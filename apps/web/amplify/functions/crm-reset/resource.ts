import { defineFunction } from "@aws-amplify/backend";

/**
 * Backs the staging-only "Danger Zone" databaseReset mutation (one field,
 * dispatched on `action` — each Lambda-backed op costs 6 CloudFormation
 * resources in FunctionDirectiveStack, which is at the 500 ceiling):
 *
 *   action "WIPE"     — snapshot every model to S3, record a DatabaseArchive
 *                       manifest, then delete every record ("clean start").
 *   action "ROLLBACK" — restore the whole database from a chosen archive's
 *                       snapshot (kept 30 days).
 *
 * Data access comes from `allow.resource(crmReset)` in data/resource.ts; the
 * S3 archive bucket and the branch guard (AMPLIFY_BRANCH) are wired in
 * backend.ts. The handler refuses to run unless AMPLIFY_BRANCH is a known
 * non-production branch (fail-closed), so this can only ever wipe staging.
 * Timeout is generous because a full snapshot + delete touches every table.
 */
export const crmReset = defineFunction({
  name: "crm-reset",
  entry: "./handler.ts",
  timeoutSeconds: 900,
  memoryMB: 1024,
});
