/**
 * GL-07 — the controlled reasons a visit cancel or reschedule can carry.
 *
 * A cancel/reschedule moves money, schedule, and a customer promise, and Ops and
 * Finance must be able to answer "why" from a fixed vocabulary in the exportable
 * history — not free text an employee typed under time pressure. Mirrors the
 * staff-access and lifecycle reason codes: a change with no reason, an off-list
 * reason, or a bare "Other" without a note is refused before anything is touched.
 */

export const VISIT_CANCEL_REASONS = [
  "CUSTOMER_REQUEST",
  "SCHEDULING_CONFLICT",
  "WEATHER",
  "TECH_UNAVAILABLE",
  "ACCESS_ISSUE",
  "DUPLICATE",
  "SERVICE_NOT_NEEDED",
  "OTHER",
] as const;

export const VISIT_RESCHEDULE_REASONS = [
  "CUSTOMER_REQUEST",
  "WEATHER",
  "TECH_UNAVAILABLE",
  "ROUTE_CHANGE",
  "ACCESS_ISSUE",
  "OTHER",
] as const;

export type VisitChangeAction = "CANCEL" | "RESCHEDULE";

function reasonsFor(action: VisitChangeAction): readonly string[] {
  return action === "CANCEL" ? VISIT_CANCEL_REASONS : VISIT_RESCHEDULE_REASONS;
}

/**
 * Validate the controlled reason for a visit change. Returns the normalized
 * reason code. Throws a fixable error if the code is missing, not on the
 * action's list, or is OTHER without an accompanying note — so a blank or
 * unexplained cancel/reschedule is refused before the money or the schedule is
 * touched.
 */
export function assertVisitChangeReason(
  action: VisitChangeAction,
  reasonCode: string | null | undefined,
  note: string | null | undefined
): string {
  const code = (reasonCode ?? "").trim().toUpperCase();
  const allowed = reasonsFor(action);
  if (!code) {
    throw new Error(
      `A reason is required to ${action === "CANCEL" ? "cancel" : "reschedule"} a visit. Choose one of: ${allowed.join(", ")}.`
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

/** The controlled reason folded into a human-readable phrase for the audit row. */
export function visitChangeReasonSummary(
  reasonCode: string,
  note: string | null | undefined
): string {
  const trimmed = (note ?? "").trim();
  return trimmed ? `${reasonCode} — ${trimmed}` : reasonCode;
}
