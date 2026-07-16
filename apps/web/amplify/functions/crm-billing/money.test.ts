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
let createResult: { data: unknown; errors?: { message: string }[] } = {
  data: { id: "inv_1", status: "PAID" },
};

const fakeDataClient = {
  models: {
    Customer: {
      get: async ({ id }: { id: string }) => ({
        data: { id, displayName: "Dana", stripeCustomerId: "cus_1", groupId: null },
      }),
      update: async () => ({ data: null }),
    },
    Invoice: {
      create: async (input: Invoice) => {
        created.push(input);
        return createResult;
      },
      list: async () => ({ data: [] }),
    },
    Job: {
      get: async ({ id }: { id: string }) => ({
        data: { id, customerId: "c1", priceCents: 29900, paidAt: null },
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
  paymentIntentsCreate.mockClear();
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
