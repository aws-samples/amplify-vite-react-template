import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _setLockStoreForTests, memoryLockStore } from "../shared/atomicLock";
import { capacityFixtureModels } from "../shared/capacityTestFixture";

/**
 * Day pricing floors (R62) and the single-day re-check (R29).
 *
 * The 85%-of-list floor alone shipped guaranteed-loss days: a Zone B rodent
 * job at the $199 market-rate clamp discounted to $169 against $177 of
 * drive + labor + materials. Discounts must floor at variable cost.
 */

type Stop = {
  customerId: string;
  serviceType: string;
  status: string;
  technicianId?: string;
  timeWindow?: string;
};

let stopsByDate: Record<string, Stop[]>;
const listJobByScheduledDate = vi.fn(
  async ({ scheduledDate }: { scheduledDate: string }) => ({
    data: stopsByDate[scheduledDate] ?? [],
  })
);

const capacityFixture = capacityFixtureModels();

const fakeDataClient = {
  models: {
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
    Job: { listJobByScheduledDate },
    Customer: {
      get: async ({ id }: { id: string }) => ({
        data: {
          id,
          serviceStreet: "9 Elm St",
          serviceCity: "Ware",
          serviceState: "MA",
          serviceZip: "01082",
        },
      }),
    },
  },
};
Object.assign(fakeDataClient.models, capacityFixture.models);
vi.mock("../shared/dataClient", () => ({ dataClient: async () => fakeDataClient }));

/** Every leg is `legMins` minutes. Default 20 puts an existing stop in the
 *  ≤25-minute route-density tier (−10%); a test can lower it to reach the
 *  deeper ≤15 / ≤5 tiers. */
let legMins = 20;
vi.mock("../shared/driveTime", () => ({
  HQ_ADDRESS: "81 Greenwich Rd, Ware, MA 01082",
  driveMinutesBetween: async () => legMins,
  driveMatrixFrom: async (_k: string, _o: string, dests: string[]) =>
    dests.map(() => 10),
}));

const { buildDayMatrix } = await import("./availability");

/** Freeze "today" in the shop's timezone. */
const freezeEastern = (isoDate: string) =>
  vi.setSystemTime(new Date(`${isoDate}T12:00:00-04:00`));

// Tuesday 2026-07-28 is 12 days out from the frozen today: no planner
// modifier. One stop 20 drive-min away (the ≤25 tier) → route-density −10%,
// plus quiet-day −5%, for factor 0.85.
const QUIET_NEARBY_DAY = "2026-07-28";

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
  legMins = 20;
  vi.useFakeTimers();
  freezeEastern("2026-07-16");
  listJobByScheduledDate.mockClear();
  stopsByDate = {
    [QUIET_NEARBY_DAY]: [
      {
        customerId: "c9",
        serviceType: "GENERAL_PEST",
        status: "SCHEDULED",
        technicianId: "t1",
        timeWindow: "MORNING",
      },
    ],
  };
});

afterEach(() => vi.useRealTimers());

describe("discount floor at variable cost (R62)", () => {
  it("a Zone B rodent day never prices below the $177 variable cost", async () => {
    const days = await buildDayMatrix({
      routesKey: "test-routes-key",
      candidateAddress: "12 Beacon St, Ware, MA",
      service: "RODENT",
      baseCents: 19900, // the market-rate clamp floor
      zone: "B",
    });

    const day = days.find((d) => d.date === QUIET_NEARBY_DAY)!;
    // 0.85 × $199 = $169.15 — below the (90+65)/60×$42 + 45mi×$0.30 + $55
    // variable cost of $177. The cost floor must win.
    expect(day.priceCents).toBe(17700);
    expect(day.factors).toContain("floored at variable cost");
  });

  it("without a zone there is no cost model, so the discounted price stands", async () => {
    const days = await buildDayMatrix({
      routesKey: "test-routes-key",
      candidateAddress: "12 Beacon St, Ware, MA",
      service: "RODENT",
      baseCents: 19900,
    });

    const day = days.find((d) => d.date === QUIET_NEARBY_DAY)!;
    // factor 0.85 (route −10% + quiet −5%), clear of the 60% policy floor.
    expect(day.priceCents).toBe(16900); // tidy(0.85 × $199)
  });

  it("leaves the price alone when cost sits safely under the discount", async () => {
    const days = await buildDayMatrix({
      routesKey: "test-routes-key",
      candidateAddress: "12 Beacon St, Ware, MA",
      service: "GENERAL_PEST",
      baseCents: 30000, // cost ≈ $115 — nowhere near the floor
      zone: "A",
    });

    const day = days.find((d) => d.date === QUIET_NEARBY_DAY)!;
    expect(day.priceCents).toBe(25500); // tidy(0.85 × $300)
    expect(day.factors).not.toContain("floored at variable cost");
  });
});

describe("single-day re-check (R29 support)", () => {
  it("onlyDate reads and returns exactly that day", async () => {
    const days = await buildDayMatrix({
      routesKey: "test-routes-key",
      candidateAddress: "12 Beacon St, Ware, MA",
      service: "RODENT",
      baseCents: 19900,
      zone: "B",
      onlyDate: QUIET_NEARBY_DAY,
    });

    expect(days.map((d) => d.date)).toEqual([QUIET_NEARBY_DAY]);
    expect(listJobByScheduledDate).toHaveBeenCalledTimes(1);
  });

  it("a date outside the quotable window is never bookable via the re-check", async () => {
    const days = await buildDayMatrix({
      routesKey: "test-routes-key",
      candidateAddress: "12 Beacon St, Ware, MA",
      service: "RODENT",
      baseCents: 19900,
      zone: "B",
      onlyDate: "2026-09-30",
    });

    expect(days).toEqual([]);
  });
});

