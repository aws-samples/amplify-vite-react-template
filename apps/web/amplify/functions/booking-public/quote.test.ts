import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BOOKING_TERMS_TEXT,
  BOOKING_TERMS_VERSION,
} from "../shared/bookingTerms";

/**
 * Quote pricing integrity:
 *
 * R59 — zone UNKNOWN never produces a bookable price. A Routes-API outage or
 * an expired key used to silently reprice the whole funnel as Zone B; it must
 * fall to the callback path and tell the office why.
 *
 * R60 — rodent/roach market-rate quotes carry the same Zone B travel adder
 * as the carded services; an 89-minute drive must not price like a
 * 10-minute one.
 *
 * R17 — a PRICED quote carries the checkout terms (version + text), so the
 * UI renders exactly what /book will hold the customer to.
 *
 * AI-first pricing — every base price (GENERAL_PEST one-time + plans,
 * WASP_NEST first + extra nests, rodent/roach) comes from the cached AI
 * rate sheet (shared/marketRate). No sheet → CONTACT, never a made-up
 * price. The deterministic overlay (Zone B adders, day pricing) stays on
 * top of the AI base.
 */

const bookings: Record<string, unknown>[] = [];
const pricingRuns: Record<string, unknown>[] = [];

const fakeDataClient = {
  models: {
    QuoteThrottle: {
      get: async () => ({ data: null }),
      create: async () => ({ data: { id: "t1" } }),
      update: async () => ({ data: { id: "t1" } }),
    },
    MarketRate: { list: async () => ({ data: [] }) },
    BookingRequest: {
      create: async (input: Record<string, unknown>) => {
        bookings.push(input);
        return { data: { id: `b${bookings.length}`, ...input } };
      },
    },
    LeadPricingRun: {
      create: async (input: Record<string, unknown>) => {
        pricingRuns.push(input);
        return { data: { id: "r1", ...input } };
      },
    },
    Technician: {
      list: async () => ({ data: [{ id: "t1", active: true }] }),
    },
    Job: { listJobByScheduledDate: async () => ({ data: [] }) },
    Customer: { get: async () => ({ data: null }) },
  },
};
vi.mock("../shared/dataClient", () => ({ dataClient: async () => fakeDataClient }));

const officeEmails: { subject: string; bodyHtml: string }[] = [];
vi.mock("../shared/email", () => ({
  emailShell: (h: string, b: string) => `${h}${b}`,
  sendEmail: async () => true,
  notifyOffice: async (o: { subject: string; bodyHtml: string }) => {
    officeEmails.push(o);
    return true;
  },
}));

/** Drive time from HQ; null simulates a Routes outage / dead key. */
let hqMinutes: number | null = 20;
vi.mock("../shared/driveTime", () => ({
  HQ_ADDRESS: "81 Greenwich Rd, Ware, MA 01082",
  driveMinutesBetween: async () => hqMinutes,
  driveMatrixFrom: async (_k: string, _o: string, dests: string[]) =>
    dests.map(() => null),
}));

type FakeSheet = {
  oneTimeCents: number;
  extraNestCents?: number;
  plans?: Record<string, { monthlyCents: number; initialFeeCents: number }>;
};
let marketRateResult: {
  priceCents: number;
  sheet: FakeSheet;
  basis: string;
  cached: boolean;
} | null;
const marketRateCalls: Record<string, unknown>[] = [];
vi.mock("../shared/marketRate", () => ({
  marketRate: async (opts: Record<string, unknown>) => {
    marketRateCalls.push(opts);
    return marketRateResult;
  },
  sqftBucket: (sqft: number) => Math.max(500, Math.ceil(sqft / 500) * 500),
}));

vi.mock("@aws-sdk/client-ssm", () => ({
  SSMClient: class {
    async send() {
      return { Parameter: { Value: "test-secret" } };
    }
  },
  GetParameterCommand: class {},
}));

const { handler } = await import("./handler");

const postQuote = async (input: unknown) => {
  const res = (await handler({
    headers: {},
    requestContext: {
      http: { method: "POST", path: "/quote", sourceIp: "1.2.3.4" },
    },
    body: JSON.stringify(input),
    isBase64Encoded: false,
  } as never)) as { statusCode: number; body: string };
  return { status: res.statusCode, body: JSON.parse(res.body) };
};

const rodentInput = {
  name: "Dana Whitlock",
  email: "dana@example.com",
  service: "RODENT",
  sqft: 2000,
  address: { street: "12 Beacon St", city: "Ware", state: "MA", zip: "01082" },
};

beforeEach(() => {
  bookings.length = 0;
  pricingRuns.length = 0;
  officeEmails.length = 0;
  marketRateCalls.length = 0;
  hqMinutes = 20;
  marketRateResult = {
    priceCents: 19900,
    sheet: { oneTimeCents: 19900 },
    basis: "test",
    cached: true,
  };
  process.env.SES_NOTIFY_EMAIL = "office@pestbuzzkill.com";
  process.env.GOOGLE_ROUTES_API_KEY = "test-routes-key";
  process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
  delete process.env.TURNSTILE_SECRET;
});

