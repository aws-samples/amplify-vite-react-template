import { beforeEach, describe, expect, it, vi } from "vitest";
import { _setLockStoreForTests, memoryLockStore } from "./atomicLock";
import type Stripe from "stripe";

/**
 * Customer deactivation guarantees (GL-09). This is money + service + access in
 * one action, so the tests assert the promises, not the plumbing: every active
 * plan's billing is stopped, the remaining visits leave the schedule, the
 * balance is REPORTED and never charged, the portal login is ended BEFORE the
 * status flip (so INACTIVE never implies a live login), INACTIVE is set LAST and
 * read back, the transition is recorded, and any half-done step leaves the
 * customer ACTIVE with an owned, resumable recovery rather than a hidden
 * inconsistency. A single-winner claim serializes racing transitions.
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
/** The single-winner lifecycle claim store (id = customerId). */
const claims = new Map<string, Record<string, unknown>>();
const lifecycleCommands = new Map<string, Record<string, unknown>>();

/** Ordered log of the side effects, so we can prove the sequence:
 *  money → work → portal → INACTIVE(last). */
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
    // The lifecycle claim: create is conditional on the id not existing, exactly
    // like the real single-winner lock. A second create loses (data: null).
    CustomerLifecycleCommand: {
      create: async (input: { id: string } & Record<string, unknown>) => {
        if (lifecycleCommands.has(input.id)) return { data: null };
        lifecycleCommands.set(input.id, { ...input });
        return { data: { ...input } };
      },
      get: async ({ id }: { id: string }) => ({
        data: lifecycleCommands.get(id) ?? null,
      }),
      update: async (input: { id: string } & Record<string, unknown>) => {
        const row = lifecycleCommands.get(input.id);
        if (!row) return { data: null };
        for (const [k, v] of Object.entries(input)) {
          if (v !== undefined) row[k] = v;
        }
        return { data: { ...row } };
      },
      listCustomerLifecycleCommandByCustomerIdAndRequestedAt: async ({
        customerId,
      }: {
        customerId: string;
      }) => ({
        data: [...lifecycleCommands.values()].filter(
          (c) => c.customerId === customerId
        ),
        nextToken: null,
      }),
    },
    CustomerLifecycleClaim: {
      get: async ({ id }: { id: string }) => ({ data: claims.get(id) ?? null }),
      create: async (input: { id: string }) => {
        if (claims.has(input.id)) return { data: null };
        claims.set(input.id, { ...input });
        events.push(`claim:acquire:${input.id}`);
        return { data: { ...input } };
      },
      delete: async ({ id }: { id: string }) => {
        claims.delete(id);
        events.push(`claim:release:${id}`);
        return { data: { id } };
      },
    },
  },
};

vi.mock("./dataClient", () => ({ dataClient: async () => fakeDataClient }));

const notifyOffice = vi.fn(async () => true);
vi.mock("./email", () => ({
  notifyOffice: (...a: unknown[]) =>
    (notifyOffice as unknown as (...x: unknown[]) => Promise<boolean>)(...a),
  sendEmail: vi.fn(async () => true),
  emailShell: (h: string, b: string) => `${h}${b}`,
}));

