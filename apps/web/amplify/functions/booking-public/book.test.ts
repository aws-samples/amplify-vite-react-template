import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _setLockStoreForTests, memoryLockStore } from "../shared/atomicLock";
import { capacityFixtureModels } from "../shared/capacityTestFixture";
import {
  BOOKING_TERMS_TEXT,
  BOOKING_TERMS_VERSION,
} from "../shared/bookingTerms";

/**
 * R29 — /book re-checks live availability before taking money.
 *
 * The stored quote is a snapshot up to 24 hours old; before this check,
 * every holder of a live quote could book the same last slot. Booking must
 * re-read the day and re-run capacity/feasibility — while still honoring the
 * QUOTED price, never repricing.
 *
 * R17 — /book requires the tcVersion the customer actually saw; a missing or
 * stale version gets a 409 carrying the fresh terms (and creates no
 * PaymentIntent), and a successful booking records version, server-stamped
 * timestamp, IP and user-agent.
 */

type Stop = { customerId: string; serviceType: string; status: string };

let booking: Record<string, unknown>;
const bookingRows = new Map<string, Record<string, unknown>>();
let failCheckoutPersistWrites = false;
let stopsOnDay: Stop[];
let jobRow: Record<string, unknown> | null = null;
const bookingUpdates: Record<string, unknown>[] = [];

const capacityFixture = capacityFixtureModels();

const fakeDataClient = {
  models: {
    BookingRequest: {
      get: async () => ({ data: booking }),
      update: async (patch: Record<string, unknown>) => {
        bookingUpdates.push(patch);
        booking = { ...booking, ...patch };
        return { data: booking };
      },
    },
    Technician: {
      list: async () => ({
        data: [
          {
            id: "t1",
            active: true,
            licenseNumber: "MA-1",
            licenseExpiresOn: "2099-01-01",
          },
        ],
      }),
    },
    Job: {
      listJobByScheduledDate: async () => ({ data: stopsOnDay }),
      // GL-06: the /book gate reads the failed booking's job to distinguish a
      // re-payable pre-service failure from a post-service balance.
      get: async ({ id }: { id: string }) => ({
        data: jobRow && jobRow.id === id ? jobRow : null,
      }),
    },
    Customer: {
      get: async ({ id }: { id: string }) => ({
        data: {
          id,
          displayName: "Dana Whitlock",
          email: "dana@example.com",
          // A saved-card customer already mirrors a Stripe customer.
          stripeCustomerId: "cus_saved",
          serviceStreet: "9 Elm St",
          serviceCity: "Ware",
          serviceState: "MA",
          serviceZip: "01082",
        },
      }),
      update: async () => ({ data: {} }),
    },
  },
};
Object.assign(fakeDataClient.models, capacityFixture.models);
vi.mock("../shared/dataClient", () => ({ dataClient: async () => fakeDataClient }));

vi.mock("../shared/email", () => ({
  emailShell: (h: string, b: string) => `${h}${b}`,
  sendEmail: async () => true,
  notifyOffice: async () => true,
}));

vi.mock("../shared/driveTime", () => ({
  HQ_ADDRESS: "81 Greenwich Rd, Ware, MA 01082",
  driveMinutesBetween: async () => 20,
  driveMatrixFrom: async (_k: string, _o: string, dests: string[]) =>
    dests.map(() => null),
}));

let existingIntent: Record<string, unknown> | null = null;
const defaultIntentCreateImpl = async (
  args: { amount: number },
  _opts?: { idempotencyKey?: string }
) => ({
  id: "pi_new",
  client_secret: "cs_new",
  status: "requires_payment_method",
  amount: args.amount,
});
const intentCreate = vi.fn(defaultIntentCreateImpl);
const intentRetrieve = vi.fn(async () => existingIntent);
// A realistic cancel: the provider answers with the CANCELED intent — the
// contract verifies that status instead of trusting a silent void.
const defaultIntentCancelImpl = async (id: string) => ({
  id,
  status: "canceled" as const,
});
const intentCancel = vi.fn(defaultIntentCancelImpl);
const customerCreate = vi.fn(
  async (
    _args: Record<string, unknown>,
    _opts?: { idempotencyKey?: string }
  ) => ({ id: "cus_1" })
);
// The saved payment method getDefaultPaymentMethod resolves (null = no card).
let savedPaymentMethod: Record<string, unknown> | null = { id: "pm_card", type: "card" };
const customerRetrieve = vi.fn(async (_id: string, _opts?: unknown) => ({
  id: "cus_saved",
  deleted: false,
  invoice_settings: { default_payment_method: savedPaymentMethod },
}));
vi.mock("stripe", () => ({
  default: class {
    paymentIntents = {
      create: intentCreate,
      retrieve: intentRetrieve,
      cancel: intentCancel,
    };
    customers = { create: customerCreate, retrieve: customerRetrieve };
  },
}));

vi.mock("@aws-sdk/client-ssm", () => ({
  SSMClient: class {
    async send() {
      return { Parameter: { Value: "test-secret" } };
    }
  },
  GetParameterCommand: class {},
}));

