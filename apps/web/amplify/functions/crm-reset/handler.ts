import type { AppSyncResolverEvent } from "aws-lambda";
import { callerIsOwner } from "../shared/authz";
import { opFieldName } from "../shared/opEvent";
import { rollbackDatabase, wipeDatabase } from "../shared/databaseReset";

/**
 * Danger Zone resolver — staging-only database wipe + rollback. Every guard
 * that keeps this off production lives in shared/databaseReset (see that file's
 * header); here we add the server-side OWNER check that mirrors the OWNER-only
 * mutation authorization.
 */
type WipeArgs = { label?: string | null };
type RollbackArgs = { archiveId: string };

export const handler = async (
  event: AppSyncResolverEvent<WipeArgs | RollbackArgs>
) => {
  if (!callerIsOwner(event.identity)) {
    throw new Error("Only owners can reset the database");
  }

  switch (opFieldName(event)) {
    case "wipeDatabase": {
      const args = event.arguments as WipeArgs;
      return wipeDatabase(args.label ?? null);
    }
    case "rollbackDatabase": {
      const args = event.arguments as RollbackArgs;
      return rollbackDatabase(String(args.archiveId ?? ""));
    }
    default:
      throw new Error(`Unknown field ${opFieldName(event)}`);
  }
};
