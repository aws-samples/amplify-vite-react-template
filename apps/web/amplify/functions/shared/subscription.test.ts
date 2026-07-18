import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";

/**
 * Plan billing lifecycle rules.
 *
 * The interval test is the important one. A reviewer has already misread
 * `monthlyCents` as a per-visit price once and asked for quarterly plans to be
 * billed every three months, which would have cut that revenue by two thirds.
 * A comment did not stop that; a failing build will.
 */

type Plan = {
  id: string;
  customerId: string;
  planName: string;
  priceCents: number;
  serviceFrequency: string;
  status: string;
  stripeSubscriptionId?: string | null;
  canceledAt?: string | null;
};

type Job = {
  id: string;
  servicePlanId: string;
  status: string;
  scheduledDate?: string | null;
  paidAt?: string | null;
  routeId?: string | null;
  routeOrder?: number | null;
  notes?: string | null;
};

const plans = new Map<string, Plan>();
const customers = new Map<
  string,
  { id: string; displayName: string; stripeCustomerId?: string | null }
>();
const jobs = new Map<string, Job>();
let jobUpdate = async (patch: Partial<Job> & { id: string }) => {
  jobs.set(patch.id, { ...jobs.get(patch.id)!, ...patch });
  return { data: jobs.get(patch.id) ?? null };
};

const fakeDataClient = {
  models: {
    ServicePlan: {
      get: async ({ id }: { id: string }) => ({ data: plans.get(id) ?? null }),
      update: async (patch: Partial<Plan> & { id: string }) => {
        plans.set(patch.id, { ...plans.get(patch.id)!, ...patch });
        return { data: plans.get(patch.id) };
      },
    },
    Customer: {
      get: async ({ id }: { id: string }) => ({ data: customers.get(id) ?? null }),
      update: async (patch: { id: string; stripeCustomerId?: string }) => {
        customers.set(patch.id, { ...customers.get(patch.id)!, ...patch });
        return { data: customers.get(patch.id) };
      },
    },
    Job: {
      listJobByServicePlanId: async ({ servicePlanId }: { servicePlanId: string }) => ({
        data: [...jobs.values()].filter((j) => j.servicePlanId === servicePlanId),
        nextToken: null,
      }),
      update: (patch: Partial<Job> & { id: string }) => jobUpdate(patch),
    },
  },
};

vi.mock("./dataClient", () => ({
  dataClient: async () => fakeDataClient,
}));

const notifyOffice = vi.fn(async () => true);
vi.mock("./email", () => ({
  notifyOffice: (...args: unknown[]) =>
    (notifyOffice as unknown as (...a: unknown[]) => Promise<boolean>)(...args),
}));

const openOwnedWork = vi.fn(async () => "work-1");
vi.mock("./ownedWork", () => ({
  openOwnedWork: (...args: unknown[]) =>
    (openOwnedWork as unknown as (...a: unknown[]) => Promise<string | null>)(...args),
}));

const { startPlanBilling, cancelPlanBilling, cancelQueuedPlanVisits } =
  await import("./subscription");

type FakeStripe = Stripe & {
  __subsCreated: Stripe.SubscriptionCreateParams[];
  __subsCanceled: string[];
};

function makeStripe(opts: { hasPaymentMethod: boolean }): FakeStripe {
  const subsCreated: Stripe.SubscriptionCreateParams[] = [];
  const subsCanceled: string[] = [];
  return {
    __subsCreated: subsCreated,
    __subsCanceled: subsCanceled,
    customers: {
      create: async () => ({ id: "cus_new" }),
      retrieve: async () => ({
        deleted: false,
        invoice_settings: {
          default_payment_method: opts.hasPaymentMethod
            ? { id: "pm_1", type: "card" }
            : null,
        },
      }),
    },
    products: {
      list: async () => ({
        data: [{ id: "prod_1", metadata: { crmProduct: "true" } }],
      }),
      create: async () => ({ id: "prod_1" }),
    },
    subscriptions: {
      create: async (params: Stripe.SubscriptionCreateParams) => {
        subsCreated.push(params);
        return { id: `sub_${subsCreated.length}` };
      },
      cancel: async (id: string) => {
        subsCanceled.push(id);
        return { id };
      },
    },
  } as unknown as FakeStripe;
}

