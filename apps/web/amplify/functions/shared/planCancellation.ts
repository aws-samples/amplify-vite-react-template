import type Stripe from "stripe";
import { randomUUID } from "node:crypto";
import { dataClient } from "./dataClient";
import {
  casTakeover,
  casFencedUpdate,
  casGuardedUpdate,
} from "./atomicLock";
import { emailShell, notifyOffice, sendEmail } from "./email";
import { openOwnedWork, resolveOwnedWork } from "./ownedWork";
import {
  cancelPlanBilling,
  cancelQueuedPlanVisits,
  type QueuedVisitsResolution,
} from "./subscription";
import { computeVisitCancellationPolicy } from "./cancellationPolicy";
import {
  ALREADY_CANCELED_MESSAGE,
  coverageEndingDescription,
  confirmationEmailBodyHtml,
  finalChargeDescription,
  pendingCancelMessage,
  planCanceledSuccessMessage,
  refundOutcomeDescription,
  type VisitResolutionSummary,
} from "./planCancellationPolicy";

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
  refundOutcome: { amountCents: number; description: string };
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
  /** The truthful in-flight message the portal renders when a cancel is pending,
   *  so it never shows a static "you won't be charged again" against live billing. */
  pendingMessage: string;
};

const todayEastern = (): string =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

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
    for (const inv of page.data) {
      // Net of refunds — the schema's own rule for every revenue figure. A
      // partially refunded bill is owed only its remainder.
      total += Math.max(
        0,
        (inv.amountCents ?? 0) - (inv.refundedAmountCents ?? 0)
      );
    }
    token = page.nextToken;
  } while (token);
  return total;
}

