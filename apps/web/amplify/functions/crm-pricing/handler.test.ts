import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The lead-pricing flow's two written-word guarantees:
 *
 * R58 — no reply ever quotes a dollar amount the rate card didn't compute.
 * The fallback template used to hardcode "$99" on mosquito plans (which have
 * no initial fee), and the price guard whitelisted "$15"/"$99" — the exact
 * literals it exists to catch.
 *
 * R75 — the MA/RI licensing gate fails closed. A lead with no extractable
 * state used to skip the gate entirely, then geocode as "<town>, MA" —
 * Hartford, Nashua, and Brattleboro all sit inside the 90-minute zone check.
 */

const pricingRuns: Record<string, unknown>[] = [];
const fakeDataClient = {
  models: {
    LeadPricingRun: {
      create: async (input: Record<string, unknown>) => {
        pricingRuns.push(input);
        return { data: { id: "run_1", ...input } };
      },
    },
  },
};
vi.mock("../shared/dataClient", () => ({ dataClient: async () => fakeDataClient }));

vi.mock("../shared/email", () => ({
  emailShell: (h: string, b: string) => `${h}${b}`,
  sendEmail: async () => true,
}));

/** First model call (extraction, has output_config) returns the canned
 *  extraction; the second (reply composition) returns whatever the test set. */
let extraction: Record<string, unknown>;
let composedReply: string;
const messagesCreate = vi.fn(
  async (args: { output_config?: unknown }) => ({
    stop_reason: "end_turn",
    content: [
      {
        type: "text",
        text: args.output_config ? JSON.stringify(extraction) : composedReply,
      },
    ],
  })
);
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: messagesCreate };
  },
}));

const fetchMock = vi.fn(async () => ({
  ok: true,
  json: async () => ({ routes: [{ duration: "1200s" }] }), // 20 min → Zone A
}));
vi.stubGlobal("fetch", fetchMock);

const { handler, replyUsesOnlyAllowedAmounts, templateReply } = await import(
  "./handler"
);

const priceLead = async (args: Record<string, unknown>) =>
  (await handler({
    arguments: args,
    identity: { sub: "u1", groups: ["OFFICE"] },
    fieldName: "priceLead",
  } as never)) as Record<string, unknown>;

const baseExtraction = {
  eligibility: "ok",
  propertyType: "residential",
  specialtyKind: "none",
  pest: "ants",
  customerName: "Dana Whitlock",
  town: "Ware",
  state: "MA",
  fullAddress: "12 Beacon St, Ware, MA",
  sqft: 3200,
  units: null,
  halfAcres: null,
  tick: false,
  frequencyInterest: "quarterly",
  leadFeeCents: null,
  rodentInterest: false,
  multiProperty: false,
  competitorMatchBelowFloor: false,
  complianceDocsRequested: false,
  assumptions: [],
};

beforeEach(() => {
  pricingRuns.length = 0;
  messagesCreate.mockClear();
  fetchMock.mockClear();
  extraction = { ...baseExtraction };
  composedReply = "Sounds good!"; // no dollar amounts — always passes the guard
  process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
  process.env.GOOGLE_ROUTES_API_KEY = "test-routes-key";
});

describe("the licensing gate fails closed (R75)", () => {
  it("a lead with no extractable state gets NEEDS_INFO, never a quote", async () => {
    extraction = { ...baseExtraction, state: null, town: "Hartford", fullAddress: null };

    const run = await priceLead({ inputText: "lead", leadFeeCents: 0 });

    expect(run.decision).toBe("NEEDS_INFO");
    expect(String(run.reason)).toMatch(/state/i);
  });

  it("never geocodes a state-less town as '<town>, MA'", async () => {
    extraction = { ...baseExtraction, state: null, town: "Hartford", fullAddress: null };

    await priceLead({ inputText: "lead", leadFeeCents: 0 });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still passes on an explicit out-of-state address", async () => {
    extraction = { ...baseExtraction, state: "CT", town: "Hartford" };

    const run = await priceLead({ inputText: "lead", leadFeeCents: 0 });

    expect(run.decision).toBe("PASS");
    expect(String(run.reason)).toContain("outside MA/RI");
  });
});

describe("no phantom dollar amounts in replies (R58)", () => {
  it("a mosquito reply never quotes the $99 initial fee the plan doesn't have", async () => {
    extraction = {
      ...baseExtraction,
      propertyType: "mosquito",
      pest: "mosquitoes",
      tick: true,
      halfAcres: 2,
      frequencyInterest: "unspecified",
    };
    // The model invents the fee in writing; the guard must catch it.
    composedReply =
      "Our mosquito + tick plan is $169/mo with a $99 initial visit — we can be out Thursday!";

    const run = await priceLead({ inputText: "lead", leadFeeCents: 0 });

    expect(run.decision).toBe("QUOTE");
    expect(String(run.replyText)).not.toContain("$99");
    expect(String(run.replyText)).toContain("$169");
    expect(String(run.replyText)).toContain("no initial fee");
  });

  it("a computed $99 initial fee still appears in the fallback template", async () => {
    composedReply = "This will run you $500 flat."; // bogus amount → rejected

    const run = await priceLead({ inputText: "lead", leadFeeCents: 0 });

    expect(run.decision).toBe("QUOTE");
    expect(String(run.replyText)).toContain("$75/mo");
    expect(String(run.replyText)).toContain("$99 initial service");
  });

  it("keeps a composed reply whose every amount was computed", async () => {
    composedReply =
      "For ants in Ware, our quarterly plan is $75/mo with a $99 initial service. Thursday work?";

    const run = await priceLead({ inputText: "lead", leadFeeCents: 0 });

    expect(run.replyText).toBe(composedReply);
  });
});

describe("replyUsesOnlyAllowedAmounts", () => {
  it("no longer whitelists the $15/$99 literals", () => {
    expect(replyUsesOnlyAllowedAmounts("The first visit is $99", ["$75"])).toBe(false);
    expect(replyUsesOnlyAllowedAmounts("Includes the $15 rodent add-on", ["$75"])).toBe(false);
  });

  it("accepts amounts the rate card computed", () => {
    expect(replyUsesOnlyAllowedAmounts("It's $75/mo with a $99 initial", ["$75", "$99"])).toBe(true);
  });

  it("normalizes thousands separators before comparing", () => {
    expect(replyUsesOnlyAllowedAmounts("A $1,299 job", ["$1299"])).toBe(true);
  });
});

describe("templateReply", () => {
  const facts = {
    pest: "mosquitoes",
    town: "Ware",
    monthly: "$169",
    initial: null,
    oneTime: null,
    frequency: "MONTHLY" as const,
    assumptions: [],
  };

  it("says 'no initial fee' when the plan has none", () => {
    const reply = templateReply(facts);

    expect(reply).toContain("no initial fee");
    expect(reply).not.toContain("$99");
  });

  it("quotes the initial fee when the plan carries one", () => {
    const reply = templateReply({ ...facts, pest: "ants", initial: "$124" });

    expect(reply).toContain("$124 initial service");
  });
});
