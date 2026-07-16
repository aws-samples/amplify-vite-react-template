import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The webhook is where Stripe's version of events reaches the CRM, and two of
 * them used to land silently:
 *
 *   - `customer.subscription.deleted` flipped the plan and returned — no email,
 *     and the already-queued next visit stayed alive for the Schedule pool to
 *     route as a free service call. Losing a recurring customer must never be
 *     a silent database update.
 *   - Money movement settled the ledger but told the customer nothing: the
 *     charge that settles here (bank debits), the monthly subscription
 *     invoice, the dashboard refund. A charge the customer can't recognize is
 *     a dispute.
 */

type Plan = Record<string, unknown> & { id: string };
type Job = Record<string, unknown> & { id: string };
type Invoice = Record<string, unknown> & { id: string };

const plans = new Map<string, Plan>();
const jobs = new Map<string, Job>();
let invoices: Invoice[] = [];
const invoicesCreated: Invoice[] = [];
let customerEmail: string | null = "dana@example.com";

const fakeDataClient = {
  models: {
    ServicePlan: {
      get: async ({ id }: { id: string }) => ({ data: plans.get(id) ?? null }),
      update: async (patch: Plan) => {
        plans.set(patch.id, { ...plans.get(patch.id)!, ...patch });
        return { data: plans.get(patch.id) };
      },
    },
    Customer: {
      get: async ({ id }: { id: string }) => ({
        data: {
          id,
          displayName: "Dana Whitlock",
          contactName: "Dana",
          email: customerEmail,
          groupId: null,
        },
      }),
    },
    Job: {
      listJobByServicePlanId: async ({
        servicePlanId,
      }: {
        servicePlanId: string;
      }) => ({
        data: [...jobs.values()].filter(
          (j) => j.servicePlanId === servicePlanId
        ),
        nextToken: null,
      }),
      update: async (patch: Job) => {
        jobs.set(patch.id, { ...jobs.get(patch.id)!, ...patch });
        return { data: jobs.get(patch.id) };
      },
    },
    Invoice: {
      listInvoiceByStripePaymentIntentId: async ({
        stripePaymentIntentId,
      }: {
        stripePaymentIntentId: string;
      }) => ({
        data: invoices.filter(
          (i) => i.stripePaymentIntentId === stripePaymentIntentId
        ),
      }),
      list: async ({
        filter,
      }: {
        filter?: { stripeInvoiceId?: { eq?: string } };
      }) => ({
        data: invoices.filter(
          (i) => i.stripeInvoiceId === filter?.stripeInvoiceId?.eq
        ),
      }),
      get: async ({ id }: { id: string }) => ({
        data: invoices.find((i) => i.id === id) ?? null,
      }),
      update: async (patch: Invoice) => {
        const i = invoices.findIndex((x) => x.id === patch.id);
        if (i < 0) return { data: null, errors: [{ message: "not found" }] };
        invoices[i] = { ...invoices[i], ...patch };
        return { data: invoices[i] };
      },
      create: async (input: Invoice) => {
        const row = { ...input, id: (input.id as string) ?? "inv_new" };
        invoicesCreated.push(row);
        invoices.push(row);
        return { data: row };
      },
    },
  },
};
vi.mock("../shared/dataClient", () => ({
  dataClient: async () => fakeDataClient,
}));

// The signature check is Stripe's concern, not this suite's: constructEvent
// hands back whatever the test posted.
vi.mock("../shared/stripeClient", () => ({
  stripeClient: () => ({
    webhooks: { constructEvent: (payload: string) => JSON.parse(payload) },
    subscriptions: {
      retrieve: async () => ({ metadata: {} }),
    },
  }),
  paymentMethodLabel: () => ({ label: "Visa ••4242", kind: "CARD" }),
}));

const sendEmail = vi.fn(async (_opts?: unknown) => true);
const notifyOffice = vi.fn(async (_opts?: unknown) => true);
vi.mock("../shared/email", () => ({
  sendEmail: (opts: unknown) => sendEmail(opts as never),
  notifyOffice: (opts: unknown) => notifyOffice(opts as never),
  emailShell: (heading: string, body: string) => `${heading}\n${body}`,
}));

// Booking finalization drags in PDF rendering and S3 — not under test here.
vi.mock("../shared/bookingFinalize", () => ({
  finalizeBooking: vi.fn(async () => undefined),
}));

process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";

const { handler } = await import("./handler");

const invoke = (type: string, object: unknown) =>
  (
    handler as unknown as (e: never) => Promise<{ statusCode: number }>
  )({
    headers: { "stripe-signature": "sig" },
    body: JSON.stringify({ type, data: { object } }),
    isBase64Encoded: false,
  } as never);

