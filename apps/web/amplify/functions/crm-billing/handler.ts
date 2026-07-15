import type { AppSyncResolverEvent } from "aws-lambda";
import { dataClient } from "../shared/dataClient";
import { opFieldName } from "../shared/opEvent";
import { assertCanActForCustomer, callerIsOffice } from "../shared/authz";
import { paymentMethodLabel, stripeClient } from "../shared/stripeClient";
import { customerAccessGroups } from "../shared/dynamicGroups";

type Args = {
  customerId?: string;
  servicePlanId?: string;
  jobId?: string;
  amountCents?: number;
  description?: string;
  idempotencyKey?: string;
};

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
      assertOffice(event);
      return startSubscription(event.arguments.servicePlanId!);
    }
    case "cancelSubscription": {
      assertOffice(event);
      return cancelSubscription(event.arguments.servicePlanId!);
    }
    case "pausePlan": {
      assertOffice(event);
      return setPlanPaused(event.arguments.servicePlanId!, true);
    }
    case "resumePlan": {
      assertOffice(event);
      return setPlanPaused(event.arguments.servicePlanId!, false);
    }
    case "chargeOneTimeJob": {
      assertOffice(event);
      return chargeOneTimeJob(event.arguments.jobId!);
    }
    case "chargeManualAmount": {
      assertOffice(event);
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

function assertOffice(event: AppSyncResolverEvent<Args>) {
  if (!callerIsOffice(event.identity)) {
    throw new Error("Office role required");
  }
}

/** Get or create the Stripe customer mirroring a CRM customer. */
async function ensureStripeCustomer(customerId: string) {
  const client = await dataClient();
  const { data: customer } = await client.models.Customer.get({
    id: customerId,
  });
  if (!customer) throw new Error(`Customer ${customerId} not found`);
  if (customer.stripeCustomerId) {
    return { customer, stripeCustomerId: customer.stripeCustomerId };
  }
  const stripe = stripeClient();
  const created = await stripe.customers.create({
    name: customer.displayName,
    email: customer.email ?? undefined,
    phone: customer.phone ?? undefined,
    metadata: { crmCustomerId: customerId },
  });
  await client.models.Customer.update({
    id: customerId,
    stripeCustomerId: created.id,
  });
  return { customer, stripeCustomerId: created.id };
}

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

async function getDefaultPaymentMethod(stripeCustomerId: string) {
  const stripe = stripeClient();
  const customer = await stripe.customers.retrieve(stripeCustomerId, {
    expand: ["invoice_settings.default_payment_method"],
  });
  if (customer.deleted) return null;
  const pm = customer.invoice_settings?.default_payment_method;
  return pm && typeof pm !== "string" ? pm : null;
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
 * Subscription price_data requires a real Stripe product — keep exactly one
 * catalog product for all CRM plans (plan name rides on the price/metadata).
 */
async function ensureProduct(): Promise<string> {
  const stripe = stripeClient();
  const { data: products } = await stripe.products.list({
    active: true,
    limit: 100,
  });
  const existing = products.find((p) => p.metadata?.crmProduct === "true");
  if (existing) return existing.id;
  const created = await stripe.products.create({
    name: "BuzzKill Pest Control Service",
    metadata: { crmProduct: "true" },
  });
  return created.id;
}

/**
 * Start monthly billing for a Subscription record. Uses price_data against
 * the single CRM product (no per-plan catalog to maintain) and the
 * customer's default payment method; invoices settle through the webhook.
 */
async function startSubscription(servicePlanId: string) {
  const client = await dataClient();
  const { data: sub } = await client.models.ServicePlan.get({
    id: servicePlanId,
  });
  if (!sub) throw new Error(`Service plan ${servicePlanId} not found`);
  if (sub.stripeSubscriptionId) {
    return { stripeSubscriptionId: sub.stripeSubscriptionId, existing: true };
  }
  const { stripeCustomerId } = await ensureStripeCustomer(sub.customerId);
  const pm = await getDefaultPaymentMethod(stripeCustomerId);
  if (!pm) {
    throw new Error(
      "Customer has no saved payment method — collect payment info first"
    );
  }
  const stripe = stripeClient();
  const productId = await ensureProduct();
  const created = await stripe.subscriptions.create(
    {
      customer: stripeCustomerId,
      items: [
        {
          price_data: {
            currency: "usd",
            unit_amount: sub.priceCents,
            recurring: { interval: "month" },
            product: productId,
          },
        },
      ],
      default_payment_method: pm.id,
      metadata: { crmServicePlanId: servicePlanId, crmCustomerId: sub.customerId },
    },
    { idempotencyKey: `crm-sub-${servicePlanId}` }
  );
  await client.models.ServicePlan.update({
    id: servicePlanId,
    stripeSubscriptionId: created.id,
    status: "ACTIVE",
    startDate: new Date().toISOString().slice(0, 10),
  });
  return { stripeSubscriptionId: created.id, existing: false };
}

async function cancelSubscription(servicePlanId: string) {
  const client = await dataClient();
  const { data: sub } = await client.models.ServicePlan.get({
    id: servicePlanId,
  });
  if (!sub) throw new Error(`Service plan ${servicePlanId} not found`);
  if (sub.stripeSubscriptionId) {
    const stripe = stripeClient();
    try {
      await stripe.subscriptions.cancel(sub.stripeSubscriptionId);
    } catch (err) {
      // Already canceled in Stripe is fine — still mark the record.
      if ((err as { code?: string }).code !== "resource_missing") throw err;
    }
  }
  await client.models.ServicePlan.update({
    id: servicePlanId,
    status: "CANCELED",
    canceledAt: new Date().toISOString(),
  });
  return { canceled: true };
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
  if (amountCents > 2_000_000) {
    throw new Error("That amount looks too large — confirm and split if intended");
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
