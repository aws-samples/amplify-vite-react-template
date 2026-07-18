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
