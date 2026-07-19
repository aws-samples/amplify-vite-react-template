import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { _setLockStoreForTests, memoryLockStore } from "./atomicLock";

/**
 * GL-08 — CROSS-MODULE settlement proof. The REAL cancelPlanBilling runs
 * first (Stripe cancel → CRM flip → visit sweep — the path that CLEARS
 * ServicePlan.stripeSubscriptionId), then the REAL planCancellationSettled
 * judges it. Nothing simulates cancellation by flipping plan.status: if the
 * provider reference didn't survive the real path, the readback would be
 * skipped and these tests would catch it.
 */

type Row = Record<string, unknown>;
const plans = new Map<string, Row>();
const jobs = new Map<string, Row>();
const invoices = new Map<string, Row>();
const claims = new Map<string, Row>();
const customers = new Map<string, Row>();
const emailLogs = new Map<string, Row>();
const workItems = new Map<string, Row>();

const fakeDataClient = {
  models: {
    ServicePlan: {
      get: async ({ id }: { id: string }) => ({ data: plans.get(id) ?? null }),
      update: async (patch: Row & { id: string }) => {
        const row = plans.get(patch.id);
        if (!row) return { data: null };
        for (const [k, v] of Object.entries(patch)) if (v !== undefined) row[k] = v;
        return { data: { ...row } };
      },
    },
    Customer: {
      get: async ({ id }: { id: string }) => ({ data: customers.get(id) ?? null }),
    },
    Job: {
      listJobByServicePlanId: async ({ servicePlanId }: { servicePlanId: string }) => ({
        data: [...jobs.values()].filter((j) => j.servicePlanId === servicePlanId),
        nextToken: null,
      }),
      update: async (patch: Row & { id: string }) => {
        const row = jobs.get(patch.id);
        if (!row) return { data: null };
        for (const [k, v] of Object.entries(patch)) if (v !== undefined) row[k] = v;
        return { data: { ...row } };
      },
    },
    Invoice: {
      list: async ({
        filter,
      }: {
        filter?: {
          jobId?: { eq: string };
          servicePlanId?: { eq: string };
          or?: { status: { eq: string } }[];
        };
      }) => ({
        data: [...invoices.values()].filter((inv) => {
          if (filter?.jobId && inv.jobId !== filter.jobId.eq) return false;
          if (filter?.servicePlanId && inv.servicePlanId !== filter.servicePlanId.eq)
            return false;
          return true;
        }),
        nextToken: null,
      }),
    },
    PlanCancellationClaim: {
      create: async (input: Row & { id: string }) => {
        if (claims.has(input.id)) return { data: null };
        claims.set(input.id, { createdAt: new Date().toISOString(), ...input });
        return { data: { ...claims.get(input.id)! } };
      },
      get: async ({ id }: { id: string }) => ({ data: claims.get(id) ?? null }),
      update: async (patch: Row & { id: string }) => {
        const row = claims.get(patch.id) ?? { id: patch.id };
        for (const [k, v] of Object.entries(patch)) if (v !== undefined) row[k] = v;
        claims.set(patch.id, row);
        return { data: { ...row } };
      },
      delete: async ({ id }: { id: string }) => {
        claims.delete(id);
        return { data: null };
      },
      list: async () => ({ data: [...claims.values()], nextToken: null }),
    },
    EmailLog: {
      listEmailLogByRelatedId: async ({ relatedId }: { relatedId: string }) => ({
        data: [...emailLogs.values()].filter((l) => l.relatedId === relatedId),
        nextToken: null,
      }),
    },
    WorkItem: {
      get: async ({ id }: { id: string }) => ({ data: workItems.get(id) ?? null }),
    },
  },
};

vi.mock("./dataClient", () => ({ dataClient: async () => fakeDataClient }));

const sendEmail = vi.fn(async () => true);
vi.mock("./email", () => ({
  sendEmail: (...a: unknown[]) =>
    (sendEmail as unknown as (...x: unknown[]) => Promise<boolean>)(...a),
  emailShell: (h: string, b: string) => `${h}${b}`,
  notifyOffice: vi.fn(async () => true),
}));

const openOwnedWork = vi.fn(async () => "work-1");
vi.mock("./ownedWork", () => ({
  openOwnedWork: (...a: unknown[]) =>
    (openOwnedWork as unknown as (...x: unknown[]) => Promise<string | null>)(...a),
  resolveOwnedWork: vi.fn(async () => true),
  openMissingContactWork: vi.fn(async () => "work-mc"),
  workItemId: (kind: string, key: string) => `${kind}:${key}`,
}));