describe("zone UNKNOWN never prices (R59)", () => {
  it("falls to the callback path instead of silently pricing as Zone B", async () => {
    hqMinutes = null; // Routes outage / dead key

    const res = await postQuote({ ...rodentInput, service: "GENERAL_PEST" });

    expect(res.status).toBe(200);
    expect(res.body.decision).toBe("CONTACT");
    expect(res.body.days).toBeUndefined();
    expect(bookings[0]).toMatchObject({ status: "CONTACT", zone: "UNKNOWN" });
  });

  it("tells the office the zone lookup failed, not just 'call this lead'", async () => {
    hqMinutes = null;

    await postQuote(rodentInput);

    expect(officeEmails).toHaveLength(1);
    expect(officeEmails[0].subject).toBe("Website lead needs a call");
    expect(officeEmails[0].bodyHtml).toContain("Drive-time zone lookup failed");
  });
});

describe("market-rate services carry the Zone B adder (R60)", () => {
  it("adds the $25 one-time adder to a Zone B rodent quote", async () => {
    hqMinutes = 80; // Zone B

    const res = await postQuote(rodentInput);

    expect(res.body.decision).toBe("PRICED");
    expect(pricingRuns[0]).toMatchObject({ zone: "B", oneTimePriceCents: 22400 });
  });

  it("adds it to roach quotes too", async () => {
    hqMinutes = 80;

    const res = await postQuote({ ...rodentInput, service: "ROACH" });

    expect(res.body.decision).toBe("PRICED");
    expect(pricingRuns[0]).toMatchObject({ oneTimePriceCents: 22400 });
  });

  it("leaves Zone A rodent quotes at the market rate", async () => {
    hqMinutes = 20;

    const res = await postQuote(rodentInput);

    expect(res.body.decision).toBe("PRICED");
    expect(pricingRuns[0]).toMatchObject({ zone: "A", oneTimePriceCents: 19900 });
  });
});

describe("GENERAL_PEST prices from the cached AI sheet", () => {
  const gpSheet: FakeSheet = {
    oneTimeCents: 30000,
    plans: {
      MONTHLY: { monthlyCents: 9900, initialFeeCents: 11900 },
      BIMONTHLY: { monthlyCents: 5900, initialFeeCents: 11900 },
      QUARTERLY: { monthlyCents: 4900, initialFeeCents: 10900 },
    },
  };
  const gpInput = { ...rodentInput, service: "GENERAL_PEST" };

  beforeEach(() => {
    marketRateResult = {
      priceCents: 30000,
      sheet: gpSheet,
      basis: "test sheet",
      cached: true,
    };
  });

  it("prices the one-time base and the chosen plan from the sheet (Zone A)", async () => {
    const res = await postQuote({ ...gpInput, recurringPreference: "QUARTERLY" });

    expect(res.body.decision).toBe("PRICED");
    expect(marketRateCalls[0]).toMatchObject({
      service: "GENERAL_PEST",
      city: "Ware",
      state: "MA",
      sqft: 2000,
    });
    expect(res.body.recurringOffer).toEqual({
      frequency: "QUARTERLY",
      monthlyCents: 4900,
      initialFeeCents: 10900,
    });
    expect(pricingRuns[0]).toMatchObject({
      oneTimePriceCents: 30000,
      monthlyPriceCents: 4900,
      initialFeeCents: 10900,
    });
  });

  it("keeps the deterministic Zone B adders on top of the AI base", async () => {
    hqMinutes = 80; // Zone B

    const res = await postQuote({ ...gpInput, recurringPreference: "MONTHLY" });

    expect(res.body.decision).toBe("PRICED");
    // one-time +$25 flat, monthly +$25/mo, initial +$25 flat.
    expect(pricingRuns[0]).toMatchObject({ zone: "B", oneTimePriceCents: 32500 });
    expect(res.body.recurringOffer).toEqual({
      frequency: "MONTHLY",
      monthlyCents: 12400,
      initialFeeCents: 14400,
    });
  });

  it("applies the day-pricing overlay to the AI base", async () => {
    const res = await postQuote(gpInput);

    expect(res.body.decision).toBe("PRICED");
    const prices = (res.body.days as { priceCents: number }[]).map(
      (d) => d.priceCents
    );
    expect(prices.length).toBeGreaterThan(0);
    // Every day is the AI base times the overlay's bounded modifiers…
    for (const p of prices) {
      expect(p).toBeGreaterThanOrEqual(30000 * 0.85);
      expect(p).toBeLessThanOrEqual(30000 * 1.15);
      expect(p % 100).toBe(0); // tidied to whole dollars
    }
    // …and an empty schedule means the quiet-day discount actually moved it.
    expect(Math.min(...prices)).toBeLessThan(30000);
  });

  it("falls to CONTACT when no rate sheet is available (never a made-up price)", async () => {
    marketRateResult = null;

    const res = await postQuote(gpInput);

    expect(res.body.decision).toBe("CONTACT");
    expect(res.body.days).toBeUndefined();
    expect(bookings[0]).toMatchObject({ status: "CONTACT" });
  });

  it("falls to CONTACT when the sheet is missing the chosen plan cadence", async () => {
    marketRateResult = {
      priceCents: 30000,
      sheet: { oneTimeCents: 30000 }, // no plans on the sheet
      basis: "partial",
      cached: true,
    };

    const res = await postQuote({ ...gpInput, recurringPreference: "MONTHLY" });

    expect(res.body.decision).toBe("CONTACT");
  });
});

