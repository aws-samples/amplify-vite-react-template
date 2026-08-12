# BuzzKill — Analytics Reference

What the public marketing site (`apps/web`) tracks, how it's wired, and what
still needs to be configured in the GA4 dashboard. This is the single source of
truth for analytics on `www.pestbuzzkill.com`.

_Last updated: 2026-07-24._

---

## 1. Platforms

| Tool | ID | Purpose | Where configured |
| --- | --- | --- | --- |
| **Google Analytics 4** | `G-PEL59Y653T` (production) | Traffic, behavior, conversions | `index.html` + `src/lib/analytics.ts` |
| **Microsoft Clarity** | `wan5977c41` | Session replay + heatmaps | `index.html` |

- The GA4 property ID is **environment-driven** via `VITE_GA_ID`. Production
  falls back to `G-PEL59Y653T`; set `VITE_GA_ID` on the **staging** Amplify
  branch to a separate GA4 property so QA traffic never pollutes production.
- Both tags load in `index.html`, so they run on **every page** (including the
  `/lp/*` ad landing pages).
- GA4 loads with `send_page_view: false` — the SPA sends page views itself (see
  §4) so client-side route changes are captured and not double-counted.

---

## 2. How tracking is wired (code)

| File | Responsibility |
| --- | --- |
| `index.html` | Loads gtag.js (env-driven ID) + Microsoft Clarity |
| `src/lib/analytics.ts` | Event taxonomy + all `track*` helper functions |
| `src/components/AnalyticsTracker.tsx` | Fires one `page_view` per route (waits for the page title) |
| `src/components/ClickTracker.tsx` | Fires `cta_click` for every `<a>`/`<button>` via one delegated listener |
| `src/components/ScrollDepthTracker.tsx` | Fires `scroll_depth` at 25/50/75/90/100% |
| `src/components/SEO.tsx` | Sets each page's `<title>` (read by `page_view`) |
| Forms (see §5) | Fire `form_submit`, `generate_lead`, `purchase` |

The three tracker components mount once at the app root, so they cover **all
routes** with no per-page wiring.

---

## 3. Automatic tracking (GA4 built-in — no code)

Collected automatically by gtag.js:

- **Users** — `client_id` (persistent cookie) identifies the browser/device.
- **Sessions** — `session_id`, `ga_session_number`, `session_start`, engagement time.
- **Acquisition / attribution** — source / medium / campaign / term / content,
  parsed automatically from standard `utm_*` params and Google Ads `gclid`.
- **Geo, device, browser, language** — standard GA4 dimensions.

> First-touch attribution is *also* captured app-side by `captureAttribution()`
> (in `App.tsx`) and stored in `sessionStorage`, then sent with each lead to the
> CRM — separate from GA4, so sales can see a lead's original source.

### 3.1 Lead ID stitching

Once any form reports a lead, `setLeadId()` (in `src/lib/analytics.ts`) persists
it to `sessionStorage` under `bk_lead_id` and it is attached **two ways**:

| Scope | Mechanism | What it buys you |
| --- | --- | --- |
| Event | `trackEvent` stamps `lead_id` on **every subsequent event** | Any single event — `cta_click`, `purchase`, `scroll_depth` — traces to the CRM record |
| User | `gtag('set','user_properties',{lead_id})` | GA4 attributes the lead to the whole user, **including the page views before the form was submitted**, so Explore can replay the full path that produced the lead |

`lead_id` survives route changes and reloads for the whole session, which is
what lets a `purchase` on `/book` join back to a lead created earlier on
`/contact`. Last write wins (newest lead is the one the session is working on) —
the opposite of attribution, where first touch wins.

The id is also pushed to Clarity as a custom tag (`clarity('set','lead_id',…)`),
so a lead's **session recording** is filterable by the same key GA4 reports on.

### 3.2 Tagging emailed links

An emailed link should carry three things. Sample:

```
https://www.pestbuzzkill.com/quote
  ?lead=W8xK2mQ7vR...           ← capability. NEVER reaches analytics.
  &bk_lid=c7f3a9e2-4b1d-...     ← CRM lead id. This is what GA4 tracks.
  &utm_source=buzzkill
  &utm_medium=email
  &utm_campaign=quote_followup
  &utm_content=cta_button
```

