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
import { emailShell, notifyOffice, sendEmail } from "../shared/email";
import {
  escapeHtml,
  sendChargeReceipt,
  sendPaymentFailedNotice,
} from "../shared/receipts";
import {
  clearPlanDelinquency,
  nextDunningAtIso,
} from "../shared/recovery";
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
      // GL-06: an async funnel payment (e.g. bank debit) is still clearing —
      // hold the slot as PROCESSING, never a commitment, until it resolves.
      case "payment_intent.processing":
        await onFunnelPaymentProcessing(stripeEvent.data.object);
        break;
      case "payment_intent.payment_failed": {
        const pi = stripeEvent.data.object;
        // A funnel payment has no invoice yet (finalization never ran), so it is
        // handled directly — the booking is marked failed and the customer told.
        // Everything else settles its invoice FAILED.
        const handledAsFunnel = await onFunnelPaymentFailed(pi);
        if (!handledAsFunnel) await settlePaymentIntent(pi, "FAILED");
        break;
      }
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
      case "charge.dispute.created":
        await onDisputeCreated(stripeEvent.data.object);
        break;
      case "charge.dispute.closed":
        await onDisputeClosed(stripeEvent.data.object);
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
/**
 * GL-06 — a funnel payment entered `processing` (an async method still clearing).
 * Mark the booking PROCESSING: the slot is held but it is NOT a commitment (no
 * job, no confirmation) until the money lands. Only advances from QUOTED, and
 * only for the intent the booking currently points at, so an out-of-order or
 * stale event can never downgrade a booking that already succeeded/finalized.
 */
async function onFunnelPaymentProcessing(intent: Stripe.PaymentIntent) {
  const bookingRequestId = intent.metadata?.bookingRequestId;
  if (!bookingRequestId) return;
  const client = await dataClient();
  const { data: booking } = await client.models.BookingRequest.get({
    id: bookingRequestId,
  });
  if (!booking || booking.status !== "QUOTED") return;
  if (
    booking.stripePaymentIntentId &&
    booking.stripePaymentIntentId !== intent.id
  ) {
    return;
  }
  await client.models.BookingRequest.update({
    id: booking.id,
    status: "PROCESSING",
  });
}

/**
 * GL-06 — a funnel payment failed. A funnel booking has no CRM customer or
 * invoice yet (finalization only runs on success), so there is nothing to
 * settle: mark the booking PAYMENT_FAILED with the reason, and tell the customer
 * once (retry-safe) that no charge was made and their slot is still open.
 * Returns true when this WAS a funnel booking (so the caller skips invoice
 * settlement), false otherwise.
 */
async function onFunnelPaymentFailed(
  intent: Stripe.PaymentIntent
): Promise<boolean> {
  const bookingRequestId = intent.metadata?.bookingRequestId;
  if (!bookingRequestId) return false;
  const client = await dataClient();
  const { data: booking } = await client.models.BookingRequest.get({
    id: bookingRequestId,
  });
  if (!booking) return true;
  // A booking that already succeeded is not un-booked by a stale failure event,
  // and a repointed intent's failure is not this booking's.
  if (booking.status === "BOOKED") return true;
  if (
    booking.stripePaymentIntentId &&
    booking.stripePaymentIntentId !== intent.id
  ) {
    return true;
  }
  const reason = intent.last_payment_error?.message ?? "The payment was declined.";
  await client.models.BookingRequest.update({
    id: booking.id,
    status: "PAYMENT_FAILED",
    paymentFailedReason: reason,
  });
  // Tell the customer once — the marker keeps a replayed webhook from re-sending.
  if (!booking.paymentFailedNoticeSentAt && booking.email) {
    const marketingUrl = process.env.MARKETING_URL ?? "https://www.pestbuzzkill.com";
    const dateLine = booking.selectedDate
      ? `${escapeHtml(booking.selectedDate)} `
      : "";
    const sent = await sendEmail({
      to: booking.email,
      subject: "Your BuzzKill booking didn't go through",
      template: "booking-payment-failed",
      relatedId: booking.id,
      html: emailShell(
        "Your payment didn't go through",
        `<p>Hi ${escapeHtml(booking.name ?? "there")},</p>
         <p>We couldn't complete the payment for your ${dateLine}pest control booking, so <strong>the booking was not completed and you have not been charged</strong>.</p>
         <p>Your slot is still open. You can pick a time and try again here:</p>
         <p><a href="${marketingUrl}/quote">Book your visit</a></p>
         <p>If you keep having trouble, reply to this email or give us a call and we'll help.</p>`
      ),
    });
    if (sent) {
      await client.models.BookingRequest.update({
        id: booking.id,
        paymentFailedNoticeSentAt: new Date().toISOString(),
      });
    }
  }
  return true;
}

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
  const reason =
    status === "FAILED" ? invoiceDeclineReason(stripeInvoice) : undefined;
  const nowIso = new Date().toISOString();
  // A subscription invoice's retries belong to Stripe (its smart retries hit
  // the same card on its own schedule), so we do NOT arm our own dunning
  // cadence here — doing so would double-charge. We record the real decline
  // reason and, below, suspend the plan from dispatch immediately.
  const failedFields = reason ? { failureReason: reason } : {};

  type Row = { id: string; amountCents: number; description?: string | null };
  let row: Row | null = null;
  let transitioned = false;

  if (existing[0]) {
    // Already in this state: a replayed webhook. Do nothing so it never
    // re-emails or re-schedules dunning.
    if (existing[0].status === status) return;
    transitioned = true;
    await client.models.Invoice.update({
      id: existing[0].id,
      status,
      ...(paidAt
        ? { paidAt, failureReason: null, nextDunningAt: null }
        : {}),
      ...failedFields,
    });
    row = {
      id: existing[0].id,
      amountCents: existing[0].amountCents,
      description: existing[0].description,
    };
    if (status === "PAID" && existing[0].amountCents > 0) {
      await sendChargeReceipt({
        customerId: crmCustomerId,
        amountCents: existing[0].amountCents,
        description: existing[0].description ?? "Subscription payment",
        invoiceId: existing[0].id,
      });
    }
  } else {
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
      ...failedFields,
      accessGroups: customerAccessGroups(crmCustomerId, customer?.groupId),
    });
    transitioned = true;
    row = {
      id: created?.id ?? "",
      amountCents: stripeInvoice.amount_due,
      description,
    };
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

  if (!transitioned || !row) return;
  if (status === "PAID") {
    // The customer is current again — lift any delinquency suspension so the
    // recurring engine resumes dispatching visits.
    await clearPlanDelinquency(crmServicePlanId);
  } else {
    await onSubscriptionInvoiceFailed({
      invoiceId: row.id,
      customerId: crmCustomerId,
      servicePlanId: crmServicePlanId,
      amountCents: row.amountCents,
      description: row.description ?? "Subscription payment",
      reason: reason ?? "The payment was declined",
    });
  }
}

