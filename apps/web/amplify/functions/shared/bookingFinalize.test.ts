import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Lead conversion at booking finalization.
 *
 * The funnel is the only conversion path, so the webhook's finalization is
 * where a CRM lead becomes an ACTIVE customer. A lead the office priced
 * (Thumbtack paste, funnel CONTACT) and then sent to /quote is the same
 * person who now paid — finalization must CONVERT that record, not mint a
 * duplicate beside it, and must flip the lead's PENDING pricing runs to WON
 * (R73). And because the customer has already paid, nothing about the
 * matching may ever brick a finalization: any failure falls back to the
 * plain create and says so in the office alert.
 */

type Row = Record<string, unknown> & { id: string };

let existingCustomers: Row[] = [];
let pricingRuns: Row[] = [];
let customerListError: Error | null = null;
let customerUpdateFails = false;
const customersCreated: Row[] = [];
const customerUpdates: Row[] = [];
const runUpdates: Row[] = [];
const plansCreated: Row[] = [];
const jobsCreated: Row[] = [];
const emails: { to: string; subject: string; html: string }[] = [];
// R80: the new-booking-landed alert routes to sales@ via notifyLeads now.
const leadAlerts: { subject: string; heading: string; bodyHtml: string; template: string }[] = [];
let booking: Record<string, unknown>;

const fakeDataClient = {
  models: {
    BookingRequest: {
      get: async () => ({ data: booking }),
      update: async (patch: Row) => ({ data: patch }),
    },
    BookingFinalization: {
      create: async () => ({ data: { id: "b1" } }),
      delete: async () => ({ data: null }),
    },
    Customer: {
      list: async () => {
        if (customerListError) throw customerListError;
        return { data: existingCustomers, nextToken: null };
      },
      create: async (input: Row) => {
        const row = { ...input, id: "cust-new" };
        customersCreated.push(row);
        return { data: { groupId: null, ...row } };
      },
      update: async (patch: Row) => {
        customerUpdates.push(patch);
        if (customerUpdateFails && patch.status) {
          return { data: null, errors: [{ message: "update refused" }] };
        }
        const current = existingCustomers.find((c) => c.id === patch.id);
        return { data: { groupId: null, ...current, ...patch } };
      },
    },
    LeadPricingRun: {
      list: async ({
        filter,
      }: {
        filter?: { customerId?: { eq?: string } };
      }) => ({
        data: pricingRuns.filter(
          (r) => r.customerId === filter?.customerId?.eq
        ),
        nextToken: null,
      }),
      update: async (patch: Row) => {
        runUpdates.push(patch);
        const i = pricingRuns.findIndex((r) => r.id === patch.id);
        if (i >= 0) pricingRuns[i] = { ...pricingRuns[i], ...patch };
        return { data: pricingRuns[i] ?? patch };
      },
    },
    ServicePlan: {
      create: async (input: Record<string, unknown>) => {
        plansCreated.push({ id: "plan1", ...input });
        return { data: { id: "plan1", ...input } };
      },
    },
    Job: {
      create: async (input: Record<string, unknown>) => {
        jobsCreated.push({ id: "job1", ...input });
        return { data: { id: "job1", ...input } };
      },
    },
    Invoice: {
      create: async (input: Record<string, unknown>) => ({
        data: { id: "inv1", ...input },
      }),
    },
    Agreement: {
      create: async (input: Record<string, unknown>) => ({
        data: { id: "agr1", ...input },
      }),
    },
  },
};
vi.mock("./dataClient", () => ({ dataClient: async () => fakeDataClient }));
vi.mock("./email", () => ({
  emailShell: (h: string, b: string) => `${h}${b}`,
  sendEmail: async (o: { to: string; subject: string; html: string }) => {
    emails.push(o);
    return true;
  },
  notifyOffice: async () => true,
  notifyLeads: async (o: {
    subject: string;
    heading: string;
    bodyHtml: string;
    template: string;
  }) => {
    leadAlerts.push(o);
    return true;
  },
}));
vi.mock("./pdf", () => ({
  renderAgreementPdf: async () => Buffer.from("pdf"),
}));
vi.mock("./stripeClient", () => ({
  stripeClient: () => ({ customers: { update: async () => ({}) } }),
}));

const { finalizeBooking } = await import("./bookingFinalize");

const finalize = () =>
  finalizeBooking({
    bookingRequestId: "b1",
    paymentIntentId: "pi_1",
    amountReceived: 31300,
  });

/** A lead the office already has — sparse, the way a Thumbtack paste lands. */
const seedLead = (over: Partial<Row> = {}): Row => {
  const lead: Row = {
    id: "lead-1",
    status: "LEAD",
    displayName: "Dana Whitlock",
    email: "dana@example.com",
    contactName: null,
    phone: null,
    serviceStreet: null,
    serviceCity: null,
    serviceState: null,
    serviceZip: null,
    leadSource: "Thumbtack",
    leadNotes: "Pasted lead: mice in the basement",
    stripeCustomerId: null,
    convertedAt: null,
    groupId: null,
    ...over,
  };
  existingCustomers.push(lead);
  return lead;
};

