import { formatMoney } from "./money";
/**
 * GL-19 — pure mismatch logic for the daily leadership reconciliations.
 * Money (provider payments/refunds vs the CRM ledger), plans (provider
 * subscriptions vs CRM plans), and state (customer lifecycle vs scheduled
 * work vs money). Pure functions over plain rows so every rule is unit
 * tested; the daily-reminders drivers fetch, call, open owned items, and
 * persist one ReconRun row per kind for the Command view.
 */

export type Mismatch = {
  /** Stable dedupe key — the same real-world problem reoccurs onto one item. */
  key: string;
  title: string;
  detail: string;
  team: "FINANCE" | "OPS";
  customerId?: string | null;
  relatedId: string;
};

// ------------------------------------------------------------------ money

export type ProviderPayment = {
  id: string;
  amountCents: number;
  /** Funnel payments carry bookingRequestId metadata — the paid-booking
   *  reconciliation already owns those end-to-end. */
  bookingRequestId?: string | null;
  /** Subscription-cycle payments reference a Stripe invoice. */
  stripeInvoiceId?: string | null;
};

export type ProviderRefund = { paymentIntentId: string; amountCents: number };

export type LedgerInvoice = {
  id: string;
  status?: string | null;
  amountCents?: number | null;
  refundedAmountCents?: number | null;
  stripePaymentIntentId?: string | null;
  stripeInvoiceId?: string | null;
  customerId?: string | null;
  issuedAt?: string | null;
};

export type MoneySummary = {
  providerPaidCents: number;
  providerRefundCents: number;
  netCashCents: number;
  crmPaidCents: number;
  mismatches: number;
};

/**
 * Every successful provider payment must equal exactly one CRM paid/refunded
 * invoice (or a funnel booking, which the GL-05 pass owns), and every
 * provider refund must be recorded on its invoice. Net cash is explainable:
 * provider paid − provider refunds.
 */
