import type Stripe from "stripe";
import { dataClient } from "./dataClient";
import { emailShell, notifyOffice, sendEmail } from "./email";
import { openOwnedWork } from "./ownedWork";
import { cancelPlanBilling, type QueuedVisitsResolution } from "./subscription";

/**
 * GL-08 — customer self-service plan cancellation.
 *
 * The office already had a cancel button (crm-billing.cancelSubscription →
 * cancelPlanBilling). What the portal was missing is the *customer-facing* half:
 * an honest preview of the consequences before they commit, and a cancel that
 * fails safe. Both live here so the truthful-preview copy and the fail-safe
 * behavior have one owner and one set of tests.
 *
 * cancelPlanBilling (shared/subscription) stays the single engine that touches
 * Stripe and the schedule. This module is the customer wrapper around it: it
 * decides what to say beforehand, records the optional reason, sends the durable
 * confirmation, and — the important part — turns a Stripe outage into a visible
 * pending state plus an owned exception instead of a false "canceled".
 */

/** What one queued visit becomes when the plan is canceled. */
type PreviewQueuedVisit = {
  jobId: string;
  scheduledDate: string | null;
  /** STOPS: never worked, never paid — auto-canceled. REMAINS: paid up front or
   *  a tech already on site — the office decides refund/honor, it is not lost. */
  disposition: "STOPS" | "REMAINS";
  reason: string;
};

export type PlanCancellationPreview = {
  servicePlanId: string;
  planName: string;
  priceCents: number;
  serviceFrequency: string;
  status: string;
  /** True once a plan is already canceled (or a pending cancel is in flight) —
   *  the UI shows the outcome instead of re-offering the action. */
  alreadyResolved: boolean;
  cancellationPending: boolean;
  /** Cancellation takes effect immediately — billing and visits stop today. */
  effectiveDate: string;
  /** Plain-language money outcome. Canceling stops future charges; the current
   *  period is already paid and is not refunded, and no new charge is made. */
  finalCharge: { amountCents: number; description: string };
  refundOrCredit: { amountCents: number; description: string };
  /** Every queued visit and where cancellation leaves it. */
  queuedVisits: PreviewQueuedVisit[];
  visitsStopping: number;
  /** A visit paid up front that stays on the schedule pending an office
   *  decision — surfaced so the customer is told it is not silently lost. */
  paidVisitRemains: boolean;
  /** Money already billed and still unpaid (OPEN/FAILED invoices on this plan).
   *  Canceling stops FUTURE billing; it does not wipe a bill already owed, and
   *  the preview must not let the customer believe otherwise. */
  outstandingBalanceCents: number;
  /** The ongoing protection that ends with the plan. */
  coverageEnding: string;
  /** May a one-time pause/save offer be shown? Only for a live, unpaused plan. */
  saveOfferAvailable: boolean;
};

const todayEastern = (): string =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

