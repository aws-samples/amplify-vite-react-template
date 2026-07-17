/**
 * The public booking funnel — the only road from lead to customer. A lead
 * converts by picking a day, accepting the terms, and paying by card at
 * MARKETING_URL + "/quote"; the Stripe webhook then creates the plan, the
 * agreement, and the first visit.
 *
 * The CRM's hostname decides the environment exactly the way backend.ts
 * derives MARKETING_URL from the branch (main CRM ↔ production marketing
 * site), so the URL a phone CSR reads aloud is the same one the
 * "booking-link" email carries.
 */

/** The production CRM host (the `main` branch build in backend.ts). */
const PRODUCTION_CRM_HOST = "main.d5ln2hbbp9s2j.amplifyapp.com";

export function marketingSiteUrl(
  hostname: string = window.location.hostname
): string {
  return hostname === PRODUCTION_CRM_HOST
    ? "https://www.pestbuzzkill.com"
    : "https://staging.d26qpsjewk0bee.amplifyapp.com";
}

/** The full funnel URL — where every lead goes to price, book, and pay. */
export function bookingFunnelUrl(
  hostname: string = window.location.hostname
): string {
  return `${marketingSiteUrl(hostname)}/quote`;
}

/**
 * The funnel URL as a CSR reads it aloud on the phone: no protocol, no
 * "www." — "pestbuzzkill.com/quote" is a URL a caller can type.
 */
export function bookingFunnelSpoken(
  hostname: string = window.location.hostname
): string {
  return bookingFunnelUrl(hostname).replace(/^https:\/\/(www\.)?/, "");
}
