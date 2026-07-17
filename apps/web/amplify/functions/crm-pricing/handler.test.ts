import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The lead-pricing flow's written-word guarantees:
 *
 * R58 — no reply ever quotes a dollar amount the engine didn't compute.
 * The fallback template used to hardcode "$99" on mosquito plans (which have
 * no initial fee), and the price guard whitelisted "$15"/"$99" — the exact
 * literals it exists to catch.
 *
 * R75 — the MA/RI licensing gate fails closed. A lead with no extractable
 * state used to skip the gate entirely, then geocode as "<town>, MA" —
 * Hartford, Nashua, and Brattleboro all sit inside the 90-minute zone check.
 *
 * And the AI-pricing contract: every base price comes from the cached
 * market-rate sheet via the PURE-READ getCachedRate API (deterministic
 * Zone B adders on top, like the funnel). The live path never researches:
 * a stale sheet still serves, and a combo with no sheet at all enqueues
 * the research for the hourly pricing-refresh cron and ESCALATES to a
 * human with the re-price-in-an-hour reason — never a silent skip, never
 * an invented price; HOA leads auto-quote per-unit like everything else.
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

/** The AI market-rate cache: tests set the cached sheet per service. The
 *  handler only ever READS it (getCachedRate) — a miss enqueues research
 *  for the cron instead of researching inline. */
type FakeSheet = Record<string, unknown> | null;
let sheets: Record<string, FakeSheet>;
type FakeRate = {
  priceCents: number;
  sheet: Record<string, unknown>;
  basis: string;
  cached: boolean;
  /** Row metadata a stale (past-expiresAt) sheet would carry — the caller
   *  must price from it untouched. */
  expiresAt?: string;
} | null;
const marketRateMock = vi.fn(
  async (opts: { service: string }): Promise<FakeRate> => {
    const sheet = sheets[opts.service];
    if (!sheet) return null;
    const hoa = sheet.hoaPerUnitMonthly as
      | { UNITS_1_10: { MONTHLY: number } }
      | undefined;
    return {
      priceCents: (sheet.oneTimeCents as number) ?? hoa?.UNITS_1_10.MONTHLY ?? 0,
      sheet,
      basis: "test basis",
      cached: true,
    };
  }
);
const enqueueMock = vi.fn(async (_opts: Record<string, unknown>) => undefined);
vi.mock("../shared/marketRate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../shared/marketRate")>()),
  getCachedRate: (opts: never) => marketRateMock(opts),
  enqueueRateResearch: (opts: never) => enqueueMock(opts),
}));

const { handler, replyUsesOnlyAllowedAmounts, templateReply } = await import(
  "./handler"
);

const FUNNEL = "https://staging.d26qpsjewk0bee.amplifyapp.com/quote";

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
  nestCount: null,
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
  marketRateMock.mockClear();
  enqueueMock.mockClear();
  extraction = { ...baseExtraction };
  composedReply = "Sounds good!"; // no dollar amounts — always passes the guard
  // The cached AI sheets every price comes from. The quarterly plan is
  // deliberately $75/mo + $99 initial so the R58 template expectations pin
  // the same literals the retired rate card produced.
  sheets = {
    GENERAL_PEST: {
      oneTimeCents: 31900,
      plans: {
        MONTHLY: { monthlyCents: 9900, initialFeeCents: 10900 },
        BIMONTHLY: { monthlyCents: 5900, initialFeeCents: 10900 },
        QUARTERLY: { monthlyCents: 7500, initialFeeCents: 9900 },
      },
    },
    WASP_NEST: { oneTimeCents: 28900, extraNestCents: 9900 },
    RODENT: { oneTimeCents: 39900 },
    ROACH: { oneTimeCents: 34900 },
    TERMITE: { oneTimeCents: 84900 },
    WILDLIFE: { oneTimeCents: 59900 },
    COMMERCIAL: {
      oneTimeCents: 39900,
      plans: {
        MONTHLY: { monthlyCents: 14900, initialFeeCents: 19900 },
        BIMONTHLY: { monthlyCents: 11900, initialFeeCents: 19900 },
        QUARTERLY: { monthlyCents: 9900, initialFeeCents: 17900 },
      },
    },
    HOA: {
      hoaPerUnitMonthly: {
        UNITS_1_10: { MONTHLY: 2200, BIMONTHLY: 1800, QUARTERLY: 1500 },
        UNITS_11_25: { MONTHLY: 1200, BIMONTHLY: 1000, QUARTERLY: 850 },
        UNITS_26_50: { MONTHLY: 900, BIMONTHLY: 750, QUARTERLY: 600 },
        UNITS_51_100: { MONTHLY: 675, BIMONTHLY: 550, QUARTERLY: 450 },
        UNITS_101_PLUS: { MONTHLY: 425, BIMONTHLY: 350, QUARTERLY: 275 },
      },
    },
  };
  process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
  process.env.GOOGLE_ROUTES_API_KEY = "test-routes-key";
  process.env.MARKETING_URL = "https://staging.d26qpsjewk0bee.amplifyapp.com";
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

