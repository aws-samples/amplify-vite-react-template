/**
 * GL-18 — the CRM's mirror of the exception (owned-work) policy.
 *
 * The server's amplify/functions/shared/workPolicy.ts is authoritative: it
 * enforces which closes are allowed. This mirror carries only the UI-facing
 * facts — the short label, severity, customer impact, and which resolution
 * actions to offer — so the Work queue shows the right buttons and badges.
 * Kept in step with the server by hand, like STAFF_*_REASONS in api.ts. If the
 * two ever drift, the server still rejects an invalid close — the UI can only
 * offer the wrong button, never force a bad outcome.
 */

export type WorkSeverity = "CRITICAL" | "HIGH" | "ROUTINE";

/** An in-place verified close: the server re-checks the outcome before closing. */
export type CrmVerifiedAction = { id: string; label: string };

/** A verified close reached through a dedicated action button/mutation. */
export type CrmExternalAction = { mutation: string; label: string };

export type CrmManualReason = { code: string; label: string };

export type CrmWorkPolicy = {
  label: string;
  severity: WorkSeverity;
  customerImpact: string;
  verified: CrmVerifiedAction[];
  externalAction?: CrmExternalAction;
  manualReasons: CrmManualReason[];
};

const OTHER: CrmManualReason = { code: "OTHER", label: "Other (explain in the note)" };

