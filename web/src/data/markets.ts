/**
 * Appointed markets, as supplied.
 *
 * Shared by the homepage and /why-choose-us. Extracted from index.astro when the
 * second page needed the same wall — a carrier list duplicated across pages
 * would drift, and drift here means a page claiming an appointment that has
 * lapsed.
 *
 * Logos live in web/public/images/carriers/<slug>.png, normalised to 120px
 * height. `name` is the img alt text: the wall shows logos only, so that alt is
 * the sole accessible label for each carrier.
 *
 * ⚠ Publishing a carrier name or mark asserts an active appointment and
 * reproduces a third-party trademark. Both should be confirmed with Compliance
 * before launch, and re-confirmed whenever this list changes. See
 * web/public/images/carriers/README.md.
 */
export interface Market {
  name: string;
  slug: string;
}

export const MARKETS: Market[] = [
  { name: "Amwins", slug: "amwins" },
  { name: "CAIS", slug: "cais" },
  { name: "Community Association Underwriters", slug: "community-association-underwriters" },
  { name: "CondoLogic", slug: "condologic" },
  { name: "Distinguished", slug: "distinguished" },
  { name: "Greater New York", slug: "greater-new-york" },
  { name: "Honeycomb", slug: "honeycomb" },
  { name: "LIO Insurance", slug: "lio-insurance" },
  { name: "McGowan", slug: "mcgowan" },
  { name: "Pathpoint", slug: "pathpoint" },
  { name: "RPS", slug: "rps" },
  { name: "Travelers", slug: "travelers" },
];
