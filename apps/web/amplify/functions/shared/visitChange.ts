import type Stripe from "stripe";
import { dataClient } from "./dataClient";
import { emailShell, sendEmail } from "./email";
import { openOwnedWork } from "./ownedWork";
import { refundInvoice, refundableRemaining } from "./refund";
import { assertTechnicianCompliance } from "./compliance";
import {
  computeVisitCancellationPolicy,
  type VisitCancellationPolicy,
} from "./cancellationPolicy";

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
const STOPS_PER_TECH = 8;

export type VisitChangeActor = {
  sub: string | null;
  email: string | null;
  isOwner: boolean;
};

/** The plain business decisions the office may pick. Amounts are never typed —
 *  the server derives them from policy. */
export type CancelDecision =
  | "CANCEL_REFUND"
  | "CANCEL_CREDIT"
  | "MANAGER_EXCEPTION";

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

/** The refundable paid invoice for a visit (PAID with money still to give
 *  back), and the open/unpaid invoice that a cancel should void. */
function classifyInvoices(invoices: InvoiceRow[]) {
  const paid = invoices.find(
    (inv) =>
      (inv.status === "PAID" || inv.status === "REFUNDED") &&
      refundableRemaining(inv) > 0
  );
  const open = invoices.find(
    (inv) => inv.status === "OPEN" || inv.status === "FAILED"
  );
  return { paid, open };
}

