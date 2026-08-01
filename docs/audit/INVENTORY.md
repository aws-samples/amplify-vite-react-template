# BuzzKill Code Inventory — 2026-08-01

Structural audit. Findings are removed from this document as they are fixed.

> **Re-verification pass 2026-08-01 (HEAD `3bcb828`):** every section was re-verified against the current tree by six parallel read-only scans after the pagination migration rewrote ~100 backend files. All `file:LINE` references below are current at `3bcb828`. Corrections to the original scan's own errors are noted inline ("the original scan…"); new findings since the original scan are integrated in place, the largest being §1.1.6 (duplication the pagination migration introduced), the `as never` blind spot in §4.9, and the 114-site `pageErrors: "ignore"` swallow class in §1.5.

**Resolved so far**

| Item | Commit | What closed |
|---|---|---|
| #1, the migratable half | `4779b7e` | Seven of the thirteen hand-mirrored modules and constant blocks now have one copy, with the CRM re-exporting it. The rule is written up in [PATTERNS.md](PATTERNS.md). |
| #1, the remaining six mirrors — **item closed** | `b2e8339` `810c485` `0c129ab` `03bb6fb` `d81922c` | Each impure server module had its pure half extracted into a new leaf (`adminJobTypes`, `leadReasons`, `marketRateKeys`, `agingMath`), the engine re-exports its old surface, and the CRM barrels over the leaf — pattern 2 in [PATTERNS.md](PATTERNS.md). The sixth "mirror" (`planCadence` ← `seasonalCadenceCopy`) was not one; the phantom zero-caller canonical was deleted. One related gap stays open in [5.1](#51-hand-mirrored-modules--closed-one-related-gap-remains). |
| #2 Pagination — **item closed** | `cf61a27` `9992454` `63ecd75` | One loop: `shared/pagination.ts` (pure leaf; `listAll` + `forEachPage`), re-exported by the CRM's `api.ts` — pattern 3 in [PATTERNS.md](PATTERNS.md). The 11 hand-rolled implementations collapsed onto it; all 86 backend inline `do…while(nextToken)` loops migrated (side-effect order, early exits, and per-site error-swallowing preserved verbatim — the error-ignoring sites carry a greppable `pageErrors: "ignore"` for the item-15 cleanup; 80 at close, 114 after the zero-page sweep — see §1.5); the 24 truncating CRM/portal reads now page to exhaustion. Survey corrections vs. the original counts: 86 loops not 87 (per-file figures were double-counted), 25 truncating reads not 23, 11 implementations not 4. The zero-page follow-up sweep is also closed (51 more sites; see [1.1.5](#115-pagination-gaps-left-open-by-2--zero-page-sweep-closed-one-gap-remains)); only the More.tsx `sentAt`-index gap remains there. |

**Scope:** `apps/web/src` (marketing + funnel), `apps/web/amplify` (backend), `apps/crm/src` (CRM + portal + tech). 360 non-test TS/TSX files.
**Excluded:** `node_modules`, `dist`, `creative`, and `.claude/worktrees/**` — the latter are three stale full-tree copies of the repo that inflate every file-count metric; nothing in this document refers to them.

**Ranking:** blast radius × frequency of inconsistency. Blast radius = number of call sites / surfaces affected. Frequency = how often the divergence actually produces different behaviour today.

**Verification:** every `file:LINE` below was produced by direct file reads. Items marked **[V]** were additionally re-verified by hand against the source after the scan. Items marked **[?]** are stated with lower confidence and note why.

---

## Master ranking

