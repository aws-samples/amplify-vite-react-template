import type Stripe from "stripe";
import { dataClient } from "./dataClient";
import { notifyOffice } from "./email";
import { openOwnedWork } from "./ownedWork";
import { cancelPlanBilling } from "./subscription";
import {
  recordCustomerLifecycleEvent,
  type LifecycleActor,
} from "./lifecycleLog";
import {
  acquireLifecycleClaim,
  releaseLifecycleClaim,
} from "./lifecycleClaim";

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

  try {
    // Idempotent re-run: already INACTIVE. Re-assert the portal revoke to heal
    // any drift (the exact INACTIVE-with-live-login bug this gate closes), but
    // record NO second transition — the ledger holds transitions, not no-ops.
    if (priorStatus === "INACTIVE") {
      const heal = opts.revokePortalAccess
        ? await opts.revokePortalAccess().catch(() => ({ revoked: false }))
        : { revoked: false };
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

    // A plan is still billing. Do NOT flip INACTIVE — that would hide the live
    // charge — do not revoke the portal, and do not sweep the schedule for a
    // customer we can't finish deactivating. Page a human and hand back partial.
    if (failedPlans.length > 0) {
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
    //    any visit a slipped plan stranded — so no reminder or dispatch survives.
    const jobsCanceled = await sweepRemainingFutureJobs(customerId);

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

    return {
      plansCanceled,
      visitsResolved,
      jobsCanceled,
      outstandingBalanceCents,
      portalUserSub: customer.portalUserSub ?? null,
      portalRevoked,
      status: "INACTIVE",
      partial: false,
      alreadyInactive: false,
      audited: recorded,
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

/**
 * Cancel the customer's remaining not-yet-done jobs and take them off their
 * routes. Leaves history (COMPLETED/NO_ACCESS/CANCELED), a technician mid-visit
 * (IN_PROGRESS), and anything paid up front — a paid visit is money already
 * collected, so honouring or refunding it is an office decision, not a silent
 * cancellation. Returns how many were swept.
 */
async function sweepRemainingFutureJobs(customerId: string): Promise<number> {
  const client = await dataClient();
  let count = 0;
  const note = `Auto-canceled ${new Date()
    .toISOString()
    .slice(0, 10)}: customer deactivated. Taken off the schedule so nothing dispatches.`;
  let token: string | null | undefined;
  do {
    const page = await client.models.Job.list({
      filter: { customerId: { eq: customerId } },
      nextToken: token,
      limit: 200,
    });
    for (const job of page.data) {
      if (job.status !== "SCHEDULED" && job.status !== "UNSCHEDULED") continue;
      if (job.paidAt) continue;
      const { data: updated } = await client.models.Job.update({
        id: job.id,
        status: "CANCELED",
        routeId: null,
        routeOrder: null,
        technicianId: null,
        notes: job.notes ? `${job.notes}\n${note}` : note,
      });
      if (updated) count++;
    }
    token = page.nextToken;
  } while (token);
  return count;
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
