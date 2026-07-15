import type { PostAuthenticationTriggerHandler } from "aws-lambda";
import { dataClient } from "../shared/dataClient";

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
  }
  return event;
};
