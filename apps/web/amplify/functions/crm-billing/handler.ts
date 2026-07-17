import type { AppSyncResolverEvent } from "aws-lambda";
import { dataClient } from "../shared/dataClient";
import { opFieldName } from "../shared/opEvent";
import {
  assertCanActForCustomer,
  assertFinance,
  callerIsFinance,
  callerIsOwner,
  callerSub,
} from "../shared/authz";
import type { AppSyncIdentity } from "aws-lambda";
import { paymentMethodLabel, stripeClient } from "../shared/stripeClient";
import { notifyOffice } from "../shared/email";
import { sendChargeReceipt } from "../shared/receipts";
import { refundInvoice } from "../shared/refund";
import {
  clearPlanDelinquency,
  dueDateForTerms,
  normalizeTerms,
  settleInvoiceOnCard,
} from "../shared/recovery";
import {
  cancelPlanBilling,
  ensureStripeCustomer as sharedEnsureStripeCustomer,
  getDefaultPaymentMethod as sharedGetDefaultPaymentMethod,
  startPlanBilling,
} from "../shared/subscription";
import { deactivateCustomer as sharedDeactivateCustomer } from "../shared/deactivation";
import { customerAccessGroups } from "../shared/dynamicGroups";

type Args = {
  customerId?: string;
  servicePlanId?: string;
  jobId?: string;
  amountCents?: number;
  description?: string;
  idempotencyKey?: string;
  invoiceId?: string;
  reason?: string;
  status?: string;
  method?: string;
  terms?: string;
  poNumber?: string;
  note?: string;
  kind?: string;
  id?: string;
};

// The shared helpers take an injected Stripe client because booking-public
// resolves its secret differently. In here it is always the env-backed one.
const ensureStripeCustomer = (customerId: string) =>
  sharedEnsureStripeCustomer(stripeClient(), customerId);
const getDefaultPaymentMethod = (stripeCustomerId: string) =>
  sharedGetDefaultPaymentMethod(stripeClient(), stripeCustomerId);

/**
 * Who is doing this, taken from the verified Cognito identity rather than from
 * anything the browser sent. Every money record carries it.
 */
type Actor = { sub: string | null; email: string | null; isOwner: boolean };

function actorOf(event: AppSyncResolverEvent<Args>): Actor {
  const identity = event.identity as { claims?: Record<string, unknown> } | null;
  const email = identity?.claims?.email;
  return {
    sub: callerSub(event.identity),
    email: typeof email === "string" ? email : null,
    isOwner: callerIsOwner(event.identity),
  };
}

const actorStamp = (a: Actor) => ({
  createdBy: a.sub ?? undefined,
  createdByEmail: a.email ?? undefined,
});

/**
 * What a BuzzKill job can plausibly cost, with room above the rate card's own
 * ceiling: AI-priced rodent work clamps at $2,500 and a large HOA one-time can
 * exceed that, so a lower bar would send real work to the owner for approval —
 * which is the bottleneck this product is supposed to remove.
 *
 * This is a backstop, not the control. It catches the classic hundred-fold slip
 * ($149.00 typed as 14900) on anything over $50; the confirmation the CRM shows
 * before calling this is what catches the rest.
 */
const MANUAL_CHARGE_CEILING_CENTS = 500_000; // $5,000
/** Nothing this business does is a single $20,000 card charge. */
const ABSOLUTE_CHARGE_CEILING_CENTS = 2_000_000;

function assertChargeableAmount(actor: Actor, amountCents: number) {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new Error("Enter a valid amount to charge");
  }
  if (amountCents > ABSOLUTE_CHARGE_CEILING_CENTS) {
    throw new Error(
      `$${(amountCents / 100).toLocaleString("en-US")} is beyond anything this business charges to a card. If it is genuinely owed, take it another way — do not split it into smaller charges.`
    );
  }
  if (amountCents > MANUAL_CHARGE_CEILING_CENTS && !actor.isOwner) {
    throw new Error(
      `$${(amountCents / 100).toLocaleString("en-US")} is over the $${(MANUAL_CHARGE_CEILING_CENTS / 100).toLocaleString("en-US")} limit for a single charge. An owner can take it — do not split it into smaller charges.`
    );
  }
}

