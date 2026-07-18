/**
 * GL-08 — the one plan-cancellation policy, in pure form.
 *
 * Every plan-cancellation surface — the portal preview, the pending message, the
 * in-app success message, the confirmation email, and the staff view — must say
 * the SAME thing, and each visit sentence must be derived from the ACTUAL
 * resolution of the plan's queued visits, never a static line that can drift from
 * what really happened. Keeping the values and the copy builders here (no Stripe,
 * no data client) means the promise the preview makes, the words the email uses,
 * and the message the portal shows all come from one place and can be
 * unit-tested exhaustively.
 *
 * The VALUES below are the customer-facing launch policy. They are promises, not
 * developer defaults, so they carry CEO/Finance/Operations sign-off; they live
 * here as one typed source so preview / terms / portal / recovery / notices
 * cannot disagree. Change the policy by changing these constants, and every
 * surface changes with it.
 */

export const PLAN_CANCELLATION_POLICY = {
  /** Cancellation takes effect immediately — billing and visits stop today. */
  effectiveTiming: "IMMEDIATE" as const,
  /** The already-billed current period is not refunded on cancel. */
  currentPeriodRefunded: false as const,
  /** Canceling does NOT clear unpaid OPEN/FAILED invoices already owed. */
  outstandingBalanceCleared: false as const,
  /** A visit paid up front stays the customer's — keep it or refund it, their
   *  choice — never silently lost. */
  prepaidVisitDefault: "KEEP_OR_REFUND" as const,
  /** Any charge that posts on/after the customer's accepted cancellation time is
   *  refunded; a person (Finance) approves each refund (business decision
   *  2026-07-18). The pending copy may say "we'll refund it" because we will. */
  postRequestChargeRefund: "REFUND_FINANCE_APPROVED" as const,
  /** The pending-resolution commitment shown to customers. */
  resolutionSla: "usually within one business day",
  /** The one-time retention offer: pause the plan (no charges while paused)
   *  rather than cancel. Backed by the pausePlan mutation, not just UI text. */
  saveOffer: { enabled: true as const, kind: "PAUSE" as const },
} as const;

const usd = (cents: number): string =>
  `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

/**
 * The actual resolution of a plan's queued visits, from cancelPlanBilling.
 *   stopped     — unpaid future visits removed from the schedule.
 *   keptPaid    — visits paid up front, left on the books for an office keep/
 *                 refund decision (never silently canceled).
 *   failed      — visits that SHOULD have come off but whose write failed; they
 *                 are still on the schedule and our team must remove them. These
 *                 are NOT prepaid and must never be described as such.
 */
export type VisitResolutionSummary = {
  stopped: number;
  keptPaid: number;
  failed: number;
  /** Scheduled dates (YYYY-MM-DD or null) for the kept-paid visits. */
  keptPaidDates: (string | null)[];
  /** Scheduled dates for the still-on-schedule failed removals. */
  failedDates: (string | null)[];
};

/** The line about what happened to the recurring visits — conditional on whether
 *  every cancelable visit actually came off. Shared by the success message and
 *  the confirmation email so they can never disagree. */
export function visitOutcomeSentence(summary: {
  failed: number;
}): string {
  return summary.failed === 0
    ? "Your recurring visits have stopped."
    : `Most of your recurring visits have stopped; ${summary.failed} still need our team to take off the schedule, and we're on it.`;
}

/** The kept-paid line — only when a paid-up-front visit remains. */
export function keptPaidSentence(summary: { keptPaid: number }): string {
  if (summary.keptPaid <= 0) return "";
  return summary.keptPaid === 1
    ? " A visit you'd already paid for stays on our books — we'll be in touch to keep it or refund it, your choice."
    : ` ${summary.keptPaid} visits you'd already paid for stay on our books — we'll be in touch to keep or refund each, your choice.`;
}

/**
 * The in-app success message (the sheet result). Derived entirely from the real
 * resolution: it never claims all visits stopped while any remain, and only says
 * "emailed" when the confirmation was actually accepted for sending.
 */
export function planCanceledSuccessMessage(
  summary: { failed: number; keptPaid: number },
  opts: { confirmationEmailed: boolean }
): string {
  let message = "Your plan is canceled and you won't be billed again. ";
  message += visitOutcomeSentence(summary);
  message += keptPaidSentence(summary);
  if (opts.confirmationEmailed) message += " We've emailed you a confirmation.";
  return message;
}

