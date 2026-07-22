import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The webhook's recovery events:
 *   - charge.dispute.created opens a Dispute row with its evidence deadline and
 *     an ACTION-REQUIRED office alert; replay-safe by stripeDisputeId.
 *   - charge.dispute.closed records WON/LOST.
 *   - invoice.payment_failed stores the real decline reason, emails the
 *     customer a pay link, and arms the dunning schedule.
 */

type Invoice = Record<string, unknown> & { id: string };
type Dispute = Record<string, unknown> & { id: string };
type Plan = Record<string, unknown> & { id: string };

let invoices: Invoice[] = [];
const invoicesCreated: Invoice[] = [];
let disputes: Dispute[] = [];
const disputesCreated: Dispute[] = [];
const plans = new Map<string, Plan>();
let customerEmail: string | null = "dana@example.com";

const fakeDataClient = {
  models: {
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
    ServicePlan: {
      get: async ({ id }: { id: string }) => ({ data: plans.get(id) ?? null }),
      update: async (patch: Plan) => {
        plans.set(patch.id, { ...plans.get(patch.id)!, ...patch });
        return { data: plans.get(patch.id) };
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
    Dispute: {
      listDisputeByStripeDisputeId: async ({
        stripeDisputeId,
      }: {
        stripeDisputeId: string;
      }) => ({
        data: disputes.filter((d) => d.stripeDisputeId === stripeDisputeId),
      }),
      create: async (input: Dispute) => {
        const row = { ...input, id: (input.id as string) ?? `dp_${disputes.length + 1}` };
        disputesCreated.push(row);
        disputes.push(row);
        return { data: row };
      },
      update: async (patch: Dispute) => {
        const i = disputes.findIndex((x) => x.id === patch.id);
        if (i < 0) return { data: null, errors: [{ message: "not found" }] };
        disputes[i] = { ...disputes[i], ...patch };
        return { data: disputes[i] };
      },
    },
  },
};
vi.mock("../shared/dataClient", () => ({ dataClient: async () => fakeDataClient }));

vi.mock("../shared/stripeClient", () => ({
  stripeClient: () => ({
    webhooks: { constructEvent: (payload: string) => JSON.parse(payload) },
    subscriptions: { retrieve: async () => ({ metadata: {} }) },
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

vi.mock("../shared/bookingFinalize", () => ({
  finalizeBooking: vi.fn(async () => undefined),
}));

process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
process.env.CRM_APP_URL = "https://crm.example.com";

const { handler } = await import("./handler");

const invoke = (type: string, object: unknown) =>
  (
    handler as unknown as (e: never) => Promise<{ statusCode: number }>
  )({
    headers: { "stripe-signature": "sig" },
    body: JSON.stringify({ type, data: { object } }),
    isBase64Encoded: false,
  } as never);

beforeEach(() => {
  invoices = [];
  invoicesCreated.length = 0;
  disputes = [];
  disputesCreated.length = 0;
  plans.clear();
  customerEmail = "dana@example.com";
  sendEmail.mockClear();
  notifyOffice.mockClear();
});

const dueBy = Math.floor(Date.now() / 1000) + 10 * 86400; // 10 days out

describe("charge.dispute.created", () => {
  const disputeObj = {
    id: "du_1",
    amount: 29900,
    reason: "fraudulent",
    status: "needs_response",
    created: 1_784_000_000,
    evidence_details: { due_by: dueBy },
    payment_intent: "pi_1",
  };

  it("opens a Dispute row with the deadline, linked to the customer/invoice", async () => {
    invoices.push({
      id: "inv_1",
      customerId: "cA",
      amountCents: 29900,
      status: "PAID",
      stripePaymentIntentId: "pi_1",
    });

    const res = await invoke("charge.dispute.created", disputeObj);

    expect(res.statusCode).toBe(200);
    expect(disputesCreated).toHaveLength(1);
    expect(disputesCreated[0]).toMatchObject({
      stripeDisputeId: "du_1",
      customerId: "cA",
      invoiceId: "inv_1",
      amountCents: 29900,
      status: "NEEDS_RESPONSE",
    });
    expect(disputesCreated[0].evidenceDueBy).toBeTruthy();
  });

  it("pages the office ACTION REQUIRED with the amount and a deadline", async () => {
    invoices.push({
      id: "inv_1",
      customerId: "cA",
      amountCents: 29900,
      status: "PAID",
      stripePaymentIntentId: "pi_1",
    });

    await invoke("charge.dispute.created", disputeObj);

    const [alert] = notifyOffice.mock.calls[0] as unknown as [
      { subject: string; bodyHtml: string },
    ];
    expect(alert.subject).toMatch(/ACTION REQUIRED/);
    expect(alert.subject).toContain("$299.00");
    expect(alert.bodyHtml).toMatch(/evidence is due/i);
    expect(alert.bodyHtml).toContain("dashboard.stripe.com/disputes/du_1");
  });

  it("is replay-safe — a second delivery creates no duplicate", async () => {
    invoices.push({
      id: "inv_1",
      customerId: "cA",
      amountCents: 29900,
      status: "PAID",
      stripePaymentIntentId: "pi_1",
    });

    await invoke("charge.dispute.created", disputeObj);
    await invoke("charge.dispute.created", disputeObj);

    expect(disputesCreated).toHaveLength(1);
  });

  it("still records a dispute whose charge maps to no known invoice", async () => {
    const res = await invoke("charge.dispute.created", disputeObj);

    expect(res.statusCode).toBe(200);
    expect(disputesCreated).toHaveLength(1);
    expect(disputesCreated[0].customerId).toBeUndefined();
  });
});

describe("charge.dispute.closed", () => {
  it("records a win", async () => {
    disputes.push({
      id: "dp_1",
      stripeDisputeId: "du_1",
      amountCents: 29900,
      status: "NEEDS_RESPONSE",
    });

    await invoke("charge.dispute.closed", {
      id: "du_1",
      amount: 29900,
      status: "won",
    });

    expect(disputes[0].status).toBe("WON");
    expect(disputes[0].closedAt).toBeTruthy();
  });

  it("records a loss", async () => {
    disputes.push({
      id: "dp_1",
      stripeDisputeId: "du_1",
      amountCents: 29900,
      status: "NEEDS_RESPONSE",
    });

    await invoke("charge.dispute.closed", {
      id: "du_1",
      amount: 29900,
      status: "lost",
    });

    expect(disputes[0].status).toBe("LOST");
  });

  it("is replay-safe once terminal", async () => {
    disputes.push({
      id: "dp_1",
      stripeDisputeId: "du_1",
      amountCents: 29900,
      status: "WON",
    });

    await invoke("charge.dispute.closed", {
      id: "du_1",
      amount: 29900,
      status: "won",
    });

    // No second office email — already closed this way.
    expect(notifyOffice).not.toHaveBeenCalled();
  });
});

describe("invoice.payment_failed arms dunning", () => {
  const stripeInvoice = {
    id: "in_fail",
    amount_due: 4500,
    created: 1_784_216_400,
    charge: { failure_message: "Your card has insufficient funds." },
    parent: {
      subscription_details: {
        subscription: "sub_1",
        metadata: { crmServicePlanId: "p1", crmCustomerId: "cA" },
      },
    },
  };

  it("stores the real decline reason, emails the customer, and suspends the plan from dispatch", async () => {
    plans.set("p1", { id: "p1", customerId: "cA", planName: "Residential monthly", priceCents: 4500, status: "ACTIVE" });

    await invoke("invoice.payment_failed", stripeInvoice);

    expect(invoicesCreated).toHaveLength(1);
    expect(invoicesCreated[0]).toMatchObject({
      status: "FAILED",
      failureReason: "Your card has insufficient funds.",
    });
    // Subscription-invoice retries are Stripe's, so we do NOT arm our own
    // cron dunning (that would double-charge). Instead the plan is suspended
    // from dispatch immediately so recurring.ts stops routing techs to it.
    expect(invoicesCreated[0].nextDunningAt).toBeFalsy();
    expect(plans.get("p1")?.delinquent).toBe(true);
    expect(plans.get("p1")?.delinquentSince).toBeTruthy();

    // The customer got the payment-failed notice, and the office was paged.
    const customerNotice = sendEmail.mock.calls.find(
      (c) => (c[0] as { template?: string }).template === "payment-failed"
    );
    expect(customerNotice).toBeTruthy();
    const officeAlert = notifyOffice.mock.calls.find((c) =>
      String((c[0] as { subject: string }).subject).includes("Payment failed")
    );
    expect(officeAlert).toBeTruthy();
  });

  it("a replayed failure neither re-emails nor re-arms dunning", async () => {
    plans.set("p1", { id: "p1", customerId: "cA", planName: "Residential monthly", priceCents: 4500, status: "ACTIVE" });

    await invoke("invoice.payment_failed", stripeInvoice);
    sendEmail.mockClear();
    notifyOffice.mockClear();
    await invoke("invoice.payment_failed", stripeInvoice);

    expect(invoicesCreated).toHaveLength(1);
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
