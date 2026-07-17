import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The recurring engine's deactivation guard (defense in depth).
 *
 * Deactivation already cancels a customer's plans, so an ACTIVE plan on an
 * INACTIVE customer means one slipped through. The engine must still refuse to
 * queue the next visit — otherwise a technician gets routed to someone who
 * left. This is the belt to deactivation's braces.
 */

type Plan = { id: string; customerId: string; status: string; serviceFrequency: string; planName: string; delinquent?: boolean };
type Customer = { id: string; status: string; groupId?: string | null };

const plans = new Map<string, Plan>();
const customers = new Map<string, Customer>();
const created: unknown[] = [];

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
  },
};

vi.mock("./dataClient", () => ({ dataClient: async () => fakeDataClient }));
vi.mock("./dynamicGroups", () => ({ customerAccessGroups: () => ["cus-c1"] }));

const { scheduleNextRecurringVisit } = await import("./recurring");

beforeEach(() => {
  plans.clear();
  customers.clear();
  created.length = 0;
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
