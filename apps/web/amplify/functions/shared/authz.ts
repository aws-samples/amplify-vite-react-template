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
 * OWNER is a superset of every staff role, so an owner never needs a second
 * login to do office or finance work.
 */
export function callerIsOwner(
  identity: AppSyncIdentity | undefined | null
): boolean {
  return callerGroups(identity).includes("OWNER");
}

export function callerIsOffice(
  identity: AppSyncIdentity | undefined | null
): boolean {
  const g = callerGroups(identity);
  return g.includes("OFFICE") || g.includes("OWNER");
}

/** May move money: charges, subscription start/stop, invoice voids. */
export function callerIsFinance(
  identity: AppSyncIdentity | undefined | null
): boolean {
  const g = callerGroups(identity);
  return g.includes("FINANCE") || g.includes("OWNER");
}

export function assertOffice(
  identity: AppSyncIdentity | undefined | null
): void {
  if (!callerIsOffice(identity)) throw new Error("Office role required");
}

const STAFF_GROUPS = ["OWNER", "OFFICE", "FINANCE", "TECH"];

/** Any internal staff member, as opposed to a portal customer. */
export function isStaff(groups: string[]): boolean {
  return groups.some((g) => STAFF_GROUPS.includes(g));
}

export function assertFinance(
  identity: AppSyncIdentity | undefined | null
): void {
  if (!callerIsFinance(identity)) {
    throw new Error(
      "Finance role required — this action moves money. Ask an owner, or someone with the finance role."
    );
  }
}

export function assertOwner(
  identity: AppSyncIdentity | undefined | null
): void {
  if (!callerIsOwner(identity)) throw new Error("Owner role required");
}

/** Office staff, or the portal user whose dynamic cus-<id> group matches. */
export function assertCanActForCustomer(
  identity: AppSyncIdentity | undefined | null,
  customerId: string
): void {
  const groups = callerGroups(identity);
  if (
    groups.includes("OFFICE") ||
    groups.includes("OWNER") ||
    groups.includes(cusGroup(customerId))
  ) {
    return;
  }
  throw new Error("Not authorized for this customer");
}
