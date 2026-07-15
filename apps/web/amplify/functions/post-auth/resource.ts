import { defineFunction } from "@aws-amplify/backend";

/**
 * Cognito PostAuthentication trigger: stamps portalLastLoginAt on the
 * Customer record so the CRM can show "Active" (has logged in) instead of
 * "Invited" for portal users. Never blocks a login — errors are swallowed.
 */
export const postAuth = defineFunction({
  name: "post-auth",
  entry: "./handler.ts",
});
