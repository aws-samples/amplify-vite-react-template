import { defineFunction } from "@aws-amplify/backend";

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
 *
 * Cognito permissions come from the `access` grant in auth/resource.ts;
 * data access from `allow.resource()` in data/resource.ts.
 */
export const crmAdmin = defineFunction({
  name: "crm-admin",
  entry: "./handler.ts",
  timeoutSeconds: 60,
  resourceGroupName: "auth",
});
