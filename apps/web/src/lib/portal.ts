/**
 * The customer portal lives in the CRM app (a separate Amplify deployment), so
 * the marketing site links out to it by absolute URL.
 *
 * This is the single source for "where Customer Login goes" — Header and Footer
 * both read it, so the old FieldRoutes link can never come back in one place
 * and stay in another. Signing in at the root lands a customer on /portal via
 * HomeRedirect.
 *
 * The environment is decided by THIS site's hostname rather than by a build
 * variable. It used to fall back to the production portal whenever
 * VITE_PORTAL_URL was unset — and it is unset on the staging branch, so every
 * "Customer Login" on staging.pestbuzzkill.com pointed a QA session straight at
 * the real customers' portal. A default that needs an env var set correctly on
 * every branch to be safe is a default that will be wrong on some branch.
 *
 * So the direction is inverted, matching the CRM's mirror-image link
 * (apps/crm/src/lib/bookingLink.ts): only a KNOWN production host gets the
 * production portal, and an unrecognized host — a preview branch, a local dev
 * server, a new custom domain — stays on staging. Getting this wrong now sends
 * a real customer to a test portal, which is the failure that shows up loudly
 * and harms nobody's data.
 */

/** Every hostname that serves the PRODUCTION marketing site. The custom
 *  domains are canonical; the Amplify hostname is retained so a direct or
 *  legacy session stays in the production environment. */
const PRODUCTION_SITE_HOSTS = new Set([
  "www.pestbuzzkill.com",
  "pestbuzzkill.com",
  "main.d26qpsjewk0bee.amplifyapp.com",
]);

const PRODUCTION_PORTAL = "https://app.pestbuzzkill.com";
/** The staging CRM — the same URL backend.ts puts in non-main emails, so a
 *  link a customer clicks and a link they're shown agree on the environment. */
const STAGING_PORTAL = "https://staging.d5ln2hbbp9s2j.amplifyapp.com";

/** True only for a hostname known to serve production. Unknown ⇒ false. */
export function isProductionSite(
  hostname: string = window.location.hostname
): boolean {
  return PRODUCTION_SITE_HOSTS.has(hostname.toLowerCase());
}

/**
 * Where "Customer Login" goes. `VITE_PORTAL_URL` still wins when set, so a
 * one-off build can be pointed anywhere; it is now an override rather than the
 * thing standing between staging and the production portal.
 */
export function portalUrl(
  hostname: string = window.location.hostname
): string {
  const override = import.meta.env.VITE_PORTAL_URL as string | undefined;
  if (override) return override;
  return isProductionSite(hostname) ? PRODUCTION_PORTAL : STAGING_PORTAL;
}