| # | Finding | Section | Blast radius | Drifted today? |
|---|---|---|---|---|
| 3 | `err instanceof Error ? …` — 155 sites (53 backend + 102 CRM), zero helpers | [1.5](#15-error-handling) | ~155 sites | N/A (uniform) |
| 4 | Money formatting: 15 impls, 3 incompatible output shapes | [1.2](#12-money-formatting) | ~110 sites | Yes — customer-facing |
| 5 | `productsUsed.amountValue` — `number` on the wire, `string` in the CRM **[V]** | [4.1](#41-a3-productsusedamountvalue--numberstring) | Tech report save path | Yes — throws |
| 6 | Date/timezone: 15 formatters, 6 `todayEastern`, 6 `addDays`, 3 TZ regimes | [1.3](#13-date-formatting--timezone) | ~130 sites | Yes — off-by-one |
| 7 | `ServiceCode` union is a strict subset of the schema enum, cast hides it **[V]** | [4.2](#42-a1-servicecode-subset) | Whole public funnel | Yes — 2 products |
| 8 | Auth: `office`/`finance` are aliases of `owner`; 29 inline role checks **[V]** | [1.4](#14-authpermission-checks) | 4 handlers + CRM | Partly — 2 real divergences |
| 9 | `useAsync` hook missing — 35 hand-rolled fetch triads, 1 with a race guard | [1.1](#11-apidata-fetching) | 35 components | Yes — races |
| 10 | Four mega-handlers (5960 / 4043 / 3716 / 3350 lines) | [2](#2-file-size-offenders) | 87 operations | N/A |
| 11 | No shared UI kit for `apps/web`; `Sheet` lacks a11y; 17 `window.confirm` | [1.6](#16-modals--sheets) | 2 apps | Yes — divergent |
| 12 | `LeadRequest` missing `idempotencyKey` + 10 fields | [4.4](#44-a4-leadrequest-vs-leadinput) | Both lead forms | Yes — dup leads |
| 13 | Toasts/notifications: 12 mechanisms, no toast system | [1.7](#17-toasts--notifications) | ~130 sites | Yes |
| 14 | `PlanCadence` missing `SEMIANNUAL` | [4.3](#43-a2-plancadence-missing-semiannual) | Rate sheets, HOA, copy | Yes |
| 15 | 243 swallowed-error sites + 114 `pageErrors: "ignore"`, 3 return conventions | [1.5](#15-error-handling) | Tree-wide | N/A |
| 16 | Portal renders raw exception text to customers (11 sites) | [1.5](#15-error-handling) | Customer-facing | Yes |
| 17 | 108 `as unknown as` casts; 45 are client shims that drop GraphQL errors | [4.9](#49-b3-as-unknown-as--108-sites) | ~45 CRM reads | Yes |
| 18 | `String(quoteJson)` cast in the post-payment path | [4.10](#410-b4-awsjson-string--object) | `PAID_NOT_FINALIZED` | Latent |
| 19 | Forms: no library, 3 email validators, 6 dollars→cents parsers | [1.8](#18-form-handling--validation) | ~40 sites | Yes |
| 20 | Dead: 1 whole file, 3 orphan components, 12 dead exports, 3 dead routes | [3](#3-dead-code) | — | — |
| 21 | No runtime schema validation anywhere; ~120 untrusted boundaries | [5.5](#55-runtime-validation) | 87 AppSync ops + 5 public | — |
| 22 | `listAll`-adjacent: 5 presigned-upload copies, 3 pollers, 4 storage codecs | [1.1](#11-apidata-fetching) | ~15 sites | Yes — 1 leaks |

---

# 1. Duplicate implementations

## 1.1 API/data fetching

*Subsections 1.1.1 (list-to-exhaustion implementations) and 1.1.2 (truncating
single-page reads) were item #2 — closed, see the resolved table. What remains
below is items #9 (the missing `useAsyncData` hook) and #22 (fetch-adjacent
duplicates), plus two gaps 1.1.5 records that the item-#2 survey surfaced.*

### 1.1.3 The `loading/error/useEffect` triad — 35 copies, no hook

26 written as `load` + `useEffect`:
`Customers.tsx:33→58` · `Dashboard.tsx:118→151` · `Leads.tsx:61→76` · `Inventory.tsx:53→88` · `PromoCodes.tsx:44→65` · `technicians.tsx:59→80` and `:188→209` · `ProductUsage.tsx:77→115` · `PricingLog.tsx:33→46` · `ProductLog.tsx:35→52` · `Work.tsx:57→72` · `MarketRates.tsx:245→324` · `Schedule.tsx:63→145` and `:693→718` · `Staff.tsx:100→111` · `GroupDetail.tsx:39→54` · `CustomerDetail.tsx:201→264`, `:3203→3232`, and `:3352→3381` (the last two missed by the original count) · `VisitChangeHistory.tsx:41→58` · `Today.tsx:53→63` · `JobDetail.tsx:222→287` · `Requests.tsx:82→151` · `Billing.tsx:39→78` · `LeadPanel.tsx:54→72` · `QuoteHistory.tsx:90→110` (rewritten from an IIFE into a `useCallback` + `useEffect` pair)

4 as an async IIFE inside `useEffect`: `portal/Home.tsx:46-69` · `portal/Docs.tsx:16-59` · `portal/Group.tsx:19-48` · `CustomerDetail.tsx:3386-3403` (further ad-hoc IIFEs at `CustomerDetail.tsx:276` and `:3092`)

5 as `.then/.catch` with no error state: `portal/Group.tsx:95-105` · `Staff.tsx:689-694` · `More.tsx:298-311` · `CustomerDetail.tsx:296-308` · `CollectPaymentSheet.tsx:40-51`

Divergences across the 35:
- Only `apps/crm/src/office/Customers.tsx:32,34,41,49,52` guards out-of-order responses (`reqRef`). `Schedule.tsx:63` (re-runs on `date`) and `CustomerDetail.tsx:201` (re-runs on `id`) do not; zero files use a `cancelled`/`alive` cleanup flag, so any of the other 34 can render a slower older response over a newer one.
- `Leads.tsx:61-74` and `GroupDetail.tsx:39-52` never `setError(null)` on retry — a stale error banner survives a successful reload.
- None has an unmount/abort guard.

**Canonical:** a `useAsyncData(fn, deps)` with `Customers.tsx`'s monotonic-request-id semantics.

### 1.1.4 Other fetch-adjacent duplicates

| Job | Implementations | Canonical |
|---|---|---|
| Amplify result unwrap | `api.ts:1091` `unwrap`, `api.ts:1107` `opResult`, `api.ts:1071` `jsonField` (now **zero** call sites — dead, see §3.4), + 12 inline `errors[0]`-only sites (`technicians.tsx:229,257,442`; `CustomerDetail.tsx:2790`; `Staff.tsx:431,471,769`; `JobDetail.tsx:636,685,837,1546,1551`) + `Schedule.tsx:707-709` | `opResult` (149 combined call sites: 91 `opResult` + 46 `unwrap` + 12 inline) |
| Widened-client custom-op call | 27 typed wrappers in `api.ts` vs **17 inline casts**: `Requests.tsx:100,185,229,252` · `AddService.tsx:109` · `Work.tsx:151` · `technicians.tsx:191` · `Schedule.tsx:677,697` · `MarketRates.tsx:270,939` · `CustomerDetail.tsx:2778,3205,3248,3354,3413` · `JobDetail.tsx:813` | The `api.ts` wrappers |
| Presigned S3 upload | 5 copies: `Requests.tsx:179` · `ReportPhotos.tsx:52` · `CustomerDocuments.tsx:72` · `JobDetail.tsx:940` and `:1074` (**the same 24 lines twice in one file**) | Extract `uploadViaPresignedUrl()`; `ReportPhotos` is the most complete |
| Function-URL resolution | `bookingApi.ts:18-50`, `leadIntakeApi.ts:18-47` (headers each say they mirror the other), `backend.ts:28-33` (dead) | One `getBackendUrl(envKey, outputKey)` |
| HTTP transport envelope | `bookingApi.ts:300-342` `post`→`ApiResult` (9 callers, carries `status`) vs `leadIntakeApi.ts:67-103` (2 callers, flattens to a string) | `post`/`ApiResult` |
| Async-job polling | `QuotePage.tsx:252-338` (cancels, backs off, status-aware) · `TrackPage.tsx:73-116` (cancels, no backoff) · **`BookPage.tsx:150-222` (no `stopped` flag, no cleanup)** — keeps `setState`-ing up to 60s after navigation, and can start twice via `:131`, `:147`, `:230` | Extract `QuotePage`'s loop |
| `sessionStorage` JSON codec | `bookingFunnel.ts:307-373` (injectable storage) · `bookingApi.ts:346-392` (**only one with a TTL**) · `QuotePage.tsx:49-81` (page-private) · `leadIntake.ts:31-61` | One `sessionCodec<T>(key, validate, {ttlMs})` |
| Portal "customers I may act for" | `portalData.ts:21-48` (own + group, deduped, sorted; 4 callers) vs `Group.tsx:19-48` (group only, no dedupe; now paged via `listAll` but otherwise unchanged) | `portalData.ts` |
| Google Places autocomplete | `apps/crm/src/lib/addressAutocomplete.tsx` and `apps/web/src/lib/addressAutocomplete.tsx` — **247 lines each, differing only in 4 comment lines** | Either; needs a shared package |
| Lead-form submit machine | `Contact.tsx:25-66` vs `TalkToExpertModal.tsx:63-99` — same 30 lines, identical validation strings (`Contact.tsx:32` ≡ `TalkToExpertModal.tsx:70`) | One `useLeadForm` hook |

### 1.1.5 Pagination gaps left open by #2 — zero-page sweep CLOSED, one gap remains

The **~60 backend zero-page `list*()` reads are resolved**: a full-tree sweep
found **51** Amplify Data sites (the estimate's other 9 were Stripe SDK cursor
calls, a different contract left alone). 31 were made exhaustive via
`listAll`/`forEachPage` (per-site error-swallowing preserved with
`pageErrors: "ignore"`); 20 are deliberate point reads on unique-by-construction
keys (payment-intent/dispute ids, portal subs, unguessable tokens, idempotency
keys) and now carry a one-line comment saying so, so no future audit re-flags
them. Two of the "known examples" (`shared/subscription.ts:71,94`) were Stripe
SDK calls, not Amplify. Notable fixes:

- `shared/jobAssignment.ts` `technicianForCaller` — the identity resolver under
  every technician auth check no longer denies technicians past one roster page.
- `crm-admin` `describeExistingLoginForEmail` — three `limit: 1` **filtered**
  scans could not see past the first scanned row, so the portal-login collision
  check essentially never fired; they now page the scan.
- `crm-docs` inventory depletion — the per-report `already` Set (the only
  idempotency guard against double depletion) is now paged to exhaustion.
- The `visitMoneySettled` gate, the EmailLog outbox-adoption guards (duplicate
  legal/customer notices), and the quote path's `MarketRate` serving-row reads
  all page fully.

Still open:

1. **`More.tsx` email log** wants the newest 100, which needs a `sentAt`
   index (server-side sort), not whole-table paging — today it sorts an
   arbitrary unsorted page client-side. Commented at the site
   (`apps/crm/src/pages/More.tsx:298-311`, comment `:299-302`).
2. **`Schedule.tsx:700-704`** — `listTechnicianDayExceptionByDate` (`limit: 200`)
   and the `CompanyClosure` read are still single-page, in a file the migration
   otherwise touched.

Scope note: "one loop" is **Amplify-Data-scoped**. Two other paging contracts
remain hand-rolled by design (different token protocols, left alone by #2):
3 Cognito `ListUsersInGroup` loops in `crm-admin/handler.ts` (`:2179-2192`,
`:2202-2215`, `:3148-3190` — the first two are near-identical 19-line copies
differing only by an `exceptUsername` filter) and 4 Stripe `has_more`/
`starting_after` cursor loops in `daily-reminders/handler.ts` (`:2034-2051`,
`:2061-2071`, `:2107-2112`, `:2788-2797`). Adoption today: 28 backend files
import `shared/pagination`; 76 backend `listAll` + 43 `forEachPage` call
sites, 53 CRM/portal `listAll` sites.

### 1.1.6 Duplication the pagination migration itself introduced

- **`pageErrors: "ignore"` repeated 113–115 times** across ~26 files
  (`daily-reminders/handler.ts` 34, `crm-docs/handler.ts` 14,
  `shared/capacity.ts` 10, `shared/technicianReads.ts` 7,
  `shared/planCancellation.ts` 7, `crm-admin/handler.ts` 6, …), with **zero**
  explicit `pageErrors: "throw"` sites — the safe default is only ever used
  implicitly. Each is deliberate greppable debt (`pagination.ts:20-23`), but
  there is no `listAllLegacy()`/preset naming the intent once. Raises the
  weight of item #15.
- **Byte-identical fetch lambdas, no shared reader.** Backend:
  `Technician.list({limit: 200, nextToken})` ×4 (`technicianReads.ts:106`,
  `jobAssignment.ts:64`, `capacity.ts:183,228`); `Product.list({limit: 1000,
  nextToken})` ×3 (`daily-reminders/handler.ts:881`, `crm-docs/handler.ts:4175,4309`).
  CRM: `Technician.list` ×4 (`technicians.tsx:63`, `CustomerDetail.tsx:3391`,
  `Schedule.tsx:75`, `Staff.tsx:691`); `Customer.list({limit: 1000})` ×3
  (`GroupDetail.tsx:45`, `Dashboard.tsx:122`, `Schedule.tsx:105`).
- **Duplicated try/catch wrapper:** `capacity.ts:181-189` and `:226-235` are
  the same `try { listAll(Technician…) as TechRow[] } catch { console.error }`
  block, differing only in log string and failure return.
- **Portal per-customer fan-out written three times:**
  `Promise.all(mine.map(c => listAll(t => api().models.Job.list({filter: {customerId: {eq: c.id}}, …}))))`
  at `portal/Home.tsx:52-62` and `portal/Requests.tsx:88-98`, single-customer
  variant at `portal/Group.tsx:96-102`; `portal/Docs.tsx:22-45` is the same
  shape for `ServiceReport`/`Agreement`.

---

## 1.2 Money formatting

**15 implementations, 3 incompatible output shapes.**

**Shape A — `$1,499.00`** (6 byte-identical copies): `apps/crm/src/lib/format.ts:1` (`money`, 11 importers / ~79 calls) · `shared/cancellationPolicy.ts:51` · `shared/planCancellationPolicy.ts:43` · `shared/visitChange.ts:98` · `shared/pdf.ts:191` · `shared/deactivation.ts:651`. The middle three are the same 5 lines pasted three times.

**Shape B — `$1499.00`** (no separator): `shared/receipts.ts:20` (**14 sites, customer receipts**) · `apps/crm/src/office/Inventory.tsx:35` · `apps/crm/src/office/ProductUsage.tsx:33` · plus **83 inline `$${(x/100).toFixed(2)}`** — `shared/bookingFinalize.ts` (33), `daily-reminders/handler.ts` (15), `stripe-webhook/handler.ts` (11), `shared/leadershipRecon.ts` (5), `shared/subscription.ts` (3), `shared/planCancellation.ts` (3), `shared/refund.ts` (2), `shared/bookingReconcile.ts` (2), and one each in `shared/receipts.ts`, `shared/leadLifecycle.ts`, `shared/bookingPaymentFailure.ts`, `crm-docs/handler.ts`, `booking-public/promo.ts`, `booking-public/handler.ts`, `PromoCodes.tsx`, `ProductUsage.tsx`, `Inventory.tsx`.

**Shape C — `$149` when whole**: `crm-pricing/rateCards.ts:197` · `apps/web/src/lib/bookingFunnel.ts:142` (comment: "Same shape as the server's `money()`"; 23 call sites) · `apps/crm/src/portal/AddService.tsx:74`.

**One-offs:** `crm-billing/handler.ts:147` — `toLocaleString` with no fraction options → `$20,000`, cents dropped. `shared/subscription.ts:411-412` — `.toFixed(2)` **with no `$`**, so the auto-cancel audit note reads `Paid 149.00` while the sibling toast at `:478` reads `$149.00`. `shared/fieldRoutesImport.ts:128` — a function named `money` that returns **dollars as a number**, colliding with 6 cents-taking `money` functions in the same tree.

**The concrete divergence.** One `booking.amountCents` of 149900 renders three ways across three customer surfaces:
- `$1499` — the funnel quote page (`bookingFunnel.ts:142` via `QuotePage.tsx`)
- `$1499.00` — the confirmation email (`shared/bookingFinalize.ts:2280`)
- `$1499.00` — the receipt (`shared/receipts.ts:90`)

and `$1,499.00` everywhere in the CRM (`format.ts:1`).

**Rounding.** Two "tidy price" functions disagree: `booking-public/availability.ts:57` rounds to the nearest whole dollar; `shared/marketRate.ts:162-166` (`tidy`) rounds to the nearest `$X9`. Neither imports the other. Separately, `apps/crm/src/lib/amountWords.ts:82-83` uses `Math.round` then `Math.floor(/100)` while every display path uses `toFixed(2)`/`toLocaleString` — and `CustomerDetail.tsx:991` (and a second site at `:1378`) renders `money(j.priceCents)` and `amountInWords(j.priceCents)` **side by side**, computed under two different rounding rules.

**Dollars→cents:** the expression `Math.round(parseFloat(x) * 100)` is retyped **12 times** (`CustomerDetail.tsx:2055,2183,2187,2342,3001` · `MarketRates.tsx:432` · `PromoCodes.tsx:243` · `Inventory.tsx:263` · `ProductLog.tsx:288` · `LeadPanel.tsx:248` (uses `Number()` not `parseFloat()` — different NaN behaviour) · `autoQuote.ts:68` · `marketRate.ts:952`). No shared `dollarsToCents()`.

Storage is unambiguously integer cents everywhere; `crm-billing`, `refund.ts`, `receipts.ts`, `subscription.ts` are all cents-clean in their arithmetic. The one float-dollars computation is `crm-pricing/rateCards.ts:171-173`.

- **Canonical:** `apps/crm/src/lib/format.ts:1` for the `$1,499.00` shape; keep Shape C but rename it (`priceLabel`) so it stops colliding.

## 1.3 Date formatting & timezone

**15 distinct display formatters.** CRM: `format.ts:10,20,46`, plus 4 inline (`CustomerDocuments.tsx:49`, `GroupDetail.tsx:255`, `JobDetail.tsx:1641,1834`) — the inline ones call `toLocaleDateString()`/`toLocaleTimeString()` **with no locale**, so they render `7/14/2026` in the US and `14/07/2026` elsewhere (`AddService.tsx:441` is a fifth inline formatter but does pass `"en-US"` + `T12:00:00`). Backend: `shared/recurring.ts:340` (exports `prettyDate` at `:348`), `shared/receipts.ts:26`, `daily-reminders/handler.ts:118-123` — three near-identical `prettyDate`s in one tree, and the latter two do not import the exported one. Plus `shared/planCancellationPolicy.ts:183`, `shared/pdf.ts:151,159,197,749`, `thumbtack-webhook/autoQuote.ts:138`.

**`todayEastern` — 6 copies:** `apps/crm/src/lib/format.ts:31` · `daily-reminders/handler.ts:2175` · `booking-public/availability.ts:40` · `shared/planCancellation.ts:90` · `shared/subscription.ts:527` · `shared/visitChange.ts:90`, plus 2 inline (`booking-public/handler.ts:1948,3350`).

**`addDays(YYYY-MM-DD, n)` — 6 copies, 2 algorithms:** `shared/cancellationPolicy.ts:39,47` (`Date.UTC` + epoch ms — the only timezone-proof one) vs the `T12:00:00Z` + `setUTCDate` family — `shared/recurring.ts:29`, `shared/assignVisit.ts:17`, `booking-public/availability.ts:46`, and `shared/agingMath.ts:32` (`addDaysToDate`, relocated there from `recovery.ts` by `03bb6fb`; its comment still says "like recurring.ts" and it still doesn't import the timezone-proof one; the same file adds a fourth ISO-parse convention at `:55`, `iso.length <= 10 ? T00:00:00Z : iso`) — plus `apps/crm/src/lib/format.ts:34` (mixed local/UTC, see below). The CRM's old `api.ts` copy was deleted (it now imports `dueDateForTerms` from `agingMath`, `api.ts:684`); `recovery.ts` keeps an inline `setUTCDate` at `:89`. `isWeekday` is redefined at `assignVisit.ts:23` and `availability.ts:52`, with a `toWeekday()` variant at `recurring.ts:36-40`; the canonical exported one is `capacity.ts:68` (imported by `daily-reminders/handler.ts:14`, `businessDays.ts:2`), and `businessHours.ts:79` has a fourth with a different signature (`isWeekday(weekday: number)`).

**Three "Eastern wall clock → UTC" converters**, all DST-correct, none aware of the others: `shared/businessDays.ts:49-67` (`easternWallToUtc`), `shared/businessHours.ts:59-77` (`etWallToUtc`), `shared/cancellationPolicy.ts:66-77` (`easternEpochMs`).

**UTC-shift sites:**
1. `apps/crm/src/components/DateTimeFields.tsx:8-11` — `isoPlusDays` takes the **local** date via `setDate()` then reads it back through `.toISOString()` (UTC). After 20:00 ET, `isoPlusDays(0)` returns tomorrow. This is the office "Today / Tomorrow / +1 week" quick-pick.
2. `apps/crm/src/lib/format.ts:34-38` — `addDays` mixes a local parse with a UTC read. Safe in the Americas, wrong at UTC+12/+13. `startOfWeek:41-43` and Schedule week navigation build on it.
3. `apps/crm/src/office/Work.tsx:809` and `MarketRates.tsx:263` — `new Date().toISOString().slice(0,10)` is **UTC today** in an app that has `todayEastern()` at `format.ts:31`. `Work.tsx:809` feeds aging arithmetic at `:811`.
4. `stripe-webhook/handler.ts:489` — `toLocaleDateString` with no `timeZone` on the Stripe invoice date. Lambda runs UTC, so an invoice created 2026-08-01 00:30 UTC (= 31 Jul 20:30 ET) is described as "August 2026".
5. `daily-reminders/handler.ts:119` — `T12:00:00` with no `Z` and no `timeZone`; correct only because Lambda's TZ is UTC. Its sibling at `:2176` pins `America/New_York`; its cousin at `recurring.ts:341` pins both.
6. `shared/pdf.ts:197,749` and `shared/season.ts:35-37` — correct for current callers (full ISO timestamps) but would shift a bare `YYYY-MM-DD` back a day. `pdf.ts:197` prints onto a signed agreement. **[?]** latent, not live.

`"America/New_York"` is hardcoded in **14 files**. Three timezone regimes coexist (ET-anchored, UTC-anchored, local/unspecified) with no stated rule.

- **Canonical:** `shared/cancellationPolicy.ts:39-49` primitives for arithmetic; `apps/web/src/lib/bookingFunnel.ts:152` as the model for parsing `YYYY-MM-DD` for display. Rule to adopt: a `YYYY-MM-DD` never enters `new Date()` without an explicit `Z` **and** an explicit `timeZone` on the formatter.

## 1.4 Auth/permission checks

**[V] `office` and `finance` are aliases of `owner`.** `apps/web/amplify/functions/shared/authz.ts:74` and `:82` both `return callerIsOwner(identity)` (returns at `:77`, `:85`); `apps/crm/src/lib/auth.tsx:57-58` sets `office: owner, finance: owner`. Consequences:
- Every `office || finance` disjunction is a tautology: `crm-docs/handler.ts:590,599,610,618,636,671`; `App.tsx:199` (consumed at `:249`); `Work.tsx:541,557,569,602,614,626,637`.
- The three-tier close model in `crm-docs/handler.ts:1439-1697` (`updateOwnedWork`) collapses — `actorIsOwner` at `:1659` is always true, so the `MONEY_VERIFIERS` guard at `:1625-1636` can never fire. The same tiering is written in the schema (`resource.ts:3511`), the handler, and the UI; all three now mean OWNER, but only the schema says so.
- Error strings still name roles that no longer exist (`crm-docs/handler.ts:591,600,611,672`; `authz.ts:105-107`).

**30 inline role checks instead of the shared `assert*` helpers.** `assertOffice` (`authz.ts:88`) has 3 call sites (`crm-billing:260,264,279`); `assertOwner` (`authz.ts:111`) has **zero**. Meanwhile:
- `crm-docs/handler.ts` — 14 verbatim re-implementations of `assertOffice` at `:478,490,495,542,552,562,566,572,576,580,713,720,734,744`; 6 compound gates at `:590,599,610,618,636,671` with **two different messages for the identical condition** ("Office or finance role required" at `:591,600,611,672` vs "Owner role required" at `:619,637`); a file-local seventh helper `assertOfficeFieldAccess` at `:2420`.
- `crm-pricing/handler.ts:103,114,117`.
- `crm-billing/handler.ts:90-99` — `actorOf` re-implements the claim read with its own cast.
- `crm-admin/handler.ts` — **zero** imperative role gates (`callerIsOwner` at `:360,366,372,378` is passed as a fact, never a gate); the most privileged handler relies entirely on `allow.groups(["OWNER"])`. `crm-pricing/handler.ts:112-113` documents the opposite convention explicitly. Two conventions, unstated.

**Two real divergences (not just duplication):**

1. **Group entitlement has two sources of truth.** `shared/authz.ts:146-155` intersects the caller's `grp-` groups with the customer row's **live `accessGroups` stamp** — the doc at `:126-131` says this is deliberate so removal from a group revokes access immediately. But `crm-docs/handler.ts:5829-5843` (`getDocumentUrl`) **re-derives** the group name from the scalar `customer.groupId` (via `grpGroup()` now, but still from the scalar). If those two fields are ever out of step, a group login gets one answer for paying an invoice and the opposite for downloading that customer's documents.
2. **`callerEmail` normalization.** `authz.ts:26-37` trims, lower-cases, and falls back to `username`. `crm-billing/handler.ts:90-94` does none of that. Every money record stamped via `actorStamp` (`:99-102`, spread at `:739,889`; the raw `actor: {sub, email}` propagated at `:275,293,920,1075`) carries a differently-cased actor email from records stamped via `callerEmail` in `crm-docs`/`crm-admin` — the two audit trails do not join on actor.

**Three more entitlement copies that omit the `grp-` branch entirely:** `crm-docs/handler.ts:418-424`, `:441-446`, `:463-468`.

**Stale role vocabulary — 3 lists, 2 stale.** Canonical `["OWNER","TECH"]` at `shared/staffRoles.ts:12`; duplicated (and dead) at `authz.ts:94`; but `crm-admin/handler.ts:2811` still strips `["OWNER","OFFICE","FINANCE","TECH","cus-","grp-"]` and `apps/crm/src/office/Staff.tsx:71` still reads `OFFICE`/`FINANCE` as owner — a vocabulary `assertValidRoleSet` (`staffRoles.ts:39-48`) would reject.

**The `cus-`/`grp-` prefixes are open-coded** in `apps/crm/src/lib/auth.tsx:90-92,97-99`, and `shared/authz.ts:146` still restates `grp-` by hand (its `cus-` branch now goes through `cusGroup()`, imported at `:3`, used `:141` — a partial fix since the original scan).

**~28 operations declare the same rule in both the schema and the handler** — full table omitted; the pattern is `resource.ts:NNNN` `allow.groups(["OWNER"])` paired with an inline check in `crm-docs`/`crm-pricing`/`crm-billing`.

- **Canonical:** `shared/authz.ts` after deleting the `office`/`finance` aliases and the dead `isStaff`/`STAFF_GROUPS`/`assertOwner`; `assertCanActForCustomer` as the only entitlement implementation; `shared/jobAssignment.ts` (already canonical, 22 correct call sites, fails closed on read error) as the model for scope checks.

## 1.5 Error handling

**Envelopes — 6 shapes across 8 handlers, no shared module.**

| Shape | Where | Form |
|---|---|---|
| A | `booking-public/handler.ts:365-443` | `{statusCode, headers, body}` + a typed `HttpError` class at `:445` |
| B | `lead-intake/handler.ts:62-73` | local `jsonResponse`, own CORS block; `error` key on failure, `ok` on success |
| C | `stripe-webhook/handler.ts:45,60,185,188` | bare-string body, no JSON, no headers |
| D | `thumbtack-webhook/handler.ts:103` | always HTTP 200 + `{ok:false, ignored}` — here `ok:false` means "accepted and ignored", the opposite of Shape E |
| E | `booking-public/handler.ts:313-341` | `InternalResult` `{ok,data}` / `{ok,status,error}` — consumed at `crm-billing/handler.ts:377-381`, which converts it straight back into a throw |
| F | all four AppSync handlers | bare throw; **377 throw sites** (crm-docs 226, crm-admin 69, crm-billing 51, crm-pricing 31), none has a top-level try/catch |

Layered on F, `crm-docs/handler.ts` alone speaks four failure dialects: throw, `{ok,problem}` (type `:977`, sites `:990,996,1028`), `{ok,message}` (43 `message:` sites; the cluster the original scan cited now sits at `:1216`…`:1394`, drift −1 to +20), `{ok,reason}` (`:4440`). `problem` is consumed by interpolating it into a `message` two lines later (`:1208,1221`).

**Error→string — 155 occurrences across 52 files (53 backend + 102 CRM; 0 in `apps/web/src`), zero helpers.** Variants: `String(err)` (49 sites), a domain-specific fallback string (95 sites, 93 of them in the CRM — `Work.tsx` has 12 at `:67,114,135,166,203,235,268,293,319,350,381,411`), optional-chained `.message` with no guard (`shared/recovery.ts:208`, `stripe-webhook/handler.ts:305,333`, `daily-reminders/handler.ts:1876`), and three different GraphQL-errors reductions (`.join("; ")` at `shared/lifecycleLog.ts:67`, `api.ts:1096`, and now also `shared/pagination.ts:30` — which absorbed the old `api.ts:103` copy and is the natural extraction seed for `gqlErrorText`; `describeWriteErrors` at `crm-docs/handler.ts:185-192`; `errors[0]` only at `booking-public/handler.ts:1376`, `crm-pricing/handler.ts:227,246,757`). Even the binding name varies within one file (`Schedule.tsx:141` uses `err`, `:714,743` use `e`).

**Customer-facing leakage.** Three ad-hoc scrubbing strings exist (`booking-public/handler.ts:337-340`, `:437-441`, `lead-intake/handler.ts:312-314`) — three different sentences for the same intent, none shared. But the **portal renders raw AppSync error text at 11 sites**: `portal/Docs.tsx:56` · `Group.tsx:45` · `Home.tsx:66` · `Billing.tsx:74,112` · `Requests.tsx:147,205,281` · `AddService.tsx:147,216,251`. Concrete chain: `crm-docs/handler.ts:5274` (second site `:5308`) throws a message built by `describeWriteErrors`, which **deliberately appends the AppSync `errorType`** (`:185-192`) → `api.ts:1096` → `portal/Docs.tsx:56` → the customer's browser.

Also: `apps/web/src/pages/booking/BookPage.tsx:257` surfaces `piError?.message` (Stripe.js) directly.

**Swallowing — 243 sites, plus a new third class of 114.** `} catch {` with the binding dropped: 116 (~37 have an explanatory comment by a strict same-line count, ~79 do not). `.catch(() => …)` returning a constant: 127, of which exactly one is documented as deliberate (`ops-alerts/handler.ts:57`). Highest-risk silent clusters: `shared/driveTime.ts:46,89,127,174,242` (**5/5 silent**, all returning `null` — every routing failure is indistinguishable from "no route exists", nothing logged); `shared/deactivation.ts:856,879,907,912` (the money/access lifecycle path); `lead-intake/handler.ts:199,206` (the lead-write path); `crm-pricing/handler.ts:307,402,584,714`; `crm-admin/handler.ts:1773,2093,2889`; `crm-docs/handler.ts:159,4549,5741`. `apps/crm/src/lib/api.ts:1052` returns `[]` on a read throw, so the "Transition needs recovery" banner silently disappears.

**The pagination migration added a third, orthogonal swallow class: `pageErrors: "ignore"` — 114 non-test sites across 25 files**, against 124 total `listAll`/`forEachPage` call sites, i.e. **~92% of call sites opt out of the fail-loud default** (`pagination.ts:29`), and there are zero explicit `"throw"` sites. It did not convert the existing swallows (243 barely moved) — total greppable silent-error surface is now 243 + 114 = 357. Net honesty improved (the old hand-rolled loops dropped `page.errors` with no marker at all; now one grep token finds them), but the named clusters are double-swallowed: `deactivation.ts` carries 4 bare `} catch {` **and** 5 `pageErrors: "ignore"` (`:670,804,867,890,997`), and `api.ts:1043-1054` nests `pageErrors: "ignore"` (`:1049`) inside the `} catch { return [] }` (`:1052`) that already hides the recovery banner — two independent ways to vanish in 12 lines.

Three `.catch` return conventions coexist: `=> undefined`, `=> ({data:null})`, `=> ({ok:false, reason:"UNSUPPORTED"})`.

**Logging — 4 conventions, none structured.** `console.error` 179 · `console.warn` 8 · `console.log` 32 · `openOwnedWork(...)` 139 (the de-facto durable sink) · `notifyOffice(...)` 36. `shared/opEvent.ts` is **not** a logger — it exports only `opFieldName(event)`, and `opEvent(` has zero call sites. Within `console.error` there are 3 incompatible argument shapes: `(msg, err)`, `(msg, ...positionalContext)` (`shared/email.ts:247,388`; `stripe-webhook/handler.ts:183`), and `(msg, {structured})` (`lead-intake/handler.ts:286`; `crm-docs/handler.ts:4897,4905` — eight lines apart, same operation, different key sets).

**Retry — 6 mechanisms, 2 genuinely duplicated.** `shared/atomicLock.ts` (CAS, no retry loop; the `ConditionalCheckFailedException` name-check is triplicated at `:281,319,334`) · `booking-public/handler.ts:3575` (`attempt < 2`, no delay) · `pricing-refresh/handler.ts:434` (`attempt < 4`, no delay) · `pricing-refresh/handler.ts:952` (`attempt < maxAttempts` — a sixth loop the original scan missed) · `pricing-refresh/handler.ts:85-116` (persisted exponential backoff) · `shared/recovery.ts:63-90` (persisted dunning schedule, `DUNNING_RETRY_OFFSET_DAYS:68`). The last two solve genuinely different problems and are not duplication. `shared/bookingReconcile.ts` has **no** retry logic and no `catch` at all — it is the detection half only.

- **Canonical:** `shared/errorText.ts` (`errMessage(err, fallback)` + `gqlErrorText(errors)`); `shared/httpEnvelope.ts` built on `booking-public`'s `HttpError`; `logError(event, fields)` emitting one JSON line; `swallow(reason)` for the 127 anonymous arrows.

## 1.6 Modals / sheets

One shared implementation, CRM-only: `apps/crm/src/ui/kit.tsx:327` `<Sheet>` — 39 usages in 19 files. It has **no `role="dialog"`, no `aria-modal`, no Escape handler, no focus management, no body-scroll lock**, and dismisses on backdrop `onClick` + `stopPropagation` (`:340-341`), which fires on a click-drag-release outside.

The one-off in the other app has all of it: `apps/web/src/components/TalkToExpertModal.tsx:105` — `role="dialog"`/`aria-modal`/`aria-labelledby` at `:113-115`, Escape at `:50-53`, initial focus at `:49`, scroll lock at `:54-57`, and the correct `onMouseDown` + `e.target === e.currentTarget` backdrop check at `:107-109`. It is the only `aria-modal` and the only `.focus()` call in either app.

`CancelPlanSheet.tsx` (184 L) and `VisitCancelSheet.tsx` (216 L) are the same component with different nouns — same 6-state render machine, same preview-fetch effect (`:42-58` vs `:53-70`), same consequence list (`:117-138` vs `:140-158`), same two-button footer. `VisitCancelSheet` adds one branch (`!preview.changeable`, `:122-133`).

`TalkToExpertModal.tsx` and `apps/web/src/pages/Contact.tsx` are the same form twice, down to a byte-identical validator and error string (`Contact.tsx:31-33` ≡ `TalkToExpertModal.tsx:68-70`); the success copy shares its heading ("We've got it!") but the bodies differ ("Someone from our team…" vs "A local pest control expert…"), and Contact uses the `OFFICE_TEL` constant where the modal rebuilds the `tel:` href inline — already-diverged copies, not identical ones. `Contact.tsx` even reuses the modal's CSS classes (`bk-modal-consent` at `:175`) despite not being a modal.

- **Canonical:** `<Sheet>`, after backporting the a11y from `TalkToExpertModal.tsx:47-60,113-115`; then extract one `<ConsequencePreviewSheet>`.

## 1.7 Toasts / notifications

**No toast system. 12 mechanisms.**

| Mechanism | Count |
|---|---|
| `<ErrorNote>` (`kit.tsx:424`) — scrolls into view, `role="alert"`, scrubs technical text | **81** across 33 files |
| `<SuccessNote>` (`kit.tsx:443`) | 3 (`AddService.tsx:283`, `Billing.tsx:131`, `CustomerDetail.tsx:434`) |
| Raw `className="success-note"` bypassing the component | 3 (`Work.tsx:508`, `VisitCancelSheet.tsx:104`, `CancelPlanSheet.tsx:92`) |
| `warn-note` / `info-note` — classes with **no component at all** | 4 |
| `window.confirm()` | **17** (`Work.tsx:249,304,333,363,395`; `CustomerDetail.tsx:744,767,793,959,990,1377`; `GroupDetail.tsx:168`; `PromoCodes.tsx:301`; `Schedule.tsx:217`; `MarketRates.tsx:966`; `ReportPhotos.tsx:92`; `QuoteHistory.tsx:118`) |
| `window.alert()` | 4 (`Work.tsx:199,231`; `technicians.tsx:459`; `CustomerDetail.tsx:1907`) — the original scan's fifth site (`DocButton.tsx:21`) never existed |
| `div.bk-notice` (web) | 11 — inconsistently `role="alert"` / `role="status"` / neither |
| `div.bk-form-error` (web) | 10 |
| `div.bk-field-error` (web) | 4 |
| ad-hoc `<p role="status">` (`Requests.tsx:391`, `Schedule.tsx:827`), inline-styled alert div (`JobDetail.tsx:444-455`), `InstallBanner.tsx:79` | 4 |

Error-string `useState` declarations: **64 sites across 34 files** (62 CRM / 2 web — the original scan's "33" was the file count); `setError(` is called **265 times**.

- **Canonical:** `ErrorNote`/`SuccessNote`, plus the missing `WarnNote`/`InfoNote` (currently class-only); replace the 21 `alert`/`confirm` calls with the existing `<Sheet>` confirm pattern.

## 1.8 Form handling & validation

**No form library in either `package.json`** (no zod/yup/formik/react-hook-form/valibot). All form state is hand-rolled `useState`: one state per field is the dominant pattern (`technicians.tsx` 32, `BookPage.tsx` 29, `MarketRates.tsx` 28, `Staff.tsx` 27, `AddService.tsx` 17), and `CustomerDetail.tsx` has **94** `useState` calls. Only two files use a single object + curried setter, and those two are the same logic written twice (`CustomerForm.tsx:61` vs `QuotePage.tsx:340`).

**Validation strategies — 3:** an extracted pure validator returning field-keyed errors (`apps/web/src/lib/bookingFunnel.ts:239`, the only one, unit-tested, **one consumer**); inline first-failure-wins setting a single string (~15 sites); a derived `disabled` predicate with no message (~8 sites).

**Email — 3 validators, 2 regexes, 2 no-ops:**

| Site | Implementation |
|---|---|
| `Staff.tsx:710` | `/^\S+@\S+\.\S+$/` with `.trim()` — accepts `a@b..c` |
| `CustomerForm.tsx:70` | same regex, **no `.trim()`** |
| `bookingFunnel.ts:199` | `EMAIL_RE`, documented as mirroring the server's AWSEmail rule; the only tested one |
| `Contact.tsx:31` | **none** — `type="email"` at `:134` is defeated by `noValidate` at `:106` |
| `TalkToExpertModal.tsx:68` | **none** — same, `:168` defeated by `:134` |

The two public lead-capture forms are the ones with no validation.

**Phone — 1 validator (`bookingFunnel.ts:202-209`), 5 no-ops.** Two different digit-strip regexes for the same job (`Contact.tsx:9` and `TalkToExpertModal.tsx:127,195` use `/\D/g`; `TrackPage.tsx:195,209` uses `/[^0-9]/g`), each duplicated within its own file. The office number itself is hard-coded at **15+ sites across 12 files in 4 formats**: `"508-258-9294"` (`Contact.tsx:8`, `TalkToExpertModal.tsx:6`, `booking/QuotePage.tsx:40`, `Footer.tsx:41-42`, `PrivacyPolicy.tsx:28,136,192`, `LicensedInsured.tsx:254-255`, `CityPage.tsx:25,200`) · `tel:+15082589294` (`Header.tsx:149`, `QuoteCard.tsx:27`, `QuoteCTA.tsx:5`, `ComingSoon.tsx:17`, `Home.tsx:250`) · `"+1-508-258-9294"` (`SEO.tsx:139,166,276`, schema.org markup) · `"(508) 258-9294"` (`booking/TrackPage.tsx:7`, `ComingSoon.tsx:17`) — with three independently-named constants for the same fact (`OFFICE_PHONE` ×3, `OFFICE_PHONE_HREF`, `SUPPORT_PHONE`). Placeholders disagree on the expected format (`+14135551234` at `CustomerForm.tsx:105` vs `(508) 258-9294`).

**ZIP — 2:** keystroke digit-filter at `QuotePage.tsx:1223`; nothing at all at `CustomerForm.tsx:150-152`. `validateQuoteForm` never validates `zip`, relying entirely on the keystroke filter — so any other caller skips it silently.

**Sqft — 3:** bounded 100–50000 (`bookingFunnel.ts:255-259`); capped at 99999 by a `.slice(0,5)` that contradicts the bound (`QuotePage.tsx:978`); `AddService.tsx:187` has the same `.slice(0,5)` keystroke cap (`:340`) but no range check.

**Money input — 4 digit filters, 9 parse sites** (see §1.2), plus one money input with no filter at all (`LeadPanel.tsx:211-216`).

**Domain logic duplicated wholesale and already diverged:** `apps/crm/src/portal/AddService.tsx:61` `needsFor()` says at `:60` that it "Mirrors the funnel's `quoteFieldNeeds`" (`bookingFunnel.ts:84`). It does not — see §4.8 A14. `const onlyDigits` is defined at both `AddService.tsx:79` and `QuotePage.tsx:135`.

## 1.9 Tables / list rendering

There are **zero `<table>` elements** in either app; everything is div/card-based, and there is no sortable list anywhere (so no sort-state duplication yet — and no place to add it).

Shared primitives exist and dominate: `<ListRow>` (`kit.tsx:269`) 75 usages · `<Card>` 83 · `<EmptyState>` (`kit.tsx:309`) 32 · `<Spinner>` (`kit.tsx:5`) 33.

Competing hand-rolled versions:
- **15 hand-rolled empty states** as `<p className="muted small">` inside `x.length === 0 ?` ternaries, across **4 different class names** (`muted small`, `availability-empty`, `records-empty`, plain): `Group.tsx:134,143` · `Home.tsx:160` · `Billing.tsx:196` · `GroupDetail.tsx:314` · `Dashboard.tsx:851` · `Schedule.tsx:528,789,991` · `CustomerDetail.tsx:1088,1124,1219,1279` · `CustomerDocuments.tsx:157` · `More.tsx:314`. Note `Billing.tsx:196` and `CustomerDetail.tsx:1279` render the same string ("No invoices yet.") for the same data with two independent copies of the markup.
- **3 bare `"Loading…"` strings** instead of `<Spinner>`: `Staff.tsx:302` · `VisitChangeHistory.tsx:145` · `More.tsx:313`. No skeletons exist anywhere.
- **14 copies of the same `loading ? … : empty ? … : list` triple-ternary**: `Inventory.tsx:110` · `ProductUsage.tsx:205` · `PricingLog.tsx:60` · `technicians.tsx:99` · `ProductLog.tsx:67` · `PromoCodes.tsx:97` · `Leads.tsx:233` · `MarketRates.tsx:341` · `Staff.tsx:142,313` · `Customers.tsx:106,138` · `VisitChangeHistory.tsx:152` · `tech/Today.tsx:150`.
- Web side: `bk-related-grid` ×20, `bk-tips-list` ×20, `bk-choose-grid` ×20 across 20 near-identical service pages, with no shared section component.

- **Canonical:** a `<DataList items loading empty renderRow>` over the existing `ListRow`/`EmptyState`/`Spinner` — absorbs all 14 + 15 + 3.

---

# 2. File size offenders

Every non-test file over 500 lines. "Cohesive" = one responsibility, just long. "Split" = carrying unrelated jobs.

## Over 2,000 lines

| File | Lines | Distinct responsibilities | Verdict |
|---|---|---|---|
| `apps/web/amplify/functions/crm-docs/handler.ts` | 5,960 | **40-operation dispatch** `:264-750`; tech field workflow (`startJob:4989`, `endApplication:5144`, on-my-way/tracking `:5035-5143`, `completeJob:4944`); service-report lifecycle (draft `:5195`, photos `:5315`, finalize `:4219-4544`, amendments `:4545-4880`, immutability `:3618-3707`); chemical/label compliance `:3737-3800`; geo/presence forensics `:3426-3517`; honest-exit reporting `:5370`, `:5501`; office scheduling `:2165-3116` (with an embedded 640-line sub-dispatcher at `:2474-3116`); dispatch packets `:3117-3277`; owned-work verifier engine `:1042-1707` (its own 8-case switch); portal requests + callbacks `:799-974`; email/PDF delivery `:1865-3868`; S3 document store `:5635-5960`; billing side-quest `:4881` | **Split — ~10 jobs** |
| `apps/web/amplify/data/resource.ts` | 4,043 | Field-level authz helpers `:48-64`; 21 enums `:66-320` (incl. a 100-line `WorkKind`); **55 `a.model()`** `:321-2525`; **~100 custom ops** `:2526-4034` (~1,500 lines, mapping 1:1 onto the five Lambda handlers) | Cohesive but 3 clearly separable blocks |
| `apps/web/amplify/functions/booking-public/handler.ts` | 3,716 | SSM cache + CORS `:93-170`; input vocab/validators `:171-302`; internal-op path `:303-344`; **8-route HTTP router** `:345-444`; read endpoints `:647-868`; quoting `:869-2054` (with `quote()` alone at **920 lines**); checkout `:2055-3318` (`book()` at **800 lines**); cancellation + refund policy `:3319-3701` | **Split — ~7 jobs** |
| `apps/crm/src/office/CustomerDetail.tsx` | 3,538 | One 1,900-line page (`:148-2035`, 25+ state slices, 9 rendered sections) **plus 13 sibling components**: `RefundSheet:2036`, `ChargeCardSheet:2160`, `RecordPaymentSheet:2324`, `SettleInvoiceSheet:2462`, `RescheduleForm:2544`, `AmendReportForm:2644`, `ReportDeliveryRecovery:2761`, `PacketFields:2842`, `JobForm:2907`, `JobPacketForm:3027`, `GroupPicker:3122`, `PortalRequestsSection:3187`, `CallbacksSection:3316` | **Split — ~12 jobs** |
| `apps/web/amplify/functions/crm-admin/handler.ts` | 3,350 | **23-operation dispatch** `:220-439`; Cognito identity plumbing `:661-1071`; customer portal access `:1242-1362`; customer lifecycle `:1363-1703`; technician/licence records `:503-618`, `:1704-1879`; **staff RBAC (GL-14)** `:2116-3239`; email deliverability `:3240-3350` | **Split — ~5 jobs** |
| `apps/web/amplify/functions/daily-reminders/handler.ts` | 3,025 | A cron fan-out invoking **27 independent subtasks** `:125-303`: 10 reconcilers, 7 office digests, visit reminders + staffing gate, dunning/collections, Stripe reconciliation (GL-19) `:1776-2188`, booking↔payment reconciliation `:2543-2956`, email retry queue `:2422`, owned-work escalation `:2957` | **Split — 27 jobs** |
| `apps/web/amplify/functions/shared/bookingFinalize.ts` | 2,837 | Slot/route side effects `:19-116`; agreement content constants `:117-180`; entry + claim `:181-777`; attribution parsing `:834-904`; customer matching / lead conversion `:905-1206`; `finalizeClaimed` `:1207-2069` (**860 lines**); comms subsystem `:2070-2596`; late/failed-payment settlement `:2597-2833` | **Split — 2 major (finalize + comms)** |
| `apps/crm/src/tech/JobDetail.tsx` | 2,022 | Product-row modeling + `localStorage` memory `:40-202`; online/offline hook `:80-97`; page shell `:203-748`; `ScopePrepExits:799`; `CallbackFindingCard:922`; `NoAccessCard:1055`; `ReportForm:1192-1887` (**~700 lines**); `ProductRowEditor:1888` | **Split — ~6 jobs** |
| `apps/web/amplify/functions/shared/visitChange.ts` | 2,009 | Constants/leases `:40-172`; preview `:174-286`; event recording + notice `:287-412`; cancel `:413-1095` (incl. a 560-line driver at `:509-1069`); claim/resume machinery `:1096-1396`; reschedule `:1397-2002` (`rescheduleVisit` ~580 lines) | Cohesive domain, 3 ops + claim layer |

## 1,000–1,600 lines

| File | Lines | Responsibilities | Verdict |
|---|---|---|---|
| `shared/pdf.ts` | 1,599 | `PdfWriter` primitive `:22-163`; design constants `:178-245`; `AgreementDoc` layout `:246-402`; **4 unrelated documents** — agreement `:403-739`, quote `:880-1124`, service report `:1127-1415`, amendment `:1416-1599` | Split — 4 docs, 1 writer |
| `shared/capacity.ts` | 1,533 | 6 banded layers: tech eligibility `:113-365`; slot reads `:366-446`; reserve/release `:447-646`; checkout claim lifecycle `:647-911`; routing feasibility `:912-1098`; closed-tour + nightly rebuild `:1099-1274`; day reconciliation `:1275-1533` | Cohesive, 6 layers |
| `crm-pricing/handler.ts` | 1,514 | 5-op dispatch `:104-122`; market research `:123-246`; catalog rollback `:247-371`; SSM `:372-404`; S3 upload `:405-425`; Claude extraction + Google Routes `:426-457`; sheet math `:459-528`; reply composition `:529-628`; `priceLead` `:636-1473` (**840 lines**) | Split — 6 jobs |
| `apps/web/src/pages/booking/QuotePage.tsx` | 1,386 | localStorage pending-quote `:41-83`; field model + validation `:84-141`; page `:142-1281`; `QuoteLoadingScreen` `:1282-1370` | 1 page + 4 concerns |
| `pricing-refresh/handler.ts` | 1,353 | Budget/backoff `:72-118`; SSM `:119-149`; row listers `:150-208` (local pager renamed `listAllRows:199` to avoid colliding with the shared leaf); work selection `:211-290`; **self-heal quote email** `:291-597`; office digest + weekly report `:598-871`; failure settle `:872-914`; leased runner `:915-1031`; cron `:1032-1353` | Split — 5 jobs |
| `shared/planCancellation.ts` | 1,275 | Preview `:45-250`; outcomes `:251-317`; verifier `:329-541`; invoice facts `:542-610`; drive `:611-746`; settle `:747-868`; command write `:869-886`; `cancelPlanForCustomer` `:887-1011`; reclaim/resume `:1012-1206`; email `:1207-1272` | Cohesive |
| `apps/crm/src/lib/api.ts` | 1,121 | 8 domains in one barrel: leads `:43-208`; technician reads `:209-301`; owned work/email `:302-337`; invoices/disputes `:338-744`; work items `:745-796`; market rates `:797-819`; staff/roster/licence `:820-967`; lifecycle `:968-1069`; generic helpers `:1070-1121`. Shrank 64 lines when `LEAD_LOST_REASONS`, `InvoiceTerms`/`dueDateForTerms`/`addDaysUTC`, and the local pagination loops moved to the shared leaves | Split — 8 domains |
| `shared/marketRate.ts` | 1,057 | Prompt versioning `:88-135`; HOA one-time derivation + result type `:136-167` (the vocab, key/bucket math, and `parseSheet` moved to the pure leaf `shared/marketRateKeys.ts` and are re-exported at `:25-32`); variable-cost floor `:168-236`; pricing rollback `:259-344`; catalog snapshots `:345-441`; cached read `:443-492`; demand enqueue `:493-639`; cron machinery `:640-763`; LLM research + prompt hashing `:764-1057` | Split — ~5 jobs |
| `crm-billing/handler.ts` | 1,119 | 19-op dispatch `:151-315`; guards `:87-150`; setup-intent/PM `:316-452`; **portal add-service proxy into booking-public** `:341-408` (the outlier); subscriptions `:453-527`; charges `:528-771`; invoice ops `:772-1085`; recovery owner `:1086-1120` | Cohesive money domain |
| `stripe-webhook/handler.ts` | 1,089 | Signature + **11-event dispatch** `:38-190`; funnel settlement `:263-352`; subscription invoice billing `:353-740`; refunds `:741-780`; subscription deletion `:781-946`; disputes `:947-1082` | Cohesive router; disputes separable |
| `apps/crm/src/office/MarketRates.tsx` | 1,071 | `EnginePanel:98`; list page `:233-422`; conversions `:423-452`; `RateForm:453-875`; `RollbackPanel:876` | Split — 4 jobs |
| `apps/crm/src/office/Schedule.tsx` | 1,064 | `Schedule:46-636` (week nav, 5 parallel loads, unscheduled pool, route board, capacity strip) + `AvailabilityPanel:637-1064` (day facts, PTO, closures, 2 inline forms) | **2 pages fused** |
| `apps/web/src/pages/booking/BookPage.tsx` | 1,060 | 20+ state slices covering quote expiry, terms version drift, CARD vs INVOICE, promo, Stripe secret, finalize polling, 6 terminal screens `:444-672`; `PaymentForm:933` | 1 page, ~6 flows |
| `shared/leadLifecycle.ts` | 1,057 | Vocab `:30-65` (`LEAD_LOST_REASONS` moved to `shared/leadReasons.ts`); activity append `:70-127`; recovery work `:128-196`; `createLead` `:197-393`; consent gate `:394-420`; `logLeadTouch` `:421-548`; 3 capture entry points `:549-687`; `setLeadDisposition` `:688-938`; `assignLeadOwner` `:939-1002`; reassign `:1003-1060` | Cohesive |
| `shared/deactivation.ts` | 1,006 | `deactivateCustomer` `:119-649` (**530 lines**); plan listing `:658`; lifecycle sweep `:680-834`; inventory `:835-923`; notice `:924-988` | Cohesive; one 530-line function |
| `apps/web/amplify/backend.ts` | 966 | `defineBackend` `:56-145`; Cognito hardening `:78-136`; CAS lock-table IAM `:137-243`; 4 Function URLs `:244-280`; SES policy/config `:281-287`, `:623-669`; SSM params + grants `:369-533`; CloudWatch alarms + SNS + DLQs `:687-921`; S3 CFN override `:922-937`; AWS Backup `:938-966` | **Split — ~7 infra concerns** |
| `apps/crm/src/office/Dashboard.tsx` | 949 | **10 independent report cards** in one component `:102-811` (revenue by client type `:454`, discounts `:510`, AR aging `:535,570`, recovery queue `:614`, disputes `:655`, uncharged `:717`, not-billing `:741`, no-next-visit `:760`, needs-attention `:780`); `DrillPanel:836` | **Split — 10 reports** |
| `apps/crm/src/office/Work.tsx` | 870 | `WorkQueue:43-744` + **`PaymentsInFlight:745-870`** — an unrelated screen exported from the same file | **Split — 2 screens** |

## 500–800 lines

| File | Lines | Responsibilities | Verdict |
|---|---|---|---|
| `apps/crm/src/office/Staff.tsx` | 782 | Role vocab `:54-92`; roster `:93-225`; `AccessHistory:226-350`; `RosterBadges:351`; `StaffActions:368-677`; `InviteForm:678-786` | Split — 4 |
| `shared/workPolicy.ts` | 824 | Types; **the `WORK_POLICY` data table** (~680 lines of config for 38 kinds); 4 lookups. Grew by the `label` field in `4779b7e` when it absorbed the CRM's copy | Cohesive — one table |
| `apps/crm/src/office/technicians.tsx` | 746 | `technicianComplianceIssue:35`; `TechnicianRoster:53`; `LicenseRecords:176`; `TechForm:368-746` | Split — 3 |
| `shared/subscription.ts` | 733 | Stripe ensure `:29-120`; anchor math `:121-148`; `startPlanBilling:149-287`; **queued-visit cancellation resolution `:288-580`**; `cancelPlanBilling:581-730` | Split — 2 |
| `shared/email.ts` | 597 | HTML shell `:37-91`; MIME `:92-133`; `sendEmail:134-301`; resend `:302-354`; **suppression/do-not-contact policy `:355-401`**; transient classification `:394`; log write `:402-429`; **failure→owned-work `:430-478`**; ops mute + notify `:479-597` | Cohesive-ish; 2 separable |
| `apps/web/src/pages/residential/Residential.tsx` | 554 | Content constants `:7-198`; page `:199-554` | Cohesive |
| `shared/atomicLock.ts` | 552 | Types `:54-103`; suffix resolution `:104-149`; condition builder `:150-213`; DynamoDB store `:214-344`; test seam `:345-354`; 6 CAS primitives `:355-466`; in-memory store `:467-552` | Cohesive primitive |
| `apps/web/src/lib/bookingApi.ts` | 503 | URL discovery `:18-53`; **~25 exported types `:54-299`**; `post` `:300-345`; lead-token storage `:346-395`; 10 endpoint wrappers `:396-503` | Cohesive; type block dominates |
| `apps/web/src/pages/services/Wildlife.tsx` | 503 | Content constants `:8-126`; page `:127-503` | Cohesive |
| `apps/web/src/pages/services/HumaneRemoval.tsx` | 501 | Content constants `:8-188`; page `:189-501` | Cohesive; near-duplicate structure of `Wildlife.tsx` |

## Test files over 500 lines

| File | Lines | Modules under test | Multi-module |
|---|---|---|---|
| `crm-docs/compliance.test.ts` | 2,248 | `crm-docs/handler` + `shared/email`, `shared/driveTime`, `shared/recurring`; 12 `describe`s | **Yes** |
| `crm-admin/offboarding.test.ts` | 1,932 | `crm-admin/handler` + Cognito client; 9 `describe`s | No |
| `booking-public/quote.test.ts` | 1,920 | `booking-public/handler`; 19 `describe`s | No |
| `shared/bookingFinalize.test.ts` | 1,751 | + `shared/bookingPaymentFailure` | **Yes** |
| `pricing-refresh/handler.test.ts` | 1,674 | + `shared/marketRate`, `shared/pricingControl` | **Yes** |
| `booking-public/book.test.ts` | 1,218 | `booking-public/handler` | No |
| `crm-pricing/handler.test.ts` | 1,145 | `crm-pricing/handler` | No |
| `shared/capacity.test.ts` | 1,107 | `shared/capacity` | No |
| `shared/visitChange.test.ts` | 1,035 | `shared/visitChange` | No |
| `shared/marketRate.test.ts` | 1,035 | `shared/marketRate` | No |
| `shared/planCancellation.test.ts` | 785 | `shared/planCancellation` | No |
| `shared/subscription.test.ts` | 781 | `shared/subscription` | No |
| `shared/leadLifecycle.test.ts` | 708 | `shared/leadLifecycle` | No |
| `crm-billing/money.test.ts` | 699 | `crm-billing/handler` | No |
| `stripe-webhook/handler.test.ts` | 647 | + `shared/bookingFinalize` | **Yes** |
| `shared/deactivation.test.ts` | 639 | `shared/deactivation` | No |
| `shared/callbacks.test.ts` | 551 | `crm-docs/handler` — **no `callbacks.ts` module exists** | Inverted |
| `booking-public/cancel.test.ts` | 524 | `booking-public/handler` | No |
| `daily-reminders/handler.test.ts` | 503 | `daily-reminders/handler` — covers 4 of 27 subtasks | No |
| `apps/web/src/lib/bookingFunnel.test.ts` | 516 | `apps/web/src/lib/bookingFunnel.ts` | No |

---

# 3. Dead code

## 3.1 Fully dead files

| File | Lines | Evidence |
|---|---|---|
| `apps/web/amplify/functions/shared/fieldRoutesImport.ts` | 236 | No importer in the deployed tree; one dev script (`apps/web/scripts/migrationPreview.mts:15-17,32`) imports `adaptFieldRoutesRows`. Only other mention is prose at `apps/web/amplify/data/resource.ts:2643`. Its sibling `agreementImport.ts` **is** live (`crm-admin/handler.ts:17`); only the CSV adapter in front of it is dead-in-production. |

`shared/units.ts` was on this list and is **no longer dead** — `4779b7e` pointed `JobDetail.tsx`'s unit picker at its `COMMON_UNITS`. Do not delete it. Its three other exports (`normalizeUnit`, `dimensionOf`, `parseAmount`) are still test-only; see [3.4](#34-unused-exports). `apps/crm/src/lib/accessGroups.ts` was also on this list and was deleted in the same commit.

## 3.2 Orphaned components

`apps/web/src/components/NumberedSteps.tsx` (38 L) · `apps/web/src/components/ServiceSection.tsx` (53 L) · `apps/web/src/components/WhyUs.tsx` (29 L) — zero references of any kind.

Verified **not** orphaned despite appearances: `apps/crm/src/office/technicians.tsx` (imported by `Schedule.tsx:21` and `Staff.tsx:17`), `apps/web/src/pages/ComingSoon.tsx` (imported by `AboutPage.tsx:1`, `Reviews.tsx:1`, `Careers.tsx:1`). 17 of the 18 exports of `apps/crm/src/ui/kit.tsx` have external consumers; `statusTone` (`kit.tsx:192`) is consumed only by `StatusBadge` in the same file (`:219`) and should stop being exported.

## 3.3 Unreachable routes and dead guards

All three stem from `apps/crm/src/lib/auth.tsx:54-58` collapsing `owner`/`office`/`finance` into one boolean:

| Site | Dead thing |
|---|---|
| `apps/crm/src/App.tsx:261-265` | The `roles.finance` tabbar arm — `roles.finance === staff`, so it can never be taken. The "Owned work" tab at `:263` is dead. |
| `apps/crm/src/App.tsx:304-305` | `HomeRedirect`'s `/work` arm — same cause. |
| `apps/crm/src/App.tsx:210` | Consequently **`/work` has no reachable navigation entry**. `apps/crm/src/office/Work.tsx` (870 lines) is a fully-built screen reachable only by typing the URL. `More.tsx` has no entry for it; the backend `sourceUrl: "/work"` producers (`daily-reminders/handler.ts:2261`, `post-auth/handler.ts:64`, `crm-docs/handler.ts:2459`, `booking-public/handler.ts:1450,2100`, `ses-events/handler.ts:129,169,231`) are consumed only by `Work.tsx:514-515` itself. |
| `apps/crm/src/App.tsx:199` | `const workStaff = roles.office \|\| roles.finance` is always identical to `staff` on line 198. |
| `apps/crm/src/App.tsx:245` | `/more` is the only route not wrapped in `<Require when={…}>`. Inconsistency, not dead code. |

**Web routes:** `/residential/*` vs `/services/*` render the same components, and this is **intentional and correctly handled** — `apps/web/src/components/SEO.tsx:59-61` rewrites `/residential/*` → `/services/*` for `rel=canonical` and `og:url`, and only `/services/*` is in `sitemap.xml`. No defect. Two `/residential` variants have zero inbound links while their siblings are linked from `Header.tsx`/`Residential.tsx`: `App.tsx:150` `/residential/termite/treatment` and `App.tsx:153` `/residential/wildlife/humane-removal` **[?]** — may be a deliberate omission. `/lp/protect`, `/lp/call` (external ad traffic) and `/request-quote` (legacy redirect) correctly have no internal links. No shadowed or duplicate paths in either route table.

## 3.4 Unused exports

**Declaration-only** — the symbol appears exactly once in the whole tree (dead function bodies):

| Location | Symbol |
|---|---|
| `apps/crm/src/lib/api.ts:78` | `LEAD_OUTCOME_CODES_BY_CHANNEL` |
| `apps/crm/src/lib/api.ts:1071` | `jsonField` |
| `apps/crm/src/lib/backend.ts:28` | `getCustomOutput` |
| `apps/web/amplify/functions/shared/authz.ts:111` | `assertOwner` |
| `apps/web/amplify/functions/shared/bookingPayment.ts:148` | `bookingToProcessing` |
| `apps/web/amplify/functions/shared/bookingPayment.ts:185` | `bookingToBooked` |
| `apps/web/amplify/functions/shared/bookingPayment.ts:258` | `getBooking` |
| `apps/web/amplify/functions/shared/fieldRoutesImport.ts:163` | `adaptFieldRoutesRows` — dead in the deployed tree; consumed by the dev script `apps/web/scripts/migrationPreview.mts:15,32` |
| `apps/web/amplify/functions/shared/recovery.ts:54` | `invoiceAgingBucket` |
| `apps/web/amplify/functions/shared/pagination.ts:17` | `PageOptions` — never named by any call site (all pass `{ pageErrors: "ignore" }` inline); `PageResult` (`:10`) is test-only |
| `apps/web/amplify/functions/shared/staffAccessLog.ts:107` | `findStaffAccessEventByKey` |

`bookingPayment.ts` itself is live (`booking-public/handler.ts:53-57`, `daily-reminders/handler.ts:55` import other symbols); three of its state-transition functions are dead.

Also dead: `authz.ts:97` `isStaff` — zero call sites (only other tree hit is prose in `jobAssignment.ts:12`); the module-private `STAFF_GROUPS` (`authz.ts:94`, not exported) exists only to serve it. Both duplicate `staffRoles.ts:12` `STAFF_ROLES`.

**Consumed only by their own test (51 exports).** Legitimate test seams — leave: `atomicLock.ts:112 _resolveTableSuffix`, `atomicLock.ts:334 _classifyLockError`, `photoVerify.ts:58 _setS3ClientForTests`.

Genuinely orphaned logic, grouped:
- `apps/web/src/lib/bookingFunnel.ts` — a funnel-state persistence cluster built but never wired into a page: `DESCRIBE_SERVICE:47`, `QuoteFormFields:214`, `FUNNEL_STORAGE_KEY:307`, `StorageLike:310`, `encodeFunnelState:316`, `decodeFunnelState:320`. The module is otherwise live.
- `apps/crm/src/lib/recovery.ts` — `RecoveryInvoice:18`, `RecoveryDispute:31`, `isInDunning:48`, `isOpenDispute:53`, `compareRecoveryItems:192`
- `apps/crm/src/lib/workQueues.ts` — `ChargeableJob:9`, `invoiceCoversJob:31`, `PlanVisitJob:63`, `NextVisitPlan:69`
- `apps/crm/src/lib/marketRates.ts` — `isServable:100`, `selectPlanRate:166`, `planPrefill:207`
- `apps/crm/src/lib/reportDraft.ts` — `DraftStore:18`, `draftKey:28`, `SyncSnapshot:171`
- `apps/crm/src/lib/aging.ts` — `dueBasis:39` (now a wrapper over the shared leaf). `agingBucketForDays` left this list: `03bb6fb` moved it to `shared/agingMath.ts:102` where it is live.
- `apps/crm/src/lib/bookingLink.ts` — `marketingSiteUrl:32`, `bookingFunnelSpoken:51`
- `apps/crm/src/lib/billingDisclosure.ts` — `BillablePlan:22`, `planBilledOnCompletion:55`
- Others: `amountWords.ts:60`, `deposits.ts:12`, `planCadence.ts:47`, `serviceCatalog.ts:283,300,427`, `routeOptimizer.ts:154`, `season.ts:25`, `subscription.ts:121`, `marketRate.ts:117,136,962`, `businessHours.ts:126`, `capacity.ts:64,1139`, `bookingLink.ts:20`, `planCancellationPolicy.ts:75`, `units.ts:75,92,119`. Reclassification note: ~10 nearby symbols originally in this list are used inside their own module and belong under *over-exported*, not orphaned — `numberToWords` (`amountWords.ts:85`), `CATALOG_IDS` (`serviceCatalog.ts:295`), `serviceMonthsOf` (`season.ts:51,64`), `RESEARCH_PROFILES` + `pricingPromptHash` + `HOA_ONE_TIME_MULTIPLIER` (`marketRate.ts`), `contactDueAt` (`businessHours.ts:109`), `dayStopId` (`capacity.ts`), `mintBookingLinkToken` (`bookingLink.ts:81`), `visitOutcomeSentence` (`planCancellationPolicy.ts:131,213`).

**Over-exported (161 symbols)** — `export`ed but used only inside their own module. Not dead; a visibility issue. Densest: `apps/web/src/lib/bookingApi.ts` (13), `apps/crm/src/lib/revenue.ts` (9, the whole `ClientType*` cluster at `:55-141`), `shared/marketRate.ts` (8), `shared/groupChange.ts` (6), `shared/atomicLock.ts` (6), `apps/web/src/lib/analytics.ts` (3). (`apps/crm/src/lib/workPolicy.ts`'s 4 went away with the copy in `4779b7e`.)

## 3.5 Commented-out code — none

38 candidate lines were inspected; all are continuation lines of English prose comments beginning with words like "for", "while", "function", "return". No `/* */` block contains disabled code. The nearest thing is `apps/web/amplify/data/resource.ts:469`, a field-shape description.

**One dangling comment:** `apps/crm/src/App.tsx:229-231` documents a staging-only database-reset route that no longer exists (removed 2026-07-22, commit `9c9bff4`). The comment was not removed with it.

## 3.6 TODO / FIXME / XXX / HACK — none

Zero matches tree-wide in non-test code, including case-insensitive and loose variants (`TBD`, `deprecated`). The only hit anywhere is a junk-address test fixture (`"xxx"`) at `shared/dispatchReadiness.test.ts:35`.

---

# 4. Type drift

Canonical schema: `apps/web/amplify/data/resource.ts` — 56 `a.model()`, 20 `a.enum()`.

## 4.1 A3: `productsUsed.amountValue` — `number`/`string` **[V]**

| Declaration | Type |
|---|---|
| `apps/web/amplify/functions/shared/inventory.ts:26` (`ReportProduct`, owns the persisted shape) | `amountValue?: number` |
| `apps/crm/src/tech/JobDetail.tsx:54` (`ProductRow`) | `amountValue?: string` |

The write path converts correctly (`JobDetail.tsx:1427` → `Number(p.amountValue)`, `:1442`). The **read** path does not:
- `JobDetail.tsx:99,101` — `parseProducts` asserts `v as ProductRow[]` over rows whose `amountValue` is a number.
- `JobDetail.tsx:138` — `normalizeRow` does `amountValue: row.amountValue ?? split.value`, **preserving the number**.

Failure path: a tech saves a DRAFT report with a picked product ("2 fl oz"), reloads the job, and presses Save without retyping the amount. `p.amountValue` is the number `2`, and `JobDetail.tsx:1427` calls `p.amountValue?.trim()` → `TypeError: p.amountValue.trim is not a function`. Same at `:1434` (`composeAmount` → `:121`) and `:190` (`rememberAmounts`).

Related in the same pair: `ProductRow.name/epaNumber/quantity/targetPest` are **required** (`JobDetail.tsx:41-46`) while the `ReportProduct` equivalents are all **optional** (`inventory.ts:16-21`); `JobDetail.tsx:1419` `.filter((p) => p.name.trim())` throws on a legacy row with no `name`.

## 4.2 A1: `ServiceCode` subset **[V]**

| Declaration | Members |
|---|---|
| `apps/web/amplify/data/resource.ts:632` (canonical) | GENERAL_PEST, WASP_NEST, RODENT, ROACH, TERMITE, WILDLIFE, **MOSQUITO**, **MOSQUITO_TICK** |
| `apps/web/amplify/functions/shared/serviceCatalog.ts:41` | the 8 + COMMERCIAL_PEST, HOA_COMMON_AREA |
| `apps/crm/src/portal/AddService.tsx:27` | all 8 |
| `apps/web/src/lib/bookingApi.ts:54` | **6 — MOSQUITO and MOSQUITO_TICK missing** |

Laundered by two casts: `apps/web/src/lib/bookingFunnel.ts:37` `code: e.id as ServiceCode` and `apps/web/src/pages/booking/QuotePage.tsx:409` `service: fields.service as ServiceCode`. `funnelCatalog()` returns every entry with `funnel: true`, and both `MOSQUITO` (`serviceCatalog.ts:249`) and `MOSQUITO_TICK` (`:265`) set it — so `SERVICE_OPTIONS` contains two values at runtime that its own element type says are impossible. Any `Record<ServiceCode, …>` map or exhaustive `switch` added in `apps/web/src` will be silently wrong for the two GL-17 seasonal products.

## 4.3 A2: `PlanCadence` missing `SEMIANNUAL`

`resource.ts:79` `ServiceFrequency` has MONTHLY / BIMONTHLY / QUARTERLY / **SEMIANNUAL** (documented at `:83-86` as office-added and real). But `PlanCadence` (now at `shared/marketRateKeys.ts:24`, re-exported by `marketRate.ts:28,30`) and `apps/web/src/lib/bookingApi.ts:63` `RecurringFrequency` have only three. Consequences:
- `HoaPerUnitRates = Record<HoaBand, Record<PlanCadence, number>>` (`marketRateKeys.ts:60`) and `RateSheet.plans` (`:75`) **structurally cannot hold a semiannual rate**.
- `apps/crm/src/lib/marketRates.ts:36` (re-export) and `:51` (`CADENCE_LABEL`) — the Market Rates screen can never price or label one.
- `apps/crm/src/lib/billingDisclosure.ts:16` `VISIT_NOTE` is now typed `Record<string, string>` with 3 keys at `:17-19` — strictly worse than the previous keyed record: `firstChargeWords` (`:38`) indexes it with `plan.serviceFrequency ?? ""`, so adding SEMIANNUAL to the enum produces zero compiler signal anywhere, and the visit-cadence sentence is still silently omitted — the exact sentence that exists so "quarterly" isn't misread as the billing cadence.
- `apps/web/src/lib/bookingFunnel.ts:42` casts `PlanCadence[]` → `RecurringFrequency[]`, so adding the member would break here with no compiler help. `QuotePage.tsx:922` hardcodes the three.

## 4.4 A4: `LeadRequest` vs `LeadInput`

| `apps/web/src/lib/leadIntakeApi.ts:49` | `apps/web/amplify/functions/lead-intake/handler.ts:29` |
|---|---|
| `first: string` **required** | `first?: string` |
| `formId: string` **required** | `formId?: string` |
| — missing — | `idempotencyKey?: string` |
| — missing — | `addr?`, `city?`, `state?`, `zip?` |
| — missing — | `sqft?`, `units?`, `freq?` |
| — missing — | `company?`, `specialtyService?`, `specialtyPropertyType?` |

The server threads `idempotencyKey` into `resolveLeadIdentity` (`lead-intake/handler.ts:262`) precisely so a retried submission dedupes. The client type has no such field, so `Contact.tsx:42` and `TalkToExpertModal.tsx:79` — the only two callers — can never send one. Every double-submit mints a fresh lead, which is what `LeadIntakeClaim` (`resource.ts:914`) and the `DUPLICATE_LEAD` work kind (`resource.ts:196`) exist to clean up after.

## 4.5 A5/A6: `Dispute` and `Invoice` — stale hand-augmentations

`apps/crm/src/lib/api.ts:364-368` says the `Dispute` model "does not exist in the generated types until the backend wave lands." It does: `resource.ts:2140`. Field divergences:

| Field | Schema | CRM `api.ts:375` |
|---|---|---|
| `stripeDisputeId` | `.required()` → `string` (`:2142`) | `?: string \| null` (`:377`) |
| `customerId` | `a.id()` → `string \| null` (`:2143`) | `string` **required** (`:378`) |
| `status` | `a.ref("DisputeStatus").required()` (`:2147`) | `?: DisputeStatus \| string \| null` (`:382`) — widened to `string` |

`listDisputes` (`api.ts:716`) reaches it via `api().models as unknown as {Dispute?: …}` (`:725`) and returns an empty page when the key is absent — so a genuine auth/codegen failure is indistinguishable from "no disputes."

`apps/crm/src/lib/api.ts:352-361` intersects `Schema["Invoice"]["type"]` with eight fields that **all already exist** (`resource.ts:2046-2058`); the comment is stale. The real divergence: `InvoiceTerms` (now a shared leaf — `shared/agingMath.ts:16`, with `TERMS_DAYS:19` and `normalizeTerms:26`; imported at `api.ts:7`, re-exported `:350`) is a 3-member union, but `resource.ts:2048` is a plain `a.string()` — no server validation, so the union is documentation only, now two hops from the field it describes (`api.ts:354` widens the Invoice augmentation's own `terms` back to `string | null`). Downstream, five more loose subsets each widen the 6-member `InvoiceStatus` enum (`resource.ts:147`) to `string | null`: `aging.ts:33`, `revenue.ts:15`, `deposits.ts:13`, `recovery.ts:22,36`, `workQueues.ts:12,20,65,73`. A typo in `"REFUNEDED"` inside `revenue.ts:33` would compile and silently zero collected revenue.

## 4.6 A7/A8: cancel-outcome mirrors missing required fields

`PlanCancellationPreview` — server `shared/planCancellation.ts:55`, CRM `api.ts:439`. Server has `pendingMessage: string` **required** (`:87`), documented as "the truthful in-flight message the portal renders when a cancel is pending, so it never shows a static 'you won't be charged again' against live billing." The CRM type **omits it entirely**.

`CustomerCancelOutcome` — server `:249`, CRM `api.ts:476`. The `CANCELED` arm omits `stripeSubscriptionCanceled` (server: `boolean` required, `:253`) and `settled` (`:260`), the latter documented at `:257-259` as "False = canceled but a residual … is still owned and open — the sweep must NOT count this as completed."

`VisitCancelOutcome.outcome` — server `visitChange.ts:430` has `COMPLETE | PARTIAL | PENDING | FAILED`; CRM `api.ts:539` omits **`FAILED`**, which is genuinely returned at `visitChange.ts:561`. `VisitCancelSheet.tsx:104` happens to catch it via `!== "COMPLETE"`, so no visible bug today; `CustomerDetail.tsx:2619` shows the `=== "PARTIAL"` shape that would exclude it. **[?]** latent.

## 4.7 A9: technician reads over-promise

`apps/crm/src/lib/api.ts:242` declares `customers: Record<string, Customer>` and `:278` `customer: Customer | null` — the full ~80-field entity. The server sends 10 fields: `shared/technicianReads.ts:28-40` `CUSTOMER_VISIT_FIELDS`, applied by `pickCustomer` at `:45`. Same for jobs — `TechnicianJobDetail.job: Job` (`api.ts:265`) vs `pickJob` (`:55`), which `delete`s `priceCents` and `paidPaymentIntentId`. The server side still speaks `AnyRecord = Record<string, unknown>` (`:43`, permeating `:85-276`) — no typed contract on the producing side. Latent today (the tech screens only read inside the projection), but any new read of e.g. `customer.propertyClass` type-checks and returns `undefined`.

## 4.8 A10–A17: remaining entity divergences

| # | Drift | Detail |
|---|---|---|
| A10 | Property class — **5 names, 1 enforced** | `resource.ts:626` `propertyKind` is an enum; `Customer.propertyClass` (`:377`), `Job.propertyClass` (`:1702`), and 3 custom-op args are plain `a.string()`. Type-only copies at `serviceCatalog.ts:37`, `bookingApi.ts:62`, `AddService.tsx:37`; `revenue.ts:55-59` (`ClientType`) adds `UNCLASSIFIED`. `onsiteMinutesForClass` (`serviceCatalog.ts:300`) — the LOCKED 30/60-minute capacity rule — reads an unvalidated string; a stray `"Commercial"` books 30 minutes for a 60-minute job. |
| A11 | `PortalRequestRow` / `CallbackRow` declared twice each, disjoint | `portal/Requests.tsx:40,53` vs `office/CustomerDetail.tsx:3187,3316`. `customerId` (schema `.required()`) missing from the CustomerDetail copies; `photoKey` (schema `.required()`) typed `?: string \| null` in one and missing in the other; 5 schema fields absent from both. `Requests.tsx:64` `Mode = "RESCHEDULE"\|"CALLBACK"\|"HELP"` mixes `PortalRequest.kind` values with `CALLBACK`, which is a different model. |
| A12 | `quoteJson` — 1 written shape, **7 reader shapes** | Written at `booking-public/handler.ts:1991`. Read as 7 different ad-hoc types: `handler.ts:501`, `:2462` (no `serviceLabel`), `:2588`, `bookingFinalize.ts:1235`, `:2215` and `:2461` (**no `initialFeeCents`**), `shared/quoteDoc.ts:13`, `QuoteHistory.tsx:26` (`monthlyCents` optional). None includes `days[].factors` or `days[].slot`, both actually stored (`availability.ts:30-38`). |
| A13 | `SheetEdits` omits `extraAnimalCents` | `marketRateKeys.ts:71` has it; `apps/crm/src/lib/marketRates.ts:122` `SheetEdits` does not, and `MarketRates.tsx` has an editor for `extraNestCents` (`:467,502,514,570`) and none for `extraAnimalCents`. `booking-public/handler.ts:1746` and `crm-pricing/handler.ts:1006` **refuse the quote** when `extraAnimals > 0 && extraAnimalCents == null` — so if research produced a wildlife sheet without that key, the office has no CRM path to add it. Also `extraNestCents?: number \| null` (`marketRates.ts:124`) vs `?: number` (`marketRateKeys.ts:68`) — `mergeSheetEdits` (`:141`) guards with `!= null`, so a `null` edit silently no-ops instead of clearing. Partial fix since the original scan: `RateSheet` itself is now a **single** declaration (`marketRateKeys.ts:63`, re-exported by both `marketRate.ts:28-30` and CRM `marketRates.ts:36`); only `SheetEdits` still diverges. |
| A14 | `AddService` funnel mirror diverged | `AddService.tsx:52` `Needs` has 4 keys vs `bookingFunnel.ts:64` `QuoteFieldNeeds`'s 6; WILDLIFE returns `none` (`:65`) where the funnel requires `removalKind`+`removalCount` (`:105`); no `inUnit` parameter. Comment at `:58` claims it mirrors. |
| A15 | `DocEntry` vs `CustomerDocumentEntry` | `kind` and `uploadedAt` **required** at `crm-docs/handler.ts:5713`, optional at `CustomerDocuments.tsx:18`. `DOCUMENT_KINDS` (`:5724`) and `KINDS` (`:29`) are the same 5 strings twice; `readDocuments` (`:5734`)/`safeParse` are duplicated. |
| A16 | `LabelRules` re-declared inline | `shared/compliance.ts:155` exports the type **and** `parseLabelRules` (`:163`). `ProductLog.tsx:151-165` re-declares it inline (anonymous type at `:156`) with its own parse; `JobDetail.tsx:163-172` writes a third partial parse (`allowedServiceTypesOf`). |
A17 (`leadStage` typed and derived twice) was closed by `4779b7e`: the stage derivation now has one copy. The `leadNextActionAt` difference survives **deliberately** — the server's "due now" answers a sweep's question, the CRM's "epoch" answers the office queue's ordering question — and is documented at both ends rather than left as accidental drift.

**Duplicated but currently in sync** (maintenance risk, no drift yet): `WorkKind` 38 members × 2 declarations (`resource.ts` enum + `shared/workPolicy.ts`); `Attribution` (declared **4×** identically at `leadIntake.ts:13`, `bookingFinalize.ts:838`, `lead-intake/handler.ts:18`, `booking-public/handler.ts:219`); staff roles; `PricingOutcome`; `DisputeStatus` members. One asymmetry: `JOB_SCHEDULE_REASONS` (`shared/visitChangeReasons.ts:81`) has no CRM mirror at all.

Closed by `4779b7e`: the visit, staff and lifecycle reason vocabularies and `ServiceAddressFields` each have one declaration now.

## 4.9 B3: `as unknown as` — 108 sites

**Pattern 1 — client shims (~45 in the CRM).** `api().models` / `.mutations` / `.queries as unknown as {…}`, each justified by a comment saying the generated types trail a schema deploy. In every case checked, the op already exists. **Each shim declares a return type with no `errors` field**, so `unwrap()` cannot be used and GraphQL errors are dropped:

`portal/Requests.tsx:100` (errors dropped at `:116,127`) · `CustomerDetail.tsx:3205,3354` (a second shim over the same two models, with different row types) · `Schedule.tsx:677` · `technicians.tsx:191` · `MarketRates.tsx:270` · `api.ts:188,574,725,755,778,945,978,1027` (eight models — all of which exist; returns `{data:[]}` on absence, so an auth failure reads as "empty") · plus 15 mutation shims and 4 query shims in `api.ts` (27 total). Component-level shims beyond the four files above: `Requests.tsx:185,229,252` · `CustomerDetail.tsx:2778,3248,3413` · `Schedule.tsx:697` · `MarketRates.tsx:939` · `Work.tsx:151` · `JobDetail.tsx:813` · `AddService.tsx:109` — CRM total 46.

Server-side equivalents: `daily-reminders/handler.ts:2347,2435` · `crm-docs/handler.ts:768` · `bookingFinalize.ts:41` · `lifecycleCommand.ts:83` · `assignVisit.ts:105` · `marketRate.ts:301,370` · `leadClaim.ts:19,68` · `capacity.ts:553,1478,1525` · `groupChange.ts:83,131,169,247` · `crm-admin/handler.ts:1193` · `pricing-refresh/handler.ts:1221` · `crm-pricing/handler.ts:98,286`.

**Pattern 2 — forcing an entity into a hand-written DTO** (the strongest signal): `bookingFinalize.ts:244,255,288` (`booking as unknown as BookingRecord`) · `crm-docs/handler.ts:5882` · `technicianReads.ts:307,409` (the whole boundary becomes `Record<string, unknown>`) · `daily-reminders/handler.ts:2045,2079,2119,2127,2820,2855` (six parallel DTOs for the reconciliation sweep) · `stripe-webhook/handler.ts:390,423,674` · `portalData.ts:41` and `Group.tsx:29` (the comment at `portalData.ts` admits `get()` and `Schema[…]["type"]` are "structurally equivalent but differently inferred") · `crm-billing/handler.ts:514` (`"" as unknown as {behavior:"void"}`).

**Pattern 3 — untrusted AppSync arguments:** `crm-docs/handler.ts:411,436,455,479,491,496,512,621`; `crm-admin/handler.ts:244,250,409,414`.

**The grep set has a blind spot — 8 `as never` casts**, assignable to anything, stronger than `as unknown as`, invisible to all four aggregates above: `crm-admin/handler.ts:357,363,369,375` (`event.arguments as never` — pattern 3 with a stronger escape hatch) · `crm-docs/handler.ts:4478` · `planCancellation.ts:882` · `visitChange.ts:1160` · `apps/crm/src/lib/api.ts:1051` (`return all as never[]` — launders `listAll`'s `Record<string, unknown>[]` into the declared 8-field lifecycle-command DTO). Count unchanged since the original scan; the earlier "notably clean" verdict overstated.

**Single-`as` laundering on `listAll` results** (also outside the greps): the migration added `pricing-refresh/handler.ts:199-203` `listAllRows<T>` — takes `list(): Promise<{data: unknown[]}>` and returns `Promise<T[]>` via one `as Promise<T[]>`, a free unchecked entity→DTO coercion for any caller-chosen `T`; pre-existing twin at `daily-reminders/handler.ts:2148-2155`. Plus 8 direct `(await listAll(...)) as T[]` sites: `daily-reminders/handler.ts:94,1687` · `technicianReads.ts:144` · `leadIdentity.ts:89` · `licenses.ts:116` · `capacity.ts:182,227` · `visitChange.ts:131`.

**Otherwise clean:** only **3** `: any` in the whole tree (`bookingLink.ts:70`, `booking-public/handler.ts:970`, `pricing-refresh/handler.ts:420` — all `client: any`, each with an explicit eslint-disable), **zero** `as any`, **zero** `@ts-ignore`/`@ts-expect-error`. All other eslint-disables are `react-hooks/exhaustive-deps`.

## 4.10 B4: AWSJSON `string | object`

Correct narrowing (`typeof raw === "string" ? JSON.parse(raw) : raw`) at 14 sites including `booking-public/handler.ts:501` (`parseStoredQuote`), `shared/quoteDoc.ts:44`, `shared/marketRate.ts:510` + `shared/marketRateKeys.ts:92`, `crm-docs/handler.ts:157,4548`, `api.ts:1073-1080` (`jsonField`, parse at `:1075`).

Incorrect (`JSON.parse(String(x))`) at 6: `bookingFinalize.ts:1235`, `:2215`, `:2461` · `booking-public/handler.ts:2462`, `:2588` · `QuoteHistory.tsx:34`.

If the client ever returns `quoteJson` already parsed — which `parseStoredQuote` in the *same file* explicitly defends against — `String(obj)` yields `"[object Object]"` and `JSON.parse` throws. At `bookingFinalize.ts:1235` that throw is inside `finalizeBooking` **after the payment succeeded**, i.e. the `PAID_NOT_FINALIZED` state described at `resource.ts:200-204`. `QuoteHistory.tsx:33` catches; `booking-public/handler.ts:2583` does not. **[?]** Latent — depends on client behaviour.

Also unguarded: `Schedule.tsx:707-710` narrows the string case but then casts to `DayFacts` with no validation, and the client type (`:645`) omits a `date` field the server sends (`crm-docs/handler.ts:653-663`).

## 4.11 B5: unvalidated `JSON.parse`

Validated: `reportDraft.ts:78`, `bookingApi.ts:381`, `bookingFunnel.ts:323`.

Cast with no check: `leadIntake.ts:57` · `QuotePage.tsx:51` · `api.ts:1075` · **`api.ts:1107` (`opResult`, parse at `:1115`) — every custom-op response in the CRM** · `CustomerDetail.tsx:333` · `CustomerDocuments.tsx:38` · `MarketRates.tsx:306` · `JobDetail.tsx:181` · **`shared/leadExtraction.ts:163` — LLM output, `as Extraction`, no schema check** · `booking-public/handler.ts:1126`, `crm-billing/handler.ts:377,391`, `autoQuote.ts:115` (cross-Lambda payloads) · `ops-alerts/handler.ts:64`, `ses-events/handler.ts:368` (SNS payloads) · `crm-pricing/handler.ts:303` · `crm-admin/handler.ts:2092`. Sites the original list missed (all pre-existing): `crm-docs/handler.ts:5740` · `bookingFinalize.ts:855` · `marketRate.ts:313` (`as CatalogManifest`) · `crm-pricing/handler.ts:711` · `thumbtack-webhook/handler.ts:460` · `booking-public/handler.ts:382` · `lead-intake/handler.ts:205` (`as LeadInput`) · `ProductUsage.tsx:54` · `Schedule.tsx:708` (`as DayFacts`).

`opResult<T>` is the single largest untyped boundary — it takes `{data: unknown}` and returns `T` with no runtime check, and it is what materializes every DTO in §4.6–4.7.

## 4.12 B6: non-null assertions in risky spots

| Site | Assertion | Risk |
|---|---|---|
| `apps/crm/src/tech/JobDetail.tsx:1621,1732` | `Math.max(Number(cur), picked.reEntryHours!)` | `reEntryHours` is nullable on `Product`; `Math.max(n, null)` → `0`, silently lowering a legally-mandated re-entry interval |
| `apps/crm/src/office/Work.tsx:515` | `navigate(item.sourceUrl!)` | `WorkItem.sourceUrl` is `a.string()` → nullable |
| `apps/crm/src/office/CustomerDetail.tsx:1584` | `p.readFailures!.join(", ")` | On an `opResult`-parsed DTO with no runtime check |
| `apps/web/amplify/functions/crm-docs/handler.ts:269-745` | **49** × `event.arguments.X!` (original scan undercounted at ~22) | Compensating for generated handler arg types being nullable where the schema says `.required()` |
| `crm-docs/handler.ts:2738,2809` | `priorHeldFacts!.minutes` | Capacity minute math |
| `shared/bookingFinalize.ts:1713` | `firstVisitDate!.slice(0,7)` | Builds a `monthKey` for a `TreatmentObligation` |
| `apps/web/src/pages/booking/BookPage.tsx:891` | `(statusToken ?? quote.statusToken)!` | Guarded at `:888`, but exists because `pricedResponse()` (`booking-public/handler.ts:579-604`) returns `statusToken` while the synchronous `quote()` PRICED return (`:2025-2051`) **omits it** — so the GL-05 durability claim at `handler.ts:600-602` does not hold for a fresh quote |

Safe but shim-induced: `QuoteHistory.tsx:220`. (The `portal/Requests.tsx` pair was removed — zero non-null assertions remain in that file.)

---

# 5. Missing patterns

## 5.1 Hand-mirrored modules — CLOSED; one related gap remains

**Item #1 is fully closed** — see the resolved table at the top for commits, and [PATTERNS.md](PATTERNS.md) for the two rules it established (server-owned re-export; pure-leaf extraction). This section keeps only what those commits deliberately did NOT fix.

**A related gap, unfixed:** the CRM's `LEAD_TOUCH_CHANNELS` (`lib/api.ts:58`) has 4 channels where the server has 6 (`shared/leadLifecycle.ts:42` adds `BOOKING_LINK`, `THUMBTACK`), and the outcome list is ordered differently (`api.ts:64` vs server `:43`), which changes dropdown order; `LEAD_OUTCOME_CODES_BY_CHANNEL` (`api.ts:77`) likewise mirrors the server's `OUTCOMES_BY_CHANNEL` (`:58`) minus the two missing channel keys. This is a functional gap, not just duplication — fixing it is a behaviour change (dropdown contents change) and belongs in its own commit; when it lands, both vocabularies belong in `shared/leadReasons.ts` next to `LEAD_LOST_REASONS`.

**A second mirror class the closing sweep structurally could not catch — client↔client:** `apps/web/src/lib/addressAutocomplete.tsx` and `apps/crm/src/lib/addressAutocomplete.tsx` are verbatim 247-line copies (4 comment lines differ, zero code). Patterns 1–3 all assume a server-owned canonical; there is no home at all for shared *frontend* code, so this pair has nowhere to collapse to. (It is also the only reader of `VITE_GOOGLE_MAPS_API_KEY` — the "3 files" in §5.2 is really one file copied twice plus one more.)

**Context that still holds:** there is no `packages/` directory and no root `package.json`. The CRM reaches backend code through deep relative paths (`../../../web/amplify/...`), which `amplify.yml:48-52` supports by running `cd ../web && npm ci` in the CRM `preBuild`, with `amplify.yml:85` caching `../web/node_modules/**/*`. That comment in `amplify.yml` still claims "nothing from apps/web ships in the CRM bundle", which is now false twelve times over — the CRM value-imports `serviceCatalog` (×3), `inventory`, `rateServing`, `workPolicy`, `agingMath` (×2), `leadStage`, `adminJobTypes`, `leadReasons`, `pagination`, `visitChangeReasons`, and `staffRoles`.


## 5.2 Repeated shapes with no home

| Missing abstraction | Evidence | Consumers |
|---|---|---|
| `useAsyncData` hook | 35 hand-rolled triads; only 1 guards response ordering (§1.1.3); `kit.tsx` already owns the render halves (`Spinner:5`, `ErrorNote:424`, `SuccessNote:443`) | 35 |
| `errMessage(err, fallback)` | 155 backend + ~102 frontend sites, zero helpers (§1.5) | ~200 |
| CRM copy module | The 102 sites carry **85 distinct hand-written user-visible strings** as inline fallbacks ("Photo upload failed" appears ×4). The backend already has 4 copy modules (`bookingTerms.ts`, `consentText.ts`, `lifecycleReasons.ts`, `visitChangeReasons.ts`); the CRM has zero | ~85 strings |
| Money/date primitives | `apps/crm/src/lib/format.ts` is unreachable from web and backend (0 importers outside `apps/crm`); ~113 inline money expressions by the broad `/100`+`toFixed(2)` grep, 83 of them the `$${…}` template shape (§1.2); `"America/New_York"` in 14 files (§1.3) | ~130 |
| Config/env accessor | 3 near-identical `amplify_outputs` loaders (`bookingApi.ts:18-49`, `leadIntakeApi.ts:18-46` — headers each say they mirror the other — `backend.ts:12-33`); **83 raw `process.env` reads over 29 variable names**; `VITE_GOOGLE_MAPS_API_KEY` read independently in 3 files, `VITE_STRIPE_PUBLISHABLE_KEY` in 2 | 92 |
| `escapeHtml` | **5 definitions**: `shared/receipts.ts:34` (exported), `booking-public/handler.ts:3710`, `lead-intake/handler.ts:162`, `thumbtack-webhook/handler.ts:422`, `daily-reminders/handler.ts:3019` (this one named `escapeHtmlLite`). 48 usages; four are private redefinitions of the exported one | 48 |
| `<ConfirmSheet>` | The server already exposes a preview→commit contract for 3 flows (`previewPlanCancellation`, `previewVisitChange`, `previewLifecycleTransition`), consumed by 2 near-identical bespoke sheets (`CancelPlanSheet.tsx:49`, `VisitCancelSheet.tsx:61`) plus an inline consumer (`CustomerDetail.tsx:278`); everything else uses raw `window.confirm` with consequences crammed into a string (17 sites) | ~20 |
| Write-result assert | `errors?.map((e) => e.message).join("; ") ?? "unknown error"` open-coded **32 times** in backend non-test code with 4 different fallbacks (`"unknown error"`, `"unknown"`, `"no row returned"`, `""`); `shared/pagination.ts:30` is a third copy of the join; the CRM already has the helper (`api.ts:1091` `unwrap`) — a pure leaf that could move to `shared/` under the same pattern-3 rule pagination used | 32 |
| AppSync router | 4 copies of `switch (opFieldName(event)) { … default: throw }` at `crm-docs:265`, `crm-admin:221`, `crm-billing:153`, `crm-pricing:104`. `shared/opEvent.ts` extracted only the field-name read; the router, per-case authz, arg cast, and error arm are copy-pasted | 87 ops (40/23/19/5 — the earlier 95 counted 8 fact-code `case` labels in `crm-docs:1052-1421` that aren't router arms) |
| Typed op factory | `apps/crm/src/lib/api.ts` repeats the same 6-line `as unknown as` wrapper **27 times** (`:463-471`, `:618-624`, `:1057-1067`, …). One `op<TIn,TOut>(name)` replaces all 27 — and would be generated for free if op contracts lived in a shared package | 27 |
| `listAllModel(model, args)` | Every CRM `listAll` call is the same closure `listAll((t) => api().models.X.list({…, limit: N, nextToken: t}))` (53 sites, e.g. `Dashboard.tsx:121-125`, `CustomerDetail.tsx:213-218` — 6 in a row); page-size literals have no home either — **193 magic `limit: N`** across 9 distinct values (200 ×117, 500 ×29, 1000 ×14, 100 ×12, 50 ×11, plus 1/2/3/10) now that `listAll` makes the number a pure throughput knob | 53 + 193 |
| `logError(event, fields)` | 217 raw `console.*` calls in backend non-test code (176 `console.error`, 32 `console.log`, 9 `console.warn`); 3 incompatible arg shapes (§1.5) | 217 |
| Shared test fixture | **55 test files** hand-build a data-client mock (38 use the literal name `fakeDataClient`, 17 the same `{models: {…}}` shape); **36** separately re-mock `shared/email`. `shared/capacityTestFixture.ts` is the precedent, now used by 7 | 55 |

## 5.3 Test seams the source lacks

Most of these test files reach their subject through `await import("./handler")` — the tests already name a module boundary the source does not have. (Three booking-public seams differ: `track.test.ts:2` statically imports the named `decideTrackStatus`, `finalizeEmail.test.ts` never touches the handler, and `aiBoundary.test.ts` reads the source text.)

| Handler | Lines | Test files splitting it | Notes |
|---|---|---|---|
| `booking-public/handler.ts` | 3,716 | `quote` (1920), `book` (1218), `cancel` (524), `finalizeEmail` (216), `track` (68), `aiBoundary` (62) | **6 seams.** The directory already contains real modules `availability.ts` and `promo.ts` with matching tests — the extraction is half-done. `aiBoundary.test.ts:17` resorts to `readFileSync` + regex over `handler.ts` because there is no module to assert against. |
| `crm-docs/handler.ts` | 5,960 | `compliance` (2248), `bookingLink` (313), `ownedWork` (297) | `ownedWork.test.ts:60` imports the named `updateOwnedWork` (`handler.ts:1439`) — **a function that should live in `shared/ownedWork.ts`, which already exists** with its own test. Same for `shared/compliance.ts` and `shared/bookingLink.ts`. |
| `daily-reminders/handler.ts` | 3,025 | `handler` (503), `recovery` (323), `reconcile` (238), `requestOwnership` (161), `ownedWork` (100) | **5 seams**; four pull a named function out of the monolith |
| `crm-admin/handler.ts` | 3,350 | `offboarding` (1932), `reactivation` (327), `groupAudit` (322) | 3 seams |
| `crm-billing/handler.ts` | 1,119 | `money` (699), `recovery` (428) | 2 seams |
| `stripe-webhook/handler.ts` | 1,089 | `handler` (647), `recovery` (336) | 2 seams |

## 5.4 UI kit exists for one app only

Two entirely disjoint UI systems with **zero shared code**:

| | `apps/crm/src` | `apps/web/src` |
|---|---|---|
| Component kit | `ui/kit.tsx`, 454 L, 18 exports, **38 importers** | **none** |
| Field wrapper | `<Field>` — 161 usages | raw `div.bk-field` — 34 |
| Modal | `<Sheet>` — 39 | `div.bk-modal-overlay` — 1 |
| Error display | `<ErrorNote>` — 81 | `bk-field-error` (4) + `bk-form-error` (10) |
| Empty state | `<EmptyState>` — 32 | none |
| List row | `<ListRow>` — 75 | none |
| CSS namespace | `.sheet`, `.field`, `.error-note` | `.bk-modal-overlay`, `.bk-field` |

The four booking pages (`BookPage`, `QuotePage`, `CancelPage`, `TrackPage` — 2,924 lines) import **no** shared UI component at all.

## 5.5 Runtime validation

**No runtime schema library in either `package.json`** — no zod, yup, valibot, ajv, joi, superstruct, io-ts, or typebox. (`zod`/`yup`/`ajv` appear in `node_modules` only as transitive AWS/Amplify deps.)

Every inbound untrusted payload is hand-validated:

| Boundary | Sites |
|---|---|
| Public unauthenticated HTTP | `booking-public/handler.ts` — `JSON.parse` guarded at `:382`, then ad-hoc per-route checks (`parseStoredQuote:488`, `quoteFrequency:524`, `normalizePhone:256`, `resolveLeadToken:964,972,999`), with raw `Record<string, unknown>` bodies threaded into 7 route handlers. `lead-intake/handler.ts:205` then `EMAIL_RE.test` at `:79` + ~12 open-coded `?.trim()` coercions |
| Webhooks | `stripe-webhook/handler.ts:54` (signature verified; body shape then cast) · `thumbtack-webhook/handler.ts:115` (HMAC; body hand-read at `:460`) · `auth-challenge/verify.ts:57` |
| LLM output | `shared/leadExtraction.ts:163` — `JSON.parse(text.text) as Extraction`, **no shape check at all**; `shared/marketRate.ts:313,510`; `crm-pricing/handler.ts:303,711`; `autoQuote.ts:115` |
| AppSync arguments | **87 operations** across 4 routers, all cast rather than validated (`crm-admin/handler.ts:223,238,244,250,255,277,290,310,334,354`; `crm-docs/handler.ts:269-278` with non-null assertions) |
| Ad-hoc `parse*`/`read*` fns | 14, no shared contract. `parseQuoteSnapshot` is defined **twice** — `shared/quoteDoc.ts:41` (exported) and `pricing-refresh/handler.ts:306` (private duplicate) |

---

# Appendix — method

- Original scan (2026-07-31, `b74e23a`): seven parallel read-only subagents, one per dimension, followed by hand verification of the highest-severity claims (§4.1, §4.2, §1.4 marked **[V]**).
- Re-verification pass (2026-08-01, `3bcb828`): six parallel read-only subagents re-checked every concrete claim against the current tree — line references were refreshed, counts recounted, the original scan's own errors corrected inline, and new findings integrated. Line numbers throughout are now from the working tree at `3bcb828` (branch `staging`, clean).
- Counts are of non-test code unless stated.
- As findings are fixed they are removed from this document and recorded in the Resolved table at the top, with the commit. Anything still described here is still true as of `3bcb828`.
- `.claude/worktrees/**` contains three stale full-tree copies (`cool-williamson-080aec`, `vigilant-hawking-99d854`, `dreamy-archimedes-bbb35e`). They roughly quadruple every naive `find`/`wc` metric and were excluded throughout.
- Note for future scans: `shared/inventory.ts:201` contains a **literal NUL byte** inside a template literal (`` `nm:${…}\x00${…}` ``, a composite-key separator, introduced by `aa5f252`). `grep` classifies the file as binary and **silently skips it**, so every recursive-grep aggregate excludes `inventory.ts` unless run with `grep -a`. This explains the empty-grep anomaly noted by the original scan; claims resting on a negative grep must re-check this file with `Read` or `grep -a`.
