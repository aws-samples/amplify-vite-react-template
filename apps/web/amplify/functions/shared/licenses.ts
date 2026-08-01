import { dataClient } from "./dataClient";
import { hasCurrentLicense } from "./compliance";
import { listAll } from "./pagination";

/**
 * GL-17 — one-to-many licence records, and THE single answer to "is this
 * technician licensed on this date". Rules:
 *
 *  - When a technician has ANY TechnicianLicense records, the records are the
 *    only authority (Compliance controls their status). The legacy
 *    Technician.licenseNumber/licenseExpiresOn fields are consulted only for
 *    technicians with zero records — the migration fallback.
 *  - A licence-record READ FAILURE fails CLOSED: the technician reads as not
 *    currently licensed (source ERROR), never as whatever the legacy fields
 *    say — an outage must not resurrect a revoked number or hide a lapse.
 *  - "Current now / on a work date": a record whose status is CURRENT and
 *    whose expiration is on-or-after the date.
 *  - "Valid on a historical date" (report authorship): a CURRENT or EXPIRED
 *    record that had not yet expired on that date — a later renewal or expiry
 *    never rewrites who was licensed when the application happened. REVOKED
 *    records never validate anything, and once records exist the legacy
 *    number is never consulted — a revoked/invalid history cannot fall back
 *    to a stale single field.
 */

export type LicenseRecordLike = {
  id?: string;
  number?: string | null;
  status?: string | null;
  expiresOn?: string | null;
  licenseType?: string | null;
  issuer?: string | null;
};

export type LicenseFacts = {
  current: boolean;
  number: string | null;
  expiresOn: string | null;
  /** RECORDS — the one-to-many records decided; LEGACY — zero records, the
   *  migration single-fields decided; ERROR — the records could NOT be read,
   *  and the answer failed closed (current: false). */
  source: "RECORDS" | "LEGACY" | "ERROR";
};

type TechnicianLike = {
  id: string;
  licenseNumber?: string | null;
  licenseExpiresOn?: string | null;
};

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Pure record-set evaluation, unit-testable without a client. */
export function licenseFactsFromRecords(
  records: LicenseRecordLike[],
  technician: TechnicianLike,
  onDate?: string
): LicenseFacts {
  const date = onDate ?? today();
  if (records.length === 0) {
    // Migration fallback: zero records — the legacy single fields decide.
    return {
      current: hasCurrentLicense(technician, date),
      number: technician.licenseNumber ?? null,
      expiresOn: technician.licenseExpiresOn ?? null,
      source: "LEGACY",
    };
  }
  const usable = records.filter(
    (r) =>
      r.status === "CURRENT" && (!r.expiresOn || r.expiresOn >= date)
  );
  // Prefer the record that lasts longest — the one dispatch can rely on.
  usable.sort((a, b) => (b.expiresOn ?? "9999").localeCompare(a.expiresOn ?? "9999"));
  const best = usable[0] ?? null;
  return {
    current: Boolean(best),
    number: best?.number ?? null,
    expiresOn: best?.expiresOn ?? null,
    source: "RECORDS",
  };
}

/** Which record (if any) was VALID on a historical date — for authorship.
 *  Once ANY records exist they are the only authority: no valid record on
 *  that date means NO number, never the legacy single field (which may be
 *  the very number Compliance revoked). */
export function licenseValidOnDate(
  records: LicenseRecordLike[],
  technician: TechnicianLike,
  onDate: string
): { number: string | null } {
  if (records.length === 0) {
    return { number: technician.licenseNumber ?? null };
  }
  const valid = records.filter(
    (r) =>
      (r.status === "CURRENT" || r.status === "EXPIRED") &&
      (!r.expiresOn || r.expiresOn >= onDate)
  );
  valid.sort((a, b) => (b.expiresOn ?? "9999").localeCompare(a.expiresOn ?? "9999"));
  return { number: valid[0]?.number ?? null };
}

/** Load a technician's licence records. NULL on any read failure — the caller
 *  must fail CLOSED (treat as unlicensed), never fall back to the legacy
 *  fields, which an outage could use to resurrect a revoked number. */
export async function licenseRecordsFor(
  technicianId: string
): Promise<LicenseRecordLike[] | null> {
  try {
    const client = await dataClient();
    if (!("TechnicianLicense" in client.models)) return [];
    return (await listAll(
      (nextToken) =>
        client.models.TechnicianLicense.listTechnicianLicenseByTechnicianId(
          { technicianId },
          { limit: 100, nextToken }
        ),
      { pageErrors: "ignore" }
    )) as LicenseRecordLike[];
  } catch (err) {
    console.error("licenseRecordsFor failed", technicianId, err);
    return null;
  }
}

/** The one call every enforcement point uses: is this technician licensed on
 *  `onDate` (default today), and under which number? A records read failure
 *  fails CLOSED: current=false, source ERROR. */
export async function licenseFactsFor(
  technician: TechnicianLike,
  onDate?: string
): Promise<LicenseFacts> {
  const records = await licenseRecordsFor(technician.id);
  if (records === null) {
    return { current: false, number: null, expiresOn: null, source: "ERROR" };
  }
  return licenseFactsFromRecords(records, technician, onDate);
}
