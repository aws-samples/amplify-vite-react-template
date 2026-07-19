import type Stripe from "stripe";
import { randomUUID } from "node:crypto";
import { dataClient } from "./dataClient";
import {
  casTakeover,
  casFencedUpdate,
  casFencedDelete,
  casGuardedDelete,
} from "./atomicLock";
import { emailShell, sendEmail } from "./email";
import { openOwnedWork, resolveOwnedWork } from "./ownedWork";
import { refundInvoice, refundableRemaining } from "./refund";
import { assertTechnicianCompliance } from "./compliance";
import { licenseFactsFor } from "./licenses";
import { releaseMonthForJob } from "./obligations";
import {
  releaseScheduledMinutes,
  reserveScheduledMinutes,
  visitMinutes,
} from "./capacity";
import {
  computeVisitCancellationPolicy,
  type VisitCancellationPolicy,
} from "./cancellationPolicy";

/** A visit-change command older than this, with its next-attempt time passed (or
 *  never set), belongs to a dead attempt the reconcile sweep or a retry may
 *  resume. */
const VISIT_CHANGE_ORPHAN_MS = 10 * 60_000;

/** How long one attempt may hold the visit-change command's exclusive lease. */
const VISIT_CHANGE_LEASE_MS = 5 * 60_000;
/** After a failed attempt the sweep won't auto-resume before this. */
const VISIT_CHANGE_RETRY_MS = 15 * 60_000;
/** After this many failed AUTO resumes the sweep stops re-driving and leaves it
 *  to the already-open recovery case; a person can always resume by hand. */
export const MAX_VISIT_CHANGE_RESUME_ATTEMPTS = 5;

/**
 * GL-07 — one safe office cancel/reschedule workflow for a single visit.
 *
 * The office used to change a visit's schedule state directly (updateJobSchedule
 * CANCEL/RESCHEDULE) with no money decision, no plan awareness, and no customer
 * notice. This module is the guided replacement: a read-only PREVIEW that shows
 * every consequence before the employee commits, and two EXECUTE actions that
 * perform all approved consequences as one fail-safe step and record an
 * immutable VisitChangeEvent.
 *
 * The money maths lives in cancellationPolicy (pure); the refund lives in
 * refund.refundInvoice (idempotent, ledger-correct). This module orchestrates
 * them, keeps the plan out of it (canceling a visit never cancels the plan), and
 * — the important part — turns any partial failure into an owned exception and a
 * truthful PARTIAL outcome instead of a false "done".
 *
 * Every function creates its own data client rather than passing one across a
 * boundary: naming the V6 client's type across a function signature trips tsc's
 * inference-depth ceiling (TS2321), the same reason crm-admin's reassignFutureJobs
 * does.
 */

// The per-technician daily stop capacity — one route is one technician-day of
// capacity. Kept in step with booking-public/availability.ts (STOPS_PER_TECH).
export const STOPS_PER_TECH = 8;

export type VisitChangeActor = {
  sub: string | null;
  email: string | null;
  isOwner: boolean;
};

/** The plain business decisions the office may pick. Amounts are never typed —
 *  the server derives them from policy. ("Keep as account credit" was removed
 *  for launch: it promised a balance with no real credit ledger behind it. Cancel
 *  offers refund-to-card, an owner manager exception, or a policy fee-retained.) */
export type CancelDecision = "CANCEL_REFUND";

const todayEastern = (): string =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

const usd = (cents: number): string =>
  `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

type JobRow = {
  id: string;
  customerId: string;
  servicePlanId?: string | null;
  serviceType: string;
  status: string;
  scheduledDate?: string | null;
  timeWindow?: string | null;
  priceCents?: number | null;
  routeId?: string | null;
  technicianId?: string | null;
  paidAt?: string | null;
  propertyClass?: string | null;
  dispatchDriveMinutes?: number | null;
};

type InvoiceRow = {
  id: string;
  amountCents: number;
  status: string | null;
  refundedAmountCents?: number | null;
  stripePaymentIntentId?: string | null;
};

/** Page every invoice attached to a job — a filtered scan counts its limit
 *  against rows scanned, so it must be paged to be sure the paid one is seen. */
async function invoicesForJob(jobId: string): Promise<InvoiceRow[]> {
  const client = await dataClient();
  const rows: InvoiceRow[] = [];
  let token: string | null | undefined;
  do {
    const page = await client.models.Invoice.list({
      filter: { jobId: { eq: jobId } },
      nextToken: token,
      limit: 200,
    });
    rows.push(...(page.data as InvoiceRow[]));
    token = page.nextToken;
  } while (token);
  return rows;
}

/** GL-07 R2: EVERY refundable paid invoice and EVERY open/unpaid invoice on
 *  the visit — a cancel reconciles all of them, never only the first of each. */
function classifyInvoices(invoices: InvoiceRow[]) {
  const paidList = invoices.filter(
    (inv) =>
      (inv.status === "PAID" || inv.status === "REFUNDED") &&
      refundableRemaining(inv) > 0
  );
  const openList = invoices.filter(
    (inv) => inv.status === "OPEN" || inv.status === "FAILED"
  );
  return { paidList, openList };
}

function amountPaidFor(job: JobRow, paidList: InvoiceRow[]): number {
  const total = paidList.reduce((sum, inv) => sum + refundableRemaining(inv), 0);
  if (total > 0) return total;
  // Booking writes paidAt in the same create as the job, so it is the
  // authoritative "already paid" even if the invoice row is missing.
  if (job.paidAt && job.priceCents && job.priceCents > 0) return job.priceCents;
  return 0;
}

const CHANGEABLE = new Set(["SCHEDULED", "UNSCHEDULED"]);

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

export type VisitChangePreview = {
  jobId: string;
  customerId: string;
  customerName: string;
  customerEmail: string | null;
  serviceType: string;
  scheduledDate: string | null;
  timeWindow: string | null;
  status: string;
  /** False when the visit is IN_PROGRESS/COMPLETED/terminal — nothing to change. */
  changeable: boolean;
  alreadyCanceled: boolean;
  amountPaidCents: number;
  amountOpenCents: number;
  policy: VisitCancellationPolicy;
  /** The disposition each decision would produce, computed from policy so the
   *  office reads a number rather than working one out. */
  decisions: {
    reschedule: { available: boolean; description: string };
    cancelRefund: { available: boolean; amountCents: number; description: string };
  };
  planConsequence: string;
  routeConsequence: string;
  noticePreview: string;
};

export async function buildVisitChangePreview(
  jobId: string
): Promise<VisitChangePreview> {
  const client = await dataClient();
  const { data: job } = await client.models.Job.get({ id: jobId });
  if (!job) throw new Error(`Job ${jobId} not found`);

  const [{ data: customer }, invoices] = await Promise.all([
    client.models.Customer.get({ id: job.customerId }),
    invoicesForJob(jobId),
  ]);

  const { paidList } = classifyInvoices(invoices);
  const amountPaidCents = amountPaidFor(job as JobRow, paidList);
  const amountOpenCents = invoices
    .filter((inv) => inv.status === "OPEN" || inv.status === "FAILED")
    .reduce((sum, inv) => sum + (inv.amountCents ?? 0), 0);

  const policy = computeVisitCancellationPolicy({
    scheduledDate: job.scheduledDate ?? null,
    amountPaidCents,
    today: todayEastern(),
    nowMs: Date.now(),
    timeWindow: job.timeWindow ?? null,
  });

  let planConsequence =
    "This is a one-time visit — no recurring plan is affected.";
  if (job.servicePlanId) {
    const { data: plan } = await client.models.ServicePlan.get({
      id: job.servicePlanId,
    });
    const planName = plan?.planName ?? "the plan";
    planConsequence = `This is a visit on the ${planName} plan. Canceling this one visit does NOT cancel the plan — the plan keeps running and its next visit is unaffected. Cancel the plan itself only from the plan's own Cancel button.`;
  }

  const routeConsequence =
    job.routeId || job.technicianId
      ? "This visit will come off its assigned route and the technician's day, freeing that slot."
      : "This visit isn't on a route yet, so nothing on the schedule board changes.";

  const changeable = CHANGEABLE.has(job.status);
  const alreadyCanceled = job.status === "CANCELED";

  const refundLine =
    amountPaidCents === 0
      ? "Nothing was paid, so no money moves — the visit simply comes off the schedule."
      : policy.withinFreeWindow
        ? `Refund ${usd(policy.refundableCents)} to the card on file.`
        : `The visit is within 72 hours of its start, so the ${usd(policy.feeCents)} paid is retained per the cancellation policy — no refund, and no account credit.`;

  return {
    jobId,
    customerId: job.customerId,
    customerName: customer?.displayName ?? job.customerId,
    customerEmail: customer?.email ?? null,
    serviceType: job.serviceType,
    scheduledDate: job.scheduledDate ?? null,
    timeWindow: job.timeWindow ?? null,
    status: job.status,
    changeable,
    alreadyCanceled,
    amountPaidCents,
    amountOpenCents,
    policy,
    decisions: {
      reschedule: {
        available: changeable,
        description:
          "Move this visit to a new date. We revalidate capacity and the technician's license, update the route, and email the customer the old and new details. No money moves.",
      },
      cancelRefund: {
        available: changeable,
        amountCents: policy.refundableCents,
        description: refundLine,
      },
    },
    planConsequence,
    routeConsequence,
    noticePreview:
      amountPaidCents > 0
        ? `We'll email ${customer?.displayName ?? "the customer"} that their ${job.serviceType} visit${job.scheduledDate ? ` on ${job.scheduledDate}` : ""} is canceled, with the exact refund amount — or that the payment is retained under the 72-hour policy.`
        : `We'll email ${customer?.displayName ?? "the customer"} that their ${job.serviceType} visit${job.scheduledDate ? ` on ${job.scheduledDate}` : ""} is canceled.`,
  };
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

