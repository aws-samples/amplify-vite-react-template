/**
 * The defined set of administrative job types the office may complete WITHOUT
 * a technician's finalized report.
 *
 * Field and pesticide work is never here: its completion IS the tech's
 * finalized service report, which is the legal pesticide application record.
 * Office-completing such a job would mark it done with no record behind it —
 * the exact editable-regulatory-gap the report immutability work closed,
 * reopened from the office side.
 *
 * Empty today: no administrative job type is defined, so every job completes
 * via a finalized report. Add an exact serviceType here to make that one type
 * office-completable — and it takes effect on both sides at once, because
 * crm-docs (which enforces the rule in completeJob) and the CRM (which hides
 * the "✓ Complete" button) both read THIS set. Hiding the button is a
 * courtesy; the server is the guarantee.
 *
 * A pure leaf with no imports, so the CRM can value-import it into the
 * browser bundle.
 */

/** Trim + lower-case, so a free-text label matches a stored type. */
function normalize(serviceType: string | null | undefined): string {
  return (serviceType ?? "").trim().toLowerCase();
}

/** Stored normalized. Empty today — see the module note before adding one. */
export const ADMIN_JOB_SERVICE_TYPES: ReadonlySet<string> = new Set<string>([]);

/**
 * Whether the office may complete this job itself. Matches case-insensitively
 * and trimmed on both sides; a missing or blank serviceType never matches.
 *
 * `adminTypes` is injectable so a test can pin the boundary without a defined
 * type existing yet; every caller in the tree uses the default.
 */
export function isOfficeCompletableServiceType(
  serviceType: string | null | undefined,
  adminTypes: Iterable<string> = ADMIN_JOB_SERVICE_TYPES
): boolean {
  const st = normalize(serviceType);
  if (st === "") return false;
  for (const t of adminTypes) {
    if (normalize(t) === st) return true;
  }
  return false;
}
