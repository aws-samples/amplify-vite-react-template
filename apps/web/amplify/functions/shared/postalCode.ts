/**
 * The one home for ZIP rules. Two DIFFERENT questions live here and they are
 * deliberately kept apart:
 *
 *  - SHAPE (`isValidZip`) — "is this a US ZIP at all". The booking funnel asks
 *    this. It must not ask the territory question: an out-of-area address is a
 *    lead we deliberately capture and price through the Zone C path behind a
 *    lead token (`booking-public/handler.ts` `quote()`), not a form error.
 *
 *  - TERRITORY (`isMaRiZip`) — "is this inside the launch footprint". Only
 *    dispatch asks this, because only dispatch has to send a truck.
 *
 * Before this module the shape question was asked NOWHERE: `validateQuoteForm`
 * declared `zip` and never checked it, and `quote()` validated street/city/state
 * and stored `zip` unchecked. A customer could pay for a booking with no ZIP,
 * and the omission surfaced later as a dispatch-readiness checklist error the
 * customer never saw. The territory regex additionally had no shared home, so
 * `dispatchReadiness` kept it private.
 */

/** US ZIP: five digits, optionally +4. */
export const ZIP_RE = /^\d{5}(-\d{4})?$/;

/** Massachusetts and Rhode Island ZIPs both start 01–02. */
export const MA_RI_ZIP_RE = /^0[12]\d{3}(-\d{4})?$/;

/** Shape only — says nothing about whether we serve it. */
export function isValidZip(raw?: string | null): boolean {
  return ZIP_RE.test((raw ?? "").trim());
}

/** Inside the launch territory. Implies `isValidZip`. */
export function isMaRiZip(raw?: string | null): boolean {
  return MA_RI_ZIP_RE.test((raw ?? "").trim());
}
