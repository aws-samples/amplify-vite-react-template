import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import type { QueuedVisitsResolution } from "./subscription";

/**
 * GL-08 — customer self-service plan cancellation.
 *
 * The preview must tell the truth before the customer commits (effective date,
 * money, queued visits, a paid visit that remains, coverage that ends), the
 * cancel must fail SAFE (a Stripe outage becomes a visible pending state and an
 * owned exception, never a false "canceled"), and a duplicate confirm must not
 * charge or cancel twice.
 */

type Plan = {
  id: string;
  customerId: string;
  planName: string;
  priceCents: number;
  serviceFrequency: string;
  status: string;
  stripeSubscriptionId?: string | null;
  cancellationPending?: boolean | null;
  cancellationRequestedAt?: string | null;
  cancellationReason?: string | null;
};

type Job = {
  id: string;
  servicePlanId: string;
  status: string;
  scheduledDate?: string | null;
  paidAt?: string | null;
};

type Invoice = {
  id: string;
  servicePlanId?: string | null;
  customerId: string;
  amountCents: number;
  status: string;
};

const plans = new Map<string, Plan>();
const jobs = new Map<string, Job>();
const invoices = new Map<string, Invoice>();
const customers = new Map<
  string,
  { id: string; displayName: string; email?: string | null }
>();

const fakeDataClient = {
  models: {
    ServicePlan: {
      get: async ({ id }: { id: string }) => ({ data: plans.get(id) ?? null }),
      update: async (patch: Partial<Plan> & { id: string }) => {
        plans.set(patch.id, { ...plans.get(patch.id)!, ...patch });
        return { data: plans.get(patch.id) };
      },
    },
    Job: {
      listJobByServicePlanId: async ({
        servicePlanId,
      }: {
        servicePlanId: string;
      }) => ({
        data: [...jobs.values()].filter((j) => j.servicePlanId === servicePlanId),
        nextToken: null,
      }),
    },
    Invoice: {
      list: async ({
        filter,
      }: {
        filter?: {
          servicePlanId?: { eq: string };
          or?: { status: { eq: string } }[];
        };
      }) => {
        const planId = filter?.servicePlanId?.eq;
        const statuses = (filter?.or ?? []).map((c) => c.status.eq);
        return {
          data: [...invoices.values()].filter(
            (inv) =>
              inv.servicePlanId === planId &&
              (statuses.length === 0 || statuses.includes(inv.status))
          ),
          nextToken: null,
        };
      },
    },
    Customer: {
      get: async ({ id }: { id: string }) => ({ data: customers.get(id) ?? null }),
    },
  },
};

vi.mock("./dataClient", () => ({
  dataClient: async () => fakeDataClient,
}));

const notifyOffice = vi.fn(async () => true);
const sendEmail = vi.fn(async () => true);
vi.mock("./email", () => ({
  notifyOffice: (...a: unknown[]) =>
    (notifyOffice as unknown as (...x: unknown[]) => Promise<boolean>)(...a),
  sendEmail: (...a: unknown[]) =>
    (sendEmail as unknown as (...x: unknown[]) => Promise<boolean>)(...a),
  emailShell: (_heading: string, body: string) => body,
}));

const openOwnedWork = vi.fn(async () => "work-1");
vi.mock("./ownedWork", () => ({
  openOwnedWork: (...a: unknown[]) =>
    (openOwnedWork as unknown as (...x: unknown[]) => Promise<string | null>)(...a),
}));

// The Stripe engine is exercised by subscription.test.ts. Here we control its
// outcome so the wrapper's success/pending behavior is what's under test.
const cancelPlanBilling = vi.fn();
vi.mock("./subscription", () => ({
  cancelPlanBilling: (...a: unknown[]) =>
    (cancelPlanBilling as unknown as (...x: unknown[]) => unknown)(...a),
}));

const { buildCancellationPreview, cancelPlanForCustomer } = await import(
  "./planCancellation"
);

