import { defineAuth } from "@aws-amplify/backend";
import { crmAdmin } from "../functions/crm-admin/resource";
import { postAuth } from "../functions/post-auth/resource";
import {
  createChallenge,
  defineChallenge,
  verifyChallenge,
} from "../functions/auth-challenge/resource";

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
 *
 * Sign-in: password (SRP) or emailed magic link (custom auth flow — the
 * auth-challenge triggers). Invites send a magic link, not a temp password;
 * `custom:loginTokenHash/Exp` hold the pending single-use link token.
 */
export const auth = defineAuth({
  loginWith: {
    email: true,
  },
  userAttributes: {
    "custom:loginTokenHash": { dataType: "String", mutable: true },
    "custom:loginTokenExp": { dataType: "String", mutable: true },
  },
  groups: ["OFFICE", "TECH", "CUSTOMER"],
  triggers: {
    postAuthentication: postAuth,
    defineAuthChallenge: defineChallenge,
    createAuthChallenge: createChallenge,
    verifyAuthChallengeResponse: verifyChallenge,
  },
  access: (allow) => [
    allow
      .resource(crmAdmin)
      .to(["manageUsers", "manageGroups", "manageGroupMembership"]),
    allow.resource(createChallenge).to(["manageUsers"]),
    allow.resource(verifyChallenge).to(["manageUsers"]),
  ],
});
