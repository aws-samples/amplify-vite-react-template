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
  activeTechBases,
  bestSlotFor,
  claimDaySlot,
  closedTourMinutes,
  consumeCapacityClaim,
  dayEligibility,
  extendCapacityClaim,
  makeLegResolver,
  marginalTravelMinutes,
  onsiteMinutes,
  reconcileCapacityDay,
  recomputeSlotMinutes,
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

describe("activeTechBases — the origin set the service area is measured from", () => {
  it("returns each active technician's configured home base", async () => {
    technicians.set("t2", {
      id: "t2",
      name: "Rae",
      active: true,
      baseStreet: "9 Elm St",
      baseCity: "Marlborough",
      baseState: "MA",
      baseZip: "01752",
    });

    expect(await activeTechBases()).toEqual([
      "5 Base Rd, Ware, MA, 01082",
      "9 Elm St, Marlborough, MA, 01752",
    ]);
  });

  it("ignores inactive technicians — they dispatch from nowhere", async () => {
    technicians.set("t2", {
      id: "t2",
      active: false,
      baseStreet: "9 Elm St",
      baseCity: "Marlborough",
      baseState: "MA",
      baseZip: "01752",
    });

    expect(await activeTechBases()).toEqual(["5 Base Rd, Ware, MA, 01082"]);
  });

  it("dedupes technicians who share a base — one origin, not two matrix rows", async () => {
    technicians.set("t2", {
      id: "t2",
      active: true,
      baseStreet: "5 Base Rd",
      baseCity: "Ware",
      baseState: "MA",
      baseZip: "01082",
    });

    expect(await activeTechBases()).toEqual(["5 Base Rd, Ware, MA, 01082"]);
  });

  it("NEVER falls back to a company HQ: an unconfigured roster is null, not Ware", async () => {
    // The business has no central base. Silently substituting one would price
    // and judge out-of-area from an address no truck departs from — the exact
    // defect this accessor exists to prevent.
    technicians.set("t1", { id: "t1", name: "Sam", active: true });

    expect(await activeTechBases()).toBeNull();
  });

  it("is null when the roster read fails — the caller must not read that as far away", async () => {
    baseModels.Technician.list.mockRejectedValueOnce(new Error("dynamo down"));

    expect(await activeTechBases()).toBeNull();
  });
});

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

  it("the leg resolver dedupes CONCURRENT lookups of the same leg to one Routes call", async () => {
    // The quote day board prices several days at once, and neighbouring days
    // share legs (same technician bases, same recurring stops). The memo has
    // to hold the in-flight promise: a value-memo only dedupes calls that
    // START after an earlier one finished, so every concurrent day would miss
    // and fire its own BILLED Routes request. That failure is invisible at
    // runtime — the board is still correct, it just quietly costs more.
    driveMinutesBetween.mockClear();
    driveMinutesBetween.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return 15;
    });

    const legMinutes = makeLegResolver("routes-key");
    const answers = await Promise.all(
      Array.from({ length: 6 }, () =>
        legMinutes("12 Beacon St, Ware, MA", "9 Main St, Ware, MA")
      )
    );

    expect(answers).toEqual([15, 15, 15, 15, 15, 15]);
    expect(driveMinutesBetween).toHaveBeenCalledTimes(1);

    // And a later caller still reads the settled memo rather than re-calling.
    expect(
      await legMinutes("12 Beacon St, Ware, MA", "9 Main St, Ware, MA")
    ).toBe(15);
    expect(driveMinutesBetween).toHaveBeenCalledTimes(1);
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
    // One existing stop, every leg 15 min. Splicing the candidate into the
    // tour replaces one 15-min leg with two → a TRUE marginal of 15 (not the
    // old 2×15 round-trip double-count), so claim = 30 on-site + 15 = 45. The
    // discount still keys off nearestStopMinutes, so it names the tech we book.
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
      claimMinutes: 45,
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