/** Best-effort real decline reason off a failed Stripe invoice. */
function invoiceDeclineReason(inv: Stripe.Invoice): string {
  const anyInv = inv as unknown as {
    last_finalization_error?: { message?: string };
    payment_intent?: { last_payment_error?: { message?: string } };
    charge?: { failure_message?: string };
  };
  return (
    anyInv.last_finalization_error?.message ||
    anyInv.payment_intent?.last_payment_error?.message ||
    anyInv.charge?.failure_message ||
    "The card payment was declined"
  );
}

/**
 * A subscription charge failed: tell the customer (amount + real reason + a pay
 * link) and page the office. The dunning schedule is already stamped on the
 * invoice by the caller; the daily cron drives the retries from here.
 */
async function onSubscriptionInvoiceFailed(opts: {
  invoiceId: string;
  customerId: string;
  servicePlanId: string;
  amountCents: number;
  description: string;
  reason: string;
}) {
  const client = await dataClient();
  // The card died: suspend the plan from dispatch NOW, not after a cadence.
  // recurring.ts skips a delinquent plan, so no tech is routed to a customer
  // whose subscription isn't paying. Stripe keeps retrying the card; a
  // successful retry fires invoice.paid, which clears the delinquency.
  await client.models.ServicePlan.update({
    id: opts.servicePlanId,
    delinquent: true,
    delinquentSince: new Date().toISOString(),
  });

  const customerReached = await sendPaymentFailedNotice({
    customerId: opts.customerId,
    amountCents: opts.amountCents,
    description: opts.description,
    reason: opts.reason,
    invoiceId: opts.invoiceId,
  });

  const { data: customer } = await client.models.Customer.get({
    id: opts.customerId,
  });
  const name = customer?.displayName ?? opts.customerId;
  await notifyOffice({
    subject: `Payment failed — ${name}: $${(opts.amountCents / 100).toFixed(2)}`,
    heading: "A subscription payment failed",
    template: "ops-invoice-payment-failed",
    customerId: opts.customerId,
    relatedId: opts.invoiceId,
    bodyHtml: `<p><strong>${escapeHtml(name)}</strong>'s payment of <strong>$${(opts.amountCents / 100).toFixed(2)}</strong> for ${escapeHtml(opts.description)} failed.</p>
       <p><strong>Reason:</strong> ${escapeHtml(opts.reason)}</p>
       <p>${
         customerReached
           ? "The customer has been emailed a link to update their card and pay."
           : "<strong>The customer has no email on file</strong> — reach out another way."
       } The plan is suspended from dispatch until it pays, so no further visits go out; Stripe automatically retries the card, and a successful retry resumes the plan.</p>`,
  });
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

/** Stripe dashboard URL for a dispute — BuzzKill responds to evidence there. */
const disputeDashboardUrl = (id: string) =>
  `https://dashboard.stripe.com/disputes/${id}`;

/** id off a Stripe field that may be a string id or an expanded object. */
function idOf(
  v: string | { id?: string } | null | undefined
): string | undefined {
  if (!v) return undefined;
  return typeof v === "string" ? v : v.id;
}

/**
 * A card chargeback opened (R02). Money has already been pulled back out of the
 * account and there is a hard deadline to respond — miss it and the dispute is
 * lost by default. Create the Dispute row (linked to the customer/invoice via
 * the charge's payment_intent) and page the office with the amount, the
 * deadline, and a Stripe-dashboard link. BuzzKill builds no evidence editor —
 * the office responds in Stripe.
 *
 * Replay-safe: deduped by stripeDisputeId.
 */
async function onDisputeCreated(dispute: Stripe.Dispute) {
  const client = await dataClient();
  const { data: dupes } =
    await client.models.Dispute.listDisputeByStripeDisputeId({
      stripeDisputeId: dispute.id,
    });
  if (dupes[0]) return; // already recorded — replayed webhook

  const piId = idOf(dispute.payment_intent);
  let customerId: string | undefined;
  let invoiceId: string | undefined;
  let groupId: string | null | undefined;
  if (piId) {
    const { data: matches } =
      await client.models.Invoice.listInvoiceByStripePaymentIntentId({
        stripePaymentIntentId: piId,
      });
    const invoice = matches[0];
    if (invoice) {
      invoiceId = invoice.id;
      customerId = invoice.customerId;
      const { data: customer } = await client.models.Customer.get({
        id: invoice.customerId,
      });
      groupId = customer?.groupId;
    }
  }

  const evidenceDueBy = dispute.evidence_details?.due_by
    ? new Date(dispute.evidence_details.due_by * 1000).toISOString()
    : undefined;
  const openedAt = dispute.created
    ? new Date(dispute.created * 1000).toISOString()
    : new Date().toISOString();

  await client.models.Dispute.create({
    stripeDisputeId: dispute.id,
    customerId,
    invoiceId,
    amountCents: dispute.amount,
    reason: dispute.reason ?? undefined,
    status: "NEEDS_RESPONSE",
    evidenceDueBy,
    openedAt,
    ...(customerId
      ? { accessGroups: customerAccessGroups(customerId, groupId) }
      : {}),
  });

  const { data: customer } = customerId
    ? await client.models.Customer.get({ id: customerId })
    : { data: null };
  const name = customer?.displayName ?? "an unknown customer";
  const deadline = evidenceDueBy
    ? new Date(evidenceDueBy).toLocaleDateString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
        timeZone: "UTC",
      })
    : "unknown — check Stripe";
  await notifyOffice({
    subject: `ACTION REQUIRED — card dispute opened: ${name} ($${(dispute.amount / 100).toFixed(2)})`,
    heading: "A card dispute was opened",
    template: "ops-dispute-opened",
    customerId,
    relatedId: dispute.id,
    bodyHtml: `<p>A customer (<strong>${escapeHtml(name)}</strong>) has disputed a charge of <strong>$${(dispute.amount / 100).toFixed(2)}</strong>${dispute.reason ? ` — reason given: <em>${escapeHtml(dispute.reason)}</em>` : ""}.</p>
       <p><strong>Evidence is due by ${escapeHtml(deadline)}.</strong> Miss that deadline and the dispute is lost by default and the money is gone.</p>
       <p>Respond in the Stripe dashboard — BuzzKill does not build an evidence editor:</p>
       <p style="margin:20px 0;"><a href="${disputeDashboardUrl(dispute.id)}" style="background:#176b2c;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600;">Open the dispute in Stripe</a></p>`,
  });
}

