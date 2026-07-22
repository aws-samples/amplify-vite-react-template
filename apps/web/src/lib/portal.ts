/**
 * The customer portal lives in the CRM app (a separate Amplify deployment), so
 * the marketing site links out to it by absolute URL. The URL is
 * environment-dependent (prod vs staging), so it is overridable per build via
 * VITE_PORTAL_URL and falls back to the production custom domain. Signing in
 * at the root lands a customer on /portal via HomeRedirect.
 *
 * This is the single source for "where Customer Login goes" — Header and Footer
 * both read it, so the old FieldRoutes link can never come back in one place
 * and stay in another.
 */
export const PORTAL_URL =
  (import.meta.env.VITE_PORTAL_URL as string | undefined) ??
  "https://app.pestbuzzkill.com";