// The card-less invoice path finalizes synchronously; the finalize behavior
// itself is covered in bookingFinalize.test.ts, so here we only assert the
// /book branch routes to it with the right args (eligibility, capacity, terms).
const finalizeBookingMock = vi.fn(
  async (_opts: {
    bookingRequestId: string;
    paymentIntentId: string;
    amountReceived: number;
    invoice?: { terms: string; dueDate: string };
  }) => {}
);
vi.mock("../shared/bookingFinalize", () => ({
  finalizeBooking: finalizeBookingMock,
}));

const { handler } = await import("./handler");

const postBook = async (body: unknown) => {
  const res = (await handler({
    headers: { "user-agent": "vitest-agent/1.0" },
    requestContext: {
      http: { method: "POST", path: "/book", sourceIp: "1.2.3.4" },
    },
    body: JSON.stringify(body),
    isBase64Encoded: false,
  } as never)) as { statusCode: number; body: string };
  return { status: res.statusCode, body: JSON.parse(res.body) };
};

/** Freeze "today" in the shop's timezone. */
const freezeEastern = (isoDate: string) =>
  vi.setSystemTime(new Date(`${isoDate}T12:00:00-04:00`));

// Quoted 2026-07-15; booking attempted 2026-07-16 for Wednesday 2026-07-22.
const QUOTED_DAY = {
  date: "2026-07-22",
  priceCents: 31300, // deliberately NOT what a live repricing would produce
  factors: [],
};

const gpcStop = (n: number): Stop => ({
  customerId: `c${n}`,
  serviceType: "GENERAL_PEST",
  status: "SCHEDULED",
});

/** GL-04: "full" now means the technician-DAY LEDGER holds the minutes —
 *  one slot row per tech-day (540 min), not a stop count. `headroom` leaves
 *  that many minutes free. */
const fillSlots = (date: string, headroom = 0) => {
  capacityFixture.maps.capacityDays.set(`${date}#t1`, {
    id: `${date}#t1`,
    date,
    technicianId: "t1",
    committedMinutes: 540 - headroom,
  });
};

beforeEach(() => {
  capacityFixture.maps.capacityDays.clear();
  capacityFixture.maps.capacityClaims.clear();
  capacityFixture.maps.techDayStops.clear();
  capacityFixture.maps.closures.clear();
  capacityFixture.maps.exceptions.clear();
  bookingRows.clear();
  failCheckoutPersistWrites = false;
  const baseStore = memoryLockStore({
    CapacityDay: capacityFixture.maps.capacityDays,
    CapacityClaim: capacityFixture.maps.capacityClaims,
    TechDayStops: capacityFixture.maps.techDayStops,
    // GL-17: the single-winner payment-attempt lease AND the fenced
    // checkout persistence live on the BookingRequest row — same map
    // object the fake model serves.
    BookingRequest: bookingRows,
  });
  // Fault injection for the FENCED checkout persistence only (writes that
  // carry the intent reference) — the attempt lease still works, exactly
  // like a store that fails mid-attempt.
  _setLockStoreForTests({
    conditionalUpdate: async (model, id, sets, conditions, opts) => {
      if (
        failCheckoutPersistWrites &&
        model === "BookingRequest" &&
        "stripePaymentIntentId" in sets
      ) {
        return { ok: false, reason: "UNSUPPORTED" };
      }
      return baseStore.conditionalUpdate(model, id, sets, conditions, opts);
    },
    conditionalDelete: (model, id, conditions) =>
      baseStore.conditionalDelete(model, id, conditions),
  });
  vi.useFakeTimers();
  freezeEastern("2026-07-16");
  bookingUpdates.length = 0;
  stopsOnDay = [];
  existingIntent = null;
  intentCreate.mockClear();
  intentCreate.mockImplementation(defaultIntentCreateImpl);
  intentRetrieve.mockClear();
  intentCancel.mockClear();
  intentCancel.mockImplementation(defaultIntentCancelImpl);
  customerCreate.mockClear();
  customerRetrieve.mockClear();
  savedPaymentMethod = { id: "pm_card", type: "card" };
  finalizeBookingMock.mockClear();
  finalizeBookingMock.mockImplementation(async () => {});
  jobRow = null;
  process.env.SES_NOTIFY_EMAIL = "office@pestbuzzkill.com";
  process.env.STRIPE_SECRET_KEY = "sk_test_x";
  process.env.GOOGLE_ROUTES_API_KEY = "test-routes-key";
  booking = {
    id: "b1",
    status: "QUOTED",
    name: "Dana Whitlock",
    email: "dana@example.com",
    phone: null,
    street: "12 Beacon St",
    city: "Ware",
    state: "MA",
    zip: "01082",
    service: "RODENT",
    zone: "B",
    quoteJson: JSON.stringify({
      days: [QUOTED_DAY],
      baseCents: 22400,
      serviceLabel: "Rodent treatment — up to 2,000 sqft",
      recurringOffer: null,
    }),
    expiresAt: "2026-07-17T12:00:00Z",
    stripeCustomerId: null,
    stripePaymentIntentId: null,
    selectedDate: null,
  };
  bookingRows.set("b1", booking);
});

afterEach(() => vi.useRealTimers());

const bookIt = (overrides: Record<string, unknown> = {}) =>
  postBook({
    bookingId: "b1",
    date: "2026-07-22",
    tcAccepted: true,
    tcVersion: BOOKING_TERMS_VERSION,
    ...overrides,
  });

