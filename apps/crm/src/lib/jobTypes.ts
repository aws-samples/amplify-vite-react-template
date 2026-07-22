/**
 * The defined set of administrative job types the office may complete
 * WITHOUT a technician's finalized report.
 *
 * Field and pesticide work is never here: its completion is the tech's
 * finalized service report, which is the legal pesticide application
 * record. So the office "✓ Complete" button shows only for a job whose
 * serviceType is in this set — everything else must go through the tech's
 * report. The server enforces the same rule in completeJob, so hiding the
 * button is a courtesy, not the guarantee.
 *
 * Empty today: no administrative job type is defined, so no job is
 * office-completable. Add an exact serviceType string here to make that one
 * type office-completable. KEEP IN SYNC with
 * apps/web/amplify/functions/crm-docs/handler.ts (ADMIN_JOB_SERVICE_TYPES).
 */
export const ADMIN_JOB_SERVICE_TYPES: readonly string[] = [];

/** Matches case-insensitively and trimmed, mirroring the server. */
export function isOfficeCompletableServiceType(
  serviceType: string | null | undefined,
  adminTypes: readonly string[] = ADMIN_JOB_SERVICE_TYPES
): boolean {
  const st = (serviceType ?? "").trim().toLowerCase();
  return st !== "" && adminTypes.some((t) => t.trim().toLowerCase() === st);
}
