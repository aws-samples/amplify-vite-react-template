import type { AppSyncResolverEvent } from "aws-lambda";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { dataClient } from "../shared/dataClient";
import { opFieldName } from "../shared/opEvent";
import {
  assertCanActForCustomer,
  assertFinance,
  assertOffice,
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
import {
  buildCancellationPreview,
  cancelPlanForCustomer,
} from "../shared/planCancellation";
import {
  buildVisitChangePreview,
  cancelVisit,
  rescheduleVisit,
  type CancelDecision,
} from "../shared/visitChange";
import {
  assertVisitChangeReason,
  visitChangeReasonSummary,
} from "../shared/visitChangeReasons";
import { customerAccessGroups } from "../shared/dynamicGroups";
import { listAll } from "../shared/pagination";

type Args = {
  customerId?: string;
  servicePlanId?: string;
  jobId?: string;
  amountCents?: number;
  description?: string;
  idempotencyKey?: string;
  invoiceId?: string;
  reason?: string;
  reasonCode?: string;
  status?: string;
  method?: string;
  terms?: string;
  poNumber?: string;
  note?: string;
  kind?: string;
  id?: string;
  // Portal add-service: folded onto createSetupIntent (the 499/500 AppSync cap
  // has no room for a new op). `action` selects the sub-op; `payload` carries
  // its parsed JSON (a.json() arrives already parsed — never re-stringify it).
  action?: string;
  payload?: unknown;
  // GL-07 visit cancel/reschedule.
  decision?: string;
  scheduledDate?: string;
  technicianId?: string;
  routeId?: string;
  routeOrder?: number;
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
 * Authorize a plan-scoped customer action (GL-08 preview/cancel). The customer
 * sends only a servicePlanId, so we resolve the plan's owner and check against
 * it with the same dynamic-group rule as the invoice paths — a portal user may
 * act only on their own plan; OFFICE/OWNER always may. The not-authorized error
 * is identical whether the plan is missing or someone else's, so a customer
 * cannot use this to discover another customer's plan ids.
 */
async function assertCanActForPlan(
  identity: AppSyncIdentity | undefined | null,
  servicePlanId: string
): Promise<void> {
  const client = await dataClient();
  const { data: plan } = await client.models.ServicePlan.get({
    id: servicePlanId,
  });
  if (!plan) throw new Error("Not authorized for this plan");
  try {
    await assertCanActForCustomer(identity, plan.customerId);
  } catch {
    throw new Error("Not authorized for this plan");
  }
}

/**
 * The one hard ceiling on a single card charge — a fat-finger backstop, not a
 * role gate. With staff roles consolidated to owner + technician, every login
 * that can charge is an owner, so there is no junior-vs-owner tier to enforce:
 * the old "over $5k needs an owner" approval step is gone. What remains is a
 * universal sanity limit that catches the classic hundred-fold slip ($149.00
 * typed as 14900). The confirmation the CRM shows before calling this is what
 * catches the rest.
 */
/** Nothing this business does is a single $20,000 card charge. */
const ABSOLUTE_CHARGE_CEILING_CENTS = 2_000_000;

function assertChargeableAmount(_actor: Actor, amountCents: number) {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new Error("Enter a valid amount to charge");
  }
  if (amountCents > ABSOLUTE_CHARGE_CEILING_CENTS) {
    throw new Error(
      `$${(amountCents / 100).toLocaleString("en-US")} is beyond anything this business charges to a card. If it is genuinely owed, take it another way — do not split it into smaller charges.`
    );
  }
}

export const handler = async (event: AppSyncResolverEvent<Args>) => {
  switch (opFieldName(event)) {
    case "createSetupIntent": {
      await assertCanActForCustomer(event.identity, event.arguments.customerId!);
      // Portal add-service (folded here to spend no AppSync op): the ownership
      // check above is the trust boundary — booking-public re-checks it, but a
      // customer can never quote/charge for someone else's account from here.
      if (event.arguments.action === "ADD_SERVICE_QUOTE") {
        return portalAddServiceQuote(
          event.arguments.customerId!,
          event.arguments.payload
        );
      }
      if (event.arguments.action === "ADD_SERVICE_BOOK") {
        return portalAddServiceBook(
          event.arguments.customerId!,
          event.arguments.payload
        );
      }
      return createSetupIntent(event.arguments.customerId!);
    }
    case "getPaymentMethodSummary": {
      await assertCanActForCustomer(event.identity, event.arguments.customerId!);
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
    case "previewPlanCancellation": {
      await assertCanActForPlan(event.identity, event.arguments.servicePlanId!);
      return buildCancellationPreview(event.arguments.servicePlanId!);
    }
    case "cancelPlanByCustomer": {
      await assertCanActForPlan(event.identity, event.arguments.servicePlanId!);
      return cancelPlanForCustomer(stripeClient(), event.arguments.servicePlanId!, {
        reason: event.arguments.reason ?? null,
      });
    }
    case "previewVisitChange": {
      assertOffice(event.identity);
      return buildVisitChangePreview(event.arguments.jobId!);
    }
    case "cancelVisit": {
      assertOffice(event.identity);
      const a = actorOf(event);
      const code = assertVisitChangeReason(
        "CANCEL",
        event.arguments.reasonCode,
        event.arguments.note
      );
      return cancelVisit(stripeClient(), {
        jobId: event.arguments.jobId!,
        decision: (event.arguments.decision ?? "") as CancelDecision,
        reason: visitChangeReasonSummary(code, event.arguments.note),
        actor: { sub: a.sub, email: a.email, isOwner: a.isOwner },
      });
    }
    case "rescheduleVisit": {
      assertOffice(event.identity);
      const a = actorOf(event);
      const code = assertVisitChangeReason(
        "RESCHEDULE",
        event.arguments.reasonCode,
        event.arguments.note
      );
      return rescheduleVisit({
        jobId: event.arguments.jobId!,
        scheduledDate: event.arguments.scheduledDate ?? null,
        technicianId: event.arguments.technicianId ?? null,
        routeId: event.arguments.routeId ?? null,
        routeOrder: event.arguments.routeOrder ?? null,
        reason: visitChangeReasonSummary(code, event.arguments.note),
        actor: { sub: a.sub, email: a.email, isOwner: a.isOwner },
      });
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

// ── Portal add-service ────────────────────────────────────────────────
// A logged-in customer prices and books an ADDITIONAL service on their own
// account. We reuse the public booking engine wholesale (pricing, capacity,
// finalize) by invoking booking-public DIRECTLY (IAM), passing the customer id
// this handler already verified. booking-public trusts the invoke only because
// it arrives with no requestContext.http (a forged public POST can't), and it
// re-checks the customer owns the quote. No new AppSync op, no JWT, no CORS.

const lambda = new LambdaClient({});

/** Resolve booking-public's function name (env for tests, else the token-free
 *  SSM param the function stack publishes — a direct CDK ref cycled stacks). */
async function bookingPublicFunctionName(): Promise<string> {
  let fnName = process.env.BOOKING_PUBLIC_FUNCTION_NAME;
  if (!fnName && process.env.BOOKING_PUBLIC_FUNCTION_PARAM) {
    const { SSMClient, GetParameterCommand } = await import(
      "@aws-sdk/client-ssm"
    );
    const out = await new SSMClient({}).send(
      new GetParameterCommand({ Name: process.env.BOOKING_PUBLIC_FUNCTION_PARAM })
    );
    fnName = out.Parameter?.Value ?? undefined;
  }
  if (!fnName) {
    throw new Error(
      "Adding a service isn't available right now — please call the office."
    );
  }
  return fnName;
}

/** Invoke booking-public's trusted internal op and unwrap its result. */
async function invokeBookingPublic(op: Record<string, unknown>): Promise<unknown> {
  const out = await lambda.send(
    new InvokeCommand({
      FunctionName: await bookingPublicFunctionName(),
      InvocationType: "RequestResponse",
      Payload: Buffer.from(JSON.stringify({ internalOp: op })),
    })
  );
  if (out.FunctionError || !out.Payload) {
    throw new Error("Adding a service didn't go through — nothing was charged.");
  }
  const parsed = JSON.parse(Buffer.from(out.Payload).toString("utf8")) as
    | { ok: true; data: unknown }
    | { ok: false; status: number; error: string };
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.data;
}

/** a.json() args arrive parsed, but a client that stringifies is tolerated. */
function asObject(payload: unknown): Record<string, unknown> {
  if (payload && typeof payload === "object") {
    return payload as Record<string, unknown>;
  }
  if (typeof payload === "string" && payload.trim()) {
    try {
      const parsed = JSON.parse(payload);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      /* fall through to empty */
    }
  }
  return {};
}

/** Price an additional service for this customer (binds the quote to them). */
async function portalAddServiceQuote(customerId: string, payload: unknown) {
  return invokeBookingPublic({ kind: "QUOTE", customerId, input: asObject(payload) });
}

/** Book the priced add-service quote onto this customer's saved card. */
async function portalAddServiceBook(customerId: string, payload: unknown) {
  return invokeBookingPublic({ kind: "BOOK", customerId, body: asObject(payload) });
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
  let pm = await getDefaultPaymentMethod(customer.stripeCustomerId);
  if (!pm) {
    // Self-heal: a saved method with no default happens when the
    // setup_intent.succeeded webhook never arrived (unregistered endpoint,
    // outage, missed delivery — Stripe does not replay events to endpoints
    // added later). The method exists on the Stripe customer either way, so
    // adopt the newest one as the default here rather than telling the office
    // a collected card/bank is "missing".
    const saved = await stripeClient().customers.listPaymentMethods(
      customer.stripeCustomerId,
      { limit: 10 }
    );
    const newest = saved.data.sort((a, b) => b.created - a.created)[0];
    if (!newest) return { hasPaymentMethod: false, label: null, kind: null };
    await stripeClient().customers.update(customer.stripeCustomerId, {
      invoice_settings: { default_payment_method: newest.id },
    });
    pm = newest;
  }
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
  const existingInvoices: { status: string | null }[] = await listAll(
    (nextToken) =>
      client.models.Invoice.list({
        filter: { jobId: { eq: jobId } },
        nextToken,
      }),
    { pageErrors: "ignore" }
  );
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
    // GL-06: a still-processing bank debit marks the invoice un-payable so the
    // portal/office can't charge it again while it clears; the webhook clears
    // this on succeeded/failed.
    ...(intent.status === "processing"
      ? { pendingDebitIntentId: intent.id }
      : {}),
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
    // GL-06: a still-processing bank debit marks the invoice un-payable so it
    // can't be charged again while it clears; the webhook clears this on
    // succeeded/failed.
    ...(intent.status === "processing"
      ? { pendingDebitIntentId: intent.id }
      : {}),
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
  if (kind === "MARK_DEPOSITED" || kind === "UNMARK_DEPOSITED") {
    return setInvoiceDeposited(actor, invoiceId, kind === "MARK_DEPOSITED", note);
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
 * Confirm (or un-confirm) that a manually collected payment physically reached
 * the bank account. Settling recorded the money as received; this records it
 * as banked, so the office can reconcile the cash drawer against the bank
 * statement. Rides settleInvoice's method arg — see the schema comment on why
 * it is not its own mutation (CFN 500-resource cap).
 *
 * Only MANUAL invoices qualify: anything with a Stripe id reaches the bank via
 * Stripe payouts, and stamping it here would fake a reconciliation that never
 * happened.
 */
async function setInvoiceDeposited(
  actor: Actor,
  invoiceId: string,
  deposited: boolean,
  note?: string | null
) {
  const client = await dataClient();
  const { data: invoice } = await client.models.Invoice.get({ id: invoiceId });
  if (!invoice) throw new Error(`Invoice ${invoiceId} not found`);
  if (invoice.stripePaymentIntentId || invoice.stripeInvoiceId) {
    throw new Error(
      "This invoice was paid through Stripe — that money reaches the bank via Stripe payouts and needs no manual deposit confirmation."
    );
  }
  if (deposited && invoice.status !== "PAID" && invoice.status !== "REFUNDED") {
    throw new Error(
      `This invoice is ${String(invoice.status).toLowerCase()} — only money already received can be marked deposited`
    );
  }
  if (deposited && invoice.depositedAt) {
    return {
      invoiceId,
      depositedAt: invoice.depositedAt,
      alreadyDeposited: true,
    };
  }

  const nowIso = new Date().toISOString();
  const cleanNote = note?.trim().slice(0, 300) || undefined;
  const { data: updated, errors } = await client.models.Invoice.update({
    id: invoiceId,
    depositedAt: deposited ? nowIso : null,
    depositedBy: deposited ? (actor.sub ?? undefined) : null,
    depositedByEmail: deposited ? (actor.email ?? undefined) : null,
    depositNote: deposited && cleanNote ? cleanNote : null,
  });
  if (!updated) {
    throw new Error(
      `Could not update the deposit record: ${errors?.map((e) => e.message).join("; ") ?? "unknown error"}`
    );
  }
  return {
    invoiceId,
    depositedAt: deposited ? nowIso : null,
    alreadyDeposited: false,
  };
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
      await assertCanActForCustomer(identity, invoice.customerId);
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
