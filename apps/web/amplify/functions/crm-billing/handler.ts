import type { AppSyncResolverEvent } from "aws-lambda";
import { dataClient } from "../shared/dataClient";
import { opFieldName } from "../shared/opEvent";
import {
  assertCanActForCustomer,
  assertFinance,
  callerIsOwner,
  callerSub,
} from "../shared/authz";
import { paymentMethodLabel, stripeClient } from "../shared/stripeClient";
import { notifyOffice } from "../shared/email";
import { sendChargeReceipt } from "../shared/receipts";
import { refundInvoice } from "../shared/refund";
import {
  cancelPlanBilling,
  ensureStripeCustomer as sharedEnsureStripeCustomer,
  getDefaultPaymentMethod as sharedGetDefaultPaymentMethod,
  startPlanBilling,
} from "../shared/subscription";
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
      });
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
  const { data: existingInvoices } = await client.models.Invoice.list({
    filter: {
      jobId: { eq: jobId },
      status: { ne: "FAILED" },
    },
  });
  if (existingInvoices.length > 0) {
    throw new Error("This job already has a non-failed invoice");
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
    { idempotencyKey: `crm-job-${jobId}` }
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
  const { data: invoice, errors } = await client.models.Invoice.create({
    customerId: args.customerId,
    jobId: args.jobId ?? undefined,
    description: method ? `${clean} (${method.toLowerCase()})` : clean,
    amountCents: args.amountCents,
    status: args.status,
    method: method === "BANK" ? "BANK" : undefined,
    issuedAt: nowIso,
    ...(args.status === "PAID" ? { paidAt: nowIso } : {}),
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
