# Website Structure & SEO Reference — protectmyhoa.com

**Purpose:** a pre-edit reference for updating site content **without disturbing the SEO surface that is currently producing organic leads.**

Generated from a full read of `web/` plus a production build (`npm --prefix web run build`) on 2026-08-06.
All page counts, titles, and URLs in this document were extracted from the built `dist/` output — they are what the site actually ships, not what the templates suggest.

---

## Contents

1. [Read this first — the analytics situation](#1-read-this-first--the-analytics-situation)
2. [Repository layout](#2-repository-layout)
3. [Page inventory](#3-page-inventory)
4. [Complete title list](#4-complete-title-list)
5. [Where the SEO lives](#5-where-the-seo-lives)
6. [Edit safety classification](#6-edit-safety-classification)
7. [Structured data](#7-structured-data)
8. [Internal link graph](#8-internal-link-graph)
9. [Agency identity (NAP)](#9-agency-identity-nap)
10. [Forms & lead flow](#10-forms--lead-flow)
11. [Environment variables](#11-environment-variables)
12. [Build & deploy](#12-build--deploy)
13. [Known issues](#13-known-issues)
14. [Pre-commit verification procedure](#14-pre-commit-verification-procedure)

---

## 1. Read this first — the analytics situation

**There is no Google Analytics on this site.** No GA4, no `G-XXXXXXXXXX` measurement ID, no Universal Analytics property. What is actually installed:

| Tag | ID | What it does |
| --- | --- | --- |
| Google **Ads** (gtag.js) | `AW-18085022517` | Ad conversion tracking only |
| Microsoft Clarity | `wamnker55b` | Session recordings + heatmaps |

`gtag.js` loaded with an `AW-` account ID reports to **Google Ads**, not to GA4. Two consequences:

- Your organic traffic data is coming from **Google Search Console**, which is external to this repo. No content edit can break it.
- There is **no on-site organic analytics baseline** in the codebase to preserve or compare against.

### Conversion tracking is already broken

Documented in-code at [`web/src/constants.ts:44-51`](../web/src/constants.ts#L44-L51):

> `window.gtag` is never defined, because Astro compiles the `<head>` snippet to `type="module"`, which keeps its `gtag` function out of global scope. **Verified on production.** Left as-is deliberately: making conversions actually fire is a behaviour change, not an env change.

So `fireConversion()` silently no-ops on every page. **Leads still arrive** — the forms post to email, the CRM, and Zapier independently of gtag. But Google Ads is never told about them.

This is pre-existing and **not** something a content edit would cause. It is recorded here because "leads are coming through" and "conversions are being recorded" are currently two different facts.

---

## 2. Repository layout

Monorepo, two independently deployed Amplify apps:

| App | Path | Stack | SEO relevant? |
| --- | --- | --- | --- |
| Marketing site | `web/` | Astro 5.18 static + React islands | **Yes — this is the whole public site** |
| CRM | `crm/` | Vite + React SPA, Amplify Gen 2 (Cognito, AppSync/DynamoDB, S3, Lambda/Textract) | No — authenticated internal tool |
| Shared | `shared/` | Dependency-free constants used by both | Yes — feeds JSON-LD |

Branches: `staging` (pre-production, both apps build it) → `main` (production). Land work on `staging`, verify on the staging URLs, then merge.

### `web/` source tree

```
web/
├── astro.config.mjs            # site URL, sitemap integration + exclusion filter
├── public/
│   ├── robots.txt              # crawl directives
│   ├── favicon.png, logo.png
│   └── images/                 # incl. hero-video.mp4 (28 MB)
├── scripts/
│   └── sync-buildium.ts        # generates data/properties.json
└── src/
    ├── constants.ts            # analytics switch, conversion fn, nav links, socials
    ├── layouts/
    │   └── Layout.astro        # THE SEO HEAD for 34 of 43 indexable pages
    ├── pages/                  # 11 templates → 107 pages
    ├── components/
    │   ├── Navbar.astro, Footer.astro, Hero.astro
    │   ├── ContactForm.tsx, CoverageCalculator.tsx
    │   ├── InstantAssessment.tsx, AssociationLeadForm.tsx
    │   ├── QuoteApp.tsx
    │   └── quote/              # schema, session, submission, ui, icons, theme
    ├── data/
    │   ├── states.ts           # 6 state pages
    │   ├── cities.ts           # 22 city pages
    │   ├── landing-pages.ts    # 8 get-started pages
    │   └── properties.json     # 64 association pages
    ├── lib/crmLead.ts          # web → CRM AppSync write
    └── styles/                 # global.css, quote.css + per-page CSS
```

---

## 3. Page inventory

**107 HTML pages** from **11 templates**. 43 indexable, 64 deliberately hidden.

| Group | Count | Template | Data source | In sitemap |
| --- | --- | --- | --- | --- |
| Static pages | 7 | one `.astro` each | hand-written | Yes |
| State pages | 6 | `hoa-insurance-[state].astro` | `states.ts` | Yes |
| City pages | 22 | `hoa-insurance-[city]-[stateAbbr].astro` | `cities.ts` | Yes |
| Get-started landers | 8 | `get-started/[...slug].astro` | `landing-pages.ts` | Yes |
| Association pages | 64 | `associations/[slug].astro` | `properties.json` | **No — noindex** |
| **Total** | **107** | | | **43 indexed** |

### The 64 association pages are hidden on purpose

Private, property-manager-distributed HO-6 links generated by the Buildium sync. **Three independent guards — all must stay:**

1. `<meta name="robots" content="noindex, nofollow">` + `<meta name="googlebot" ...>` — [`associations/[slug].astro:42-43`](../web/src/pages/associations/%5Bslug%5D.astro#L42-L43)
2. `Disallow: /associations/` — [`web/public/robots.txt:3`](../web/public/robots.txt#L3)
3. Sitemap exclusion filter — [`web/astro.config.mjs:12`](../web/astro.config.mjs#L12)

### robots.txt

```
User-agent: *
Allow: /
Disallow: /associations/

Sitemap: https://www.protectmyhoa.com/sitemap-index.xml
```

---

## 4. Complete title list

### Static pages (7)

| URL | `<title>` | Len |
| --- | --- | --- |
| `/` | HOA Insurance for Condominium Associations & Unit Owners — ProtectMyHOA | 73 |
| `/about-us` | About HOA Insurance Agency — Independent HOA & Condo Insurance Brokerage | 74 |
| `/what-we-do` | HOA Insurance & HO-6 Coverage — ProtectMyHOA | 43 |
| `/why-choose-us` | Why Choose HOA Insurance Agency — Specialists in HOA & Condo Insurance | 72 |
| `/quote` | HOA Insurance Quote · ProtectMyHOA | 34 |
| `/privacy-policy` | Privacy Policy — HOA Insurance Agency | 37 |
| `/terms-of-service` | Terms of Service — HOA Insurance Agency | 39 |

### State pages (6) — `states.ts` → `title`

| URL | `<title>` |
| --- | --- |
| `/hoa-insurance-massachusetts` | HOA Insurance in Massachusetts — ProtectMyHOA |
| `/hoa-insurance-rhode-island` | HOA Insurance in Rhode Island — ProtectMyHOA |
| `/hoa-insurance-new-hampshire` | HOA Insurance in New Hampshire — ProtectMyHOA |
| `/hoa-insurance-connecticut` | HOA Insurance in Connecticut — ProtectMyHOA |
| `/hoa-insurance-new-york` | HOA Insurance in New York — ProtectMyHOA |
| `/hoa-insurance-oklahoma` | HOA Insurance in Oklahoma — ProtectMyHOA |

### City pages (22) — `cities.ts` → `title`

| URL | `<title>` |
| --- | --- |
| `/hoa-insurance-boston-ma` | HOA Insurance in Boston, MA — ProtectMyHOA |
| `/hoa-insurance-worcester-ma` | HOA Insurance in Worcester, MA — ProtectMyHOA |
| `/hoa-insurance-springfield-ma` | HOA Insurance in Springfield, MA — ProtectMyHOA |
| `/hoa-insurance-cambridge-ma` | HOA Insurance in Cambridge, MA — ProtectMyHOA |
| `/hoa-insurance-marlborough-ma` | HOA Insurance in Marlborough, MA — ProtectMyHOA |
| `/hoa-insurance-providence-ri` | HOA Insurance in Providence, RI — ProtectMyHOA |
| `/hoa-insurance-warwick-ri` | HOA Insurance in Warwick, RI — ProtectMyHOA |
| `/hoa-insurance-cranston-ri` | HOA Insurance in Cranston, RI — ProtectMyHOA |
| `/hoa-insurance-manchester-nh` | HOA Insurance in Manchester, NH — ProtectMyHOA |
| `/hoa-insurance-nashua-nh` | HOA Insurance in Nashua, NH — ProtectMyHOA |
| `/hoa-insurance-concord-nh` | HOA Insurance in Concord, NH — ProtectMyHOA |
| `/hoa-insurance-hartford-ct` | HOA Insurance in Hartford, CT — ProtectMyHOA |
| `/hoa-insurance-stamford-ct` | HOA Insurance in Stamford, CT — ProtectMyHOA |
| `/hoa-insurance-new-haven-ct` | HOA Insurance in New Haven, CT — ProtectMyHOA |
| `/hoa-insurance-bridgeport-ct` | HOA Insurance in Bridgeport, CT — ProtectMyHOA |
| `/hoa-insurance-new-york-city-ny` | HOA Insurance in New York City — ProtectMyHOA |
| `/hoa-insurance-buffalo-ny` | HOA Insurance in Buffalo, NY — ProtectMyHOA |
| `/hoa-insurance-rochester-ny` | HOA Insurance in Rochester, NY — ProtectMyHOA |
| `/hoa-insurance-albany-ny` | HOA Insurance in Albany, NY — ProtectMyHOA |
| `/hoa-insurance-oklahoma-city-ok` | HOA Insurance in Oklahoma City — ProtectMyHOA |
| `/hoa-insurance-tulsa-ok` | HOA Insurance in Tulsa, OK — ProtectMyHOA |
| `/hoa-insurance-norman-ok` | HOA Insurance in Norman, OK — ProtectMyHOA |

### Get-started landing pages (8) — `landing-pages.ts` → `metaTitle`

| URL | `<title>` |
| --- | --- |
| `/get-started` | Free HOA Insurance Assessment — ProtectMyHOA |
| `/get-started/massachusetts` | Free Massachusetts HOA Insurance Assessment — ProtectMyHOA |
| `/get-started/rhode-island` | Free Rhode Island HOA Insurance Assessment — ProtectMyHOA |
| `/get-started/new-hampshire` | Free New Hampshire HOA Insurance Assessment — ProtectMyHOA |
| `/get-started/connecticut` | Free Connecticut HOA Insurance Assessment — ProtectMyHOA |
| `/get-started/new-york` | Free New York HOA Insurance Assessment — ProtectMyHOA |
| `/get-started/oklahoma` | Free Oklahoma HOA Insurance Assessment — ProtectMyHOA |
| `/get-started/new-england` | Free New England HOA Insurance Assessment — ProtectMyHOA |

### Association pages (64, noindex) — one template

```
HO-6 Condo Insurance for {property.name} — ProtectMyHOA
```

[`associations/[slug].astro:49`](../web/src/pages/associations/%5Bslug%5D.astro#L49). The 64 `{property.name}` values from `properties.json`:

114 Elm Street Condominium · 26 Moseley St Condominiums · 420 Lakeside Office Condominium Trust · 43 Withington St Condominiums · 52 Withington St Condominium · 65-69 Nightingale Condominium · 66 Hamilton Street Condominium · 680 South Ave Condominium Trust · 7 Oakcrest Condominium · 73 Dix Street Condominium · 755 Lofts Condominiums · 81 Summer St Condominium · Adams House Condominium · Admiral Dewey House Condominium · Alpine Village Condominium · Applewood Three Condominium Association · Applewood Two Condominium Association · Baiting Brook Farm Condominium · Baseball Factory · Chestnut Grove Condominium Trust · Chestnut Hill Woods · Craftsman Village Condominium · Custer Estate Condominium Trust · Cypress Gardens Condominiums · Eagles View Condominiums · Explorers @ VOAT · Fairland Gardens Condominiums · Fallbrook Condominium · Forge Hill Condominium · Freedom Village @ VOAT · Furnace Brook Estates · Geneva Mills Condominium · Hadwen Park Place II Condominiums · High Rock Condominiums · Independence Village @ VOAT · Ledgewood Estates Condominium Trust · Longley Trace Condominium Trust · Louisiana Purchase @ VOAT · Maple Ridge Town Home Condominium · Mayflower Landing @ VOAT · Medfield Crossing Condominium Trust · Mosley Park Condominium Trust · Northside Meadow Condominium Trust · Oak Knoll Condominium · Old Stone Bridge Acres Condominiums · One Hundred Captains Row Condominium Trust · Partridge Berry Hills Condominium Association · Pheasant Hill Condominium Trust · Pizzi Farm · Reservoir Place Condominium · Residences at Stedman · River Village Condominium · Rose Stone Village Condominium · Sargent Estates Condominiums · Sixteen Everett Ave Condominiums · Spruce Hill Condominium Association · The Villages At Dale Woods Condominiums · Trail View Condominium · Trailside Terrace Condominiums · Uncommon Place Condominium · Vecchia Gardens Condominium · VOAT Infrastructure Trust · Weatherstone at Blithewood Condominium · Webber Village Condominium

---

## 5. Where the SEO lives

### One shared head for most of the site

[`web/src/layouts/Layout.astro`](../web/src/layouts/Layout.astro) is the single `<head>` for **34 of 43** indexable pages. It owns:

- `<title>`, `<meta name="description">`
- `<link rel="canonical">` — built as `https://www.protectmyhoa.com` + `canonicalPath`
- Open Graph: `og:type`, `og:title`, `og:description`, `og:image`, `og:url`, `og:site_name`
- Twitter: `summary_large_image` card + title/description/image
- The `InsuranceAgency` JSON-LD block
- Both analytics tags

Pages feed it four props: `title`, `description`, `canonicalPath`, `jsonLd`.

### Three pages bypass the layout

`/quote`, `/get-started/*`, and `/associations/*` each hand-roll their own `<html>`/`<head>`. This is why the analytics snippet is duplicated **four times**. Change one, change all four:

| File | Analytics lines |
| --- | --- |
| [`layouts/Layout.astro`](../web/src/layouts/Layout.astro#L74-L95) | 74–95 |
| [`pages/quote.astro`](../web/src/pages/quote.astro#L23-L44) | 23–44 |
| [`pages/get-started/[...slug].astro`](../web/src/pages/get-started/%5B...slug%5D.astro#L63-L84) | 63–84 |
| [`pages/associations/[slug].astro`](../web/src/pages/associations/%5Bslug%5D.astro#L52-L73) | 52–73 |

Consequences of the bypass:
- `/quote` and `/get-started/*` have **no Twitter card and no `og:image`**.
- `/associations/*` has **no canonical and no JSON-LD** (fine — it is noindex).

### Heading structure (verified in built HTML)

| Page | H1 | H2 | H3 | JSON-LD blocks |
| --- | --- | --- | --- | --- |
| `/` | 1 | 8 | 12 | 2 |
| `/about-us` | 1 | 4 | 1 | 1 |
| `/what-we-do` | 1 | 6 | 9 | 2 |
| `/why-choose-us` | 1 | 5 | 1 | 1 |
| `/hoa-insurance-massachusetts` | 1 | 6 | 8 | 1 |
| `/hoa-insurance-boston-ma` | 1 | 4 | 1 | 1 |
| `/get-started` | 1 | 0 | 1 | 1 |
| `/quote` | **0** | 0 | 0 | **0** |

Every page has exactly one H1 except `/quote` (see [Known issues](#13-known-issues)). H1 text comes from:

- Static pages → the `<Hero title="...">` prop
- State pages → `states.ts` → `heroTitle`
- City pages → `cities.ts` → `heroTitle`
- Get-started → `landing-pages.ts` → `headline`

---

## 6. Edit safety classification

### 🔴 DO NOT CHANGE — URLs and ranking signals

| What | Where |
| --- | --- |
| `slug` fields | `states.ts`, `cities.ts`, `landing-pages.ts` — **these ARE the URLs** |
| Filenames in `src/pages/` | renaming = new URL = lost ranking |
| `title` / `description` | `states.ts`, `cities.ts` |
| `metaTitle` / `metaDescription` | `landing-pages.ts` |
| `title=` / `description=` / `canonicalPath=` props | the 7 static pages |
| `faqJsonLd` blocks | [`index.astro:33-50`](../web/src/pages/index.astro#L33-L50), [`what-we-do.astro:33-47`](../web/src/pages/what-we-do.astro#L33-L47) |
| `baseSchema` | [`Layout.astro:28-57`](../web/src/layouts/Layout.astro#L28-L57) |
| The `<head>` of `Layout.astro` | canonical / OG / Twitter machinery |
| `robots.txt`, `astro.config.mjs` | crawl directives + sitemap filter |
| The 3 noindex guards | see §3 |

### 🟡 CAREFUL — H1s, link graph, NAP

- **`heroTitle`** (states/cities) and **`headline`** (landing-pages) render as the **H1**. Editable, but keep the primary keyword — H1 is a genuine ranking signal.
- **`cities: [...]`** array in `states.ts` drives state→city internal links. Removing a name orphans that city page from its hub.
- **Phone / email / address** live in [`shared/agency.ts`](../shared/agency.ts) and feed the JSON-LD `PostalAddress`. This is your NAP consistency for local SEO — it must keep matching your Google Business Profile.
- **FAQ answer text** on `/` and `/what-we-do` is *both* visible copy and `FAQPage` schema — the same array feeds both. Rewording changes your rich-result markup. Treat as 🔴.

### 🟢 SAFE — pure content

- All body copy in the 7 static pages (everything below the `<Layout ...>` props)
- `intro`, `regulations`, `hoaTypes` in `states.ts`
- `subheadline`, `trustSignals`, `urgencyText` in `landing-pages.ts`
- `Hero` `subtitle` and `eyebrow` props
- The content arrays: `COVERAGES`, `STEPS`, `CLIENT_TYPES` (index), `MASTER_COVERAGES`, `COMMON_ISSUES`, `HO6_COVERAGES` (what-we-do)
- All CSS files, all images

---

## 7. Structured data

### `InsuranceAgency` — every page via `Layout.astro`

```
@type:       InsuranceAgency
name:        HOA Insurance Agency
url:         https://www.protectmyhoa.com
telephone:   +1-508-233-2261        (derived from shared/agency.ts)
email:       insurance@ProtectMyHOA.com
address:     420 Lakeside Ave, Suite 202, Marlborough, MA 01752, US
areaServed:  MA, RI, NH, CT, NY, OK   (6 × @type: State)
sameAs:      Instagram, Facebook, LinkedIn
description: Independent insurance brokerage specializing in HOA master
             insurance policies and HO-6 condo unit owner coverage.
```

`/get-started/*` emits its own trimmed copy (no `areaServed`, no `sameAs`) at [`get-started/[...slug].astro:86-101`](../web/src/pages/get-started/%5B...slug%5D.astro#L86-L101).

### `FAQPage` — 2 pages only

Your highest-value and most fragile SEO asset — rich-result eligible.

| Page | Questions | Source |
| --- | --- | --- |
| `/` | 6 | [`index.astro:33-50`](../web/src/pages/index.astro#L33-L50) |
| `/what-we-do` | 3 | [`what-we-do.astro:33-47`](../web/src/pages/what-we-do.astro#L33-L47) |

Homepage questions: what is HOA master insurance · master vs HO-6 · do unit owners need HO-6 · what states served · how much does it cost · what to review at renewal.

---

## 8. Internal link graph

Hub-and-spoke, correctly built:

```
/  ──────────────► all 6 state pages
                   │
state page ────────┼──► its own city pages (from the `cities` array)
                   └──► /about-us /what-we-do /why-choose-us /quote
city page ─────────────► its parent state page
Navbar   (every page) ─► / /about-us /what-we-do /why-choose-us /#contact
Footer   (every page) ─► /privacy-policy /terms-of-service
```

Verified counts: `/` has 6 state links · `/hoa-insurance-massachusetts` links to all 5 MA cities · `/hoa-insurance-boston-ma` links back to MA.

Nav links are defined once in [`constants.ts:71-77`](../web/src/constants.ts#L71-L77). `NAV_LINKS` intentionally omits `/quote` and `/get-started`; the quote CTA is rendered separately.

**Note:** no page links to `/get-started/*` — those 8 pages are reachable only from ads and the sitemap. That is by design for paid traffic, but it means they receive no internal link equity.

---

## 9. Agency identity (NAP)

Single source of truth: [`shared/agency.ts`](../shared/agency.ts). Deliberately dependency-free so Astro pages, React islands, the Vite SPA, and Vitest can all import it.

| Field | Value |
| --- | --- |
| Legal name | HOA Insurance Agency LLC |
| Producer contact | Jake Greasley |
| Address | 420 Lakeside Ave, Suite 202, Marlborough, MA 01752 |
| Phone | 508-233-2261 |
| Email | insurance@ProtectMyHOA.com (canonical mixed case) |

`AGENCY_FMT` derives every reformatted variant — `tel:` href, E.164, schema.org `telephone`, footer address line, FormSubmit endpoint. **Edit `AGENCY` only; never hand-edit `AGENCY_FMT`.** One edit updates both the ACORD forms and the website footer.

Socials (in `constants.ts` → `SOCIAL`, and in the JSON-LD `sameAs`): Instagram `@hoainsuranceagency` · Facebook · LinkedIn `company/hoa-insurance-agency`.

---

## 10. Forms & lead flow

Four separate lead-capture surfaces:

| Component | Used on | Purpose |
| --- | --- | --- |
| `ContactForm.tsx` | `/`, `/what-we-do`, `/about-us`, `/why-choose-us`, state + city pages | General contact |
| `CoverageCalculator.tsx` | `/` | Interactive coverage estimator |
| `InstantAssessment.tsx` | `/get-started/*` | Ad-landing assessment funnel |
| `AssociationLeadForm.tsx` | `/associations/*` | HO-6 quote, pre-filled with property |
| `QuoteApp.tsx` | `/quote` | Multi-step quote wizard (`client:only`) |

Each submission can fan out to three destinations, all independent:

1. **Email** via FormSubmit → `https://formsubmit.co/ajax/insurance@protectmyhoa.com`
2. **CRM** via AppSync ([`lib/crmLead.ts`](../web/src/lib/crmLead.ts)) — skipped silently if `PUBLIC_CRM_API_URL` / `PUBLIC_CRM_API_KEY` are unset
3. **Zapier** webhooks — one per form type (`PUBLIC_ZAPIER_HOOK_HO6`, `_QUOTE`, `_LEAD`)

Because these are independent, the broken gtag conversion does not affect lead delivery.

---

## 11. Environment variables

From [`web/.env.example`](../web/.env.example). All are optional — the site builds and renders without any of them.

| Variable | Effect if unset |
| --- | --- |
| `PUBLIC_GOOGLE_PLACES_KEY` | Address autocomplete disabled |
| `PUBLIC_CRM_API_URL` / `PUBLIC_CRM_API_KEY` | Forms skip the CRM write, still send email |
| `PUBLIC_ANALYTICS_DISABLED` | **Analytics ON** (see below) |
| `PUBLIC_ZAPIER_HOOK_HO6` / `_QUOTE` / `_LEAD` | No Zapier routing |
| `PUBLIC_OWNER_LOOKUP_URL` | Owner lookup falls through gracefully |
| `BUILDIUM_CLIENT_ID` / `_SECRET` | Only used by `npm run sync`, never bundled |

### The analytics kill switch

`PUBLIC_ANALYTICS_DISABLED` is **on by default** — production needs no configuration, so analytics can never be lost to a forgotten variable. Set it to exactly `"true"` on the **staging** Amplify app and branch previews so test leads cannot register conversions against the live campaign or pollute Clarity.

**Local development:** the file comment says to leave it unset locally. That means **analytics tags are live on your local pages.** Read-only browsing is harmless, but if you plan to submit a test lead, create `web/.env` with `PUBLIC_ANALYTICS_DISABLED=true` first.

---

## 12. Build & deploy

```sh
cd web && npm install
npm run dev      # → http://localhost:4321
npm run build    # → web/dist  (107 pages, ~4.4s)
npm run preview
npm run sync     # regenerate data/properties.json from Buildium
```

Astro config: `site: "https://www.protectmyhoa.com"`, `output: "static"`, integrations `@astrojs/react` + `@astrojs/sitemap` (with the `/associations/` filter).

Deploy via [`amplify.yml`](../amplify.yml) — two `applications` entries keyed on `appRoot`. Each Amplify app sets `AMPLIFY_MONOREPO_APP_ROOT` to `web` or `crm`. The `web` app is frontend-only: `npm ci` → `npm run build` → publish `dist/`.

`dist/` is gitignored.

---

## 13. Known issues

Recorded for awareness. **None should be fixed as part of a content pass** — each is a separate, measurable change.

1. **Google Ads conversions never fire.** `window.gtag` is undefined because Astro compiles the head snippet as a module. Verified on production, documented at [`constants.ts:44-51`](../web/src/constants.ts#L44-L51).

2. **No GA4 anywhere.** Only an `AW-` Ads tag and Clarity. If organic reporting is wanted on-site, GA4 would need to be added.

3. **`/quote` is in the sitemap with zero crawlable content.** H1=0, H2=0, no JSON-LD, no body text — it renders `<QuoteApp client:only="react" />`, so crawlers get an empty shell. Submitted for indexing with nothing to index.

4. **8 ad landing pages are in the organic sitemap.** `/get-started/{state}` targets the same keywords as `/hoa-insurance-{state}` ("Massachusetts HOA insurance"), risking self-competition against the pages actually earning organic leads.

5. **Three titles exceed the ~60-char SERP limit** and are truncated in results: `/about-us` (74), `/` (73), `/why-choose-us` (72).

6. **`/quote` uses `·` as its title separator** while all 106 other pages use `—`.

7. **Two city titles drop the state abbreviation** — "HOA Insurance in New York City" and "HOA Insurance in Oklahoma City" break the `{City}, {ST}` pattern the other 20 follow. Data inconsistency in `cities.ts`.

8. **Near-duplicate titles:** `/hoa-insurance-new-york` ("...in New York") vs `/hoa-insurance-new-york-city-ny` ("...in New York City") — cannibalization risk between the state hub and its largest city page.

9. **Analytics snippet duplicated 4×** (see §5). A tag change must be made in all four files.

10. **Committed live credentials.** [`web/scripts/sync-buildium.ts:56-60`](../web/scripts/sync-buildium.ts#L56-L60) hardcodes `BUILDIUM_CLIENT_ID` and `BUILDIUM_CLIENT_SECRET` as `||` fallback defaults, while the file's own header documents both as required env vars. Present in the working tree and in git history on `staging`. **Rotating the credentials is the only effective remediation** — deleting the lines does not clear history. Carried over from a previous audit; see [`docs/audit/INVENTORY.md`](audit/INVENTORY.md) §6.

11. **28 MB `hero-video.mp4`** in `public/images/`, loaded on several pages. A Core Web Vitals concern (LCP), which is a ranking factor.

---

## 14. Pre-commit verification procedure

This is how you **prove** a content edit left the SEO surface untouched, rather than hoping it did.

Save the following as `web/seo-fingerprint.ps1`. It has been tested on this repo against all 107 pages — both that it passes on an unchanged build, and that it catches a single tampered `<title>` and names the page.

```powershell
# Fingerprints the SEO-bearing parts of every built page.
#   .\seo-fingerprint.ps1 -Save     → write baseline (run BEFORE editing)
#   .\seo-fingerprint.ps1           → compare against baseline (run AFTER)
param(
  [switch]$Save,
  [string]$Root     = 'web\dist',
  [string]$Baseline = 'web\seo-baseline.json'
)

function Get-SeoFingerprint {
  param([string]$Root)
  # Use .FullName, not $env:TEMP-style paths — 8.3 short names ("CHRIST~1")
  # will not string-match the long form returned by DirectoryName.
  $base = (Get-Item $Root).FullName
  Get-ChildItem -Recurse -Filter index.html $Root | ForEach-Object {
    $c = Get-Content $_.FullName -Raw
    [pscustomobject]@{
      url       = '/' + $_.DirectoryName.Substring($base.Length).TrimStart('\').Replace('\','/')
      # $(if ...) subexpressions are required — PowerShell 5.1 rejects a bare
      # `if` as a hashtable value ("The hash literal was incomplete").
      title     = $(if ($c -match '(?s)<title>(.*?)</title>') { $matches[1] } else { '' })
      desc      = $(if ($c -match '<meta name="description" content="([^"]*)"') { $matches[1] } else { '' })
      canonical = $(if ($c -match '<link rel="canonical" href="([^"]*)"') { $matches[1] } else { '' })
      robots    = $(if ($c -match '<meta name="robots" content="([^"]*)"') { $matches[1] } else { '' })
      h1        = ([regex]::Matches($c,'<h1[^>]*>')).Count
      jsonld    = (([regex]::Matches($c,'(?s)<script type="application/ld\+json">(.*?)</script>') |
                    ForEach-Object { $_.Groups[1].Value }) -join '~')
    }
  } | Sort-Object url
}

$FIELDS = 'url','title','desc','canonical','robots','h1','jsonld'
$current = Get-SeoFingerprint -Root $Root

if ($Save) {
  $current | ConvertTo-Json -Depth 3 -Compress | Out-File $Baseline -Encoding utf8
  "Baseline saved: $($current.Count) pages -> $Baseline"
  return
}

if (-not (Test-Path $Baseline)) { throw "No baseline at $Baseline. Run with -Save first." }
$diff = Compare-Object (Get-Content $Baseline -Raw | ConvertFrom-Json) $current -Property $FIELDS

if ($diff) {
  "SEO CHANGED - $($diff.Count) row(s):"
  $diff | Select-Object SideIndicator,url,title,desc,canonical,robots,h1 | Format-Table -AutoSize -Wrap
  "(<= baseline, => current)"
} else {
  "PASS - SEO surface unchanged across all $($current.Count) pages."
}
```

### Usage

```powershell
# BEFORE you edit
npm --prefix web run build
.\web\seo-fingerprint.ps1 -Save

# ... make your content edits ...

# AFTER you edit
npm --prefix web run build
.\web\seo-fingerprint.ps1
```

Also confirm the sitemap is stable:

```powershell
([xml](Get-Content web\dist\sitemap-0.xml -Raw)).urlset.url.loc.Count   # expect 43
```

**`PASS` means** every title, description, canonical, robots directive, H1 count, and JSON-LD payload on all 107 pages is identical to before your edit. Your organic rankings have nothing to react to.

**If it flags a row**, `SideIndicator` tells you which side changed (`<=` baseline, `=>` current) and `url` names the page — check it against the [edit safety classification](#6-edit-safety-classification) before deciding whether the change was intended.

Add `web/seo-baseline.json` to `.gitignore` if you don't want the baseline committed.

Then land on `staging`, verify on the staging URL, and merge to `main`.
