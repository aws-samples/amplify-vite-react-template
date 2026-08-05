import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The recurring engine's deactivation guard (defense in depth).
 *
 * Deactivation already cancels a customer's plans, so an ACTIVE plan on an
 * INACTIVE customer means one slipped through. The engine must still refuse to
 * queue the next visit — otherwise a technician gets routed to someone who
 * left. This is the belt to deactivation's braces.
 */

type Plan = {
  id: string;
  customerId: string;
  status: string;
  serviceFrequency: string;
  planName: string;
  delinquent?: boolean;
  seasonal?: boolean;
  serviceMonths?: number[];
};
type Customer = {
  id: string;
  status: string;
  groupId?: string | null;
  propertyClass?: string | null;
};

const plans = new Map<string, Plan>();
const customers = new Map<string, Customer>();
const created: unknown[] = [];
/** TreatmentObligation rows, keyed by id (`<planId>#<YYYY-MM>`). */
const obligations = new Map<string, Record<string, unknown>>();

const fakeDataClient = {
  models: {
    ServicePlan: {
      get: async ({ id }: { id: string }) => ({ data: plans.get(id) ?? null }),
    },
    Customer: {
      get: async ({ id }: { id: string }) => ({ data: customers.get(id) ?? null }),
    },
    Job: {
      listJobByServicePlanId: async () => ({ data: [], nextToken: null }),
      create: async (input: unknown) => {
        created.push(input);
        return { data: { id: `job-${created.length}` } };
      },
    },
    TreatmentObligation: {
      create: async (input: Record<string, unknown> & { id: string }) => {
        if (obligations.has(input.id)) return { data: null };
        obligations.set(input.id, { ...input });
        return { data: obligations.get(input.id) };
      },
      get: async ({ id }: { id: string }) => ({
        data: obligations.get(id) ?? null,
      }),
      update: async (input: Record<string, unknown> & { id: string }) => {
        const existing = obligations.get(input.id);
        if (!existing) return { data: null };
        obligations.set(input.id, { ...existing, ...input });
        return { data: obligations.get(input.id) };
      },
    },
  },
};

vi.mock("./dataClient", () => ({ dataClient: async () => fakeDataClient }));
vi.mock("./dynamicGroups", () => ({ customerAccessGroups: () => ["cus-c1"] }));

const { scheduleNextRecurringVisit } = await import("./recurring");

beforeEach(() => {
  plans.clear();
  customers.clear();
  created.length = 0;
  obligations.clear();
  plans.set("p1", {
    id: "p1",
    customerId: "c1",
    status: "ACTIVE",
    serviceFrequency: "QUARTERLY",
    planName: "Residential quarterly",
  });
});

const completedJob = {
  id: "j1",
  customerId: "c1",
  servicePlanId: "p1",
  serviceType: "General pest",
  completedAt: "2026-07-10T12:00:00Z",
};

describe("scheduleNextRecurringVisit — INACTIVE customer guard", () => {
  it("does not queue the next visit when the customer is INACTIVE", async () => {
    customers.set("c1", { id: "c1", status: "INACTIVE" });

    await scheduleNextRecurringVisit(completedJob);

    expect(created).toHaveLength(0);
  });

  it("still queues the next visit for an ACTIVE customer", async () => {
    customers.set("c1", { id: "c1", status: "ACTIVE" });

    await scheduleNextRecurringVisit(completedJob);

    expect(created).toHaveLength(1);
  });

  it("a twice-a-year (SEMIANNUAL) plan queues the next visit ~6 months out", async () => {
    customers.set("c1", { id: "c1", status: "ACTIVE" });
    plans.set("p1", {
      id: "p1",
      customerId: "c1",
      status: "ACTIVE",
      serviceFrequency: "SEMIANNUAL",
      planName: "Bi-annual farm",
    });

    await scheduleNextRecurringVisit(completedJob); // completed 2026-07-10

    const next = created[0] as { scheduledDate: string };
    // 2026-07-10 + 182 days = 2027-01-08.
    expect(next.scheduledDate).toBe("2027-01-08");
  });
});

/**
 * The next visit must be born DISPATCHABLE. assertDispatchFacts refuses a job
 * with no property classification, and the only editor for a job's class is
 * that visit's own dispatch packet — so a visit minted without one is stuck
 * until someone finds an obscure button. Carrying the completed job's class
 * forward is right when it has one, but an imported or pre-classification job
 * has none, and `null` was being carried forward faithfully.
 */
