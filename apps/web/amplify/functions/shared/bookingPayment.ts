import { casGuardedUpdate, type LockCondition } from "./atomicLock";
import { dataClient } from "./dataClient";

/**
 * GL-06 — the ONE conditional state machine for a booking's payment states.
 *
 * Every processing/success/failure webhook, sweep, and retry endpoint moves a
 * BookingRequest through these helpers, never a bare status write. Each
 * transition is a guarded CAS conditioned on BOTH the allowed prior states
 * AND the payment attempt it belongs to (stripePaymentIntentId), so:
 *  - duplicate or replayed events collapse (the second write LOSES);
 *  - a stale processing/failure event for an OLD attempt cannot touch a
 *    booking that moved on to a new intent;
 *  - out-of-order delivery cannot regress BOOKED (success is terminal for
 *    payment events) or overwrite a later business decision (CANCELED and
 *    EXPIRED are never in any allowed-prior list).
 *
 * A LOST transition is a fact, not an error: the caller decides whether it
 * means "already applied" (ack the webhook) or "state moved on" (do nothing).
 * UNSUPPORTED (no CAS wiring) is a refusal the caller must surface — a
 * payment event must never be acknowledged on a write that did not happen.
 */

export type BookingTransition =
  | { ok: true }
  | { ok: false; reason: "LOST" | "UNSUPPORTED" };

/** GL-17 — the ONLY PaymentIntent statuses a /book retry may hand back as a
 *  fresh payable secret. Everything else — canceled, succeeded, processing,
 *  requires_capture — is either terminal, in flight, or not payable, and is
 *  answered truthfully instead of returned as chargeable. */
export const PAYABLE_REUSE_STATUSES: ReadonlySet<string> = new Set([
  "requires_payment_method",
  "requires_confirmation",
  "requires_action",
]);

export const PAYMENT_ATTEMPT_LEASE_MS = 30_000;

export type PaymentAttempt =
  | { ok: true; release: () => Promise<void> }
  | { ok: false; unavailable: boolean };

/**
 * GL-17 — the durable single-winner checkout-attempt claim: one guarded CAS
 * write on the BookingRequest row (a not-live-lease condition, backend-only).
 * Parallel double-clicks: exactly one attempt proceeds; the loser is told to
 * retry in a moment. A crashed winner's claim expires on its own. This
 * serializes ATTEMPTS; the invariant "one chargeable intent per booking" is
 * carried by the deterministic provider idempotency keys and the
 * persist-before-secret rule, so even a lease-expiry overlap converges.
 */
export async function acquirePaymentAttempt(
  bookingId: string
): Promise<PaymentAttempt> {
  const nowIso = new Date().toISOString();
  const until = new Date(Date.now() + PAYMENT_ATTEMPT_LEASE_MS).toISOString();
  const res = await casGuardedUpdate(
    "BookingRequest",
    bookingId,
    { paymentAttemptLeaseUntil: until },
    [{ kind: "notLiveLease", field: "paymentAttemptLeaseUntil", nowIso }]
  );
  if (!res.ok) return { ok: false, unavailable: res.reason === "UNSUPPORTED" };
  return {
    ok: true,
    release: async () => {
      // Only THIS holder releases — a later winner's lease is never cleared.
      await casGuardedUpdate(
        "BookingRequest",
        bookingId,
        { paymentAttemptLeaseUntil: null },
        [
          {
            kind: "fieldEquals",
            field: "paymentAttemptLeaseUntil",
            value: until,
          },
        ]
      ).catch(() => undefined);
    },
  };
}

const attemptGuard = (intentId: string | null): LockCondition[] =>
  intentId
    ? [{ kind: "fieldEquals", field: "stripePaymentIntentId", value: intentId }]
    : [];

/** QUOTED → PROCESSING for THIS attempt, stamping the durable processing
 *  facts. Late events (already PROCESSING/BOOKED/FAILED) lose harmlessly. */
