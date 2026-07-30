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