| Param | Purpose | Read by |
| --- | --- | --- |
| `lead` | Existing capability token — prefills the lead's details, decides whose booking a payment converts | `QuotePage`, resolved server-side |
| `bk_lid` | The CRM lead id. `captureLandingParams()` (called in `main.tsx` before render) adopts it, so **the very first `page_view` of the visit already names the lead** | `src/lib/analytics.ts` |
| `utm_*` | Standard campaign attribution, parsed by GA4 automatically | GA4, plus `captureAttribution()` |

`bk_lid` is safe in a URL — an opaque CRM id, not a capability, and the same id
already reported as `lead_id`. `lead` is **not**: see §3.3.

**Address bar:** `captureLandingParams()` (called in `main.tsx` before render)
reads everything the landing URL carries, hands it to the tags, then erases
`utm_*`, `utm_id`, and `bk_lid` via `replaceState`. The visitor ends up on a bare
`https://www.pestbuzzkill.com/quote/instant` with full tracking intact.

Campaign attribution normally works by gtag parsing `utm_*` out of the page URL,
so erasing them would report the session as **direct / none** — and because
gtag.js loads async it may parse the URL *after* the cleanup, making the naive
version fail intermittently rather than cleanly. Two deliberately redundant
defences, because the failure mode is silent:

1. **`gtag('set','campaign',…)`** — values pushed to GA4 explicitly, so
   attribution no longer depends on the URL surviving at all.
2. **`landingHref`** — the original URL is retained and reported as the *first*
   `page_view`'s `page_location`, so GA4's own parsing sees what it always saw.
   Consumed once; later page views report their own URL.

Three things are **not** erased, with tests pinning each:

| Kept | Why removing it breaks things |
| --- | --- |
| `gclid` | gtag turns it into the `_gcl_aw` cookie carrying Google Ads click attribution. gtag.js loads async and may still be reading the URL; the explicit campaign push covers GA4 but *not* that cookie. Never appears on an email link anyway. |
| `lead` | `QuotePage` reads it from the address bar in its own effect. Removing it breaks form prefill and which lead a payment converts. |
| hash | Carries the saved-quote resume tokens (`#request=…&token=…`). |

> `main.tsx` calls `captureAttribution()` **before** `captureLandingParams()`.
> That order is load-bearing: the CRM's first-touch lead source reads the same
> `utm_*` params, and the cleanup erases them. `App.tsx` still calls
> `captureAttribution()` in an effect as an idempotent safety net.

### 3.3 Capability redaction (security)

`?lead=<token>` is a 7-day capability that prefills a lead's contact and address
details and decides whose booking a payment converts. `/track/<token>` is a
private live-tracking link. `#request=…&token=…` resumes a saved quote.

None of these may reach GA4 or Clarity: an analytics property is read by more
people than the funnel is, retains data for months, and surfaces raw URLs inside
session replays. `sanitizeAnalyticsPath()` / `sanitizeAnalyticsUrl()` strip them
from every event's `page_path` and `page_location`, and mask the `/track/`
segment to `/track/(token)`.

> The funnel does `history.replaceState` to clear `?lead=` from the address bar,
> but that runs inside a lazily-loaded page's effect and is **not** guaranteed to
> beat the first `page_view`. Redaction at the analytics layer is the guarantee;
> do not rely on the address-bar strip alone.

`bk_lid` is redacted from `page_path` too — not for secrecy, but because leaving
it there would fragment the Pages report into one row per lead.

---

## 4. Event taxonomy (custom events)

All event names live in `GA_EVENTS` in `src/lib/analytics.ts`.

### 4.1 `page_view` — every page / route
Fired by `AnalyticsTracker` on every route change (incl. `/lp/*`).

| Parameter | Example | Meaning |
| --- | --- | --- |
| `page_path` | `/services/termite` | URL path + query |
| `page_location` | `https://www.pestbuzzkill.com/services/termite` | Full URL |
| `page_title` | `Termite Inspection & Control — MA & RI \| BuzzKill Pest Control` | Page name |