export const WORK_POLICY: Record<string, CrmWorkPolicy> = {
  NO_ACCESS: {
    label: "No access",
    severity: "HIGH",
    customerImpact:
      "A paid visit couldn't be completed — no one could get in — and the plan is left without a next visit.",
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
    label: "Failed email",
    severity: "HIGH",
    customerImpact: "A message to a customer or the team didn't go out.",
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
    label: "Callback",
    severity: "HIGH",
    customerImpact: "A customer was promised a specialist callback.",
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
    label: "Duplicate lead",
    severity: "ROUTINE",
    customerImpact: "A possible duplicate customer record needs a decision.",
    verified: [],
    manualReasons: [
      { code: "MERGED", label: "Merged into the existing record" },
      { code: "KEPT_SEPARATE_CONFIRMED", label: "Confirmed separate people" },
      { code: "NOT_A_DUPLICATE", label: "Not actually a duplicate" },
      OTHER,
    ],
  },
  UNSTAFFED_VISIT: {
    label: "Unstaffed visit",
    severity: "CRITICAL",
    customerImpact: "A booked visit has no technician — it won't happen as sold.",
    verified: [{ id: "STAFFED", label: "Confirm a technician is now assigned" }],
    manualReasons: [
      { code: "CANCELED_WITH_CUSTOMER", label: "Canceled with the customer" },
      { code: "RESCHEDULED", label: "Rescheduled to a staffed day" },
      { code: "RESOLVED_OFFLINE", label: "Resolved offline" },
      OTHER,
    ],
  },
  PAID_VISIT_CANCELLATION: {
    label: "Paid cancellation",
    severity: "CRITICAL",
    customerImpact:
      "A paid, canceled visit still owes the customer a refund, credit, or invoice void.",
    verified: [{ id: "MONEY_SETTLED", label: "Confirm the refund / void is settled" }],
    manualReasons: [
      { code: "CREDIT_APPLIED", label: "Account credit applied and told the customer" },
      { code: "REFUNDED_IN_STRIPE", label: "Refunded directly in Stripe" },
      { code: "INVOICE_VOIDED", label: "Open invoice voided" },
      { code: "NOT_OWED", label: "Nothing was actually owed" },
      OTHER,
    ],
  },
  PORTAL_FAILURE: {
    label: "Portal failure",
    severity: "HIGH",
    customerImpact: "The customer's online account couldn't be set up.",
    verified: [],
    manualReasons: [
      { code: "REPAIRED_SIGN_IN_CONFIRMED", label: "Repaired — sign-in confirmed" },
      { code: "RECREATED", label: "Recreated the account" },
      { code: "CUSTOMER_DECLINED_PORTAL", label: "Customer declined the portal" },
      OTHER,
    ],
  },
  PRICING_ESCALATION: {
    label: "Pricing",
    severity: "HIGH",
    customerImpact: "A quote is waiting on a human price decision.",
    verified: [],
    manualReasons: [
      { code: "PRICE_APPROVED_SENT", label: "Price approved and quote sent" },
      { code: "CUSTOMER_QUOTED", label: "Customer quoted another way" },
      { code: "DECLINED", label: "Declined — not a fit" },
      OTHER,
    ],
  },
  MISSING_CONTACT: {
    label: "Missing contact",
    severity: "HIGH",
    customerImpact:
      "The customer has no email on file, so a promised message couldn't be delivered.",
    verified: [{ id: "CONTACT_ADDED", label: "Confirm a contact is on file" }],
    manualReasons: [
      { code: "PHONE_ONLY_CONFIRMED", label: "Phone-only customer confirmed" },
      { code: "NOTICE_DELIVERED_OTHER", label: "Delivered the notice another way" },
      { code: "CUSTOMER_UNREACHABLE", label: "Customer unreachable" },
      OTHER,
    ],
  },
  PAID_NOT_FINALIZED: {
    label: "Paid, not finalized",
    severity: "CRITICAL",
    customerImpact: "A customer paid, but the booking didn't finish recording.",
    verified: [],
    externalAction: { mutation: "retryBookingFinalization", label: "Retry finalization" },
    manualReasons: [
      { code: "REFUNDED", label: "Refunded the customer" },
      { code: "FINALIZED_OFFLINE", label: "Finished the booking by hand" },
      { code: "DUPLICATE_PAYMENT", label: "Duplicate payment — handled" },
      OTHER,
    ],
  },
  LOCATION_REVIEW: {
    label: "Location review",
    severity: "ROUTINE",
    customerImpact:
      "A finished report's captured location needs an after-the-fact presence check.",
    verified: [],
    manualReasons: [
      { code: "PRESENCE_CONFIRMED", label: "On-site presence confirmed" },
      { code: "DISCREPANCY_EXPLAINED", label: "Discrepancy explained" },
      { code: "ESCALATED_COMPLIANCE", label: "Escalated to compliance" },
      OTHER,
    ],
  },
  STAFF_OFFBOARD: {
    label: "Staff offboard",
    severity: "HIGH",
    customerImpact:
      "An offboarded employee's future work or technician record still needs finishing.",
    verified: [],
    manualReasons: [
      { code: "OFFBOARD_RERUN_COMPLETE", label: "Re-ran offboard — complete" },
      { code: "WORK_REASSIGNED", label: "Work reassigned" },
      { code: "VISIT_CLOSED", label: "In-progress visit closed out" },
      OTHER,
    ],
  },
  STAFF_SECURITY: {
    label: "Staff security",
    severity: "CRITICAL",
    customerImpact:
      "A staff access change may be incomplete — someone could still have live access.",
    verified: [],
    manualReasons: [
      { code: "ACCESS_CONFIRMED_REMOVED", label: "Access confirmed removed" },
      { code: "RERUN_COMPLETE", label: "Re-ran the change — complete" },
      { code: "FALSE_ALARM", label: "No access was actually left" },
      OTHER,
    ],
  },
};

export function workPolicy(kind: string | null | undefined): CrmWorkPolicy | null {
  return (kind && WORK_POLICY[kind]) || null;
}

export function isVerifiable(kind: string | null | undefined): boolean {
  const p = workPolicy(kind);
  return !!p && (p.verified.length > 0 || !!p.externalAction);
}

export const SEVERITY_TONE: Record<WorkSeverity, "danger" | "warn" | "info"> = {
  CRITICAL: "danger",
  HIGH: "warn",
  ROUTINE: "info",
};

export const SEVERITY_LABEL: Record<WorkSeverity, string> = {
  CRITICAL: "Critical",
  HIGH: "High",
  ROUTINE: "Routine",
};