// capacity + obligations are exercised elsewhere; here they must only not throw.
vi.mock("./capacity", () => ({
  releaseSlot: vi.fn(async () => undefined),
  releasePoolMinutes: vi.fn(async () => undefined),
  onsiteMinutes: () => 30,
  windowOfTimeWindow: () => "MORNING",
}));

const { cancelPlanBilling } = await import("./subscription");
const { planCancellationSettled } = await import("./planCancellation");

/** A Stripe fake whose subscription store is the provider's ground truth. */
function makeStripe(subStatus: Record<string, string>): Stripe {
  return {
    subscriptions: {
      cancel: vi.fn(async (id: string) => {
        subStatus[id] = "canceled";
        return { id };
      }),
      retrieve: vi.fn(async (id: string) => {
        if (!(id in subStatus)) {
          throw Object.assign(new Error("No such subscription"), {
            code: "resource_missing",
          });
        }
        return { id, status: subStatus[id] };
      }),
    },
  } as unknown as Stripe;
}

beforeEach(() => {
  for (const t of [plans, jobs, invoices, claims, customers, emailLogs, workItems]) {
    t.clear();
  }
  sendEmail.mockClear();
  openOwnedWork.mockClear();
  _setLockStoreForTests(
    memoryLockStore({ PlanCancellationClaim: claims })
  );
  customers.set("c1", { id: "c1", displayName: "Dana", email: "dana@example.com" });
  plans.set("p1", {
    id: "p1",
    customerId: "c1",
    planName: "Quarterly Pest Plan",
    priceCents: 4500,
    serviceFrequency: "QUARTERLY",
    status: "ACTIVE",
    stripeSubscriptionId: "sub_live_1",
  });
  emailLogs.set("n1", {
    id: "n1",
    relatedId: "p1",
    template: "plan-canceled",
    deliveryStatus: "DELIVERED",
    createdAt: new Date().toISOString(),
  });
});

afterEach(() => _setLockStoreForTests(null));

