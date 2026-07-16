import type { AppSyncResolverEvent } from "aws-lambda";
import { dataClient } from "../shared/dataClient";
import { opFieldName } from "../shared/opEvent";
import { assertCanActForCustomer, assertFinance } from "../shared/authz";
import { paymentMethodLabel, stripeClient } from "../shared/stripeClient";
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
  approvedBy?: string;
  invoiceId?: string;
  reason?: string;
};

// The shared helpers take an injected Stripe client because booking-public
// resolves its secret differently. In here it is always the env-backed one.
const ensureStripeCustomer = (customerId: string) =>
  sharedEnsureStripeCustomer(stripeClient(), customerId);
const getDefaultPaymentMethod = (stripeCustomerId: string) =>
  sharedGetDefaultPaymentMethod(stripeClient(), stripeCustomerId);

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
      return chargeOneTimeJob(event.arguments.jobId!);
    }
    case "refundInvoice": {
      assertFinance(event.identity);
      return refundInvoice(stripeClient(), {
        invoiceId: event.arguments.invoiceId!,
        amountCents: event.arguments.amountCents ?? null,
        reason: event.arguments.reason ?? "",
      });
    }
    case "chargeManualAmount": {
      assertFinance(event.identity);
      return chargeManualAmount(
        event.arguments.customerId!,
        event.arguments.amountCents!,
        event.arguments.description ?? "Manual charge",
        event.arguments.idempotencyKey
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
  return cancelPlanBilling(stripeClient(), servicePlanId);
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
async function chargeOneTimeJob(jobId: string) {
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

  return {
    invoiceId: invoice?.id,
    paymentIntentId: intent.id,
    status: intent.status,
  };
}

/**
 * Charge an arbitrary amount to a customer's saved payment method and record
 * the invoice — the office escape hatch for one-off or unusual charges that
 * don't map to a job. Card-on-file only; for offline payments the office
 * records an invoice directly (no charge).
 */
async function chargeManualAmount(
  customerId: string,
  amountCents: number,
  description: string,
  idempotencyKey?: string
) {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new Error("Enter a valid amount to charge");
  }
  // TODO(WS2): above CHARGE_APPROVAL_THRESHOLD_CENTS ($500) this must require
  // an approval record created by an OWNER who is not the caller. Blocked on
  // the approval UI — without it, requiring approvedBy would leave FINANCE
  // unable to raise a large charge at all.
  if (amountCents > 2_000_000) {
    throw new Error(
      "That amount is over the $20,000 limit for a single manual charge. Ask an owner — do not split it into smaller charges."
    );
  }
  const client = await dataClient();
  const { customer, stripeCustomerId } = await ensureStripeCustomer(customerId);
  const pm = await getDefaultPaymentMethod(stripeCustomerId);
  if (!pm) {
    throw new Error(
      "Customer has no saved payment method — collect one first, or record an offline invoice instead"
    );
  }

  const clean = description.trim().slice(0, 300) || "Manual charge";
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
    accessGroups: customerAccessGroups(customerId, customer.groupId),
  });

  return {
    invoiceId: invoice?.id,
    paymentIntentId: intent.id,
    status: intent.status,
  };
}
