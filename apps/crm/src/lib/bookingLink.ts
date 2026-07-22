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

/** Both hostnames that can serve the production CRM. The custom domain is
 * canonical; retaining the Amplify hostname keeps direct/legacy sessions in
 * the production environment instead of accidentally handing out QA links. */
const PRODUCTION_CRM_HOSTS = new Set([
  "app.pestbuzzkill.com",
  "main.d5ln2hbbp9s2j.amplifyapp.com",
]);

/**
 * True when this CRM is the production (main) deployment. The Danger Zone
 * (staging-only database wipe) hides itself when this is true — a second layer
 * over the backend's authoritative branch guard. Anything that isn't a known
 * production host counts as staging/dev.
 */
export function isProductionCrm(
  hostname: string = window.location.hostname
): boolean {
  return PRODUCTION_CRM_HOSTS.has(hostname.toLowerCase());
}

export function marketingSiteUrl(
  hostname: string = window.location.hostname
): string {
  return isProductionCrm(hostname)
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
