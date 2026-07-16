import type Stripe from "stripe";
import { dataClient } from "./dataClient";
import { notifyOffice } from "./email";

/**
 * Plan billing lifecycle — the single owner of "start billing" and "stop
 * billing" for a ServicePlan.
 *
 * This lives in shared/ because three different Lambdas need it and only one
 * used to have it: crm-billing (the office buttons), crm-docs (job completion,
 * which is what is *supposed* to start billing), and booking-public (customer
 * self-cancellation, which must stop it). The Stripe client is injected
 * because the callers resolve the secret differently — crm-billing/crm-docs via
 * Amplify secret(), booking-public via SSM at runtime.
 *
 * Billing interval: plans are priced PER MONTH regardless of service cadence
 * (rateCards.ts exposes `monthlyCents`; a quarterly plan is "$45/mo, serviced
 * every 3 months"). So every subscription bills monthly by design — that is the
 * product, not a defect. Do not "fix" this to bill quarterly plans every three
 * months; it would cut their revenue by two thirds.
 */

/** Get or create the Stripe customer mirroring a CRM customer. */
export async function ensureStripeCustomer(
  stripe: Stripe,
  customerId: string
) {
  const client = await dataClient();
  const { data: customer } = await client.models.Customer.get({
    id: customerId,
  });
  if (!customer) throw new Error(`Customer ${customerId} not found`);
  if (customer.stripeCustomerId) {
    return { customer, stripeCustomerId: customer.stripeCustomerId };
  }
  const created = await stripe.customers.create({
    name: customer.displayName,
    email: customer.email ?? undefined,
    phone: customer.phone ?? undefined,
    metadata: { crmCustomerId: customerId },
  });
  await client.models.Customer.update({
    id: customerId,
    stripeCustomerId: created.id,
  });
  return { customer, stripeCustomerId: created.id };
}

export async function getDefaultPaymentMethod(
  stripe: Stripe,
  stripeCustomerId: string
) {
  const customer = await stripe.customers.retrieve(stripeCustomerId, {
    expand: ["invoice_settings.default_payment_method"],
  });
  if (customer.deleted) return null;
  const pm = customer.invoice_settings?.default_payment_method;
  return pm && typeof pm !== "string" ? pm : null;
}

/**
 * Subscription price_data requires a real Stripe product — keep exactly one
 * catalog product for all CRM plans (plan name rides on the price/metadata).
 */
export async function ensureProduct(stripe: Stripe): Promise<string> {
  const { data: products } = await stripe.products.list({
    active: true,
    limit: 100,
  });
  const existing = products.find((p) => p.metadata?.crmProduct === "true");
  if (existing) return existing.id;
  const created = await stripe.products.create({
    name: "BuzzKill Pest Control Service",
    metadata: { crmProduct: "true" },
  });
  return created.id;
}

export type StartBillingOutcome =
  | { started: true; stripeSubscriptionId: string; alreadyRunning: boolean }
  | {
      started: false;
      reason:
        | "PLAN_NOT_FOUND"
        | "PLAN_NOT_ACTIVE"
        | "NO_PAYMENT_METHOD"
        | "STRIPE_ERROR";
      message: string;
    };

/**
 * Start monthly billing for a plan. Idempotent: a plan that already has a
 * subscription returns it rather than creating a second one.
 *
 * Returns an outcome instead of throwing, because the important caller is job
 * completion — a tech finishing a visit must not fail because the office never
 * collected a card. An unstarted plan stays visible as ACTIVE with no
 * stripeSubscriptionId, which the Dashboard surfaces as "not billing".
 */
