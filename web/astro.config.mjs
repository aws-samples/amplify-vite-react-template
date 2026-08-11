import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";
import { reviewedStateSlugs } from "./src/data/states.ts";

/**
 * State pages whose content is still generic are served `noindex` (see
 * data/states.ts `reviewed`). They must also be kept out of the sitemap —
 * submitting a noindex URL for indexing is a contradictory signal and wastes
 * crawl budget. Imported from the data file rather than hardcoded so flipping a
 * state to `reviewed: true` adds it to the sitemap in the same edit.
 */
const isUnreviewedStatePage = (page) => {
  const m = page.match(/\/hoa-insurance-([a-z-]+)\/?$/);
  if (!m) return false;
  const slug = m[1];
  // City pages are /hoa-insurance-{city}-{st} and always end in a two-letter
  // segment; no state slug does ("north-carolina" ends in 8 letters). They stay.
  if (/-[a-z]{2}$/.test(slug)) return false;
  return !reviewedStateSlugs.includes(slug);
};

export default defineConfig({
  site: "https://www.protectmyhoa.com",
  integrations: [
    react(),
    sitemap({
      filter: (page) =>
        // Private association pages: PM-distributed links, not organic targets.
        !page.includes("/associations/") && !isUnreviewedStatePage(page),
    }),
  ],
  output: "static",
});