const stripe = {} as Stripe;

const resolution = (
  over: Partial<QueuedVisitsResolution> = {}
): QueuedVisitsResolution => ({
  canceled: [],
  needsDecision: [],
  failed: [],
  ...over,
});

beforeEach(() => {
  plans.clear();
  jobs.clear();
  invoices.clear();
  customers.clear();
  notifyOffice.mockClear();
  sendEmail.mockClear();
  openOwnedWork.mockClear();
  cancelPlanBilling.mockReset();
  cancelPlanBilling.mockResolvedValue({
    stripeSubscriptionCanceled: true,
    queuedVisits: resolution(),
  });
  customers.set("c1", {
    id: "c1",
    displayName: "Dana Whitlock",
    email: "dana@example.com",
  });
  plans.set("p1", {
    id: "p1",
    customerId: "c1",
    planName: "Quarterly Pest Plan",
    priceCents: 4500,
    serviceFrequency: "QUARTERLY",
    status: "ACTIVE",
    stripeSubscriptionId: "sub_1",
  });
});

describe("buildCancellationPreview", () => {
  it("no queued visit: nothing to stop, no paid visit, no balance", async () => {
    const p = await buildCancellationPreview("p1");
    expect(p.visitsStopping).toBe(0);
    expect(p.queuedVisits).toHaveLength(0);
    expect(p.paidVisitRemains).toBe(false);
    expect(p.outstandingBalanceCents).toBe(0);
    expect(p.saveOfferAvailable).toBe(true);
    expect(p.alreadyResolved).toBe(false);
  });

  it("queued unpaid visit: reported as STOPS and counted", async () => {
    jobs.set("j1", {
      id: "j1",
      servicePlanId: "p1",
      status: "SCHEDULED",
      scheduledDate: "2026-08-01",
    });
    const p = await buildCancellationPreview("p1");
    expect(p.visitsStopping).toBe(1);
    expect(p.queuedVisits[0].disposition).toBe("STOPS");
    expect(p.paidVisitRemains).toBe(false);
  });

  it("already-paid queued visit: REMAINS, and paidVisitRemains is flagged", async () => {
    jobs.set("j1", {
      id: "j1",
      servicePlanId: "p1",
      status: "SCHEDULED",
      scheduledDate: "2026-08-01",
      paidAt: "2026-07-01T00:00:00Z",
    });
    const p = await buildCancellationPreview("p1");
    expect(p.visitsStopping).toBe(0);
    expect(p.paidVisitRemains).toBe(true);
    expect(p.queuedVisits[0].disposition).toBe("REMAINS");
  });

  it("open + failed invoices: outstanding balance is summed and surfaced honestly", async () => {
    invoices.set("i1", {
      id: "i1",
      servicePlanId: "p1",
      customerId: "c1",
      amountCents: 4500,
      status: "OPEN",
    });
    invoices.set("i2", {
      id: "i2",
      servicePlanId: "p1",
      customerId: "c1",
      amountCents: 4500,
      status: "FAILED",
    });
    invoices.set("i3", {
      id: "i3",
      servicePlanId: "p1",
      customerId: "c1",
      amountCents: 9900,
      status: "PAID", // already settled — not outstanding
    });
    const p = await buildCancellationPreview("p1");
    expect(p.outstandingBalanceCents).toBe(9000);
    expect(p.finalCharge.description).toContain("$90.00");
    // The money copy never promises a refund it isn't giving.
    expect(p.refundOrCredit.amountCents).toBe(0);
  });

  it("a canceled plan reads as already resolved and offers no save offer", async () => {
    plans.set("p1", { ...plans.get("p1")!, status: "CANCELED" });
    const p = await buildCancellationPreview("p1");
    expect(p.alreadyResolved).toBe(true);
    expect(p.saveOfferAvailable).toBe(false);
  });
});