function amountPaidFor(job: JobRow, paid: InvoiceRow | undefined): number {
  if (paid) return refundableRemaining(paid);
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
    cancelCredit: { available: boolean; amountCents: number; description: string };
    managerException: { ownerOnly: true; amountCents: number; description: string };
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

  const { paid } = classifyInvoices(invoices);
  const amountPaidCents = amountPaidFor(job as JobRow, paid);
  const amountOpenCents = invoices
    .filter((inv) => inv.status === "OPEN" || inv.status === "FAILED")
    .reduce((sum, inv) => sum + (inv.amountCents ?? 0), 0);

  const policy = computeVisitCancellationPolicy({
    scheduledDate: job.scheduledDate ?? null,
    amountPaidCents,
    today: todayEastern(),
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
        : `Policy keeps the ${usd(policy.feeCents)} paid as a late-cancel fee — no refund unless an owner approves a manager exception.`;

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
      cancelCredit: {
        available: changeable && policy.refundableCents > 0,
        amountCents: policy.refundableCents,
        description:
          policy.refundableCents > 0
            ? `Keep ${usd(policy.refundableCents)} as account credit toward future service instead of refunding the card.`
            : "No refundable amount, so there is nothing to keep as credit.",
      },
      managerException: {
        ownerOnly: true,
        amountCents: amountPaidCents,
        description:
          amountPaidCents > 0
            ? `Owner override: waive any late-cancel fee and refund the full ${usd(amountPaidCents)} to the card.`
            : "Owner override — nothing was paid, so there is no fee to waive.",
      },
    },
    planConsequence,
    routeConsequence,
    noticePreview:
      amountPaidCents > 0
        ? `We'll email ${customer?.displayName ?? "the customer"} that their ${job.serviceType} visit${job.scheduledDate ? ` on ${job.scheduledDate}` : ""} is canceled, and confirm the refund or credit amount.`
        : `We'll email ${customer?.displayName ?? "the customer"} that their ${job.serviceType} visit${job.scheduledDate ? ` on ${job.scheduledDate}` : ""} is canceled.`,
  };
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

type Disposition = "REFUND" | "CREDIT" | "FEE_RETAINED" | "NONE";

/** Write one immutable audit row. Best-effort like the other lifecycle ledgers:
 *  the change is already durably applied, so a missed audit row is logged, never
 *  thrown (which would invite a double-applying retry). */
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
  outcome: "COMPLETE" | "PARTIAL";
}): Promise<void> {
  try {
    const client = await dataClient();
    await client.models.VisitChangeEvent.create({
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
      occurredAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error(
      `Failed to record visit change event (${input.action} on ${input.jobId}) — the change was applied; the audit row was not`,
      err
    );
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
  creditCents: number;
  invoiceVoided: boolean;
  communicationResult: "SENT" | "FAILED" | "NO_EMAIL";
  outcome: "COMPLETE" | "PARTIAL";
  message: string;
};

/**
 * Cancel one visit as a single guided action. Ordered so nothing lies:
 *   1. Money first — refund the policy amount (or the full amount on a manager
 *      exception). If the refund throws, the visit is NOT canceled: an owned
 *      exception is opened and the error propagates, so the screen shows a
 *      failure, never a false "canceled" with the money stuck.
 *   2. Void any open/unpaid invoice for the visit — a canceled visit is not owed.
 *   3. Flip the job CANCELED and off its route. A failure here (money already
 *      moved) opens an owned exception and throws loudly.
 *   4. Notify the customer. A failed/absent notice is owned and downgrades the
 *      outcome to PARTIAL, but the cancellation stands.
 * Records an immutable VisitChangeEvent throughout. Canceling a visit never
 * touches the recurring plan.
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

  // Idempotent: a second confirm (or a second employee) on an already-canceled
  // visit is a no-op success, not a second refund.
  if (job.status === "CANCELED") {
    return {
      jobId: job.id,
      action: "CANCEL",
      decision: args.decision,
      canceled: true,
      alreadyCanceled: true,
      disposition: "NONE",
      refundedCents: 0,
      creditCents: 0,
      invoiceVoided: false,
      communicationResult: "SENT",
      outcome: "COMPLETE",
      message: "This visit was already canceled.",
    };
  }
  if (!CHANGEABLE.has(job.status)) {
    throw new Error(
      `This visit is ${job.status.toLowerCase().replace(/_/g, " ")} — it can't be canceled here. Only a scheduled or unscheduled visit can be canceled.`
    );
  }

  const reason = args.reason?.trim();
  if (!reason) {
    throw new Error("A reason is required to cancel a visit.");
  }

  if (args.decision === "MANAGER_EXCEPTION" && !args.actor.isOwner) {
    throw new Error(
      "Only an owner can approve a manager exception. Pick Cancel and refund (policy amount), or ask an owner."
    );
  }

  const [{ data: customer }, invoices] = await Promise.all([
    client.models.Customer.get({ id: job.customerId }),
    invoicesForJob(job.id),
  ]);
  const { paid, open } = classifyInvoices(invoices);
  const amountPaidCents = amountPaidFor(job as JobRow, paid);
  const policy = computeVisitCancellationPolicy({
    scheduledDate: job.scheduledDate ?? null,
    amountPaidCents,
    today: todayEastern(),
  });

  // What this decision is worth — computed, never typed.
  const refundTarget =
    args.decision === "MANAGER_EXCEPTION"
      ? amountPaidCents
      : args.decision === "CANCEL_REFUND"
        ? policy.refundableCents
        : 0; // CANCEL_CREDIT refunds nothing to the card
  const creditTarget = args.decision === "CANCEL_CREDIT" ? policy.refundableCents : 0;

  let disposition: Disposition = "NONE";
  if (refundTarget > 0) disposition = "REFUND";
  else if (creditTarget > 0) disposition = "CREDIT";
  else if (policy.feeCents > 0) disposition = "FEE_RETAINED";

  const policyUsed = policy.withinFreeWindow
    ? "Full-refund window"
    : args.decision === "MANAGER_EXCEPTION"
      ? "Late cancel — fee waived by manager exception"
      : "Late cancel — fee retained";

  // 1. Money first. A refund that fails must not leave a canceled visit.
  let refundStripeId: string | null = null;
  let refundedCents = 0;
  if (refundTarget > 0) {
    if (!paid) {
      // Paid (job.paidAt) but no invoice to refund against — cannot move money
      // safely. Own it; do not cancel with the money unresolved.
      await openOwnedWork({
        kind: "PAID_VISIT_CANCELLATION",
        dedupeKey: `visit-cancel-refund:${job.id}`,
        title: `Refund a paid visit by hand: ${customer?.displayName ?? job.customerId}`,
        detail: `A ${usd(amountPaidCents)} refund is owed for canceling ${job.serviceType}${job.scheduledDate ? ` on ${job.scheduledDate}` : ""}, but no paid invoice was found to refund against. The visit was NOT canceled.`,
        customerId: job.customerId,
        relatedId: job.id,
        sourceUrl: `/customers/${job.customerId}`,
        resolutionAction:
          "Find the payment in Stripe, refund it, record the invoice, then cancel the visit again.",
        ownerTeam: "FINANCE",
      });
      throw new Error(
        `A refund is owed but no paid invoice was found for this visit — an operations case was opened. The visit was not canceled.`
      );
    }
    try {
      const outcome = await refundInvoice(stripe, {
        invoiceId: paid.id,
        amountCents: refundTarget,
        reason,
        actor: { sub: args.actor.sub, email: args.actor.email },
      });
      refundStripeId = outcome.stripeRefundId ?? null;
      refundedCents = outcome.refundedNowCents;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      await openOwnedWork({
        kind: "PAID_VISIT_CANCELLATION",
        dedupeKey: `visit-cancel-refund:${job.id}`,
        title: `Finish canceling a paid visit: ${customer?.displayName ?? job.customerId}`,
        detail: `Canceling ${job.serviceType}${job.scheduledDate ? ` on ${job.scheduledDate}` : ""} could not refund ${usd(refundTarget)}: ${detail}. The visit was NOT canceled.`,
        customerId: job.customerId,
        relatedId: job.id,
        sourceUrl: `/customers/${job.customerId}`,
        resolutionAction:
          "Retry the cancellation once the refund can be issued, or refund in Stripe and then cancel the visit.",
        ownerTeam: "FINANCE",
      });
      await recordVisitChangeEvent({
        jobId: job.id,
        customerId: job.customerId,
        action: "CANCEL",
        decision: args.decision,
        actor: args.actor,
        reason,
        policyUsed,
        amountCents: refundTarget,
        disposition: "REFUND",
        priorScheduledDate: job.scheduledDate ?? null,
        communicationResult: "NONE",
        effects: `Refund of ${usd(refundTarget)} failed — visit left scheduled, owned case opened. ${detail}`,
        outcome: "PARTIAL",
      });
      // Person is waiting on the answer — surface the failure, don't fake success.
      throw new Error(
        `The refund could not be issued (${detail}) — the visit was not canceled and an operations case was opened.`
      );
    }
  }

  // A retained credit is durable owned finance work — recorded, not forgotten.
  if (creditTarget > 0) {
    await openOwnedWork({
      kind: "PAID_VISIT_CANCELLATION",
      dedupeKey: `visit-credit:${job.id}`,
      title: `Apply ${usd(creditTarget)} account credit: ${customer?.displayName ?? job.customerId}`,
      detail: `Canceling ${job.serviceType}${job.scheduledDate ? ` on ${job.scheduledDate}` : ""}, the office chose to keep ${usd(creditTarget)} as account credit toward future service instead of refunding the card. Reason: "${reason}".`,
      customerId: job.customerId,
      relatedId: job.id,
      sourceUrl: `/customers/${job.customerId}`,
      resolutionAction:
        "Apply the credit to the customer's next invoice or plan renewal, and tell the customer it's on their account.",
      ownerTeam: "FINANCE",
    });
  }

  // 2. Void the open/unpaid invoice — a canceled visit is not owed. Only when
  // there is no live charge in flight: an OPEN invoice with a PaymentIntent is
  // money still moving (a bank debit takes days), and voiding the row without
  // canceling the intent would let the charge land anyway. That case is handed
  // to finance rather than silently dropped.
  let invoiceVoided = false;
  if (open) {
    const liveCharge = open.status === "OPEN" && Boolean(open.stripePaymentIntentId);
    if (liveCharge) {
      await openOwnedWork({
        kind: "PAID_VISIT_CANCELLATION",
        dedupeKey: `visit-void-open:${job.id}`,
        title: `Void an in-flight charge for a canceled visit: ${customer?.displayName ?? job.customerId}`,
        detail: `The canceled ${job.serviceType} visit has an OPEN invoice (${open.id}) with a payment still in motion. It can't be safely voided here without stopping the charge.`,
        customerId: job.customerId,
        relatedId: job.id,
        sourceUrl: `/customers/${job.customerId}`,
        resolutionAction:
          "Void the invoice through the billing tools (which stops the PaymentIntent), or refund it if the charge has since settled.",
        ownerTeam: "FINANCE",
      });
    } else {
      try {
        await client.models.Invoice.update({
          id: open.id,
          status: "VOID",
          voidedAt: new Date().toISOString(),
          voidReason: `Visit canceled: ${reason}`,
          ...(args.actor.sub ? { voidedBy: args.actor.sub } : {}),
          ...(args.actor.email ? { voidedByEmail: args.actor.email } : {}),
        });
        invoiceVoided = true;
      } catch (err) {
        console.error(`cancelVisit: could not void open invoice ${open.id}`, err);
      }
    }
  }

  // 3. Flip the visit CANCELED and off its route.
  const { data: canceled, errors } = await client.models.Job.update({
    id: job.id,
    status: "CANCELED",
    routeId: null,
    technicianId: null,
    routeOrder: null,
  });
  if (!canceled) {
    const detail = errors?.map((e) => e.message).join("; ") ?? "unknown error";
    await openOwnedWork({
      kind: "PAID_VISIT_CANCELLATION",
      dedupeKey: `visit-cancel-state:${job.id}`,
      title: `Finish canceling a visit: ${customer?.displayName ?? job.customerId}`,
      detail: `${
        refundedCents > 0 ? `${usd(refundedCents)} was already refunded, but ` : ""
      }the visit could not be flipped to canceled: ${detail}.`,
      customerId: job.customerId,
      relatedId: job.id,
      sourceUrl: `/customers/${job.customerId}`,
      resolutionAction:
        "Cancel the visit by hand and confirm the refund/credit already issued is correct.",
      ownerTeam: "OPS",
    });
    await recordVisitChangeEvent({
      jobId: job.id,
      customerId: job.customerId,
      action: "CANCEL",
      decision: args.decision,
      actor: args.actor,
      reason,
      policyUsed,
      amountCents: refundedCents || creditTarget,
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

  // 4. Notify the customer. A failed/absent notice is owned, not fatal.
  const moneyLine =
    disposition === "REFUND"
      ? `<p>We've refunded <strong>${usd(refundedCents)}</strong> to your card — allow a few business days for it to appear.</p>`
      : disposition === "CREDIT"
        ? `<p>We've kept <strong>${usd(creditTarget)}</strong> as credit on your account toward future service.</p>`
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
  const communicationResult = await notifyCustomer({
    customerId: job.customerId,
    customerName: customer?.displayName ?? job.customerId,
    email: customer?.email ?? null,
    subject: "Your BuzzKill visit is canceled",
    html,
    template: "visit-canceled",
    relatedId: job.id,
    missingContactContext: `${customer?.displayName ?? job.customerId}'s ${job.serviceType} visit was canceled${
      disposition === "REFUND" ? ` with a ${usd(refundedCents)} refund` : ""
    }, but the record has no email to confirm it.`,
  });

  const outcome: "COMPLETE" | "PARTIAL" =
    communicationResult === "SENT" ? "COMPLETE" : "PARTIAL";

  await recordVisitChangeEvent({
    jobId: job.id,
    customerId: job.customerId,
    action: "CANCEL",
    decision: args.decision,
    actor: args.actor,
    reason,
    policyUsed,
    amountCents: refundedCents || creditTarget || policy.feeCents,
    disposition,
    refundStripeId,
    priorScheduledDate: job.scheduledDate ?? null,
    communicationResult,
    effects: [
      disposition === "REFUND"
        ? `Refunded ${usd(refundedCents)} to card.`
        : disposition === "CREDIT"
          ? `Kept ${usd(creditTarget)} as account credit (owned finance task).`
          : disposition === "FEE_RETAINED"
            ? `Late-cancel fee of ${usd(policy.feeCents)} retained.`
            : "No money moved.",
      invoiceVoided ? "Voided the open invoice." : "",
      "Visit canceled and taken off its route.",
      job.servicePlanId ? "Recurring plan left running." : "",
      communicationResult === "SENT"
        ? "Customer emailed."
        : communicationResult === "FAILED"
          ? "Customer email FAILED (owned)."
          : "No customer email on file (owned).",
    ]
      .filter(Boolean)
      .join(" "),
    outcome,
  });

  return {
    jobId: job.id,
    action: "CANCEL",
    decision: args.decision,
    canceled: true,
    alreadyCanceled: false,
    disposition,
    refundedCents,
    creditCents: creditTarget,
    invoiceVoided,
    communicationResult,
    outcome,
    message:
      outcome === "COMPLETE"
        ? "Visit canceled. The customer has been emailed."
        : "Visit canceled. We couldn't reach the customer — an operations task was opened to notify them.",
  };
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
  const reason = args.reason?.trim() || null;

  const wantsAssignment = Boolean(args.technicianId && args.routeId && newDate);
  let assignedToRoute = false;

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
    // exactly the case this catches.
    assertTechnicianCompliance(technician, {
      requireActive: true,
      workDate: newDate!,
    });
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
    assignedToRoute = true;
  } else {
    // Move the date and return the visit to the pool for assignment.
    const { data, errors } = await client.models.Job.update({
      id: job.id,
      scheduledDate: newDate,
      timeWindow: args.timeWindow?.trim() || null,
      routeId: null,
      technicianId: null,
      routeOrder: null,
      status: newDate ? "SCHEDULED" : "UNSCHEDULED",
    });
    if (!data) {
      throw new Error(
        errors?.map((e) => e.message).join("; ") || "Could not reschedule the visit"
      );
    }
  }

  const { data: customer } = await client.models.Customer.get({
    id: job.customerId,
  });
  const html = emailShell(
    "Your visit has been rescheduled",
    `<p>Your <strong>${job.serviceType}</strong> visit has been moved.</p>
     <p><strong>Was:</strong> ${priorScheduledDate ?? "not yet scheduled"}${
       job.timeWindow ? ` (${job.timeWindow})` : ""
     }<br/>
        <strong>Now:</strong> ${newDate ?? "to be scheduled — we'll confirm the date"}${
          args.timeWindow ? ` (${args.timeWindow})` : ""
        }</p>
     <p>If this new time doesn't work, just reply to this email or call us and we'll find another.</p>`
  );
  const communicationResult = await notifyCustomer({
    customerId: job.customerId,
    customerName: customer?.displayName ?? job.customerId,
    email: customer?.email ?? null,
    subject: "Your BuzzKill visit has been rescheduled",
    html,
    template: "visit-rescheduled",
    relatedId: job.id,
    missingContactContext: `${customer?.displayName ?? job.customerId}'s ${job.serviceType} visit was moved from ${priorScheduledDate ?? "unscheduled"} to ${newDate ?? "a date to be confirmed"}, but the record has no email to tell them.`,
  });

  const outcome: "COMPLETE" | "PARTIAL" =
    communicationResult === "SENT" ? "COMPLETE" : "PARTIAL";

  await recordVisitChangeEvent({
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
        ? "Assigned to a validated technician and route."
        : "Returned to the scheduling pool for assignment.",
      communicationResult === "SENT"
        ? "Customer emailed the old and new details."
        : communicationResult === "FAILED"
          ? "Customer email FAILED (owned)."
          : "No customer email on file (owned).",
    ].join(" "),
    outcome,
  });

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
        : "Visit rescheduled. We couldn't reach the customer — an operations task was opened to notify them.",
  };
}
