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

/** One existing stop 10 minutes away → route-density discount applies. */
vi.mock("../shared/driveTime", () => ({
  HQ_ADDRESS: "81 Greenwich Rd, Ware, MA 01082",
  driveMinutesBetween: async () => 20,
  driveMatrixFrom: async (_k: string, _o: string, dests: string[]) =>
    dests.map(() => 10),
}));

const { buildDayMatrix } = await import("./availability");

/** Freeze "today" in the shop's timezone. */
const freezeEastern = (isoDate: string) =>
  vi.setSystemTime(new Date(`${isoDate}T12:00:00-04:00`));

// Tuesday 2026-07-28 is 12 days out from the frozen today: no rush, no
// planner modifier. One nearby stop → route-density −10% and quiet-day −5%,
// the deepest discount the modifiers can produce (factor 0.85).
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

  it("without a zone there is no cost model, and the 85% floor stands", async () => {
    const days = await buildDayMatrix({
      routesKey: "test-routes-key",
      candidateAddress: "12 Beacon St, Ware, MA",
      service: "RODENT",
      baseCents: 19900,
    });

    const day = days.find((d) => d.date === QUIET_NEARBY_DAY)!;
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
