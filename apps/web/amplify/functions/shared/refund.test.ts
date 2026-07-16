import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";

/**
 * Refunds.
 *
 * Until now `REFUNDED` was an enum member and a badge colour that no code path
 * ever wrote: the only way to refund was the Stripe dashboard, which left the
 * invoice PAID forever and the Dashboard counting the money as revenue.
 */

type Invoice = {
  id: string;
  customerId: string;
  amountCents: number;
  status: string;
  refundedAmountCents?: number | null;
  refundedAt?: string | null;
  refundReason?: string | null;
  stripeRefundId?: string | null;
  stripePaymentIntentId?: string | null;
};

let invoices: Invoice[] = [];

type UpdateResult = { data: Invoice | null; errors?: { message: string }[] };
type UpdateFn = (patch: Partial<Invoice> & { id: string }) => Promise<UpdateResult>;

const workingUpdate: UpdateFn = async (patch) => {
  const i = invoices.findIndex((x) => x.id === patch.id);
  if (i < 0) return { data: null, errors: [{ message: "not found" }] };
  invoices[i] = { ...invoices[i], ...patch };
  return { data: invoices[i] };
};

const fakeDataClient: {
  models: {
    Invoice: {
      get: (a: { id: string }) => Promise<{ data: Invoice | null }>;
      update: UpdateFn;
      listInvoiceByStripePaymentIntentId: (a: {
        stripePaymentIntentId: string;
      }) => Promise<{ data: Invoice[] }>;
    };
  };
} = {
  models: {
    Invoice: {
      get: async ({ id }: { id: string }) => ({
        data: invoices.find((i) => i.id === id) ?? null,
      }),
      update: workingUpdate,
      listInvoiceByStripePaymentIntentId: async ({
        stripePaymentIntentId,
      }: {
        stripePaymentIntentId: string;
      }) => ({
        data: invoices.filter(
          (i) => i.stripePaymentIntentId === stripePaymentIntentId
        ),
      }),
    },
  },
};
vi.mock("./dataClient", () => ({ dataClient: async () => fakeDataClient }));

const { refundInvoice, applyRefundToInvoice, refundableRemaining } =
  await import("./refund");

const refundsCreate = vi.fn(async () => ({ id: "re_1" }));
const stripe = { refunds: { create: refundsCreate } } as unknown as Stripe;

const seed = (over: Partial<Invoice> = {}): Invoice => {
  const inv: Invoice = {
    id: "inv1",
    customerId: "c1",
    amountCents: 29900,
    status: "PAID",
    refundedAmountCents: null,
    stripePaymentIntentId: "pi_1",
    ...over,
  };
  invoices.push(inv);
  return inv;
};
const current = () => invoices[0];

beforeEach(() => {
  invoices = [];
  // Restore: one test below swaps in a failing update and must not leak.
  fakeDataClient.models.Invoice.update = workingUpdate;
  refundsCreate.mockClear();
  refundsCreate.mockImplementation(async () => ({ id: "re_1" }));
});