describe("scheduleNextRecurringVisit — the next visit's property class", () => {
  it("carries the completed visit's class forward, and sizes capacity from it", async () => {
    customers.set("c1", { id: "c1", status: "ACTIVE", propertyClass: "RESIDENTIAL" });

    await scheduleNextRecurringVisit({
      ...completedJob,
      propertyClass: "COMMUNITY",
    });

    const next = created[0] as { propertyClass: string; capacityMinutes: number };
    // The visit's own class wins over the customer default...
    expect(next.propertyClass).toBe("COMMUNITY");
    // ...and the reserved minutes agree with it (community is 60, not 30).
    expect(next.capacityMinutes).toBe(60);
  });

  it("falls back to the customer's class when the completed visit carries none", async () => {
    customers.set("c1", { id: "c1", status: "ACTIVE", propertyClass: "COMMUNITY" });

    // A job imported from FieldRoutes, or created before the class was
    // recorded: no propertyClass at all.
    await scheduleNextRecurringVisit(completedJob);

    const next = created[0] as { propertyClass?: string; capacityMinutes: number };
    expect(next.propertyClass).toBe("COMMUNITY");
    // The old code sized this off the completed job's absent class and quietly
    // reserved the residential 30 for a 60-minute common-area visit.
    expect(next.capacityMinutes).toBe(60);
  });

  it("leaves the class unset when nobody has ever classified the property", async () => {
    customers.set("c1", { id: "c1", status: "ACTIVE" });

    await scheduleNextRecurringVisit(completedJob);

    // Not invented. This is the case the dispatch guard genuinely exists for,
    // and the office is asked once, in the visit's packet.
    const next = created[0] as { propertyClass?: string };
    expect(next.propertyClass).toBeUndefined();
  });
});

describe("scheduleNextRecurringVisit — one-time type guard", () => {
  it("does not queue a next visit for a ONE_TIME job, even with a plan id", async () => {
    customers.set("c1", { id: "c1", status: "ACTIVE" });

    // A contradictory record: a one-time job that somehow carries a plan id.
    // Billing already refuses this (startBillingForPlan gates on RECURRING);
    // scheduling must refuse in lockstep so a one-time treatment can never
    // spawn a recurring successor.
    await scheduleNextRecurringVisit({ ...completedJob, type: "ONE_TIME" });

    expect(created).toHaveLength(0);
  });

  it("queues a next visit for a RECURRING job", async () => {
    customers.set("c1", { id: "c1", status: "ACTIVE" });

    await scheduleNextRecurringVisit({ ...completedJob, type: "RECURRING" });

    expect(created).toHaveLength(1);
  });
});

describe("scheduleNextRecurringVisit — delinquency gate", () => {
  it("does not queue the next visit when the plan is delinquent (billing suspended)", async () => {
    customers.set("c1", { id: "c1", status: "ACTIVE" });
    plans.set("p1", {
      id: "p1",
      customerId: "c1",
      status: "ACTIVE",
      serviceFrequency: "QUARTERLY",
      planName: "Residential quarterly",
      delinquent: true,
    });

    await scheduleNextRecurringVisit(completedJob);

    expect(created).toHaveLength(0);
  });
});


describe("scheduleNextRecurringVisit — the seasonal calendar (GL-17)", () => {
  const seasonalPlan: Plan = {
    id: "p1",
    customerId: "c1",
    status: "ACTIVE",
    serviceFrequency: "MONTHLY",
    planName: "Mosquito + tick plan",
    seasonal: true,
    serviceMonths: [4, 5, 6, 7, 8, 9, 10],
  };

  it("an October completion queues NEXT APRIL — never a November visit — and satisfies October", async () => {
    customers.set("c1", { id: "c1", status: "ACTIVE" });
    plans.set("p1", seasonalPlan);

    await scheduleNextRecurringVisit({
      ...completedJob,
      completedAt: "2026-10-14T15:00:00Z",
    });

    expect(created).toHaveLength(1);
    const next = created[0] as { scheduledDate: string };
    expect(next.scheduledDate.slice(0, 7)).toBe("2027-04");
    // October's obligation is SATISFIED by the completed treatment.
    expect(obligations.get("p1#2026-10")?.status).toBe("SATISFIED");
    // April's obligation exists and is SCHEDULED against the queued visit.
    expect(obligations.get("p1#2027-04")?.status).toBe("SCHEDULED");
  });

  it("a mid-season completion queues the NEXT calendar month (one treatment per month)", async () => {
    customers.set("c1", { id: "c1", status: "ACTIVE" });
    plans.set("p1", seasonalPlan);

    await scheduleNextRecurringVisit({
      ...completedJob,
      completedAt: "2026-06-05T15:00:00Z",
    });

    const next = created[0] as { scheduledDate: string };
    expect(next.scheduledDate.slice(0, 7)).toBe("2026-07");
    expect(obligations.get("p1#2026-06")?.status).toBe("SATISFIED");
  });

  it("a SATISFIED month is terminal — a later skip cannot regress it", async () => {
    customers.set("c1", { id: "c1", status: "ACTIVE" });
    plans.set("p1", seasonalPlan);
    await scheduleNextRecurringVisit({
      ...completedJob,
      completedAt: "2026-06-05T15:00:00Z",
    });
    const { markObligation } = await import("./obligations");
    await markObligation({
      servicePlanId: "p1",
      monthKey: "2026-06",
      status: "SKIPPED_MISSED",
    });
    expect(obligations.get("p1#2026-06")?.status).toBe("SATISFIED");
  });
});
