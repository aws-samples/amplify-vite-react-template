import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The money screens' server-side guards.
 *
 * The review's finding: giving money back had a confirmation, a required
 * reason and a sane ceiling, while taking it had none of the three. These cover
 * the half that a UI cannot be trusted with — a mutation is reachable without
 * the CRM, so the ceiling, the reason and the actor all have to hold here.
 */

type Invoice = Record<string, unknown> & { id: string };

const created: Invoice[] = [];
let invoices: Invoice[] = [];
let createResult: { data: unknown; errors?: { message: string }[] } = {
  data: { id: "inv_1", status: "PAID" },
};
let customerEmail: string | null = "dana@example.com";

const fakeDataClient = {
  models: {
    Customer: {
      get: async ({ id }: { id: string }) => ({
        data: {
          id,
          displayName: "Dana",
          email: customerEmail,
          stripeCustomerId: "cus_1",
          groupId: null,
        },
      }),
      update: async () => ({ data: null }),
    },
    Invoice: {
      create: async (input: Invoice) => {
        created.push(input);
        return createResult;
      },
      list: async () => ({ data: [] }),
      get: async ({ id }: { id: string }) => ({
        data: invoices.find((i) => i.id === id) ?? null,
      }),
      update: async (patch: Invoice) => {
        const i = invoices.findIndex((x) => x.id === patch.id);
        if (i < 0) return { data: null, errors: [{ message: "not found" }] };
        invoices[i] = { ...invoices[i], ...patch };
        return { data: invoices[i], errors: undefined };
      },
    },
    Job: {
      get: async ({ id }: { id: string }) => ({
        data: {
          id,
          customerId: "c1",
          serviceType: "Wasp nest removal",
          priceCents: 29900,
          paidAt: null,
        },
      }),
    },
  },
};
vi.mock("../shared/dataClient", () => ({ dataClient: async () => fakeDataClient }));

const paymentIntentsCreate = vi.fn(async () => ({
  id: "pi_1",
  status: "succeeded",
}));
vi.mock("../shared/stripeClient", () => ({
  stripeClient: () => ({
    paymentIntents: { create: paymentIntentsCreate },
    customers: {
      retrieve: async () => ({
        deleted: false,
        invoice_settings: { default_payment_method: { id: "pm_1", type: "card" } },
      }),
    },
  }),
  paymentMethodLabel: () => ({ label: "Visa ••4242", kind: "CARD" }),
}));

const sendEmail = vi.fn(async () => true);
const notifyOffice = vi.fn(async () => true);
vi.mock("../shared/email", () => ({
  sendEmail: (opts: unknown) => sendEmail(opts as never),
  notifyOffice: (opts: unknown) => notifyOffice(opts as never),
  emailShell: (heading: string, body: string) => `${heading}\n${body}`,
}));

const { handler } = await import("./handler");

/** An AppSync event with a verified Cognito identity, as the resolver sees it. */
const event = (
  field: string,
  args: Record<string, unknown>,
  identity: { groups: string[]; sub?: string; email?: string } = {
    groups: ["FINANCE"],
    sub: "sub-finance",
    email: "csr@pestbuzzkill.com",
  }
) =>
  ({
    info: { fieldName: field },
    arguments: args,
    identity: {
      sub: identity.sub,
      groups: identity.groups,
      claims: { email: identity.email },
    },
  }) as never;

const call = (...a: Parameters<typeof event>) =>
  (handler as unknown as (e: never) => Promise<unknown>)(event(...a));

beforeEach(() => {
  created.length = 0;
  invoices = [];
  paymentIntentsCreate.mockClear();
  paymentIntentsCreate.mockImplementation(async () => ({
    id: "pi_1",
    status: "succeeded",
  }));
  sendEmail.mockClear();
  notifyOffice.mockClear();
  customerEmail = "dana@example.com";
  createResult = { data: { id: "inv_1", status: "PAID" } };
});