export function computeMoneyMismatches(input: {
  payments: ProviderPayment[];
  refunds: ProviderRefund[];
  invoices: LedgerInvoice[];
  /** Invoice rows the CRM says are PAID whose issuedAt falls inside the
   *  reconcile window — older rows aren't judged against a windowed scan. */
  windowStartIso: string;
}): { mismatches: Mismatch[]; summary: MoneySummary } {
  const out: Mismatch[] = [];
  const byPi = new Map<string, LedgerInvoice[]>();
  const byStripeInvoice = new Map<string, LedgerInvoice[]>();
  for (const inv of input.invoices) {
    const pi = inv.stripePaymentIntentId?.trim();
    if (pi) byPi.set(pi, [...(byPi.get(pi) ?? []), inv]);
    const si = inv.stripeInvoiceId?.trim();
    if (si) byStripeInvoice.set(si, [...(byStripeInvoice.get(si) ?? []), inv]);
  }

  let providerPaidCents = 0;
  const settled = new Set(["PAID", "REFUNDED"]);
  for (const p of input.payments) {
    providerPaidCents += p.amountCents;
    // Funnel money is judged by the paid-booking reconciliation (GL-05) —
    // double-reporting the same dollar helps nobody.
    if (p.bookingRequestId) continue;
    const matches = [
      ...(byPi.get(p.id) ?? []),
      ...(p.stripeInvoiceId ? (byStripeInvoice.get(p.stripeInvoiceId) ?? []) : []),
    ];
    const settledMatch = matches.find((m) => settled.has(m.status ?? ""));
    if (!settledMatch) {
      out.push({
        key: `money-unmatched-payment:${p.id}`,
        title: "Provider payment has no CRM paid invoice",
        detail: `Stripe holds a succeeded payment of ${formatMoney(p.amountCents)} (${p.id}${p.stripeInvoiceId ? `, invoice ${p.stripeInvoiceId}` : ""}) that no CRM invoice records as PAID. The books understate revenue, or a customer paid for something the CRM doesn't know about.`,
        team: "FINANCE",
        relatedId: p.id,
      });
    }
  }

  const paymentIds = new Set(input.payments.map((p) => p.id));
  let crmPaidCents = 0;
  for (const inv of input.invoices) {
    if (inv.status !== "PAID" && inv.status !== "REFUNDED") continue;
    crmPaidCents += inv.amountCents ?? 0;
    const pi = inv.stripePaymentIntentId?.trim();
    // Only judge CRM rows born inside the window (a windowed provider scan
    // cannot prove anything about older money). Offline-method rows carry no
    // PI and are legitimately provider-absent.
    if (!pi || (inv.issuedAt ?? "") < input.windowStartIso) continue;
    if (!paymentIds.has(pi)) {
      out.push({
        key: `money-unbacked-invoice:${inv.id}`,
        title: "CRM invoice says PAID; the provider has no succeeded payment",
        detail: `Invoice ${inv.id} records ${formatMoney(inv.amountCents ?? 0)} PAID against PaymentIntent ${pi}, but Stripe's succeeded payments in the reconcile window do not include it. The books may overstate cash.`,
        team: "FINANCE",
        customerId: inv.customerId,
        relatedId: inv.id,
      });
    }
  }

  let providerRefundCents = 0;
  const refundByPi = new Map<string, number>();
  for (const r of input.refunds) {
    providerRefundCents += r.amountCents;
    refundByPi.set(
      r.paymentIntentId,
      (refundByPi.get(r.paymentIntentId) ?? 0) + r.amountCents
    );
  }
  for (const [pi, refunded] of refundByPi) {
    const matches = byPi.get(pi) ?? [];
    if (!matches.length) continue; // funnel/no-ledger money — booking pass owns it
    const recorded = matches.reduce(
      (sum, m) =>
        sum +
        (m.refundedAmountCents ?? (m.status === "REFUNDED" ? (m.amountCents ?? 0) : 0)),
      0
    );
    if (recorded < refunded) {
      out.push({
        key: `money-unrecorded-refund:${pi}`,
        title: "Provider refund not recorded on the invoice",
        detail: `Stripe refunded ${formatMoney(refunded)} on ${pi}, but the CRM invoice(s) record only ${formatMoney(recorded)} refunded. The books overstate net cash.`,
        team: "FINANCE",
        customerId: matches[0]?.customerId,
        relatedId: pi,
      });
    }
  }

  return {
    mismatches: out,
    summary: {
      providerPaidCents,
      providerRefundCents,
      netCashCents: providerPaidCents - providerRefundCents,
      crmPaidCents,
      mismatches: out.length,
    },
  };
}

// ------------------------------------------------------------------ plans

export type ProviderSubscription = {
  id: string;
  /** Stripe status: active | trialing | past_due | canceled | unpaid | … */
  status: string;
};

export type PlanRow = {
  id: string;
  status?: string | null; // ACTIVE | PAUSED | CANCELED
  stripeSubscriptionId?: string | null;
  customerId?: string | null;
  planName?: string | null;
};

export type PlanJobRow = {
  id: string;
  servicePlanId?: string | null;
  status?: string | null;
  scheduledDate?: string | null;
};

export type PlanSummary = {
  canceledStillBilling: number;
  activeProviderCanceled: number;
  providerOnlySubscriptions: number;
  delinquentStillScheduled: number;
  mismatches: number;
};

const LIVE_SUB = new Set(["active", "trialing", "past_due", "unpaid"]);

