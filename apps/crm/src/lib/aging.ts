/**
 * AR aging buckets for the office Dashboard.
 *
 * The contract — bucket boundaries, the dueDate-falling-back-to-issuedAt
 * basis rule, whole-day UTC arithmetic — lives in the backend's
 * shared/agingMath.ts (a pure leaf, value-imported), so the Dashboard and
 * every server-side aging report agree to the dollar by construction. What
 * stays here is the CRM's shape of it: invoice-first wrappers that take an
 * explicit `today` (YYYY-MM-DD, the caller's Eastern wall-clock day — the
 * server ages against UTC-now instead, a deliberate divergence), plus the
 * receivable filter and the Dashboard's bucket summary.
 */

import {
  AGING_BUCKET_ORDER,
  agingBucketForDays,
  daysBetween,
  dueBasis as sharedDueBasis,
  type AgingBucket,
} from "../../../web/amplify/functions/shared/agingMath";

export {
  AGING_BUCKET_LABEL,
  AGING_BUCKET_ORDER as AGING_BUCKETS,
  agingBucketForDays,
  daysBetween,
  toYmd,
} from "../../../web/amplify/functions/shared/agingMath";
export type { AgingBucket } from "../../../web/amplify/functions/shared/agingMath";

export type AgingInvoice = {
  amountCents: number;
  status?: string | null;
  dueDate?: string | null;
  issuedAt?: string | null;
};

/** The shared basis rule (due date, else issue date), typed for CRM rows. */
export function dueBasis(inv: AgingInvoice): string | null {
  return sharedDueBasis(inv);
}

/** Whole days past due as of `today` (YYYY-MM-DD). Not-yet-due is <= 0. */
export function daysPastDue(inv: AgingInvoice, today: string): number {
  const basis = dueBasis(inv);
  if (!basis) return 0;
  return daysBetween(basis, today);
}

/** The aging bucket for an invoice as of `today`. */
export function agingBucket(inv: AgingInvoice, today: string): AgingBucket {
  return agingBucketForDays(daysPastDue(inv, today));
}

/** Only unpaid, still-receivable money ages. */
export function isReceivable(inv: AgingInvoice): boolean {
  return inv.status === "OPEN" || inv.status === "FAILED";
}

export type AgingBucketTotal = { totalCents: number; count: number };

export type AgingSummary = {
  buckets: Record<AgingBucket, AgingBucketTotal>;
  totalCents: number;
  count: number;
};

function emptyBuckets(): Record<AgingBucket, AgingBucketTotal> {
  return Object.fromEntries(
    AGING_BUCKET_ORDER.map((b) => [b, { totalCents: 0, count: 0 }])
  ) as Record<AgingBucket, AgingBucketTotal>;
}

/**
 * Total outstanding receivable by aging bucket. Considers only OPEN and FAILED
 * invoices (the money still owed); PAID/REFUNDED/VOID/DRAFT are not receivable
 * and never age. Refund carve-outs don't apply here — a partly refunded
 * invoice that is still owed money is PAID, not OPEN, so it isn't receivable.
 */
export function agingSummary(
  invoices: AgingInvoice[],
  today: string
): AgingSummary {
  const buckets = emptyBuckets();
  let totalCents = 0;
  let count = 0;
  for (const inv of invoices) {
    if (!isReceivable(inv)) continue;
    const bucket = agingBucket(inv, today);
    buckets[bucket].totalCents += inv.amountCents;
    buckets[bucket].count += 1;
    totalCents += inv.amountCents;
    count += 1;
  }
  return { buckets, totalCents, count };
}
