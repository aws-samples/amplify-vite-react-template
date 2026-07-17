import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The AI market-rate engine — every base price in one researched sheet.
 *
 * The live path (getCachedRate) is PURE READS with serve-last-known-good:
 * an expired sheet still serves, a pinned sheet serves forever, only a
 * combo with no sheet at all returns null — and reading NEVER researches.
 * Misses are recorded with enqueueRateResearch (idempotent RateCoverage
 * upsert, notify list capped) for the hourly cron. Research itself
 * (researchAndCacheRate) is the cron's machinery: one call per (service,
 * area, size band) yields a full sheet cached on one MarketRate row, with
 * prev-values recorded on refresh for the weekly diff. Guardrails: the
 * variable-cost floor (one-time components only) and every-component-or-
 * nothing parsing. Deliberately NO min/max clamps, NO upper bound, NO
 * review queue.
 */

type Row = Record<string, unknown> & {
  id: string;
  rateKey: string;
  priceCents: number;
  active: boolean;
  pinned?: boolean;
  ratesJson?: string;
  basis?: string;
  researchedAt?: string;
  expiresAt?: string;
  prevPriceCents?: number;
  prevResearchedAt?: string;
};

type CovRow = Record<string, unknown> & {
  id: string;
  source: string;
  active: boolean;
  failCount?: number;
  notify?: string;
};

const rows: Row[] = [];
const created: Row[] = [];
const covRows: CovRow[] = [];
let covGetThrows = false;

const fakeDataClient = {
  models: {
    MarketRate: {
      listMarketRateByRateKey: async ({ rateKey }: { rateKey: string }) => ({
        data: rows.filter((r) => r.rateKey === rateKey),
      }),
      create: async (input: Record<string, unknown>) => {
        const row = { id: `mr${rows.length + 1}`, ...input } as Row;
        rows.push(row);
        created.push(row);
        return { data: row };
      },
      update: async (input: Record<string, unknown> & { id: string }) => {
        const row = rows.find((r) => r.id === input.id);
        if (row) Object.assign(row, input);
        return { data: row ?? null };
      },
    },
    RateCoverage: {
      get: async ({ id }: { id: string }) => {
        if (covGetThrows) throw new Error("dynamo down");
        return { data: covRows.find((r) => r.id === id) ?? null };
      },
      create: async (input: Record<string, unknown> & { id: string }) => {
        if (covRows.some((r) => r.id === input.id)) {
          return { data: null, errors: [{ message: "conditional check failed" }] };
        }
        const row = { ...input } as CovRow;
        covRows.push(row);
        return { data: row };
      },
      update: async (input: Record<string, unknown> & { id: string }) => {
        const row = covRows.find((r) => r.id === input.id);
        if (row) Object.assign(row, input);
        return { data: row ?? null };
      },
    },
  },
};
vi.mock("./dataClient", () => ({ dataClient: async () => fakeDataClient }));

const officeEmails: { subject: string; bodyHtml: string }[] = [];
vi.mock("./email", () => ({
  emailShell: (h: string, b: string) => `${h}${b}`,
  sendEmail: async () => true,
  notifyOffice: async (o: { subject: string; bodyHtml: string }) => {
    officeEmails.push(o);
    return true;
  },
}));

/** The research pass: tests set the text Claude "returns". */
let researchText: string;
const messagesCreate = vi.fn(async () => ({
  content: [{ type: "text", text: researchText }],
}));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: messagesCreate };
  },
}));

const {
  enqueueRateResearch,
  getCachedRate,
  hoaBandFor,
  NOTIFY_CAP,
  researchAndCacheRate,
} = await import("./marketRate");

const GP_TEXT = `Local operators in the Ware MA area quote these numbers for a 2,000 sqft home.
ONE_TIME_USD: 320
MONTHLY_PLAN_PER_MONTH_USD: 95
MONTHLY_PLAN_INITIAL_FEE_USD: 110
BIMONTHLY_PLAN_PER_MONTH_USD: 60
BIMONTHLY_PLAN_INITIAL_FEE_USD: 110
QUARTERLY_PLAN_PER_MONTH_USD: 48
QUARTERLY_PLAN_INITIAL_FEE_USD: 100`;

const gpArgs = {
  service: "GENERAL_PEST",
  city: "Ware",
  state: "MA",
  sqft: 1800, // → 2000 band
} as const;

