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
 * Zone B adders on top, like the funnel). The live path never researches
 * inline: a stale sheet still serves, and a combo with no complete sheet
 * enqueues only the exact demand, returns RESEARCHING, and resumes the same
 * saved run automatically — never a human escalation or invented price.
 */

const pricingRuns: Record<string, unknown>[] = [];
// GL-16: the rollback mutations read/write the PricingControl control row.
const controlRows = new Map<string, Record<string, unknown>>();
const versionRows = new Map<string, Record<string, unknown>>();
const marketRows: Record<string, unknown>[] = [];
const coverageRows = new Map<string, Record<string, unknown>>();
const fakeDataClient = {
  models: {
    LeadPricingRun: {
      create: async (input: Record<string, unknown>) => {
        const row = { id: `run_${pricingRuns.length + 1}`, ...input };
        pricingRuns.push(row);
        return { data: { ...row } };
      },
      get: async ({ id }: { id: string }) => ({
        data: pricingRuns.find((row) => row.id === id) ?? null,
      }),
      update: async (patch: Record<string, unknown> & { id: string }) => {
        const row = pricingRuns.find((candidate) => candidate.id === patch.id);
        if (!row) return { data: null, errors: [{ message: "not found" }] };
        for (const [key, value] of Object.entries(patch)) {
          if (value === null) delete row[key];
          else row[key] = value;
        }
        return { data: { ...row } };
      },
    },
    CatalogVersion: {
      get: async ({ id }: { id: string }) => ({
        data: versionRows.get(id) ?? null,
      }),
    },
    PricingControl: {
      get: async ({ id }: { id: string }) => ({
        data: controlRows.get(id) ?? null,
      }),
      create: async (input: Record<string, unknown> & { id: string }) => {
        if (controlRows.has(input.id)) {
          return { data: null, errors: [{ message: "exists" }] };
        }
        controlRows.set(input.id, { ...input });
        return { data: controlRows.get(input.id) };
      },
      update: async (patch: Record<string, unknown> & { id: string }) => {
        const row = controlRows.get(patch.id);
        if (!row) return { data: null, errors: [{ message: "no row" }] };
        for (const [k, v] of Object.entries(patch)) {
          if (v === null) delete row[k];
          else row[k] = v;
        }
        return { data: { ...row } };
      },
    },
    MarketRate: {
      listMarketRateByRateKey: async ({ rateKey }: { rateKey: string }) => ({
        data: marketRows.filter((row) => row.rateKey === rateKey),
      }),
    },
    RateCoverage: {
      get: async ({ id }: { id: string }) => ({
        data: coverageRows.get(id) ?? null,
      }),
      create: async (input: Record<string, unknown> & { id: string }) => {
        coverageRows.set(input.id, { ...input });
        return { data: coverageRows.get(input.id) };
      },
      update: async (input: Record<string, unknown> & { id: string }) => {
        const row = coverageRows.get(input.id);
        if (!row) return { data: null, errors: [{ message: "not found" }] };
        for (const [key, value] of Object.entries(input)) {
          if (value === null) delete row[key];
          else row[key] = value;
        }
        return { data: { ...row } };
      },
    },
  },
};
vi.mock("../shared/dataClient", () => ({ dataClient: async () => fakeDataClient }));

const lambdaInvokes: Record<string, unknown>[] = [];
vi.mock("@aws-sdk/client-lambda", () => ({
  InvokeCommand: class {
    input: Record<string, unknown>;
    constructor(input: Record<string, unknown>) {
      this.input = input;
    }
  },
  LambdaClient: class {
    send = async (command: { input: Record<string, unknown> }) => {
      lambdaInvokes.push(command.input);
      return {};
    };
  },
}));

// Pricing must never use email as an implicit fallback. This capture remains
// because the rollback controls legitimately notify office staff.
const leadEscalations: { subject: string; bodyHtml: string; template: string }[] =
  [];
