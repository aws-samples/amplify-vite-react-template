import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _setLockStoreForTests, memoryLockStore } from "../shared/atomicLock";
import { _resetRollbackMemoForTests } from "../shared/marketRate";

/**
 * The pricing-refresh worker — the only place research runs.
 *
 * GL-16 (the July cost incident): every run first takes the SINGLE drain
 * lease, so overlapping invocations can never double-research the queue;
 * every provider request reserves ATOMIC daily budget before the call, so
 * failures/timeouts consume it too; failures back off exponentially and
 * exhaust into an owned Office item after MAX_RESEARCH_ATTEMPTS; office
 * visibility is a daily digest + Monday report, never one email per rate;
 * and waiting-lead emails are claim-based so replays cannot double-send.
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
  leaseUntil?: string;
  leaseNonce?: string;
  nextEligibleAt?: string;
  exhaustedAt?: string;
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

// RateCoverage and PricingControl live in Maps shared between the fake
// AppSync client and the CAS lock store, so guarded writes and model reads
// see one truth — exactly the production arrangement.
const covTable = new Map<string, CovRow>();
const controlTable = new Map<string, Record<string, unknown>>();
const versionTable = new Map<string, Record<string, unknown>>();
const rateRows: RateRow[] = [];
const createdRates: RateRow[] = [];
const customers: Record<string, unknown>[] = [];
const bookings: Record<string, unknown>[] = [];
const workItems = new Map<string, Record<string, unknown>>();

const covs = () => [...covTable.values()];
const cov = (id: string) => covTable.get(id);
const addCov = (row: CovRow) => covTable.set(row.id, row);

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
      list: async () => ({ data: covs() }),
      get: async ({ id }: { id: string }) => ({ data: cov(id) ?? null }),
      create: async (input: Record<string, unknown> & { id: string }) => {
        if (covTable.has(input.id)) {
          return { data: null, errors: [{ message: "conditional check failed" }] };
        }
        const row = { ...input } as CovRow;
        covTable.set(row.id, row);
        return { data: row };
      },
      update: async (input: Record<string, unknown> & { id: string }) => {
        const row = cov(input.id);
        if (row) Object.assign(row, input);
        return { data: row ?? null };
      },
    },
    CatalogVersion: {
      list: async () => ({ data: [...versionTable.values()], nextToken: null }),
      get: async ({ id }: { id: string }) => ({
        data: versionTable.get(id) ?? null,
      }),
      create: async (input: Record<string, unknown> & { id: string }) => {
        versionTable.set(input.id, { ...input });
        return { data: versionTable.get(input.id) };
      },
    },
    PricingControl: {
      list: async () => ({ data: [...controlTable.values()] }),
      get: async ({ id }: { id: string }) => ({
        data: controlTable.get(id) ?? null,
      }),
      create: async (input: Record<string, unknown> & { id: string }) => {
        if (controlTable.has(input.id)) {
          return { data: null, errors: [{ message: "conditional check failed" }] };
        }
        controlTable.set(input.id, { ...input });
        return { data: controlTable.get(input.id) };
      },
    },
    Customer: { list: async () => ({ data: [...customers] }) },
    BookingRequest: {
      list: async () => ({ data: [...bookings] }),
      get: async ({ id }: { id: string }) => ({
        data: bookings.find((b) => b.id === id) ?? null,
      }),
    },
    WorkItem: {
      get: async ({ id }: { id: string }) => ({ data: workItems.get(id) ?? null }),
      create: async (input: Record<string, unknown> & { id: string }) => {
        workItems.set(input.id, { ...input });
        return { data: workItems.get(input.id) };
      },
      update: async (input: Record<string, unknown> & { id: string }) => {
        const row = workItems.get(input.id);
        if (row) Object.assign(row, input);
        return { data: row ?? null };
      },
    },
    WorkEvent: {
      create: async (input: Record<string, unknown>) => ({ data: { ...input } }),
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

const {
  handler,
  BACKOFF_BASE_MS,
  DEMAND_RESEARCH_PER_DAY,
  MAX_RESEARCH_ATTEMPTS,
  RESEARCH_PER_DAY,
  RESEARCH_PER_RUN,
  SEED_TOWNS,
  SEED_SQFT_BUCKETS,
} = await import("./handler");

/** 6 sqft-banded services × the seed buckets + WASP_NEST + HOA, per town. */
const COMBOS_PER_TOWN = 6 * SEED_SQFT_BUCKETS.length + 2;

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const DAY = 24 * 3600_000;

