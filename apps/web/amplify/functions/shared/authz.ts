import type { AppSyncIdentity, AppSyncIdentityCognito } from "aws-lambda";
import { cusGroup } from "./dynamicGroups";

function cognitoIdentity(
  identity: AppSyncIdentity | undefined | null
): AppSyncIdentityCognito | null {
  if (identity && typeof identity === "object" && "sub" in identity) {
    return identity as AppSyncIdentityCognito;
  }
  return null;
}

export function callerGroups(
  identity: AppSyncIdentity | undefined | null
): string[] {
  return cognitoIdentity(identity)?.groups ?? [];
}

export function callerSub(
  identity: AppSyncIdentity | undefined | null
): string | null {
  return cognitoIdentity(identity)?.sub ?? null;
}

export function callerEmail(
  identity: AppSyncIdentity | undefined | null
): string | null {
  const cognito = cognitoIdentity(identity);
  const email = cognito?.claims?.email;
  if (typeof email === "string" && email.trim()) {
    return email.trim().toLowerCase();
  }
  return cognito?.username?.includes("@")
    ? cognito.username.trim().toLowerCase()
    : null;
}

/**
 * The signed-in staff member's display name, from the token's `name` claim
 * (staff logins set a Cognito `name` attribute — see portalProvision.ensureLogin).
 * Used where a record has to name the actual human who took an action — e.g. the
 * issuer printed on a service-report amendment — rather than a guessed name.
 * Null when the token carries no usable name; callers fall back to the email.
 */
export function callerName(
  identity: AppSyncIdentity | undefined | null
): string | null {
  const cognito = cognitoIdentity(identity);
  const name = cognito?.claims?.name;
  if (typeof name === "string" && name.trim()) return name.trim();
  const given = cognito?.claims?.given_name;
  const family = cognito?.claims?.family_name;
  const composed = [given, family]
    .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
    .join(" ")
    .trim();
  return composed || null;
}

/**
 * The staff roles were consolidated to OWNER + TECH: OFFICE and FINANCE folded
 * into OWNER, so all office and money-movement work is now the owner tier.
 * callerIsOffice/callerIsFinance are kept as names for the dozens of call sites
 * that read as "office work" or "finance work" — both now mean OWNER.
 */
export function callerIsOwner(
  identity: AppSyncIdentity | undefined | null
): boolean {
  return callerGroups(identity).includes("OWNER");
}

/** Day-to-day office work — now the owner tier (OFFICE folded into OWNER). */
export function callerIsOffice(
  identity: AppSyncIdentity | undefined | null
): boolean {
  return callerIsOwner(identity);
}

/** May move money: charges, subscription start/stop, invoice voids. Now the
 *  owner tier (FINANCE folded into OWNER). */
export function callerIsFinance(
  identity: AppSyncIdentity | undefined | null
): boolean {
  return callerIsOwner(identity);
}

export function assertOffice(
  identity: AppSyncIdentity | undefined | null
): void {
  if (!callerIsOffice(identity)) throw new Error("Owner role required");
}

const STAFF_GROUPS = ["OWNER", "TECH"];

/** Any internal staff member, as opposed to a portal customer. */
export function isStaff(groups: string[]): boolean {
  return groups.some((g) => STAFF_GROUPS.includes(g));
}

export function assertFinance(
  identity: AppSyncIdentity | undefined | null
): void {
  if (!callerIsFinance(identity)) {
    throw new Error(
      "Owner role required — this action moves money. Ask an owner."
    );
  }
}

export function assertOwner(
  identity: AppSyncIdentity | undefined | null
): void {
  if (!callerIsOwner(identity)) throw new Error("Owner role required");
}

/** An owner (staff), or the portal user whose dynamic cus-<id> group matches. */
export function assertCanActForCustomer(
  identity: AppSyncIdentity | undefined | null,
  customerId: string
): void {
  const groups = callerGroups(identity);
  if (groups.includes("OWNER") || groups.includes(cusGroup(customerId))) {
    return;
  }
  throw new Error("Not authorized for this customer");
}