describe("every base price comes from the AI market-rate sheet", () => {
  it("prices a quarterly GP plan from the sheet's cadence (Zone A: no adder)", async () => {
    const run = await priceLead({ inputText: "lead", leadFeeCents: 0 });

    expect(run.decision).toBe("QUOTE");
    expect(run.monthlyPriceCents).toBe(7500);
    expect(run.initialFeeCents).toBe(9900);
    expect(marketRateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        service: "GENERAL_PEST",
        city: "Ware",
        state: "MA",
        sqft: 3200,
      })
    );
    // A hit is a pure read — nothing gets queued for the cron.
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("lays the deterministic Zone B adders on top, exactly like the funnel", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ routes: [{ duration: "3600s" }] }), // 60 min → Zone B
    } as never);

    const run = await priceLead({ inputText: "lead", leadFeeCents: 0 });

    expect(run.zone).toBe("B");
    expect(run.monthlyPriceCents).toBe(8300); // $75 + $8 quarterly adder
    expect(run.initialFeeCents).toBe(12400); // $99 + $25 flat adder
  });

  it("prices a wasp lead as first nest + extra nests from one sheet", async () => {
    extraction = {
      ...baseExtraction,
      propertyType: "specialty",
      specialtyKind: "wasp_nest",
      pest: "wasps",
      nestCount: 3,
      frequencyInterest: "one_time",
    };

    const run = await priceLead({ inputText: "lead", leadFeeCents: 0 });

    expect(run.decision).toBe("QUOTE");
    expect(run.oneTimePriceCents).toBe(48700); // $289 + 2 × $99
    expect(String(run.service)).toContain("3 nests");
    expect(marketRateMock).toHaveBeenCalledWith(
      expect.objectContaining({ service: "WASP_NEST" })
    );
  });

  it("prices a roach cleanout from the ROACH sheet", async () => {
    extraction = {
      ...baseExtraction,
      propertyType: "specialty",
      specialtyKind: "roach",
      pest: "German cockroaches",
    };

    const run = await priceLead({ inputText: "lead", leadFeeCents: 0 });

    expect(run.decision).toBe("QUOTE");
    expect(run.oneTimePriceCents).toBe(34900);
    expect(marketRateMock).toHaveBeenCalledWith(
      expect.objectContaining({ service: "ROACH", sqft: 3200 })
    );
  });

  it("pivots a one-time that fails the 3× lead-fee test to the sheet's quarterly plan", async () => {
    extraction = { ...baseExtraction, frequencyInterest: "one_time" };

    // One-time $319 → GP $204, lead fee $100 needs $300 GP: pivot.
    const run = await priceLead({ inputText: "lead", leadFeeCents: 10000 });

    expect(run.decision).toBe("QUOTE");
    expect(run.monthlyPriceCents).toBe(7500);
    expect(run.initialFeeCents).toBe(9900);
    expect(String(run.reason)).toContain("pivoted to the quarterly plan");
  });

  it("asks for the town when the engine has no area to key the cache on", async () => {
    extraction = { ...baseExtraction, town: null };

    const run = await priceLead({ inputText: "lead", leadFeeCents: 0 });

    expect(run.decision).toBe("NEEDS_INFO");
    expect(String(run.reason)).toMatch(/town/i);
    expect(marketRateMock).not.toHaveBeenCalled();
  });
});