const formatUsd = (cents: number): string =>
  `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

/** Money already billed on this plan and not yet paid (OPEN or FAILED). A
 *  cancel stops future billing but does not erase a debt already owed. */
async function outstandingBalanceForPlan(servicePlanId: string): Promise<number> {
  const client = await dataClient();
  let total = 0;
  let token: string | null | undefined;
  do {
    const page = await client.models.Invoice.list({
      filter: {
        servicePlanId: { eq: servicePlanId },
        or: [{ status: { eq: "OPEN" } }, { status: { eq: "FAILED" } }],
      },
      limit: 200,
      nextToken: token,
    });
    for (const inv of page.data) total += inv.amountCents ?? 0;
    token = page.nextToken;
  } while (token);
  return total;
}

async function listQueuedVisits(
  servicePlanId: string
): Promise<PreviewQueuedVisit[]> {
  const client = await dataClient();
  const visits: PreviewQueuedVisit[] = [];
  let token: string | null | undefined;
  do {
    const page = await client.models.Job.listJobByServicePlanId(
      { servicePlanId },
      { nextToken: token, limit: 200 }
    );
    for (const job of page.data) {
      if (job.status === "IN_PROGRESS") {
        visits.push({
          jobId: job.id,
          scheduledDate: job.scheduledDate ?? null,
          disposition: "REMAINS",
          reason: "a technician is on site right now",
        });
        continue;
      }
      if (job.status !== "UNSCHEDULED" && job.status !== "SCHEDULED") continue;
      if (job.paidAt) {
        visits.push({
          jobId: job.id,
          scheduledDate: job.scheduledDate ?? null,
          disposition: "REMAINS",
          reason: "already paid for — we'll refund or keep it, your choice",
        });
        continue;
      }
      visits.push({
        jobId: job.id,
        scheduledDate: job.scheduledDate ?? null,
        disposition: "STOPS",
        reason: "not yet done — it comes off the schedule",
      });
    }
    token = page.nextToken;
  } while (token);
  return visits;
}

/**
 * Build the confirmation preview. Reads only — computes what the customer will
 * see, and what canceling will actually do, from the plan and its queued jobs.
 * Throws only if the plan does not exist.
 */
export async function buildCancellationPreview(
  servicePlanId: string
): Promise<PlanCancellationPreview> {
  const client = await dataClient();
  const { data: plan } = await client.models.ServicePlan.get({
    id: servicePlanId,
  });
  if (!plan) throw new Error(`Service plan ${servicePlanId} not found`);

  const queuedVisits = await listQueuedVisits(servicePlanId);
  const visitsStopping = queuedVisits.filter(
    (v) => v.disposition === "STOPS"
  ).length;
  const paidVisitRemains = queuedVisits.some(
    (v) => v.disposition === "REMAINS"
  );
  const alreadyResolved = plan.status === "CANCELED";
  const outstandingBalanceCents = await outstandingBalanceForPlan(servicePlanId);

  const outstandingLine =
    outstandingBalanceCents > 0
      ? ` You still owe ${formatUsd(outstandingBalanceCents)} on an unpaid invoice — canceling doesn't clear that, and we'll still need it settled.`
      : "";

  return {
    servicePlanId,
    planName: plan.planName,
    priceCents: plan.priceCents,
    serviceFrequency: String(plan.serviceFrequency),
    status: String(plan.status),
    alreadyResolved,
    cancellationPending: Boolean(plan.cancellationPending),
    effectiveDate: todayEastern(),
    finalCharge: {
      amountCents: 0,
      description: `No new charge. Canceling stops all future monthly charges — you won't be billed again.${outstandingLine}`,
    },
    refundOrCredit: {
      amountCents: 0,
      description:
        "The current period is already paid and isn't refunded. Any visit you paid for up front stays yours unless you ask us to refund it.",
    },
    queuedVisits,
    visitsStopping,
    paidVisitRemains,
    outstandingBalanceCents,
    coverageEnding:
      "Your plan's ongoing protection ends today — the scheduled recurring visits and the between-visit coverage and re-treatment that come with the plan stop when it's canceled.",
    // A save offer only makes sense for a plan that is actually running and not
    // already paused; it is never allowed to gate the cancel (UI concern), and
    // it is surfaced at most once.
    saveOfferAvailable: plan.status === "ACTIVE",
  };
}

export type CustomerCancelOutcome =
  | {
      status: "CANCELED";
      alreadyCanceled: boolean;
      stripeSubscriptionCanceled: boolean;
      visitsStopped: number;
      visitsRemaining: number;
      confirmationEmailed: boolean;
      message: string;
    }
  | {
      status: "PENDING";
      message: string;
      requestedAt: string;
    };