beforeEach(() => {
  plans.clear();
  customers.clear();
  jobs.clear();
  jobUpdate = async (patch) => {
    jobs.set(patch.id, { ...jobs.get(patch.id)!, ...patch });
    return { data: jobs.get(patch.id) ?? null };
  };
  notifyOffice.mockClear();
  openOwnedWork.mockClear();
  customers.set("c1", {
    id: "c1",
    displayName: "Dana Whitlock",
    stripeCustomerId: "cus_1",
  });
});

const seedPlan = (over: Partial<Plan> = {}): Plan => {
  const plan: Plan = {
    id: "p1",
    customerId: "c1",
    planName: "Residential quarterly",
    priceCents: 4500,
    serviceFrequency: "QUARTERLY",
    status: "ACTIVE",
    stripeSubscriptionId: null,
    ...over,
  };
  plans.set(plan.id, plan);
  return plan;
};

const seedJob = (over: Partial<Job> = {}): Job => {
  const job: Job = {
    id: `j${jobs.size + 1}`,
    servicePlanId: "p1",
    status: "UNSCHEDULED",
    scheduledDate: "2026-10-14",
    paidAt: null,
    routeId: null,
    routeOrder: null,
    notes: "Auto-queued quarterly visit after job j0.",
    ...over,
  };
  jobs.set(job.id, job);
  return job;
};

describe("startPlanBilling", () => {
  it("starts billing when the first visit completes", async () => {
    seedPlan();
    const stripe = makeStripe({ hasPaymentMethod: true });

    const outcome = await startPlanBilling(stripe, "p1");

    expect(outcome.started).toBe(true);
    expect(plans.get("p1")!.stripeSubscriptionId).toBe("sub_1");
  });

  it("bills a quarterly plan MONTHLY at its monthly price", async () => {
    // rateCards.ts returns monthlyCents: $45 is $45/month and "quarterly" is
    // the visit cadence, not the billing cadence. Billing this every 3 months
    // would cut the plan's revenue from $540/yr to $180/yr.
    seedPlan({ serviceFrequency: "QUARTERLY", priceCents: 4500 });
    const stripe = makeStripe({ hasPaymentMethod: true });

    await startPlanBilling(stripe, "p1");

    const price = stripe.__subsCreated[0].items![0].price_data!;
    expect(price.recurring!.interval).toBe("month");
    expect(price.recurring!.interval_count ?? 1).toBe(1);
    expect(price.unit_amount).toBe(4500);
  });

  it.each(["MONTHLY", "BIMONTHLY", "QUARTERLY"])(
    "bills a %s plan every single month",
    async (frequency) => {
      seedPlan({ serviceFrequency: frequency });
      const stripe = makeStripe({ hasPaymentMethod: true });

      await startPlanBilling(stripe, "p1");

      // interval_count is the half that actually moves the cadence — asserting
      // only `interval === "month"` would pass an every-3-months subscription.
      const recurring = stripe.__subsCreated[0].items![0].price_data!.recurring!;
      expect(recurring.interval).toBe("month");
      expect(recurring.interval_count ?? 1).toBe(1);
    }
  );

  it("does not create a second subscription on a later visit", async () => {
    seedPlan({ stripeSubscriptionId: "sub_existing" });
    const stripe = makeStripe({ hasPaymentMethod: true });

    const outcome = await startPlanBilling(stripe, "p1");

    expect(outcome).toMatchObject({
      started: true,
      alreadyRunning: true,
      stripeSubscriptionId: "sub_existing",
    });
    expect(stripe.__subsCreated).toHaveLength(0);
  });

  it("reports no-payment-method instead of throwing, so the visit still completes", async () => {
    seedPlan();
    const stripe = makeStripe({ hasPaymentMethod: false });

    const outcome = await startPlanBilling(stripe, "p1");

    expect(outcome).toMatchObject({ started: false, reason: "NO_PAYMENT_METHOD" });
  });

  it("leaves an unbilled plan ACTIVE with no subscription, so the Dashboard lists it", async () => {
    seedPlan();

    await startPlanBilling(makeStripe({ hasPaymentMethod: false }), "p1");

    expect(plans.get("p1")).toMatchObject({
      status: "ACTIVE",
      stripeSubscriptionId: null,
    });
  });

  it("never reports a canceled plan as billing, even with a stale subscription id", async () => {
    // onSubscriptionDeleted used to leave the dead id behind; without the
    // status check first, this would answer "already billing" forever.
    seedPlan({ status: "CANCELED", stripeSubscriptionId: "sub_dead" });

    const outcome = await startPlanBilling(
      makeStripe({ hasPaymentMethod: true }),
      "p1"
    );

    expect(outcome).toMatchObject({ started: false, reason: "PLAN_NOT_ACTIVE" });
  });

  it("reports a Stripe failure rather than throwing into job completion", async () => {
    seedPlan();
    const stripe = makeStripe({ hasPaymentMethod: true });
    stripe.subscriptions.create = (async () => {
      throw new Error("stripe is down");
    }) as never;

    const outcome = await startPlanBilling(stripe, "p1");

    expect(outcome).toMatchObject({ started: false, reason: "STRIPE_ERROR" });
  });

  it("reports a missing plan", async () => {
    const outcome = await startPlanBilling(
      makeStripe({ hasPaymentMethod: true }),
      "nope"
    );

    expect(outcome).toMatchObject({ started: false, reason: "PLAN_NOT_FOUND" });
  });
});

