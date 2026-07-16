import type Stripe from "stripe";
import { dataClient } from "./dataClient";

/**
 * Refunds.
 *
 * Two ways money goes back, and both have to land on the same invoice fields or
 * the ledger lies:
 *
 *   1. `refundInvoice` — a CSR refunds from the CRM. This is the intended path.
 *   2. `applyRefundToInvoice` — the `charge.refunded` webhook, which also fires
 *      for refunds issued from the Stripe dashboard. Without it, a dashboard
 *      refund leaves the invoice PAID forever and the Dashboard keeps counting
 *      the money as revenue.
 *
 * Both are expressed as "the invoice has now had N cents refunded in total",
 * which is idempotent: replaying the webhook, or the webhook landing after the
 * mutation already wrote the same number, converges rather than double-counts.
 */

/** What an invoice needs for refund maths. */
type RefundableInvoice = {
  id: string;
  amountCents: number;
  status: string | null;
  refundedAmountCents?: number | null;
  stripePaymentIntentId?: string | null;
};

export function alreadyRefunded(invoice: RefundableInvoice): number {
  return invoice.refundedAmountCents ?? 0;
}

export function refundableRemaining(invoice: RefundableInvoice): number {
  return Math.max(0, invoice.amountCents - alreadyRefunded(invoice));
}

/** REFUNDED only once every cent is back; a partial refund stays PAID. */
export function statusAfterRefund(
  invoice: RefundableInvoice,
  refundedTotalCents: number
): "PAID" | "REFUNDED" {
  return refundedTotalCents >= invoice.amountCents ? "REFUNDED" : "PAID";
}

export type RefundOutcome = {
  invoiceId: string;
  refundedNowCents: number;
  refundedTotalCents: number;
  status: "PAID" | "REFUNDED";
  /** False when the invoice was an offline payment — nothing went to Stripe. */
  sentToStripe: boolean;
  stripeRefundId?: string;
};

/**
 * Refund an invoice. `amountCents` omitted refunds whatever is outstanding.
 *
 * Throws rather than reporting an outcome, because unlike job completion the
 * caller here is a person who pressed a button and is waiting for the answer:
 * a refund that did not happen must not look like one that did.
 */
export async function refundInvoice(
  stripe: Stripe,
  opts: { invoiceId: string; amountCents?: number | null; reason: string }
): Promise<RefundOutcome> {
  const client = await dataClient();
  const { data: invoice } = await client.models.Invoice.get({
    id: opts.invoiceId,
  });
  if (!invoice) throw new Error(`Invoice ${opts.invoiceId} not found`);

  const reason = opts.reason.trim();
  if (!reason) throw new Error("A reason is required to refund an invoice");

  if (invoice.status !== "PAID" && invoice.status !== "REFUNDED") {
    throw new Error(
      `This invoice is ${String(invoice.status).toLowerCase()} — only a paid invoice can be refunded`
    );
  }

  const remaining = refundableRemaining(invoice);
  if (remaining <= 0) {
    throw new Error("This invoice has already been refunded in full");
  }

  const requested = opts.amountCents ?? remaining;
  if (!Number.isInteger(requested) || requested <= 0) {
    throw new Error("Enter a valid amount to refund");
  }
  if (requested > remaining) {
    throw new Error(
      `That is more than is left to refund on this invoice ($${(remaining / 100).toFixed(2)})`
    );
  }

  let stripeRefundId: string | undefined;
  let sentToStripe = false;
  if (invoice.stripePaymentIntentId) {
    // Keyed on the invoice and the running total, so a double-tap refunds once
    // while a deliberate second partial refund still goes through.
    const refund = await stripe.refunds.create(
      {
        payment_intent: invoice.stripePaymentIntentId,
        amount: requested,
        metadata: { crmInvoiceId: invoice.id, reason },
      },
      {
        idempotencyKey: `crm-refund-${invoice.id}-${alreadyRefunded(invoice)}-${requested}`,
      }
    );
    stripeRefundId = refund.id;
    sentToStripe = true;
  }
  // No PaymentIntent means the office recorded an offline payment — no card was
  // ever charged, so there is nothing for Stripe to send back. Recording it here
  // is the whole job: the cash went back in the real world and the ledger has to
  // agree.

  const refundedTotal = alreadyRefunded(invoice) + requested;
  const status = statusAfterRefund(invoice, refundedTotal);
  const { data: updated, errors } = await client.models.Invoice.update({
    id: invoice.id,
    refundedAmountCents: refundedTotal,
    refundedAt: new Date().toISOString(),
    refundReason: reason,
    status,
    ...(stripeRefundId ? { stripeRefundId } : {}),
  });
  if (!updated) {
    // The money is already back with the customer. This must be loud: the
    // ledger now overstates revenue and only a human can reconcile it.
    throw new Error(
      `Refund of $${(requested / 100).toFixed(2)} was issued${
        stripeRefundId ? ` (Stripe ${stripeRefundId})` : ""
      } but the invoice could not be updated — tell the office to reconcile invoice ${invoice.id} by hand. ${
        errors?.map((e) => e.message).join("; ") ?? ""
      }`
    );
  }

  return {
    invoiceId: invoice.id,
    refundedNowCents: requested,
    refundedTotalCents: refundedTotal,
    status,
    sentToStripe,
    stripeRefundId,
  };
}

/**
 * Reconcile an invoice against Stripe's view of what has been refunded.
 * Called by the `charge.refunded` webhook, which fires for refunds issued from
 * the Stripe dashboard as well as our own.
 *
 * Takes the total from Stripe rather than adding to ours — Stripe is the
 * authority on how much money actually went back, and a replayed webhook must
 * converge on the same number rather than double it.
 */
export async function applyRefundToInvoice(opts: {
  paymentIntentId: string;
  amountRefundedCents: number;
  refundId?: string;
}): Promise<{ invoiceId: string; status: string } | null> {
  const client = await dataClient();
  const { data: matches } =
    await client.models.Invoice.listInvoiceByStripePaymentIntentId({
      stripePaymentIntentId: opts.paymentIntentId,
    });
  const invoice = matches[0];
  if (!invoice) {
    console.warn(
      `charge.refunded: no invoice for PaymentIntent ${opts.paymentIntentId}`
    );
    return null;
  }
  if (alreadyRefunded(invoice) === opts.amountRefundedCents) {
    return { invoiceId: invoice.id, status: String(invoice.status) };
  }

  const status = statusAfterRefund(invoice, opts.amountRefundedCents);
  await client.models.Invoice.update({
    id: invoice.id,
    refundedAmountCents: opts.amountRefundedCents,
    refundedAt: new Date().toISOString(),
    status,
    ...(opts.refundId ? { stripeRefundId: opts.refundId } : {}),
    ...(invoice.refundReason ? {} : { refundReason: "Refunded in Stripe" }),
  });
  return { invoiceId: invoice.id, status };
}
