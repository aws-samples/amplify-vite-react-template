import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _setLockStoreForTests, memoryLockStore } from "../shared/atomicLock";

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
  cancelRequestedAt?: string | null;
};

let booking: Booking;
const updates: Partial<Booking>[] = [];

/** What Amplify's update actually resolves: data OR errors, and it can throw. */
type UpdateResult = { data: Booking | null; errors?: { message: string }[] };
type UpdateFn = (patch: Partial<Booking> & { id: string }) => Promise<UpdateResult>;

const fakeDataClient: {
  models: {
    BookingRequest: {
      listBookingRequestByCancelToken: () => Promise<{ data: Booking[] }>;
      update: UpdateFn;
    };
    Job: {
      update: () => Promise<{ data: null }>;
      get: () => Promise<{ data: null }>;
    };
  };
} = {
  models: {
    BookingRequest: {
      listBookingRequestByCancelToken: async () => ({ data: [booking] }),
      update: async (patch: Partial<Booking> & { id: string }) => {
        updates.push(patch);
        booking = { ...booking, ...patch };
        return { data: booking };
      },
    },
    // No job row behind these bookings: the guarded cancel path re-reads the
    // job first and skips cleanly when there is nothing to cancel.
    Job: {
      update: async () => ({ data: null }),
      get: async () => ({ data: null }),
    },
  },
};
vi.mock("../shared/dataClient", () => ({ dataClient: async () => fakeDataClient }));

const customerEmails: string[] = [];
const officeEmails: { subject: string; bodyHtml: string }[] = [];
vi.mock("../shared/email", () => ({
  emailShell: (h: string, b: string) => `${h}${b}`,
  sendEmail: async (o: { subject: string }) => {
    customerEmails.push(o.subject);
    return true;
  },
  notifyOffice: async (o: { subject: string; bodyHtml: string }) => {
    officeEmails.push(o);
    return true;
  },
}));

const workOpened: { kind: string; relatedId: string; resolutionAction: string }[] = [];
vi.mock("../shared/ownedWork", () => ({
  openOwnedWork: async (work: {
    kind: string;
    relatedId: string;
    resolutionAction: string;
  }) => {
    workOpened.push(work);
    return "work-cancel";
  },
}));

