import { AGENCY, AGENCY_FMT } from "../../shared/agency";

export const PHONE = AGENCY.phone;
export const PHONE_HREF = AGENCY_FMT.phoneHref;
export const EMAIL = AGENCY.email;
export const EMAIL_HREF = AGENCY_FMT.emailHref;
export const ADDRESS_LINE1 = AGENCY.addressLine1;
export const ADDRESS_LINE2 = AGENCY_FMT.addressLine2;
export const QUOTE_URL = "/quote";
export const FORMSUBMIT_URL = AGENCY_FMT.formsubmitUrl;

/**
 * Analytics kill switch — Google Ads and Microsoft Clarity.
 *
 * **On by default.** Production needs no configuration, so analytics can never
 * be lost to a forgotten variable. Set `PUBLIC_ANALYTICS_DISABLED=true` on the
 * **staging** Amplify app (and any branch preview) to turn both off there, so
 * a test lead cannot register a conversion against the live campaign and
 * staging sessions stay out of Clarity.
 *
 * Read via a helper rather than inline so the .astro <head>s and this module
 * share one definition — the account id itself is still repeated across four
 * heads (see INVENTORY §1.5).
 */
export const ANALYTICS_DISABLED =
  import.meta.env.PUBLIC_ANALYTICS_DISABLED === "true";

/**
 * Google Ads conversion `send_to` — account id and label.
 *
 * The account id and the Clarity project id are still written out in each of
 * the four .astro <head>s rather than read from here, so that the emitted tag
 * markup stays byte-identical to what production already serves.
 */
const ADS_CONVERSION_ID = "AW-18085022517/Csp3COKBgpscELWWzq9D";

type Gtag = (
  command: "event",
  action: "conversion",
  params: { send_to: string; value: number; currency: string }
) => void;

/**
 * Report one converted lead. Declines silently when analytics is switched off,
 * when there is no window (SSR), or when the tag has not loaded.
 *
 * NOTE: the last guard is currently always true in every environment —
 * `window.gtag` is never defined, because Astro compiles the <head> snippet to
 * `type="module"`, which keeps its `gtag` function out of global scope.
 * Verified on production. Left as-is deliberately: making conversions actually
 * fire is a behaviour change, not an env change. See INVENTORY §6.
 */
export function fireConversion(): void {
  if (ANALYTICS_DISABLED) return;
  if (typeof window === "undefined") return;
  const gtag = (window as Window & { gtag?: Gtag }).gtag;
  if (!gtag) return;
  gtag("event", "conversion", {
    send_to: ADS_CONVERSION_ID,
    value: 1.0,
    currency: "USD",
  });
}

export const SOCIAL = {
  instagram: "https://www.instagram.com/hoainsuranceagency",
  facebook: "https://www.facebook.com/people/HOA-Insurance-Agency/61575377498498/",
  linkedin: "https://www.linkedin.com/company/hoa-insurance-agency",
};

export const NAV_LINKS = [
  { label: "Home", path: "/" },
  { label: "About Us", path: "/about-us" },
  { label: "HOA Insurance", path: "/what-we-do" },
  { label: "Why Choose Us", path: "/why-choose-us" },
  { label: "Contact", path: "/#contact" },
];