export const handler = async (event: AppSyncResolverEvent<Args>) => {
  switch (opFieldName(event)) {
    case "createSetupIntent": {
      assertCanActForCustomer(event.identity, event.arguments.customerId!);
      return createSetupIntent(event.arguments.customerId!);
    }
    case "getPaymentMethodSummary": {
      assertCanActForCustomer(event.identity, event.arguments.customerId!);
      return getPaymentMethodSummary(event.arguments.customerId!);
    }
    case "startSubscription": {
      assertFinance(event.identity);
      return startSubscription(event.arguments.servicePlanId!);
    }
    case "cancelSubscription": {
      assertFinance(event.identity);
      return cancelSubscription(event.arguments.servicePlanId!);
    }
    case "deactivateCustomer": {
      // Cancels subscriptions = money authority, so FINANCE/OWNER, mirroring
      // cancelSubscription.
      assertFinance(event.identity);
      return sharedDeactivateCustomer(stripeClient(), event.arguments.customerId!);
    }
    case "pausePlan": {
      assertFinance(event.identity);
      return setPlanPaused(event.arguments.servicePlanId!, true);
    }
    case "resumePlan": {
      assertFinance(event.identity);
      return setPlanPaused(event.arguments.servicePlanId!, false);
    }
    case "chargeOneTimeJob": {
      assertFinance(event.identity);
      return chargeOneTimeJob(actorOf(event), event.arguments.jobId!);
    }
    case "refundInvoice": {
      assertFinance(event.identity);
      return refundInvoice(stripeClient(), {
        invoiceId: event.arguments.invoiceId!,
        amountCents: event.arguments.amountCents ?? null,
        reason: event.arguments.reason ?? "",
        actor: actorOf(event),
      });
    }
    case "chargeManualAmount": {
      assertFinance(event.identity);
      return chargeManualAmount(
        actorOf(event),
        event.arguments.customerId!,
        event.arguments.amountCents!,
        event.arguments.description ?? "",
        event.arguments.idempotencyKey
      );
    }
    case "voidInvoice": {
      assertFinance(event.identity);
      return voidInvoice(
        actorOf(event),
        event.arguments.invoiceId!,
        event.arguments.reason ?? ""
      );
    }
    case "recordOfflinePayment": {
      assertFinance(event.identity);
      return recordOfflinePayment(actorOf(event), {
        customerId: event.arguments.customerId!,
        amountCents: event.arguments.amountCents!,
        description: event.arguments.description ?? "",
        status: event.arguments.status ?? "PAID",
        method: event.arguments.method,
        jobId: event.arguments.jobId,
        terms: event.arguments.terms,
        poNumber: event.arguments.poNumber,
      });
    }
    case "settleInvoice": {
      assertFinance(event.identity);
      return settleInvoice(
        actorOf(event),
        event.arguments.invoiceId!,
        event.arguments.method ?? "",
        event.arguments.note
      );
    }
    case "payInvoice": {
      return payInvoice(actorOf(event), event.identity, event.arguments.invoiceId!);
    }
    case "assignRecoveryOwner": {
      // OWNER/FINANCE/OFFICE — chasing money is office work even though moving
      // it is finance work. The mutation-level authz already excludes everyone
      // else; no money moves here.
      return assignRecoveryOwner(
        actorOf(event),
        event.arguments.kind ?? "",
        event.arguments.id!
      );
    }
    default:
      throw new Error(`Unknown field ${opFieldName(event)}`);
  }
};


/**
 * SetupIntent for saving a card or US bank account for off-session reuse.
 * The webhook (setup_intent.succeeded) makes it the default payment method
 * and caches its label on the Customer record.
 */
