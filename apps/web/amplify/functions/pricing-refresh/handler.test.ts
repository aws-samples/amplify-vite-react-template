import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The pricing-refresh worker — the only place research runs now. It wakes
 * immediately for a live quote miss and every five minutes for recovery.
 *
 * Every run: idempotent coverage seeding (curated towns + combos derived
 * from rates/customers/bookings), then drain due work under the caps —
 * DEMAND misses first (self-heal ≤1h with a "your prices are ready" email
 * to the waiting lead), then never-researched gaps, then sheets past the
 * weekly refresh, skipping pinned. Failures increment failCount and never
 * crash the run. Monday 10:00 UTC also emails the office the weekly
 * report — visibility, not a gate.
 */

type CovRow = Record<string, unknown> & {
  id: string;
  service: string;
  areaKey: string;
  city: string;
  state: string;
  band?: number | null;
  source: string;
  active: boolean;
  failCount?: number;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  notify?: string;
};

type RateRow = Record<string, unknown> & {
  id: string;
  rateKey: string;
  service: string;
  areaKey: string;
  priceCents: number;
  active: boolean;
  pinned?: boolean;
  basis?: string;
  researchedAt?: string;
  prevPriceCents?: number;
};

const covRows: CovRow[] = [];
const rateRows: RateRow[] = [];
const createdRates: RateRow[] = [];
const customers: Record<string, unknown>[] = [];
const bookings: Record<string, unknown>[] = [];