const gpResearch = () =>
  researchAndCacheRate({ anthropicKey: "test-key", ...gpArgs });

const gpRead = () => getCachedRate({ ...gpArgs });

beforeEach(() => {
  rows.length = 0;
  created.length = 0;
  covRows.length = 0;
  covGetThrows = false;
  officeEmails.length = 0;
  messagesCreate.mockClear();
  researchText = GP_TEXT;
  process.env.CRM_APP_URL = "https://crm.example.test";
});

describe("one research call yields one stored sheet with every component", () => {
  it("stores the GENERAL_PEST sheet (one-time + all three plan cadences) on one row", async () => {
    const res = await gpResearch();

    expect(messagesCreate).toHaveBeenCalledTimes(1);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      rateKey: "GENERAL_PEST#ware-ma#2000",
      service: "GENERAL_PEST",
      areaKey: "ware-ma",
      priceCents: 31900, // tidy($320) — mirrors the sheet's one-time price
      active: true,
    });
    const sheet = JSON.parse(String(created[0].ratesJson));
    expect(sheet).toEqual({
      oneTimeCents: 31900,
      plans: {
        MONTHLY: { monthlyCents: 9900, initialFeeCents: 10900 },
        BIMONTHLY: { monthlyCents: 5900, initialFeeCents: 10900 },
        QUARTERLY: { monthlyCents: 4900, initialFeeCents: 9900 },
      },
    });
    expect(res).toMatchObject({
      priceCents: 31900,
      prevPriceCents: null,
      prevResearchedAt: null,
    });
    expect(res!.sheet.plans!.QUARTERLY).toEqual({
      monthlyCents: 4900,
      initialFeeCents: 9900,
    });
  });

  it("folds the wasp extra-nest price into the WASP_NEST sheet", async () => {
    researchText = "Typical local pricing.\nFIRST_NEST_USD: 285\nEXTRA_NEST_USD: 95";

    const res = await researchAndCacheRate({
      anthropicKey: "test-key",
      service: "WASP_NEST",
      city: "Ware",
      state: "MA",
    });

    expect(created[0].rateKey).toBe("WASP_NEST#ware-ma");
    expect(res!.sheet).toEqual({ oneTimeCents: 28900, extraNestCents: 9900 });
    expect(res!.priceCents).toBe(28900);
  });
});

