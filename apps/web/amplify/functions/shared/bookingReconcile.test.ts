import { describe, expect, it } from "vitest";
import {
  danglingChildRecords,
  mismatchedChildRelationships,
  reconcileBookings,
  type ReconBooking,
  type ReconInvoice,
} from "./bookingReconcile";

/**
 * GL-05 bullet 7: every successful booking payment has exactly one complete
 * booking, and every complete paid booking has exactly one matching payment.
 * These are the reconciliation assertions a launch runs against the real
 * tables; here they run against fixtures.
 */

const bookedBooking = (over: Partial<ReconBooking> = {}): ReconBooking => ({
  id: "b1",
  status: "BOOKED",
  stripePaymentIntentId: "pi_1",
  amountCents: 31300,
  customerId: "cust-1",
  jobId: "job-b1",
  agreementId: "agr-b1",
  ...over,
});

const paidInvoice = (over: Partial<ReconInvoice> = {}): ReconInvoice => ({
  id: "booking-b1",
  status: "PAID",
  stripePaymentIntentId: "pi_1",
  ...over,
});

describe("booking/payment reconciliation", () => {
  it("a healthy set reconciles clean", () => {
    const r = reconcileBookings([bookedBooking()], [paidInvoice()], ["pi_1"]);
    expect(r.ok).toBe(true);
    expect(r.paymentsMissingBooking).toHaveLength(0);
    expect(r.duplicateBookingsForPayment).toHaveLength(0);
    expect(r.incompleteBookedBookings).toHaveLength(0);
    expect(r.duplicatePaidInvoices).toHaveLength(0);
  });

  it("flags a succeeded payment with no complete booking (the stuck-paid case)", () => {
    // The payment succeeded but the booking is still QUOTED — finalization
    // never completed. This is exactly what PAID_NOT_FINALIZED covers.
    const stuck = bookedBooking({ status: "QUOTED", jobId: null, agreementId: null });
    const r = reconcileBookings([stuck], [], ["pi_1"]);
    expect(r.ok).toBe(false);
    expect(r.paymentsMissingBooking).toEqual([{ stripePaymentIntentId: "pi_1" }]);
  });

  it("flags two complete bookings for one payment (a duplicated commitment)", () => {
    const r = reconcileBookings(
      [bookedBooking({ id: "b1" }), bookedBooking({ id: "b2" })],
      [paidInvoice()],
      ["pi_1"]
    );
    expect(r.ok).toBe(false);
    expect(r.duplicateBookingsForPayment).toEqual([
      { stripePaymentIntentId: "pi_1", bookingIds: ["b1", "b2"] },
    ]);
  });

  it("flags a BOOKED booking whose paid invoice is missing from the ledger", () => {
    const r = reconcileBookings([bookedBooking()], [], ["pi_1"]);
    expect(r.ok).toBe(false);
    expect(r.incompleteBookedBookings).toEqual([
      { bookingId: "b1", reason: "BOOKED but missing: paid invoice" },
    ]);
  });

  it("flags a BOOKED booking missing its child records", () => {
    const r = reconcileBookings(
      [bookedBooking({ jobId: null, agreementId: null })],
      [paidInvoice()],
      ["pi_1"]
    );
    expect(r.ok).toBe(false);
    expect(r.incompleteBookedBookings[0].reason).toContain("job");
    expect(r.incompleteBookedBookings[0].reason).toContain("agreement");
  });

  it("flags one payment backing two paid invoices (double-counted money)", () => {
    const r = reconcileBookings(
      [bookedBooking()],
      [paidInvoice({ id: "booking-b1" }), paidInvoice({ id: "dup-inv" })],
      ["pi_1"]
    );
    expect(r.ok).toBe(false);
    expect(r.duplicatePaidInvoices).toEqual([
      { stripePaymentIntentId: "pi_1", invoiceIds: ["booking-b1", "dup-inv"] },
    ]);
  });

  it("a zero-amount booking needs no invoice to be complete", () => {
    const free = bookedBooking({ amountCents: 0, stripePaymentIntentId: null });
    const r = reconcileBookings([free], [], []);
    expect(r.ok).toBe(true);
  });

  it("a canceled booking with a PaymentIntent is not treated as stuck", () => {
    // Payment never succeeded (abandoned/expired), so it is not in the
    // succeeded set — and a CANCELED booking is a resolved outcome.
    const canceled = bookedBooking({ status: "CANCELED" });
    const r = reconcileBookings([canceled], [], []);
    expect(r.ok).toBe(true);
  });

  it("flags a BOOKED booking whose Stripe amount differs from the committed amount", () => {
    const r = reconcileBookings(
      [bookedBooking()],
      [paidInvoice()],
      ["pi_1"],
      { pi_1: 9900 } // Stripe took $99, the booking committed to $313
    );
    expect(r.ok).toBe(false);
    expect(r.amountMismatches).toEqual([
      {
        bookingId: "b1",
        stripePaymentIntentId: "pi_1",
        bookedCents: 31300,
        paidCents: 9900,
      },
    ]);
  });

  it("an exact-amount match reconciles clean", () => {
    const r = reconcileBookings([bookedBooking()], [paidInvoice()], ["pi_1"], {
      pi_1: 31300,
    });
    expect(r.ok).toBe(true);
    expect(r.amountMismatches).toHaveLength(0);
  });
});

