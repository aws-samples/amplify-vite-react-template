import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { VerifyAuthChallengeResponseTriggerHandler } from "aws-lambda";
import {
  AdminUpdateUserAttributesCommand,
  CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";

const cognito = new CognitoIdentityProviderClient();
const ses = new SESClient();

const LINK_TTL_MINUTES = 60;

/**
 * The answer a client gives when it wants a link rather than having one.
 * A real token is 43 characters of base64url from randomBytes(32), so the
 * sentinel can never collide with one.
 */
export const REQUEST_LINK_ANSWER = "REQUEST_LINK";

/**
 * VerifyAuthChallengeResponse for magic-link sign-in. The challenge answer
 * decides which leg runs — this trigger reliably receives the answer on
 * every RespondToAuthChallenge, which is why the request/redeem split lives
 * here and not on clientMetadata (Cognito never delivers InitiateAuth
 * metadata to CreateAuthChallenge; keying on it left the request leg
 * unreachable and the email silently unsent).
 *
 *   - REQUEST_LINK: mint a fresh single-use token, store its hash on the
 *     user, email the sign-in link — then fail the answer on purpose. The
 *     requesting session is a throwaway; the emailed link starts a new one.
 *   - anything else: treat it as a link token, check it against the stored
 *     hash in constant time, and burn it on success.
 */
export const handler: VerifyAuthChallengeResponseTriggerHandler = async (
  event
) => {
  const answer = event.request.challengeAnswer ?? "";

  if (answer === REQUEST_LINK_ANSWER) {
    await emailSignInLink(
      event.userPoolId,
      event.userName,
      event.request.userAttributes.email
    );
    event.response.answerCorrect = false;
    return event;
  }

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

async function emailSignInLink(
  userPoolId: string,
  userName: string,
  email: string
) {
  const token = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(token).digest("hex");
  const exp = String(Date.now() + LINK_TTL_MINUTES * 60_000);

  await cognito.send(
    new AdminUpdateUserAttributesCommand({
      UserPoolId: userPoolId,
      Username: userName,
      UserAttributes: [
        { Name: "custom:loginTokenHash", Value: hash },
        { Name: "custom:loginTokenExp", Value: exp },
      ],
    })
  );

  const crmUrl = process.env.CRM_APP_URL ?? "";
  const link = `${crmUrl}/welcome#email=${encodeURIComponent(email)}&token=${token}`;
  await ses.send(
    new SendEmailCommand({
      Source: process.env.SES_FROM_EMAIL,
      Destination: { ToAddresses: [email] },
      Message: {
        Subject: { Data: "Your BuzzKill sign-in link" },
        Body: {
          Html: {
            Data: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto">
  <h2 style="color:#176b2c">Sign in to BuzzKill</h2>
  <p>Tap the button below to sign in — no password needed. The link works once and expires in ${LINK_TTL_MINUTES} minutes.</p>
  <p style="margin:24px 0"><a href="${link}" style="background:#176b2c;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600">Sign in</a></p>
  <p style="color:#666;font-size:13px">If you didn't request this, you can ignore this email.</p>
</div>`,
          },
        },
      },
    })
  );

  // The one breadcrumb this flow leaves: today's defect was diagnosable only
  // by its absence from CloudTrail. No address in the log — userName is the
  // opaque Cognito sub.
  console.log(`magic-link email sent for user ${userName}`);
}