describe("cancelPlanForCustomer — success", () => {
  it("cancels, stamps the reason, clears pending, and emails a durable confirmation", async () => {
    cancelPlanBilling.mockResolvedValue({
      stripeSubscriptionCanceled: true,
      queuedVisits: resolution({ canceled: [{ jobId: "j1", scheduledDate: null }] }),
    });
    const out = await cancelPlanForCustomer(stripe, "p1", { reason: "Moving away" });
    expect(out.status).toBe("CANCELED");
    if (out.status !== "CANCELED") throw new Error("unreachable");
    expect(out.visitsStopped).toBe(1);
    expect(out.confirmationEmailed).toBe(true);
    expect(sendEmail).toHaveBeenCalledOnce();
    expect(plans.get("p1")?.cancellationReason).toBe("Moving away");
    expect(plans.get("p1")?.cancellationPending).toBe(false);
    expect(openOwnedWork).not.toHaveBeenCalled();
  });

  it("an empty reason never blocks the cancel", async () => {
    const out = await cancelPlanForCustomer(stripe, "p1", { reason: "   " });
    expect(out.status).toBe("CANCELED");
    expect(cancelPlanBilling).toHaveBeenCalledOnce();
  });

  it("a paid visit left on the schedule is named in the confirmation email", async () => {
    cancelPlanBilling.mockResolvedValue({
      stripeSubscriptionCanceled: true,
      queuedVisits: resolution({
        needsDecision: [
          { jobId: "j1", scheduledDate: "2026-08-01", why: "paid up front" },
        ],
      }),
    });
    const out = await cancelPlanForCustomer(stripe, "p1", {});
    expect(out.status).toBe("CANCELED");
    if (out.status !== "CANCELED") throw new Error("unreachable");
    expect(out.visitsRemaining).toBe(1);
    const firstCall = sendEmail.mock.calls[0] as unknown as [{ html: string }];
    expect(firstCall[0].html).toContain("2026-08-01");
  });

  it("no email on file: opens MISSING_CONTACT work instead of a silent gap", async () => {
    customers.set("c1", { id: "c1", displayName: "Dana Whitlock", email: null });
    const out = await cancelPlanForCustomer(stripe, "p1", {});
    expect(out.status).toBe("CANCELED");
    if (out.status !== "CANCELED") throw new Error("unreachable");
    expect(out.confirmationEmailed).toBe(false);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(openOwnedWork).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "MISSING_CONTACT" })
    );
  });
});

describe("cancelPlanForCustomer — duplicate clicks", () => {
  it("a second confirm on an already-canceled plan is an idempotent no-op", async () => {
    plans.set("p1", { ...plans.get("p1")!, status: "CANCELED" });
    const out = await cancelPlanForCustomer(stripe, "p1", {});
    expect(out.status).toBe("CANCELED");
    if (out.status !== "CANCELED") throw new Error("unreachable");
    expect(out.alreadyCanceled).toBe(true);
    expect(cancelPlanBilling).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe("cancelPlanForCustomer — provider/API failure", () => {
  it("does not show canceled: sets a pending flag, opens urgent owned work, pages the office", async () => {
    cancelPlanBilling.mockRejectedValue(new Error("Stripe is down"));
    const out = await cancelPlanForCustomer(stripe, "p1", { reason: "Too pricey" });

    expect(out.status).toBe("PENDING");
    if (out.status !== "PENDING") throw new Error("unreachable");
    expect(out.message).toMatch(/won't be charged again/i);

    // The plan is still ACTIVE — the customer is not told a false "canceled".
    expect(plans.get("p1")?.status).toBe("ACTIVE");
    expect(plans.get("p1")?.cancellationPending).toBe(true);
    expect(plans.get("p1")?.cancellationReason).toBe("Too pricey");

    expect(openOwnedWork).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "PORTAL_FAILURE",
        ownerTeam: "FINANCE",
        dedupeKey: "plan-cancel:p1",
      })
    );
    expect(notifyOffice).toHaveBeenCalledOnce();
    // No false confirmation email on a failed cancel.
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