async function createSetupIntent(customerId: string) {
  const { stripeCustomerId } = await ensureStripeCustomer(customerId);
  const stripe = stripeClient();
  const intent = await stripe.setupIntents.create({
    customer: stripeCustomerId,
    usage: "off_session",
    payment_method_types: ["card", "us_bank_account"],
    payment_method_options: {
      us_bank_account: {
        financial_connections: { permissions: ["payment_method"] },
      },
    },
    metadata: { crmCustomerId: customerId },
  });
  return { clientSecret: intent.client_secret, stripeCustomerId };
}

async function getPaymentMethodSummary(customerId: string) {
  const client = await dataClient();
  const { data: customer } = await client.models.Customer.get({
    id: customerId,
  });
  if (!customer) throw new Error(`Customer ${customerId} not found`);
  if (!customer.stripeCustomerId) {
    return { hasPaymentMethod: false, label: null, kind: null };
  }
  const pm = await getDefaultPaymentMethod(customer.stripeCustomerId);
  if (!pm) return { hasPaymentMethod: false, label: null, kind: null };
  const { label, kind } = paymentMethodLabel(pm);
  if (customer.paymentMethodLabel !== label) {
    await client.models.Customer.update({
      id: customerId,
      paymentMethodLabel: label,
      paymentMethodKind: kind,
    });
  }
  return { hasPaymentMethod: true, label, kind };
}

/**
 * Office "Start billing" button. Job completion starts billing automatically
 * (crm-docs); this stays as the manual path for plans whose first visit
 * predates that, or whose card arrived late.
 */
async function startSubscription(servicePlanId: string) {
  const outcome = await startPlanBilling(stripeClient(), servicePlanId);
  if (!outcome.started) throw new Error(outcome.message);
  return {
    stripeSubscriptionId: outcome.stripeSubscriptionId,
    existing: outcome.alreadyRunning,
  };
}

async function cancelSubscription(servicePlanId: string) {
  const result = await cancelPlanBilling(stripeClient(), servicePlanId);
  // Auto-canceled visits need no email — the person who pressed Cancel gets the
  // result back. A visit deliberately left on the schedule does: it is money or
  // a promise already made (paid up front, or a tech on site), and this email
  // is the only place that decision surfaces.
  if (result.queuedVisits.needsDecision.length > 0) {
    const client = await dataClient();
    const { data: plan } = await client.models.ServicePlan.get({
      id: servicePlanId,
    });
    const { data: customer } = plan
      ? await client.models.Customer.get({ id: plan.customerId })
      : { data: null };
    const name = customer?.displayName ?? plan?.customerId ?? servicePlanId;
    await notifyOffice({
      subject: `Canceled plan has visits needing a decision: ${name}`,
      heading: "A canceled plan still has visits on the schedule",
      template: "ops-cancel-visits-decision",
      customerId: plan?.customerId,
      relatedId: servicePlanId,
      bodyHtml: `<p><strong>${name}</strong>'s plan${plan ? ` <strong>${plan.planName}</strong>` : ""} was canceled, but ${result.queuedVisits.needsDecision.length === 1 ? "a queued visit was" : "queued visits were"} deliberately left on the schedule:</p>
         <ul>${result.queuedVisits.needsDecision
           .map((v) => `<li>${v.scheduledDate ?? "unscheduled"} — ${v.why}</li>`)
           .join("")}</ul>
         <p><strong>Decide what happens to ${result.queuedVisits.needsDecision.length === 1 ? "it" : "each one"}</strong> — honour it, refund it, or cancel it on the Schedule. Left alone it will dispatch a technician.</p>`,
    });
  }
  return result;
}

/**
 * Deactivate/reactivate a plan without canceling it. When a Stripe
 * subscription is running, pausing voids invoices while paused
 * (pause_collection) and resuming clears it; either way the plan status
 * flips PAUSED ⇄ ACTIVE so scheduling can honor it.
 */