const dayKey = () => `day#${new Date().toISOString().slice(0, 10)}`;
const dayCounters = () => controlTable.get(dayKey());

/** Pre-set the day row as if earlier runs already reserved this much. */
function spendBudget(attempts: number, demandAttempts = 0) {
  controlTable.set(dayKey(), {
    id: dayKey(),
    kind: "DAY",
    attempts,
    demandAttempts,
    succeeded: attempts,
    failed: 0,
  });
}

/** Run the handler with no API key: seeding happens, research cannot. */
async function seedOnly() {
  delete process.env.ANTHROPIC_API_KEY;
  const summary = await handler();
  process.env.ANTHROPIC_API_KEY = "test-key";
  return summary;
}

/** Quiet the queue: every covered combo has a fresh sheet, nothing due. */
function quietAll() {
  for (const c of covs()) {
    c.lastSuccessAt = iso(2 * DAY);
    c.lastAttemptAt = iso(2 * DAY);
    rateRows.push({
      id: `seed-${c.id}`,
      rateKey: c.id,
      service: c.service,
      areaKey: c.areaKey,
      priceCents: 19900,
      active: true,
      researchedAt: iso(2 * DAY),
    });
  }
}

const demandRow = (over: Partial<CovRow> = {}): CovRow => ({
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
  ...over,
});

beforeEach(() => {
  covTable.clear();
  controlTable.clear();
  versionTable.clear();
  workItems.clear();
  _resetRollbackMemoForTests();
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
  // The CAS store and the fake client share these Maps — guarded writes and
  // model reads see one truth, like DynamoDB under AppSync.
  _setLockStoreForTests(
    memoryLockStore({
      RateCoverage: covTable as unknown as Map<string, Record<string, unknown>>,
      PricingControl: controlTable,
    })
  );
  // A Wednesday, well away from the Monday report and the 21:00 digest slot.
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-15T14:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  _setLockStoreForTests(null);
  delete process.env.ANTHROPIC_API_KEY;
});

describe("the drain lease — exactly one invocation researches at a time", () => {
  it("an overlapping invocation exits without selecting or spending anything", async () => {
    await seedOnly();
    quietAll();
    addCov(demandRow());
    // First research hangs mid-flight; later calls resolve instantly.
    let releaseResearch!: () => void;
    messagesCreate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseResearch = () =>
            resolve({ content: [{ type: "text", text: MEGA_TEXT }] });
        })
    );

    const runA = handler();
    // Let A reach its provider call (it now holds the drain lease).
    while (messagesCreate.mock.calls.length === 0) await Promise.resolve();

    const summaryB = await handler();
    expect(summaryB).toMatchObject({ skipped: "drain-lease-held" });

    releaseResearch();
    const summaryA = await runA;
    expect(summaryA.attempted).toBe(1);
    // ONE research, ONE budget reservation, ONE cached rate — no double spend.
    expect(messagesCreate).toHaveBeenCalledTimes(1);
    expect(dayCounters()?.attempts).toBe(1);
    expect(createdRates).toHaveLength(1);
  });

  it("a live drain lease held by another worker is respected", async () => {
    addCov(demandRow());
    controlTable.set("pricing-drain", {
      id: "pricing-drain",
      kind: "DRAIN",
      holderNonce: "someone-else",
      leaseUntil: iso(-10 * 60_000), // 10 minutes in the future
    });

    const summary = await handler();

    expect(summary).toMatchObject({ skipped: "drain-lease-held" });
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it("a crashed run's EXPIRED lease is taken over atomically and the queue drains", async () => {
    vi.setSystemTime(new Date("2026-07-15T14:07:00Z")); // off the hour — no seeding
    addCov(demandRow());
    controlTable.set("pricing-drain", {
      id: "pricing-drain",
      kind: "DRAIN",
      holderNonce: "dead-worker",
      leaseUntil: iso(60_000), // expired a minute ago
    });

    const summary = await handler();

    expect(summary.attempted).toBe(1);
    expect(createdRates).toHaveLength(1);
    // The lease is released at the end of the run — the next cron isn't blocked.
    expect(controlTable.get("pricing-drain")?.leaseUntil).toBeUndefined();
  });

  it("a coverage row another worker holds a live research lease on is never re-researched", async () => {
    await seedOnly();
    quietAll();
    addCov(demandRow({ leaseUntil: iso(-2 * 60_000), leaseNonce: "other" }));

    const summary = await handler();

    expect(summary.attempted).toBe(0);
    expect(messagesCreate).not.toHaveBeenCalled();
  });
});