describe("cancelPlanBilling", () => {
  it("cancels at Stripe, not just on the record", async () => {
    seedPlan({ stripeSubscriptionId: "sub_live" });
    const stripe = makeStripe({ hasPaymentMethod: true });

    const result = await cancelPlanBilling(stripe, "p1");

    expect(stripe.__subsCanceled).toContain("sub_live");
    expect(result.stripeSubscriptionCanceled).toBe(true);
    expect(plans.get("p1")).toMatchObject({ status: "CANCELED" });
  });

  it("clears the subscription id so a dead id never reads as healthy", async () => {
    seedPlan({ stripeSubscriptionId: "sub_live" });

    await cancelPlanBilling(makeStripe({ hasPaymentMethod: true }), "p1");

    expect(plans.get("p1")!.stripeSubscriptionId).toBeNull();
  });

  it("leaves the plan ACTIVE when Stripe fails, rather than 'canceled' while still billing", async () => {
    // The whole point of cancelling at Stripe first: a plan marked CANCELED
    // whose card is still charged is an unauthorized recurring charge, and
    // nobody can see it.
    seedPlan({ stripeSubscriptionId: "sub_live" });
    const stripe = makeStripe({ hasPaymentMethod: true });
    stripe.subscriptions.cancel = (async () => {
      throw Object.assign(new Error("stripe down"), {
        code: "api_error",
        statusCode: 500,
      });
    }) as never;

    await expect(cancelPlanBilling(stripe, "p1")).rejects.toThrow();
    expect(plans.get("p1")).toMatchObject({
      status: "ACTIVE",
      stripeSubscriptionId: "sub_live",
    });
  });

  it("treats an already-gone Stripe subscription as success", async () => {
    seedPlan({ stripeSubscriptionId: "sub_gone" });
    const stripe = makeStripe({ hasPaymentMethod: true });
    stripe.subscriptions.cancel = (async () => {
      throw Object.assign(new Error("No such subscription"), {
        code: "resource_missing",
      });
    }) as never;

    await cancelPlanBilling(stripe, "p1");

    expect(plans.get("p1")).toMatchObject({ status: "CANCELED" });
  });

  it("cancels a plan that never started billing", async () => {
    seedPlan({ stripeSubscriptionId: null });

    const result = await cancelPlanBilling(
      makeStripe({ hasPaymentMethod: true }),
      "p1"
    );

    expect(result).toMatchObject({ canceled: true, stripeSubscriptionCanceled: false });
    expect(plans.get("p1")).toMatchObject({ status: "CANCELED" });
  });

  it("throws on a missing plan rather than reporting a cancellation it did not do", async () => {
    await expect(
      cancelPlanBilling(makeStripe({ hasPaymentMethod: true }), "nope")
    ).rejects.toThrow(/not found/);
  });
});

