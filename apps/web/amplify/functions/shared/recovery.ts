import type Stripe from "stripe";
import { dataClient } from "./dataClient";
import { openOwnedWork } from "./ownedWork";
import { sendChargeReceipt } from "./receipts";
import {
  ensureStripeCustomer,
  getDefaultPaymentMethod,
} from "./subscription";

/**
 * The money-out recovery lifecycle's shared spine: aging maths, payment terms,
 * the dunning retry cadence, and the one place that charges a saved card to
 * settle an existing invoice.
 *
 * Pure functions here (aging buckets, due-date-from-terms, the dunning
 * schedule) are mirrored on the frontend — keep the boundaries identical or the
 * two sides disagree about how overdue a customer is.
 */

// ── Payment terms → due date ─────────────────────────────────────────────

export type InvoiceTerms = "DUE_ON_RECEIPT" | "NET_15" | "NET_30";

/** Days each term adds to the issue date. */
const TERMS_DAYS: Record<InvoiceTerms, number> = {
  DUE_ON_RECEIPT: 0,
  NET_15: 15,
  NET_30: 30,
};

/** Coerce a client-supplied terms string to a known term (default receipt). */
export function normalizeTerms(raw?: string | null): InvoiceTerms {
  const t = (raw ?? "").trim().toUpperCase();
  return t === "NET_15" || t === "NET_30" ? t : "DUE_ON_RECEIPT";
}

