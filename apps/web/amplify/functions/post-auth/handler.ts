import type { PostAuthenticationTriggerHandler } from "aws-lambda";
import { dataClient } from "../shared/dataClient";
import { openOwnedWork } from "../shared/ownedWork";

export const handler: PostAuthenticationTriggerHandler = async (event) => {
  try {
    const sub = event.request.userAttributes?.sub;
    if (sub) {
      const client = await dataClient();
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