export async function bookingToProcessing(opts: {
  bookingId: string;
  intentId: string;
  methodLabel?: string | null;
  /** Business days a bank debit is expected to take — sets expectedBy. */
  expectedBusinessDays?: number;
}): Promise<BookingTransition> {
  const now = new Date();
  const expected = new Date(now);
  // Calendar-days approximation of N business days (weekends skipped).
  let remaining = opts.expectedBusinessDays ?? 5;
  while (remaining > 0) {
    expected.setUTCDate(expected.getUTCDate() + 1);
    if (expected.getUTCDay() !== 0 && expected.getUTCDay() !== 6) remaining--;
  }
  const res = await casGuardedUpdate(
    "BookingRequest",
    opts.bookingId,
    {
      status: "PROCESSING",
      processingStartedAt: now.toISOString(),
      // The sweep re-reads Stripe well before the expected date.
      processingNextCheckAt: new Date(
        now.getTime() + 6 * 60 * 60_000
      ).toISOString(),
      processingExpectedBy: expected.toISOString().slice(0, 10),
      processingMethodLabel: opts.methodLabel ?? null,
    },
    [
      { kind: "fieldEquals", field: "status", value: "QUOTED" },
      ...attemptGuard(opts.intentId),
    ]
  );
  return res.ok ? { ok: true } : res;
}

/** QUOTED|PROCESSING → BOOKED. Success is terminal for payment events. */
export async function bookingToBooked(opts: {
  bookingId: string;
  intentId?: string | null;
}): Promise<BookingTransition> {
  const res = await casGuardedUpdate(
    "BookingRequest",
    opts.bookingId,
    {
      status: "BOOKED",
      processingNextCheckAt: null,
    },
    [
      { kind: "fieldIn", field: "status", values: ["QUOTED", "PROCESSING"] },
      ...attemptGuard(opts.intentId ?? null),
    ]
  );
  return res.ok ? { ok: true } : res;
}

/** QUOTED|PROCESSING → PAYMENT_FAILED for THIS attempt. A failure event for
 *  a superseded attempt, or one arriving after success, loses. */
export async function bookingToPaymentFailed(opts: {
  bookingId: string;
  intentId: string;
  reason: string;
}): Promise<BookingTransition> {
  const res = await casGuardedUpdate(
    "BookingRequest",
    opts.bookingId,
    {
      status: "PAYMENT_FAILED",
      paymentFailedReason: opts.reason,
      processingNextCheckAt: null,
    },
    [
      { kind: "fieldIn", field: "status", values: ["QUOTED", "PROCESSING"] },
      ...attemptGuard(opts.intentId),
    ]
  );
  return res.ok ? { ok: true } : res;
}

/** Atomically claim the one failed-payment notice for a booking — a replayed
 *  failure webhook cannot email twice, because only the marker's winner
 *  sends. UNSUPPORTED sends anyway: a duplicate email is recoverable, a
 *  missing "your booking didn't go through" is a customer left waiting. */
export async function claimPaymentFailedNotice(
  bookingId: string
): Promise<boolean> {
  const res = await casGuardedUpdate(
    "BookingRequest",
    bookingId,
    { paymentFailedNoticeSentAt: new Date().toISOString() },
    [{ kind: "fieldMissingOrNull", field: "paymentFailedNoticeSentAt" }]
  );
  return res.ok || res.reason === "UNSUPPORTED";
}

/** The processing sweep's pacing stamp — plain guarded write keyed to the
 *  booking still being PROCESSING so a settled booking is never re-stamped. */
export async function stampProcessingNextCheck(
  bookingId: string,
  nextCheckAt: string
): Promise<void> {
  await casGuardedUpdate(
    "BookingRequest",
    bookingId,
    { processingNextCheckAt: nextCheckAt },
    [{ kind: "fieldEquals", field: "status", value: "PROCESSING" }]
  ).catch(() => undefined);
}

/** Read helper used by sweeps and endpoints. */
export async function getBooking(bookingId: string) {
  const client = await dataClient();
  const { data } = await client.models.BookingRequest.get({ id: bookingId });
  return data;
}
