import type { PostAuthenticationTriggerHandler } from "aws-lambda";
import {
  AdminUpdateUserAttributesCommand,
  CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import { dataClient } from "../shared/dataClient";
import { openOwnedWork } from "../shared/ownedWork";

const cognito = new CognitoIdentityProviderClient();

/**
 * Stamp custom:lastLoginAt on the just-authenticated user. Cognito has no native
 * last-login, and this is the one hook every staff role passes through, so it is
 * where the GL-14 roster's "last login" comes from. Stamped for every login
 * (staff and portal alike — the roster only reads it for staff); its own
 * try/catch so a failed stamp never blocks the sign-in and never opens ops work
 * over a cosmetic timestamp.
 */
async function stampLastLogin(userPoolId: string, username: string) {
  try {
    await cognito.send(
      new AdminUpdateUserAttributesCommand({
        UserPoolId: userPoolId,
        Username: username,
        UserAttributes: [
          { Name: "custom:lastLoginAt", Value: new Date().toISOString() },
        ],
      })
    );
  } catch (err) {
    console.error("post-auth last-login stamp failed", err);
  }
}

export const handler: PostAuthenticationTriggerHandler = async (event) => {
  await stampLastLogin(event.userPoolId, event.userName);
  try {
    const sub = event.request.userAttributes?.sub;
    if (sub) {
      const client = await dataClient();
      // Zero-page read is deliberate: one portal login sub maps to one customer, so one page holds every match (audit 1.1.5).
      const { data: customers } =
        await client.models.Customer.listCustomerByPortalUserSub({
          portalUserSub: sub,
        });
      const customer = customers[0];
      if (customer) {
        await client.models.Customer.update({
          id: customer.id,
          portalLastLoginAt: new Date().toISOString(),
        });
      }
    }
  } catch (err) {
    // A failed stamp must never block a login.
    console.error("post-auth login stamp failed", err);
    const sub = event.request.userAttributes?.sub;
    await openOwnedWork({
      kind: "PORTAL_FAILURE",
      dedupeKey: `post-auth:${sub ?? event.userName}`,
      title: "Portal login bookkeeping failed",
      detail: err instanceof Error ? err.message : String(err),
      relatedId: sub ?? event.userName,
      sourceUrl: "/work",
      resolutionAction:
        "Verify the portal user can sign in and see the correct records, then repair the customer login linkage or data permissions.",
      ownerTeam: "OPS",
    });
  }
  return event;
};
