import { CANCEL_FULL_REFUND_DAYS } from "./bookingTerms";
import { formatMoney as usd } from "./money";

/**
 * GL-07 — the one cancellation-money rule for a paid visit, in pure form.
 *
 * The office never types a refund amount. It picks a plain business decision;
 * the server computes what that decision is worth from this policy and shows it
 * before the employee confirms. Keeping the maths here — with no Stripe, no
 * data client — means the number the preview shows and the number the refund
 * uses come from the same function, and it can be unit-tested exhaustively.
 *
 * The rule is the SAME promise the booking funnel already makes (R17,
 * shared/bookingTerms): a visit canceled more than CANCEL_FULL_REFUND_DAYS whole
 * days before it happens is fully refundable; canceled inside that window it is
 * not, and the amount already paid is retained as a late-cancellation fee. There
 * is deliberately no CSR-typed middle amount — a waiver of the fee is a Manager
 * exception (owner-only), handled by the engine, not by inventing a number here.
 */

export type VisitCancellationPolicy = {
  /** The last calendar day (YYYY-MM-DD) on which a full refund is owed, or null
   *  when the visit has no scheduled date yet (nothing to be late for). */
  policyDeadline: string | null;
  /** True when today is on or before the deadline — a full refund is owed. */
  withinFreeWindow: boolean;
  /** Whole days from today until the visit; null when there is no date. */
  daysUntilVisit: number | null;
  amountPaidCents: number;
  /** What the policy says can go back to the customer. */
  refundableCents: number;
  /** The late-cancellation fee retained (amountPaid − refundable). */
  feeCents: number;
  /** Plain-language explanation the preview shows verbatim. */
  explanation: string;
};

/** Midnight-UTC epoch for a YYYY-MM-DD date, so day arithmetic ignores clocks
 *  and time zones — these are calendar dates, not instants. */
function dayEpoch(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, (m ?? 1) - 1, d ?? 1);
}

const MS_PER_DAY = 86_400_000;

/** Add (or subtract) whole days to a YYYY-MM-DD date, returning YYYY-MM-DD. */
export function addDays(iso: string, days: number): string {
  return new Date(dayEpoch(iso) + days * MS_PER_DAY).toISOString().slice(0, 10);
}



/** We schedule for the DAY, not a time-of-day window, so the 72-hour refund
 *  line is judged from the 8:00 AM Eastern workday open — the earliest a
 *  visit can begin. */
const WORKDAY_START_HOUR = 8;

/** The epoch (ms) of an Eastern wall-clock time on a calendar date, DST-aware.
 *  Exported so callers that must reconstruct a judging instant from a stored
 *  Eastern calendar date (e.g. the public self-cancel's legacy resume path)
 *  share this one DST-correct boundary maths instead of re-deriving an offset. */
export function easternEpochMs(dateIso: string, hour: number): number {
  const guess = Date.parse(`${dateIso}T${String(hour).padStart(2, "0")}:00:00Z`);
  const tz = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    timeZoneName: "shortOffset",
  })
    .formatToParts(new Date(guess))
    .find((part) => part.type === "timeZoneName")?.value;
  const m = tz?.match(/GMT([+-]\d+)/);
  const offsetHours = m ? Number(m[1]) : -5;
  return guess - offsetHours * 3600_000;
}

/**
 * Compute the cancellation policy for a visit. `today` is the caller's notion of
 * the current calendar day (Eastern) — passed in so the function stays pure and
 * so a retry judges the same window it did the first time.
 *
 * GL-07 R6 — when the caller supplies `nowMs` the rule is HOUR-EXACT: strictly
 * more than 72 hours before the visit's scheduled start in America/New_York
 * (the 8:00 AM workday open, since visits are scheduled by day) refunds in
 * full; exactly 72 hours or less refunds nothing. Without `nowMs` the legacy
 * whole-calendar-day comparison applies (the public funnel's promised wording
 * is day-based and changes only with CEO approval).
 *
 * A visit with no scheduled date, or amountPaid of 0, still returns a coherent
 * policy: nothing to be late for, nothing to refund.
 */
export function computeVisitCancellationPolicy(opts: {
  scheduledDate: string | null | undefined;
  amountPaidCents: number;
  today: string;
  /** The judging instant for the hour-exact rule (Date.now() at the accepted
   *  request, or the durable command's requestedAt on a resume). */
  nowMs?: number;
}): VisitCancellationPolicy {
  const amountPaidCents = Math.max(0, Math.trunc(opts.amountPaidCents || 0));
  const scheduledDate = opts.scheduledDate?.trim() || null;

  // No date on the visit: it cannot be a "late" cancel, so the full amount is
  // refundable. (An UNSCHEDULED paid visit is a pool job the customer paid for.)
  if (!scheduledDate) {
    return {
      policyDeadline: null,
      withinFreeWindow: true,
      daysUntilVisit: null,
      amountPaidCents,
      refundableCents: amountPaidCents,
      feeCents: 0,
      explanation:
        amountPaidCents > 0
          ? `This visit isn't scheduled for a date yet, so a full ${usd(amountPaidCents)} refund is available.`
          : "Nothing has been paid for this visit, so there is no refund to make.",
    };
  }

  const daysUntilVisit = Math.round(
    (dayEpoch(scheduledDate) - dayEpoch(opts.today)) / MS_PER_DAY
  );
  const policyDeadline = addDays(scheduledDate, -CANCEL_FULL_REFUND_DAYS);
  // The locked rule: STRICTLY more than 72 hours before the scheduled start
  // (hour-exact, Eastern) = full refund; at or inside 72 hours = none. The
  // whole-day comparison remains for callers without a judging instant.
  const withinFreeWindow =
    opts.nowMs != null
      ? easternEpochMs(scheduledDate, WORKDAY_START_HOUR) - opts.nowMs >
        CANCEL_FULL_REFUND_DAYS * MS_PER_DAY
      : daysUntilVisit > CANCEL_FULL_REFUND_DAYS;

  const refundableCents = withinFreeWindow ? amountPaidCents : 0;
  const feeCents = amountPaidCents - refundableCents;

  let explanation: string;
  if (amountPaidCents === 0) {
    explanation = "Nothing has been paid for this visit, so there is no refund to make.";
  } else if (withinFreeWindow) {
    explanation = `This is more than ${CANCEL_FULL_REFUND_DAYS} days before the visit (on or before ${policyDeadline}), so the full ${usd(amountPaidCents)} is refundable.`;
  } else {
    explanation = `This is within ${CANCEL_FULL_REFUND_DAYS * 24} hours of the visit's scheduled start, so per the cancellation policy the ${usd(amountPaidCents)} already paid isn't refunded. There is no override and no account credit.`;
  }

  return {
    policyDeadline,
    withinFreeWindow,
    daysUntilVisit,
    amountPaidCents,
    refundableCents,
    feeCents,
    explanation,
  };
}
