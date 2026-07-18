/**
 * GL-18 — the exception (owned-work) policy registry.
 *
 * One canonical table that says, for every WorkKind, how serious it is, what the
 * customer feels, who owns it, and the *controlled* set of ways it may be closed.
 * The whole gate rests on one rule: an exception closes only from a **verified
 * outcome** (the app re-checks the real-world fact) or from an **owner manual
 * override** (a reasoned, evidenced, separately-reported exception). A routine
 * office user can no longer make the dashboard green by typing a note.
 *
 * This module is deliberately pure data + pure predicates — no dataClient, no
 * node built-ins — so it imports cleanly into the Lambda. The CRM keeps a small
 * mirror (apps/crm/src/lib/workPolicy.ts) of the UI-facing fields; the two are
 * kept in step by hand, like STAFF_*_REASONS. workPolicy.test.ts guards the
 * shape against the WorkKind list so a new kind can never ship un-triaged.
 *
 * The verifier NAMES live here; the verifier LOGIC (which reads jobs, invoices,
 * customers) lives beside updateOwnedWork in crm-docs/handler.ts, so this file
 * stays dependency-free.
 */

export type WorkKind =
  | "NO_ACCESS"
  | "EMAIL_FAILURE"
  | "CALLBACK_PROMISE"
  | "DUPLICATE_LEAD"
  | "UNSTAFFED_VISIT"
  | "PAID_VISIT_CANCELLATION"
  | "PORTAL_FAILURE"
  | "PRICING_ESCALATION"
  | "MISSING_CONTACT"
  | "PAID_NOT_FINALIZED"
  | "LOCATION_REVIEW"
  | "STAFF_OFFBOARD"
  | "STAFF_SECURITY"
  | "LEAD_FOLLOWUP"
  | "LIFECYCLE_RECOVERY"
  | "PLAN_CANCELLATION_RECOVERY";

/**
 * CRITICAL — money is at risk, access/security may be wrong, or the customer was
 * told something untrue. HIGH — predictable revenue leak or a service the
 * customer is waiting on. ROUTINE — an after-the-fact review or cleanup.
 */
export type WorkSeverity = "CRITICAL" | "HIGH" | "ROUTINE";

/** The verifier logic each id maps to lives in crm-docs/handler.ts. */
export type VerifierId =
  | "CUSTOMER_HAS_EMAIL"
  | "JOB_STAFFED"
  | "VISIT_MONEY_SETTLED"
  | "PLAN_CANCELLATION_SETTLED";

/**
 * A close the app can *confirm*. Running it re-checks the real-world fact
 * server-side before the item closes; a routine OFFICE/FINANCE user may run it.
 */
export type VerifiedResolution = {
  id: string;
  label: string;
  verifier: VerifierId;
};

/**
 * A verified close carried out by a dedicated mutation elsewhere (the button
 * does the work AND resolves the item, e.g. Rebook / Retry finalization). The
 * office runs the button; the item is never closed by a free-text note.
 */
export type ExternalAction = {
  mutation: string;
  label: string;
};

/** A controlled reason for an owner-only manual override. */
export type ManualReason = { code: string; label: string };

export type WorkPolicy = {
  severity: WorkSeverity;
  /** One plain sentence an office user reads to know who is affected and how. */
  customerImpact: string;
  /** The team accountable by default (a produced row may carry its own team). */
  ownerTeam: "OPS" | "SALES" | "FINANCE";
  /** In-place verified closes, run through updateOwnedWork with a verifier. */
  verified: VerifiedResolution[];
  /** A verified close reached through a dedicated action button/mutation. */
  externalAction?: ExternalAction;
  /** Owner-only override reasons when no verified outcome applies. */
  manualReasons: ManualReason[];
};

const OTHER: ManualReason = { code: "OTHER", label: "Other (explain in the note)" };