describe("the live path — pure reads, serve-last-known-good", () => {
  it("a cache hit serves the stored sheet, and reading never researches", async () => {
    await gpResearch();
    messagesCreate.mockClear();

    const res = await gpRead();

    expect(messagesCreate).not.toHaveBeenCalled();
    expect(res).toMatchObject({ priceCents: 31900, cached: true });
    expect(res!.sheet.plans!.MONTHLY.monthlyCents).toBe(9900);
    expect(rows).toHaveLength(1);
  });

  it("an office-overridden row wins — priceCents beats the sheet's one-time", async () => {
    await gpResearch();
    rows[0].priceCents = 25000; // office edit from the Market Rates screen

    const res = await gpRead();

    expect(res).toMatchObject({ priceCents: 25000, cached: true });
    expect(res!.sheet.oneTimeCents).toBe(25000);
    // The rest of the sheet still serves.
    expect(res!.sheet.plans!.QUARTERLY.monthlyCents).toBe(4900);
  });

  it("an EXPIRED row still serves — staleness beats a callback, expiry means due-for-refresh", async () => {
    await gpResearch();
    rows[0].expiresAt = new Date(Date.now() - 1000).toISOString();
    rows[0].researchedAt = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
    messagesCreate.mockClear();

    const res = await gpRead();

    expect(messagesCreate).not.toHaveBeenCalled();
    expect(res).toMatchObject({ priceCents: 31900, cached: true });
    expect(rows).toHaveLength(1); // nothing re-researched, nothing created
  });

  it("a pinned row past its expiry serves forever, without a research call", async () => {
    await gpResearch();
    rows[0].pinned = true; // the office edited this sheet
    rows[0].expiresAt = new Date(Date.now() - 1000).toISOString();
    messagesCreate.mockClear();

    const res = await gpRead();

    expect(messagesCreate).not.toHaveBeenCalled();
    expect(res).toMatchObject({ priceCents: 31900, cached: true });
  });

  it("a retired (inactive) row no longer serves — retire still wins over everything", async () => {
    await gpResearch();
    rows[0].pinned = true;
    rows[0].active = false;
    messagesCreate.mockClear();

    const res = await gpRead();

    expect(res).toBeNull();
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it("a combo with no sheet at all returns null — and never researches", async () => {
    const res = await gpRead();

    expect(res).toBeNull();
    expect(messagesCreate).not.toHaveBeenCalled();
    expect(rows).toHaveLength(0);
  });

  it("with several active rows the freshest research serves; a pinned one beats it", async () => {
    const old = {
      id: "a",
      rateKey: "GENERAL_PEST#ware-ma#2000",
      priceCents: 11100,
      active: true,
      researchedAt: "2026-06-01T00:00:00Z",
    };
    const fresh = {
      id: "b",
      rateKey: "GENERAL_PEST#ware-ma#2000",
      priceCents: 22200,
      active: true,
      researchedAt: "2026-07-01T00:00:00Z",
    };
    rows.push(old as Row, fresh as Row);

    expect((await gpRead())!.priceCents).toBe(22200);

    (old as Row).pinned = true; // the office's word beats fresher research
    expect((await gpRead())!.priceCents).toBe(11100);
  });
});

describe("demand-enqueue — an idempotent RateCoverage upsert per combo", () => {
  const miss = (extra: Record<string, unknown> = {}) =>
    enqueueRateResearch({ ...gpArgs, ...extra });

  it("records a miss keyed by the combo, DEMAND, active, with the waiting lead", async () => {
    await miss({ notifyEmail: "Lead@Example.com", bookingRequestId: "bk1" });

    expect(covRows).toHaveLength(1);
    expect(covRows[0]).toMatchObject({
      id: "GENERAL_PEST#ware-ma#2000", // sqft 1800 → the 2000 band
      service: "GENERAL_PEST",
      areaKey: "ware-ma",
      city: "Ware",
      state: "MA",
      band: 2000,
      source: "DEMAND",
      failCount: 0,
      active: true,
    });
    expect(JSON.parse(covRows[0].notify!)).toEqual([
      { email: "lead@example.com", bookingRequestId: "bk1" },
    ]);
  });

  it("is idempotent per combo — a second miss appends, never duplicates the row", async () => {
    await miss({ notifyEmail: "a@x.com", bookingRequestId: "bk1" });
    await miss({ notifyEmail: "b@x.com", bookingRequestId: "bk2" });

    expect(covRows).toHaveLength(1);
    expect(JSON.parse(covRows[0].notify!)).toEqual([
      { email: "a@x.com", bookingRequestId: "bk1" },
      { email: "b@x.com", bookingRequestId: "bk2" },
    ]);
  });

  it("dedupes the same lead asking twice", async () => {
    await miss({ notifyEmail: "a@x.com", bookingRequestId: "bk1" });
    await miss({ notifyEmail: "A@X.com", bookingRequestId: "bk1" });

    expect(JSON.parse(covRows[0].notify!)).toHaveLength(1);
  });

  it(`caps the notify list at ${NOTIFY_CAP} — overflow leads still get the research, not the email`, async () => {
    for (let i = 0; i < NOTIFY_CAP + 2; i++) {
      await miss({ notifyEmail: `lead${i}@x.com`, bookingRequestId: `bk${i}` });
    }

    expect(covRows).toHaveLength(1);
    expect(JSON.parse(covRows[0].notify!)).toHaveLength(NOTIFY_CAP);
  });

  it("a real miss promotes a seeded row to DEMAND; seeding never demotes it back", async () => {
    await miss({ source: "SEED" });
    expect(covRows[0].source).toBe("SEED");

    await miss(); // a customer actually needed this combo
    expect(covRows[0].source).toBe("DEMAND");

    await miss({ source: "SEED" }); // next hour's idempotent seeding pass
    expect(covRows[0].source).toBe("DEMAND");
  });

  it("reactivates a deactivated combo when somebody needs it again", async () => {
    await miss();
    covRows[0].active = false;

    await miss();

    expect(covRows[0].active).toBe(true);
  });

  it("never throws — losing a miss record must never fail a quote", async () => {
    covGetThrows = true;

    await expect(miss({ notifyEmail: "a@x.com" })).resolves.toBeUndefined();
    expect(covRows).toHaveLength(0);
  });
});

describe("researchAndCacheRate — the cron's machinery, and nobody else's", () => {
  it("refuses over a pinned combo — nothing researches over an office edit", async () => {
    await gpResearch();
    rows[0].pinned = true;
    rows[0].researchedAt = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
    messagesCreate.mockClear();

    const res = await gpResearch();

    expect(res).toBeNull();
    expect(messagesCreate).not.toHaveBeenCalled();
    expect(rows).toHaveLength(1);
  });

  it("a refresh records prev-values for the weekly diff and retires the superseded row", async () => {
    await gpResearch();
    const firstResearchedAt = String(rows[0].researchedAt);
    researchText = GP_TEXT.replace("ONE_TIME_USD: 320", "ONE_TIME_USD: 355");
    messagesCreate.mockClear();

    const res = await gpResearch();

    expect(rows).toHaveLength(2);
    expect(res).toMatchObject({
      priceCents: 35900, // tidy($355)
      prevPriceCents: 31900,
      prevResearchedAt: firstResearchedAt,
    });
    expect(created[1]).toMatchObject({
      prevPriceCents: 31900,
      prevResearchedAt: firstResearchedAt,
      active: true,
    });
    // Exactly one live row per combo: the old sheet retired.
    expect(rows[0].active).toBe(false);
    expect((await gpRead())!.priceCents).toBe(35900);
  });

  it("a missing API key returns null without calling Anthropic", async () => {
    const res = await researchAndCacheRate({ anthropicKey: null, ...gpArgs });

    expect(res).toBeNull();
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it("junk research (no parseable lines) returns null and stores nothing", async () => {
    researchText = "I could not find reliable pricing for this area.";

    const res = await gpResearch();

    expect(res).toBeNull();
    expect(rows).toHaveLength(0);
    expect(officeEmails).toHaveLength(0);
  });

  it("a failed refresh keeps the previous sheet serving — no rows touched", async () => {
    await gpResearch();
    researchText = "Nothing conclusive this week.";
    messagesCreate.mockClear();

    const res = await gpResearch();

    expect(res).toBeNull();
    expect(rows).toHaveLength(1);
    expect(rows[0].active).toBe(true);
    expect((await gpRead())!.priceCents).toBe(31900);
  });

  it("a partial sheet is a junk sheet — every component or nothing", async () => {
    researchText = GP_TEXT.split("\n").slice(0, -1).join("\n"); // drop quarterly initial

    const res = await gpResearch();

    expect(res).toBeNull();
    expect(rows).toHaveLength(0);
  });

  it("missing MONTHLY lines are not satisfied by the BIMONTHLY substrings", async () => {
    // MONTHLY_* is a substring of BIMONTHLY_* — an unanchored label match
    // once priced the monthly plan at bimonthly rates for 90 days.
    researchText = GP_TEXT.split("\n")
      .filter((l) => !l.startsWith("MONTHLY_"))
      .join("\n");

    const res = await gpResearch();

    expect(res).toBeNull();
    expect(rows).toHaveLength(0);
  });

  it("label order cannot cross-assign cadences — BIMONTHLY first still parses each to its own value", async () => {
    const lines = GP_TEXT.split("\n");
    researchText = [
      lines[0],
      lines[1],
      ...lines.slice(4, 6), // BIMONTHLY pair first
      ...lines.slice(2, 4), // then MONTHLY pair
      ...lines.slice(6),
    ].join("\n");

    const res = await gpResearch();

    // Tidy $X9 rounding applies: 95 → $99, 60 → $59 — what matters here is
    // that each cadence kept its own researched value.
    expect(res?.sheet.plans?.MONTHLY.monthlyCents).toBe(9900);
    expect(res?.sheet.plans?.BIMONTHLY.monthlyCents).toBe(5900);
  });

  it("the Anthropic call throwing returns null", async () => {
    messagesCreate.mockRejectedValueOnce(new Error("timeout"));

    const res = await gpResearch();

    expect(res).toBeNull();
    expect(rows).toHaveLength(0);
  });
});

describe("variable-cost floor — the only downside guardrail", () => {
  it("floors a researched one-time price at the deterministic Zone-A cost", async () => {
    // rodent_nest: (90+40)/60×$42 + 30mi×$0.30 + $55 = $155 variable cost.
    researchText = "Cut-rate operators advertise $80.\nONE_TIME_USD: 80";

    const res = await researchAndCacheRate({
      anthropicKey: "test-key",
      service: "RODENT",
      city: "Ware",
      state: "MA",
      sqft: 2000,
    });

    expect(res!.priceCents).toBe(15500);
    expect(res!.floorApplied).toBe(true);
    expect(created[0].priceCents).toBe(15500);
    expect(String(created[0].basis)).toContain("floored at Zone-A variable cost");
  });

  it("has no upper bound — a big researched price ships as researched", async () => {
    researchText = "Severe infestation pricing.\nONE_TIME_USD: 4750";

    const res = await researchAndCacheRate({
      anthropicKey: "test-key",
      service: "ROACH",
      city: "Ware",
      state: "MA",
      sqft: 2000,
    });

    expect(res!.priceCents).toBe(474900); // tidy($4,750) — no clamp
    expect(res!.floorApplied).toBe(false);
  });

  it("applies no floor to components with no cost model, and says so on the row", async () => {
    // Monthly plan researched absurdly low — no deterministic per-visit cost
    // model exists for recurring cadences, so it ships as researched rather
    // than inventing economics.
    researchText = GP_TEXT.replace(
      "MONTHLY_PLAN_PER_MONTH_USD: 95",
      "MONTHLY_PLAN_PER_MONTH_USD: 10"
    );

    const res = await gpResearch();

    expect(res!.sheet.plans!.MONTHLY.monthlyCents).toBe(900); // tidy($10)
    expect(String(created[0].basis)).toContain(
      "plan prices carry no variable-cost floor"
    );
  });

  it("leaves the wasp extra-nest increment unfloored and records that", async () => {
    researchText = "Typical local pricing.\nFIRST_NEST_USD: 285\nEXTRA_NEST_USD: 5";

    const res = await researchAndCacheRate({
      anthropicKey: "test-key",
      service: "WASP_NEST",
      city: "Ware",
      state: "MA",
    });

    expect(res!.sheet.extraNestCents).toBe(900); // tidy($5) — no floor
    expect(String(created[0].basis)).toContain(
      "extra-nest price carries no variable-cost floor"
    );
  });
});

describe("TERMITE and WILDLIFE — sqft-banded one-time sheets with no cost floor", () => {
  it("stores a sqft-banded TERMITE sheet and records the no-floor basis", async () => {
    researchText =
      "Local operators quote full liquid soil treatments around here.\nONE_TIME_USD: 850";

    const res = await researchAndCacheRate({
      anthropicKey: "test-key",
      service: "TERMITE",
      city: "Ware",
      state: "MA",
      sqft: 1800,
    });

    expect(created[0].rateKey).toBe("TERMITE#ware-ma#2000");
    expect(res!.sheet).toEqual({ oneTimeCents: 84900 }); // tidy($850)
    expect(res!.priceCents).toBe(84900);
    expect(res!.floorApplied).toBe(false); // no cost model — no floor to bind
    expect(String(created[0].basis)).toContain(
      "one-time price carries no variable-cost floor"
    );
  });

  it("ships a low researched WILDLIFE price unfloored — no cost model, no invented economics", async () => {
    researchText = "Exclusion visits in this area.\nONE_TIME_USD: 60";

    const res = await researchAndCacheRate({
      anthropicKey: "test-key",
      service: "WILDLIFE",
      city: "Ware",
      state: "MA",
      sqft: 2400,
    });

    expect(created[0].rateKey).toBe("WILDLIFE#ware-ma#2500");
    expect(res!.priceCents).toBe(5900); // tidy($60), deliberately unfloored
    expect(String(created[0].basis)).toContain(
      "one-time price carries no variable-cost floor"
    );
  });

  it("junk termite research refuses rather than pricing", async () => {
    researchText = "Termite pricing varies too much to say.";

    const res = await researchAndCacheRate({
      anthropicKey: "test-key",
      service: "TERMITE",
      city: "Ware",
      state: "MA",
      sqft: 2000,
    });

    expect(res).toBeNull();
    expect(rows).toHaveLength(0);
  });
});

describe("COMMERCIAL — one-time + all three plan cadences on one sheet", () => {
  const COMMERCIAL_TEXT = `Commercial pricing for a ~5,000 sqft office/retail space in central MA.
ONE_TIME_USD: 400
MONTHLY_PLAN_PER_MONTH_USD: 150
MONTHLY_PLAN_INITIAL_FEE_USD: 200
BIMONTHLY_PLAN_PER_MONTH_USD: 120
BIMONTHLY_PLAN_INITIAL_FEE_USD: 200
QUARTERLY_PLAN_PER_MONTH_USD: 100
QUARTERLY_PLAN_INITIAL_FEE_USD: 180`;

  const commercialResearch = () =>
    researchAndCacheRate({
      anthropicKey: "test-key",
      service: "COMMERCIAL",
      city: "Ware",
      state: "MA",
      sqft: 4800,
    });

  it("stores the full commercial sheet on one sqft-banded row", async () => {
    researchText = COMMERCIAL_TEXT;

    const res = await commercialResearch();

    expect(messagesCreate).toHaveBeenCalledTimes(1);
    expect(created[0].rateKey).toBe("COMMERCIAL#ware-ma#5000");
    const sheet = JSON.parse(String(created[0].ratesJson));
    expect(sheet).toEqual({
      oneTimeCents: 39900, // tidy($400)
      plans: {
        MONTHLY: { monthlyCents: 14900, initialFeeCents: 19900 },
        BIMONTHLY: { monthlyCents: 11900, initialFeeCents: 19900 },
        QUARTERLY: { monthlyCents: 9900, initialFeeCents: 17900 },
      },
    });
    expect(res).toMatchObject({ priceCents: 39900 });
  });

  it("a partial commercial sheet is a junk sheet — every component or nothing", async () => {
    researchText = COMMERCIAL_TEXT.split("\n").slice(0, -1).join("\n");

    const res = await commercialResearch();

    expect(res).toBeNull();
    expect(rows).toHaveLength(0);
  });

  it("records that no floor applies anywhere on the commercial sheet", async () => {
    researchText = COMMERCIAL_TEXT;

    await commercialResearch();

    const basis = String(created[0].basis);
    expect(basis).toContain("one-time price carries no variable-cost floor");
    expect(basis).toContain("plan prices carry no variable-cost floor");
  });

  it("the new-rate office email renders the commercial shape", async () => {
    researchText = COMMERCIAL_TEXT;

    await commercialResearch();

    expect(officeEmails).toHaveLength(1);
    expect(officeEmails[0].subject).toBe(
      "New AI rate cached — COMMERCIAL · ware-ma · up to 5,000 sqft"
    );
    expect(officeEmails[0].bodyHtml).toContain("$399");
    expect(officeEmails[0].bodyHtml).toContain("$149/mo");
    expect(officeEmails[0].bodyHtml).toContain("$179");
  });
});

describe("HOA — per-unit monthly rates by unit-count band", () => {
  const HOA_TEXT = `Association common-area contracts in central MA, per unit per month.
UNITS_1_10_MONTHLY_PER_UNIT_USD: 22
UNITS_1_10_BIMONTHLY_PER_UNIT_USD: 18
UNITS_1_10_QUARTERLY_PER_UNIT_USD: 15
UNITS_11_25_MONTHLY_PER_UNIT_USD: 12
UNITS_11_25_BIMONTHLY_PER_UNIT_USD: 10
UNITS_11_25_QUARTERLY_PER_UNIT_USD: 8.50
UNITS_26_50_MONTHLY_PER_UNIT_USD: 9
UNITS_26_50_BIMONTHLY_PER_UNIT_USD: 7.50
UNITS_26_50_QUARTERLY_PER_UNIT_USD: 6
UNITS_51_100_MONTHLY_PER_UNIT_USD: 6.75
UNITS_51_100_BIMONTHLY_PER_UNIT_USD: 5.50
UNITS_51_100_QUARTERLY_PER_UNIT_USD: 4.50
UNITS_101_PLUS_MONTHLY_PER_UNIT_USD: 4.25
UNITS_101_PLUS_BIMONTHLY_PER_UNIT_USD: 3.50
UNITS_101_PLUS_QUARTERLY_PER_UNIT_USD: 2.75`;

  const hoaResearch = () =>
    researchAndCacheRate({
      anthropicKey: "test-key",
      service: "HOA",
      city: "Ware",
      state: "MA",
    });

  it("stores every band × cadence on one sheet, with exact per-unit cents (no $X9 tidying)", async () => {
    researchText = HOA_TEXT;

    const res = await hoaResearch();

    expect(messagesCreate).toHaveBeenCalledTimes(1);
    expect(created[0].rateKey).toBe("HOA#ware-ma");
    const sheet = JSON.parse(String(created[0].ratesJson));
    // Small per-unit dollars survive exactly — tidy($6.75) would be $9.
    expect(sheet.hoaPerUnitMonthly.UNITS_51_100).toEqual({
      MONTHLY: 675,
      BIMONTHLY: 550,
      QUARTERLY: 450,
    });
    expect(sheet.hoaPerUnitMonthly.UNITS_101_PLUS.QUARTERLY).toBe(275);
    expect(sheet.oneTimeCents).toBeUndefined();
    // The row's required priceCents column mirrors the smallest band's
    // monthly per-unit rate (an HOA sheet has no one-time to mirror).
    expect(created[0].priceCents).toBe(2200);
    expect(res!.sheet.hoaPerUnitMonthly!.UNITS_1_10.MONTHLY).toBe(2200);
  });

  it("records that HOA rates carry no cost floor — no cost model exists", async () => {
    researchText = HOA_TEXT;

    await hoaResearch();

    expect(String(created[0].basis)).toContain(
      "HOA per-unit rates carry no variable-cost floor"
    );
  });

  it("a partial band grid is a junk sheet — every combination or nothing", async () => {
    researchText = HOA_TEXT.split("\n").slice(0, -1).join("\n"); // drop 101+/quarterly

    const res = await hoaResearch();

    expect(res).toBeNull();
    expect(rows).toHaveLength(0);
  });

  it("a read serves the stored per-unit sheet without inventing a one-time", async () => {
    researchText = HOA_TEXT;
    await hoaResearch();
    messagesCreate.mockClear();

    const res = await getCachedRate({
      service: "HOA",
      city: "Ware",
      state: "MA",
    });

    expect(messagesCreate).not.toHaveBeenCalled();
    expect(res).toMatchObject({ cached: true });
    expect(res!.sheet.oneTimeCents).toBeUndefined();
    expect(res!.sheet.hoaPerUnitMonthly!.UNITS_26_50.BIMONTHLY).toBe(750);
  });

  it("bands mirror the retired association card's brackets", () => {
    expect(hoaBandFor(1)).toBe("UNITS_1_10");
    expect(hoaBandFor(10)).toBe("UNITS_1_10");
    expect(hoaBandFor(11)).toBe("UNITS_11_25");
    expect(hoaBandFor(25)).toBe("UNITS_11_25");
    expect(hoaBandFor(26)).toBe("UNITS_26_50");
    expect(hoaBandFor(50)).toBe("UNITS_26_50");
    expect(hoaBandFor(60)).toBe("UNITS_51_100");
    expect(hoaBandFor(100)).toBe("UNITS_51_100");
    expect(hoaBandFor(101)).toBe("UNITS_101_PLUS");
    expect(hoaBandFor(500)).toBe("UNITS_101_PLUS");
  });
});

describe("visibility, not a gate", () => {
  it("emails the office once when a NEW sheet is cached — with the sheet and the screen to override it", async () => {
    await gpResearch();

    expect(officeEmails).toHaveLength(1);
    expect(officeEmails[0].subject).toBe(
      "New AI rate cached — GENERAL_PEST · ware-ma · up to 2,000 sqft"
    );
    expect(officeEmails[0].bodyHtml).toContain("$319");
    expect(officeEmails[0].bodyHtml).toContain("$99/mo");
    expect(officeEmails[0].bodyHtml).toContain(
      "https://crm.example.test/market-rates"
    );
  });

  it("does not email on a read", async () => {
    await gpResearch();
    officeEmails.length = 0;

    await gpRead();

    expect(officeEmails).toHaveLength(0);
  });

  it("mentions the floor when it was applied", async () => {
    researchText = "Cut-rate operators advertise $80.\nONE_TIME_USD: 80";

    await researchAndCacheRate({
      anthropicKey: "test-key",
      service: "RODENT",
      city: "Ware",
      state: "MA",
      sqft: 2000,
    });

    expect(officeEmails[0].bodyHtml).toContain("floored at Zone-A variable cost");
  });
});
