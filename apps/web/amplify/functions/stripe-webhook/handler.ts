import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import type Stripe from "stripe";
import { dataClient } from "../shared/dataClient";
import { paymentMethodLabel, stripeClient } from "../shared/stripeClient";
import { customerAccessGroups } from "../shared/dynamicGroups";
import { finalizeBooking } from "../shared/bookingFinalize";

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
    }
    return;
  }

  const { data: customer } = await client.models.Customer.get({
    id: crmCustomerId,
  });
  const { data: sub } = await client.models.ServicePlan.get({
    id: crmServicePlanId,
  });
  await client.models.Invoice.create({
    customerId: crmCustomerId,
    servicePlanId: crmServicePlanId,
    description: `${sub?.planName ?? "Subscription"} — ${new Date(
      stripeInvoice.created * 1000
    ).toLocaleDateString("en-US", { month: "long", year: "numeric" })}`,
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
}

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
    canceledAt: new Date().toISOString(),
  });
}