describe("coverage seeding — top of the hour only, demand drains every run", () => {
  it("skips seeding off the top of the hour, but still drains a waiting DEMAND miss", async () => {
    await seedOnly();
    quietAll(); // every seeded combo has a fresh sheet — nothing due
    const seededCount = covTable.size;
    addCov(demandRow());
    vi.setSystemTime(new Date("2026-07-15T14:05:00Z")); // 5 past — off the hour

    const summary = await handler();

    expect(summary.seeded).toBe(0); // no re-scan mid-hour
    expect(covTable.size).toBe(seededCount + 1); // only the demand row we added
    expect(summary.attempted).toBe(1); // the demand miss still drained
    expect(createdRates[0].rateKey).toBe("TERMITE#springfield-ma#3000");
  });

  it("seeds the curated town list across every service kind and common band", async () => {
    await seedOnly();

    expect(covTable.size).toBe(SEED_TOWNS.length * COMBOS_PER_TOWN);
    expect(cov("GENERAL_PEST#ware-ma#2000")).toMatchObject({
      source: "SEED",
      city: "Ware",
      state: "MA",
      band: 2000,
      active: true,
    });
    expect(cov("HOA#ware-ma")).toMatchObject({
      band: null,
      source: "SEED",
    });
  });

  it("is idempotent — a second run creates nothing new", async () => {
    await seedOnly();
    const count = covTable.size;

    await seedOnly();

    expect(covTable.size).toBe(count);
  });

  it("cannot resurrect a combo the office retired", async () => {
    await seedOnly();
    const retired = cov("GENERAL_PEST#ware-ma#2000")!;
    retired.active = false;

    await seedOnly();

    expect(cov("GENERAL_PEST#ware-ma#2000")!.active).toBe(false);
  });

  it("cannot re-arm an exhausted combo — only the office's explicit retry does", async () => {
    await seedOnly();
    const parked = cov("GENERAL_PEST#ware-ma#2000")!;
    parked.exhaustedAt = iso(DAY);
    parked.failCount = MAX_RESEARCH_ATTEMPTS;

    await seedOnly();
    const summary = await handler();

    expect(cov("GENERAL_PEST#ware-ma#2000")).toMatchObject({
      exhaustedAt: parked.exhaustedAt,
      failCount: MAX_RESEARCH_ATTEMPTS,
    });
    // ...and the drain never touched it either.
    expect(
      messagesCreate.mock.calls.length === 0 ||
        createdRates.every((r) => r.rateKey !== "GENERAL_PEST#ware-ma#2000")
    ).toBe(true);
    expect(summary.attempted).toBeLessThanOrEqual(RESEARCH_PER_RUN);
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
    expect(cov("RODENT#springfield-ma#2000")).toMatchObject({
      source: "SERVED",
      city: "springfield",
      band: 2000,
    });
    // Customer and booking towns get the full service × band cross.
    expect(cov("GENERAL_PEST#amherst-ma#1500")).toMatchObject({
      source: "SERVED",
    });
    // A community booking maps to the HOA kind (no band).
    expect(cov("HOA#granby-ma")).toMatchObject({ source: "SERVED" });
  });
});

