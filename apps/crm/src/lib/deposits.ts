/**
 * Bank-deposit tracking for manually collected money.
 *
 * Stripe money reaches the bank on its own (Stripe payouts); cash and cheques
 * reach the bank only if somebody physically takes them there. This module
 * decides which settled invoices are that kind of money, so the dashboard can
 * hold a "waiting to be deposited" list until someone confirms the deposit
 * landed (Invoice.depositedAt, stamped by the settleInvoice MARK_DEPOSITED
 * action).
 */

export type DepositInvoice = {
  status?: string | null;
  amountCents: number;
  refundedAmountCents?: number | null;
  stripePaymentIntentId?: string | null;
  stripeInvoiceId?: string | null;
  depositedAt?: string | null;
};

/**
 * Settled money that arrived outside Stripe — recorded by hand (cash, cheque,
 * direct transfer) via recordOfflinePayment or an OFFLINE settle. Anything
 * with a Stripe id gets to the bank via Stripe payouts and never needs a
 * manual deposit confirmation.
 */
export function isManualSettled(i: DepositInvoice): boolean {
  return (
    (i.status === "PAID" || i.status === "REFUNDED") &&
    !i.stripePaymentIntentId &&
    !i.stripeInvoiceId
  );
}

/** Manual money still sitting in a drawer as far as anyone has recorded. */
export function awaitingDeposit<T extends DepositInvoice>(invoices: T[]): T[] {
  return invoices.filter((i) => isManualSettled(i) && !i.depositedAt);
}

/** What actually needs banking: the kept amount, net of refunds. */
export function depositableCents(i: DepositInvoice): number {
  return Math.max(0, i.amountCents - (i.refundedAmountCents ?? 0));
}
