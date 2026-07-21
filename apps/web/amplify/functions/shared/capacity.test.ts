import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _setLockStoreForTests, memoryLockStore } from "./atomicLock";
import { capacityFixtureModels } from "./capacityTestFixture";

/**
 * GL-04 — per-technician, per-DAY capacity, adversarially. The memory
 * lock store models DynamoDB's conditional atomicity, so the races here
 * deterministically prove one winner; every missing fact (models, CAS,
 * closures, licences, Routes legs) must FAIL CLOSED.
 */

type Row = Record<string, unknown>;
const technicians = new Map<string, Row>();
const licenses = new Map<string, Row[]>();
const jobs = new Map<string, Row>();
const customers = new Map<string, Row>();
const capacityFixture = capacityFixtureModels();
const { capacityDays, capacityClaims, techDayStops, closures, exceptions } =
  capacityFixture.maps;

let modelsPresent = true;

const baseModels = {
  Technician: {
    list: vi.fn(async () => ({
      data: [...technicians.values()],
      nextToken: null,
    })),
  },
  TechnicianLicense: {
    listTechnicianLicenseByTechnicianId: vi.fn(
      async ({ technicianId }: { technicianId: string }) => ({
        data: licenses.get(technicianId) ?? [],
        nextToken: null,
      })
    ),
  },
  Job: {
    listJobByScheduledDate: vi.fn(
      async ({ scheduledDate }: { scheduledDate: string }) => ({
        data: [...jobs.values()].filter(
          (j) => j.scheduledDate === scheduledDate
        ),
        nextToken: null,
      })
    ),
  },
  Customer: {
    get: vi.fn(async ({ id }: { id: string }) => ({
      data: customers.get(id) ?? null,
    })),
  },
};

vi.mock("./dataClient", () => ({
  dataClient: async () => ({
    models: modelsPresent
      ? { ...baseModels, ...capacityFixture.models }
      : { ...baseModels },
  }),
}));

const driveMinutesBetween = vi.fn(
  async (_k: string, _from: string, _to: string): Promise<number | null> => 15
);
vi.mock("./driveTime", () => ({
  HQ_ADDRESS: "81 Greenwich Rd, Ware, MA 01082",
  driveMinutesBetween: (...a: unknown[]) =>
    (driveMinutesBetween as unknown as (...x: unknown[]) => Promise<number | null>)(
      ...a
    ),
}));

const {
  bestSlotFor,
  claimDaySlot,
  consumeCapacityClaim,
  dayEligibility,
  extendCapacityClaim,
  makeLegResolver,
  onsiteMinutes,
  reconcileCapacityDay,
  dayStopId,
  STOPS_PER_TECH,
  releaseCapacityClaim,
  releaseJobCapacity,
  reserveSlot,
  releaseSlot,
  slotId,
  slotStates,
  stopsBySlotOn,
  DAY_MINUTES,
} = await import("./capacity");

// 2026-08-05 is a Wednesday; 2026-08-08 a Saturday.
const WED = "2026-08-05";
const SAT = "2026-08-08";

beforeEach(() => {
  for (const t of [
    technicians,
    jobs,
    customers,
    capacityDays,
    capacityClaims,
    techDayStops,
    closures,
    exceptions,
  ]) {
    t.clear();
  }
  licenses.clear();
  modelsPresent = true;
  driveMinutesBetween.mockClear();
  driveMinutesBetween.mockImplementation(async () => 15);
  _setLockStoreForTests(
    memoryLockStore({
      CapacityDay: capacityDays,
      CapacityClaim: capacityClaims,
      TechDayStops: techDayStops,
    })
  );
  technicians.set("t1", {
    id: "t1",
    name: "Sam",
    active: true,
    baseStreet: "5 Base Rd",
    baseCity: "Ware",
    baseState: "MA",
    baseZip: "01082",
  });
  licenses.set("t1", [
    { id: "l1", number: "MA-1", status: "CURRENT", expiresOn: "2099-01-01" },
  ]);
});

