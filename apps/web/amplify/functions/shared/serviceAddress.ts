/**
 * The ONE place a customer's service address is composed.
 *
 * There are two different addresses hiding behind one record, and mixing them
 * up is what breaks scheduling:
 *
 *  - ROUTING: what goes to Google Routes / geocoding. Street, city, state, zip
 *    and NOTHING else. A unit ("Unit 289", "Apt 4B") is not geocodable — it is
 *    interior to a building — so including it can make the whole address
 *    unresolvable. One unresolvable stop makes its technician's entire day
 *    unmeasurable, and an unmeasurable day fails closed: it holds the full
 *    window and stops selling capacity, surfacing to the office as a false
 *    "that day is fully booked" (see ADDRESS_UNROUTABLE).
 *
 *  - DISPLAY: what a human reads. The unit MUST be here — the technician still
 *    has to find the right door, and the office needs it on reports and mail.
 *
 * Before this module every call site inlined its own
 * `[street, city, state, zip].join(", ")`, so there was no single place that
 * could get the distinction right. Route with `routingAddress`, show with
 * `displayAddress`, and the two can never drift again.
 */

export type ServiceAddressFields = {
  serviceStreet?: string | null;
  serviceUnit?: string | null;
  serviceCity?: string | null;
  serviceState?: string | null;
  serviceZip?: string | null;
};

function clean(value: string | null | undefined): string {
  return (value ?? "").trim();
}

/**
 * The geocodable address: street, city, state, zip. The unit is deliberately
 * omitted — see the module note. Empty string when there is nothing to route,
 * which every caller already treats as "not routable".
 */
export function routingAddress(c: ServiceAddressFields): string {
  return [c.serviceStreet, c.serviceCity, c.serviceState, c.serviceZip]
    .map(clean)
    .filter(Boolean)
    .join(", ");
}

/**
 * The human-facing address, unit included, e.g.
 * "290 Eliot Street, Unit 289, Ashland, MA 01721".
 *
 * The unit is normalized so a bare "289" reads as "Unit 289" while an already
 * qualified "Apt 4B" / "Suite 200" / "#12" is left exactly as the office typed
 * it — the office should never have to guess the app's preferred wording.
 */
export function displayAddress(c: ServiceAddressFields): string {
  const unit = clean(c.serviceUnit);
  const street = clean(c.serviceStreet);
  const line1 = [street, unit ? qualifyUnit(unit) : ""]
    .filter(Boolean)
    .join(", ");
  return [line1, clean(c.serviceCity), clean(c.serviceState), clean(c.serviceZip)]
    .filter(Boolean)
    .join(", ");
}

/** "289" → "Unit 289"; "Apt 4B" / "#12" / "Suite 200" are already qualified. */
export function qualifyUnit(unit: string): string {
  const u = unit.trim();
  if (!u) return "";
  return /^(unit|apt|apartment|suite|ste|#|rm|room|floor|fl|bldg|building)\b|^#/i.test(
    u
  )
    ? u
    : `Unit ${u}`;
}

/**
 * Does this street line look like a unit (or a second address) was typed into
 * it? Used to REPORT suspect records for a human to fix — never to rewrite one
 * automatically, because "Unit 3 Rd" is a real street name somewhere and a
 * silent edit to a service address is how a technician gets sent to the wrong
 * building.
 */
export function streetLooksLikeItHidesAUnit(
  street: string | null | undefined
): boolean {
  const s = clean(street);
  if (!s) return false;
  // A unit keyword appearing AFTER the leading house number (so "12 Unit Ave"
  // as a street name doesn't trip it, but "290 Eliot St, Unit 289" does).
  if (/,\s*(unit|apt|apartment|suite|ste|#|rm|room)\b/i.test(s)) return true;
  if (/\s#\s*\w/.test(s)) return true;
  // Two street-ish tokens in one line ("290 Eliot Street 289 America blvd") —
  // a second address jammed into the same field.
  const streetWords =
    s.match(
      /\b(st|street|rd|road|ave|avenue|blvd|boulevard|ln|lane|dr|drive|way|ct|court|cir|circle|pl|place|ter|terrace|hwy|highway)\b/gi
    ) ?? [];
  return streetWords.length >= 2;
}