/** A trusted internal invoke (crm-billing → this Lambda): no requestContext.http,
 *  the customerId already verified by crm-billing against the Cognito identity. */
const internalBook = async (
  customerId: string,
  body: Record<string, unknown> = {}
) => {
  const res = (await handler({
    internalOp: {
      kind: "BOOK",
      customerId,
      sourceIp: "1.2.3.4",
      body: {
        bookingId: "b1",
        date: "2026-07-22",
        tcAccepted: true,
        tcVersion: BOOKING_TERMS_VERSION,
        ...body,
      },
    },
  } as never)) as unknown as
    | { ok: true; data: Record<string, unknown> }
    | { ok: false; status: number; error: string };
  return res;
};

describe("invoice-me — HOA/commercial book card-less on net terms", () => {
  it("refuses a residential invoice request server-side, even if the client asks", async () => {
    // Default fixture has no propertyKind → residential.
    const res = await bookIt({ invoice: true });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invoicing isn't available/i);
    expect(finalizeBookingMock).not.toHaveBeenCalled();
    expect(intentCreate).not.toHaveBeenCalled();
  });

  it("books a commercial invoice request card-less — claims capacity, finalizes on net terms, returns no client secret", async () => {
    booking.propertyKind = "COMMERCIAL";

    const res = await bookIt({ invoice: true });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ booked: true, amountCents: 31300 });
    expect(res.body.clientSecret).toBeUndefined();
    // No Stripe object is ever created for an invoiced booking.
    expect(intentCreate).not.toHaveBeenCalled();
    // The card-less finalize ran once, with the synthetic anchor + net terms.
    expect(finalizeBookingMock).toHaveBeenCalledTimes(1);
    const arg = finalizeBookingMock.mock.calls[0][0];
    expect(arg).toMatchObject({
      bookingRequestId: "b1",
      paymentIntentId: "invoice-b1",
      amountReceived: 31300,
      invoice: { terms: "NET_30" },
    });
    expect(arg.invoice?.dueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // The selection + amount were persisted through the fenced write.
    expect(booking.selectedDate).toBe("2026-07-22");
    expect(booking.amountCents).toBe(31300);
    // No card intent reference was written.
    expect(booking.stripePaymentIntentId ?? null).toBeNull();
  });
});

describe("booking re-checks live availability (R29)", () => {
  it("books when the day is still live — at the quoted price, not a reprice", async () => {
    const res = await bookIt();

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ clientSecret: "cs_new", amountCents: 31300 });
    expect(intentCreate).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 31300 }),
      expect.anything()
    );
    // The fenced write landed the facts on the durable row.
    expect(booking).toMatchObject({
      selectedDate: "2026-07-22",
      stripePaymentIntentId: "pi_new",
    });
  });

  it("refuses when the day filled up after the quote", async () => {
    fillSlots("2026-07-22"); // every technician-window ledger is full

    const res = await bookIt();

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no longer available/i);
    expect(intentCreate).not.toHaveBeenCalled();
  });

  it("refuses when the day no longer fits the route minutes", async () => {
    // 20 minutes of headroom can't absorb 30 on-site + real Routes legs —
    // the per-slot feasibility must hold even though the ledger isn't full.
    fillSlots("2026-07-22", 20);

    const res = await bookIt();

    expect(res.status).toBe(409);
    expect(intentCreate).not.toHaveBeenCalled();
  });

  it("cancels a stale open intent when the day is gone, so it can't still charge", async () => {
    booking.stripePaymentIntentId = "pi_old";
    existingIntent = {
      id: "pi_old",
      status: "requires_payment_method",
      amount: 31300,
      client_secret: "cs_old",
    };
    fillSlots("2026-07-22");

    const res = await bookIt();

    expect(res.status).toBe(409);
    expect(intentCancel).toHaveBeenCalledWith("pi_old");
  });

  it("a paid booking still reads 'already paid', not 'day unavailable'", async () => {
    booking.stripePaymentIntentId = "pi_old";
    existingIntent = { id: "pi_old", status: "succeeded", amount: 31300 };
    stopsOnDay = Array.from({ length: 8 }, (_, i) => gpcStop(i));

    const res = await bookIt();

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already paid/i);
    expect(intentCancel).not.toHaveBeenCalled();
  });

  it("a still-processing booking says so, never 'already paid' (GL-06)", async () => {
    booking.stripePaymentIntentId = "pi_old";
    existingIntent = { id: "pi_old", status: "processing", amount: 31300 };
    stopsOnDay = Array.from({ length: 8 }, (_, i) => gpcStop(i));

    const res = await bookIt();

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/still processing/i);
    expect(res.body.error).not.toMatch(/already paid/i);
    expect(intentCancel).not.toHaveBeenCalled();
  });
});

describe("plan-only quotes always book the plan", () => {
  // A community common-area quote has no one-time offer: whatever the
  // client sends, the booking is the plan and the charge is the first month.
  beforeEach(() => {
    booking.service = "GENERAL_PEST";
    booking.quoteJson = JSON.stringify({
      days: [{ ...QUOTED_DAY, priceCents: 28800 }],
      baseCents: 28800,
      serviceLabel: "Community common-area pest control — 24 units",
      recurringOffer: {
        frequency: "MONTHLY",
        monthlyCents: 28800,
        initialFeeCents: 28800,
      },
      planOnly: true,
    });
  });

  it("charges the first month and records recurring even when the client sends recurring: false", async () => {
    const res = await bookIt({ recurring: false });

    expect(res.status).toBe(200);
    expect(res.body.amountCents).toBe(28800);
    expect(intentCreate).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 28800 }),
      expect.anything()
    );
    expect(booking).toMatchObject({
      recurring: true,
      amountCents: 28800,
    });
    expect(res.body.summary).toContain("$288/mo");
  });
});