async function setPlanPaused(servicePlanId: string, paused: boolean) {
  const client = await dataClient();
  const { data: sub } = await client.models.ServicePlan.get({
    id: servicePlanId,
  });
  if (!sub) throw new Error(`Service plan ${servicePlanId} not found`);
  if (sub.status === "CANCELED") {
    throw new Error("Plan is canceled — create a new plan instead");
  }
  if (sub.stripeSubscriptionId) {
    const stripe = stripeClient();
    await stripe.subscriptions.update(sub.stripeSubscriptionId, {
      pause_collection: paused
        ? { behavior: "void" }
        : ("" as unknown as { behavior: "void" }), // '' clears the pause per Stripe API convention
    });
  }
  await client.models.ServicePlan.update({
    id: servicePlanId,
    status: paused ? "PAUSED" : "ACTIVE",
  });
  return { paused };
}

/**
 * Charge a one-time job off-session against the default payment method.
 * Creates an OPEN Invoice immediately; payment_intent.succeeded/failed in
 * the webhook settles it to PAID/FAILED.
 */
async function chargeOneTimeJob(actor: Actor, jobId: string) {
  const client = await dataClient();
  const { data: job } = await client.models.Job.get({ id: jobId });
  if (!job) throw new Error(`Job ${jobId} not found`);
  if (!job.priceCents || job.priceCents <= 0) {
    throw new Error("Job has no price to charge");
  }
  // Paid up front at online checkout. This is checked before the Invoice scan
  // because it is written in the same create as the job — it cannot be missing
  // the way a ledger row can, and charging here would be the second charge.
  if (job.paidAt) {
    throw new Error(
      `This job was already paid online on ${job.paidAt.slice(0, 10)} — charging again would double-charge the customer`
    );
  }
  if (job.type !== "ONE_TIME") {
    throw new Error(
      "This is a plan visit — the plan's subscription bills it, not this button"
    );
  }
  // The button charges for work performed, so the server checks the work was
  // performed. The CRM's UI already hides Charge on anything not COMPLETED,
  // but the mutation is reachable without the CRM, and a NO_ACCESS or
  // SCHEDULED job charged in full is money taken for nothing.
  if (job.status !== "COMPLETED") {
    if (job.status === "NO_ACCESS") {
      throw new Error(
        "This visit ended no-access — the technician could not do the work, so there is nothing to charge"
      );
    }
    if (job.status === "CANCELED") {
      throw new Error(
        "This job was canceled — there is no completed work to charge for"
      );
    }
    throw new Error(
      `This job is ${job.status.toLowerCase().replace(/_/g, " ")} — charge it after the work is completed`
    );
  }
  // Paged to exhaustion: a filtered scan counts its limit against rows
  // scanned, not rows matched, so a single page could miss the covering
  // invoice and wave a second charge through.
  const existingInvoices: { status: string | null }[] = [];
  let invoiceToken: string | null | undefined;
  do {
    const { data: page, nextToken } = await client.models.Invoice.list({
      filter: { jobId: { eq: jobId } },
      nextToken: invoiceToken,
    });
    existingInvoices.push(...page);
    invoiceToken = nextToken;
  } while (invoiceToken);
  // FAILED may be retried, and VOID was withdrawn as wrong — neither speaks
  // for the job any more. Anything else (OPEN, PAID, REFUNDED) means the money
  // question was already answered; answering it twice is a double charge, and
  // re-charging a deliberate refund is a decision for the manual charge path.
  const covering = existingInvoices.filter(
    (i) => i.status !== "FAILED" && i.status !== "VOID"
  );
  if (covering.length > 0) {
    throw new Error(
      covering.some((i) => i.status === "REFUNDED")
        ? "This job was charged and then deliberately refunded — if that refund was a mistake, use the manual card charge and say why"
        : "This job already has a non-failed invoice"
    );
  }

  const { customer, stripeCustomerId } = await ensureStripeCustomer(
    job.customerId
  );
  const pm = await getDefaultPaymentMethod(stripeCustomerId);
  if (!pm) {
    throw new Error(
      "Customer has no saved payment method — collect payment info first"
    );
  }

  const stripe = stripeClient();
  const description = `${job.serviceType}${job.scheduledDate ? ` — ${job.scheduledDate}` : ""}`;
  const intent = await stripe.paymentIntents.create(
    {
      customer: stripeCustomerId,
      amount: job.priceCents,
      currency: "usd",
      payment_method: pm.id,
      off_session: true,
      confirm: true,
      description,
      // Belt-and-braces: Stripe sends its own receipt here in live mode. The
      // sendChargeReceipt below is the one that works in every mode.
      receipt_email: customer.email ?? undefined,
      metadata: { crmJobId: jobId, crmCustomerId: job.customerId },
    },
    // The attempt counter is the number of invoice rows this job already has:
    // a bare per-job key would make Stripe replay the first attempt's response
    // for 24 hours — a FAILED retry with a fresh card would get the old
    // decline back. Two racing calls for the same attempt still share a key,
    // so a double-tap replays one intent instead of charging twice.
    { idempotencyKey: `crm-job-${jobId}-a${existingInvoices.length}` }
  );

  const { data: invoice } = await client.models.Invoice.create({
    customerId: job.customerId,
    jobId,
    description,
    amountCents: job.priceCents,
    status: intent.status === "succeeded" ? "PAID" : "OPEN",
    method: pm.type === "us_bank_account" ? "BANK" : "CARD",
    stripePaymentIntentId: intent.id,
    issuedAt: new Date().toISOString(),
    ...(intent.status === "succeeded"
      ? { paidAt: new Date().toISOString() }
      : {}),
    accessGroups: customerAccessGroups(job.customerId, customer.groupId),
  });

  // A charge the customer can't recognize is a dispute. Anything not yet
  // succeeded (bank debits) gets its receipt from the webhook when the
  // invoice settles to PAID.
  if (intent.status === "succeeded") {
    await sendChargeReceipt({
      customerId: job.customerId,
      amountCents: job.priceCents,
      description,
      invoiceId: invoice?.id,
    });
  }

  return {
    invoiceId: invoice?.id,
    paymentIntentId: intent.id,
    status: intent.status,
  };
}

