import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _setLockStoreForTests, memoryLockStore } from "./atomicLock";

/**
 * GL-04 — the one minute-based capacity rule and its ATOMIC day ledger. The
 * memory lock store models DynamoDB's per-item conditional atomicity, so the
 * two-buyers-one-slot race here deterministically proves exactly one winner.
 */

type Row = Record<string, unknown>;
const technicians = new Map<string, Row>();
const licenses = new Map<string, Row[]>();
const exceptions = new Map<string, Row>();
const closures = new Map<string, Row>();
const jobs = new Map<string, Row>();
const capacityDays = new Map<string, Row>();
const capacityClaims = new Map<string, Row>();

function model(table: Map<string, Row>, opts: { conditional?: boolean } = {}) {
  return {
    create: vi.fn(async (input: Row) => {
      const id = String(input.id ?? `${table.size + 1}`);
      if (opts.conditional !== false && table.has(id)) return { data: null };
      table.set(id, { ...input, id });
      return { data: { ...table.get(id)! } };
    }),
    get: vi.fn(async ({ id }: { id: string }) => ({
      data: table.has(id) ? { ...table.get(id)! } : null,
    })),
    update: vi.fn(async (input: Row) => {
      const row = table.get(String(input.id));
      if (!row) return { data: null };
      for (const [k, v] of Object.entries(input)) if (v !== undefined) row[k] = v;
      return { data: { ...row } };
    }),
    delete: vi.fn(async ({ id }: { id: string }) => {
      const existed = table.get(id) ?? null;
      table.delete(id);
      return { data: existed };
    }),
    list: vi.fn(async () => ({ data: [...table.values()], nextToken: null })),
  };
}

const fakeClient = {
  models: {
    Technician: {
      ...model(technicians),
      list: vi.fn(async () => ({ data: [...technicians.values()], nextToken: null })),
    },
    TechnicianLicense: {
      listTechnicianLicenseByTechnicianId: vi.fn(
        async ({ technicianId }: { technicianId: string }) => ({
          data: licenses.get(technicianId) ?? [],
          nextToken: null,
        })
      ),
    },
    TechnicianDayException: {
      ...model(exceptions),
      listTechnicianDayExceptionByDate: vi.fn(async ({ date }: { date: string }) => ({
        data: [...exceptions.values()].filter((e) => e.date === date),
        nextToken: null,
      })),
    },
    CompanyClosure: model(closures),
    Job: {
      listJobByScheduledDate: vi.fn(async ({ scheduledDate }: { scheduledDate: string }) => ({
        data: [...jobs.values()].filter((j) => j.scheduledDate === scheduledDate),
        nextToken: null,
      })),
    },
    CapacityDay: model(capacityDays),
    CapacityClaim: {
      ...model(capacityClaims),
      listCapacityClaimByDate: vi.fn(async ({ date }: { date: string }) => ({
        data: [...capacityClaims.values()].filter((c) => c.date === date),
        nextToken: null,
      })),
    },
  },
};

vi.mock("./dataClient", () => ({ dataClient: async () => fakeClient }));

const {
  claimCapacity,
  committedMinutesOn,
  consumeCapacityClaim,
  dayCapacityMinutes,
  reconcileCapacityDay,
  releaseCapacityClaim,
  reserveScheduledMinutes,
  visitMinutes,
  WORKDAY_MINUTES,
} = await import("./capacity");

// 2026-08-05 is a Wednesday.
const WED = "2026-08-05";
const SAT = "2026-08-08";

beforeEach(() => {
  for (const t of [technicians, exceptions, closures, jobs, capacityDays, capacityClaims]) {
    t.clear();
  }
  licenses.clear();
  _setLockStoreForTests(
    memoryLockStore({
      CapacityDay: capacityDays,
      CapacityClaim: capacityClaims,
    })
  );
  technicians.set("t1", { id: "t1", name: "Sam", active: true });
  licenses.set("t1", [
    { id: "l1", number: "MA-1", status: "CURRENT", expiresOn: "2099-01-01" },
  ]);
});

afterEach(() => _setLockStoreForTests(null));

describe("dayCapacityMinutes — the one rule", () => {
  it("gives an eligible technician a Monday–Friday 8–5 day (540 minutes)", async () => {
    const cap = await dayCapacityMinutes(WED);
    expect(cap.capMinutes).toBe(WORKDAY_MINUTES);
    expect(cap.eligibleTechs).toBe(1);
  });

  it("sells nothing on weekends, closures, PTO, or with zero eligible technicians — no floor of one", async () => {
    expect((await dayCapacityMinutes(SAT)).capMinutes).toBe(0);

    closures.set(WED, { id: WED, date: WED, reason: "July company outing" });
    expect((await dayCapacityMinutes(WED)).capMinutes).toBe(0);
    closures.clear();

    exceptions.set("e1", { id: "e1", technicianId: "t1", date: WED, kind: "PTO", reason: "Vacation" });
    const pto = await dayCapacityMinutes(WED);
    expect(pto.capMinutes).toBe(0);
    expect(pto.reasons.join(" ")).toMatch(/PTO/);
    exceptions.clear();

    technicians.set("t1", { id: "t1", name: "Sam", active: false });
    expect((await dayCapacityMinutes(WED)).capMinutes).toBe(0);
  });

  it("fails CLOSED: an expired licence or an unreadable record sells no capacity", async () => {
    licenses.set("t1", [
      { id: "l1", number: "MA-1", status: "CURRENT", expiresOn: "2026-08-01" },
    ]);
    const expired = await dayCapacityMinutes(WED);
    expect(expired.capMinutes).toBe(0);
    expect(expired.reasons.join(" ")).toMatch(/no current licence/);

    fakeClient.models.TechnicianLicense.listTechnicianLicenseByTechnicianId.mockRejectedValueOnce(
      new Error("throttled")
    );
    const unreadable = await dayCapacityMinutes(WED);
    expect(unreadable.capMinutes).toBe(0);
    expect(unreadable.reasons.join(" ")).toMatch(/fail closed/i);
  });
});

