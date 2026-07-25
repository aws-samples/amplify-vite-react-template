/**
 * The CRM's mirror of amplify/functions/shared/serviceAddress.ts.
 *
 * Two addresses hide behind one customer record, and mixing them up breaks
 * scheduling:
 *
 *  - `routingAddress` — street/city/state/zip only. What goes into a maps link
 *    or anything geocoded. A unit ("Unit 289") is interior to a building and is
 *    not geocodable, so including it can make the address unresolvable.
 *  - `displayAddress` — what a human reads; the unit MUST be here, because the
 *    technician still has to find the right door.
 *
 * Kept in step with the server copy by hand, like workPolicy.ts.
 */

export type ServiceAddressFields = {
  serviceStreet?: string | null;
  serviceUnit?: string | null;
  serviceCity?: string | null;
  serviceState?: string | null;
  serviceZip?: string | null;
};

const clean = (v: string | null | undefined) => (v ?? "").trim();

/** "289" → "Unit 289"; an already-qualified "Apt 4B" / "#12" is left alone. */
export function qualifyUnit(unit: string): string {
  const u = unit.trim();
  if (!u) return "";
  return /^(unit|apt|apartment|suite|ste|#|rm|room|floor|fl|bldg|building)\b|^#/i.test(
    u
  )
    ? u
    : `Unit ${u}`;
}

/** The geocodable address — NO unit. Use for maps links and navigation. */
export function routingAddress(c: ServiceAddressFields): string {
  return [c.serviceStreet, c.serviceCity, c.serviceState, c.serviceZip]
    .map(clean)
    .filter(Boolean)
    .join(", ");
}

/** The human-facing address, unit included. Use for anything a person reads. */
export function displayAddress(c: ServiceAddressFields): string {
  const unit = clean(c.serviceUnit);
  const line1 = [clean(c.serviceStreet), unit ? qualifyUnit(unit) : ""]
    .filter(Boolean)
    .join(", ");
  return [line1, clean(c.serviceCity), clean(c.serviceState), clean(c.serviceZip)]
    .filter(Boolean)
    .join(", ");
}

/** Short form for list rows: street (+ unit) and city. */
export function shortDisplayAddress(c: ServiceAddressFields): string {
  const unit = clean(c.serviceUnit);
  const line1 = [clean(c.serviceStreet), unit ? qualifyUnit(unit) : ""]
    .filter(Boolean)
    .join(", ");
  return [line1, clean(c.serviceCity)].filter(Boolean).join(", ");
}