async function listQueuedVisits(
  servicePlanId: string
): Promise<PreviewQueuedVisit[]> {
  const client = await dataClient();
  const visits: PreviewQueuedVisit[] = [];
  // One paged invoice read for the whole plan; net paid per visit drives the
  // preview's per-visit 72-hour money outcome.
  const invoices = await listPlanInvoices(servicePlanId);
  const paidByJob = new Map<string, number>();
  for (const inv of invoices) {
    if (inv.status !== "PAID" || !inv.jobId) continue;
    paidByJob.set(
      inv.jobId,
      (paidByJob.get(inv.jobId) ?? 0) +
        Math.max(0, (inv.amountCents ?? 0) - (inv.refundedAmountCents ?? 0))
    );
  }
  const today = todayEastern();
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
      const paidCents =
        paidByJob.get(job.id) ?? (job.paidAt ? Math.max(0, job.priceCents ?? 0) : 0);
      if (paidCents > 0) {
        // GL-08 R6: the preview states the SERVER-calculated 72-hour outcome —
        // never a keep-or-refund choice, never credit.
        const policy = computeVisitCancellationPolicy({
          scheduledDate: job.scheduledDate ?? null,
          amountPaidCents: paidCents,
          today,
        });
        visits.push({
          jobId: job.id,
          scheduledDate: job.scheduledDate ?? null,
          disposition: "STOPS",
          reason: policy.withinFreeWindow
            ? `paid — the $${(paidCents / 100).toFixed(2)} you paid will be refunded in full (it's more than 72 hours away)`
            : `paid — it's within 72 hours, so per our cancellation policy the $${(paidCents / 100).toFixed(2)} paid isn't refunded`,
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
      description: finalChargeDescription(outstandingBalanceCents),
    },
    refundOutcome: {
      amountCents: 0,
      description: refundOutcomeDescription(),
    },
    queuedVisits,
    visitsStopping,
    paidVisitRemains,
    outstandingBalanceCents,
    coverageEnding: coverageEndingDescription(),
    // A save offer only makes sense for a plan that is actually running and not
    // already paused; it is never allowed to gate the cancel (UI concern), and
    // it is surfaced at most once.
    saveOfferAvailable: plan.status === "ACTIVE",
    // The truthful in-flight message, so the portal shows the SAME pending copy
    // the server uses (never a static "you won't be charged again").
    pendingMessage: pendingCancelMessage(),
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
      /** GL-08 R3: provider + CRM both read settled. False = canceled but a
       *  residual (visit, refund, in-flight payment, notice) is still owned
       *  and open — the sweep must NOT count this as completed. */
      settled?: boolean;
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
/**
 * GL-08 R1 — the truthful pending message. Billing may still be live, so it must
 * NOT promise "you won't be charged again": it states the in-flight status, what
 * happens if a charge posts before we finish, and when the customer will hear.
 */
const PENDING_CANCEL_MESSAGE = pendingCancelMessage();

const alreadyCanceledOutcome = (settled = true): CustomerCancelOutcome => ({
  status: "CANCELED",
  alreadyCanceled: true,
  stripeSubscriptionCanceled: false,
  visitsStopped: 0,
  visitsRemaining: 0,
  confirmationEmailed: false,
  settled,
  message: ALREADY_CANCELED_MESSAGE,
});

/** A cancellation command older than this, with its next-attempt time passed (or
 *  never set), belongs to a dead attempt — the reconcile sweep or the customer's
 *  own retry may resume it rather than being told "pending" forever. */
const CANCELLATION_ORPHAN_MS = 10 * 60_000;

/** How long one drive attempt may hold the command's exclusive lease. */
const CANCELLATION_LEASE_MS = 5 * 60_000;
/** After a failed attempt the sweep won't auto-resume before this — paces retries. */
const CANCELLATION_RETRY_MS = 15 * 60_000;
/** After this many failed AUTO resumes the sweep stops re-driving and leaves it
 *  to the already-open FINANCE case; a person can always resume by hand. */
export const MAX_CANCELLATION_RESUME_ATTEMPTS = 5;

type CancellablePlan = { id: string; planName: string; customerId: string };

/**
 * Whether a plan cancellation is FULLY settled — the single source of truth for
 * both the PLAN_CANCELLATION_RECOVERY verified close (crm-docs verifier) and the
 * automatic case-resolve on a clean cancel. Settled means: the plan is canceled
 * and no longer pending, every cancelable visit is off the schedule, no charge
 * is still in flight, and every charge that posted on/after the accepted
 * cancellation time has been refunded (GL-08 R2/R4). One function so the
 * office button and the verifier can never disagree about "done".
 */
export async function planCancellationSettled(
  servicePlanId: string,
  opts: {
    /** GL-08 R3: settled is proved against the PROVIDER, not only CRM state.
     *  Pass a Stripe client; without one, a plan that ever had a provider
     *  subscription cannot read settled (fail closed, never assumed). */
    stripe?: Stripe | null;
  } = {}
): Promise<{ settled: boolean; reason: string }> {
  const client = await dataClient();
  const { data: plan } = await client.models.ServicePlan.get({
    id: servicePlanId,
  });
  if (!plan) return { settled: false, reason: "The plan record could not be found." };
  if (plan.status !== "CANCELED") {
    return {
      settled: false,
      reason: "The plan isn't canceled yet — resume the cancellation first.",
    };
  }
  if (plan.cancellationPending) {
    return {
      settled: false,
      reason: "The cancellation is still finishing — let it complete or resume it first.",
    };
  }
  // The durable command carries the provider reference and the accepted
  // request time — read it once for both.
  let commandRow: {
    requestedAt?: string | null;
    stripeSubscriptionId?: string | null;
  } | null = null;
  if ("PlanCancellationClaim" in client.models) {
    const { data } = await client.models.PlanCancellationClaim.get({
      id: servicePlanId,
    }).catch(() => ({ data: null }));
    commandRow = data;
  }
  // Provider proof (GL-08 R3): the CRM saying CANCELED is not evidence the
  // subscription stopped charging. The reference SURVIVES cancellation
  // (canceledStripeSubscriptionId / the command), so the REAL cancel path —
  // which clears stripeSubscriptionId — still gets the Stripe readback.
  const providerRef =
    plan.stripeSubscriptionId ??
    (plan as { canceledStripeSubscriptionId?: string | null })
      .canceledStripeSubscriptionId ??
    commandRow?.stripeSubscriptionId ??
    null;
  if (providerRef) {
    if (!opts.stripe) {
      return {
        settled: false,
        reason:
          "The provider subscription could not be verified from here — settle from a billing-enabled surface.",
      };
    }
    try {
      const sub = await opts.stripe.subscriptions.retrieve(providerRef);
      if (sub.status !== "canceled") {
        return {
          settled: false,
          reason: `The Stripe subscription still reads ${sub.status} — future charges are NOT stopped. Cancel it at the provider first.`,
        };
      }
    } catch (err) {
      const code = (err as { code?: string; statusCode?: number }) ?? {};
      // A missing subscription cannot charge anyone — that satisfies "stopped".
      if (code.code !== "resource_missing" && code.statusCode !== 404) {
        return {
          settled: false,
          reason:
            "The provider subscription could not be read — settlement can't be confirmed right now.",
        };
      }
    }
  }
  const queued = await listQueuedVisits(servicePlanId);
  const stillOn = queued.filter((v) => v.disposition === "STOPS").length;
  if (stillOn > 0) {
    return {
      settled: false,
      reason: `${stillOn} recurring visit(s) still need to come off the schedule.`,
    };
  }
  // GL-08 R4 (exact terminal settlement): every visit the cancellation
  // touched must have reached its FINAL outcome — including visits that are
  // already CANCELED and therefore invisible to the schedule check above,
  // and payments made BEFORE the request. The stamped cancelDisposition is
  // the policy outcome; the invoices prove the money actually moved.
  {
    let jobToken: string | null | undefined;
    do {
      const page = await client.models.Job.listJobByServicePlanId(
        { servicePlanId },
        { limit: 200, nextToken: jobToken }
      );
      for (const job of page.data ?? []) {
        if (job.status === "IN_PROGRESS") {
          return {
            settled: false,
            reason: `A technician is on site for visit ${job.id} — its final outcome must be recorded before the cancellation can settle.`,
          };
        }
        if (job.status !== "CANCELED") continue;
        const facts = await jobInvoiceFacts(job.id);
        if (facts.inFlightCents > 0) {
          return {
            settled: false,
            reason: `A payment is still in motion on canceled visit ${job.id} — it must settle to its exact 72-hour outcome first.`,
          };
        }
        const disposition = (job as { cancelDisposition?: string | null })
          .cancelDisposition;
        if (disposition === "FEE_RETAINED") continue; // the recorded policy outcome
        if (facts.paidRemainingCents > 0) {
          // REFUND_OWED, AWAIT_SETTLEMENT, or an unstamped legacy cancel with
          // money still held: not settled until the exact refund posts (or a
          // recorded retained outcome exists).
          return {
            settled: false,
            reason: `Canceled visit ${job.id} still holds $${(facts.paidRemainingCents / 100).toFixed(2)} with no full refund and no recorded retained-fee outcome.`,
          };
        }
      }
      jobToken = page.nextToken;
    } while (jobToken);
  }
  const invoices = await listPlanInvoices(servicePlanId);
  const liveCharge = invoices.some(
    (i) => i.status === "OPEN" && Boolean(i.stripePaymentIntentId)
  );
  if (liveCharge) {
    return {
      settled: false,
      reason: "A charge is still in flight — refund or void it before closing.",
    };
  }
  // The accepted cancellation time: the mutable plan stamp, the durable
  // command's requestedAt, then canceledAt — the provider-stop moment every
  // cancel path stamps. Office/deactivation/dashboard cancels predate the
  // cancellationRequestedAt stamp, so canceledAt keeps their late charges
  // inside the full-refund gate instead of silently skipping it.
  const requestedAt =
    plan.cancellationRequestedAt ??
    commandRow?.requestedAt ??
    (plan as { canceledAt?: string | null }).canceledAt ??
    null;
  if (requestedAt) {
    // GL-08 R3: judged by PAYMENT time (paidAt; issuedAt only as fallback),
    // and a late charge is settled only by a FULL refund — a partial refund
    // does not settle a post-cancellation charge.
    const lateUnrefunded = invoices.some(
      (i) =>
        i.status === "PAID" &&
        (i.paidAt ?? i.issuedAt ?? "") >= requestedAt &&
        (i.refundedAmountCents ?? 0) < (i.amountCents ?? 0)
    );
    if (lateUnrefunded) {
      return {
        settled: false,
        reason:
          "A charge that posted after the cancellation hasn't been refunded in full — finish the refund first.",
      };
    }
  }
  // GL-08 R5: final customer delivery is part of settled — DELIVERED (mailbox
  // confirmed) or a RECORDED approved alternate-contact outcome; provider
  // acceptance (SENT) is not customer delivery. A notice-history READ FAILURE
  // fails CLOSED. With no address on file, the MISSING_CONTACT case owns the
  // alternate path.
  try {
    const { data: cust } = await client.models.Customer.get({
      id: plan.customerId,
    });
    if (cust?.email?.trim() && "EmailLog" in client.models) {
      const { data: logs } = await client.models.EmailLog.listEmailLogByRelatedId(
        { relatedId: servicePlanId },
        { limit: 50 }
      );
      const delivered = (logs ?? []).some(
        (l) =>
          l.template === "plan-canceled" &&
          (l.deliveryStatus === "DELIVERED" ||
            l.deliveryStatus === "ALTERNATE_DELIVERED")
      );
      if (!delivered) {
        const accepted = (logs ?? []).some(
          (l) => l.template === "plan-canceled" && l.deliveryStatus === "SENT"
        );
        return {
          settled: false,
          reason: accepted
            ? "The cancellation confirmation was accepted by the provider but not yet DELIVERED — wait for the delivery event, or record an approved alternate delivery."
            : "The cancellation confirmation hasn't reached the customer — resume the cancellation (it re-sends or adopts the notice), or record an approved alternate delivery.",
        };
      }
    }
  } catch (err) {
    console.error("planCancellationSettled: notice check failed", err);
    return {
      settled: false,
      reason:
        "The customer-notice history could not be read — settlement can't be confirmed right now.",
    };
  }
  return {
    settled: true,
    reason:
      "Provider subscription stopped, plan canceled, every visit at its exact money outcome, every late charge fully refunded, and the customer's final word delivered.",
  };
}

/** The money still attached to one visit, for the settlement check. */
async function jobInvoiceFacts(jobId: string): Promise<{
  paidRemainingCents: number;
  inFlightCents: number;
}> {
  const client = await dataClient();
  let paidRemainingCents = 0;
  let inFlightCents = 0;
  let token: string | null | undefined;
  do {
    const page = await client.models.Invoice.list({
      filter: { jobId: { eq: jobId } },
      limit: 200,
      nextToken: token,
    });
    for (const inv of page.data ?? []) {
      if (inv.status === "PAID" || inv.status === "REFUNDED") {
        paidRemainingCents += Math.max(
          0,
          (inv.amountCents ?? 0) - (inv.refundedAmountCents ?? 0)
        );
      } else if (inv.status === "OPEN" && inv.stripePaymentIntentId) {
        inFlightCents += inv.amountCents ?? 0;
      }
    }
    token = page.nextToken;
  } while (token);
  return { paidRemainingCents, inFlightCents };
}

/** Every invoice on a plan (paged), for the settlement check and preview. */
type PlanInvoiceRow = {
  id?: string;
  jobId?: string | null;
  status: string | null;
  amountCents?: number | null;
  stripePaymentIntentId?: string | null;
  issuedAt?: string | null;
  paidAt?: string | null;
  refundedAmountCents?: number | null;
};
async function listPlanInvoices(servicePlanId: string): Promise<PlanInvoiceRow[]> {
  const client = await dataClient();
  const out: PlanInvoiceRow[] = [];
  let token: string | null | undefined;
  do {
    const page = await client.models.Invoice.list({
      filter: { servicePlanId: { eq: servicePlanId } },
      limit: 200,
      nextToken: token,
    });
    for (const inv of page.data) out.push(inv);
    token = page.nextToken;
  } while (token);
  return out;
}

/**
 * Drive a cancellation to a terminal outcome, assuming this caller HOLDS the
 * durable command (the claim). Idempotent and resumable: cancelPlanBilling is
 * Stripe-first and treats an already-canceled subscription as success.
 *
 * On success: clear the pending flag, email the truthful confirmation, resolve
 * the recovery case IF the cancellation is now fully settled, delete the claim.
 * On failure: keep the claim as the live command (never delete it) with the
 * error and a next-attempt time, open/re-open the FINANCE PLAN_CANCELLATION_
 * RECOVERY case (the customer-visible safe resume path), page the office, and
 * return PENDING — so a process death or provider outage can never strand the
 * request, and the customer is never asked to retry.
 */
async function driveHeldCancellation(
  stripe: Stripe,
  plan: CancellablePlan,
  ctx: {
    requestedAt: string;
    reason: string | null;
    attemptCount: number;
    /** The exclusive holder nonce — every command write below is fenced on it. */
    nonce: string;
  }
): Promise<CustomerCancelOutcome> {
  const client = await dataClient();
  const servicePlanId = plan.id;

  // Record the instruction durably BEFORE touching the provider.
  try {
    await client.models.ServicePlan.update({
      id: servicePlanId,
      cancellationPending: true,
      cancellationRequestedAt: ctx.requestedAt,
      cancellationReason: ctx.reason ?? undefined,
    });
  } catch (flagErr) {
    console.error(
      `driveHeldCancellation: could not pre-record pending cancel on ${servicePlanId}`,
      flagErr
    );
  }

  let result: {
    stripeSubscriptionCanceled: boolean;
    queuedVisits: QueuedVisitsResolution;
  };
  try {
    result = await cancelPlanBilling(stripe, servicePlanId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`driveHeldCancellation failed for plan ${servicePlanId}`, err);

    const workId = await openOwnedWork({
      kind: "PLAN_CANCELLATION_RECOVERY",
      dedupeKey: servicePlanId,
      title: `Finish a customer's plan cancellation: ${plan.planName}`,
      detail: `A customer confirmed canceling plan ${servicePlanId} (${plan.planName}) on ${ctx.requestedAt}, but it could not be completed: ${message}. Billing may still be live and the plan may still be ACTIVE. Auto-resume attempt ${ctx.attemptCount + 1}.${ctx.reason ? ` Reason they gave: "${ctx.reason}".` : ""}`,
      customerId: plan.customerId,
      relatedId: servicePlanId,
      sourceUrl: `/customers/${plan.customerId}`,
      resolutionAction:
        "Resume the cancellation (it's idempotent and safe to re-run). It can't be closed until billing is stopped, the plan is canceled, every visit is dispositioned, any charge since the request is refunded, and the customer has the final word.",
      ownerTeam: "FINANCE",
    });

    // The claim IS the durable command — do NOT delete it. Record the failure and
    // when to auto-resume, so the sweep re-drives it and the customer never has
    // to retry.
    const kept = await casFencedUpdate(
      "PlanCancellationClaim",
      servicePlanId,
      { field: "leaseNonce", nonce: ctx.nonce },
      {
        stage: "FAILED",
        lastError: message,
        attemptCount: ctx.attemptCount + 1,
        nextAttemptAt: new Date(Date.now() + CANCELLATION_RETRY_MS).toISOString(),
        customerId: plan.customerId,
        ownerTeam: "FINANCE",
        ...(workId ? { recoveryWorkItemId: workId } : {}),
        // Release the lease with the failure recorded, so the sweep's resume
        // reclaims at nextAttemptAt instead of waiting out a dead lease.
        leaseUntil: null,
      }
    );
    if (!kept.ok && kept.reason === "UNSUPPORTED") {
      await client.models.PlanCancellationClaim.update({
        id: servicePlanId,
        stage: "FAILED",
        lastError: message,
        attemptCount: ctx.attemptCount + 1,
        nextAttemptAt: new Date(Date.now() + CANCELLATION_RETRY_MS).toISOString(),
        customerId: plan.customerId,
        ownerTeam: "FINANCE",
        leaseUntil: null,
        ...(workId ? { recoveryWorkItemId: workId } : {}),
      }).catch((updateErr) =>
        console.error(
          `driveHeldCancellation: could not update the cancellation command on ${servicePlanId}`,
          updateErr
        )
      );
    }

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
      bodyHtml: `<p><strong>${name}</strong> confirmed canceling their plan <strong>${plan.planName}</strong>, but it did not go through. <strong>The plan may still be ACTIVE and the card still on subscription.</strong> We'll keep retrying automatically, but please finish it now.</p>
         <p><strong>Cancel it by hand</strong> — they have been told we're finishing it, and another monthly charge must not post.</p>
         <p style="color:#666;font-size:13px;">Plan: ${servicePlanId}<br/>Error: ${message}</p>`,
    });

    return { status: "PENDING", requestedAt: ctx.requestedAt, message: PENDING_CANCEL_MESSAGE };
  }

  // Canceled at the provider + CRM. Record the confirmed phase on the durable
  // command before the remaining phases, so a process stop resumes from here
  // instead of re-running blind.
  await writeCancellationCommand(servicePlanId, ctx.nonce, {
    stage: "PROVIDER_STOPPED",
  });
  try {
    await client.models.ServicePlan.update({
      id: servicePlanId,
      cancellationPending: false,
      cancellationRequestedAt: ctx.requestedAt,
      cancellationReason: ctx.reason ?? undefined,
    });
  } catch (stampErr) {
    console.error(
      `driveHeldCancellation: cancel succeeded but reason/flag write failed on ${servicePlanId}`,
      stampErr
    );
  }

  return settleAfterDrive(stripe, plan, ctx, result.queuedVisits, {
    stripeSubscriptionCanceled: result.stripeSubscriptionCanceled,
    alreadyCanceled: false,
  });
}

/** Build the customer-facing summary from the ACTUAL visit resolution. */
function summaryOfResolution(r: QueuedVisitsResolution): VisitResolutionSummary {
  return {
    stopped: r.canceled.length,
    failed: r.failed.length,
    failedDates: r.failed.map((v) => v.scheduledDate ?? null),
    refundsOwed: (r.refundsOwed ?? []).map((v) => ({
      date: v.scheduledDate ?? null,
      amountCents: v.amountCents,
    })),
    retained: (r.retained ?? []).map((v) => ({
      date: v.scheduledDate ?? null,
      amountCents: v.amountCents,
    })),
    pendingDecisions: r.needsDecision.length,
  };
}

/**
 * GL-08 — the shared back half of every drive/repair: send (or adopt) the
 * confirmation, prove settlement against Stripe + CRM, and land the durable
 * command on a PERSISTED terminal — stage COMPLETE with the outcome/result
 * kept as the readable record when settled, or AWAITING_SETTLEMENT with an
 * owned Finance case and a next-attempt time when anything (visit sweep, a
 * late charge's full refund, an in-flight payment, the provider record) is
 * still unfinished. The command is never deleted: the row IS the persisted
 * outcome, and nothing reads Complete while a phase is missing.
 */
async function settleAfterDrive(
  stripe: Stripe,
  plan: CancellablePlan,
  ctx: { requestedAt: string; attemptCount: number; nonce: string },
  resolution: QueuedVisitsResolution,
  flags: { stripeSubscriptionCanceled: boolean; alreadyCanceled: boolean }
): Promise<CustomerCancelOutcome> {
  const servicePlanId = plan.id;
  const summary = summaryOfResolution(resolution);
  const visitsStopped = resolution.canceled.length;
  const visitsRemaining = resolution.needsDecision.length + resolution.failed.length;

  const confirmationEmailed = await sendCancellationConfirmation(
    plan.customerId,
    servicePlanId,
    plan.planName,
    summary
  );
  if (confirmationEmailed) {
    await writeCancellationCommand(servicePlanId, ctx.nonce, {
      stage: "NOTICE_SENT",
    });
  }

  // Settlement is proved against the provider AND the CRM; the verified close
  // and this auto-resolve share the one check so they can never disagree.
  const settled = await planCancellationSettled(servicePlanId, { stripe });
  if (settled.settled && confirmationEmailed) {
    await resolveOwnedWork({
      kind: "PLAN_CANCELLATION_RECOVERY",
      dedupeKey: servicePlanId,
      note: "Cancellation completed — provider stopped, visits cleared, late charges refunded, and the customer notified.",
    }).catch(() => undefined);
    await writeCancellationCommand(servicePlanId, ctx.nonce, {
      stage: "COMPLETE",
      outcome: "COMPLETE",
      resultJson: JSON.stringify({
        visitsStopped,
        visitsRemaining,
        refundsOwed: summary.refundsOwed,
        retained: summary.retained,
        confirmationEmailed,
        settled: true,
      }),
      lastError: null,
      leaseUntil: null,
    });
  } else {
    // NOT terminal: the schedule, a money outcome, the provider record, or
    // the customer notice is unfinished. The command stays open (resumable at
    // nextAttemptAt) and the residual is OWNED — never a quiet green.
    const residual = !confirmationEmailed
      ? `${settled.settled ? "" : `${settled.reason} `}The cancellation confirmation has not reached the provider yet.`
      : settled.reason;
    await openOwnedWork({
      kind: "PLAN_CANCELLATION_RECOVERY",
      dedupeKey: servicePlanId,
      title: `Finish settling a canceled plan: ${plan.planName}`,
      detail: `Plan ${servicePlanId} (${plan.planName}) is canceled but not fully settled: ${residual}`,
      customerId: plan.customerId,
      relatedId: servicePlanId,
      sourceUrl: `/customers/${plan.customerId}`,
      resolutionAction:
        "Resume the cancellation (idempotent) or finish the named residual by hand — it can't close until Stripe and the CRM both read settled and the customer has the final word.",
      ownerTeam: "FINANCE",
    });
    await writeCancellationCommand(servicePlanId, ctx.nonce, {
      stage: "AWAITING_SETTLEMENT",
      lastError: residual,
      attemptCount: ctx.attemptCount + 1,
      nextAttemptAt: new Date(Date.now() + CANCELLATION_RETRY_MS).toISOString(),
      leaseUntil: null,
    });
  }

  // GL-08 R3/R6: every claim in the message is derived from the real
  // resolution and the per-visit 72-hour outcomes — all from the one policy
  // builder shared with the confirmation email.
  const message = planCanceledSuccessMessage(summary, { confirmationEmailed });

  return {
    status: "CANCELED",
    alreadyCanceled: flags.alreadyCanceled,
    stripeSubscriptionCanceled: flags.stripeSubscriptionCanceled,
    visitsStopped,
    visitsRemaining,
    confirmationEmailed,
    settled: settled.settled,
    message,
  };
}

/** A fenced command write: lands only while the nonce is still ours. Without
 *  CAS wiring (unit fakes / deploy straddling) takeover is disabled, so the
 *  plain single-holder write is the safe fallback. */
async function writeCancellationCommand(
  servicePlanId: string,
  nonce: string,
  sets: Record<string, string | number | boolean | null>
): Promise<void> {
  const res = await casFencedUpdate(
    "PlanCancellationClaim",
    servicePlanId,
    { field: "leaseNonce", nonce },
    sets
  );
  if (res.ok || res.reason === "LOST") return;
  const client = await dataClient();
  await client.models.PlanCancellationClaim
    .update({ id: servicePlanId, ...sets } as never)
    .catch(() => undefined);
}

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
  // canceled is a no-op success ONLY when the cancellation is fully settled.
  // A CANCELED plan with unfinished schedule/money/notice work is REPAIRED
  // (GL-08 R2) — already-canceled must not short-circuit the residuals.
  if (plan.status === "CANCELED") {
    const settled = await planCancellationSettled(servicePlanId, { stripe });
    if (settled.settled) return alreadyCanceledOutcome(true);
  }

  const requestedAt = new Date().toISOString();

  // GL-08 R1/R5: take the durable command. `create` is conditional on the id
  // (= plan id) not existing, so two simultaneous confirm clicks cannot both
  // drive a cancel. The loser does NOT just return pending: it tries to reclaim
  // an orphaned command (a prior attempt died mid-flight) so the customer's own
  // retry can finish the job rather than wedging on a stale claim forever.
  let nonce: string = randomUUID();
  const { data: claim } = await client.models.PlanCancellationClaim.create({
    id: servicePlanId,
    requestedAt,
    stage: "REQUESTED",
    ownerTeam: "FINANCE",
    attemptCount: 0,
    customerId: plan.customerId,
    note: reason ?? undefined,
    // GL-08 R3: the provider reference rides the durable command, so the
    // settlement readback survives the plan clearing its own id.
    stripeSubscriptionId: plan.stripeSubscriptionId ?? undefined,
    leaseNonce: nonce,
    leaseUntil: new Date(Date.now() + CANCELLATION_LEASE_MS).toISOString(),
  });
  let attemptCount = 0;
  if (!claim) {
    const { data: current } = await client.models.ServicePlan.get({
      id: servicePlanId,
    });
    if (current?.status === "CANCELED") {
      const settled = await planCancellationSettled(servicePlanId, { stripe });
      if (settled.settled) return alreadyCanceledOutcome(true);
    }
    const reclaimed = await reclaimOrphanedCancellationClaim(servicePlanId);
    if (!reclaimed.won) {
      // A live attempt genuinely owns the command — report the truthful pending
      // state (never a second Stripe cancel).
      return { status: "PENDING", requestedAt, message: PENDING_CANCEL_MESSAGE };
    }
    attemptCount = reclaimed.attemptCount;
    nonce = reclaimed.nonce;
  }

  // Close the tiny window where another request flipped the plan CANCELED
  // between our first read and taking the command.
  const { data: afterClaim } = await client.models.ServicePlan.get({
    id: servicePlanId,
  });
  if (afterClaim?.status === "CANCELED") {
    // Flipped CANCELED under us — repair any residual under the claim we hold
    // (a settled plan settles the command COMPLETE inside the repair).
    return repairCanceledPlan(stripe, plan, {
      requestedAt,
      attemptCount,
      nonce,
    });
  }

  return driveHeldCancellation(stripe, plan, {
    requestedAt,
    reason,
    attemptCount,
    nonce,
  });
}

