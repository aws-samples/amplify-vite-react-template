import { defineFunction } from "@aws-amplify/backend";

/**
 * Cognito PreTokenGeneration trigger. Amplify's Data client authenticates
 * AppSync with the Cognito ACCESS token, which — unlike the id token — carries
 * no `email` or `name` claim. Every Lambda resolver reads the acting human from
 * `event.identity.claims` (see shared/authz `callerEmail`/`callerName`), so
 * without this the actor's email is null for a UUID-username login and records
 * fall back to a system actor / the raw sub.
 *
 * This copies `email` and `name` from the user's attributes into the access
 * token so the CRM's audit trail names the real person. It requires the V2
 * trigger event (only V2 can add claims to the access token); backend.ts pins
 * the pre-token config to V2_0.
 */
export const preToken = defineFunction({
  name: "pre-token",
  entry: "./handler.ts",
  // Auth triggers must live in the auth stack to avoid a circular dependency
  // between the auth/data/function nested stacks.
  resourceGroupName: "auth",
});
