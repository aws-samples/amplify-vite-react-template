import type Stripe from "stripe";
import { dataClient } from "./dataClient";
import { notifyOffice } from "./email";
import { cancelPlanBilling } from "./subscription";
import {
  recordCustomerLifecycleEvent,
  type LifecycleActor,
} from "./lifecycleLog";

/**
 * Customer deactivation — the server-enforced version of the office "Mark
 * inactive" button.
 *
 * Deactivation used to be a single status flip (Customer.status = INACTIVE) and
 * nothing else: the Stripe subscription kept charging, the recurring engine
 * kept queueing visits, those visits stayed on technician routes, and the
 * portal login still worked. A customer who says "stop my service" was still
 * being billed and still being visited. This resolves the live work instead of
 * hiding it behind a flag.
 *
 * Order matters, and the status flip is LAST on purpose. Money is stopped
 * first (the plans), then the work (the queued/one-time visits), and only then
 * is the customer marked INACTIVE. A failure partway through therefore never
 * leaves an INACTIVE customer whose card is still being charged — the visible,
 * retryable state is "still ACTIVE, one plan didn't cancel", not the invisible
 * "INACTIVE but billing".
 *
 * Idempotent: a re-run finds no ACTIVE plans and no open visits, recomputes the
 * balance, and re-asserts INACTIVE.
 *
 * The Cognito side (disabling the portal login) lives in crm-admin
 * (revokePortalAccess) because that is where the pool credentials are; this
 * function returns portalUserSub so the caller can chain the two.
 */

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
  /** The Cognito sub of the portal login, for the caller to disable. */
  portalUserSub: string | null;
  /** The customer's status after this ran (INACTIVE unless a plan cancel failed). */
  status: string;
  /**
   * A plan's Stripe cancel failed, so the customer was left ACTIVE and the
   * office was paged. The caller must not report a clean deactivation.
   */
  partial: boolean;
};

export async function deactivateCustomer(
  stripe: Stripe,
  customerId: string,
  actor?: LifecycleActor | null
): Promise<DeactivateCustomerResult> {
  const client = await dataClient();
  const { data: customer } = await client.models.Customer.get({
    id: customerId,
  });
  if (!customer) throw new Error(`Customer ${customerId} not found`);
  const priorStatus = customer.status;

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
  // charge — and do not sweep the schedule for a customer we can't finish
  // deactivating. Page a human and hand back a partial result.
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
      status: customer.status,
      partial: true,
    };
  }

  // b. Now the trucks. The plan cancels already took their own queued visits
  //    off the schedule; this sweeps what's left — one-time future jobs, and
  //    any visit a slipped plan stranded — so no reminder or dispatch survives.
  const jobsCanceled = await sweepRemainingFutureJobs(customerId);

  // d. INACTIVE last, once the money and the work are resolved.
  await client.models.Customer.update({ id: customerId, status: "INACTIVE" });

  // e. Record the transition for leadership (GL-09). Only when it was a real
  //    state change — an idempotent re-run on an already-INACTIVE customer
  //    re-asserts the flag but is not a new transition and must not double-log.
  if (priorStatus !== "INACTIVE") {
    await recordCustomerLifecycleEvent({
      customerId,
      action: "DEACTIVATE",
      actor,
      priorStatus,
      newStatus: "INACTIVE",
      effects: `${plansCanceled} plan(s) billing stopped, ${visitsResolved} queued visit(s) resolved, ${jobsCanceled} upcoming visit(s) canceled. Outstanding balance ${formatCents(
        outstandingBalanceCents
      )} REPORTED, not charged. Portal login ended separately.`,
    });
  }

  return {
    plansCanceled,
    visitsResolved,
    jobsCanceled,
    outstandingBalanceCents,
    portalUserSub: customer.portalUserSub ?? null,
    status: "INACTIVE",
    partial: false,
  };
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
