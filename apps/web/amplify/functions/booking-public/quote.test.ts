import { beforeEach, describe, expect, it, vi } from "vitest";
import { _setLockStoreForTests, memoryLockStore } from "../shared/atomicLock";
import { capacityFixtureModels } from "../shared/capacityTestFixture";
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
 * WASP_NEST first + extra nests, rodent/roach, termite/wildlife one-times,
 * commercial one-time + plans, community per-unit plans) comes from the
 * cached AI rate sheet via the PURE-READ getCachedRate API
 * (shared/marketRate) — the live path never researches, and a stale sheet
 * still serves. No sheet at all → the miss is queued for the hourly
 * pricing-refresh worker (with the lead's email + booking id), returns a
 * token-authenticated PENDING request for the loading screen, and emails a
 * secure resume link if the lead leaves — never a made-up price. The deterministic
 * overlay (Zone B adders, day pricing) stays on top of the AI base.
 *
 * Every ask is priced: all six form services × all three property kinds get
 * a day board. CONTACT is reserved for zone OUT, zone UNKNOWN (R59), and a
 * fully-booked month; a cold rate cache is PENDING while research runs.
 */

const bookings: Record<string, unknown>[] = [];
const pricingRuns: Record<string, unknown>[] = [];
/** Scheduled stops returned for EVERY day — 8 fills a one-tech schedule. */
let stopsEveryDay: { customerId: string; serviceType: string; status: string }[] =
  [];

const capacityFixture = capacityFixtureModels();

const fakeDataClient = {
  models: {
    QuoteThrottle: {
      get: async () => ({ data: null }),
      create: async () => ({ data: { id: "t1" } }),
      update: async () => ({ data: { id: "t1" } }),
    },
    // GL-03: the CONTACT promise is returned only when its owned action
    // durably exists — the fake queue accepts it like production does.
    WorkItem: {
      get: async () => ({ data: null }),
      create: async (input: Record<string, unknown>) => ({ data: input }),
      update: async (input: Record<string, unknown>) => ({ data: input }),
    },
    WorkEvent: {
      create: async (input: Record<string, unknown>) => ({ data: input }),
    },
    MarketRate: { list: async () => ({ data: [] }) },
    BookingRequest: {
      create: async (input: Record<string, unknown>) => {
        const row = { id: `b${bookings.length + 1}`, ...input };
        bookings.push(row);
        return { data: row };
      },
      get: async ({ id }: { id: string }) => ({
        data: bookings.find((b) => b.id === id) ?? null,
      }),
      update: async (input: Record<string, unknown> & { id: string }) => {
        const row = bookings.find((b) => b.id === input.id);
        // Mirror production transport: the GraphQL body is JSON.stringify'd,
        // which DROPS undefined keys — an update with { field: undefined }
        // leaves the stored attribute untouched, never clears it.
        if (row) {
          for (const [k, v] of Object.entries(input)) {
            if (v !== undefined) row[k] = v;
          }
        }
        return { data: row ?? null };
      },
    },
    LeadPricingRun: {
      create: async (input: Record<string, unknown>) => {
        pricingRuns.push(input);
        return { data: { id: "r1", ...input } };
      },
    },
    Technician: {
      list: async () => ({
        data: [
          {
            id: "t1",
            active: true,
            licenseNumber: "MA-1",
            licenseExpiresOn: "2099-01-01",
          },
        ],
      }),
    },
    Job: { listJobByScheduledDate: async () => ({ data: stopsEveryDay }) },
    Customer: {
      get: async () => ({ data: null }),
      listCustomerByBookingLinkToken: async ({
        bookingLinkToken,
      }: {
        bookingLinkToken: string;
      }) => {
        leadLookups.push(bookingLinkToken);
        const hit = customersByLinkToken[bookingLinkToken];
        return { data: hit ? (Array.isArray(hit) ? hit : [hit]) : [] };
      },
    },
  },
};
let customersByLinkToken: Record<string, { id: string } | { id: string }[]> =
  {};
const leadLookups: string[] = [];
Object.assign(fakeDataClient.models, capacityFixture.models);
vi.mock("../shared/dataClient", () => ({ dataClient: async () => fakeDataClient }));

// R80: the two quote-path lead alerts (ops-booking-contact, ops-booking-rate-
// queued) route to sales@ via notifyLeads now. notifyOffice stays mocked so a
// stray ops route would leave leadEmails empty and fail the assertions.
const leadEmails: { subject: string; bodyHtml: string; template: string }[] = [];
vi.mock("../shared/email", () => ({
  emailShell: (h: string, b: string) => `${h}${b}`,
  sendEmail: async () => true,
  notifyOffice: async () => true,
  notifyLeads: async (o: {
    subject: string;
    bodyHtml: string;
    template: string;
  }) => {
    leadEmails.push(o);
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
  oneTimeCents?: number;
  extraNestCents?: number;
  plans?: Record<string, { monthlyCents: number; initialFeeCents: number }>;
  hoaPerUnitMonthly?: Record<string, Record<string, number>>;
};
type FakeRate = {
  priceCents: number;
  sheet: FakeSheet;
  basis: string;
  cached: boolean;
  /** Row metadata a stale (past-expiresAt) sheet would carry — the caller
   *  must serve it untouched, never inspect or refuse it. */
  expiresAt?: string;
} | null;
let marketRateResult: FakeRate;
/** Per-engine-kind results for multi-service scenarios; a kind not present
 *  here falls back to marketRateResult. */
let marketRateByService: Record<string, FakeRate>;
const marketRateCalls: Record<string, unknown>[] = [];
/** Every enqueueRateResearch call — the live path's only research surface. */
const enqueueCalls: Record<string, unknown>[] = [];
vi.mock("../shared/marketRate", () => ({
  // The pure-read API: never researches, serves stale — the handler must
  // trust whatever comes back and never fall to any research path.
  getCachedRate: async (opts: Record<string, unknown>) => {
    marketRateCalls.push(opts);
    const service = String(opts.service);
    return service in marketRateByService
      ? marketRateByService[service]
      : marketRateResult;
  },
  enqueueRateResearch: async (opts: Record<string, unknown>) => {
    enqueueCalls.push(opts);
  },
  sqftBucket: (sqft: number) => Math.max(500, Math.ceil(sqft / 500) * 500),
  areaKeyFor: (city: string, state: string) =>
    `${city.trim().toLowerCase().replace(/\s+/g, "-")}-${state.trim().toLowerCase()}`,
  rateKeyFor: (service: string, areaKey: string, bucket: number | null) =>
    `${service}#${areaKey}${bucket ? `#${bucket}` : ""}`,
  hoaBandFor: (units: number) =>
    units <= 10
      ? "UNITS_1_10"
      : units <= 25
        ? "UNITS_11_25"
        : units <= 50
          ? "UNITS_26_50"
          : units <= 100
            ? "UNITS_51_100"
            : "UNITS_101_PLUS",
}));

vi.mock("@aws-sdk/client-ssm", () => ({
  SSMClient: class {
    async send() {
      return { Parameter: { Value: "test-secret" } };
    }
  },
  GetParameterCommand: class {},
}));

const pricingInvokes: Record<string, unknown>[] = [];
vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: class {
    async send(command: { input?: Record<string, unknown> }) {
      pricingInvokes.push(command.input ?? {});
      return { StatusCode: 202 };
    }
  },
  InvokeCommand: class {
    input: Record<string, unknown>;
    constructor(input: Record<string, unknown>) {
      this.input = input;
    }
  },
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

const postQuoteStatus = async (input: unknown) => {
  const res = (await handler({
    headers: {},
    requestContext: {
      http: { method: "POST", path: "/quote-status", sourceIp: "1.2.3.4" },
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
  capacityFixture.maps.capacityDays.clear();
  capacityFixture.maps.capacityClaims.clear();
  capacityFixture.maps.closures.clear();
  capacityFixture.maps.exceptions.clear();
  _setLockStoreForTests(
    memoryLockStore({
      CapacityDay: capacityFixture.maps.capacityDays,
      CapacityClaim: capacityFixture.maps.capacityClaims,
    })
  );
  bookings.length = 0;
  pricingRuns.length = 0;
  leadEmails.length = 0;
  customersByLinkToken = {};
  leadLookups.length = 0;
  marketRateCalls.length = 0;
  enqueueCalls.length = 0;
  pricingInvokes.length = 0;
  stopsEveryDay = [];
  hqMinutes = 20;
  marketRateByService = {};
  marketRateResult = {
    priceCents: 19900,
    sheet: { oneTimeCents: 19900 },
    basis: "test",
    cached: true,
  };
  process.env.SES_NOTIFY_EMAIL = "office@pestbuzzkill.com";
  process.env.GOOGLE_ROUTES_API_KEY = "test-routes-key";
  process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
  process.env.PRICING_REFRESH_FUNCTION_NAME = "pricing-refresh-test";
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

    expect(leadEmails).toHaveLength(1);
    // GL-03: this lead gave no phone/consent, so the truthful fallback is an
    // email, not a call — and the office alert says so.
    expect(leadEmails[0].subject).toBe("Website lead needs an email");
    expect(leadEmails[0].bodyHtml).toContain("Drive-time zone lookup failed");
    // R80: the contact alert is a lead alert — it routes to sales@.
    expect(leadEmails[0].template).toBe("ops-booking-contact");
  });

  it("promises a call only when the lead gave a phone and consent (GL-03)", async () => {
    hqMinutes = null; // zone UNKNOWN → fallback

    const res = await postQuote({
      ...rodentInput,
      phone: "(413) 555-0123",
      callConsent: true,
    });

    expect(res.body.decision).toBe("CONTACT");
    expect(res.body.message).toMatch(/call you/i);
    expect(leadEmails[0].subject).toBe("Website lead needs a call");
    expect(bookings[0]).toMatchObject({ status: "CONTACT", callConsent: true });
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

  it("returns PENDING when no rate sheet is available (never a made-up price)", async () => {
    marketRateResult = null;

    const res = await postQuote(gpInput);

    expect(res.body.decision).toBe("PENDING");
    expect(res.body.days).toBeUndefined();
    expect(bookings[0]).toMatchObject({ status: "PENDING" });
  });

  it("a miss queues the research with the lead's email + booking id and promises the inbox", async () => {
    marketRateResult = null;

    const res = await postQuote(gpInput);

    expect(res.body.decision).toBe("PENDING");
    expect(enqueueCalls).toEqual([
      {
        service: "GENERAL_PEST",
        city: "Ware",
        state: "MA",
        sqft: 2000,
        notifyEmail: "dana@example.com",
        bookingRequestId: res.body.bookingId,
      },
    ]);
    // The honest holding copy: the loading screen stays attached to this
    // durable request and email is the leave-safe fallback.
    expect(res.body.message).toMatch(/building your exact price/i);
    expect(res.body.statusToken).toBeTruthy();
    expect(pricingInvokes).toHaveLength(1);
    expect(leadEmails[0].subject).toBe("Website lead waiting on AI pricing");
    // R80: the rate-queued alert is a lead alert — it routes to sales@.
    expect(leadEmails[0].template).toBe("ops-booking-rate-queued");
  });

  it("the secure status poll turns the same PENDING request into its day board", async () => {
    marketRateResult = null;
    const pending = await postQuote(gpInput);
    const bookingId = pending.body.bookingId as string;
    const statusToken = pending.body.statusToken as string;

    marketRateResult = {
      priceCents: 30000,
      sheet: { oneTimeCents: 30000, plans: gpSheet.plans },
      basis: "research completed",
      cached: true,
    };
    const ready = await postQuoteStatus({ bookingId, statusToken });

    expect(ready.status).toBe(200);
    expect(ready.body.decision).toBe("PRICED");
    expect(ready.body.bookingId).toBe(bookingId);
    expect((ready.body.days as unknown[]).length).toBeGreaterThan(0);
    expect(bookings).toHaveLength(1);
    expect(bookings[0]).toMatchObject({ id: bookingId, status: "QUOTED" });
    expect(pricingInvokes).toHaveLength(1);
    expect(leadEmails).toHaveLength(1);
  });

  it("returns PENDING when the sheet is missing the chosen plan cadence", async () => {
    marketRateResult = {
      priceCents: 30000,
      sheet: { oneTimeCents: 30000 }, // no plans on the sheet
      basis: "partial",
      cached: true,
    };

    const res = await postQuote({ ...gpInput, recurringPreference: "MONTHLY" });

    expect(res.body.decision).toBe("PENDING");
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

  it("returns PENDING when research is unavailable", async () => {
    marketRateResult = null;

    const res = await postQuote(waspInput);

    expect(res.body.decision).toBe("PENDING");
  });

  it("returns PENDING when a multi-nest job has no extra-nest component", async () => {
    marketRateResult = {
      priceCents: 29900,
      sheet: { oneTimeCents: 29900 }, // no extra-nest price on the sheet
      basis: "partial",
      cached: true,
    };

    const res = await postQuote({ ...waspInput, nestCount: 2 });

    expect(res.body.decision).toBe("PENDING");
  });
});

describe("TERMITE and WILDLIFE price from their sheets — no specialist callback", () => {
  const termiteInput = { ...rodentInput, service: "TERMITE" };

  beforeEach(() => {
    marketRateResult = {
      priceCents: 84900,
      sheet: { oneTimeCents: 84900 },
      basis: "test sheet",
      cached: true,
    };
  });

  it("day-prices a termite ask from the TERMITE sheet (Zone A)", async () => {
    const res = await postQuote(termiteInput);

    expect(res.body.decision).toBe("PRICED");
    expect(marketRateCalls[0]).toMatchObject({ service: "TERMITE", sqft: 2000 });
    expect(pricingRuns[0]).toMatchObject({ oneTimePriceCents: 84900 });
    expect(res.body.service).toContain("Termite treatment");
    expect((res.body.days as unknown[]).length).toBeGreaterThan(0);
  });

  it("adds the Zone B one-time adder to a wildlife quote (R60)", async () => {
    hqMinutes = 80; // Zone B

    const res = await postQuote({ ...rodentInput, service: "WILDLIFE" });

    expect(res.body.decision).toBe("PRICED");
    expect(marketRateCalls[0]).toMatchObject({ service: "WILDLIFE" });
    expect(pricingRuns[0]).toMatchObject({ zone: "B", oneTimePriceCents: 87400 });
    expect(res.body.service).toContain("Wildlife exclusion and removal");
  });

  it("returns PENDING only when research is unavailable", async () => {
    marketRateResult = null;

    const res = await postQuote(termiteInput);

    expect(res.body.decision).toBe("PENDING");
    expect(bookings[0]).toMatchObject({ status: "PENDING" });
  });

  it("requires sqft — the sheets are sqft-banded", async () => {
    const res = await postQuote({ ...termiteInput, sqft: undefined });

    expect(res.status).toBe(400);
    expect(res.body.errors.sqft).toBeDefined();
  });
});

describe("COMMUNITY prices the common-area plan from the HOA sheet", () => {
  const hoaGrid = {
    UNITS_1_10: { MONTHLY: 2200, BIMONTHLY: 1800, QUARTERLY: 1500 },
    UNITS_11_25: { MONTHLY: 1200, BIMONTHLY: 1000, QUARTERLY: 850 },
    UNITS_26_50: { MONTHLY: 900, BIMONTHLY: 750, QUARTERLY: 600 },
    UNITS_51_100: { MONTHLY: 675, BIMONTHLY: 550, QUARTERLY: 450 },
    UNITS_101_PLUS: { MONTHLY: 425, BIMONTHLY: 350, QUARTERLY: 275 },
  };
  const communityInput = {
    ...rodentInput,
    service: "GENERAL_PEST",
    propertyKind: "COMMUNITY",
    units: 24,
    sqft: undefined,
  };

  beforeEach(() => {
    marketRateByService = {
      HOA: {
        priceCents: 2200,
        sheet: { hoaPerUnitMonthly: hoaGrid },
        basis: "test sheet",
        cached: true,
      },
    };
  });

  it("prices per-unit × units for the chosen cadence, first month charged at booking", async () => {
    const res = await postQuote({ ...communityInput, recurringPreference: "MONTHLY" });

    expect(res.body.decision).toBe("PRICED");
    expect(marketRateCalls[0]).toMatchObject({ service: "HOA", city: "Ware", state: "MA" });
    // 24 units → 11–25 band → $12/unit → $288/mo; charged at booking = the
    // first month's total.
    expect(res.body.recurringOffer).toEqual({
      frequency: "MONTHLY",
      monthlyCents: 28800,
      initialFeeCents: 28800,
    });
    expect(res.body.planOnly).toBe(true);
  });

  it("defaults to the quarterly cadence", async () => {
    const res = await postQuote(communityInput);

    expect(res.body.recurringOffer).toMatchObject({
      frequency: "QUARTERLY",
      monthlyCents: 20400, // 24 × $8.50
    });
  });

  it("the day board picks the first visit — the plan price never varies by day", async () => {
    const res = await postQuote({ ...communityInput, recurringPreference: "MONTHLY" });

    const prices = (res.body.days as { priceCents: number }[]).map(
      (d) => d.priceCents
    );
    expect(prices.length).toBeGreaterThan(0);
    for (const p of prices) expect(p).toBe(28800);
  });

  it("adds the Zone B monthly adder to the plan", async () => {
    hqMinutes = 80; // Zone B

    const res = await postQuote({ ...communityInput, recurringPreference: "MONTHLY" });

    expect(res.body.recurringOffer).toEqual({
      frequency: "MONTHLY",
      monthlyCents: 31300, // $288 + $25 monthly adder
      initialFeeCents: 31300,
    });
  });

  it("requires the unit count with a clear field error", async () => {
    const res = await postQuote({ ...communityInput, units: undefined });

    expect(res.status).toBe(400);
    expect(res.body.errors.units).toMatch(/units/i);
  });

  it("reports the plan on the pricing run without a phantom one-time price", async () => {
    await postQuote({ ...communityInput, recurringPreference: "MONTHLY" });

    expect(pricingRuns[0].monthlyPriceCents).toBe(28800);
    expect(pricingRuns[0].initialFeeCents).toBe(28800);
    expect(pricingRuns[0].oneTimePriceCents).toBeUndefined();
  });

  it("returns PENDING when the HOA sheet is unavailable", async () => {
    marketRateByService = { HOA: null };

    const res = await postQuote(communityInput);

    expect(res.body.decision).toBe("PENDING");
  });
});

describe("COMMERCIAL prices like residential GP from the COMMERCIAL sheet", () => {
  const commercialSheet: FakeSheet = {
    oneTimeCents: 39900,
    plans: {
      MONTHLY: { monthlyCents: 14900, initialFeeCents: 19900 },
      BIMONTHLY: { monthlyCents: 11900, initialFeeCents: 19900 },
      QUARTERLY: { monthlyCents: 9900, initialFeeCents: 17900 },
    },
  };
  const commercialInput = {
    ...rodentInput,
    service: "GENERAL_PEST",
    propertyKind: "COMMERCIAL",
    sqft: 4800,
  };

  beforeEach(() => {
    marketRateByService = {
      COMMERCIAL: {
        priceCents: 39900,
        sheet: commercialSheet,
        basis: "test sheet",
        cached: true,
      },
    };
  });

  it("prices the one-time and the chosen plan from the COMMERCIAL sheet", async () => {
    const res = await postQuote({ ...commercialInput, recurringPreference: "MONTHLY" });

    expect(res.body.decision).toBe("PRICED");
    expect(marketRateCalls[0]).toMatchObject({ service: "COMMERCIAL", sqft: 4800 });
    expect(res.body.recurringOffer).toEqual({
      frequency: "MONTHLY",
      monthlyCents: 14900,
      initialFeeCents: 19900,
    });
    expect(pricingRuns[0]).toMatchObject({ oneTimePriceCents: 39900 });
    expect(res.body.service).toContain("Commercial pest control");
  });

  it("keeps the deterministic Zone B adders on top", async () => {
    hqMinutes = 80; // Zone B

    const res = await postQuote({ ...commercialInput, recurringPreference: "QUARTERLY" });

    expect(pricingRuns[0]).toMatchObject({ zone: "B", oneTimePriceCents: 42400 });
    expect(res.body.recurringOffer).toEqual({
      frequency: "QUARTERLY",
      monthlyCents: 10700, // $99 + $8 quarterly adder
      initialFeeCents: 20400, // $179 + $25 flat adder
    });
  });

  it("requires sqft — the commercial sheet is sqft-banded", async () => {
    const res = await postQuote({ ...commercialInput, sqft: undefined });

    expect(res.status).toBe(400);
    expect(res.body.errors.sqft).toBeDefined();
  });

  it("any pest asked at a commercial property prices from the COMMERCIAL sheet", async () => {
    const res = await postQuote({ ...commercialInput, service: "WASP_NEST" });

    expect(res.body.decision).toBe("PRICED");
    expect(marketRateCalls[0]).toMatchObject({ service: "COMMERCIAL" });
  });
});

describe("every ask is priced — the full service × property-kind sweep", () => {
  const gpPlans = {
    MONTHLY: { monthlyCents: 9900, initialFeeCents: 11900 },
    BIMONTHLY: { monthlyCents: 5900, initialFeeCents: 11900 },
    QUARTERLY: { monthlyCents: 4900, initialFeeCents: 10900 },
  };
  const rate = (sheet: FakeSheet): FakeRate => ({
    priceCents: sheet.oneTimeCents ?? 0,
    sheet,
    basis: "test sheet",
    cached: true,
  });

  it("decision is PRICED for all 18 combinations when research succeeds", async () => {
    marketRateByService = {
      GENERAL_PEST: rate({ oneTimeCents: 30000, plans: gpPlans }),
      WASP_NEST: rate({ oneTimeCents: 29900, extraNestCents: 9900 }),
      RODENT: rate({ oneTimeCents: 39900 }),
      ROACH: rate({ oneTimeCents: 34900 }),
      TERMITE: rate({ oneTimeCents: 84900 }),
      WILDLIFE: rate({ oneTimeCents: 59900 }),
      COMMERCIAL: rate({ oneTimeCents: 39900, plans: gpPlans }),
      HOA: {
        priceCents: 2200,
        sheet: {
          hoaPerUnitMonthly: {
            UNITS_1_10: { MONTHLY: 2200, BIMONTHLY: 1800, QUARTERLY: 1500 },
            UNITS_11_25: { MONTHLY: 1200, BIMONTHLY: 1000, QUARTERLY: 850 },
            UNITS_26_50: { MONTHLY: 900, BIMONTHLY: 750, QUARTERLY: 600 },
            UNITS_51_100: { MONTHLY: 675, BIMONTHLY: 550, QUARTERLY: 450 },
            UNITS_101_PLUS: { MONTHLY: 425, BIMONTHLY: 350, QUARTERLY: 275 },
          },
        },
        basis: "test sheet",
        cached: true,
      },
    };
    marketRateResult = null; // any un-mapped engine kind would fail loudly

    for (const service of [
      "GENERAL_PEST",
      "WASP_NEST",
      "RODENT",
      "ROACH",
      "TERMITE",
      "WILDLIFE",
    ]) {
      for (const propertyKind of ["RESIDENTIAL", "COMMUNITY", "COMMERCIAL"]) {
        bookings.length = 0;
        const res = await postQuote({
          ...rodentInput,
          service,
          propertyKind,
          sqft: 2000,
          nestCount: 2,
          units: 24,
        });

        expect(res.status, `${service} × ${propertyKind}`).toBe(200);
        expect(res.body.decision, `${service} × ${propertyKind}`).toBe("PRICED");
        expect(
          (res.body.days as unknown[]).length,
          `${service} × ${propertyKind}`
        ).toBeGreaterThan(0);
      }
    }
  });
});

describe("the live path is a pure read (serve-last-known-good)", () => {
  it("a hit never enqueues research — the day board prices as before", async () => {
    const res = await postQuote(rodentInput);

    expect(res.body.decision).toBe("PRICED");
    expect((res.body.days as unknown[]).length).toBeGreaterThan(0);
    expect(enqueueCalls).toHaveLength(0);
    expect(marketRateCalls).toHaveLength(1); // one read, nothing else
  });

  it("a stale sheet still serves — staleness beats a callback", async () => {
    marketRateResult = {
      priceCents: 19900,
      sheet: { oneTimeCents: 19900 },
      basis: "researched months ago",
      cached: true,
      expiresAt: "2020-01-01T00:00:00.000Z", // long past — served anyway
    };

    const res = await postQuote(rodentInput);

    expect(res.body.decision).toBe("PRICED");
    expect(pricingRuns[0]).toMatchObject({ oneTimePriceCents: 19900 });
    expect(enqueueCalls).toHaveLength(0);
  });
});

describe("the only surviving CONTACT outcomes", () => {
  it("zone OUT still falls to the callback path", async () => {
    hqMinutes = 120; // beyond the 90-minute zone

    const res = await postQuote(rodentInput);

    expect(res.body.decision).toBe("CONTACT");
    expect(bookings[0]).toMatchObject({ status: "CONTACT", zone: "OUT" });
  });

  it("a fully-booked month falls to the callback path", async () => {
    // GL-04: "fully booked" means every technician-window LEDGER holds its
    // minutes — fill t1's slots for every weekday in the sellable window.
    // From i = 0 (not 1): after ~8pm Eastern the UTC day is already
    // tomorrow's date, so starting at 1 left the first sellable Eastern day
    // uncovered and the test flaked PRICED between 00:00 and 04:00 UTC.
    for (let i = 0; i <= 41; i++) {
      const d = new Date(Date.now() + i * 86_400_000).toISOString().slice(0, 10);
      for (const w of ["MORNING", "AFTERNOON"] as const) {
        capacityFixture.maps.capacityDays.set(`${d}#${w}#t1`, {
          id: `${d}#${w}#t1`,
          date: d,
          window: w,
          technicianId: "t1",
          committedMinutes: w === "MORNING" ? 240 : 300,
        });
      }
    }

    const res = await postQuote(rodentInput);

    expect(res.body.decision).toBe("CONTACT");
    expect(res.body.message).toMatch(/fully booked/i);
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
    expect(leadEmails[0].bodyHtml).toContain("utm:facebook");
    expect(leadEmails[0].bodyHtml).toContain("campaign:spring-ants");
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

describe("the booking link's lead identity rides on the booking", () => {
  it("resolves a valid ?lead token to the lead's customer id", async () => {
    customersByLinkToken["tok-lead-abc123def456"] = { id: "lead-77" };

    const { status } = await postQuote({
      ...rodentInput,
      leadToken: "tok-lead-abc123def456",
    });

    expect(status).toBe(200);
    expect(bookings[0].leadCustomerId).toBe("lead-77");
  });

  it("silently drops a token that resolves to nothing — identity is an upgrade, not a gate", async () => {
    const { status, body } = await postQuote({
      ...rodentInput,
      leadToken: "tok-unknown-0123456789",
    });

    expect(status).toBe(200);
    expect(bookings[0].leadCustomerId).toBeUndefined();
    // The response never confirms whether the token matched anything.
    expect(JSON.stringify(body)).not.toContain("lead");
  });

  it("rejects junk-shaped tokens before any lookup", async () => {
    const { status } = await postQuote({
      ...rodentInput,
      leadToken: "<script>x</script>",
    });

    expect(status).toBe(200);
    expect(bookings[0].leadCustomerId).toBeUndefined();
    // The shape gate runs BEFORE the table — junk never costs a query.
    expect(leadLookups).toHaveLength(0);
  });

  it("refuses a token that somehow matches more than one record", async () => {
    customersByLinkToken["tok-shared-0123456789"] = [
      { id: "lead-a" },
      { id: "lead-b" },
    ];

    const { status } = await postQuote({
      ...rodentInput,
      leadToken: "tok-shared-0123456789",
    });

    expect(status).toBe(200);
    expect(bookings[0].leadCustomerId).toBeUndefined();
  });

  it("a resumed PENDING quote keeps the lead identity from the original submission", async () => {
    customersByLinkToken["tok-lead-abc123def456"] = { id: "lead-77" };
    marketRateResult = null;
    const pending = await postQuote({
      ...rodentInput,
      leadToken: "tok-lead-abc123def456",
    });
    expect(pending.body.decision).toBe("PENDING");
    expect(bookings[0].leadCustomerId).toBe("lead-77");

    // The status poll resumes WITHOUT a leadToken; the update it writes must
    // not clear the stored identity.
    marketRateResult = {
      priceCents: 19900,
      sheet: { oneTimeCents: 19900 },
      basis: "research completed",
      cached: true,
    };
    const ready = await postQuoteStatus({
      bookingId: pending.body.bookingId,
      statusToken: pending.body.statusToken,
    });

    expect(ready.body.decision).toBe("PRICED");
    expect(bookings[0]).toMatchObject({
      status: "QUOTED",
      leadCustomerId: "lead-77",
    });
  });
});

describe("GL-17 — mosquito seasonal plans on the funnel", () => {
  const mosquitoInput = {
    name: "Dana Whitlock",
    email: "dana@example.com",
    service: "MOSQUITO",
    propertyKind: "RESIDENTIAL",
    lotHalfAcres: 1,
    address: { street: "12 Main St", city: "Ware", state: "MA", zip: "01082" },
  };

  it("prices the plan from the DETERMINISTIC card — no rate sheet, no research", async () => {
    // No mosquito entry exists in the fake rate world at all: pricing must
    // come from the card, never the AI engine.
    const res = await postQuote(mosquitoInput);

    expect(res.body.decision).toBe("PRICED");
    expect(res.body.planOnly).toBe(true);
    expect(res.body.recurringOffer).toMatchObject({
      frequency: "MONTHLY", // billed monthly year-round — no cadence choice
      monthlyCents: 11900, // ½ acre, Zone A
      initialFeeCents: 11900, // first month charged at booking
    });
    // The day board picks the first treatment; the price never varies by day.
    for (const d of res.body.days as { priceCents: number }[]) {
      expect(d.priceCents).toBe(11900);
    }
    expect(String(res.body.service)).toContain("Mosquito plan");
  });

  it("mosquito + tick and larger yards price by the card's half-acre steps", async () => {
    const res = await postQuote({
      ...mosquitoInput,
      service: "MOSQUITO_TICK",
      lotHalfAcres: 3, // 1½ acres: $139 + 2 × $30
    });

    expect(res.body.decision).toBe("PRICED");
    expect(res.body.recurringOffer.monthlyCents).toBe(19900);
    expect(String(res.body.service)).toContain("Mosquito + tick");
  });

  it("Zone B distance is priced inside the card exactly once", async () => {
    hqMinutes = 80; // Zone B

    const res = await postQuote(mosquitoInput);

    expect(res.body.decision).toBe("PRICED");
    // $119 + the $25 mosquito monthly Zone B adder — not double-added.
    expect(res.body.recurringOffer.monthlyCents).toBe(14400);
  });

  it("a community asking for mosquito gets the MOSQUITO plan, not the HOA sheet — and needs no unit count", async () => {
    const res = await postQuote({
      ...mosquitoInput,
      propertyKind: "COMMUNITY",
      // no units on purpose
    });

    expect(res.body.decision).toBe("PRICED");
    expect(res.body.recurringOffer.monthlyCents).toBe(11900);
    expect(String(res.body.service)).toContain("Mosquito plan");
  });

  it("ignores a cadence preference — the locked rule is monthly billing", async () => {
    const res = await postQuote({
      ...mosquitoInput,
      recurringPreference: "QUARTERLY",
    });
    expect(res.body.recurringOffer.frequency).toBe("MONTHLY");
  });

  it("refuses a yard size outside the card's range", async () => {
    const res = await postQuote({ ...mosquitoInput, lotHalfAcres: 12 });
    expect(res.status).toBe(400);
    expect(res.body.errors.lotHalfAcres).toBeTruthy();
  });

  it("REJECTS a missing yard size — never silently prices half an acre", async () => {
    const { lotHalfAcres: _omit, ...noAcreage } = mosquitoInput;
    const res = await postQuote(noAcreage);
    expect(res.status).toBe(400);
    expect(res.body.errors.lotHalfAcres).toBeTruthy();
    // Nothing was quoted or stored under a guessed size.
    expect(bookings).toHaveLength(0);
  });

  it("sells the FIRST TREATMENT only onto April–October dates", async () => {
    vi.useFakeTimers();
    try {
      // Late October: the 42-day board crosses into November, but only the
      // remaining in-season October days may be sold.
      vi.setSystemTime(new Date("2026-10-20T15:00:00Z"));
      const res = await postQuote({
        ...mosquitoInput,
        email: "dana+oct@example.com",
      });
      expect(res.body.decision).toBe("PRICED");
      for (const d of res.body.days as { date: string }[]) {
        const month = Number(d.date.slice(5, 7));
        expect(month).toBeGreaterThanOrEqual(4);
        expect(month).toBeLessThanOrEqual(10);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("ADVERSARIAL: a fully-booked IN-SEASON month is 'fully booked' — never a false April promise", async () => {
    // Staging-drill finding: an empty day board must not read as
    // off-season while the season is running.
    for (let i = 0; i <= 41; i++) {
      const d = new Date(Date.now() + i * 86_400_000).toISOString().slice(0, 10);
      for (const w of ["MORNING", "AFTERNOON"] as const) {
        capacityFixture.maps.capacityDays.set(`${d}#${w}#t1`, {
          id: `${d}#${w}#t1`,
          date: d,
          window: w,
          technicianId: "t1",
          committedMinutes: w === "MORNING" ? 240 : 300,
        });
      }
    }

    const res = await postQuote({
      ...mosquitoInput,
      email: "dana+booked@example.com",
    });

    expect(res.body.decision).toBe("CONTACT");
    expect(String(res.body.message)).toMatch(/fully booked/i);
    expect(res.body.offSeason).toBeUndefined();
  });

  it("a fully off-season ask is a REAL date-less sale: PRICED, empty day board, truthful copy", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-12-09T15:00:00Z")); // deep off-season
      const res = await postQuote({
        ...mosquitoInput,
        email: "dana+dec@example.com",
      });
      // The November–March customer can accept and PAY immediately — never
      // a "we'll call you" dead end.
      expect(res.body.decision).toBe("PRICED");
      expect(res.body.offSeason).toBe(true);
      expect(res.body.days).toEqual([]);
      expect(res.body.recurringOffer).toMatchObject({
        frequency: "MONTHLY",
        monthlyCents: 11900,
        initialFeeCents: 11900,
      });
      // Truthful copy: year-round billing, April as a MONTH, no exact day.
      expect(String(res.body.offSeasonMessage)).toContain("billed monthly year-round");
      expect(String(res.body.offSeasonMessage)).toContain("April");
      expect(String(res.body.offSeasonMessage)).toContain("confirm the exact day");
      expect(res.body.terms?.version).toBeTruthy();
      expect(bookings[0]).toMatchObject({ status: "QUOTED" });
      expect(String(bookings[0].quoteJson)).toContain('"offSeason":true');
    } finally {
      vi.useRealTimers();
    }
  });
});
