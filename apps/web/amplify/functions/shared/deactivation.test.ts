import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";

/**
 * Customer deactivation guarantees. This is money + service in one button, so
 * the tests assert the promises, not the plumbing: every active plan's billing
 * is stopped, the remaining visits leave the schedule, the balance is REPORTED
 * and never charged, INACTIVE is set LAST, and a half-done deactivation (a plan
 * that would not cancel) leaves the customer ACTIVE and pages a human rather
 * than hiding a live charge behind an INACTIVE flag.
 */

type Plan = { id: string; customerId: string; planName: string; status: string };
type Job = {
  id: string;
  customerId: string;
  status: string;
  scheduledDate?: string | null;
  paidAt?: string | null;
  routeId?: string | null;
  routeOrder?: number | null;
  technicianId?: string | null;
  notes?: string | null;
};
type Invoice = {
  id: string;
  customerId: string;
  status: string;
  amountCents: number;
  refundedAmountCents?: number | null;
};
type Customer = {
  id: string;
  displayName: string;
  status: string;
  portalUserSub?: string | null;
};

const customers = new Map<string, Customer>();
const plans = new Map<string, Plan>();
const jobs = new Map<string, Job>();
const invoices = new Map<string, Invoice>();

/** Ordered log of the side effects, so we can prove INACTIVE is set LAST. */
let events: string[] = [];
let jobUpdate = async (patch: Partial<Job> & { id: string }) => {
  jobs.set(patch.id, { ...jobs.get(patch.id)!, ...patch });
  events.push(`job:${patch.id}`);
  return { data: jobs.get(patch.id) ?? null };
};

const fakeDataClient = {
  models: {
    Customer: {
      get: async ({ id }: { id: string }) => ({ data: customers.get(id) ?? null }),
      update: async (patch: Partial<Customer> & { id: string }) => {
        customers.set(patch.id, { ...customers.get(patch.id)!, ...patch });
        if (patch.status) events.push(`customer:${patch.status}`);
        return { data: customers.get(patch.id) };
      },
    },
    ServicePlan: {
      list: async ({ filter }: { filter: { customerId: { eq: string } } }) => ({
        data: [...plans.values()].filter(
          (p) => p.customerId === filter.customerId.eq
        ),
        nextToken: null,
      }),
    },
    Job: {
      list: async ({ filter }: { filter: { customerId: { eq: string } } }) => ({
        data: [...jobs.values()].filter(
          (j) => j.customerId === filter.customerId.eq
        ),
        nextToken: null,
      }),
      update: (patch: Partial<Job> & { id: string }) => jobUpdate(patch),
    },
    Invoice: {
      list: async ({ filter }: { filter: { customerId: { eq: string } } }) => ({
        data: [...invoices.values()].filter(
          (i) => i.customerId === filter.customerId.eq
        ),
        nextToken: null,
      }),
    },
  },
};

vi.mock("./dataClient", () => ({ dataClient: async () => fakeDataClient }));

const notifyOffice = vi.fn(async () => true);
vi.mock("./email", () => ({
  notifyOffice: (...a: unknown[]) =>
    (notifyOffice as unknown as (...x: unknown[]) => Promise<boolean>)(...a),
}));

const cancelPlanBilling = vi.fn(async (_stripe: unknown, servicePlanId: string) => {
  events.push(`cancelPlan:${servicePlanId}`);
  return {
    canceled: true,
    stripeSubscriptionCanceled: true,
    queuedVisits: {
      canceled: [{ jobId: `q-${servicePlanId}`, scheduledDate: null }],
      needsDecision: [],
      failed: [],
    },
  };
});
vi.mock("./subscription", () => ({
  cancelPlanBilling: (stripe: unknown, id: string) => cancelPlanBilling(stripe, id),
}));

const recordCustomerLifecycleEvent = vi.fn(async () => {});
vi.mock("./lifecycleLog", () => ({
  recordCustomerLifecycleEvent: (...a: unknown[]) =>
    (recordCustomerLifecycleEvent as unknown as (...x: unknown[]) => Promise<void>)(
      ...a
    ),
}));

const { deactivateCustomer } = await import("./deactivation");

