/** A format-valid EPA registration number, e.g. 432-1234 or 432-1234-4321. */
export const EPA_REGISTRATION_RE = /^\d{2,7}-\d{1,5}(-\d{1,7})?$/;

type TechnicianCompliance = {
  name?: string | null;
  active?: boolean | null;
  licenseNumber?: string | null;
  licenseExpiresOn?: string | null;
};

type ProductCompliance = {
  name?: string | null;
  active?: boolean | null;
  epaNumber?: string | null;
  defaultRate?: string | null;
  reEntryHours?: number | null;
  labelApproved?: boolean | null;
};

function isoDate(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || !/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  const parsed = new Date(`${trimmed}T00:00:00.000Z`);
  return Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== trimmed
    ? null
    : trimmed;
}

/**
 * An active technician is dispatchable. That status therefore means the
 * applicator certification is present and current, not merely that a checkbox
 * was ticked in a browser.
 */
export function assertTechnicianCompliance(
  technician: TechnicianCompliance,
  opts: { requireActive?: boolean; workDate?: string } = {}
): void {
  const name = technician.name?.trim() || "This technician";
  if (opts.requireActive && !technician.active) {
    throw new Error(`${name} is inactive and cannot be assigned regulated work`);
  }
  if (!technician.licenseNumber?.trim()) {
    throw new Error(`${name} needs an applicator license number`);
  }
  const expiresOn = isoDate(technician.licenseExpiresOn);
  if (!expiresOn) {
    throw new Error(`${name} needs the applicator license expiration date`);
  }
  const workDate = isoDate(opts.workDate) ?? new Date().toISOString().slice(0, 10);
  if (expiresOn < workDate) {
    throw new Error(
      `${name}'s applicator license expired on ${expiresOn} and is not valid for work on ${workDate}`
    );
  }
}

/** Inactive personnel records may remain for history; active ones must comply. */
export function assertTechnicianCanBeSaved(
  technician: TechnicianCompliance
): void {
  if (technician.active) {
    assertTechnicianCompliance(technician, { requireActive: true });
  }
}

/**
 * Inactive products may remain as catalog history. An active product is a
 * technician-facing label source, so every fact needed at application time
 * must have been reviewed and approved first.
 */
export function assertProductCanBeSaved(product: ProductCompliance): void {
  if (!product.active) return;
  const name = product.name?.trim() || "This product";
  if (!product.labelApproved) {
    throw new Error(`${name}'s label data must be reviewed and approved before activation`);
  }
  const epaNumber = product.epaNumber?.trim();
  if (!epaNumber) {
    throw new Error(`${name} needs its EPA registration number before activation`);
  }
  if (!EPA_REGISTRATION_RE.test(epaNumber)) {
    throw new Error(
      `“${epaNumber}” isn't a valid EPA registration number for ${name} — it looks like 432-1234`
    );
  }
  if (!product.defaultRate?.trim()) {
    throw new Error(`${name} needs the label application rate or dilution before activation`);
  }
  if (
    product.reEntryHours == null ||
    !Number.isFinite(product.reEntryHours) ||
    product.reEntryHours < 0
  ) {
    throw new Error(`${name} needs a valid label re-entry rule before activation`);
  }
}
