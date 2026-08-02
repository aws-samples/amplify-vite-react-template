import { generateClient } from "aws-amplify/data";
import type { Schema } from "../../amplify/data/resource";
import { urgencyBadge, LICENSE_EXPIRY_SCALE, type BadgeClass } from "./badges";
import { LICENSE_STATUS_LABELS } from "./enums";

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

/**
 * Licensing's own vocabulary for where a licence sits.
 *
 * Deliberately not `UrgencyLevel`: a licence that has run out is "expired",
 * not "overdue" (nothing is late — the permission is simply gone), and a
 * licence with months left is "ok" rather than "calm". `Licensing` branches on
 * these words in seven places.
 */
export type LicenseLevel = "ok" | "soon" | "urgent" | "expired" | "unknown";

/**
 * Compliance state of a license, derived from its expiration date and
 * overlaid on the manually-set status. Expiry is the thing that actually
 * stops you writing business, so a past date always wins over a stale
 * "ACTIVE" flag.
 *
 * A wrapper around `urgencyBadge`, not a replacement for it, for two reasons
 * the ladder cannot express:
 *
 *  1. The status override runs *before* the ladder. A LAPSED licence is red
 *     and reads "Lapsed" however far off its expiration date is, so this is a
 *     branch above the arithmetic rather than another rung on it.
 *  2. The level is renamed at this boundary — see `LicenseLevel`.
 *
 * The cutoffs themselves live in `LICENSE_EXPIRY_SCALE`.
 */
