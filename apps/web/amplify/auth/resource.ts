import { defineAuth } from "@aws-amplify/backend";
import { crmAdmin } from "../functions/crm-admin/resource";
import { postAuth } from "../functions/post-auth/resource";
import { stripeWebhook } from "../functions/stripe-webhook/resource";
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
    // GL-14: last successful sign-in, stamped by the post-auth trigger. Cognito
    // does not record a last-login natively, so the staff roster reads it here —
    // the one place that covers every staff role (OWNER/OFFICE/FINANCE/TECH)
    // without inventing a staff-profile table just to hold one timestamp.
    "custom:lastLoginAt": { dataType: "String", mutable: true },
  },
  groups: ["OWNER", "OFFICE", "FINANCE", "TECH", "CUSTOMER"],
  triggers: {
    postAuthentication: postAuth,
    // NOTE: the pre-token-generation trigger is wired in backend.ts, not here.
    // It must add email/name to the ACCESS token (Amplify signs AppSync with
    // it), which needs the V2 event contract that defineAuth.triggers does not
    // expose — backend.ts attaches it as a V2_0 trigger via a property override.
    defineAuthChallenge: defineChallenge,
    createAuthChallenge: createChallenge,
    verifyAuthChallengeResponse: verifyChallenge,
  },
  access: (allow) => [
    // setUserPassword is granted separately — the manageUsers bundle does not
    // include AdminSetUserPassword, and invites need it to move a new account
    // out of FORCE_CHANGE_PASSWORD (which blocks the magic-link custom flow).
    //
    // Offboarding (deactivateTechnician, revokePortalAccess/restorePortalAccess)
    // needs AdminDisableUser, AdminEnableUser, and AdminUserGlobalSignOut. All
    // three already ride inside `manageUsers` — verified against the Amplify
    // action→IAM map — and global sign-out has no granular action of its own, so
    // it can ONLY come from this bundle. No extra grant is added: manageUsers is
    // the grant that authorizes the offboarding calls.
    // listUsersInGroup is granted on top of the bundles above: the GL-14 staff
    // roster (staffRoster) and the last-owner guard (offboardStaff /
    // changeStaffRoles) enumerate a group's members, and ListUsersInGroup is
    // NOT part of manageUsers or manageGroupMembership — those cover Admin*Get
    // and add/remove, but not listing a group. Without this grant the roster is
    // blank and the last-owner check cannot count the owners it protects.
    allow
      .resource(crmAdmin)
      .to([
        "manageUsers",
        "manageGroups",
        "manageGroupMembership",
        "setUserPassword",
        "listUsersInGroup",
      ]),
    // Only verify writes user attributes now: it mints the link token on the
    // REQUEST_LINK answer and burns it on redemption. create issues the
    // challenge and touches nothing.
    allow.resource(verifyChallenge).to(["manageUsers"]),
    // post-auth stamps custom:lastLoginAt on every successful sign-in (GL-14
    // roster last-login). Only the granular updateUserAttributes action — it has
    // no reason to read, disable, or group-manage anyone.
    allow.resource(postAuth).to(["updateUserAttributes"]),
    // Portal provisioning at conversion (R41): finalizeBooking runs in the
    // Stripe webhook and creates the customer's portal login the moment a
    // booking converts them — same bundle as crm-admin's invite path, because
    // it is literally the same shared code (shared/portalProvision).
    allow
      .resource(stripeWebhook)
      .to([
        "manageUsers",
        "manageGroups",
        "manageGroupMembership",
        "setUserPassword",
      ]),
  ],
});
