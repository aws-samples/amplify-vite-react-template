/**
 * GL-03 — the EXACT consent wording a lead agreed to, versioned. The funnel
 * renders this text (pure module — the browser bundle imports it like
 * serviceCatalog), and the /quote endpoint stamps the version onto the
 * BookingRequest, so "they consented" is always "they consented to THESE
 * words" — reconstructible years later, never a bare boolean whose wording
 * drifted. Change the wording ⇒ bump the version; never edit a released
 * version's meaning.
 *
 * The wording promises CALLS ONLY: no approved text-message workflow exists,
 * so the copy must not collect consent for one.
 */
export const CALL_CONSENT_TEXT_VERSION = "2026-07-20.1";

export const CALL_CONSENT_TEXT =
  "You can call me about my quote. If we can't price your address on the " +
  "spot, this lets us reach you by phone; otherwise we'll email you.";