describe("refundInvoice", () => {
  it("refunds the full amount by default and writes REFUNDED", async () => {
    seed();

    const out = await refundInvoice(stripe, {
      invoiceId: "inv1",
      reason: "Customer cancelled in the refund window",
    });

    expect(out).toMatchObject({ refundedNowCents: 29900, status: "REFUNDED" });
    expect(current()).toMatchObject({
      status: "REFUNDED",
      refundedAmountCents: 29900,
      stripeRefundId: "re_1",
    });
  });

  it("sends the refund to Stripe against the original payment", async () => {
    seed();

    await refundInvoice(stripe, { invoiceId: "inv1", reason: "duplicate charge" });

    expect(refundsCreate).toHaveBeenCalledOnce();
    const [params] = refundsCreate.mock.calls[0] as unknown as [
      Stripe.RefundCreateParams,
    ];
    expect(params).toMatchObject({ payment_intent: "pi_1", amount: 29900 });
  });

  it("records the reason — a refund with no reason is unauditable", async () => {
    seed();

    await refundInvoice(stripe, { invoiceId: "inv1", reason: "  tech no-showed  " });

    expect(current().refundReason).toBe("tech no-showed");
  });

  it("refuses a refund with no reason", async () => {
    seed();

    await expect(
      refundInvoice(stripe, { invoiceId: "inv1", reason: "   " })
    ).rejects.toThrow(/reason is required/i);
    expect(refundsCreate).not.toHaveBeenCalled();
  });

  it("keeps a partial refund PAID and tracks what is left", async () => {
    seed();

    const out = await refundInvoice(stripe, {
      invoiceId: "inv1",
      amountCents: 10000,
      reason: "goodwill",
    });

    expect(out).toMatchObject({ status: "PAID", refundedTotalCents: 10000 });
    expect(current()).toMatchObject({ status: "PAID", refundedAmountCents: 10000 });
    expect(refundableRemaining(current())).toBe(19900);
  });

  it("accumulates partial refunds and flips to REFUNDED on the last cent", async () => {
    seed();

    await refundInvoice(stripe, { invoiceId: "inv1", amountCents: 10000, reason: "a" });
    const out = await refundInvoice(stripe, {
      invoiceId: "inv1",
      amountCents: 19900,
      reason: "b",
    });

    expect(out).toMatchObject({ refundedTotalCents: 29900, status: "REFUNDED" });
    expect(current().status).toBe("REFUNDED");
  });

  it("refuses to refund more than is left", async () => {
    seed({ refundedAmountCents: 25000 });

    await expect(
      refundInvoice(stripe, { invoiceId: "inv1", amountCents: 10000, reason: "x" })
    ).rejects.toThrow(/more than is left/i);
    expect(refundsCreate).not.toHaveBeenCalled();
  });

  it("refuses to refund a fully refunded invoice twice", async () => {
    seed({ status: "REFUNDED", refundedAmountCents: 29900 });

    await expect(
      refundInvoice(stripe, { invoiceId: "inv1", reason: "again" })
    ).rejects.toThrow(/already been refunded in full/i);
  });

  it("refuses to refund an invoice that was never paid", async () => {
    seed({ status: "OPEN" });

    await expect(
      refundInvoice(stripe, { invoiceId: "inv1", reason: "x" })
    ).rejects.toThrow(/only a paid invoice/i);
    expect(refundsCreate).not.toHaveBeenCalled();
  });

  it("records an offline payment's refund without calling Stripe", async () => {
    // Cash or cheque: no card was ever charged, so there is nothing for Stripe
    // to send back. The refund happened in the real world; the ledger agrees.
    seed({ stripePaymentIntentId: null });

    const out = await refundInvoice(stripe, {
      invoiceId: "inv1",
      reason: "refunded by cheque",
    });

    expect(out).toMatchObject({ sentToStripe: false, status: "REFUNDED" });
    expect(refundsCreate).not.toHaveBeenCalled();
    expect(current().status).toBe("REFUNDED");
  });

  it("shouts when the money went back but the ledger write failed", async () => {
    // Worst case: the customer has their money and the CRM still counts it as
    // revenue. Silence here is the exact class this codebase keeps fixing.
    seed();
    fakeDataClient.models.Invoice.update = async () => ({
      data: null,
      errors: [{ message: "throttled" }],
    });

    await expect(
      refundInvoice(stripe, { invoiceId: "inv1", reason: "x" })
    ).rejects.toThrow(/reconcile invoice inv1 by hand/i);
  });

  it("refuses an unknown invoice", async () => {
    await expect(
      refundInvoice(stripe, { invoiceId: "nope", reason: "x" })
    ).rejects.toThrow(/not found/i);
  });
});

describe("applyRefundToInvoice (charge.refunded webhook)", () => {
  it("reconciles a refund issued from the Stripe dashboard", async () => {
    // This is the case that made the Dashboard count refunded money forever.
    seed();

    await applyRefundToInvoice({
      paymentIntentId: "pi_1",
      amountRefundedCents: 29900,
      refundId: "re_dash",
    });

    expect(current()).toMatchObject({
      status: "REFUNDED",
      refundedAmountCents: 29900,
      stripeRefundId: "re_dash",
      refundReason: "Refunded in Stripe",
    });
  });

  it("is idempotent — a replayed webhook does not double the total", async () => {
    seed();

    await applyRefundToInvoice({ paymentIntentId: "pi_1", amountRefundedCents: 10000 });
    await applyRefundToInvoice({ paymentIntentId: "pi_1", amountRefundedCents: 10000 });

    expect(current().refundedAmountCents).toBe(10000);
    expect(current().status).toBe("PAID");
  });

  it("does not overwrite the reason a CSR gave", async () => {
    seed({ refundedAmountCents: 10000, refundReason: "tech no-showed" });

    await applyRefundToInvoice({ paymentIntentId: "pi_1", amountRefundedCents: 29900 });

    expect(current().refundReason).toBe("tech no-showed");
    expect(current().status).toBe("REFUNDED");
  });

  it("ignores a payment intent it has no invoice for", async () => {
    const res = await applyRefundToInvoice({
      paymentIntentId: "pi_unknown",
      amountRefundedCents: 100,
    });

    expect(res).toBeNull();
  });
});