describe("work selection — demand first, then gaps, then weekly-due; pinned never", () => {
  it("a DEMAND miss is researched before a sheet due for weekly refresh", async () => {
    await seedOnly();
    quietAll();
    const due = rateRows.find((r) => r.rateKey === "RODENT#ware-ma#2000")!;
    due.researchedAt = iso(8 * DAY);
    addCov(demandRow());

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

describe("the atomic budget — reserved before every provider call", () => {
  it(`a deep queue drains at most RESEARCH_PER_RUN (${RESEARCH_PER_RUN}) per run`, async () => {
    await seedOnly(); // hundreds of never-researched gap rows

    const summary = await handler();

    expect(summary.attempted).toBe(RESEARCH_PER_RUN);
    expect(messagesCreate).toHaveBeenCalledTimes(RESEARCH_PER_RUN);
    expect(dayCounters()?.attempts).toBe(RESEARCH_PER_RUN);
  });

  it(`stops at RESEARCH_PER_DAY (${RESEARCH_PER_DAY}) across a day's runs — the counter, not a guess`, async () => {
    await seedOnly();
    spendBudget(RESEARCH_PER_DAY - 10);

    const summary = await handler();

    expect(summary.attempted).toBe(10);
    expect(summary.budgetExhausted).toBe(true);
    expect(dayCounters()?.attempts).toBe(RESEARCH_PER_DAY);
  });

  it("a spent daily budget researches nothing — the queue holds for tomorrow", async () => {
    await seedOnly();
    spendBudget(RESEARCH_PER_DAY);

    const summary = await handler();

    expect(summary.attempted).toBe(0);
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it("the budget resets at the UTC day boundary — yesterday's spend never blocks today", async () => {
    await seedOnly();
    quietAll();
    spendBudget(RESEARCH_PER_DAY); // today is fully spent...
    vi.setSystemTime(new Date("2026-07-16T00:02:00Z")); // ...then midnight passes
    addCov(demandRow());

    const summary = await handler();

    expect(summary.attempted).toBe(1);
    expect(controlTable.get("day#2026-07-16")?.attempts).toBe(1);
    // Yesterday's row is untouched history.
    expect(controlTable.get("day#2026-07-15")?.attempts).toBe(RESEARCH_PER_DAY);
  });

  it("a FAILED research consumes budget exactly like a success", async () => {
    await seedOnly();
    quietAll();
    addCov(demandRow());
    researchText = "No conclusive pricing found."; // junk → research refuses

    await handler();

    expect(dayCounters()).toMatchObject({ attempts: 1, failed: 1, succeeded: 0 });
  });

  it("a THROWN provider call (timeout, overload) consumes budget too", async () => {
    await seedOnly();
    quietAll();
    addCov(demandRow());
    messagesCreate.mockRejectedValue(new Error("Request timed out"));

    const summary = await handler();

    expect(summary.failed).toBe(1);
    expect(dayCounters()).toMatchObject({ attempts: 1, failed: 1 });
  });
});

describe("failure backoff and exhaustion — one bad combo can never loop the queue", () => {
  it("failures increment failCount, set a bounded backoff, and never crash the run", async () => {
    await seedOnly();
    quietAll();
    addCov(demandRow({ id: "TERMITE#nowhere-ma#2000", areaKey: "nowhere-ma", city: "Nowhere", band: 2000, failCount: 1 }));
    researchText = "No conclusive pricing found.";

    const summary = await handler();

    expect(summary.failed).toBe(1);
    const row = cov("TERMITE#nowhere-ma#2000")!;
    expect(row.failCount).toBe(2);
    expect(row.lastSuccessAt).toBeUndefined();
    // Second failure → 2^1 × base backoff.
    expect(Date.parse(row.nextEligibleAt!)).toBe(Date.now() + 2 * BACKOFF_BASE_MS);
    expect(createdRates).toHaveLength(0);
  });

  it("a combo inside its backoff window is not retried; past it, it is", async () => {
    await seedOnly();
    quietAll();
    addCov(demandRow({ failCount: 1, nextEligibleAt: iso(-BACKOFF_BASE_MS) }));

    const early = await handler();
    expect(early.attempted).toBe(0);

    vi.setSystemTime(new Date(Date.now() + BACKOFF_BASE_MS + 60_000));
    const late = await handler();
    expect(late.attempted).toBe(1);
    expect(createdRates).toHaveLength(1);
  });

  it(`the ${MAX_RESEARCH_ATTEMPTS}th straight failure parks the combo with an owned Office item`, async () => {
    await seedOnly();
    quietAll();
    addCov(demandRow({ failCount: MAX_RESEARCH_ATTEMPTS - 1 }));
    researchText = "Still nothing usable.";

    await handler();

    const row = cov("TERMITE#springfield-ma#3000")!;
    expect(row.exhaustedAt).toBeTruthy();
    expect(row.failCount).toBe(MAX_RESEARCH_ATTEMPTS);
    expect(row.nextEligibleAt).toBeUndefined();
    const items = [...workItems.values()];
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "PRICING_RESEARCH_EXHAUSTED",
      status: "OPEN",
      relatedId: "TERMITE#springfield-ma#3000",
    });

    // Parked means parked: the next run spends nothing on it.
    messagesCreate.mockClear();
    const next = await handler();
    expect(next.attempted).toBe(0);
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it("the office's explicit retry (clearing exhaustedAt) re-enters the queue cleanly", async () => {
    await seedOnly();
    quietAll();
    addCov(
      demandRow({ failCount: MAX_RESEARCH_ATTEMPTS, exhaustedAt: iso(DAY) })
    );
    // The Market Rates screen's one safe action:
    const row = cov("TERMITE#springfield-ma#3000")!;
    delete row.exhaustedAt;
    row.failCount = 0;

    const summary = await handler();

    expect(summary.attempted).toBe(1);
    expect(createdRates).toHaveLength(1);
    expect(cov("TERMITE#springfield-ma#3000")!.failCount).toBe(0);
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
    const c = cov("WASP_NEST#ware-ma")!;
    expect(c.failCount).toBe(0);
    expect(c.lastSuccessAt).toBeTruthy();
    expect(c.leaseUntil).toBeUndefined(); // the research lease was released
  });

  it("caching a rate does NOT email the office per rate — visibility rides the digest", async () => {
    await seedOnly();
    quietAll();
    addCov(demandRow());

    await handler();

    expect(createdRates).toHaveLength(1);
    expect(officeEmails).toHaveLength(0);
  });
});

describe("the daily digest — one consolidated email, never one per rate", () => {
  it("the 21:00 UTC hour sends ONE digest with the day's spend, results, and queue state", async () => {
    await seedOnly();
    quietAll();
    addCov(demandRow());
    addCov(
      demandRow({
        id: "ROACH#nowhere-ma#2000",
        service: "ROACH",
        areaKey: "nowhere-ma",
        city: "Nowhere",
        band: 2000,
        failCount: MAX_RESEARCH_ATTEMPTS,
        exhaustedAt: iso(DAY),
      })
    );
    vi.setSystemTime(new Date("2026-07-15T21:02:00Z"));

    await handler();

    const digests = officeEmails.filter(
      (e) => e.template === "ops-pricing-daily-digest"
    );
    expect(digests).toHaveLength(1);
    const body = digests[0].bodyHtml;
    expect(body).toContain("TERMITE · springfield-ma · up to 3,000 sqft");
    expect(body).toContain("already live and quoting");
    expect(body).toContain("estimated spend");
    expect(body).toContain("ROACH · nowhere-ma"); // the exhausted combo is surfaced
    expect(digests[0].subject).toContain("AI pricing daily digest");

    // A second run in the same hour claims nothing — exactly one digest a day.
    vi.setSystemTime(new Date("2026-07-15T21:07:00Z"));
    await handler();
    expect(
      officeEmails.filter((e) => e.template === "ops-pricing-daily-digest")
    ).toHaveLength(1);
  });

  it("outside the digest hour, no digest is sent", async () => {
    await seedOnly();
    quietAll();
    addCov(demandRow());

    await handler();

    expect(
      officeEmails.filter((e) => e.template === "ops-pricing-daily-digest")
    ).toHaveLength(0);
  });
});

describe("the targeted quote wake-up — one miss, the demand reserve, no re-research", () => {
  it("researches exactly its miss from the DEMAND reserve", async () => {
    await seedOnly();
    quietAll();
    addCov(demandRow());
    spendBudget(RESEARCH_PER_DAY); // the general budget is gone...

    const summary = await handler({
      rateKey: "TERMITE#springfield-ma#3000",
      source: "quote",
    });

    // ...but the waiting lead still gets priced from the demand reserve.
    expect(summary.attempted).toBe(1);
    expect(createdRates[0].rateKey).toBe("TERMITE#springfield-ma#3000");
    expect(dayCounters()?.demandAttempts).toBe(1);
  });

  it(`the demand reserve is capped at ${DEMAND_RESEARCH_PER_DAY}/day`, async () => {
    addCov(demandRow());
    spendBudget(RESEARCH_PER_DAY, DEMAND_RESEARCH_PER_DAY);

    const summary = await handler({
      rateKey: "TERMITE#springfield-ma#3000",
      source: "quote",
    });

    expect(summary.attempted).toBe(0);
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it("a combo that already has a live sheet is NOT re-researched by a wake-up", async () => {
    const demand = demandRow();
    addCov(demand);
    rateRows.push({
      id: "live-sheet",
      rateKey: demand.id,
      service: demand.service,
      areaKey: demand.areaKey,
      priceCents: 32000,
      active: true,
      researchedAt: iso(60_000),
    });

    const summary = await handler({ rateKey: demand.id, source: "quote" });

    expect(summary.attempted).toBe(0);
    expect(messagesCreate).not.toHaveBeenCalled();
  });
});

describe("the self-heal email — a waiting lead hears exactly once", () => {
  const waitingRow = (): CovRow =>
    demandRow({
      id: "GENERAL_PEST#springfield-ma#2000",
      service: "GENERAL_PEST",
      band: 2000,
      notify: JSON.stringify([
        { email: "lead1@x.com", bookingRequestId: "bk1" },
        { email: "lead2@x.com", bookingRequestId: "bk2" },
      ]),
    });

  it("emails every waiting lead once, then clears the notify list", async () => {
    await seedOnly();
    quietAll();
    bookings.push({ id: "bk1", cancelToken: "resume-token-1" });
    addCov(waitingRow());

    await handler();

    const ready = sentEmails.filter((e) => e.template === "booking-rate-ready");
    expect(ready.map((e) => e.to)).toEqual(["lead1@x.com", "lead2@x.com"]);
    expect(ready[0].subject).toContain("Your exact prices are ready");
    expect(ready[0].html).toContain(
      "https://staging.example.test/quote#request=bk1&token=resume-token-1"
    );
    const c = cov("GENERAL_PEST#springfield-ma#2000")!;
    expect(JSON.parse(c.notify!)).toEqual([]);

    // Replay: the sheet exists, the combo is not due — nobody re-emailed.
    sentEmails.length = 0;
    await handler();
    expect(sentEmails.filter((e) => e.template === "booking-rate-ready")).toHaveLength(0);
  });

  it("keeps a failed delivery queued and retries it without researching again", async () => {
    await seedOnly();
    quietAll();
    addCov(waitingRow());
    emailsThatFail.add("lead2@x.com");

    await handler();

    const c = cov("GENERAL_PEST#springfield-ma#2000")!;
    expect(JSON.parse(c.notify!)).toEqual([
      { email: "lead2@x.com", bookingRequestId: "bk2", ready: true },
    ]);

    emailsThatFail.clear();
    sentEmails.length = 0;
    await handler();

    expect(messagesCreate).toHaveBeenCalledTimes(1); // first run only
    expect(sentEmails.filter((e) => e.template === "booking-rate-ready").map((e) => e.to))
      .toEqual(["lead2@x.com"]);
    expect(JSON.parse(c.notify!)).toEqual([]);
  });

  it("does not announce ready when a live partial sheet still needs research", async () => {
    await seedOnly();
    quietAll();
    const demand = waitingRow();
    addCov(demand);
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
    expect(JSON.parse(cov(demand.id)!.notify!)).toHaveLength(2);
  });

  it("sends nothing when research fails — the lead is emailed only with real prices", async () => {
    await seedOnly();
    quietAll();
    addCov(waitingRow());
    researchText = "Could not price this.";

    await handler();

    expect(sentEmails.filter((e) => e.template === "booking-rate-ready")).toHaveLength(0);
    const c = cov("GENERAL_PEST#springfield-ma#2000")!;
    expect(JSON.parse(c.notify!)).toHaveLength(2); // still waiting
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
    // A combo failing research, a stale one, and an exhausted one.
    const failing = cov("TERMITE#ware-ma#1500")!;
    failing.failCount = 3;
    const stale = cov("WILDLIFE#ware-ma#1500")!;
    stale.lastSuccessAt = iso(25 * DAY);
    const parked = cov("ROACH#ware-ma#1500")!;
    parked.exhaustedAt = iso(2 * DAY);
    parked.failCount = MAX_RESEARCH_ATTEMPTS;
    // A coverage gap: never succeeded.
    addCov({
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

  it("emails one report with ranked moves, floors, failures, exhausted, stale rows, gaps and counts", async () => {
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
    // Failing, exhausted, stale, gaps.
    expect(body).toContain("TERMITE · ware-ma · up to 1,500 sqft");
    expect(body).toContain("3 straight failures");
    expect(body).toContain("ROACH · ware-ma · up to 1,500 sqft");
    expect(body).toContain("retry, pin a price, or retire it");
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

describe("GL-16 — rollback pause and the daily change review", () => {
  it("an active catalog rollback pauses research — the queue holds, nothing is spent", async () => {
    await seedOnly();
    quietAll();
    addCov(demandRow());
    versionTable.set("cv-prior", {
      id: "cv-prior",
      manifestJson: "{}",
      keyCount: 0,
    });
    controlTable.set("catalog-rollback", {
      id: "catalog-rollback",
      kind: "ROLLBACK",
      rollbackVersionId: "cv-prior",
      rollbackReason: "BAD_PROMPT_RESULT",
    });
    _resetRollbackMemoForTests();

    const summary = await handler();

    expect(summary.rolledBack).toBe(true);
    expect(summary.attempted).toBe(0);
    expect(messagesCreate).not.toHaveBeenCalled();
    expect(dayCounters()?.attempts ?? 0).toBe(0);
  });

  it("the digest enters the day's live changes (AI + office pins) into the queue for recorded review", async () => {
    await seedOnly();
    quietAll();
    addCov(demandRow()); // one AI change will cache today
    rateRows.push({
      id: "office-pin",
      rateKey: "RODENT#ware-ma#2500",
      service: "RODENT",
      areaKey: "ware-ma",
      priceCents: 45900,
      active: true,
      pinned: true,
      createdAt: new Date().toISOString(),
      editedBy: "jake@getgim.com",
      editReason: "MATCH_COMPETITOR",
      prevPriceCents: 39900,
    } as RateRow & { createdAt: string; editedBy: string; editReason: string });
    vi.setSystemTime(new Date("2026-07-15T21:02:00Z"));

    await handler();

    const review = [...workItems.values()].find(
      (w) => w.kind === "PRICING_CHANGE_REVIEW"
    )!;
    expect(review).toBeTruthy();
    expect(String(review.title)).toContain("2 live rate changes");
    expect(String(review.detail)).toContain("TERMITE · springfield-ma");
    expect(String(review.detail)).toContain("office pin by jake@getgim.com");
    expect(String(review.detail)).toContain("$399 → $459");
    // Review, never a gate: the sheets cached and served without waiting.
    expect(createdRates.length).toBeGreaterThan(0);
  });

  it("no changes today → no review item to busy the queue", async () => {
    await seedOnly();
    quietAll();
    vi.setSystemTime(new Date("2026-07-15T21:02:00Z"));

    await handler();

    expect(
      [...workItems.values()].some((w) => w.kind === "PRICING_CHANGE_REVIEW")
    ).toBe(false);
  });
});

describe("GL-16 — a rollback governs the COMPLETE catalog, not just quoting", () => {
  /** Roll back to an immutable version naming exactly `rowIds` per key. */
  const rolledBackState = (manifest: Record<string, string>) => {
    versionTable.set("cv-prior", {
      id: "cv-prior",
      manifestJson: JSON.stringify(manifest),
      keyCount: Object.keys(manifest).length,
    });
    controlTable.set("catalog-rollback", {
      id: "catalog-rollback",
      kind: "ROLLBACK",
      rollbackVersionId: "cv-prior",
      rollbackReason: "BAD_PROMPT_RESULT",
    });
    _resetRollbackMemoForTests();
  };

  it("does NOT email 'prices ready' for a sheet the rolled-back funnel refuses to serve", async () => {
    await seedOnly();
    quietAll();
    // The combo's ONLY sheet arrived AFTER the restored version was
    // snapshotted — the version doesn't name it, so quoting won't serve it.
    rateRows.push({
      id: "post-version-row",
      rateKey: "GENERAL_PEST#springfield-ma#2000",
      service: "GENERAL_PEST",
      areaKey: "springfield-ma",
      priceCents: 39900,
      active: true,
      researchedAt: iso(30 * 60_000),
    } as RateRow);
    addCov(
      demandRow({
        id: "GENERAL_PEST#springfield-ma#2000",
        service: "GENERAL_PEST",
        band: 2000,
        notify: JSON.stringify([
          { email: "lead1@x.com", bookingRequestId: "bk1", ready: true },
        ]),
      })
    );
    rolledBackState({}); // the restored version predates this combo

    await handler();

    // No "your exact prices are ready" — clicking through would show the
    // lead NO price at all. The claim stays queued for after the rollback.
    expect(
      sentEmails.filter((e) => e.template === "booking-rate-ready")
    ).toHaveLength(0);
    expect(
      JSON.parse(cov("GENERAL_PEST#springfield-ma#2000")!.notify!)
    ).toHaveLength(1);
  });

  it("still emails ready when the restored version's sheet serves during the rollback", async () => {
    await seedOnly();
    quietAll();
    rateRows.push({
      id: "version-named-row",
      rateKey: "GENERAL_PEST#springfield-ma#2000",
      service: "GENERAL_PEST",
      areaKey: "springfield-ma",
      priceCents: 34900,
      active: true,
      researchedAt: iso(3 * 3600_000),
    } as RateRow);
    addCov(
      demandRow({
        id: "GENERAL_PEST#springfield-ma#2000",
        service: "GENERAL_PEST",
        band: 2000,
        notify: JSON.stringify([
          { email: "lead1@x.com", bookingRequestId: "bk1", ready: true },
        ]),
      })
    );
    rolledBackState({
      "GENERAL_PEST#springfield-ma#2000": "version-named-row",
    });

    await handler();

    // The restored sheet IS serving — the promise is truthful.
    expect(
      sentEmails
        .filter((e) => e.template === "booking-rate-ready")
        .map((e) => e.to)
    ).toEqual(["lead1@x.com"]);
    expect(
      JSON.parse(cov("GENERAL_PEST#springfield-ma#2000")!.notify!)
    ).toEqual([]);
  });

  it("clearing the rollback releases the held ready-claim on the next run", async () => {
    await seedOnly();
    quietAll();
    rateRows.push({
      id: "post-version-row",
      rateKey: "GENERAL_PEST#springfield-ma#2000",
      service: "GENERAL_PEST",
      areaKey: "springfield-ma",
      priceCents: 39900,
      active: true,
      researchedAt: iso(30 * 60_000),
    } as RateRow);
    addCov(
      demandRow({
        id: "GENERAL_PEST#springfield-ma#2000",
        service: "GENERAL_PEST",
        band: 2000,
        notify: JSON.stringify([
          { email: "lead1@x.com", bookingRequestId: "bk1", ready: true },
        ]),
      })
    );
    rolledBackState({});
    await handler();
    expect(
      sentEmails.filter((e) => e.template === "booking-rate-ready")
    ).toHaveLength(0);

    controlTable.delete("catalog-rollback");
    _resetRollbackMemoForTests();
    await handler();

    expect(
      sentEmails
        .filter((e) => e.template === "booking-rate-ready")
        .map((e) => e.to)
    ).toEqual(["lead1@x.com"]);
  });
});

describe("GL-16 — immutable catalog versions", () => {
  it("a run that publishes rates snapshots the complete serving manifest", async () => {
    await seedOnly();
    quietAll();
    addCov(demandRow());

    await handler();

    const versions = [...versionTable.values()];
    expect(versions.length).toBeGreaterThan(0);
    const latest = versions[versions.length - 1];
    expect(latest.trigger).toBe("RUN");
    const manifest = JSON.parse(String(latest.manifestJson));
    // The manifest names the exact row that now serves the researched key.
    const cached = createdRates[createdRates.length - 1];
    expect(manifest[String(cached.rateKey)]).toBe(cached.id);
  });

  it("bootstrap: live rates with NO versions get a snapshot even when nothing new publishes", async () => {
    await seedOnly();
    quietAll();
    rateRows.push({
      id: "existing-row",
      rateKey: "GENERAL_PEST#ware-ma#2000",
      service: "GENERAL_PEST",
      areaKey: "ware-ma",
      priceCents: 30000,
      active: true,
      researchedAt: iso(24 * 3600_000),
    } as RateRow);

    await handler(); // off-hour drain, nothing to research

    const versions = [...versionTable.values()];
    expect(versions.some((v) => v.trigger === "BOOTSTRAP")).toBe(true);
  });
});

describe("lock-layer infrastructure failure fails the run LOUDLY (July staging defect)", () => {
  // Staging demonstrated it: every deployed CAS write missed its table
  // (ResourceNotFoundException), the drain takeover reported LOST, and the
  // worker logged "drain-lease-held" and did nothing — forever, silently.
  // An unavailable lock layer must be a thrown run failure (Errors alarm),
  // never a quiet skip that impersonates a held lease.

  it("the handler run REJECTS when the CAS store has no PricingControl wiring", async () => {
    _setLockStoreForTests(memoryLockStore({})); // no PricingControl table
    await expect(handler()).rejects.toThrow(/CAS lock layer unavailable/);
  });

  it("acquireDrain throws on UNSUPPORTED instead of reporting a held lease", async () => {
    const { acquireDrain } = await import("../shared/pricingControl");
    _setLockStoreForTests(memoryLockStore({}));
    await expect(acquireDrain("nonce-1")).rejects.toThrow(
      /infrastructure failure, not a held lease/
    );
  });

  it("reserveBudget throws on UNSUPPORTED instead of reporting exhaustion", async () => {
    const { reserveBudget } = await import("../shared/pricingControl");
    _setLockStoreForTests(memoryLockStore({}));
    await expect(
      reserveBudget(new Date("2026-07-15T14:00:00Z"), "GENERAL", {
        perDay: 150,
        demandPerDay: 40,
      })
    ).rejects.toThrow(/infrastructure failure, not budget exhaustion/);
  });
});
