import { createContext, useContext } from "react";
import { fetchAuthSession } from "aws-amplify/auth";

/**
 * Who you are, from the only source that's actually enforced.
 *
 * Cognito groups (declared in amplify/auth/resource.ts) are what the backend
 * checks — `allow.groups(["ADMIN"])` on the team mutations. UserProfile.role
 * is a plain row any signed-in user can write, so it must never gate a screen;
 * it's a display mirror of the group, nothing more.
 */

export type Role = "ADMIN" | "STAFF" | "PRODUCER";

/**
 * The signed-in user's Cognito groups, read off the ID token.
 *
 * The claim is omitted entirely — not sent as an empty array — when the user
 * belongs to no group, and its payload type is loose enough that it has to be
 * narrowed rather than trusted. An expired or missing session resolves to no
 * groups (so the caller degrades to "no privileges") instead of throwing.
 */
export async function fetchUserGroups(): Promise<string[]> {
  try {
    const { tokens } = await fetchAuthSession();
    const claim = tokens?.idToken?.payload["cognito:groups"];
    if (!Array.isArray(claim)) return [];
    return claim.filter((g): g is string => typeof g === "string");
  } catch (err) {
    // Not admin — but a broken session shouldn't vanish from the console.
    console.error("Could not read Cognito groups:", err);
    return [];
  }
}

export function isAdminGroup(groups: string[]): boolean {
  return groups.includes("ADMIN");
}

/**
 * The role to record on UserProfile. Most-privileged group wins; someone in
 * no group is staff, which grants nothing beyond a signed-in session.
 */
export function roleFromGroups(groups: string[]): Role {
  if (groups.includes("ADMIN")) return "ADMIN";
  if (groups.includes("PRODUCER")) return "PRODUCER";
  return "STAFF";
}

/**
 * Admin status for the whole signed-in shell. Resolved once in ProfileGate,
 * alongside the profile fetch, so no screen renders before it's known.
 * Defaults to false: a consumer outside the provider is not an admin.
 */
export const AdminContext = createContext(false);

export function useIsAdmin(): boolean {
  return useContext(AdminContext);
}