/**
 * A dispute closed (R02): set the outcome (WON/LOST) and closedAt. Replay-safe —
 * a dispute already in its terminal state is a no-op. If the created event was
 * somehow missed we still record the closure so the outcome is never lost.
 */
async function onDisputeClosed(dispute: Stripe.Dispute) {
  const client = await dataClient();
  const status: "WON" | "LOST" = dispute.status === "won" ? "WON" : "LOST";
  const closedAt = new Date().toISOString();

  const { data: rows } = await client.models.Dispute.listDisputeByStripeDisputeId(
    { stripeDisputeId: dispute.id }
  );
  const existing = rows[0];
  if (existing) {
    if (existing.status === status) return; // already closed this way — replay
    await client.models.Dispute.update({ id: existing.id, status, closedAt });
  } else {
    // The created event never landed — record the closure anyway rather than
    // lose the outcome.
    await client.models.Dispute.create({
      stripeDisputeId: dispute.id,
      amountCents: dispute.amount,
      reason: dispute.reason ?? undefined,
      status,
      closedAt,
      openedAt: dispute.created
        ? new Date(dispute.created * 1000).toISOString()
        : undefined,
    });
  }

  await notifyOffice({
    subject: `Card dispute ${status === "WON" ? "won" : "lost"} ($${(dispute.amount / 100).toFixed(2)})`,
    heading: `A card dispute was ${status === "WON" ? "won" : "lost"}`,
    template: "ops-dispute-closed",
    relatedId: dispute.id,
    bodyHtml: `<p>The <strong>$${(dispute.amount / 100).toFixed(2)}</strong> dispute has closed: <strong>${status === "WON" ? "won — the funds stay with BuzzKill" : "lost — the funds have gone back to the customer"}</strong>.</p>
       <p><a href="${disputeDashboardUrl(dispute.id)}">View it in Stripe</a></p>`,
  });
}