afterEach(() => _setLockStoreForTests(null));

describe("locked durations + the per-day ledger", () => {
  it("on-site minutes come from PROPERTY CLASS only: residential 30, commercial/community 60", () => {
    expect(onsiteMinutes("RESIDENTIAL")).toBe(30);
    expect(onsiteMinutes(null)).toBe(30);
    expect(onsiteMinutes("COMMERCIAL")).toBe(60);
    expect(onsiteMinutes("COMMUNITY")).toBe(60);
  });

  it("the working day is one 540-minute bucket per technician", () => {
    // 8:00–5:00 Eastern = 540 sellable minutes; there is no per-window split.
    expect(DAY_MINUTES).toBe(540);
    expect(slotId(WED, "t1")).toBe(`${WED}#t1`);
  });
});

describe("eligibility — every missing fact sells zero", () => {
  it("uses the technician's private base, and a day override wins over it", async () => {
    let day = await dayEligibility(WED);
    expect(day.techs).toHaveLength(1);
    expect(day.techs[0].baseAddress).toBe("5 Base Rd, Ware, MA, 01082");
    exceptions.set("e1", {
      id: "e1",
      technicianId: "t1",
      date: WED,
      kind: "BASE_OVERRIDE",
      reason: "Starting from the depot",
      overrideStreet: "9 Depot St",
      overrideCity: "Palmer",
      overrideState: "MA",
      overrideZip: "01069",
    });
    day = await dayEligibility(WED);
    expect(day.techs[0].baseAddress).toBe("9 Depot St, Palmer, MA, 01069");
  });

  it("weekends, closures, PTO, inactive, and unreadable licences sell zero", async () => {
    expect((await dayEligibility(SAT)).techs).toHaveLength(0);

    closures.set(WED, { id: WED, date: WED, reason: "Company outing" });
    expect((await dayEligibility(WED)).techs).toHaveLength(0);
    closures.clear();

    exceptions.set("e1", {
      id: "e1",
      technicianId: "t1",
      date: WED,
      kind: "PTO",
      reason: "Vacation",
    });
    expect((await dayEligibility(WED)).techs).toHaveLength(0);
    exceptions.clear();

    baseModels.TechnicianLicense.listTechnicianLicenseByTechnicianId.mockRejectedValueOnce(
      new Error("throttled")
    );
    const unreadable = await dayEligibility(WED);
    expect(unreadable.techs).toHaveLength(0);
    expect(unreadable.reasons.join(" ")).toMatch(/fail closed/i);
  });

  it("a CLOSURE-CALENDAR read failure sells zero — never treated as no closure", async () => {
    (capacityFixture.models.CompanyClosure as { get: unknown }).get =
      async () => {
        throw new Error("throttled");
      };
    try {
      const day = await dayEligibility(WED);
      expect(day.techs).toHaveLength(0);
      expect(day.reasons.join(" ")).toMatch(/closure calendar could not be read/i);
    } finally {
      const rebuilt = capacityFixtureModels();
      (capacityFixture.models.CompanyClosure as { get: unknown }).get = (
        rebuilt.models.CompanyClosure as { get: unknown }
      ).get;
    }
  });

  it("MISSING capacity models sell zero — never permissive success", async () => {
    modelsPresent = false;
    const day = await dayEligibility(WED);
    expect(day.techs).toHaveLength(0);
    const reserved = await reserveSlot(WED, "t1", 60);
    expect(reserved.ok).toBe(false);
    if (reserved.ok) throw new Error("unreachable");
    expect(reserved.unavailable).toBe(true);
  });

  it("CAS UNSUPPORTED refuses a reserve — never the read-then-write race", async () => {
    _setLockStoreForTests(memoryLockStore({})); // models exist; CAS wiring gone
    const reserved = await reserveSlot(WED, "t1", 60);
    expect(reserved.ok).toBe(false);
    if (reserved.ok) throw new Error("unreachable");
    expect(reserved.unavailable).toBe(true);
  });
});

