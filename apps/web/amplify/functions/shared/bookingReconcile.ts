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
  recurring?: boolean | null;
  servicePlanId?: string | null;
  name?: string | null;
  email?: string | null;
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
  /** A BOOKED booking whose Stripe payment succeeded for a different amount than
   *  the booking committed to — money and commitment disagree. Only populated
   *  when Stripe amounts are supplied. */
  amountMismatches: {
    bookingId: string;
    stripePaymentIntentId: string;
    bookedCents: number;
    paidCents: number;
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
  succeededPaymentIntentIds: string[],
  /** PaymentIntent id -> amount_received (cents), when Stripe amounts are
   *  available. Enables the exact-amount check demanded by GL-05 ("one
   *  succeeded payment for the exact amount"). */
  paidCentsByPi?: Record<string, number>
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

  const amountMismatches: BookingReconciliation["amountMismatches"] = [];
  if (paidCentsByPi) {
    for (const b of bookings) {
      if (b.status !== "BOOKED") continue;
      const pi = b.stripePaymentIntentId?.trim();
      const bookedCents = b.amountCents ?? 0;
      if (!pi || bookedCents <= 0) continue;
      const paidCents = paidCentsByPi[pi];
      // Only compare when Stripe actually reported this PI as succeeded with an
      // amount — a PI absent from the succeeded set is a different anomaly
      // (paymentsMissingBooking / incomplete), not an amount disagreement.
      if (typeof paidCents === "number" && paidCents !== bookedCents) {
        amountMismatches.push({
          bookingId: b.id,
          stripePaymentIntentId: pi,
          bookedCents,
          paidCents,
        });
      }
    }
  }

  const ok =
    paymentsMissingBooking.length === 0 &&
    duplicateBookingsForPayment.length === 0 &&
    incompleteBookedBookings.length === 0 &&
    duplicatePaidInvoices.length === 0 &&
    amountMismatches.length === 0;

  return {
    paymentsMissingBooking,
    duplicateBookingsForPayment,
    incompleteBookedBookings,
    duplicatePaidInvoices,
    amountMismatches,
    ok,
  };
}

/** Whether each child record a BOOKED booking's checkpoint IDs point at. */
export type ChildExistence = {
  customer: boolean;
  job: boolean;
  agreement: boolean;
  paidInvoice: boolean;
  plan: boolean;
};

/**
 * The child records a BOOKED booking claims (via nonblank checkpoint IDs) but
 * that no longer resolve to a real row — a "dangling checkpoint". A nonblank
 * BookingRequest.jobId is not proof the Job still exists; reconciliation must
 * load it and check. Pure so it can be unit-tested against fixtures; the caller
 * supplies the existence lookups it did against the live tables.
 */
export function danglingChildRecords(
  booking: ReconBooking,
  exists: ChildExistence
): string[] {
  const missing: string[] = [];
  if (booking.customerId && !exists.customer) missing.push("customer");
  if (booking.jobId && !exists.job) missing.push("job");
  if (booking.agreementId && !exists.agreement) missing.push("agreement");
  if ((booking.amountCents ?? 0) > 0 && !exists.paidInvoice) {
    missing.push("paid invoice");
  }
  if (booking.recurring && booking.servicePlanId && !exists.plan) {
    missing.push("service plan");
  }
  return missing;
}