export function computePlanMismatches(input: {
  subscriptions: ProviderSubscription[];
  plans: PlanRow[];
  jobs: PlanJobRow[];
  todayIso: string;
}): { mismatches: Mismatch[]; summary: PlanSummary } {
  const out: Mismatch[] = [];
  const subById = new Map(input.subscriptions.map((s) => [s.id, s]));
  const planBySub = new Map<string, PlanRow>();
  for (const p of input.plans) {
    if (p.stripeSubscriptionId) planBySub.set(p.stripeSubscriptionId, p);
  }

  let canceledStillBilling = 0;
  let activeProviderCanceled = 0;
  for (const p of input.plans) {
    if (!p.stripeSubscriptionId) continue;
    const sub = subById.get(p.stripeSubscriptionId);
    if (!sub) continue; // outside the scan — not judged
    if (p.status === "CANCELED" && LIVE_SUB.has(sub.status)) {
      canceledStillBilling++;
      out.push({
        key: `plan-canceled-still-billing:${p.id}`,
        title: `Canceled plan is still billing: ${p.planName ?? p.id}`,
        detail: `CRM plan ${p.id} is CANCELED but Stripe subscription ${sub.id} is ${sub.status}. The customer is being charged for a plan they ended.`,
        team: "FINANCE",
        customerId: p.customerId,
        relatedId: p.id,
      });
    }
    if (p.status === "ACTIVE" && sub.status === "canceled") {
      activeProviderCanceled++;
      out.push({
        key: `plan-provider-canceled:${p.id}`,
        title: `Active plan stopped billing at the provider: ${p.planName ?? p.id}`,
        detail: `CRM plan ${p.id} is ACTIVE but Stripe subscription ${sub.id} is canceled. Service will keep dispatching with no revenue behind it.`,
        team: "FINANCE",
        customerId: p.customerId,
        relatedId: p.id,
      });
    }
  }

  let providerOnlySubscriptions = 0;
  for (const s of input.subscriptions) {
    if (!LIVE_SUB.has(s.status)) continue;
    if (!planBySub.has(s.id)) {
      providerOnlySubscriptions++;
      out.push({
        key: `plan-provider-only:${s.id}`,
        title: "Provider subscription has no CRM plan",
        detail: `Stripe subscription ${s.id} is ${s.status}, but no CRM service plan records it. Someone is being billed for service the CRM will never schedule.`,
        team: "FINANCE",
        relatedId: s.id,
      });
    }
  }

  // Delinquency suspends a plan (PAUSED); its future visits must not stay
  // silently scheduled.
  let delinquentStillScheduled = 0;
  const pausedPlanIds = new Set(
    input.plans.filter((p) => p.status === "PAUSED").map((p) => p.id)
  );
  for (const j of input.jobs) {
    if (!j.servicePlanId || !pausedPlanIds.has(j.servicePlanId)) continue;
    if (j.status !== "SCHEDULED") continue;
    if ((j.scheduledDate ?? "") < input.todayIso) continue;
    delinquentStillScheduled++;
    out.push({
      key: `plan-delinquent-scheduled:${j.id}`,
      title: "Suspended (delinquent) plan still has a scheduled visit",
      detail: `Visit ${j.id} is SCHEDULED for ${j.scheduledDate} under plan ${j.servicePlanId}, which is PAUSED (typically for nonpayment). Decide: collect and resume, or cancel the visit — don't dispatch unpaid work silently.`,
      team: "OPS",
      relatedId: j.id,
    });
  }

  return {
    mismatches: out,
    summary: {
      canceledStillBilling,
      activeProviderCanceled,
      providerOnlySubscriptions,
      delinquentStillScheduled,
      mismatches: out.length,
    },
  };
}

// ------------------------------------------------------------------ state

export type CustomerRow = {
  id: string;
  status?: string | null; // LEAD | ACTIVE | INACTIVE
  displayName?: string | null;
};

export type StateJobRow = {
  id: string;
  customerId?: string | null;
  status?: string | null;
  scheduledDate?: string | null;
  servicePlanId?: string | null;
};

export type StateInvoiceRow = {
  id: string;
  jobId?: string | null;
  status?: string | null;
  amountCents?: number | null;
  customerId?: string | null;
  pendingDebitIntentId?: string | null;
};