describe("chargeManualAmount ceiling", () => {
  it("takes an ordinary charge", async () => {
    await call("chargeManualAmount", {
      customerId: "c1",
      amountCents: 14900,
      description: "Wasp nest follow-up",
    });

    expect(paymentIntentsCreate).toHaveBeenCalledOnce();
  });

  it("allows the rate card's most expensive job", async () => {
    // marketRate clamps rodent/roach at $2,500 — a ceiling below this would
    // send real work to the owner, which is the bottleneck to remove.
    await call("chargeManualAmount", {
      customerId: "c1",
      amountCents: 250000,
      description: "Rodent exclusion",
    });

    expect(paymentIntentsCreate).toHaveBeenCalledOnce();
  });

  it("refuses the hundred-fold typo this exists to catch", async () => {
    // $149.00 typed as 14900.
    await expect(
      call("chargeManualAmount", {
        customerId: "c1",
        amountCents: 1490000,
        description: "Wasp nest follow-up",
      })
    ).rejects.toThrow(/over the \$5,000 limit/i);
    expect(paymentIntentsCreate).not.toHaveBeenCalled();
  });

  it("tells the CSR not to split it, because splitting is the obvious workaround", async () => {
    await expect(
      call("chargeManualAmount", {
        customerId: "c1",
        amountCents: 1490000,
        description: "x",
      })
    ).rejects.toThrow(/do not split it/i);
  });

  it("lets an owner take a charge above the finance ceiling", async () => {
    await call(
      "chargeManualAmount",
      { customerId: "c1", amountCents: 800000, description: "Large HOA one-time" },
      { groups: ["OWNER"], sub: "sub-owner", email: "jake@getgim.com" }
    );

    expect(paymentIntentsCreate).toHaveBeenCalledOnce();
  });

  it("refuses $20,000 even from an owner — nothing here is a $20,000 card charge", async () => {
    await expect(
      call(
        "chargeManualAmount",
        { customerId: "c1", amountCents: 2500000, description: "x" },
        { groups: ["OWNER"], sub: "sub-owner" }
      )
    ).rejects.toThrow(/beyond anything this business charges/i);
  });

  it("refuses a charge with no explanation", async () => {
    await expect(
      call("chargeManualAmount", {
        customerId: "c1",
        amountCents: 14900,
        description: "   ",
      })
    ).rejects.toThrow(/say what this charge is for/i);
    expect(paymentIntentsCreate).not.toHaveBeenCalled();
  });

  it("refuses a zero or negative amount", async () => {
    await expect(
      call("chargeManualAmount", { customerId: "c1", amountCents: 0, description: "x" })
    ).rejects.toThrow(/valid amount/i);
    await expect(
      call("chargeManualAmount", { customerId: "c1", amountCents: -100, description: "x" })
    ).rejects.toThrow(/valid amount/i);
  });

  it("refuses an office user outright", async () => {
    await expect(
      call(
        "chargeManualAmount",
        { customerId: "c1", amountCents: 14900, description: "x" },
        { groups: ["OFFICE"], sub: "sub-office" }
      )
    ).rejects.toThrow(/finance role required/i);
  });
});

describe("actor stamping", () => {
  it("stamps who charged the card, from the token rather than the request", async () => {
    await call("chargeManualAmount", {
      customerId: "c1",
      amountCents: 14900,
      description: "Wasp nest follow-up",
    });

    expect(created[0]).toMatchObject({
      createdBy: "sub-finance",
      createdByEmail: "csr@pestbuzzkill.com",
    });
  });

  it("stamps who recorded an offline payment", async () => {
    // The cheapest way to fabricate revenue in this product. The least it can
    // do is name who did it.
    await call("recordOfflinePayment", {
      customerId: "c1",
      amountCents: 50000,
      description: "Cheque from the HOA",
      status: "PAID",
      method: "CHEQUE",
    });

    expect(created[0]).toMatchObject({
      createdBy: "sub-finance",
      createdByEmail: "csr@pestbuzzkill.com",
      status: "PAID",
      amountCents: 50000,
    });
  });

  it("ignores a createdBy the client tries to supply", async () => {
    await call("chargeManualAmount", {
      customerId: "c1",
      amountCents: 14900,
      description: "x",
      createdBy: "sub-someone-else",
      createdByEmail: "notme@example.com",
    });

    expect(created[0]).toMatchObject({ createdBy: "sub-finance" });
  });
});

