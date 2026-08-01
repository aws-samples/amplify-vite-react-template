import type Stripe from "stripe";
import { dataClient } from "./dataClient";
import { forEachPage } from "./pagination";
import { sendRefundNotice } from "./receipts";

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
  opts: {
    invoiceId: string;
    amountCents?: number | null;
    reason: string;
    /** Verified Cognito identity of whoever pressed the button. */
    actor?: { sub: string | null; email: string | null };
  }
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
    // Why was already required; who was not. Compelling an explanation for an
    // action whose actor is unrecorded is a strange place to stop.
    ...(opts.actor?.sub ? { refundedBy: opts.actor.sub } : {}),
    ...(opts.actor?.email ? { refundedByEmail: opts.actor.email } : {}),
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

  // The customer hears it from us rather than discovering a mystery credit —
  // or worse, not discovering it and disputing the original charge anyway.
  await sendRefundNotice({
    customerId: invoice.customerId,
    amountCents: requested,
    description: invoice.description,
    invoiceId: invoice.id,
    sentToStripe,
  });

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
  paymentIntentId: string | null;
  /** Fallback lookup: subscription invoices may predate PI stamping. */
  stripeInvoiceId?: string | null;
  amountRefundedCents: number;
  refundId?: string;
}): Promise<{ invoiceId: string; status: string } | null> {
  const client = await dataClient();
  type RefundTargetRow = RefundableInvoice & {
    customerId: string;
    description?: string | null;
    refundReason?: string | null;
  };
  let invoice: RefundTargetRow | null = null;
  if (opts.paymentIntentId) {
    // Zero-page read is deliberate: one PaymentIntent stamps one invoice, so one page holds every match (audit 1.1.5).
    const { data: matches } =
      await client.models.Invoice.listInvoiceByStripePaymentIntentId({
        stripePaymentIntentId: opts.paymentIntentId,
      });
    invoice = (matches[0] as RefundTargetRow | undefined) ?? null;
  }
  if (!invoice && opts.stripeInvoiceId) {
    // A dashboard refund of a subscription charge must still land on the
    // CRM row — without this the settlement gate stays blocked forever
    // after a REAL refund. The filter scan is PAGINATED to exhaustion: the
    // filter applies after each scanned page, so the matching row can sit
    // on any page.
    const stripeInvoiceId = opts.stripeInvoiceId;
    await forEachPage(
      (nextToken) =>
        client.models.Invoice.list({
          filter: { stripeInvoiceId: { eq: stripeInvoiceId } },
          limit: 200,
          nextToken,
        }),
      (items) => {
        invoice = (items[0] as RefundTargetRow | undefined) ?? null;
        if (invoice) return false;
      },
      { pageErrors: "ignore" }
    );
  }
  if (!invoice) {
    console.warn(
      `charge.refunded: no invoice for PaymentIntent ${opts.paymentIntentId ?? "-"} / Stripe invoice ${opts.stripeInvoiceId ?? "-"}`
    );
    return null;
  }
  if (alreadyRefunded(invoice) === opts.amountRefundedCents) {
    return { invoiceId: invoice.id, status: String(invoice.status) };
  }

  const refundedNowCents = opts.amountRefundedCents - alreadyRefunded(invoice);
  const status = statusAfterRefund(invoice, opts.amountRefundedCents);
  await client.models.Invoice.update({
    id: invoice.id,
    refundedAmountCents: opts.amountRefundedCents,
    refundedAt: new Date().toISOString(),
    status,
    ...(opts.refundId ? { stripeRefundId: opts.refundId } : {}),
    ...(invoice.refundReason ? {} : { refundReason: "Refunded in Stripe" }),
  });
  // A dashboard refund is still a refund the customer should hear about. Our
  // own refundInvoice sends its notice and then converges here through the
  // idempotency return above, so this only announces money Stripe moved first.
  if (refundedNowCents > 0) {
    await sendRefundNotice({
      customerId: invoice.customerId,
      amountCents: refundedNowCents,
      description: invoice.description,
      invoiceId: invoice.id,
      sentToStripe: true,
    });
  }
  return { invoiceId: invoice.id, status };
}