const fakeDataClient = {
  models: {
    MarketRate: {
      list: async () => ({ data: [...rateRows] }),
      listMarketRateByRateKey: async ({ rateKey }: { rateKey: string }) => ({
        data: rateRows.filter((r) => r.rateKey === rateKey),
      }),
      create: async (input: Record<string, unknown>) => {
        const row = { id: `mr${rateRows.length + 1}`, ...input } as RateRow;
        rateRows.push(row);
        createdRates.push(row);
        return { data: row };
      },
      update: async (input: Record<string, unknown> & { id: string }) => {
        const row = rateRows.find((r) => r.id === input.id);
        if (row) Object.assign(row, input);
        return { data: row ?? null };
      },
    },
    RateCoverage: {
      list: async () => ({ data: [...covRows] }),
      get: async ({ id }: { id: string }) => ({
        data: covRows.find((r) => r.id === id) ?? null,
      }),
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
    Customer: { list: async () => ({ data: [...customers] }) },
    BookingRequest: {
      list: async () => ({ data: [...bookings] }),
      get: async ({ id }: { id: string }) => ({
        data: bookings.find((b) => b.id === id) ?? null,
      }),
    },
  },
};
vi.mock("../shared/dataClient", () => ({ dataClient: async () => fakeDataClient }));

const sentEmails: { to: string; subject: string; template: string; html: string }[] =
  [];
const emailsThatFail = new Set<string>();
const officeEmails: { subject: string; template: string; bodyHtml: string }[] = [];
vi.mock("../shared/email", () => ({
  emailShell: (h: string, b: string) => `${h}${b}`,
  sendEmail: async (o: { to: string; subject: string; template: string; html: string }) => {
    sentEmails.push(o);
    return !emailsThatFail.has(o.to);
  },
  notifyOffice: async (o: { subject: string; template: string; bodyHtml: string }) => {
    officeEmails.push(o);
    return true;
  },
}));

vi.mock("@aws-sdk/client-ssm", () => ({
  SSMClient: class {
    send = async () => ({});
  },
  GetParameterCommand: class {},
}));

/** One response satisfying EVERY service's label set — each spec parses
 *  only its own lines, so one text prices any combo the run picks. */
const MEGA_TEXT = `Local pricing research for the area.
ONE_TIME_USD: 320
MONTHLY_PLAN_PER_MONTH_USD: 95
MONTHLY_PLAN_INITIAL_FEE_USD: 110
BIMONTHLY_PLAN_PER_MONTH_USD: 60
BIMONTHLY_PLAN_INITIAL_FEE_USD: 110
QUARTERLY_PLAN_PER_MONTH_USD: 48
QUARTERLY_PLAN_INITIAL_FEE_USD: 100
FIRST_NEST_USD: 285
EXTRA_NEST_USD: 95
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

let researchText: string;
const messagesCreate = vi.fn(async () => ({
  content: [{ type: "text", text: researchText }],
}));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: messagesCreate };
  },
}));

const { handler, RESEARCH_PER_DAY, RESEARCH_PER_RUN, SEED_TOWNS, SEED_SQFT_BUCKETS } =
  await import("./handler");

/** 6 sqft-banded services × the seed buckets + WASP_NEST + HOA, per town. */
const COMBOS_PER_TOWN = 6 * SEED_SQFT_BUCKETS.length + 2;

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const DAY = 24 * 3600_000;

/** Run the handler with no API key: seeding happens, research cannot. */
async function seedOnly() {
  delete process.env.ANTHROPIC_API_KEY;
  const summary = await handler();
  process.env.ANTHROPIC_API_KEY = "test-key";
  return summary;
}

/** Quiet the queue: every covered combo has a fresh sheet, nothing due. */
function quietAll() {
  for (const cov of covRows) {
    cov.lastSuccessAt = iso(2 * DAY);
    cov.lastAttemptAt = iso(2 * DAY);
    rateRows.push({
      id: `seed-${cov.id}`,
      rateKey: cov.id,
      service: cov.service,
      areaKey: cov.areaKey,
      priceCents: 19900,
      active: true,
      researchedAt: iso(2 * DAY),
    });
  }
}

beforeEach(() => {
  covRows.length = 0;
  rateRows.length = 0;
  createdRates.length = 0;
  customers.length = 0;
  bookings.length = 0;
  sentEmails.length = 0;
  emailsThatFail.clear();
  officeEmails.length = 0;
  messagesCreate.mockClear();
  messagesCreate.mockImplementation(async () => ({
    content: [{ type: "text", text: researchText }],
  }));
  researchText = MEGA_TEXT;
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.CRM_APP_URL = "https://crm.example.test";
  process.env.MARKETING_URL = "https://staging.example.test";
  // A Wednesday, well away from the Monday-10:00-UTC report slot.
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-15T14:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.ANTHROPIC_API_KEY;
});

describe("coverage seeding — top of the hour only, demand drains every run", () => {
  it("skips seeding off the top of the hour, but still drains a waiting DEMAND miss", async () => {
    // Seed once at the top of an hour (beforeEach is 14:00), then run again
    // mid-hour: no re-seed, but the lead waiting since the seed still gets
    // priced — the 5-minute self-heal the every-5-min cadence exists for.
    await seedOnly();
    quietAll(); // every seeded combo has a fresh sheet — nothing due
    const seededCount = covRows.length;
    covRows.push({
      id: "TERMITE#springfield-ma#3000",
      service: "TERMITE",
      areaKey: "springfield-ma",
      city: "Springfield",
      state: "MA",
      band: 3000,
      source: "DEMAND",
      active: true,
      failCount: 0,
      notify: "[]",
    });
    vi.setSystemTime(new Date("2026-07-15T14:05:00Z")); // 5 past — off the hour

    const summary = await handler();

    expect(summary.seeded).toBe(0); // no re-scan mid-hour
    expect(covRows).toHaveLength(seededCount + 1); // only the demand row we added
    expect(summary.attempted).toBe(1); // the demand miss still drained
    expect(createdRates[0].rateKey).toBe("TERMITE#springfield-ma#3000");
  });

  it("seeds the curated town list across every service kind and common band", async () => {
    await seedOnly();

    expect(covRows).toHaveLength(SEED_TOWNS.length * COMBOS_PER_TOWN);
    expect(covRows.find((c) => c.id === "GENERAL_PEST#ware-ma#2000")).toMatchObject({
      source: "SEED",
      city: "Ware",
      state: "MA",
      band: 2000,
      active: true,
    });
    expect(covRows.find((c) => c.id === "HOA#ware-ma")).toMatchObject({
      band: null,
      source: "SEED",
    });
  });

  it("is idempotent — a second run creates nothing new", async () => {
    await seedOnly();
    const count = covRows.length;

    await seedOnly();

    expect(covRows).toHaveLength(count);
  });

  it("derives SERVED combos from existing rates, customer towns, and booking requests", async () => {
    rateRows.push({
      id: "pre1",
      rateKey: "RODENT#springfield-ma#2000",
      service: "RODENT",
      areaKey: "springfield-ma",
      priceCents: 19900,
      active: true,
      researchedAt: iso(DAY),
    });
    customers.push({ serviceCity: "Amherst", serviceState: "MA" });
    bookings.push({
      propertyKind: "COMMUNITY",
      service: "GENERAL_PEST",
      city: "Granby",
      state: "MA",
      units: 30,
    });

    await seedOnly();

    // The pre-existing sheet's exact combo joins the refresh cycle.
    expect(covRows.find((c) => c.id === "RODENT#springfield-ma#2000")).toMatchObject({
      source: "SERVED",
      city: "springfield",
      band: 2000,
    });
    // Customer and booking towns get the full service × band cross.
    expect(covRows.find((c) => c.id === "GENERAL_PEST#amherst-ma#1500")).toMatchObject(
      { source: "SERVED" }
    );
    // A community booking maps to the HOA kind (no band).
    expect(covRows.find((c) => c.id === "HOA#granby-ma")).toMatchObject({
      source: "SERVED",
    });
  });
});

describe("work selection — demand first, then gaps, then weekly-due; pinned never", () => {
  it("a DEMAND miss is researched before a sheet due for weekly refresh", async () => {
    await seedOnly();
    quietAll();
    // A sheet past its weekly refresh...
    const due = rateRows.find((r) => r.rateKey === "RODENT#ware-ma#2000")!;
    due.researchedAt = iso(8 * DAY);
    // ...and a lead waiting on a combo with no sheet at all.
    covRows.push({
      id: "TERMITE#springfield-ma#3000",
      service: "TERMITE",
      areaKey: "springfield-ma",
      city: "Springfield",
      state: "MA",
      band: 3000,
      source: "DEMAND",
      active: true,
      failCount: 0,
      notify: "[]",
    });

    const summary = await handler();

    expect(summary.attempted).toBe(2);
    expect(createdRates[0].rateKey).toBe("TERMITE#springfield-ma#3000");
    expect(createdRates[1].rateKey).toBe("RODENT#ware-ma#2000");
  });

  it("a sheet fresher than a week is not touched", async () => {
    await seedOnly();
    quietAll();

    const summary = await handler();

    expect(summary.attempted).toBe(0);
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it("a pinned sheet is never refreshed, however old", async () => {
    await seedOnly();
    quietAll();
    const pinned = rateRows.find((r) => r.rateKey === "GENERAL_PEST#ware-ma#2000")!;
    pinned.pinned = true;
    pinned.researchedAt = iso(60 * DAY);

    const summary = await handler();

    expect(summary.attempted).toBe(0);
    expect(messagesCreate).not.toHaveBeenCalled();
  });
});

describe("the caps — the cron's whole research budget", () => {
  it(`a deep queue drains at most RESEARCH_PER_RUN (${RESEARCH_PER_RUN}) per run`, async () => {
    await seedOnly(); // hundreds of never-researched gap rows

    const summary = await handler();

    expect(summary.attempted).toBe(RESEARCH_PER_RUN);
    expect(messagesCreate).toHaveBeenCalledTimes(RESEARCH_PER_RUN);
  });

  it(`stops at RESEARCH_PER_DAY (${RESEARCH_PER_DAY}) across a day's runs`, async () => {
    await seedOnly();
    // A busy day so far: 140 combos already attempted within 24h.
    for (const cov of covRows.slice(0, RESEARCH_PER_DAY - 10)) {
      cov.lastAttemptAt = iso(3600_000);
    }

    const summary = await handler();

    expect(summary.budget).toBe(10);
    expect(summary.attempted).toBe(10);
  });

  it("a spent daily budget researches nothing — the queue holds for tomorrow", async () => {
    await seedOnly();
    for (const cov of covRows.slice(0, RESEARCH_PER_DAY)) {
      cov.lastAttemptAt = iso(3600_000);
    }

    const summary = await handler();

    expect(summary.attempted).toBe(0);
    expect(messagesCreate).not.toHaveBeenCalled();
  });
});