export async function startPlanBilling(
  stripe: Stripe,
  servicePlanId: string
): Promise<StartBillingOutcome> {
  const client = await dataClient();
  const { data: plan } = await client.models.ServicePlan.get({
    id: servicePlanId,
  });
  if (!plan) {
    return {
      started: false,
      reason: "PLAN_NOT_FOUND",
      message: `Service plan ${servicePlanId} not found`,
    };
  }
  // Checked before the subscription-id short-circuit: a plan cancelled from the
  // Stripe dashboard keeps its (now dead) id, and reporting that as "already
  // billing" would hide a cancelled plan still receiving visits.
  if (plan.status === "CANCELED") {
    return {
      started: false,
      reason: "PLAN_NOT_ACTIVE",
      message: "Plan is canceled — it does not bill. Create a new plan instead.",
    };
  }
  if (plan.stripeSubscriptionId) {
    return {
      started: true,
      stripeSubscriptionId: plan.stripeSubscriptionId,
      alreadyRunning: true,
    };
  }
  if (plan.status !== "ACTIVE") {
    return {
      started: false,
      reason: "PLAN_NOT_ACTIVE",
      message: `Plan is ${plan.status} — only an active plan starts billing`,
    };
  }

  try {
    const { stripeCustomerId } = await ensureStripeCustomer(
      stripe,
      plan.customerId
    );
    const pm = await getDefaultPaymentMethod(stripe, stripeCustomerId);
    if (!pm) {
      return {
        started: false,
        reason: "NO_PAYMENT_METHOD",
        message:
          "Customer has no saved payment method — collect one, then start billing",
      };
    }
    const productId = await ensureProduct(stripe);
    const created = await stripe.subscriptions.create(
      {
        customer: stripeCustomerId,
        items: [
          {
            price_data: {
              currency: "usd",
              unit_amount: plan.priceCents,
              recurring: { interval: "month" },
              product: productId,
            },
          },
        ],
        default_payment_method: pm.id,
        metadata: {
          crmServicePlanId: servicePlanId,
          crmCustomerId: plan.customerId,
        },
      },
      { idempotencyKey: `crm-sub-${servicePlanId}` }
    );
    await client.models.ServicePlan.update({
      id: servicePlanId,
      stripeSubscriptionId: created.id,
      status: "ACTIVE",
      startDate: new Date().toISOString().slice(0, 10),
    });
    return {
      started: true,
      stripeSubscriptionId: created.id,
      alreadyRunning: false,
    };
  } catch (err) {
    return {
      started: false,
      reason: "STRIPE_ERROR",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/** One queued visit and where cancellation left it. */
export type QueuedVisit = {
  jobId: string;
  scheduledDate: string | null;
};

export type QueuedVisitsResolution = {
  /** Auto-canceled: never worked, never paid for — dispatching one is a free service call. */
  canceled: QueuedVisit[];
  /** Deliberately left on the schedule; the office must decide what happens to it. */
  needsDecision: (QueuedVisit & { why: string })[];
  /** Should have been canceled but the write failed — the caller must tell somebody. */
  failed: QueuedVisit[];
};

const emptyResolution = (): QueuedVisitsResolution => ({
  canceled: [],
  needsDecision: [],
  failed: [],
});

/**
 * A canceled plan must not keep dispatching technicians. The recurring engine
 * queues each next visit ahead of time (recurring.ts), so every cancel path
 * leaves one behind: reminders still fire, the Schedule pool still routes it,
 * and it completes unbillable and silent — the not-billing digest only scans
 * ACTIVE plans, so a free visit on a canceled plan triggers nothing anywhere.
 *
 * Auto-cancels queued visits that were never worked and never paid for, with
 * the reason written into the job's notes. Visits money or people are already
 * committed to — paid up front, or a technician mid-visit — are left alone and
 * reported back: "refund it, honour it, or reschedule it" is an office
 * decision, not something a cancel path should guess at.
 *
 * Throws only if the schedule cannot be read at all; a single visit whose
 * write fails lands in `failed` so the caller can page a human about it.
 */
export async function cancelQueuedPlanVisits(
  servicePlanId: string,
  cause: string
): Promise<QueuedVisitsResolution> {
  const client = await dataClient();
  const resolution = emptyResolution();

  let token: string | null | undefined;
  do {
    const page = await client.models.Job.listJobByServicePlanId(
      { servicePlanId },
      { nextToken: token, limit: 200 }
    );
    for (const job of page.data) {
      const visit: QueuedVisit = {
        jobId: job.id,
        scheduledDate: job.scheduledDate ?? null,
      };
      if (job.status === "IN_PROGRESS") {
        resolution.needsDecision.push({
          ...visit,
          why: "a technician is on site right now",
        });
        continue;
      }
      if (job.status !== "UNSCHEDULED" && job.status !== "SCHEDULED") continue;
      if (job.paidAt) {
        resolution.needsDecision.push({
          ...visit,
          why: "it was paid up front — refund it or honour it",
        });
        continue;
      }
      const note = `Auto-canceled ${new Date().toISOString().slice(0, 10)}: ${cause}. Taken off the schedule so it cannot dispatch unbilled.`;
      try {
        const { data: updated } = await client.models.Job.update({
          id: job.id,
          status: "CANCELED",
          routeId: null,
          routeOrder: null,
          notes: job.notes ? `${job.notes}\n${note}` : note,
        });
        if (updated) resolution.canceled.push(visit);
        else resolution.failed.push(visit);
      } catch (err) {
        console.error(
          `cancelQueuedPlanVisits: could not cancel job ${job.id}`,
          err
        );
        resolution.failed.push(visit);
      }
    }
    token = page.nextToken;
  } while (token);

  return resolution;
}

/**
 * Cancel a plan everywhere, in one operation: Stripe first, then the record,
 * then the queued visits the plan would otherwise strand.
 *
 * Stripe goes first deliberately. If Stripe fails we throw and leave the plan
 * ACTIVE, which is visibly wrong and gets retried — the opposite order marks
 * the plan CANCELED while the card keeps being charged, which is invisible and
 * is an unauthorized recurring charge.
 */
export async function cancelPlanBilling(
  stripe: Stripe,
  servicePlanId: string
): Promise<{
  canceled: boolean;
  stripeSubscriptionCanceled: boolean;
  queuedVisits: QueuedVisitsResolution;
}> {
  const client = await dataClient();
  const { data: plan } = await client.models.ServicePlan.get({
    id: servicePlanId,
  });
  if (!plan) throw new Error(`Service plan ${servicePlanId} not found`);

  let stripeSubscriptionCanceled = false;
  if (plan.stripeSubscriptionId) {
    try {
      await stripe.subscriptions.cancel(plan.stripeSubscriptionId);
      stripeSubscriptionCanceled = true;
    } catch (err) {
      // Already gone at Stripe is success — anything else must surface.
      const code = (err as { code?: string })?.code;
      const status = (err as { statusCode?: number })?.statusCode;
      if (code === "resource_missing" || status === 404) {
        stripeSubscriptionCanceled = true;
      } else {
        throw err;
      }
    }
  }

  await client.models.ServicePlan.update({
    id: servicePlanId,
    status: "CANCELED",
    stripeSubscriptionId: null,
    canceledAt: new Date().toISOString(),
  });

  // The billing is stopped; now stop the trucks. Nothing past this point may
  // throw — the cancellation is real, and a caller (the customer-facing
  // /cancel included) must not be told it failed because a job row would not
  // update. What could not be resolved is emailed to the office instead.
  let queuedVisits: QueuedVisitsResolution | null = null;
  try {
    queuedVisits = await cancelQueuedPlanVisits(
      servicePlanId,
      "the service plan was canceled"
    );
  } catch (err) {
    console.error(
      `cancelPlanBilling: could not resolve queued visits for plan ${servicePlanId}`,
      err
    );
  }
  if (!queuedVisits || queuedVisits.failed.length > 0) {
    const { data: customer } = await client.models.Customer.get({
      id: plan.customerId,
    }).catch(() => ({ data: null }));
    const name = customer?.displayName ?? plan.customerId;
    await notifyOffice({
      subject: `ACTION REQUIRED — canceled plan still has visits on the schedule: ${name}`,
      heading: "A canceled plan still has visits on the schedule",
      template: "ops-cancel-visits-stranded",
      customerId: plan.customerId,
      relatedId: servicePlanId,
      bodyHtml: `<p><strong>${name}</strong>'s plan <strong>${plan.planName}</strong> was just canceled and its billing is stopped, but ${
        queuedVisits
          ? `${queuedVisits.failed.length} queued visit${queuedVisits.failed.length === 1 ? "" : "s"} could not be taken off the schedule`
          : "the schedule could not be checked for queued visits"
      }.</p>
         <p><strong>Open the Schedule and cancel this customer's queued visits by hand.</strong> Anything left will dispatch a technician for a visit nobody is paying for.</p>`,
    });
  }

  return {
    canceled: true,
    stripeSubscriptionCanceled,
    queuedVisits: queuedVisits ?? emptyResolution(),
  };
}