vi.mock("../shared/email", () => ({
  emailShell: (h: string, b: string) => `${h}${b}`,
  sendEmail: async () => true,
  notifyOffice: async () => true,
  notifyLeads: async (o: {
    subject: string;
    bodyHtml: string;
    template: string;
  }) => {
    leadEscalations.push(o);
    return true;
  },
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

/**
 * The service area is measured from technician HOME bases (no company HQ), so
 * the zone lookup is a computeRouteMatrix call over every base — one call,
 * closest base wins. The response is a flat element array, not `{routes}`.
 */
const routeMatrix = (...minutesPerBase: number[]) =>
  minutesPerBase.map((m, originIndex) => ({
    originIndex,
    duration: `${m * 60}s`,
    condition: "ROUTE_EXISTS",
  }));

/** The technician home bases the service area is measured from. Mutable so a
 *  test can stand up a multi-technician roster and assert the closest wins. */
const roster = vi.hoisted(() => ({
  bases: ["5 Base Rd, Marlborough, MA, 01752"] as string[] | null,
}));
vi.mock("../shared/capacity", () => ({
  activeTechBases: async () => roster.bases,
}));

const fetchMock = vi.fn(async () => ({
  ok: true,
  json: async () => routeMatrix(20), // 20 min from the one base → Zone A
}));
vi.stubGlobal("fetch", fetchMock);

/** The AI market-rate cache: tests set the cached sheet per service. The
 *  handler only ever READS it (getCachedRate) — a miss enqueues research
 *  for the demand worker instead of researching inline. */
type FakeSheet = Record<string, unknown> | null;
let sheets: Record<string, FakeSheet>;
type FakeRate = {
  priceCents: number;
  sheet: Record<string, unknown>;
  basis: string;
  cached: boolean;
  pinned?: boolean;
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
const enqueueMock = vi.fn(async (opts: Record<string, unknown>) => opts != null);
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
    identity: { sub: "u1", groups: ["OWNER"] },
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
  animalCount: null,
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
  controlRows.clear();
  marketRows.length = 0;
  coverageRows.clear();
  lambdaInvokes.length = 0;
  pricingRuns.length = 0;
  leadEscalations.length = 0;
  messagesCreate.mockClear();
  fetchMock.mockClear();
  roster.bases = ["5 Base Rd, Marlborough, MA, 01752"];
  marketRateMock.mockClear();
  enqueueMock.mockClear();
  enqueueMock.mockImplementation(async () => true);
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
  process.env.PRICING_REFRESH_FUNCTION_NAME = "pricing-refresh-test";
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

describe("the service area is measured from technician home bases, not an HQ", () => {
  it("takes the CLOSEST base: a lead one tech lives near is quoted, not passed", async () => {
    // The same lead against three bases. Measured from the farthest it is 120
    // min — an automatic out-of-area PASS under the old fixed-origin rule.
    // A technician lives 25 minutes away, so it is a Zone A job.
    roster.bases = ["Far Rd, Athol, MA", "Mid Rd, Sturbridge, MA", "5 Base Rd, Marlborough, MA"];
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => routeMatrix(120, 95, 25),
    } as never);

    const run = await priceLead({ inputText: "lead", leadFeeCents: 0 });

    expect(run.decision).toBe("QUOTE");
    expect(run.zone).toBe("A");
    expect(run.driveMinutes).toBe(25);
  });

  it("passes only when EVERY base is beyond 90 minutes, and says so", async () => {
    roster.bases = ["Far Rd, Athol, MA", "Mid Rd, Sturbridge, MA", "5 Base Rd, Marlborough, MA"];
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => routeMatrix(140, 96, 101),
    } as never);

    const run = await priceLead({ inputText: "lead", leadFeeCents: 0 });

    expect(run.decision).toBe("PASS");
    expect(run.zone).toBe("OUT");
    expect(run.driveMinutes).toBe(96); // the closest base, not the first
    expect(String(run.reason)).toContain("closest technician base");
    // The old copy blamed a town nobody dispatches from.
    expect(String(run.reason)).not.toMatch(/Ware/i);
  });

  it("an unroutable base leaves the zone UNKNOWN — never a false out-of-area", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [{ originIndex: 0, condition: "ROUTE_NOT_FOUND" }],
    } as never);

    const run = await priceLead({ inputText: "lead", leadFeeCents: 0 });

    // Refusing a paid lead because Routes hiccuped would burn the lead fee.
    expect(run.decision).not.toBe("PASS");
    expect(run.zone).not.toBe("OUT");
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
      json: async () => routeMatrix(60), // 60 min → Zone B
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

  it("prices rodent exclusion from AI instead of creating a custom handoff", async () => {
    extraction = {
      ...baseExtraction,
      propertyType: "specialty",
      specialtyKind: "rodent_exclusion",
      pest: "mice entry points",
      frequencyInterest: "one_time",
    };

    const run = await priceLead({ inputText: "lead", leadFeeCents: 0 });

    expect(run.decision).toBe("QUOTE");
    expect(run.oneTimePriceCents).toBe(39900);
    expect(String(run.service)).toContain("Rodent exclusion");
    expect(marketRateMock).toHaveBeenCalledWith(
      expect.objectContaining({ service: "RODENT", sqft: 3200 })
    );
    expect(leadEscalations).toHaveLength(0);
  });

  it("special flags keep standard AI pricing and only record safe notes", async () => {
    extraction = {
      ...baseExtraction,
      multiProperty: true,
      competitorMatchBelowFloor: true,
      complianceDocsRequested: true,
    };

    const run = await priceLead({ inputText: "lead", leadFeeCents: 0 });

    expect(run.decision).toBe("QUOTE");
    expect(String(run.reason)).toContain("quoted the described property only");
    expect(String(run.reason)).toContain("standard BuzzKill pricing shown");
    expect(String(run.reason)).toContain("pricing is unaffected");
    expect(leadEscalations).toHaveLength(0);
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

describe("missing/incomplete rates finish asynchronously without escalation", () => {
  it("no GP sheet → request the exact rate + RESEARCHING with an immediate wake", async () => {
    sheets.GENERAL_PEST = null;

    const run = await priceLead({ inputText: "lead", leadFeeCents: 0 });

    expect(run.decision).toBe("RESEARCHING");
    expect(String(run.reason)).toMatch(/finish automatically/i);
    expect(run.replyText).toBeUndefined();
    expect(run.monthlyPriceCents).toBeUndefined();
    expect(run.oneTimePriceCents).toBeUndefined();
    expect(run.researchRateKey).toBeTruthy();
    expect(enqueueMock).toHaveBeenCalledWith(expect.objectContaining({
      service: "GENERAL_PEST",
      city: "Ware",
      state: "MA",
      sqft: 3200,
      requestedBy: "CRM_LEAD",
      requestReason: "MISSING_RATE_SHEET",
    }));
    expect(lambdaInvokes).toHaveLength(1);
    expect(
      JSON.parse(
        Buffer.from(lambdaInvokes[0].Payload as Uint8Array).toString("utf8")
      )
    ).toEqual({ rateKey: run.researchRateKey, source: "quote" });
    expect(leadEscalations).toHaveLength(0);
  });

  it("an incomplete multi-nest sheet requests replacement research", async () => {
    sheets.WASP_NEST = { oneTimeCents: 28900 }; // no extraNestCents
    extraction = {
      ...baseExtraction,
      propertyType: "specialty",
      specialtyKind: "wasp_nest",
      pest: "wasps",
      nestCount: 2,
    };

    const run = await priceLead({ inputText: "lead", leadFeeCents: 0 });

    expect(run.decision).toBe("RESEARCHING");
    expect(enqueueMock).toHaveBeenCalledWith(expect.objectContaining({
      service: "WASP_NEST",
      city: "Ware",
      state: "MA",
      requestedBy: "CRM_LEAD",
      requestReason: "INCOMPLETE_RATE_SHEET",
    }));
    expect(leadEscalations).toHaveLength(0);
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

  it("a failed durable enqueue is an explicit retryable error, not a handoff", async () => {
    sheets.GENERAL_PEST = null;
    enqueueMock.mockResolvedValueOnce(false);

    const run = await priceLead({ inputText: "lead", leadFeeCents: 0 });

    expect(run.decision).toBe("ERROR");
    expect(String(run.reason)).toMatch(/could not be saved/i);
    expect(String(run.reason)).toMatch(/retry pricing/i);
    expect(leadEscalations).toHaveLength(0);
  });

  it("resumes the same run after research without extracting the lead twice", async () => {
    sheets.GENERAL_PEST = null;
    const waiting = await priceLead({ inputText: "lead", leadFeeCents: 0 });
    expect(waiting.decision).toBe("RESEARCHING");

    sheets.GENERAL_PEST = {
      oneTimeCents: 31900,
      plans: {
        QUARTERLY: { monthlyCents: 7500, initialFeeCents: 9900 },
        BIMONTHLY: { monthlyCents: 5900, initialFeeCents: 10900 },
      },
    };
    const completed = await priceLead({ resumeRunId: waiting.id });

    expect(completed.id).toBe(waiting.id);
    expect(completed.decision).toBe("QUOTE");
    expect(completed.monthlyPriceCents).toBe(7500);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      messagesCreate.mock.calls.filter(
        ([args]) => (args as { output_config?: unknown }).output_config
      )
    ).toHaveLength(1);
  });

  it("polling a still-running request is read-only and does not enqueue again", async () => {
    sheets.GENERAL_PEST = null;
    const waiting = await priceLead({ inputText: "lead", leadFeeCents: 0 });
    const rateKey = String(waiting.researchRateKey);
    coverageRows.set(rateKey, { id: rateKey, active: true, failCount: 0 });

    const polled = await priceLead({ resumeRunId: waiting.id });

    expect(polled.id).toBe(waiting.id);
    expect(polled.decision).toBe("RESEARCHING");
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(lambdaInvokes).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(pricingRuns).toHaveLength(1);
  });

  it("a pinned incomplete rate reports the exact office correction", async () => {
    extraction = {
      ...baseExtraction,
      propertyType: "specialty",
      specialtyKind: "wasp_nest",
      nestCount: 2,
    };
    marketRateMock.mockResolvedValueOnce({
      priceCents: 28900,
      sheet: { oneTimeCents: 28900 },
      basis: "office rate",
      cached: true,
      pinned: true,
    });

    const run = await priceLead({ inputText: "lead", leadFeeCents: 0 });

    expect(run.decision).toBe("ERROR");
    expect(String(run.reason)).toMatch(/Unpin that exact Market Rate/i);
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(leadEscalations).toHaveLength(0);
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

  it("prices a wildlife lead by animal count — not sqft — as an exclusion/removal visit", async () => {
    extraction = {
      ...baseExtraction,
      eligibility: "wildlife",
      pest: "squirrels in the attic",
    };

    const run = await priceLead({ inputText: "lead", leadFeeCents: 0 });

    expect(run.decision).toBe("QUOTE");
    expect(run.oneTimePriceCents).toBe(59900); // base visit (single animal)
    expect(String(run.service)).toContain("Wildlife exclusion and removal");
    // Priced by animal count — the cache lookup carries no sqft band.
    const wildlifeCall = marketRateMock.mock.calls
      .map((c: unknown[]) => c[0] as { service: string; sqft?: number })
      .find((a) => a.service === "WILDLIFE");
    expect(wildlifeCall).toBeDefined();
    expect(wildlifeCall!.sqft).toBeUndefined();
  });

  it("adds the sheet's extra-animal increment per additional wildlife animal", async () => {
    sheets.WILDLIFE = { oneTimeCents: 59900, extraAnimalCents: 12900 };
    extraction = {
      ...baseExtraction,
      eligibility: "wildlife",
      pest: "a family of raccoons",
      animalCount: 3, // base + 2 extra
    };

    const run = await priceLead({ inputText: "lead", leadFeeCents: 0 });

    expect(run.decision).toBe("QUOTE");
    expect(run.oneTimePriceCents).toBe(85700); // 59900 + 2 × 12900
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
      json: async () => routeMatrix(60), // 60 min → Zone B
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

  it("a cache miss researches each new kind without handing it to a human", async () => {
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

      expect(run.decision).toBe("RESEARCHING");
      expect(String(run.reason)).toMatch(/finish automatically/i);
      expect(run.replyText).toBeUndefined();
      expect(enqueueMock).toHaveBeenCalledTimes(1);
      expect(leadEscalations).toHaveLength(0);
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

  it("an HOA cache miss researches like every other service — band-less enqueue", async () => {
    sheets.HOA = null;
    extraction = hoaExtraction();

    const run = await priceLead({ inputText: "lead", leadFeeCents: 0 });

    expect(run.decision).toBe("RESEARCHING");
    expect(enqueueMock).toHaveBeenCalledWith(expect.objectContaining({
      service: "HOA",
      city: "Ware",
      state: "MA",
      requestedBy: "CRM_LEAD",
      requestReason: "MISSING_RATE_SHEET",
    }));
    expect(leadEscalations).toHaveLength(0);
  });
});

describe("explicit staff market research — exactly one existing rate", () => {
  const rateKey = "GENERAL_PEST#ware-ma#2000";
  const request = async (args: Record<string, unknown>) =>
    (await handler({
      arguments: args,
      identity: {
        sub: "u1",
        groups: ["OWNER"],
        claims: { email: "office@example.com" },
      },
      fieldName: "requestPricingResearch",
    } as never)) as Record<string, unknown>;

  beforeEach(() => {
    process.env.PRICING_REFRESH_FUNCTION_NAME = "pricing-refresh-test";
    marketRows.push({
      id: "mr-live",
      rateKey,
      service: "GENERAL_PEST",
      areaKey: "ware-ma",
      priceCents: 31900,
      active: true,
      pinned: false,
      researchedAt: "2026-06-01T00:00:00.000Z",
    });
  });

  it("stamps and wakes only the selected rate with an attributable reason", async () => {
    const result = await request({
      rateKey,
      reasonCode: "COMPETITOR_CHANGE",
      note: "Two local competitors changed plans",
    });

    expect(result).toEqual({ ok: true, rateKey });
    expect([...coverageRows.keys()]).toEqual([rateKey]);
    expect(coverageRows.get(rateKey)).toMatchObject({
      source: "MANUAL",
      active: true,
      researchRequestedBy: "office@example.com",
      researchRequestReason:
        "COMPETITOR_CHANGE — Two local competitors changed plans",
    });
    expect(coverageRows.get(rateKey)?.researchRequestedAt).toBeTruthy();
    expect(lambdaInvokes).toHaveLength(1);
    expect(
      JSON.parse(
        Buffer.from(lambdaInvokes[0].Payload as Uint8Array).toString("utf8")
      )
    ).toEqual({ rateKey, source: "manual" });
  });

  it("refuses to research over an office-pinned rate", async () => {
    marketRows[0].pinned = true;

    await expect(
      request({ rateKey, reasonCode: "MARGIN_REVIEW" })
    ).rejects.toThrow(/Unpin the office rate/i);
    expect(coverageRows.size).toBe(0);
    expect(lambdaInvokes).toHaveLength(0);
  });

  it("requires a controlled business reason and an explanation for OTHER", async () => {
    await expect(
      request({ rateKey, reasonCode: "FELT_LIKE_IT" })
    ).rejects.toThrow(/business reason/i);
    await expect(
      request({ rateKey, reasonCode: "OTHER" })
    ).rejects.toThrow(/Explain/i);
    expect(coverageRows.size).toBe(0);
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

  it("carries the lead's tokenized funnel URL when the caller resolved one", () => {
    const tokenized = `${FUNNEL}?lead=tok-abc123def4567890`;

    const reply = templateReply({ ...facts, funnelUrl: tokenized });

    expect(reply).toContain(tokenized);
    // And the token cannot trip the amount guard — no digits read as money.
    expect(replyUsesOnlyAllowedAmounts(reply, ["$169"])).toBe(true);
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

describe("GL-16 — the one reasoned, authorized catalog rollback", () => {
  beforeEach(() => {
    versionRows.clear();
    versionRows.set("cv-good", {
      id: "cv-good",
      manifestJson: JSON.stringify({ "GENERAL_PEST#ware-ma#2000": "mr-1" }),
      keyCount: 1,
    });
  });
  const rollback = async (
    args: Record<string, unknown>,
    groups: string[] = ["OWNER"]
  ) =>
    (await handler({
      arguments: args,
      identity: { sub: "u1", groups },
      fieldName: "rollbackPricing",
    } as never)) as Record<string, unknown>;
  const clear = async (groups: string[] = ["OWNER"]) =>
    (await handler({
      arguments: {},
      identity: { sub: "u1", groups },
      fieldName: "clearPricingRollback",
    } as never)) as Record<string, unknown>;

  it("an OWNER rolls the catalog back to an immutable VERSION in one write, recorded", async () => {
    const res = await rollback({
      versionId: "cv-good",
      reasonCode: "BAD_PROMPT_RESULT",
      note: "Friday's run tripled HOA rates",
    });

    expect(res).toMatchObject({ ok: true, versionId: "cv-good" });
    const row = controlRows.get("catalog-rollback")!;
    expect(row.rollbackVersionId).toBe("cv-good");
    expect(String(row.rollbackReason)).toContain("BAD_PROMPT_RESULT");
    expect(String(row.rollbackReason)).toContain("tripled HOA rates");
    expect(row.rollbackAppliedAt).toBeTruthy();
  });

  it("price authority stays role-controlled — TECH cannot roll back or clear", async () => {
    await expect(
      rollback(
        { versionId: "cv-good", reasonCode: "OTHER", note: "x" },
        ["TECH"]
      )
    ).rejects.toThrow(/Owner role required/);
    await expect(clear(["TECH"])).rejects.toThrow(/Owner role required/);
    expect(controlRows.has("catalog-rollback")).toBe(false);
  });

  it("refuses an uncontrolled reason, a missing version, and an unreadable manifest", async () => {
    await expect(
      rollback({ versionId: "cv-good", reasonCode: "FELT_LIKE_IT" })
    ).rejects.toThrow(/controlled rollback reason/);
    await expect(
      rollback({ versionId: "cv-nope", reasonCode: "OTHER", note: "x" })
    ).rejects.toThrow(/doesn't exist/);
    versionRows.set("cv-bad", {
      id: "cv-bad",
      manifestJson: "not json at all",
    });
    await expect(
      rollback({ versionId: "cv-bad", reasonCode: "OTHER", note: "x" })
    ).rejects.toThrow(/unreadable/);
    expect(controlRows.has("catalog-rollback")).toBe(false);
  });

  it("clearing resumes the newest rates and records who cleared; clearing twice is harmless", async () => {
    await rollback({
      versionId: "cv-good",
      reasonCode: "MODEL_ERROR",
    });

    const res = await clear();
    expect(res).toMatchObject({ ok: true });
    const row = controlRows.get("catalog-rollback")!;
    expect(row.rollbackVersionId).toBeUndefined();
    expect(row.rollbackClearedAt).toBeTruthy();

    await expect(clear()).resolves.toMatchObject({ ok: true });
  });
});
