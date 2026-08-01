import { generateClient } from "aws-amplify/data";
import type { Schema } from "../../amplify/data/resource";

export const client = generateClient<Schema>();

export type Account = Schema["Account"]["type"];
export type Building = Schema["Building"]["type"];
export type Quote = Schema["Quote"]["type"];
export type Policy = Schema["Policy"]["type"];
export type Carrier = Schema["Carrier"]["type"];
export type AppetiteGuide = Schema["AppetiteGuide"]["type"];
export type CrmDocument = Schema["Document"]["type"];
export type Certificate = Schema["Certificate"]["type"];
export type UserProfile = Schema["UserProfile"]["type"];
export type ProducerLicense = Schema["ProducerLicense"]["type"];
export type License = Schema["License"]["type"];
export type MarketingTask = Schema["MarketingTask"]["type"];

/** The one paginated-list helper. Defined in pagination.ts so the Lambdas
 *  can import it without dragging generateClient() into their bundle. */
export { listAllPages } from "./pagination";

// Lines of authority are the licensing counterpart to lines of business —
// they're what a state license actually grants. Alphabetical.
export const LINES_OF_AUTHORITY = [
  "Adjuster",
  "Casualty",
  "Health",
  "Life",
  "Personal Lines",
  "Property",
  "Surplus Lines",
  "Variable Products",
];

export const LICENSE_CLASS_LABELS: Record<string, string> = {
  AGENCY: "Agency / business entity",
  ADJUSTER: "Adjuster",
  CONSULTANT: "Consultant",
  PRODUCER: "Producer",
  SURPLUS_LINES: "Surplus lines",
};

export const LICENSE_STATUS_LABELS: Record<string, string> = {
  ACTIVE: "Active",
  EXPIRED: "Expired",
  INACTIVE: "Inactive",
  LAPSED: "Lapsed",
  PENDING: "Pending",
};

/** Days until a date (negative = past). Null-safe. */
export function daysUntilDate(d: string | null | undefined): number | null {
  if (!d) return null;
  const then = new Date(d + "T00:00:00").getTime();
  const today = new Date(new Date().toDateString()).getTime();
  return Math.round((then - today) / 86_400_000);
}

/**
 * Compliance state of a license, derived from its expiration date and
 * overlaid on the manually-set status. Expiry is the thing that actually
 * stops you writing business, so a past date always wins over a stale
 * "ACTIVE" flag.
 */
export function licenseHealth(l: {
  status?: string | null;
  expirationDate?: string | null;
}): { level: "ok" | "soon" | "urgent" | "expired" | "unknown"; label: string; badge: string } {
  if (l.status && l.status !== "ACTIVE" && l.status !== "PENDING") {
    const label = LICENSE_STATUS_LABELS[l.status] ?? l.status;
    return { level: "expired", label, badge: "red" };
  }
  const days = daysUntilDate(l.expirationDate);
  if (days == null) return { level: "unknown", label: "No expiration on file", badge: "gray" };
  if (days < 0) return { level: "expired", label: `Expired ${-days}d ago`, badge: "red" };
  if (days <= 30) return { level: "urgent", label: `${days}d left`, badge: "red" };
  if (days <= 60) return { level: "soon", label: `${days}d left`, badge: "amber" };
  return { level: "ok", label: `${days}d left`, badge: "green" };
}

export const US_STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA",
  "KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT",
  "VA","WA","WV","WI","WY","DC",
];

// Alphabetical.
export const LINES_OF_BUSINESS = [
  "Crime/Fidelity",
  "D&O",
  "Earthquake",
  "Flood",
  "General Liability",
  "HO-6",
  "Property",
  "Umbrella",
  "Workers Comp",
];

/** Whole numbers with thousands separators: 11000 -> "11,000". */
export function fmtNum(n: number | null | undefined): string {
  if (n == null) return "—";
  return n.toLocaleString("en-US");
}

export function fmtMoney(n: number | null | undefined): string {
  if (n == null) return "—";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

export function fmtDate(d: string | null | undefined): string {
  if (!d) return "—";
  return new Date(d + (d.length === 10 ? "T00:00:00" : "")).toLocaleDateString("en-US");
}

// ── Shared form validation ───────────────────────────────────────────
// Returns a list of human-readable problems; empty = valid. All fields
// optional — only filled-in values are checked.
export function validateAccountFields(f: {
  contactEmail?: string;
  zip?: string;
  unitCount?: string;
  yearBuilt?: string;
  totalInsuredValue?: string;
}): string[] {
  const problems: string[] = [];
  const email = f.contactEmail?.trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    problems.push("Contact email doesn't look like a valid address.");
  }
  const zip = f.zip?.trim();
  if (zip && !/^\d{5}(-\d{4})?$/.test(zip)) {
    problems.push("ZIP should be 5 digits (or ZIP+4).");
  }
  if (f.unitCount) {
    const n = Number(f.unitCount);
    if (!Number.isInteger(n) || n < 0 || n > 100000)
      problems.push("Unit count should be a whole number of at least 0.");
  }
  if (f.yearBuilt) {
    const n = Number(f.yearBuilt);
    const maxYear = new Date().getFullYear() + 5;
    if (!Number.isInteger(n) || n < 1600 || n > maxYear)
      problems.push(`Year built should be between 1600 and ${maxYear}.`);
  }
  if (f.totalInsuredValue) {
    const n = Number(f.totalInsuredValue);
    if (!Number.isFinite(n) || n < 0)
      problems.push("Total insured value can't be negative.");
  }
  return problems;
}

