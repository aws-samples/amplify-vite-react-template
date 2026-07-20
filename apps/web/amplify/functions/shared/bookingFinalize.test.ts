import { beforeEach, describe, expect, it, vi } from "vitest";
import { _setLockStoreForTests, memoryLockStore } from "./atomicLock";
import { capacityFixtureModels } from "./capacityTestFixture";

/**
 * Lead conversion at booking finalization.
 *
 * The funnel is the only conversion path, so the webhook's finalization is
 * where a CRM lead becomes an ACTIVE customer. A lead the office priced
 * (Thumbtack paste, funnel CONTACT) and then sent to /quote is the same
 * person who now paid — finalization must CONVERT that record, not mint a
 * duplicate beside it, and must flip the lead's PENDING pricing runs to WON
 * (R73). And because the customer has already paid, nothing about the
 * matching may create beside an unresolved lead: any read or conversion
 * failure must fail closed into the shared Office recovery path.
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

// GL-05: to prove finalization is idempotent, the fake persists rows keyed by
// id and honors a deterministic-id create as conditional — a second create with
// an id that already exists fails, exactly as DynamoDB's conditional put does.
// This is what makes a "run finalize twice" test meaningful.
const store = {
  ServicePlan: new Map<string, Row>(),
  Job: new Map<string, Row>(),
  Invoice: new Map<string, Row>(),
  Agreement: new Map<string, Row>(),
  BookingFinalization: new Map<string, Row>(),
  LeadActivity: new Map<string, Row>(),
};
// Per-model injected failures — set true to make the next create(s) fail, the
// way a throttled/validation-refused write would, so a retry can then succeed.
const failCreate = {
  ServicePlan: false,
  Job: false,
  Invoice: false,
  Agreement: false,
};

function statefulModel(name: keyof typeof store, created?: Row[]) {
  const failable = name in failCreate;
  return {
    create: async (input: Row) => {
      if (failable && failCreate[name as keyof typeof failCreate]) {
        return { data: null, errors: [{ message: `forced ${name} failure` }] };
      }
      const id = (input.id as string) ?? `${name}-${store[name].size + 1}`;
      if (store[name].has(id)) {
        // Conditional create against an existing id — a retry landing on a
        // record a prior attempt already wrote. No duplicate row.
        return { data: null, errors: [{ message: "ConditionalCheckFailed" }] };
      }
      // Amplify stamps createdAt on every row; the orphan-claim reaper reads it.
      const row = {
        createdAt: new Date().toISOString(),
        ...input,
        id,
      } as Row;
      store[name].set(id, row);
      created?.push(row);
      return { data: row };
    },
    get: async ({ id }: { id: string }) => ({ data: store[name].get(id) ?? null }),
    update: async (patch: Row) => {
      const row = store[name].get(patch.id as string);
      if (!row) return { data: null, errors: [{ message: "no row" }] };
      for (const [k, v] of Object.entries(patch)) if (v !== undefined) row[k] = v;
      return { data: { ...row } };
    },
    delete: async ({ id }: { id: string }) => {
      store[name].delete(id);
      return { data: null };
    },
  };
}

const fakeDataClient = {
  models: {
    BookingRequest: {
      get: async () => ({ data: booking }),
      // Mutates the shared booking so a checkpoint (customerId) and the
      // BOOKED flip are visible to a subsequent retry — that visibility is the
      // whole point of the idempotency tests.
      update: async (patch: Row) => {
        Object.assign(booking, patch);
        return { data: { ...booking } };
      },
    },
    BookingFinalization: statefulModel("BookingFinalization"),
    Customer: {
      get: async ({ id }: { id: string }) => ({
        data: existingCustomers.find((c) => c.id === id) ?? null,
      }),
      list: async () => {
        if (customerListError) throw customerListError;
        return { data: existingCustomers, nextToken: null };
      },
      create: async (input: Row) => {
        // Honor the deterministic id finalization now supplies (cust-<booking>)
        // so a resumed run's get() finds this exact record instead of remaking.
        const row = {
          groupId: null,
          ...input,
          id: (input.id as string) ?? "cust-new",
        } as Row;
        customersCreated.push(row);
        // Also visible to a later get() — a resumed finalization reuses this
        // exact customer instead of creating a second one.
        existingCustomers.push(row);
        return { data: row };
      },
      update: async (patch: Row) => {
        customerUpdates.push(patch);
        if (customerUpdateFails && patch.status) {
          return { data: null, errors: [{ message: "update refused" }] };
        }
        const current = existingCustomers.find((c) => c.id === patch.id);
        if (current) Object.assign(current, patch);
        return { data: { groupId: null, ...current, ...patch } };
      },
    },
    CompanyClosure: { get: async () => ({ data: null, errors: [] }) },
    LeadActivity: statefulModel("LeadActivity"),
    WorkItem: {
      get: async () => ({ data: null }),
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
    ServicePlan: statefulModel("ServicePlan", plansCreated),
    Job: statefulModel("Job", jobsCreated),
    Invoice: statefulModel("Invoice"),
    Agreement: statefulModel("Agreement"),
  },
};
// GL-04: real capacity models for the expired-hold fallback tests.
const capacityFixture = capacityFixtureModels();
Object.assign(fakeDataClient.models, capacityFixture.models, {
  Technician: {
    list: async () => ({
      data: [
        {
          id: "t1",
          name: "Sam",
          active: true,
          baseStreet: "5 Base Rd",
          baseCity: "Ware",
          baseState: "MA",
          baseZip: "01082",
        },
      ],
      nextToken: null,
    }),
  },
});
(fakeDataClient.models.Job as Record<string, unknown>).listJobByScheduledDate =
  async ({ scheduledDate }: { scheduledDate: string }) => ({
    data: [...store.Job.values()].filter(
      (j) => j.scheduledDate === scheduledDate
    ),
    nextToken: null,
  });

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
  stripeClient: () => ({
    customers: { update: async () => ({}) },
    paymentIntents: {
      // The office Retry path re-reads the PaymentIntent to reconfirm the money.
      retrieve: async (id: string) => ({
        id,
        status: "succeeded",
        amount_received: 31300,
        payment_method: "pm_1",
      }),
    },
  }),
}));
// R41: portal provisioning is part of conversion — captured, and failable.
const portalInvites: { customerId: string; email: string; name: string }[] = [];
let portalProvisionError: Error | null = null;
let portalLinkSent = true;
vi.mock("./portalProvision", () => ({
  provisionPortalLogin: async (o: {
    customerId: string;
    email: string;
    name: string;
  }) => {
    if (portalProvisionError) throw portalProvisionError;
    portalInvites.push(o);
    // Reality (grantCustomerPortal) stamps portalUserSub on the customer, so a
    // resumed finalization sees the login already exists and does not re-invite.
    const c = existingCustomers.find((x) => x.id === o.customerId);
    if (c) c.portalUserSub = "sub-1";
    return {
      sub: "sub-1",
      username: o.email,
      created: true,
      groupsAdded: [],
      linkSent: portalLinkSent,
    };
  },
}));
const workOpened: { kind: string; title: string; detail: string; dedupeKey?: string }[] = [];
const workResolved: { kind: string; dedupeKey: string }[] = [];
vi.mock("./ownedWork", () => ({
  openOwnedWork: async (o: {
    kind: string;
    title: string;
    detail: string;
    dedupeKey?: string;
  }) => {
    workOpened.push(o);
    return "work-1";
  },
  resolveOwnedWork: async (o: { kind: string; dedupeKey: string }) => {
    workResolved.push(o);
    return true;
  },
  workItemId: (kind: string, key: string) => `${kind}:${key}`,
}));

const { finalizeBooking, retryBookingFinalization } = await import(
  "./bookingFinalize"
);
// GL-06: the shared failure path (webhook + reconcile sweep) under the same
// fakes — the pending-lifecycle tests drive it directly.
const { recordFunnelPaymentFailure } = await import("./bookingPaymentFailure");

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
  // GL-06: the BOOKED flip is a guarded CAS write — back it with a live view
  // over the shared booking object (mutated in place by the memory store).
  _setLockStoreForTests(
    memoryLockStore({
      BookingRequest: {
        get: (id: string) =>
          booking && booking.id === id
            ? (booking as Record<string, unknown>)
            : undefined,
      } as unknown as Map<string, Record<string, unknown>>,
      Job: store.Job,
      Invoice: store.Invoice,
      Customer: {
        get: (id: string) => existingCustomers.find((row) => row.id === id),
      } as unknown as Map<string, Record<string, unknown>>,
      CapacityDay: capacityFixture.maps.capacityDays,
      CapacityClaim: capacityFixture.maps.capacityClaims,
    })
  );
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
  portalInvites.length = 0;
  portalProvisionError = null;
  portalLinkSent = true;
  workOpened.length = 0;
  workResolved.length = 0;
  capacityFixture.maps.capacityDays.clear();
  capacityFixture.maps.capacityClaims.clear();
  store.ServicePlan.clear();
  store.Job.clear();
  store.Invoice.clear();
  store.Agreement.clear();
  store.BookingFinalization.clear();
  store.LeadActivity.clear();
  failCreate.ServicePlan = false;
  failCreate.Job = false;
  failCreate.Invoice = false;
  failCreate.Agreement = false;
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

describe("matching failure fails closed into paid recovery", () => {
  it("creates no ordinary customer when the identity scan blows up", async () => {
    customerListError = new Error("DynamoDB flaked");

    await expect(finalize()).rejects.toThrow(/DynamoDB flaked/i);

    expect(customersCreated).toHaveLength(0);
    expect(workOpened).toContainEqual(
      expect.objectContaining({ kind: "PAID_NOT_FINALIZED" })
    );
  });

  it("does not send a false new-booking success alert", async () => {
    customerListError = new Error("DynamoDB flaked");

    await expect(finalize()).rejects.toThrow();

    expect(leadAlerts).toHaveLength(0);
    expect(booking.status).toBe("QUOTED");
  });

  it("does not create beside a lead when conversion is refused", async () => {
    seedLead();
    customerUpdateFails = true;

    await expect(finalize()).rejects.toThrow(/could not convert/i);

    expect(customersCreated).toHaveLength(0);
    expect(workOpened).toContainEqual(
      expect.objectContaining({ kind: "PAID_NOT_FINALIZED" })
    );
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

describe("the booking link's lead identity converts exactly that lead", () => {
  it("a phone-only lead using the spoken bare link resolves by normalized phone", async () => {
    seedLead({ email: null, phone: "+1 (413) 555-1234" });

    await finalize();

    expect(customersCreated).toHaveLength(0);
    expect(customerUpdates.find((row) => row.status === "ACTIVE")).toMatchObject({
      id: "lead-1",
    });
  });

  it("converts the referenced record even when the checkout email differs", async () => {
    // The lead's record carries the office's email; the customer paid with
    // another inbox — exactly the case email matching cannot solve.
    seedLead({ id: "lead-2", email: "office-records@example.com" });
    booking.leadCustomerId = "lead-2";

    await finalize();

    expect(customersCreated).toHaveLength(0);
    const convert = customerUpdates.find((u) => u.status === "ACTIVE");
    expect(convert).toMatchObject({ id: "lead-2", status: "ACTIVE" });
    expect(String(convert!.leadNotes)).toContain(
      "Checkout email dana@example.com differs"
    );
  });

  it("the lead reference beats an email match to a different record", async () => {
    // Two people share the inbox: the booking's email matches lead-1, but
    // the link was sent to lead-2. Identity wins over the guess.
    seedLead(); // lead-1, dana@example.com
    seedLead({ id: "lead-2", email: "office-records@example.com" });
    booking.leadCustomerId = "lead-2";

    await finalize();

    expect(customersCreated).toHaveLength(0);
    expect(
      customerUpdates.find((u) => u.status === "ACTIVE")
    ).toMatchObject({ id: "lead-2" });
  });

  it("a dangling lead reference creates fresh and hands the mystery to a human", async () => {
    seedLead(); // same-email lead exists, but the reference is what we trust
    booking.leadCustomerId = "ghost-1";

    await finalize();

    // No guessing: the same-email lead is NOT converted.
    expect(customerUpdates.find((u) => u.status === "ACTIVE")).toBeUndefined();
    expect(customersCreated).toHaveLength(1);
    const work = workOpened.find((w) => w.kind === "DUPLICATE_LEAD");
    expect(work).toBeDefined();
    expect(work!.detail).toContain("no longer resolves");
    expect(existingCustomers.find((row) => row.id === "lead-1")).toMatchObject({
      status: "LEAD",
      conversionReviewBookingId: "b1",
      nextAction: "Resolve paid booking identity",
    });
  });

  it("several records sharing the checkout email means a fresh record and owned work, not an arbitrary conversion", async () => {
    seedLead(); // lead-1, dana@example.com
    seedLead({ id: "lead-9", email: "dana@example.com" });

    await finalize();

    expect(customerUpdates.find((u) => u.status === "ACTIVE")).toBeUndefined();
    expect(customersCreated).toHaveLength(1);
    const work = workOpened.find((w) => w.kind === "DUPLICATE_LEAD");
    expect(work).toBeDefined();
    expect(work!.detail).toContain("lead-1");
    expect(work!.detail).toContain("lead-9");
    expect(
      existingCustomers
        .filter((row) => row.id === "lead-1" || row.id === "lead-9")
        .every(
          (row) =>
            row.conversionReviewBookingId === "b1" &&
            row.nextAction === "Resolve paid booking identity"
        )
    ).toBe(true);
  });
});

describe("R41 — the portal login is part of conversion", () => {
  it("provisions a portal login for a fresh customer and says so in the confirmation", async () => {
    await finalize();

    expect(portalInvites).toEqual([
      {
        customerId: "cust-b1",
        email: "dana@example.com",
        name: "Dana Whitlock",
      },
    ]);
    const confirmation = emails.find((e) => e.subject.startsWith("You're booked"));
    expect(confirmation).toBeDefined();
    expect(confirmation!.html).toContain("customer portal sign-in link");
  });

  it("provisions for a converted lead that never had a login", async () => {
    seedLead();

    await finalize();

    expect(portalInvites).toEqual([
      { customerId: "lead-1", email: "dana@example.com", name: "Dana Whitlock" },
    ]);
  });

  it("leaves a repeat customer who already has a portal login alone", async () => {
    seedLead({ status: "ACTIVE", portalUserSub: "sub-existing" });

    await finalize();

    expect(portalInvites).toHaveLength(0);
    const confirmation = emails.find((e) => e.subject.startsWith("You're booked"));
    expect(confirmation!.html).not.toContain("customer portal sign-in link");
  });

  it("a failed invite never bricks the paid finalization — it lands in the owned-work queue", async () => {
    portalProvisionError = new Error("Cognito is down");

    await finalize();

    // The paid booking still finalizes end to end.
    expect(jobsCreated).toHaveLength(1);
    const confirmation = emails.find((e) => e.subject.startsWith("You're booked"));
    expect(confirmation).toBeDefined();
    expect(confirmation!.html).not.toContain("customer portal sign-in link");
    // And the gap is owned work, not a log line.
    const item = workOpened.find((w) => w.kind === "PORTAL_FAILURE");
    expect(item).toBeDefined();
    expect(item!.detail).toContain("Cognito is down");
  });

  it("a provisioned login whose invite email failed to send makes no promise and is owned work", async () => {
    portalLinkSent = false;

    await finalize();

    // The account exists, but the customer was never told — so the
    // confirmation must not promise a link, and someone must resend it.
    const confirmation = emails.find((e) => e.subject.startsWith("You're booked"));
    expect(confirmation!.html).not.toContain("customer portal sign-in link");
    const item = workOpened.find((w) => w.kind === "PORTAL_FAILURE");
    expect(item).toBeDefined();
    expect(item!.title).toMatch(/invite email did not send/i);
  });

  it("a re-booking INACTIVE customer with an existing (likely disabled) login becomes owned work", async () => {
    seedLead({ status: "INACTIVE", portalUserSub: "sub-existing" });

    await finalize();

    // No duplicate invite — but no silence either: deactivation disabled
    // the login and conversion doesn't re-enable it.
    expect(portalInvites).toHaveLength(0);
    const item = workOpened.find((w) => w.kind === "PORTAL_FAILURE");
    expect(item).toBeDefined();
    expect(item!.title).toMatch(/may be disabled/i);
  });

  it("does not provision a second identity when lead matching is unreadable", async () => {
    customerListError = new Error("DynamoDB flaked");

    await expect(finalize()).rejects.toThrow(/DynamoDB flaked/i);

    expect(portalInvites).toHaveLength(0);
    expect(customersCreated).toHaveLength(0);
  });
});

describe("idempotency and payment guards survive the matching", () => {
  it("does nothing when the booking is already finalized and its outbox is drained", async () => {
    booking.status = "BOOKED";
    // A fully finalized booking carries its durable sent markers, so a
    // redelivery resends nothing.
    booking.confirmationSentAt = "2026-07-17T00:00:00Z";
    booking.officeAlertSentAt = "2026-07-17T00:00:00Z";
    seedLead();

    await finalize();

    expect(customerUpdates).toHaveLength(0);
    expect(customersCreated).toHaveLength(0);
    expect(emails).toHaveLength(0);
  });

  it("opens a Finance case for an amount that doesn't match the quote — never a silent return", async () => {
    seedLead();

    await finalizeBooking({
      bookingRequestId: "b1",
      paymentIntentId: "pi_1",
      amountReceived: 100,
    });

    expect(customerUpdates).toHaveLength(0);
    expect(customersCreated).toHaveLength(0);
    const item = workOpened.find(
      (w) => w.kind === "PAID_NOT_FINALIZED" && w.dedupeKey === "b1"
    );
    expect(item).toBeDefined();
    expect(item!.title).toMatch(/does not match the quote/i);
    expect(item!.detail).toContain("$1.00"); // captured
    expect(item!.detail).toContain("$313.00"); // quoted
  });

  it("opens a Finance case when a succeeded payment has no booking row", async () => {
    // The webhook fired for a booking that no longer exists.
    // @ts-expect-error deliberately drop the row
    booking = null;

    await finalizeBooking({
      bookingRequestId: "gone",
      paymentIntentId: "pi_ghost",
      amountReceived: 31300,
    });

    const item = workOpened.find(
      (w) => w.kind === "PAID_NOT_FINALIZED" && w.dedupeKey === "missing-booking:pi_ghost"
    );
    expect(item).toBeDefined();
    expect(item!.detail).toContain("$313.00");
  });

  it("opens a Finance case for a paid booking that is CANCELED before it ever finalized", async () => {
    booking.status = "CANCELED";
    booking.jobId = undefined; // never finalized

    await finalize();

    const item = workOpened.find(
      (w) => w.kind === "PAID_NOT_FINALIZED" && w.dedupeKey === "b1"
    );
    expect(item).toBeDefined();
    expect(item!.title).toMatch(/canceled, never finalized/i);
    expect(customersCreated).toHaveLength(0);
  });

  it("does NOT open a case for a booking that finalized and was only later canceled", async () => {
    booking.status = "CANCELED";
    booking.jobId = "job-b1"; // it did finalize; the refund flow owns the cancel

    await finalize();

    expect(workOpened.find((w) => w.kind === "PAID_NOT_FINALIZED")).toBeUndefined();
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

/**
 * GL-05 — exactly-once paid booking conversion. The evidence the gate demands:
 * inject a failure after each material step, prove the retry RESUMES the same
 * booking (never a second customer/plan/job/agreement/invoice), prove the paid
 * customer is a durable office exception in the meantime, and prove the
 * confirmation is sent once, only after the commitment exists.
 */