describe("per-day plan first-visit fee", () => {
  /** A day with NO nearby stop and no quiet/planner modifier — factor 1.0. */
  const PLAIN_DAY = "2026-07-27";

  it("discounts the first visit by the day's route factor, monthly untouched", async () => {
    const days = await buildDayMatrix({
      routesKey: "test-routes-key",
      candidateAddress: "12 Beacon St, Ware, MA",
      service: "GENERAL_PEST",
      baseCents: 36000,
      planInitialFeeCents: 14900,
    });

    // factor 0.85 (route-density −10% + quiet-day −5%) on the nearby day.
    const near = days.find((d) => d.date === QUIET_NEARBY_DAY)!;
    expect(near.planInitialFeeCents).toBe(12700); // tidy(0.85 × $149)
    expect(near.factors.some((f) => f.startsWith("plan first visit"))).toBe(true);

    // A day with no nearby stop pays list — the discount is the exception.
    const plain = days.find((d) => d.date === PLAIN_DAY)!;
    expect(plain.planInitialFeeCents).toBeLessThanOrEqual(14900);
  });

  it("NEVER charges above the plan's list fee, even on a busy day", async () => {
    // Pin the day near capacity so the nearly-full +10% modifier fires.
    capacityFixture.maps.capacityDays.set(`${PLAIN_DAY}#t1`, {
      id: `${PLAIN_DAY}#t1`,
      date: PLAIN_DAY,
      technicianId: "t1",
      // ≥85% of the 540-minute window (the +10% tier) but with room left for
      // a 30-minute stop plus its legs — a day too full to FIT the stop drops
      // off the board entirely and would make this test vacuous.
      committedMinutes: 465,
      verified: true,
    });

    const days = await buildDayMatrix({
      routesKey: "test-routes-key",
      candidateAddress: "12 Beacon St, Ware, MA",
      service: "GENERAL_PEST",
      baseCents: 36000,
      planInitialFeeCents: 14900,
    });

    // Prove the +10% modifier actually fired, or this test is vacuous.
    const busy = days.find((d) => d.date === PLAIN_DAY)!;
    expect(busy).toBeDefined();
    expect(busy.factors).toContain("nearly-full +10%");
    expect(busy.priceCents).toBeGreaterThan(36000); // one-time DOES rise
    // The plan card states ONE list fee; a tile must never contradict it by
    // asking for more than the offer above it promised.
    for (const d of days) {
      expect(d.planInitialFeeCents!).toBeLessThanOrEqual(14900);
    }
  });

  it("a loss-leader fee under variable cost is NOT marked up by the cost floor", async () => {
    // Zone B rodent: variable cost is $177, well ABOVE this $99 plan fee. The
    // floor exists to stop discounts going too deep, not to reprice a first
    // visit the plan deliberately sells below cost.
    const days = await buildDayMatrix({
      routesKey: "test-routes-key",
      candidateAddress: "12 Beacon St, Ware, MA",
      service: "RODENT",
      baseCents: 19900,
      zone: "B",
      planInitialFeeCents: 9900,
    });

    const near = days.find((d) => d.date === QUIET_NEARBY_DAY)!;
    expect(near.planInitialFeeCents).toBe(9900); // held at list, never $177
  });

  it("omits the field entirely when no plan was offered", async () => {
    const days = await buildDayMatrix({
      routesKey: "test-routes-key",
      candidateAddress: "12 Beacon St, Ware, MA",
      service: "RODENT",
      baseCents: 19900,
      zone: "B",
    });

    expect(days.every((d) => d.planInitialFeeCents === undefined)).toBe(true);
  });
});

describe("plan first-visit fee — the 60% policy floor", () => {
  /** 25 days out from the frozen today, so the planner −5% stacks on top of
   *  the route and quiet discounts and drives the raw factor BELOW 0.6. A day
   *  at exactly 0.6 would make this test pass with the floor deleted. */
  const FAR_NEARBY_DAY = "2026-08-10";

  it("stops the deepest stacked discount from going past 60% of list", async () => {
    // Adjacent-parcel stop (≤5 min) = −35%, quiet day = −5%, planner = −5%.
    // Raw factor 0.55 would take a $149 first visit to $82.
    legMins = 3;
    stopsByDate[FAR_NEARBY_DAY] = [
      {
        customerId: "c8",
        serviceType: "GENERAL_PEST",
        status: "SCHEDULED",
        technicianId: "t1",
        timeWindow: "MORNING",
      },
    ];

    const days = await buildDayMatrix({
      routesKey: "test-routes-key",
      candidateAddress: "12 Beacon St, Ware, MA",
      service: "GENERAL_PEST",
      baseCents: 36000,
      planInitialFeeCents: 14900,
    });

    const deep = days.find((d) => d.date === FAR_NEARBY_DAY)!;
    // Prove the discounts really stacked past the floor, or this is vacuous.
    expect(deep.factors).toContain("route-density −35% (stop 3 min away)");
    expect(deep.factors).toContain("quiet-day −5%");
    expect(deep.factors).toContain("planner −5%");
    // 0.60 × $149 = $89.40 → tidied to $89. Never the un-floored $82.
    expect(deep.planInitialFeeCents).toBe(8900);
  });
});
