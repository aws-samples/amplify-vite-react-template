import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import type Stripe from "stripe";
import { dataClient } from "../shared/dataClient";
import { paymentMethodLabel, stripeClient } from "../shared/stripeClient";
import { customerAccessGroups } from "../shared/dynamicGroups";
import { finalizeBooking } from "../shared/bookingFinalize";
import { recordFunnelPaymentFailure } from "../shared/bookingPaymentFailure";
import { applyRefundToInvoice } from "../shared/refund";
import { emailShell, notifyOffice, sendEmail } from "../shared/email";
import {
  claimDaySlot,
  extendCapacityClaim,
  releaseCapacityClaim,
  consumeCapacityClaim,
  PROCESSING_CLAIM_MS,
} from "../shared/capacity";
import {
  escapeHtml,
  sendChargeReceipt,
  sendPaymentFailedNotice,
  sendPostCancellationChargeNotice,
} from "../shared/receipts";
import {
  clearPlanDelinquency,
  nextDunningAtIso,
} from "../shared/recovery";
import { openOwnedWork } from "../shared/ownedWork";
import { casGuardedUpdate } from "../shared/atomicLock";
import { forEachPage, listAll } from "../shared/pagination";
import {
  cancelQueuedPlanVisits,
  startPlanBilling,
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
      // GL-06: an async funnel payment (a pending US bank debit) is
      // sufficient to book — the FULL commitment (customer, job, capacity,
      // pending invoice, agreement, truthful confirmation) is created NOW,
      // with every surface saying "Payment pending" until it settles.
      // GL-04: the checkout's capacity claim is EXTENDED first so the slot
      // stays a counted fact until finalize consumes it into the job.
      case "payment_intent.processing": {
        const pi = stripeEvent.data.object;
        if (pi.metadata?.bookingRequestId) {
          const extended = await extendCapacityClaim(
            pi.metadata.bookingRequestId,
            PROCESSING_CLAIM_MS
          );
          if (!extended) {
            // The hold expired and was swept before the debit was reported —
            // RE-CLAIM from the booking's stamped slot facts. A slot that
            // meanwhile sold out is left unclaimed here; finalize owns the
            // truthful fallback (pool ledger + owned re-place case).
            const client = await dataClient();
            const { data: bk } = await client.models.BookingRequest.get({
              id: pi.metadata.bookingRequestId,
            }).catch(() => ({ data: null }));
            const tech = (bk as { capacityTechnicianId?: string | null } | null)
              ?.capacityTechnicianId;
            const minutes = (bk as { capacityMinutes?: number | null } | null)
              ?.capacityMinutes;
            if (bk?.selectedDate && tech && minutes != null) {
              await claimDaySlot({
                claimKey: bk.id,
                date: bk.selectedDate,
                technicianId: tech,
                minutes,
                holdMs: PROCESSING_CLAIM_MS,
                holdReason: `pending bank debit for ${bk.email ?? bk.id}`,
              }).catch(() => undefined);
            }
          }
        }
        await onFunnelPaymentProcessing(pi);
        break;
      }
      case "payment_intent.payment_failed": {
        const pi = stripeEvent.data.object;
        // GL-04: a failed funnel payment releases the checkout's capacity
        // claim — the slot goes back on sale. (A pending commitment's claim
        // was already CONSUMED into its job; that capacity is released by
        // settlePendingFailure's exactly-once job cancel instead.)
        if (pi.metadata?.bookingRequestId) {
          await releaseCapacityClaim(pi.metadata.bookingRequestId);
        }
        // A funnel payment that never finalized has no invoice, so it is
        // handled directly — the booking is marked failed, any pending
        // commitment is unwound or converted, and the customer told.
        // Everything else settles its invoice FAILED.
        const handledAsFunnel = await onFunnelPaymentFailed(pi);
        if (!handledAsFunnel) await settlePaymentIntent(pi, "FAILED");
        break;
      }
      // GL-06: a canceled intent that was backing a pending commitment is the
      // same business fact as a failed one — the money will never arrive.
      case "payment_intent.canceled": {
        const pi = stripeEvent.data.object;
        if (pi.metadata?.bookingRequestId) {
          await releaseCapacityClaim(pi.metadata.bookingRequestId);
          await onFunnelPaymentFailed(
            pi,
            "The payment was canceled before it completed."
          );
        }
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

  // Now that a card/bank is on file, start billing on any ACTIVE-not-billing
  // plan this customer holds — the migrated book and office-converted leads
  // sit ACTIVE with no subscription until exactly this moment. Best-effort per
  // plan: a failure is logged and the plan can still be started by hand from
  // the customer page. startPlanBilling is idempotent (a plan already billing
  // is a no-op) and anchors migrated plans to their stored bill day.
  const plans = await listAll(
    (nextToken) =>
      client.models.ServicePlan.list({
        filter: {
          customerId: { eq: crmCustomerId },
          status: { eq: "ACTIVE" },
        },
        limit: 200,
        nextToken,
      }),
    { pageErrors: "ignore" }
  );
  const toStart: string[] = plans
    .filter((plan) => !plan.stripeSubscriptionId)
    .map((plan) => plan.id);
  for (const planId of toStart) {
    try {
      const outcome = await startPlanBilling(stripe, planId);
      if (!outcome.started) {
        console.error(
          "onSetupIntentSucceeded: could not start billing",
          planId,
          outcome.reason,
          outcome.message
        );
      }
    } catch (err) {
      console.error("onSetupIntentSucceeded: start-billing threw", planId, err);
    }
  }
}

/** One-time job charges: settle the Invoice created by chargeOneTimeJob. */
/**
 * GL-06 — a funnel payment entered `processing`: a pending bank debit is
 * sufficient to book. The complete commitment is created immediately via
 * finalizeBooking's pending mode — customer, agreement/mandate record,
 * scheduled job (dispatchable), consumed capacity, OPEN invoice, and a
 * truthful "visit scheduled — payment processing" confirmation. Idempotent
 * and resumable: a thrown error leaves owned work and lets Stripe redeliver.
 */
async function onFunnelPaymentProcessing(intent: Stripe.PaymentIntent) {
  const bookingRequestId = intent.metadata?.bookingRequestId;
  if (!bookingRequestId) return;
  await finalizeBooking({
    bookingRequestId,
    paymentIntentId: intent.id,
    amountReceived: intent.amount,
    paymentMethodId:
      typeof intent.payment_method === "string"
        ? intent.payment_method
        : (intent.payment_method?.id ?? null),
    pending: {
      methodLabel: intent.payment_method_types?.includes("us_bank_account")
        ? "bank transfer (ACH)"
        : (intent.payment_method_types?.[0] ?? null),
    },
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
  intent: Stripe.PaymentIntent,
  reasonOverride?: string
): Promise<boolean> {
  const bookingRequestId = intent.metadata?.bookingRequestId;
  if (!bookingRequestId) return false;
  // The shared failure path (also driven by the daily reconcile sweep for
  // failures whose webhook never arrived): conditional transition, exactly-
  // once unwind/convert of any pending commitment, one truthful customer
  // notice. Throws on UNSUPPORTED so Stripe redelivers.
  await recordFunnelPaymentFailure({
    bookingRequestId,
    intentId: intent.id,
    reason:
      reasonOverride ??
      intent.last_payment_error?.message ??
      "The payment was declined.",
  });
  return true;
}

async function settlePaymentIntent(
  intent: Stripe.PaymentIntent,
  status: "PAID" | "FAILED"
) {
  const client = await dataClient();
  // Zero-page read is deliberate: one PaymentIntent stamps one invoice, so one page holds every match (audit 1.1.5).
  const { data: invoices } = await client.models.Invoice.listInvoiceByStripePaymentIntentId(
    { stripePaymentIntentId: intent.id }
  );
  const invoice = invoices[0];
  if (!invoice || invoice.status === status) return;
  await client.models.Invoice.update({
    id: invoice.id,
    status,
    // GL-06: the pending bank debit has now resolved (settled or failed), so the
    // "un-payable while clearing" mark is lifted — a FAILED invoice becomes
    // payable again, a PAID one is done.
    pendingDebitIntentId: null,
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

  // PAGINATED to exhaustion: this lookup is BOTH the replay guard and the
  // FAILED→PAID transition path — a row hiding past the first filter-scan
  // page would otherwise be duplicated on the smart-retry success.
  const existing: { id: string; amountCents: number; description?: string | null; status?: string | null }[] = [];
  await forEachPage(
    (nextToken) =>
      client.models.Invoice.list({
        filter: { stripeInvoiceId: { eq: stripeInvoice.id } },
        limit: 200,
        nextToken,
      }),
    (invoices) => {
      existing.push(
        ...(invoices as unknown as typeof existing)
      );
      if (existing.length) return false;
    },
    { pageErrors: "ignore" }
  );
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

  // The PaymentIntent behind the invoice charge — WITHOUT it a refund can
  // only be recorded as offline (no Stripe money movement) and a dashboard
  // refund can't find this row. Both make "refunded" a lie. On the current
  // Stripe API (basil+) the invoice has NO top-level payment_intent — the
  // mapping lives on InvoicePayments, in the payload when included and via
  // the API otherwise.
  const paymentsOnPayload = (
    stripeInvoice as unknown as {
      payments?: {
        data?: {
          payment?: { payment_intent?: string | { id: string } | null };
        }[];
      };
    }
  ).payments?.data;
  let stripePaymentIntentId: string | undefined;
  for (const p of paymentsOnPayload ?? []) {
    const pi = p.payment?.payment_intent;
    const id = typeof pi === "string" ? pi : pi?.id;
    if (id) {
      stripePaymentIntentId = id;
      break;
    }
  }
  if (!stripePaymentIntentId && status === "PAID") {
    try {
      const { data: invoicePayments } = await stripeClient().invoicePayments.list({
        invoice: stripeInvoice.id,
        status: "paid",
        limit: 3,
      });
      for (const p of invoicePayments) {
        const pi = p.payment?.payment_intent;
        const id = typeof pi === "string" ? pi : pi?.id;
        if (id) {
          stripePaymentIntentId = id;
          break;
        }
      }
    } catch (err) {
      console.error(
        `invoice.paid: could not resolve the PaymentIntent for ${stripeInvoice.id} — a refund of this row would be recorded offline`,
        err
      );
    }
  }

  if (existing[0]) {
    // Already in this state: a replayed webhook. Do nothing so it never
    // re-emails or re-schedules dunning.
    if (existing[0].status === status) return;
    transitioned = true;
    await client.models.Invoice.update({
      id: existing[0].id,
      status,
      ...(stripePaymentIntentId ? { stripePaymentIntentId } : {}),
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
      stripePaymentIntentId,
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
  }

  if (!transitioned || !row) return;
  if (status === "PAID") {
    // The monthly settlement is a real charge on a real card. Normally the
    // customer gets a receipt — but a charge that posted after they cancelled is
    // handled truthfully instead (GL-08 R2). Only fires on a status *change*, so
    // a replayed webhook can never send twice.
    await onPaidSubscriptionCharge({
      customerId: crmCustomerId,
      servicePlanId: crmServicePlanId,
      invoiceId: row.id,
      amountCents: row.amountCents,
      description: row.description ?? "Subscription payment",
      // GL-08 R3: judged by when the money actually MOVED — an invoice
      // created before the cancellation but charged after (bank debit, card
      // retry) is still a post-cancellation charge.
      paidAtUnix:
        stripeInvoice.status_transitions?.paid_at ?? stripeInvoice.created,
    });
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

/**
 * A subscription charge settled. Normally the customer gets a receipt — but
 * GL-08 R2: if it posted on/after the customer's accepted cancellation time, it
 * is a charge that should not have happened. We do NOT send a "you were charged"
 * receipt; we tell the truth that we're refunding it and open (or re-open, via
 * the shared servicePlanId dedupe key) the Finance-owned PLAN_CANCELLATION_
 * RECOVERY case marking the refund owed. Per the 2026-07-18 business decision the
 * refund itself is a Finance-approved action, not an automatic money movement,
 * so this stages it for a person rather than issuing it here.
 */
async function onPaidSubscriptionCharge(opts: {
  customerId: string;
  servicePlanId: string;
  invoiceId: string;
  amountCents: number;
  description: string;
  paidAtUnix: number;
}) {
  if (opts.amountCents <= 0) return;
  const client = await dataClient();
  const { data: plan } = await client.models.ServicePlan.get({
    id: opts.servicePlanId,
  });
  // The accepted cancellation time: the mutable plan stamp, with the DURABLE
  // command's requestedAt as the fallback — a swallowed plan write must not
  // turn a post-cancellation charge into an ordinary receipt.
  let requestedAt = plan?.cancellationRequestedAt ?? null;
  if (!requestedAt && "PlanCancellationClaim" in client.models) {
    const { data: claim } = await client.models.PlanCancellationClaim.get({
      id: opts.servicePlanId,
    }).catch(() => ({ data: null }));
    requestedAt = claim?.requestedAt ?? null;
  }
  // Office/deactivation/dashboard cancels stamp canceledAt at the moment
  // billing stopped — without this fallback their post-cancel charges read
  // as ordinary receipts and nothing owns the refund.
  if (!requestedAt) {
    requestedAt =
      (plan as { canceledAt?: string | null } | null)?.canceledAt ?? null;
  }
  const postCancellation =
    Boolean(requestedAt) &&
    opts.paidAtUnix * 1000 >= new Date(requestedAt as string).getTime();

  if (!postCancellation) {
    await sendChargeReceipt({
      customerId: opts.customerId,
      amountCents: opts.amountCents,
      description: opts.description,
      invoiceId: opts.invoiceId,
    });
    return;
  }

  await stagePostCancellationCharge({
    servicePlanId: opts.servicePlanId,
    planName: plan?.planName ?? null,
    customerId: opts.customerId,
    invoiceId: opts.invoiceId,
    amountCents: opts.amountCents,
    requestedAt: requestedAt as string,
  });
}

/**
 * GL-08 R2/R3: a charge that posted AFTER an accepted cancellation gets a
 * durable Finance case FIRST, then the refund-promise notice — never an
 * ordinary receipt. Called from invoice.paid (anchor already stamped) AND
 * from subscription.deleted's late-charge rescan (charge landed in the
 * delivery retry gap, before any anchor existed).
 */
async function stagePostCancellationCharge(opts: {
  servicePlanId: string;
  planName: string | null;
  customerId: string;
  invoiceId: string;
  amountCents: number;
  requestedAt: string;
}) {
  const amountUsd = `$${(opts.amountCents / 100).toFixed(2)}`;
  const caseId = await openOwnedWork({
    kind: "PLAN_CANCELLATION_RECOVERY",
    dedupeKey: opts.servicePlanId,
    title: `Refund a charge that posted after cancellation: ${opts.planName ?? opts.servicePlanId}`,
    detail: `${amountUsd} was paid on this plan after the customer's cancellation was accepted (${opts.requestedAt}). Refund invoice ${opts.invoiceId} IN FULL — a partial refund does not settle it — and make sure the subscription is actually cancelled so no further charge posts.`,
    customerId: opts.customerId,
    relatedId: opts.servicePlanId,
    sourceUrl: `/customers/${opts.customerId}`,
    resolutionAction:
      "Refund this invoice in full from the customer's billing page, then resume the cancellation. This case can't close until the plan is canceled, every visit is cleared, and this refund is fully settled.",
    ownerTeam: "FINANCE",
  });
  if (caseId) {
    // SEND-ONCE: invoice.paid and the subscription.deleted rescan can both
    // stage this charge concurrently — the notice goes out exactly once,
    // decided by an atomic marker claim on the invoice row. UNSUPPORTED
    // (no CAS wiring) sends anyway: a duplicate email is recoverable, a
    // missing refund promise is the lie GL-08 forbids.
    const marker = await casGuardedUpdate(
      "Invoice",
      opts.invoiceId,
      { postCancelNoticeSentAt: new Date().toISOString() },
      [{ kind: "fieldMissingOrNull", field: "postCancelNoticeSentAt" }]
    );
    if (marker.ok || marker.reason === "UNSUPPORTED") {
      await sendPostCancellationChargeNotice({
        customerId: opts.customerId,
        amountCents: opts.amountCents,
        invoiceId: opts.invoiceId,
      });
    }
  } else {
    // The case could not be written: no customer promise. Page the office
    // urgently instead — the settlement check (full-refund-required) keeps
    // the cancellation open until a person finishes this.
    await notifyOffice({
      subject: `URGENT — post-cancellation charge with NO case: ${opts.planName ?? opts.servicePlanId}`,
      heading: "A post-cancellation charge could not be put in the owned queue",
      template: "ops-post-cancel-charge-unowned",
      customerId: opts.customerId,
      relatedId: opts.servicePlanId,
      bodyHtml: `<p>${amountUsd} was paid on plan ${opts.servicePlanId} AFTER the customer's accepted cancellation (${opts.requestedAt}), and the Finance recovery case could not be written. The customer has NOT been messaged. Refund invoice ${opts.invoiceId} in full and re-run the cancellation now.</p>`,
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
  // charge.invoice no longer exists on the current Stripe API (basil+) — a
  // subscription-invoice charge maps to its invoice via InvoicePayments.
  // Resolving it here lets a dashboard refund land on a CRM row that predates
  // PI stamping instead of leaving refundedAmountCents at 0 forever.
  // One-time charges simply return an EMPTY list here (no throw) — so any
  // throw is a real Stripe API failure and must propagate: the handler 500s
  // and Stripe redelivers, instead of a transient fault permanently losing
  // the refund for an unstamped legacy row.
  let stripeInvoiceId: string | null = null;
  const { data: invoicePayments } = await stripeClient().invoicePayments.list({
    payment: { type: "payment_intent", payment_intent: paymentIntentId },
    limit: 1,
  });
  const inv = invoicePayments[0]?.invoice;
  stripeInvoiceId = typeof inv === "string" ? inv : (inv?.id ?? null);
  await applyRefundToInvoice({
    paymentIntentId,
    stripeInvoiceId,
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
  // The anchor is the subscription's REAL cancel moment from Stripe — not
  // webhook delivery time. A retried delivery must not re-date the
  // cancellation past a charge that settled in the retry gap.
  const canceledAtIso = stripeSub.canceled_at
    ? new Date(stripeSub.canceled_at * 1000).toISOString()
    : new Date().toISOString();
  const { data: planFlipped, errors: planFlipErrors } =
    await client.models.ServicePlan.update({
      id: crmServicePlanId,
      status: "CANCELED",
      // Clear the id too, so "the plan has a subscription id" always means a live
      // one — a cancelled plan holding a dead id reads as healthy everywhere.
      stripeSubscriptionId: null,
      // GL-08 R3: keep the durable reference for the settlement readback.
      canceledStripeSubscriptionId: stripeSub.id,
      canceledAt: canceledAtIso,
      // A dashboard cancel is an accepted cancellation too — anchor it so
      // later charges are judged against the real cancel moment.
      cancellationRequestedAt: sub.cancellationRequestedAt ?? canceledAtIso,
    });
  if (!planFlipped) {
    // THROW so the handler 500s and Stripe redelivers: acking a lost anchor
    // write would leave the plan ACTIVE forever (free dispatch) and every
    // later charge judged as an ordinary receipt.
    throw new Error(
      `subscription.deleted: plan ${crmServicePlanId} did not flip: ${
        planFlipErrors?.map((e) => e.message).join("; ") ?? "unknown error"
      }`
    );
  }

  // LATE-CHARGE RESCAN: a charge that settled during this event's delivery
  // retry gap was receipted as ordinary (no anchor existed yet) — now that
  // the anchor is stamped, re-judge every PAID invoice on the plan and stage
  // the refund case + customer notice for any post-cancellation charge.
  // invoice.paid is never redelivered, so this rescan is the only path that
  // catches them.
  try {
    await forEachPage(
      (nextToken) =>
        client.models.Invoice.list({
          filter: { servicePlanId: { eq: crmServicePlanId } },
          limit: 200,
          nextToken,
        }),
      async (invoices) => {
        for (const inv of invoices) {
          const paidAt = inv.paidAt ?? inv.issuedAt ?? "";
          if (
            inv.status === "PAID" &&
            paidAt >= canceledAtIso &&
            (inv.refundedAmountCents ?? 0) < (inv.amountCents ?? 0)
          ) {
            await stagePostCancellationCharge({
              servicePlanId: crmServicePlanId,
              planName: sub.planName ?? null,
              customerId: sub.customerId,
              invoiceId: inv.id,
              amountCents: inv.amountCents ?? 0,
              requestedAt: canceledAtIso,
            });
          }
        }
      },
      { pageErrors: "ignore" }
    );
  } catch (err) {
    // The settlement gate (full-refund-required) still blocks the close;
    // this rescan failing only delays the staged case, never the truth.
    console.error("onSubscriptionDeleted: late-charge rescan failed", err);
  }

  // Nothing below may throw: the plan is now CANCELED, so a Stripe retry of
  // this event would hit the guard above and never send the alert at all.
  // Failures are folded into the email instead.
  let queued: QueuedVisitsResolution | null = null;
  try {
    queued = await cancelQueuedPlanVisits(
      crmServicePlanId,
      "the plan's subscription was canceled at Stripe",
      // GL-08: the SAME anchor written to cancellationRequestedAt above, so the
      // hour-exact 72-hour line is judged from the subscription's real cancel
      // moment (not webhook delivery/retry time).
      Date.parse(sub.cancellationRequestedAt ?? canceledAtIso)
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
    if ((queued.refundsOwed ?? []).length > 0) {
      visitLines.push(
        `<p><strong>Refunds owed in full (the visit was more than 72 hours out — the Finance case prescribes the exact amount):</strong></p>
         <ul>${(queued.refundsOwed ?? [])
           .map((v) => `<li>${v.scheduledDate ?? "unscheduled"} — $${(v.amountCents / 100).toFixed(2)}</li>`)
           .join("")}</ul>`
      );
    }
    if ((queued.retained ?? []).length > 0) {
      visitLines.push(
        `<p>Payment retained per the 72-hour policy (visit within 72 hours): ${(queued.retained ?? [])
          .map((v) => `${v.scheduledDate ?? "unscheduled"} — $${(v.amountCents / 100).toFixed(2)}`)
          .join(", ")}.</p>`
      );
    }
    if (queued.needsDecision.length > 0) {
      visitLines.push(
        `<p><strong>Needing a decision (technician on site, or a payment still in motion):</strong></p>
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
  // Zero-page read is deliberate: one Stripe dispute id maps to one Dispute row, so one page holds every match (audit 1.1.5).
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
    // Zero-page read is deliberate: one PaymentIntent stamps one invoice, so one page holds every match (audit 1.1.5).
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

  // Zero-page read is deliberate: one Stripe dispute id maps to one Dispute row, so one page holds every match (audit 1.1.5).
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
