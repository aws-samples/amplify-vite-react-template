import { defineFunction } from "@aws-amplify/backend";

/**
 * Cognito custom-auth triggers implementing magic-link sign-in. Users get a
 * single-use emailed link (on invite from crm-admin, or on demand from the
 * login screen) instead of temporary passwords.
 */
export const defineChallenge = defineFunction({
  name: "auth-define-challenge",
  entry: "./define.ts",
});

export const createChallenge = defineFunction({
  name: "auth-create-challenge",
  entry: "./create.ts",
});

export const verifyChallenge = defineFunction({
  name: "auth-verify-challenge",
  entry: "./verify.ts",
});
