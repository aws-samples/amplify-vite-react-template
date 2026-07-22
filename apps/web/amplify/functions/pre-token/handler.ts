import type { PreTokenGenerationV2TriggerHandler } from "aws-lambda";

/**
 * Copy `email` and `name` from the user's attributes into the ACCESS token.
 *
 * Amplify's Data client signs AppSync requests with the Cognito access token,
 * which natively carries `sub`, `cognito:groups`, and `username` but not
 * `email`/`name`. The CRM's Lambda resolvers stamp the acting human on records
 * (lead owner, do-not-contact decider, service-report amendment issuer) from
 * `event.identity.claims`, so without these claims the actor's email is null
 * and the audit trail degrades to a system actor or the raw sub.
 *
 * Only V2+ pre-token generation can add claims to the access token, so this is
 * wired as a V2_0 trigger (see backend.ts). We add nothing when the attribute
 * is absent — an empty override is a no-op, never a written empty string.
 */
export const handler: PreTokenGenerationV2TriggerHandler = async (event) => {
  const attrs = event.request.userAttributes ?? {};
  const claimsToAddOrOverride: Record<string, string> = {};
  if (attrs.email) claimsToAddOrOverride.email = attrs.email;
  if (attrs.name) claimsToAddOrOverride.name = attrs.name;

  event.response.claimsAndScopeOverrideDetails = {
    accessTokenGeneration: { claimsToAddOrOverride },
  };
  return event;
};
