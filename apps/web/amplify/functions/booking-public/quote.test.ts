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

let marketRateResult: { priceCents: number; basis: string; cached: boolean } | null;
vi.mock("./marketRate", () => ({
  marketRate: async () => marketRateResult,
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
  hqMinutes = 20;
  marketRateResult = { priceCents: 19900, basis: "test", cached: true };
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
