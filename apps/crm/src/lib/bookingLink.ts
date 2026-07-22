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
 * True when this CRM is the production (main) deployment. Used to pick the
 * booking/marketing URL, where the fail-safe default is the opposite of the
 * wipe's: an unrecognized host stays NON-production so a test lead is never
 * pointed at real checkout (see marketingSiteUrl). Do NOT use this to gate the
 * database wipe — use isStagingCrm, which fails closed the other way.
 */
export function isProductionCrm(
  hostname: string = window.location.hostname
): boolean {
  return PRODUCTION_CRM_HOSTS.has(hostname.toLowerCase());
}

/** Hosts that positively identify a staging or local-dev CRM. */
const STAGING_CRM_HOSTS = new Set(["staging.d5ln2hbbp9s2j.amplifyapp.com"]);

function isDevHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local")
  );
}

/**
 * True ONLY when we can positively identify a staging or dev CRM. This is the
 * gate for destructive, staging-only tools (the database wipe): it fails
 * CLOSED — main and any host we don't recognize return false, so the wipe is
 * never one tap away outside a known staging/dev environment. This is
 * deliberately NOT the inverse of isProductionCrm: the two dangers are
 * opposite (real checkout vs. real data loss), so each defaults to its own
 * safe side for an unknown host. The backend branch guard is authoritative;
 * this keeps the button out of sight everywhere it must not appear.
 */
export function isStagingCrm(
  hostname: string = window.location.hostname
): boolean {
  const host = hostname.toLowerCase();
  return (
    STAGING_CRM_HOSTS.has(host) || host.startsWith("staging.") || isDevHost(host)
  );
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
