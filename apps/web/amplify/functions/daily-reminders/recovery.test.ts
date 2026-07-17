import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The daily recovery passes: the dunning retry cadence (advance, then suspend
 * after the final attempt), the AR-aging digest bucketing, open-invoice
 * reminders, and dispute-deadline alerts.
 */

import { reminderKind } from "./handler";

type Invoice = Record<string, unknown> & { id: string; status: string };
type Plan = Record<string, unknown> & { id: string };
type Dispute = Record<string, unknown> & { id: string };

let invoices: Invoice[] = [];
const plans = new Map<string, Plan>();
let disputes: Dispute[] = [];

const iso = (daysFromNow: number) =>
  new Date(Date.now() + daysFromNow * 86_400_000).toISOString();
const dateStr = (daysFromNow: number) => iso(daysFromNow).slice(0, 10);

const byStatus = (status: string) =>
  invoices.filter((i) => i.status === status);

const fakeDataClient = {
  models: {
    // Empty for the service-reminder / not-billing passes so those digests
    // find nothing and stay quiet; the recovery passes are what we assert on.
    ServicePlan: {
      list: async () => ({ data: [], nextToken: null }),
      get: async ({ id }: { id: string }) => ({ data: plans.get(id) ?? null }),
      update: async (patch: Plan) => {
        plans.set(patch.id, { ...plans.get(patch.id)!, ...patch });
        return { data: plans.get(patch.id) };
      },
    },
    Job: {
      listJobByScheduledDate: async () => ({ data: [], nextToken: null }),
      listJobByServicePlanId: async () => ({ data: [], nextToken: null }),
      listJobByStatusAndScheduledDate: async () => ({ data: [], nextToken: null }),
    },
    Invoice: {
      list: async () => ({ data: [], nextToken: null }),
      listInvoiceByStatusAndIssuedAt: async ({ status }: { status: string }) => ({
        data: byStatus(status),
        nextToken: null,
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
    },
    Dispute: {
      listDisputeByStatus: async ({ status }: { status: string }) => ({
        data: disputes.filter((d) => d.status === status),
        nextToken: null,
      }),
    },
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
    Route: { get: async () => ({ data: null }) },
    Technician: { get: async () => ({ data: null }) },
  },
};
vi.mock("../shared/dataClient", () => ({ dataClient: async () => fakeDataClient }));

const paymentIntentsCreate = vi.fn(async () => ({ id: "pi_new", status: "succeeded" }));
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

const officeEmails: { subject: string; bodyHtml: string }[] = [];
const customerEmails: { to: string; subject: string; template?: string }[] = [];
vi.mock("../shared/email", () => ({
  emailShell: (h: string, b: string) => `${h}${b}`,
  sendEmail: async (opts: { to: string; subject: string; template?: string }) => {
    customerEmails.push(opts);
    return true;
  },
  notifyOffice: async (opts: { subject: string; bodyHtml: string }) => {
    officeEmails.push(opts);
    return true;
  },
}));

process.env.STRIPE_SECRET_KEY = "sk_test";
process.env.CRM_APP_URL = "https://crm.example.com";

const { handler } = await import("./handler");
const run = () => (handler as unknown as () => Promise<unknown>)();
const office = (needle: string) =>
  officeEmails.filter((e) => e.subject.includes(needle));

beforeEach(() => {
  invoices = [];
  plans.clear();
  disputes = [];
  officeEmails.length = 0;
  customerEmails.length = 0;
  paymentIntentsCreate.mockClear();
  paymentIntentsCreate.mockImplementation(async () => ({ id: "pi_new", status: "succeeded" }));
});

describe("reminderKind boundaries", () => {
  it("fires due-soon exactly 3 days before the due date", () => {
    expect(reminderKind(-3, true)).toBe("DUE_SOON");
    expect(reminderKind(-2, true)).toBeNull();
    expect(reminderKind(-4, true)).toBeNull();
  });
  it("only fires due-soon when there is a real due date", () => {
    expect(reminderKind(-3, false)).toBeNull();
  });
  it("fires overdue the day after due, then weekly", () => {
    expect(reminderKind(1, true)).toBe("OVERDUE");
    expect(reminderKind(2, true)).toBeNull();
    expect(reminderKind(7, true)).toBe("OVERDUE");
    expect(reminderKind(14, true)).toBe("OVERDUE");
  });
});

describe("dunning retry cadence", () => {
  it("recovers the invoice when the retry succeeds", async () => {
    invoices.push({
      id: "inv_1",
      customerId: "cA",
      amountCents: 4500,
      status: "FAILED",
      servicePlanId: "p1",
      dunningAttempts: 0,
      nextDunningAt: iso(-1), // due
    });
    plans.set("p1", { id: "p1", customerId: "cA", planName: "Monthly", priceCents: 4500, status: "ACTIVE" });

    await run();

    expect(paymentIntentsCreate).toHaveBeenCalledOnce();
    expect(invoices[0].status).toBe("PAID");
    expect(plans.get("p1")!.delinquent).toBeFalsy();
  });

  it("advances the cadence on a failed retry without suspending yet", async () => {
    paymentIntentsCreate.mockImplementation(async () => {
      throw Object.assign(new Error("declined"), { payment_intent: { id: "pi_x" } });
    });
    invoices.push({
      id: "inv_1",
      customerId: "cA",
      amountCents: 4500,
      status: "FAILED",
      servicePlanId: "p1",
      dunningAttempts: 0,
      nextDunningAt: iso(-1),
    });
    plans.set("p1", { id: "p1", customerId: "cA", planName: "Monthly", priceCents: 4500, status: "ACTIVE" });

    await run();

    expect(invoices[0].dunningAttempts).toBe(1);
    expect(invoices[0].nextDunningAt).toBeTruthy(); // rescheduled, not suspended
    expect(plans.get("p1")!.delinquent).toBeFalsy();
  });

  it("suspends the plan after the final failed attempt", async () => {
    paymentIntentsCreate.mockImplementation(async () => {
      throw Object.assign(new Error("declined"), { payment_intent: { id: "pi_x" } });
    });
    invoices.push({
      id: "inv_1",
      customerId: "cA",
      amountCents: 4500,
      status: "FAILED",
      servicePlanId: "p1",
      dunningAttempts: 2, // the +7 retry — the last one
      nextDunningAt: iso(-1),
    });
    plans.set("p1", { id: "p1", customerId: "cA", planName: "Monthly", priceCents: 4500, status: "ACTIVE" });

    await run();

    expect(invoices[0].dunningAttempts).toBe(3);
    expect(invoices[0].nextDunningAt).toBeNull();
    expect(plans.get("p1")).toMatchObject({ delinquent: true });
    expect(plans.get("p1")!.delinquentSince).toBeTruthy();
    expect(office("suspended").length).toBe(1);
  });

  it("does not retry an invoice whose next attempt is still in the future", async () => {
    invoices.push({
      id: "inv_1",
      customerId: "cA",
      amountCents: 4500,
      status: "FAILED",
      servicePlanId: "p1",
      dunningAttempts: 0,
      nextDunningAt: iso(2), // not due yet
    });

    await run();

    expect(paymentIntentsCreate).not.toHaveBeenCalled();
    expect(invoices[0].status).toBe("FAILED");
  });
});

describe("AR aging digest", () => {
  it("buckets outstanding money and totals it", async () => {
    invoices.push(
      { id: "a", customerId: "cA", amountCents: 10000, status: "OPEN", dueDate: dateStr(5) }, // current
      { id: "b", customerId: "cB", amountCents: 20000, status: "OPEN", dueDate: dateStr(-15) }, // 1-30
      { id: "c", customerId: "cC", amountCents: 30000, status: "FAILED", dueDate: dateStr(-95), nextDunningAt: iso(5) } // 90+
    );

    await run();

    const [digest] = office("AR aging");
    expect(digest).toBeTruthy();
    expect(digest.subject).toContain("$600.00"); // 100 + 200 + 300
    expect(digest.bodyHtml).toContain("Current");
    expect(digest.bodyHtml).toContain("90+ days");
  });
});

describe("open-invoice reminders", () => {
  it("emails a due-soon reminder 3 days before the due date", async () => {
    invoices.push({
      id: "inv_1",
      customerId: "cA",
      amountCents: 12000,
      status: "OPEN",
      dueDate: dateStr(3),
      issuedAt: iso(-2),
    });

    await run();

    const reminder = customerEmails.find((e) => e.template === "invoice-due-soon");
    expect(reminder).toBeTruthy();
    expect(reminder!.to).toBe("cA@example.com");
  });

  it("emails an overdue reminder the day after the due date", async () => {
    invoices.push({
      id: "inv_1",
      customerId: "cA",
      amountCents: 12000,
      status: "OPEN",
      dueDate: dateStr(-1),
      issuedAt: iso(-16),
    });

    await run();

    expect(customerEmails.some((e) => e.template === "invoice-overdue")).toBe(true);
  });
});

describe("dispute-deadline alerts", () => {
  it("alerts on an open dispute whose evidence deadline is near, naming the owner", async () => {
    disputes.push({
      id: "dp_1",
      stripeDisputeId: "du_1",
      customerId: "cA",
      amountCents: 29900,
      status: "NEEDS_RESPONSE",
      evidenceDueBy: iso(2),
      ownerEmail: "olga@pestbuzzkill.com",
    });

    await run();

    const [alert] = office("dispute");
    expect(alert).toBeTruthy();
    expect(alert.bodyHtml).toContain("olga@pestbuzzkill.com");
    expect(alert.bodyHtml).toContain("$299.00");
  });

  it("stays quiet when the deadline is comfortably far off", async () => {
    disputes.push({
      id: "dp_1",
      stripeDisputeId: "du_1",
      customerId: "cA",
      amountCents: 29900,
      status: "NEEDS_RESPONSE",
      evidenceDueBy: iso(30),
    });

    await run();

    expect(office("dispute")).toHaveLength(0);
  });
});
