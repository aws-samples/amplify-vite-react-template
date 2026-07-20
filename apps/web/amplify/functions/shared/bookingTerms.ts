/**
 * Single source for the booking-funnel checkout terms (R17).
 *
 * Both Lambdas that speak about cancellation — booking-public (the /cancel
 * refund decision and its copy) and the Stripe webhook (the agreement PDF
 * and confirmation email via bookingFinalize) — derive their policy from
 * CANCEL_FULL_REFUND_DAYS here, so the promise a customer accepts is the
 * rule the code enforces.
 *
 * The text states ONLY what the code keeps: charge-at-booking, the refund
 * cutoff, the emailed cancellation link, and the recurring-plan billing
 * start. Bump BOOKING_TERMS_VERSION whenever the text changes — /book
 * rejects a stale version and the UI re-renders + re-asks.
 */

export const CANCEL_FULL_REFUND_DAYS = 3;

export const BOOKING_TERMS_VERSION = "2026-07-17";

export const BOOKING_TERMS_TEXT = [
  "Your card is charged the amount shown today, when you book.",
  `Cancel more than ${CANCEL_FULL_REFUND_DAYS} whole days before your visit for a full refund. Cancellations ${CANCEL_FULL_REFUND_DAYS} days or less before the visit are not refundable.`,
  "Your cancellation link arrives in the booking confirmation email.",
  "If you book a recurring plan, today's charge is the plan's initial fee (for community common-area plans, your first month); the monthly subscription starts after your first completed visit.",
].join("\n\n");

/**
 * GL-17: the one customer-facing explanation of an off-season seasonal
 * enrollment — truthful about immediate year-round billing and about April
 * being a month, not a promised exact day. Shared so the funnel response
 * (booking-public) and the emailed quote PDF (pricing-refresh) say it
 * identically.
 */
export const OFF_SEASON_MESSAGE =
  "Mosquito season runs April–October. Enroll now and your plan starts today — billed monthly year-round — and we'll schedule your first treatment for April and confirm the exact day with you.";
