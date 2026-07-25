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
  | "PAYMENT_INTENT_ORPHAN"
  | "LOCATION_REVIEW"
  | "STAFF_OFFBOARD"
  | "STAFF_SECURITY"
  | "LEAD_FOLLOWUP"
  | "LEAD_LIFECYCLE_RECOVERY"
  | "LIFECYCLE_RECOVERY"
  | "PLAN_CANCELLATION_RECOVERY"
  | "VISIT_CHANGE_RECOVERY"
  | "ROUTE_MISMATCH"
  | "STALE_DRAFT"
  | "OFFICE_FIELD_REVIEW"
  | "LICENSE_LAPSE"
  | "SCOPE_MISMATCH"
  | "PREP_MISSING"
  | "DISPATCH_NOT_READY"
  | "ADDRESS_UNROUTABLE"
  | "OBLIGATION_RECOVERY"
  | "PRICING_RESEARCH_EXHAUSTED"
  | "PRICING_CHANGE_REVIEW"
  | "SERVICE_CATALOG_DECISION"
  | "INFRA_ALERT"
  | "CUSTOMER_REQUEST"
  | "MONEY_MISMATCH"
  | "PLAN_MISMATCH"
  | "STATE_MISMATCH"
  | "BALANCE_COLLECTION"
  | "PAYMENT_PROCESSING_OVERDUE";

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
  | "PLAN_CANCELLATION_SETTLED"
  | "TECH_LICENSED"
  | "DISPATCH_READY"
  | "LIFECYCLE_SETTLED"
  | "VISIT_CHANGE_SETTLED";

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
    // GL-10 locked rule: no access is a NONREFUNDABLE cancellation — there is
    // deliberately no refund disposition here.
    manualReasons: [
      { code: "CUSTOMER_DECLINED_REBOOK", label: "Customer declined a rebook" },
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
      "A paid, canceled visit still has an unresolved refund or invoice disposition.",
    ownerTeam: "FINANCE",
    verified: [
      {
        id: "MONEY_SETTLED",
        label: "Confirm the refund / void is settled",
        verifier: "VISIT_MONEY_SETTLED",
      },
    ],
    manualReasons: [
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
  PAYMENT_INTENT_ORPHAN: {
    severity: "CRITICAL",
    customerImpact:
      "A chargeable payment intent exists that the booking record does not reference — if the customer completes it, finalization will refuse the money as superseded.",
    ownerTeam: "FINANCE",
    verified: [],
    manualReasons: [
      { code: "INTENT_CANCELED", label: "Canceled the intent in Stripe" },
      { code: "REFUNDED", label: "Refunded the customer" },
      { code: "RECONCILED", label: "Reconciled the booking to the intent" },
      OTHER,
    ],
  },
  ADDRESS_UNROUTABLE: {
    // A stop whose address Google Routes cannot resolve makes its technician's
    // WHOLE day unmeasurable, and an unmeasurable day fails closed — it holds
    // the full window and sells nothing. Left silent, the office only ever sees
    // "that day is now fully booked" on a day that is nearly empty, so this is
    // graded on the revenue it quietly blocks, not on the one bad record.
    severity: "HIGH",
    customerImpact:
      "A service address can't be found, so its technician's whole day can't be routed and stops can't be booked onto it.",
    ownerTeam: "OPS",
    verified: [],
    manualReasons: [
      { code: "ADDRESS_CORRECTED", label: "Address corrected" },
      { code: "OUTSIDE_SERVICE_AREA", label: "Outside the service area" },
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
  LEAD_LIFECYCLE_RECOVERY: {
    severity: "HIGH",
    customerImpact:
      "A lead intake, mutation, consent decision, conversion identity decision, or sweep stopped before every required fact was verified.",
    ownerTeam: "SALES",
    verified: [],
    manualReasons: [
      { code: "RERUN_COMPLETE", label: "Re-ran the safe action and verified it" },
      { code: "IDENTITY_RESOLVED", label: "Resolved the lead/customer identity" },
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
    verified: [
      {
        id: "LIFECYCLE_SETTLED",
        label: "Confirm billing, schedule, access, and status all agree",
        verifier: "LIFECYCLE_SETTLED",
      },
    ],
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
  ROUTE_MISMATCH: {
    severity: "CRITICAL",
    // A stop's route and its assigned technician disagree — the wrong
    // technician could be shown (or sent to) the job and its customer. The
    // stop is withheld from the field day until the two agree, so the exposure
    // becomes a scheduling gap the office must fix.
    customerImpact:
      "A visit's route and its assigned technician disagree — it is withheld from the field day until the office repairs the assignment.",
    ownerTeam: "OPS",
    verified: [
      {
        id: "ASSIGNMENT_AGREES",
        label: "Confirm the visit is staffed and its route agrees",
        verifier: "JOB_STAFFED",
      },
    ],
    manualReasons: [
      { code: "UNASSIGNED_TO_POOL", label: "Returned the visit to the pool" },
      { code: "CANCELED_WITH_CUSTOMER", label: "Canceled with the customer" },
      OTHER,
    ],
  },
  STALE_DRAFT: {
    severity: "ROUTINE",
    // A visit changed hands (reassignment, offboarding, cancel) while its
    // former technician had an unsent DRAFT report. The draft is a regulated
    // record in the making — the office decides its disposition rather than
    // letting it silently rot or be silently reused.
    customerImpact:
      "A reassigned or canceled visit still has the former technician's unsent draft report — the office must decide what happens to it.",
    ownerTeam: "OPS",
    verified: [],
    manualReasons: [
      { code: "NEW_TECH_REWROTE", label: "New technician filed their own report" },
      { code: "DRAFT_DISCARDED", label: "Draft reviewed and discarded" },
      { code: "OFFICE_FILED", label: "Office completed the record via amendment/report" },
      OTHER,
    ],
  },
  OFFICE_FIELD_REVIEW: {
    severity: "ROUTINE",
    // An office/owner performed a technician's field action (start, end,
    // no-access) with a recorded reason. Reviewed after the fact so emergency
    // access stays an exception, not a habit — and never silently impersonates
    // the applicator.
    customerImpact:
      "An office member performed a technician's field action — the reasoned use is recorded and needs a routine review.",
    ownerTeam: "OPS",
    verified: [],
    manualReasons: [
      { code: "REVIEWED_APPROPRIATE", label: "Reviewed — appropriate use" },
      { code: "REVIEWED_COACHED", label: "Reviewed — coached the employee" },
      OTHER,
    ],
  },
  SCOPE_MISMATCH: {
    severity: "HIGH",
    customerImpact:
      "A technician arrived and the sold service doesn't match what the site needs — the customer is waiting on the corrected service.",
    ownerTeam: "OPS",
    verified: [],
    externalAction: { mutation: "rebookJob", label: "Rebook corrected visit" },
    manualReasons: [
      { code: "SCOPE_CORRECTED_REBOOKED", label: "Scope corrected and rebooked" },
      { code: "CUSTOMER_DECLINED", label: "Customer declined the corrected service" },
      { code: "REFUNDED_INSTEAD", label: "Refunded instead" },
      OTHER,
    ],
  },
  PREP_MISSING: {
    severity: "HIGH",
    customerImpact:
      "A visit couldn't be performed because the customer's required preparation wasn't in place — they're waiting on a rebook.",
    ownerTeam: "OPS",
    verified: [],
    externalAction: { mutation: "rebookJob", label: "Rebook visit" },
    manualReasons: [
      { code: "PREP_DONE_REBOOKED", label: "Prep completed and rebooked" },
      { code: "CUSTOMER_DECLINED", label: "Customer declined to reschedule" },
      { code: "REFUNDED_INSTEAD", label: "Refunded instead" },
      OTHER,
    ],
  },
  DISPATCH_NOT_READY: {
    severity: "HIGH",
    customerImpact:
      "Tomorrow's visit is missing a dispatch fact (address, classification, or packet) — it can't safely go out as booked.",
    ownerTeam: "OPS",
    verified: [
      {
        id: "READY",
        label: "Confirm the visit is dispatch-ready",
        verifier: "DISPATCH_READY",
      },
    ],
    manualReasons: [
      { code: "RESCHEDULED", label: "Rescheduled with the customer" },
      { code: "CANCELED_WITH_CUSTOMER", label: "Canceled with the customer" },
      OTHER,
    ],
  },
  OBLIGATION_RECOVERY: {
    severity: "HIGH",
    // GL-17: a seasonal plan's monthly-treatment ledger could not be written
    // (an obligation row failed to create/advance). The promise ("one
    // treatment each month, Apr–Oct") exists whether or not the bookkeeping
    // landed — so the failure is OWNED, not swallowed, until the ledger reads
    // true again.
    customerImpact:
      "A seasonal plan's monthly-treatment record could not be written — the promised-visit ledger is out of step with reality until it's fixed.",
    ownerTeam: "OPS",
    verified: [],
    manualReasons: [
      { code: "LEDGER_CORRECTED", label: "Obligation record corrected by hand" },
      { code: "PLAN_CANCELED", label: "Plan canceled — no obligation remains" },
      OTHER,
    ],
  },
  PRICING_RESEARCH_EXHAUSTED: {
    severity: "HIGH",
    // GL-16: a service+area combo failed AI research MAX_RESEARCH_ATTEMPTS
    // times in a row and is parked — quotes for it fall to the honest
    // callback path (never an invented price) until the office acts. The
    // safe next actions live on the Market Rates screen: retry the
    // research, set the price by hand (pins the row), or retire the combo.
    customerImpact:
      "AI pricing repeatedly failed for a service + area, so those quotes fall back to a callback instead of an instant price.",
    ownerTeam: "OPS",
    verified: [],
    manualReasons: [
      { code: "RESEARCH_RETRIED", label: "Research retried from Market Rates" },
      { code: "PRICE_SET_MANUALLY", label: "Price set by hand (row pinned)" },
      { code: "COMBO_RETIRED", label: "Combo retired — not offered here" },
      OTHER,
    ],
  },
  PRICING_CHANGE_REVIEW: {
    severity: "ROUTINE",
    // GL-16: the day's live rate changes (AI research + office pins), already
    // quoting — the CEO-accepted control is a recorded one-business-day
    // review, never preapproval. Anything wrong is corrected on Market Rates
    // (pins the row) or by the OWNER catalog rollback.
    customerImpact:
      "New live prices are quoting to customers and await their recorded daily review.",
    ownerTeam: "OPS",
    verified: [],
    manualReasons: [
      { code: "REVIEWED_OK", label: "Reviewed — prices stand" },
      { code: "REVIEWED_CORRECTED", label: "Reviewed — corrected on Market Rates" },
      { code: "REVIEWED_ROLLED_BACK", label: "Reviewed — catalog rolled back" },
      OTHER,
    ],
  },
  SERVICE_CATALOG_DECISION: {
    severity: "HIGH",
    // GL-01: someone asked for work the service catalog does not sell. The
    // customer is waiting on an answer, so the decision (add it to the
    // catalog / decline and tell them) carries the common one-business-day
    // clock; a job is never silently invented around the catalog.
    customerImpact:
      "A customer asked for a service outside the catalog — they are waiting on whether BuzzKill sells it.",
    ownerTeam: "OPS",
    verified: [],
    manualReasons: [
      { code: "ADDED_TO_CATALOG", label: "Added to the catalog (engineering change) and customer scheduled" },
      { code: "MAPPED_TO_EXISTING", label: "It maps to an existing catalog service — job created" },
      { code: "DECLINED_TOLD_CUSTOMER", label: "Declined — customer told we don't offer it" },
      OTHER,
    ],
  },
  CUSTOMER_REQUEST: {
    severity: "HIGH",
    // GL-11: a customer asked for something through the portal (reschedule /
    // help) and is watching the case there — same one-business-day clock.
    customerImpact:
      "A customer submitted a portal request (reschedule or help) and is waiting on the office's answer.",
    ownerTeam: "OPS",
    verified: [],
    externalAction: { mutation: "resolvePortalRequest", label: "Resolve with an answer" },
    manualReasons: [
      { code: "RESOLVED_VIA_REQUEST", label: "Resolved through the portal request (see its note)" },
      OTHER,
    ],
  },
  INFRA_ALERT: {
    severity: "HIGH",
    // GL-22: a background system failure (Lambda errors, a scheduled job
    // that never ran, dead-lettered email events, an incomplete daily run).
    // The customer impact is indirect but real: obligations those systems
    // watch can silently go unmet until this is fixed. Same one-business-day
    // owned response as everything else — no severity classes.
    customerImpact:
      "A background system failed — reminders, reconciliation, or email tracking may be silently behind until it's fixed.",
    ownerTeam: "OPS",
    verified: [],
    manualReasons: [
      { code: "RECOVERED_VERIFIED", label: "Recovered — verified healthy" },
      { code: "ESCALATED_ENGINEERING", label: "Escalated to engineering" },
      OTHER,
    ],
  },
  MONEY_MISMATCH: {
    severity: "CRITICAL",
    // GL-19: the provider ledger and the CRM ledger disagree about money.
    customerImpact:
      "Stripe and the CRM disagree about a payment or refund — someone's money is recorded wrong until this reconciles.",
    ownerTeam: "FINANCE",
    verified: [],
    manualReasons: [
      { code: "RECONCILED_CORRECTED", label: "Reconciled — record corrected, Finance signed" },
      { code: "PROVIDER_TIMING", label: "Provider timing — verified it self-resolved" },
      OTHER,
    ],
  },
  PLAN_MISMATCH: {
    severity: "CRITICAL",
    // GL-19: provider subscriptions and CRM plans disagree.
    customerImpact:
      "A customer's recurring billing and their CRM plan disagree — they may be charged for a canceled plan or served without revenue.",
    ownerTeam: "FINANCE",
    verified: [],
    manualReasons: [
      { code: "BILLING_CORRECTED", label: "Billing corrected — provider and CRM agree" },
      { code: "PLAN_CORRECTED", label: "CRM plan corrected to match reality" },
      OTHER,
    ],
  },
  STATE_MISMATCH: {
    severity: "HIGH",
    // GL-19: lifecycle/visit state disagrees with money or the schedule.
    customerImpact:
      "A customer's status, schedule, and money tell different stories — a deactivated customer could be visited, or canceled work could hold live money.",
    ownerTeam: "OPS",
    verified: [],
    manualReasons: [
      { code: "STATE_CORRECTED", label: "State corrected — status, schedule, and money agree" },
      OTHER,
    ],
  },
  BALANCE_COLLECTION: {
    severity: "CRITICAL",
    // GL-06: the work was performed; the bank debit then failed. The invoice
    // is the outstanding balance — the case turns green only when the money
    // is verifiably settled, never on a note.
    customerImpact:
      "The visit was completed but the customer's bank payment failed afterward — the invoice is an unpaid balance.",
    ownerTeam: "FINANCE",
    verified: [
      {
        id: "BALANCE_SETTLED",
        label: "Confirm the balance is settled",
        verifier: "VISIT_MONEY_SETTLED",
      },
    ],
    manualReasons: [
      { code: "WRITTEN_OFF", label: "Balance written off (Finance approval)" },
      OTHER,
    ],
  },
  PAYMENT_PROCESSING_OVERDUE: {
    severity: "HIGH",
    // GL-06: a pending bank debit passed its expected settlement date with no
    // provider result. The visit may be approaching (or done) on money that
    // never arrived — reconcile with Stripe before it becomes a surprise.
    customerImpact:
      "A customer's bank payment has been processing longer than expected — the scheduled visit is riding on money that hasn't settled.",
    ownerTeam: "FINANCE",
    verified: [
      {
        id: "PAYMENT_RESOLVED",
        label: "Confirm the payment reached a final state",
        verifier: "VISIT_MONEY_SETTLED",
      },
    ],
    manualReasons: [
      { code: "PROVIDER_CONFIRMED_PENDING", label: "Stripe confirms it is still processing normally" },
      OTHER,
    ],
  },
  LICENSE_LAPSE: {
    severity: "HIGH",
    // A technician's applicator licence is expiring (advance warning) or has
    // expired/been revoked. Their future capacity is already removed by the
    // enforcement points; this is the office's advance renewal/reassignment
    // work so customers are moved BEFORE a doorstep failure.
    customerImpact:
      "A technician's applicator licence is lapsing — their future visits need a renewal on file or reassignment before service dates arrive.",
    ownerTeam: "OPS",
    verified: [
      {
        id: "LICENSE_CURRENT",
        label: "Confirm a current licence is on file (or no future work remains)",
        verifier: "TECH_LICENSED",
      },
    ],
    manualReasons: [
      { code: "TECH_OFFBOARDED", label: "Technician offboarded — no future work" },
      OTHER,
    ],
  },
  VISIT_CHANGE_RECOVERY: {
    severity: "CRITICAL",
    // A visit cancel/reschedule left money, schedule, or the audit record in a
    // mixed state: a refund may have issued while the visit stayed scheduled, a
    // charge may be mid-flight, or the immutable change record didn't write.
    customerImpact:
      "An office visit cancel or reschedule didn't fully finish — the money, the schedule, the customer notice, or the audit record may not match.",
    ownerTeam: "FINANCE",
    externalAction: {
      mutation: "resumeVisitChange",
      label: "Resume visit change",
    },
    verified: [
      {
        id: "SETTLED",
        label: "Confirm the change is fully settled (money, schedule, notice, audit)",
        verifier: "VISIT_CHANGE_SETTLED",
      },
    ],
    manualReasons: [
      { code: "SETTLED_OFFLINE", label: "Settled with the customer offline" },
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