/**
 * Steal a stuck cancellation command so this caller can resume it. Mirrors
 * bookingFinalize.reclaimOrphanedClaim: a command whose next-attempt time hasn't
 * arrived still belongs to a live/paced attempt (do not steal); one that is old
 * or overdue is fair game. Returns whether we now hold it and the prior attempt
 * count, so history carries across the steal.
 */
/**
 * GL-08 R2 — repair a plan that already reads CANCELED but is not settled:
 * re-sweep residual visits (idempotent — canceled jobs are skipped, each
 * remaining one gets its 72-hour disposition), re-send or ADOPT the
 * confirmation, and re-prove settlement — landing the durable command on
 * COMPLETE only when Stripe and CRM agree and the customer has the word.
 * Caller must HOLD the command (nonce).
 */
async function repairCanceledPlan(
  stripe: Stripe,
  plan: CancellablePlan,
  ctx: { requestedAt: string; attemptCount: number; nonce: string }
): Promise<CustomerCancelOutcome> {
  const client = await dataClient();
  const resolution = await cancelQueuedPlanVisits(
    plan.id,
    "Plan cancellation repair — clearing residual visits"
  );
  await client.models.ServicePlan.update({
    id: plan.id,
    cancellationPending: false,
  }).catch(() => undefined);
  return settleAfterDrive(stripe, plan, ctx, resolution, {
    stripeSubscriptionCanceled: true,
    alreadyCanceled: true,
  });
}