// GL-08: the public cancel link goes through the SAME durable plan-cancel
// command as the portal (cancelPlanForCustomer), never the bare engine.
const cancelPlanBilling = vi.fn(async () => ({
  status: "CANCELED",
  alreadyCanceled: false,
  stripeSubscriptionCanceled: true,
  visitsStopped: 0,
  visitsRemaining: 0,
  confirmationEmailed: true,
  settled: true,
  message: "canceled",
}));
vi.mock("../shared/planCancellation", () => ({
  cancelPlanForCustomer: (...args: unknown[]) => cancelPlanBilling(...(args as [])),
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

const workingUpdate: UpdateFn = async (patch) => {
  updates.push(patch);
  booking = { ...booking, ...patch };
  return { data: booking };
};

beforeEach(() => {
  vi.useFakeTimers();
  fakeDataClient.models.BookingRequest.update = workingUpdate;
  // backend.ts injects this into every Lambda that emails; without it the
  // office alert has nowhere to go.
  process.env.SES_NOTIFY_EMAIL = "office@pestbuzzkill.com";
  updates.length = 0;
  officeEmails.length = 0;
  customerEmails.length = 0;
  workOpened.length = 0;
  cancelPlanBilling.mockClear();
  refundsCreate.mockClear();
  cancelPlanBilling.mockImplementation(async () => ({
    status: "CANCELED",
    alreadyCanceled: false,
    stripeSubscriptionCanceled: true,
    visitsStopped: 0,
    visitsRemaining: 0,
    confirmationEmailed: true,
    settled: true,
    message: "canceled",
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
    cancelRequestedAt: null,
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

  it("honours the first attempt's instant when a retry lands inside the no-refund window", async () => {
    // Asked on day 4 (refundable) and it failed; retried on day 2. Our outage
    // must not move their money — the persisted instant is authoritative.
    booking.cancelRequestedAt = "2026-07-16T12:00:00-04:00";
    booking.cancelRequestedOn = "2026-07-16";
    freezeEastern("2026-07-18"); // 2 days out — would be non-refundable today

    const res = await call({ token: "tok", confirm: true });

    expect(res.body).toMatchObject({ canceled: true, refunded: true });
    expect(refundsCreate).toHaveBeenCalledOnce();
  });

  it("backfills the instant for a legacy row that has only the date, keeping the refund", async () => {
    // A first attempt that failed BEFORE this field existed left only the date.
    // The instant is derived from the earliest moment of that Eastern day —
    // never later than the true first attempt, so the refund can only be kept.
    booking.cancelRequestedOn = "2026-07-16";
    booking.cancelRequestedAt = null;
    freezeEastern("2026-07-18");

    const res = await call({ token: "tok", confirm: true });

    expect(res.body).toMatchObject({ canceled: true, refunded: true });
    const stamped = updates.find((u) => u.cancelRequestedAt)?.cancelRequestedAt;
    expect(stamped).toBeTruthy();
    // Backfilled to Eastern midnight of the recorded date, not "now".
    expect(Date.parse(stamped as string)).toBe(
      Date.parse("2026-07-16T00:00:00-04:00")
    );
    // The original calendar date is preserved, never re-dated forward.
    const dateWrite = updates.find((u) => u.cancelRequestedOn !== undefined);
    expect(dateWrite?.cancelRequestedOn).toBe("2026-07-16");
  });

  it("does not re-stamp a booking whose instant is already recorded", async () => {
    booking.cancelRequestedAt = "2026-07-16T12:00:00-04:00";
    booking.cancelRequestedOn = "2026-07-16";
    freezeEastern("2026-07-18");

    await call({ token: "tok", confirm: true });

    expect(
      updates.filter(
        (u) => u.cancelRequestedAt !== undefined || u.cancelRequestedOn !== undefined
      )
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

describe("GL-08 — hour-exact 72-hour enforcement (matches the customer copy)", () => {
  // Visit Monday 2026-07-20, MORNING window → 8:00 AM ET start. The 72-hour
  // line therefore falls on Friday 8:00 AM ET — a boundary the whole-calendar-
  // day rule could NEVER see: Monday − Friday is 3 calendar days, so the old
  // `daysOut > 3` check refused every Friday cancel regardless of the hour.

  it("refunds a cancel 73 hours out (Friday 7am) — which the day-based rule wrongly refused", async () => {
    vi.setSystemTime(new Date("2026-07-17T07:00:00-04:00")); // 73h before Mon 8am

    const res = await call({ token: "tok", confirm: true });

    expect(res.body).toMatchObject({ canceled: true, refunded: true });
    expect(refundsCreate).toHaveBeenCalledOnce();
  });

  it("refuses a cancel 71 hours out (Friday 9am) — exactly the same weekend, one boundary crossed", async () => {
    vi.setSystemTime(new Date("2026-07-17T09:00:00-04:00")); // 71h before Mon 8am

    const res = await call({ token: "tok", confirm: true });

    expect(res.body).toMatchObject({ canceled: true, refunded: false });
    expect(refundsCreate).not.toHaveBeenCalled();
  });

  it("persists the exact cancel instant so a later retry judges the same boundary", async () => {
    vi.setSystemTime(new Date("2026-07-17T07:00:00-04:00"));

    await call({ token: "tok", confirm: true });

    const stamp = updates.find((u) => u.cancelRequestedAt)?.cancelRequestedAt;
    expect(stamp).toBeTruthy();
    expect(Date.parse(stamp as string)).toBe(
      Date.parse("2026-07-17T07:00:00-04:00")
    );
  });

  it("judges an afternoon visit from its 12pm start, matching the job's stored label", async () => {
    // AFTERNOON maps to "afternoon (12pm–5pm)" — a noon start. The 72-hour line
    // is Friday 12pm; at Friday 11am we are 73h out. Judged from the raw
    // "AFTERNOON" enum (no parseable hour) it would default to an 8am start and
    // wrongly refuse — this proves the public path shares the office start hour.
    booking.selectedWindow = "AFTERNOON";
    vi.setSystemTime(new Date("2026-07-17T11:00:00-04:00")); // 73h before Mon 12pm

    const res = await call({ token: "tok", confirm: true });

    expect(res.body).toMatchObject({ canceled: true, refunded: true });
    expect(refundsCreate).toHaveBeenCalledOnce();
  });
});

describe("when the cancellation date cannot be recorded", () => {
  // The write that protects the refund is itself a write that can fail. Left
  // unguarded it fell through to the generic 500 "please try again" — no date,
  // no alert, and the day-three retry loses the refund.
  // Fail ONLY the date write — a conditional-check or throttle on that call —
  // and let the rest of the flow work. A total DynamoDB outage is a different
  // scenario: then the cancellation genuinely cannot complete and a 500 is honest.
  const breakDateWrite = () => {
    fakeDataClient.models.BookingRequest.update = async (patch) =>
      patch.cancelRequestedOn
        ? { data: null, errors: [{ message: "conditional check failed" }] }
        : workingUpdate(patch);
  };

  // Amplify resolves most errors, but a network fault throws. Both shapes have
  // to be handled: an unguarded throw here reaches the outer catch and returns
  // the generic "please try again", losing the date and the alert with it.
  const throwOnDateWrite = () => {
    fakeDataClient.models.BookingRequest.update = async (patch) => {
      if (patch.cancelRequestedOn) throw new Error("DynamoDB unreachable");
      return workingUpdate(patch);
    };
  };

  it("still cancels — today's refund decision does not depend on the write", async () => {
    freezeEastern("2026-07-16");
    breakDateWrite();

    const res = await call({ token: "tok", confirm: true });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ canceled: true, refunded: true });
  });

  it("still cancels when the write throws rather than resolving an error", async () => {
    freezeEastern("2026-07-16");
    throwOnDateWrite();

    const res = await call({ token: "tok", confirm: true });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ canceled: true, refunded: true });
    expect(refundsCreate).toHaveBeenCalledOnce();
  });

  it("a throwing write never becomes the generic 'please try again'", async () => {
    freezeEastern("2026-07-16");
    throwOnDateWrite();
    cancelPlanBilling.mockImplementation(async () => {
      throw new Error("stripe unreachable");
    });

    const res = await call({ token: "tok", confirm: true });

    expect(res.status).toBe(503);
    expect(res.body.error).not.toMatch(/try again/i);
    expect(officeEmails.some((e) => e.subject.includes("ACTION REQUIRED"))).toBe(true);
  });

  it("does not fall through to the generic 'please try again'", async () => {
    freezeEastern("2026-07-16");
    breakDateWrite();
    cancelPlanBilling.mockImplementation(async () => {
      throw new Error("stripe unreachable");
    });

    const res = await call({ token: "tok", confirm: true });

    expect(res.status).toBe(503);
    expect(res.body.error).not.toMatch(/try again/i);
  });

  it("tells the office the date was not saved and points it to owned work", async () => {
    freezeEastern("2026-07-16");
    breakDateWrite();
    cancelPlanBilling.mockImplementation(async () => {
      throw new Error("stripe unreachable");
    });

    await call({ token: "tok", confirm: true });

    expect(officeEmails).toHaveLength(1);
    expect(officeEmails[0].bodyHtml).toContain("not saved on the booking");
    expect(officeEmails[0].bodyHtml).toContain("owned cancellation work item");
    expect(officeEmails[0].bodyHtml).toContain("2026-07-16");
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
    expect(res.body.error).toContain("(508) 258-9294");
    expect(res.body.error).not.toMatch(/try again/i);
  });

  it("keeps the customer's refund date even though the cancellation failed", async () => {
    freezeEastern("2026-07-16");

    const res = await call({ token: "tok", confirm: true });

    expect(res.body.cancellationRecordedOn).toBe("2026-07-16");
    expect(updates[0]).toMatchObject({ cancelRequestedOn: "2026-07-16" });
  });

  it("creates owned work and pages the office so a human finishes the cancellation", async () => {
    freezeEastern("2026-07-16");

    await call({ token: "tok", confirm: true });

    expect(officeEmails.some((e) => e.subject.includes("ACTION REQUIRED"))).toBe(true);
    expect(workOpened).toContainEqual(
      expect.objectContaining({
        kind: "PAID_VISIT_CANCELLATION",
        relatedId: "b1",
      })
    );
  });

  it("does not mark the booking canceled or tell the customer it worked", async () => {
    freezeEastern("2026-07-16");

    await call({ token: "tok", confirm: true });

    expect(booking.status).toBe("BOOKED");
    expect(customerEmails).not.toContain("Your BuzzKill appointment is canceled");
  });

  it("never refunds a customer whose plan is still billing", async () => {
    // Cancellation runs before the refund precisely so this cannot happen.
    freezeEastern("2026-07-16");

    await call({ token: "tok", confirm: true });

    expect(refundsCreate).not.toHaveBeenCalled();
  });
});

describe("GL-06 — canceling a pending-debit booking (commitment exists, money still clearing)", () => {
  const invoiceTable = new Map<string, Record<string, unknown>>();

  beforeEach(() => {
    invoiceTable.clear();
    invoiceTable.set("booking-b1", {
      id: "booking-b1",
      status: "OPEN",
      pendingDebitIntentId: "pi_1",
      amountCents: 29900,
    });
    _setLockStoreForTests(memoryLockStore({ Invoice: invoiceTable }));
    booking.status = "PROCESSING"; // debit clearing; jobId j1 = real commitment
  });

  afterEach(() => _setLockStoreForTests(null));

  it("previews the same 72-hour policy with honest pending wording", async () => {
    freezeEastern("2026-07-16"); // 4 days out — refundable
    const res = await call({ token: "tok" });

    expect(res.status).toBe(200);
    expect(res.body.refund).toMatchObject({ kind: "FULL", amountCents: 29900 });
    expect(res.body.policy).toContain("still processing");
  });

  it("a refundable cancel queues the refund to the original method and voids the pending invoice", async () => {
    freezeEastern("2026-07-16"); // 4 days out
    const res = await call({ token: "tok", confirm: true });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ canceled: true, refunded: true });
    // Stripe queues the refund and completes it after the debit settles —
    // refund-to-original-method either way, issued exactly once.
    expect(refundsCreate).toHaveBeenCalledOnce();
    expect(booking.status).toBe("CANCELED");
    const invoice = invoiceTable.get("booking-b1")!;
    expect(invoice.status).toBe("VOID"); // debit + queued refund net to zero
    expect(invoice.pendingDebitIntentId).toBeUndefined();
    expect(customerEmails.some((s) => s.includes("canceled"))).toBe(true);
  });

  it("a nonrefundable cancel keeps the OPEN invoice — the settling debit pays what is genuinely owed", async () => {
    freezeEastern("2026-07-19"); // 1 day out — inside the window
    const res = await call({ token: "tok", confirm: true });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ canceled: true, refunded: false });
    expect(refundsCreate).not.toHaveBeenCalled();
    expect(booking.status).toBe("CANCELED");
    const invoice = invoiceTable.get("booking-b1")!;
    expect(invoice.status).toBe("OPEN");
    expect(invoice.pendingDebitIntentId).toBe("pi_1");
  });

  it("a PROCESSING booking with no commitment yet is not cancelable from the link", async () => {
    booking.jobId = null;
    freezeEastern("2026-07-16");

    const res = await call({ token: "tok", confirm: true });

    expect(res.status).toBe(404);
  });
});