describe("a cache miss enqueues and escalates — the human holds it for an hour", () => {
  it("no GP sheet → enqueue for the cron + ESCALATE with the re-price reason and the holding script", async () => {
    sheets.GENERAL_PEST = null;

    const run = await priceLead({ inputText: "lead", leadFeeCents: 0 });

    expect(run.decision).toBe("ESCALATE");
    expect(run.reason).toBe("AI rate queued — re-price this lead in an hour");
    expect(String(run.replyText)).toContain("custom quote from our owner");
    expect(run.monthlyPriceCents).toBeUndefined();
    expect(run.oneTimePriceCents).toBeUndefined();
    expect(enqueueMock).toHaveBeenCalledWith({
      service: "GENERAL_PEST",
      city: "Ware",
      state: "MA",
      sqft: 3200,
    });
  });

  it("a multi-nest wasp job with no extra-nest component is unpriceable → ESCALATE", async () => {
    sheets.WASP_NEST = { oneTimeCents: 28900 }; // no extraNestCents
    extraction = {
      ...baseExtraction,
      propertyType: "specialty",
      specialtyKind: "wasp_nest",
      pest: "wasps",
      nestCount: 2,
    };

    const run = await priceLead({ inputText: "lead", leadFeeCents: 0 });

    expect(run.decision).toBe("ESCALATE");
    expect(run.reason).toBe("AI rate queued — re-price this lead in an hour");
    expect(enqueueMock).toHaveBeenCalledWith({
      service: "WASP_NEST",
      city: "Ware",
      state: "MA",
    });
  });

  it("a stale sheet still prices — serve-last-known-good, no enqueue", async () => {
    // getCachedRate serves the last known good sheet even past expiresAt;
    // the caller must price from whatever comes back and never queue or
    // refuse a served rate.
    marketRateMock.mockImplementationOnce(async () => ({
      priceCents: 31900,
      sheet: sheets.GENERAL_PEST as Record<string, unknown>,
      basis: "researched months ago",
      cached: true,
      expiresAt: "2020-01-01T00:00:00.000Z", // long past — served anyway
    }));

    const run = await priceLead({ inputText: "lead", leadFeeCents: 0 });

    expect(run.decision).toBe("QUOTE");
    expect(run.monthlyPriceCents).toBe(7500);
    expect(run.initialFeeCents).toBe(9900);
    expect(enqueueMock).not.toHaveBeenCalled();
  });
});

describe("termite, wildlife, and commercial auto-quote from the engine", () => {
  it("prices a termite lead from the TERMITE sheet — the quote-custom policy is retired", async () => {
    extraction = {
      ...baseExtraction,
      propertyType: "specialty",
      specialtyKind: "termite",
      pest: "termites",
      frequencyInterest: "one_time",
    };

    const run = await priceLead({ inputText: "lead", leadFeeCents: 0 });

    expect(run.decision).toBe("QUOTE");
    expect(run.oneTimePriceCents).toBe(84900);
    expect(marketRateMock).toHaveBeenCalledWith(
      expect.objectContaining({ service: "TERMITE", city: "Ware", sqft: 3200 })
    );
  });

  it("prices a wildlife lead as an exclusion/removal visit — the wildlife pass is retired", async () => {
    extraction = {
      ...baseExtraction,
      eligibility: "wildlife",
      pest: "squirrels in the attic",
    };

    const run = await priceLead({ inputText: "lead", leadFeeCents: 0 });

    expect(run.decision).toBe("QUOTE");
    expect(run.oneTimePriceCents).toBe(59900);
    expect(String(run.service)).toContain("Wildlife exclusion and removal");
    expect(marketRateMock).toHaveBeenCalledWith(
      expect.objectContaining({ service: "WILDLIFE", sqft: 3200 })
    );
  });

  it("prices a commercial monthly plan from the COMMERCIAL sheet — the deterministic card retired", async () => {
    extraction = {
      ...baseExtraction,
      propertyType: "commercial",
      frequencyInterest: "monthly",
      sqft: 8000,
    };

    const run = await priceLead({ inputText: "lead", leadFeeCents: 0 });

    expect(run.decision).toBe("QUOTE");
    expect(run.monthlyPriceCents).toBe(14900);
    expect(run.initialFeeCents).toBe(19900);
    expect(String(run.service)).toContain("Commercial pest control");
    expect(marketRateMock).toHaveBeenCalledWith(
      expect.objectContaining({ service: "COMMERCIAL", sqft: 8000 })
    );
  });

  it("prices a commercial one-time from the sheet with the Zone B adder on top", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ routes: [{ duration: "3600s" }] }), // 60 min → Zone B
    } as never);
    extraction = {
      ...baseExtraction,
      propertyType: "commercial",
      frequencyInterest: "one_time",
    };

    const run = await priceLead({ inputText: "lead", leadFeeCents: 0 });

    expect(run.decision).toBe("QUOTE");
    expect(run.oneTimePriceCents).toBe(42400); // $399 + $25 Zone B flat
  });

  it("a cache miss still escalates to a human for each new kind — and queues the combo", async () => {
    sheets.TERMITE = null;
    sheets.WILDLIFE = null;
    sheets.COMMERCIAL = null;
    for (const patch of [
      { propertyType: "specialty", specialtyKind: "termite" },
      { eligibility: "wildlife" },
      { propertyType: "commercial" },
    ]) {
      pricingRuns.length = 0;
      enqueueMock.mockClear();
      extraction = { ...baseExtraction, ...patch };

      const run = await priceLead({ inputText: "lead", leadFeeCents: 0 });

      expect(run.decision).toBe("ESCALATE");
      expect(run.reason).toBe("AI rate queued — re-price this lead in an hour");
      expect(String(run.replyText)).toContain("custom quote from our owner");
      expect(enqueueMock).toHaveBeenCalledTimes(1);
    }
  });
});