async function reclaimOrphanedCancellationClaim(
  servicePlanId: string
): Promise<
  { won: true; attemptCount: number; nonce: string } | { won: false; attemptCount: number }
> {
  const client = await dataClient();
  const nonce = randomUUID();
  const { data: held } = await client.models.PlanCancellationClaim.get({
    id: servicePlanId,
  });
  if (!held) {
    const { data } = await client.models.PlanCancellationClaim.create({
      id: servicePlanId,
      requestedAt: new Date().toISOString(),
      stage: "REQUESTED",
      ownerTeam: "FINANCE",
      attemptCount: 0,
      leaseNonce: nonce,
      leaseUntil: new Date(Date.now() + CANCELLATION_LEASE_MS).toISOString(),
    });
    return data
      ? { won: true, attemptCount: 0, nonce }
      : { won: false, attemptCount: 0 };
  }
  const stampedMs = held.createdAt ? new Date(held.createdAt).getTime() : NaN;
  const readyMs = held.nextAttemptAt
    ? new Date(held.nextAttemptAt).getTime()
    : NaN;
  const nextArrived = Number.isNaN(readyMs) ? false : Date.now() >= readyMs;
  const old =
    Number.isNaN(stampedMs) || Date.now() - stampedMs >= CANCELLATION_ORPHAN_MS;
  // A young command whose retry time hasn't come belongs to a live attempt.
  if (!old && !nextArrived) return { won: false, attemptCount: held.attemptCount ?? 0 };
  // The actual steal is ONE guarded update conditioned on "no live lease" —
  // deciding "it looks orphaned" is advisory; only the CAS write makes exactly
  // one concurrent reclaimer the winner. A legacy pre-lease row has no
  // leaseUntil, which the guard treats as not-live, and the age checks above
  // already refused young rows.
  const takeover = await casTakeover("PlanCancellationClaim", servicePlanId, {
    nonceField: "leaseNonce",
    nonce,
    leaseField: "leaseUntil",
    leaseMs: CANCELLATION_LEASE_MS,
    refuseStages: { field: "stage", values: ["COMPLETE"] },
  });
  return takeover.ok
    ? { won: true, attemptCount: held.attemptCount ?? 0, nonce }
    : { won: false, attemptCount: held.attemptCount ?? 0 };
}

