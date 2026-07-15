import { createHash, randomBytes } from "node:crypto";
import type { CreateAuthChallengeTriggerHandler } from "aws-lambda";
import {
  AdminUpdateUserAttributesCommand,
  CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";

const cognito = new CognitoIdentityProviderClient();
const ses = new SESClient();

const LINK_TTL_MINUTES = 60;

/**
 * CreateAuthChallenge for magic-link sign-in. Two modes, chosen by the
 * client via clientMetadata.mode:
 *   - "request": mint a fresh single-use token, store its hash on the user,
 *     and email the sign-in link. The client abandons this session.
 *   - "redeem" (default): no side effects — the client answers with the
 *     token from the link and VerifyAuthChallengeResponse checks it.
 */
export const handler: CreateAuthChallengeTriggerHandler = async (event) => {
  const mode = event.request.clientMetadata?.mode ?? "redeem";

  if (mode === "request") {
    const email = event.request.userAttributes.email;
    const token = randomBytes(32).toString("base64url");
    const hash = createHash("sha256").update(token).digest("hex");
    const exp = String(Date.now() + LINK_TTL_MINUTES * 60_000);

    await cognito.send(
      new AdminUpdateUserAttributesCommand({
        UserPoolId: event.userPoolId,
        Username: event.userName,
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
  }

  // Never expose secrets; the client only needs to know which mode ran.
  event.response.publicChallengeParameters = { mode };
  event.response.privateChallengeParameters = { mode };
  event.response.challengeMetadata = `MAGIC_LINK_${mode.toUpperCase()}`;
  return event;
};