/** A Stripe stub that would record a charge if one were ever attempted. */
const paymentIntentsCreate = vi.fn(async () => ({ id: "pi", status: "succeeded" }));
const stripe = {
  paymentIntents: { create: paymentIntentsCreate },
} as unknown as Stripe;

beforeEach(() => {
  customers.clear();
  plans.clear();
  jobs.clear();
  invoices.clear();
  events = [];
  notifyOffice.mockClear();
  paymentIntentsCreate.mockClear();
  recordCustomerLifecycleEvent.mockClear();
  cancelPlanBilling.mockClear();
  cancelPlanBilling.mockImplementation(async (_s: unknown, servicePlanId: string) => {
    events.push(`cancelPlan:${servicePlanId}`);
    return {
      canceled: true,
      stripeSubscriptionCanceled: true,
      queuedVisits: {
        canceled: [{ jobId: `q-${servicePlanId}`, scheduledDate: null }],
        needsDecision: [],
        failed: [],
      },
    };
  });
  jobUpdate = async (patch) => {
    jobs.set(patch.id, { ...jobs.get(patch.id)!, ...patch });
    events.push(`job:${patch.id}`);
    return { data: jobs.get(patch.id) ?? null };
  };
  customers.set("c1", {
    id: "c1",
    displayName: "Dana Whitlock",
    status: "ACTIVE",
    portalUserSub: "sub-portal-1",
  });
});

const seedPlan = (over: Partial<Plan> = {}): Plan => {
  const p: Plan = {
    id: `p${plans.size + 1}`,
    customerId: "c1",
    planName: "Residential quarterly",
    status: "ACTIVE",
    ...over,
  };
  plans.set(p.id, p);
  return p;
};
const seedJob = (over: Partial<Job> = {}): Job => {
  const j: Job = {
    id: `j${jobs.size + 1}`,
    customerId: "c1",
    status: "SCHEDULED",
    scheduledDate: "2026-10-14",
    paidAt: null,
    routeId: null,
    routeOrder: null,
    technicianId: null,
    notes: null,
    ...over,
  };
  jobs.set(j.id, j);
  return j;
};
const seedInvoice = (over: Partial<Invoice> = {}): Invoice => {
  const i: Invoice = {
    id: `inv${invoices.size + 1}`,
    customerId: "c1",
    status: "OPEN",
    amountCents: 5000,
    refundedAmountCents: null,
    ...over,
  };
  invoices.set(i.id, i);
  return i;
};