type Disposition = "REFUND" | "FEE_RETAINED" | "NONE";

/**
 * Write one immutable audit row (GL-07 R6). The change itself is already durably
 * applied, so we do NOT throw and invite a double-applying retry — but a lost
 * audit row is a real gap in a record Ops and Finance rely on, so a write failure
 * opens a blocking VISIT_CHANGE_RECOVERY owned case (the change stands; the
 * missing history is now owned, visible, and owed a fix) instead of only logging.
 * Returns whether the row landed. Mirrors lifecycleLog.recordCustomerLifecycleEvent.
 */
async function recordVisitChangeEvent(input: {
  jobId: string;
  customerId: string;
  action: "CANCEL" | "RESCHEDULE";
  decision?: string | null;
  actor: VisitChangeActor;
  reason?: string | null;
  policyUsed?: string | null;
  amountCents?: number | null;
  disposition?: Disposition | null;
  refundStripeId?: string | null;
  priorScheduledDate?: string | null;
  newScheduledDate?: string | null;
  communicationResult: string;
  effects: string;
  outcome: string;
}): Promise<{ recorded: boolean }> {
  const occurredAt = new Date().toISOString();
  try {
    const client = await dataClient();
    const { data, errors } = await client.models.VisitChangeEvent.create({
      jobId: input.jobId,
      customerId: input.customerId,
      action: input.action,
      decision: input.decision ?? undefined,
      actorSub: input.actor.sub ?? undefined,
      actorEmail: input.actor.email ?? "system",
      reason: input.reason ?? undefined,
      policyUsed: input.policyUsed ?? undefined,
      amountCents: input.amountCents ?? undefined,
      disposition: input.disposition ?? undefined,
      refundStripeId: input.refundStripeId ?? undefined,
      priorScheduledDate: input.priorScheduledDate ?? undefined,
      newScheduledDate: input.newScheduledDate ?? undefined,
      communicationResult: input.communicationResult,
      effects: input.effects,
      outcome: input.outcome,
      occurredAt,
    });
    if (!data) {
      throw new Error(errors?.map((e) => e.message).join("; ") || "no row returned");
    }
    return { recorded: true };
  } catch (err) {
    console.error(
      `Failed to record visit change event (${input.action} on ${input.jobId}) — the change was applied; the audit row was not`,
      err
    );
    try {
      await openOwnedWork({
        kind: "VISIT_CHANGE_RECOVERY",
        dedupeKey: `visit-change-audit:${input.jobId}:${occurredAt}`,
        title: `Reconstruct a missing visit-change record: ${input.jobId}`,
        detail: `A ${input.action} on visit ${input.jobId} was applied (${input.effects}) by ${input.actor.email ?? "system"} at ${occurredAt}, but the audit row failed to write, so this change is missing from the visit-change history.`,
        customerId: input.customerId,
        relatedId: input.jobId,
        sourceUrl: `/customers/${input.customerId}`,
        resolutionAction:
          "Confirm the visit's money, schedule, and customer notice match the intended change, reconstruct the missing visit-change audit entry, then close.",
        ownerTeam: "FINANCE",
      });
    } catch (workErr) {
      console.error(
        `Failed to open VISIT_CHANGE_RECOVERY for the lost audit row on ${input.jobId}`,
        workErr
      );
    }
    return { recorded: false };
  }
}

/** Send the customer their cancellation/reschedule notice and report the
 *  result. A missing email becomes owned MISSING_CONTACT work; a send failure is
 *  already owned as EMAIL_FAILURE by sendEmail. Never throws — a failed notice
 *  is owned, it does not undo the change. */
async function notifyCustomer(opts: {
  customerId: string;
  customerName: string;
  email: string | null;
  subject: string;
  html: string;
  template: string;
  relatedId: string;
  missingContactContext: string;
}): Promise<"SENT" | "FAILED" | "NO_EMAIL"> {
  const to = opts.email?.trim();
  if (!to) {
    await openOwnedWork({
      kind: "MISSING_CONTACT",
      dedupeKey: `visit-change-notice:${opts.relatedId}`,
      title: `Reach ${opts.customerName} about a visit change`,
      detail: opts.missingContactContext,
      customerId: opts.customerId,
      relatedId: opts.relatedId,
      sourceUrl: `/customers/${opts.customerId}`,
      resolutionAction:
        "Add and verify an email or phone, tell the customer about the change, and record how they were reached.",
      ownerTeam: "OPS",
    });
    return "NO_EMAIL";
  }
  const sent = await sendEmail({
    to,
    subject: opts.subject,
    html: opts.html,
    template: opts.template,
    customerId: opts.customerId,
    relatedId: opts.relatedId,
  });
  return sent ? "SENT" : "FAILED";
}

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

export type VisitCancelOutcome = {
  jobId: string;
  action: "CANCEL";
  decision: CancelDecision;
  canceled: boolean;
  alreadyCanceled: boolean;
  disposition: Disposition;
  refundedCents: number;
  invoiceVoided: boolean;
  communicationResult: "SENT" | "FAILED" | "NO_EMAIL" | "PENDING";
  /** COMPLETE — done and the customer was told. PARTIAL — done but the notice is
   *  owned. PENDING — a charge is still processing, so the money state is not yet
   *  final and the visit change is owned through settlement (R3). */
  outcome: "COMPLETE" | "PARTIAL" | "PENDING";
  message: string;
};

/**
 * Cancel one visit as a single guided action, under a durable single-winner
 * command (GL-07 R1/R2): validate, take the VisitChangeClaim (id = jobId) BEFORE
 * any money/schedule change, then drive the ordered consequences. A concurrent
 * cancel loses the claim; a hard stop is resumable from the last completed step
 * and can never refund twice. Canceling a visit never touches the recurring plan.
 */
export async function cancelVisit(
  stripe: Stripe,
  args: {
    jobId: string;
    decision: CancelDecision;
    reason?: string | null;
    actor: VisitChangeActor;
  }
): Promise<VisitCancelOutcome> {
  const client = await dataClient();
  const { data: job } = await client.models.Job.get({ id: args.jobId });
  if (!job) throw new Error(`Job ${args.jobId} not found`);

  // R7 idempotent replay: a second confirm on an already-canceled visit returns
  // the STORED outcome from the audit ledger — never a fabricated SENT/COMPLETE.
  if (job.status === "CANCELED") return storedCancelOutcome(job.id, args.decision);
  if (!CHANGEABLE.has(job.status)) {
    throw new Error(
      `This visit is ${job.status.toLowerCase().replace(/_/g, " ")} — it can't be canceled here. Only a scheduled or unscheduled visit can be canceled.`
    );
  }

  const reason = args.reason?.trim();
  if (!reason) throw new Error("A reason is required to cancel a visit.");

  // R1: take the single-winner durable command BEFORE any money/schedule change.
  let nonce: string = randomUUID();
  const { data: claim } = await client.models.VisitChangeClaim.create({
    id: job.id,
    action: "CANCEL",
    decision: args.decision,
    reason,
    stage: "REQUESTED",
    ownerTeam: "FINANCE",
    requestedAt: new Date().toISOString(),
    attemptCount: 0,
    customerId: job.customerId,
    leaseNonce: nonce,
    leaseUntil: new Date(Date.now() + VISIT_CHANGE_LEASE_MS).toISOString(),
  });
  if (!claim) {
    // A live attempt holds the command — seize it only if its lease is dead
    // (ONE guarded update; exactly one racer wins), else report in-progress
    // rather than driving a second refund.
    const reclaimed = await reclaimOrphanedVisitChange(job.id);
    if (!reclaimed.won) return inProgressCancelOutcome(job.id, args.decision);
    nonce = reclaimed.nonce;
  }

  return driveHeldVisitCancel(stripe, job as JobRow, {
    decision: args.decision,
    reason,
    actor: args.actor,
    nonce,
  });
}

