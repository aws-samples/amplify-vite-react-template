import type Stripe from "stripe";
import { dataClient } from "./dataClient";
import { notifyOffice } from "./email";
import { openOwnedWork } from "./ownedWork";
import { CANCEL_FULL_REFUND_DAYS } from "./bookingTerms";
import { computeVisitCancellationPolicy } from "./cancellationPolicy";
import { jobScheduleGuards, releaseJobCapacity } from "./capacity";
import { casGuardedUpdate } from "./atomicLock";

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
  /** Canceled off the schedule (cancellation is immediate for every future
   *  visit — paid or not; the money outcome is tracked separately below). */
  canceled: QueuedVisit[];
  /** A real-world outcome still needs an office decision (a technician on
   *  site, or a payment still in motion) — each has an owned case. */
  needsDecision: (QueuedVisit & { why: string })[];
  /** Should have been canceled but the write failed — the caller must tell somebody. */
  failed: QueuedVisit[];
  /** GL-08: paid visits canceled MORE than 72 hours out — a full
   *  original-method refund is owed; each carries an owned Finance case with
   *  the exact server-calculated amount (no other outcome is allowed). */
  refundsOwed?: (QueuedVisit & { amountCents: number })[];
  /** GL-08: paid visits canceled at 72 hours or less — per the approved
   *  policy the payment is retained (no refund, never account credit); named
   *  to the customer in the confirmation. */
  retained?: (QueuedVisit & { amountCents: number })[];
};

const emptyResolution = (): QueuedVisitsResolution => ({
  canceled: [],
  needsDecision: [],
  failed: [],
  refundsOwed: [],
  retained: [],
});

/**
 * A canceled plan must not keep dispatching technicians. The recurring engine
 * queues each next visit ahead of time (recurring.ts), so every cancel path
 * leaves one behind: reminders still fire, the Schedule pool still routes it,
 * and it completes unbillable and silent — the not-billing digest only scans
 * ACTIVE plans, so a free visit on a canceled plan triggers nothing anywhere.
 *
 * GL-08 (approved rule): subscription cancellation is effective immediately —
 * every future visit comes OFF the schedule — and each affected visit
 * independently receives the server-calculated 72-hour money outcome:
 * strictly more than 72 hours before its start, a full refund to the original
 * payment method (an owned Finance case carries the exact amount; no other
 * outcome is allowed); at exactly 72 hours or less, no refund (the retained
 * amount is named to the customer). There is no keep-or-refund choice and no
 * account credit. A technician mid-visit, or a payment still in motion
 * (pending bank debit), is a real-world outcome the system won't guess:
 * those get an owned case with the policy result spelled out.
 *
 * Throws only if the schedule cannot be read at all; a single visit whose
 * write fails lands in `failed` so the caller can page a human about it.
 */