export type StateSummary = {
  inactiveWithWork: number;
  canceledVisitOpenMoney: number;
  mismatches: number;
};

export function computeStateMismatches(input: {
  customers: CustomerRow[];
  jobs: StateJobRow[];
  plans: PlanRow[];
  invoices: StateInvoiceRow[];
  todayIso: string;
}): { mismatches: Mismatch[]; summary: StateSummary } {
  const out: Mismatch[] = [];

  // An INACTIVE customer must have no live work or billing.
  const inactive = new Set(
    input.customers.filter((c) => c.status === "INACTIVE").map((c) => c.id)
  );
  const nameById = new Map(input.customers.map((c) => [c.id, c.displayName]));
  let inactiveWithWork = 0;
  const flaggedCustomers = new Set<string>();
  for (const j of input.jobs) {
    if (!j.customerId || !inactive.has(j.customerId)) continue;
    const live =
      j.status === "UNSCHEDULED" ||
      (j.status === "SCHEDULED" && (j.scheduledDate ?? "") >= input.todayIso) ||
      j.status === "IN_PROGRESS";
    if (!live || flaggedCustomers.has(j.customerId)) continue;
    flaggedCustomers.add(j.customerId);
    inactiveWithWork++;
    out.push({
      key: `state-inactive-with-work:${j.customerId}`,
      title: `Deactivated customer still has live work: ${nameById.get(j.customerId) ?? j.customerId}`,
      detail: `Customer ${j.customerId} is INACTIVE but still has live/scheduled work (e.g. visit ${j.id}${j.scheduledDate ? ` on ${j.scheduledDate}` : ""}). A technician could be dispatched to a customer the business deactivated.`,
      team: "OPS",
      customerId: j.customerId,
      relatedId: j.customerId,
    });
  }
  for (const p of input.plans) {
    if (!p.customerId || !inactive.has(p.customerId)) continue;
    if (p.status !== "ACTIVE" || flaggedCustomers.has(p.customerId)) continue;
    flaggedCustomers.add(p.customerId);
    inactiveWithWork++;
    out.push({
      key: `state-inactive-with-work:${p.customerId}`,
      title: `Deactivated customer still has an active plan: ${nameById.get(p.customerId) ?? p.customerId}`,
      detail: `Customer ${p.customerId} is INACTIVE but plan ${p.id} is ACTIVE — billing or scheduling may continue for a deactivated customer.`,
      team: "OPS",
      customerId: p.customerId,
      relatedId: p.customerId,
    });
  }

  // A canceled visit may keep PAID money (the nonrefundable 72-hour rule),
  // but an OPEN invoice on a canceled visit is money limbo: either it should
  // have been voided (pre-service unwind) or it is a real balance that
  // collection must own — never a row that just sits.
  let canceledVisitOpenMoney = 0;
  const canceledJobs = new Set(
    input.jobs.filter((j) => j.status === "CANCELED").map((j) => j.id)
  );
  for (const inv of input.invoices) {
    if (inv.status !== "OPEN" || !inv.jobId || !canceledJobs.has(inv.jobId))
      continue;
    if (inv.pendingDebitIntentId) continue; // in-flight debit — GL-06 owns it
    canceledVisitOpenMoney++;
    out.push({
      key: `state-canceled-open-money:${inv.id}`,
      title: "Canceled visit still has an open invoice",
      detail: `Invoice ${inv.id} (${formatMoney(inv.amountCents ?? 0)}) is OPEN against canceled visit ${inv.jobId}. Decide the money: void it (nothing owed) or collect it as a real balance — it must not sit unowned.`,
      team: "FINANCE",
      customerId: inv.customerId,
      relatedId: inv.id,
    });
  }

  return {
    mismatches: out,
    summary: {
      inactiveWithWork,
      canceledVisitOpenMoney,
      mismatches: out.length,
    },
  };
}
