# BuzzKill Code Inventory — 2026-07-31

Structural audit. Findings are removed from this document as they are fixed.

**Resolved so far**

| Item | Commit | What closed |
|---|---|---|
| #1, the migratable half | `4779b7e` | Seven of the thirteen hand-mirrored modules and constant blocks now have one copy, with the CRM re-exporting it. The rule is written up in [PATTERNS.md](PATTERNS.md). |
| #1, the remaining six mirrors — **item closed** | `b2e8339` `810c485` `0c129ab` `03bb6fb` `d81922c` | Each impure server module had its pure half extracted into a new leaf (`adminJobTypes`, `leadReasons`, `marketRateKeys`, `agingMath`), the engine re-exports its old surface, and the CRM barrels over the leaf — pattern 2 in [PATTERNS.md](PATTERNS.md). The sixth "mirror" (`planCadence` ← `seasonalCadenceCopy`) was not one; the phantom zero-caller canonical was deleted. One related gap stays open in [5.1](#51-hand-mirrored-modules--closed-one-related-gap-remains). |
| #2 Pagination — **item closed** | `cf61a27` `9992454` `63ecd75` | One loop: `shared/pagination.ts` (pure leaf; `listAll` + `forEachPage`), re-exported by the CRM's `api.ts` — pattern 3 in [PATTERNS.md](PATTERNS.md). The 11 hand-rolled implementations collapsed onto it; all 86 backend inline `do…while(nextToken)` loops migrated (side-effect order, early exits, and per-site error-swallowing preserved verbatim — the 80 error-ignoring sites carry a greppable `pageErrors: "ignore"` for the item-15 cleanup); the 24 truncating CRM/portal reads now page to exhaustion. Survey corrections vs. the original counts: 86 loops not 87 (per-file figures were double-counted), 25 truncating reads not 23, 11 implementations not 4. The zero-page follow-up sweep is also closed (51 more sites; see [1.1.5](#115-pagination-gaps-left-open-by-2--zero-page-sweep-closed-one-gap-remains)); only the More.tsx `sentAt`-index gap remains there. |

**Scope:** `apps/web/src` (marketing + funnel), `apps/web/amplify` (backend), `apps/crm/src` (CRM + portal + tech). 360 non-test TS/TSX files.
**Excluded:** `node_modules`, `dist`, `creative`, and `.claude/worktrees/**` — the latter are three stale full-tree copies of the repo that inflate every file-count metric; nothing in this document refers to them.

**Ranking:** blast radius × frequency of inconsistency. Blast radius = number of call sites / surfaces affected. Frequency = how often the divergence actually produces different behaviour today.

**Verification:** every `file:LINE` below was produced by direct file reads. Items marked **[V]** were additionally re-verified by hand against the source after the scan. Items marked **[?]** are stated with lower confidence and note why.

---

## Master ranking

