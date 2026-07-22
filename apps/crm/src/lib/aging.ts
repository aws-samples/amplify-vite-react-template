/**
 * AR aging buckets for the office Dashboard.
 *
 * A pure module because these are the numbers the business reads to decide how
 * bad its receivables are, and they must agree — to the dollar — with the
 * backend's shared/recovery.ts. The bucket boundaries below are the contract:
 * change them here and you have to change them there, or the Dashboard and any
 * server-side aging report drift apart. Boundaries are pinned by aging.test.ts
 * rather than by a screenshot of the Dashboard.
 *
 * Aging is measured from an invoice's dueDate, falling back to issuedAt when an
 * invoice predates due dates or never got one. "Days past due" is whole days
 * elapsed since that basis date; anything not yet due is `current`.
 */

export type AgingBucket = "current" | "1-30" | "31-60" | "61-90" | "90+";

export const AGING_BUCKETS: readonly AgingBucket[] = [
  "current",
  "1-30",
  "31-60",
  "61-90",
  "90+",
] as const;

export const AGING_BUCKET_LABEL: Record<AgingBucket, string> = {
  current: "Current",
  "1-30": "1–30 days",
  "31-60": "31–60 days",
  "61-90": "61–90 days",
  "90+": "90+ days",
};

/** The date portion (YYYY-MM-DD) of an ISO date or datetime string. */
export function toYmd(iso: string): string {
  return iso.slice(0, 10);
}

function ymdToUTC(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  return Date.UTC(y, (m ?? 1) - 1, d ?? 1);
}

/**
 * Whole days from `fromYmd` to `toYmd`, positive when `toYmd` is later. Both
 * are YYYY-MM-DD; the diff is taken in UTC so a DST change never adds or drops
 * a day.
 */
export function daysBetween(fromYmd: string, toYmd: string): number {
  return Math.round((ymdToUTC(toYmd) - ymdToUTC(fromYmd)) / 86_400_000);
}

export type AgingInvoice = {
  amountCents: number;
  status?: string | null;
  dueDate?: string | null;
  issuedAt?: string | null;
};

/**
 * The date an invoice's clock runs from: its due date, or the day it was
 * issued if it has no due date. Null when neither is known (nothing to age).
 */
export function dueBasis(inv: AgingInvoice): string | null {
  if (inv.dueDate) return toYmd(inv.dueDate);
  if (inv.issuedAt) return toYmd(inv.issuedAt);
  return null;
}

/** Whole days past due as of `today` (YYYY-MM-DD). Not-yet-due is <= 0. */
export function daysPastDue(inv: AgingInvoice, today: string): number {
  const basis = dueBasis(inv);
  if (!basis) return 0;
  return daysBetween(basis, today);
}

/**
 * Which aging bucket a given days-past-due lands in. The boundaries:
 *   <= 0  current (not yet due)
 *   1–30  1-30
 *   31–60 31-60
 *   61–90 61-90   (90 days past due is still 61-90, not 90+)
 *   > 90  90+
 */
export function agingBucketForDays(days: number): AgingBucket {
  if (days <= 0) return "current";
  if (days <= 30) return "1-30";
  if (days <= 60) return "31-60";
  if (days <= 90) return "61-90";
  return "90+";
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
  return {
    current: { totalCents: 0, count: 0 },
    "1-30": { totalCents: 0, count: 0 },
    "31-60": { totalCents: 0, count: 0 },
    "61-90": { totalCents: 0, count: 0 },
    "90+": { totalCents: 0, count: 0 },
  };
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