describe("GL-05 — finalization is idempotent and resumable under failure", () => {
  const paidInvoiceOf = () => store.Invoice.get("booking-b1");

  it("a job-create failure becomes a Paid—not finalized exception, then a retry finishes the SAME booking", async () => {
    // Step fails: the job cannot be written.
    failCreate.Job = true;
    await expect(finalize()).rejects.toThrow(/job/i);

    // Not booked, and the paid customer is a durable, office-visible exception
    // carrying the amount and a one-tap recovery — never a log line.
    expect(booking.status).toBe("QUOTED");
    const exception = workOpened.find((w) => w.kind === "PAID_NOT_FINALIZED");
    expect(exception).toBeDefined();
    expect(exception!.detail).toContain("$313.00");
    expect(exception!.detail).toContain("2026-07-22");
    const created1 = customersCreated.length;
    expect(created1).toBe(1); // the customer was created on the first pass

    // The webhook (or the office) retries. It resumes: no second customer,
    // job, or invoice — and the booking completes.
    failCreate.Job = false;
    await finalize();

    expect(booking.status).toBe("BOOKED");
    expect(customersCreated).toHaveLength(1); // still one — reused, not remade
    expect(jobsCreated).toHaveLength(1);
    expect(paidInvoiceOf()).toBeDefined();
    // The exception the first pass opened is resolved by the success.
    expect(workResolved.find((w) => w.kind === "PAID_NOT_FINALIZED")).toBeDefined();
  });

  it("resumes onto the same fresh customer even if the checkpoint was lost and the email became ambiguous", async () => {
    // A prior attempt created the fresh customer (deterministic id cust-b1) but
    // died before the checkpoint landed, and a same-email lead now also exists —
    // so re-matching by email is ambiguous and, without the deterministic id,
    // would mint a SECOND fresh record.
    existingCustomers.push({
      id: "cust-b1",
      email: "dana@example.com",
      status: "ACTIVE",
      portalUserSub: "sub-1",
    });
    seedLead(); // lead-1, same email → makes the match ambiguous
    booking.customerId = undefined;

    await finalize();

    expect(customersCreated).toHaveLength(0); // reused cust-b1, minted nothing
    expect(booking.customerId).toBe("cust-b1");
    expect(booking.status).toBe("BOOKED");
  });

  it("reuses the converted lead via the checkpoint even when a retry's email match has become ambiguous", async () => {
    seedLead(); // lead-1, dana@example.com — converted on the first pass
    // Pass 1: convert the lead, then fail before the booking is BOOKED.
    failCreate.Job = true;
    await expect(finalize()).rejects.toThrow();
    // The checkpoint recorded the resolved customer even though BOOKED never
    // ran. (This assertion fails if the customerId checkpoint is disabled.)
    expect(booking.customerId).toBe("lead-1");

    // The email is now ambiguous — a duplicate record shares it. WITHOUT the
    // checkpoint, the retry would re-match, hit the ambiguity, and mint a fresh
    // duplicate beside the already-converted lead.
    existingCustomers.push({ id: "dup-1", email: "dana@example.com", status: "LEAD" });

    failCreate.Job = false;
    await finalize();

    expect(customersCreated).toHaveLength(0); // reused lead-1 — no duplicate
    expect(booking.status).toBe("BOOKED");
  });

  it("a converted lead is not re-converted or duplicated on retry", async () => {
    seedLead();
    failCreate.Agreement = true;
    await expect(finalize()).rejects.toThrow(/agreement/i);
    expect(booking.status).toBe("QUOTED");

    failCreate.Agreement = false;
    await finalize();

    expect(booking.status).toBe("BOOKED");
    expect(customersCreated).toHaveLength(0); // the lead was converted, never duplicated
    expect(jobsCreated).toHaveLength(1);
    expect(store.Agreement.size).toBe(1);
  });

  it("the paid invoice is required — a booking never reaches BOOKED without its ledger row", async () => {
    failCreate.Invoice = true;
    await expect(finalize()).rejects.toThrow(/invoice/i);
    expect(booking.status).toBe("QUOTED");

    failCreate.Invoice = false;
    await finalize();

    expect(booking.status).toBe("BOOKED");
    expect(paidInvoiceOf()).toMatchObject({ status: "PAID", stripePaymentIntentId: "pi_1" });
    expect([...store.Invoice.keys()]).toEqual(["booking-b1"]); // exactly one
  });

  it("a plan booking resumes onto the same plan, not a second subscription", async () => {
    booking.quoteJson = JSON.stringify({
      serviceLabel: "Commercial pest control — up to 5,000 sqft",
      recurringOffer: { frequency: "MONTHLY", monthlyCents: 14900, initialFeeCents: 19900 },
    });
    booking.recurring = true;

    failCreate.Job = true;
    await expect(finalize()).rejects.toThrow();
    // The plan was created before the job step failed.
    expect(plansCreated).toHaveLength(1);

    failCreate.Job = false;
    await finalize();

    expect(booking.status).toBe("BOOKED");
    expect(plansCreated).toHaveLength(1); // resumed onto the same plan
    expect(store.ServicePlan.size).toBe(1);
  });

  it("a re-delivered webhook for an already-booked payment is a no-op — no second confirmation", async () => {
    await finalize();
    expect(booking.status).toBe("BOOKED");
    expect(emails).toHaveLength(1);
    const jobs1 = jobsCreated.length;

    // Stripe delivers the same event again.
    await finalize();

    expect(jobsCreated).toHaveLength(jobs1); // nothing new
    expect(customersCreated).toHaveLength(1);
    expect(emails).toHaveLength(1); // the confirmation is sent exactly once
  });

  it("the confirmation email is sent only after the booking is BOOKED", async () => {
    // If finalization never reaches BOOKED, no "you're booked" goes out.
    failCreate.Agreement = true;
    await expect(finalize()).rejects.toThrow();
    expect(emails).toHaveLength(0);
  });

  it("never confirms when the BOOKED write itself does not persist", async () => {
    // Every child record exists, but the status write is refused. The
    // confirmation must not go out claiming completion, and the paid customer
    // becomes a durable exception for the idempotent retry.
    _setLockStoreForTests(
      memoryLockStore({
        Job: store.Job,
        CapacityDay: capacityFixture.maps.capacityDays,
        CapacityClaim: capacityFixture.maps.capacityClaims,
        // No BookingRequest wiring: the guarded BOOKED flip fails closed,
        // exactly as a refused conditional write would.
      })
    );
    await expect(finalize()).rejects.toThrow(/BOOKED/i);
    expect(booking.status).toBe("QUOTED");
    expect(emails).toHaveLength(0);
    expect(workOpened.find((w) => w.kind === "PAID_NOT_FINALIZED")).toBeDefined();

    // The write recovers: the retry resumes onto the same records and confirms.
    _setLockStoreForTests(
      memoryLockStore({
        BookingRequest: {
          get: (id: string) =>
            booking && booking.id === id
              ? (booking as Record<string, unknown>)
              : undefined,
        } as unknown as Map<string, Record<string, unknown>>,
        Job: store.Job,
        CapacityDay: capacityFixture.maps.capacityDays,
        CapacityClaim: capacityFixture.maps.capacityClaims,
      })
    );
    await finalize();
    expect(booking.status).toBe("BOOKED");
    expect(jobsCreated).toHaveLength(1);
    expect(emails).toHaveLength(1);
  });

  it("a hard kill after BOOKED but before the confirmation is detected and resends only the unsent message", async () => {
    // The booking is BOOKED with a job on file (so it is not treated as
    // stuck-paid) but neither send happened — the durable markers are unset.
    booking.status = "BOOKED";
    booking.jobId = "job-b1";
    booking.customerId = "cust-b1";
    // confirmationSentAt / officeAlertSentAt intentionally unset.

    await finalize();

    // Both outstanding messages go out exactly once...
    expect(emails).toHaveLength(1);
    expect(leadAlerts).toHaveLength(1);
    expect(booking.confirmationSentAt).toBeDefined();
    expect(booking.officeAlertSentAt).toBeDefined();

    // ...and a further redelivery resends nothing.
    await finalize();
    expect(emails).toHaveLength(1);
    expect(leadAlerts).toHaveLength(1);
  });

  it("resumes only the message that was lost — a confirmation already sent is not repeated", async () => {
    booking.status = "BOOKED";
    booking.jobId = "job-b1";
    booking.customerId = "cust-b1";
    booking.confirmationSentAt = "2026-07-17T00:00:00Z"; // already delivered
    // officeAlertSentAt unset — the kill landed between the two sends.

    await finalize();

    expect(emails).toHaveLength(0); // confirmation not repeated
    expect(leadAlerts).toHaveLength(1); // only the sales alert catches up
    expect(booking.officeAlertSentAt).toBeDefined();
  });

  it("office Retry re-confirms the payment and finishes the stuck booking", async () => {
    failCreate.Agreement = true;
    await expect(finalize()).rejects.toThrow();
    expect(booking.status).toBe("QUOTED");

    failCreate.Agreement = false;
    const res = await retryBookingFinalization("b1");

    expect(res).toEqual({ status: "FINALIZED" });
    expect(booking.status).toBe("BOOKED");
    expect(customersCreated).toHaveLength(1);
    expect(jobsCreated).toHaveLength(1);
  });

  it("office Retry on an already-booked booking does nothing but clears any stale exception", async () => {
    await finalize();
    const jobs1 = jobsCreated.length;

    const res = await retryBookingFinalization("b1");

    expect(res).toEqual({ status: "ALREADY_BOOKED" });
    expect(jobsCreated).toHaveLength(jobs1);
    // Self-healing: a PAID_NOT_FINALIZED left OPEN by a transient resolve
    // failure is cleared even on the already-booked path.
    expect(workResolved.find((w) => w.kind === "PAID_NOT_FINALIZED")).toBeDefined();
  });

  it("reclaims an orphaned finalization claim (a killed run) and completes the booking", async () => {
    // A prior run was hard-killed after claiming: an old claim row remains and
    // the booking is still QUOTED. Without reclaiming, the booking would wedge.
    store.BookingFinalization.set("b1", {
      id: "b1",
      note: "pi pi_1",
      createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    });

    await finalize();

    expect(booking.status).toBe("BOOKED");
    expect(jobsCreated).toHaveLength(1);
  });

  it("does not steal a fresh (live) finalization claim", async () => {
    store.BookingFinalization.set("b1", {
      id: "b1",
      note: "pi pi_1",
      createdAt: new Date().toISOString(),
    });

    await finalize();

    expect(booking.status).toBe("QUOTED"); // a live delivery owns it — no-op
    expect(jobsCreated).toHaveLength(0);
  });

  it("retry reports failure — never FINALIZED — when finalization could not complete", async () => {
    // A live claim is held, so finalizeBooking no-ops and the booking stays QUOTED.
    store.BookingFinalization.set("b1", {
      id: "b1",
      note: "held",
      createdAt: new Date().toISOString(),
    });

    await expect(retryBookingFinalization("b1")).rejects.toThrow(/still not complete/i);
  });

  it("a superseded PaymentIntent that captured money opens a stray-payment exception", async () => {
    await finalizeBooking({
      bookingRequestId: "b1",
      paymentIntentId: "pi_stale",
      amountReceived: 31300,
    });

    const stray = workOpened.find(
      (w) => w.kind === "PAID_NOT_FINALIZED" && w.dedupeKey === "stray-pi:pi_stale"
    );
    expect(stray).toBeDefined();
    expect(stray!.detail).toContain("pi_stale");
    // The booking itself was not touched.
    expect(booking.status).toBe("QUOTED");
    expect(customersCreated).toHaveLength(0);
  });
});

