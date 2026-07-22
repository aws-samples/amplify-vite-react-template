import type { AppSyncResolverEvent } from "aws-lambda";
import { callerIsOwner } from "../shared/authz";
import { rollbackDatabase, wipeDatabase } from "../shared/databaseReset";

/**
 * Danger Zone resolver — staging-only database wipe + rollback behind ONE
 * mutation field (databaseReset), dispatched on the `action` argument. One
 * field, not two: each Lambda-backed op costs 6 CloudFormation resources in
 * FunctionDirectiveStack, which is at the 500-resource ceiling. Every guard
 * that keeps this off production lives in shared/databaseReset (see that
 * file's header); here we add the server-side OWNER check that mirrors the
 * OWNER-only mutation authorization.
 */
type ResetArgs = {
  action: string;
  label?: string | null;
  archiveId?: string | null;
};

export const handler = async (event: AppSyncResolverEvent<ResetArgs>) => {
  if (!callerIsOwner(event.identity)) {
    throw new Error("Only owners can reset the database");
  }

  const { action, label, archiveId } = event.arguments;
  switch (action) {
    case "WIPE":
      return wipeDatabase(label ?? null);
    case "ROLLBACK":
      return rollbackDatabase(String(archiveId ?? ""));
    default:
      throw new Error(`Unknown databaseReset action "${action}"`);
  }
};
