import { assertDeliverableAddress } from "./compliance";
import { driveMinutesBetween } from "./driveTime";

/**
 * GL-12 — the real dispatch gate. "Non-blank" was the whole readiness check;
 * this proves the facts a technician actually needs:
 *
 *  - a ROUTABLE MA/RI address (state + ZIP shape + placeholder rejection, and
 *    a Google Routes drive-time proof attached to the decision — the same
 *    source capacity uses);
 *  - an explicit property classification, because the locked on-site durations
 *    (residential 30 min; commercial and community/common-area 60) and pricing
 *    depend on it;
 *  - the packet minimums for the visit.
 *
 * Every refusal is a checklist naming exactly what the office fixes — never a
 * bare "invalid input", and never overridable free text.
 */

export type PropertyClass = "RESIDENTIAL" | "COMMERCIAL" | "COMMUNITY";

export const PROPERTY_CLASSES: readonly PropertyClass[] = [
  "RESIDENTIAL",
  "COMMERCIAL",
  "COMMUNITY",
];

/** The locked on-site durations: residential 30; commercial/community 60. */
export function onsiteMinutesFor(propertyClass: string | null | undefined): number {
  return propertyClass === "COMMERCIAL" || propertyClass === "COMMUNITY" ? 60 : 30;
}

export function normalizePropertyClass(
  value: string | null | undefined
): PropertyClass | null {
  const v = (value ?? "").trim().toUpperCase();
  return (PROPERTY_CLASSES as readonly string[]).includes(v)
    ? (v as PropertyClass)
    : null;
}

type DispatchCustomer = {
  displayName?: string | null;
  serviceStreet?: string | null;
  serviceCity?: string | null;
  serviceState?: string | null;
  serviceZip?: string | null;
};

/** Placeholder tokens that satisfy "non-blank" but are not an address. */
const PLACEHOLDER_RE =
  /^(n\/?a|na|tbd|tba|unknown|none|same|x+|\?+|-+|\.+)$/i;

function isPlaceholder(value: string): boolean {
  const v = value.trim();
  if (!v) return true;
  if (PLACEHOLDER_RE.test(v)) return true;
  // A single repeated character ("aaaa") is filler, not a fact.
  if (v.length >= 2 && new Set(v.toLowerCase().replace(/\s/g, "")).size === 1) {
    return true;
  }
  return false;
}

const MA_RI_STATE_RE = /^(ma|massachusetts|ri|rhode\s*island)$/i;
const MA_RI_ZIP_RE = /^0[12]\d{3}(-\d{4})?$/;

/**
 * The pure (no-network) half of the gate: address shape, launch territory,
 * placeholders, property class. Throws a checklist error; returns nothing.
 */
export function assertDispatchFacts(
  customer: DispatchCustomer,
  job: { propertyClass?: string | null; serviceType?: string | null }
): void {
  // The existing non-blank minimum first — its message style is the baseline.
  assertDeliverableAddress(customer);

  const who = customer.displayName?.trim() || "this customer";
  const problems: string[] = [];
  const street = customer.serviceStreet?.trim() ?? "";
  const city = customer.serviceCity?.trim() ?? "";
  const state = customer.serviceState?.trim() ?? "";
  const zip = customer.serviceZip?.trim() ?? "";

  if (isPlaceholder(street) || /^\d+$/.test(street)) {
    problems.push(`the street ("${street}") isn't a real street address`);
  }
  if (isPlaceholder(city)) {
    problems.push(`the city ("${city}") isn't a real city`);
  }
  if (!MA_RI_STATE_RE.test(state)) {
    problems.push(
      `the state ("${state}") must be MA or RI — BuzzKill's launch territory is Massachusetts and Rhode Island`
    );
  }
  if (!MA_RI_ZIP_RE.test(zip)) {
    problems.push(
      `the ZIP ("${zip}") isn't a Massachusetts/Rhode Island ZIP (starts 01–02)`
    );
  }
  if (!normalizePropertyClass(job.propertyClass)) {
    problems.push(
      "the visit needs its property classification — residential (30 minutes on site) or commercial/community (60) — because duration and pricing depend on it"
    );
  }
  if (problems.length) {
    throw new Error(
      `This job can't be dispatched yet — ${who}'s record needs fixing: ${problems.join(
        "; "
      )}. The office fixes this before assigning a technician.`
    );
  }
}

export type DispatchRouteProof = {
  driveMinutes: number;
  checkedAt: string;
};

/**
 * The routability proof: the same Google Routes source capacity uses, attached
 * to the dispatch decision. A null result (unroutable address / no coverage)
 * REFUSES dispatch with the office fix named. Skipped (returns null proof)
 * only when no API key is configured — local/dev environments.
 */
export async function proveRoutable(
  routesApiKey: string | undefined,
  originAddress: string,
  customer: DispatchCustomer
): Promise<DispatchRouteProof | null> {
  if (!routesApiKey) return null;
  const address = [
    customer.serviceStreet,
    customer.serviceCity,
    customer.serviceState,
    customer.serviceZip,
  ]
    .filter(Boolean)
    .join(", ");
  const minutes = await driveMinutesBetween(routesApiKey, originAddress, address);
  if (minutes == null) {
    throw new Error(
      `Google can't route to "${address}" — the address doesn't resolve to a drivable location. Fix the customer's service address before assigning a technician.`
    );
  }
  return { driveMinutes: Math.round(minutes), checkedAt: new Date().toISOString() };
}