/**
 * Drive a cancellation to a terminal outcome, assuming this caller HOLDS the
 * command. Reads the command's stage so a resume SKIPS a refund that already went
 * out (R2: never twice, never a refunded-but-scheduled visit). On any step
 * failure it KEEPS the command (records stage/error/next-attempt) and opens an
 * owned recovery case; on a clean terminal it deletes the command. A charge still
 * PROCESSING makes the outcome PENDING — the money is owned through settlement,
 * never reported as a finished state (R3).
 */
async function driveHeldVisitCancel(
  stripe: Stripe,
  job: JobRow,
  args: {
    decision: CancelDecision;
    reason: string;
    actor: VisitChangeActor;
    /** The exclusive holder nonce — every command write below is fenced on it. */
    nonce: string;
  }
): Promise<VisitCancelOutcome> {
  const client = await dataClient();
  const jobId = job.id;
  const { decision, reason, actor, nonce } = args;
  const { data: claim } = await client.models.VisitChangeClaim.get({ id: jobId });
  const attemptCount = claim?.attemptCount ?? 0;
  const moneyDone = ["MONEY_DONE", "VOIDED", "CANCELED"].includes(
    String(claim?.stage ?? "")
  );

  const [{ data: customer }, invoices] = await Promise.all([
    client.models.Customer.get({ id: job.customerId }),
    invoicesForJob(jobId),
  ]);
  const { paidList, openList } = classifyInvoices(invoices);
  const amountPaidCents = amountPaidFor(job, paidList);
  // GL-07 R6: hour-exact, judged from the FIRST accepted request (the durable
  // command's requestedAt) so a resume gets the same answer the customer was
  // entitled to — an outage never moves them across the 72-hour line.
  const requestedMs = claim?.requestedAt
    ? Date.parse(String(claim.requestedAt))
    : Date.now();
  const policy = computeVisitCancellationPolicy({
    scheduledDate: job.scheduledDate ?? null,
    amountPaidCents,
    today: todayEastern(),
    nowMs: Number.isFinite(requestedMs) ? requestedMs : Date.now(),
    timeWindow: job.timeWindow ?? null,
  });

  // GL-07 R6: the SERVER-calculated 72-hour amount is the only refund — no
  // owner override, no arbitrary amount, and never account credit.
  const refundTarget = decision === "CANCEL_REFUND" ? policy.refundableCents : 0;

  let disposition: Disposition = "NONE";
  if (refundTarget > 0) disposition = "REFUND";
  else if (policy.feeCents > 0) disposition = "FEE_RETAINED";

  const policyUsed = policy.withinFreeWindow
    ? "Full-refund window"
    : "Late cancel — no refund (72-hour policy)";

  const custName = customer?.displayName ?? job.customerId;
  const dateSuffix = job.scheduledDate ? ` on ${job.scheduledDate}` : "";
  // Keep the command on a failure so the reconcile sweep / a retry resumes from
  // here — never deleting it, unlike a clean terminal.
  const keepFailed = async (
    stage: string,
    error: string,
    workId: string | null,
    extra: Record<string, string | number | boolean | null> = {}
  ) => {
    await writeVisitChangeClaim(jobId, nonce, {
      stage,
      lastError: error,
      attemptCount: attemptCount + 1,
      nextAttemptAt: new Date(Date.now() + VISIT_CHANGE_RETRY_MS).toISOString(),
      ...(workId ? { recoveryWorkItemId: workId } : {}),
      ...extra,
      // Release the lease with the failure recorded, so a resume reclaims at
      // nextAttemptAt instead of waiting out a dead holder's lease.
      leaseUntil: null,
    });
  };

  // 1. Money first — skipped on a resume where it already went out.
  let refundStripeId: string | null = claim?.refundStripeId ?? null;
  let refundedCents = moneyDone ? (claim?.refundedCents ?? 0) : 0;
  if (!moneyDone && refundTarget > 0) {
    if (paidList.length === 0) {
      const workId = await openOwnedWork({
        kind: "VISIT_CHANGE_RECOVERY",
        dedupeKey: `visit-change:${jobId}`,
        title: `Refund a paid visit by hand: ${custName}`,
        detail: `A ${usd(amountPaidCents)} refund is owed for canceling ${job.serviceType}${dateSuffix}, but no paid invoice was found to refund against. The visit was NOT canceled.`,
        customerId: job.customerId,
        relatedId: jobId,
        sourceUrl: `/customers/${job.customerId}`,
        resolutionAction:
          "Find the payment in Stripe, refund it, record the invoice, then resume the visit change.",
        ownerTeam: "FINANCE",
      });
      await keepFailed("REQUESTED", "No paid invoice found to refund against.", workId);
      throw new Error(
        `A refund is owed but no paid invoice was found for this visit — an operations case was opened. The visit was not canceled.`
      );
    }
    try {
      // GL-07 R2: the exact policy amount is reconciled across EVERY refundable
      // invoice on the visit — not only the first .find() hit. refundInvoice's
      // per-invoice running-total idempotency keeps a resumed drive exact.
      let remainingTarget = refundTarget;
      for (const paid of paidList) {
        if (remainingTarget <= 0) break;
        const slice = Math.min(remainingTarget, refundableRemaining(paid));
        if (slice <= 0) continue;
        const outcome = await refundInvoice(stripe, {
          invoiceId: paid.id,
          amountCents: slice,
          reason,
          actor: { sub: actor.sub, email: actor.email },
        });
        refundStripeId = outcome.stripeRefundId ?? refundStripeId;
        refundedCents += outcome.refundedNowCents;
        remainingTarget -= slice;
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const workId = await openOwnedWork({
        kind: "VISIT_CHANGE_RECOVERY",
        dedupeKey: `visit-change:${jobId}`,
        title: `Finish canceling a paid visit: ${custName}`,
        detail: `Canceling ${job.serviceType}${dateSuffix} could not refund ${usd(refundTarget)}: ${detail}. The visit was NOT canceled.`,
        customerId: job.customerId,
        relatedId: jobId,
        sourceUrl: `/customers/${job.customerId}`,
        resolutionAction:
          "Resume the visit change once the refund can be issued, or refund in Stripe and then resume.",
        ownerTeam: "FINANCE",
      });
      await keepFailed("REQUESTED", detail, workId);
      await recordVisitChangeEvent({
        jobId,
        customerId: job.customerId,
        action: "CANCEL",
        decision,
        actor,
        reason,
        policyUsed,
        amountCents: refundTarget,
        disposition: "REFUND",
        priorScheduledDate: job.scheduledDate ?? null,
        communicationResult: "NONE",
        effects: `Refund of ${usd(refundTarget)} failed — visit left scheduled, owned case opened. ${detail}`,
        outcome: "PARTIAL",
      });
      throw new Error(
        `The refund could not be issued (${detail}) — the visit was not canceled and an operations case was opened.`
      );
    }
    // Checkpoint: money is done and durably recorded so a resume never re-refunds.
    await writeVisitChangeClaim(jobId, nonce, {
      stage: "MONEY_DONE",
      refundedCents,
      ...(refundStripeId ? { refundStripeId } : {}),
    });
  }

  // 2. Void EVERY open/unpaid invoice (GL-07 R2 — never only the first). R3:
  // never COMPLETE while a charge is still processing — retrieve each intent
  // and branch on its real state; a failed or unread void is a tracked
  // failure that keeps the outcome PARTIAL, never a quiet fall-through.
  let invoiceVoided = claim?.invoiceVoided ?? false;
  let moneyPending = false;
  let pendingDetail = "";
  let voidFailed = false;
  const voidOne = async (open: InvoiceRow): Promise<void> => {
    const liveCharge = open.status === "OPEN" && Boolean(open.stripePaymentIntentId);
    if (liveCharge) {
      let intentStatus = "unknown";
      try {
        const pi = await stripe.paymentIntents.retrieve(open.stripePaymentIntentId!);
        intentStatus = pi.status;
        if (
          pi.status === "requires_payment_method" ||
          pi.status === "requires_action" ||
          pi.status === "requires_confirmation" ||
          pi.status === "requires_capture"
        ) {
          // A cancelable pre-processing intent — cancel it, then void the invoice.
          await stripe.paymentIntents
            .cancel(open.stripePaymentIntentId!)
            .catch(() => undefined);
          await client.models.Invoice.update({
            id: open.id,
            status: "VOID",
            voidedAt: new Date().toISOString(),
            voidReason: `Visit canceled: ${reason}`,
            ...(actor.sub ? { voidedBy: actor.sub } : {}),
            ...(actor.email ? { voidedByEmail: actor.email } : {}),
          });
          const { data: reread } = await client.models.Invoice.get({ id: open.id });
          if (reread?.status !== "VOID") voidFailed = true;
        } else if (pi.status === "processing" || pi.status === "succeeded") {
          // A bank debit in flight (or already landed) is NOT safely voidable
          // here — own it through settlement rather than reporting a final state.
          moneyPending = true;
          pendingDetail = `the payment is ${pi.status}`;
        }
        // "canceled" → nothing to do; the charge is already gone.
      } catch (err) {
        moneyPending = true;
        pendingDetail = "the payment status could not be read";
        console.error(`cancelVisit: could not retrieve intent for ${open.id}`, err);
      }
      if (moneyPending) {
        const workId = await openOwnedWork({
          kind: "VISIT_CHANGE_RECOVERY",
          dedupeKey: `visit-change:${jobId}`,
          title: `A charge is still processing on a canceled visit: ${custName}`,
          detail: `The ${job.serviceType} visit was canceled, but its open invoice (${open.id}) has a payment still in motion (${intentStatus}). It can't be voided or refunded until it settles. When it settles: ${
            policy.withinFreeWindow
              ? "refund it in full — the cancellation was strictly more than 72 hours before the visit's start"
              : "it is retained per the 72-hour policy (the cancellation was 72 hours or less before the start)"
          }; if it fails, void the invoice.`,
          customerId: job.customerId,
          relatedId: jobId,
          sourceUrl: `/customers/${job.customerId}`,
          resolutionAction:
            "Watch the payment to settlement, apply the stated 72-hour outcome exactly once, and confirm the visit is fully settled.",
          ownerTeam: "FINANCE",
        });
        await keepFailed("PENDING", `Charge ${intentStatus}, awaiting settlement.`, workId);
      }
      return;
    }
    try {
      await client.models.Invoice.update({
        id: open.id,
        status: "VOID",
        voidedAt: new Date().toISOString(),
        voidReason: `Visit canceled: ${reason}`,
        ...(actor.sub ? { voidedBy: actor.sub } : {}),
        ...(actor.email ? { voidedByEmail: actor.email } : {}),
      });
      // R3: read back the void — a silently-failed void must not report done.
      const { data: reread } = await client.models.Invoice.get({ id: open.id });
      if (reread?.status !== "VOID") {
        voidFailed = true;
        const workId = await openOwnedWork({
          kind: "VISIT_CHANGE_RECOVERY",
          dedupeKey: `visit-change:${jobId}`,
          title: `Void an open invoice for a canceled visit: ${custName}`,
          detail: `The open invoice (${open.id}) for the canceled ${job.serviceType} visit did not read back as VOID.`,
          customerId: job.customerId,
          relatedId: jobId,
          sourceUrl: `/customers/${job.customerId}`,
          resolutionAction:
            "Void the invoice in the billing tools and confirm it reads voided.",
          ownerTeam: "FINANCE",
        });
        await keepFailed("MONEY_DONE", "Open-invoice void did not persist.", workId);
      }
    } catch (err) {
      // A thrown void is a tracked failure — it keeps the outcome PARTIAL and
      // the command open; it can never quietly fall through to Complete.
      voidFailed = true;
      console.error(`cancelVisit: could not void open invoice ${open.id}`, err);
      const workId = await openOwnedWork({
        kind: "VISIT_CHANGE_RECOVERY",
        dedupeKey: `visit-change:${jobId}`,
        title: `Void an open invoice for a canceled visit: ${custName}`,
        detail: `Voiding invoice ${open.id} for the canceled ${job.serviceType} visit threw: ${err instanceof Error ? err.message : String(err)}.`,
        customerId: job.customerId,
        relatedId: jobId,
        sourceUrl: `/customers/${job.customerId}`,
        resolutionAction:
          "Void the invoice in the billing tools and confirm it reads voided, then resume the visit change.",
        ownerTeam: "FINANCE",
      });
      await keepFailed("MONEY_DONE", "Open-invoice void threw.", workId);
    }
  };
  if (!invoiceVoided) {
    for (const open of openList) {
      await voidOne(open);
    }
    invoiceVoided = openList.length > 0 && !voidFailed && !moneyPending;
    if (invoiceVoided) {
      await writeVisitChangeClaim(jobId, nonce, {
        stage: "VOIDED",
        invoiceVoided: true,
      });
    }
  }

  // 3. Flip the visit CANCELED and off its route.
  const { data: canceled, errors } = await client.models.Job.update({
    id: jobId,
    status: "CANCELED",
    routeId: null,
    technicianId: null,
    routeOrder: null,
  });
  if (!canceled) {
    const detail = errors?.map((e) => e.message).join("; ") ?? "unknown error";
    const workId = await openOwnedWork({
      kind: "VISIT_CHANGE_RECOVERY",
      dedupeKey: `visit-change:${jobId}`,
      title: `Finish canceling a visit: ${custName}`,
      detail: `${
        refundedCents > 0 ? `${usd(refundedCents)} was already refunded, but ` : ""
      }the visit could not be flipped to canceled: ${detail}.`,
      customerId: job.customerId,
      relatedId: jobId,
      sourceUrl: `/customers/${job.customerId}`,
      resolutionAction:
        "Resume the visit change — the refund already issued is recorded, so it won't refund twice.",
      ownerTeam: "OPS",
    });
    await keepFailed("MONEY_DONE", detail, workId);
    await recordVisitChangeEvent({
      jobId,
      customerId: job.customerId,
      action: "CANCEL",
      decision,
      actor,
      reason,
      policyUsed,
      amountCents: refundedCents,
      disposition,
      refundStripeId,
      priorScheduledDate: job.scheduledDate ?? null,
      communicationResult: "NONE",
      effects: `Money applied but the visit could not be canceled — owned case opened. ${detail}`,
      outcome: "PARTIAL",
    });
    throw new Error(
      `${refundedCents > 0 ? `A ${usd(refundedCents)} refund was issued, but ` : ""}the visit could not be canceled (${detail}) — an operations case was opened.`
    );
  }
  await writeVisitChangeClaim(jobId, nonce, {
    stage: moneyPending ? "PENDING" : "CANCELED",
  });

  // GL-04: a canceled visit gives its day's minutes back to the shared
  // capacity ledger.
  if (job.scheduledDate) {
    await releaseScheduledMinutes(job.scheduledDate, visitMinutes(job)).catch(
      () => undefined
    );
  }

  // GL-17: a canceled seasonal visit gives its month back (SCHEDULED → DUE),
  // guarded on the month still belonging to THIS job — the month can be
  // re-booked without tripping the one-visit-per-month mutex.
  if (job.servicePlanId && job.scheduledDate) {
    await releaseMonthForJob({
      servicePlanId: job.servicePlanId,
      monthKey: job.scheduledDate.slice(0, 7),
      jobId,
      note: "Visit canceled — the month is owed again.",
    }).catch(() => undefined);
  }

  // 4. Notify the customer — the truthful money state (R3: pending vs final).
  const moneyLine = moneyPending
    ? `<p>Your visit is canceled. A payment for this visit is still processing; once it clears we'll refund it — you don't need to do anything.</p>`
    : disposition === "REFUND"
      ? `<p>We've refunded <strong>${usd(refundedCents)}</strong> to your card — allow a few business days for it to appear.</p>`
      : disposition === "FEE_RETAINED"
        ? `<p>As this cancellation is within ${policy.daysUntilVisit ?? 0} day(s) of the visit, the amount paid is retained per our cancellation policy.</p>`
        : "";
  const html = emailShell(
    "Your visit is canceled",
    `<p>Your <strong>${job.serviceType}</strong> visit${
      job.scheduledDate ? ` scheduled for <strong>${job.scheduledDate}</strong>` : ""
    } has been canceled.</p>
     ${moneyLine}
     <p>Need to book again? Just reply to this email or give us a call — we're glad to help.</p>`
  );
  // Outbox adoption (GL-07 R3): a resumed drive that already got its notice
  // accepted must not email the customer twice — the per-visit email log is
  // the proof.
  let communicationResult: "SENT" | "FAILED" | "NO_EMAIL" | "PENDING";
  if (await priorAcceptedVisitNotice(jobId, "visit-canceled")) {
    communicationResult = "SENT";
  } else {
    communicationResult = await notifyCustomer({
      customerId: job.customerId,
      customerName: custName,
      email: customer?.email ?? null,
      subject: "Your BuzzKill visit is canceled",
      html,
      template: "visit-canceled",
      relatedId: jobId,
      missingContactContext: `${custName}'s ${job.serviceType} visit was canceled${
        disposition === "REFUND" ? ` with a ${usd(refundedCents)} refund` : ""
      }, but the record has no email to confirm it.`,
    });
  }

  // GL-07 R5: the terminal outcome tells the whole truth — a failed invoice
  // void, a missing audit row, or an unreached customer keeps it PARTIAL, and
  // a processing charge keeps it PENDING. COMPLETE is reserved for all of:
  // money exact, invoices reconciled, notice accepted, audit recorded.
  const provisionalOutcome: "COMPLETE" | "PARTIAL" | "PENDING" = moneyPending
    ? "PENDING"
    : communicationResult === "SENT" && !voidFailed
      ? "COMPLETE"
      : "PARTIAL";

  const { recorded: auditRecorded } = await recordVisitChangeEvent({
    jobId,
    customerId: job.customerId,
    action: "CANCEL",
    decision,
    actor,
    reason,
    policyUsed,
    amountCents: refundedCents || policy.feeCents,
    disposition,
    refundStripeId,
    priorScheduledDate: job.scheduledDate ?? null,
    communicationResult,
    effects: [
      moneyPending
        ? `A charge is still processing (${pendingDetail}) — refund owed on settlement, owned by finance.`
        : disposition === "REFUND"
          ? `Refunded ${usd(refundedCents)} to card.`
          : disposition === "FEE_RETAINED"
            ? `Late-cancel fee of ${usd(policy.feeCents)} retained.`
            : "No money moved.",
      invoiceVoided ? "Voided the open invoice." : "",
      "Visit canceled and taken off its route.",
      job.servicePlanId ? "Recurring plan left running." : "",
      communicationResult === "SENT"
        ? "Customer notice accepted by the provider."
        : communicationResult === "FAILED"
          ? "Customer email FAILED (owned)."
          : "No customer email on file (owned).",
      voidFailed ? "An open invoice could not be voided (owned)." : "",
    ]
      .filter(Boolean)
      .join(" "),
    outcome: provisionalOutcome,
  });

  // A lost audit row is a completion requirement, not aftermath (its recovery
  // case is opened inside recordVisitChangeEvent) — it downgrades COMPLETE.
  const outcome: "COMPLETE" | "PARTIAL" | "PENDING" =
    provisionalOutcome === "COMPLETE" && !auditRecorded
      ? "PARTIAL"
      : provisionalOutcome;

  if (outcome === "COMPLETE") {
    // Terminal: everything reconciled — release the command so a later
    // legitimate change to this visit can re-acquire.
    await releaseVisitChangeClaim(jobId, nonce);
  } else {
    // PARTIAL/PENDING: the command stays as the durable anchor Resume and the
    // sweep drive — releasing here made "Resume visit change" a no-op while
    // an invoice, notice, audit, or settling charge was still owed.
    await writeVisitChangeClaim(jobId, nonce, {
      stage: outcome === "PENDING" ? "PENDING" : "CANCELED",
      lastError:
        outcome === "PENDING"
          ? `A payment is still settling: ${pendingDetail}.`
          : [
              voidFailed ? "open-invoice void unfinished" : "",
              communicationResult !== "SENT" ? "customer notice unfinished" : "",
              !auditRecorded ? "audit row missing" : "",
            ]
              .filter(Boolean)
              .join("; "),
      nextAttemptAt: new Date(Date.now() + VISIT_CHANGE_RETRY_MS).toISOString(),
      leaseUntil: null,
    });
  }

  return {
    jobId,
    action: "CANCEL",
    decision,
    canceled: true,
    alreadyCanceled: false,
    disposition,
    refundedCents,
    invoiceVoided,
    communicationResult,
    outcome,
    message: moneyPending
      ? "Visit canceled. A payment is still processing — the refund is owned by finance and will be issued once it settles."
      : outcome === "COMPLETE"
        ? "Visit canceled. The customer has been emailed."
        : voidFailed
          ? "Visit canceled, but an open invoice could not be voided — it's owned by finance; Resume finishes it."
          : communicationResult === "SENT"
            ? "Visit canceled, but its audit record is missing — owned; Resume re-verifies it."
            : "Visit canceled. We couldn't reach the customer — an operations task was opened to notify them.",
  };
}

/** GL-07 R3/R5 — did a prior attempt's visit notice actually leave (provider
 *  accepted)? The per-visit EmailLog is the outbox truth for the crash window
 *  between acceptance and the outcome write. */
async function priorAcceptedVisitNotice(
  jobId: string,
  template: string,
  sinceIso?: string
): Promise<boolean> {
  try {
    const client = await dataClient();
    if (!("EmailLog" in client.models)) return false;
    const { data } = await client.models.EmailLog.listEmailLogByRelatedId(
      { relatedId: jobId },
      { limit: 50 }
    );
    return (data ?? []).some(
      (l) =>
        l.template === template &&
        (l.deliveryStatus === "SENT" || l.deliveryStatus === "DELIVERED") &&
        // For reschedules, only a send belonging to THIS command counts — an
        // older reschedule's accepted notice must not suppress a new promise.
        (!sinceIso || String(l.createdAt ?? "") >= sinceIso)
    );
  } catch (err) {
    console.error("priorAcceptedVisitNotice failed", jobId, err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Visit-change command: reclaim / resume / stored-outcome replay
// ---------------------------------------------------------------------------

/** Steal a stuck visit-change command so this caller can resume it. A command
 *  whose next-attempt time hasn't arrived still belongs to a live/paced attempt;
 *  an old or overdue one is fair game. Returns whether we now hold it. */
async function reclaimOrphanedVisitChange(
  jobId: string
): Promise<{ won: true; nonce: string } | { won: false }> {
  const client = await dataClient();
  const nonce = randomUUID();
  const { data: held } = await client.models.VisitChangeClaim.get({ id: jobId });
  if (!held) {
    const { data } = await client.models.VisitChangeClaim.create({
      id: jobId,
      stage: "REQUESTED",
      ownerTeam: "FINANCE",
      requestedAt: new Date().toISOString(),
      attemptCount: 0,
      leaseNonce: nonce,
      leaseUntil: new Date(Date.now() + VISIT_CHANGE_LEASE_MS).toISOString(),
    });
    return data ? { won: true, nonce } : { won: false };
  }
  const stampedMs = held.createdAt ? new Date(held.createdAt).getTime() : NaN;
  const readyMs = held.nextAttemptAt ? new Date(held.nextAttemptAt).getTime() : NaN;
  const nextArrived = Number.isNaN(readyMs) ? false : Date.now() >= readyMs;
  const old =
    Number.isNaN(stampedMs) || Date.now() - stampedMs >= VISIT_CHANGE_ORPHAN_MS;
  if (!old && !nextArrived) return { won: false };
  // "Looks orphaned" is advisory; the actual steal is ONE guarded update
  // conditioned on no live lease — exactly one concurrent reclaimer wins, and
  // a live holder's command can never be stolen. Legacy pre-lease rows carry
  // no leaseUntil, which the guard treats as not-live (the age checks above
  // already refused young rows).
  const takeover = await casTakeover("VisitChangeClaim", jobId, {
    nonceField: "leaseNonce",
    nonce,
    leaseField: "leaseUntil",
    leaseMs: VISIT_CHANGE_LEASE_MS,
  });
  return takeover.ok ? { won: true, nonce } : { won: false };
}

/** A fenced command write: lands only while the nonce is still ours. Without
 *  CAS wiring (unit fakes / deploy straddling) takeover is disabled, so the
 *  plain single-holder write is the safe fallback. */
async function writeVisitChangeClaim(
  jobId: string,
  nonce: string,
  sets: Record<string, string | number | boolean | null>
): Promise<void> {
  const res = await casFencedUpdate(
    "VisitChangeClaim",
    jobId,
    { field: "leaseNonce", nonce },
    sets
  );
  if (res.ok || res.reason === "LOST") return;
  const client = await dataClient();
  await client.models.VisitChangeClaim
    .update({ id: jobId, ...sets } as never)
    .catch(() => undefined);
}

/** Release the command on a terminal outcome — fenced on the holder nonce, so
 *  an expired worker can never delete a newer attempt's command. Idempotent;
 *  swallows its own failure (a lingering command only delays the next change,
 *  never corrupts). */
async function releaseVisitChangeClaim(
  jobId: string,
  nonce: string
): Promise<void> {
  const released = await casFencedDelete("VisitChangeClaim", jobId, {
    field: "leaseNonce",
    nonce,
    allowMissingFence: true,
  });
  if (released !== "UNSUPPORTED") return;
  const client = await dataClient();
  await client.models.VisitChangeClaim.delete({ id: jobId }).catch(() => undefined);
}

/** Cleanup of a command nobody owns (e.g. the visit is already canceled):
 *  delete only while NO live lease exists, so a holder mid-drive keeps its
 *  command. */
async function sweepUnheldVisitChangeClaim(jobId: string): Promise<void> {
  const swept = await casGuardedDelete("VisitChangeClaim", jobId, [
    { kind: "notLiveLease", field: "leaseUntil", nowIso: new Date().toISOString() },
  ]);
  if (swept === "UNSUPPORTED") {
    const client = await dataClient();
    await client.models.VisitChangeClaim.delete({ id: jobId }).catch(() => undefined);
  }
}

/** The newest visit-change audit row for a job, for the R7 stored-outcome replay. */
async function latestVisitChangeEvent(jobId: string): Promise<{
  disposition?: string | null;
  amountCents?: number | null;
  communicationResult?: string | null;
  outcome?: string | null;
} | null> {
  const client = await dataClient();
  const page = await client.models.VisitChangeEvent.list({
    filter: { jobId: { eq: jobId } },
    limit: 200,
  }).catch(() => ({ data: [] as Record<string, unknown>[] }));
  const rows = (page.data ?? []) as {
    occurredAt?: string | null;
    disposition?: string | null;
    amountCents?: number | null;
    communicationResult?: string | null;
    outcome?: string | null;
  }[];
  if (!rows.length) return null;
  rows.sort((a, b) =>
    String(b.occurredAt ?? "").localeCompare(String(a.occurredAt ?? ""))
  );
  return rows[0];
}

/** R7: an already-canceled visit returns the STORED money/notice/outcome from the
 *  ledger, never a fabricated clean result. */
async function storedCancelOutcome(
  jobId: string,
  decision: CancelDecision
): Promise<VisitCancelOutcome> {
  const ev = await latestVisitChangeEvent(jobId);
  if (!ev) {
    // GL-07 R3: NO history — the replay must say recovery is required, never
    // fabricate a clean Sent/Complete out of a missing ledger.
    return {
      jobId,
      action: "CANCEL",
      decision,
      canceled: true,
      alreadyCanceled: true,
      disposition: "NONE",
      refundedCents: 0,
      invoiceVoided: false,
      communicationResult: "PENDING",
      outcome: "PARTIAL",
      message:
        "This visit was already canceled, but its outcome history is missing — money, notice, and audit are unverified. Use Resume visit change to re-verify and finish them.",
    };
  }
  const disposition = (ev.disposition ?? "NONE") as Disposition;
  const refundedCents =
    disposition === "REFUND" ? Math.max(0, ev.amountCents ?? 0) : 0;
  const comm = (ev.communicationResult ?? "PENDING") as
    | "SENT"
    | "FAILED"
    | "NO_EMAIL"
    | "PENDING";
  const outcome = (ev.outcome ?? "PARTIAL") as "COMPLETE" | "PARTIAL" | "PENDING";
  return {
    jobId,
    action: "CANCEL",
    decision,
    canceled: true,
    alreadyCanceled: true,
    disposition,
    refundedCents,
    invoiceVoided: false,
    communicationResult: comm,
    outcome,
    message:
      outcome === "PENDING"
        ? "This visit was already canceled; a payment is still settling."
        : "This visit was already canceled.",
  };
}

/** A concurrent cancel that lost the command to a live attempt — report the
 *  truthful in-progress state, never a second refund. */
function inProgressCancelOutcome(
  jobId: string,
  decision: CancelDecision
): VisitCancelOutcome {
  return {
    jobId,
    action: "CANCEL",
    decision,
    canceled: false,
    alreadyCanceled: false,
    disposition: "NONE",
    refundedCents: 0,
    invoiceVoided: false,
    communicationResult: "PENDING",
    outcome: "PENDING",
    message:
      "This visit's cancellation is already in progress — refresh in a moment to see the result.",
  };
}

/**
 * Resume a stuck visit-change command (GL-07 R1/R2). The safe re-run the
 * VISIT_CHANGE_RECOVERY case prescribes and the entry the reconcile sweep calls.
 * Idempotent: an already-canceled visit returns its stored outcome and clears the
 * command. `auto` (the sweep) respects the attempt cap and next-attempt time.
 */
export async function resumeVisitChange(
  stripe: Stripe,
  jobId: string,
  opts: { auto?: boolean } = {}
): Promise<VisitCancelOutcome | VisitRescheduleOutcome> {
  const client = await dataClient();
  const { data: job } = await client.models.Job.get({ id: jobId });
  if (!job) throw new Error(`Job ${jobId} not found`);

  const { data: existing } = await client.models.VisitChangeClaim.get({ id: jobId });

  // Already canceled: a SURVIVING command means residuals (an unvoided
  // invoice, a pending charge, a missed notice, a missing audit) — take the
  // lease and RE-DRIVE; the checkpoints skip finished money, the notice
  // adopts from the outbox, and the audit re-records (GL-07 R3). Only a
  // canceled visit with NO command replays its stored outcome.
  if (job.status === "CANCELED") {
    if (!existing || (existing.action ?? "CANCEL") !== "CANCEL") {
      if (existing && (existing.action ?? "CANCEL") !== "CANCEL") {
        await sweepUnheldVisitChangeClaim(jobId);
      }
      return storedCancelOutcome(
        jobId,
        (existing?.decision ?? "CANCEL_REFUND") as CancelDecision
      );
    }
  }
  if (!existing) {
    // A hard kill left no command but the visit is not canceled — nothing durable
    // to resume from; leave it for a fresh office action.
    return inProgressCancelOutcome(jobId, "CANCEL_REFUND");
  }

  if (opts.auto) {
    const readyMs = existing.nextAttemptAt
      ? new Date(existing.nextAttemptAt).getTime()
      : 0;
    if (Number.isFinite(readyMs) && Date.now() < readyMs) {
      return inProgressCancelOutcome(jobId, (existing.decision ?? "CANCEL_REFUND") as CancelDecision);
    }
    if ((existing.attemptCount ?? 0) >= MAX_VISIT_CHANGE_RESUME_ATTEMPTS) {
      return inProgressCancelOutcome(jobId, (existing.decision ?? "CANCEL_REFUND") as CancelDecision);
    }
  }

  // GL-07 R4: a stuck RESCHEDULE resumes with the employee's STORED intent
  // (destination + time window) under the ORIGINAL actor — no system guess.
  // rescheduleVisit re-acquires the command via the stale-reclaim CAS path,
  // its notice adopts from the outbox, and its audit re-records.
  if ((existing.action ?? "CANCEL") !== "CANCEL") {
    if (!existing.newScheduledDate && !existing.proposedTechnicianId) {
      // A legacy command with no stored intent — a person must re-enter it.
      return inProgressCancelOutcome(jobId, "CANCEL_REFUND");
    }
    return rescheduleVisit({
      jobId,
      scheduledDate: existing.newScheduledDate ?? null,
      timeWindow: existing.proposedTimeWindow ?? null,
      technicianId: existing.proposedTechnicianId ?? null,
      routeId: existing.proposedRouteId ?? null,
      reason: existing.reason ?? "Resumed reschedule",
      actor: {
        sub: existing.actorSub ?? null,
        email: existing.actorEmail ?? "system",
        isOwner: false,
      },
    });
  }

  // A resume is an exclusive holder like any other attempt: seize the lease
  // with ONE guarded update. While another attempt's lease is live this loses
  // and reports in-progress — never two concurrent drives of one visit change.
  let nonce: string = randomUUID();
  const takeover = await casTakeover("VisitChangeClaim", jobId, {
    nonceField: "leaseNonce",
    nonce,
    leaseField: "leaseUntil",
    leaseMs: VISIT_CHANGE_LEASE_MS,
  });
  if (!takeover.ok) {
    if (takeover.reason === "LOST") {
      return inProgressCancelOutcome(
        jobId,
        (existing.decision ?? "CANCEL_REFUND") as CancelDecision
      );
    }
    // UNSUPPORTED: takeover is impossible for everyone, so the pacing checks
    // above are the only serialization — keep the legacy single-holder nonce.
    nonce = existing.leaseNonce ?? nonce;
  }

  return driveHeldVisitCancel(stripe, job as JobRow, {
    decision: (existing.decision ?? "CANCEL_REFUND") as CancelDecision,
    reason: existing.reason ?? "Resumed cancellation",
    actor: { sub: null, email: "system", isOwner: true },
    nonce,
  });
}

// ---------------------------------------------------------------------------
// Reschedule
// ---------------------------------------------------------------------------

export type VisitRescheduleOutcome = {
  jobId: string;
  action: "RESCHEDULE";
  rescheduled: boolean;
  priorScheduledDate: string | null;
  newScheduledDate: string | null;
  assignedToRoute: boolean;
  communicationResult: "SENT" | "FAILED" | "NO_EMAIL";
  outcome: "COMPLETE" | "PARTIAL";
  message: string;
};

/**
 * Reschedule one visit as a single guided action. When a technician + route are
 * named, it revalidates the technician's license for the NEW date and the
 * route's ownership and capacity before moving the visit; otherwise it moves the
 * date and returns the visit to the pool for assignment. Either way it emails the
 * customer the old and new details. A notice failure is owned, never a false
 * success.
 */
export async function rescheduleVisit(args: {
  jobId: string;
  scheduledDate?: string | null;
  timeWindow?: string | null;
  technicianId?: string | null;
  routeId?: string | null;
  routeOrder?: number | null;
  reason?: string | null;
  actor: VisitChangeActor;
}): Promise<VisitRescheduleOutcome> {
  const client = await dataClient();
  const { data: job } = await client.models.Job.get({ id: args.jobId });
  if (!job) throw new Error(`Job ${args.jobId} not found`);
  if (!CHANGEABLE.has(job.status)) {
    throw new Error(
      `This visit is ${job.status.toLowerCase().replace(/_/g, " ")} — only a scheduled or unscheduled visit can be rescheduled.`
    );
  }

  const priorScheduledDate = job.scheduledDate ?? null;
  const newDate = args.scheduledDate?.trim() || null;
  // R5: reschedule now requires a controlled reason, the same as cancel.
  const reason = args.reason?.trim();
  if (!reason) throw new Error("A reason is required to reschedule a visit.");

  // R1: single-winner command so concurrent reschedules converge on one result.
  let rescheduleNonce: string = randomUUID();
  const { data: claim } = await client.models.VisitChangeClaim.create({
    id: job.id,
    action: "RESCHEDULE",
    reason,
    stage: "REQUESTED",
    ownerTeam: "OPS",
    requestedAt: new Date().toISOString(),
    attemptCount: 0,
    customerId: job.customerId,
    // GL-07 R4: the intended destination and the ORIGINAL employee ride the
    // durable command, so a stranded attempt resumes with the same intent
    // and identity.
    newScheduledDate: newDate ?? undefined,
    proposedTechnicianId: args.technicianId ?? undefined,
    proposedRouteId: args.routeId ?? undefined,
    proposedTimeWindow: args.timeWindow?.trim() || undefined,
    actorSub: args.actor.sub ?? undefined,
    actorEmail: args.actor.email ?? undefined,
    leaseNonce: rescheduleNonce,
    leaseUntil: new Date(Date.now() + VISIT_CHANGE_LEASE_MS).toISOString(),
  });
  if (!claim) {
    const reclaimed = await reclaimOrphanedVisitChange(job.id);
    if (!reclaimed.won) {
      throw new Error(
        "This visit's reschedule is already in progress — refresh in a moment to see the result."
      );
    }
    rescheduleNonce = reclaimed.nonce;
    // A reclaimed command carries THIS attempt's intent from here on.
    await writeVisitChangeClaim(job.id, rescheduleNonce, {
      action: "RESCHEDULE",
      reason,
      newScheduledDate: newDate,
      proposedTechnicianId: args.technicianId ?? null,
      proposedRouteId: args.routeId ?? null,
      proposedTimeWindow: args.timeWindow?.trim() || null,
      actorSub: args.actor.sub ?? null,
      actorEmail: args.actor.email ?? null,
    });
  }

  const wantsAssignment = Boolean(args.technicianId && args.routeId && newDate);
  let assignedToRoute = false;
  // R5: a dated visit left without a technician is never published as a clean
  // SCHEDULED — it stays visibly pending assignment with a CONFIRMED owner.
  let staffingOwned = false;
  // A refusal before any write releases the command (nothing to resume); a
  // failure AFTER the first write keeps it durably resumable with a case.
  let mutated = false;

  try {
  if (wantsAssignment) {
    const [{ data: technician }, { data: route }, { data: customer0 }] =
      await Promise.all([
        client.models.Technician.get({ id: args.technicianId! }),
        client.models.Route.get({ id: args.routeId! }),
        client.models.Customer.get({ id: job.customerId }),
      ]);
    if (!customer0) throw new Error(`Customer ${job.customerId} no longer exists`);
    if (!technician) throw new Error(`Technician ${args.technicianId} not found`);
    // Revalidate the license for the NEW date — a move past a license expiry is
    // exactly the case this catches. GL-17: currency comes from the licence
    // records (legacy fields only while a technician has no records).
    if (!technician.active) {
      throw new Error(
        `${technician.name ?? "This technician"} is inactive and cannot be assigned regulated work`
      );
    }
    {
      const facts = await licenseFactsFor(technician, newDate!);
      if (!facts.current) {
        if (facts.source === "ERROR") {
          throw new Error(
            `${technician.name ?? "This technician"}'s licence records could not be read just now — try again in a moment.`
          );
        }
        if (facts.source === "LEGACY") {
          assertTechnicianCompliance(technician, {
            requireActive: true,
            workDate: newDate!,
          });
        }
        throw new Error(
          `${technician.name ?? "This technician"} has no current applicator licence on record for ${newDate} — record a current licence or pick another technician`
        );
      }
    }
    if (!route || route.technicianId !== technician.id || route.date !== newDate) {
      throw new Error(
        "The selected route doesn't belong to that technician and date."
      );
    }
    // Revalidate capacity: a route is one technician-day; it can't exceed its
    // stop capacity. Count the stops already on it, excluding this visit.
    let stops = 0;
    let token: string | null | undefined;
    do {
      const page = await client.models.Job.list({
        filter: { routeId: { eq: route.id } },
        nextToken: token,
        limit: 200,
      });
      stops += page.data.filter(
        (j) => j.id !== job.id && j.status !== "CANCELED"
      ).length;
      token = page.nextToken;
    } while (token);
    if (stops >= STOPS_PER_TECH) {
      throw new Error(
        `That route is full (${stops} of ${STOPS_PER_TECH} stops). Pick another day or technician.`
      );
    }
    // GL-04: the ATOMIC day claim — one guarded add on the shared minute
    // ledger; two simultaneous office moves cannot both take the last
    // minutes (the stop count above is a coarse secondary bound).
    if (newDate !== priorScheduledDate) {
      const reserved = await reserveScheduledMinutes(
        newDate!,
        visitMinutes(job)
      );
      if (!reserved.ok) {
        throw new Error(reserved.message);
      }
    }

    const { data, errors } = await client.models.Job.update({
      id: job.id,
      scheduledDate: newDate,
      timeWindow: args.timeWindow?.trim() || null,
      technicianId: technician.id,
      routeId: route.id,
      routeOrder: args.routeOrder ?? stops + 1,
      status: "SCHEDULED",
    });
    if (!data) {
      throw new Error(
        errors?.map((e) => e.message).join("; ") || "Could not reschedule the visit"
      );
    }
    mutated = true;
    assignedToRoute = true;
    if (priorScheduledDate && newDate !== priorScheduledDate) {
      await releaseScheduledMinutes(priorScheduledDate, visitMinutes(job)).catch(
        () => undefined
      );
    }
  } else {
    // GL-07 R4: a dated move with no technician is NEVER published as a clean
    // SCHEDULED — the owned staffing case is CONFIRMED FIRST (a case that
    // can't be written aborts before anything is published or promised), the
    // visit stays visibly pending assignment, and the customer is told the
    // requested date will be confirmed — not a confirmed appointment.
    if (newDate) {
      const { data: customer0 } = await client.models.Customer.get({
        id: job.customerId,
      });
      const staffingCase = await openOwnedWork({
        kind: "UNSTAFFED_VISIT",
        dedupeKey: `visit-reschedule-unstaffed:${job.id}`,
        title: `Assign a technician: ${customer0?.displayName ?? job.customerId} on ${newDate}`,
        detail: `${job.serviceType} was moved to ${newDate} without a technician or route. It is deliberately NOT published as scheduled: assign a validated technician, then it becomes a confirmed appointment.`,
        customerId: job.customerId,
        relatedId: job.id,
        sourceUrl: `/schedule`,
        resolutionAction:
          "Assign a licensed, available technician and put the visit on that day's route.",
        ownerTeam: "OPS",
      });
      if (!staffingCase) {
        throw new Error(
          "The staffing case for this move could not be written — nothing was changed. Try again in a moment."
        );
      }
      staffingOwned = true;
    }
    const { data, errors } = await client.models.Job.update({
      id: job.id,
      scheduledDate: newDate,
      timeWindow: args.timeWindow?.trim() || null,
      routeId: null,
      technicianId: null,
      routeOrder: null,
      // Pending assignment is UNSCHEDULED-with-a-target-date, not a published
      // schedule the dispatch board and reminders would trust.
      status: "UNSCHEDULED",
    });
    if (!data) {
      throw new Error(
        errors?.map((e) => e.message).join("; ") || "Could not reschedule the visit"
      );
    }
    mutated = true;
    // A pool move still occupies its target day (pending assignment counts —
    // the customer was promised the date window). Atomic reserve + release of
    // the prior day, mirroring the assignment path.
    if (newDate && newDate !== priorScheduledDate) {
      const reserved = await reserveScheduledMinutes(newDate, visitMinutes(job));
      if (!reserved.ok) {
        // The schedule already moved — surface, don't strand: the UNSTAFFED
        // case owns the day fit as part of assignment.
        console.warn(
          `rescheduleVisit: pool move to ${newDate} exceeds the day's minutes`,
          job.id
        );
      }
    }
    if (priorScheduledDate && newDate !== priorScheduledDate) {
      await releaseScheduledMinutes(priorScheduledDate, visitMinutes(job)).catch(
        () => undefined
      );
    }
  }

  const { data: customer } = await client.models.Customer.get({
    id: job.customerId,
  });
  // The customer is promised a CONFIRMED time only when a technician is truly
  // assigned; a pending-assignment move promises confirmation, not a date.
  const nowLine = assignedToRoute
    ? `${newDate}${args.timeWindow ? ` (${args.timeWindow})` : ""}`
    : newDate
      ? `${newDate}${args.timeWindow ? ` (${args.timeWindow})` : ""} — requested; we'll confirm your appointment once your technician is assigned`
      : "to be scheduled — we'll confirm the date";
  const html = emailShell(
    "Your visit has been rescheduled",
    `<p>Your <strong>${job.serviceType}</strong> visit has been moved.</p>
     <p><strong>Was:</strong> ${priorScheduledDate ?? "not yet scheduled"}${
       job.timeWindow ? ` (${job.timeWindow})` : ""
     }<br/>
        <strong>Now:</strong> ${nowLine}</p>
     <p>If this new time doesn't work, just reply to this email or call us and we'll find another.</p>`
  );
  // Outbox adoption for a RESUMED attempt of this same command (accepted
  // since the command was requested) — never a duplicate email; a NEW
  // reschedule is a new command with a fresh requestedAt, so its notice sends.
  let communicationResult: "SENT" | "FAILED" | "NO_EMAIL" | "PENDING";
  if (
    await priorAcceptedVisitNotice(
      job.id,
      "visit-rescheduled",
      claim?.requestedAt ?? undefined
    )
  ) {
    communicationResult = "SENT";
  } else {
    communicationResult = await notifyCustomer({
      customerId: job.customerId,
      customerName: customer?.displayName ?? job.customerId,
      email: customer?.email ?? null,
      subject: "Your BuzzKill visit has been rescheduled",
      html,
      template: "visit-rescheduled",
      relatedId: job.id,
      missingContactContext: `${customer?.displayName ?? job.customerId}'s ${job.serviceType} visit was moved from ${priorScheduledDate ?? "unscheduled"} to ${newDate ?? "a date to be confirmed"}, but the record has no email to tell them.`,
    });
  }

  const provisionalOutcome: "COMPLETE" | "PARTIAL" =
    communicationResult === "SENT" ? "COMPLETE" : "PARTIAL";

  const { recorded: auditRecorded } = await recordVisitChangeEvent({
    jobId: job.id,
    customerId: job.customerId,
    action: "RESCHEDULE",
    decision: assignedToRoute ? "RESCHEDULE_ASSIGN" : "RESCHEDULE_POOL",
    actor: args.actor,
    reason,
    priorScheduledDate,
    newScheduledDate: newDate,
    communicationResult,
    effects: [
      `Moved from ${priorScheduledDate ?? "unscheduled"} to ${newDate ?? "unscheduled"}.`,
      assignedToRoute
        ? "Assigned to a validated technician and route (capacity + license checked)."
        : staffingOwned
          ? "No technician yet — staffing is in an owned queue (UNSTAFFED_VISIT)."
          : "Returned to the scheduling pool for assignment.",
      communicationResult === "SENT"
        ? "Customer emailed the old and new details."
        : communicationResult === "FAILED"
          ? "Customer email FAILED (owned)."
          : "No customer email on file (owned).",
    ].join(" "),
    outcome: provisionalOutcome,
  });

  // A lost audit row is a completion requirement (its recovery case is opened
  // inside recordVisitChangeEvent) — it downgrades COMPLETE.
  const outcome: "COMPLETE" | "PARTIAL" =
    provisionalOutcome === "COMPLETE" && !auditRecorded
      ? "PARTIAL"
      : provisionalOutcome;

  if (outcome === "COMPLETE") {
    // Terminal: applied, communicated, audited — release the command.
    await releaseVisitChangeClaim(job.id, rescheduleNonce);
  } else {
    // The move is applied but the notice or audit is unfinished — the command
    // stays as the durable, resumable anchor (Resume re-drives with the same
    // stored intent; the notice adopts from the outbox, never duplicates).
    await writeVisitChangeClaim(job.id, rescheduleNonce, {
      stage: "RESCHEDULED",
      lastError: [
        communicationResult !== "SENT" ? "customer notice unfinished" : "",
        !auditRecorded ? "audit row missing" : "",
      ]
        .filter(Boolean)
        .join("; "),
      nextAttemptAt: new Date(Date.now() + VISIT_CHANGE_RETRY_MS).toISOString(),
      leaseUntil: null,
    });
  }

  return {
    jobId: job.id,
    action: "RESCHEDULE",
    rescheduled: true,
    priorScheduledDate,
    newScheduledDate: newDate,
    assignedToRoute,
    communicationResult,
    outcome,
    message:
      outcome === "COMPLETE"
        ? "Visit rescheduled. The customer has been emailed the new details."
        : communicationResult === "SENT"
          ? "Visit rescheduled, but its audit record is missing — owned; Resume re-verifies it."
          : "Visit rescheduled. We couldn't reach the customer — an operations task was opened to notify them.",
  };
  } catch (err) {
    if (!mutated) {
      // Refused before any change — release the command so a corrected
      // attempt isn't wedged behind a stranded REQUESTED row.
      await releaseVisitChangeClaim(job.id, rescheduleNonce);
      throw err;
    }
    // Stranded AFTER the schedule changed: durable command + owned case, so
    // the employee's intent survives the failure and Resume finishes it.
    const detail = err instanceof Error ? err.message : String(err);
    const workId = await openOwnedWork({
      kind: "VISIT_CHANGE_RECOVERY",
      dedupeKey: `visit-change:${job.id}`,
      title: `Finish a stranded reschedule`,
      detail: `Rescheduling ${job.serviceType} to ${newDate ?? "unscheduled"} stopped partway: ${detail}. The schedule may be moved while the customer notice or audit is unfinished.`,
      customerId: job.customerId,
      relatedId: job.id,
      sourceUrl: `/customers/${job.customerId}`,
      resolutionAction:
        "Resume the visit change — it re-drives the same stored destination under the original employee, adopts an already-sent notice, and re-records the audit.",
      ownerTeam: "OPS",
    });
    await writeVisitChangeClaim(job.id, rescheduleNonce, {
      stage: "RESCHEDULED",
      lastError: detail,
      ...(workId ? { recoveryWorkItemId: workId } : {}),
      nextAttemptAt: new Date(Date.now() + VISIT_CHANGE_RETRY_MS).toISOString(),
      leaseUntil: null,
    });
    throw err;
  }
}
