import { defineAuth } from "@aws-amplify/backend";
import { crmAdmin } from "../functions/crm-admin/resource";

/**
 * Shared auth for the marketing site and the CRM.
 *
 * Static groups map to BuzzKill roles:
 *   OFFICE   — office staff (full CRM access)
 *   TECH     — technicians (routes, jobs, service reports)
 *   CUSTOMER — portal users (their own records + their customer-group's)
 * "Both" office+tech users are simply members of OFFICE and TECH.
 *
 * Row-level customer visibility uses *dynamic* Cognito groups created at
 * runtime by the crm-admin function (`cus-<customerId>`, `grp-<groupId>`)
 * and matched against each record's `accessGroups` field.
 */
export const auth = defineAuth({
  loginWith: {
    email: true,
  },
  groups: ["OFFICE", "TECH", "CUSTOMER"],
  access: (allow) => [
    allow
      .resource(crmAdmin)
      .to(["manageUsers", "manageGroups", "manageGroupMembership"]),
  ],
});