/**
 * Charge an arbitrary amount to a customer's saved payment method and record
 * the invoice — the finance escape hatch for one-off or unusual charges that
 * don't map to a job. Card-on-file only; money taken outside Stripe goes
 * through recordOfflinePayment.
 */
async function chargeManualAmount(
  actor: Actor,
  customerId: string,
  amountCents: number,
  description: string,
  idempotencyKey?: string
) {
  assertChargeableAmount(actor, amountCents);
  const clean = description.trim().slice(0, 300);
  if (!clean) {
    throw new Error(
      "Say what this charge is for — it goes on the customer's statement, and an unexplained charge is one nobody can answer a question about later"
    );
  }

  const client = await dataClient();
  const { customer, stripeCustomerId } = await ensureStripeCustomer(customerId);
  const pm = await getDefaultPaymentMethod(stripeCustomerId);
  if (!pm) {
    throw new Error(
      "Customer has no saved payment method — collect one first, or record an offline payment instead"
    );
  }

  const stripe = stripeClient();
  // A per-submit idempotency token from the client collapses accidental
  // retries/double-taps into a single charge; a deliberate second identical
  // charge uses a fresh token. Fall back to a content-derived key.
  const key =
    idempotencyKey?.slice(0, 200) ||
    `crm-manual-${customerId}-${amountCents}-${Buffer.from(clean).toString("base64url").slice(0, 40)}`;
  const intent = await stripe.paymentIntents.create(
    {
      customer: stripeCustomerId,
      amount: amountCents,
      currency: "usd",
      payment_method: pm.id,
      off_session: true,
      confirm: true,
      description: clean,
      // Belt-and-braces: Stripe sends its own receipt here in live mode. The
      // sendChargeReceipt below is the one that works in every mode.
      receipt_email: customer.email ?? undefined,
      metadata: { crmCustomerId: customerId, manual: "true" },
    },
    { idempotencyKey: `crm-manual-${key}` }
  );

  const { data: invoice } = await client.models.Invoice.create({
    customerId,
    description: clean,
    amountCents,
    status: intent.status === "succeeded" ? "PAID" : "OPEN",
    method: pm.type === "us_bank_account" ? "BANK" : "CARD",
    stripePaymentIntentId: intent.id,
    issuedAt: new Date().toISOString(),
    ...(intent.status === "succeeded"
      ? { paidAt: new Date().toISOString() }
      : {}),
    ...actorStamp(actor),
    accessGroups: customerAccessGroups(customerId, customer.groupId),
  });

  // Same receipt as any other charge — the escape hatch is exactly where an
  // unexplained card charge is most likely to turn into a dispute.
  if (intent.status === "succeeded") {
    await sendChargeReceipt({
      customerId,
      amountCents,
      description: clean,
      invoiceId: invoice?.id,
    });
  }

  return {
    invoiceId: invoice?.id,
    paymentIntentId: intent.id,
    status: intent.status,
  };
}