describe("GL-04: a payment landing after the slot hold expired never books a visit that holds nothing", () => {
  const slotKey = "2026-07-22#MORNING#t1";
  beforeEach(() => {
    _setLockStoreForTests(
      memoryLockStore({
        CapacityDay: capacityFixture.maps.capacityDays,
        CapacityClaim: capacityFixture.maps.capacityClaims,
        Job: store.Job,
        BookingRequest: {
          get: (id: string) =>
            booking && booking.id === id
              ? (booking as Record<string, unknown>)
              : undefined,
        } as unknown as Map<string, Record<string, unknown>>,
      })
    );
    booking.capacityTechnicianId = "t1";
    booking.capacityMinutes = 60;
    // NO CapacityClaim row exists — the 45-minute hold expired and the sweep
    // released it before the payment was reported.
  });

  it("re-reserves the booking's stamped slot when it still fits, and stamps the job with the hold", async () => {
    capacityFixture.maps.capacityDays.set(slotKey, {
      id: slotKey,
      date: "2026-07-22",
      window: "MORNING",
      technicianId: "t1",
      committedMinutes: 0,
    });
    await finalize();
    expect(booking.status).toBe("BOOKED");
    expect(
      capacityFixture.maps.capacityDays.get(slotKey)!.committedMinutes
    ).toBe(60);
    const job = [...store.Job.values()][0];
    expect(job).toMatchObject({
      capacityWindow: "MORNING",
      capacityMinutes: 60,
      capacityTechnicianId: "t1",
    });
  });

  it("a slot that meanwhile SOLD OUT books onto the pool ledger and opens an owned re-place case", async () => {
    capacityFixture.maps.capacityDays.set(slotKey, {
      id: slotKey,
      date: "2026-07-22",
      window: "MORNING",
      technicianId: "t1",
      committedMinutes: 240, // full — someone else bought the window
    });
    await finalize();
    expect(booking.status).toBe("BOOKED"); // the money is real either way
    // The sold-out slot was NOT force-oversold.
    expect(
      capacityFixture.maps.capacityDays.get(slotKey)!.committedMinutes
    ).toBe(240);
    const job = [...store.Job.values()][0];
    expect(job).toMatchObject({ capacityWindow: "MORNING" });
    expect(job.capacityTechnicianId ?? null).toBeNull(); // pool, not a lie
    expect(
      workOpened.some(
        (w) => (w as Record<string, unknown>).kind === "UNSTAFFED_VISIT"
      )
    ).toBe(true);
  });
});

