/**
 * GL-05 reconciliation — pure predicates over booking + invoice rows, so
 * "every successful booking payment has exactly one complete booking, and every
 * complete paid booking has exactly one matching payment" is provable without a
 * browser or a live Stripe call. A launch reconciliation feeds these the real
 * tables (and the set of PaymentIntents Stripe reports as succeeded); the unit
 * test feeds them fixtures. Keeping the logic here, pure, is what lets the same
 * rule be asserted in CI and run in production.
 */

export type ReconBooking = {
  id: string;
  status?: string | null;
  stripePaymentIntentId?: string | null;
  amountCents?: number | null;
  customerId?: string | null;
  jobId?: string | null;
  agreementId?: string | null;
};

export type ReconInvoice = {
  id: string;
  status?: string | null;
  stripePaymentIntentId?: string | null;
};

export type BookingAnomaly = { bookingId: string; reason: string };

export type BookingReconciliation = {
  /** A payment Stripe reports succeeded, with no BOOKED booking behind it —
   *  money taken with nothing delivered. Each should have an open
   *  PAID_NOT_FINALIZED exception. */
  paymentsMissingBooking: { stripePaymentIntentId: string }[];
  /** One succeeded payment tied to more than one BOOKED booking — a duplicate
   *  commitment from a non-idempotent retry. Must be empty. */
  duplicateBookingsForPayment: {
    stripePaymentIntentId: string;
    bookingIds: string[];
  }[];
  /** A booking marked BOOKED whose required records don't all exist. */
  incompleteBookedBookings: BookingAnomaly[];
  /** One PaymentIntent backing more than one PAID invoice — double-counted
   *  money. Must be empty. */
  duplicatePaidInvoices: {
    stripePaymentIntentId: string;
    invoiceIds: string[];
  }[];
  ok: boolean;
};

function pushInto<T>(map: Map<string, T[]>, key: string, value: T): void {
  const arr = map.get(key);
  if (arr) arr.push(value);
  else map.set(key, [value]);
}

export function reconcileBookings(
  bookings: ReconBooking[],
  invoices: ReconInvoice[],
  succeededPaymentIntentIds: string[]
): BookingReconciliation {
  const bookedByPi = new Map<string, ReconBooking[]>();
  for (const b of bookings) {
    const pi = b.stripePaymentIntentId?.trim();
    if (pi && b.status === "BOOKED") pushInto(bookedByPi, pi, b);
  }

  const paidInvoiceByPi = new Map<string, string[]>();
  for (const inv of invoices) {
    const pi = inv.stripePaymentIntentId?.trim();
    if (pi && inv.status === "PAID") pushInto(paidInvoiceByPi, pi, inv.id);
  }

  const paymentsMissingBooking: { stripePaymentIntentId: string }[] = [];
  const duplicateBookingsForPayment: {
    stripePaymentIntentId: string;
    bookingIds: string[];
  }[] = [];
  const seen = new Set<string>();
  for (const raw of succeededPaymentIntentIds) {
    const pi = raw.trim();
    if (!pi || seen.has(pi)) continue;
    seen.add(pi);
    const booked = bookedByPi.get(pi) ?? [];
    if (booked.length === 0) {
      paymentsMissingBooking.push({ stripePaymentIntentId: pi });
    } else if (booked.length > 1) {
      duplicateBookingsForPayment.push({
        stripePaymentIntentId: pi,
        bookingIds: booked.map((b) => b.id),
      });
    }
  }

  const incompleteBookedBookings: BookingAnomaly[] = [];
  for (const b of bookings) {
    if (b.status !== "BOOKED") continue;
    const missing: string[] = [];
    if (!b.customerId) missing.push("customer");
    if (!b.jobId) missing.push("job");
    if (!b.agreementId) missing.push("agreement");
    const pi = b.stripePaymentIntentId?.trim();
    if ((b.amountCents ?? 0) > 0 && (!pi || !(paidInvoiceByPi.get(pi)?.length))) {
      missing.push("paid invoice");
    }
    if (missing.length) {
      incompleteBookedBookings.push({
        bookingId: b.id,
        reason: `BOOKED but missing: ${missing.join(", ")}`,
      });
    }
  }

  const duplicatePaidInvoices = [...paidInvoiceByPi.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([stripePaymentIntentId, invoiceIds]) => ({
      stripePaymentIntentId,
      invoiceIds,
    }));

  const ok =
    paymentsMissingBooking.length === 0 &&
    duplicateBookingsForPayment.length === 0 &&
    incompleteBookedBookings.length === 0 &&
    duplicatePaidInvoices.length === 0;

  return {
    paymentsMissingBooking,
    duplicateBookingsForPayment,
    incompleteBookedBookings,
    duplicatePaidInvoices,
    ok,
  };
}