beforeEach(() => {
  existingCustomers = [];
  pricingRuns = [];
  customerListError = null;
  customerUpdateFails = false;
  customersCreated.length = 0;
  customerUpdates.length = 0;
  runUpdates.length = 0;
  plansCreated.length = 0;
  jobsCreated.length = 0;
  emails.length = 0;
  leadAlerts.length = 0;
  delete process.env.DOCS_BUCKET; // skip the S3 write
  process.env.SES_NOTIFY_EMAIL = "office@pestbuzzkill.com";
  booking = {
    id: "b1",
    status: "QUOTED",
    name: "Dana Whitlock",
    email: "dana@example.com",
    phone: "+14135551234",
    street: "12 Beacon St",
    city: "Ware",
    state: "MA",
    zip: "01082",
    quoteJson: JSON.stringify({
      serviceLabel: "Rodent treatment — up to 2,000 sqft",
      recurringOffer: null,
    }),
    selectedDate: "2026-07-22",
    selectedWindow: "MORNING",
    recurring: false,
    amountCents: 31300,
    cancelToken: "tok-1",
    stripeCustomerId: "cus_1",
    stripePaymentIntentId: "pi_1",
  };
});

describe("an existing lead converts instead of duplicating", () => {
  it("flips the lead ACTIVE and creates no second customer", async () => {
    seedLead();

    await finalize();

    expect(customersCreated).toHaveLength(0);
    const convert = customerUpdates.find((u) => u.status === "ACTIVE");
    expect(convert).toMatchObject({ id: "lead-1", status: "ACTIVE" });
    expect(convert!.convertedAt).toBeDefined();
  });

  it("matches the email case-insensitively", async () => {
    seedLead({ email: "Dana@Example.COM " });

    await finalize();

    expect(customersCreated).toHaveLength(0);
    expect(customerUpdates[0]).toMatchObject({ id: "lead-1", status: "ACTIVE" });
  });

  it("fills only the fields the office didn't already have", async () => {
    seedLead({
      contactName: "Dana W.",
      phone: "+14135550000", // the office's number wins
      serviceStreet: null, // the booking's address fills the gap
    });

    await finalize();

    const convert = customerUpdates[0];
    expect(convert.contactName).toBeUndefined();
    expect(convert.phone).toBeUndefined();
    expect(convert).toMatchObject({
      serviceStreet: "12 Beacon St",
      serviceCity: "Ware",
      serviceState: "MA",
      serviceZip: "01082",
      stripeCustomerId: "cus_1",
    });
  });

  it("preserves the original leadSource and appends the booking to leadNotes", async () => {
    seedLead();

    await finalize();

    const convert = customerUpdates[0];
    expect(convert.leadSource).toBeUndefined(); // Thumbtack stays
    expect(String(convert.leadNotes)).toContain(
      "Pasted lead: mice in the basement"
    );
    expect(String(convert.leadNotes)).toContain(
      "Booked online via the website funnel (booking b1)"
    );
  });

  it("sets the funnel-derived leadSource only when the record never had one", async () => {
    seedLead({ leadSource: null });
    booking.attribution = JSON.stringify({ source: "google" });

    await finalize();

    expect(customerUpdates[0].leadSource).toBe("Website booking · utm:google");
    expect(String(customerUpdates[0].leadNotes)).toContain(
      "Booked online via the website funnel"
    );
  });

  it("an already-ACTIVE customer is reused, not recreated, and keeps convertedAt", async () => {
    seedLead({ status: "ACTIVE", convertedAt: "2026-01-01T00:00:00Z" });

    await finalize();

    expect(customersCreated).toHaveLength(0);
    expect(customerUpdates[0]).toMatchObject({
      id: "lead-1",
      status: "ACTIVE",
      convertedAt: "2026-01-01T00:00:00Z",
    });
  });
});

describe("R73 — the booking flips PENDING pricing runs to WON", () => {
  it("flips the converted lead's PENDING runs and leaves settled ones alone", async () => {
    seedLead();
    pricingRuns = [
      { id: "run-1", customerId: "lead-1", outcome: "PENDING" },
      { id: "run-2", customerId: "lead-1", outcome: "LOST" },
      { id: "run-3", customerId: "someone-else", outcome: "PENDING" },
    ];

    await finalize();

    expect(runUpdates).toEqual([{ id: "run-1", outcome: "WON" }]);
  });

  it("a fresh customer with no runs flips nothing", async () => {
    await finalize();

    expect(runUpdates).toHaveLength(0);
  });
});