describe("recordOfflinePayment", () => {
  it("moves no money", async () => {
    await call("recordOfflinePayment", {
      customerId: "c1",
      amountCents: 50000,
      description: "Cash",
      status: "PAID",
      method: "CASH",
    });

    expect(paymentIntentsCreate).not.toHaveBeenCalled();
  });

  it("records how the money arrived", async () => {
    await call("recordOfflinePayment", {
      customerId: "c1",
      amountCents: 50000,
      description: "Payment",
      status: "PAID",
      method: "CHEQUE",
    });

    expect(String(created[0].description)).toContain("cheque");
  });

  it("raises an open invoice when the money has not arrived", async () => {
    await call("recordOfflinePayment", {
      customerId: "c1",
      amountCents: 50000,
      description: "Invoice for extra work",
      status: "OPEN",
    });

    expect(created[0]).toMatchObject({ status: "OPEN" });
    expect(created[0].paidAt).toBeUndefined();
  });

  it("refuses a status it does not understand rather than guessing", async () => {
    await expect(
      call("recordOfflinePayment", {
        customerId: "c1",
        amountCents: 50000,
        description: "x",
        status: "REFUNDED",
      })
    ).rejects.toThrow(/unsupported invoice status/i);
  });

  it("refuses an office user", async () => {
    await expect(
      call(
        "recordOfflinePayment",
        { customerId: "c1", amountCents: 100, description: "x", status: "PAID" },
        { groups: ["OFFICE"], sub: "sub-office" }
      )
    ).rejects.toThrow(/finance role required/i);
  });

  it("surfaces a failed write rather than reporting a payment it did not record", async () => {
    createResult = { data: null, errors: [{ message: "throttled" }] };

    await expect(
      call("recordOfflinePayment", {
        customerId: "c1",
        amountCents: 100,
        description: "x",
        status: "PAID",
      })
    ).rejects.toThrow(/could not record the payment/i);
  });
});

describe("voidInvoice", () => {
  it("withdraws an unpaid invoice and records who and why", async () => {
    invoices.push({ id: "inv_1", status: "OPEN", amountCents: 29900 });

    await call("voidInvoice", { invoiceId: "inv_1", reason: "Raised against the wrong customer" });

    expect(invoices[0]).toMatchObject({
      status: "VOID",
      voidReason: "Raised against the wrong customer",
      voidedBy: "sub-finance",
      voidedByEmail: "csr@pestbuzzkill.com",
    });
  });

  it("refuses to void a paid invoice — money that moved is refunded, not forgotten", async () => {
    invoices.push({ id: "inv_1", status: "PAID", amountCents: 29900 });

    await expect(
      call("voidInvoice", { invoiceId: "inv_1", reason: "oops" })
    ).rejects.toThrow(/refund it instead/i);
    expect(invoices[0].status).toBe("PAID");
  });

  it("refuses to void a refunded invoice", async () => {
    invoices.push({ id: "inv_1", status: "REFUNDED", amountCents: 29900 });

    await expect(
      call("voidInvoice", { invoiceId: "inv_1", reason: "x" })
    ).rejects.toThrow(/refund it instead/i);
  });

  it("requires a reason", async () => {
    invoices.push({ id: "inv_1", status: "OPEN", amountCents: 100 });

    await expect(
      call("voidInvoice", { invoiceId: "inv_1", reason: "   " })
    ).rejects.toThrow(/say why/i);
    expect(invoices[0].status).toBe("OPEN");
  });

  it("is idempotent", async () => {
    invoices.push({ id: "inv_1", status: "VOID", amountCents: 100 });

    const res = (await call("voidInvoice", { invoiceId: "inv_1", reason: "x" })) as {
      alreadyVoid: boolean;
    };

    expect(res.alreadyVoid).toBe(true);
  });

  it("refuses an office user", async () => {
    invoices.push({ id: "inv_1", status: "OPEN", amountCents: 100 });
    await expect(
      call("voidInvoice", { invoiceId: "inv_1", reason: "x" }, { groups: ["OFFICE"], sub: "s" })
    ).rejects.toThrow(/finance role required/i);
  });
});

