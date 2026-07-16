import type { CreateAuthChallengeTriggerHandler } from "aws-lambda";

/**
 * CreateAuthChallenge for magic-link sign-in: always present one
 * CUSTOM_CHALLENGE and do nothing else.
 *
 * The real work happens in VerifyAuthChallengeResponse, keyed off the
 * challenge answer itself — the REQUEST_LINK sentinel mints and emails a
 * link; anything else is checked as a link token. It used to live here,
 * switched by clientMetadata.mode, but Cognito only forwards ClientMetadata
 * from RespondToAuthChallenge to this trigger — the metadata on an
 * InitiateAuth call never arrives, so the "request" branch was unreachable
 * and the sign-in email silently never sent.
 */
export const handler: CreateAuthChallengeTriggerHandler = async (event) => {
  event.response.publicChallengeParameters = { challenge: "MAGIC_LINK" };
  event.response.privateChallengeParameters = {};
  event.response.challengeMetadata = "MAGIC_LINK";
  return event;
};
