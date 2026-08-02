import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The auto-send gate. A reply that sends itself quotes a real customer a real
 * price with no human in between, so every one of these tests is about
 * REFUSING to send rather than sending.
 *
 * Auto-send requires ALL of: clean mapping, funnel PRICED, in zone, clears 3×
 * the Thumbtack lead fee in gross profit, and at least one bookable day.
 */

let invokePayload: Record<string, unknown> | null = null;
let quoteResponse: unknown = null;
let invokeError: Error | null = null;
let bookingZone: string | null = "A";

vi.mock("@aws-sdk/client-lambda", () => ({
  InvokeCommand: class {
    input: Record<string, unknown>;
    constructor(input: Record<string, unknown>) {
      this.input = input;
    }
  },
  LambdaClient: class {
    send = async (cmd: { input: Record<string, unknown> }) => {
      if (invokeError) throw invokeError;
      invokePayload = JSON.parse(String(Buffer.from(cmd.input.Payload as Uint8Array)));
      return {
        Payload: Buffer.from(JSON.stringify(quoteResponse)),
      };
    };
  },
}));

vi.mock("@aws-sdk/client-ssm", () => ({
  GetParameterCommand: class {
    constructor(public input: unknown) {}
  },
  SSMClient: class {
    send = async () => ({ Parameter: { Value: "booking-public-fn" } });
  },
}));

vi.mock("../shared/dataClient", () => ({
  dataClient: async () => ({
    models: {
      BookingRequest: {
        get: async () => ({ data: bookingZone ? { zone: bookingZone } : null }),
      },
    },
  }),
}));

const { autoQuoteLead, leadFeeCentsFrom } = await import("./autoQuote");

const ANTS_DETAILS = [
  { question: "Property type", answer: "Residential" },
  { question: "Primary pest type", answer: "Ants" },
  { question: "Total square footage of building", answer: "3,000 - 4,000 sq ft" },
];

const base = {
  leadID: "L1",
  customerId: "lead-1",
  category: "Pest Control Services",
  details: ANTS_DETAILS,
  city: "Belmont",
  state: "MA",
  zip: "02478",
};

const priced = (priceCents: number, days = ["2026-07-28", "2026-07-29"]) => ({
  ok: true,
  data: {
    decision: "PRICED",
    bookingId: "b1",
    days: days.map((date) => ({ date, priceCents })),
  },
});

beforeEach(() => {
  invokePayload = null;
  invokeError = null;
  bookingZone = "A";
  quoteResponse = priced(42400);
  process.env.BOOKING_PUBLIC_FUNCTION_NAME = "booking-public-fn";
  process.env.MARKETING_URL = "https://www.pestbuzzkill.com";
});

describe("leadFeeCentsFrom", () => {
  it("parses Thumbtack's dollar string", () => {
    expect(leadFeeCentsFrom("17.42")).toBe(1742);
    expect(leadFeeCentsFrom("$43.55")).toBe(4355);
  });

  it("treats a missing price as a FREE lead, not an unknown one", () => {
    expect(leadFeeCentsFrom(null)).toBe(0);
    expect(leadFeeCentsFrom("")).toBe(0);
  });
});

describe("auto-send gate", () => {
  it("auto-sends a clean, in-zone, fee-clearing quote with real dates", async () => {
    const res = await autoQuoteLead({ ...base, leadPrice: "17.42" }, "Ajay Daptardar");

    expect(res.decision).toBe("QUOTE");
    expect(res.autoSend).toBe(true);
    // `money()` drops a trailing .00 on whole dollars — house style.
    expect(res.replyText).toContain("$424");
    expect(res.replyText).toContain("Ajay");
    expect(res.replyText).toMatch(/pestbuzzkill\.com\/quote/);
    expect(res.offeredDates).toHaveLength(2);
  });

  it("prices through the SAME funnel engine, with the mapped inputs", async () => {
    await autoQuoteLead({ ...base, leadPrice: "17.42" }, "Ajay");

    const op = (invokePayload as { internalOp: { kind: string; input: Record<string, unknown> } })
      .internalOp;
    expect(op.kind).toBe("QUOTE");
    expect(op.input.service).toBe("GENERAL_PEST");
    expect(op.input.sqft).toBe(4000);
    expect(op.input.propertyKind).toBe("RESIDENTIAL");
  });

  it("REFUSES when the job does not clear 3× the lead fee", async () => {
    // $60 job, $43.55 lead fee: gross profit cannot reach $130.65.
    quoteResponse = priced(6000);
    const res = await autoQuoteLead({ ...base, leadPrice: "43.55" }, "Beth");

    expect(res.decision).toBe("PASS");
    expect(res.autoSend).toBe(false);
    expect(res.reason).toMatch(/3×|3x/);
  });

  it("REFUSES when the questionnaire left a gap — never guesses a price", async () => {
    const res = await autoQuoteLead(
      { ...base, details: [{ question: "Primary pest type", answer: "Wasps" }], leadPrice: "17.42" },
      "Sam"
    );

    expect(res.decision).toBe("NEEDS_INFO");
    expect(res.autoSend).toBe(false);
    expect(res.replyText).toBeUndefined();
    // A count-priced service can never be auto-quoted: Thumbtack never asks.
    expect(res.reason).toMatch(/nest count/);
  });

  it("REFUSES when the funnel bounced the address instead of pricing it", async () => {
    quoteResponse = {
      ok: true,
      data: { decision: "CONTACT", message: "Outside the standard service area" },
    };
    const res = await autoQuoteLead({ ...base, leadPrice: "17.42" }, "Far Away");

    expect(res.decision).toBe("PASS");
    expect(res.autoSend).toBe(false);
    expect(res.reason).toMatch(/service area/i);
  });

  it("REFUSES when priced but no day is actually bookable", async () => {
    quoteResponse = { ok: true, data: { decision: "PRICED", bookingId: "b1", days: [] } };
    const res = await autoQuoteLead({ ...base, leadPrice: "17.42" }, "Sam");

    expect(res.decision).toBe("NEEDS_INFO");
    expect(res.autoSend).toBe(false);
    expect(res.reason).toMatch(/no bookable day|capacity/i);
  });

  it("REFUSES when the zone can't be read — an unknown margin is not a green light", async () => {
    bookingZone = null;
    const res = await autoQuoteLead({ ...base, leadPrice: "17.42" }, "Sam");

    expect(res.autoSend).toBe(false);
  });

  it("REFUSES, without losing the lead, when the quote engine is unreachable", async () => {
    invokeError = new Error("lambda down");
    const res = await autoQuoteLead({ ...base, leadPrice: "17.42" }, "Sam");

    expect(res.decision).toBe("ERROR");
    expect(res.autoSend).toBe(false);
    expect(res.reason).toMatch(/by hand/i);
  });

  it("still auto-sends a FREE lead — zero fee is trivially cleared", async () => {
    const res = await autoQuoteLead({ ...base, leadPrice: null }, "Sam");

    expect(res.autoSend).toBe(true);
    expect(res.leadFeeCents).toBe(0);
  });

  it("never puts an amount in the reply that the engine did not return", async () => {
    quoteResponse = priced(19900);
    const res = await autoQuoteLead({ ...base, leadPrice: "0" }, "Sam");

    const amounts = (res.replyText ?? "").match(/\$[\d,]+(?:\.\d{2})?/g) ?? [];
    expect(amounts).toEqual(["$199.00"]);
  });
});