const seedPlan = (over: Partial<Plan> = {}): Plan => {
  const plan: Plan = {
    id: "p1",
    customerId: "c1",
    planName: "Residential quarterly",
    priceCents: 4500,
    status: "ACTIVE",
    stripeSubscriptionId: "sub_1",
    ...over,
  };
  plans.set(plan.id, plan);
  return plan;
};

const seedJob = (over: Partial<Job> = {}): Job => {
  const job: Job = {
    id: `j${jobs.size + 1}`,
    servicePlanId: "p1",
    customerId: "c1",
    status: "UNSCHEDULED",
    scheduledDate: "2026-10-14",
    paidAt: null,
    notes: "Auto-queued quarterly visit after job j0.",
    ...over,
  };
  jobs.set(job.id, job);
  return job;
};

beforeEach(() => {
  plans.clear();
  jobs.clear();
  invoices = [];
  invoicesCreated.length = 0;
  customerEmail = "dana@example.com";
  sendEmail.mockClear();
  notifyOffice.mockClear();
});

describe("customer.subscription.deleted", () => {
  const deletedEvent = { id: "sub_1", metadata: { crmServicePlanId: "p1" } };

  it("tells the office the same day a subscription dies at Stripe", async () => {
    seedPlan();

    const res = await invoke("customer.subscription.deleted", deletedEvent);

    expect(res.statusCode).toBe(200);
    expect(plans.get("p1")).toMatchObject({
      status: "CANCELED",
      stripeSubscriptionId: null,
    });
    expect(notifyOffice).toHaveBeenCalledOnce();
    const [alert] = notifyOffice.mock.calls[0] as unknown as [
      { subject: string; bodyHtml: string },
    ];
    expect(alert.subject).toMatch(/ACTION REQUIRED/);
    expect(alert.subject).toContain("Dana Whitlock");
    // The office acts on dollars: monthly price and what a year of it is worth.
    expect(alert.bodyHtml).toContain("$45.00/mo");
    expect(alert.bodyHtml).toContain("$540.00/yr");
  });

  it("cancels the stranded next visit so it cannot dispatch as a free service call", async () => {
    seedPlan();
    const job = seedJob({ status: "UNSCHEDULED" });

    await invoke("customer.subscription.deleted", deletedEvent);

    expect(jobs.get(job.id)).toMatchObject({ status: "CANCELED" });
    expect(String(jobs.get(job.id)!.notes)).toMatch(/canceled at Stripe/i);
    const [alert] = notifyOffice.mock.calls[0] as unknown as [
      { bodyHtml: string },
    ];
    expect(alert.bodyHtml).toContain("2026-10-14");
  });

  it("leaves a paid-up-front visit on the schedule and asks for a decision", async () => {
    seedPlan();
    const job = seedJob({
      status: "SCHEDULED",
      paidAt: "2026-07-10T12:00:00Z",
    });

    await invoke("customer.subscription.deleted", deletedEvent);

    expect(jobs.get(job.id)!.status).toBe("SCHEDULED");
    const [alert] = notifyOffice.mock.calls[0] as unknown as [
      { bodyHtml: string },
    ];
    expect(alert.bodyHtml).toMatch(/needing a decision/i);
    expect(alert.bodyHtml).toMatch(/paid up front/i);
  });

  it("stays silent when the CRM's own cancel already handled it", async () => {
    // cancelPlanBilling marks the plan CANCELED and resolves its visits before
    // Stripe echoes this event back — announcing it again would train the
    // office to ignore the alert that matters.
    seedPlan({ status: "CANCELED", stripeSubscriptionId: null });
    const job = seedJob({ status: "UNSCHEDULED" });

    const res = await invoke("customer.subscription.deleted", deletedEvent);

    expect(res.statusCode).toBe(200);
    expect(notifyOffice).not.toHaveBeenCalled();
    expect(jobs.get(job.id)!.status).toBe("UNSCHEDULED");
  });

  it("acknowledges a subscription that carries no CRM metadata", async () => {
    const res = await invoke("customer.subscription.deleted", {
      id: "sub_foreign",
      metadata: {},
    });

    expect(res.statusCode).toBe(200);
    expect(notifyOffice).not.toHaveBeenCalled();
  });
});