describe("terms acceptance is versioned and recorded (R17)", () => {
  const freshTerms = {
    version: BOOKING_TERMS_VERSION,
    text: BOOKING_TERMS_TEXT,
  };

  it("refuses a /book with no tcVersion — 409 carrying the fresh terms, no charge", async () => {
    const res = await bookIt({ tcVersion: undefined });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/terms were updated/i);
    expect(res.body.terms).toEqual(freshTerms);
    expect(intentCreate).not.toHaveBeenCalled();
    expect(bookingUpdates).toHaveLength(0);
  });

  it("refuses a stale tcVersion the same way", async () => {
    const res = await bookIt({ tcVersion: "2020-01-01" });

    expect(res.status).toBe(409);
    expect(res.body.terms).toEqual(freshTerms);
    expect(intentCreate).not.toHaveBeenCalled();
    expect(bookingUpdates).toHaveLength(0);
  });

  it("records version, IP, user-agent and a SERVER-stamped tcAcceptedAt", async () => {
    // A client-supplied timestamp must never win — send a lie and make sure
    // the record carries the frozen server clock instead.
    const res = await bookIt({ tcAcceptedAt: "1999-01-01T00:00:00Z" });

    expect(res.status).toBe(200);
    expect(booking).toMatchObject({
      tcVersion: BOOKING_TERMS_VERSION,
      tcAcceptedAt: new Date().toISOString(), // frozen 2026-07-16T16:00:00.000Z
      tcIp: "1.2.3.4",
      tcUserAgent: "vitest-agent/1.0",
    });
  });
});

describe("live-key branch guard", () => {
  // The shared SSM fallback holds the live key, so a missing branch secret
  // once ran this funnel in live mode from a staging checkout. A wrong key
  // must be a loud refusal, never a real charge.
  it("refuses a live key on any non-production branch", async () => {
    const { assertStripeKeyAllowed } = await import("./handler");
    expect(() => assertStripeKeyAllowed("sk_live_abc", "staging")).toThrow(
      /live Stripe key/i
    );
    expect(() => assertStripeKeyAllowed("rk_live_abc", "staging")).toThrow(
      /live Stripe key/i
    );
    expect(() => assertStripeKeyAllowed("sk_live_abc", undefined)).toThrow(
      /live Stripe key/i
    );
  });

  it("allows the live key on main and test keys everywhere", async () => {
    const { assertStripeKeyAllowed } = await import("./handler");
    expect(() => assertStripeKeyAllowed("sk_live_abc", "main")).not.toThrow();
    expect(() => assertStripeKeyAllowed("sk_test_abc", "staging")).not.toThrow();
    expect(() => assertStripeKeyAllowed("sk_test_abc", "main")).not.toThrow();
  });
});

describe("GL-06 — /book retrieves the durable payment state, never a dead-end Quote not found", () => {
  it("a PROCESSING booking with its scheduled commitment says don't pay again", async () => {
    booking.status = "PROCESSING";
    booking.jobId = "j1";

    const res = await bookIt();

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("visit is scheduled");
    expect(res.body.error).toContain("don't pay again");
  });

  it("a BOOKED booking says it is already paid", async () => {
    booking.status = "BOOKED";

    const res = await bookIt();

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("already paid");
  });

  it("a POST-service failure is a balance due — paying here would buy a second visit", async () => {
    booking.status = "PAYMENT_FAILED";
    booking.jobId = "j1";
    jobRow = { id: "j1", status: "COMPLETED" };

    const res = await bookIt();

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("outstanding balance");
  });

  it("a PRE-service failure is simply re-payable — the gate lets the retry through", async () => {
    booking.status = "PAYMENT_FAILED";
    booking.jobId = "j1";
    jobRow = { id: "j1", status: "CANCELED" };

    const res = await bookIt();

    // Whatever the downstream capacity/payment result, the state gate must
    // not dead-end the retry as "Quote not found".
    expect(res.status).not.toBe(404);
    expect(String(res.body.error ?? "")).not.toContain("Quote not found");
  });
});