> The homepage is reported to GA as `page_path = /home` (its real URL and
> `page_location` stay `/`) so it reads like every other page in path reports.
> This is GA-display-only — SEO, canonical, sitemap, and Google Ads use the
> true `/` URL and are unaffected.

### 4.2 `cta_click` — every button & link
Fired by `ClickTracker` (one delegated `document` listener over all `<a>`/`<button>`).

| Parameter | Example | Meaning |
| --- | --- | --- |
| `page_path` | `/` | Page the click happened on |
| `button_id` | `nav_get_instant_quote` | Explicit `data-track-id`, else a slug of the text |
| `button_text` | `Get an Instant Quote` | Visible label (max 120 chars) |
| `destination` | `/quote`, `form_submit`, `action` | Where the click leads |

Hand-tagged high-value IDs include: `nav_get_instant_quote`, `topbar_phone`,
`topbar_customer_login`, `quote_cta_primary`, `quote_cta_phone`,
`quote_card_cta`, `quote_card_phone`, `footer_phone`, `footer_start_service`,
`talk_to_expert_submit`, `contact_form_submit`. Any element can opt out with
`data-no-track`.

### 4.3 `scroll_depth` — reading depth
Fired by `ScrollDepthTracker`, once per threshold per page view.

| Parameter | Values | Meaning |
| --- | --- | --- |
| `page_path` | e.g. `/communities` | Page scrolled |
| `percent` | `25` \| `50` \| `75` \| `90` \| `100` | Deepest milestone reached |

### 4.4 `form_submit` — every form attempt (success AND error)
Fired from all 5 forms. Base params always present, plus form-specific extras.

**Always present**

| Parameter | Values | Meaning |
| --- | --- | --- |
| `page_path` | URL path | Where the form was submitted |
| `form_id` | see below | Which form |
| `status` | `success` \| `error` | Outcome (drop-off tracking) |

**`form_id` values:** `contact`, `talk_to_expert`, `quote`, `quote_contact`,
`book`, `book_payment`, `cancel`.

**Extra parameters (by form)**

| Extra param | Appears on | Meaning |
| --- | --- | --- |
| `lead_id` | contact, talk_to_expert (success) | CRM lead id |
| `booking_id` | quote, book (success) | Booking record id |
| `decision` | quote (success) | `PRICED` vs `CONTACT` |
| `errors` | quote (error) | Comma-joined failed field names |
| `error` | contact, talk_to_expert, book (error) | Error message |
| `refunded` | cancel (success) | Whether the cancellation refunded |

> Known quirk: booking/cancel error paths sometimes overwrite `status` with an
> HTTP code (e.g. `503`, `404`) instead of `error`. Functional, but that
> dimension will occasionally show a number.

### 4.5 `generate_lead` — a real lead (GA4 standard event → conversion)

| Parameter | Meaning |
| --- | --- |
| `page_path` | Page that generated the lead |
| `form_id` | `contact` \| `talk_to_expert` \| `quote_contact` |
| `lead_id` | CRM lead id — links the GA session to the CRM record |

### 4.6 `purchase` — a paid booking (GA4 standard ecommerce → conversion)

| Parameter | Meaning |
| --- | --- |
| `page_path` | Page where purchase completed |
| `transaction_id` | Booking / payment id (dedupes) |
| `booking_id` | Same id, under the dimension the funnel's `form_submit` already uses |
| `value` | Revenue in dollars (`amountCents / 100`) |
| `currency` | `USD` |
| `lead_id` | Auto-attached when the session produced a lead — ties revenue to the CRM lead |

---

## 5. Where conversion events fire

| Surface | `form_submit` | `generate_lead` | `purchase` |
| --- | --- | --- | --- |
| Talk-to-Expert modal | ✅ | ✅ | — |
| Contact page | ✅ | ✅ | — |
| Booking `/quote` | ✅ | ✅ (contact case) | — |
| Booking `/book` | ✅ | — | ✅ |
| Booking `/cancel` | ✅ | — | — |

The `/lp/*` landing pages have no on-page forms — they route to `/quote` or a
`tel:` link (both captured by `cta_click`).

