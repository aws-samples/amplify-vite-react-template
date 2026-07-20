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
/** What Invoice.list returns — the job's existing ledger rows. */
let jobInvoices: { id: string; jobId: string; status: string }[] = [];
let createResult: { data: unknown; errors?: { message: string }[] } = {
  data: { id: "inv_1", status: "PAID" },
};
let customerEmail: string | null = "dana@example.com";
const baseJob = () => ({
  customerId: "c1",
  type: "ONE_TIME",
  serviceType: "Wasp nest removal",
  priceCents: 29900,
  status: "COMPLETED",
  paidAt: null as string | null,
});
let job = baseJob();

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
      list: async () => ({ data: jobInvoices }),
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
        data: { id, ...job },
      }),
    },
  },
};
vi.mock("../shared/dataClient", () => ({ dataClient: async () => fakeDataClient }));

const paymentIntentsCreate = vi.fn(async () => ({
  id: "pi_1",
  status: "succeeded",
}));
const paymentIntentsRetrieve = vi.fn(async (id: string) => ({
  id,
  status: "requires_payment_method",
}));
const paymentIntentsCancel = vi.fn(async () => ({
  id: "pi_1",
  status: "canceled",
}));
vi.mock("../shared/stripeClient", () => ({
  stripeClient: () => ({
    paymentIntents: {
      create: paymentIntentsCreate,
      retrieve: paymentIntentsRetrieve,
      cancel: paymentIntentsCancel,
    },
    customers: {
      retrieve: async () => ({
        deleted: false,
        invoice_settings: { default_payment_method: { id: "pm_1", type: "card" } },
      }),
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

const { handler } = await import("./handler");

/** An AppSync event with a verified Cognito identity, as the resolver sees it. */
const event = (
  field: string,
  args: Record<string, unknown>,
  identity: { groups: string[]; sub?: string; email?: string } = {
    groups: ["OWNER"],
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
  jobInvoices = [];
  job = baseJob();
  paymentIntentsCreate.mockClear();
  paymentIntentsCreate.mockImplementation(async () => ({
    id: "pi_1",
    status: "succeeded",
  }));
  paymentIntentsRetrieve.mockClear();
  paymentIntentsRetrieve.mockImplementation(async (id: string) => ({
    id,
    status: "requires_payment_method",
  }));
  paymentIntentsCancel.mockClear();
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

  it("allows an expensive but real job", async () => {
    // The AI engine deliberately has no upper price clamp, so big legitimate
    // jobs exist ($2,500 exclusions do happen). This ceiling is NOT a pricing
    // control — it is only the manual-entry typo guard on hand-keyed charges,
    // so it must sit above real work or it sends that work to the owner,
    // which is the bottleneck to remove.
    await call("chargeManualAmount", {
      customerId: "c1",
      amountCents: 250000,
      description: "Rodent exclusion",
    });

    expect(paymentIntentsCreate).toHaveBeenCalledOnce();
  });

  it("tells the CSR not to split it, because splitting is the obvious workaround", async () => {
    await expect(
      call("chargeManualAmount", {
        customerId: "c1",
        amountCents: 2500000,
        description: "x",
      })
    ).rejects.toThrow(/do not split it/i);
  });

  it("lets an owner take a large charge below the sanity ceiling", async () => {
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

  it("refuses a technician outright — moving money is the owner tier", async () => {
    await expect(
      call(
        "chargeManualAmount",
        { customerId: "c1", amountCents: 14900, description: "x" },
        { groups: ["TECH"], sub: "sub-tech" }
      )
    ).rejects.toThrow(/owner role required — this action moves money/i);
  });
});

describe("chargeOneTimeJob status guard", () => {
  // R08: the CRM hides the Charge button on anything not COMPLETED, but the
  // mutation is reachable without the CRM. The server enforces what the
  // button's label promises: this charges for work that was performed.

  it("charges a completed, unpaid one-time job in full", async () => {
    const res = (await call("chargeOneTimeJob", { jobId: "job1" })) as {
      status: string;
    };

    expect(res.status).toBe("succeeded");
    const [params] = paymentIntentsCreate.mock.calls[0] as unknown as [
      { amount: number },
    ];
    expect(params.amount).toBe(29900);
  });

  it("refuses a NO_ACCESS visit — the technician could not do the work", async () => {
    job.status = "NO_ACCESS";

    await expect(call("chargeOneTimeJob", { jobId: "job1" })).rejects.toThrow(
      /nothing to charge/i
    );
    expect(paymentIntentsCreate).not.toHaveBeenCalled();
  });

  it("refuses a job that is merely scheduled", async () => {
    job.status = "SCHEDULED";

    await expect(call("chargeOneTimeJob", { jobId: "job1" })).rejects.toThrow(
      /scheduled — charge it after the work is completed/i
    );
    expect(paymentIntentsCreate).not.toHaveBeenCalled();
  });

  it("refuses an in-progress job with honest words", async () => {
    job.status = "IN_PROGRESS";

    await expect(call("chargeOneTimeJob", { jobId: "job1" })).rejects.toThrow(
      /in progress — charge it after the work is completed/i
    );
  });

  it("refuses a canceled job", async () => {
    job.status = "CANCELED";

    await expect(call("chargeOneTimeJob", { jobId: "job1" })).rejects.toThrow(
      /canceled/i
    );
    expect(paymentIntentsCreate).not.toHaveBeenCalled();
  });

  it("refuses a plan visit — the subscription bills those", async () => {
    job.type = "RECURRING";

    await expect(call("chargeOneTimeJob", { jobId: "job1" })).rejects.toThrow(
      /plan visit/i
    );
    expect(paymentIntentsCreate).not.toHaveBeenCalled();
  });

  it("still refuses a job paid online at booking — charging again is a double charge", async () => {
    job.paidAt = "2026-07-12T14:00:00.000Z";

    await expect(call("chargeOneTimeJob", { jobId: "job1" })).rejects.toThrow(
      /already paid online on 2026-07-12/i
    );
    expect(paymentIntentsCreate).not.toHaveBeenCalled();
  });

  it("refuses when an OPEN or PAID invoice already covers the job", async () => {
    jobInvoices = [{ id: "inv_open", jobId: "job1", status: "OPEN" }];

    await expect(call("chargeOneTimeJob", { jobId: "job1" })).rejects.toThrow(
      /already has a non-failed invoice/i
    );
    expect(paymentIntentsCreate).not.toHaveBeenCalled();
  });

  it("refuses a job whose charge was deliberately refunded", async () => {
    jobInvoices = [{ id: "inv_ref", jobId: "job1", status: "REFUNDED" }];

    await expect(call("chargeOneTimeJob", { jobId: "job1" })).rejects.toThrow(
      /deliberately refunded/i
    );
    expect(paymentIntentsCreate).not.toHaveBeenCalled();
  });

  it("charges again after a FAILED attempt — the work is still unpaid", async () => {
    jobInvoices = [{ id: "inv_fail", jobId: "job1", status: "FAILED" }];

    await call("chargeOneTimeJob", { jobId: "job1" });

    expect(paymentIntentsCreate).toHaveBeenCalledOnce();
  });

  it("charges after a voided invoice — withdrawn means never charged", async () => {
    jobInvoices = [{ id: "inv_void", jobId: "job1", status: "VOID" }];

    await call("chargeOneTimeJob", { jobId: "job1" });

    expect(paymentIntentsCreate).toHaveBeenCalledOnce();
  });

  it("a retry is a new idempotency key — Stripe must not replay the first attempt's decline", async () => {
    await call("chargeOneTimeJob", { jobId: "job1" });
    const firstKey = (
      paymentIntentsCreate.mock.calls[0] as unknown[]
    )[1] as { idempotencyKey: string };

    jobInvoices = [{ id: "inv_fail", jobId: "job1", status: "FAILED" }];
    await call("chargeOneTimeJob", { jobId: "job1" });
    const retryKey = (
      paymentIntentsCreate.mock.calls[1] as unknown[]
    )[1] as { idempotencyKey: string };

    expect(firstKey.idempotencyKey).not.toBe(retryKey.idempotencyKey);
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

  it("refuses a technician — recording revenue is the owner tier", async () => {
    await expect(
      call(
        "recordOfflinePayment",
        { customerId: "c1", amountCents: 100, description: "x", status: "PAID" },
        { groups: ["TECH"], sub: "sub-tech" }
      )
    ).rejects.toThrow(/owner role required — this action moves money/i);
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

  it("voiding an open invoice cancels its still-cancellable payment intent", async () => {
    invoices.push({
      id: "inv_1",
      status: "OPEN",
      amountCents: 29900,
      stripePaymentIntentId: "pi_open",
    });

    await call("voidInvoice", { invoiceId: "inv_1", reason: "wrong customer" });

    expect(paymentIntentsCancel).toHaveBeenCalledWith("pi_open");
    expect(invoices[0].status).toBe("VOID");
  });

  it("refuses to void while a bank debit is still processing — the money may still land", async () => {
    invoices.push({
      id: "inv_1",
      status: "OPEN",
      amountCents: 29900,
      stripePaymentIntentId: "pi_processing",
    });
    paymentIntentsRetrieve.mockImplementation(async () => ({
      id: "pi_processing",
      status: "processing",
    }));

    await expect(
      call("voidInvoice", { invoiceId: "inv_1", reason: "x" })
    ).rejects.toThrow(/still processing/i);
    expect(paymentIntentsCancel).not.toHaveBeenCalled();
    expect(invoices[0].status).toBe("OPEN");
  });

  it("refuses to void an open invoice whose payment already succeeded — refund instead", async () => {
    invoices.push({
      id: "inv_1",
      status: "OPEN",
      amountCents: 29900,
      stripePaymentIntentId: "pi_done",
    });
    paymentIntentsRetrieve.mockImplementation(async () => ({
      id: "pi_done",
      status: "succeeded",
    }));

    await expect(
      call("voidInvoice", { invoiceId: "inv_1", reason: "x" })
    ).rejects.toThrow(/refund it instead/i);
    expect(invoices[0].status).toBe("OPEN");
  });

  it("voids an already-canceled intent without a second cancel call", async () => {
    invoices.push({
      id: "inv_1",
      status: "OPEN",
      amountCents: 29900,
      stripePaymentIntentId: "pi_canceled",
    });
    paymentIntentsRetrieve.mockImplementation(async () => ({
      id: "pi_canceled",
      status: "canceled",
    }));

    await call("voidInvoice", { invoiceId: "inv_1", reason: "x" });

    expect(paymentIntentsCancel).not.toHaveBeenCalled();
    expect(invoices[0].status).toBe("VOID");
  });

  it("is idempotent", async () => {
    invoices.push({ id: "inv_1", status: "VOID", amountCents: 100 });

    const res = (await call("voidInvoice", { invoiceId: "inv_1", reason: "x" })) as {
      alreadyVoid: boolean;
    };

    expect(res.alreadyVoid).toBe(true);
  });

  it("refuses a technician — voiding an invoice is the owner tier", async () => {
    invoices.push({ id: "inv_1", status: "OPEN", amountCents: 100 });
    await expect(
      call("voidInvoice", { invoiceId: "inv_1", reason: "x" }, { groups: ["TECH"], sub: "s" })
    ).rejects.toThrow(/owner role required — this action moves money/i);
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
