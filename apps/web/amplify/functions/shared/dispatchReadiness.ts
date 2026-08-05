import { assertDeliverableAddress } from "./compliance";
import { driveMinutesBetween } from "./driveTime";
import { MA_RI_ZIP_RE } from "./postalCode";

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

export type DispatchCustomer = {
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
  // Two buckets, because they are fixed on two different SCREENS. Lumping the
  // property class in with the address problems and calling the lot
  // "<customer>'s record" sent the office to the customer editor — where the
  // property-type field is the customer's DEFAULT and only seeds new visits, so
  // changing it left this refusal saying exactly the same thing. The class the
  // guard reads lives on the visit, and the only editor for it is that visit's
  // dispatch packet. A refusal that names the wrong screen is worse than a
  // vague one: it is confidently wrong.
  const customerProblems: string[] = [];
  const visitProblems: string[] = [];
  const street = customer.serviceStreet?.trim() ?? "";
  const city = customer.serviceCity?.trim() ?? "";
  const state = customer.serviceState?.trim() ?? "";
  const zip = customer.serviceZip?.trim() ?? "";

  if (isPlaceholder(street) || /^\d+$/.test(street)) {
    customerProblems.push(`the street ("${street}") isn't a real street address`);
  }
  if (isPlaceholder(city)) {
    customerProblems.push(`the city ("${city}") isn't a real city`);
  }
  if (!MA_RI_STATE_RE.test(state)) {
    customerProblems.push(
      `the state ("${state}") must be MA or RI — BuzzKill's launch territory is Massachusetts and Rhode Island`
    );
  }
  if (!MA_RI_ZIP_RE.test(zip)) {
    customerProblems.push(
      `the ZIP ("${zip}") isn't a Massachusetts/Rhode Island ZIP (starts 01–02)`
    );
  }
  if (!normalizePropertyClass(job.propertyClass)) {
    visitProblems.push(
      "it needs its property classification — residential (30 minutes on site) or commercial/community (60) — because duration and pricing depend on it"
    );
  }
  if (customerProblems.length || visitProblems.length) {
    const parts: string[] = [];
    if (customerProblems.length) {
      parts.push(`${who}'s record needs fixing: ${customerProblems.join("; ")}`);
    }
    if (visitProblems.length) {
      // Names the button, not just the concept — "the office fixes this" is
      // only actionable if the office knows where.
      parts.push(
        `this visit's dispatch packet needs fixing (open the visit and press "Packet"): ${visitProblems.join(
          "; "
        )}`
      );
    }
    throw new Error(
      `This job can't be dispatched yet — ${parts.join(
        ", and "
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
 * REFUSES dispatch with the office fix named.
 *
 * A missing GOOGLE_ROUTES_API_KEY FAILS CLOSED: dispatch is refused with the
 * configuration named, because a silently skipped proof would let every
 * unroutable address through exactly when the safety net is down. The ONLY
 * exception is the explicit local-dev escape hatch ALLOW_UNVERIFIED_ROUTES
 * ("true"), which production must never set.
 */
export async function proveRoutable(
  routesApiKey: string | undefined,
  originAddress: string,
  customer: DispatchCustomer
): Promise<DispatchRouteProof | null> {
  if (!routesApiKey) {
    if (process.env.ALLOW_UNVERIFIED_ROUTES === "true") return null;
    throw new Error(
      "Dispatch routability can't be verified: GOOGLE_ROUTES_API_KEY isn't configured. Fix the configuration (or, in local dev only, set ALLOW_UNVERIFIED_ROUTES=true) — visits are not assigned on an unverified address."
    );
  }
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