export async function cancelQueuedPlanVisits(
  servicePlanId: string,
  cause: string,
  /** GL-08: the accepted-cancellation instant (ms) that anchors the hour-exact
   *  72-hour refund line — the same instant the plan's cancellationRequestedAt
   *  records. Passed from every caller so a resume judges the moment the
   *  customer was entitled to, not the retry. Defaults to now for safety. */
  nowMs: number = Date.now()
): Promise<QueuedVisitsResolution> {
  const client = await dataClient();
  const resolution = emptyResolution();
  const today = todayEasternDate();

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
        await openOwnedWork({
          kind: "PAID_VISIT_CANCELLATION",
          dedupeKey: job.id,
          title: "Canceled plan has a visit in progress",
          detail: `Plan ${servicePlanId} was canceled while job ${job.id} had a technician on site. The system did not guess whether to stop or honor the visit.`,
          customerId: job.customerId,
          relatedId: job.id,
          sourceUrl: `/customers/${job.customerId}`,
          resolutionAction:
            "Confirm what service was performed, settle any refund or charge, and document the decision on the customer record.",
          ownerTeam: "OPS",
        });
        continue;
      }
      if (job.status !== "UNSCHEDULED" && job.status !== "SCHEDULED") continue;

      // The money facts BEFORE the schedule write, so the disposition rides on
      // what was actually paid (net of prior refunds) and what is in motion.
      const money = await jobMoneyFacts(job.id);
      const paidCents =
        money.paidNetCents > 0
          ? money.paidNetCents
          : job.paidAt
            ? Math.max(0, job.priceCents ?? 0)
            : 0;
      // GL-08: hour-exact against the visit's Eastern scheduled start, judged
      // from the accepted-cancellation instant — matching the office path
      // (visitChange.driveHeldVisitCancel) so preview, this write, and the
      // office button all agree with the customer-facing copy.
      const policy = computeVisitCancellationPolicy({
        scheduledDate: job.scheduledDate ?? null,
        amountPaidCents: paidCents,
        today,
        nowMs,
      });

      const note = `Auto-canceled ${new Date().toISOString().slice(0, 10)}: ${cause}.${
        paidCents > 0
          ? policy.withinFreeWindow
            ? ` Paid ${(paidCents / 100).toFixed(2)} — full refund owed (more than ${CANCEL_FULL_REFUND_DAYS * 24} hours out).`
            : ` Paid ${(paidCents / 100).toFixed(2)} — retained per the ${CANCEL_FULL_REFUND_DAYS * 24}-hour policy.`
          : " Taken off the schedule so it cannot dispatch unbilled."
      }`;
      // The MACHINE-READABLE disposition rides the cancel write itself, so
      // settlement verifies the exact policy outcome later — never inferring
      // it from schedule rows that no longer list (GL-08 R4).
      const disposition =
        money.inFlightCents > 0
          ? "AWAIT_SETTLEMENT"
          : paidCents > 0
            ? policy.withinFreeWindow
              ? "REFUND_OWED"
              : "FEE_RETAINED"
            : "NONE";
      let canceled = false;
      try {
        // GUARDED on the snapshot this sweep read: the 72-hour policy and
        // the capacity release below were computed from THAT schedule — a
        // concurrent move makes this cancel lose into the failed list (owned
        // recovery re-runs it against the fresh state) instead of recording
        // a money disposition for a date the visit no longer has.
        const published = await casGuardedUpdate(
          "Job",
          job.id,
          {
            status: "CANCELED",
            routeId: null,
            routeOrder: null,
            // Stamps end WITH the hold — the release below reads the
            // pre-update row, and a re-driven sweep finds nothing left to
            // give back.
            capacityMinutes: null,
            capacityTechnicianId: null,
            cancelDisposition: disposition,
            cancelDispositionCents:
              disposition === "AWAIT_SETTLEMENT"
                ? money.inFlightCents
                : paidCents,
            notes: job.notes ? `${job.notes}\n${note}` : note,
          },
          jobScheduleGuards(job)
        );
        canceled = published.ok;
      } catch (err) {
        console.error(
          `cancelQueuedPlanVisits: could not cancel job ${job.id}`,
          err
        );
      }
      if (!canceled) {
        resolution.failed.push(visit);
        continue;
      }
      resolution.canceled.push(visit);
      // GL-04: the canceled visit's minutes go back to its technician-day
      // slot (or the pool accounting slot) — strictly from its stamps, via
      // the one canonical release path.
      await releaseJobCapacity(job);

      if (paidCents > 0 && policy.withinFreeWindow) {
        // >72h: the refund is owed in full — the case PRESCRIBES the exact
        // server-calculated outcome; it is not a keep-or-refund choice.
        (resolution.refundsOwed ??= []).push({ ...visit, amountCents: paidCents });
        await openOwnedWork({
          kind: "PAID_VISIT_CANCELLATION",
          dedupeKey: job.id,
          title: `Refund a canceled plan visit in full: $${(paidCents / 100).toFixed(2)}`,
          detail: `Job ${job.id}${job.scheduledDate ? ` on ${job.scheduledDate}` : ""} was paid ($${(paidCents / 100).toFixed(2)} net of prior refunds) and canceled with plan ${servicePlanId} strictly more than 72 hours before its start. Per the approved policy the ONLY outcome is a full refund of that amount to the original payment method${money.paidInvoiceId ? ` (invoice ${money.paidInvoiceId})` : " (no paid invoice row was found — locate the payment in Stripe)"}. The visit is already off the schedule.`,
          customerId: job.customerId,
          relatedId: job.id,
          sourceUrl: `/customers/${job.customerId}`,
          resolutionAction:
            "Issue the exact full refund to the original payment method and confirm it posted. No other disposition (partial refund, account credit, keeping the money) is allowed for this case.",
          ownerTeam: "FINANCE",
        });
      } else if (paidCents > 0) {
        // ≤72h: the approved policy retains the payment — decided, recorded,
        // and named to the customer; not silently kept.
        (resolution.retained ??= []).push({ ...visit, amountCents: paidCents });
      }

      if (money.inFlightCents > 0) {
        // A pending (usually bank-debit) payment is still in motion for a
        // visit that no longer exists — it cannot be voided here and must not
        // settle into silence. Own it with the policy result spelled out.
        resolution.needsDecision.push({
          ...visit,
          why: "a payment is still in motion — Finance settles it per the 72-hour rule",
        });
        await openOwnedWork({
          kind: "PAID_VISIT_CANCELLATION",
          dedupeKey: `pending-payment:${job.id}`,
          title: "A payment is still in motion on a canceled plan visit",
          detail: `Job ${job.id}${job.scheduledDate ? ` on ${job.scheduledDate}` : ""} was canceled with plan ${servicePlanId} while $${(money.inFlightCents / 100).toFixed(2)} is still processing${money.inFlightInvoiceId ? ` (invoice ${money.inFlightInvoiceId})` : ""}. When it settles: ${
            policy.withinFreeWindow
              ? "refund it in full — the visit was strictly more than 72 hours away at cancellation"
              : "it is retained per the 72-hour policy (the visit was 72 hours or less away)"
          }. If it fails, void the invoice. Do not let it settle into an ordinary receipt.`,
          customerId: job.customerId,
          relatedId: job.id,
          sourceUrl: `/customers/${job.customerId}`,
          resolutionAction:
            "Watch the payment to settlement, apply the stated 72-hour outcome exactly once, and record it on the invoice.",
          ownerTeam: "FINANCE",
        });
      }
    }
    token = page.nextToken;
  } while (token);

  return resolution;
}