describe("refresh bookkeeping", () => {
  it("records prev-values on the new row and retires the superseded sheet", async () => {
    await seedOnly();
    quietAll();
    const due = rateRows.find((r) => r.rateKey === "WASP_NEST#ware-ma")!;
    due.priceCents = 24900;
    due.researchedAt = iso(9 * DAY);
    const dueResearchedAt = due.researchedAt;

    await handler();

    const fresh = createdRates.find((r) => r.rateKey === "WASP_NEST#ware-ma")!;
    expect(fresh).toMatchObject({
      priceCents: 28900, // tidy($285) from the researched text
      prevPriceCents: 24900,
      prevResearchedAt: dueResearchedAt,
      active: true,
    });
    expect(due.active).toBe(false);
    const cov = covRows.find((c) => c.id === "WASP_NEST#ware-ma")!;
    expect(cov.failCount).toBe(0);
    expect(cov.lastSuccessAt).toBeTruthy();
  });

  it("failures increment failCount and never crash the run", async () => {
    await seedOnly();
    quietAll();
    covRows.push({
      id: "TERMITE#nowhere-ma#2000",
      service: "TERMITE",
      areaKey: "nowhere-ma",
      city: "Nowhere",
      state: "MA",
      band: 2000,
      source: "DEMAND",
      active: true,
      failCount: 1,
      notify: "[]",
    });
    researchText = "No conclusive pricing found."; // junk → research refuses

    const summary = await handler();

    expect(summary.failed).toBe(1);
    const cov = covRows.find((c) => c.id === "TERMITE#nowhere-ma#2000")!;
    expect(cov.failCount).toBe(2);
    expect(cov.lastSuccessAt).toBeUndefined();
    expect(createdRates).toHaveLength(0);
  });

  it("the Anthropic call throwing is a counted failure, not a crash", async () => {
    await seedOnly();
    quietAll();
    covRows.push({
      id: "ROACH#nowhere-ma#2000",
      service: "ROACH",
      areaKey: "nowhere-ma",
      city: "Nowhere",
      state: "MA",
      band: 2000,
      source: "DEMAND",
      active: true,
      failCount: 0,
      notify: "[]",
    });
    messagesCreate.mockRejectedValue(new Error("overloaded"));

    const summary = await handler();

    expect(summary.failed).toBe(1);
    expect(covRows.find((c) => c.id === "ROACH#nowhere-ma#2000")!.failCount).toBe(1);
  });
});