export function licenseHealth(l: {
  status?: string | null;
  expirationDate?: string | null;
}): { level: LicenseLevel; label: string; cls: BadgeClass } {
  if (l.status && l.status !== "ACTIVE" && l.status !== "PENDING") {
    const label = LICENSE_STATUS_LABELS[l.status] ?? l.status;
    return { level: "expired", label, cls: "red" };
  }
  const { cls, label, level } = urgencyBadge(
    daysUntil(l.expirationDate),
    LICENSE_EXPIRY_SCALE
  );
  return {
    cls,
    label,
    level: level === "overdue" ? "expired" : level === "calm" ? "ok" : level,
  };
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

/**
 * The one message for "the ACORD template isn't in S3". `AccountDetail` and
 * `FormsTab` each had their own wording for it; both now come from here so
 * the advice can only be changed in one place. Exported so those two can
 * tell a classified template failure from an unclassified one and keep their
 * own "Generation failed: …" prefix off it — see `friendlyError`.
 */
export const TEMPLATE_MISSING_MESSAGE =
  "That ACORD template hasn't been uploaded yet. Go to Settings → ACORD " +
  "templates, upload the fillable PDF, then try again — nothing you entered was lost.";

/**
 * Only `fetchTemplate` (`lib/acordPdf.ts`) produces this string, and it only ever
 * fetches templates, so the token cannot appear on any other code path.
 *
 * The two regexes this replaces also matched a bare `403|404`, and
 * `AccountDetail`'s also matched `NoSuchKey`. Both are dropped deliberately:
 *
 *  - Neither can occur on the template path. `fetchTemplate` calls `getUrl`
 *    without `validateObjectExistence`, so a missing object never surfaces as
 *    `NoSuchKey` — the presigned URL resolves and the `fetch` 404s, which is
 *    already reported as "Template fetch failed (404)".
 *  - Both are unsafe as substring tests now that this helper runs at every
 *    call site: `NoSuchKey` is exactly what a genuinely deleted *document*
 *    raises in `FilePreview`/`DocumentsPanel`, and `404` matches any message
 *    that merely contains those three digits (an id, an amount, a field name).
 */
const TEMPLATE_MISSING_RE = /Template fetch failed/;

/** Turn raw GraphQL/AppSync errors into something a human can act on. */
export function friendlyError(err: unknown, fallback: string): string {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  if (TEMPLATE_MISSING_RE.test(msg)) return TEMPLATE_MISSING_MESSAGE;
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

// ── Calendar-day arithmetic and date+time rendering ──────────────────

/**
 * Midnight UTC for a civil (Y, M, D) triple, as epoch ms.
 *
 * Only ever used to subtract one of these from another, so the zone it pins
 * them to is arbitrary — UTC is chosen because it has no DST, which makes the
 * difference an exact multiple of 86_400_000. `Date.UTC` would do, except it
 * remaps years 0-99 onto 1900-1999; `setUTCFullYear` does not.
 */
function utcDayMs(year: number, month: number, day: number): number {
  const t = new Date(0);
  t.setUTCFullYear(year, month - 1, day);
  t.setUTCHours(0, 0, 0, 0);
  return t.getTime();
}

/**
 * Whole days from today until `d` — negative once it is past, `0` today.
 * Null-safe; `null` for anything that isn't a real calendar day.
 *
 * ## Which calendar "today" comes from, and why it is the local one
 *
 * §1.7 of the audit lists three implementations of this, disagreeing about
 * where "today" starts: `daysUntilDate` (local midnight via `toDateString()`),
 * `Dashboard.tsx`'s `daysUntil` (local midnight via `setHours`), and the
 * `isoDay`/`addDays` pair in `renewal-tasks/handler.ts` (UTC). This function
 * takes the **local** calendar, for the three sites that render a number to a
 * person.
 *
 * That is not a contradiction of PATTERNS §6 ("a rule shared with a Lambda
 * matches the Lambda"). §6's justification is about the *operand*: UTC wins
 * for the settle rule because the right-hand side is a server-assigned
 * `createdAt` instant. Every operand here is the opposite kind of value — a
 * bare `a.date()` day-string with no zone attached (`License.expirationDate`,
 * `Policy.expirationDate`, `Account.currentPolicyExpiration`), or a
 * `MarketingTask.submitBy` the Lambda derived from one by pure calendar
 * arithmetic. And the Lambda never computes a days-until number at all: it
 * builds day strings and compares them lexicographically, so there is no
 * handler-side counterpart of this rule to mirror. The one thing left that
 * could differ is whose midnight ends "today", and the answer for a badge
 * reading "1d left" is the reader's. At 17:00 in Los Angeles, a licence
 * expiring tomorrow must not already say `0d`.
 *
 * ## What the string is read as
 *
 * The leading `YYYY-MM-DD` is taken **literally** — the day as written, never
 * parsed through `new Date`. A datetime string is therefore downcast to its
 * nominal day, the same downcast the `.slice(0, 10)` sites already perform,
 * and a UTC `createdAt` keeps its UTC day rather than sliding a day west of
 * Greenwich. Anything after position 10 is ignored.
 *
 * Differences from the `daysUntilDate` this replaced in Wave 4 (removed in the
 * same commit that migrated its last two call sites):
 * - Malformed input returns `null`, not `NaN`. `NaN` slipped through
 *   `licenseHealth`'s `days == null` guard and rendered "NaNd left" in a
 *   green pill; `null` lands in the "No expiration on file" branch.
 * - Exact civil-day subtraction rather than `Math.round` over a local-midnight
 *   difference, so a span containing a DST transition cannot be off by one.
 */
export function daysUntil(d: string | null | undefined): number | null {
  if (blank(d)) return null;
  const day = String(d).trim().slice(0, 10);
  if (!isIsoDay(day)) return null;
  const [y, mo, dd] = day.split("-").map(Number);
  const now = new Date();
  const todayMs = utcDayMs(now.getFullYear(), now.getMonth() + 1, now.getDate());
  return (utcDayMs(y, mo, dd) - todayMs) / 86_400_000;
}

/**
 * A stored timestamp rendered as date + time, en-US. The counterpart of
 * `fmtDate`, and the shared version of the lone `toLocaleString` at
 * `FormsTab.tsx:214`. Same `"—"` for absent input.
 *
 * Two deliberate differences from that call site's current output:
 *
 * 1. **Seconds are dropped.** `7/31/2026, 3:04:05 PM` becomes
 *    `7/31/2026, 3:04 PM`. The second an upload landed is noise in a table,
 *    and the date half stays byte-identical to `fmtDate`'s, which the raw
 *    `toLocaleString` default is not guaranteed to keep across ICU versions.
 * 2. **An unparseable string renders `"—"`,** not the literal `Invalid Date`.
 *
 * A **date-only** string (`length === 10`, `fmtDate`'s own discriminator —
 * see §4.3) is delegated to `fmtDate` rather than being shown as
 * `12:00 AM`. There is no time in the data, so inventing midnight and
 * printing it would be a fabricated fact — and which midnight it was would
 * depend on the reader's zone. A 10-character string that is not a real
 * calendar day is `"—"`; `fmtDate` is looser here and is left alone.
 */
export function fmtDateTime(d: string | null | undefined): string {
  if (blank(d)) return "—";
  const s = String(d).trim();
  if (s.length === 10) return isIsoDay(s) ? fmtDate(s) : "—";
  const parsed = new Date(s);
  if (Number.isNaN(parsed.getTime())) return "—";
  return parsed.toLocaleString("en-US", {
    month: "numeric",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
