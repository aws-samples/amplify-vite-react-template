import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The booking-link email — the LEAD state's one conversion affordance.
 *
 * There is no quote to send and no agreement to e-sign anymore: every
 * outbound CTA drives the lead to the public funnel (MARKETING_URL +
 * "/quote"), where they see their price, pick their day, and pay to book.
 * The copy is honest about the fallback: if the funnel can't price the
 * property, a specialist calls.
 */

let customer: Record<string, unknown> | null;
const fakeDataClient = {
  models: {
    Customer: {
      get: async () => ({ data: customer }),
    },
  },
};
vi.mock("../shared/dataClient", () => ({ dataClient: async () => fakeDataClient }));

const sentEmails: {
  to: string;
  subject: string;
  html: string;
  template: string;
  customerId?: string | null;
}[] = [];
vi.mock("../shared/email", () => ({
  emailShell: (h: string, b: string) => `${h}${b}`,
  sendEmail: async (o: (typeof sentEmails)[number]) => {
    sentEmails.push(o);
    return true;
  },
  notifyOffice: async () => true,
}));
vi.mock("../shared/stripeClient", () => ({ stripeClient: () => ({}) }));
vi.mock("../shared/subscription", () => ({
  startPlanBilling: async () => ({ started: true }),
}));
vi.mock("../shared/recurring", () => ({
  nextVisitDate: () => "2026-08-15",
  prettyDate: (d: string) => d,
  scheduleNextRecurringVisit: async () => undefined,
}));
vi.mock("../shared/pdf", () => ({
  renderServiceReportPdf: async () => new Uint8Array([1]),
}));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send() {
      return {};
    }
  },
  PutObjectCommand: class {},
  GetObjectCommand: class {},
}));
vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: async () => "https://s3.example/put",
}));

const { handler } = await import("./handler");

const send = (kind: string, note?: string, groups: string[] = ["OFFICE"]) =>
  (handler as unknown as (e: never) => Promise<unknown>)({
    info: { fieldName: "sendCustomerEmail" },
    arguments: { customerId: "c1", kind, note },
    identity: { sub: "sub-office", groups, claims: { email: "csr@x.com" } },
  } as never);

beforeEach(() => {
  sentEmails.length = 0;
  customer = {
    id: "c1",
    displayName: "Dana Whitlock",
    contactName: "Dana",
    email: "dana@example.com",
  };
  process.env.MARKETING_URL = "https://staging.d26qpsjewk0bee.amplifyapp.com";
});

describe("sendCustomerEmail kind booking-link", () => {
  it("emails the funnel CTA at MARKETING_URL + /quote", async () => {
    const res = (await send("booking-link")) as { sent: boolean; to: string };

    expect(res).toEqual({ sent: true, to: "dana@example.com" });
    const [email] = sentEmails;
    expect(email.to).toBe("dana@example.com");
    expect(email.html).toContain(
      'href="https://staging.d26qpsjewk0bee.amplifyapp.com/quote"'
    );
    // A phone CSR reads the link out loud — it appears as plain text too.
    expect(email.html).toContain(
      "Or paste this link into your browser: https://staging.d26qpsjewk0bee.amplifyapp.com/quote"
    );
  });

  it("is honest about what happens: price, pick a day, pay — specialist calls if not", async () => {
    await send("booking-link");

    const [email] = sentEmails;
    expect(email.html).toMatch(/exact price in seconds/i);
    expect(email.html).toMatch(/pick the day/i);
    expect(email.html).toMatch(/pay online/i);
    expect(email.html).toMatch(/a specialist will call/i);
    // No promises the dead flow used to make.
    expect(email.html).not.toMatch(/sign|agreement/i);
  });

  it("logs under its own template kind, like the other kinds", async () => {
    await send("booking-link");

    expect(sentEmails[0]).toMatchObject({
      template: "booking-link",
      customerId: "c1",
      subject: expect.stringMatching(/book/i),
    });
  });

  it("carries the office's note like the other kinds", async () => {
    await send("booking-link", "We talked this morning about the mice.");

    expect(sentEmails[0].html).toContain(
      "We talked this morning about the mice."
    );
  });

  it("falls back to the production URL when the env is absent", async () => {
    delete process.env.MARKETING_URL;

    await send("booking-link");

    expect(sentEmails[0].html).toContain("https://www.pestbuzzkill.com/quote");
  });

  it("still refuses an unknown kind", async () => {
    await expect(send("quote-sheet")).rejects.toThrow(/unknown email kind/i);
    expect(sentEmails).toHaveLength(0);
  });

  it("still refuses a customer with no email", async () => {
    customer = { id: "c1", displayName: "Dana", email: null };

    await expect(send("booking-link")).rejects.toThrow(/no email address/i);
  });

  it("still refuses a technician", async () => {
    await expect(send("booking-link", undefined, ["TECH"])).rejects.toThrow(
      /office role required/i
    );
  });
});
