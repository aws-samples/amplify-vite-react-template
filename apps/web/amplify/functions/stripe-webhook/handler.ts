import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import type Stripe from "stripe";
import { dataClient } from "../shared/dataClient";
import { paymentMethodLabel, stripeClient } from "../shared/stripeClient";
import { customerAccessGroups } from "../shared/dynamicGroups";
import { finalizeBooking } from "../shared/bookingFinalize";
import { applyRefundToInvoice } from "../shared/refund";
import { notifyOffice } from "../shared/email";
import { escapeHtml, sendChargeReceipt } from "../shared/receipts";
import {
  cancelQueuedPlanVisits,
  type QueuedVisitsResolution,
} from "../shared/subscription";

export const handler = async (
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> => {
  const signature = event.headers["stripe-signature"];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!signature || !secret || !event.body) {
    return { statusCode: 400, body: "Bad request" };
  }

  const payload = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;

  let stripeEvent: Stripe.Event;
  try {
    stripeEvent = stripeClient().webhooks.constructEvent(
      payload,
      signature,
      secret
    );
  } catch {
    return { statusCode: 400, body: "Invalid signature" };
  }

  try {
    switch (stripeEvent.type) {
      case "setup_intent.succeeded":
        await onSetupIntentSucceeded(stripeEvent.data.object);
        break;
      case "payment_intent.succeeded": {
        const pi = stripeEvent.data.object;
        if (pi.metadata?.bookingRequestId) {
          // Website booking funnel: payment creates the CRM records.
          await finalizeBooking({
            bookingRequestId: pi.metadata.bookingRequestId,
            paymentIntentId: pi.id,
            amountReceived: pi.amount_received,
            paymentMethodId:
              typeof pi.payment_method === "string"
                ? pi.payment_method
                : (pi.payment_method?.id ?? null),
          });
        } else {
          await settlePaymentIntent(pi, "PAID");
        }
        break;
      }
      case "payment_intent.payment_failed":
        await settlePaymentIntent(stripeEvent.data.object, "FAILED");
        break;
      case "invoice.paid":
        await onSubscriptionInvoice(stripeEvent.data.object, "PAID");
        break;
      case "invoice.payment_failed":
        await onSubscriptionInvoice(stripeEvent.data.object, "FAILED");
        break;
      // Fires for refunds issued from the Stripe dashboard too, which is the
      // only way one could be issued before the CRM had a refund action.
      // Without this the invoice stays PAID and the money is counted as
      // revenue forever.
      case "charge.refunded":
        await onChargeRefunded(stripeEvent.data.object);
        break;
      case "customer.subscription.deleted":
        await onSubscriptionDeleted(stripeEvent.data.object);
        break;
      default:
        break; // Unhandled event types are acknowledged and ignored.
    }
  } catch (err) {
    console.error("Webhook handling failed", stripeEvent.type, err);
    // 500 so Stripe retries — handlers below are idempotent.
    return { statusCode: 500, body: "Handler error" };
  }

  return { statusCode: 200, body: "ok" };
};

/** Newly saved payment method → make it the customer default + cache label. */
async function onSetupIntentSucceeded(intent: Stripe.SetupIntent) {
  const crmCustomerId = intent.metadata?.crmCustomerId;
  const pmId =
    typeof intent.payment_method === "string"
      ? intent.payment_method
      : intent.payment_method?.id;
  const stripeCustomerId =
    typeof intent.customer === "string" ? intent.customer : intent.customer?.id;
  if (!crmCustomerId || !pmId || !stripeCustomerId) return;

  const stripe = stripeClient();
  await stripe.customers.update(stripeCustomerId, {
    invoice_settings: { default_payment_method: pmId },
  });
  const pm = await stripe.paymentMethods.retrieve(pmId);
  const { label, kind } = paymentMethodLabel(pm);

  const client = await dataClient();
  await client.models.Customer.update({
    id: crmCustomerId,
    paymentMethodLabel: label,
    paymentMethodKind: kind,
  });
}

/** One-time job charges: settle the Invoice created by chargeOneTimeJob. */
async function settlePaymentIntent(
  intent: Stripe.PaymentIntent,
  status: "PAID" | "FAILED"
) {
  const client = await dataClient();
  const { data: invoices } = await client.models.Invoice.listInvoiceByStripePaymentIntentId(
    { stripePaymentIntentId: intent.id }
  );
  const invoice = invoices[0];
  if (!invoice || invoice.status === status) return;
  await client.models.Invoice.update({
    id: invoice.id,
    status,
    ...(status === "PAID"
      ? { paidAt: new Date().toISOString(), failureReason: null }
      : {
          failureReason:
            intent.last_payment_error?.message ?? "Payment failed",
        }),
  });
  // The charge just became real money, so the customer hears about it now.
  // Instant card charges got their receipt from chargeOneTimeJob /
  // chargeManualAmount; this covers the ones that settle later (bank debits),
  // and the status guard above keeps a replayed webhook from sending twice.
  if (status === "PAID") {
    await sendChargeReceipt({
      customerId: invoice.customerId,
      amountCents: invoice.amountCents,
      description: invoice.description ?? "Pest control service",
      invoiceId: invoice.id,
    });
  }
}