const openOwnedWork = vi.fn(async () => "work-1");
vi.mock("./ownedWork", () => ({
  openOwnedWork: (...a: unknown[]) =>
    (openOwnedWork as unknown as (...x: unknown[]) => Promise<string>)(...a),
  openMissingContactWork: vi.fn(async () => "work-mc"),
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

const recordCustomerLifecycleEvent = vi.fn(async () => ({ recorded: true }));
vi.mock("./lifecycleLog", () => ({
  recordCustomerLifecycleEvent: (...a: unknown[]) =>
    (
      recordCustomerLifecycleEvent as unknown as (
        ...x: unknown[]
      ) => Promise<{ recorded: boolean }>
    )(...a),
}));

const { deactivateCustomer } = await import("./deactivation");

/** A Stripe stub that would record a charge if one were ever attempted. */
const paymentIntentsCreate = vi.fn(async () => ({ id: "pi", status: "succeeded" }));
const stripe = {
  paymentIntents: { create: paymentIntentsCreate },
} as unknown as Stripe;

const actor = { sub: "fin-1", email: "finance@buzzkill.com" };

/** The injected Cognito revoke; records its ordering in the event log. */
const revokePortal = vi.fn(async () => {
  events.push("portal:revoke");
  return { revoked: true };
});

/** Default options a real caller passes: a controlled reason + the portal hook. */
const opts = () => ({ reason: "CUSTOMER_REQUEST", revokePortalAccess: revokePortal });

beforeEach(() => {
  lifecycleCommands.clear();
  _setLockStoreForTests(
    memoryLockStore({
      CustomerLifecycleCommand: lifecycleCommands,
      CustomerLifecycleClaim: claims,
    })
  );
  customers.clear();
  plans.clear();
  jobs.clear();
  invoices.clear();
  claims.clear();
  events = [];
  notifyOffice.mockClear();
  openOwnedWork.mockClear();
  paymentIntentsCreate.mockClear();
  recordCustomerLifecycleEvent.mockClear();
  recordCustomerLifecycleEvent.mockResolvedValue({ recorded: true });
  revokePortal.mockClear();
  revokePortal.mockImplementation(async () => {
    events.push("portal:revoke");
    return { revoked: true };
  });
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

    const res = await deactivateCustomer(stripe, "c1", actor, opts());

    expect(cancelPlanBilling).toHaveBeenCalledTimes(2);
    const ids = cancelPlanBilling.mock.calls.map((c) => c[1]);
    expect(ids).toEqual(expect.arrayContaining(["p1", "p2"]));
    expect(ids).not.toContain("p3");
    expect(res.plansCanceled).toBe(2);
    expect(res.visitsResolved).toBe(2); // one auto-queued visit resolved per plan
  });

  it("requires a reason — refuses to deactivate with a blank one", async () => {
    seedPlan({ id: "p1" });
    await expect(
      deactivateCustomer(stripe, "c1", actor, {
        reason: "   ",
        revokePortalAccess: revokePortal,
      })
    ).rejects.toThrow(/reason is required/i);
    // Nothing was touched — no plan cancel, no status flip.
    expect(cancelPlanBilling).not.toHaveBeenCalled();
    expect(customers.get("c1")!.status).toBe("ACTIVE");
  });

  it("sweeps a remaining future visit off its route and cancels it", async () => {
    const job = seedJob({ status: "SCHEDULED", routeId: "r1", routeOrder: 3, technicianId: "t1" });

    const res = await deactivateCustomer(stripe, "c1", actor, opts());

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

    const res = await deactivateCustomer(stripe, "c1", actor, opts());

    expect(jobs.get(paid.id)!.status).toBe("SCHEDULED");
    expect(jobs.get(done.id)!.status).toBe("COMPLETED");
    expect(res.jobsCanceled).toBe(0);
  });

  it("reports the outstanding balance (OPEN + FAILED, net of refunds) and charges nothing", async () => {
    seedInvoice({ status: "OPEN", amountCents: 5000 });
    seedInvoice({ status: "FAILED", amountCents: 3000, refundedAmountCents: 1000 });
    seedInvoice({ status: "PAID", amountCents: 9999 }); // settled — owes nothing

    const res = await deactivateCustomer(stripe, "c1", actor, opts());

    expect(res.outstandingBalanceCents).toBe(5000 + (3000 - 1000));
    expect(paymentIntentsCreate).not.toHaveBeenCalled();
  });

  it("ends the portal login BEFORE flipping INACTIVE, sets INACTIVE last, and records the transition", async () => {
    seedPlan({ id: "p1" });
    seedJob({ status: "SCHEDULED" });

    const res = await deactivateCustomer(stripe, "c1", actor, opts());

    expect(customers.get("c1")!.status).toBe("INACTIVE");
    expect(res.status).toBe("INACTIVE");
    expect(res.partial).toBe(false);
    expect(res.portalRevoked).toBe(true);
    expect(revokePortal).toHaveBeenCalledOnce();
    // Access before status: the portal revoke happens before the INACTIVE write,
    // so INACTIVE never implies a live login.
    expect(events.indexOf("portal:revoke")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("portal:revoke")).toBeLessThan(
      events.indexOf("customer:INACTIVE")
    );
    // The INACTIVE flip is the final state write of the whole operation.
    expect(events.indexOf("cancelPlan:p1")).toBeLessThan(
      events.indexOf("customer:INACTIVE")
    );
    // The transition is recorded for leadership: actor, prior → new, the money/
    // job effects, and the controlled reason.
    expect(recordCustomerLifecycleEvent).toHaveBeenCalledOnce();
    const [entry] = recordCustomerLifecycleEvent.mock.calls[0] as unknown as [
      {
        action: string;
        priorStatus: string;
        newStatus: string;
        effects: string;
        reason: string;
      },
    ];
    expect(entry.action).toBe("DEACTIVATE");
    expect(entry.priorStatus).toBe("ACTIVE");
    expect(entry.newStatus).toBe("INACTIVE");
    expect(entry.effects).toMatch(/not charged/i);
    expect(entry.reason).toBe("CUSTOMER_REQUEST");
    expect(res.audited).toBe(true);
  });

  it("does NOT revoke the portal or flip INACTIVE and pages the office when a plan's cancel fails", async () => {
    seedPlan({ id: "p1" });
    seedJob({ status: "SCHEDULED", routeId: "r1" });
    cancelPlanBilling.mockImplementationOnce(async () => {
      throw new Error("stripe is down");
    });

    const res = await deactivateCustomer(stripe, "c1", actor, opts());

    expect(res.partial).toBe(true);
    expect(res.status).toBe("ACTIVE");
    expect(customers.get("c1")!.status).toBe("ACTIVE");
    expect(events).not.toContain("customer:INACTIVE");
    // The portal is NOT ended for a customer we couldn't finish deactivating —
    // they are still ACTIVE and still a customer.
    expect(revokePortal).not.toHaveBeenCalled();
    expect(recordCustomerLifecycleEvent).not.toHaveBeenCalled();
    expect(res.jobsCanceled).toBe(0);
    expect(notifyOffice).toHaveBeenCalledOnce();
    const [alert] = notifyOffice.mock.calls[0] as unknown as [{ subject: string }];
    expect(alert.subject).toMatch(/ACTION REQUIRED/);
  });

  it("when the portal revoke fails, leaves the customer ACTIVE with owned recovery — never INACTIVE-with-live-login", async () => {
    seedPlan({ id: "p1" });
    revokePortal.mockImplementationOnce(async () => {
      throw new Error("cognito unreachable");
    });

    const res = await deactivateCustomer(stripe, "c1", actor, opts());

    expect(res.partial).toBe(true);
    expect(res.portalRevoked).toBe(false);
    expect(res.status).toBe("ACTIVE");
    // Money was stopped, but the status is NOT flipped — the invisible bad state
    // (INACTIVE with a live portal) never happens.
    expect(cancelPlanBilling).toHaveBeenCalledOnce();
    expect(events).not.toContain("customer:INACTIVE");
    // A durable, resumable recovery owns finishing it.
    expect(openOwnedWork).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "LIFECYCLE_RECOVERY" })
    );
    expect(notifyOffice).toHaveBeenCalledOnce();
    expect(recordCustomerLifecycleEvent).not.toHaveBeenCalled();
  });

  it("surfaces a lost audit write as audited:false while the transition still stands", async () => {
    seedPlan({ id: "p1" });
    recordCustomerLifecycleEvent.mockResolvedValueOnce({ recorded: false });

    const res = await deactivateCustomer(stripe, "c1", actor, opts());

    // The customer is genuinely deactivated, but the immutable record is a
    // COMPLETION REQUIREMENT (GL-09): a lost audit row keeps the transition
    // PARTIAL (owned + resumable), never a clean success.
    expect(res.status).toBe("INACTIVE");
    expect(res.partial).toBe(true);
    expect(res.audited).toBe(false);
    expect(customers.get("c1")!.status).toBe("INACTIVE");
  });

  it("is idempotent: a re-run on an already-inactive customer heals access and logs no second transition", async () => {
    customers.set("c1", {
      id: "c1",
      displayName: "Dana Whitlock",
      status: "INACTIVE",
      portalUserSub: "sub-portal-1",
    });

    const res = await deactivateCustomer(stripe, "c1", actor, opts());

    expect(res.partial).toBe(false);
    expect(res.alreadyInactive).toBe(true);
    expect(res.plansCanceled).toBe(0);
    expect(res.jobsCanceled).toBe(0);
    expect(customers.get("c1")!.status).toBe("INACTIVE");
    // The portal revoke is re-asserted to heal any drift (INACTIVE-with-live-login).
    expect(revokePortal).toHaveBeenCalledOnce();
    // Already INACTIVE: no second transition row.
    expect(recordCustomerLifecycleEvent).not.toHaveBeenCalled();
  });

  it("serializes racing transitions: the claim loser reports in-progress and drives nothing", async () => {
    seedPlan({ id: "p1" });
    // A transition is already in flight — its claim is held.
    claims.set("c1", { id: "c1", action: "REACTIVATE" });

    const res = await deactivateCustomer(stripe, "c1", actor, opts());

    expect(res.partial).toBe(true);
    expect(res.message).toMatch(/in progress/i);
    // The loser did not cancel billing, revoke the portal, or flip status.
    expect(cancelPlanBilling).not.toHaveBeenCalled();
    expect(revokePortal).not.toHaveBeenCalled();
    expect(events).not.toContain("customer:INACTIVE");
    // And it did not delete the in-flight winner's claim.
    expect(claims.has("c1")).toBe(true);
  });

  it("releases the claim on a clean deactivation so a later transition can proceed", async () => {
    seedPlan({ id: "p1" });
    await deactivateCustomer(stripe, "c1", actor, opts());
    // The release is a FENCED CAS delete (atomicLock), not the AppSync model
    // delete — the proof is the row being gone, not the fake's event log.
    expect(claims.has("c1")).toBe(false);
    expect(events).toContain("claim:acquire:c1");
  });

  it("throws on a missing customer rather than reporting a deactivation it did not do", async () => {
    await expect(
      deactivateCustomer(stripe, "nope", actor, opts())
    ).rejects.toThrow(/not found/);
  });
});