/**
 * Withdraw an invoice that should not have been raised.
 *
 * Replaces the hard delete an OWNER used to have. A deleted invoice takes its
 * amount, its actor and the fact of its existence with it; a VOID one stays on
 * the books saying who withdrew it and why, and the Dashboard already excludes
 * VOID from every figure.
 *
 * Refuses a paid invoice: money that moved is refunded, not un-remembered.
 */
async function voidInvoice(
  actor: Actor,
  invoiceId: string,
  reason: string
) {
  const clean = reason.trim().slice(0, 300);
  if (!clean) throw new Error("Say why this invoice is being voided");

  const client = await dataClient();
  const { data: invoice } = await client.models.Invoice.get({ id: invoiceId });
  if (!invoice) throw new Error(`Invoice ${invoiceId} not found`);
  if (invoice.status === "VOID") {
    return { invoiceId, status: "VOID", alreadyVoid: true };
  }
  if (invoice.status === "PAID" || invoice.status === "REFUNDED") {
    throw new Error(
      "This invoice has been paid — refund it instead. Voiding it would drop money that actually moved out of the books."
    );
  }

  // An OPEN invoice with a PaymentIntent is a charge still in motion (a bank
  // debit takes days). Voiding the row without touching the intent leaves the
  // charge to land anyway — and frees the job for a second one. The void must
  // also stop the money, or honestly refuse.
  if (invoice.status === "OPEN" && invoice.stripePaymentIntentId) {
    const intent = await stripeClient().paymentIntents.retrieve(
      invoice.stripePaymentIntentId
    );
    if (intent.status === "succeeded") {
      throw new Error(
        "This invoice's payment already went through — it will settle to PAID shortly. Refund it instead of voiding."
      );
    }
    if (intent.status === "processing") {
      throw new Error(
        "This invoice's bank debit is still processing — the money may still arrive. Wait for it to settle or fail, then void or refund."
      );
    }
    if (intent.status !== "canceled") {
      await stripeClient().paymentIntents.cancel(intent.id);
    }
  }

  const { data: updated, errors } = await client.models.Invoice.update({
    id: invoiceId,
    status: "VOID",
    voidedAt: new Date().toISOString(),
    voidReason: clean,
    voidedBy: actor.sub ?? undefined,
    voidedByEmail: actor.email ?? undefined,
  });
  if (!updated) {
    throw new Error(
      `Could not void the invoice: ${errors?.map((e) => e.message).join("; ") ?? "unknown error"}`
    );
  }
  return { invoiceId, status: "VOID", alreadyVoid: false };
}

/**
 * Record money taken outside Stripe (cash, cheque, transfer), or raise an
 * invoice to be settled later. Moves no money — this is bookkeeping.
 *
 * It lives here rather than as a client-side Invoice.create for one reason:
 * the actor. Marking $500 collected without collecting it is the cheapest way
 * to fabricate revenue in this product, and a browser-written record could name
 * anyone as its author.
 */