/**
 * Resume a stuck plan cancellation (GL-08 R1). The safe re-run the
 * PLAN_CANCELLATION_RECOVERY case prescribes and the same entry the reconcile
 * sweep calls. Idempotent: an already-canceled plan just clears its pending
 * flag, resolves the recovery case if fully settled, and deletes the command.
 *
 * `auto` (the sweep) respects the attempt cap and the next-attempt time so it
 * paces itself and eventually leaves a truly-stuck cancel to the human FINANCE
 * case; a person pressing "Resume" (auto=false) always drives immediately.
 */
export async function resumePlanCancellation(
  stripe: Stripe,
  servicePlanId: string,
  opts: { auto?: boolean } = {}
): Promise<CustomerCancelOutcome> {
  const client = await dataClient();
  const { data: plan } = await client.models.ServicePlan.get({
    id: servicePlanId,
  });
  if (!plan) throw new Error(`Service plan ${servicePlanId} not found`);

  // Already canceled AND fully settled (proved against Stripe + CRM): mark
  // the command COMPLETE if no live holder owns it, resolve the case, done.
  // NOT settled: fall through — the repair below re-drives the residuals
  // under the exclusive lease (GL-08 R2: CANCELED never short-circuits
  // unfinished schedule, money, or notice work).
  if (plan.status === "CANCELED") {
    const settled = await planCancellationSettled(servicePlanId, { stripe });
    if (settled.settled) {
      if (plan.cancellationPending) {
        await client.models.ServicePlan.update({
          id: servicePlanId,
          cancellationPending: false,
        }).catch(() => undefined);
      }
      await resolveOwnedWork({
        kind: "PLAN_CANCELLATION_RECOVERY",
        dedupeKey: servicePlanId,
        note: "Cancellation already complete on resume — nothing left to do.",
      }).catch(() => undefined);
      // Persist the terminal on the command if nobody live holds it — the
      // row IS the readable outcome, never deleted.
      await casGuardedUpdate(
        "PlanCancellationClaim",
        servicePlanId,
        { stage: "COMPLETE", outcome: "COMPLETE", leaseUntil: null },
        [
          {
            kind: "notLiveLease",
            field: "leaseUntil",
            nowIso: new Date().toISOString(),
          },
        ]
      );
      return alreadyCanceledOutcome(true);
    }
  }

  // Ensure we hold the command (create it if a hard kill left none).
  const { data: existing } = await client.models.PlanCancellationClaim.get({
    id: servicePlanId,
  });
  const attemptCount = existing?.attemptCount ?? 0;
  // Backfill order matters: canceledAt (stamped when billing actually
  // stopped) comes before "now" — resuming days later must not re-date the
  // cancellation to AFTER a charge that already posted, or that charge is
  // judged pre-request forever and never refunded.
  const requestedAt =
    existing?.requestedAt ??
    plan.cancellationRequestedAt ??
    (plan as { canceledAt?: string | null }).canceledAt ??
    new Date().toISOString();

  let nonce: string = randomUUID();
  if (!existing) {
    const { data: freshClaim } = await client.models.PlanCancellationClaim.create({
      id: servicePlanId,
      requestedAt,
      stage: "REQUESTED",
      ownerTeam: "FINANCE",
      attemptCount,
      customerId: plan.customerId,
      stripeSubscriptionId:
        plan.stripeSubscriptionId ??
        (plan as { canceledStripeSubscriptionId?: string | null })
          .canceledStripeSubscriptionId ??
        undefined,
      leaseNonce: nonce,
      leaseUntil: new Date(Date.now() + CANCELLATION_LEASE_MS).toISOString(),
    }).catch(() => ({ data: null }));
    if (!freshClaim) {
      // Lost the create to a racing attempt — it owns the drive now.
      return { status: "PENDING", requestedAt, message: PENDING_CANCEL_MESSAGE };
    }
  } else {
    if (opts.auto) {
      // Auto-resume pacing: don't re-drive before the next-attempt time, and stop
      // auto-retrying past the cap (the FINANCE case is already open for a human).
      const readyMs = existing.nextAttemptAt
        ? new Date(existing.nextAttemptAt).getTime()
        : 0;
      if (Number.isFinite(readyMs) && Date.now() < readyMs) {
        return { status: "PENDING", requestedAt, message: PENDING_CANCEL_MESSAGE };
      }
      if (attemptCount >= MAX_CANCELLATION_RESUME_ATTEMPTS) {
        return { status: "PENDING", requestedAt, message: PENDING_CANCEL_MESSAGE };
      }
    }
    // A resume is an exclusive holder like any other attempt: seize the lease
    // with ONE guarded update. While another attempt's lease is live (including
    // a human racing the sweep) this loses and reports pending — never two
    // concurrent drives of the same cancellation.
    const takeover = await casTakeover("PlanCancellationClaim", servicePlanId, {
      nonceField: "leaseNonce",
      nonce,
      leaseField: "leaseUntil",
      leaseMs: CANCELLATION_LEASE_MS,
      refuseStages: { field: "stage", values: ["COMPLETE"] },
    });
    if (!takeover.ok) {
      if (takeover.reason === "LOST") {
        return { status: "PENDING", requestedAt, message: PENDING_CANCEL_MESSAGE };
      }
      // UNSUPPORTED (unit fakes / straddling): takeover is impossible for
      // everyone, so the pacing checks above are the only serialization — keep
      // the legacy single-holder assumption there.
      nonce = existing.leaseNonce ?? nonce;
    }
  }

  if (plan.status === "CANCELED") {
    return repairCanceledPlan(stripe, plan, { requestedAt, attemptCount, nonce });
  }
  return driveHeldCancellation(stripe, plan, {
    requestedAt,
    reason: plan.cancellationReason ?? existing?.note ?? null,
    attemptCount,
    nonce,
  });
}