/**
 * Cancel a plan on the customer's own instruction.
 *
 * Success path: run the shared cancel engine (Stripe → record → queued visits),
 * stamp the optional reason, clear any prior pending flag, and email the
 * customer a durable confirmation. The reason NEVER blocks the cancel — a plan
 * whose customer typed nothing cancels exactly the same.
 *
 * Failure path (Stripe unreachable, so cancelPlanBilling throws with billing
 * still live): the plan is NOT shown as canceled. It is flagged
 * cancellationPending so the portal shows "we're finishing this by hand", an
 * urgent PORTAL_FAILURE exception is opened with the customer named, and the
 * office is paged. We return PENDING rather than throwing so the customer sees a
 * truthful in-progress state, never a false success and never a bare error that
 * hides that we already know they asked.
 */
export async function cancelPlanForCustomer(
  stripe: Stripe,
  servicePlanId: string,
  opts: { reason?: string | null } = {}
): Promise<CustomerCancelOutcome> {
  const client = await dataClient();
  const { data: plan } = await client.models.ServicePlan.get({
    id: servicePlanId,
  });
  if (!plan) throw new Error(`Service plan ${servicePlanId} not found`);

  const reason = opts.reason?.trim() || null;

  // Duplicate-click / already-done: a second confirm on a plan that is already
  // canceled is a no-op success, not an error and not a second Stripe call.
  if (plan.status === "CANCELED") {
    return {
      status: "CANCELED",
      alreadyCanceled: true,
      stripeSubscriptionCanceled: false,
      visitsStopped: 0,
      visitsRemaining: 0,
      confirmationEmailed: false,
      message: "This plan is already canceled.",
    };
  }

  let result: {
    stripeSubscriptionCanceled: boolean;
    queuedVisits: QueuedVisitsResolution;
  };
  try {
    result = await cancelPlanBilling(stripe, servicePlanId);
  } catch (err) {
    // Billing is still live and the plan is still ACTIVE. Do not say canceled.
    const requestedAt = new Date().toISOString();
    const message = err instanceof Error ? err.message : String(err);
    console.error(`cancelPlanForCustomer failed for plan ${servicePlanId}`, err);

    try {
      await client.models.ServicePlan.update({
        id: servicePlanId,
        cancellationPending: true,
        cancellationRequestedAt: requestedAt,
        cancellationReason: reason ?? undefined,
      });
    } catch (flagErr) {
      // The flag is a nicety; the owned exception below is the durable record
      // that guarantees a human finishes this. Never let the flag write mask it.
      console.error(
        `cancelPlanForCustomer: could not flag pending cancel on ${servicePlanId}`,
        flagErr
      );
    }

    await openOwnedWork({
      kind: "PORTAL_FAILURE",
      dedupeKey: `plan-cancel:${servicePlanId}`,
      title: `Finish a customer's plan cancellation: ${plan.planName}`,
      detail: `A customer confirmed canceling plan ${servicePlanId} (${plan.planName}) in the portal on ${requestedAt}, but the cancellation could not be completed: ${message}. Billing is still live and the plan is still ACTIVE.${reason ? ` Reason they gave: "${reason}".` : ""}`,
      customerId: plan.customerId,
      relatedId: servicePlanId,
      sourceUrl: `/customers/${plan.customerId}`,
      resolutionAction:
        "Cancel the plan's billing and queued visits by hand, then confirm the cancellation to the customer. They believe they have canceled — do not let another charge post.",
      ownerTeam: "FINANCE",
    });

    const { data: customer } = await client.models.Customer.get({
      id: plan.customerId,
    }).catch(() => ({ data: null }));
    const name = customer?.displayName ?? plan.customerId;
    await notifyOffice({
      subject: `ACTION REQUIRED — customer could not cancel their plan: ${name}`,
      heading: "A customer tried to cancel their plan and it failed",
      template: "ops-plan-cancel-failed",
      customerId: plan.customerId,
      relatedId: servicePlanId,
      bodyHtml: `<p><strong>${name}</strong> confirmed canceling their plan <strong>${plan.planName}</strong> in the portal, but it did not go through. <strong>The plan is still ACTIVE and the card is still on subscription.</strong></p>
         <p><strong>Cancel it by hand now</strong> — they have been told we're finishing it, and another monthly charge must not post.</p>
         <p style="color:#666;font-size:13px;">Plan: ${servicePlanId}<br/>Error: ${message}</p>`,
    });

    return {
      status: "PENDING",
      requestedAt,
      message:
        "We've recorded your cancellation and we're finishing it now. You won't be charged again — if anything needs a moment on our side, our team completes it and emails you. Nothing more is needed from you.",
    };
  }

  // Canceled for real. Stamp the reason and clear any earlier pending flag.
  try {
    await client.models.ServicePlan.update({
      id: servicePlanId,
      cancellationPending: false,
      cancellationRequestedAt: new Date().toISOString(),
      cancellationReason: reason ?? undefined,
    });
  } catch (stampErr) {
    console.error(
      `cancelPlanForCustomer: cancel succeeded but reason/flag write failed on ${servicePlanId}`,
      stampErr
    );
  }

  const visitsStopped = result.queuedVisits.canceled.length;
  const visitsRemaining =
    result.queuedVisits.needsDecision.length +
    result.queuedVisits.failed.length;

  const confirmationEmailed = await sendCancellationConfirmation(
    plan.customerId,
    plan.planName,
    result.queuedVisits
  );

  return {
    status: "CANCELED",
    alreadyCanceled: false,
    stripeSubscriptionCanceled: result.stripeSubscriptionCanceled,
    visitsStopped,
    visitsRemaining,
    confirmationEmailed,
    message:
      "Your plan is canceled. You won't be billed again and your recurring visits have stopped. We've emailed you a confirmation.",
  };
}

