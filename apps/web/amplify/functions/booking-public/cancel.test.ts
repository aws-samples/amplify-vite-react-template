import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Cancellation: the refund clock and the honest failure.
 *
 * The rule under test is that refundability is judged from when the customer
 * FIRST asked to cancel. Before that, a cancellation that failed on day 4
 * because Stripe was unreachable, and succeeded on retry on day 3, silently
 * cost the customer their full refund for our outage.
 */

type Booking = {
  id: string;
  status: string;
  name: string;
  email: string;
  service: string;
  selectedDate: string;
  selectedWindow: string;
  amountCents: number;
  cancelToken: string;
  customerId?: string | null;
  jobId?: string | null;
  servicePlanId?: string | null;
  stripePaymentIntentId?: string | null;
  cancelRequestedOn?: string | null;
};

let booking: Booking;
const updates: Partial<Booking>[] = [];

const fakeDataClient = {
  models: {
    BookingRequest: {
      listBookingRequestByCancelToken: async () => ({ data: [booking] }),
      update: async (patch: Partial<Booking> & { id: string }) => {
        updates.push(patch);
        booking = { ...booking, ...patch };
        return { data: booking };
      },
    },
    Job: { update: async () => ({ data: null }) },
  },
};
vi.mock("../shared/dataClient", () => ({ dataClient: async () => fakeDataClient }));

const officeEmails: string[] = [];
vi.mock("../shared/email", () => ({
  emailShell: (h: string, b: string) => `${h}${b}`,
  sendEmail: async (o: { subject: string }) => {
    officeEmails.push(o.subject);
    return true;
  },
}));

const cancelPlanBilling = vi.fn(async () => ({
  canceled: true,
  stripeSubscriptionCanceled: true,
}));
vi.mock("../shared/subscription", () => ({
  cancelPlanBilling: (...args: unknown[]) => cancelPlanBilling(...(args as [])),
}));

const refundsCreate = vi.fn(async () => ({ id: "re_1" }));
vi.mock("stripe", () => ({
  default: class {
    refunds = { create: refundsCreate };
  },
}));
vi.mock("@aws-sdk/client-ssm", () => ({
  SSMClient: class {
    async send() {
      return { Parameter: { Value: "sk_test_x" } };
    }
  },
  GetParameterCommand: class {},
}));

const { handler } = await import("./handler");

const call = async (body: unknown) => {
  const res = (await handler({
    headers: {},
    requestContext: { http: { method: "POST", path: "/cancel", sourceIp: "1.2.3.4" } },
    body: JSON.stringify(body),
    isBase64Encoded: false,
  } as never)) as { statusCode: number; body: string };
  return { status: res.statusCode, body: JSON.parse(res.body) };
};

/** Freeze "today" in the shop's timezone. */
const freezeEastern = (isoDate: string) =>
  vi.setSystemTime(new Date(`${isoDate}T12:00:00-04:00`));

beforeEach(() => {
  vi.useFakeTimers();
  // backend.ts injects this into every Lambda that emails; without it the
  // office alert has nowhere to go.
  process.env.SES_NOTIFY_EMAIL = "office@pestbuzzkill.com";
  updates.length = 0;
  officeEmails.length = 0;
  cancelPlanBilling.mockClear();
  refundsCreate.mockClear();
  cancelPlanBilling.mockImplementation(async () => ({
    canceled: true,
    stripeSubscriptionCanceled: true,
  }));
  booking = {
    id: "b1",
    status: "BOOKED",
    name: "Dana Whitlock",
    email: "dana@example.com",
    service: "GENERAL_PEST",
    selectedDate: "2026-07-20",
    selectedWindow: "MORNING",
    amountCents: 29900,
    cancelToken: "tok",
    customerId: "c1",
    jobId: "j1",
    servicePlanId: "p1",
    stripePaymentIntentId: "pi_1",
    cancelRequestedOn: null,
  };
});