export const WORK_POLICY: Record<WorkKind, WorkPolicy> = {
  NO_ACCESS: {
    severity: "HIGH",
    customerImpact:
      "A paid visit couldn't be completed — no one could get in — and the plan is left without a next visit.",
    ownerTeam: "OPS",
    verified: [],
    externalAction: { mutation: "rebookJob", label: "Rebook visit" },
    manualReasons: [
      { code: "CUSTOMER_DECLINED_REBOOK", label: "Customer declined a rebook" },
      { code: "REFUNDED_INSTEAD", label: "Refunded instead of rebooking" },
      { code: "RESOLVED_OFFLINE", label: "Resolved with the customer offline" },
      OTHER,
    ],
  },
  EMAIL_FAILURE: {
    severity: "HIGH",
    customerImpact: "A message to a customer or the team didn't go out.",
    ownerTeam: "OPS",
    verified: [],
    manualReasons: [
      { code: "RESENT_CONFIRMED", label: "Resent and confirmed delivered" },
      { code: "ALTERNATE_CONTACT", label: "Reached them another way" },
      { code: "ADDRESS_CORRECTED", label: "Fixed the address and resent" },
      { code: "NO_LONGER_NEEDED", label: "Message no longer needed" },
      OTHER,
    ],
  },
  CALLBACK_PROMISE: {
    severity: "HIGH",
    customerImpact: "A customer was promised a specialist callback.",
    ownerTeam: "SALES",
    verified: [],
    manualReasons: [
      { code: "CALLED_REACHED", label: "Called and reached the customer" },
      { code: "CALLED_LEFT_MESSAGE", label: "Called and left a message" },
      { code: "EMAILED_INSTEAD", label: "Followed up by email instead" },
      { code: "CUSTOMER_BOOKED", label: "Customer booked" },
      { code: "UNREACHABLE", label: "Customer unreachable after attempts" },
      OTHER,
    ],
  },
  DUPLICATE_LEAD: {
    severity: "ROUTINE",
    customerImpact: "A possible duplicate customer record needs a decision.",
    ownerTeam: "SALES",
    verified: [],
    manualReasons: [
      { code: "MERGED", label: "Merged into the existing record" },
      { code: "KEPT_SEPARATE_CONFIRMED", label: "Confirmed separate people" },
      { code: "NOT_A_DUPLICATE", label: "Not actually a duplicate" },
      OTHER,
    ],
  },
  UNSTAFFED_VISIT: {
    severity: "CRITICAL",
    customerImpact: "A booked visit has no technician — it won't happen as sold.",
    ownerTeam: "OPS",
    verified: [
      {
        id: "STAFFED",
        label: "Confirm a technician is now assigned",
        verifier: "JOB_STAFFED",
      },
    ],
    manualReasons: [
      { code: "CANCELED_WITH_CUSTOMER", label: "Canceled with the customer" },
      { code: "RESCHEDULED", label: "Rescheduled to a staffed day" },
      { code: "RESOLVED_OFFLINE", label: "Resolved offline" },
      OTHER,
    ],
  },
  PAID_VISIT_CANCELLATION: {
    severity: "CRITICAL",
    customerImpact:
      "A paid, canceled visit still owes the customer a refund, credit, or invoice void.",
    ownerTeam: "FINANCE",
    verified: [
      {
        id: "MONEY_SETTLED",
        label: "Confirm the refund / void is settled",
        verifier: "VISIT_MONEY_SETTLED",
      },
    ],
    manualReasons: [
      { code: "CREDIT_APPLIED", label: "Account credit applied and told the customer" },
      { code: "REFUNDED_IN_STRIPE", label: "Refunded directly in Stripe" },
      { code: "INVOICE_VOIDED", label: "Open invoice voided" },
      { code: "NOT_OWED", label: "Nothing was actually owed" },
      OTHER,
    ],
  },
  PORTAL_FAILURE: {
    severity: "HIGH",
    customerImpact: "The customer's online account couldn't be set up.",
    ownerTeam: "OPS",
    verified: [],
    manualReasons: [
      { code: "REPAIRED_SIGN_IN_CONFIRMED", label: "Repaired — sign-in confirmed" },
      { code: "RECREATED", label: "Recreated the account" },
      { code: "CUSTOMER_DECLINED_PORTAL", label: "Customer declined the portal" },
      OTHER,
    ],
  },
  PRICING_ESCALATION: {
    severity: "HIGH",
    customerImpact: "A quote is waiting on a human price decision.",
    ownerTeam: "SALES",
    verified: [],
    manualReasons: [
      { code: "PRICE_APPROVED_SENT", label: "Price approved and quote sent" },
      { code: "CUSTOMER_QUOTED", label: "Customer quoted another way" },
      { code: "DECLINED", label: "Declined — not a fit" },
      OTHER,
    ],
  },
  MISSING_CONTACT: {
    severity: "HIGH",
    customerImpact:
      "The customer has no email on file, so a promised message couldn't be delivered.",
    ownerTeam: "OPS",
    verified: [
      {
        id: "CONTACT_ADDED",
        label: "Confirm a contact is on file",
        verifier: "CUSTOMER_HAS_EMAIL",
      },
    ],
    manualReasons: [
      { code: "PHONE_ONLY_CONFIRMED", label: "Phone-only customer confirmed" },
      { code: "NOTICE_DELIVERED_OTHER", label: "Delivered the notice another way" },
      { code: "CUSTOMER_UNREACHABLE", label: "Customer unreachable" },
      OTHER,
    ],
  },
  PAID_NOT_FINALIZED: {
    severity: "CRITICAL",
    customerImpact: "A customer paid, but the booking didn't finish recording.",
    ownerTeam: "FINANCE",
    verified: [],
    externalAction: {
      mutation: "retryBookingFinalization",
      label: "Retry finalization",
    },
    manualReasons: [
      { code: "REFUNDED", label: "Refunded the customer" },
      { code: "FINALIZED_OFFLINE", label: "Finished the booking by hand" },
      { code: "DUPLICATE_PAYMENT", label: "Duplicate payment — handled" },
      OTHER,
    ],
  },
  LOCATION_REVIEW: {
    severity: "ROUTINE",
    customerImpact:
      "A finished report's captured location needs an after-the-fact presence check.",
    ownerTeam: "OPS",
    verified: [],
    manualReasons: [
      { code: "PRESENCE_CONFIRMED", label: "On-site presence confirmed" },
      { code: "DISCREPANCY_EXPLAINED", label: "Discrepancy explained" },
      { code: "ESCALATED_COMPLIANCE", label: "Escalated to compliance" },
      OTHER,
    ],
  },
  STAFF_OFFBOARD: {
    severity: "HIGH",
    customerImpact:
      "An offboarded employee's future work or technician record still needs finishing.",
    ownerTeam: "OPS",
    verified: [],
    manualReasons: [
      { code: "OFFBOARD_RERUN_COMPLETE", label: "Re-ran offboard — complete" },
      { code: "WORK_REASSIGNED", label: "Work reassigned" },
      { code: "VISIT_CLOSED", label: "In-progress visit closed out" },
      OTHER,
    ],
  },
  STAFF_SECURITY: {
    severity: "CRITICAL",
    customerImpact:
      "A staff access change may be incomplete — someone could still have live access.",
    ownerTeam: "OPS",
    verified: [],
    manualReasons: [
      { code: "ACCESS_CONFIRMED_REMOVED", label: "Access confirmed removed" },
      { code: "RERUN_COMPLETE", label: "Re-ran the change — complete" },
      { code: "FALSE_ALARM", label: "No access was actually left" },
      OTHER,
    ],
  },
  LEAD_FOLLOWUP: {
    severity: "HIGH",
    customerImpact:
      "An open lead has no next step, or its next step is overdue — it's going cold.",
    ownerTeam: "SALES",
    // No in-place verifier: the system auto-resolves this the moment the lead is
    // genuinely worked (a logged touch, a booking link, lost, DNC, or a
    // conversion), so a salesperson closes it by working the lead, not by a note.
    // The owner override is the escape hatch if it ever gets stuck open.
    verified: [],
    manualReasons: [
      { code: "TOUCHED_ADVANCED", label: "Contacted / moved it forward" },
      { code: "BOOKING_SENT", label: "Sent the booking link" },
      { code: "MARKED_LOST", label: "Marked the lead lost" },
      { code: "MARKED_DNC", label: "Set do-not-contact" },
      OTHER,
    ],
  },
  LIFECYCLE_RECOVERY: {
    severity: "CRITICAL",
    // Money/access are in a mixed state and a status transition did not fully
    // complete or record: billing may be stopped while a portal login is still
    // live, or a status change happened with no audit row. Either way something
    // the business must be able to prove or rely on is currently untrue.
    customerImpact:
      "A customer deactivation or reactivation didn't fully complete — access, billing, or the audit record may not match the customer's real state.",
    ownerTeam: "OPS",
    // No auto-verifier: the safe resume is to re-run the transition (it is
    // idempotent) and confirm access + billing + status agree, then close with
    // the matching reason. The owner override is the escape hatch.
    verified: [],
    manualReasons: [
      { code: "RERAN_TRANSITION_COMPLETE", label: "Re-ran the transition — complete" },
      { code: "PORTAL_CONFIRMED_ENDED", label: "Portal login confirmed ended" },
      { code: "AUDIT_ROW_RECONSTRUCTED", label: "Reconstructed the audit record" },
      OTHER,
    ],
  },
  PLAN_CANCELLATION_RECOVERY: {
    severity: "CRITICAL",
    // Money is at risk: billing may still be live, a charge may have posted after
    // the customer cancelled, and the customer was told their cancellation is
    // being finished. Until it is truly settled the customer's money and our
    // word are both exposed.
    customerImpact:
      "A customer's plan cancellation didn't fully finish — billing, a queued visit, a late-charge refund, or their final confirmation may still be outstanding.",
    ownerTeam: "FINANCE",
    // The safe resume: re-run the idempotent cancellation. The button does the
    // work; the verified close below re-checks the world before it can close.
    externalAction: {
      mutation: "resumePlanCancellation",
      label: "Resume cancellation",
    },
    verified: [
      {
        id: "CANCELLATION_SETTLED",
        label: "Confirm the cancellation is fully settled",
        verifier: "PLAN_CANCELLATION_SETTLED",
      },
    ],
    // Owner-only overrides for the genuinely-handled-offline cases; the forced
    // close is stamped and reviewable exactly like every other manual override.
    manualReasons: [
      { code: "SETTLED_OFFLINE", label: "Fully settled with the customer offline" },
      { code: "REFUNDED_ELSEWHERE", label: "Late charge refunded another way" },
      { code: "NO_REFUND_OWED", label: "Reviewed — no refund was owed" },
      OTHER,
    ],
  },
};

export function workPolicy(kind: string): WorkPolicy | null {
  return (WORK_POLICY as Record<string, WorkPolicy | undefined>)[kind] ?? null;
}

/**
 * True when the app can confirm this kind's outcome — either an in-place
 * verified close or a dedicated verified-action button. For a verifiable kind,
 * a free-text close is refused for routine staff (it must be an owner override).
 */
export function isVerifiable(kind: string): boolean {
  const p = workPolicy(kind);
  return !!p && (p.verified.length > 0 || !!p.externalAction);
}

/** Find a verified resolution by id for a kind. */
export function verifiedResolution(
  kind: string,
  resolutionId: string
): VerifiedResolution | null {
  const p = workPolicy(kind);
  return p?.verified.find((v) => v.id === resolutionId) ?? null;
}

/** Whether a reason code is a valid manual-override reason for a kind. */
export function isValidManualReason(kind: string, code: string): boolean {
  const p = workPolicy(kind);
  return !!p && p.manualReasons.some((r) => r.code === code);
}
