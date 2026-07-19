import type Stripe from "stripe";
import { dataClient } from "./dataClient";
import { notifyOffice } from "./email";
import { openMissingContactWork, openOwnedWork } from "./ownedWork";
import { cancelPlanBilling } from "./subscription";
import {
  recordCustomerLifecycleEvent,
  type LifecycleActor,
} from "./lifecycleLog";
import {
  acquireLifecycleClaim,
  releaseLifecycleClaim,
} from "./lifecycleClaim";
import {
  claimLifecycleCommand,
  finishLifecycleCommand,
  recordLifecycleStage,
} from "./lifecycleCommand";
import { reasonPolicy, LIFECYCLE_POLICY_VERSION } from "./lifecycleReasons";
import { emailShell, sendEmail } from "./email";


/**
 * Customer deactivation — ONE server action for the whole offboarding (GL-09).
 *
 * Deactivation used to be a single status flip (Customer.status = INACTIVE) and
 * nothing else: the Stripe subscription kept charging, the recurring engine
 * kept queueing visits, those visits stayed on technician routes, and the
 * portal login still worked. Then it stopped the money and the work — but the
 * portal login was still ended by a SECOND, separate client call, so a browser
 * that died between them left the customer INACTIVE with a live login into their
 * own billing and documents. This folds the access step in, in the right place.
 *
 * Order matters, and the status flip is LAST on purpose:
 *   money (plans) → work (queued/one-time visits) → ACCESS (portal login) →
 *   STATUS (INACTIVE).
 * Because access is revoked BEFORE the status flip, an INACTIVE customer never
 * keeps a live login. And because a failure partway through never reaches the
 * flip, the visible, retryable state is always "still ACTIVE, one step left"
 * (owned and resumable), never the invisible "INACTIVE but still billing" or
 * "INACTIVE with a live portal".
 *
 * A single-winner CustomerLifecycleClaim (id = customerId) serializes this with
 * any racing reactivate so interleaved requests cannot produce mixed state
 * (R5). The status write is read back and the audit write is blocking-on-failure
 * (R4). Idempotent: a re-run on an already-INACTIVE customer heals access, does
 * not double-log, and re-reports the current fact.
 *
 * The Cognito revoke is injected as `opts.revokePortalAccess` because the pool
 * credentials live in crm-admin; this module owns the ordered sequence and the
 * failure handling around it.
 */

/** The outcome of the injected portal-revoke step. */
export type PortalRevokeResult = { revoked: boolean; detail?: string };

export type DeactivateCustomerOptions = {
  /**
   * The controlled reason for the transition, already validated and folded to
   * "CODE" (or "CODE — note" for OTHER) by the caller. Recorded verbatim in the
   * audit ledger.
   */
  reason: string;
  /** The bare controlled reason code — drives the per-reason policy (balance
   *  handling + customer-notice wording). Defaults to OTHER when absent. */
  reasonCode?: string;
  /** GL-09: the durable command's idempotency key. A stable key from the UI
   *  makes a retry resume the same command; absent, a fresh command is minted
   *  (still durable + resumable by the daily worker). */
  idempotencyKey?: string;
  /**
   * End the portal login. Injected by crm-admin (which holds the Cognito pool
   * credentials). Runs BEFORE the INACTIVE flip so INACTIVE never implies a live
   * login. Omitted only by callers/tests with no portal capability.
   */
  revokePortalAccess?: () => Promise<PortalRevokeResult>;
};

export type DeactivateCustomerResult = {
  /** ACTIVE plans whose Stripe subscription + queued visits were cancelled. */
  plansCanceled: number;
  /** Auto-queued plan visits taken off the schedule by the plan cancels. */
  visitsResolved: number;
  /** Remaining future jobs (one-time, or a slipped plan's) swept off routes. */
  jobsCanceled: number;
  /**
   * What the customer still owes: OPEN + FAILED invoices, net of refunds.
   * REPORTED, never collected — auto-charging a card on the way out is exactly
   * the kind of silent, unexplained charge the money screens refuse elsewhere.
   * Surfaced so nothing is quietly lost; the office decides how to settle it.
   */
  outstandingBalanceCents: number;
  /** The Cognito sub of the portal login, if any. */
  portalUserSub: string | null;
  /** Whether the portal login was ended as part of THIS action (R1: the access
   *  step is now inside deactivation, not a second call the office must remember). */
  portalRevoked: boolean;
  /** The customer's status after this ran (INACTIVE unless a step failed). */
  status: string;
  /**
   * A step failed (a plan still billing, the portal login still live, or the
   * status write did not persist), so the customer was left ACTIVE, the office
   * paged, and an owned recovery opened. The caller must not report a clean
   * deactivation.
   */
  partial: boolean;
  /** True on an idempotent re-run of an already-INACTIVE customer. */
  alreadyInactive: boolean;
  /** Whether the transition's audit row was written (R4). False means a blocking
   *  LIFECYCLE_RECOVERY item now owns reconstructing the missing history. */
  audited: boolean;
  /** A truthful human-readable status for the office when partial/in-flight. */
  message?: string;
};

