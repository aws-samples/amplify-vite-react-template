/**
 * GL-03 — the versioned record of WHY we are allowed to contact a lead, stamped
 * onto the BookingRequest and the Customer so the basis is reconstructible
 * years later instead of being a bare boolean whose meaning drifted. Change the
 * wording ⇒ bump the version; never edit a released version's meaning.
 *
 * It covers CALLS ONLY: no approved text-message workflow exists, so nothing
 * here may be read as permission to text.
 *
 * History, because the nature of this string changed:
 *   2026-07-20.1  A tick box. The text was rendered next to a checkbox and the
 *                 form would not submit until it was ticked, so the record read
 *                 "they agreed to THESE words".
 *   2026-08-03.1  The tick box was removed. The same sentence was printed next
 *                 to the submit button instead, so submitting was the act of
 *                 agreeing to a sentence that was still on screen.
 *   2026-08-03.2  The printed sentence was removed too (owner's call). Nothing
 *                 on the form states a consent notice now, so this string can
 *                 no longer claim the visitor read anything. It instead records
 *                 what actually happened: an inbound request in which the
 *                 person supplied their own contact details and asked us to get
 *                 back to them. That is the basis for the reply, and it is what
 *                 the audit will show.
 *
 * Retired wordings stay in PRIOR_CONSENT_TEXTS so an older record is readable
 * without a trip through git.
 */
export const CALL_CONSENT_TEXT_VERSION = "2026-08-03.2";

export const CALL_CONSENT_TEXT =
  "Inbound website request: the customer completed a BuzzKill request form, " +
  "supplied their own contact details, and asked us to respond about that " +
  "request. No separate consent notice was displayed on the form. We reply by " +
  "phone when they gave a number, otherwise by email.";

/** Retired wordings, keyed by the version stamped on records that used them. */
export const PRIOR_CONSENT_TEXTS: Readonly<Record<string, string>> = {
  "2026-07-20.1":
    "You can call me about my quote. If we can't price your address on the " +
    "spot, this lets us reach you by phone; otherwise we'll email you.",
  "2026-08-03.1":
    "By submitting this form you agree BuzzKill may contact you about your " +
    "request. If you give us a phone number we may call you about it, and " +
    "we'll email you either way.",
};
