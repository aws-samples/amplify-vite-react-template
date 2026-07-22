import type { DefineAuthChallengeTriggerHandler } from "aws-lambda";

/**
 * Magic-link sign-in (custom auth flow): always present one CUSTOM_CHALLENGE;
 * a correct answer (the link token) issues tokens, anything else fails after
 * the first wrong answer — links are single-use secrets, not guessable codes.
 */
export const handler: DefineAuthChallengeTriggerHandler = async (event) => {
  const session = event.request.session ?? [];
  const last = session[session.length - 1];

  if (last?.challengeName === "CUSTOM_CHALLENGE" && last.challengeResult) {
    event.response.issueTokens = true;
    event.response.failAuthentication = false;
  } else if (last?.challengeName === "CUSTOM_CHALLENGE" && !last.challengeResult) {
    event.response.issueTokens = false;
    event.response.failAuthentication = true;
  } else {
    event.response.issueTokens = false;
    event.response.failAuthentication = false;
    event.response.challengeName = "CUSTOM_CHALLENGE";
  }
  return event;
};
