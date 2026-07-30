import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _setLockStoreForTests, memoryLockStore } from "./atomicLock";
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
  timeWindow?: string | null;
  paidAt?: string | null;
  priceCents?: number | null;
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
const claims = new Map<string, Record<string, unknown>>();
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
    // Atomic durable command: create fails (returns null) if the id already
    // exists — the single-winner guard (R5). Amplify stamps createdAt, so the
    // fake does too, which the orphan-reclaim age check relies on.
    PlanCancellationClaim: {
      create: async (input: { id: string } & Record<string, unknown>) => {
        if (claims.has(input.id)) return { data: null };
        claims.set(input.id, {
          createdAt: new Date().toISOString(),
          ...input,
        });
        return { data: claims.get(input.id) };
      },
      get: async ({ id }: { id: string }) => ({ data: claims.get(id) ?? null }),
      update: async (patch: { id: string } & Record<string, unknown>) => {
        const row = claims.get(patch.id) ?? { id: patch.id };
        Object.assign(row, patch);
        claims.set(patch.id, row);
        return { data: row };
      },
      delete: async ({ id }: { id: string }) => {
        const existed = claims.get(id) ?? null;
        claims.delete(id);
        return { data: existed };
      },
      list: async () => ({ data: [...claims.values()], nextToken: null }),
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
const resolveOwnedWork = vi.fn(async () => true);
vi.mock("./ownedWork", () => ({
  openOwnedWork: (...a: unknown[]) =>
    (openOwnedWork as unknown as (...x: unknown[]) => Promise<string | null>)(...a),
  resolveOwnedWork: (...a: unknown[]) =>
    (resolveOwnedWork as unknown as (...x: unknown[]) => Promise<boolean>)(...a),
}));

// The Stripe engine is exercised by subscription.test.ts. Here we control its
// outcome so the wrapper's success/pending behavior is what's under test.
const cancelPlanBilling = vi.fn();
const cancelQueuedPlanVisits = vi.fn(
  async (): Promise<QueuedVisitsResolution> => ({
    canceled: [],
    needsDecision: [],
    failed: [],
    refundsOwed: [],
    retained: [],
  })
);
vi.mock("./subscription", () => ({
  cancelPlanBilling: (...a: unknown[]) =>
    (cancelPlanBilling as unknown as (...x: unknown[]) => unknown)(...a),
  cancelQueuedPlanVisits: (...a: unknown[]) =>
    (cancelQueuedPlanVisits as unknown as (...x: unknown[]) => unknown)(...a),
}));

const {
  buildCancellationPreview,
  cancelPlanForCustomer,
  resumePlanCancellation,
  planCancellationSettled,
} = await import("./planCancellation");

// The settlement check proves the provider record: this fake's subscription
// reads canceled (the engine's job), so a completed drive can settle.
const stripe = {
  subscriptions: { retrieve: async () => ({ status: "canceled" }) },
} as unknown as Stripe;

const resolution = (
  over: Partial<QueuedVisitsResolution> = {}
): QueuedVisitsResolution => ({
  canceled: [],
  needsDecision: [],
  failed: [],
  ...over,
});

beforeEach(() => {
  _setLockStoreForTests(memoryLockStore({ PlanCancellationClaim: claims }));
  plans.clear();
  jobs.clear();
  invoices.clear();
  claims.clear();
  customers.clear();
  notifyOffice.mockClear();
  sendEmail.mockClear();
  openOwnedWork.mockClear();
  resolveOwnedWork.mockClear();
  cancelPlanBilling.mockReset();
  // Like the real engine: Stripe stopped AND the CRM plan flipped CANCELED —
  // settlement legitimately reads done after a clean drive.
  cancelPlanBilling.mockImplementation(async (_s: unknown, id: string) => {
    plans.set(id, { ...plans.get(id)!, status: "CANCELED" });
    return { stripeSubscriptionCanceled: true, queuedVisits: resolution() };
  });
  cancelQueuedPlanVisits.mockClear();
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

  it("a paid visit >72h out: STOPS, with the exact full-refund outcome named", async () => {
    // GL-08 R6: no keep-or-refund choice — the preview states the server's
    // 72-hour result. The date is computed FROM NOW, like its ≤72h sibling: a
    // hard-coded one silently rots into the 72-hour window as the real calendar
    // advances past it, turning a policy assertion into a wall-clock flake.
    const farOut = new Date(Date.now() + 30 * 24 * 3600_000)
      .toISOString()
      .slice(0, 10);
    jobs.set("j1", {
      id: "j1",
      servicePlanId: "p1",
      status: "SCHEDULED",
      scheduledDate: farOut,
      paidAt: "2026-07-01T00:00:00Z",
      priceCents: 12000,
    });
    const p = await buildCancellationPreview("p1");
    expect(p.visitsStopping).toBe(1);
    expect(p.queuedVisits[0].disposition).toBe("STOPS");
    expect(p.queuedVisits[0].reason).toMatch(/refunded in full/i);
    expect(p.queuedVisits[0].reason).toContain("$120.00");
    expect(p.queuedVisits[0].reason).not.toMatch(/your choice|credit/i);
  });

  it("a paid visit ≤72h out: STOPS, and the retained payment is named — never credit", async () => {
    const soon = new Date(Date.now() + 24 * 3600_000).toISOString().slice(0, 10);
    jobs.set("j1", {
      id: "j1",
      servicePlanId: "p1",
      status: "SCHEDULED",
      scheduledDate: soon,
      paidAt: "2026-07-01T00:00:00Z",
      priceCents: 12000,
    });
    const p = await buildCancellationPreview("p1");
    expect(p.queuedVisits[0].disposition).toBe("STOPS");
    expect(p.queuedVisits[0].reason).toMatch(/isn't refunded/i);
    expect(p.queuedVisits[0].reason).not.toMatch(/credit/i);
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
    // The money copy never promises a refund it isn't giving, and never credit.
    expect(p.refundOutcome.amountCents).toBe(0);
    expect(p.refundOutcome.description).toMatch(/never issue account credit/i);
  });

  it("outstanding balance is NET of refunds — a partially refunded bill owes its remainder", async () => {
    invoices.set("i1", {
      id: "i1",
      servicePlanId: "p1",
      customerId: "c1",
      amountCents: 4500,
      status: "OPEN",
      refundedAmountCents: 1500,
    } as never);
    const p = await buildCancellationPreview("p1");
    expect(p.outstandingBalanceCents).toBe(3000);
  });

  it("a canceled plan reads as already resolved and offers no save offer", async () => {
    plans.set("p1", { ...plans.get("p1")!, status: "CANCELED" });
    const p = await buildCancellationPreview("p1");
    expect(p.alreadyResolved).toBe(true);
    expect(p.saveOfferAvailable).toBe(false);
  });

  // GL-08: the preview is HOUR-EXACT so it agrees with the dispositive cancel
  // and the office path. Visit Monday 2026-07-20, morning window → 8:00 AM ET
  // start, so the 72-hour line is Friday 8:00 AM ET — a boundary the old
  // whole-day rule (Mon − Fri = 3 days) could never resolve as refundable.
  describe("hour-exact 72-hour preview", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    const seedPaidMondayVisit = () => {
      jobs.set("j1", {
        id: "j1",
        servicePlanId: "p1",
        status: "SCHEDULED",
        scheduledDate: "2026-07-20",
        timeWindow: "morning (8am–12pm)",
        paidAt: "2026-07-01T00:00:00Z",
        priceCents: 12000,
      });
    };

    it("names a full refund at 73 hours out (Friday 7am)", async () => {
      seedPaidMondayVisit();
      vi.setSystemTime(new Date("2026-07-17T07:00:00-04:00")); // 73h before Mon 8am

      const p = await buildCancellationPreview("p1");

      expect(p.queuedVisits[0].reason).toMatch(/refunded in full/i);
      expect(p.queuedVisits[0].reason).toContain("$120.00");
    });

    it("names the retained payment at 71 hours out (Friday 9am)", async () => {
      seedPaidMondayVisit();
      vi.setSystemTime(new Date("2026-07-17T09:00:00-04:00")); // 71h before Mon 8am

      const p = await buildCancellationPreview("p1");

      expect(p.queuedVisits[0].reason).toMatch(/isn't refunded/i);
      expect(p.queuedVisits[0].reason).not.toMatch(/credit/i);
    });
  });
});

describe("cancelPlanForCustomer — success", () => {
  it("cancels, stamps the reason, clears pending, and emails a durable confirmation", async () => {
    cancelPlanBilling.mockImplementation(async (_s: unknown, id: string) => {
      plans.set(id, { ...plans.get(id)!, status: "CANCELED" });
      return {
        stripeSubscriptionCanceled: true,
        queuedVisits: resolution({ canceled: [{ jobId: "j1", scheduledDate: null }] }),
      };
    });
    const out = await cancelPlanForCustomer(stripe, "p1", { reason: "Moving away" });
    expect(out.status).toBe("CANCELED");
    if (out.status !== "CANCELED") throw new Error("unreachable");
    expect(out.visitsStopped).toBe(1);
    expect(out.confirmationEmailed).toBe(true);
    expect(out.settled).toBe(true);
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

  it("a paid canceled visit is named in the email with its exact 72-hour outcome", async () => {
    cancelPlanBilling.mockImplementation(async (_s: unknown, id: string) => {
      plans.set(id, { ...plans.get(id)!, status: "CANCELED" });
      return {
        stripeSubscriptionCanceled: true,
        queuedVisits: resolution({
          canceled: [
            { jobId: "j1", scheduledDate: "2026-08-01" },
            { jobId: "j2", scheduledDate: "2026-07-20" },
          ],
          refundsOwed: [
            { jobId: "j1", scheduledDate: "2026-08-01", amountCents: 12000 },
          ],
          retained: [
            { jobId: "j2", scheduledDate: "2026-07-20", amountCents: 9000 },
          ],
        }),
      };
    });
    const out = await cancelPlanForCustomer(stripe, "p1", {});
    expect(out.status).toBe("CANCELED");
    if (out.status !== "CANCELED") throw new Error("unreachable");
    const firstCall = sendEmail.mock.calls[0] as unknown as [{ html: string }];
    // GL-08 R6: the exact server outcome per visit — never a choice, never credit.
    expect(firstCall[0].html).toContain("August 1, 2026");
    expect(firstCall[0].html).toMatch(/\$120\.00.*refunded in full/i);
    expect(firstCall[0].html).toMatch(/\$90\.00 already paid isn't refunded/i);
    expect(firstCall[0].html).not.toMatch(/keep it or refund it|your choice|credit/i);
    expect(out.message).toMatch(/refunded in full/i);
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
  it("does not show canceled: keeps the durable command, opens the FINANCE recovery case, pages the office", async () => {
    cancelPlanBilling.mockRejectedValue(new Error("Stripe is down"));
    const out = await cancelPlanForCustomer(stripe, "p1", { reason: "Too pricey" });

    expect(out.status).toBe("PENDING");
    if (out.status !== "PENDING") throw new Error("unreachable");
    // GL-08 R1: truthful pending copy — the plan is still active, a charge that
    // posts gets refunded. It must NOT falsely promise "won't be charged again".
    expect(out.message).toMatch(/still active/i);
    expect(out.message).toMatch(/refund it/i);
    expect(out.message).not.toMatch(/won't be charged again/i);

    // The plan is still ACTIVE — the customer is not told a false "canceled".
    expect(plans.get("p1")?.status).toBe("ACTIVE");
    expect(plans.get("p1")?.cancellationPending).toBe(true);
    expect(plans.get("p1")?.cancellationReason).toBe("Too pricey");

    // R4: a purpose-built cancellation-recovery case (never generic PORTAL_FAILURE).
    expect(openOwnedWork).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "PLAN_CANCELLATION_RECOVERY",
        ownerTeam: "FINANCE",
        dedupeKey: "p1",
      })
    );
    expect(notifyOffice).toHaveBeenCalledOnce();
    // No false confirmation email on a failed cancel.
    expect(sendEmail).not.toHaveBeenCalled();
    // R1: the command is NOT deleted — it is the durable anchor the sweep resumes,
    // stamped with the error, an attempt count, and a next-attempt time.
    expect(claims.has("p1")).toBe(true);
    const cmd = claims.get("p1")!;
    expect(cmd.lastError).toMatch(/stripe is down/i);
    expect(cmd.attemptCount).toBe(1);
    expect(cmd.nextAttemptAt).toBeTruthy();
    expect(cmd.recoveryWorkItemId).toBe("work-1");
  });
});

describe("cancelPlanForCustomer — GL-08 durability & honesty", () => {
  it("a concurrent click that loses the claim to a LIVE attempt returns PENDING, not a second cancel", async () => {
    // A live in-flight cancel holds a fresh claim (created just now).
    claims.set("p1", { id: "p1", createdAt: new Date().toISOString() });
    const out = await cancelPlanForCustomer(stripe, "p1", {});
    expect(out.status).toBe("PENDING");
    // No second Stripe cancel and no second confirmation email fired.
    expect(cancelPlanBilling).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("reclaims an ORPHANED command (a dead prior attempt) and finishes the cancel", async () => {
    // A stale claim left by a process that died mid-cancel — old enough to steal.
    claims.set("p1", {
      id: "p1",
      createdAt: new Date(Date.now() - 60 * 60_000).toISOString(),
      attemptCount: 1,
    });
    const out = await cancelPlanForCustomer(stripe, "p1", {});
    // The customer's own retry finishes it rather than wedging on the stale claim.
    expect(out.status).toBe("CANCELED");
    expect(cancelPlanBilling).toHaveBeenCalledOnce();
    expect(claims.get("p1")).toMatchObject({ stage: "COMPLETE" });
  });

  it("persists the settled command as the readable outcome — never deleted", async () => {
    const out = await cancelPlanForCustomer(stripe, "p1", {});
    expect(out.status).toBe("CANCELED");
    // GL-08 R5: the row IS the persisted terminal result.
    const cmd = claims.get("p1")!;
    expect(cmd.stage).toBe("COMPLETE");
    expect(cmd.outcome).toBe("COMPLETE");
    expect(String(cmd.resultJson)).toMatch(/settled/);
    // And a later duplicate is a no-op, not a wedge.
    const again = await cancelPlanForCustomer(stripe, "p1", {});
    expect(again.status).toBe("CANCELED");
    if (again.status !== "CANCELED") throw new Error("unreachable");
    expect(again.alreadyCanceled).toBe(true);
  });

  it("stays OPEN (AWAITING_SETTLEMENT) when settlement cannot be proved, with an owned case", async () => {
    // The provider still reports the subscription active — canceled in CRM
    // but NOT settled; the command must not read complete.
    const liveStripe = {
      subscriptions: { retrieve: async () => ({ status: "active" }) },
    } as unknown as Stripe;
    const out = await cancelPlanForCustomer(liveStripe, "p1", {});
    expect(out.status).toBe("CANCELED");
    if (out.status !== "CANCELED") throw new Error("unreachable");
    expect(out.settled).toBe(false);
    expect(claims.get("p1")).toMatchObject({ stage: "AWAITING_SETTLEMENT" });
    expect(openOwnedWork).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "PLAN_CANCELLATION_RECOVERY" })
    );
  });

  it("says visits stopped only when none failed to come off (R2)", async () => {
    cancelPlanBilling.mockImplementation(async (_s: unknown, id: string) => {
      plans.set(id, { ...plans.get(id)!, status: "CANCELED" });
      return {
        stripeSubscriptionCanceled: true,
        queuedVisits: resolution({
          canceled: [{ jobId: "j1", scheduledDate: null }],
          failed: [{ jobId: "j2", scheduledDate: "2026-08-01" }],
        }),
      };
    });
    const out = await cancelPlanForCustomer(stripe, "p1", {});
    if (out.status !== "CANCELED") throw new Error("unreachable");
    expect(out.message).not.toMatch(/your recurring visits have stopped\./i);
    expect(out.message).toMatch(/still need our team/i);
    expect(out.visitsRemaining).toBe(1);
  });

  it("claims 'emailed' only when the confirmation actually sent (R6)", async () => {
    customers.set("c1", { id: "c1", displayName: "Dana Whitlock", email: null });
    const out = await cancelPlanForCustomer(stripe, "p1", {});
    if (out.status !== "CANCELED") throw new Error("unreachable");
    expect(out.confirmationEmailed).toBe(false);
    expect(out.message).not.toMatch(/emailed/i);
  });
});

describe("resumePlanCancellation (GL-08 R1)", () => {
  it("drives a stuck command to completion — the customer never has to retry", async () => {
    // A command left behind by a failed attempt; the plan is still ACTIVE.
    claims.set("p1", {
      id: "p1",
      createdAt: new Date().toISOString(),
      stage: "FAILED",
      attemptCount: 1,
      customerId: "c1",
    });
    const out = await resumePlanCancellation(stripe, "p1", { auto: true });
    expect(out.status).toBe("CANCELED");
    expect(cancelPlanBilling).toHaveBeenCalledOnce();
    // The command persists as the readable terminal outcome.
    expect(claims.get("p1")).toMatchObject({ stage: "COMPLETE" });
  });

  it("auto-resume respects the next-attempt time (paces itself)", async () => {
    claims.set("p1", {
      id: "p1",
      createdAt: new Date().toISOString(),
      stage: "FAILED",
      attemptCount: 1,
      nextAttemptAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
    const out = await resumePlanCancellation(stripe, "p1", { auto: true });
    expect(out.status).toBe("PENDING");
    // Not yet due — no Stripe cancel this pass.
    expect(cancelPlanBilling).not.toHaveBeenCalled();
  });

  it("an already-canceled plan is cleaned up and the case resolved when settled", async () => {
    plans.set("p1", {
      ...plans.get("p1")!,
      status: "CANCELED",
      cancellationPending: true,
    });
    claims.set("p1", { id: "p1", createdAt: new Date().toISOString() });
    const out = await resumePlanCancellation(stripe, "p1", { auto: true });
    expect(out.status).toBe("CANCELED");
    expect(plans.get("p1")?.cancellationPending).toBe(false);
    expect(cancelPlanBilling).not.toHaveBeenCalled();
    expect(claims.get("p1")).toMatchObject({ stage: "COMPLETE" });
    expect(resolveOwnedWork).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "PLAN_CANCELLATION_RECOVERY" })
    );
  });

  it("GL-08 R2: a CANCELED-but-unsettled plan is REPAIRED, never short-circuited", async () => {
    // Canceled in CRM, but a residual visit sweep + notice never ran (killed
    // mid-drive). Resume must repair — sweep the visits, send the notice —
    // not report already-canceled.
    plans.set("p1", {
      ...plans.get("p1")!,
      status: "CANCELED",
      cancellationPending: true,
    });
    jobs.set("j1", { id: "j1", servicePlanId: "p1", status: "SCHEDULED" });
    claims.set("p1", {
      id: "p1",
      createdAt: new Date(Date.now() - 60 * 60_000).toISOString(),
      stage: "FAILED",
      attemptCount: 1,
    });
    cancelQueuedPlanVisits.mockImplementationOnce(async () => {
      jobs.set("j1", { ...jobs.get("j1")!, status: "CANCELED" });
      return {
        canceled: [{ jobId: "j1", scheduledDate: null }],
        needsDecision: [],
        failed: [],
        refundsOwed: [],
        retained: [],
      };
    });
    const out = await resumePlanCancellation(stripe, "p1", { auto: true });
    expect(out.status).toBe("CANCELED");
    expect(cancelQueuedPlanVisits).toHaveBeenCalledOnce();
    // The residual visit came off and the customer got the confirmation.
    expect(sendEmail).toHaveBeenCalledOnce();
    expect(claims.get("p1")).toMatchObject({ stage: "COMPLETE" });
  });
});

describe("planCancellationSettled (GL-08 R4 verifier / auto-resolve gate)", () => {
  it("is not settled while the plan is still active", async () => {
    const s = await planCancellationSettled("p1");
    expect(s.settled).toBe(false);
    expect(s.reason).toMatch(/isn't canceled yet/i);
  });

  it("is not settled while a cancelable visit is still on the schedule", async () => {
    plans.set("p1", { ...plans.get("p1")!, status: "CANCELED" });
    jobs.set("j1", { id: "j1", servicePlanId: "p1", status: "SCHEDULED" });
    const s = await planCancellationSettled("p1", { stripe });
    expect(s.settled).toBe(false);
    expect(s.reason).toMatch(/come off the schedule/i);
  });

  it("fails CLOSED when the provider record can't be verified (no Stripe client)", async () => {
    plans.set("p1", { ...plans.get("p1")!, status: "CANCELED" });
    const s = await planCancellationSettled("p1");
    expect(s.settled).toBe(false);
    expect(s.reason).toMatch(/could not be verified/i);
  });

  it("is not settled while the PROVIDER subscription still reads active", async () => {
    plans.set("p1", { ...plans.get("p1")!, status: "CANCELED" });
    const liveStripe = {
      subscriptions: { retrieve: async () => ({ status: "active" }) },
    } as unknown as Stripe;
    const s = await planCancellationSettled("p1", { stripe: liveStripe });
    expect(s.settled).toBe(false);
    expect(s.reason).toMatch(/still reads active/i);
  });

  it("is not settled while a charge posted after the request is unrefunded", async () => {
    plans.set("p1", {
      ...plans.get("p1")!,
      status: "CANCELED",
      cancellationRequestedAt: "2026-07-01T00:00:00Z",
    });
    invoices.set("i1", {
      id: "i1",
      servicePlanId: "p1",
      customerId: "c1",
      amountCents: 4500,
      status: "PAID",
      issuedAt: "2026-07-05T00:00:00Z",
      refundedAmountCents: 0,
    } as never);
    const s = await planCancellationSettled("p1", { stripe });
    expect(s.settled).toBe(false);
    expect(s.reason).toMatch(/refunded in full/i);
  });

  it("a PARTIAL refund does not settle a post-cancellation charge", async () => {
    plans.set("p1", {
      ...plans.get("p1")!,
      status: "CANCELED",
      cancellationRequestedAt: "2026-07-01T00:00:00Z",
    });
    invoices.set("i1", {
      id: "i1",
      servicePlanId: "p1",
      customerId: "c1",
      amountCents: 4500,
      status: "PAID",
      issuedAt: "2026-07-05T00:00:00Z",
      refundedAmountCents: 100,
    } as never);
    const s = await planCancellationSettled("p1", { stripe });
    expect(s.settled).toBe(false);
    expect(s.reason).toMatch(/refunded in full/i);
  });

  it("judges the late-charge window by PAYMENT time, not invoice creation", async () => {
    // Created before the request, PAID after — a classic pending bank debit.
    plans.set("p1", {
      ...plans.get("p1")!,
      status: "CANCELED",
      cancellationRequestedAt: "2026-07-01T00:00:00Z",
    });
    invoices.set("i1", {
      id: "i1",
      servicePlanId: "p1",
      customerId: "c1",
      amountCents: 4500,
      status: "PAID",
      issuedAt: "2026-06-25T00:00:00Z",
      paidAt: "2026-07-03T00:00:00Z",
      refundedAmountCents: 0,
    } as never);
    const s = await planCancellationSettled("p1", { stripe });
    expect(s.settled).toBe(false);
    expect(s.reason).toMatch(/refunded in full/i);
  });

  it("is settled when canceled, cleared, no live charge, and any late charge refunded", async () => {
    plans.set("p1", {
      ...plans.get("p1")!,
      status: "CANCELED",
      cancellationPending: false,
      cancellationRequestedAt: "2026-07-01T00:00:00Z",
    });
    invoices.set("i1", {
      id: "i1",
      servicePlanId: "p1",
      customerId: "c1",
      amountCents: 4500,
      status: "REFUNDED",
      issuedAt: "2026-07-05T00:00:00Z",
      refundedAmountCents: 4500,
    } as never);
    const s = await planCancellationSettled("p1", { stripe });
    expect(s.settled).toBe(true);
  });
});
