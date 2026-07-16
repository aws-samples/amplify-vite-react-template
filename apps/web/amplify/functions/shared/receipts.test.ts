import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Customer notices for money movement.
 *
 * The contract under test is the part callers lean on: these run after the
 * money has already moved, so they must never throw — a receipt that could not
 * be sent must not fail the charge behind it — and a customer with no email on
 * file goes to the office signal path instead of nowhere.
 */

let customer: Record<string, unknown> | null = null;
let customerGet = async () => ({ data: customer });

vi.mock("./dataClient", () => ({
  dataClient: async () => ({
    models: { Customer: { get: () => customerGet() } },
  }),
}));

const sendEmail = vi.fn(async () => true);
const notifyOffice = vi.fn(async () => true);
vi.mock("./email", () => ({
  sendEmail: (opts: unknown) => sendEmail(opts as never),
  notifyOffice: (opts: unknown) => notifyOffice(opts as never),
  emailShell: (heading: string, body: string) => `${heading}\n${body}`,
}));

const { sendChargeReceipt, sendRefundNotice } = await import("./receipts");

beforeEach(() => {
  sendEmail.mockClear();
  notifyOffice.mockClear();
  customer = {
    id: "c1",
    displayName: "Whitlock HOA",
    contactName: "Dana",
    email: "dana@example.com",
  };
  customerGet = async () => ({ data: customer });
});

describe("sendChargeReceipt", () => {
  it("sends the receipt to the customer with the amount in the subject", async () => {
    const ok = await sendChargeReceipt({
      customerId: "c1",
      amountCents: 14900,
      description: "Wasp nest follow-up",
      invoiceId: "inv1",
    });

    expect(ok).toBe(true);
    const [receipt] = sendEmail.mock.calls[0] as unknown as [
      {
        to: string;
        subject: string;
        html: string;
        template: string;
        relatedId?: string;
      },
    ];
    expect(receipt).toMatchObject({
      to: "dana@example.com",
      template: "payment-receipt",
      relatedId: "inv1",
    });
    expect(receipt.subject).toContain("$149.00");
    expect(receipt.html).toContain("Hi Dana");
  });

  it("routes to the office when there is no email on file", async () => {
    customer = { id: "c1", displayName: "Whitlock HOA", email: null };

    const ok = await sendChargeReceipt({
      customerId: "c1",
      amountCents: 14900,
      description: "Wasp nest follow-up",
    });

    expect(ok).toBe(false);
    expect(sendEmail).not.toHaveBeenCalled();
    const [alert] = notifyOffice.mock.calls[0] as unknown as [
      { bodyHtml: string },
    ];
    // The office can only act on it if the alert says what was charged.
    expect(alert.bodyHtml).toContain("$149.00");
    expect(alert.bodyHtml).toContain("Whitlock HOA");
  });

  it("never throws — the charge behind it already happened", async () => {
    customerGet = async () => {
      throw new Error("dynamo is down");
    };

    const ok = await sendChargeReceipt({
      customerId: "c1",
      amountCents: 14900,
      description: "x",
    });

    expect(ok).toBe(false);
  });

  it("escapes markup in the description — CSR free text ends up in HTML", async () => {
    await sendChargeReceipt({
      customerId: "c1",
      amountCents: 100,
      description: `Follow-up <script>alert("x")</script>`,
    });

    const [receipt] = sendEmail.mock.calls[0] as unknown as [{ html: string }];
    expect(receipt.html).not.toContain("<script>");
    expect(receipt.html).toContain("&lt;script&gt;");
  });
});

describe("sendRefundNotice", () => {
  it("states the card timing for a Stripe refund", async () => {
    await sendRefundNotice({
      customerId: "c1",
      amountCents: 29900,
      description: "Wasp nest removal",
      sentToStripe: true,
    });

    const [notice] = sendEmail.mock.calls[0] as unknown as [
      { subject: string; html: string; template: string },
    ];
    expect(notice.template).toBe("refund-notice");
    expect(notice.subject).toContain("$299.00");
    expect(notice.html).toContain("3–5 business days");
  });

  it("does not promise a card credit for money returned outside Stripe", async () => {
    await sendRefundNotice({
      customerId: "c1",
      amountCents: 29900,
      sentToStripe: false,
    });

    const [notice] = sendEmail.mock.calls[0] as unknown as [{ html: string }];
    expect(notice.html).not.toContain("original payment method");
    expect(notice.html).toContain("has been issued");
  });

  it("never throws, and tells the office when the customer is unreachable", async () => {
    customer = { id: "c1", displayName: "Whitlock HOA", email: null };

    const ok = await sendRefundNotice({
      customerId: "c1",
      amountCents: 29900,
      sentToStripe: true,
    });

    expect(ok).toBe(false);
    expect(notifyOffice).toHaveBeenCalledOnce();
  });
});
