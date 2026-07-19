import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _setLockStoreForTests, memoryLockStore } from "./atomicLock";

/**
 * GL-17 — the seasonal month mutex, adversarially. The obligation row is the
 * ONLY thing standing between a plan and two treatments in one month, so:
 * a missing ledger fails CLOSED, a missing CAS store fails CLOSED (the
 * read-then-write it would fall back to is exactly the race the mutex
 * exists to kill), two concurrent claimers get one winner, and a release
 * can never free a month a different visit holds.
 */

const obligations = new Map<string, Record<string, unknown>>();
let modelPresent = true;

const model = {
  create: vi.fn(async (input: { id: string } & Record<string, unknown>) => {
    if (obligations.has(input.id)) return { data: null };
    obligations.set(input.id, { ...input });
    return { data: { ...input } };
  }),
  get: vi.fn(async ({ id }: { id: string }) => ({
    data: obligations.has(id) ? { ...obligations.get(id)! } : null,
  })),
  update: vi.fn(async (input: { id: string } & Record<string, unknown>) => {
    const row = obligations.get(input.id);
    if (!row) return { data: null };
    for (const [k, v] of Object.entries(input)) if (v !== undefined) row[k] = v;
    return { data: { ...row } };
  }),
};

vi.mock("./dataClient", () => ({
  dataClient: async () => ({
    models: modelPresent ? { TreatmentObligation: model } : {},
  }),
}));

const openOwnedWork = vi.fn(async () => "work-1");
vi.mock("./ownedWork", () => ({
  openOwnedWork: (...a: unknown[]) =>
    (openOwnedWork as unknown as (...x: unknown[]) => Promise<string | null>)(...a),
}));

const { claimMonthForJob, releaseMonthForJob } = await import("./obligations");

beforeEach(() => {
  obligations.clear();
  modelPresent = true;
  openOwnedWork.mockClear();
  _setLockStoreForTests(memoryLockStore({ TreatmentObligation: obligations }));
});

afterEach(() => _setLockStoreForTests(null));

describe("claimMonthForJob — deterministic failure modes", () => {
  const input = (jobId: string) => ({
    servicePlanId: "plan-1",
    monthKey: "2026-08",
    jobId,
  });

  it("a fresh month is claimed by conditional create", async () => {
    const res = await claimMonthForJob(input("job-A"));
    expect(res.ok).toBe(true);
    expect(obligations.get("plan-1#2026-08")).toMatchObject({
      status: "SCHEDULED",
      jobId: "job-A",
    });
  });

  it("two concurrent claimers of a DUE month: exactly one wins", async () => {
    obligations.set("plan-1#2026-08", {
      id: "plan-1#2026-08",
      status: "DUE",
      jobId: null,
    });
    const [a, b] = await Promise.all([
      claimMonthForJob(input("job-A")),
      claimMonthForJob(input("job-B")),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const row = obligations.get("plan-1#2026-08")!;
    expect(row.status).toBe("SCHEDULED");
    expect(row.jobId).toBe(a.ok ? "job-A" : "job-B");
  });

  it("the same job re-claiming its month is idempotent", async () => {
    await claimMonthForJob(input("job-A"));
    const again = await claimMonthForJob(input("job-A"));
    expect(again.ok).toBe(true);
  });

  it("FAILS CLOSED when the obligation ledger is unavailable", async () => {
    modelPresent = false;
    const res = await claimMonthForJob(input("job-A"));
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.unavailable).toBe(true);
  });

  it("FAILS CLOSED when CAS is unavailable — never the read-then-write race", async () => {
    obligations.set("plan-1#2026-08", {
      id: "plan-1#2026-08",
      status: "DUE",
      jobId: null,
    });
    _setLockStoreForTests(memoryLockStore({})); // no TreatmentObligation table wired
    const res = await claimMonthForJob(input("job-A"));
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.unavailable).toBe(true);
    // The month was NOT flipped by any fallback write.
    expect(obligations.get("plan-1#2026-08")!.status).toBe("DUE");
  });

  it("a SATISFIED or other-job month refuses with the holder named", async () => {
    obligations.set("plan-1#2026-08", {
      id: "plan-1#2026-08",
      status: "SCHEDULED",
      jobId: "job-OTHER",
    });
    const res = await claimMonthForJob(input("job-A"));
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.holderJobId).toBe("job-OTHER");
  });
});

describe("releaseMonthForJob — fenced on the owning job", () => {
  it("releases only the owning job's month", async () => {
    obligations.set("plan-1#2026-08", {
      id: "plan-1#2026-08",
      status: "SCHEDULED",
      jobId: "job-A",
    });
    await releaseMonthForJob({
      servicePlanId: "plan-1",
      monthKey: "2026-08",
      jobId: "job-B", // NOT the holder
    });
    expect(obligations.get("plan-1#2026-08")).toMatchObject({
      status: "SCHEDULED",
      jobId: "job-A",
    });
    await releaseMonthForJob({
      servicePlanId: "plan-1",
      monthKey: "2026-08",
      jobId: "job-A",
    });
    expect(obligations.get("plan-1#2026-08")!.status).toBe("DUE");
  });

  it("FAILS CLOSED (no unguarded write) when CAS is unavailable", async () => {
    obligations.set("plan-1#2026-08", {
      id: "plan-1#2026-08",
      status: "SCHEDULED",
      jobId: "job-A",
    });
    _setLockStoreForTests(memoryLockStore({}));
    await releaseMonthForJob({
      servicePlanId: "plan-1",
      monthKey: "2026-08",
      jobId: "job-A",
    });
    // Held is the safe error — no fallback write raced anyone.
    expect(obligations.get("plan-1#2026-08")!.status).toBe("SCHEDULED");
  });

  it("never regresses SATISFIED", async () => {
    obligations.set("plan-1#2026-08", {
      id: "plan-1#2026-08",
      status: "SATISFIED",
      jobId: "job-A",
    });
    await releaseMonthForJob({
      servicePlanId: "plan-1",
      monthKey: "2026-08",
      jobId: "job-A",
    });
    expect(obligations.get("plan-1#2026-08")!.status).toBe("SATISFIED");
  });
});
