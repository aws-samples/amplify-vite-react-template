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
 *   OWNER    — everything, including approvals and staff invites
 *   OFFICE   — day-to-day: leads, quotes, scheduling, plans. May NOT move
 *              money or invite staff.
 *   FINANCE  — money movement: charges, refunds, invoice voids
 *   TECH     — technicians (routes, jobs, service reports)
 *   CUSTOMER — portal users (their own records + their customer-group's)
 *
 * Roles are additive: a user who does office work and handles billing is a
 * member of both OFFICE and FINANCE. OWNER is a superset — every rule that
 * admits OFFICE or FINANCE also admits OWNER, so an owner never needs a
 * second login. "Both" office+tech users are simply members of both.
 *
 * Separation of duties: a manual charge above CHARGE_APPROVAL_THRESHOLD_CENTS
 * (crm-billing) requires an OWNER approver who is not the initiator. Approval
 * and role changes are recorded as AuditEvents.
 *
 * DEPLOY STEP: after this ships, add the owner's Cognito user to the OWNER
 * group by hand. Nothing else can invite staff, so skipping this locks
 * everyone out of provisioning new logins.
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
  groups: ["OWNER", "OFFICE", "FINANCE", "TECH", "CUSTOMER"],
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
    // Only verify writes user attributes now: it mints the link token on the
    // REQUEST_LINK answer and burns it on redemption. create issues the
    // challenge and touches nothing.
    allow.resource(verifyChallenge).to(["manageUsers"]),
  ],
});