export async function deactivateCustomer(
  stripe: Stripe,
  customerId: string,
  actor: LifecycleActor | null | undefined,
  opts: DeactivateCustomerOptions
): Promise<DeactivateCustomerResult> {
  const reason = (opts.reason ?? "").trim();
  if (!reason) {
    // Defense in depth — the caller validates against the controlled list; this
    // guarantees the shared engine never records a reasonless transition.
    throw new Error("A reason is required to deactivate a customer.");
  }

  const client = await dataClient();
  const { data: customer } = await client.models.Customer.get({
    id: customerId,
  });
  if (!customer) throw new Error(`Customer ${customerId} not found`);
  const priorStatus = customer.status;

  // R5: single-winner claim. A racing deactivate or an interleaving reactivate
  // loses the claim and reports the current state rather than driving a second,
  // mixed-state transition.
  const won = await acquireLifecycleClaim(customerId, "DEACTIVATE");
  if (!won) {
    const { data: current } = await client.models.Customer.get({
      id: customerId,
    });
    const status = current?.status ?? customer.status;
    return {
      plansCanceled: 0,
      visitsResolved: 0,
      jobsCanceled: 0,
      outstandingBalanceCents: 0,
      portalUserSub: current?.portalUserSub ?? customer.portalUserSub ?? null,
      portalRevoked: false,
      status,
      partial: status !== "INACTIVE",
      alreadyInactive: status === "INACTIVE",
      audited: true,
      message:
        status === "INACTIVE"
          ? "This customer is already inactive."
          : "A status change is already in progress for this customer — refresh in a moment.",
    };
  }

  // GL-09: the durable command owns this transition end-to-end — claimed
  // BEFORE any provider effect, with per-stage progress, so a process stop is
  // resumable and a duplicate/opposite request is answered from persisted
  // state instead of a fresh interpretation.
  const commandKey =
    opts.idempotencyKey?.trim() ||
    `deact-${customerId}-${Date.now().toString(36)}`;
  const reasonCode = opts.reasonCode ?? "OTHER";
  const commandClaim = await claimLifecycleCommand({
    idempotencyKey: commandKey,
    customerId,
    action: "DEACTIVATE",
    actor: actor ?? null,
    reasonCode,
    reason,
    priorStatus,
  });
  if (!commandClaim.claimed) {
    await releaseLifecycleClaim(customerId);
    const c = commandClaim.command;
    if (commandClaim.state === "DONE") {
      return {
        plansCanceled: 0,
        visitsResolved: 0,
        jobsCanceled: 0,
        outstandingBalanceCents: 0,
        portalUserSub: customer.portalUserSub ?? null,
        portalRevoked: false,
        status: (await client.models.Customer.get({ id: customerId })).data
          ?.status ?? priorStatus,
        partial: c.outcome !== "COMPLETE",
        alreadyInactive: c.outcome === "COMPLETE",
        audited: true,
        message: `This request already ran: ${c.outcome ?? c.stage}. ${c.effects ?? ""}`,
      };
    }
    return {
      plansCanceled: 0,
      visitsResolved: 0,
      jobsCanceled: 0,
      outstandingBalanceCents: 0,
      portalUserSub: customer.portalUserSub ?? null,
      portalRevoked: false,
      status: priorStatus,
      partial: true,
      alreadyInactive: false,
      audited: true,
      message:
        commandClaim.state === "OPPOSITE_IN_FLIGHT"
          ? `A ${c.action.toLowerCase()} of this customer is still unfinished (${c.stage}). Finish or recover it before the opposite change — nothing was done.`
          : "This transition is already in progress — refresh in a moment for its recorded outcome.",
    };
  }

  try {
    // Idempotent re-run: already INACTIVE. Re-assert the portal revoke to heal
    // any drift (the exact INACTIVE-with-live-login bug this gate closes), but
    // record NO second transition — the ledger holds transitions, not no-ops.
    if (priorStatus === "INACTIVE") {
      const heal = opts.revokePortalAccess
        ? await opts.revokePortalAccess().catch(() => ({ revoked: false }))
        : { revoked: false };
      await finishLifecycleCommand(commandKey, {
        stage: "COMPLETE",
        outcome: "COMPLETE",
        effects: "Already inactive; portal access re-asserted to heal drift.",
      });
      return {
        plansCanceled: 0,
        visitsResolved: 0,
        jobsCanceled: 0,
        outstandingBalanceCents: await outstandingBalance(customerId),
        portalUserSub: customer.portalUserSub ?? null,
        portalRevoked: heal.revoked,
        status: "INACTIVE",
        partial: false,
        alreadyInactive: true,
        audited: true,
        message: "This customer is already inactive.",
      };
    }

    // GL-09: the server-computed inventory of every affected record, persisted
    // on the command BEFORE any provider effect — the resume and the employee
    // preview both read the same facts.
    const inventory = await buildLifecycleInventory(customerId);
    await recordLifecycleStage(commandKey, "INVENTORIED", {
      inventoryJson: JSON.stringify(inventory),
    });

    // a. Stop the money first. cancelPlanBilling cancels the Stripe subscription
    //    AND resolves that plan's queued visits; it throws only when the Stripe
    //    cancel itself failed (the subscription is still live and still
    //    charging), which is the one case we must not paper over.
    const activePlans = await listActivePlans(customerId);
    let plansCanceled = 0;
    let visitsResolved = 0;
    const failedPlans: { id: string; name: string; message: string }[] = [];
    for (const plan of activePlans) {
      try {
        const res = await cancelPlanBilling(stripe, plan.id);
        plansCanceled++;
        visitsResolved += res.queuedVisits.canceled.length;
      } catch (err) {
        failedPlans.push({
          id: plan.id,
          name: plan.planName,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const outstandingBalanceCents = await outstandingBalance(customerId);

    if (failedPlans.length === 0) {
      await recordLifecycleStage(commandKey, "BILLING_STOPPED", {
        effects: `${plansCanceled} plan(s) stopped, ${visitsResolved} queued visit(s) resolved.`,
      });
    }

    // A plan is still billing. Do NOT flip INACTIVE — that would hide the live
    // charge — do not revoke the portal, and do not sweep the schedule for a
    // customer we can't finish deactivating. A DURABLE owned case + page, and
    // the command stays PARTIAL (resumable) — never merely an email.
    if (failedPlans.length > 0) {
      const caseId = await openOwnedWork({
        kind: "LIFECYCLE_RECOVERY",
        dedupeKey: `deactivate-billing:${customerId}`,
        title: `Finish a deactivation — a plan is still billing: ${customer.displayName}`,
        detail: `${customer.displayName}'s deactivation could not stop ${failedPlans.length} plan(s) at Stripe (${failedPlans.map((p) => `${p.name}: ${p.message}`).join("; ")}). They are deliberately still ACTIVE — an INACTIVE customer that is still billing is invisible.`,
        customerId,
        relatedId: customerId,
        sourceUrl: `/customers/${customerId}`,
        resolutionAction:
          "Cancel the plan by hand from the customer's page, then re-run the deactivation (idempotent).",
        ownerTeam: "FINANCE",
      });
      await finishLifecycleCommand(commandKey, {
        stage: "PARTIAL",
        outcome: "PARTIAL",
        effects: `Billing could not be fully stopped (${failedPlans.length} plan(s) live). Customer left ACTIVE. Recovery case ${caseId ? "opened" : "COULD NOT BE OPENED — escalate"}.`,
        lastError: failedPlans.map((p) => p.message).join("; "),
      });
      await notifyOffice({
        subject: `ACTION REQUIRED — deactivation left a plan still billing: ${customer.displayName}`,
        heading: "A customer deactivation could not stop the billing",
        template: "ops-deactivate-plan-stuck",
        customerId,
        bodyHtml: `<p><strong>${customer.displayName}</strong> was being deactivated, but ${
          failedPlans.length === 1
            ? "a plan's"
            : `${failedPlans.length} plans'`
        } subscription could not be canceled at Stripe, so the card is still being charged. The customer has been left <strong>ACTIVE</strong> on purpose — an INACTIVE customer that is still billing is invisible.</p>
         <ul>${failedPlans
           .map((p) => `<li>${p.name}: ${p.message}</li>`)
           .join("")}</ul>
         <p><strong>Cancel the plan by hand from the customer's page, then mark them inactive again.</strong></p>`,
      });
      return {
        plansCanceled,
        visitsResolved,
        jobsCanceled: 0,
        outstandingBalanceCents,
        portalUserSub: customer.portalUserSub ?? null,
        portalRevoked: false,
        status: customer.status,
        partial: true,
        alreadyInactive: false,
        audited: true,
        message: `Left ACTIVE: ${failedPlans.length} plan(s) could not stop billing at Stripe. Cancel by hand, then deactivate again.`,
      };
    }

    // b. Now the trucks. The plan cancels already took their own queued visits
    //    off the schedule; this sweeps what's left — one-time future jobs, and
    //    any visit a slipped plan stranded — so no reminder or dispatch
    //    survives. Paid and in-progress visits are NOT silently skipped: each
    //    becomes an owned honor/refund/finish decision with a deadline.
    const sweep = await sweepRemainingFutureJobs(customerId, customer.displayName);
    const jobsCanceled = sweep.canceled;
    if (sweep.failed === 0 && sweep.caseWriteFailed === 0) {
      await recordLifecycleStage(commandKey, "SCHEDULE_CLEARED", {
        effects: `${jobsCanceled} upcoming visit(s) canceled; ${sweep.paidDecisions} paid and ${sweep.inProgressDecisions} in-progress visit(s) put in owned decisions.`,
      });
    }

    // c. ACCESS before STATUS (R1). If the portal revoke fails, the money is
    //    already stopped but the login is still live and the record is still
    //    ACTIVE — a visible, retryable state, never "INACTIVE with a live
    //    portal". Open resumable owned recovery, page the office, and return
    //    partial without flipping the status.
    let portalRevoked = false;
    if (opts.revokePortalAccess) {
      try {
        const r = await opts.revokePortalAccess();
        portalRevoked = r.revoked;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          `deactivateCustomer: portal revoke failed for ${customerId}`,
          err
        );
        await openOwnedWork({
          kind: "LIFECYCLE_RECOVERY",
          dedupeKey: `deactivate-portal:${customerId}`,
          title: `Finish a deactivation — portal login still live: ${customer.displayName}`,
          detail: `${customer.displayName}'s billing was stopped (${plansCanceled} plan(s)) and their schedule cleared, but the portal login could not be ended: ${message}. They are still ACTIVE and can still sign in. They can NOT be charged (plans are canceled) but CAN still sign in until this is finished.`,
          customerId,
          relatedId: customerId,
          sourceUrl: `/customers/${customerId}`,
          resolutionAction:
            "End the customer's portal login, then deactivate them again — deactivation is idempotent, so re-running safely finishes the job.",
          ownerTeam: "OPS",
        });
        await notifyOffice({
          subject: `ACTION REQUIRED — deactivation left a portal login live: ${customer.displayName}`,
          heading: "A customer deactivation could not end the portal login",
          template: "ops-deactivate-portal-stuck",
          customerId,
          bodyHtml: `<p><strong>${customer.displayName}</strong>'s billing was stopped and their schedule cleared, but their <strong>portal login could not be ended</strong>, so they can still sign in to their own billing and documents. They have been left <strong>ACTIVE</strong> on purpose.</p>
             <p style="color:#666;font-size:13px;">Error: ${message}</p>
             <p><strong>End their portal access, then deactivate them again.</strong></p>`,
        });
        await finishLifecycleCommand(commandKey, {
          stage: "PARTIAL",
          outcome: "PARTIAL",
          effects:
            "Billing stopped and schedule cleared, but the portal login could not be ended. Customer left ACTIVE; owned recovery is open.",
          lastError: message,
        });
        return {
          plansCanceled,
          visitsResolved,
          jobsCanceled,
          outstandingBalanceCents,
          portalUserSub: customer.portalUserSub ?? null,
          portalRevoked: false,
          status: customer.status,
          partial: true,
          alreadyInactive: false,
          audited: true,
          message:
            "Left ACTIVE: billing stopped but the portal login could not be ended. It's owned and will be finished; re-running is safe.",
        };
      }
    }
    await recordLifecycleStage(commandKey, "ACCESS_DONE");

    // d. INACTIVE last, with a read-back (R4). A silently-failed status write
    //    must not report success — if the flip did not persist, open blocking
    //    recovery and tell the truth.
    await client.models.Customer.update({ id: customerId, status: "INACTIVE" });
    const { data: readBack } = await client.models.Customer.get({
      id: customerId,
    });
    if (readBack?.status !== "INACTIVE") {
      await openOwnedWork({
        kind: "LIFECYCLE_RECOVERY",
        dedupeKey: `deactivate-status:${customerId}`,
        title: `Finish a deactivation — status did not persist: ${customer.displayName}`,
        detail: `${customer.displayName}'s billing was stopped, schedule cleared, and portal login ${portalRevoked ? "ended" : "handled"}, but the INACTIVE status write did not persist (still reads ${readBack?.status ?? "unknown"}).`,
        customerId,
        relatedId: customerId,
        sourceUrl: `/customers/${customerId}`,
        resolutionAction:
          "Re-run the deactivation to re-assert INACTIVE — it is idempotent — and confirm the record reads inactive.",
        ownerTeam: "OPS",
      });
      await finishLifecycleCommand(commandKey, {
        stage: "PARTIAL",
        outcome: "PARTIAL",
        effects:
          "Everything stopped but the INACTIVE status write did not persist. Owned recovery is open.",
      });
      return {
        plansCanceled,
        visitsResolved,
        jobsCanceled,
        outstandingBalanceCents,
        portalUserSub: customer.portalUserSub ?? null,
        portalRevoked,
        status: readBack?.status ?? customer.status,
        partial: true,
        alreadyInactive: false,
        audited: true,
        message:
          "The INACTIVE status did not stick. It's owned and will be re-asserted; re-running is safe.",
      };
    }
    await recordLifecycleStage(commandKey, "STATUS_DONE");

    // e. Record the transition for leadership (R3/R4). The audit write is
    //    blocking-on-failure inside recordCustomerLifecycleEvent (a lost row
    //    opens its own LIFECYCLE_RECOVERY); we surface whether it landed.
    const { recorded } = await recordCustomerLifecycleEvent({
      customerId,
      action: "DEACTIVATE",
      actor,
      reason,
      priorStatus,
      newStatus: "INACTIVE",
      effects: `${plansCanceled} plan(s) billing stopped, ${visitsResolved} queued visit(s) resolved, ${jobsCanceled} upcoming visit(s) canceled. Outstanding balance ${formatCents(
        outstandingBalanceCents
      )} REPORTED, not charged. Portal login ${
        portalRevoked ? "ended" : "not applicable (no login)"
      }.`,
    });

    if (recorded) await recordLifecycleStage(commandKey, "AUDITED");

    // GL-09: the tracked final customer notice — the approved per-reason
    // wording with effective date, disposition, balance next step, portal
    // implication, and contact path. A customer with no email becomes owned
    // missing-contact work (that case IS the tracking); a failed send keeps
    // the command PARTIAL so the promise cannot silently vanish.
    const notice = await sendLifecycleNotice({
      action: "DEACTIVATE",
      reasonCode,
      customer: {
        id: customerId,
        displayName: customer.displayName,
        email: customer.email ?? null,
        contactName: customer.contactName ?? null,
      },
      outstandingBalanceCents,
      sweep,
    });
    if (notice.outcome !== "FAILED") {
      await recordLifecycleStage(commandKey, "NOTICE_SENT", {
        effects: `Customer notice: ${notice.outcome}.`,
      });
    }

    const sweepClean = sweep.failed === 0 && sweep.caseWriteFailed === 0;
    const finalPartial = !recorded || notice.outcome === "FAILED" || !sweepClean;
    const effectsSummary = `${plansCanceled} plan(s) billing stopped, ${visitsResolved} queued visit(s) resolved, ${jobsCanceled} upcoming visit(s) canceled${
      sweep.failed ? ` (${sweep.failed} FAILED — owned)` : ""
    }; ${sweep.paidDecisions} paid and ${sweep.inProgressDecisions} in-progress visit(s) in owned decisions. Outstanding balance ${formatCents(
      outstandingBalanceCents
    )} ${reasonPolicy("DEACTIVATE", reasonCode).balanceHandling.toLowerCase().replace(/_/g, " ")} (policy ${LIFECYCLE_POLICY_VERSION}). Portal ${
      portalRevoked ? "ended" : "n/a"
    }. Notice: ${notice.outcome}.`;
    await finishLifecycleCommand(commandKey, {
      stage: finalPartial ? "PARTIAL" : "COMPLETE",
      outcome: finalPartial ? "PARTIAL" : "COMPLETE",
      effects: effectsSummary,
    });

    return {
      plansCanceled,
      visitsResolved,
      jobsCanceled,
      outstandingBalanceCents,
      portalUserSub: customer.portalUserSub ?? null,
      portalRevoked,
      status: "INACTIVE",
      partial: finalPartial,
      alreadyInactive: false,
      audited: recorded,
      message: finalPartial
        ? "Deactivated, but a follow-up item is owned (see the customer's recovery work)."
        : undefined,
    };
  } finally {
    // Whatever the outcome (clean, partial, or a throw), release the claim so a
    // retry or the opposite transition can proceed. Only reached when we won the
    // claim above, so we never delete another request's live claim.
    await releaseLifecycleClaim(customerId);
  }
}

/** Cents → a plain dollar string for the audit summary. */
function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Every ACTIVE ServicePlan for a customer, paged fully. */
async function listActivePlans(
  customerId: string
): Promise<{ id: string; planName: string }[]> {
  const client = await dataClient();
  const out: { id: string; planName: string }[] = [];
  let token: string | null | undefined;
  do {
    const page = await client.models.ServicePlan.list({
      filter: { customerId: { eq: customerId } },
      nextToken: token,
      limit: 200,
    });
    for (const plan of page.data) {
      if (plan.status === "ACTIVE") {
        out.push({ id: plan.id, planName: plan.planName });
      }
    }
    token = page.nextToken;
  } while (token);
  return out;
}

export type LifecycleSweepResult = {
  canceled: number;
  /** Cancel writes (or the list read) that failed — each keeps the transition
   *  out of a clean COMPLETE and is resumable (GL-09). */
  failed: number;
  /** Paid visits given an owned honor/refund/cancel decision. */
  paidDecisions: number;
  /** In-progress visits given an owned finish/disposition decision. */
  inProgressDecisions: number;
  /** Owned-decision cases that could not be durably written. */
  caseWriteFailed: number;
};

/**
 * Cancel the customer's remaining not-yet-done jobs and take them off their
 * routes. Leaves history (COMPLETED/NO_ACCESS/CANCELED). A paid visit and a
 * technician mid-visit are NOT silently skipped: each gets an OWNED
 * honor/refund/finish decision with a staffed owner and deadline (GL-09) —
 * money already collected and work already underway are office decisions, not
 * silent gaps. Every failure is counted; a read failure is a failure, never an
 * empty page.
 */
async function sweepRemainingFutureJobs(
  customerId: string,
  displayName: string
): Promise<LifecycleSweepResult> {
  const client = await dataClient();
  const out: LifecycleSweepResult = {
    canceled: 0,
    failed: 0,
    paidDecisions: 0,
    inProgressDecisions: 0,
    caseWriteFailed: 0,
  };
  const note = `Auto-canceled ${new Date()
    .toISOString()
    .slice(0, 10)}: customer deactivated. Taken off the schedule so nothing dispatches.`;
  try {
    let token: string | null | undefined;
    do {
      const page = await client.models.Job.list({
        filter: { customerId: { eq: customerId } },
        nextToken: token,
        limit: 200,
      });
      for (const job of page.data) {
        if (job.status === "IN_PROGRESS") {
          // Work underway right now — an owned finish/disposition decision.
          const opened = await openOwnedWork({
            kind: "LIFECYCLE_RECOVERY",
            dedupeKey: `deactivate-inprogress:${job.id}`,
            title: `Deactivation: a visit is IN PROGRESS — decide it: ${displayName}`,
            detail: `${displayName} is being deactivated while visit ${job.id}${job.scheduledDate ? ` (${job.scheduledDate})` : ""} is in progress. It was left in place; decide whether it finishes, is cut short, or is rescheduled — and what the customer is told.`,
            customerId,
            relatedId: job.id,
            sourceUrl: `/customers/${customerId}`,
            resolutionAction:
              "Decide the in-progress visit (finish / stop / disposition), record the outcome, and confirm the customer knows.",
            ownerTeam: "OPS",
          });
          if (opened) out.inProgressDecisions++;
          else out.caseWriteFailed++;
          continue;
        }
        if (job.status !== "SCHEDULED" && job.status !== "UNSCHEDULED") continue;
        if (job.paidAt) {
          // Money already collected — an owned honor/refund/cancel decision,
          // never a silent skip.
          const opened = await openOwnedWork({
            kind: "LIFECYCLE_RECOVERY",
            dedupeKey: `deactivate-paid:${job.id}`,
            title: `Deactivation: a PAID visit needs a decision: ${displayName}`,
            detail: `${displayName} is being deactivated but visit ${job.id}${job.scheduledDate ? ` (${job.scheduledDate})` : ""} was already paid up front. Decide: honor it, refund it per the 72-hour policy, or reschedule it — the money is real either way.`,
            customerId,
            relatedId: job.id,
            sourceUrl: `/customers/${customerId}`,
            resolutionAction:
              "Choose honor / refund / cancel for this paid visit through the visit tools, and confirm the customer knows.",
            ownerTeam: "FINANCE",
          });
          if (opened) out.paidDecisions++;
          else out.caseWriteFailed++;
          continue;
        }
        try {
          const { data: updated } = await client.models.Job.update({
            id: job.id,
            status: "CANCELED",
            routeId: null,
            routeOrder: null,
            technicianId: null,
            notes: job.notes ? `${job.notes}\n${note}` : note,
          });
          if (updated) out.canceled++;
          else out.failed++;
        } catch (err) {
          console.error("sweepRemainingFutureJobs: job failed", job.id, err);
          out.failed++;
        }
      }
      token = page.nextToken;
    } while (token);
  } catch (err) {
    // A failed schedule READ cannot be skipped or hidden by the final status.
    console.error("sweepRemainingFutureJobs: list failed", customerId, err);
    out.failed++;
  }
  if (out.failed > 0 || out.caseWriteFailed > 0) {
    await openOwnedWork({
      kind: "LIFECYCLE_RECOVERY",
      dedupeKey: `deactivate-schedule:${customerId}`,
      title: `Deactivation schedule sweep incomplete: ${displayName}`,
      detail: `${out.failed} visit change(s) failed and ${out.caseWriteFailed} owned decision case(s) could not be written while deactivating ${displayName}. Re-running the deactivation resumes the sweep.`,
      customerId,
      relatedId: customerId,
      sourceUrl: `/customers/${customerId}`,
      resolutionAction:
        "Re-run the deactivation (idempotent) to finish the schedule sweep, then confirm no future visit remains.",
      ownerTeam: "OPS",
    });
  }
  return out;
}

/**
 * GL-09 — the server-computed inventory the command persists BEFORE any
 * provider effect and the employee preview renders: every plan (with provider
 * reference), every future/paid/in-progress visit, the outstanding balance,
 * and the portal login. One source of truth for both.
 */
export async function buildLifecycleInventory(customerId: string): Promise<{
  activePlans: { id: string; planName: string; stripeSubscriptionId: string | null; priceCents: number | null }[];
  futureUnpaidJobs: { id: string; scheduledDate: string | null; serviceType: string }[];
  paidJobs: { id: string; scheduledDate: string | null; serviceType: string }[];
  inProgressJobs: { id: string; scheduledDate: string | null; serviceType: string }[];
  outstandingBalanceCents: number;
  portalUserSub: string | null;
  readFailures: string[];
}> {
  const client = await dataClient();
  const inv = {
    activePlans: [] as { id: string; planName: string; stripeSubscriptionId: string | null; priceCents: number | null }[],
    futureUnpaidJobs: [] as { id: string; scheduledDate: string | null; serviceType: string }[],
    paidJobs: [] as { id: string; scheduledDate: string | null; serviceType: string }[],
    inProgressJobs: [] as { id: string; scheduledDate: string | null; serviceType: string }[],
    outstandingBalanceCents: 0,
    portalUserSub: null as string | null,
    readFailures: [] as string[],
  };
  try {
    const { data: customer } = await client.models.Customer.get({ id: customerId });
    inv.portalUserSub = customer?.portalUserSub ?? null;
  } catch {
    inv.readFailures.push("customer");
  }
  try {
    let token: string | null | undefined;
    do {
      const page = await client.models.ServicePlan.list({
        filter: { customerId: { eq: customerId } },
        nextToken: token,
        limit: 200,
      });
      for (const plan of page.data) {
        if (plan.status === "ACTIVE") {
          inv.activePlans.push({
            id: plan.id,
            planName: plan.planName,
            stripeSubscriptionId: plan.stripeSubscriptionId ?? null,
            priceCents: plan.priceCents ?? null,
          });
        }
      }
      token = page.nextToken;
    } while (token);
  } catch {
    inv.readFailures.push("plans");
  }
  try {
    let token: string | null | undefined;
    do {
      const page = await client.models.Job.list({
        filter: { customerId: { eq: customerId } },
        nextToken: token,
        limit: 200,
      });
      for (const job of page.data) {
        const summary = {
          id: job.id,
          scheduledDate: job.scheduledDate ?? null,
          serviceType: job.serviceType,
        };
        if (job.status === "IN_PROGRESS") inv.inProgressJobs.push(summary);
        else if (
          (job.status === "SCHEDULED" || job.status === "UNSCHEDULED") &&
          job.paidAt
        )
          inv.paidJobs.push(summary);
        else if (job.status === "SCHEDULED" || job.status === "UNSCHEDULED")
          inv.futureUnpaidJobs.push(summary);
      }
      token = page.nextToken;
    } while (token);
  } catch {
    inv.readFailures.push("jobs");
  }
  try {
    inv.outstandingBalanceCents = await outstandingBalance(customerId);
  } catch {
    inv.readFailures.push("invoices");
  }
  return inv;
}

/**
 * GL-09 — the tracked final customer notice, driven by the per-reason policy.
 * Returns SENT | NO_EMAIL (owned missing-contact work IS the tracking) |
 * SKIPPED_BY_POLICY (e.g. duplicate records get no notice) | FAILED.
 */
export async function sendLifecycleNotice(input: {
  action: "DEACTIVATE" | "REACTIVATE";
  reasonCode: string;
  customer: {
    id: string;
    displayName: string;
    email: string | null;
    contactName: string | null;
  };
  outstandingBalanceCents: number;
  sweep?: LifecycleSweepResult | null;
}): Promise<{ outcome: "SENT" | "NO_EMAIL" | "SKIPPED_BY_POLICY" | "FAILED" }> {
  const policy = reasonPolicy(input.action, input.reasonCode);
  if (!policy.noticeSubject) return { outcome: "SKIPPED_BY_POLICY" };
  if (!input.customer.email) {
    await openMissingContactWork({
      customerId: input.customer.id,
      displayName: input.customer.displayName,
      context: `The ${input.action === "DEACTIVATE" ? "deactivation" : "reactivation"} notice could not be delivered.`,
    });
    return { outcome: "NO_EMAIL" };
  }
  const balanceLine =
    input.action === "DEACTIVATE" && input.outstandingBalanceCents > 0
      ? `<p>Your account shows an outstanding balance of <strong>${formatCents(input.outstandingBalanceCents)}</strong>. ${
          policy.balanceHandling === "COLLECT"
            ? "We'll follow up about settling it — or just reply to this email."
            : "We'll be in touch if anything is owed."
        }</p>`
      : "";
  const paidLine =
    input.action === "DEACTIVATE" && (input.sweep?.paidDecisions ?? 0) > 0
      ? `<p>You have ${input.sweep!.paidDecisions} paid visit(s) on file — we'll contact you within one business day about honoring or refunding ${input.sweep!.paidDecisions === 1 ? "it" : "them"}.</p>`
      : "";
  const portalLine =
    input.action === "DEACTIVATE"
      ? "<p>Your online portal sign-in has been closed. Your service records stay safely on file.</p>"
      : "<p>Your online portal works again with your usual sign-in.</p>";
  const sent = await sendEmail({
    to: input.customer.email,
    subject: policy.noticeSubject,
    template:
      input.action === "DEACTIVATE"
        ? "lifecycle-deactivated"
        : "lifecycle-reactivated",
    customerId: input.customer.id,
    relatedId: input.customer.id,
    html: emailShell(
      policy.noticeSubject,
      `<p>Hi ${input.customer.contactName ?? input.customer.displayName},</p>
       <p>${policy.noticeIntro}</p>
       ${balanceLine}
       ${paidLine}
       ${portalLine}
       <p style="color:#666;font-size:13px;">Questions? Just reply to this email or call the office.</p>`
    ),
  });
  return { outcome: sent ? "SENT" : "FAILED" };
}

/**
 * What the customer still owes: the sum of OPEN and FAILED invoices, net of any
 * refunds already applied. PAID/REFUNDED/VOID/DRAFT are settled or withdrawn
 * and owe nothing.
 */
async function outstandingBalance(customerId: string): Promise<number> {
  const client = await dataClient();
  let total = 0;
  let token: string | null | undefined;
  do {
    const page = await client.models.Invoice.list({
      filter: { customerId: { eq: customerId } },
      nextToken: token,
      limit: 200,
    });
    for (const inv of page.data) {
      if (inv.status === "OPEN" || inv.status === "FAILED") {
        total += (inv.amountCents ?? 0) - (inv.refundedAmountCents ?? 0);
      }
    }
    token = page.nextToken;
  } while (token);
  return total;
}