async function recordOfflinePayment(
  actor: Actor,
  args: {
    customerId: string;
    amountCents: number;
    description: string;
    status: string;
    method?: string | null;
    jobId?: string | null;
    terms?: string | null;
    poNumber?: string | null;
  }
) {
  if (!Number.isInteger(args.amountCents) || args.amountCents <= 0) {
    throw new Error("Enter a valid amount");
  }
  if (args.status !== "PAID" && args.status !== "OPEN") {
    throw new Error(`Unsupported invoice status: ${args.status}`);
  }
  const clean = args.description.trim().slice(0, 300);
  if (!clean) throw new Error("Say what this payment is for");

  const client = await dataClient();
  const { data: customer } = await client.models.Customer.get({
    id: args.customerId,
  });
  if (!customer) throw new Error(`Customer ${args.customerId} not found`);

  const method = (args.method ?? "").trim().toUpperCase();
  const nowIso = new Date().toISOString();
  // An invoice-for-later gets a due date so it can age; money already in hand
  // has nothing to fall due. terms/poNumber only make sense on the OPEN path.
  const isOpen = args.status === "OPEN";
  const poNumber = args.poNumber?.trim().slice(0, 60) || undefined;
  const { data: invoice, errors } = await client.models.Invoice.create({
    customerId: args.customerId,
    jobId: args.jobId ?? undefined,
    description: method ? `${clean} (${method.toLowerCase()})` : clean,
    amountCents: args.amountCents,
    status: args.status,
    method: method === "BANK" ? "BANK" : undefined,
    issuedAt: nowIso,
    ...(args.status === "PAID" ? { paidAt: nowIso } : {}),
    ...(isOpen
      ? {
          terms: normalizeTerms(args.terms),
          dueDate: dueDateForTerms(args.terms, nowIso),
          ...(poNumber ? { poNumber } : {}),
        }
      : {}),
    ...actorStamp(actor),
    accessGroups: customerAccessGroups(args.customerId, customer.groupId),
  });
  if (!invoice) {
    throw new Error(
      `Could not record the payment: ${errors?.map((e) => e.message).join("; ") ?? "unknown error"}`
    );
  }
  return { invoiceId: invoice.id, status: invoice.status };
}

/**
 * Settle an existing OPEN/FAILED invoice when payment arrives (R31).
 *
 *   OFFLINE — cash, cheque, or transfer landed. Marks it PAID with the actor
 *     and an optional reference note. No money moves; this is bookkeeping.
 *   CARD — charges the customer's saved card off-session and settles on
 *     success (shared settleInvoiceOnCard, which also sends the receipt).
 *
 * Idempotent on an already-PAID invoice; refuses anything not OPEN/FAILED.
 */
async function settleInvoice(
  actor: Actor,
  invoiceId: string,
  method: string,
  note?: string | null
) {
  const kind = method.trim().toUpperCase();
  if (kind === "CARD") {
    return settleInvoiceOnCard(stripeClient(), {
      invoiceId,
      actor: { sub: actor.sub, email: actor.email },
      note,
      attemptTag: "settle",
    });
  }
  if (kind !== "OFFLINE") {
    throw new Error(`Unsupported settlement method: ${method}`);
  }

  const client = await dataClient();
  const { data: invoice } = await client.models.Invoice.get({ id: invoiceId });
  if (!invoice) throw new Error(`Invoice ${invoiceId} not found`);
  if (invoice.status === "PAID" || invoice.status === "REFUNDED") {
    return { invoiceId, status: String(invoice.status), alreadyPaid: true };
  }
  if (invoice.status !== "OPEN" && invoice.status !== "FAILED") {
    throw new Error(
      `This invoice is ${String(invoice.status).toLowerCase()} — only an open or failed invoice can be settled`
    );
  }
  // Refuse an offline settle while a card/bank charge is still in flight on
  // this invoice — the same hazard voidInvoice guards. Recording cash now
  // marks it PAID, then the debit lands too and the customer is charged twice
  // with no ledger trace.
  if (invoice.stripePaymentIntentId) {
    const intent = await stripeClient().paymentIntents.retrieve(
      invoice.stripePaymentIntentId
    );
    if (intent.status === "processing" || intent.status === "succeeded") {
      throw new Error(
        "A card or bank payment is already in flight on this invoice — wait for it to settle or fail before recording an offline payment, or you will collect twice."
      );
    }
  }

  const nowIso = new Date().toISOString();
  const cleanNote = note?.trim().slice(0, 300) || undefined;
  const { data: updated, errors } = await client.models.Invoice.update({
    id: invoiceId,
    status: "PAID",
    paidAt: nowIso,
    failureReason: null,
    // Recovery is over for this row.
    nextDunningAt: null,
    lastDunningAt: nowIso,
    settledBy: actor.sub ?? undefined,
    settledByEmail: actor.email ?? undefined,
    ...(cleanNote ? { settleNote: cleanNote } : {}),
  });
  if (!updated) {
    throw new Error(
      `Could not settle the invoice: ${errors?.map((e) => e.message).join("; ") ?? "unknown error"}`
    );
  }
  // A subscription invoice paid by hand un-suspends the plan.
  await clearPlanDelinquency(invoice.servicePlanId);
  return { invoiceId, status: "PAID", alreadyPaid: false };
}