describe("cancelPlanBilling resolves the queued visits", () => {
  // The recurring engine queues the next visit ahead of time, so every cancel
  // path used to strand one: reminders fired, techs dispatched, and the visit
  // completed unbillable — invisible even to the not-billing digest, which
  // only scans ACTIVE plans.

  it("cancels the auto-queued next visit so it cannot dispatch as a free service call", async () => {
    seedPlan({ stripeSubscriptionId: "sub_live" });
    const job = seedJob({ status: "UNSCHEDULED" });

    const result = await cancelPlanBilling(makeStripe({ hasPaymentMethod: true }), "p1");

    expect(jobs.get(job.id)).toMatchObject({ status: "CANCELED" });
    expect(result.queuedVisits.canceled).toHaveLength(1);
  });

  it("takes a scheduled unpaid visit off its route too", async () => {
    seedPlan({ stripeSubscriptionId: "sub_live" });
    const job = seedJob({ status: "SCHEDULED", routeId: "r1", routeOrder: 3 });

    await cancelPlanBilling(makeStripe({ hasPaymentMethod: true }), "p1");

    expect(jobs.get(job.id)).toMatchObject({
      status: "CANCELED",
      routeId: null,
      routeOrder: null,
    });
  });

  it("writes why into the job's notes — an audit trail, not a vanished row", async () => {
    seedPlan({ stripeSubscriptionId: "sub_live" });
    const job = seedJob({ notes: "Auto-queued quarterly visit after job j0." });

    await cancelPlanBilling(makeStripe({ hasPaymentMethod: true }), "p1");

    const notes = jobs.get(job.id)!.notes ?? "";
    expect(notes).toContain("Auto-queued quarterly visit after job j0.");
    expect(notes).toMatch(/auto-canceled/i);
    expect(notes).toMatch(/plan was canceled/i);
  });

  it("leaves a paid-up-front visit alone and reports it for an office decision", async () => {
    // The funnel's first visit is paid at booking. Money already moved, so
    // "refund it or honour it" is an office decision, not a webhook's guess.
    seedPlan({ stripeSubscriptionId: "sub_live" });
    const job = seedJob({ status: "SCHEDULED", paidAt: "2026-07-10T12:00:00Z" });

    const result = await cancelPlanBilling(makeStripe({ hasPaymentMethod: true }), "p1");

    expect(jobs.get(job.id)!.status).toBe("SCHEDULED");
    expect(result.queuedVisits.needsDecision).toHaveLength(1);
    expect(result.queuedVisits.needsDecision[0].why).toMatch(/paid up front/i);
  });

  it("leaves an in-progress visit alone — a technician is standing in the yard", async () => {
    seedPlan({ stripeSubscriptionId: "sub_live" });
    const job = seedJob({ status: "IN_PROGRESS" });

    const result = await cancelPlanBilling(makeStripe({ hasPaymentMethod: true }), "p1");

    expect(jobs.get(job.id)!.status).toBe("IN_PROGRESS");
    expect(result.queuedVisits.needsDecision[0].why).toMatch(/on site/i);
  });

  it("does not touch completed, no-access or already-canceled visits", async () => {
    seedPlan({ stripeSubscriptionId: "sub_live" });
    const done = seedJob({ status: "COMPLETED" });
    const noAccess = seedJob({ status: "NO_ACCESS" });
    const gone = seedJob({ status: "CANCELED", notes: "old" });

    const result = await cancelPlanBilling(makeStripe({ hasPaymentMethod: true }), "p1");

    expect(jobs.get(done.id)!.status).toBe("COMPLETED");
    expect(jobs.get(noAccess.id)!.status).toBe("NO_ACCESS");
    expect(jobs.get(gone.id)!.notes).toBe("old");
    expect(result.queuedVisits).toMatchObject({
      canceled: [],
      needsDecision: [],
      failed: [],
    });
  });

  it("still cancels the plan and pages the office when a visit refuses to cancel", async () => {
    // The billing is already stopped by this point; failing the whole cancel
    // over a job row would tell a customer their cancellation failed when it
    // did not. The failure goes to a human instead.
    seedPlan({ stripeSubscriptionId: "sub_live" });
    seedJob({ status: "UNSCHEDULED" });
    jobUpdate = async () => ({ data: null });

    const result = await cancelPlanBilling(makeStripe({ hasPaymentMethod: true }), "p1");

    expect(result.canceled).toBe(true);
    expect(plans.get("p1")!.status).toBe("CANCELED");
    expect(result.queuedVisits.failed).toHaveLength(1);
    expect(notifyOffice).toHaveBeenCalledOnce();
    const [alert] = notifyOffice.mock.calls[0] as unknown as [{ subject: string }];
    expect(alert.subject).toMatch(/ACTION REQUIRED/);
    // GL-08 R2: the failed removal is durable owned work, not just an email.
    expect(openOwnedWork).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "PAID_VISIT_CANCELLATION",
        dedupeKey: "plan-cancel-visit:j1",
        ownerTeam: "OPS",
      })
    );
  });

  it("pages the office when the schedule cannot be checked at all", async () => {
    seedPlan({ stripeSubscriptionId: "sub_live" });
    fakeDataClient.models.Job.listJobByServicePlanId = (async () => {
      throw new Error("throttled");
    }) as never;

    const result = await cancelPlanBilling(makeStripe({ hasPaymentMethod: true }), "p1");

    expect(result.canceled).toBe(true);
    expect(notifyOffice).toHaveBeenCalledOnce();

    fakeDataClient.models.Job.listJobByServicePlanId = (async ({
      servicePlanId,
    }: {
      servicePlanId: string;
    }) => ({
      data: [...jobs.values()].filter((j) => j.servicePlanId === servicePlanId),
      nextToken: null,
    })) as never;
  });

  it("sends no office email when everything resolved cleanly", async () => {
    seedPlan({ stripeSubscriptionId: "sub_live" });
    seedJob({ status: "UNSCHEDULED" });

    await cancelPlanBilling(makeStripe({ hasPaymentMethod: true }), "p1");

    expect(notifyOffice).not.toHaveBeenCalled();
  });
});

describe("cancelQueuedPlanVisits", () => {
  // Exercised directly by the Stripe webhook, which does its own plan flip and
  // folds this resolution into the office alert.

  it("only touches the given plan's jobs", async () => {
    seedPlan();
    const ours = seedJob({ servicePlanId: "p1" });
    const theirs = seedJob({ servicePlanId: "p2" });

    await cancelQueuedPlanVisits("p1", "the service plan was canceled");

    expect(jobs.get(ours.id)!.status).toBe("CANCELED");
    expect(jobs.get(theirs.id)!.status).toBe("UNSCHEDULED");
  });

  it("puts the cause it was given into the audit note", async () => {
    seedPlan();
    const job = seedJob();

    await cancelQueuedPlanVisits(
      "p1",
      "the plan's subscription was canceled at Stripe"
    );

    expect(jobs.get(job.id)!.notes).toContain("canceled at Stripe");
  });
});
