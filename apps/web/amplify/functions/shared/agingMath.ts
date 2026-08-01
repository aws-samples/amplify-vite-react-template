/**
 * AR aging and payment-terms arithmetic — the pure half of shared/recovery.ts,
 * split out (like marketRateKeys.ts) so the CRM can value-import it into the
 * browser bundle. recovery.ts itself charges cards (Stripe, SES, dataClient)
 * and must never reach a browser.
 *
 * These are the numbers the business reads to decide how bad its receivables
 * are, and the office Dashboard and every server-side aging report must agree
 * — to the dollar. The bucket boundaries, the "dueDate falling back to
 * issuedAt" basis rule, the whole-day UTC arithmetic, and the terms→due-date
 * rule are the contract; they all live here and nowhere else.
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

// ── Day arithmetic ───────────────────────────────────────────────────────

/** The date portion (YYYY-MM-DD) of an ISO date or datetime string. */
export function toYmd(iso: string): string {
  return iso.slice(0, 10);
}

/** Whole-day number (UTC) for a date-only or datetime ISO string. */
export function utcDayNumber(iso: string): number {
  const d = new Date(iso.length <= 10 ? `${iso}T00:00:00Z` : iso);
  return Math.floor(d.getTime() / 86_400_000);
}

/**
 * Whole days from `fromYmd` to `untilYmd`, positive when `untilYmd` is later.
 * Both are YYYY-MM-DD; the diff is taken in UTC so a DST change never adds or
 * drops a day.
 */
export function daysBetween(fromYmd: string, untilYmd: string): number {
  return utcDayNumber(untilYmd) - utcDayNumber(fromYmd);
}

// ── Aging buckets ────────────────────────────────────────────────────────

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

/**
 * Which aging bucket a given days-past-due lands in. The boundaries:
 *   <= 0  CURRENT (not yet due)
 *   1–30  D1_30
 *   31–60 D31_60
 *   61–90 D61_90   (90 days past due is still D61_90, not D90_PLUS)
 *   > 90  D90_PLUS
 */
export function agingBucketForDays(days: number): AgingBucket {
  if (days <= 0) return "CURRENT";
  if (days <= 30) return "D1_30";
  if (days <= 60) return "D31_60";
  if (days <= 90) return "D61_90";
  return "D90_PLUS";
}

/**
 * The date an invoice's clock runs from: its due date, or the day it was
 * issued if it has no due date. Null when neither is known (nothing to age).
 */
export function dueBasis(inv: {
  dueDate?: string | null;
  issuedAt?: string | null;
}): string | null {
  if (inv.dueDate) return toYmd(inv.dueDate);
  if (inv.issuedAt) return toYmd(inv.issuedAt);
  return null;
}