describe("GL-17 — off-season enrollment checks out date-less, paid TODAY", () => {
  const offSeasonQuote = () => {
    freezeEastern("2026-12-09"); // deep off-season: a November–March customer
    booking.service = "MOSQUITO";
    booking.expiresAt = "2026-12-10T12:00:00Z";
    booking.quoteJson = JSON.stringify({
      days: [], // no in-season day existed to offer
      baseCents: 11900,
      serviceLabel: "Mosquito plan — up to ½ acre",
      recurringOffer: {
        frequency: "MONTHLY",
        monthlyCents: 11900,
        initialFeeCents: 11900,
      },
      planOnly: true,
      offSeason: true,
    });
  };
  const enroll = () =>
    postBook({
      bookingId: "b1",
      // No date, no window — none exists to pick.
      recurring: true,
      tcAccepted: true,
      tcVersion: BOOKING_TERMS_VERSION,
    });

  it("charges the FIRST MONTH immediately with no date, no window, no capacity claim", async () => {
    offSeasonQuote();

    const res = await enroll();

    expect(res.status).toBe(200);
    expect(res.body.amountCents).toBe(11900); // pays now — never a dead end
    expect(res.body.clientSecret).toBe("cs_new");
    expect(String(res.body.summary)).toContain("billing starts today");
    expect(String(res.body.summary)).toContain("April");
    expect(String(res.body.summary)).toContain("confirm the exact day");
    expect(intentCreate).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 11900, setup_future_usage: "off_session" }),
      // The deterministic first-generation idempotency key.
      expect.objectContaining({ idempotencyKey: "bk-intent-b1-first" })
    );
    // The enrollment holds no slot: nothing touched the capacity ledgers.
    expect(capacityFixture.maps.capacityDays.size).toBe(0);
    expect(capacityFixture.maps.capacityClaims.size).toBe(0);
    // The fenced write landed the enrollment facts on the durable row
    // (nulls REMOVE the attribute, exactly like the deployed CAS write).
    expect(booking.selectedDate ?? null).toBeNull();
    expect(booking).toMatchObject({
      recurring: true,
      amountCents: 11900,
      tcVersion: BOOKING_TERMS_VERSION,
      stripePaymentIntentId: "pi_new",
    });
  });

  it("a RETRY reuses the live same-amount intent — never a second chargeable intent", async () => {
    offSeasonQuote();
    booking.stripePaymentIntentId = "pi_live";
    existingIntent = {
      id: "pi_live",
      amount: 11900,
      status: "requires_payment_method",
      client_secret: "cs_live",
    };

    const res = await enroll();

    expect(res.status).toBe(200);
    expect(res.body.clientSecret).toBe("cs_live");
    expect(intentCreate).not.toHaveBeenCalled();
    expect(intentCancel).not.toHaveBeenCalled();
  });

  it("a stale different-amount intent is CANCELED before the fresh one exists", async () => {
    offSeasonQuote();
    booking.stripePaymentIntentId = "pi_stale";
    existingIntent = {
      id: "pi_stale",
      amount: 99900,
      status: "requires_payment_method",
      client_secret: "cs_stale",
    };

    const res = await enroll();

    expect(res.status).toBe(200);
    expect(res.body.clientSecret).toBe("cs_new");
    expect(intentCancel).toHaveBeenCalledTimes(1);
    expect(intentCreate).toHaveBeenCalledTimes(1);
  });

  it("an already-succeeded intent means PAID — 409, don't charge twice", async () => {
    offSeasonQuote();
    booking.stripePaymentIntentId = "pi_done";
    existingIntent = {
      id: "pi_done",
      amount: 11900,
      status: "succeeded",
      client_secret: "cs_done",
    };

    const res = await enroll();

    expect(res.status).toBe(409);
    expect(String(res.body.error)).toContain("already paid");
    expect(intentCreate).not.toHaveBeenCalled();
  });

  it("an off-season quote stored WITHOUT its plan offer refuses cleanly, never 500s", async () => {
    offSeasonQuote();
    booking.quoteJson = JSON.stringify({
      days: [],
      serviceLabel: "Mosquito plan — up to ½ acre",
      recurringOffer: null,
      offSeason: true,
    });

    const res = await enroll();

    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain("No recurring plan");
  });
});