/** Turn raw GraphQL/AppSync errors into something a human can act on. */
export function friendlyError(err: unknown, fallback: string): string {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  const varMatch = msg.match(/Variable '(\w+)' has an invalid value/);
  if (varMatch) return `"${varMatch[1]}" has an invalid value — please check that field.`;
  if (/Not Authorized|Unauthorized/i.test(msg))
    return "You don't have permission to do that.";
  if (/Network(Error| error)|Failed to fetch/i.test(msg))
    return "Network problem — check your connection and try again.";
  return msg || fallback;
}

// ── Field-level validators ───────────────────────────────────────────
// Same contract as validateAccountFields: return a list of human-readable
// problems, empty = valid, so callers compose by concatenation:
//
//   const problems = [
//     ...validateAccountFields(form),
//     ...validateYear(form.roofUpdatedYear, "Roof updated year", { maxYearsAhead: 1 }),
//   ];
//
// Absent values are always "not provided, skip" — every existing call site
// guards with `if (field)` before checking, and required-ness is asserted
// separately (e.g. NewLead's `if (!form.name.trim())`). Validators here must
// never make an optional field fail just for being blank.

/**
 * Email shape check. Two variants existed: client.ts's `[^\s@]+` TLD and
 * QuoteApp's `[^\s@]{2,}`. The `{2,}` form wins — the root zone has no
 * single-character TLDs, so it rejects "a@b.c" typos without rejecting any
 * real address. Exported so `web` can drop its private copy.
 */
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** "" / whitespace / null / undefined all mean "not provided". `0` does not. */
function blank(v: string | number | null | undefined): boolean {
  return v == null || String(v).trim() === "";
}

const ISO_DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Real calendar day, decided by arithmetic only — no `new Date()`, so no
 *  timezone can shift it (see §1.7's UTC-vs-local split). */
function isIsoDay(v: string): boolean {
  const m = ISO_DAY_RE.exec(v);
  if (!m) return false;
  const [, y, mo, d] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= lengths[month - 1];
}

/**
 * Start-before-end for a pair of ISO day strings. Compared with `<=` on the
 * raw strings — correct for ISO-8601 and free of any timezone question.
 * Equal dates are valid: a one-day term is legitimate, and both existing
 * implementations (CoverageForm, Licensing) only reject `start > end`.
 *
 * Either side absent → no ordering problem. A present-but-malformed side is
 * reported on its own; ordering is only checked once both parse.
 */
export function validateDateRange(
  start: string | null | undefined,
  end: string | null | undefined,
  startLabel = "Effective date",
  endLabel = "expiration date"
): string[] {
  const problems: string[] = [];
  const s = blank(start) ? "" : String(start).trim();
  const e = blank(end) ? "" : String(end).trim();
  if (s && !isIsoDay(s)) problems.push(`${startLabel} isn't a valid date.`);
  if (e && !isIsoDay(e)) problems.push(`${endLabel} isn't a valid date.`);
  if (problems.length) return problems;
  if (s && e && s > e) {
    problems.push(`${startLabel} can't be after the ${endLabel}.`);
  }
  return problems;
}

/**
 * Four-digit year within a plausible window. The two ranges in the codebase
 * are not drift — `yearBuilt` allows +5 (construction can be scheduled ahead
 * of today) while the roof/HVAC/electrical/plumbing "updated" years allow +1,
 * because work already done can't be years in the future. So the upper bound
 * is a parameter, not a constant.
 */
export function validateYear(
  value: string | number | null | undefined,
  label: string,
  opts: { min?: number; maxYearsAhead?: number } = {}
): string[] {
  if (blank(value)) return [];
  const min = opts.min ?? 1600;
  const max = new Date().getFullYear() + (opts.maxYearsAhead ?? 5);
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    return [`${label} should be between ${min} and ${max}.`];
  }
  return [];
}

/**
 * Whole number, `min` (default 0) and up. Named for the common case; the
 * default bound is "not negative", matching validateAccountFields's unit
 * count. Form state holds numerics as strings, so string input is expected —
 * coercion is `Number()`, same as every existing check.
 */
export function validatePositiveInt(
  value: string | number | null | undefined,
  label: string,
  opts: { min?: number; max?: number } = {}
): string[] {
  if (blank(value)) return [];
  const min = opts.min ?? 0;
  const { max } = opts;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || (max != null && n > max)) {
    return [
      max != null
        ? `${label} should be a whole number between ${min} and ${max}.`
        : `${label} should be a whole number of at least ${min}.`,
    ];
  }
  return [];
}
