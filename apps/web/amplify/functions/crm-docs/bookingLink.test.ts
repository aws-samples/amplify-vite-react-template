import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The booking-link email — the LEAD state's one conversion affordance.
 *
 * There is no quote to send and no agreement to e-sign anymore: every
 * outbound CTA drives the lead to the public funnel (MARKETING_URL +
 * "/quote"), where they see their price, pick their day, and pay to book.
 * A missing market rate stays with the automated public-funnel worker and
 * emails the customer when ready; there is no manager escalation.
 */

let customer: Record<string, unknown> | null;
let customerUpdateFails = false;
const customerUpdates: Record<string, unknown>[] = [];
const claims = new Map<string, Record<string, unknown>>();
const activities = new Map<string, Record<string, unknown>>();
const workItems = new Map<string, Record<string, unknown>>();
const fakeDataClient = {
  models: {
    Customer: {
      get: async () => ({ data: customer, errors: [] }),
      update: async (patch: Record<string, unknown>) => {
        if (customerUpdateFails) return { data: null };
        customerUpdates.push(patch);
        if (customer) Object.assign(customer, patch);
        return { data: customer };
      },
    },
    LeadLifecycleClaim: {
      create: async (row: Record<string, unknown>) => {
        const id = String(row.id);
        if (claims.has(id)) return { data: null };
        claims.set(id, row);
        return { data: row };
      },
      get: async ({ id }: { id: string }) => ({ data: claims.get(id) ?? null }),
      delete: async ({ id }: { id: string }) => ({ data: claims.delete(id) }),
    },
    LeadActivity: {
      get: async ({ id }: { id: string }) => ({ data: activities.get(id) ?? null, errors: [] }),
      create: async (row: Record<string, unknown>) => {
        activities.set(String(row.id), row);
        return { data: row };
      },
    },
    SuppressedEmail: { get: async () => ({ data: null, errors: [] }) },
    CompanyClosure: { get: async () => ({ data: null, errors: [] }) },
    WorkItem: {
      get: async ({ id }: { id: string }) => ({ data: workItems.get(id) ?? null }),
      create: async (row: Record<string, unknown>) => {
        workItems.set(String(row.id), row);
        return { data: row };
      },
      update: async (patch: Record<string, unknown>) => {
        const id = String(patch.id);
        const row = { ...workItems.get(id), ...patch };
        workItems.set(id, row);
        return { data: row };
      },
    },
    WorkEvent: { create: async (row: Record<string, unknown>) => ({ data: row }) },
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

let actionSequence = 0;
const send = (kind: string, note?: string, groups: string[] = ["OFFICE"]) =>
  (handler as unknown as (e: never) => Promise<unknown>)({
    info: { fieldName: "sendCustomerEmail" },
    arguments: {
      customerId: "c1",
      kind,
      note,
      idempotencyKey: `booking-link-test-${++actionSequence}`,
    },
    identity: { sub: "sub-office", groups, claims: { email: "csr@x.com" } },
  } as never);

const prepare = (groups: string[] = ["OFFICE"]) =>
  (handler as unknown as (e: never) => Promise<unknown>)({
    info: { fieldName: "prepareLeadQuote" },
    arguments: { customerId: "c1" },
    identity: { sub: "sub-office", groups, claims: { email: "csr@x.com" } },
  } as never);

beforeEach(() => {
  sentEmails.length = 0;
  customerUpdateFails = false;
  customerUpdates.length = 0;
  claims.clear();
  activities.clear();
  workItems.clear();
  customer = {
    id: "c1",
    displayName: "Dana Whitlock",
    contactName: "Dana",
    email: "dana@example.com",
    status: "LEAD",
    contactConsentChannels: ["EMAIL"],
    nextAction: "Deliver the lead-specific booking link",
    nextActionAt: "2026-07-21T16:00:00.000Z",
  };
  process.env.MARKETING_URL = "https://staging.d26qpsjewk0bee.amplifyapp.com";
});

describe("sendCustomerEmail kind booking-link", () => {
  it("emails the funnel CTA carrying this lead's identity token", async () => {
    const res = (await send("booking-link")) as { sent: boolean; to: string };

    expect(res).toEqual({ sent: true, to: "dana@example.com" });
    const [email] = sentEmails;
    expect(email.to).toBe("dana@example.com");
    // The link names the lead (?lead=<token>) so the paid booking converts
    // exactly this record instead of email-guessing.
    expect(email.html).toMatch(
      /href="https:\/\/staging\.d26qpsjewk0bee\.amplifyapp\.com\/quote\?lead=[A-Za-z0-9_-]{16,}"/
    );
    // A phone CSR reads the link out loud — it appears as plain text too.
    expect(email.html).toMatch(
      /Or paste this link into your browser: https:\/\/staging\.d26qpsjewk0bee\.amplifyapp\.com\/quote\?lead=/
    );
    // First send mints the token onto the record, then (GL-02) stamps the
    // provider-accepted attempt while delivery remains a separate fact.
    expect(customerUpdates).toHaveLength(2);
    expect(String(customerUpdates[0].bookingLinkToken)).toMatch(
      /^[A-Za-z0-9_-]{16,}$/
    );
    expect(customerUpdates[1].lastAttemptedAt).toBeTruthy();
    expect(customerUpdates[1].bookingLinkDeliveredAt).toBeUndefined();
  });

  it("reuses the already-minted token on a resend", async () => {
    customer!.bookingLinkToken = "tok-already-minted-0123";
    customer!.bookingLinkTokenExpiresAt = "2099-01-01T00:00:00.000Z";

    await send("booking-link");

    expect(sentEmails[0].html).toContain("/quote?lead=tok-already-minted-0123");
    // No token mint on a resend, but provider acceptance is stamped as an
    // attempt, not customer delivery (GL-02).
    expect(customerUpdates).toHaveLength(1);
    expect(customerUpdates[0].lastAttemptedAt).toBeTruthy();
    expect(customerUpdates[0].bookingLinkDeliveredAt).toBeUndefined();
  });

  it("a post-send lifecycle failure never reports the bare-link send as complete", async () => {
    customerUpdateFails = true;

    await expect(send("booking-link")).rejects.toThrow(/lead state was not saved/i);

    // Provider acceptance happened, but the whole business obligation did not,
    // so the caller receives failure and shared recovery owns the partial.
    expect(sentEmails[0].html).toContain(
      'href="https://staging.d26qpsjewk0bee.amplifyapp.com/quote"'
    );
    expect(sentEmails[0].html).not.toContain("?lead=");
    expect(
      [...workItems.values()].some(
        (row) => row.kind === "LEAD_LIFECYCLE_RECOVERY"
      )
    ).toBe(true);
  });

  it("is honest about what happens: price, pick a day, pay — AI owns a fresh-rate wait", async () => {
    await send("booking-link");

    const [email] = sentEmails;
    expect(email.html).toMatch(/exact price in seconds/i);
    expect(email.html).toMatch(/pick the day/i);
    expect(email.html).toMatch(/pay online/i);
    expect(email.html).toMatch(/keep working on it/i);
    expect(email.html).toMatch(/email you a secure link/i);
    expect(email.html).not.toMatch(/specialist|manager/i);
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

    expect(sentEmails[0].html).toContain("https://www.pestbuzzkill.com/quote?lead=");
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

describe("prepareLeadQuote", () => {
  beforeEach(() => {
    Object.assign(customer!, {
      phone: "413-555-0123",
      serviceStreet: "12 Beacon St",
      serviceCity: "Cambridge",
      serviceState: "MA",
      serviceZip: "02139",
    });
  });

  it("returns the exact prefilled public-funnel link without sending anything", async () => {
    const result = (await prepare()) as { url: string };

    expect(result.url).toMatch(
      /^https:\/\/staging\.d26qpsjewk0bee\.amplifyapp\.com\/quote\?lead=[A-Za-z0-9_-]{16,}$/
    );
    expect(sentEmails).toHaveLength(0);
    expect(customerUpdates).toHaveLength(1);
  });

  it("fails closed when required staff-assist facts are missing", async () => {
    customer!.phone = null;
    customer!.serviceZip = null;

    await expect(prepare()).rejects.toThrow(/phone, ZIP code/i);
    expect(customerUpdates).toHaveLength(0);
  });

  it("refuses suppressed and out-of-footprint leads", async () => {
    customer!.doNotContact = true;
    await expect(prepare()).rejects.toThrow(/reopen/i);

    customer!.doNotContact = false;
    customer!.serviceState = "CT";
    await expect(prepare()).rejects.toThrow(/only for MA and RI/i);
  });

  it("never falls back to an identity-less link when token persistence fails", async () => {
    customerUpdateFails = true;
    await expect(prepare()).rejects.toThrow(/could not be created/i);
  });

  it("still refuses a technician", async () => {
    await expect(prepare(["TECH"])).rejects.toThrow(/office role required/i);
  });
});