describe("WASP_NEST prices from the cached AI sheet", () => {
  const waspInput = {
    name: "Dana Whitlock",
    email: "dana@example.com",
    service: "WASP_NEST",
    nestCount: 1,
    address: { street: "12 Beacon St", city: "Ware", state: "MA", zip: "01082" },
  };

  beforeEach(() => {
    marketRateResult = {
      priceCents: 29900,
      sheet: { oneTimeCents: 29900, extraNestCents: 9900 },
      basis: "test sheet",
      cached: true,
    };
  });

  it("prices the first nest from the sheet", async () => {
    const res = await postQuote(waspInput);

    expect(res.body.decision).toBe("PRICED");
    expect(marketRateCalls[0]).toMatchObject({ service: "WASP_NEST" });
    expect(pricingRuns[0]).toMatchObject({ oneTimePriceCents: 29900 });
  });

  it("adds the sheet's extra-nest increment per additional nest", async () => {
    const res = await postQuote({ ...waspInput, nestCount: 3 });

    expect(res.body.decision).toBe("PRICED");
    expect(pricingRuns[0]).toMatchObject({ oneTimePriceCents: 49700 });
  });

  it("falls to CONTACT when research is unavailable", async () => {
    marketRateResult = null;

    const res = await postQuote(waspInput);

    expect(res.body.decision).toBe("CONTACT");
  });

  it("falls to CONTACT when a multi-nest job has no extra-nest component", async () => {
    marketRateResult = {
      priceCents: 29900,
      sheet: { oneTimeCents: 29900 }, // no extra-nest price on the sheet
      basis: "partial",
      cached: true,
    };

    const res = await postQuote({ ...waspInput, nestCount: 2 });

    expect(res.body.decision).toBe("CONTACT");
  });
});

describe("PRICED quotes carry the checkout terms (R17)", () => {
  it("returns the current terms version and text with the price", async () => {
    const res = await postQuote(rodentInput);

    expect(res.body.decision).toBe("PRICED");
    expect(res.body.terms).toEqual({
      version: BOOKING_TERMS_VERSION,
      text: BOOKING_TERMS_TEXT,
    });
  });

  it("sends no terms on the CONTACT path — there is nothing to accept yet", async () => {
    hqMinutes = null; // zone UNKNOWN → callback

    const res = await postQuote(rodentInput);

    expect(res.body.decision).toBe("CONTACT");
    expect(res.body.terms).toBeUndefined();
  });
});

describe("first-touch attribution rides on the booking", () => {
  const storedAttribution = () =>
    bookings[0].attribution
      ? JSON.parse(String(bookings[0].attribution))
      : undefined;

  it("stores sanitized attribution on a PRICED booking", async () => {
    const res = await postQuote({
      ...rodentInput,
      attribution: {
        source: "google",
        medium: "cpc",
        campaign: "x".repeat(400), // oversize — truncated to 300
        gclid: "abc123",
        referrer: "https://www.google.com/",
        landingPage: "/quote",
        unknownKey: "dropped", // not in the contract
        junk: { nested: true },
      },
    });

    expect(res.body.decision).toBe("PRICED");
    expect(storedAttribution()).toEqual({
      source: "google",
      medium: "cpc",
      campaign: "x".repeat(300),
      gclid: "abc123",
      referrer: "https://www.google.com/",
      landingPage: "/quote",
    });
  });

  it("stores it on the CONTACT path too, and tells the office the source", async () => {
    hqMinutes = null; // zone UNKNOWN → callback

    const res = await postQuote({
      ...rodentInput,
      attribution: { source: "facebook", campaign: "spring-ants" },
    });

    expect(res.body.decision).toBe("CONTACT");
    expect(storedAttribution()).toEqual({
      source: "facebook",
      campaign: "spring-ants",
    });
    expect(officeEmails[0].bodyHtml).toContain("utm:facebook");
    expect(officeEmails[0].bodyHtml).toContain("campaign:spring-ants");
  });

  it("survives junk attribution as a no-op — the quote never fails over it", async () => {
    for (const junk of [
      "not-an-object",
      42,
      ["an", "array"],
      { source: { nested: true }, campaign: ["arr"], gclid: null },
    ]) {
      bookings.length = 0;
      const res = await postQuote({ ...rodentInput, attribution: junk });

      expect(res.status).toBe(200);
      expect(res.body.decision).toBe("PRICED");
      expect(bookings[0].attribution).toBeUndefined();
    }
  });

  it("coerces primitive non-string values instead of dropping the click", async () => {
    await postQuote({
      ...rodentInput,
      attribution: { source: "google", term: 12345 },
    });

    expect(storedAttribution()).toEqual({ source: "google", term: "12345" });
  });
});