describe("visitMinutes", () => {
  it("locked on-site durations + the Routes proof (or the default allowance)", () => {
    expect(visitMinutes({ propertyClass: "RESIDENTIAL", dispatchDriveMinutes: 22 })).toBe(52);
    expect(visitMinutes({ propertyClass: "COMMERCIAL", dispatchDriveMinutes: null })).toBe(90);
    expect(visitMinutes({ propertyClass: null, dispatchDriveMinutes: null })).toBe(60);
  });
});

describe("the atomic day ledger — two buyers, one slot", () => {
  it("two concurrent checkout claims for the last minutes: exactly one wins", async () => {
    // One tech = 540 minutes; 480 already committed; a 60-minute visit fits
    // once. Two concurrent claims race the guarded add — one must lose.
    capacityDays.set(WED, { id: WED, date: WED, committedMinutes: 480 });
    const [a, b] = await Promise.all([
      claimCapacity({ claimKey: "booking-A", date: WED, minutes: 60 }),
      claimCapacity({ claimKey: "booking-B", date: WED, minutes: 60 }),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    // The loser's claim row is gone — a refused claim never lies about holding.
    const live = [...capacityClaims.values()];
    expect(live).toHaveLength(1);
    expect(capacityDays.get(WED)!.committedMinutes).toBe(540);
  });

  it("two concurrent office moves cannot both take the last minutes", async () => {
    capacityDays.set(WED, { id: WED, date: WED, committedMinutes: 500 });
    const [a, b] = await Promise.all([
      reserveScheduledMinutes(WED, 40),
      reserveScheduledMinutes(WED, 40),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(capacityDays.get(WED)!.committedMinutes).toBe(540);
  });

  it("a released claim gives its minutes back; a consumed claim does not", async () => {
    await claimCapacity({ claimKey: "bk-1", date: WED, minutes: 60 });
    expect(capacityDays.get(WED)!.committedMinutes).toBe(60);
    await releaseCapacityClaim("bk-1");
    expect(capacityDays.get(WED)!.committedMinutes).toBe(0);
    expect(capacityClaims.size).toBe(0);

    await claimCapacity({ claimKey: "bk-2", date: WED, minutes: 60 });
    await consumeCapacityClaim("bk-2");
    // The minutes stay committed — the booked job carries them now.
    expect(capacityDays.get(WED)!.committedMinutes).toBe(60);
    expect(capacityClaims.size).toBe(0);
    // A double release after consume is a no-op.
    await releaseCapacityClaim("bk-2");
    expect(capacityDays.get(WED)!.committedMinutes).toBe(60);
  });

  it("a claim refused for capacity reports sold out with zero-capacity days named", async () => {
    technicians.set("t1", { id: "t1", name: "Sam", active: false });
    const res = await claimCapacity({ claimKey: "bk-3", date: WED, minutes: 60 });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.soldOut).toBe(true);
  });
});

describe("reconcileCapacityDay — the self-healing ledger", () => {
  it("recomputes the counter from jobs + live claims and expires dead checkouts", async () => {
    jobs.set("j1", {
      id: "j1",
      scheduledDate: WED,
      status: "SCHEDULED",
      propertyClass: "RESIDENTIAL",
      dispatchDriveMinutes: 20,
    });
    capacityClaims.set("dead", {
      id: "dead",
      date: WED,
      minutes: 60,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    capacityClaims.set("live", {
      id: "live",
      date: WED,
      minutes: 45,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    capacityDays.set(WED, { id: WED, date: WED, committedMinutes: 999 });

    const res = await reconcileCapacityDay(WED);
    expect(res.expiredClaims).toBe(1);
    // job (30 onsite + 20 travel) + live claim 45 = 95.
    expect(res.committedMinutes).toBe(95);
    expect(capacityDays.get(WED)!.committedMinutes).toBe(95);
    expect(capacityClaims.has("dead")).toBe(false);
  });

  it("committedMinutesOn counts pending-assignment (UNSCHEDULED-dated) visits too", async () => {
    jobs.set("j1", { id: "j1", scheduledDate: WED, status: "UNSCHEDULED" });
    const res = await committedMinutesOn(WED);
    expect(res.minutes).toBe(60);
  });
});