describe("GL-08 cross-module: real cancel → real settlement", () => {
  it("the REAL cancel path preserves the provider reference and settlement re-proves it at Stripe", async () => {
    const subStatus: Record<string, string> = { sub_live_1: "active" };
    const stripe = makeStripe(subStatus);

    await cancelPlanBilling(stripe, "p1");
    // The real path cleared the live id…
    expect(plans.get("p1")).toMatchObject({
      status: "CANCELED",
      stripeSubscriptionId: null,
      // …but the durable reference survives.
      canceledStripeSubscriptionId: "sub_live_1",
    });

    const settled = await planCancellationSettled("p1", { stripe });
    expect(settled.settled).toBe(true);
    // The provider readback actually ran, against the SURVIVING reference.
    expect(
      (stripe.subscriptions.retrieve as unknown as { mock: { calls: unknown[][] } })
        .mock.calls.map((c) => c[0])
    ).toContain("sub_live_1");
  });

  it("NOT settled while the provider still reports the subscription active — even though CRM reads CANCELED", async () => {
    const subStatus: Record<string, string> = { sub_live_1: "active" };
    const stripe = makeStripe(subStatus);
    await cancelPlanBilling(stripe, "p1");
    // Simulate the provider resurrecting / the cancel not sticking at Stripe.
    subStatus.sub_live_1 = "active";
    const settled = await planCancellationSettled("p1", { stripe });
    expect(settled.settled).toBe(false);
    expect(settled.reason).toMatch(/still reads active/i);
  });

  it("fails CLOSED when no Stripe client can verify the surviving reference", async () => {
    const stripe = makeStripe({ sub_live_1: "active" });
    await cancelPlanBilling(stripe, "p1");
    const settled = await planCancellationSettled("p1", {});
    expect(settled.settled).toBe(false);
    expect(settled.reason).toMatch(/could not be verified/i);
  });

  it("a >72h PAID visit's refund case does NOT settle until the refund actually posted", async () => {
    const stripe = makeStripe({ sub_live_1: "active" });
    jobs.set("j1", {
      id: "j1",
      servicePlanId: "p1",
      customerId: "c1",
      status: "SCHEDULED",
      scheduledDate: "2026-10-14", // far out — full refund owed
      paidAt: "2026-07-01T00:00:00Z",
    });
    invoices.set("i1", {
      id: "i1",
      jobId: "j1",
      servicePlanId: "p1",
      status: "PAID",
      amountCents: 12000,
      refundedAmountCents: 0,
      paidAt: "2026-07-01T00:00:00Z",
      issuedAt: "2026-07-01T00:00:00Z",
    });

    const result = await cancelPlanBilling(stripe, "p1");
    // The visit is canceled with the REFUND_OWED disposition stamped —
    // invisible to the schedule check, but not to settlement.
    expect(jobs.get("j1")).toMatchObject({
      status: "CANCELED",
      cancelDisposition: "REFUND_OWED",
    });
    expect(result.queuedVisits.refundsOwed).toHaveLength(1);

    let settled = await planCancellationSettled("p1", { stripe });
    expect(settled.settled).toBe(false);
    expect(settled.reason).toMatch(/no full refund/i);

    // Finance issues the exact full refund → now it settles.
    invoices.set("i1", {
      ...invoices.get("i1")!,
      status: "REFUNDED",
      refundedAmountCents: 12000,
    });
    settled = await planCancellationSettled("p1", { stripe });
    expect(settled.settled).toBe(true);
  });

  it("a ≤72h retained visit settles on its RECORDED disposition, not on a refund", async () => {
    const stripe = makeStripe({ sub_live_1: "active" });
    const soon = new Date(Date.now() + 24 * 3600_000).toISOString().slice(0, 10);
    jobs.set("j1", {
      id: "j1",
      servicePlanId: "p1",
      customerId: "c1",
      status: "SCHEDULED",
      scheduledDate: soon,
      paidAt: "2026-07-01T00:00:00Z",
    });
    invoices.set("i1", {
      id: "i1",
      jobId: "j1",
      servicePlanId: "p1",
      status: "PAID",
      amountCents: 9000,
      refundedAmountCents: 0,
      paidAt: "2026-07-01T00:00:00Z",
      issuedAt: "2026-07-01T00:00:00Z",
    });
    await cancelPlanBilling(stripe, "p1");
    expect(jobs.get("j1")).toMatchObject({ cancelDisposition: "FEE_RETAINED" });
    const settled = await planCancellationSettled("p1", { stripe });
    expect(settled.settled).toBe(true);
  });

  it("an IN_PROGRESS visit blocks settlement until its final outcome exists", async () => {
    const stripe = makeStripe({ sub_live_1: "active" });
    jobs.set("j1", {
      id: "j1",
      servicePlanId: "p1",
      customerId: "c1",
      status: "IN_PROGRESS",
      scheduledDate: "2026-07-19",
    });
    await cancelPlanBilling(stripe, "p1");
    const settled = await planCancellationSettled("p1", { stripe });
    expect(settled.settled).toBe(false);
    expect(settled.reason).toMatch(/on site/i);
  });

  it("provider-accepted (SENT) is NOT customer delivery; DELIVERED or a recorded alternate is", async () => {
    const stripe = makeStripe({ sub_live_1: "active" });
    await cancelPlanBilling(stripe, "p1");
    emailLogs.set("n1", {
      id: "n1",
      relatedId: "p1",
      template: "plan-canceled",
      deliveryStatus: "SENT",
      createdAt: new Date().toISOString(),
    });
    let settled = await planCancellationSettled("p1", { stripe });
    expect(settled.settled).toBe(false);
    expect(settled.reason).toMatch(/not yet DELIVERED/i);

    emailLogs.set("n1", {
      ...emailLogs.get("n1")!,
      deliveryStatus: "ALTERNATE_DELIVERED",
    });
    settled = await planCancellationSettled("p1", { stripe });
    expect(settled.settled).toBe(true);
  });

  it("a notice-history READ FAILURE fails CLOSED, never open", async () => {
    const stripe = makeStripe({ sub_live_1: "active" });
    await cancelPlanBilling(stripe, "p1");
    const orig = fakeDataClient.models.EmailLog.listEmailLogByRelatedId;
    (fakeDataClient.models.EmailLog as Row).listEmailLogByRelatedId = async () => {
      throw new Error("throttled");
    };
    try {
      const settled = await planCancellationSettled("p1", { stripe });
      expect(settled.settled).toBe(false);
      expect(settled.reason).toMatch(/could not be read/i);
    } finally {
      (fakeDataClient.models.EmailLog as Row).listEmailLogByRelatedId = orig;
    }
  });
});