afterEach(() => vi.useRealTimers());

describe("cancellation refund window", () => {
  it("refunds a cancellation made more than 3 days out", async () => {
    freezeEastern("2026-07-16"); // 4 days out

    const res = await call({ token: "tok", confirm: true });

    expect(res.body).toMatchObject({ canceled: true, refunded: true });
    expect(refundsCreate).toHaveBeenCalledOnce();
  });

  it("does not refund a cancellation made 3 days out", async () => {
    freezeEastern("2026-07-17"); // exactly 3 days — the policy says no

    const res = await call({ token: "tok", confirm: true });

    expect(res.body).toMatchObject({ canceled: true, refunded: false });
    expect(refundsCreate).not.toHaveBeenCalled();
  });

  it("records the date the customer first asked to cancel", async () => {
    freezeEastern("2026-07-16");

    await call({ token: "tok", confirm: true });

    expect(updates[0]).toMatchObject({ cancelRequestedOn: "2026-07-16" });
  });

  it("honours the first attempt's date when a retry lands inside the no-refund window", async () => {
    // Asked on day 4 (refundable) and it failed; retried on day 2. Our outage
    // must not move their money.
    booking.cancelRequestedOn = "2026-07-16";
    freezeEastern("2026-07-18"); // 2 days out — would be non-refundable today

    const res = await call({ token: "tok", confirm: true });

    expect(res.body).toMatchObject({ canceled: true, refunded: true });
    expect(refundsCreate).toHaveBeenCalledOnce();
  });

  it("does not overwrite the original request date on a retry", async () => {
    booking.cancelRequestedOn = "2026-07-16";
    freezeEastern("2026-07-18");

    await call({ token: "tok", confirm: true });

    expect(
      updates.filter((u) => u.cancelRequestedOn !== undefined)
    ).toHaveLength(0);
  });

  it("quotes the refund from the first attempt in the preview too", async () => {
    booking.cancelRequestedOn = "2026-07-16";
    freezeEastern("2026-07-18");

    const res = await call({ token: "tok" }); // no confirm — preview only

    expect(res.body.refund).toMatchObject({ kind: "FULL", amountCents: 29900 });
    expect(cancelPlanBilling).not.toHaveBeenCalled();
  });
});

describe("cancellation failure", () => {
  beforeEach(() => {
    cancelPlanBilling.mockImplementation(async () => {
      throw new Error("stripe unreachable");
    });
  });

  it("tells the customer the truth instead of 'please try again'", async () => {
    freezeEastern("2026-07-16");

    const res = await call({ token: "tok", confirm: true });

    expect(res.status).toBe(503);
    expect(res.body.error).toContain("(401) 526-0323");
    expect(res.body.error).not.toMatch(/try again/i);
  });

  it("keeps the customer's refund date even though the cancellation failed", async () => {
    freezeEastern("2026-07-16");

    const res = await call({ token: "tok", confirm: true });

    expect(res.body.cancellationRecordedOn).toBe("2026-07-16");
    expect(updates[0]).toMatchObject({ cancelRequestedOn: "2026-07-16" });
  });

  it("pages the office so a human finishes the cancellation", async () => {
    freezeEastern("2026-07-16");

    await call({ token: "tok", confirm: true });

    expect(officeEmails.some((s) => s.includes("ACTION REQUIRED"))).toBe(true);
  });

  it("does not mark the booking canceled or tell the customer it worked", async () => {
    freezeEastern("2026-07-16");

    await call({ token: "tok", confirm: true });

    expect(booking.status).toBe("BOOKED");
    expect(officeEmails).not.toContain("Your BuzzKill appointment is canceled");
  });

  it("never refunds a customer whose plan is still billing", async () => {
    // Cancellation runs before the refund precisely so this cannot happen.
    freezeEastern("2026-07-16");

    await call({ token: "tok", confirm: true });

    expect(refundsCreate).not.toHaveBeenCalled();
  });
});