describe("GL-17 corrective — off-season checkout behind the failure-safe payment contract", () => {
  const offSeasonQuote = () => {
    freezeEastern("2026-12-09");
    booking.service = "MOSQUITO";
    booking.expiresAt = "2026-12-10T12:00:00Z";
    booking.quoteJson = JSON.stringify({
      days: [],
      baseCents: 11900,
      serviceLabel: "Mosquito plan — up to ½ acre",
      recurringOffer: {
        frequency: "MONTHLY",
        monthlyCents: 11900,
        initialFeeCents: 11900,
      },
      planOnly: true,
      offSeason: true,
    });
  };
  const enroll = () =>
    postBook({
      bookingId: "b1",
      recurring: true,
      tcAccepted: true,
      tcVersion: BOOKING_TERMS_VERSION,
    });
  const flush = async (rounds = 60) => {
    for (let i = 0; i < rounds; i++) await Promise.resolve();
  };

  it("TWO PARALLEL clicks: exactly one attempt proceeds — one customer, one intent", async () => {
    offSeasonQuote();
    // Barrier: hold the winner INSIDE the provider create so the second
    // click arrives while the attempt lease is genuinely held.
    let releaseCreate!: () => void;
    const gate = new Promise<void>((resolve) => (releaseCreate = resolve));
    intentCreate.mockImplementation(async (args: { amount: number }) => {
      await gate;
      return {
        id: "pi_new",
        client_secret: "cs_new",
        status: "requires_payment_method",
        amount: args.amount,
      };
    });

    const first = enroll();
    await flush(); // the winner is now parked inside paymentIntents.create
    expect(intentCreate).toHaveBeenCalledTimes(1);

    const second = await enroll(); // the racing duplicate
    expect(second.status).toBe(409);
    expect(String(second.body.error)).toContain("already being prepared");

    releaseCreate();
    const winner = await first;
    expect(winner.status).toBe(200);
    expect(winner.body.clientSecret).toBe("cs_new");
    // Exactly ONE provider customer and ONE intent were ever created.
    expect(customerCreate).toHaveBeenCalledTimes(1);
    expect(intentCreate).toHaveBeenCalledTimes(1);
  });

  it("a CANCELED same-amount intent is never reused — a fresh generation replaces it", async () => {
    offSeasonQuote();
    booking.stripePaymentIntentId = "pi_dead";
    existingIntent = {
      id: "pi_dead",
      amount: 11900,
      status: "canceled",
      client_secret: "cs_dead", // present, matching amount — still dead
    };

    const res = await enroll();

    expect(res.status).toBe(200);
    expect(res.body.clientSecret).toBe("cs_new");
    expect(res.body.clientSecret).not.toBe("cs_dead");
    // The replacement is keyed on the dead generation — deterministic.
    expect(intentCreate).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 11900 }),
      expect.objectContaining({ idempotencyKey: "bk-intent-b1-pi_dead" })
    );
  });

  it("a PROCESSING intent is answered truthfully — never replaced, never re-charged", async () => {
    offSeasonQuote();
    booking.stripePaymentIntentId = "pi_proc";
    existingIntent = {
      id: "pi_proc",
      amount: 11900,
      status: "processing",
      client_secret: "cs_proc",
    };

    const res = await enroll();

    expect(res.status).toBe(409);
    expect(String(res.body.error)).toContain("still processing");
    expect(intentCreate).not.toHaveBeenCalled();
    expect(intentCancel).not.toHaveBeenCalled();
  });

  it("a stale intent that CANNOT be proven terminal blocks any replacement", async () => {
    offSeasonQuote();
    booking.stripePaymentIntentId = "pi_stuck";
    existingIntent = {
      id: "pi_stuck",
      amount: 99900, // mismatched — must be closed before replacement
      status: "requires_payment_method",
      client_secret: "cs_stuck",
    };
    intentCancel.mockImplementation(async () => {
      throw new Error("provider timeout");
    });
    // The verification re-read still shows it live.

    const res = await enroll();

    expect(res.status).toBe(503);
    expect(String(res.body.error)).toContain("couldn't safely close");
    // No new chargeable intent exists while the old one is unproven.
    expect(intentCreate).not.toHaveBeenCalled();
  });

  it("provider create OK + persistence FAILURE: the intent is closed, no secret leaves", async () => {
    offSeasonQuote();
    failCheckoutPersistWrites = true;

    const res = await enroll();

    expect(res.status).toBe(503);
    expect(res.body.clientSecret).toBeUndefined();
    // The fresh intent was closed safely instead of left chargeable, and
    // nothing durable references it.
    expect(intentCancel).toHaveBeenCalledWith("pi_new");
    expect(booking.stripePaymentIntentId ?? null).toBeNull();
  });

  it("persistence failure then RETRY: the idempotency chain replays the dead generation and mints exactly one new intent", async () => {
    offSeasonQuote();
    // A replay-faithful provider: same key ⇒ same intent; cancel marks it.
    const byKey = new Map<
      string,
      { id: string; client_secret: string; status: string; amount: number }
    >();
    let minted = 0;
    intentCreate.mockImplementation(
      async (args: { amount: number }, opts?: { idempotencyKey?: string }) => {
        const key = opts?.idempotencyKey ?? `anon-${minted}`;
        if (!byKey.has(key)) {
          minted++;
          byKey.set(key, {
            id: `pi_${minted}`,
            client_secret: `cs_${minted}`,
            status: "requires_payment_method",
            amount: args.amount,
          });
        }
        return { ...byKey.get(key)! };
      }
    );
    intentCancel.mockImplementation(async (id: string) => {
      for (const intent of byKey.values()) {
        if (intent.id === id) intent.status = "canceled";
      }
      return { id, status: "canceled" };
    });

    // Attempt 1: the fenced persistence fails after pi_1 exists — pi_1 is
    // closed instead of left chargeable.
    failCheckoutPersistWrites = true;
    const first = await enroll();
    failCheckoutPersistWrites = false;
    expect(first.status).toBe(503);

    // Attempt 2: the same first-generation key REPLAYS canceled pi_1; the
    // chain advances deterministically to one fresh pi_2 — never a blind
    // pile of chargeable intents.
    const second = await enroll();

    expect(second.status).toBe(200);
    expect(second.body.clientSecret).toBe("cs_2");
    expect(minted).toBe(2); // pi_1 (dead) + pi_2 — nothing else, ever
    expect(byKey.has("bk-intent-b1-first")).toBe(true);
    expect(byKey.has("bk-intent-b1-pi_1")).toBe(true);
    expect(booking).toMatchObject({
      stripePaymentIntentId: "pi_2",
      tcVersion: BOOKING_TERMS_VERSION,
    });
  });
});

describe("GL-17 corrective — the STANDARD path shares the payable-reuse allowlist", () => {
  it("a canceled same-slot same-amount intent is not handed back — a fresh one replaces it", async () => {
    booking.stripePaymentIntentId = "pi_dead";
    booking.selectedDate = "2026-07-22";
    existingIntent = {
      id: "pi_dead",
      amount: 31300,
      status: "canceled",
      client_secret: "cs_dead",
    };

    const res = await bookIt();

    expect(res.status).toBe(200);
    expect(res.body.clientSecret).toBe("cs_new");
    expect(res.body.clientSecret).not.toBe("cs_dead");
  });
});

