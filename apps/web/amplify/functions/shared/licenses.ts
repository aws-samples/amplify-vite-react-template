import { dataClient } from "./dataClient";
import { hasCurrentLicense } from "./compliance";

/**
 * GL-17 — one-to-many licence records, and THE single answer to "is this
 * technician licensed on this date". Rules:
 *
 *  - When a technician has ANY TechnicianLicense records, the records are the
 *    only authority (Compliance controls their status). The legacy
 *    Technician.licenseNumber/licenseExpiresOn fields are consulted only for
 *    technicians with zero records — the migration fallback.
 *  - "Current now / on a work date": a record whose status is CURRENT and
 *    whose expiration is on-or-after the date.
 *  - "Valid on a historical date" (report authorship): a CURRENT or EXPIRED
 *    record that had not yet expired on that date — a later renewal or expiry
 *    never rewrites who was licensed when the application happened. REVOKED
 *    records never validate anything.
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
  source: "RECORDS" | "LEGACY";
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

/** Which record (if any) was VALID on a historical date — for authorship. */
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
  return { number: valid[0]?.number ?? technician.licenseNumber ?? null };
}

/** Load a technician's licence records. Empty on any read failure — the caller
 *  then falls back to legacy fields, which errs toward the old behavior rather
 *  than locking the field out on an outage. */
export async function licenseRecordsFor(
  technicianId: string
): Promise<LicenseRecordLike[]> {
  try {
    const client = await dataClient();
    if (!("TechnicianLicense" in client.models)) return [];
    const out: LicenseRecordLike[] = [];
    let token: string | null | undefined;
    do {
      const page =
        await client.models.TechnicianLicense.listTechnicianLicenseByTechnicianId(
          { technicianId },
          { limit: 100, nextToken: token }
        );
      out.push(...((page.data ?? []) as LicenseRecordLike[]));
      token = page.nextToken;
    } while (token);
    return out;
  } catch (err) {
    console.error("licenseRecordsFor failed", technicianId, err);
    return [];
  }
}

/** The one call every enforcement point uses: is this technician licensed on
 *  `onDate` (default today), and under which number? */
export async function licenseFactsFor(
  technician: TechnicianLike,
  onDate?: string
): Promise<LicenseFacts> {
  const records = await licenseRecordsFor(technician.id);
  return licenseFactsFromRecords(records, technician, onDate);
}