describe("per-day atomicity — two buyers, one slot", () => {
  it("two concurrent claims for a slot's last minutes: exactly one wins", async () => {
    capacityDays.set(slotId(WED, "t1"), {
      id: slotId(WED, "t1"),
      date: WED,
      technicianId: "t1",
      committedMinutes: DAY_MINUTES - 60, // room for exactly one more 60
    });
    const [a, b] = await Promise.all([
      claimDaySlot({
        claimKey: "bk-A",
        date: WED,
        technicianId: "t1",
        minutes: 60,
      }),
      claimDaySlot({
        claimKey: "bk-B",
        date: WED,
        technicianId: "t1",
        minutes: 60,
      }),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(capacityClaims.size).toBe(1); // the loser's row is gone
    expect(capacityDays.get(slotId(WED, "t1"))!.committedMinutes).toBe(
      DAY_MINUTES
    );
  });

  it("two technicians' days are protected independently", async () => {
    capacityDays.set(slotId(WED, "t1"), {
      id: slotId(WED, "t1"),
      date: WED,
      technicianId: "t1",
      committedMinutes: DAY_MINUTES, // t1's day full
    });
    const t1 = await reserveSlot(WED, "t1", 30);
    expect(t1.ok).toBe(false);
    const t2 = await reserveSlot(WED, "t2", 30);
    expect(t2.ok).toBe(true);
  });

  it("release gives the slot's minutes back; consume keeps them and returns the slot facts", async () => {
    await claimDaySlot({
      claimKey: "bk-1",
      date: WED,
      technicianId: "t1",
      minutes: 75,
    });
    expect(capacityDays.get(slotId(WED, "t1"))!.committedMinutes).toBe(75);
    await releaseCapacityClaim("bk-1");
    expect(capacityDays.get(slotId(WED, "t1"))!.committedMinutes).toBe(0);

    await claimDaySlot({
      claimKey: "bk-2",
      date: WED,
      technicianId: "t1",
      minutes: 75,
    });
    const consumed = await consumeCapacityClaim("bk-2");
    expect(consumed).toMatchObject({
      technicianId: "t1",
      minutes: 75,
    });
    expect(capacityDays.get(slotId(WED, "t1"))!.committedMinutes).toBe(75);
    await releaseCapacityClaim("bk-2"); // double release = no-op
    expect(capacityDays.get(slotId(WED, "t1"))!.committedMinutes).toBe(75);
  });
});

describe("claim moves + strict releases — adversarial", () => {
  const seedSlot = (tech: string, committed = 0) => {
    capacityDays.set(slotId(WED, tech), {
      id: slotId(WED, tech),
      date: WED,
      technicianId: tech,
      committedMinutes: committed,
    });
  };

  it("a same-key claim with a CHANGED slot moves the reservation — never ok-with-nothing-held", async () => {
    seedSlot("t1");
    seedSlot("t2");
    const first = await claimDaySlot({
      claimKey: "bk-1",
      date: WED,
      technicianId: "t1",
      minutes: 60,
    });
    expect(first.ok).toBe(true);
    // The customer switches selection under the SAME booking id.
    const moved = await claimDaySlot({
      claimKey: "bk-1",
      date: WED,
      technicianId: "t2",
      minutes: 90,
    });
    expect(moved.ok).toBe(true);
    // Old slot released, new slot held, row carries the NEW facts.
    expect(capacityDays.get(slotId(WED, "t1"))!.committedMinutes).toBe(0);
    expect(capacityDays.get(slotId(WED, "t2"))!.committedMinutes).toBe(90);
    expect(capacityClaims.get("bk-1")).toMatchObject({
      technicianId: "t2",
      minutes: 90,
    });
  });

  it("a same-key move into a FULL slot refuses and keeps the original hold intact", async () => {
    seedSlot("t1");
    seedSlot("t2", DAY_MINUTES);
    await claimDaySlot({
      claimKey: "bk-1",
      date: WED,
      technicianId: "t1",
      minutes: 60,
    });
    const moved = await claimDaySlot({
      claimKey: "bk-1",
      date: WED,
      technicianId: "t2",
      minutes: 90,
    });
    expect(moved.ok).toBe(false);
    expect(capacityDays.get(slotId(WED, "t1"))!.committedMinutes).toBe(60);
    expect(capacityClaims.get("bk-1")).toMatchObject({
      technicianId: "t1",
    });
  });

  it("extending a swept (missing) claim reports false — the caller must re-claim", async () => {
    expect(await extendCapacityClaim("gone-key", 60_000)).toBe(false);
    seedSlot("t1");
    await claimDaySlot({
      claimKey: "bk-live",
      date: WED,
      technicianId: "t1",
      minutes: 30,
    });
    expect(await extendCapacityClaim("bk-live", 60_000)).toBe(true);
  });

  it("releaseJobCapacity releases ONLY stamped facts — an unstamped job gives nothing back", async () => {
    seedSlot("t1", 120);
    // Unstamped (legacy) job: nothing to release, ledger untouched.
    await releaseJobCapacity({
      scheduledDate: WED,
      technicianId: "t1",
    });
    expect(capacityDays.get(slotId(WED, "t1"))!.committedMinutes).toBe(120);
    // A funnel-held job (capacityTechnicianId, NO office assignment) releases
    // the TECHNICIAN slot its checkout reserved.
    await releaseJobCapacity({
      scheduledDate: WED,
      capacityMinutes: 45,
      technicianId: null,
      capacityTechnicianId: "t1",
    });
    expect(capacityDays.get(slotId(WED, "t1"))!.committedMinutes).toBe(75);
  });

  it("the nightly rebuild KEEPS a paid unassigned funnel booking on its held technician slot", async () => {
    jobs.set("j-funnel", {
      id: "j-funnel",
      customerId: "c1",
      status: "SCHEDULED",
      scheduledDate: WED,
      capacityMinutes: 60,
      capacityTechnicianId: "t1",
      technicianId: null,
      propertyClass: "RESIDENTIAL",
    });
    customers.set("c1", {
      id: "c1",
      serviceStreet: "9 Elm St",
      serviceCity: "Ware",
      serviceState: "MA",
      serviceZip: "01082",
    });
    await reconcileCapacityDay(WED, "key");
    const slot = capacityDays.get(slotId(WED, "t1"));
    // base → stop (15) + onsite 30 + stop → base (15) = 60, on tech t1 — NOT
    // reclassified to the non-blocking pool.
    expect(slot).toBeTruthy();
    expect(slot!.committedMinutes).toBe(60);
    expect(capacityDays.get(slotId(WED, "POOL"))?.committedMinutes ?? 0).toBe(0);
  });
});

describe("GL-07 — the atomic assigned-stop day ledger", () => {
  it("two concurrent claims for the day's LAST STOP: exactly one wins", async () => {
    techDayStops.set(dayStopId(WED, "t1"), {
      id: dayStopId(WED, "t1"),
      date: WED,
      technicianId: "t1",
      committedStops: STOPS_PER_TECH - 1,
    });

    const [a, b] = await Promise.all([
      reserveSlot(WED, "t1", 30, { stops: 1 }),
      reserveSlot(WED, "t1", 30, { stops: 1 }),
    ]);

    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const loser = a.ok ? b : a;
    expect(String((loser as { message?: string }).message)).toContain(
      "day is full"
    );
    expect(
      techDayStops.get(dayStopId(WED, "t1"))!.committedStops
    ).toBe(STOPS_PER_TECH); // exactly one landed
  });

  it("a minutes refusal returns the stop it had already won — a failed claim leaks nothing", async () => {
    capacityDays.set(slotId(WED, "t1"), {
      id: slotId(WED, "t1"),
      date: WED,
      technicianId: "t1",
      committedMinutes: DAY_MINUTES - 5, // 5 left of 540 — 30 won't fit
      verified: true,
    });

    const res = await reserveSlot(WED, "t1", 30, { stops: 1 });

    expect(res.ok).toBe(false);
    expect(
      techDayStops.get(dayStopId(WED, "t1"))?.committedStops ?? 0
    ).toBe(0); // the stop it won was compensated
  });

  it("release returns the minutes AND the assigned stop", async () => {
    const ok = await reserveSlot(WED, "t1", 45, { stops: 1 });
    expect(ok.ok).toBe(true);
    // The row was created against the REAL contract: required fields present.
    const created = techDayStops.get(dayStopId(WED, "t1"))!;
    expect(created).toMatchObject({ date: WED, technicianId: "t1", committedStops: 1 });

    await releaseSlot(WED, "t1", 45, { stops: 1 });

    expect(capacityDays.get(slotId(WED, "t1"))!.committedMinutes).toBe(0);
    expect(techDayStops.get(dayStopId(WED, "t1"))!.committedStops).toBe(0);
  });

  it("the nightly rebuild repairs a DRIFTED stop counter from ground truth", async () => {
    customers.set("c1", {
      id: "c1",
      serviceStreet: "9 Elm St",
      serviceCity: "Ware",
      serviceState: "MA",
      serviceZip: "01082",
    });
    // Ground truth: exactly ONE assigned visit for t1 on WED…
    jobs.set("j1", {
      id: "j1",
      customerId: "c1",
      scheduledDate: WED,
      status: "SCHEDULED",
      technicianId: "t1",
      routeOrder: 1,
      propertyClass: "RESIDENTIAL",
    });
    // …but the counter drifted to 5, and a second tech has a stale row
    // with no stops at all.
    techDayStops.set(dayStopId(WED, "t1"), {
      id: dayStopId(WED, "t1"),
      date: WED,
      technicianId: "t1",
      committedStops: 5,
    });
    techDayStops.set(dayStopId(WED, "t9"), {
      id: dayStopId(WED, "t9"),
      date: WED,
      technicianId: "t9",
      committedStops: 3,
    });

    await reconcileCapacityDay(WED, "routes-key");

    expect(techDayStops.get(dayStopId(WED, "t1"))!.committedStops).toBe(1);
    expect(techDayStops.get(dayStopId(WED, "t9"))!.committedStops).toBe(0);
  });

  it("FIRST-EVER stop: no row exists — the claim CREATES it with the real required fields and wins", async () => {
    expect(techDayStops.size).toBe(0);

    const res = await reserveSlot(WED, "t1", 30, { stops: 1 });

    expect(res.ok).toBe(true);
    expect(techDayStops.get(dayStopId(WED, "t1"))).toMatchObject({
      date: WED,
      technicianId: "t1",
      committedStops: 1,
    });
  });

  it("a stop-row CREATE the API rejects is an honest refusal, never a phantom 'day full'", async () => {
    // Simulate the deployed contract refusing the create (as the old
    // missing-required-field bug did): the model returns errors, no data.
    const model = capacityFixture.models.TechDayStops as {
      create: (i: Record<string, unknown>) => Promise<unknown>;
    };
    const realCreate = model.create;
    model.create = async () => ({
      data: null,
      errors: [{ message: "Variable 'input' has coerced Null value" }],
    });
    try {
      const res = await reserveSlot(WED, "t1", 30, { stops: 1 });
      expect(res.ok).toBe(false);
      const refusal = res as { unavailable?: boolean; message: string };
      // UNAVAILABLE — "try again", owned by ops — NOT a capacity lie.
      expect(refusal.unavailable).toBe(true);
      expect(refusal.message).not.toContain("day is full");
      // Nothing was claimed anywhere.
      expect(techDayStops.size).toBe(0);
      expect(
        capacityDays.get(slotId(WED, "t1"))?.committedMinutes ?? 0
      ).toBe(0);
    } finally {
      model.create = realCreate;
    }
  });

  it("the nightly rebuild CREATES a missing row for a day that has assigned stops", async () => {
    customers.set("c1", {
      id: "c1",
      serviceStreet: "9 Elm St",
      serviceCity: "Ware",
      serviceState: "MA",
      serviceZip: "01082",
    });
    jobs.set("j1", {
      id: "j1",
      customerId: "c1",
      scheduledDate: WED,
      status: "SCHEDULED",
      technicianId: "t1",
      routeOrder: 1,
      propertyClass: "RESIDENTIAL",
    });
    expect(techDayStops.size).toBe(0); // no ledger row at all

    await reconcileCapacityDay(WED, "routes-key");

    expect(techDayStops.get(dayStopId(WED, "t1"))).toMatchObject({
      date: WED,
      technicianId: "t1",
      committedStops: 1,
    });
  });
});

describe("feasibility — REAL Routes legs, fail closed", () => {
  it("an empty slot pays base → candidate → base with real legs; no Routes key means no capacity", async () => {
    const eligibility = await dayEligibility(WED);
    const best = await bestSlotFor({
      date: WED,
      onsite: 30,
      eligibility,
      slots: await slotStates(WED),
      stopsBySlot: new Map(),
      legMinutes: makeLegResolver("routes-key"),
      candidateAddress: "12 Beacon St, Ware, MA",
    });
    // 30 on-site + 15 out + 15 back.
    expect(best).toMatchObject({ technicianId: "t1", claimMinutes: 60 });

    const noKey = await bestSlotFor({
      date: WED,
      onsite: 30,
      eligibility,
      slots: await slotStates(WED),
      stopsBySlot: new Map(),
      legMinutes: makeLegResolver(null),
      candidateAddress: "12 Beacon St, Ware, MA",
    });
    expect(noKey).toBeNull();
  });

  it("a leg Routes cannot produce makes the slot infeasible", async () => {
    driveMinutesBetween.mockImplementation(async () => null);
    const best = await bestSlotFor({
      date: WED,
      onsite: 30,
      eligibility: await dayEligibility(WED),
      slots: await slotStates(WED),
      stopsBySlot: new Map(),
      legMinutes: makeLegResolver("routes-key"),
      candidateAddress: "12 Beacon St, Ware, MA",
    });
    expect(best).toBeNull();
  });

  it("an UNVERIFIED slot (failed nightly Routes rebuild) sells nothing", async () => {
    capacityDays.set(slotId(WED, "t1"), {
      id: slotId(WED, "t1"),
      date: WED,
      technicianId: "t1",
      committedMinutes: 0,
      verified: false,
    });
    const best = await bestSlotFor({
      date: WED,
      onsite: 30,
      eligibility: await dayEligibility(WED),
      slots: await slotStates(WED),
      stopsBySlot: new Map(),
      legMinutes: makeLegResolver("routes-key"),
      candidateAddress: "12 Beacon St, Ware, MA",
    });
    expect(best).toBeNull();
  });

  it("a technician already at the day's stop ceiling is never offered", async () => {
    // GL-07: t1 already holds STOPS_PER_TECH stops that day, so the only
    // eligible tech drops out and the day sells nothing — a booking can never
    // auto-assign onto a full route.
    const full = Array.from(
      { length: STOPS_PER_TECH },
      (_, i) => `${i} Stop St, Ware, MA`
    );
    const best = await bestSlotFor({
      date: WED,
      onsite: 30,
      eligibility: await dayEligibility(WED),
      slots: await slotStates(WED),
      stopsBySlot: new Map([[slotId(WED, "t1"), full]]),
      legMinutes: makeLegResolver("routes-key"),
      candidateAddress: "12 Beacon St, Ware, MA",
    });
    expect(best).toBeNull();
  });

  it("reports the nearest existing stop on the chosen tech (drives the discount)", async () => {
    // One stop 15 min away → nearest-stop insertion 2×15; the discount keys
    // off nearestStopMinutes, so it always names the tech we book.
    const best = await bestSlotFor({
      date: WED,
      onsite: 30,
      eligibility: await dayEligibility(WED),
      slots: await slotStates(WED),
      stopsBySlot: new Map([[slotId(WED, "t1"), ["9 Near St, Ware, MA"]]]),
      legMinutes: makeLegResolver("routes-key"),
      candidateAddress: "12 Beacon St, Ware, MA",
    });
    expect(best).toMatchObject({
      technicianId: "t1",
      claimMinutes: 60,
      nearestStopMinutes: 15,
    });
  });

  it("an empty tech has no nearest stop (no route-density discount)", async () => {
    const best = await bestSlotFor({
      date: WED,
      onsite: 30,
      eligibility: await dayEligibility(WED),
      slots: await slotStates(WED),
      stopsBySlot: new Map(),
      legMinutes: makeLegResolver("routes-key"),
      candidateAddress: "12 Beacon St, Ware, MA",
    });
    expect(best?.nearestStopMinutes).toBeNull();
  });
});

describe("nightly rebuild — base → stops → base with real legs", () => {
  it("rebuilds a slot from its jobs in route order and expires dead claims", async () => {
    customers.set("c1", {
      id: "c1",
      serviceStreet: "9 Elm St",
      serviceCity: "Ware",
      serviceState: "MA",
      serviceZip: "01082",
    });
    jobs.set("j1", {
      id: "j1",
      customerId: "c1",
      scheduledDate: WED,
      status: "SCHEDULED",
      technicianId: "t1",
      routeOrder: 1,
      propertyClass: "RESIDENTIAL",
    });
    capacityClaims.set("dead", {
      id: "dead",
      date: WED,
      technicianId: "t1",
      minutes: 60,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const res = await reconcileCapacityDay(WED, "routes-key");
    expect(res.expiredClaims).toBe(1);
    // base→stop 15 + onsite 30 + stop→base 15 = 60.
    const slot = capacityDays.get(slotId(WED, "t1"))!;
    expect(slot.committedMinutes).toBe(60);
    expect(slot.verified).toBe(true);
  });

  it("a slot whose legs cannot be verified is marked unverified and holds the full day", async () => {
    customers.set("c1", {
      id: "c1",
      serviceStreet: "9 Elm St",
      serviceCity: "Ware",
      serviceState: "MA",
      serviceZip: "01082",
    });
    jobs.set("j1", {
      id: "j1",
      customerId: "c1",
      scheduledDate: WED,
      status: "SCHEDULED",
      technicianId: "t1",
      routeOrder: 1,
    });
    driveMinutesBetween.mockImplementation(async () => null);
    const res = await reconcileCapacityDay(WED, "routes-key");
    expect(res.unverified).toBe(1);
    const slot = capacityDays.get(slotId(WED, "t1"))!;
    expect(slot.verified).toBe(false);
    expect(slot.committedMinutes).toBe(DAY_MINUTES);
  });

  it("stopsBySlotOn joins jobs and live claims into their tech-day slots", async () => {
    customers.set("c1", {
      id: "c1",
      serviceStreet: "9 Elm St",
      serviceCity: "Ware",
      serviceState: "MA",
      serviceZip: "01082",
    });
    jobs.set("j1", {
      id: "j1",
      customerId: "c1",
      scheduledDate: WED,
      status: "SCHEDULED",
      technicianId: "t1",
    });
    capacityClaims.set("live", {
      id: "live",
      date: WED,
      technicianId: "t1",
      address: "3 Oak St, Ware, MA",
      minutes: 45,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const stops = await stopsBySlotOn(WED);
    expect(stops.get(slotId(WED, "t1"))).toEqual([
      "9 Elm St, Ware, MA, 01082",
      "3 Oak St, Ware, MA",
    ]);
  });
});