describe("GL-17 corrective 3 — lifecycle-fenced checkout on EVERY /book branch", () => {
  const flush = async (rounds = 80) => {
    for (let i = 0; i < rounds; i++) await Promise.resolve();
  };

  it("a webhook flipping QUOTED → PROCESSING mid-attempt is NEVER regressed — truthful 409, our intent closed", async () => {
    // The debit-processing webhook lands between provider work and checkout
    // persistence: the fenced write must lose and the state must stand.
    intentCreate.mockImplementation(async (args: { amount: number }) => {
      booking.status = "PROCESSING"; // the concurrent webhook
      return {
        id: "pi_new",
        client_secret: "cs_new",
        status: "requires_payment_method",
        amount: args.amount,
      };
    });

    const res = await bookIt();

    expect(res.status).toBe(409);
    expect(String(res.body.error)).toContain("still processing");
    expect(res.body.clientSecret).toBeUndefined();
    expect(booking.status).toBe("PROCESSING"); // NOT regressed to QUOTED
    // Our unreferenced intent was closed, not left chargeable.
    expect(intentCancel).toHaveBeenCalledWith("pi_new");
  });

  it("a webhook flipping QUOTED → BOOKED mid-attempt is NEVER regressed — truthful already-paid", async () => {
    intentCreate.mockImplementation(async (args: { amount: number }) => {
      booking.status = "BOOKED"; // finalization completed concurrently
      return {
        id: "pi_new",
        client_secret: "cs_new",
        status: "requires_payment_method",
        amount: args.amount,
      };
    });

    const res = await bookIt();

    expect(res.status).toBe(409);
    expect(String(res.body.error)).toContain("already paid");
    expect(booking.status).toBe("BOOKED");
    expect(intentCancel).toHaveBeenCalledWith("pi_new");
  });

  it("STANDARD fresh-intent persistence failure: no secret, intent closed, capacity claim released", async () => {
    failCheckoutPersistWrites = true;

    const res = await bookIt();

    expect(res.status).toBe(503);
    expect(res.body.clientSecret).toBeUndefined();
    expect(intentCancel).toHaveBeenCalledWith("pi_new");
    // Full compensation: no claim row survives and the slot minutes are back.
    expect(capacityFixture.maps.capacityClaims.size).toBe(0);
    for (const slot of capacityFixture.maps.capacityDays.values()) {
      expect(slot.committedMinutes ?? 0).toBe(0);
    }
    expect(booking.stripePaymentIntentId ?? null).toBeNull();
  });

  it("STANDARD reuse persistence failure: no secret leaves", async () => {
    booking.stripePaymentIntentId = "pi_live";
    booking.selectedDate = "2026-07-22";
    existingIntent = {
      id: "pi_live",
      amount: 31300,
      status: "requires_payment_method",
      client_secret: "cs_live",
    };
    failCheckoutPersistWrites = true;

    const res = await bookIt();

    expect(res.status).toBe(503);
    expect(res.body.clientSecret).toBeUndefined();
  });

  it("STANDARD path: an unprovable prior-intent cancellation blocks any replacement", async () => {
    booking.stripePaymentIntentId = "pi_stuck";
    // Mismatched selection forces replacement; the provider won't confirm
    // the cancel and the re-read still shows it live.
    booking.selectedDate = "2026-07-20";
    existingIntent = {
      id: "pi_stuck",
      amount: 31300,
      status: "requires_payment_method",
      client_secret: "cs_stuck",
    };
    intentCancel.mockImplementation(async () => {
      throw new Error("provider timeout");
    });

    const res = await bookIt();

    expect(res.status).toBe(503);
    expect(String(res.body.error)).toContain("couldn't safely close");
    expect(intentCreate).not.toHaveBeenCalled();
  });

  it("PARALLEL dated requests with different selections: one attempt mutates selection/capacity; one intent exists", async () => {
    let releaseCreate!: () => void;
    const gate = new Promise<void>((resolve) => (releaseCreate = resolve));
    intentCreate.mockImplementation(async (args: { amount: number }) => {
      await gate;
      return {
        id: "pi_new",
        client_secret: "cs_new",
        status: "requires_payment_method",
        amount: args.amount,
      };
    });

    const first = bookIt(); // the winning attempt
    await flush(); // parked inside the provider create, lease held
    expect(intentCreate).toHaveBeenCalledTimes(1);

    const second = await bookIt(); // racing duplicate attempt
    expect(second.status).toBe(409);
    expect(String(second.body.error)).toContain("already being prepared");

    releaseCreate();
    const winner = await first;

    expect(winner.status).toBe(200);
    // Exactly ONE selection mutation, ONE claim, ONE chargeable intent.
    expect(booking.selectedDate).toBe("2026-07-22");
    expect(booking.stripePaymentIntentId).toBe("pi_new");
    expect(intentCreate).toHaveBeenCalledTimes(1);
    expect(capacityFixture.maps.capacityClaims.size).toBe(1);
  });

  it("LEASE-EXPIRY overlap converges on ONE intent and never overwrites the newer attempt", async () => {
    // A replay-faithful provider so the deterministic key makes both
    // attempts converge on the SAME intent.
    const byKey = new Map<
      string,
      { id: string; client_secret: string; status: string; amount: number }
    >();
    let minted = 0;
    const replay = async (
      args: { amount: number },
      opts?: { idempotencyKey?: string }
    ) => {
      const key = opts?.idempotencyKey ?? `anon-${minted}`;
      if (!byKey.has(key)) {
        minted++;
        byKey.set(key, {
          id: `pi_${minted}`,
          client_secret: `cs_${minted}`,
          status: "requires_payment_method",
          amount: args.amount,
        });
      }
      return { ...byKey.get(key)! };
    };
    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => (releaseA = resolve));
    let firstCall = true;
    intentCreate.mockImplementation(async (args, opts) => {
      if (firstCall) {
        firstCall = false;
        await gateA; // attempt A stalls INSIDE provider work past its lease
      }
      return replay(args as { amount: number }, opts);
    });

    const attemptA = bookIt();
    await flush(); // A holds the lease, parked in the gate
    vi.setSystemTime(new Date(Date.now() + 61_000)); // A's lease expires

    const attemptB = await bookIt(); // takes over the expired lease
    expect(attemptB.status).toBe(200);
    expect(attemptB.body.clientSecret).toBe("cs_1"); // the converged intent
    expect(booking.stripePaymentIntentId).toBe("pi_1");

    releaseA();
    const resA = await attemptA;

    // A's fenced write LOST on the holder fence — truthful refusal, and the
    // AUTHORITATIVE converged intent was NOT canceled out from under B.
    expect(resA.status).toBe(409);
    expect(String(resA.body.error)).toContain("finished first");
    expect(intentCancel).not.toHaveBeenCalled();
    expect(minted).toBe(1); // ONE intent, ever
    expect(booking.stripePaymentIntentId).toBe("pi_1");
    expect(booking.status).toBe("QUOTED"); // still payable, never clobbered
  });
});

