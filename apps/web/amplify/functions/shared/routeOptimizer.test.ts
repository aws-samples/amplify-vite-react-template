import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { solveClosedTsp } from "./routeOptimizer";

// ---------------------------------------------------------------------------
// solveClosedTsp — the pure exact TSP core
// ---------------------------------------------------------------------------
describe("solveClosedTsp — shortest base → stops → base tour", () => {
  // Asymmetric legs (real drive times differ by direction) with a single
  // clearly-cheapest loop: base → A → B → C → base costs 4; every other tour
  // pays at least one 10-minute leg. Matrix index 0 = base, 1 = A, 2 = B, 3 = C.
  const matrix = [
    [0, 1, 10, 10],
    [10, 0, 1, 10],
    [10, 10, 0, 1],
    [1, 10, 10, 0],
  ];

  it("orders the stops into the minimal closed tour", () => {
    expect(solveClosedTsp(matrix)).toEqual([0, 1, 2]); // A, B, C
  });

  it("a single stop is trivially itself", () => {
    expect(solveClosedTsp([[0, 5], [5, 0]])).toEqual([0]);
  });

  it("returns null when a stop is unreachable (fail closed, never guess)", () => {
    // Every leg to/from stop index 2 (matrix index 2) is unroutable → no tour
    // can include it, so there is no complete route.
    const m: (number | null)[][] = matrix.map((row) => [...row]);
    for (let k = 0; k < m.length; k++) {
      if (k !== 2) {
        m[2][k] = null;
        m[k][2] = null;
      }
    }
    expect(solveClosedTsp(m)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// optimizeTechDay — end to end against a mocked schedule + Routes matrix
// ---------------------------------------------------------------------------
const driveMatrixFrom = vi.fn();
vi.mock("./driveTime", () => ({
  driveMatrixFrom: (...a: unknown[]) =>
    (driveMatrixFrom as unknown as (...x: unknown[]) => Promise<(number | null)[]>)(
      ...a
    ),
}));
vi.mock("./capacity", () => ({
  POOL_TECH: "POOL",
  techBaseFor: async () => "BASE",
}));

// Asymmetric directed drive times with a single cheapest loop
// BASE → A → B → C → BASE (each 1 min; every other leg 10).
const COST: Record<string, Record<string, number>> = {
  BASE: { A: 1, B: 10, C: 10 },
  A: { BASE: 10, B: 1, C: 10 },
  B: { BASE: 10, A: 10, C: 1 },
  C: { BASE: 1, A: 10, B: 10 },
};
let jobs: Record<string, unknown>[] = [];
const updates: { id: string; routeOrder: number }[] = [];

const fakeClient = {
  models: {
    Job: {
      listJobByScheduledDate: async () => ({ data: jobs, nextToken: null }),
      update: async (patch: { id: string; routeOrder: number }) => {
        updates.push(patch);
        const j = jobs.find((x) => x.id === patch.id);
        if (j) j.routeOrder = patch.routeOrder;
        return { data: patch };
      },
    },
    Customer: {
      get: async ({ id }: { id: string }) => ({
        // customerId "cust-A" → address "A", etc.
        data: { serviceStreet: id.replace("cust-", ""), serviceCity: "Ware" },
      }),
    },
  },
};
vi.mock("./dataClient", () => ({ dataClient: async () => fakeClient }));

const { optimizeTechDay } = await import("./routeOptimizer");

beforeEach(() => {
  process.env.GOOGLE_ROUTES_API_KEY = "routes-key";
  updates.length = 0;
  driveMatrixFrom.mockImplementation(
    async (_key: string, origin: string, dests: string[]) => {
      const from = origin.split(",")[0];
      return dests.map((d) => COST[from]?.[d.split(",")[0]] ?? null);
    }
  );
  // Three stops for t1 on the date, in a deliberately SUBOPTIMAL order
  // (current order B, C, A; optimal is A, B, C).
  jobs = [
    { id: "jA", customerId: "cust-A", technicianId: "t1", status: "SCHEDULED", routeOrder: 3 },
    { id: "jB", customerId: "cust-B", technicianId: "t1", status: "SCHEDULED", routeOrder: 1 },
    { id: "jC", customerId: "cust-C", technicianId: "t1", status: "SCHEDULED", routeOrder: 2 },
  ];
});

afterEach(() => {
  delete process.env.GOOGLE_ROUTES_API_KEY;
});

describe("optimizeTechDay", () => {
  it("re-sequences the day into the shortest tour and writes the new order", async () => {
    const res = await optimizeTechDay({ technicianId: "t1", date: "2026-08-05" });
    expect(res.optimized).toBe(true);
    // The unique shortest loop is BASE → A → B → C → BASE.
    const order = new Map(jobs.map((j) => [j.id, j.routeOrder as number]));
    expect(order.get("jA")).toBe(1);
    expect(order.get("jB")).toBe(2);
    expect(order.get("jC")).toBe(3);
    expect(res.order).toEqual(["jA", "jB", "jC"]);
  });

  it("does nothing for a one-stop day", async () => {
    jobs = [jobs[0]];
    const res = await optimizeTechDay({ technicianId: "t1", date: "2026-08-05" });
    expect(res.optimized).toBe(false);
    expect(updates).toHaveLength(0);
  });

  it("never re-sequences a day already in progress", async () => {
    jobs[1].status = "IN_PROGRESS";
    const res = await optimizeTechDay({ technicianId: "t1", date: "2026-08-05" });
    expect(res.optimized).toBe(false);
    expect(updates).toHaveLength(0);
  });

  it("no Routes key ⇒ no-op (never reorders on guessed travel)", async () => {
    delete process.env.GOOGLE_ROUTES_API_KEY;
    const res = await optimizeTechDay({ technicianId: "t1", date: "2026-08-05" });
    expect(res.optimized).toBe(false);
    expect(updates).toHaveLength(0);
  });

  it("leaves the order untouched when a leg is unroutable", async () => {
    driveMatrixFrom.mockImplementation(async () => [null, null, null]);
    const res = await optimizeTechDay({ technicianId: "t1", date: "2026-08-05" });
    expect(res.optimized).toBe(false);
    expect(updates).toHaveLength(0);
  });

  it("ignores stops that belong to other technicians", async () => {
    jobs.push({
      id: "jX",
      customerId: "cust-A",
      technicianId: "t2",
      status: "SCHEDULED",
      routeOrder: 9,
    });
    await optimizeTechDay({ technicianId: "t1", date: "2026-08-05" });
    expect(updates.some((u) => u.id === "jX")).toBe(false);
  });
});