describe("closedTourMinutes — travel is ONE tour, not a round trip per stop", () => {
  const BASE = "81 Greenwich Rd, Ware, MA";
  // A far cluster: base ↔ cluster is 85 min each way; hops WITHIN the cluster
  // are 5 min. This is the Ware-base / Ashland-work shape that read "full" at
  // two stops under the old per-stop double-count.
  const leg = async (from: string, to: string): Promise<number | null> => {
    if (from === to) return 0;
    const near = (a: string) => a.includes("Cluster");
    return near(from) && near(to) ? 5 : 85;
  };
  const clusterStop = (n: number, onsite: number) => ({
    address: `${n} Cluster Way`,
    onsite,
  });

  it("charges the far base haul ONCE for the whole cluster day", async () => {
    const stops = [clusterStop(1, 60), clusterStop(2, 60), clusterStop(3, 60)];
    const { travel, treatment, verified } = await closedTourMinutes(
      BASE,
      stops,
      leg
    );
    expect(verified).toBe(true);
    // base→s1 85 + s1→s2 5 + s2→s3 5 + s3→base 85 = 180 travel, measured ONCE.
    // The old model charged each stop its own ~170-min base round trip.
    expect(travel).toBe(180);
    expect(treatment).toBe(180); // 3 × 60 on-site
    // 180 + 180 = 360 leaves real room under the 540 budget for more cluster
    // stops — exactly what "full at two stops" was wrongly denying.
    expect(travel + treatment).toBeLessThan(DAY_MINUTES);
  });

  it("fails closed (unverified) on an unroutable leg, but still knows treatment", async () => {
    const res = await closedTourMinutes(
      BASE,
      [clusterStop(1, 30)],
      async () => null
    );
    expect(res.verified).toBe(false);
    expect(res.treatment).toBe(30);
  });

  it("an empty day is zero travel and verified", async () => {
    expect(await closedTourMinutes(BASE, [], leg)).toEqual({
      travel: 0,
      treatment: 0,
      verified: true,
    });
  });

  it("a missing base fails closed", async () => {
    const res = await closedTourMinutes(null, [clusterStop(1, 30)], leg);
    expect(res.verified).toBe(false);
  });

  it("NAMES the stop that broke the tour, so the office is told what to fix", async () => {
    // The middle stop cannot be resolved by Routes. Reporting only
    // "unverified" would surface to staff as a bare "that day is fully booked"
    // on a day that is nearly empty — the whole point is to say WHICH address.
    const legs = async (_from: string, to: string) =>
      to.includes("Bad") ? null : 10;
    const res = await closedTourMinutes(
      BASE,
      [
        { address: "1 Good St", onsite: 30, label: "Fine Property" },
        { address: "2 Bad St", onsite: 30, label: "Broken Property" },
      ],
      legs
    );
    expect(res.verified).toBe(false);
    expect(res.blockedBy).toEqual({
      address: "2 Bad St",
      label: "Broken Property",
    });
  });

  it("names a stop that has NO address at all", async () => {
    const res = await closedTourMinutes(
      BASE,
      [{ address: null, onsite: 30, label: "No Address Property" }],
      leg
    );
    expect(res.verified).toBe(false);
    expect(res.blockedBy).toEqual({
      address: null,
      label: "No Address Property",
    });
  });
});

describe("marginalTravelMinutes — what a stop really ADDS to a day", () => {
  const BASE = "81 Greenwich Rd, Ware, MA";
  // The real shape: base is 85 min from the cluster; hops inside it are 5.
  const leg = async (from: string, to: string): Promise<number | null> => {
    if (from === to) return 0;
    const near = (a: string) => a.includes("Cluster");
    return near(from) && near(to) ? 5 : 85;
  };

  it("an EMPTY day pays the full base round trip", async () => {
    expect(
      await marginalTravelMinutes({
        baseAddress: BASE,
        stops: [],
        candidateAddress: "1 Cluster Way",
        legMinutes: leg,
      })
    ).toBe(170); // 85 out + 85 back
  });

  it("a day ALREADY in the cluster pays only the detour, not another haul", async () => {
    // This is the office-assign bug: charging driveMinutes × 2 billed ~170 for
    // a stop next door to one the technician is already visiting.
    expect(
      await marginalTravelMinutes({
        baseAddress: BASE,
        stops: ["1 Cluster Way", "2 Cluster Way"],
        candidateAddress: "3 Cluster Way",
        legMinutes: leg,
      })
    ).toBe(5); // spliced between two cluster stops: 5 + 5 − 5
  });

  it("is null when no seam can be measured — the caller must fail closed", async () => {
    expect(
      await marginalTravelMinutes({
        baseAddress: BASE,
        stops: ["1 Cluster Way"],
        candidateAddress: "3 Cluster Way",
        legMinutes: async () => null,
      })
    ).toBeNull();
  });

  it("a far cluster day still fits well under the 540-minute window", async () => {
    // Nathaniel's Tuesday: 157 travel + 210 treatment = 367 committed. Adding
    // one more community stop in the same cluster must fit in the 173 left —
    // the old round-trip charge (60 + 170 = 230) is what refused it.
    const committed = 367;
    const marginal = await marginalTravelMinutes({
      baseAddress: BASE,
      stops: ["1 Cluster Way", "2 Cluster Way", "3 Cluster Way"],
      candidateAddress: "4 Cluster Way",
      legMinutes: leg,
    });
    const claim = 60 + (marginal ?? 0); // community on-site + real detour
    expect(claim).toBeLessThan(DAY_MINUTES - committed);
  });
});

