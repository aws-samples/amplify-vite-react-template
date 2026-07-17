/**
 * GL-14 — the pure rules for staff identity and role membership, kept out of
 * the Cognito/handler plumbing so they can be reasoned about and unit-tested
 * without an AWS account. The handler supplies the facts it reads from Cognito
 * (who is an owner, which logins are enabled); these functions decide what is
 * allowed.
 */

/** The internal staff roles, in canonical display order. CUSTOMER is a portal
 *  role and is handled separately — it is never a "staff" role here. */
export const STAFF_ROLES = ["OWNER", "OFFICE", "FINANCE", "TECH"] as const;
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
