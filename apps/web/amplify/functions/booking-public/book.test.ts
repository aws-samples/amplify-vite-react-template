import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
let stopsOnDay: Stop[];
const bookingUpdates: Record<string, unknown>[] = [];

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
      list: async () => ({ data: [{ id: "t1", active: true }] }),
    },
    Job: {
      listJobByScheduledDate: async () => ({ data: stopsOnDay }),
    },
    Customer: {
      get: async ({ id }: { id: string }) => ({
        data: {
          id,
          serviceStreet: "9 Elm St",
          serviceCity: "Ware",
          serviceState: "MA",
          serviceZip: "01082",
        },
      }),
    },
  },
};
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
const intentCreate = vi.fn(async (args: { amount: number }) => ({
  id: "pi_new",
  client_secret: "cs_new",
  status: "requires_payment_method",
  amount: args.amount,
}));
const intentRetrieve = vi.fn(async () => existingIntent);
const intentCancel = vi.fn(async () => ({}));
vi.mock("stripe", () => ({
  default: class {
    paymentIntents = {
      create: intentCreate,
      retrieve: intentRetrieve,
      cancel: intentCancel,
    };
    customers = { create: async () => ({ id: "cus_1" }) };
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
  windows: ["MORNING", "AFTERNOON"],
  priceCents: 31300, // deliberately NOT what a live repricing would produce
  factors: [],
};

const gpcStop = (n: number): Stop => ({
  customerId: `c${n}`,
  serviceType: "GENERAL_PEST",
  status: "SCHEDULED",
});

beforeEach(() => {
  vi.useFakeTimers();
  freezeEastern("2026-07-16");
  bookingUpdates.length = 0;
  stopsOnDay = [];
  existingIntent = null;
  intentCreate.mockClear();
  intentRetrieve.mockClear();
  intentCancel.mockClear();
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
    selectedWindow: null,
  };
});

afterEach(() => vi.useRealTimers());

const bookIt = (overrides: Record<string, unknown> = {}) =>
  postBook({
    bookingId: "b1",
    date: "2026-07-22",
    window: "MORNING",
    tcAccepted: true,
    tcVersion: BOOKING_TERMS_VERSION,
    ...overrides,
  });

describe("booking re-checks live availability (R29)", () => {
  it("books when the day is still live — at the quoted price, not a reprice", async () => {
    const res = await bookIt();

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ clientSecret: "cs_new", amountCents: 31300 });
    expect(intentCreate).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 31300 })
    );
    expect(bookingUpdates[0]).toMatchObject({
      selectedDate: "2026-07-22",
      selectedWindow: "MORNING",
      stripePaymentIntentId: "pi_new",
    });
  });

  it("refuses when the day filled up after the quote", async () => {
    stopsOnDay = Array.from({ length: 8 }, (_, i) => gpcStop(i)); // at capacity

    const res = await bookIt();

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no longer available/i);
    expect(intentCreate).not.toHaveBeenCalled();
  });

  it("refuses when the day no longer fits the route minutes", async () => {
    // 7 stops leave stop-count headroom, but 7×(90+20) + 90 onsite + insertion
    // overruns the 480-minute workday — the feasibility block must hold.
    stopsOnDay = Array.from({ length: 7 }, (_, i) => gpcStop(i));

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
    stopsOnDay = Array.from({ length: 8 }, (_, i) => gpcStop(i));

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
      expect.objectContaining({ amount: 28800 })
    );
    expect(bookingUpdates[0]).toMatchObject({
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
    expect(bookingUpdates[0]).toMatchObject({
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