| # | Finding | Section | Blast radius | Drifted today? |
|---|---|---|---|---|
| 3 | `err instanceof Error ? …` — 155 backend + ~102 frontend sites, zero helpers | [1.5](#15-error-handling) | ~200 sites | N/A (uniform) |
| 4 | Money formatting: 15 impls, 3 incompatible output shapes | [1.2](#12-money-formatting) | ~110 sites | Yes — customer-facing |
| 5 | `productsUsed.amountValue` — `number` on the wire, `string` in the CRM **[V]** | [4.1](#41-a3-productsusedamountvalue--numberstring) | Tech report save path | Yes — throws |
| 6 | Date/timezone: 15 formatters, 6 `todayEastern`, 6 `addDays`, 3 TZ regimes | [1.3](#13-date-formatting--timezone) | ~130 sites | Yes — off-by-one |
| 7 | `ServiceCode` union is a strict subset of the schema enum, cast hides it **[V]** | [4.2](#42-a1-servicecode-subset) | Whole public funnel | Yes — 2 products |
| 8 | Auth: `office`/`finance` are aliases of `owner`; 29 inline role checks **[V]** | [1.4](#14-authpermission-checks) | 4 handlers + CRM | Partly — 2 real divergences |
| 9 | `useAsync` hook missing — 34 hand-rolled fetch triads, 1 with a race guard | [1.1](#11-apidata-fetching) | 34 components | Yes — races |
| 10 | Four mega-handlers (5918 / 4043 / 3710 / 3320 lines) | [2](#2-file-size-offenders) | 95 operations | N/A |
| 11 | No shared UI kit for `apps/web`; `Sheet` lacks a11y; 19 `window.confirm` | [1.6](#16-modals--sheets) | 2 apps | Yes — divergent |
| 12 | `LeadRequest` missing `idempotencyKey` + 10 fields | [4.4](#44-a4-leadrequest-vs-leadinput) | Both lead forms | Yes — dup leads |
| 13 | Toasts/notifications: 12 mechanisms, no toast system | [1.7](#17-toasts--notifications) | ~130 sites | Yes |
| 14 | `PlanCadence` missing `SEMIANNUAL` | [4.3](#43-a2-plancadence-missing-semiannual) | Rate sheets, HOA, copy | Yes |
| 15 | 244 swallowed-error sites, 3 return conventions | [1.5](#15-error-handling) | Tree-wide | N/A |
| 16 | Portal renders raw exception text to customers (11 sites) | [1.5](#15-error-handling) | Customer-facing | Yes |
| 17 | 108 `as unknown as` casts; 45 are client shims that drop GraphQL errors | [4.9](#49-b3-as-unknown-as--108-sites) | ~45 CRM reads | Yes |
| 18 | `String(quoteJson)` cast in the post-payment path | [4.10](#410-b4-awsjson-string--object) | `PAID_NOT_FINALIZED` | Latent |
| 19 | Forms: no library, 3 email validators, 6 dollars→cents parsers | [1.8](#18-form-handling--validation) | ~40 sites | Yes |
| 20 | Dead: 1 whole file, 3 orphan components, 11 dead exports, 3 dead routes | [3](#3-dead-code) | — | — |
| 21 | No runtime schema validation anywhere; ~120 untrusted boundaries | [5.5](#55-runtime-validation) | 95 AppSync ops + 5 public | — |
| 22 | `listAll`-adjacent: 5 presigned-upload copies, 3 pollers, 4 storage codecs | [1.1](#11-apidata-fetching) | ~15 sites | Yes — 1 leaks |

---

# 1. Duplicate implementations

## 1.1 API/data fetching

*Subsections 1.1.1 (list-to-exhaustion implementations) and 1.1.2 (truncating
single-page reads) were item #2 — closed, see the resolved table. What remains
below is items #9 (the missing `useAsyncData` hook) and #22 (fetch-adjacent
duplicates), plus two gaps 1.1.5 records that the item-#2 survey surfaced.*

### 1.1.3 The `loading/error/useEffect` triad — 34 copies, no hook

23 written as `load` + `useEffect`:
`Customers.tsx:33→58` · `Dashboard.tsx:118→151` · `Leads.tsx:61→76` · `Inventory.tsx:53→88` · `PromoCodes.tsx:44→65` · `technicians.tsx:59→80` and `:188→209` · `ProductUsage.tsx:77→115` · `PricingLog.tsx:33→53` · `ProductLog.tsx:35→59` · `Work.tsx:57→72` · `MarketRates.tsx:245→322` · `Schedule.tsx:63→145` and `:693→718` · `Staff.tsx:101→112` · `GroupDetail.tsx:39→52` · `CustomerDetail.tsx:200→263` · `VisitChangeHistory.tsx:40→61` · `Today.tsx:53→63` · `JobDetail.tsx:220→285` · `Requests.tsx:82→135` · `Billing.tsx:39→75` · `LeadPanel.tsx:54→71`

6 as an async IIFE inside `useEffect`: `portal/Home.tsx:43-62` · `portal/Docs.tsx:16-54` · `portal/Group.tsx:19-44` · `CustomerDetail.tsx:3373-3386` · `QuoteHistory.tsx:89-108`

5 as `.then/.catch` with no error state: `portal/Group.tsx:92-96` · `Staff.tsx:690-698` · `More.tsx:298-307` · `CustomerDetail.tsx:297-302` · `CollectPaymentSheet.tsx:44`

Divergences across the 34:
- Only `apps/crm/src/office/Customers.tsx:32,34,41,49,52` guards out-of-order responses (`reqRef`). `Schedule.tsx:63` (re-runs on `date`) and `CustomerDetail.tsx:200` (re-runs on `id`) do not.
- `Leads.tsx:61-74` and `GroupDetail.tsx:39-50` never `setError(null)` on retry — a stale error banner survives a successful reload.
- None has an unmount/abort guard.

**Canonical:** a `useAsyncData(fn, deps)` with `Customers.tsx`'s monotonic-request-id semantics.

### 1.1.4 Other fetch-adjacent duplicates

| Job | Implementations | Canonical |
|---|---|---|
| Amplify result unwrap | `api.ts:1155` `unwrap`, `api.ts:1171` `opResult`, `api.ts:1120` `jsonField`, + 12 inline `errors[0]`-only sites (`technicians.tsx:229,257,442`; `CustomerDetail.tsx:2789`; `Staff.tsx:432,472,773`; `JobDetail.tsx:634,683,835,1543,1549`) + `Schedule.tsx:707-709` | `opResult` (153 combined call sites) |
| Widened-client custom-op call | 28 typed wrappers in `api.ts` vs **17 inline casts**: `Requests.tsx:94,169,213,236` · `AddService.tsx:109` · `Work.tsx:151` · `technicians.tsx:191` · `Schedule.tsx:677,697` · `MarketRates.tsx:270,937` · `CustomerDetail.tsx:2777,3204,3240,3346,3398` · `JobDetail.tsx:811` | The `api.ts` wrappers |
| Presigned S3 upload | 5 copies: `Requests.tsx:163` · `ReportPhotos.tsx:52` · `CustomerDocuments.tsx:72` · `JobDetail.tsx:938` and `:1072` (**the same 24 lines twice in one file**) | Extract `uploadViaPresignedUrl()`; `ReportPhotos` is the most complete |
| Function-URL resolution | `bookingApi.ts:18-50`, `leadIntakeApi.ts:18-47` (headers each say they mirror the other), `backend.ts:28-33` (dead) | One `getBackendUrl(envKey, outputKey)` |
| HTTP transport envelope | `bookingApi.ts:300-342` `post`→`ApiResult` (9 callers, carries `status`) vs `leadIntakeApi.ts:67-103` (2 callers, flattens to a string) | `post`/`ApiResult` |
| Async-job polling | `QuotePage.tsx:252-338` (cancels, backs off, status-aware) · `TrackPage.tsx:72-116` (cancels, no backoff) · **`BookPage.tsx:149-222` (no `stopped` flag, no cleanup)** — keeps `setState`-ing up to 60s after navigation, and can start twice via `:131`, `:146`, `:229` | Extract `QuotePage`'s loop |
| `sessionStorage` JSON codec | `bookingFunnel.ts:307-373` (injectable storage) · `bookingApi.ts:346-392` (**only one with a TTL**) · `QuotePage.tsx:49-81` (page-private) · `leadIntake.ts:31-61` | One `sessionCodec<T>(key, validate, {ttlMs})` |
| Portal "customers I may act for" | `portalData.ts:21-48` (own + group, deduped, sorted; 4 callers) vs `Group.tsx:19-44` (group only, no dedupe) | `portalData.ts` |
| Google Places autocomplete | `apps/crm/src/lib/addressAutocomplete.tsx` and `apps/web/src/lib/addressAutocomplete.tsx` — **247 lines each, differing only in 3 comment lines** | Either; needs a shared package |
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
   arbitrary unsorted page client-side. Commented at the site.

---

## 1.2 Money formatting

**15 implementations, 3 incompatible output shapes.**

**Shape A — `$1,499.00`** (6 byte-identical copies): `apps/crm/src/lib/format.ts:1` (`money`, 11 importers / ~79 calls) · `shared/cancellationPolicy.ts:51` · `shared/planCancellationPolicy.ts:43` · `shared/visitChange.ts:97` · `shared/pdf.ts:191` · `shared/deactivation.ts:650`. The middle three are the same 5 lines pasted three times.

**Shape B — `$1499.00`** (no separator): `shared/receipts.ts:20` (**14 sites, customer receipts**) · `apps/crm/src/office/Inventory.tsx:35` · `apps/crm/src/office/ProductUsage.tsx:33` · plus **90 inline `$${(x/100).toFixed(2)}`** — `shared/bookingFinalize.ts` (29), `daily-reminders/handler.ts` (14), `stripe-webhook/handler.ts` (11), `shared/subscription.ts` (5), `shared/leadershipRecon.ts` (4), `shared/planCancellation.ts` (3), `shared/refund.ts:100,145`, and others.

**Shape C — `$149` when whole**: `crm-pricing/rateCards.ts:197` · `apps/web/src/lib/bookingFunnel.ts:142` (comment: "Same shape as the server's `money()`"; 23 call sites) · `apps/crm/src/portal/AddService.tsx:74`.

**One-offs:** `crm-billing/handler.ts:146` — `toLocaleString` with no fraction options → `$20,000`, cents dropped. `shared/subscription.ts:409-410` — `.toFixed(2)` **with no `$`**, so the auto-cancel audit note reads `Paid 149.00` while the sibling toast at `:476` reads `$149.00`. `shared/fieldRoutesImport.ts:128` — a function named `money` that returns **dollars as a number**, colliding with 6 cents-taking `money` functions in the same tree.

**The concrete divergence.** One `booking.amountCents` of 149900 renders three ways across three customer surfaces:
- `$1499` — the funnel quote page (`bookingFunnel.ts:142` via `QuotePage.tsx`)
- `$1499.00` — the confirmation email (`shared/bookingFinalize.ts:2280`)
- `$1499.00` — the receipt (`shared/receipts.ts:90`)

and `$1,499.00` everywhere in the CRM (`format.ts:1`).

**Rounding.** Two "tidy price" functions disagree: `booking-public/availability.ts:57` rounds to the nearest whole dollar; `shared/marketRate.ts:208-209` rounds to the nearest `$X9`. Neither imports the other. Separately, `apps/crm/src/lib/amountWords.ts:82-83` uses `Math.round` then `Math.floor(/100)` while every display path uses `toFixed(2)`/`toLocaleString` — and `CustomerDetail.tsx:990` renders `money(j.priceCents)` and `amountInWords(j.priceCents)` **side by side**, computed under two different rounding rules.

**Dollars→cents:** the expression `Math.round(parseFloat(x) * 100)` is retyped **11 times** (`CustomerDetail.tsx:2054,2182,2186,2341,3000` · `MarketRates.tsx:430` · `PromoCodes.tsx:243` · `Inventory.tsx:263` · `ProductLog.tsx:295` · `LeadPanel.tsx:248` (uses `Number()` not `parseFloat()` — different NaN behaviour) · `autoQuote.ts:68` · `marketRate.ts:1015`). No shared `dollarsToCents()`.

Storage is unambiguously integer cents everywhere; `crm-billing`, `refund.ts`, `receipts.ts`, `subscription.ts` are all cents-clean in their arithmetic. The one float-dollars computation is `crm-pricing/rateCards.ts:167-173`.

- **Canonical:** `apps/crm/src/lib/format.ts:1` for the `$1,499.00` shape; keep Shape C but rename it (`priceLabel`) so it stops colliding.

## 1.3 Date formatting & timezone

**15 distinct display formatters.** CRM: `format.ts:10,20,46`, plus 4 inline (`CustomerDocuments.tsx:49`, `GroupDetail.tsx:253`, `JobDetail.tsx:1639,1832`, `AddService.tsx:441`) — the inline ones call `toLocaleDateString()` **with no locale**, so they render `7/14/2026` in the US and `14/07/2026` elsewhere. Backend: `shared/recurring.ts:334` (exports `prettyDate` at `:342`), `shared/receipts.ts:26`, `daily-reminders/handler.ts:120` — three near-identical `prettyDate`s in one tree, and the latter two do not import the exported one. Plus `shared/planCancellationPolicy.ts:183`, `shared/pdf.ts:151,159,197,749`, `thumbtack-webhook/autoQuote.ts:138`.

**`todayEastern` — 6 copies:** `apps/crm/src/lib/format.ts:31` · `daily-reminders/handler.ts:2170` · `booking-public/availability.ts:40` · `shared/planCancellation.ts:89` · `shared/subscription.ts:524` · `shared/visitChange.ts:89`, plus 2 inline (`booking-public/handler.ts:1943,3344`).

**`addDays(YYYY-MM-DD, n)` — 6 copies, 2 algorithms:** `shared/cancellationPolicy.ts:39,47` (`Date.UTC` + epoch ms — the only timezone-proof one) vs the `T12:00:00Z` + `setUTCDate` family (`shared/recurring.ts:28`, `shared/assignVisit.ts:16`, `booking-public/availability.ts:46`, `shared/recovery.ts:38`, `apps/crm/src/lib/api.ts:709`). `isWeekday` is likewise redefined at `assignVisit.ts:22`, `recurring.ts:37`, `availability.ts:52`.

**Three "Eastern wall clock → UTC" converters**, all DST-correct, none aware of the others: `shared/businessDays.ts:47-65`, `shared/businessHours.ts:42-56`, `shared/cancellationPolicy.ts:64-76`.

**UTC-shift sites:**
1. `apps/crm/src/components/DateTimeFields.tsx:8-11` — `isoPlusDays` takes the **local** date via `setDate()` then reads it back through `.toISOString()` (UTC). After 20:00 ET, `isoPlusDays(0)` returns tomorrow. This is the office "Today / Tomorrow / +1 week" quick-pick.
2. `apps/crm/src/lib/format.ts:34-38` — `addDays` mixes a local parse with a UTC read. Safe in the Americas, wrong at UTC+12/+13. `startOfWeek:41-43` and Schedule week navigation build on it.
3. `apps/crm/src/office/Work.tsx:809` and `MarketRates.tsx:263` — `new Date().toISOString().slice(0,10)` is **UTC today** in an app that has `todayEastern()` at `format.ts:31`. `Work.tsx:809` feeds aging arithmetic at `:811`.
4. `stripe-webhook/handler.ts:489` — `toLocaleDateString` with no `timeZone` on the Stripe invoice date. Lambda runs UTC, so an invoice created 2026-08-01 00:30 UTC (= 31 Jul 20:30 ET) is described as "August 2026".
5. `daily-reminders/handler.ts:121` — `T12:00:00` with no `Z` and no `timeZone`; correct only because Lambda's TZ is UTC. Its sibling at `:2171` pins `America/New_York`; its cousin at `recurring.ts:335` pins both.
6. `shared/pdf.ts:197,749` and `shared/season.ts:34-35` — correct for current callers (full ISO timestamps) but would shift a bare `YYYY-MM-DD` back a day. `pdf.ts:197` prints onto a signed agreement. **[?]** latent, not live.

`"America/New_York"` is hardcoded in **14 files**. Three timezone regimes coexist (ET-anchored, UTC-anchored, local/unspecified) with no stated rule.

- **Canonical:** `shared/cancellationPolicy.ts:39-49` primitives for arithmetic; `apps/web/src/lib/bookingFunnel.ts:152` as the model for parsing `YYYY-MM-DD` for display. Rule to adopt: a `YYYY-MM-DD` never enters `new Date()` without an explicit `Z` **and** an explicit `timeZone` on the formatter.

## 1.4 Auth/permission checks

**[V] `office` and `finance` are aliases of `owner`.** `apps/web/amplify/functions/shared/authz.ts:74` and `:82` both `return callerIsOwner(identity)`; `apps/crm/src/lib/auth.tsx:56-57` sets `office: owner, finance: owner`. Consequences:
- Every `office || finance` disjunction is a tautology: `crm-docs/handler.ts:585,594,605,613,631,666`; `App.tsx:199,249`; `Work.tsx:541,557,569,602,614,626,637`.
- The three-tier close model in `crm-docs/handler.ts:1552-1654` collapses — `actorIsOwner` at `:1619` is always true, so the `MONEY_VERIFIERS` guard at `:1590-1598` can never fire. The same tiering is written in the schema (`resource.ts:3511`), the handler, and the UI; all three now mean OWNER, but only the schema says so.
- Error strings still name roles that no longer exist (`crm-docs/handler.ts:586,595,606,667`; `authz.ts:106`).

**29 inline role checks instead of the shared `assert*` helpers.** `assertOffice` (`authz.ts:88`) has 3 call sites; `assertOwner` (`authz.ts:111`) has **zero**. Meanwhile:
- `crm-docs/handler.ts` — 14 verbatim re-implementations of `assertOffice` at `:473,485,490,537,547,557,561,567,571,575,708,715,729,739`; 6 compound gates at `:585,594,605,613,631,666` with **two different messages for the identical condition**; a file-local seventh helper `assertOfficeFieldAccess` at `:2380-2396`.
- `crm-pricing/handler.ts:102,113,116`.
- `crm-billing/handler.ts:89-97` — `actorOf` re-implements the claim read with its own cast.
- `crm-admin/handler.ts` — **zero** imperative role gates; the most privileged handler relies entirely on `allow.groups(["OWNER"])`. `crm-pricing/handler.ts:111-112` documents the opposite convention explicitly. Two conventions, unstated.

**Two real divergences (not just duplication):**

1. **Group entitlement has two sources of truth.** `shared/authz.ts:148-155` intersects the caller's `grp-` groups with the customer row's **live `accessGroups` stamp** — the doc at `:126-132` says this is deliberate so removal from a group revokes access immediately. But `crm-docs/handler.ts:5794-5800` (`getDocumentUrl`) **re-derives** the group name from the scalar `customer.groupId`. If those two fields are ever out of step, a group login gets one answer for paying an invoice and the opposite for downloading that customer's documents.
2. **`callerEmail` normalization.** `authz.ts:26-37` trims, lower-cases, and falls back to `username`. `crm-billing/handler.ts:90-94` does none of that. Every money record stamped via `actorStamp` (`:99-102`, consumed at `:274,292,1076`) carries a differently-cased actor email from records stamped via `callerEmail` in `crm-docs`/`crm-admin` — the two audit trails do not join on actor.

**Three more entitlement copies that omit the `grp-` branch entirely:** `crm-docs/handler.ts:413-419`, `:436-441`, `:458-463`.

**Stale role vocabulary — 3 lists, 2 stale.** Canonical `["OWNER","TECH"]` at `shared/staffRoles.ts:12`; duplicated (and dead) at `authz.ts:94`; but `crm-admin/handler.ts:2784` still strips `["OWNER","OFFICE","FINANCE","TECH","cus-","grp-"]` and `apps/crm/src/office/Staff.tsx:72` still reads `OFFICE`/`FINANCE` as owner — a vocabulary `assertValidRoleSet` (`staffRoles.ts:39-48`) would reject.

**The `cus-`/`grp-` prefixes are open-coded** in `apps/crm/src/lib/auth.tsx:90-92,97-99` and `shared/authz.ts:146` rather than using `cusGroup`/`grpGroup` from `shared/dynamicGroups.ts`. (The duplicate CRM copy of that module was deleted in `4779b7e`; these two remaining sites still restate the prefix and its length by hand.)

**~28 operations declare the same rule in both the schema and the handler** — full table omitted; the pattern is `resource.ts:NNNN` `allow.groups(["OWNER"])` paired with an inline check in `crm-docs`/`crm-pricing`/`crm-billing`.

- **Canonical:** `shared/authz.ts` after deleting the `office`/`finance` aliases and the dead `isStaff`/`STAFF_GROUPS`/`assertOwner`; `assertCanActForCustomer` as the only entitlement implementation; `shared/jobAssignment.ts` (already canonical, 19 correct call sites, fails closed on read error) as the model for scope checks.

## 1.5 Error handling

**Envelopes — 6 shapes across 8 handlers, no shared module.**

| Shape | Where | Form |
|---|---|---|
| A | `booking-public/handler.ts:365-442` | `{statusCode, headers, body}` + a typed `HttpError` class at `:444` |
| B | `lead-intake/handler.ts:62-73` | local `jsonResponse`, own CORS block; `error` key on failure, `ok` on success |
| C | `stripe-webhook/handler.ts:44,59,184,187` | bare-string body, no JSON, no headers |
| D | `thumbtack-webhook/handler.ts:103` | always HTTP 200 + `{ok:false, ignored}` — here `ok:false` means "accepted and ignored", the opposite of Shape E |
| E | `booking-public/handler.ts:313-341` | `InternalResult` `{ok,data}` / `{ok,status,error}` — consumed at `crm-billing/handler.ts:377-381`, which converts it straight back into a throw |
| F | all four AppSync handlers | bare throw; **377 throw sites** (crm-docs 226, crm-admin 69, crm-billing 51, crm-pricing 31), none has a top-level try/catch |

Layered on F, `crm-docs/handler.ts` alone speaks four failure dialects: throw, `{ok,problem}` (`:972,981,987`), `{ok,message}` (`:1196,1200,1214,1255,1318,1345,1354,1367,1376,1395`), `{ok,reason}` (`:4385`). `problem` is consumed by interpolating it into a `message` two lines later (`:1188,1200`).

**Error→string — 155 backend occurrences across 52 files, zero helpers.** Variants: `String(err)` (51 sites), a domain-specific fallback string (95 sites, 93 of them in the CRM — `Work.tsx` has 12 at `:67,114,135,166,203,235,268,293,319,350,381,411`), optional-chained `.message` with no guard (`shared/recovery.ts:264`, `stripe-webhook/handler.ts:305,332`, `daily-reminders/handler.ts:1857`), and three different GraphQL-errors reductions (`.join("; ")` at `shared/lifecycleLog.ts:67` and `api.ts:103,1160`; `describeWriteErrors` at `crm-docs/handler.ts:180-187`; `errors[0]` only at `booking-public/handler.ts:1371`, `crm-pricing/handler.ts:220,239,750`). Even the binding name varies within one file (`Schedule.tsx:141` uses `err`, `:714,743` use `e`).

**Customer-facing leakage.** Three ad-hoc scrubbing strings exist (`booking-public/handler.ts:337-340`, `:438-442`, `lead-intake/handler.ts:313-315`) — three different sentences for the same intent, none shared. But the **portal renders raw AppSync error text at 11 sites**: `portal/Docs.tsx:52` · `Group.tsx:42` · `Home.tsx:60` · `Billing.tsx:71,109` · `Requests.tsx:131,189,265` · `AddService.tsx:147,216,251`. Concrete chain: `crm-docs/handler.ts:5236` throws a message built by `describeWriteErrors`, which **deliberately appends the AppSync `errorType`** (`:180-187`) → `api.ts:1160` → `portal/Docs.tsx:52` → the customer's browser.

Also: `apps/web/src/pages/booking/BookPage.tsx:257` surfaces `piError?.message` (Stripe.js) directly.

**Swallowing — 244 sites.** `} catch {` with the binding dropped: 117 (25 have an explanatory comment, 92 do not). `.catch(() => …)` returning a constant: 127, of which exactly one is documented as deliberate (`ops-alerts/handler.ts:57`). Highest-risk silent clusters: `shared/driveTime.ts:46,89,127,174,242` (**5/5 silent**, all returning `null` — every routing failure is indistinguishable from "no route exists", nothing logged); `shared/deactivation.ts:857,880,908,913` (the money/access lifecycle path); `lead-intake/handler.ts:199,206` (the lead-write path); `crm-pricing/handler.ts:300,577,707`; `crm-admin/handler.ts:1752,2069,2862`; `crm-docs/handler.ts:154,4494,5703`. `apps/crm/src/lib/api.ts:1101` returns `[]` on a read throw, so the "Transition needs recovery" banner silently disappears.

Three `.catch` return conventions coexist: `=> undefined`, `=> ({data:null})`, `=> ({ok:false, reason:"UNSUPPORTED"})`.

**Logging — 4 conventions, none structured.** `console.error` 179 · `console.warn` 9 · `console.log` 32 · `openOwnedWork(...)` 139 (the de-facto durable sink) · `notifyOffice(...)` 36. `shared/opEvent.ts` is **not** a logger — it exports only `opFieldName(event)`, and `opEvent(` has zero call sites. Within `console.error` there are 3 incompatible argument shapes: `(msg, err)`, `(msg, ...positionalContext)` (`shared/email.ts:247,388`; `stripe-webhook/handler.ts:182`), and `(msg, {structured})` (`lead-intake/handler.ts:286`; `crm-docs/handler.ts:4843,4851` — eight lines apart, same operation, different key sets).

**Retry — 5 mechanisms, 2 genuinely duplicated.** `shared/atomicLock.ts` (CAS, no retry loop; the `ConditionalCheckFailedException` name-check is triplicated at `:281,319,335`) · `booking-public/handler.ts:3569` (`attempt < 2`, no delay) · `pricing-refresh/handler.ts:437` (`attempt < 4`, no delay) · `pricing-refresh/handler.ts:84-116` (persisted exponential backoff) · `shared/recovery.ts:118-145` (persisted dunning schedule). The last two solve genuinely different problems and are not duplication. `shared/bookingReconcile.ts` has **no** retry logic and no `catch` at all — it is the detection half only.

- **Canonical:** `shared/errorText.ts` (`errMessage(err, fallback)` + `gqlErrorText(errors)`); `shared/httpEnvelope.ts` built on `booking-public`'s `HttpError`; `logError(event, fields)` emitting one JSON line; `swallow(reason)` for the 127 anonymous arrows.

## 1.6 Modals / sheets

One shared implementation, CRM-only: `apps/crm/src/ui/kit.tsx:327` `<Sheet>` — 39 usages in 21 files. It has **no `role="dialog"`, no `aria-modal`, no Escape handler, no focus management, no body-scroll lock**, and dismisses on backdrop `onClick` + `stopPropagation` (`:340-341`), which fires on a click-drag-release outside.

The one-off in the other app has all of it: `apps/web/src/components/TalkToExpertModal.tsx:104` — `role="dialog"`/`aria-modal`/`aria-labelledby` at `:113-115`, Escape at `:50-53`, initial focus at `:49`, scroll lock at `:54-57`, and the correct `onMouseDown` + `e.target === e.currentTarget` backdrop check at `:107-109`. It is the only `aria-modal` and the only `.focus()` call in either app.

`CancelPlanSheet.tsx` (185 L) and `VisitCancelSheet.tsx` (216 L) are the same component with different nouns — same 6-state render machine, same preview-fetch effect (`:42-58` vs `:53-70`), same consequence list (`:117-138` vs `:140-158`), same two-button footer. `VisitCancelSheet` adds one branch (`!preview.changeable`, `:122-133`).

`TalkToExpertModal.tsx` and `apps/web/src/pages/Contact.tsx` are the same form twice, down to identical error strings and identical success copy (`:124-128` vs `:99-103`); `Contact.tsx` even reuses the modal's CSS classes (`bk-modal-consent` at `:175`) despite not being a modal.

- **Canonical:** `<Sheet>`, after backporting the a11y from `TalkToExpertModal.tsx:47-60,113-115`; then extract one `<ConsequencePreviewSheet>`.

## 1.7 Toasts / notifications

**No toast system. 12 mechanisms.**

| Mechanism | Count |
|---|---|
| `<ErrorNote>` (`kit.tsx:424`) — scrolls into view, `role="alert"`, scrubs technical text | **81** across 33 files |
| `<SuccessNote>` (`kit.tsx:443`) | 3 (`AddService.tsx:283`, `Billing.tsx:128`, `CustomerDetail.tsx:434`) |
| Raw `className="success-note"` bypassing the component | 3 (`Work.tsx:508`, `VisitCancelSheet.tsx:104`, `CancelPlanSheet.tsx:92`) |
| `warn-note` / `info-note` — classes with **no component at all** | 4 |
| `window.confirm()` | **17** (`Work.tsx:249,304,333,363,395`; `CustomerDetail.tsx:743,766,792,958,989,1376`; `GroupDetail.tsx:166`; `PromoCodes.tsx:301`; `Schedule.tsx:217`; `MarketRates.tsx:964`; `ReportPhotos.tsx:92`; `QuoteHistory.tsx:114`) |
| `window.alert()` | 5 (`Work.tsx:199,231`; `technicians.tsx:459`; `CustomerDetail.tsx:1906`; `DocButton.tsx:21`) |
| `div.bk-notice` (web) | 11 — inconsistently `role="alert"` / `role="status"` / neither |
| `div.bk-form-error` (web) | 10 |
| `div.bk-field-error` (web) | 4 |
| ad-hoc `<p role="status">`, inline-styled alert div (`JobDetail.tsx:437-455`), `InstallBanner.tsx:79` | 4 |

`const [error, setError] = useState<string|null>(null)` is declared **33 times**; `setError(` is called **256 times**.

- **Canonical:** `ErrorNote`/`SuccessNote`, plus the missing `WarnNote`/`InfoNote` (currently class-only); replace the 22 `alert`/`confirm` calls with the existing `<Sheet>` confirm pattern.

## 1.8 Form handling & validation

**No form library in either `package.json`** (no zod/yup/formik/react-hook-form/valibot). All form state is hand-rolled `useState`: one state per field is the dominant pattern (`technicians.tsx` 32, `BookPage.tsx` 29, `MarketRates.tsx` 28, `Staff.tsx` 27, `AddService.tsx` 17), and `CustomerDetail.tsx` has **94** `useState` calls. Only two files use a single object + curried setter, and those two are the same logic written twice (`CustomerForm.tsx:61` vs `QuotePage.tsx:340`).

**Validation strategies — 3:** an extracted pure validator returning field-keyed errors (`apps/web/src/lib/bookingFunnel.ts:241`, the only one, unit-tested, **one consumer**); inline first-failure-wins setting a single string (~15 sites); a derived `disabled` predicate with no message (~8 sites).

**Email — 3 validators, 2 regexes, 2 no-ops:**

| Site | Implementation |
|---|---|
| `Staff.tsx:714` | `/^\S+@\S+\.\S+$/` with `.trim()` — accepts `a@b..c` |
| `CustomerForm.tsx:70` | same regex, **no `.trim()`** |
| `bookingFunnel.ts:199` | `EMAIL_RE`, documented as mirroring the server's AWSEmail rule; the only tested one |
| `Contact.tsx:31` | **none** — `type="email"` at `:134` is defeated by `noValidate` at `:106` |
| `TalkToExpertModal.tsx:68` | **none** — same, `:168` defeated by `:134` |

The two public lead-capture forms are the ones with no validation.

**Phone — 1 validator (`bookingFunnel.ts:202-209`), 5 no-ops.** Two different digit-strip regexes for the same job (`Contact.tsx:9` and `TalkToExpertModal.tsx:127,195` use `/\D/g`; `TrackPage.tsx:195,209` uses `/[^0-9]/g`), each duplicated within its own file. The office number itself is declared three times with **two different values**: `"508-258-9294"` at `Contact.tsx:8` and `TalkToExpertModal.tsx:6`, `+15082589294` at `QuoteCard.tsx:27` and `Home.tsx:250`. Placeholders disagree on the expected format (`+14135551234` at `CustomerForm.tsx:104` vs `(508) 258-9294`).

**ZIP — 2:** keystroke digit-filter at `QuotePage.tsx:1223`; nothing at all at `CustomerForm.tsx:150-152`. `validateQuoteForm` never validates `zip`, relying entirely on the keystroke filter — so any other caller skips it silently.

**Sqft — 3:** bounded 100–50000 (`bookingFunnel.ts:255-259`); capped at 99999 by a `.slice(0,5)` that contradicts the bound (`QuotePage.tsx:978`); unbounded (`AddService.tsx:187`).

**Money input — 4 digit filters, 9 parse sites** (see §1.2), plus one money input with no filter at all (`LeadPanel.tsx:211-216`).

**Domain logic duplicated wholesale and already diverged:** `apps/crm/src/portal/AddService.tsx:62` `needsFor()` says at `:60` that it "Mirrors the funnel's `quoteFieldNeeds`" (`bookingFunnel.ts:84`). It does not — see §4.13. `const onlyDigits` is defined at both `AddService.tsx:79` and `QuotePage.tsx:135`.

## 1.9 Tables / list rendering

There are **zero `<table>` elements** in either app; everything is div/card-based, and there is no sortable list anywhere (so no sort-state duplication yet — and no place to add it).

Shared primitives exist and dominate: `<ListRow>` (`kit.tsx:269`) 75 usages · `<Card>` 83 · `<EmptyState>` (`kit.tsx:309`) 32 · `<Spinner>` (`kit.tsx:5`) 33.

Competing hand-rolled versions:
- **15 hand-rolled empty states** as `<p className="muted small">` inside `x.length === 0 ?` ternaries, across **4 different class names** (`muted small`, `availability-empty`, `records-empty`, plain): `Group.tsx:126,135` · `Home.tsx:154` · `Billing.tsx:193` · `GroupDetail.tsx:312` · `Dashboard.tsx:851` · `Schedule.tsx:528,789,991` · `CustomerDetail.tsx:1087,1123,1218,1278` · `CustomerDocuments.tsx:157` · `More.tsx:310`. Note `Billing.tsx:193` and `CustomerDetail.tsx:1278` render the same string for the same data with two independent copies of the markup.
- **3 bare `"Loading…"` strings** instead of `<Spinner>`: `Staff.tsx:303` · `VisitChangeHistory.tsx:148` · `More.tsx:309`. No skeletons exist anywhere.
- **14 copies of the same `loading ? … : empty ? … : list` triple-ternary**: `Inventory.tsx:112` · `ProductUsage.tsx:207` · `PricingLog.tsx:69` · `technicians.tsx:101` · `ProductLog.tsx:76` · `PromoCodes.tsx:99` · `Leads.tsx:235` · `MarketRates.tsx:341` · `Staff.tsx:145,316` · `Customers.tsx:108,140` · `VisitChangeHistory.tsx:157` · `Today.tsx:152`.
- Web side: `bk-related-grid` ×20, `bk-tips-list` ×20, `bk-choose-grid` ×20 across 20 near-identical service pages, with no shared section component.

- **Canonical:** a `<DataList items loading empty renderRow>` over the existing `ListRow`/`EmptyState`/`Spinner` — absorbs all 14 + 15 + 3.

---

# 2. File size offenders

Every non-test file over 500 lines. "Cohesive" = one responsibility, just long. "Split" = carrying unrelated jobs.

## Over 2,000 lines

| File | Lines | Distinct responsibilities | Verdict |
|---|---|---|---|
| `apps/web/amplify/functions/crm-docs/handler.ts` | 5,918 | **40-operation dispatch** `:259-753`; tech field workflow (`startJob:4951`, `endApplication:5106`, on-my-way/tracking `:4997-5105`, `completeJob:4906`); service-report lifecycle (draft `:5157`, photos `:5277`, finalize `:4166-4489`, amendments `:4490-4825`, immutability `:3578-3667`); chemical/label compliance `:3697-3760`; geo/presence forensics `:3386-3477`; honest-exit reporting `:5332`, `:5463`; office scheduling `:2125-3076` (with an embedded 640-line sub-dispatcher at `:2434-3076`); dispatch packets `:3077-3237`; owned-work verifier engine `:1028-1667` (its own 8-case switch); portal requests + callbacks `:794-941`; email/PDF delivery `:1825-3824`; S3 document store `:5597-5929`; billing side-quest `:4826` | **Split — ~10 jobs** |
| `apps/web/amplify/data/resource.ts` | 4,043 | Field-level authz helpers `:48-64`; 21 enums `:66-320` (incl. a 100-line `WorkKind`); **55 `a.model()`** `:321-2525`; **~100 custom ops** `:2526-4034` (~1,500 lines, mapping 1:1 onto the five Lambda handlers) | Cohesive but 3 clearly separable blocks |
| `apps/web/amplify/functions/booking-public/handler.ts` | 3,710 | SSM cache + CORS `:93-170`; input vocab/validators `:171-302`; internal-op path `:303-344`; **8-route HTTP router** `:345-444`; read endpoints `:647-868`; quoting `:869-2054` (with `quote()` alone at **920 lines**); checkout `:2055-3318` (`book()` at **800 lines**); cancellation + refund policy `:3319-3701` | **Split — ~7 jobs** |
| `apps/crm/src/office/CustomerDetail.tsx` | 3,523 | One 1,900-line page (`:147-2034`, 25+ state slices, 9 rendered sections) **plus 14 sibling components**: `RefundSheet:2035`, `ChargeCardSheet:2159`, `RecordPaymentSheet:2323`, `SettleInvoiceSheet:2461`, `RescheduleForm:2543`, `AmendReportForm:2643`, `ReportDeliveryRecovery:2760`, `PacketFields:2841`, `JobForm:2906`, `JobPacketForm:3026`, `GroupPicker:3121`, `PortalRequestsSection:3186`, `CallbacksSection:3308` | **Split — ~12 jobs** |
| `apps/web/amplify/functions/crm-admin/handler.ts` | 3,320 | **23-operation dispatch** `:219-438`; Cognito identity plumbing `:660-1051`; customer portal access `:1222-1342`; customer lifecycle `:1343-1683`; technician/licence records `:502-617`, `:1684-1855`; **staff RBAC (GL-14)** `:2092-3211`; email deliverability `:3212-3320` | **Split — ~5 jobs** |
| `apps/web/amplify/functions/daily-reminders/handler.ts` | 3,015 | A cron fan-out invoking **27 independent subtasks** `:127-305`: 10 reconcilers, 7 office digests, visit reminders + staffing gate, dunning/collections, Stripe reconciliation (GL-19) `:1756-2183`, booking↔payment reconciliation `:2530-2944`, email retry queue `:2410`, owned-work escalation `:2945` | **Split — 27 jobs** |
| `apps/web/amplify/functions/shared/bookingFinalize.ts` | 2,833 | Slot/route side effects `:19-116`; agreement content constants `:117-180`; entry + claim `:181-777`; attribution parsing `:834-904`; customer matching / lead conversion `:905-1206`; `finalizeClaimed` `:1207-2069` (**860 lines**); comms subsystem `:2070-2596`; late/failed-payment settlement `:2597-2833` | **Split — 2 major (finalize + comms)** |
| `apps/crm/src/tech/JobDetail.tsx` | 2,020 | Product-row modeling + `localStorage` memory `:40-202`; online/offline hook `:80-97`; page shell `:203-748`; `ScopePrepExits:799`; `CallbackFindingCard:922`; `NoAccessCard:1055`; `ReportForm:1192-1887` (**~700 lines**); `ProductRowEditor:1888` | **Split — ~6 jobs** |
| `apps/web/amplify/functions/shared/visitChange.ts` | 2,002 | Constants/leases `:40-172`; preview `:174-286`; event recording + notice `:287-412`; cancel `:413-1095` (incl. a 560-line driver at `:509-1069`); claim/resume machinery `:1096-1396`; reschedule `:1397-2002` (`rescheduleVisit` ~580 lines) | Cohesive domain, 3 ops + claim layer |

## 1,000–1,600 lines

| File | Lines | Responsibilities | Verdict |
|---|---|---|---|
| `shared/pdf.ts` | 1,599 | `PdfWriter` primitive `:22-163`; design constants `:178-245`; `AgreementDoc` layout `:246-402`; **4 unrelated documents** — agreement `:403-739`, quote `:880-1124`, service report `:1127-1415`, amendment `:1416-1599` | Split — 4 docs, 1 writer |
| `shared/capacity.ts` | 1,545 | 6 banded layers: tech eligibility `:112-375`; slot reads `:376-464`; reserve/release `:465-664`; checkout claim lifecycle `:665-929`; routing feasibility `:930-1114`; closed-tour + nightly rebuild `:1115-1288`; day reconciliation `:1289-1545` | Cohesive, 6 layers |
| `crm-pricing/handler.ts` | 1,507 | 5-op dispatch `:104-122`; market research `:123-246`; catalog rollback `:247-371`; SSM `:372-404`; S3 upload `:405-425`; Claude extraction + Google Routes `:426-457`; sheet math `:459-528`; reply composition `:529-628`; `priceLead` `:629-1466` (**840 lines**) | Split — 6 jobs |
| `apps/web/src/pages/booking/QuotePage.tsx` | 1,386 | localStorage pending-quote `:41-83`; field model + validation `:84-141`; page `:142-1281`; `QuoteLoadingScreen` `:1282-1370` | 1 page + 4 concerns |
| `pricing-refresh/handler.ts` | 1,349 | Budget/backoff `:72-118`; SSM `:119-149`; row listers `:150-208`; work selection `:211-290`; **self-heal quote email** `:291-597`; office digest + weekly report `:598-871`; failure settle `:872-914`; leased runner `:915-1031`; cron `:1032-1349` | Split — 5 jobs |
| `shared/planCancellation.ts` | 1,272 | Preview `:45-250`; outcomes `:251-317`; verifier `:329-541`; invoice facts `:542-610`; drive `:611-746`; settle `:747-868`; command write `:869-886`; `cancelPlanForCustomer` `:887-1011`; reclaim/resume `:1012-1206`; email `:1207-1272` | Cohesive |
| `apps/crm/src/lib/api.ts` | 1,185 | 8 domains in one barrel: leads `:43-230`; technician reads `:231-313`; owned work/email `:314-355`; invoices/disputes `:356-742`; work items `:744-825`; market rates `:826-848`; staff/roster/licence `:849-998`; lifecycle `:999-1119`; generic helpers `:1120-1185` | Split — 8 domains |
| `shared/marketRate.ts` | 1,120 | Prompt versioning `:64-95`; vocab + math `:96-218`; variable-cost floor `:220-288`; sheet parse `:289-328`; pricing rollback `:329-414`; catalog snapshots `:415-516`; cached read `:518-561`; demand enqueue `:562-708`; cron machinery `:709-826`; LLM research + prompt hashing `:827-1120` | Split — 6 jobs |
| `crm-billing/handler.ts` | 1,120 | 19-op dispatch `:151-315`; guards `:87-150`; setup-intent/PM `:316-452`; **portal add-service proxy into booking-public** `:341-408` (the outlier); subscriptions `:453-527`; charges `:528-771`; invoice ops `:772-1085`; recovery owner `:1086-1120` | Cohesive money domain |
| `stripe-webhook/handler.ts` | 1,082 | Signature + **11-event dispatch** `:38-190`; funnel settlement `:263-352`; subscription invoice billing `:353-740`; refunds `:741-780`; subscription deletion `:781-946`; disputes `:947-1082` | Cohesive router; disputes separable |
| `apps/crm/src/office/MarketRates.tsx` | 1,069 | `EnginePanel:98`; list page `:233-422`; conversions `:423-452`; `RateForm:453-875`; `RollbackPanel:876` | Split — 4 jobs |
| `apps/crm/src/office/Schedule.tsx` | 1,064 | `Schedule:46-636` (week nav, 5 parallel loads, unscheduled pool, route board, capacity strip) + `AvailabilityPanel:637-1064` (day facts, PTO, closures, 2 inline forms) | **2 pages fused** |
| `apps/web/src/pages/booking/BookPage.tsx` | 1,060 | 20+ state slices covering quote expiry, terms version drift, CARD vs INVOICE, promo, Stripe secret, finalize polling, 6 terminal screens `:444-672`; `PaymentForm:933` | 1 page, ~6 flows |
| `shared/leadLifecycle.ts` | 1,060 | Vocab `:30-68`; activity append `:70-127`; recovery work `:128-196`; `createLead` `:197-393`; consent gate `:394-420`; `logLeadTouch` `:421-548`; 3 capture entry points `:549-687`; `setLeadDisposition` `:688-938`; `assignLeadOwner` `:939-1002`; reassign `:1003-1060` | Cohesive |
| `shared/deactivation.ts` | 1,007 | `deactivateCustomer` `:119-649` (**530 lines**); plan listing `:658`; lifecycle sweep `:680-834`; inventory `:835-923`; notice `:924-988` | Cohesive; one 530-line function |
| `apps/web/amplify/backend.ts` | 966 | `defineBackend` `:56-145`; Cognito hardening `:78-136`; CAS lock-table IAM `:137-243`; 4 Function URLs `:244-280`; SES policy/config `:281-287`, `:623-669`; SSM params + grants `:369-533`; CloudWatch alarms + SNS + DLQs `:687-921`; S3 CFN override `:922-937`; AWS Backup `:938-966` | **Split — ~7 infra concerns** |
| `apps/crm/src/office/Dashboard.tsx` | 949 | **10 independent report cards** in one component `:102-811` (revenue by client type `:454`, discounts `:510`, AR aging `:535,570`, recovery queue `:614`, disputes `:655`, uncharged `:717`, not-billing `:741`, no-next-visit `:760`, needs-attention `:780`); `DrillPanel:836` | **Split — 10 reports** |
| `apps/crm/src/office/Work.tsx` | 870 | `WorkQueue:43-744` + **`PaymentsInFlight:745-870`** — an unrelated screen exported from the same file | **Split — 2 screens** |

## 500–800 lines

| File | Lines | Responsibilities | Verdict |
|---|---|---|---|
| `apps/crm/src/office/Staff.tsx` | 786 | Role vocab `:54-92`; roster `:93-225`; `AccessHistory:226-350`; `RosterBadges:351`; `StaffActions:368-677`; `InviteForm:678-786` | Split — 4 |
| `shared/workPolicy.ts` | 824 | Types; **the `WORK_POLICY` data table** (~680 lines of config for 38 kinds); 4 lookups. Grew by the `label` field in `4779b7e` when it absorbed the CRM's copy | Cohesive — one table |
| `apps/crm/src/office/technicians.tsx` | 746 | `technicianComplianceIssue:35`; `TechnicianRoster:53`; `LicenseRecords:176`; `TechForm:368-746` | Split — 3 |
| `shared/subscription.ts` | 730 | Stripe ensure `:29-120`; anchor math `:121-148`; `startPlanBilling:149-287`; **queued-visit cancellation resolution `:288-580`**; `cancelPlanBilling:581-730` | Split — 2 |
| `shared/email.ts` | 597 | HTML shell `:37-91`; MIME `:92-133`; `sendEmail:134-301`; resend `:302-354`; **suppression/do-not-contact policy `:355-401`**; transient classification `:394`; log write `:402-429`; **failure→owned-work `:430-478`**; ops mute + notify `:479-597` | Cohesive-ish; 2 separable |
| `apps/web/src/pages/residential/Residential.tsx` | 554 | Content constants `:7-198`; page `:199-554` | Cohesive |
| `shared/atomicLock.ts` | 552 | Types `:54-103`; suffix resolution `:104-149`; condition builder `:150-213`; DynamoDB store `:214-344`; test seam `:345-354`; 6 CAS primitives `:355-466`; in-memory store `:467-552` | Cohesive primitive |
| `apps/web/src/lib/bookingApi.ts` | 503 | URL discovery `:18-53`; **~25 exported types `:54-299`**; `post` `:300-345`; lead-token storage `:346-395`; 10 endpoint wrappers `:396-503` | Cohesive; type block dominates |
| `apps/crm/src/office/ProductLog.tsx` | 503 | Compliance check `:18-29`; list `:30-132`; `ProductForm:133-503` | Split — 2 |
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

---

# 3. Dead code

## 3.1 Fully dead files

| File | Lines | Evidence |
|---|---|---|
| `apps/web/amplify/functions/shared/fieldRoutesImport.ts` | 236 | Zero importers. Only mention is prose at `apps/web/amplify/data/resource.ts:2643`. Its sibling `agreementImport.ts` **is** live (`crm-admin/handler.ts:17`); only the CSV adapter in front of it is dead. |

`shared/units.ts` was on this list and is **no longer dead** — `4779b7e` pointed `JobDetail.tsx`'s unit picker at its `COMMON_UNITS`. Do not delete it. Its three other exports (`normalizeUnit`, `dimensionOf`, `parseAmount`) are still test-only; see [3.4](#34-unused-exports). `apps/crm/src/lib/accessGroups.ts` was also on this list and was deleted in the same commit.

## 3.2 Orphaned components

`apps/web/src/components/NumberedSteps.tsx` (38 L) · `apps/web/src/components/ServiceSection.tsx` (53 L) · `apps/web/src/components/WhyUs.tsx` (29 L) — zero references of any kind.

Verified **not** orphaned despite appearances: `apps/crm/src/office/technicians.tsx` (imported by `Schedule.tsx:21`), `apps/web/src/pages/ComingSoon.tsx` (imported by `AboutPage.tsx:1`, `Reviews.tsx:1`, `Careers.tsx:1`). All 18 exports of `apps/crm/src/ui/kit.tsx` have external consumers.

## 3.3 Unreachable routes and dead guards

All three stem from `apps/crm/src/lib/auth.tsx:54-58` collapsing `owner`/`office`/`finance` into one boolean:

| Site | Dead thing |
|---|---|
| `apps/crm/src/App.tsx:261-265` | The `roles.finance` tabbar arm — `roles.finance === staff`, so it can never be taken. The "Owned work" tab at `:263` is dead. |
| `apps/crm/src/App.tsx:304-305` | `HomeRedirect`'s `/work` arm — same cause. |
| `apps/crm/src/App.tsx:210` | Consequently **`/work` has no reachable navigation entry**. `apps/crm/src/office/Work.tsx` (870 lines) is a fully-built screen reachable only by typing the URL. `More.tsx` has no entry for it; the backend `sourceUrl: "/work"` values (`daily-reminders/handler.ts:2253`, `post-auth/handler.ts:63`) are consumed only by `Work.tsx:514` itself. |
| `apps/crm/src/App.tsx:199` | `const workStaff = roles.office \|\| roles.finance` is always identical to `staff` on line 198. |
| `apps/crm/src/App.tsx:245` | `/more` is the only route not wrapped in `<Require when={…}>`. Inconsistency, not dead code. |

**Web routes:** `/residential/*` vs `/services/*` render the same components, and this is **intentional and correctly handled** — `apps/web/src/components/SEO.tsx:59-61` rewrites `/residential/*` → `/services/*` for `rel=canonical` and `og:url`, and only `/services/*` is in `sitemap.xml`. No defect. Two `/residential` variants have zero inbound links while their siblings are linked from `Header.tsx`/`Residential.tsx`: `App.tsx:150` `/residential/termite/treatment` and `App.tsx:153` `/residential/wildlife/humane-removal` **[?]** — may be a deliberate omission. `/lp/protect`, `/lp/call` (external ad traffic) and `/request-quote` (legacy redirect) correctly have no internal links. No shadowed or duplicate paths in either route table.

## 3.4 Unused exports

**Declaration-only** — the symbol appears exactly once in the whole tree (dead function bodies):

| Location | Symbol |
|---|---|
| `apps/crm/src/lib/api.ts:72` | `LEAD_OUTCOME_CODES_BY_CHANNEL` |
| `apps/crm/src/lib/api.ts:1120` | `jsonField` |
| `apps/crm/src/lib/backend.ts:28` | `getCustomOutput` |
| `apps/web/amplify/functions/shared/authz.ts:111` | `assertOwner` |
| `apps/web/amplify/functions/shared/bookingPayment.ts:148` | `bookingToProcessing` |
| `apps/web/amplify/functions/shared/bookingPayment.ts:185` | `bookingToBooked` |
| `apps/web/amplify/functions/shared/bookingPayment.ts:258` | `getBooking` |
| `apps/web/amplify/functions/shared/fieldRoutesImport.ts:163` | `adaptFieldRoutesRows` |
| `apps/web/amplify/functions/shared/recovery.ts` | `invoiceAgingBucket` |
| `apps/web/amplify/functions/shared/staffAccessLog.ts:107` | `findStaffAccessEventByKey` |

`bookingPayment.ts` itself is live (`booking-public/handler.ts:53-57`, `daily-reminders/handler.ts:55` import other symbols); three of its state-transition functions are dead.

Also dead: `authz.ts:94` `STAFF_GROUPS` and `authz.ts:97` `isStaff` — `isStaff` has zero call sites, and `STAFF_GROUPS` is used only by `isStaff`. Both duplicate `staffRoles.ts:12` `STAFF_ROLES`.

**Consumed only by their own test (51 exports).** Legitimate test seams — leave: `atomicLock.ts:112 _resolveTableSuffix`, `atomicLock.ts:334 _classifyLockError`, `photoVerify.ts:58 _setS3ClientForTests`.

Genuinely orphaned logic, grouped:
- `apps/web/src/lib/bookingFunnel.ts` — a funnel-state persistence cluster built but never wired into a page: `DESCRIBE_SERVICE:47`, `QuoteFormFields:214`, `FUNNEL_STORAGE_KEY:307`, `StorageLike:310`, `encodeFunnelState:316`, `decodeFunnelState:320`. The module is otherwise live.
- `apps/crm/src/lib/recovery.ts` — `RecoveryInvoice:18`, `RecoveryDispute:31`, `isInDunning:48`, `isOpenDispute:53`, `compareRecoveryItems:192`
- `apps/crm/src/lib/workQueues.ts` — `ChargeableJob:9`, `invoiceCoversJob:31`, `PlanVisitJob:63`, `NextVisitPlan:69`
- `apps/crm/src/lib/marketRates.ts` — `isServable:120`, `selectPlanRate:215`, `planPrefill:256`
- `apps/crm/src/lib/reportDraft.ts` — `DraftStore:18`, `draftKey:28`, `SyncSnapshot:171`
- `apps/crm/src/lib/aging.ts` — `dueBasis:64`, `agingBucketForDays:85`
- `apps/crm/src/lib/bookingLink.ts` — `marketingSiteUrl:32`, `bookingFunnelSpoken:51`
- `apps/crm/src/lib/billingDisclosure.ts` — `BillablePlan:22`, `planBilledOnCompletion:55`
- Others: `amountWords.ts:60`, `deposits.ts:12`, `planCadence.ts:42`, `serviceCatalog.ts:283,300,427`, `routeOptimizer.ts:154`, `season.ts:25`, `subscription.ts:121`, `marketRate.ts:88,155,1025`, `businessHours.ts:126`, `capacity.ts:63,1139`, `bookingLink.ts:20`, `planCancellationPolicy.ts:75`, `units.ts:75,92,119`

**Over-exported (161 symbols)** — `export`ed but used only inside their own module. Not dead; a visibility issue. Densest: `apps/web/src/lib/bookingApi.ts` (13), `apps/crm/src/lib/revenue.ts` (9, the whole `ClientType*` cluster at `:55-141`), `shared/marketRate.ts` (8), `shared/groupChange.ts` (6), `shared/atomicLock.ts` (6), `apps/web/src/lib/analytics.ts` (3). (`apps/crm/src/lib/workPolicy.ts`'s 4 went away with the copy in `4779b7e`.)

## 3.5 Commented-out code — none

38 candidate lines were inspected; all are continuation lines of English prose comments beginning with words like "for", "while", "function", "return". No `/* */` block contains disabled code. The nearest thing is `apps/web/amplify/data/resource.ts:469`, a field-shape description.

**One dangling comment:** `apps/crm/src/App.tsx:229-231` documents a staging-only database-reset route that no longer exists (removed 2026-07-22, commit `9c9bff4`). The comment was not removed with it.

## 3.6 TODO / FIXME / XXX / HACK — none

Zero matches tree-wide, including case-insensitive and loose variants (`TBD`, `deprecated`). Only false positives in page copy (`RodentControl.tsx:43`, `WoodBoring.tsx:85`) and a regex literal at `shared/dispatchReadiness.ts:52`.

---

# 4. Type drift

Canonical schema: `apps/web/amplify/data/resource.ts` — 56 `a.model()`, 20 `a.enum()`.

## 4.1 A3: `productsUsed.amountValue` — `number`/`string` **[V]**

| Declaration | Type |
|---|---|
| `apps/web/amplify/functions/shared/inventory.ts:26` (`ReportProduct`, owns the persisted shape) | `amountValue?: number` |
| `apps/crm/src/tech/JobDetail.tsx:53` (`ProductRow`) | `amountValue?: string` |

The write path converts correctly (`JobDetail.tsx:1425` → `Number(p.amountValue)`, `:1440`). The **read** path does not:
- `JobDetail.tsx:100-101` — `parseProducts` asserts `v as ProductRow[]` over rows whose `amountValue` is a number.
- `JobDetail.tsx:136` — `normalizeRow` does `amountValue: row.amountValue ?? split.value`, **preserving the number**.

Failure path: a tech saves a DRAFT report with a picked product ("2 fl oz"), reloads the job, and presses Save without retyping the amount. `p.amountValue` is the number `2`, and `JobDetail.tsx:1425` calls `p.amountValue?.trim()` → `TypeError: p.amountValue.trim is not a function`. Same at `:1432` (`composeAmount` → `:122`) and `:188` (`rememberAmounts`).

Related in the same pair: `ProductRow.name/epaNumber/quantity/targetPest` are **required** (`JobDetail.tsx:41-46`) while the `ReportProduct` equivalents are all **optional** (`inventory.ts:16-21`); `JobDetail.tsx:1414` `.filter((p) => p.name.trim())` throws on a legacy row with no `name`.

## 4.2 A1: `ServiceCode` subset **[V]**

| Declaration | Members |
|---|---|
| `apps/web/amplify/data/resource.ts:632` (canonical) | GENERAL_PEST, WASP_NEST, RODENT, ROACH, TERMITE, WILDLIFE, **MOSQUITO**, **MOSQUITO_TICK** |
| `apps/web/amplify/functions/shared/serviceCatalog.ts:39` | the 8 + COMMERCIAL_PEST, HOA_COMMON_AREA |
| `apps/crm/src/portal/AddService.tsx:27` | all 8 |
| `apps/web/src/lib/bookingApi.ts:54` | **6 — MOSQUITO and MOSQUITO_TICK missing** |

Laundered by two casts: `apps/web/src/lib/bookingFunnel.ts:37` `code: e.id as ServiceCode` and `apps/web/src/pages/booking/QuotePage.tsx:409` `service: fields.service as ServiceCode`. `funnelCatalog()` returns every entry with `funnel: true`, and both `MOSQUITO` (`serviceCatalog.ts:252`) and `MOSQUITO_TICK` (`:268`) set it — so `SERVICE_OPTIONS` contains two values at runtime that its own element type says are impossible. Any `Record<ServiceCode, …>` map or exhaustive `switch` added in `apps/web/src` will be silently wrong for the two GL-17 seasonal products.

## 4.3 A2: `PlanCadence` missing `SEMIANNUAL`

`resource.ts:79` `ServiceFrequency` has MONTHLY / BIMONTHLY / QUARTERLY / **SEMIANNUAL** (documented at `:83-86` as office-added and real). But `shared/marketRate.ts:106` `PlanCadence` and `apps/web/src/lib/bookingApi.ts:63` `RecurringFrequency` have only three. Consequences:
- `HoaPerUnitRates = Record<HoaBand, Record<PlanCadence, number>>` (`marketRate.ts:142`) and `RateSheet.plans` (`:183`) **structurally cannot hold a semiannual rate**.
- `apps/crm/src/lib/marketRates.ts:35,51` — the Market Rates screen can never price or label one.
- `apps/crm/src/lib/billingDisclosure.ts:16` `VISIT_NOTE` has 3 keys, so `firstChargeWords` (`:24`) silently omits the visit-cadence sentence for a SEMIANNUAL plan — the exact sentence that exists so "quarterly" isn't misread as the billing cadence.
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

`apps/crm/src/lib/api.ts:377-379` says the `Dispute` model "does not exist in the generated types until the backend wave lands." It does: `resource.ts:2140`. Field divergences:

| Field | Schema | CRM `api.ts:381` |
|---|---|---|
| `stripeDisputeId` | `.required()` → `string` (`:2143`) | `?: string \| null` (`:383`) |
| `customerId` | `a.id()` → `string \| null` (`:2144`) | `string` **required** (`:384`) |
| `status` | `a.ref("DisputeStatus").required()` (`:2148`) | `?: DisputeStatus \| string \| null` (`:388`) — widened to `string` |

`listDisputes` (`api.ts:744`) reaches it via `api().models as unknown as {Dispute?: …}` (`:753`) and returns an empty page when the key is absent — so a genuine auth/codegen failure is indistinguishable from "no disputes."

`apps/crm/src/lib/api.ts:358-368` intersects `Schema["Invoice"]["type"]` with eight fields that **all already exist** (`resource.ts:2046-2058`); the comment is stale. The real divergence: `api.ts:356` declares `InvoiceTerms` as a 3-member union, but `resource.ts:2047` is a plain `a.string()` — no server validation, so the union is documentation only. Downstream, five more loose subsets each widen the 6-member `InvoiceStatus` enum (`resource.ts:147`) to `string | null`: `aging.ts:53`, `revenue.ts:13`, `deposits.ts:12`, `recovery.ts:18`, `workQueues.ts:18`. A typo in `"REFUNEDED"` inside `revenue.ts:23` would compile and silently zero collected revenue.

## 4.6 A7/A8: cancel-outcome mirrors missing required fields

`PlanCancellationPreview` — server `shared/planCancellation.ts:54`, CRM `api.ts:445`. Server has `pendingMessage: string` **required** (`:86`), documented as "the truthful in-flight message the portal renders when a cancel is pending, so it never shows a static 'you won't be charged again' against live billing." The CRM type **omits it entirely**.

`CustomerCancelOutcome` — server `:251`, CRM `api.ts:482`. The `CANCELED` arm omits `stripeSubscriptionCanceled` (server: `boolean` required, `:255`) and `settled` (`:262`), the latter documented at `:259-261` as "False = canceled but a residual … is still owned and open — the sweep must NOT count this as completed."

`VisitCancelOutcome.outcome` — server `visitChange.ts:432` has `COMPLETE | PARTIAL | PENDING | FAILED`; CRM `api.ts:555` omits **`FAILED`**, which is genuinely returned at `visitChange.ts:563`. `VisitCancelSheet.tsx:104` happens to catch it via `!== "COMPLETE"`, so no visible bug today; `CustomerDetail.tsx:2619` shows the `=== "PARTIAL"` shape that would exclude it. **[?]** latent.

## 4.7 A9: technician reads over-promise

`apps/crm/src/lib/api.ts:253` declares `customers: Record<string, Customer>` and `:288` `customer: Customer | null` — the full ~80-field entity. The server sends 11 fields: `shared/technicianReads.ts:27-40` `CUSTOMER_VISIT_FIELDS`, applied by `pickCustomer` at `:44`. Same for jobs — `TechnicianJobDetail.job: Job` (`api.ts:271`) vs `pickJob` (`:54`), which `delete`s `priceCents` and `paidPaymentIntentId`. The server's own return type is `AnyRecord = Record<string, unknown>` (`:42,98-99`) — no typed contract on the producing side. Latent today (the tech screens only read inside the projection), but any new read of e.g. `customer.propertyClass` type-checks and returns `undefined`.

## 4.8 A10–A17: remaining entity divergences

| # | Drift | Detail |
|---|---|---|
| A10 | Property class — **5 names, 1 enforced** | `resource.ts:626` `propertyKind` is an enum; `Customer.propertyClass` (`:377`), `Job.propertyClass` (`:1702`), and 3 custom-op args are plain `a.string()`. Type-only copies at `serviceCatalog.ts:37`, `bookingApi.ts:62`, `AddService.tsx:37`; `revenue.ts:46` adds `UNCLASSIFIED`. `onsiteMinutesForClass` (`serviceCatalog.ts:300`) — the LOCKED 30/60-minute capacity rule — reads an unvalidated string; a stray `"Commercial"` books 30 minutes for a 60-minute job. |
| A11 | `PortalRequestRow` / `CallbackRow` declared twice each, disjoint | `portal/Requests.tsx:40,53` vs `office/CustomerDetail.tsx:3186,3308`. `customerId` (schema `.required()`) missing from the CustomerDetail copies; `photoKey` (schema `.required()`) typed `?: string \| null` in one and missing in the other; 5 schema fields absent from both. `Requests.tsx:64` `Mode = "RESCHEDULE"\|"CALLBACK"\|"HELP"` mixes `PortalRequest.kind` values with `CALLBACK`, which is a different model. |
| A12 | `quoteJson` — 1 written shape, **7 reader shapes** | Written at `booking-public/handler.ts:1986`. Read as 7 different ad-hoc types: `handler.ts:501`, `:2457` (no `serviceLabel`), `:2583`, `bookingFinalize.ts:1235`, `:2211` and `:2457` (**no `initialFeeCents`**), `shared/quoteDoc.ts:13`, `QuoteHistory.tsx:26` (`monthlyCents` optional). None includes `days[].factors` or `days[].slot`, both actually stored (`availability.ts:30-38`). |
| A13 | `SheetEdits` omits `extraAnimalCents` | `marketRate.ts:179` has it; `apps/crm/src/lib/marketRates.ts:171` `SheetEdits` does not, and `MarketRates.tsx` has an editor for `extraNestCents` (`:465,500,512,568`) and none for `extraAnimalCents`. `booking-public/handler.ts:1746` and `crm-pricing/handler.ts:1006` **refuse the quote** when `extraAnimals > 0 && extraAnimalCents == null` — so if research produced a wildlife sheet without that key, the office has no CRM path to add it. Also `extraNestCents?: number \| null` (`marketRates.ts:173`) vs `?: number` (`marketRate.ts:176`) — `mergeSheetEdits` guards with `!= null`, so a `null` edit silently no-ops instead of clearing. |
| A14 | `AddService` funnel mirror diverged | `AddService.tsx:52` `Needs` has 4 keys vs `bookingFunnel.ts:64` `QuoteFieldNeeds`'s 6; WILDLIFE returns `none` (`:65`) where the funnel requires `removalKind`+`removalCount` (`:105`); no `inUnit` parameter. Comment at `:58` claims it mirrors. |
| A15 | `DocEntry` vs `CustomerDocumentEntry` | `kind` and `uploadedAt` **required** at `crm-docs/handler.ts:5675`, optional at `CustomerDocuments.tsx:18`. `DOCUMENT_KINDS` (`:5686`) and `KINDS` (`:29`) are the same 5 strings twice; `readDocuments`/`safeParse` are duplicated. |
| A16 | `LabelRules` re-declared inline | `shared/compliance.ts:155` exports the type **and** `parseLabelRules` (`:163`). `ProductLog.tsx:163` re-declares it inline with its own parse; `JobDetail.tsx:161-167` writes a third partial parse. |
A17 (`leadStage` typed and derived twice) was closed by `4779b7e`: the stage derivation now has one copy. The `leadNextActionAt` difference survives **deliberately** — the server's "due now" answers a sweep's question, the CRM's "epoch" answers the office queue's ordering question — and is documented at both ends rather than left as accidental drift.

**Duplicated but currently in sync** (maintenance risk, no drift yet): `WorkKind` 38 members × 2 declarations (`resource.ts` enum + `shared/workPolicy.ts`); `Attribution` (declared **4×** identically at `leadIntake.ts:13`, `bookingFinalize.ts:834`, `lead-intake/handler.ts:18`, `booking-public/handler.ts:219`); staff roles; `PricingOutcome`; `DisputeStatus` members. One asymmetry: `JOB_SCHEDULE_REASONS` (`shared/visitChangeReasons.ts:81`) has no CRM mirror at all.

Closed by `4779b7e`: the visit, staff and lifecycle reason vocabularies and `ServiceAddressFields` each have one declaration now.

## 4.9 B3: `as unknown as` — 108 sites

**Pattern 1 — client shims (~45 in the CRM).** `api().models` / `.mutations` / `.queries as unknown as {…}`, each justified by a comment saying the generated types trail a schema deploy. In every case checked, the op already exists. **Each shim declares a return type with no `errors` field**, so `unwrap()` cannot be used and GraphQL errors are dropped:

`portal/Requests.tsx:94` (errors dropped at `:116,127`) · `CustomerDetail.tsx:3204,3346` (a second shim over the same two models, with different row types) · `Schedule.tsx:677` · `technicians.tsx:191` · `MarketRates.tsx:270` · `api.ts:753,783,806,983,1026,1072` (six models — all of which exist; returns `{data:[]}` on absence, so an auth failure reads as "empty") · plus 19 mutation shims in `api.ts`.

Server-side equivalents: `daily-reminders/handler.ts:2336,2423` · `crm-docs/handler.ts:763` · `bookingFinalize.ts:40` · `lifecycleCommand.ts:82` · `assignVisit.ts:104` · `marketRate.ts:371,440` · `leadClaim.ts:19,68` · `capacity.ts:571,1537` · `groupChange.ts:82,175,253` · `crm-admin/handler.ts:1173` · `pricing-refresh/handler.ts:1218` · `crm-pricing/handler.ts:279`.

**Pattern 2 — forcing an entity into a hand-written DTO** (the strongest signal): `bookingFinalize.ts:240,251,284` (`booking as unknown as BookingRecord`) · `crm-docs/handler.ts:5844` · `technicianReads.ts:315,398` (the whole boundary becomes `Record<string, unknown>`) · `daily-reminders/handler.ts:2061,2104,2114,2806,2842` (five parallel DTOs for the reconciliation sweep) · `stripe-webhook/handler.ts:389,421,672` · `portalData.ts:38` and `Group.tsx:29` (the comment at `portalData.ts:35` admits `get()` and `Schema[…]["type"]` are "structurally equivalent but differently inferred") · `crm-billing/handler.ts:513` (`"" as unknown as {behavior:"void"}`).

**Pattern 3 — untrusted AppSync arguments:** `crm-docs/handler.ts:406,431,450,474,486,491,507,616`; `crm-admin/handler.ts:243,249,408,413`.

**Notably clean:** only **3** `: any` in the whole tree (`bookingLink.ts:70`, `booking-public/handler.ts:969`, `pricing-refresh/handler.ts:423` — all `client: any`, each with an explicit eslint-disable), **zero** `as any`, **zero** `@ts-ignore`/`@ts-expect-error`. All other eslint-disables are `react-hooks/exhaustive-deps`.

## 4.10 B4: AWSJSON `string | object`

Correct narrowing (`typeof raw === "string" ? JSON.parse(raw) : raw`) at 14 sites including `booking-public/handler.ts:501` (`parseStoredQuote`), `shared/quoteDoc.ts:44`, `shared/marketRate.ts:294,579`, `crm-docs/handler.ts:152,4493`, `api.ts:1118`.

Incorrect (`JSON.parse(String(x))`) at 6: `bookingFinalize.ts:1235`, `:2211`, `:2457` · `booking-public/handler.ts:2457`, `:2583` · `QuoteHistory.tsx:33`.

If the client ever returns `quoteJson` already parsed — which `parseStoredQuote` in the *same file* explicitly defends against — `String(obj)` yields `"[object Object]"` and `JSON.parse` throws. At `bookingFinalize.ts:1235` that throw is inside `finalizeBooking` **after the payment succeeded**, i.e. the `PAID_NOT_FINALIZED` state described at `resource.ts:200-204`. `QuoteHistory.tsx:33` catches; `booking-public/handler.ts:2583` does not. **[?]** Latent — depends on client behaviour.

Also unguarded: `Schedule.tsx:706-710` narrows the string case but then casts to `DayFacts` with no validation, and the client type (`:645`) omits a `date` field the server sends (`crm-docs/handler.ts:653-663`).

## 4.11 B5: unvalidated `JSON.parse`

Validated: `reportDraft.ts:78`, `bookingApi.ts:381`, `bookingFunnel.ts:323`.

Cast with no check: `leadIntake.ts:57` · `QuotePage.tsx:51` · `api.ts:1124` · **`api.ts:1179` (`opResult`) — 53 call sites, every custom-op response in the CRM** · `CustomerDetail.tsx:332` · `CustomerDocuments.tsx:38` · `MarketRates.tsx:304` · `JobDetail.tsx:179` · **`shared/leadExtraction.ts:163` — LLM output, `as Extraction`, no schema check** · `booking-public/handler.ts:1121`, `crm-billing/handler.ts:376,390`, `autoQuote.ts:115` (cross-Lambda payloads) · `ops-alerts/handler.ts:64`, `ses-events/handler.ts:361` (SNS payloads) · `crm-pricing/handler.ts:296` · `crm-admin/handler.ts:2068`.

`opResult<T>` is the single largest untyped boundary — it takes `{data: unknown}` and returns `T` with no runtime check, and it is what materializes every DTO in §4.6–4.7.

## 4.12 B6: non-null assertions in risky spots

| Site | Assertion | Risk |
|---|---|---|
| `apps/crm/src/tech/JobDetail.tsx:1619,1730` | `Math.max(Number(cur), picked.reEntryHours!)` | `reEntryHours` is nullable on `Product`; `Math.max(n, null)` → `0`, silently lowering a legally-mandated re-entry interval |
| `apps/crm/src/office/Work.tsx:515` | `navigate(item.sourceUrl!)` | `WorkItem.sourceUrl` is `a.string()` → nullable |
| `apps/crm/src/office/CustomerDetail.tsx:1583` | `p.readFailures!.join(", ")` | On an `opResult`-parsed DTO with no runtime check |
| `apps/web/amplify/functions/crm-docs/handler.ts:264-740` | ~22 × `event.arguments.X!` | Compensating for generated handler arg types being nullable where the schema says `.required()` |
| `crm-docs/handler.ts:2698,2769` | `priorHeldFacts!.minutes` | Capacity minute math |
| `shared/bookingFinalize.ts:1713` | `firstVisitDate!.slice(0,7)` | Builds a `monthKey` for a `TreatmentObligation` |
| `apps/web/src/pages/booking/BookPage.tsx:891` | `(statusToken ?? quote.statusToken)!` | Guarded at `:888`, but exists because `pricedResponse()` (`booking-public/handler.ts:579-604`) returns `statusToken` while the synchronous `quote()` PRICED return (`:2025-2051`) **omits it** — so the GL-05 durability claim at `handler.ts:600-602` does not hold for a fresh quote |

Safe but shim-induced: `portal/Requests.tsx:111,122`, `QuoteHistory.tsx:216`.

---

# 5. Missing patterns

## 5.1 Hand-mirrored modules — CLOSED; one related gap remains

**Item #1 is fully closed** — see the resolved table at the top for commits, and [PATTERNS.md](PATTERNS.md) for the two rules it established (server-owned re-export; pure-leaf extraction). This section keeps only what those commits deliberately did NOT fix.

**A related gap, unfixed:** the CRM's `LEAD_TOUCH_CHANNELS` (`lib/api.ts`) has 4 channels where the server has 6 (`shared/leadLifecycle.ts:45` adds `BOOKING_LINK`, `THUMBTACK`), and the outcome list is ordered differently, which changes dropdown order. `LEAD_TOUCH_OUTCOMES` is likewise still hand-mirrored. This is a functional gap, not just duplication — fixing it is a behaviour change (dropdown contents change) and belongs in its own commit; when it lands, both vocabularies belong in `shared/leadReasons.ts` next to `LEAD_LOST_REASONS`.

**Context that still holds:** there is no `packages/` directory and no root `package.json`. The CRM reaches backend code through deep relative paths (`../../../web/amplify/...`), which `amplify.yml:47-53` supports by running `cd ../web && npm ci` in the CRM `preBuild`, with `amplify.yml:81` caching `../web/node_modules/**/*`. That comment in `amplify.yml` still claims "nothing from apps/web ships in the CRM bundle", which has been false since `serviceCatalog` was value-imported — and is more false with each new leaf.


## 5.2 Repeated shapes with no home

| Missing abstraction | Evidence | Consumers |
|---|---|---|
| `listAll` on `dataClient` | 4 impls + 87 inline loops (§1.1.1) | ~91 |
| `useAsyncData` hook | 34 hand-rolled triads; `kit.tsx` already owns the render halves (`Spinner:5`, `ErrorNote:424`, `SuccessNote:443`) | 34 |
| `errMessage(err, fallback)` | 155 backend + ~102 frontend sites, zero helpers (§1.5) | ~200 |
| CRM copy module | The 102 sites carry **83 distinct hand-written user-visible strings** as inline fallbacks ("Photo upload failed" appears ×4). The backend already has 4 copy modules (`bookingTerms.ts`, `consentText.ts`, `lifecycleReasons.ts`, `visitChangeReasons.ts`); the CRM has zero | ~83 strings |
| Money/date primitives | `apps/crm/src/lib/format.ts` is unreachable from web and backend; 95 inline money expressions; `"America/New_York"` in 14 files (§1.2, §1.3) | ~130 |
| Config/env accessor | 3 near-identical `amplify_outputs` loaders (`bookingApi.ts:18-49`, `leadIntakeApi.ts:18-46` — headers each say they mirror the other — `backend.ts:12-33`); **83 raw `process.env` reads over 29 variable names**; `VITE_GOOGLE_MAPS_API_KEY` read independently in 3 files, `VITE_STRIPE_PUBLISHABLE_KEY` in 2 | 92 |
| `escapeHtml` | **5 definitions**: `shared/receipts.ts:34` (exported), `booking-public/handler.ts:3704`, `lead-intake/handler.ts:162`, `thumbtack-webhook/handler.ts:421`, `daily-reminders/handler.ts:3009`. 48 usages; four are private redefinitions of the exported one | 48 |
| `<ConfirmSheet>` | The server already exposes a preview→commit contract for 3 flows (`previewPlanCancellation`, `previewVisitChange`, `previewLifecycleTransition`), consumed by 2 near-identical bespoke sheets; everything else uses raw `window.confirm` with consequences crammed into a string (19 sites) | ~21 |
| AppSync router | 4 copies of `switch (opFieldName(event)) { … default: throw }` at `crm-docs:259`, `crm-admin:219`, `crm-billing:151`, `crm-pricing:84`. `shared/opEvent.ts` extracted only the field-name read; the router, per-case authz, arg cast, and error arm are copy-pasted | 95 ops |
| Typed op factory | `apps/crm/src/lib/api.ts` repeats the same 6-line `as unknown as` wrapper **27 times** (`:469-476`, `:619-624`, `:1107-1116`, …). One `op<TIn,TOut>(name)` replaces all 27 — and would be generated for free if op contracts lived in a shared package | 27 |
| `logError(event, fields)` | 217 raw `console.*` calls in backend non-test code; 3 incompatible arg shapes (§1.5) | 217 |
| Shared test fixture | **55 test files** hand-build a `fakeDataClient`; **36** separately re-mock `shared/email`. `shared/capacityTestFixture.ts` is the precedent, used by 3 | 55 |

## 5.3 Test seams the source lacks

Each of these test files reaches its subject through `await import("./handler")` — the tests already name a module boundary the source does not have.

| Handler | Lines | Test files splitting it | Notes |
|---|---|---|---|
| `booking-public/handler.ts` | 3,710 | `quote` (1920), `book` (1218), `cancel` (524), `finalizeEmail` (216), `track` (68), `aiBoundary` (62) | **6 seams.** The directory already contains real modules `availability.ts` and `promo.ts` with matching tests — the extraction is half-done. `aiBoundary.test.ts:17` resorts to `readFileSync` + regex over `handler.ts` because there is no module to assert against. |
| `crm-docs/handler.ts` | 5,918 | `compliance` (2248), `bookingLink` (313), `ownedWork` (297) | `ownedWork.test.ts:60` imports the named `updateOwnedWork` (`handler.ts:1399`) — **a function that should live in `shared/ownedWork.ts`, which already exists** with its own test. Same for `shared/compliance.ts` and `shared/bookingLink.ts`. |
| `daily-reminders/handler.ts` | 3,015 | `handler` (503), `recovery` (323), `reconcile` (238), `requestOwnership` (161), `ownedWork` (100) | **5 seams**; four pull a named function out of the monolith |
| `crm-admin/handler.ts` | 3,320 | `offboarding` (1932), `reactivation` (327), `groupAudit` (322) | 3 seams |
| `crm-billing/handler.ts` | 1,120 | `money` (699), `recovery` (428) | 2 seams |
| `stripe-webhook/handler.ts` | 1,082 | `handler` (647), `recovery` (336) | 2 seams |

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
| Public unauthenticated HTTP | `booking-public/handler.ts` — `JSON.parse` guarded at `:388`, then ad-hoc per-route checks (`parseStoredQuote:488`, `quoteFrequency:524`, `normalizePhone:256`, `resolveLeadToken:963,972,999`), with raw `Record<string, unknown>` bodies threaded into 7 route handlers. `lead-intake/handler.ts:200,207` then `EMAIL_RE.test` at `:88` + ~12 open-coded `?.trim()` coercions |
| Webhooks | `stripe-webhook/handler.ts:53` (signature verified; body shape then cast) · `thumbtack-webhook/handler.ts:115` (HMAC; body hand-read) · `auth-challenge/verify.ts:57` |
| LLM output | `shared/leadExtraction.ts:163` — `JSON.parse(text.text) as Extraction`, **no shape check at all**; `shared/marketRate.ts:291,576,1005`; `crm-pricing/handler.ts:296,704`; `autoQuote.ts:115` |
| AppSync arguments | **95 operations** across 4 routers, all cast rather than validated (`crm-admin/handler.ts:222,237,243,249,253,275,288,308,332,352`; `crm-docs/handler.ts:266-274` with non-null assertions) |
| Ad-hoc `parse*`/`read*` fns | 14, no shared contract. `parseQuoteSnapshot` is defined **twice** — `shared/quoteDoc.ts:41` (exported) and `pricing-refresh/handler.ts:309` (private duplicate) |

---

# Appendix — method

- Scanning was done by seven parallel read-only subagents, each scoped to one dimension, followed by hand verification of the highest-severity claims (§4.1, §4.2, §1.4 marked **[V]**).
- Counts are of non-test code unless stated. Line numbers are from the working tree at commit `b74e23a` (branch `staging`, clean) **except** where a later commit is cited inline — `file:LINE` references inside a section closed by a fix will have moved.
- As findings are fixed they are removed from this document and recorded in the Resolved table at the top, with the commit. Anything still described here is still true as of `b74e23a` plus the commits listed there.
- `.claude/worktrees/**` contains three stale full-tree copies (`cool-williamson-080aec`, `vigilant-hawking-99d854`, `dreamy-archimedes-bbb35e`). They roughly quadruple every naive `find`/`wc` metric and were excluded throughout.
- Note for future scans: `grep` returned empty results for at least one valid path in this sandbox (`shared/inventory.ts`); claims resting on a negative grep were re-checked with `Read`.
