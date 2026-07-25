import type { AppSyncIdentity, AppSyncIdentityCognito } from "aws-lambda";
import { dataClient } from "./dataClient";
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

/**
 * May this caller ACT for a customer (pay, book, change a payment method)?
 *
 * Three ways in, checked cheapest first:
 *  1. OWNER — staff.
 *  2. The portal user whose own dynamic cus-<id> group matches.
 *  3. A management-company GROUP login (grp-<groupId>) acting for one of its
 *     member properties.
 *
 * (3) is decided by the SAME rule AppSync uses for row-level reads: the
 * customer's own `accessGroups` stamp (cus-<id> + grp-<groupId>) is intersected
 * with the caller's token groups. Reading the row's live stamp — rather than
 * re-deriving membership or trusting a cus- list baked into the token — means a
 * property removed from a group loses the group's ability to act on it
 * IMMEDIATELY, with no re-issued token and no re-login.
 *
 * Only case (3) costs a read: owners and ordinary portal customers return on the
 * token alone, so the existing hot path is unchanged.
 */
export async function assertCanActForCustomer(
  identity: AppSyncIdentity | undefined | null,
  customerId: string
): Promise<void> {
  const groups = callerGroups(identity);
  if (groups.includes("OWNER") || groups.includes(cusGroup(customerId))) {
    return;
  }
  // Only a token that carries a group membership can possibly qualify — anything
  // else is refused without touching the database.
  const callerGrpGroups = groups.filter((g) => g.startsWith("grp-"));
  if (callerGrpGroups.length > 0) {
    const client = await dataClient();
    const { data: customer } = await client.models.Customer.get({
      id: customerId,
    });
    const stamped = (customer?.accessGroups ?? []).filter(
      (g): g is string => typeof g === "string"
    );
    if (stamped.some((g) => callerGrpGroups.includes(g))) return;
  }
  throw new Error("Not authorized for this customer");
}