describe("HOA auto-quotes per unit — the always-escalate policy is retired", () => {
  const hoaExtraction = () => ({
    ...baseExtraction,
    propertyType: "association",
    pest: "ants",
    units: 60,
    frequencyInterest: "monthly",
  });

  it("quotes 60 units at the 51–100 band's per-unit monthly rate", async () => {
    extraction = hoaExtraction();

    const run = await priceLead({ inputText: "lead", leadFeeCents: 0 });

    expect(run.decision).toBe("QUOTE"); // not ESCALATE — the policy is retired
    expect(run.monthlyPriceCents).toBe(40500); // 60 × $6.75
    expect(run.initialFeeCents).toBeUndefined();
    expect(run.frequency).toBe("MONTHLY");
    expect(marketRateMock).toHaveBeenCalledWith(
      expect.objectContaining({ service: "HOA", city: "Ware", state: "MA" })
    );
  });

  it("the reply carries the quote like any other service", async () => {
    extraction = hoaExtraction();
    composedReply = "This has a made-up $999 in it."; // force the template

    const run = await priceLead({ inputText: "lead", leadFeeCents: 0 });

    expect(String(run.replyText)).toContain("$405");
    expect(String(run.replyText)).toContain("no initial fee");
  });

  it("still needs a unit count before it can price", async () => {
    extraction = { ...hoaExtraction(), units: null };

    const run = await priceLead({ inputText: "lead", leadFeeCents: 0 });

    expect(run.decision).toBe("NEEDS_INFO");
    expect(String(run.reason)).toMatch(/unit count/i);
  });

  it("an HOA cache miss escalates like every other service — band-less enqueue", async () => {
    sheets.HOA = null;
    extraction = hoaExtraction();

    const run = await priceLead({ inputText: "lead", leadFeeCents: 0 });

    expect(run.decision).toBe("ESCALATE");
    expect(run.reason).toBe("AI rate queued — re-price this lead in an hour");
    expect(enqueueMock).toHaveBeenCalledWith({
      service: "HOA",
      city: "Ware",
      state: "MA",
    });
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

  it("every branch's next step is the funnel — no scheduling-by-reply", () => {
    const replies = [
      templateReply(facts), // monthly, no initial
      templateReply({ ...facts, pest: "ants", initial: "$124" }), // monthly + initial
      templateReply({
        ...facts,
        monthly: null,
        oneTime: "$319",
        frequency: "ONE_TIME" as const,
      }), // one-time
    ];

    for (const reply of replies) {
      expect(reply).toContain(FUNNEL);
      expect(reply).toContain("book online");
      // The old promise to have "our technician out as early as Thursday" —
      // nothing on this side of the funnel schedules anything.
      expect(reply).not.toMatch(/technician out|Thursday|sign|agreement/i);
    }
  });

  it("the funnel URL does not trip the amount guard (R58)", () => {
    const reply = templateReply({ ...facts, pest: "ants", initial: "$124" });

    expect(replyUsesOnlyAllowedAmounts(reply, ["$169", "$124"])).toBe(true);
  });
});

describe("the composed reply's next step is the funnel too", () => {
  it("hands the composer the exact funnel URL and forbids reply-scheduling", async () => {
    await priceLead({ inputText: "lead", leadFeeCents: 0 });

    // Second model call is reply composition (no output_config).
    const compose = messagesCreate.mock.calls.find(
      ([args]) => !(args as { output_config?: unknown }).output_config
    );
    expect(compose).toBeDefined();
    const prompt = String(
      (compose![0] as { messages: [{ content: string }] }).messages[0].content
    );
    expect(prompt).toContain(FUNNEL);
    expect(prompt).toMatch(/NEVER promise to schedule by reply/i);
    expect(prompt).not.toMatch(/scheduling day/i);
  });

  it("the deterministic fallback reply carries the funnel link", async () => {
    composedReply = "This will run you $500 flat."; // bogus amount → template

    const run = await priceLead({ inputText: "lead", leadFeeCents: 0 });

    expect(String(run.replyText)).toContain(FUNNEL);
  });
});