/**
 * Subscription billing: upsert an Invoice record per Stripe invoice so the
 * office reporting (billed/paid/unpaid) sees recurring charges too.
 */
async function onSubscriptionInvoice(
  stripeInvoice: Stripe.Invoice,
  status: "PAID" | "FAILED"
) {
  const client = await dataClient();

  // Find the CRM subscription via metadata on the Stripe subscription.
  const stripeSubId =
    typeof stripeInvoice.parent?.subscription_details?.subscription ===
    "string"
      ? stripeInvoice.parent.subscription_details.subscription
      : stripeInvoice.parent?.subscription_details?.subscription?.id;
  let crmServicePlanId =
    stripeInvoice.parent?.subscription_details?.metadata?.crmServicePlanId;
  let crmCustomerId =
    stripeInvoice.parent?.subscription_details?.metadata?.crmCustomerId;
  if ((!crmServicePlanId || !crmCustomerId) && stripeSubId) {
    const stripeSub = await stripeClient().subscriptions.retrieve(stripeSubId);
    crmServicePlanId ??= stripeSub.metadata?.crmServicePlanId;
    crmCustomerId ??= stripeSub.metadata?.crmCustomerId;
  }
  if (!crmServicePlanId || !crmCustomerId) return;

  const { data: existing } = await client.models.Invoice.list({
    filter: { stripeInvoiceId: { eq: stripeInvoice.id } },
  });
  const paidAt =
    status === "PAID"
      ? new Date(
          (stripeInvoice.status_transitions?.paid_at ??
            stripeInvoice.created) * 1000
        ).toISOString()
      : undefined;

  if (existing[0]) {
    if (existing[0].status !== status) {
      await client.models.Invoice.update({
        id: existing[0].id,
        status,
        ...(paidAt ? { paidAt, failureReason: null } : {}),
        ...(status === "FAILED"
          ? { failureReason: "Subscription payment failed" }
          : {}),
      });
      if (status === "PAID" && existing[0].amountCents > 0) {
        await sendChargeReceipt({
          customerId: crmCustomerId,
          amountCents: existing[0].amountCents,
          description: existing[0].description ?? "Subscription payment",
          invoiceId: existing[0].id,
        });
      }
    }
    return;
  }

  const { data: customer } = await client.models.Customer.get({
    id: crmCustomerId,
  });
  const { data: sub } = await client.models.ServicePlan.get({
    id: crmServicePlanId,
  });
  const description = `${sub?.planName ?? "Subscription"} — ${new Date(
    stripeInvoice.created * 1000
  ).toLocaleDateString("en-US", { month: "long", year: "numeric" })}`;
  const { data: created } = await client.models.Invoice.create({
    customerId: crmCustomerId,
    servicePlanId: crmServicePlanId,
    description,
    amountCents: stripeInvoice.amount_due,
    status,
    stripeInvoiceId: stripeInvoice.id,
    issuedAt: new Date(stripeInvoice.created * 1000).toISOString(),
    ...(paidAt ? { paidAt } : {}),
    ...(status === "FAILED"
      ? { failureReason: "Subscription payment failed" }
      : {}),
    accessGroups: customerAccessGroups(crmCustomerId, customer?.groupId),
  });
  // The monthly settlement is a real charge on a real card — it gets the same
  // receipt as any other. The existing-invoice path above only emails on a
  // status *change*, so a replayed webhook cannot send this twice.
  if (status === "PAID" && stripeInvoice.amount_due > 0) {
    await sendChargeReceipt({
      customerId: crmCustomerId,
      amountCents: stripeInvoice.amount_due,
      description,
      invoiceId: created?.id,
    });
  }
}

/**
 * Money went back — ours or one issued from the Stripe dashboard. Stripe's
 * amount_refunded is the authority, so a replay converges instead of doubling.
 */
async function onChargeRefunded(charge: Stripe.Charge) {
  const paymentIntentId =
    typeof charge.payment_intent === "string"
      ? charge.payment_intent
      : charge.payment_intent?.id;
  if (!paymentIntentId) return;
  await applyRefundToInvoice({
    paymentIntentId,
    amountRefundedCents: charge.amount_refunded,
    refundId: charge.refunds?.data?.[0]?.id,
  });
}

