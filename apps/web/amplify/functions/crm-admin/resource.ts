import { defineFunction, secret } from "@aws-amplify/backend";

/**
 * Backs the OFFICE-only user/group administration mutations:
 *
 *   adminCreateUser   — provision Cognito logins for staff (OFFICE/TECH/
 *                       both) and customers (CUSTOMER + dynamic cus-/grp-
 *                       groups), link the created sub back to the Customer
 *                       or Technician record. Cognito emails the invite
 *                       with a temporary password.
 *   setCustomerGroup  — move a customer into/out of a CustomerGroup:
 *                       rewrites accessGroups on the customer and all child
 *                       records and fixes the portal user's Cognito group
 *                       membership, keeping group-wide visibility correct.
 *   deactivateCustomer — the whole customer offboarding in one action (GL-09):
 *                       cancel plan billing, sweep visits, END the portal login,
 *                       then flip INACTIVE. Lives here (not crm-billing) because
 *                       ending the login needs the Cognito pool credentials; the
 *                       Stripe secret below is what lets it also stop the money.
 *
 * Cognito permissions come from the `access` grant in auth/resource.ts;
 * data access from `allow.resource()` in data/resource.ts. STRIPE_SECRET_KEY is
 * wired exactly like crm-billing so the plan-cancel half of deactivation works.
 */
export const crmAdmin = defineFunction({
  name: "crm-admin",
  entry: "./handler.ts",
  timeoutSeconds: 60,
  resourceGroupName: "auth",
  environment: {
    STRIPE_SECRET_KEY: secret("STRIPE_SECRET_KEY"),
  },
});