describe("GL-09 serialization — adversarial", () => {
  it("a resumable PARTIAL blocks every DIFFERENT-key transition (both directions)", async () => {
    lifecycleCommands.set("old-partial", {
      id: "old-partial",
      customerId: "c1",
      action: "DEACTIVATE",
      stage: "PARTIAL",
      requestedAt: new Date().toISOString(),
    });
    const out = await deactivateCustomer(stripe, "c1", actor, {
      ...opts(),
      idempotencyKey: "fresh-key",
    });
    expect(out.partial).toBe(true);
    expect(out.status).toBe("ACTIVE");
    expect(out.message).toMatch(/unfinished|in progress/i);
    // No provider effect ran.
    expect(cancelPlanBilling).not.toHaveBeenCalled();
  });

  it("the SAME key resumes a PARTIAL (never blocked by itself)", async () => {
    lifecycleCommands.set("resume-key", {
      id: "resume-key",
      customerId: "c1",
      action: "DEACTIVATE",
      stage: "PARTIAL",
      requestedAt: new Date().toISOString(),
      attemptCount: 1,
    });
    const out = await deactivateCustomer(stripe, "c1", actor, {
      ...opts(),
      idempotencyKey: "resume-key",
    });
    expect(out.status).toBe("INACTIVE");
  });

  it("an open-command scan failure FAILS CLOSED: refuses before any change, owned", async () => {
    const model = fakeDataClient.models.CustomerLifecycleCommand as Record<
      string,
      unknown
    >;
    const orig = model.listCustomerLifecycleCommandByCustomerIdAndRequestedAt;
    model.listCustomerLifecycleCommandByCustomerIdAndRequestedAt = async () => {
      throw new Error("throttled");
    };
    try {
      const out = await deactivateCustomer(stripe, "c1", actor, {
        ...opts(),
        idempotencyKey: "k-scan-fail",
      });
      expect(out.partial).toBe(true);
      expect(out.status).toBe("ACTIVE");
      expect(cancelPlanBilling).not.toHaveBeenCalled();
      expect(openOwnedWork).toHaveBeenCalledWith(
        expect.objectContaining({ dedupeKey: "lifecycle-cmd-store:c1" })
      );
    } finally {
      model.listCustomerLifecycleCommandByCustomerIdAndRequestedAt = orig;
    }
  });

  it("an inventory read failure STOPS provider effects and owns the recovery", async () => {
    seedPlan({ id: "p1" });
    const model = fakeDataClient.models.ServicePlan as Record<string, unknown>;
    const orig = model.list;
    model.list = async () => {
      throw new Error("throttled");
    };
    try {
      const out = await deactivateCustomer(stripe, "c1", actor, {
        ...opts(),
        idempotencyKey: "k-inv-fail",
      });
      expect(out.partial).toBe(true);
      expect(out.status).toBe("ACTIVE");
      expect(cancelPlanBilling).not.toHaveBeenCalled();
      expect(openOwnedWork).toHaveBeenCalledWith(
        expect.objectContaining({ dedupeKey: "lifecycle-inventory:c1" })
      );
      expect(lifecycleCommands.get("k-inv-fail")).toMatchObject({
        stage: "PARTIAL",
      });
    } finally {
      model.list = orig;
    }
  });
});