/**
 * A subscription died at Stripe without going through the CRM — canceled from
 * the Stripe dashboard, or by Stripe itself after repeated failed payments.
 * Losing a recurring customer must never be a silent database update: the plan
 * flips, the stranded next visit comes off the schedule (or is surfaced for a
 * decision), and the office is told the same day.
 *
 * The CRM's own cancel paths run cancelPlanBilling, which marks the plan
 * CANCELED before this webhook arrives — the status guard below is what keeps
 * those from being double-announced.
 */
async function onSubscriptionDeleted(stripeSub: Stripe.Subscription) {
  const crmServicePlanId = stripeSub.metadata?.crmServicePlanId;
  if (!crmServicePlanId) return;
  const client = await dataClient();
  const { data: sub } = await client.models.ServicePlan.get({
    id: crmServicePlanId,
  });
  if (!sub || sub.status === "CANCELED") return;
  await client.models.ServicePlan.update({
    id: crmServicePlanId,
    status: "CANCELED",
    // Clear the id too, so "the plan has a subscription id" always means a live
    // one — a cancelled plan holding a dead id reads as healthy everywhere.
    stripeSubscriptionId: null,
    canceledAt: new Date().toISOString(),
  });

  // Nothing below may throw: the plan is now CANCELED, so a Stripe retry of
  // this event would hit the guard above and never send the alert at all.
  // Failures are folded into the email instead.
  let queued: QueuedVisitsResolution | null = null;
  try {
    queued = await cancelQueuedPlanVisits(
      crmServicePlanId,
      "the plan's subscription was canceled at Stripe"
    );
  } catch (err) {
    console.error(
      `onSubscriptionDeleted: could not resolve queued visits for plan ${crmServicePlanId}`,
      err
    );
  }

  let customerName = sub.customerId;
  try {
    const { data: customer } = await client.models.Customer.get({
      id: sub.customerId,
    });
    if (customer?.displayName) customerName = customer.displayName;
  } catch (err) {
    console.error("onSubscriptionDeleted: customer lookup failed", err);
  }

  const monthly = `$${(sub.priceCents / 100).toFixed(2)}/mo`;
  const perYear = `$${((sub.priceCents * 12) / 100).toFixed(2)}/yr`;
  const visitLines: string[] = [];
  if (!queued) {
    visitLines.push(
      `<p style="color:#b91c1c;"><strong>The schedule could not be checked for queued visits.</strong> Open the Schedule and cancel this customer's queued visits by hand — anything left will dispatch a technician for free.</p>`
    );
  } else {
    if (queued.canceled.length > 0) {
      visitLines.push(
        `<p>Their queued visit${queued.canceled.length === 1 ? "" : "s"} (${queued.canceled
          .map((v) => v.scheduledDate ?? "unscheduled")
          .join(", ")}) ${queued.canceled.length === 1 ? "was" : "were"} taken off the schedule so no technician dispatches for free.</p>`
      );
    }
    if (queued.failed.length > 0) {
      visitLines.push(
        `<p style="color:#b91c1c;"><strong>${queued.failed.length} queued visit${queued.failed.length === 1 ? "" : "s"} could not be taken off the schedule.</strong> Cancel ${queued.failed.length === 1 ? "it" : "them"} by hand or a technician will be dispatched for free.</p>`
      );
    }
    if (queued.needsDecision.length > 0) {
      visitLines.push(
        `<p><strong>Still on the schedule and needing a decision:</strong></p>
         <ul>${queued.needsDecision
           .map((v) => `<li>${v.scheduledDate ?? "unscheduled"} — ${v.why}</li>`)
           .join("")}</ul>`
      );
    }
  }

  await notifyOffice({
    subject: `ACTION REQUIRED — recurring plan stopped at Stripe: ${customerName}`,
    heading: "A recurring plan stopped billing at Stripe",
    template: "ops-subscription-died",
    customerId: sub.customerId,
    relatedId: crmServicePlanId,
    bodyHtml: `<p><strong>${escapeHtml(customerName)}</strong>'s <strong>${escapeHtml(sub.planName ?? "plan")}</strong> (${monthly} — about ${perYear}) stopped billing at Stripe. This did not come from the CRM: it was canceled from the Stripe dashboard, or by Stripe itself after repeated failed payments.</p>
       ${visitLines.join("\n       ")}
       <p><strong>Call ${escapeHtml(customerName)} today.</strong> If this is a mistake, collect a payment method and start a new plan. If they meant to leave, this is the retention call — either way, losing a recurring customer should never be a silent database update.</p>`,
  });
}
