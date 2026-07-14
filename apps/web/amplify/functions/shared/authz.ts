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

export function callerIsOffice(
  identity: AppSyncIdentity | undefined | null
): boolean {
  return callerGroups(identity).includes("OFFICE");
}

/** Office staff, or the portal user whose dynamic cus-<id> group matches. */
export function assertCanActForCustomer(
  identity: AppSyncIdentity | undefined | null,
  customerId: string
): void {
  const groups = callerGroups(identity);
  if (groups.includes("OFFICE") || groups.includes(cusGroup(customerId))) {
    return;
  }
  throw new Error("Not authorized for this customer");
}
