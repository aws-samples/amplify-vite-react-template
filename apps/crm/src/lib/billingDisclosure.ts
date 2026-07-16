import { money } from "./format";

/**
 * The words said before monthly billing starts.
 *
 * Two buttons can start a subscription: the dedicated "Start billing" on a
 * plan, and the office "✓ Complete" on a recurring job — completion auto-starts
 * the plan's billing server-side (crm-docs startBillingForPlan), so the button
 * that says "the customer won't get a field report" may also take the first
 * monthly charge today. A money button states the money before it moves, and
 * both buttons move the same money, so both confirms are composed here from
 * the same sentences — they cannot drift apart.
 */

/** Said out loud in the confirms, so "quarterly" is never read as the billing cadence. */
export const VISIT_NOTE: Record<string, string> = {
  MONTHLY: "A technician visits every month.",
  BIMONTHLY: "A technician visits every 2 months — the charge is still monthly.",
  QUARTERLY: "A technician visits every 3 months — the charge is still monthly.",
};

export type BillablePlan = {
  id: string;
  planName: string;
  priceCents: number;
  status?: string | null;
  stripeSubscriptionId?: string | null;
  serviceFrequency?: string | null;
};

export type CompletableJob = {
  type?: string | null;
  servicePlanId?: string | null;
};

/** What happens to the card, and how that differs from the visit cadence. */
const firstChargeWords = (plan: BillablePlan): string => {
  const note = VISIT_NOTE[plan.serviceFrequency ?? ""];
  return `The first charge goes to their card on file today, then monthly.${note ? ` ${note}` : ""}`;
};

/** The dedicated Start-billing button's confirm. */
export function startBillingConfirmText(
  customerName: string,
  plan: BillablePlan
): string {
  return `Start billing ${customerName} ${money(plan.priceCents)} every month for ${plan.planName}?\n\n${firstChargeWords(plan)}`;
}

/**
 * The plan whose billing will start when this job is completed, or null when
 * completing moves no money. Mirrors the server's startPlanBilling: a
 * recurring job, its plan ACTIVE, and no live Stripe subscription yet.
 */
export function planBilledOnCompletion(
  job: CompletableJob,
  plans: readonly BillablePlan[]
): BillablePlan | null {
  if (job.type !== "RECURRING" || !job.servicePlanId) return null;
  const plan = plans.find((p) => p.id === job.servicePlanId);
  if (!plan || plan.status !== "ACTIVE" || plan.stripeSubscriptionId) {
    return null;
  }
  return plan;
}

/**
 * Confirm for the office "✓ Complete" button. When completing will start
 * billing it says so in the Start-billing confirm's words; otherwise it only
 * warns about the missing field report — accurate, not alarmist.
 */
export function completeJobConfirmText(
  customerName: string,
  job: CompletableJob,
  plans: readonly BillablePlan[]
): string {
  const base =
    "Mark this job completed without a tech report? The customer won't get a field report for it.";
  const plan = planBilledOnCompletion(job, plans);
  if (!plan) return base;
  return `${base}\n\nCompleting also starts billing ${customerName} ${money(plan.priceCents)} every month for ${plan.planName}. ${firstChargeWords(plan)}`;
}
