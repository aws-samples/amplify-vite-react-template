import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _setLockStoreForTests,
  casFencedDelete,
  casFencedUpdate,
  casGuardedUpdate,
  casTakeover,
  memoryLockStore,
} from "./atomicLock";
import {
  acquireOwnerSerial,
  claimStaffAccessCommand,
  finishCommand,
  recordCommandStage,
  releaseOwnerSerial,
} from "./staffAccessCommand";
import { acquireLifecycleClaim, releaseLifecycleClaim } from "./lifecycleClaim";

/**
 * The single-winner interleavings Jake's remediation demands. The in-memory
 * store evaluates a guarded write's condition and applies it in ONE
 * synchronous step (no await between check and write), which is exactly the
 * per-item atomicity DynamoDB's ConditionExpression gives the production
 * store — so these interleavings deterministically model the real races:
 *
 *  1. TWO STALE RECLAIMERS: both see an expired lease; exactly one guarded
 *     takeover wins. (Delete-then-create allowed BOTH to win: B could delete
 *     A's freshly re-created row and re-create its own.)
 *  2. EXPIRED HOLDER RELEASES AFTER TAKEOVER: A's lease expires, B takes
 *     over, A wakes up and releases — the fenced delete refuses, B's lock
 *     survives. (Unconditional delete released B's lock.)
 *  3. EXPIRED HOLDER WRITES AFTER TAKEOVER: A's progress/terminal writes are
 *     fenced on its nonce and refuse once B holds the lease.
 */

const rows = {
  StaffAccessCommand: new Map<string, Record<string, unknown>>(),
  OwnerChangeSerial: new Map<string, Record<string, unknown>>(),
  CustomerLifecycleClaim: new Map<string, Record<string, unknown>>(),
  CustomerLifecycleCommand: new Map<string, Record<string, unknown>>(),
  TreatmentObligation: new Map<string, Record<string, unknown>>(),
};

function fakeModel(table: Map<string, Record<string, unknown>>) {
  return {
    create: vi.fn(async (input: Record<string, unknown>) => {
      const id = String(input.id);
      if (table.has(id)) return { data: null };
      const row = { ...input, createdAt: new Date().toISOString() };
      table.set(id, row);
      return { data: { ...row } };
    }),
    get: vi.fn(async ({ id }: { id: string }) => ({
      data: table.has(id) ? { ...table.get(id)! } : null,
    })),
    update: vi.fn(async (input: Record<string, unknown>) => {
      const id = String(input.id);
      const row = table.get(id);
      if (!row) return { data: null };
      for (const [k, v] of Object.entries(input)) {
        if (v !== undefined) row[k] = v;
      }
      return { data: { ...row } };
    }),
    delete: vi.fn(async ({ id }: { id: string }) => {
      table.delete(id);
      return { data: null };
    }),
    listCustomerLifecycleCommandByCustomerIdAndRequestedAt: vi.fn(
      async () => ({ data: [] })
    ),
  };
}

vi.mock("./dataClient", () => ({
  dataClient: async () => ({
    models: {
      StaffAccessCommand: fakeModel(rows.StaffAccessCommand),
      OwnerChangeSerial: fakeModel(rows.OwnerChangeSerial),
      CustomerLifecycleClaim: fakeModel(rows.CustomerLifecycleClaim),
      CustomerLifecycleCommand: fakeModel(rows.CustomerLifecycleCommand),
      TreatmentObligation: fakeModel(rows.TreatmentObligation),
    },
  }),
}));

const PAST = new Date(Date.now() - 60_000).toISOString();
const FUTURE = new Date(Date.now() + 60_000).toISOString();

beforeEach(() => {
  for (const t of Object.values(rows)) t.clear();
  _setLockStoreForTests(memoryLockStore(rows));
});

afterEach(() => {
  _setLockStoreForTests(null);
});