describe("GL-06 — a pending bank debit is a real commitment with honest state", () => {
  const finalizePending = () =>
    finalizeBooking({
      bookingRequestId: "b1",
      paymentIntentId: "pi_1",
      amountReceived: 31300,
      paymentMethodId: "pm_bank",
      pending: { methodLabel: "bank transfer (ACH)" },
    });
  const failDebit = (reason = "The bank account had insufficient funds.") =>
    recordFunnelPaymentFailure({
      bookingRequestId: "b1",
      intentId: "pi_1",
      reason,
    });

  it("creates the FULL commitment now — job, OPEN invoice, agreement — all saying payment pending, never paid", async () => {
    await finalizePending();

    expect(booking.status).toBe("PROCESSING");
    expect(booking.jobId).toBe("job-b1");
    expect(booking.customerId).toBeTruthy();
    expect(booking.processingStartedAt).toBeTruthy();
    expect(booking.processingExpectedBy).toBeTruthy();
    expect(booking.processingMethodLabel).toBe("bank transfer (ACH)");

    const job = store.Job.get("job-b1")!;
    expect(job.status).toBe("SCHEDULED"); // real and dispatchable
    expect(job.paidAt).toBeUndefined(); // NEVER described as paid
    expect(job.paymentPendingIntentId).toBe("pi_1");

    const invoice = store.Invoice.get("booking-b1")!;
    expect(invoice.status).toBe("OPEN"); // owed, not settled
    expect(invoice.method).toBe("BANK");
    expect(invoice.pendingDebitIntentId).toBe("pi_1"); // not collectable while clearing
    expect(invoice.paidAt).toBeUndefined();

    const agreement = store.Agreement.get("agr-b1")!;
    expect(String(agreement.bodyText)).toContain("authorized by bank debit");

    // The customer hears "scheduled, payment processing" — not a receipt.
    const confirmations = emails.filter((e) =>
      e.subject.includes("payment processing")
    );
    expect(confirmations).toHaveLength(1);
    expect(confirmations[0].html).toContain("don't need to do anything");
    expect(emails.some((e) => e.subject.startsWith("You're booked"))).toBe(false);
    // The office alert says payment pending, not paid.
    expect(leadAlerts).toHaveLength(1);
    expect(leadAlerts[0].bodyHtml).toContain("payment pending");
  });

  it("a redelivered processing event resumes idempotently — one commitment, one email", async () => {
    await finalizePending();
    await finalizePending();

    expect(jobsCreated).toHaveLength(1);
    expect(store.Invoice.size).toBe(1);
    expect(
      emails.filter((e) => e.subject.includes("payment processing"))
    ).toHaveLength(1);
    expect(leadAlerts).toHaveLength(1);
  });

  it("the debit settling flips the SAME commitment paid — exactly once — and sends the receipt", async () => {
    await finalizePending();
    await finalize(); // the success webhook

    expect(booking.status).toBe("BOOKED");
    const job = store.Job.get("job-b1")!;
    expect(job.paidAt).toBeTruthy();
    expect(job.paymentPendingIntentId).toBeUndefined();
    const invoice = store.Invoice.get("booking-b1")!;
    expect(invoice.status).toBe("PAID");
    expect(invoice.paidAt).toBeTruthy();
    expect(invoice.pendingDebitIntentId).toBeUndefined();
    expect(jobsCreated).toHaveLength(1); // the same records, never a second set
    expect(emails.some((e) => e.subject.startsWith("You're booked"))).toBe(true);

    // A duplicate success redelivery changes nothing and re-emails nobody.
    const paidAt = invoice.paidAt;
    const receipts = emails.filter((e) => e.subject.startsWith("You're booked"));
    await finalize();
    expect(store.Invoice.get("booking-b1")!.paidAt).toBe(paidAt);
    expect(
      emails.filter((e) => e.subject.startsWith("You're booked"))
    ).toEqual(receipts);
  });

  it("failure BEFORE service cancels the visit exactly once, voids the invoice, and tells the customer the truth", async () => {
    await finalizePending();
    const outcome = await failDebit();

    expect(outcome).toBe("HANDLED");
    expect(booking.status).toBe("PAYMENT_FAILED");
    const job = store.Job.get("job-b1")!;
    expect(job.status).toBe("CANCELED");
    expect(job.paymentPendingIntentId).toBeUndefined();
    expect(store.Invoice.get("booking-b1")!.status).toBe("VOID");
    const notices = emails.filter((e) =>
      e.subject.includes("didn't go through")
    );
    expect(notices).toHaveLength(1);
    expect(notices[0].html).toContain("has been canceled");
    expect(notices[0].html).toContain("no money was collected");

    // Replay: nothing double-cancels, nothing re-emails.
    await failDebit();
    expect(
      emails.filter((e) => e.subject.includes("didn't go through"))
    ).toHaveLength(1);
    expect(store.Job.get("job-b1")!.status).toBe("CANCELED");
  });

  it("failure AFTER service never erases the work — the invoice becomes the owed balance with Finance collection", async () => {
    await finalizePending();
    store.Job.get("job-b1")!.status = "COMPLETED";

    const outcome = await failDebit();

    expect(outcome).toBe("HANDLED");
    expect(booking.status).toBe("PAYMENT_FAILED");
    expect(store.Job.get("job-b1")!.status).toBe("COMPLETED"); // work stands
    const invoice = store.Invoice.get("booking-b1")!;
    expect(invoice.status).toBe("OPEN"); // balance due — owed for real now
    expect(invoice.pendingDebitIntentId).toBeUndefined(); // collectable again
    expect(String(invoice.failureReason)).toContain("insufficient funds");
    expect(
      workOpened.some(
        (w) => w.kind === "BALANCE_COLLECTION" && w.dedupeKey === "balance:b1"
      )
    ).toBe(true);
    const notices = emails.filter((e) => e.subject.includes("Action needed"));
    expect(notices).toHaveLength(1);
    expect(notices[0].html).toContain("outstanding balance");
  });

  it("a LATE success applies exactly once to the post-service balance — never double-collects", async () => {
    await finalizePending();
    store.Job.get("job-b1")!.status = "COMPLETED";
    await failDebit();

    await finalize(); // the debit settled after all

    expect(booking.status).toBe("BOOKED");
    const invoice = store.Invoice.get("booking-b1")!;
    expect(invoice.status).toBe("PAID");
    expect(
      workResolved.some(
        (w) => w.kind === "BALANCE_COLLECTION" && w.dedupeKey === "balance:b1"
      )
    ).toBe(true);

    const paidAt = invoice.paidAt;
    await finalize(); // duplicate success event
    expect(store.Invoice.get("booking-b1")!.paidAt).toBe(paidAt);
  });

  it("a LATE success after the pre-service cancel is a Finance decision — nothing silently resurrected", async () => {
    await finalizePending();
    await failDebit(); // canceled the visit, released the slot

    await finalize(); // then the money landed anyway

    expect(booking.status).toBe("PAYMENT_FAILED"); // not resurrected
    expect(store.Job.get("job-b1")!.status).toBe("CANCELED");
    expect(store.Invoice.get("booking-b1")!.status).toBe("VOID");
    expect(
      workOpened.some(
        (w) =>
          w.kind === "PAID_NOT_FINALIZED" &&
          w.dedupeKey === "late-success:b1" &&
          w.title.includes("settled AFTER")
      )
    ).toBe(true);
  });

  it("a stale processing event can never regress a BOOKED (or failed) booking", async () => {
    await finalize(); // instant card success — BOOKED
    const jobCount = jobsCreated.length;
    const emailCount = emails.length;

    await finalizePending(); // late/duplicate processing event

    expect(booking.status).toBe("BOOKED");
    expect(jobsCreated).toHaveLength(jobCount);
    expect(emails).toHaveLength(emailCount);
  });

  it("a pending debit for the WRONG amount refuses the commitment and opens a Finance case", async () => {
    await finalizeBooking({
      bookingRequestId: "b1",
      paymentIntentId: "pi_1",
      amountReceived: 100,
      pending: { methodLabel: "bank transfer (ACH)" },
    });

    expect(booking.status).toBe("QUOTED"); // no commitment on wrong money
    expect(store.Job.size).toBe(0);
    expect(
      workOpened.some((w) =>
        w.title.includes("Pending bank debit does not match")
      )
    ).toBe(true);
  });
});