describe("deactivateCustomer", () => {
  it("cancels billing for every ACTIVE plan, once each", async () => {
    seedPlan({ id: "p1" });
    seedPlan({ id: "p2" });
    seedPlan({ id: "p3", status: "CANCELED" }); // already gone — skipped

    const res = await deactivateCustomer(stripe, "c1");

    expect(cancelPlanBilling).toHaveBeenCalledTimes(2);
    const ids = cancelPlanBilling.mock.calls.map((c) => c[1]);
    expect(ids).toEqual(expect.arrayContaining(["p1", "p2"]));
    expect(ids).not.toContain("p3");
    expect(res.plansCanceled).toBe(2);
    expect(res.visitsResolved).toBe(2); // one auto-queued visit resolved per plan
  });

  it("sweeps a remaining future visit off its route and cancels it", async () => {
    const job = seedJob({ status: "SCHEDULED", routeId: "r1", routeOrder: 3, technicianId: "t1" });

    const res = await deactivateCustomer(stripe, "c1");

    expect(jobs.get(job.id)).toMatchObject({
      status: "CANCELED",
      routeId: null,
      routeOrder: null,
      technicianId: null,
    });
    expect(jobs.get(job.id)!.notes).toMatch(/customer deactivated/i);
    expect(res.jobsCanceled).toBe(1);
  });

  it("leaves a paid-up-front visit and history alone", async () => {
    const paid = seedJob({ status: "SCHEDULED", paidAt: "2026-07-10T12:00:00Z" });
    const done = seedJob({ status: "COMPLETED" });

    const res = await deactivateCustomer(stripe, "c1");

    expect(jobs.get(paid.id)!.status).toBe("SCHEDULED");
    expect(jobs.get(done.id)!.status).toBe("COMPLETED");
    expect(res.jobsCanceled).toBe(0);
  });

  it("reports the outstanding balance (OPEN + FAILED, net of refunds) and charges nothing", async () => {
    seedInvoice({ status: "OPEN", amountCents: 5000 });
    seedInvoice({ status: "FAILED", amountCents: 3000, refundedAmountCents: 1000 });
    seedInvoice({ status: "PAID", amountCents: 9999 }); // settled — owes nothing

    const res = await deactivateCustomer(stripe, "c1");

    expect(res.outstandingBalanceCents).toBe(5000 + (3000 - 1000));
    expect(paymentIntentsCreate).not.toHaveBeenCalled();
  });

  it("flips INACTIVE last, after the money and the work are resolved, and returns the portal sub", async () => {
    seedPlan({ id: "p1" });
    seedJob({ status: "SCHEDULED" });

    const res = await deactivateCustomer(stripe, "c1");

    expect(customers.get("c1")!.status).toBe("INACTIVE");
    expect(res.status).toBe("INACTIVE");
    expect(res.partial).toBe(false);
    expect(res.portalUserSub).toBe("sub-portal-1");
    // The INACTIVE flip is the final side effect of the whole operation.
    expect(events[events.length - 1]).toBe("customer:INACTIVE");
    expect(events.indexOf("cancelPlan:p1")).toBeLessThan(
      events.indexOf("customer:INACTIVE")
    );
    // The transition is recorded for leadership: actor, prior → new status, and
    // the money/job effects (GL-09).
    expect(recordCustomerLifecycleEvent).toHaveBeenCalledOnce();
    const [entry] = recordCustomerLifecycleEvent.mock.calls[0] as unknown as [
      { action: string; priorStatus: string; newStatus: string; effects: string },
    ];
    expect(entry.action).toBe("DEACTIVATE");
    expect(entry.priorStatus).toBe("ACTIVE");
    expect(entry.newStatus).toBe("INACTIVE");
    expect(entry.effects).toMatch(/not charged/i);
  });

  it("does NOT flip INACTIVE and pages the office when a plan's cancel fails", async () => {
    // cancelPlanBilling throws only when the Stripe cancel itself failed — the
    // subscription is still live and still charging. An INACTIVE customer that
    // is still billing is invisible, so the flip must not happen.
    seedPlan({ id: "p1" });
    seedJob({ status: "SCHEDULED", routeId: "r1" });
    cancelPlanBilling.mockImplementationOnce(async () => {
      throw new Error("stripe is down");
    });

    const res = await deactivateCustomer(stripe, "c1");

    expect(res.partial).toBe(true);
    expect(res.status).toBe("ACTIVE");
    expect(customers.get("c1")!.status).toBe("ACTIVE");
    expect(events).not.toContain("customer:INACTIVE");
    // No transition happened, so nothing is written to the lifecycle ledger.
    expect(recordCustomerLifecycleEvent).not.toHaveBeenCalled();
    // The schedule sweep is skipped too — we don't half-deactivate.
    expect(res.jobsCanceled).toBe(0);
    expect(notifyOffice).toHaveBeenCalledOnce();
    const [alert] = notifyOffice.mock.calls[0] as unknown as [{ subject: string }];
    expect(alert.subject).toMatch(/ACTION REQUIRED/);
  });

  it("is idempotent: a re-run on an already-inactive customer is a clean no-op flip", async () => {
    customers.set("c1", {
      id: "c1",
      displayName: "Dana Whitlock",
      status: "INACTIVE",
      portalUserSub: "sub-portal-1",
    });

    const res = await deactivateCustomer(stripe, "c1");

    expect(res.partial).toBe(false);
    expect(res.plansCanceled).toBe(0);
    expect(res.jobsCanceled).toBe(0);
    expect(customers.get("c1")!.status).toBe("INACTIVE");
    // Already INACTIVE: the re-run re-asserts the flag but records no second
    // transition — the ledger is transitions, not idempotent no-ops.
    expect(recordCustomerLifecycleEvent).not.toHaveBeenCalled();
  });

  it("throws on a missing customer rather than reporting a deactivation it did not do", async () => {
    await expect(deactivateCustomer(stripe, "nope")).rejects.toThrow(/not found/);
  });
});
