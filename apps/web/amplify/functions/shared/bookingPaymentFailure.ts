import { dataClient } from "./dataClient";
import { emailShell, sendEmail } from "./email";
import {
  bookingToPaymentFailed,
  claimPaymentFailedNotice,
} from "./bookingPayment";
import { settlePendingFailure } from "./bookingFinalize";
import { formatMoney } from "./money";

/**
 * GL-06 — the ONE failure path for a funnel payment, shared by the Stripe
 * webhook and the daily reconcile sweep (which discovers failures whose
 * webhook never arrived). Records the conditional PAYMENT_FAILED transition,
 * unwinds or converts any pending commitment exactly once, and tells the
 * customer once with copy matching the world we are in.
 *
 * Throws when the transition store is unavailable — the caller must NOT
 * acknowledge a failure that was never recorded (the webhook 500s so Stripe
 * redelivers; the sweep retries tomorrow).
 */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function recordFunnelPaymentFailure(opts: {
  bookingRequestId: string;
  intentId: string;
  reason: string;
}): Promise<"HANDLED" | "STALE"> {
  const client = await dataClient();
  const { data: booking } = await client.models.BookingRequest.get({
    id: opts.bookingRequestId,
  });
  if (!booking) return "STALE";

  // ONE conditional transition — QUOTED|PROCESSING → PAYMENT_FAILED for THIS
  // attempt. A stale failure (booking BOOKED, or a superseded intent) LOSES
  // and changes nothing; UNSUPPORTED throws so the caller never acknowledges
  // a failure that was never recorded.
  const moved = await bookingToPaymentFailed({
    bookingId: booking.id,
    intentId: opts.intentId,
    reason: opts.reason,
  });
  if (!moved.ok) {
    if (moved.reason === "UNSUPPORTED") {
      throw new Error(
        `funnel payment failure: transition store unavailable for booking ${booking.id}`
      );
    }
    // LOST is usually a stale/duplicate event — but it is ALSO the redelivery
    // of a failure whose consequences crashed partway. Resume the
    // consequences only when the booking is already PAYMENT_FAILED for this
    // same attempt; any other state stands untouched.
    const { data: current } = await client.models.BookingRequest.get({
      id: booking.id,
    });
    const sameAttempt =
      !current?.stripePaymentIntentId ||
      current.stripePaymentIntentId === opts.intentId;
    if (!current || current.status !== "PAYMENT_FAILED" || !sameAttempt) {
      return "STALE"; // the current state already tells the truth
    }
  }

  // The winner (or the resuming redelivery) owns the consequences. A pending
  // commitment (jobId checkpointed) is unwound pre-service — cancel once,
  // release capacity once, void the pending invoice — or converted
  // post-service into an owned outstanding balance. Every step inside is
  // conditional, so a crash here resumes idempotently on the next delivery.
  const outcome = await settlePendingFailure({
    bookingId: booking.id,
    intentId: opts.intentId,
    reason: opts.reason,
  });

  // Tell the customer once — an ATOMIC marker claim keeps a replayed webhook
  // (or the sweep racing a webhook) from re-sending. The copy tells the truth
  // for the world we are in: no charge + rebook (nothing existed yet), visit
  // canceled + rebook (pending commitment unwound), or balance due (the
  // visit already happened).
  if (booking.email && (await claimPaymentFailedNotice(booking.id))) {
    const marketingUrl =
      process.env.MARKETING_URL ?? "https://www.pestbuzzkill.com";
    const dateLine = booking.selectedDate
      ? `${esc(booking.selectedDate)} `
      : "";
    const body =
      outcome === "POST_SERVICE"
        ? `<p>Hi ${esc(booking.name ?? "there")},</p>
         <p>Your ${dateLine}pest control visit was completed, but your bank payment of <strong>${formatMoney(((booking.amountCents ?? 0) as number))}</strong> didn't go through afterward (${esc(opts.reason)}).</p>
         <p><strong>The amount is now an outstanding balance on your account.</strong> To settle it, reply to this email or call the office and we'll retry your bank payment or take a card over the phone — it takes about a minute. Our team will also reach out within one business day.</p>`
        : outcome === "PRE_SERVICE"
          ? `<p>Hi ${esc(booking.name ?? "there")},</p>
         <p>Your bank payment for the ${dateLine}pest control visit didn't go through (${esc(opts.reason)}), so <strong>that scheduled visit has been canceled and no money was collected</strong>.</p>
         <p>You can pick a time and book again in about a minute:</p>
         <p><a href="${marketingUrl}/quote">Book your visit</a></p>
         <p>If you keep having trouble, reply to this email or give us a call and we'll help.</p>`
          : `<p>Hi ${esc(booking.name ?? "there")},</p>
         <p>We couldn't complete the payment for your ${dateLine}pest control booking, so <strong>the booking was not completed and you have not been charged</strong>.</p>
         <p>Your slot is still open. You can pick a time and try again here:</p>
         <p><a href="${marketingUrl}/quote">Book your visit</a></p>
         <p>If you keep having trouble, reply to this email or give us a call and we'll help.</p>`;
    const sent = await sendEmail({
      to: booking.email,
      subject:
        outcome === "POST_SERVICE"
          ? "Action needed: your BuzzKill payment didn't go through"
          : "Your BuzzKill booking didn't go through",
      template: "booking-payment-failed",
      relatedId: booking.id,
      html: emailShell(
        outcome === "POST_SERVICE"
          ? "Your payment needs another try"
          : "Your payment didn't go through",
        body
      ),
    });
    if (!sent) {
      // The claim was taken but the send failed — clear the marker so the
      // next delivery (or the sweep) can try again; the guard means only
      // the claim's own winner ever clears it.
      await client.models.BookingRequest.update({
        id: booking.id,
        paymentFailedNoticeSentAt: null,
      }).catch(() => undefined);
    }
  }
  return "HANDLED";
}