/** Today's calendar date in Eastern time — the clock the 72-hour rule runs on. */
function todayEasternDate(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** The money already attached to one visit: net paid cents (paid minus prior
 *  refunds), the paid invoice id, and any amount still in motion (an OPEN
 *  invoice with a live PaymentIntent — the pending-bank-debit case). */
async function jobMoneyFacts(jobId: string): Promise<{
  paidNetCents: number;
  paidInvoiceId: string | null;
  inFlightCents: number;
  inFlightInvoiceId: string | null;
}> {
  const client = await dataClient();
  let paidNetCents = 0;
  let paidInvoiceId: string | null = null;
  let inFlightCents = 0;
  let inFlightInvoiceId: string | null = null;
  let token: string | null | undefined;
  do {
    const page = await client.models.Invoice.list({
      filter: { jobId: { eq: jobId } },
      limit: 200,
      nextToken: token,
    });
    for (const inv of page.data ?? []) {
      if (inv.status === "PAID") {
        const net = Math.max(
          0,
          (inv.amountCents ?? 0) - (inv.refundedAmountCents ?? 0)
        );
        if (net > 0 && !paidInvoiceId) paidInvoiceId = inv.id;
        paidNetCents += net;
      } else if (inv.status === "OPEN" && inv.stripePaymentIntentId) {
        inFlightCents += inv.amountCents ?? 0;
        if (!inFlightInvoiceId) inFlightInvoiceId = inv.id;
      }
    }
    token = page.nextToken;
  } while (token);
  return { paidNetCents, paidInvoiceId, inFlightCents, inFlightInvoiceId };
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

  // GL-08 R3: the accepted-cancellation instant. Anchored once here so the
  // plan record, the hour-exact refund sweep below, and any resume all judge
  // the 72-hour line from the SAME moment — a prior anchor survives a retry.
  const acceptedCancelAt =
    (plan as { cancellationRequestedAt?: string | null }).cancellationRequestedAt ??
    new Date().toISOString();

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

  // GL-08 R3: the plan is "canceled" only after BOTH the provider stop AND this
  // CRM transition are confirmed written. If the record does not flip, do NOT
  // report success — throw so the caller resumes. It is safe to resume: Stripe
  // is already canceled, so a retry reads resource_missing as success and only
  // re-attempts this write.
  const { data: canceledPlan, errors: cancelErrors } =
    await client.models.ServicePlan.update({
      id: servicePlanId,
      status: "CANCELED",
      stripeSubscriptionId: null,
      // GL-08 R3: the provider reference survives the clear, so settlement can
      // RE-PROVE against Stripe that this subscription really reads canceled.
      canceledStripeSubscriptionId:
        plan.stripeSubscriptionId ??
        (plan as { canceledStripeSubscriptionId?: string | null })
          .canceledStripeSubscriptionId ??
        undefined,
      canceledAt: new Date().toISOString(),
      // GL-08 R3: EVERY cancel path anchors the accepted-cancellation time —
      // the office button and the deactivation sweep included, not just the
      // customer portal. Without this stamp a charge that posts after the
      // cancel is judged pre-request and escapes the full-refund gate.
      cancellationRequestedAt: acceptedCancelAt,
    });
  if (!canceledPlan) {
    throw new Error(
      `Stripe subscription for plan ${servicePlanId} was canceled, but the plan record did not update: ${
        cancelErrors?.map((e) => e.message).join("; ") ?? "unknown error"
      }`
    );
  }

  // The billing is stopped; now stop the trucks. Nothing past this point may
  // throw — the cancellation is real, and a caller (the customer-facing
  // /cancel included) must not be told it failed because a job row would not
  // update. What could not be resolved is emailed to the office instead.
  let queuedVisits: QueuedVisitsResolution | null = null;
  try {
    queuedVisits = await cancelQueuedPlanVisits(
      servicePlanId,
      "the service plan was canceled",
      Date.parse(acceptedCancelAt)
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

    // GL-08 R2: a failed schedule write is durable owned work, not just an email
    // that can be missed — one item per stranded visit, closable only once the
    // visit is actually off the schedule (its GL-18 verifier checks the job is
    // canceled). A visit the schedule could not even be read is owned per plan.
    for (const v of queuedVisits?.failed ?? []) {
      await openOwnedWork({
        kind: "VISIT_CHANGE_RECOVERY",
        dedupeKey: `plan-cancel-visit:${v.jobId}`,
        title: `Take a visit off a canceled plan: ${name}`,
        detail: `Plan ${plan.planName} (${servicePlanId}) was canceled, but queued visit ${v.jobId}${v.scheduledDate ? ` on ${v.scheduledDate}` : ""} could not be removed from the schedule automatically. Until it is, a technician could be dispatched for a visit nobody is paying for.`,
        customerId: plan.customerId,
        relatedId: v.jobId,
        sourceUrl: `/customers/${plan.customerId}`,
        resolutionAction:
          "Cancel this visit on the Schedule board (or resume the plan cancellation — it re-sweeps). A paid visit gets the 72-hour outcome: full refund if it was more than 72 hours out at cancellation, retained otherwise.",
        ownerTeam: "OPS",
      });
    }
    if (!queuedVisits) {
      // A plan-level schedule-READ failure belongs to the plan's own recovery
      // case (its verifier re-reads the schedule and refuses to close while a
      // cancelable visit remains) — never a money-shaped "paid" case with a
      // plan id its money verifier can't inspect.
      await openOwnedWork({
        kind: "PLAN_CANCELLATION_RECOVERY",
        dedupeKey: servicePlanId,
        title: `Check a canceled plan's visits by hand: ${name}`,
        detail: `Plan ${plan.planName} (${servicePlanId}) was canceled, but its queued visits could not be read to take them off the schedule. Any left will dispatch a technician for a visit nobody is paying for.`,
        customerId: plan.customerId,
        relatedId: servicePlanId,
        sourceUrl: `/customers/${plan.customerId}`,
        resolutionAction:
          "Open the Schedule for this customer and cancel any visits still queued on the canceled plan.",
        ownerTeam: "OPS",
      });
    }
  }

  return {
    canceled: true,
    stripeSubscriptionCanceled,
    queuedVisits: queuedVisits ?? emptyResolution(),
  };
}