/** The durable "you're canceled" email — logged against the PLAN id so a
 *  repair can ADOPT a proven prior send instead of emailing twice. Its own
 *  failure becomes owned EMAIL_FAILURE work inside sendEmail — the
 *  cancellation still stands (but the command stays open until it lands). */
async function sendCancellationConfirmation(
  customerId: string,
  servicePlanId: string,
  planName: string,
  summary: VisitResolutionSummary
): Promise<boolean> {
  const client = await dataClient();
  // Outbox adoption: a prior accepted send for THIS plan satisfies the
  // promise — a resume/repair must not email the customer twice.
  try {
    if ("EmailLog" in client.models) {
      const { data: prior } = await client.models.EmailLog.listEmailLogByRelatedId(
        { relatedId: servicePlanId },
        { limit: 50 }
      );
      const accepted = (prior ?? []).some(
        (l) =>
          l.template === "plan-canceled" &&
          (l.deliveryStatus === "SENT" || l.deliveryStatus === "DELIVERED")
      );
      if (accepted) return true;
    }
  } catch (err) {
    console.error("sendCancellationConfirmation: prior-send check failed", err);
  }
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

  // GL-08 R3/R6: the email body is generated from the ACTUAL resolution — the
  // recurring-visits sentence is conditional on whether any removal failed,
  // each paid visit carries its exact server-calculated 72-hour money outcome
  // (refund in full or retained — never a choice, never credit), and a failed
  // removal is named as a visit we still need to take off (never "prepaid") —
  // so the email can never say every visit stopped while one remains.
  const html = emailShell(
    "Your plan is canceled",
    confirmationEmailBodyHtml(planName, summary)
  );

  return sendEmail({
    to,
    subject: "Your BuzzKill plan is canceled",
    template: "plan-canceled",
    customerId,
    relatedId: servicePlanId,
    html,
  });
}
