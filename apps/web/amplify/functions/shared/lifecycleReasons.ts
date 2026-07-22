import type { LifecycleAction } from "./lifecycleLog";

/**
 * GL-09 — the controlled reasons a customer lifecycle transition can carry.
 *
 * Deactivation and reactivation move money, service, access and status all at
 * once, and leadership has to be able to answer "why" from a fixed vocabulary,
 * not free text an employee typed under pressure. This mirrors the staff-access
 * reason codes (staffRoles.assertReasonCode): a transition with no reason, an
 * off-list reason, or a bare "Other" with no note is refused before anything is
 * touched, so a deactivation reason is never blank and never un-auditable.
 */
export const DEACTIVATION_REASONS = [
  "CUSTOMER_REQUEST",
  "NONPAYMENT",
  "MOVED",
  "PROPERTY_SOLD",
  "SERVICE_ENDED",
  "DUPLICATE",
  "OTHER",
] as const;

export const REACTIVATION_REASONS = [
  "CUSTOMER_RETURNED",
  "PAYMENT_RESOLVED",
  "DEACTIVATED_IN_ERROR",
  "OTHER",
] as const;

function reasonsFor(action: LifecycleAction): readonly string[] {
  return action === "DEACTIVATE" ? DEACTIVATION_REASONS : REACTIVATION_REASONS;
}

/**
 * Validate the controlled reason for a lifecycle transition. Returns the
 * normalized reason code. Throws a fixable error if the code is missing, not on
 * the action's list, or is OTHER without an accompanying note — so a blank or
 * unexplained deactivation/reactivation is refused before the money or the
 * portal is touched.
 */
export function assertLifecycleReason(
  action: LifecycleAction,
  reasonCode: string | null | undefined,
  note: string | null | undefined
): string {
  const code = (reasonCode ?? "").trim().toUpperCase();
  const allowed = reasonsFor(action);
  if (!code) {
    throw new Error(
      `A reason is required to ${action === "DEACTIVATE" ? "deactivate" : "reactivate"} a customer. Choose one of: ${allowed.join(", ")}.`
    );
  }
  if (!allowed.includes(code)) {
    throw new Error(
      `"${reasonCode}" isn't a valid reason for this action. Choose one of: ${allowed.join(", ")}.`
    );
  }
  if (code === "OTHER" && !(note ?? "").trim()) {
    throw new Error("Choosing 'Other' needs a short written note saying why.");
  }
  return code;
}

/** The controlled reason folded into a human-readable audit phrase. */
export function lifecycleReasonSummary(
  reasonCode: string,
  note: string | null | undefined
): string {
  const trimmed = (note ?? "").trim();
  return trimmed ? `${reasonCode} — ${trimmed}` : reasonCode;
}

/**
 * GL-09 — the versioned per-reason transition policy. Each deactivation reason
 * drives its own balance handling, record note, and customer-notice wording —
 * nonpayment, a duplicate record, a move, a sale, and a normal service end are
 * NOT the same event even though the mechanical steps overlap. These are the
 * engineering defaults awaiting leadership sign-off (the version records which
 * policy an action ran under); the preview, provider actions, customer notice,
 * and final record all read this one table.
 */
export const LIFECYCLE_POLICY_VERSION = "2026-07-19.1";

export type ReasonPolicy = {
  /** COLLECT — the office pursues the balance; REPORT_ONLY — surfaced, office
   *  decides; WRITE_OFF_REVIEW — flagged for a Finance write-off decision. */
  balanceHandling: "COLLECT" | "REPORT_ONLY" | "WRITE_OFF_REVIEW";
  /** For DUPLICATE: documents are retained on the surviving record. */
  retainDocumentsNote?: string;
  /** The customer-notice subject + body intro for this reason. Empty subject
   *  means NO customer notice is sent (e.g. a duplicate record — the person
   *  still has their real record; a notice would confuse them). */
  noticeSubject: string;
  noticeIntro: string;
};

export const DEACTIVATION_POLICY: Record<string, ReasonPolicy> = {
  CUSTOMER_REQUEST: {
    balanceHandling: "COLLECT",
    noticeSubject: "Your BuzzKill account has been closed",
    noticeIntro:
      "As requested, we've closed your account and stopped all future billing.",
  },
  NONPAYMENT: {
    balanceHandling: "COLLECT",
    noticeSubject: "Your BuzzKill service has been suspended",
    noticeIntro:
      "We've had to suspend your service because of an unpaid balance. Settling it restores service — reply to this email or call us and we'll sort it out together.",
  },
  MOVED: {
    balanceHandling: "COLLECT",
    noticeSubject: "Your BuzzKill account has been closed",
    noticeIntro:
      "We've closed your account following your move and stopped all future billing.",
  },
  PROPERTY_SOLD: {
    balanceHandling: "COLLECT",
    noticeSubject: "Your BuzzKill account has been closed",
    noticeIntro:
      "We've closed your account for this property and stopped all future billing.",
  },
  SERVICE_ENDED: {
    balanceHandling: "COLLECT",
    noticeSubject: "Your BuzzKill service has ended",
    noticeIntro:
      "Your service with us has ended and all future billing has stopped. Thank you for having us out.",
  },
  DUPLICATE: {
    balanceHandling: "WRITE_OFF_REVIEW",
    retainDocumentsNote:
      "This record was a duplicate; its documents are retained under the customer's surviving record.",
    // No customer notice: the person's real record is unaffected — a "your
    // account was closed" email would be confusing and wrong.
    noticeSubject: "",
    noticeIntro: "",
  },
  OTHER: {
    balanceHandling: "REPORT_ONLY",
    noticeSubject: "Your BuzzKill account has been closed",
    noticeIntro:
      "We've closed your account and stopped all future billing.",
  },
};

export const REACTIVATION_POLICY: Record<string, ReasonPolicy> = {
  CUSTOMER_RETURNED: {
    balanceHandling: "REPORT_ONLY",
    noticeSubject: "Welcome back to BuzzKill",
    noticeIntro:
      "Your account is active again. Your previous plans stay closed — book the service you need and we'll take it from there.",
  },
  PAYMENT_RESOLVED: {
    balanceHandling: "REPORT_ONLY",
    noticeSubject: "Your BuzzKill service is restored",
    noticeIntro:
      "Thanks — your balance is settled and your account is active again.",
  },
  DEACTIVATED_IN_ERROR: {
    balanceHandling: "REPORT_ONLY",
    noticeSubject: "Your BuzzKill account is active",
    noticeIntro:
      "Your account was briefly marked inactive in error — it's fully active again, and nothing about your service or billing changed.",
  },
  OTHER: {
    balanceHandling: "REPORT_ONLY",
    noticeSubject: "Your BuzzKill account is active again",
    noticeIntro: "Your account is active again.",
  },
};

export function reasonPolicy(
  action: LifecycleAction,
  reasonCode: string
): ReasonPolicy {
  const table =
    action === "DEACTIVATE" ? DEACTIVATION_POLICY : REACTIVATION_POLICY;
  return table[reasonCode] ?? table.OTHER;
}