/**
 * The truthful PENDING message, shown identically everywhere a cancellation is
 * in flight. It must NOT claim billing stopped — the provider may still charge —
 * and it names the refund promise the business now stands behind (Finance
 * approves each refund) plus the resolution commitment.
 */
export function pendingCancelMessage(): string {
  return `We've received your cancellation and we're finishing it now. Your plan is still active until we complete it, so if a scheduled charge happens to post in the meantime, we'll refund it. Our team finishes this and emails your confirmation, ${PLAN_CANCELLATION_POLICY.resolutionSla}. Nothing more is needed from you.`;
}

/** Already-canceled no-op copy. */
export const ALREADY_CANCELED_MESSAGE = "This plan is already canceled.";

// ---------------------------------------------------------------------------
// Preview copy (buildCancellationPreview) — all derived from the policy values.
// ---------------------------------------------------------------------------

/** The extra sentence appended to the final-charge line when money is still owed. */
export function outstandingBalanceLine(outstandingBalanceCents: number): string {
  if (outstandingBalanceCents <= 0) return "";
  return ` You still owe ${usd(outstandingBalanceCents)} on an unpaid invoice — canceling doesn't clear that, and we'll still need it settled.`;
}

export function finalChargeDescription(outstandingBalanceCents: number): string {
  return `No new charge. Canceling stops all future monthly charges — you won't be billed again.${outstandingBalanceLine(
    outstandingBalanceCents
  )}`;
}

export function refundOrCreditDescription(): string {
  return "The current period is already paid and isn't refunded. Any visit you paid for up front stays yours unless you ask us to refund it.";
}

export function coverageEndingDescription(): string {
  return "Your plan's ongoing protection ends today — the scheduled recurring visits and the between-visit coverage and re-treatment that come with the plan stop when it's canceled.";
}

// ---------------------------------------------------------------------------
// Confirmation-email body — one paragraph set generated from the real
// resolution, shared with the in-app message so they cannot diverge.
// ---------------------------------------------------------------------------

const fmtDate = (d: string | null): string | null => {
  if (!d) return null;
  const t = new Date(`${d}T00:00:00Z`).getTime();
  if (Number.isNaN(t)) return d;
  return new Date(t).toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
};

/**
 * The confirmation-email inner HTML, generated from the actual resolution:
 *  - the recurring-visits sentence is conditional on failed===0,
 *  - kept-paid visits are enumerated as "keep or refund, your choice",
 *  - failed removals are named as visits WE still need to take off the schedule
 *    (never described as prepaid),
 * so the email can never say every visit stopped while one remains.
 */
export function confirmationEmailBodyHtml(
  planName: string,
  summary: VisitResolutionSummary
): string {
  const parts: string[] = [];
  parts.push(
    `<p>Your <strong>${planName}</strong> plan with BuzzKill is canceled, effective today.</p>`
  );
  parts.push(`<p>You won't be billed again. ${visitOutcomeSentence(summary)}</p>`);

  const keptDates = summary.keptPaidDates.map(fmtDate).filter(Boolean);
  if (summary.keptPaid > 0) {
    const which =
      keptDates.length > 0 ? ` (${keptDates.join(", ")})` : "";
    parts.push(
      `<p>${
        summary.keptPaid === 1
          ? `One visit you'd already paid for${which} is still on our books`
          : `${summary.keptPaid} visits you'd already paid for${which} are still on our books`
      } — we'll be in touch to either keep ${
        summary.keptPaid === 1 ? "it" : "them"
      } or refund ${summary.keptPaid === 1 ? "it" : "each"}, whichever you prefer.</p>`
    );
  }

  const failedDates = summary.failedDates.map(fmtDate).filter(Boolean);
  if (summary.failed > 0) {
    const which = failedDates.length > 0 ? ` (${failedDates.join(", ")})` : "";
    parts.push(
      `<p>${
        summary.failed === 1
          ? `One recurring visit${which} is still on the schedule`
          : `${summary.failed} recurring visits${which} are still on the schedule`
      } — our team is taking ${
        summary.failed === 1 ? "it" : "them"
      } off now, and you won't be charged for ${
        summary.failed === 1 ? "it" : "them"
      }.</p>`
    );
  }

  parts.push(
    `<p>Changed your mind, or want to set something up again? Just reply to this email or give us a call — we'd be glad to have you back.</p>`
  );
  return parts.join("\n     ");
}