describe("portal add-service — charge the saved card off-session (trusted internal invoke)", () => {
  const succeededCharge = () =>
    intentCreate.mockImplementation(async (args: { amount: number }) => ({
      id: "pi_saved",
      client_secret: "cs_saved",
      status: "succeeded",
      amount: args.amount,
      amount_received: args.amount,
    }));

  it("charges the card on file and finalizes synchronously — no client secret", async () => {
    booking.leadCustomerId = "cust-1";
    succeededCharge();

    const res = await internalBook("cust-1");

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({ booked: true, amountCents: 31300 });
    expect(res.data.clientSecret).toBeUndefined();
    // Off-session charge on the saved payment method, one time.
    expect(intentCreate).toHaveBeenCalledTimes(1);
    expect(intentCreate.mock.calls[0][0]).toMatchObject({
      amount: 31300,
      customer: "cus_saved",
      payment_method: "pm_card",
      off_session: true,
      confirm: true,
    });
    // finalize ran with the REAL succeeded intent, not the invoice anchor.
    expect(finalizeBookingMock).toHaveBeenCalledTimes(1);
    expect(finalizeBookingMock.mock.calls[0][0]).toMatchObject({
      bookingRequestId: "b1",
      paymentIntentId: "pi_saved",
      amountReceived: 31300,
      paymentMethodId: "pm_card",
    });
  });

  it("refuses a quote that isn't on the caller's account — before any charge", async () => {
    booking.leadCustomerId = "someone-else";
    succeededCharge();

    const res = await internalBook("cust-1");

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(403);
    expect(intentCreate).not.toHaveBeenCalled();
    expect(finalizeBookingMock).not.toHaveBeenCalled();
  });

  it("refuses when there is no saved card — nothing is charged", async () => {
    booking.leadCustomerId = "cust-1";
    savedPaymentMethod = null;

    const res = await internalBook("cust-1");

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(402);
    expect(intentCreate).not.toHaveBeenCalled();
    expect(finalizeBookingMock).not.toHaveBeenCalled();
  });

  it("a declined card books nothing and finalizes nothing", async () => {
    booking.leadCustomerId = "cust-1";
    intentCreate.mockImplementation(async () => {
      const err = new Error("Your card was declined") as Error & { code?: string };
      err.code = "card_declined";
      throw err;
    });

    const res = await internalBook("cust-1");

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(402);
    expect(finalizeBookingMock).not.toHaveBeenCalled();
    // The booking is not advanced to a paid state.
    expect(booking.status).toBe("QUOTED");
  });

  it("a forged internalOp on the PUBLIC Function URL is ignored — normal card checkout, no saved-card charge", async () => {
    // A public POST carries requestContext.http, so the trusted branch is never
    // entered even with an internalOp in the body — it falls through to the
    // ordinary funnel, which returns a client secret for a fresh card.
    const res = await postBook({
      bookingId: "b1",
      date: "2026-07-22",
      tcAccepted: true,
      tcVersion: BOOKING_TERMS_VERSION,
      internalOp: { kind: "BOOK", customerId: "cust-1" },
    });

    expect(res.status).toBe(200);
    expect(res.body.clientSecret).toBe("cs_new");
    // The saved card was never read, and finalize did not run inline.
    expect(customerRetrieve).not.toHaveBeenCalled();
    expect(finalizeBookingMock).not.toHaveBeenCalled();
  });
});