/** The durable "you're canceled" email. Its own failure becomes owned
 *  EMAIL_FAILURE work inside sendEmail — the cancellation still stands. */
async function sendCancellationConfirmation(
  customerId: string,
  planName: string,
  queuedVisits: QueuedVisitsResolution
): Promise<boolean> {
  const client = await dataClient();
  const { data: customer } = await client.models.Customer.get({
    id: customerId,
  });
  const to = customer?.email?.trim();
  if (!to) {
    // No address to confirm to. Make it owned work rather than a silent gap.
    await openOwnedWork({
      kind: "MISSING_CONTACT",
      dedupeKey: `plan-cancel-confirm:${customerId}`,
      title: `Confirm a plan cancellation by phone: ${customer?.displayName ?? customerId}`,
      detail: `${customer?.displayName ?? customerId} canceled their plan "${planName}" but the record has no email, so the durable confirmation could not be sent.`,
      customerId,
      relatedId: customerId,
      sourceUrl: `/customers/${customerId}`,
      resolutionAction:
        "Add and verify an email address, resend the cancellation confirmation, and record how the customer was reached.",
      ownerTeam: "OPS",
    });
    return false;
  }

  const remaining = [
    ...queuedVisits.needsDecision.map((v) => v.scheduledDate),
    ...queuedVisits.failed.map((v) => v.scheduledDate),
  ].filter(Boolean);
  const remainderHtml = remaining.length
    ? `<p>One visit you'd already paid for${remaining[0] ? ` (${remaining[0]})` : ""} is still on our books — we'll be in touch to either keep it or refund it, whichever you prefer.</p>`
    : "";

  const html = emailShell(
    "Your plan is canceled",
    `<p>Your <strong>${planName}</strong> plan with BuzzKill is canceled, effective today.</p>
     <p>You won't be billed again, and your recurring visits have stopped.</p>
     ${remainderHtml}
     <p>Changed your mind, or want to set something up again? Just reply to this email or give us a call — we'd be glad to have you back.</p>`
  );

  return sendEmail({
    to,
    subject: "Your BuzzKill plan is canceled",
    template: "plan-canceled",
    customerId,
    relatedId: customerId,
    html,
  });
}
