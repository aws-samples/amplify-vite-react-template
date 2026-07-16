import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The AI market-rate engine — every base price in one researched sheet.
 *
 * One research call per (service, area, size band) yields a full rate sheet
 * cached on one MarketRate row. Exactly two guardrails: the variable-cost
 * floor (one-time components only — plans and the extra-nest increment have
 * no deterministic cost model and deliberately carry no floor), and the
 * callback fallback (no research result never yields a made-up price —
 * null, so the funnel CONTACTs). Deliberately NO min/max clamps, NO upper
 * bound, NO review queue.
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
};

const rows: Row[] = [];
const created: Row[] = [];

const fakeDataClient = {
  models: {
    MarketRate: {
      listMarketRateByRateKey: async ({ rateKey }: { rateKey: string }) => ({
        data: rows.filter((r) => r.rateKey === rateKey),
      }),
      list: async ({
        filter,
        limit,
      }: {
        filter?: { researchedAt?: { gt?: string } };
        limit?: number;
      }) => {
        const since = filter?.researchedAt?.gt;
        const data = rows.filter(
          (r) => r.researchedAt && (!since || r.researchedAt > since)
        );
        return { data: data.slice(0, limit ?? data.length) };
      },
      create: async (input: Record<string, unknown>) => {
        const row = { id: `mr${rows.length + 1}`, ...input } as Row;
        rows.push(row);
        created.push(row);
        return { data: row };
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

const { marketRate, hoaBandFor } = await import("./marketRate");

const GP_TEXT = `Local operators in the Ware MA area quote these numbers for a 2,000 sqft home.
ONE_TIME_USD: 320
MONTHLY_PLAN_PER_MONTH_USD: 95
MONTHLY_PLAN_INITIAL_FEE_USD: 110
BIMONTHLY_PLAN_PER_MONTH_USD: 60
BIMONTHLY_PLAN_INITIAL_FEE_USD: 110
QUARTERLY_PLAN_PER_MONTH_USD: 48
QUARTERLY_PLAN_INITIAL_FEE_USD: 100`;

const gpCall = () =>
  marketRate({
    anthropicKey: "test-key",
    service: "GENERAL_PEST",
    city: "Ware",
    state: "MA",
    sqft: 1800, // → 2000 band
  });

beforeEach(() => {
  rows.length = 0;
  created.length = 0;
  officeEmails.length = 0;
  messagesCreate.mockClear();
  researchText = GP_TEXT;
  process.env.CRM_APP_URL = "https://crm.example.test";
});

describe("one research call yields one stored sheet with every component", () => {
  it("stores the GENERAL_PEST sheet (one-time + all three plan cadences) on one row", async () => {
    const res = await gpCall();

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
    expect(res).toMatchObject({ priceCents: 31900, cached: false });
    expect(res!.sheet.plans!.QUARTERLY).toEqual({
      monthlyCents: 4900,
      initialFeeCents: 9900,
    });
  });

  it("folds the wasp extra-nest price into the WASP_NEST sheet", async () => {
    researchText = "Typical local pricing.\nFIRST_NEST_USD: 285\nEXTRA_NEST_USD: 95";

    const res = await marketRate({
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

describe("cache semantics", () => {
  it("a cache hit serves the stored sheet without re-researching", async () => {
    await gpCall();
    messagesCreate.mockClear();

    const res = await gpCall();

    expect(messagesCreate).not.toHaveBeenCalled();
    expect(res).toMatchObject({ priceCents: 31900, cached: true });
    expect(res!.sheet.plans!.MONTHLY.monthlyCents).toBe(9900);
    expect(rows).toHaveLength(1);
  });

  it("an office-overridden row wins — priceCents beats the sheet's one-time", async () => {
    await gpCall();
    rows[0].priceCents = 25000; // office edit from the Market Rates screen

    const res = await gpCall();

    expect(res).toMatchObject({ priceCents: 25000, cached: true });
    expect(res!.sheet.oneTimeCents).toBe(25000);
    // The rest of the sheet still serves.
    expect(res!.sheet.plans!.QUARTERLY.monthlyCents).toBe(4900);
  });

  it("an expired row re-researches instead of serving a stale price", async () => {
    await gpCall();
    rows[0].expiresAt = new Date(Date.now() - 1000).toISOString();
    rows[0].researchedAt = new Date(Date.now() - 2 * 24 * 3600_000).toISOString();
    messagesCreate.mockClear();

    const res = await gpCall();

    expect(messagesCreate).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(2);
    expect(res).toMatchObject({ cached: false });
  });

  it("a retired (inactive) row forces fresh research too", async () => {
    await gpCall();
    rows[0].active = false;
    messagesCreate.mockClear();

    await gpCall();

    expect(messagesCreate).toHaveBeenCalledTimes(1);
  });
});

describe("pinned rows — an office edit never expires or re-researches", () => {
  it("a pinned row past its expiry still serves, without a research call", async () => {
    await gpCall();
    rows[0].pinned = true; // the office edited this sheet
    rows[0].expiresAt = new Date(Date.now() - 1000).toISOString();
    messagesCreate.mockClear();

    const res = await gpCall();

    expect(messagesCreate).not.toHaveBeenCalled();
    expect(res).toMatchObject({ priceCents: 31900, cached: true });
    expect(rows).toHaveLength(1);
  });

  it("un-pinning an expired row hands it back to the research cycle", async () => {
    await gpCall();
    rows[0].pinned = true;
    rows[0].expiresAt = new Date(Date.now() - 1000).toISOString();
    await gpCall(); // pinned: served from cache
    rows[0].pinned = false;
    messagesCreate.mockClear();

    const res = await gpCall();

    expect(messagesCreate).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(2);
    expect(res).toMatchObject({ cached: false });
  });

  it("a pinned row that is retired (inactive) no longer serves — retire still wins", async () => {
    await gpCall();
    rows[0].pinned = true;
    rows[0].active = false;
    messagesCreate.mockClear();

    await gpCall();

    expect(messagesCreate).toHaveBeenCalledTimes(1);
  });

  it("fresh research is cached unpinned — only the office pins", async () => {
    await gpCall();

    expect(created[0].pinned).toBe(false);
  });
});

describe("callback fallback — no research result never yields a price", () => {
  it("junk research (no parseable lines) returns null and stores nothing", async () => {
    researchText = "I could not find reliable pricing for this area.";

    const res = await gpCall();

    expect(res).toBeNull();
    expect(rows).toHaveLength(0);
    expect(officeEmails).toHaveLength(0);
  });

  it("a partial sheet is a junk sheet — every component or nothing", async () => {
    researchText = GP_TEXT.split("\n").slice(0, -1).join("\n"); // drop quarterly initial

    const res = await gpCall();

    expect(res).toBeNull();
    expect(rows).toHaveLength(0);
  });

  it("missing MONTHLY lines are not satisfied by the BIMONTHLY substrings", async () => {
    // MONTHLY_* is a substring of BIMONTHLY_* — an unanchored label match
    // once priced the monthly plan at bimonthly rates for 90 days.
    researchText = GP_TEXT.split("\n")
      .filter((l) => !l.startsWith("MONTHLY_"))
      .join("\n");

    const res = await gpCall();

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

    const res = await gpCall();

    // Tidy $X9 rounding applies: 95 → $99, 60 → $59 — what matters here is
    // that each cadence kept its own researched value.
    expect(res?.sheet.plans?.MONTHLY.monthlyCents).toBe(9900);
    expect(res?.sheet.plans?.BIMONTHLY.monthlyCents).toBe(5900);
  });

  it("a missing API key returns null without calling Anthropic", async () => {
    const res = await marketRate({
      anthropicKey: null,
      service: "GENERAL_PEST",
      city: "Ware",
      state: "MA",
      sqft: 1800,
    });

    expect(res).toBeNull();
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it("a spent daily research budget returns null — but cache hits still serve", async () => {
    const now = new Date().toISOString();
    for (let i = 0; i < 25; i++) {
      rows.push({
        id: `seed${i}`,
        rateKey: `RODENT#elsewhere-${i}-ma`,
        priceCents: 19900,
        active: true,
        researchedAt: now,
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      });
    }

    const miss = await gpCall();
    expect(miss).toBeNull();
    expect(messagesCreate).not.toHaveBeenCalled();

    const hit = await marketRate({
      anthropicKey: "test-key",
      service: "RODENT",
      city: "Elsewhere 3",
      state: "MA",
    });
    expect(hit).toMatchObject({ priceCents: 19900, cached: true });
  });

  it("the Anthropic call throwing returns null", async () => {
    messagesCreate.mockRejectedValueOnce(new Error("timeout"));

    const res = await gpCall();

    expect(res).toBeNull();
    expect(rows).toHaveLength(0);
  });
});

describe("variable-cost floor — the only downside guardrail", () => {
  it("floors a researched one-time price at the deterministic Zone-A cost", async () => {
    // rodent_nest: (90+40)/60×$42 + 30mi×$0.30 + $55 = $155 variable cost.
    researchText = "Cut-rate operators advertise $80.\nONE_TIME_USD: 80";

    const res = await marketRate({
      anthropicKey: "test-key",
      service: "RODENT",
      city: "Ware",
      state: "MA",
      sqft: 2000,
    });

    expect(res!.priceCents).toBe(15500);
    expect(created[0].priceCents).toBe(15500);
    expect(String(created[0].basis)).toContain("floored at Zone-A variable cost");
  });

  it("has no upper bound — a big researched price ships as researched", async () => {
    researchText = "Severe infestation pricing.\nONE_TIME_USD: 4750";

    const res = await marketRate({
      anthropicKey: "test-key",
      service: "ROACH",
      city: "Ware",
      state: "MA",
      sqft: 2000,
    });

    expect(res!.priceCents).toBe(474900); // tidy($4,750) — no clamp
  });

  it("applies no floor to components with no cost model, and says so on the row", async () => {
    // Monthly plan researched absurdly low — no deterministic per-visit cost
    // model exists for recurring cadences, so it ships as researched rather
    // than inventing economics.
    researchText = GP_TEXT.replace(
      "MONTHLY_PLAN_PER_MONTH_USD: 95",
      "MONTHLY_PLAN_PER_MONTH_USD: 10"
    );

    const res = await gpCall();

    expect(res!.sheet.plans!.MONTHLY.monthlyCents).toBe(900); // tidy($10)
    expect(String(created[0].basis)).toContain(
      "plan prices carry no variable-cost floor"
    );
  });

  it("leaves the wasp extra-nest increment unfloored and records that", async () => {
    researchText = "Typical local pricing.\nFIRST_NEST_USD: 285\nEXTRA_NEST_USD: 5";

    const res = await marketRate({
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

  const hoaCall = () =>
    marketRate({
      anthropicKey: "test-key",
      service: "HOA",
      city: "Ware",
      state: "MA",
    });

  it("stores every band × cadence on one sheet, with exact per-unit cents (no $X9 tidying)", async () => {
    researchText = HOA_TEXT;

    const res = await hoaCall();

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

    await hoaCall();

    expect(String(created[0].basis)).toContain(
      "HOA per-unit rates carry no variable-cost floor"
    );
  });

  it("a partial band grid is a junk sheet — every combination or nothing", async () => {
    researchText = HOA_TEXT.split("\n").slice(0, -1).join("\n"); // drop 101+/quarterly

    const res = await hoaCall();

    expect(res).toBeNull();
    expect(rows).toHaveLength(0);
  });

  it("a cache hit serves the stored per-unit sheet without inventing a one-time", async () => {
    researchText = HOA_TEXT;
    await hoaCall();
    messagesCreate.mockClear();

    const res = await hoaCall();

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
    await gpCall();

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

  it("does not email on a cache hit", async () => {
    await gpCall();
    officeEmails.length = 0;

    await gpCall();

    expect(officeEmails).toHaveLength(0);
  });

  it("mentions the floor when it was applied", async () => {
    researchText = "Cut-rate operators advertise $80.\nONE_TIME_USD: 80";

    await marketRate({
      anthropicKey: "test-key",
      service: "RODENT",
      city: "Ware",
      state: "MA",
      sqft: 2000,
    });

    expect(officeEmails[0].bodyHtml).toContain("floored at Zone-A variable cost");
  });
});