describe("the self-heal email — a waiting lead hears the moment prices exist", () => {
  const demandRow = (): CovRow => ({
    id: "GENERAL_PEST#springfield-ma#2000",
    service: "GENERAL_PEST",
    areaKey: "springfield-ma",
    city: "Springfield",
    state: "MA",
    band: 2000,
    source: "DEMAND",
    active: true,
    failCount: 0,
    notify: JSON.stringify([
      { email: "lead1@x.com", bookingRequestId: "bk1" },
      { email: "lead2@x.com", bookingRequestId: "bk2" },
    ]),
  });

  it("emails every waiting lead once, then clears the notify list", async () => {
    await seedOnly();
    quietAll();
    bookings.push({ id: "bk1", cancelToken: "resume-token-1" });
    covRows.push(demandRow());

    await handler();

    const ready = sentEmails.filter((e) => e.template === "booking-rate-ready");
    expect(ready.map((e) => e.to)).toEqual(["lead1@x.com", "lead2@x.com"]);
    expect(ready[0].subject).toContain("Your exact prices are ready");
    expect(ready[0].html).toContain(
      "https://staging.example.test/quote#request=bk1&token=resume-token-1"
    );
    const cov = covRows.find((c) => c.id === "GENERAL_PEST#springfield-ma#2000")!;
    expect(JSON.parse(cov.notify!)).toEqual([]);

    // Next hour: the sheet exists, the combo is not due — nobody re-emailed.
    sentEmails.length = 0;
    await handler();
    expect(sentEmails.filter((e) => e.template === "booking-rate-ready")).toHaveLength(0);
  });

  it("keeps a failed delivery queued and retries it without researching again", async () => {
    await seedOnly();
    quietAll();
    covRows.push(demandRow());
    emailsThatFail.add("lead2@x.com");

    await handler();

    const cov = covRows.find((c) => c.id === "GENERAL_PEST#springfield-ma#2000")!;
    expect(JSON.parse(cov.notify!)).toEqual([
      { email: "lead2@x.com", bookingRequestId: "bk2", ready: true },
    ]);

    emailsThatFail.clear();
    sentEmails.length = 0;
    await handler();

    expect(messagesCreate).toHaveBeenCalledTimes(1); // first run only
    expect(sentEmails.filter((e) => e.template === "booking-rate-ready").map((e) => e.to))
      .toEqual(["lead2@x.com"]);
    expect(JSON.parse(cov.notify!)).toEqual([]);
  });

  it("does not announce ready when a live partial sheet still needs research", async () => {
    await seedOnly();
    quietAll();
    const demand = demandRow();
    covRows.push(demand);
    rateRows.push({
      id: "partial-sheet",
      rateKey: demand.id,
      service: demand.service,
      areaKey: demand.areaKey,
      priceCents: 32000,
      active: true,
      researchedAt: new Date().toISOString(),
    });

    const summary = await handler();

    expect(summary.attempted).toBe(0);
    expect(sentEmails.filter((e) => e.template === "booking-rate-ready"))
      .toHaveLength(0);
    expect(JSON.parse(demand.notify!)).toHaveLength(2);
  });

  it("sends nothing when research fails — the lead is emailed only with real prices", async () => {
    await seedOnly();
    quietAll();
    covRows.push(demandRow());
    researchText = "Could not price this.";

    await handler();

    expect(sentEmails.filter((e) => e.template === "booking-rate-ready")).toHaveLength(0);
    const cov = covRows.find((c) => c.id === "GENERAL_PEST#springfield-ma#2000")!;
    expect(JSON.parse(cov.notify!)).toHaveLength(2); // still waiting
  });
});