describe("payment_intent.succeeded settles and sends the receipt", () => {
  it("flips the invoice to PAID and emails the customer the amount", async () => {
    // A bank debit: chargeOneTimeJob left it OPEN and sent no receipt yet.
    invoices.push({
      id: "inv1",
      customerId: "c1",
      amountCents: 29900,
      description: "Wasp nest removal — 2026-07-20",
      status: "OPEN",
      stripePaymentIntentId: "pi_1",
    });

    await invoke("payment_intent.succeeded", { id: "pi_1", metadata: {} });

    expect(invoices[0].status).toBe("PAID");
    expect(sendEmail).toHaveBeenCalledOnce();
    const [receipt] = sendEmail.mock.calls[0] as unknown as [
      { to: string; subject: string; html: string },
    ];
    expect(receipt.to).toBe("dana@example.com");
    expect(receipt.subject).toContain("$299.00");
    expect(receipt.html).toContain("Wasp nest removal");
  });

  it("does not send a second receipt on a replayed webhook", async () => {
    invoices.push({
      id: "inv1",
      customerId: "c1",
      amountCents: 29900,
      description: "Wasp nest removal",
      status: "PAID",
      stripePaymentIntentId: "pi_1",
    });

    await invoke("payment_intent.succeeded", { id: "pi_1", metadata: {} });

    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("sends no receipt for a failed payment", async () => {
    invoices.push({
      id: "inv1",
      customerId: "c1",
      amountCents: 29900,
      description: "Wasp nest removal",
      status: "OPEN",
      stripePaymentIntentId: "pi_1",
    });

    await invoke("payment_intent.payment_failed", {
      id: "pi_1",
      metadata: {},
      last_payment_error: { message: "insufficient funds" },
    });

    expect(invoices[0].status).toBe("FAILED");
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe("invoice.paid mirrors the monthly settlement and sends the receipt", () => {
  const stripeInvoice = {
    id: "in_1",
    amount_due: 4500,
    created: 1784216400, // mid-July 2026
    status_transitions: { paid_at: 1784216400 },
    parent: {
      subscription_details: {
        subscription: "sub_1",
        metadata: { crmServicePlanId: "p1", crmCustomerId: "c1" },
      },
    },
  };

  it("creates the ledger row and emails the customer the monthly amount", async () => {
    seedPlan();

    await invoke("invoice.paid", stripeInvoice);

    expect(invoicesCreated).toHaveLength(1);
    expect(invoicesCreated[0]).toMatchObject({ amountCents: 4500, status: "PAID" });
    expect(sendEmail).toHaveBeenCalledOnce();
    const [receipt] = sendEmail.mock.calls[0] as unknown as [
      { to: string; subject: string; html: string },
    ];
    expect(receipt.to).toBe("dana@example.com");
    expect(receipt.subject).toContain("$45.00");
    expect(receipt.html).toContain("Residential quarterly");
  });

  it("a replayed webhook neither duplicates the invoice nor the receipt", async () => {
    seedPlan();

    await invoke("invoice.paid", stripeInvoice);
    await invoke("invoice.paid", stripeInvoice);

    expect(invoicesCreated).toHaveLength(1);
    expect(sendEmail).toHaveBeenCalledOnce();
  });

  it("routes to the office when the customer has no email on file", async () => {
    seedPlan();
    customerEmail = null;

    const res = await invoke("invoice.paid", stripeInvoice);

    expect(res.statusCode).toBe(200);
    expect(invoicesCreated).toHaveLength(1); // the ledger row still lands
    expect(sendEmail).not.toHaveBeenCalled();
    expect(notifyOffice).toHaveBeenCalledOnce();
  });
});

describe("charge.refunded sends the refund notice", () => {
  it("a dashboard refund reconciles the invoice and tells the customer", async () => {
    invoices.push({
      id: "inv1",
      customerId: "c1",
      amountCents: 29900,
      description: "Wasp nest removal",
      status: "PAID",
      stripePaymentIntentId: "pi_1",
    });

    await invoke("charge.refunded", {
      payment_intent: "pi_1",
      amount_refunded: 29900,
      refunds: { data: [{ id: "re_dash" }] },
    });

    expect(invoices[0].status).toBe("REFUNDED");
    expect(sendEmail).toHaveBeenCalledOnce();
    const [notice] = sendEmail.mock.calls[0] as unknown as [
      { to: string; subject: string },
    ];
    expect(notice.to).toBe("dana@example.com");
    expect(notice.subject).toContain("$299.00");
  });

  it("a replayed refund webhook sends nothing twice", async () => {
    invoices.push({
      id: "inv1",
      customerId: "c1",
      amountCents: 29900,
      description: "Wasp nest removal",
      status: "PAID",
      stripePaymentIntentId: "pi_1",
    });

    await invoke("charge.refunded", {
      payment_intent: "pi_1",
      amount_refunded: 29900,
      refunds: { data: [{ id: "re_dash" }] },
    });
    await invoke("charge.refunded", {
      payment_intent: "pi_1",
      amount_refunded: 29900,
      refunds: { data: [{ id: "re_dash" }] },
    });

    expect(sendEmail).toHaveBeenCalledOnce();
  });
});
