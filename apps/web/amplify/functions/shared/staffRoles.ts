/**
 * GL-14 — the pure rules for staff identity and role membership, kept out of
 * the Cognito/handler plumbing so they can be reasoned about and unit-tested
 * without an AWS account. The handler supplies the facts it reads from Cognito
 * (who is an owner, which logins are enabled); these functions decide what is
 * allowed.
 */

/** The internal staff roles, in canonical display order. Consolidated to two:
 *  OWNER (all office/finance/management work) and TECH (field). CUSTOMER is a
 *  portal role and is handled separately — it is never a "staff" role here. */
export const STAFF_ROLES = ["OWNER", "TECH"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export function isStaffRole(role: string): role is StaffRole {
  return (STAFF_ROLES as readonly string[]).includes(role);
}

/**
 * Normalize a caller-supplied role list: trim, upper-case, drop blanks, dedupe.
 * Order-preserving on first occurrence. Does not validate — pair with
 * assertValidRoleSet when the list must be legal.
 */
export function normalizeRoles(roles: string[]): string[] {
  return [...new Set(roles.map((r) => r.trim().toUpperCase()).filter(Boolean))];
}

/** The staff roles present in a (already normalized) list, in canonical order. */
export function staffRolesIn(roles: string[]): StaffRole[] {
  return STAFF_ROLES.filter((r) => roles.includes(r));
}

/**
 * Reject anything that is not a known role. CUSTOMER is allowed (adminCreateUser
 * provisions portal logins too); every other non-staff string is a typo or an
 * attempt to mint a group that means nothing, and is refused with the list of
 * what is valid so the caller can fix it.
 */
export function assertValidRoleSet(roles: string[]): void {
  const invalid = roles.filter((r) => r !== "CUSTOMER" && !isStaffRole(r));
  if (invalid.length) {
    throw new Error(
      `Unknown role${invalid.length > 1 ? "s" : ""}: ${invalid.join(
        ", "
      )}. Valid roles are ${STAFF_ROLES.join(", ")} (or CUSTOMER for a portal login).`
    );
  }
}

/**
 * GL-14 — the controlled reasons a role change or offboarding may cite. A staff
 * access change must carry an approved reason from a fixed list, never optional
 * free text: "why did this person's access change" has to be answerable the same
 * way every time, and a blank or invented reason is exactly what the audit is
 * there to prevent. OTHER exists as an escape hatch but demands a written note,
 * so it is never a way to skip the explanation.
 */
export const STAFF_ROLE_CHANGE_REASONS = [
  "PROMOTION",
  "REASSIGNMENT",
  "REDUCE_ACCESS",
  "CORRECTION",
  "OTHER",
] as const;

export const STAFF_OFFBOARD_REASONS = [
  "DEPARTURE_VOLUNTARY",
  "DEPARTURE_INVOLUNTARY",
  "ROLE_ENDED",
  "SECURITY",
  "OTHER",
] as const;

export type StaffAccessAction = "CHANGE_ROLES" | "OFFBOARD";

function reasonsFor(action: StaffAccessAction): readonly string[] {
  return action === "OFFBOARD"
    ? STAFF_OFFBOARD_REASONS
    : STAFF_ROLE_CHANGE_REASONS;
}

/**
 * Validate the controlled reason for a staff-access change. Returns the
 * normalized reason code. Throws a fixable error if the code is missing, not on
 * the action's list, or is OTHER without an accompanying note — so a blank or
 * unexplained access change is refused before anything is touched.
 */
export function assertReasonCode(
  action: StaffAccessAction,
  reasonCode: string | null | undefined,
  note: string | null | undefined
): string {
  const code = (reasonCode ?? "").trim().toUpperCase();
  const allowed = reasonsFor(action);
  if (!code) {
    throw new Error(
      `A reason is required. Choose one of: ${allowed.join(", ")}.`
    );
  }
  if (!allowed.includes(code)) {
    throw new Error(
      `"${reasonCode}" isn't a valid reason for this action. Choose one of: ${allowed.join(", ")}.`
    );
  }
  if (code === "OTHER" && !(note ?? "").trim()) {
    throw new Error(
      "Choosing 'Other' needs a short written note saying why."
    );
  }
  return code;
}

/**
 * The system must never be left without a usable owner — an owner is the only
 * role that can invite staff, approve charges, and change roles, so losing the
 * last one locks the business out of its own administration. A login counts as
 * a usable owner only if it is enabled AND still in the OWNER group after the
 * change; this single guard covers both offboarding (the target keeps nothing)
 * and a role change that drops OWNER.
 *
 * `otherUsableOwners` is the number of OTHER logins that are enabled and in the
 * OWNER group right now. The handler computes it from Cognito — only it can see
 * the pool — and passes it here so the decision itself stays pure.
 */
export function assertOwnerRemains(opts: {
  targetLabel: string;
  otherUsableOwners: number;
  targetKeepsOwner: boolean;
}): void {
  if (opts.targetKeepsOwner || opts.otherUsableOwners > 0) return;
  throw new Error(
    `${opts.targetLabel} is the last active owner. This would leave BuzzKill with no one who can invite staff, approve charges, or change roles. Promote a second owner first, then retry — the launch bar is at least two named owners.`
  );
}