describe("reserveSlot — an unroutable day is not a full day", () => {
  it("refuses an UNVERIFIED day with the real reason, not 'fully booked'", async () => {
    // The nightly rebuild pins an unmeasurable day at the full window (fail
    // closed), so it refuses exactly like a sold-out day. Staff must be told
    // the difference: one is genuinely booked, the other is one bad address.
    capacityDays.set(slotId(WED, "t1"), {
      id: slotId(WED, "t1"),
      date: WED,
      technicianId: "t1",
      committedMinutes: DAY_MINUTES,
      verified: false,
    });

    const res = await reserveSlot(WED, "t1", 30);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.message).toMatch(/can't be routed/i);
      expect(res.message).not.toMatch(/fully booked/i);
      // Not "sold out" — there is capacity, it is being withheld.
      expect(res.soldOut).toBe(false);
    }
  });

  it("still says 'fully booked' when the day is genuinely full", async () => {
    capacityDays.set(slotId(WED, "t1"), {
      id: slotId(WED, "t1"),
      date: WED,
      technicianId: "t1",
      committedMinutes: DAY_MINUTES,
      verified: true,
    });

    const res = await reserveSlot(WED, "t1", 30);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.message).toMatch(/fully booked/i);
      expect(res.soldOut).toBe(true);
    }
  });
});

describe("recomputeSlotMinutes — a mutation rebuilds the day to its real tour", () => {
  it("overwrites an INFLATED committed value with the true optimized tour + split", async () => {
    customers.set("c1", {
      id: "c1",
      serviceStreet: "9 Elm St",
      serviceCity: "Ware",
      serviceState: "MA",
      serviceZip: "01082",
    });
    customers.set("c2", {
      id: "c2",
      serviceStreet: "11 Elm St",
      serviceCity: "Ware",
      serviceState: "MA",
      serviceZip: "01082",
    });
    // Two SCHEDULED stops on t1 for WED (every mocked leg is 15 min).
    jobs.set("j1", {
      id: "j1",
      customerId: "c1",
      scheduledDate: WED,
      status: "SCHEDULED",
      technicianId: "t1",
      routeOrder: 1,
      propertyClass: "RESIDENTIAL",
    });
    jobs.set("j2", {
      id: "j2",
      customerId: "c2",
      scheduledDate: WED,
      status: "SCHEDULED",
      technicianId: "t1",
      routeOrder: 2,
      propertyClass: "RESIDENTIAL",
    });
    // The ledger is inflated (as the per-stop double-count would leave it),
    // which is what makes an almost-empty day read "fully booked".
    capacityDays.set(slotId(WED, "t1"), {
      id: slotId(WED, "t1"),
      date: WED,
      technicianId: "t1",
      committedMinutes: 480,
      verified: true,
    });

    await recomputeSlotMinutes(WED, "t1", "routes-key");

    const slot = capacityDays.get(slotId(WED, "t1"));
    // Real tour: base→s1 15 + s1→s2 15 + s2→base 15 = 45 travel; 2 × 30 = 60
    // treatment; committed = 105 — the day is nowhere near full.
    expect(slot!.travelMinutes).toBe(45);
    expect(slot!.treatmentMinutes).toBe(60);
    expect(slot!.committedMinutes).toBe(105);
    expect(slot!.verified).toBe(true);
  });

  it("is a no-op for the POOL slot (no route to measure)", async () => {
    await recomputeSlotMinutes(WED, "POOL", "routes-key");
    expect(capacityDays.get(slotId(WED, "POOL"))).toBeUndefined();
  });
});