/**
 * The customer-facing pay button, also usable by OWNER/FINANCE (R31). Charges
 * the acting customer's saved card for their OPEN/FAILED invoice.
 *
 * A CUSTOMER may pay only their OWN invoice: we load the invoice first, then
 * authorize against ITS customerId with assertCanActForCustomer, so customer A
 * cannot pay — or even probe the existence of — customer B's invoice. OWNER and
 * FINANCE (callerIsFinance) may pay for anyone.
 */
async function payInvoice(
  actor: Actor,
  identity: AppSyncIdentity | undefined | null,
  invoiceId: string
) {
  const client = await dataClient();
  const { data: invoice } = await client.models.Invoice.get({ id: invoiceId });
  // Same not-authorized error whether the invoice is missing or someone else's,
  // so a customer can't use this to discover another customer's invoice ids.
  if (!invoice) {
    if (!callerIsFinance(identity)) {
      throw new Error("Not authorized for this invoice");
    }
    throw new Error(`Invoice ${invoiceId} not found`);
  }
  if (!callerIsFinance(identity)) {
    try {
      assertCanActForCustomer(identity, invoice.customerId);
    } catch {
      throw new Error("Not authorized for this invoice");
    }
  }

  return settleInvoiceOnCard(stripeClient(), {
    invoiceId,
    actor: { sub: actor.sub, email: actor.email },
    attemptTag: "pay",
  });
}

/**
 * Take ownership of a recovery item (R78) — "Assign to me". Stamps
 * ownerSub/ownerEmail from the caller's own verified identity, never the
 * request, on an Invoice or a Dispute, so every open item has exactly one owner.
 */
async function assignRecoveryOwner(actor: Actor, kind: string, id: string) {
  const which = kind.trim().toUpperCase();
  const client = await dataClient();
  if (which === "INVOICE") {
    const { data: invoice } = await client.models.Invoice.get({ id });
    if (!invoice) throw new Error(`Invoice ${id} not found`);
    const { data: updated, errors } = await client.models.Invoice.update({
      id,
      ownerSub: actor.sub ?? undefined,
      ownerEmail: actor.email ?? undefined,
    });
    if (!updated) {
      throw new Error(
        `Could not assign the owner: ${errors?.map((e) => e.message).join("; ") ?? "unknown error"}`
      );
    }
    return { kind: "INVOICE", id, ownerSub: actor.sub, ownerEmail: actor.email };
  }
  if (which === "DISPUTE") {
    const { data: dispute } = await client.models.Dispute.get({ id });
    if (!dispute) throw new Error(`Dispute ${id} not found`);
    const { data: updated, errors } = await client.models.Dispute.update({
      id,
      ownerSub: actor.sub ?? undefined,
      ownerEmail: actor.email ?? undefined,
    });
    if (!updated) {
      throw new Error(
        `Could not assign the owner: ${errors?.map((e) => e.message).join("; ") ?? "unknown error"}`
      );
    }
    return { kind: "DISPUTE", id, ownerSub: actor.sub, ownerEmail: actor.email };
  }
  throw new Error(`Unknown recovery item kind: ${kind}`);
}