describe("dangling checkpoint detection", () => {
  const booked = (over: Partial<ReconBooking> = {}): ReconBooking => ({
    id: "b1",
    status: "BOOKED",
    stripePaymentIntentId: "pi_1",
    amountCents: 31300,
    customerId: "cust-1",
    jobId: "job-b1",
    agreementId: "agr-b1",
    ...over,
  });

  const allExist = {
    customer: true,
    job: true,
    agreement: true,
    paidInvoice: true,
    plan: true,
  };

  it("clean when every referenced record resolves", () => {
    expect(danglingChildRecords(booked(), allExist)).toEqual([]);
  });

  it("a nonblank jobId that no longer resolves is dangling", () => {
    expect(
      danglingChildRecords(booked(), { ...allExist, job: false })
    ).toEqual(["job"]);
  });

  it("a paid booking with no surviving invoice row is dangling", () => {
    expect(
      danglingChildRecords(booked(), { ...allExist, paidInvoice: false })
    ).toContain("paid invoice");
  });

  it("a recurring booking with a missing plan is dangling; a one-time one is not", () => {
    const recurring = booked({ recurring: true, servicePlanId: "plan-b1" });
    expect(
      danglingChildRecords(recurring, { ...allExist, plan: false })
    ).toEqual(["service plan"]);
    const oneTime = booked({ recurring: false });
    expect(
      danglingChildRecords(oneTime, { ...allExist, plan: false })
    ).toEqual([]);
  });

  it("a blank checkpoint id is not counted as dangling here (that is the incomplete check's job)", () => {
    expect(
      danglingChildRecords(booked({ jobId: null }), { ...allExist, job: false })
    ).toEqual([]);
  });
});

describe("GL-05 — relationships, not existence", () => {
  const BOOKING = {
    id: "b1",
    customerId: "c1",
    jobId: "j1",
    amountCents: 31300,
    stripePaymentIntentId: "pi_1",
    selectedDate: "2026-07-25",
    recurring: false,
  };

  it("passes when every child belongs to the booking", () => {
    expect(
      mismatchedChildRelationships(BOOKING, {
        customer: { id: "c1" },
        job: { id: "j1", customerId: "c1", scheduledDate: "2026-07-25" },
        agreement: { id: "a1", customerId: "c1" },
        plan: null,
        paidInvoice: {
          id: "inv1",
          customerId: "c1",
          jobId: "j1",
          amountCents: 31300,
          stripePaymentIntentId: "pi_1",
        },
      })
    ).toEqual([]);
  });

  it("flags a job cross-linked to another customer even though it EXISTS", () => {
    const bad = mismatchedChildRelationships(BOOKING, {
      customer: { id: "c1" },
      job: { id: "j1", customerId: "c-OTHER", scheduledDate: "2026-07-25" },
      agreement: null,
      plan: null,
      paidInvoice: null,
    });
    expect(bad.join(" ")).toMatch(/job belongs to customer c-OTHER/);
  });

  it("flags a paid invoice that belongs to a different job or amount", () => {
    const bad = mismatchedChildRelationships(BOOKING, {
      customer: null,
      job: null,
      agreement: null,
      plan: null,
      paidInvoice: {
        id: "inv1",
        customerId: "c1",
        jobId: "j-OTHER",
        amountCents: 100,
        stripePaymentIntentId: "pi_1",
      },
    });
    expect(bad.join(" ")).toMatch(/attached to job j-OTHER/);
    expect(bad.join(" ")).toMatch(/\$1\.00.*\$313\.00/);
  });

  it("skips comparisons for fields the loaded row does not carry", () => {
    expect(
      mismatchedChildRelationships(BOOKING, {
        customer: { id: "c1" },
        job: { id: "j1" },
        agreement: { id: "a1" },
        plan: null,
        paidInvoice: null,
      })
    ).toEqual([]);
  });
});