describe("the weekly report — Monday 10:00 UTC, visibility not a gate", () => {
  /** Fixtures the report should surface, built on a quiet seeded base. */
  async function reportFixtures() {
    delete process.env.ANTHROPIC_API_KEY; // report only — no research noise
    await seedOnly();
    delete process.env.ANTHROPIC_API_KEY;
    quietAll();
    // Two price moves, ranked by |%|: +50% must outrank -10%.
    const big = rateRows.find((r) => r.rateKey === "GENERAL_PEST#ware-ma#2000")!;
    big.priceCents = 30000;
    big.prevPriceCents = 20000;
    big.researchedAt = iso(DAY);
    const small = rateRows.find((r) => r.rateKey === "RODENT#ware-ma#2000")!;
    small.priceCents = 18000;
    small.prevPriceCents = 20000;
    small.researchedAt = iso(DAY);
    // A floor that bound this week.
    const floored = rateRows.find((r) => r.rateKey === "ROACH#ware-ma#2000")!;
    floored.basis = "junk ads · one-time floored at Zone-A variable cost $155.00";
    floored.researchedAt = iso(DAY);
    // A combo failing research, and a stale one.
    const failing = covRows.find((c) => c.id === "TERMITE#ware-ma#1500")!;
    failing.failCount = 3;
    const stale = covRows.find((c) => c.id === "WILDLIFE#ware-ma#1500")!;
    stale.lastSuccessAt = iso(25 * DAY);
    // A coverage gap: never succeeded.
    covRows.push({
      id: "HOA#springfield-ma",
      service: "HOA",
      areaKey: "springfield-ma",
      city: "Springfield",
      state: "MA",
      band: null,
      source: "SERVED",
      active: true,
      failCount: 0,
      lastSuccessAt: undefined,
      notify: "[]",
    });
    // The seeding run above may itself have hit the report slot — only the
    // report from the run under test counts.
    officeEmails.length = 0;
  }

  it("emails one report with ranked moves, floors, failures, stale rows, gaps and counts", async () => {
    vi.setSystemTime(new Date("2026-07-20T10:00:00Z")); // Monday 10:00 UTC
    await reportFixtures();

    await handler();

    const reports = officeEmails.filter(
      (e) => e.template === "ops-pricing-weekly-report"
    );
    expect(reports).toHaveLength(1);
    const body = reports[0].bodyHtml;
    // Ranked by |%|: the +50.0% GENERAL_PEST move appears before -10.0%.
    expect(body.indexOf("+50.0%")).toBeGreaterThan(-1);
    expect(body.indexOf("+50.0%")).toBeLessThan(body.indexOf("-10.0%"));
    expect(body).toContain("$200 → <strong>$300</strong>");
    // Floors that bound.
    expect(body).toContain("shipped at the Zone-A floor");
    expect(body).toContain("ROACH · ware-ma");
    // Failing, stale, gaps.
    expect(body).toContain("TERMITE · ware-ma · up to 1,500 sqft");
    expect(body).toContain("3 straight failures");
    expect(body).toContain("WILDLIFE · ware-ma · up to 1,500 sqft");
    expect(body).toContain("last success 25d ago");
    expect(body).toContain("HOA · springfield-ma");
    // Visibility, not a gate — and the override surface is named.
    expect(body).toContain("already live and quoting");
    expect(body).toContain("https://crm.example.test/market-rates");
    // Weekly research counts.
    expect(body).toMatch(/\d+ combos refreshed successfully of \d+ attempted/);
  });

  it("fires ONLY on the weekly slot — same data, Monday 11:00, no report", async () => {
    vi.setSystemTime(new Date("2026-07-20T11:00:00Z"));
    await reportFixtures();

    const summary = await handler();

    expect(summary.reported).toBe(false);
    expect(
      officeEmails.filter((e) => e.template === "ops-pricing-weekly-report")
    ).toHaveLength(0);
  });

  it("fires once, not twelve times — the 10:05 run in the same hour sends nothing", async () => {
    // The cron now fires every 5 minutes; only the top-of-hour run may report.
    // Seed + build fixtures at the top of the hour, then run again 5 past.
    vi.setSystemTime(new Date("2026-07-20T10:00:00Z")); // Monday 10:00 UTC
    await reportFixtures();
    vi.setSystemTime(new Date("2026-07-20T10:05:00Z")); // 5 past — off the hour

    const summary = await handler();

    expect(summary.reported).toBe(false);
    expect(
      officeEmails.filter((e) => e.template === "ops-pricing-weekly-report")
    ).toHaveLength(0);
  });
});
