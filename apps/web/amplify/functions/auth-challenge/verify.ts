import { createHash, timingSafeEqual } from "node:crypto";
import type { VerifyAuthChallengeResponseTriggerHandler } from "aws-lambda";
import {
  AdminUpdateUserAttributesCommand,
  CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";

const cognito = new CognitoIdentityProviderClient();

/** Check the magic-link token against the stored hash; clear it on success. */
export const handler: VerifyAuthChallengeResponseTriggerHandler = async (
  event
) => {
  const answer = event.request.challengeAnswer ?? "";
  const storedHash = event.request.userAttributes["custom:loginTokenHash"];
  const exp = Number(event.request.userAttributes["custom:loginTokenExp"] ?? 0);

  let ok = false;
  if (answer && storedHash && exp > Date.now()) {
    const answerHash = createHash("sha256").update(answer).digest("hex");
    const a = Buffer.from(answerHash, "hex");
    const b = Buffer.from(storedHash, "hex");
    ok = a.length === b.length && timingSafeEqual(a, b);
  }

  if (ok) {
    // Single use: burn the token.
    await cognito.send(
      new AdminUpdateUserAttributesCommand({
        UserPoolId: event.userPoolId,
        Username: event.userName,
        UserAttributes: [
          { Name: "custom:loginTokenHash", Value: "" },
          { Name: "custom:loginTokenExp", Value: "0" },
        ],
      })
    );
  }

  event.response.answerCorrect = ok;
  return event;
};
