import { defineFunction } from "@aws-amplify/backend";

/**
 * Cognito custom-auth triggers implementing magic-link sign-in. Users get a
 * single-use emailed link (on invite from crm-admin, or on demand from the
 * login screen) instead of temporary passwords.
 */
// resourceGroupName "auth": trigger functions must live in the auth stack to
// avoid circular dependencies between the auth/data/function nested stacks.
export const defineChallenge = defineFunction({
  name: "auth-define-challenge",
  entry: "./define.ts",
  resourceGroupName: "auth",
});

export const createChallenge = defineFunction({
  name: "auth-create-challenge",
  entry: "./create.ts",
  resourceGroupName: "auth",
});

export const verifyChallenge = defineFunction({
  name: "auth-verify-challenge",
  entry: "./verify.ts",
  resourceGroupName: "auth",
});