describe("atomicLock primitives", () => {
  it("two stale reclaimers: exactly one guarded takeover wins", async () => {
    rows.StaffAccessCommand.set("cmd-1", {
      id: "cmd-1",
      stage: "VALIDATED",
      leaseNonce: "dead-holder",
      leaseUntil: PAST,
      attemptCount: 1,
    });
    const [a, b] = await Promise.all([
      casTakeover("StaffAccessCommand", "cmd-1", {
        nonceField: "leaseNonce",
        nonce: "reclaimer-A",
        leaseField: "leaseUntil",
        leaseMs: 60_000,
        bumpField: "attemptCount",
        refuseStages: { field: "stage", values: ["COMPLETE", "FAILED"] },
      }),
      casTakeover("StaffAccessCommand", "cmd-1", {
        nonceField: "leaseNonce",
        nonce: "reclaimer-B",
        leaseField: "leaseUntil",
        leaseMs: 60_000,
        bumpField: "attemptCount",
        refuseStages: { field: "stage", values: ["COMPLETE", "FAILED"] },
      }),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const winner = a.ok ? "reclaimer-A" : "reclaimer-B";
    const row = rows.StaffAccessCommand.get("cmd-1")!;
    expect(row.leaseNonce).toBe(winner);
    // One takeover = one attempt bump — a lost racer must not double-count.
    expect(row.attemptCount).toBe(2);
  });

  it("refuses takeover of a LIVE lease and of a settled command", async () => {
    rows.StaffAccessCommand.set("live", {
      id: "live",
      stage: "VALIDATED",
      leaseNonce: "holder",
      leaseUntil: FUTURE,
    });
    const live = await casTakeover("StaffAccessCommand", "live", {
      nonceField: "leaseNonce",
      nonce: "thief",
      leaseField: "leaseUntil",
      leaseMs: 60_000,
    });
    expect(live.ok).toBe(false);

    rows.StaffAccessCommand.set("done", {
      id: "done",
      stage: "COMPLETE",
      leaseNonce: "old",
      leaseUntil: PAST,
    });
    const settled = await casTakeover("StaffAccessCommand", "done", {
      nonceField: "leaseNonce",
      nonce: "reopener",
      leaseField: "leaseUntil",
      leaseMs: 60_000,
      refuseStages: { field: "stage", values: ["COMPLETE", "FAILED"] },
    });
    expect(settled.ok).toBe(false);
    expect(rows.StaffAccessCommand.get("done")!.stage).toBe("COMPLETE");
  });

  it("an expired holder cannot release the new holder's lock", async () => {
    rows.OwnerChangeSerial.set("owner-serial", {
      id: "owner-serial",
      holder: "worker-A",
      leaseUntil: PAST,
    });
    const taken = await casTakeover("OwnerChangeSerial", "owner-serial", {
      nonceField: "holder",
      nonce: "worker-B",
      leaseField: "leaseUntil",
      leaseMs: 60_000,
    });
    expect(taken.ok).toBe(true);
    // A wakes up late and releases with ITS nonce — refused, B's lock stays.
    const release = await casFencedDelete("OwnerChangeSerial", "owner-serial", {
      field: "holder",
      nonce: "worker-A",
    });
    expect(release).toBe("LOST");
    expect(rows.OwnerChangeSerial.get("owner-serial")!.holder).toBe("worker-B");
    // B's own release works.
    const own = await casFencedDelete("OwnerChangeSerial", "owner-serial", {
      field: "holder",
      nonce: "worker-B",
    });
    expect(own).toBe("OK");
    expect(rows.OwnerChangeSerial.has("owner-serial")).toBe(false);
  });

  it("an expired holder cannot overwrite the new holder's progress", async () => {
    rows.StaffAccessCommand.set("cmd-2", {
      id: "cmd-2",
      stage: "ACCESS_DONE",
      leaseNonce: "worker-B",
      leaseUntil: FUTURE,
    });
    const stale = await casFencedUpdate(
      "StaffAccessCommand",
      "cmd-2",
      { field: "leaseNonce", nonce: "worker-A" },
      { stage: "COMPLETE" }
    );
    expect(stale.ok).toBe(false);
    expect(rows.StaffAccessCommand.get("cmd-2")!.stage).toBe("ACCESS_DONE");
  });

  it("guarded month claim: two schedulers cannot both take one month", async () => {
    rows.TreatmentObligation.set("plan#2026-08", {
      id: "plan#2026-08",
      status: "DUE",
      jobId: null,
    });
    const [a, b] = await Promise.all([
      casGuardedUpdate(
        "TreatmentObligation",
        "plan#2026-08",
        { status: "SCHEDULED", jobId: "job-A" },
        [{ kind: "fieldEquals", field: "status", value: "DUE" }]
      ),
      casGuardedUpdate(
        "TreatmentObligation",
        "plan#2026-08",
        { status: "SCHEDULED", jobId: "job-B" },
        [{ kind: "fieldEquals", field: "status", value: "DUE" }]
      ),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const row = rows.TreatmentObligation.get("plan#2026-08")!;
    expect(row.status).toBe("SCHEDULED");
    expect(row.jobId).toBe(a.ok ? "job-A" : "job-B");
  });
});

describe("staff access command protocol under contention", () => {
  const claimInput = (key: string) => ({
    idempotencyKey: key,
    action: "OFFBOARD" as const,
    subjectEmail: "tech@buzzkill.test",
    actor: { sub: "actor", email: "owner@buzzkill.test" },
    reasonCode: "DEPARTURE",
  });

  it("two stale reclaimers of one command: one claims, one stands down", async () => {
    rows.StaffAccessCommand.set("k1", {
      id: "k1",
      action: "OFFBOARD",
      subjectEmail: "tech@buzzkill.test",
      stage: "ACCESS_DONE",
      requestedAt: PAST,
      leaseNonce: "dead",
      leaseUntil: PAST,
      attemptCount: 3,
    });
    const [a, b] = await Promise.all([
      claimStaffAccessCommand(claimInput("k1")),
      claimStaffAccessCommand(claimInput("k1")),
    ]);
    const claimed = [a, b].filter((r) => r.claimed);
    expect(claimed).toHaveLength(1);
    const winner = claimed[0] as Extract<
      Awaited<ReturnType<typeof claimStaffAccessCommand>>,
      { claimed: true }
    >;
    // The winner resumes from the recorded stage — the loser reports in-flight.
    expect(winner.resumedFromStage).toBe("ACCESS_DONE");
    expect(winner.attempt).toBe(4);
    const loser = [a, b].find((r) => !r.claimed)!;
    expect(loser.claimed).toBe(false);
  });

  it("a worker that lost its lease cannot record progress or finish", async () => {
    rows.StaffAccessCommand.set("k2", {
      id: "k2",
      action: "OFFBOARD",
      subjectEmail: "tech@buzzkill.test",
      stage: "VALIDATED",
      requestedAt: PAST,
      leaseNonce: "worker-A",
      leaseUntil: PAST,
      attemptCount: 1,
    });
    // B reclaims the expired command.
    const b = await claimStaffAccessCommand(claimInput("k2"));
    expect(b.claimed).toBe(true);
    // A (the expired holder) tries to write progress and a terminal — both
    // must refuse and leave B's row untouched.
    expect(
      await recordCommandStage("k2", "ACCESS_DONE", undefined, {
        nonce: "worker-A",
      })
    ).toBe(false);
    expect(
      await finishCommand(
        "k2",
        { stage: "COMPLETE", outcome: "COMPLETE", effects: "stale write" },
        { nonce: "worker-A" }
      )
    ).toBe(false);
    expect(rows.StaffAccessCommand.get("k2")!.stage).toBe("VALIDATED");
    // B's fenced writes land.
    const bNonce = (b as { nonce: string }).nonce;
    expect(
      await recordCommandStage("k2", "ACCESS_DONE", undefined, { nonce: bNonce })
    ).toBe(true);
    expect(rows.StaffAccessCommand.get("k2")!.stage).toBe("ACCESS_DONE");
  });

  it("owner serial: expired holder's release cannot unlock the new holder", async () => {
    expect(await acquireOwnerSerial("holder-A")).toBe(true);
    // Expire A's lease by hand, then B takes over.
    rows.OwnerChangeSerial.get("owner-serial")!.leaseUntil = PAST;
    expect(await acquireOwnerSerial("holder-B")).toBe(true);
    // A releases late — B must still hold the mutex.
    await releaseOwnerSerial("holder-A");
    expect(rows.OwnerChangeSerial.get("owner-serial")?.holder).toBe("holder-B");
    // And a third acquire while B is live still refuses.
    expect(await acquireOwnerSerial("holder-C")).toBe(false);
  });
});

describe("customer lifecycle claim under contention", () => {
  it("two reclaimers of an expired claim: exactly one wins; the loser's release is fenced", async () => {
    rows.CustomerLifecycleClaim.set("cust-1", {
      id: "cust-1",
      action: "DEACTIVATE",
      requestedAt: PAST,
      leaseUntil: PAST,
      holder: "dead",
    });
    const [a, b] = await Promise.all([
      acquireLifecycleClaim("cust-1", "DEACTIVATE"),
      acquireLifecycleClaim("cust-1", "REACTIVATE"),
    ]);
    const winners = [a, b].filter((r) => r.won);
    expect(winners).toHaveLength(1);
    const winner = winners[0] as { won: true; holder: string };
    // The loser calls release (its finally block) with a nonce it never got to
    // install — the winner's claim must survive.
    await releaseLifecycleClaim("cust-1", "some-stale-holder");
    expect(rows.CustomerLifecycleClaim.get("cust-1")?.holder).toBe(
      winner.holder
    );
    // The winner's own release clears it.
    await releaseLifecycleClaim("cust-1", winner.holder);
    expect(rows.CustomerLifecycleClaim.has("cust-1")).toBe(false);
  });

  it("a live claim is never stolen", async () => {
    rows.CustomerLifecycleClaim.set("cust-2", {
      id: "cust-2",
      action: "DEACTIVATE",
      requestedAt: new Date().toISOString(),
      leaseUntil: FUTURE,
      holder: "live-holder",
    });
    const attempt = await acquireLifecycleClaim("cust-2", "DEACTIVATE");
    expect(attempt.won).toBe(false);
    expect(rows.CustomerLifecycleClaim.get("cust-2")!.holder).toBe(
      "live-holder"
    );
  });
});
