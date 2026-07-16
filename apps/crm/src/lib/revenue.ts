/**
 * Revenue arithmetic for the office Dashboard.
 *
 * A pure module because these are the numbers the business reads to decide
 * whether it is being paid — they need to be testable without a browser.
 *
 * The rule that matters: money that came back is not revenue. A fully refunded
 * invoice is REFUNDED; a partly refunded one stays PAID with a non-zero
 * refundedAmountCents. Filtering on status alone counts the partial refund as
 * revenue forever, so every figure nets refundedAmountCents out.
 */

export type RevenueInvoice = {
  amountCents: number;
  status?: string | null;
  refundedAmountCents?: number | null;
};

export type RevenueTotals = {
  /** Invoiced, less anything refunded. */
  billedCents: number;
  /** Actually collected and kept. */
  paidCents: number;
  /** Outstanding. */
  openCents: number;
  /** Declined. */
  failedCents: number;
  /** Given back. Netted out of billed and paid, shown separately. */
  refundedCents: number;
};

const isSettled = (i: RevenueInvoice) =>
  i.status === "PAID" || i.status === "REFUNDED";

export function refundedOf(i: RevenueInvoice): number {
  return i.refundedAmountCents ?? 0;
}

/** What a customer actually kept us paid for on one invoice. */
export function netCollectedCents(i: RevenueInvoice): number {
  if (!isSettled(i)) return 0;
  return Math.max(0, i.amountCents - refundedOf(i));
}

export function revenueTotals(invoices: RevenueInvoice[]): RevenueTotals {
  const sum = (list: RevenueInvoice[], f: (i: RevenueInvoice) => number) =>
    list.reduce((s, i) => s + f(i), 0);

  const refundedCents = sum(invoices.filter(isSettled), refundedOf);

  return {
    billedCents: sum(invoices, (i) => i.amountCents) - refundedCents,
    paidCents: sum(invoices, netCollectedCents),
    openCents: sum(
      invoices.filter((i) => i.status === "OPEN"),
      (i) => i.amountCents
    ),
    failedCents: sum(
      invoices.filter((i) => i.status === "FAILED"),
      (i) => i.amountCents
    ),
    refundedCents,
  };
}