---

## 6. Custom dimensions to register (GA4 Admin)

GA4 collects these params but will **not show them in reports** until registered
as **Event-scoped custom dimensions** (Admin → Custom definitions). Not
retroactive — register soon.

| Dimension name | Event parameter | From event |
| --- | --- | --- |
| Button ID | `button_id` | cta_click |
| Button Text | `button_text` | cta_click |
| Destination | `destination` | cta_click |
| Scroll Percent | `percent` | scroll_depth |
| Form ID | `form_id` | form_submit, generate_lead |
| Form Status | `status` | form_submit |
| Lead ID | `lead_id` | **all events** (auto-attached once known) |
| Booking ID | `booking_id` | form_submit, purchase |
| Quote Decision | `decision` | form_submit |
| Error | `error` | form_submit |
| Error Fields | `errors` | form_submit |
| Refunded | `refunded` | form_submit |

Do **not** register (already built-in): `page_path`, `page_location`,
`page_title`, `transaction_id`, `value`, `currency`.

**Also register one USER-scoped dimension** (Admin → Custom definitions → Custom
user properties, *not* the event-scoped tab):

| Dimension name | User property | Why separate |
| --- | --- | --- |
| Lead ID (User) | `lead_id` | Event scope only shows events after the lead existed; user scope covers the whole session, including the page views that led up to it |

So `lead_id` is registered **twice** — once event-scoped, once user-scoped. They
are different dimensions in GA4 and both are needed.

---

## 7. Key events (conversions)

Mark these as **Key events** in GA4 Admin → Events so they count as conversions
and can import into Google Ads:

- `generate_lead`
- `purchase`

---

## 8. Microsoft Clarity

- Project `wan5977c41`, loaded in `index.html` → covers all pages.
- Provides **session recordings**, **heatmaps**, click/scroll behavior, rage/dead-click detection.
- Filter staging vs production by **hostname** inside Clarity (no separate project needed).

---

## 9. Per-page coverage

Every route fires `page_view` + is covered by click and scroll tracking —
including `noindex` pages. `noindex` affects **Google indexing only**, not GA4:
booking (`/quote`, `/book`, `/cancel`), ad landing (`/lp/*`), and legal
(`/privacy-policy`, `/terms-of-service`) pages are **still tracked** in GA4.

See `docs/` page-title reference for the exact `page_path` → `page_title` map.

---

## 10. Not tracked (known limits)

- Form **field-level** interaction (which field abandoned, time per field) — only submit success/error.
- **Outbound link / file download** tracking — only if GA4 Enhanced Measurement is enabled on the Web Stream (verify).
- **Video / element-level** scroll — only whole-page scroll depth.
- Heatmaps / session replay / rage clicks — handled by **Clarity**, not GA4.

---

## 11. Setup checklist

**Code (done):**
- [x] GA4 + Clarity load on all pages
- [x] Env-driven GA4 property (`VITE_GA_ID`)
- [x] Accurate SPA page views (path + title)
- [x] Click, scroll, form, lead, purchase events

**Dashboard / infra (to do):**
- [ ] Set `VITE_GA_ID` on the staging Amplify branch → separate GA4 property
- [ ] Register the 12 event-scoped custom dimensions (§6)
- [ ] Register the `lead_id` **user-scoped** dimension (§6)
- [ ] Mark `generate_lead` + `purchase` as Key events (§7)
- [ ] Submit `sitemap.xml` in Google Search Console
- [ ] Link GA4 ↔ Google Ads + enable auto-tagging (gclid)
- [ ] Confirm Enhanced Measurement settings on the Web Stream
- [ ] Consent/cookie banner (compliance — deferred to overhaul)

---

## 12. How to verify

- **GA4 → Realtime** — browse the site; confirm each page shows its own path + title, and events (`cta_click`, `scroll_depth`, `form_submit`) appear.
- **GA4 → Admin → DebugView** (with the GA Debugger extension) — inspect event params live.
- **Google Search Console → URL Inspection → Test Live URL** — see the rendered HTML Google indexes.
- **Clarity dashboard** — confirm recordings + heatmaps populate.