describe("charge receipts", () => {
  // Every charge generates a customer notice. The funnel already emails a
  // payment confirmation with the amount; these are the CRM paths, which used
  // to take money in silence — a charge the customer can't recognize is a
  // dispute.

  it("emails a receipt with the amount when a manual charge succeeds", async () => {
    await call("chargeManualAmount", {
      customerId: "c1",
      amountCents: 14900,
      description: "Wasp nest follow-up",
    });

    expect(sendEmail).toHaveBeenCalledOnce();
    const [receipt] = sendEmail.mock.calls[0] as unknown as [
      { to: string; subject: string; html: string },
    ];
    expect(receipt.to).toBe("dana@example.com");
    expect(receipt.subject).toContain("$149.00");
    expect(receipt.html).toContain("Wasp nest follow-up");
    expect(receipt.html).toContain("$149.00");
  });

  it("emails a receipt when a one-time job is charged", async () => {
    await call("chargeOneTimeJob", { jobId: "job1" });

    expect(sendEmail).toHaveBeenCalledOnce();
    const [receipt] = sendEmail.mock.calls[0] as unknown as [
      { to: string; html: string },
    ];
    expect(receipt.to).toBe("dana@example.com");
    expect(receipt.html).toContain("$299.00");
    expect(receipt.html).toContain("Wasp nest removal");
  });

  it("sets receipt_email on the Stripe charge as belt-and-braces", async () => {
    await call("chargeOneTimeJob", { jobId: "job1" });

    const [params] = paymentIntentsCreate.mock.calls[0] as unknown as [
      { receipt_email?: string },
    ];
    expect(params.receipt_email).toBe("dana@example.com");
  });

  it("tells the office instead of crashing when there is no email on file", async () => {
    customerEmail = null;

    const res = (await call("chargeManualAmount", {
      customerId: "c1",
      amountCents: 14900,
      description: "Wasp nest follow-up",
    })) as { status: string };

    // The charge itself must stand — the money moved.
    expect(res.status).toBe("succeeded");
    expect(sendEmail).not.toHaveBeenCalled();
    expect(notifyOffice).toHaveBeenCalledOnce();
    const [alert] = notifyOffice.mock.calls[0] as unknown as [
      { subject: string; bodyHtml: string },
    ];
    expect(alert.subject).toMatch(/no email on file/i);
    expect(alert.bodyHtml).toContain("$149.00");
  });

  it("holds the receipt until settlement for a charge that is still processing", async () => {
    // Bank debits confirm asynchronously; the webhook sends the receipt when
    // payment_intent.succeeded flips the invoice to PAID.
    paymentIntentsCreate.mockImplementation(async () => ({
      id: "pi_1",
      status: "processing",
    }));

    await call("chargeManualAmount", {
      customerId: "c1",
      amountCents: 14900,
      description: "Wasp nest follow-up",
    });

    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("sends no receipt for an offline record — no card was charged", async () => {
    await call("recordOfflinePayment", {
      customerId: "c1",
      amountCents: 50000,
      description: "Cheque from the HOA",
      status: "PAID",
      method: "CHEQUE",
    });

    expect(sendEmail).not.toHaveBeenCalled();
  });
});
