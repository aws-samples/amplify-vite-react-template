import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The recovery mutations: settling an existing invoice when money arrives,
 * the customer-facing pay button, and recovery ownership.
 *
 * The load-bearing guarantees, all reachable without the CRM UI:
 *   - settleInvoice closes an OPEN/FAILED invoice and refuses a PAID one.
 *   - payInvoice charges the RIGHT customer's card and refuses customer A
 *     paying (or probing) customer B's invoice.
 *   - assignRecoveryOwner stamps the actor from the token, not the request.
 */

type Invoice = Record<string, unknown> & { id: string };
type Dispute = Record<string, unknown> & { id: string };

let invoices: Invoice[] = [];
let disputes: Dispute[] = [];

const fakeDataClient = {
  models: {
    Customer: {
      get: async ({ id }: { id: string }) => ({
        data: {
          id,
          displayName: `Customer ${id}`,
          email: `${id}@example.com`,
          stripeCustomerId: `cus_${id}`,
          groupId: null,
        },
      }),
      update: async () => ({ data: null }),
    },
    Invoice: {
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
    Dispute: {
      get: async ({ id }: { id: string }) => ({
        data: disputes.find((d) => d.id === id) ?? null,
      }),
      update: async (patch: Dispute) => {
        const i = disputes.findIndex((x) => x.id === patch.id);
        if (i < 0) return { data: null, errors: [{ message: "not found" }] };
        disputes[i] = { ...disputes[i], ...patch };
        return { data: disputes[i], errors: undefined };
      },
    },
    ServicePlan: {
      get: async () => ({ data: null }),
      update: async () => ({ data: null }),
    },
  },
};
vi.mock("../shared/dataClient", () => ({ dataClient: async () => fakeDataClient }));

const paymentIntentsCreate = vi.fn(async () => ({
  id: "pi_new",
  status: "succeeded",
}));
vi.mock("../shared/stripeClient", () => ({
  stripeClient: () => ({
    paymentIntents: { create: paymentIntentsCreate },
    customers: {
      retrieve: async () => ({
        deleted: false,
        invoice_settings: {
          default_payment_method: { id: "pm_1", type: "card" },
        },
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
  invoices = [];
  disputes = [];
  paymentIntentsCreate.mockClear();
  paymentIntentsCreate.mockImplementation(async () => ({
    id: "pi_new",
    status: "succeeded",
  }));
  sendEmail.mockClear();
  notifyOffice.mockClear();
});

describe("settleInvoice — OFFLINE", () => {
  it("settles an OPEN invoice PAID with the actor and note, moving no money", async () => {
    invoices.push({
      id: "inv_1",
      customerId: "cA",
      amountCents: 50000,
      status: "OPEN",
    });

    const res = (await call("settleInvoice", {
      invoiceId: "inv_1",
      method: "OFFLINE",
      note: "Cheque #4821",
    })) as { status: string };

    expect(res.status).toBe("PAID");
    expect(paymentIntentsCreate).not.toHaveBeenCalled();
    expect(invoices[0]).toMatchObject({
      status: "PAID",
      settledBy: "sub-finance",
      settledByEmail: "csr@pestbuzzkill.com",
      settleNote: "Cheque #4821",
    });
    expect(invoices[0].paidAt).toBeTruthy();
  });

  it("settles a FAILED invoice too", async () => {
    invoices.push({
      id: "inv_1",
      customerId: "cA",
      amountCents: 4500,
      status: "FAILED",
    });

    const res = (await call("settleInvoice", {
      invoiceId: "inv_1",
      method: "OFFLINE",
    })) as { status: string };

    expect(res.status).toBe("PAID");
  });

  it("is idempotent on an already-PAID invoice", async () => {
    invoices.push({
      id: "inv_1",
      customerId: "cA",
      amountCents: 4500,
      status: "PAID",
    });

    const res = (await call("settleInvoice", {
      invoiceId: "inv_1",
      method: "OFFLINE",
    })) as { alreadyPaid: boolean };

    expect(res.alreadyPaid).toBe(true);
  });

  it("refuses a VOID invoice — it is not a bill awaiting payment", async () => {
    invoices.push({
      id: "inv_1",
      customerId: "cA",
      amountCents: 4500,
      status: "VOID",
    });

    await expect(
      call("settleInvoice", { invoiceId: "inv_1", method: "OFFLINE" })
    ).rejects.toThrow(/only an open or failed invoice/i);
  });

  it("refuses a tech user — settling takes/records money, an owner action", async () => {
    invoices.push({ id: "inv_1", customerId: "cA", amountCents: 100, status: "OPEN" });
    await expect(
      call(
        "settleInvoice",
        { invoiceId: "inv_1", method: "OFFLINE" },
        { groups: ["TECH"], sub: "s" }
      )
    ).rejects.toThrow(/owner role required — this action moves money/i);
  });
});

describe("settleInvoice — CARD", () => {
  it("charges the saved card and settles PAID with a receipt", async () => {
    invoices.push({
      id: "inv_1",
      customerId: "cA",
      amountCents: 29900,
      description: "Wasp nest removal",
      status: "OPEN",
    });

    const res = (await call("settleInvoice", {
      invoiceId: "inv_1",
      method: "CARD",
    })) as { status: string };

    expect(res.status).toBe("PAID");
    const [params] = paymentIntentsCreate.mock.calls[0] as unknown as [
      { amount: number; customer: string },
    ];
    expect(params.amount).toBe(29900);
    expect(params.customer).toBe("cus_cA");
    expect(invoices[0].status).toBe("PAID");
    expect(invoices[0].stripePaymentIntentId).toBe("pi_new");
    expect(sendEmail).toHaveBeenCalledOnce(); // the receipt
  });

  it("records a decline as FAILED rather than throwing", async () => {
    invoices.push({
      id: "inv_1",
      customerId: "cA",
      amountCents: 29900,
      status: "OPEN",
    });
    paymentIntentsCreate.mockImplementation(async () => {
      throw Object.assign(new Error("Your card was declined."), {
        payment_intent: { id: "pi_declined" },
      });
    });

    const res = (await call("settleInvoice", {
      invoiceId: "inv_1",
      method: "CARD",
    })) as { status: string; failureReason: string };

    expect(res.status).toBe("FAILED");
    expect(invoices[0]).toMatchObject({
      status: "FAILED",
      failureReason: "Your card was declined.",
    });
  });
});

describe("payInvoice — the customer pay button", () => {
  it("lets an owner pay any customer's invoice on the saved card", async () => {
    invoices.push({
      id: "inv_1",
      customerId: "cA",
      amountCents: 12000,
      status: "OPEN",
    });

    const res = (await call("payInvoice", { invoiceId: "inv_1" })) as {
      status: string;
    };

    expect(res.status).toBe("PAID");
    expect(paymentIntentsCreate).toHaveBeenCalledOnce();
  });

  it("lets a customer pay their OWN invoice", async () => {
    invoices.push({
      id: "inv_1",
      customerId: "cA",
      amountCents: 12000,
      status: "OPEN",
    });

    const res = (await call(
      "payInvoice",
      { invoiceId: "inv_1" },
      { groups: ["CUSTOMER", "cus-cA"], sub: "sub-cust-a", email: "a@example.com" }
    )) as { status: string };

    expect(res.status).toBe("PAID");
  });

  it("REFUSES customer A paying customer B's invoice", async () => {
    invoices.push({
      id: "inv_B",
      customerId: "cB",
      amountCents: 12000,
      status: "OPEN",
    });

    await expect(
      call(
        "payInvoice",
        { invoiceId: "inv_B" },
        { groups: ["CUSTOMER", "cus-cA"], sub: "sub-cust-a" }
      )
    ).rejects.toThrow(/not authorized for this invoice/i);
    expect(paymentIntentsCreate).not.toHaveBeenCalled();
  });

  it("gives a customer the same not-authorized answer for a missing invoice — no id probing", async () => {
    await expect(
      call(
        "payInvoice",
        { invoiceId: "inv_missing" },
        { groups: ["CUSTOMER", "cus-cA"], sub: "sub-cust-a" }
      )
    ).rejects.toThrow(/not authorized for this invoice/i);
  });
});

describe("assignRecoveryOwner", () => {
  it("stamps the owner on an invoice from the caller's token", async () => {
    invoices.push({ id: "inv_1", customerId: "cA", amountCents: 100, status: "OPEN" });

    await call(
      "assignRecoveryOwner",
      { kind: "INVOICE", id: "inv_1" },
      { groups: ["OWNER"], sub: "sub-olga", email: "olga@pestbuzzkill.com" }
    );

    expect(invoices[0]).toMatchObject({
      ownerSub: "sub-olga",
      ownerEmail: "olga@pestbuzzkill.com",
    });
  });

  it("stamps the owner on a dispute", async () => {
    disputes.push({ id: "dp_1", stripeDisputeId: "du_1", amountCents: 100, status: "NEEDS_RESPONSE" });

    await call(
      "assignRecoveryOwner",
      { kind: "DISPUTE", id: "dp_1" },
      { groups: ["OWNER"], sub: "sub-fin", email: "fin@pestbuzzkill.com" }
    );

    expect(disputes[0]).toMatchObject({
      ownerSub: "sub-fin",
      ownerEmail: "fin@pestbuzzkill.com",
    });
  });

  it("refuses an unknown item kind", async () => {
    await expect(
      call("assignRecoveryOwner", { kind: "TICKET", id: "x" })
    ).rejects.toThrow(/unknown recovery item kind/i);
  });
});