/** Add whole days to a YYYY-MM-DD date (UTC-noon anchored, like recurring.ts). */
function addDaysToDate(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The date an invoice is due, given its terms and when it was issued. */
export function dueDateForTerms(
  terms: string | null | undefined,
  issuedIso: string
): string {
  return addDaysToDate(issuedIso.slice(0, 10), TERMS_DAYS[normalizeTerms(terms)]);
}

// ── Aging ────────────────────────────────────────────────────────────────

export type AgingBucket =
  | "CURRENT"
  | "D1_30"
  | "D31_60"
  | "D61_90"
  | "D90_PLUS";

/** Buckets in report order, oldest money last. */
export const AGING_BUCKET_ORDER: AgingBucket[] = [
  "CURRENT",
  "D1_30",
  "D31_60",
  "D61_90",
  "D90_PLUS",
];

export const AGING_BUCKET_LABEL: Record<AgingBucket, string> = {
  CURRENT: "Current",
  D1_30: "1–30 days",
  D31_60: "31–60 days",
  D61_90: "61–90 days",
  D90_PLUS: "90+ days",
};

/** Whole-day number (UTC) for a date-only or datetime ISO string. */
function dayNumber(iso: string): number {
  const d = new Date(iso.length <= 10 ? `${iso}T00:00:00Z` : iso);
  return Math.floor(d.getTime() / 86_400_000);
}

/**
 * How many days past due an invoice is. Aging is measured from dueDate,
 * falling back to issuedAt for rows that predate due dates. Zero or negative
 * means not yet due.
 */
export function daysPastDue(opts: {
  dueDate?: string | null;
  issuedAt?: string | null;
  now?: Date;
}): number {
  const ref = opts.dueDate ?? opts.issuedAt;
  if (!ref) return 0;
  const today = Math.floor((opts.now ?? new Date()).getTime() / 86_400_000);
  return today - dayNumber(ref);
}

/** Bucket for a given days-past-due count. Boundaries: 1-30, 31-60, 61-90, 90+. */
export function agingBucket(days: number): AgingBucket {
  if (days <= 0) return "CURRENT";
  if (days <= 30) return "D1_30";
  if (days <= 60) return "D31_60";
  if (days <= 90) return "D61_90";
  return "D90_PLUS";
}

/** Convenience: bucket an invoice straight from its dates. */
export function invoiceAgingBucket(
  invoice: { dueDate?: string | null; issuedAt?: string | null },
  now?: Date
): AgingBucket {
  return agingBucket(daysPastDue({ ...invoice, now }));
}

// ── Dunning retry cadence ─────────────────────────────────────────────────

/**
 * When the daily cron re-attempts a failed card, measured in days from the
 * previous attempt. Three retries at +3, +5, +7 days; after the last one fails
 * the plan is suspended. Change the array to change the cadence.
 */
export const DUNNING_RETRY_OFFSET_DAYS = [3, 5, 7];

/** How many card retries a failed invoice gets before its plan is suspended. */
export const MAX_DUNNING_ATTEMPTS = DUNNING_RETRY_OFFSET_DAYS.length;

/**
 * When to next re-attempt the card, given how many retries have already been
 * made. Returns null once the cadence is exhausted — the signal to suspend.
 *
 * attemptsMade = 0 → the first retry, +3 days from now (set on the initial
 * failure); after that first retry fails it becomes 1 → +5 days; then 2 → +7;
 * then 3 → null (suspend).
 */
export function nextDunningAtIso(
  attemptsMade: number,
  fromIso: string
): string | null {
  if (attemptsMade < 0 || attemptsMade >= DUNNING_RETRY_OFFSET_DAYS.length) {
    return null;
  }
  const from = new Date(fromIso);
  from.setUTCDate(from.getUTCDate() + DUNNING_RETRY_OFFSET_DAYS[attemptsMade]);
  return from.toISOString();
}

// ── Settling an existing invoice on the saved card ────────────────────────

export type SettleOnCardOutcome = {
  invoiceId: string;
  status: string; // PAID | FAILED | OPEN (in-flight bank debit) | PAID(already)
  paymentIntentId?: string;
  alreadyPaid?: boolean;
  failureReason?: string;
};

/**
 * Charge a customer's saved card for an OPEN or FAILED invoice and settle it.
 *
 * The single card-charge path behind settleInvoice(CARD), payInvoice, and the
 * dunning retry — so "the money came in, close the row and send a receipt"
 * behaves identically no matter who triggered it.
 *
 * Idempotent on an already-PAID invoice. Throws on a bad state (not OPEN/FAILED)
 * or a missing card — the caller is a person or a cron waiting for the honest
 * answer. A live decline is caught and recorded as FAILED rather than thrown, so
 * the retry cadence can advance on it.
 */
export async function settleInvoiceOnCard(
  stripe: Stripe,
  opts: {
    invoiceId: string;
    actor?: { sub: string | null; email: string | null };
    note?: string | null;
    /** Disambiguates the Stripe idempotency key across retries. */
    attemptTag?: string;
  }
): Promise<SettleOnCardOutcome> {
  const client = await dataClient();
  const { data: invoice } = await client.models.Invoice.get({
    id: opts.invoiceId,
  });
  if (!invoice) throw new Error(`Invoice ${opts.invoiceId} not found`);

  if (invoice.status === "PAID" || invoice.status === "REFUNDED") {
    return {
      invoiceId: invoice.id,
      status: String(invoice.status),
      alreadyPaid: true,
    };
  }
  if (invoice.status !== "OPEN" && invoice.status !== "FAILED") {
    throw new Error(
      `This invoice is ${String(invoice.status).toLowerCase()} — only an open or failed invoice can be paid`
    );
  }
  if (!Number.isInteger(invoice.amountCents) || invoice.amountCents <= 0) {
    throw new Error("This invoice has no amount to charge");
  }

  // GL-06: a bank (ACH) debit already clearing on this invoice must NOT be
  // charged again. Such a debit sits OPEN for days; the "Pay now" button hides
  // while pendingDebitIntentId is set, but this is the authoritative backstop
  // for a stale button, a second browser tab, or the dunning retry racing a
  // manual pay. The webhook clears pendingDebitIntentId when the debit settles
  // or fails; until then we report the in-flight state and create no new charge.
  const pendingDebit = (invoice as { pendingDebitIntentId?: string | null })
    .pendingDebitIntentId;
  if (pendingDebit) {
    return {
      invoiceId: invoice.id,
      status: "processing",
      paymentIntentId: pendingDebit,
    };
  }

  const { customer, stripeCustomerId } = await ensureStripeCustomer(
    stripe,
    invoice.customerId
  );
  const pm = await getDefaultPaymentMethod(stripe, stripeCustomerId);
  if (!pm) {
    throw new Error(
      "No saved payment method on file — add a card first, or record the payment another way"
    );
  }

  const nowIso = new Date().toISOString();
  // Keyed by the card and a minute bucket, not just a constant tag: a
  // customer whose card declined and who then adds a NEW card and retries
  // must get a fresh Stripe idempotency key, or Stripe replays the old
  // decline for 24h and the good card can't get in. Same card + same minute
  // (an accidental double-submit) still dedupes to one charge.
  const idempotencyKey = `crm-settle-${invoice.id}-${opts.attemptTag ?? "x"}-${pm.id}-${Math.floor(Date.now() / 60_000)}`;

  let intent: Stripe.PaymentIntent;
  try {
    intent = await stripe.paymentIntents.create(
      {
        customer: stripeCustomerId,
        amount: invoice.amountCents,
        currency: "usd",
        payment_method: pm.id,
        off_session: true,
        confirm: true,
        description: invoice.description ?? "BuzzKill Pest Control",
        receipt_email: customer.email ?? undefined,
        metadata: {
          crmInvoiceId: invoice.id,
          crmCustomerId: invoice.customerId,
        },
      },
      { idempotencyKey }
    );
  } catch (err) {
    // Off-session declines throw a card error carrying the intent it failed on.
    const e = err as {
      message?: string;
      payment_intent?: { id?: string };
      raw?: { payment_intent?: { id?: string } };
    };
    const failureReason = e?.message ?? "The card was declined";
    const piId = e?.payment_intent?.id ?? e?.raw?.payment_intent?.id;
    await client.models.Invoice.update({
      id: invoice.id,
      status: "FAILED",
      failureReason,
      ...(piId ? { stripePaymentIntentId: piId } : {}),
    });
    return {
      invoiceId: invoice.id,
      status: "FAILED",
      failureReason,
      paymentIntentId: piId,
    };
  }

  const method = pm.type === "us_bank_account" ? "BANK" : "CARD";

  if (intent.status === "succeeded") {
    await client.models.Invoice.update({
      id: invoice.id,
      status: "PAID",
      method,
      stripePaymentIntentId: intent.id,
      paidAt: nowIso,
      failureReason: null,
      // Dunning is over — this invoice is paid.
      nextDunningAt: null,
      lastDunningAt: nowIso,
      ...(opts.actor?.sub ? { settledBy: opts.actor.sub } : {}),
      ...(opts.actor?.email ? { settledByEmail: opts.actor.email } : {}),
      ...(opts.note ? { settleNote: opts.note.trim().slice(0, 300) } : {}),
    });
    await clearPlanDelinquency(invoice.servicePlanId);
    await sendChargeReceipt({
      customerId: invoice.customerId,
      amountCents: invoice.amountCents,
      description: invoice.description ?? "Pest control service",
      invoiceId: invoice.id,
    });
    return { invoiceId: invoice.id, status: "PAID", paymentIntentId: intent.id };
  }

  // A bank debit that is still processing: keep the invoice OPEN with the new
  // intent id and let the webhook settle it to PAID (and send the receipt) when
  // payment_intent.succeeded lands. pendingDebitIntentId marks it un-payable in
  // the meantime so no one is charged twice for the same bill; the webhook
  // clears it on succeeded/failed.
  await client.models.Invoice.update({
    id: invoice.id,
    status: "OPEN",
    method,
    stripePaymentIntentId: intent.id,
    pendingDebitIntentId: intent.id,
    failureReason: null,
  });
  return {
    invoiceId: invoice.id,
    status: intent.status,
    paymentIntentId: intent.id,
  };
}

/** Un-suspend a plan when one of its invoices is paid. No-op if not delinquent. */
export async function clearPlanDelinquency(
  servicePlanId: string | null | undefined
): Promise<void> {
  if (!servicePlanId) return;
  const client = await dataClient();
  const { data: plan } = await client.models.ServicePlan.get({
    id: servicePlanId,
  });
  if (!plan || !plan.delinquent) return;
  await client.models.ServicePlan.update({
    id: servicePlanId,
    delinquent: false,
    delinquentSince: null,
  });
}

/**
 * GL-15 — open (or re-open) the owned presence-review case for a FLAGGED
 * report. Shared by finalize (crm-docs) and the daily reconcile sweep; flips
 * the durable marker to QUEUED only when the case write is CONFIRMED.
 */
export async function queuePresenceReview(input: {
  reportId: string;
  customerId: string;
  customerName: string;
  serviceType: string;
  detail: string;
}): Promise<boolean> {
  const workId = await openOwnedWork({
    kind: "LOCATION_REVIEW",
    dedupeKey: `service-report-location:${input.reportId}`,
    title: `On-site location needs a look: ${input.customerName}`,
    detail: input.detail,
    customerId: input.customerId,
    relatedId: input.reportId,
    sourceUrl: `/customers/${input.customerId}`,
    resolutionAction:
      "Confirm the technician was on site (job-site photos, notes, customer contact). If confirmed, resolve. If not, issue a corrected report or open the discrepancy with the technician.",
    ownerTeam: "OPS",
  });
  if (!workId) return false;
  const client = await dataClient();
  const { data } = await client.models.ServiceReport.update({
    id: input.reportId,
    presenceReviewStatus: "QUEUED",
  });
  return Boolean(data);
}
