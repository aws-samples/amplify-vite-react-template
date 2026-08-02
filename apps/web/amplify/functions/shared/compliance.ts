import { todayEastern } from "./dates";

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
  const workDate = isoDate(opts.workDate) ?? todayEastern();
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
 * Non-throwing licence predicate (GL-13): does this technician hold a current
 * applicator licence on `onDate` (default today)? This is THE single point that
 * decides licence currency for read-scoping — when GL-17 introduces
 * one-to-many licence records, only this predicate is re-pointed.
 */
export function hasCurrentLicense(
  technician: TechnicianCompliance,
  onDate?: string
): boolean {
  if (!technician.licenseNumber?.trim()) return false;
  const expiresOn = isoDate(technician.licenseExpiresOn);
  if (!expiresOn) return false;
  const date = isoDate(onDate) ?? todayEastern();
  return expiresOn >= date;
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

type DispatchAddress = {
  displayName?: string | null;
  serviceStreet?: string | null;
  serviceCity?: string | null;
  serviceState?: string | null;
  serviceZip?: string | null;
};

/**
 * GL-12: a field job cannot be assigned or routed without a deliverable service
 * address. A technician sent to a blank or half-address wastes a route slot and,
 * for a regulated pesticide application, produces a record with no location. The
 * office owns the fix, so the message is a checklist that names exactly what to
 * add and where — never a bare "invalid input". This minimum is not overridable:
 * there is no dispatch path that skips it.
 */
export function assertDeliverableAddress(customer: DispatchAddress): void {
  const who = customer.displayName?.trim() || "this customer";
  const missing = [
    ["street", customer.serviceStreet],
    ["city", customer.serviceCity],
    ["state", customer.serviceState],
    ["ZIP", customer.serviceZip],
  ]
    .filter(([, value]) => !value?.toString().trim())
    .map(([label]) => label);
  if (missing.length) {
    throw new Error(
      `This job can't be dispatched yet — ${who} is missing a deliverable service address (${missing.join(
        ", "
      )}). The office fixes this on the customer's record before assigning a technician.`
    );
  }
}

/**
 * GL-15 — the enforceable label rules a product may carry
 * (Product.labelRulesJson). Facets present are enforced at finalization; the
 * office encodes them from the approved label and Compliance signs the encoding.
 */
export type LabelRules = {
  allowedServiceTypes?: string[];
  allowedPests?: string[];
  quantity?: { min: number; max: number; unit: string };
  rates?: string[];
  minReEntryHours?: number;
};

export function parseLabelRules(raw: unknown): LabelRules | null {
  if (!raw) return null;
  try {
    const v = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
    if (!v || typeof v !== "object") return null;
    return v as LabelRules;
  } catch {
    return null;
  }
}

/** Parse "2.5 oz", "2.5oz", "0.5 gal" into value + unit. Null when unparseable. */
export function parseQuantity(
  raw: string | null | undefined
): { value: number; unit: string } | null {
  const m = /^\s*([0-9]+(?:\.[0-9]+)?)\s*([a-z%/]+.*?)\s*$/i.exec(raw ?? "");
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value)) return null;
  return { value, unit: m[2].trim().toLowerCase() };
}

const normalizeRateString = (value: string | null | undefined): string =>
  (value ?? "").toLowerCase().replace(/\s+/g, "");

/**
 * GL-15 — hold one recorded product application to its label rules. FAILS
 * CLOSED: a facet the rule encodes must be satisfied, and a product with
 * neither structured rules nor a recorded label rate cannot be validated and
 * is refused (the office fixes the catalog, not the technician the record).
 * Returns nothing; throws a fixable, named error.
 */
export function assertApplicationWithinLabel(input: {
  productName: string;
  recordedQuantity?: string | null;
  recordedRate?: string | null;
  reportReEntryHours?: number | null;
  reportPests?: string | null;
  jobServiceType?: string | null;
  catalogDefaultRate?: string | null;
  catalogReEntryHours?: number | null;
  rules: LabelRules | null;
}): void {
  const name = input.productName;
  const rules = input.rules;

  // Rate: allowed set = structured rates (if present) else the recorded label
  // default rate. NO rate on file at all = cannot validate = fail closed.
  const allowedRates = (rules?.rates ?? [])
    .map(normalizeRateString)
    .filter(Boolean);
  const defaultRate = normalizeRateString(input.catalogDefaultRate);
  if (defaultRate) allowedRates.push(defaultRate);
  if (allowedRates.length === 0) {
    throw new Error(
      `${name} has no approved label rate on file, so a recorded application cannot be validated against the label. Ask the office to record the label rate (Product log) before this product goes on a pesticide record.`
    );
  }
  if (!allowedRates.includes(normalizeRateString(input.recordedRate))) {
    throw new Error(
      `The rate recorded for “${name}” (${input.recordedRate?.trim() || "—"}) isn't an approved label rate. Apply and record the label rate, or ask the office to update the product's approved rates.`
    );
  }

  // Quantity range, when encoded.
  if (rules?.quantity) {
    const q = parseQuantity(input.recordedQuantity);
    if (!q) {
      throw new Error(
        `The quantity recorded for “${name}” (${input.recordedQuantity?.trim() || "—"}) must be a number with its unit (e.g. "2.5 ${rules.quantity.unit}").`
      );
    }
    if (q.unit !== rules.quantity.unit.toLowerCase()) {
      throw new Error(
        `“${name}” is recorded in ${q.unit}, but its label rule is in ${rules.quantity.unit}. Record the quantity in ${rules.quantity.unit}.`
      );
    }
    if (q.value < rules.quantity.min || q.value > rules.quantity.max) {
      throw new Error(
        `The quantity recorded for “${name}” (${q.value} ${q.unit}) is outside the label range (${rules.quantity.min}–${rules.quantity.max} ${rules.quantity.unit}).`
      );
    }
  }

  // Re-entry: the report may never promise LESS than the label minimum.
  const labelMin = rules?.minReEntryHours ?? input.catalogReEntryHours;
  if (
    labelMin != null &&
    input.reportReEntryHours != null &&
    input.reportReEntryHours < labelMin
  ) {
    throw new Error(
      `The re-entry interval on this report (${input.reportReEntryHours}h) is below ${name}'s label minimum (${labelMin}h). The occupant must be told the label's re-entry time.`
    );
  }

  // Service-type applicability, when encoded.
  if (rules?.allowedServiceTypes?.length && input.jobServiceType) {
    const ok = rules.allowedServiceTypes.some(
      (t) => t.trim().toLowerCase() === input.jobServiceType!.trim().toLowerCase()
    );
    if (!ok) {
      throw new Error(
        `“${name}” isn't approved for ${input.jobServiceType} work (label rule allows: ${rules.allowedServiceTypes.join(", ")}). Pick an approved product, or ask the office to review the label rule.`
      );
    }
  }

  // Pest applicability, when encoded: every pest the report targets must be on
  // the product's allowed list.
  if (rules?.allowedPests?.length && input.reportPests?.trim()) {
    const allowed = new Set(
      rules.allowedPests.map((t) => t.trim().toLowerCase()).filter(Boolean)
    );
    const targeted = input.reportPests
      .split(/[,;]/)
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    const outside = targeted.filter((t) => !allowed.has(t));
    if (outside.length) {
      throw new Error(
        `“${name}” isn't labeled for: ${outside.join(", ")}. The label rule allows ${rules.allowedPests.join(", ")}. Fix the target pests, pick an approved product, or ask the office to review the label rule.`
      );
    }
  }
}
