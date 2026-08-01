/**
 * Agency identity — the single source of truth for both apps.
 *
 * This file lives at the repo root, outside `crm/` and `web/`, because both
 * apps render the same four facts (phone, email, street, city/state/zip) and
 * they must not be able to drift apart. It is deliberately dependency-free and
 * value-only: no imports, no framework types, no runtime. That is what lets a
 * plain relative import work from an Astro page, a React island, a Vite SPA
 * module, and a Vitest test without any build-system plumbing.
 *
 *   from crm:  import { AGENCY } from "../../shared/agency";        // crm/src/lib/*
 *   from web:  import { AGENCY } from "../../shared/agency";        // web/src/*
 *
 * ─ Stored vs. derived ────────────────────────────────────────────────────────
 * `AGENCY` holds the facts, split into the finest-grained fields anyone needs —
 * that is the ACORD producer-block shape, where city/state/zip go in separate
 * PDF fields. Every joined or reformatted variant the website needs (footer
 * address line, `tel:` href, `mailto:` href, schema.org phone, the FormSubmit
 * endpoint) is COMPUTED from those fields in `AGENCY_FMT` below. Nothing is
 * stored twice, so one edit here updates the ACORD forms and the website
 * footer together.
 *
 * To change the agency's phone/email/address: edit `AGENCY` only. Never edit a
 * value in `AGENCY_FMT` — add a new derivation instead.
 */

export const AGENCY = {
  /** Legal entity name. Used on the ACORD producer block and legal pages. */
  name: "HOA Insurance Agency LLC",
  /** Producer contact person named on ACORD forms. */
  contactName: "Jake Greasley",
  /** Street + suite. ACORD keeps this on its own line, as does the footer. */
  addressLine1: "420 Lakeside Ave, Suite 202",
  /** ACORD has a discrete city field; the footer joins city/state/zip. */
  city: "Marlborough",
  /** Two-letter USPS code — ACORD's state field will not take a full name. */
  state: "MA",
  zip: "01752",
  /** Display format. Every machine format (tel:, E.164) is derived from it. */
  phone: "508-233-2261",
  /**
   * CANONICAL SPELLING — mixed case. This is the branded spelling every
   * rendered surface already shows, and mailbox local-parts are case-sensitive
   * per RFC 5321 only in theory; the domain is case-insensitive. Anywhere a
   * lowercase form is genuinely required (URL paths, form endpoints), derive it
   * with `AGENCY_FMT.emailLower` rather than storing a second spelling.
   */
  email: "insurance@ProtectMyHOA.com",
} as const;

const phoneDigits = AGENCY.phone.replace(/\D/g, "");

/**
 * Derived presentations of `AGENCY`. Computed, never hand-edited — every value
 * here is a pure function of the fields above.
 */
export const AGENCY_FMT = {
  /** City/state/zip joined the way the website footer prints it. */
  addressLine2: `${AGENCY.city}, ${AGENCY.state} ${AGENCY.zip}`,
  /** `tel:` href — E.164, no punctuation. */
  phoneHref: `tel:+1${phoneDigits}`,
  /** schema.org `telephone` format used in the JSON-LD blocks. */
  phoneIntl: `+1-${AGENCY.phone}`,
  /** `mailto:` href, canonical mixed-case spelling. */
  emailHref: `mailto:${AGENCY.email}`,
  /** Lowercase transport form, for URL paths and form-endpoint identifiers. */
  emailLower: AGENCY.email.toLowerCase(),
  /** FormSubmit AJAX endpoint; the address is part of the URL path. */
  formsubmitUrl: `https://formsubmit.co/ajax/${AGENCY.email.toLowerCase()}`,
} as const;

export type Agency = typeof AGENCY;
export type AgencyFormatted = typeof AGENCY_FMT;