describe("matching failure never breaks a paid finalization", () => {
  it("falls back to creating the customer when the scan blows up", async () => {
    customerListError = new Error("DynamoDB flaked");

    await finalize();

    expect(customersCreated).toHaveLength(1);
    expect(customersCreated[0]).toMatchObject({
      email: "dana@example.com",
      status: "ACTIVE",
    });
  });

  it("says so in the sales alert", async () => {
    customerListError = new Error("DynamoDB flaked");

    await finalize();

    // R80: the new-booking alert routes to sales@ (notifyLeads), not info@.
    expect(leadAlerts).toHaveLength(1);
    expect(leadAlerts[0].template).toBe("office-booking-alert");
    expect(leadAlerts[0].bodyHtml).toMatch(/matching this booking to an existing CRM lead failed/i);
    expect(leadAlerts[0].bodyHtml).toContain("DynamoDB flaked");
  });

  it("falls back to create when the convert update is refused", async () => {
    seedLead();
    customerUpdateFails = true;

    await finalize();

    expect(customersCreated).toHaveLength(1);
    expect(leadAlerts).toHaveLength(1);
    expect(leadAlerts[0].bodyHtml).toMatch(/merge the two by hand/i);
  });

  it("a clean conversion carries no fallback warning", async () => {
    seedLead();

    await finalize();

    expect(leadAlerts).toHaveLength(1);
    expect(leadAlerts[0].bodyHtml).not.toMatch(/matching this booking/i);
  });
});

describe("new booking shapes finalize into the right records", () => {
  it("a community plan booking creates the plan at the monthly total; the first month was the charge", async () => {
    booking.quoteJson = JSON.stringify({
      serviceLabel: "Community common-area pest control — 24 units",
      recurringOffer: {
        frequency: "QUARTERLY",
        monthlyCents: 28800,
        initialFeeCents: 28800,
      },
      planOnly: true,
    });
    booking.recurring = true;
    booking.amountCents = 28800;

    await finalizeBooking({
      bookingRequestId: "b1",
      paymentIntentId: "pi_1",
      amountReceived: 28800,
    });

    expect(plansCreated).toHaveLength(1);
    expect(plansCreated[0]).toMatchObject({
      planName: "Community common-area pest control plan",
      priceCents: 28800, // the monthly total, not a per-unit rate
      serviceFrequency: "QUARTERLY",
      status: "ACTIVE",
    });
    expect(jobsCreated[0]).toMatchObject({
      type: "RECURRING",
      serviceType: "Community common-area pest control — 24 units",
      priceCents: 28800,
      status: "SCHEDULED",
    });
  });

  it("a commercial plan booking creates the plan from the commercial offer", async () => {
    booking.quoteJson = JSON.stringify({
      serviceLabel: "Commercial pest control — up to 5,000 sqft",
      recurringOffer: {
        frequency: "MONTHLY",
        monthlyCents: 14900,
        initialFeeCents: 19900,
      },
    });
    booking.recurring = true;
    booking.amountCents = 19900;

    await finalizeBooking({
      bookingRequestId: "b1",
      paymentIntentId: "pi_1",
      amountReceived: 19900,
    });

    expect(plansCreated[0]).toMatchObject({
      planName: "Commercial pest control plan",
      priceCents: 14900,
      serviceFrequency: "MONTHLY",
    });
    expect(jobsCreated[0]).toMatchObject({
      serviceType: "Commercial pest control — up to 5,000 sqft",
      priceCents: 19900,
    });
  });

  it("a termite booking finalizes as a paid one-time job with its label", async () => {
    booking.quoteJson = JSON.stringify({
      serviceLabel: "Termite treatment — up to 2,000 sqft",
      recurringOffer: null,
    });

    await finalize();

    expect(plansCreated).toHaveLength(0);
    expect(jobsCreated[0]).toMatchObject({
      type: "ONE_TIME",
      serviceType: "Termite treatment — up to 2,000 sqft",
      priceCents: 31300,
      paidPaymentIntentId: "pi_1",
    });
  });
});

describe("idempotency and payment guards survive the matching", () => {
  it("does nothing when the booking is already finalized", async () => {
    booking.status = "BOOKED";
    seedLead();

    await finalize();

    expect(customerUpdates).toHaveLength(0);
    expect(customersCreated).toHaveLength(0);
    expect(emails).toHaveLength(0);
  });

  it("ignores a superseded PaymentIntent", async () => {
    seedLead();

    await finalizeBooking({
      bookingRequestId: "b1",
      paymentIntentId: "pi_stale",
      amountReceived: 31300,
    });

    expect(customerUpdates).toHaveLength(0);
    expect(customersCreated).toHaveLength(0);
  });

  it("refuses an amount that doesn't match the quote", async () => {
    seedLead();

    await finalizeBooking({
      bookingRequestId: "b1",
      paymentIntentId: "pi_1",
      amountReceived: 100,
    });

    expect(customerUpdates).toHaveLength(0);
    expect(customersCreated).toHaveLength(0);
  });
});
