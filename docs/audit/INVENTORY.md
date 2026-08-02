# Code Inventory — 2026-08-01, staging @ 9d1b470

Scope: apps/crm (CRM React), apps/web/src (public site React), apps/web/amplify (Gen2 backend). ~135k lines TS.
Ranking = blast radius × how often the inconsistency bites. Behavioral disagreements outrank cosmetic duplication.

## Top findings across all sections

| # | Finding | Section | Why it ranks |
|---|---|---|---|
| 1 | "Today" computed in UTC vs Eastern — 8+ backend impls + 3 CRM impls disagree every evening 7/8pm–midnight ET | D1 | Wrong day in licenses, invoice due dates, recurring anchors, scheduling date chips |
| 2 | Customer-actor auth — 3 divergent rules; crm-docs inline checks deny grp- portal logins that authz.ts allows | D3 | Functional gap for management-company logins, 3-way source-of-truth split |
| 3 | Stale "widened client" layer in crm api.ts — 27 casts working around schema types that have since landed | T2 | Every office screen calls through unchecked hand-typed shapes |
| 4 | Portal AddService drops `offSeason` from its hand-copied quote type → off-season quote dead-ends un-bookable | T5 | Live functional bug, would have been a compile error with shared types |
| 5 | `ServiceCode` union in bookingApi.ts missing MOSQUITO/MOSQUITO_TICK, bridged by cast | T1 | Funnel actively sells values its own type says are impossible |
| 6 | Money formatting — 10 named impls + ~75 inline; `bookingFunnel.money` renders `$1234.5` at checkout | D2 | ~170 sites, customer-visible inconsistency + one display bug |
| 7 | 15 service pages are the same page (6,883 lines, 4-line structural diff) with visible copy-paste rot | M1 | Every layout fix is a 15-file edit that demonstrably doesn't happen |
| 8 | crm-docs/handler.ts: 5,960 lines, 10+ responsibility clusters | F1 | Largest file; service-report lifecycle alone is ~1,300 lines |
| 9 | Leased-claim skeleton re-written 6×; CapacityClaim is the one claim NOT CAS-fenced | D4 | Stale releaser can delete a re-created claim (key reuse, no nonce) |
| 10 | Resumable-command saga machinery written 3× (~1,200 lines: groupChange/lifecycleCommand/staffAccessCommand) + inline in bookingFinalize/visitChange/planCancellation | D5/M2 | Every new durable op re-invents lease/stage/escalation semantics |

Behavioral bugs found in passing (not cleanup — actual wrong output today):
- `apps/crm/src/components/DateTimeFields.tsx:8` — "Today" quick-chip selects tomorrow after ~8pm ET (UTC `toISOString`); feeds every office date picker. Same bug: `apps/crm/src/office/Work.tsx:809`, `apps/crm/src/office/MarketRates.tsx:263`.
- `apps/crm/src/components/CustomerDocuments.tsx:49` — local `fmtDate` parses date-only ISO as UTC midnight → renders previous day; shadows the correct `lib/format.ts:10`.
- `apps/web/src/lib/bookingFunnel.ts:142` — `money(123450)` → `$1234.5` (single decimal) on QuotePage/BookPage.
- `apps/crm/src/portal/AddService.tsx:87,223` — off-season quote returns empty day board + hard-required date → unclickable book step (dropped `offSeason` field, see T5).
- `apps/web/amplify/functions/lead-intake/handler.ts:62-69` — hard-coded `Access-Control-Allow-Origin: "*"` vs booking-public's strict allowlist (`booking-public/handler.ts:150-166`) for another public browser endpoint.
- `apps/web/amplify/functions/shared/stripeClient.ts:9-16` — no live-key-on-staging guard; only booking-public's second construction has `assertStripeKeyAllowed` (`booking-public/handler.ts:140-148`). CRM billing path would run a live key on staging.

---

## 1. DUPLICATE IMPLEMENTATIONS

### D1. "Today's date key" — two semantics that disagree (dates/scheduling)
- Eastern (correct; scheduling model is Eastern-calendar-day per `shared/businessDays.ts`): `booking-public/availability.ts:40` `easternToday()`; byte-identical `todayEastern` copies at `shared/visitChange.ts:90` + `shared/planCancellation.ts:90`; `shared/subscription.ts:527` `todayEasternDate()`; `daily-reminders/handler.ts:111` `easternPlusDays(0)` AND `daily-reminders/handler.ts:2175` `todayEasternDate()` (two in one file); inline `todayEt` at `booking-public/handler.ts:1948,3350`; private Eastern `Intl.DateTimeFormat` again in `shared/businessDays.ts:30`, `shared/season.ts:36`. CRM: `apps/crm/src/lib/format.ts:31` `todayEastern`.
- UTC (`new Date().toISOString().slice(0,10)` — returns tomorrow every evening ET): `daily-reminders/handler.ts:429,1965`, `crm-admin/handler.ts:1715,1794`, `crm-docs/handler.ts:839,1360,2455`, `shared/licenses.ts:52` (license validity), `shared/recurring.ts:123,146` (next-visit anchor), `shared/compliance.ts:49,79`, `shared/callbacks.ts:118`, `shared/subscription.ts:272` (startDate), `shared/marketRate.ts:417`, `pricing-refresh/handler.ts:658`, `booking-public/handler.ts:2755` (NET_30 due date), `shared/agingMath.ts:35` (invoice aging). CRM: `DateTimeFields.tsx:8`, `Work.tsx:809`, `MarketRates.tsx:263`; device-local variant `ProductUsage.tsx:37`.
- Most used: Eastern family (scheduling core). Most correct: Eastern.
- Canonical: one exported `todayEastern()` + `easternPlusDays(n)` in `shared/businessDays.ts`; CRM keeps `lib/format.ts todayEastern` and the 3 UTC holdouts adopt it.
- Blast radius: ~25 backend + 4 CRM call sites, ~18 files; behavioral change in the evening window (verify dedupe keys don't double-fire on switchover day).

### D2. Money formatting — 10 named implementations + ~75 inline
- Backend named: `crm-pricing/rateCards.ts:197` `money()` (drops ".00"), `shared/deactivation.ts:651` `formatCents()`, `shared/cancellationPolicy.ts` `usd`, `shared/planCancellation.ts` `usd` (identical copies), `shared/visitChange.ts:99`, `shared/receipts.ts:20`, `shared/pdf.ts:191` `fmtMoney`.
- Backend inline: ~75 × `$${(cents/100).toFixed(2)}` — `bookingFinalize.ts` (~25), `stripe-webhook/handler.ts` (~10), `daily-reminders`, `shared/refund.ts`, `crm-docs`, `shared/bookingPaymentFailure.ts`, `booking-public`.
- Frontend: `apps/crm/src/lib/format.ts:1` `money` (Intl, null-safe "—", ~85 sites/14 files — most used, most correct); `apps/web/src/lib/bookingFunnel.ts:142` (server-mirroring, but `$1234.5` bug, ~23 sites); verbatim copy of the web variant inside CRM at `apps/crm/src/portal/AddService.tsx:74`; `toFixed` locals at `Inventory.tsx:35` + `ProductUsage.tsx:33`; inline at `PromoCodes.tsx:33,207`, `ProductLog.tsx:197`, `MarketRates.tsx:157,427`.
- Disagreements: `$1234.56` vs `$1,234.56` vs `$1234` mixed in customer-facing email/PDF/portal; portal shows two money styles to the same customer (AddService vs Billing).
- Canonical: backend — one `usd(cents)` (toLocaleString 2dp) in a shared money module; CRM — `lib/format.ts money` everywhere; web keeps server-mirroring style but fixes the one-decimal case.
- Blast radius: ~170 sites, ~25 files; cosmetic-only except the `$1234.5` bug, but touches email/PDF snapshots.
- Related: dollars→cents ×3 (`rateCards.ts:30`, `thumbtack-webhook/autoQuote.ts:65-68`, `fieldRoutesImport.ts:193`) + CRM `Math.round(parseFloat(x)*100)` at `CustomerDetail.tsx:2055,2183,2187,2342,3001`, `MarketRates.tsx:432`, `PromoCodes.tsx:243`, `Inventory.tsx:263`, `ProductLog.tsx:288`, `LeadPanel.tsx:248` (uses `Number()`, no NaN guard) — wants one `toCents()`. Name hazard: `shared/marketRate.ts:163` `tidy` ($X9 ending) vs `booking-public/availability.ts:57` `tidyDollars` (whole dollars) — different policies, similar names.

### D3. "May this caller act for this customer" — 3 divergent rules (auth)
1. `shared/authz.ts:136-158` `assertCanActForCustomer` — OWNER | own cus- group | grp- token ∩ customer row's live `accessGroups`. Matches the AppSync row rule; instant revoke. Used by crm-billing (4+ sites), referenced at booking-public:2543. **Canonical.**
2. `crm-docs/handler.ts:419-422,441-444,463-466` — inline `callerIsOffice || groups.includes(cusGroup(id))` for requestCallback / getCallbackPhotoUploadUrl / submitPortalRequest. Denies grp- logins that (1) allows — functional gap, not just cleanup.
3. `crm-docs/handler.ts:5809-5844` `getDocumentUrl` — honors grp- but derives from `customer.groupId`, not `accessGroups` — third source of truth, agrees today only because groupChange keeps both in sync.
- Blast radius: 4 crm-docs sites; behavior change for grp- logins at the 3 inline sites.
- Related: owner gating done two ways — `authz.ts:88-115` `assertOffice`/`assertOwner`/`assertFinance` (~20 uses in crm-billing) vs inline `if (!callerIsOffice(...)) throw` ~17 sites in `crm-docs/handler.ts` (478,490,495,519,542-580,713-744) + `crm-pricing/handler.ts:103,114,117`, plus redundant `!callerIsOffice && !callerIsFinance` compounds ~7 sites (crm-docs 590-671; FINANCE ≡ OWNER post-consolidation). ~27 mechanical sites.

### D4. Leased-claim skeleton — 6 re-implementations; one off-style (locking)
- Compliant with the atomicLock CAS house style but each re-writes the same ~70-line acquire/lease-check/takeover/fenced-release skeleton: `shared/lifecycleClaim.ts:28-99`, `shared/leadClaim.ts:13-81` (generic — best factoring), `shared/bookingFinalize.ts:414-434` + `:2100-2150` (two claim models), `shared/visitChange.ts:1134-1190`, `shared/planCancellation.ts` (PlanCancellationClaim).
- Off-style: `shared/capacity.ts:731-798` `releaseCapacityClaim` — get → unconditional delete, no holder nonce, no lease fencing (`:756,903` `.delete().catch(() => undefined)`). Stale releaser can delete a claim re-created under the same key. The only claim model not on atomicLock.
- Canonical: generalize `leadClaim.ts`'s model-parameterized acquire/release into `shared/atomicLock.ts` (`acquireLeasedClaim(model, id, leaseMs, extras)`); add holder nonce + `casFencedDelete` to CapacityClaim.
- Blast radius: 6 files, 7 claim models; CapacityClaim fix touches `capacity.ts` (3 delete sites) + `bookingFinalize.ts` consume path.

### D5. Durable command / saga skeleton — 3 parallel implementations (state machines)
- `shared/groupChange.ts` (most complete: ordered STAGE_ORDER, `stageReached`, fenced stage writes), `shared/lifecycleCommand.ts`, `shared/staffAccessCommand.ts` — each independently implements stage enum + isSettled/isTerminal, leaseUntil+nonce resume, attemptCount escalation, one-open-command-per-subject guard. Bespoke `OwnerChangeSerial` create-retry at `staffAccessCommand.ts:317-334`. `daily-reminders/handler.ts:2335-2400` re-implements the resume-sweep loop.
- Same shape also inline in the three sagas: `bookingFinalize.ts`, `visitChange.ts` (claim/resume at ~1098-1400), `planCancellation.ts` (~300 lines apiece).
- Canonical: extract a `durableCommand` helper (create-or-resume, lease, stage advance, escalate-after-N); keep per-command stage lists.
- Blast radius: ~1,200 lines across 3 command files + 3 sagas + the reminders sweep.

### D6. HTTP response construction — 4 styles across 4 Function-URL handlers
- `booking-public/handler.ts:150-166` env-driven origin allowlist + `:454-458` `json()` helper + `HttpError` (`:445`), but raw `{statusCode,...}` literals on error paths (365-438). Most correct.
- `lead-intake/handler.ts:62-69` `jsonResponse` with `Access-Control-Allow-Origin: "*"` — disagrees with the allowlist policy for a public browser endpoint.
- `thumbtack-webhook/handler.ts:103-105` Content-Type-only `json()` (server-to-server, fine); `stripe-webhook/handler.ts:45,60,185,188` bare text bodies.
- Canonical: shared `httpJson(status, body, {cors})` + `corsHeaders`; decide deliberately whether lead-intake's `*` is intended.
- Blast radius: 4 handlers, ~25 response sites; lead-intake CORS change is behavioral.

### D7. Lambda-to-Lambda invocation — 4 name resolvers, 3 protocols into one function
- env-or-SSM function-name resolution ×4: `crm-billing/handler.ts:346-364` (throws), `thumbtack-webhook/autoQuote.ts:71` (null), `pricing-refresh/handler.ts:347+` (null, cached; comments "same lookup as booking-public"), `daily-reminders/handler.ts:2325-2400` (inline SSM for CRM_ADMIN_FUNCTION_PARAM, dynamic import).
- internalOp envelope ×2 + divergence: `crm-billing/handler.ts:366-381` and `thumbtack-webhook/autoQuote.ts:97-122` both build/unwrap `{ok}` — but booking-public dispatches on `internalOp.op` (`handler.ts:357`) while thumbtack sends `internalOp.kind` (`autoQuote.ts:109`). `pricing-refresh/handler.ts:373-395` instead fabricates a fake HTTP event — a third protocol.
- Fire-and-forget pricing wake ×2: `booking-public/handler.ts:931-955` vs `crm-pricing/handler.ts:143-162`.
- Canonical: `shared/peerInvoke.ts` — `resolveFunctionName(envName, paramEnvName)` + `invokeInternalOp<T>` + one exported `InternalOp` type (see also T4).
- Blast radius: 5 files, ~150 lines, plus the dispatch switch at booking-public:350,2507.

### D8. Web REST transport written twice (API fetching)
- `apps/web/src/lib/bookingApi.ts:18-50,300-342` (`getBookingApiUrl` + `post<T>` → discriminated `ApiResult<T>` with status + field errors; backs 10 callers, ~40 sites) vs `apps/web/src/lib/leadIntakeApi.ts:18-47,67-103` (same ladder re-typed; lossy `{ok,error}` result, swallows non-JSON; 2 sites). Header comment in B says it "mirrors" A.
- The `import.meta.glob("/amplify_outputs.json")` trick ×3: `apps/crm/src/lib/backend.ts:12-15` (cleanest, `getCustomOutput` :28-33), `bookingApi.ts:31-34`, `leadIntakeApi.ts:27-30`.
- Canonical: one `resolveCustomOutputUrl(envKey, outputsKey)` + one `post<T>`; give lead intake the `ApiResult` shape.
- Blast radius: 3 lib files, 6 page/component consumers.

### D9. `addressAutocomplete.tsx` duplicated wholesale across apps
- `apps/crm/src/lib/addressAutocomplete.tsx` vs `apps/web/src/lib/addressAutocomplete.tsx` — 247 lines each, diff is 3 comment lines (guard-logic comments already divergent per type-drift scan). Consumers: `apps/crm/src/components/CustomerForm.tsx:109`, `apps/web/src/pages/booking/QuotePage.tsx:1169`.
- Canonical: one shared copy (workspace package); until then every Places fix is made twice. Two `ResolvedAddress` declarations (:12 in both).

### D10. Date helpers — addDays ×5, isWeekday ×4, display formatting ×7
- `addDays(iso, n)`: `booking-public/availability.ts:46`, `shared/recurring.ts:29`, `shared/agingMath.ts:32`, `shared/assignVisit.ts:17`, `shared/cancellationPolicy.ts:47`. ~12 call sites.
- Day-of-week: noon-anchored (`availability.ts:52`, `assignVisit.ts:23`, `recurring.ts:337`) vs midnight-anchored (`shared/capacity.ts:69`, `crm-docs/handler.ts:1142`).
- Display: CRM canonical `lib/format.ts:10` `fmtDate` (noon-trick, 25+ files) vs web `bookingFunnel.ts:152` `formatDay` (correct, different method) vs buggy local `CustomerDocuments.tsx:49` (previous-day bug) vs inline re-implementation `AddService.tsx:441` vs style strays `GroupDetail.tsx:255`, `JobDetail.tsx:1641,1834`, `QuotePage.tsx:607`. `prettyDate` also re-declared at `daily-reminders/handler.ts:118`, `shared/receipts.ts:26`, `shared/recurring.ts:348`, `shared/planCancellationPolicy.ts:183`.
- Canonical: shared date module beside businessDays (backend); `format.ts` (CRM); `formatDay` (web).

### D11. Email/phone validation — 3 regexes + 2 forms with none
- `apps/web/src/lib/bookingFunnel.ts:199` `EMAIL_RE` (mirrors server AWSEmail — canonical) vs loose `/^\S+@\S+\.\S+$/` duplicated at `apps/crm/src/office/Staff.tsx:710` + `apps/crm/src/components/CustomerForm.tsx:70` vs none at `apps/web/src/pages/Contact.tsx:31` + `apps/web/src/components/TalkToExpertModal.tsx:68` (any non-empty string; leads can bounce CRM email actions later).
- `normalizePhone` (E.164) exists only web-side (`bookingFunnel.ts:202-209`); CRM `CustomerForm.tsx:105` free-texts phones → office-entered phones reach the backend unnormalized while funnel phones are E.164.
- Blast radius: 5 files + downstream email/SMS reliability.

### D12. Lead form submit machine — verbatim copy
- `apps/web/src/pages/Contact.tsx:12,25-65` vs `apps/web/src/components/TalkToExpertModal.tsx:18,62-99`: identical Status union, guard copy, name-splitting, analytics triple (trackFormSubmit/trackGenerateLead/trackAdsConversion). ~80 duplicated lines; a copy-edit to one silently forks behavior.
- Canonical: `useLeadForm(formId)` hook beside leadIntakeApi.ts.

### D13. Error handling — unwrap vs first-error; 102 bare ternaries; alert vs ErrorNote
- CRM canonical `lib/api.ts:1091` `unwrap` (joins all messages; ~100+ uses/25 files) vs inline `throw new Error(res.errors[0].message)` (drops all but first) ×12: `JobDetail.tsx:636,685,837,1546,1551`, `Staff.tsx:431,471,769`, `technicians.tsx:229,257,442`, `CustomerDetail.tsx:2790`.
- `err instanceof Error ? err.message : "..."` — 102 occurrences / 33 files, no `errorMessage()` helper in either app.
- Display: kit `ErrorNote` (`ui/kit.tsx:424`, filters technical text, role=alert) vs `window.alert` at `Work.tsx:199,231`, `CustomerDetail.tsx:1907`, `technicians.tsx:459`, `DocButton.tsx:21`. Web has no shared error component (three per-page styles).
- Backend: `pageErrors: "ignore"` = 113 sites, tracked debt marker (daily-reminders 34, crm-docs 14, capacity 10, technicianReads 7, planCancellation 7, crm-admin 6, deactivation 5, rest spread) — deliberate, don't flip casually. `.catch(() => undefined)` ×95 with no marker distinguishing deliberate best-effort from accident — wants a named `bestEffort(promise, label)`.

### D14. `escapeHtml` — 7 implementations
- Exported: `shared/receipts.ts:34`. Copies: `lead-intake/handler.ts:162`, `shared/bookingPaymentFailure.ts:20`, `daily-reminders/handler.ts:3019` (`escapeHtmlLite` — verify same character set), `pricing-refresh/handler.ts:606`, `thumbtack-webhook/handler.ts:422`, `booking-public/handler.ts:3710`.
- Canonical: move to `shared/email.ts`. Blast radius: 6 files, ~40 call sites; an escaping bug currently needs multiple fixes.

### D15. Modal/sheet — one CRM primitive missing behaviors the web one-off has
- `apps/crm/src/ui/kit.tsx:327-352` `Sheet` — 40 call sites / 20 files, but no Escape-to-close, no scroll lock, no dialog role/focus management. `apps/web/src/components/TalkToExpertModal.tsx:103-114` hand-rolls a modal that has all three (lines 51-57, 113-115).
- Canonical: fold TalkToExpertModal's behaviors into `Sheet` (1 file fixes 40 usages).
- Related confirmation split: `window.confirm` ×19 across 10 files (`Work.tsx:249,304,333,363,395`, `CustomerDetail.tsx:744,767,793,959,990,1377`, `Schedule.tsx:217`, `GroupDetail.tsx:168`, `MarketRates.tsx:966`, `PromoCodes.tsx:301`, `ReportPhotos.tsx:92`, `QuoteHistory.tsx:118`) vs consequence-preview sheets (`CustomerDetail.tsx:2049-2270`, `VisitCancelSheet.tsx`, `CancelPlanSheet.tsx`). `CustomerDetail.tsx:744` cancels plan billing behind bare `confirm` while `CancelPlanSheet` exists for the identical action. Native confirm can be blocked in PWA standalone (app ships InstallBanner).

### D16. Smaller duplicate clusters (consolidation debt, no disagreement)
- Presigned-URL PUT upload ×5: `JobDetail.tsx:951,1085`, `portal/Requests.tsx:197`, `CustomerDocuments.tsx:84` (correct content-type fallback), `ReportPhotos.tsx:64`. JobDetail/Requests send empty Content-Type for typeless files → can break presign signature.
- "tolerate absent model" list wrapper ×5 inside `apps/crm/src/lib/api.ts:566-586,716-738,746-766,769-789,937-957` (~110 lines → one `listOptionalModel<T>`).
- Numeric input scrubbing ×9, no `<DollarsInput>`: `CustomerDetail.tsx:2124,2254,2285,2392`, `JobDetail.tsx:1996`, `PromoCodes.tsx:367,379,414`, `AddService.tsx`.
- Storage codecs: web sessionStorage ×4 (`lib/leadIntake.ts:24-61`, `lib/bookingFunnel.ts:307-345` — best, injected StorageLike, `lib/bookingApi.ts:346-392`, `QuotePage.tsx:60-74`); CRM localStorage ×3 (`lib/reportDraft.ts` — canonical versioned/tested, ad-hoc `JobDetail.tsx:180-194`, `InstallBanner.tsx:12-21`).
- Cognito pagination ×3 hand-rolled `do…while NextToken` loops in `crm-admin/handler.ts:2176-2194,2199-2217,3144-3191`; first two are ~90% identical owner-counters.
- `fmtQty` verbatim ×2: `Inventory.tsx:32`, `ProductUsage.tsx:30`.
- Spinner strays: kit `Spinner` (33 sites) vs plain-text `Loading…` at `More.tsx:313`, `Staff.tsx:302`, `VisitChangeHistory.tsx:145`. `EmptyState` (32 uses) vs ad-hoc muted `<p>` at `More.tsx:314`, `Schedule.tsx:528`, `CustomerDetail.tsx:521,1279`, `GroupDetail.tsx:314`, `portal/Billing.tsx:196`.

### Already clean (verified, no action)
- Amplify Data pagination: single `shared/pagination.ts` (~130 sites), zero raw DocumentClient, zero hand nextToken loops. CRM re-uses via `lib/api.ts:9-11,1088`.
- SES: single touchpoint `shared/email.ts`; no raw SES elsewhere. Stripe: single factory `shared/stripeClient.ts`, no `new Stripe(` outside it (but see the key-guard asymmetry above). Stripe amount math: cents end-to-end, no conversions at the boundary.
- Exception durability: `openOwnedWork` 139 sites, zero direct OwnedWork.create bypasses; office alerting centralized with dedupe keys.
- CRM tables/lists: no `<table>` anywhere; kit `ListRow` used consistently. One context per app.

---

## 2. FILE SIZE OFFENDERS (>500 lines, non-test)

| File | Lines | Responsibilities | Verdict | Top extraction |
|---|---|---|---|---|
| apps/web/amplify/functions/crm-docs/handler.ts | 5,960 | Op router; office job create/schedule/rebook; tech field workflow (start/OMW/en-route/no-access/not-performed); service-report draft/finalize/amend/deliver + claim locks; compliance validation; inventory depletion; customer email + resend; portal requests; owned-work updates + verifier; upload URLs + documents; billing kickoff; location presence review | God file (10+) | Service-report lifecycle (~3618–4940) → shared serviceReport.ts; tech field-ops (4944–5630) next |
| apps/web/amplify/data/resource.ts | 4,043 | Entire schema: ~40 models, auth rules, 83 custom ops | Cohesive | Per-domain modules via a.combine (also relieves the 500-resource cap) |
| apps/web/amplify/functions/booking-public/handler.ts | 3,716 | HTTP router + CORS + bot/throttle; secrets/Stripe; lead prefill; /quote (900+ lines); Stripe intent lifecycle; promo; /book; /cancel; /track; internal IAM dispatch | God file | /quote flow (~870–2060) out; Stripe intent CAS machinery (2065–2450) second |
| apps/crm/src/office/CustomerDetail.tsx | 3,538 | Customer page + ~15 embedded sheets/forms: refund/charge/record-payment/settle, reschedule, report amendment + delivery recovery, job + packet forms, group picker, portal requests, callbacks | God file | Each sheet/form (2036+) to own file; billing sheets first |
| apps/web/amplify/functions/crm-admin/handler.ts | 3,350 | Op router; technician CRUD/licenses/offboarding; Cognito login lifecycle + group sync; role changes + owner-count rails + audit events; customer reactivation/contacts; group changes (resumable); agreement import; suppression lift; suspect-address report | God file | Staff/Cognito access mgmt (~2116–3240) vs technician lifecycle vs group ops — three modules |
| apps/web/amplify/functions/daily-reminders/handler.ts | 3,025 | Cron dispatcher; ~10 reconcile sweeps; appointment reminders; dunning + suspension; invoice reminders + AR aging; dispute deadlines; office reports; queued-email retry; owned-work escalation | God file | reconcile-* family (~1776–2760) → shared/reconcile.ts; dunning (1438–1615) second |
| apps/web/amplify/functions/shared/bookingFinalize.ts | 2,837 | Finalize saga (finalizeClaimed ~870 lines); retry/orphan reclaim; pending-failure settlement; comms delivery with send-claim CAS; agreement PDF; attribution | Mostly cohesive | Comms claim/deliver/markers (~2079–2600) → shared comms module |
| apps/crm/src/tech/JobDetail.tsx | 2,022 | Tech job screen: online detection, product-row model + localStorage memory, scope-prep exits, callback card, no-access card, ~700-line report form, product row editor | Cohesive | ReportForm + ProductRowEditor (1194–2022) to own files |
| apps/web/amplify/functions/shared/visitChange.ts | 2,009 | Preview/cancel (drive-held saga + refund math)/reschedule; event recording + notify; claim/reclaim/resume | Cohesive | Claim machinery (~1098–1400) → durableCommand abstraction (D5) |
| apps/web/amplify/functions/shared/pdf.ts | 1,599 | Four PDF renderers (agreement, quote + pest art, service report, amendment) + drawing primitives | Cohesive | One file per doc type over shared primitives |
| apps/web/amplify/functions/shared/capacity.ts | 1,533 | Tech bases/eligibility; slot state + reserve/release; capacity claims; schedule guards; pool minutes; bestSlotFor travel math | Cohesive | Feasibility/bestSlotFor (912+) vs slot bookkeeping |
| apps/web/amplify/functions/crm-pricing/handler.ts | 1,514 | Op router; market research request/wake; GL-16 rollback; secrets; screenshot upload; Claude extraction; zone via Google Routes; sheet pricing; AI reply + guardrails; 800-line priceLead | God file | Rollback (254–378) + reply composition (536–635) out; decompose priceLead |
| apps/web/src/pages/booking/QuotePage.tsx | 1,386 | One ~1100-line component: form, polling, offer display + pending-quote persistence + loading screen | Cohesive | Split into form / offer / polling hook |
| apps/web/amplify/functions/pricing-refresh/handler.ts | 1,353 | Research cron: budgets/backoff, work selection, leased execution; rate-ready email + quote PDF via reverse invoke; daily digest + weekly report; targeted wakeup | God file | Rate-ready email/PDF (~288–594) out |
| apps/web/amplify/functions/shared/planCancellation.ts | 1,275 | Cancellation preview; drive-held saga; resumable command + reclaim; repair; confirmation email | Cohesive | Same durableCommand candidate (D5) |
| apps/crm/src/lib/api.ts | 1,121 | Client factory, ~30 type re-exports, lead constants, typed wrappers for every CRM op | Cohesive facade | Split by domain if it keeps growing; delete stale widened layer (T2) |
| apps/web/amplify/functions/crm-billing/handler.ts | 1,119 | Op router; setup intents + PM summary; subscription start/cancel/pause; one-time/manual charges; invoice void/settle/offline/deposit; portal add-service proxy; recovery-owner assignment | Borderline | Portal proxy (342–410) out |
| apps/web/amplify/functions/stripe-webhook/handler.ts | 1,089 | Verify/dispatch + per-event handlers (setup intent, funnel payments, subscription invoices, refunds, deletion, disputes) | Cohesive | Dispute handlers (951+) if anything |
| apps/crm/src/office/MarketRates.tsx | 1,071 | Engine control panel, rate list, 440-line RateForm, rollback panel | Cohesive | RateForm + RollbackPanel out |
| apps/crm/src/office/Schedule.tsx | 1,064 | Schedule board (590-line component) + availability panel | Cohesive | AvailabilityPanel (637+) out |
| apps/web/src/pages/booking/BookPage.tsx | 1,060 | 880-line checkout component + Stripe PaymentForm + shell | Cohesive | PaymentForm out |
| apps/web/amplify/functions/shared/marketRate.ts | 1,057 | Rate keys/floors; live-read cache; rollback + snapshots; demand-enqueue; research cron machinery; Claude prompt/parse | Borderline | Research block (~640–1057) vs read/cache path |
| apps/web/amplify/functions/shared/leadLifecycle.ts | 1,057 | Lead ledger, create, touch + suppression checks, intake records, disposition + owner assignment | Cohesive | Funnel intake recorders (546–678) if needed |
| apps/web/amplify/functions/shared/deactivation.ts | 1,006 | Deactivation orchestration (530-line fn), future-job sweep, lifecycle inventory, notice email, balance calc | Cohesive | Decompose deactivateCustomer internally |
| apps/web/amplify/backend.ts | 966 | Function URLs, IAM, SSM, SES config-set/SNS, alarms + DLQs, S3 hardening, backup vault | Cohesive CDK | Alarm block (~687–930) → helper |
| apps/crm/src/office/Dashboard.tsx | 949 | Tiles + period filter, drill-down panel, aging badges, assign button | Cohesive | DrillPanel out |
| apps/crm/src/office/Work.tsx | 870 | Work queue + separate PaymentsInFlight export | Two screens | PaymentsInFlight (763+) out |
| apps/web/amplify/functions/shared/workPolicy.ts | 824 | WorkKind taxonomy + declarative WORK_POLICY table | Config data | None |
| apps/crm/src/office/Staff.tsx | 782 | Roster, access history, role/offboard actions, invite form | Cohesive | AccessHistory/InviteForm out |
| apps/crm/src/office/technicians.tsx | 746 | Tech roster + compliance flags, licenses, tech form | Cohesive | LicenseRecords out |
| apps/web/amplify/functions/shared/subscription.ts | 733 | Stripe ensure-customer/product/tax; billing anchor; start/cancel; queued-visit cancellation resolution | Mostly cohesive | cancelQueuedPlanVisits (289–527) is scheduling, not billing |
| apps/web/amplify/functions/shared/email.ts | 597 | Branded shell, MIME build, suppression/do-not-contact + email log + failure work item, queued resend, notify helpers | Cohesive | None urgent |
| apps/web/src/pages/residential/Residential.tsx | 554 | One marketing page | Cohesive | None |
| apps/web/amplify/functions/shared/atomicLock.ts | 552 | CAS lock store + condition builder + test store | Cohesive | None (grow it per D4/D5) |
| apps/web/src/pages/services/Wildlife.tsx | 503 | Marketing page | Cohesive | See M1 |
| apps/web/src/lib/bookingApi.ts | 503 | Typed API client + lead-token storage | Cohesive | None |
| apps/web/src/pages/services/HumaneRemoval.tsx | 501 | Marketing page | Cohesive | See M1 |

Test files >500 lines (name — subject): crm-docs/compliance.test.ts 2,248 — report compliance rules; crm-admin/offboarding.test.ts 1,932 — offboarding/role safety; booking-public/quote.test.ts 1,920 — /quote pricing; shared/bookingFinalize.test.ts 1,751 — finalize saga; pricing-refresh/handler.test.ts 1,674 — research cron; booking-public/book.test.ts 1,218 — /book; crm-pricing/handler.test.ts 1,145 — lead pricing/guardrails; shared/capacity.test.ts 1,107 — slots/claims; shared/visitChange.test.ts 1,035 — visit saga; shared/marketRate.test.ts 1,035 — rate cache/rollback; crm-billing/money.test.ts 699 — billing money ops.

---

## 3. DEAD CODE

### Fully dead exports (high confidence: zero hits outside definition; scanned with `rg -uu --text` incl. the NUL-byte file)
- `apps/crm/src/lib/api.ts:78` `LEAD_OUTCOME_CODES_BY_CHANNEL`
- `apps/crm/src/lib/api.ts:1071` `jsonField<T>()`
- `apps/crm/src/lib/backend.ts:28` `getCustomOutput()`

### Test-only exports, zero production callers (high confidence on the fact; built-ahead API — deletion is a judgment call)
- `apps/crm/src/lib/bookingLink.ts:51` `bookingFunnelSpoken()`
- `apps/crm/src/lib/marketRates.ts:166` `selectPlanRate()`; `:207` `planPrefill()` + `PlanPrefill` (:189)
- `apps/crm/src/lib/planCadence.ts:47` `billingCadence()`
- `apps/web/amplify/functions/shared/units.ts:92` `dimensionOf()`
- (`shared/capacityTestFixture.ts:12` is deliberate test infra — 7 importers; keep.)

### De-export candidates (used only within their own file)
`trackEvent`/`GA_EVENTS`/`GAEventName` (`apps/web/src/lib/analytics.ts:19-49`); `getBookingApiUrl` (`bookingApi.ts:18`), `readLeadToken` (:373); `getLeadIntakeUrl` (`leadIntakeApi.ts:18`); `isIOS`/`isStandalone` (`apps/crm/src/lib/installPrompt.ts:33,41`); `isProductionCrm` (`bookingLink.ts:26`); `classifyInvoice`/`clientTypeByCustomerField`/`latestClientTypeByCustomer` (`revenue.ts:93,115,127`); `ensureTaxRate` (`shared/subscription.ts:91`); `VISIT_NOTE` (`billingDisclosure.ts:16`); `WILDLIFE_OTHER_KIND` (`shared/serviceCatalog.ts:93`); `BOOKING_LINK_TOKEN_TTL_MS` (`shared/bookingLink.ts:26`); `PAYMENT_ATTEMPT_LEASE_MS` (`shared/bookingPayment.ts:38`). Plus ~40 never-imported exported types (full list in scan; low priority).

### Unreachable/unlinked routes (apps/web/src/App.tsx; CRM routes all reachable, /welcome and /request-quote are deep-link entries — keep)
- `/lp/protect` → LPProtect (App.tsx:126) — zero references anywhere incl. sitemap/tests; only LP with no trace (siblings appear in tests). Medium confidence (ad-campaign entry can't be proven dead from code).
- `/residential/termite/treatment` (App.tsx:150) and `/residential/wildlife/humane-removal` (App.tsx:153) — zero links; the `/services/...` aliases are the linked/sitemapped ones. High confidence as unlinked.

### Orphaned components (high confidence, zero imports repo-wide; pre-redesign leftovers from the 2026-07-14 monorepo move)
- `apps/web/src/components/NumberedSteps.tsx` (+ unused `Step` type)
- `apps/web/src/components/ServiceSection.tsx`
- `apps/web/src/components/WhyUs.tsx`

### Commented-out code
None. Both src trees + amplify swept for 3+ consecutive commented statement lines and commented JSX — every hit is prose commentary. Zero TODO/FIXME/HACK markers repo-wide.

### Stale gates / retired tooling
- `TURNSTILE_SECRET` (`booking-public/handler.ts:883` `verifyBotToken`) — never set (no env in backend.ts), no Turnstile widget client-side; branch permanently off (`if (!secret) return true`). Dormant-by-intent per its own comment.
- FieldRoutes migration trio — retired one-off tooling (migration completed on prod 2026-07-22): `shared/fieldRoutesImport.ts` (only consumer is the CLI), `apps/web/scripts/migrationPreview.mts`, + its types. Out of the deploy path.
- `apps/web/scripts/sync-buildium.ts` — not in any package.json script; writes `apps/web/src/data/properties.json` which nothing imports (orphaned generated data).
- NOT stale (verified, leave alone): `ALLOW_UNVERIFIED_ROUTES` (`shared/dispatchReadiness.ts:129`, documented dev escape hatch), `OPS_EMAIL_MUTED` (set by backend.ts:330,346 for staging).

---

## 4. TYPE DRIFT

### T1. `ServiceCode` — 4 competing declarations, 2 disagree on membership
- `shared/serviceCatalog.ts:39` `CatalogServiceId` — 10 codes, self-declared "the ONE versioned service catalog". **Canonical** (already imported browser-side as a value).
- `apps/web/src/lib/bookingApi.ts:54` `ServiceCode` — 6 codes, missing MOSQUITO/MOSQUITO_TICK which the funnel sells (GL-17). Bridged by `bookingFunnel.ts:37` `e.id as ServiceCode` — dropdown carries values its own type forbids; exhaustive switches silently miss mosquito.
- `booking-public/handler.ts:265` untyped SERVICES Set (8 codes); `apps/crm/src/portal/AddService.tsx:27` third hand union (8 codes).
- Blast radius: bookingApi.ts feeds QuotePage/BookPage/CancelPage/TrackPage/bookingFunnel (+2 tests).

### T2. Stale "widened client" layer in apps/crm/src/lib/api.ts — the densest mismatch-hider (27 casts)
Every "until the backend wave lands" workaround now points at schema that has landed:
- `api.ts:375` hand `Dispute` vs `resource.ts:2140` model — hand copy makes `stripeDisputeId`/`status` optional (schema: required) and unions `status` with `string`, defeating narrowing. `api.ts:369` `DisputeStatus` duplicates `resource.ts:314`. Third projection: `recovery.ts:31` `RecoveryDispute`. Feeds Dashboard/Work recovery queue.
- `api.ts:352` `Invoice & {dueDate/terms/poNumber/dunning*/owner*}` — all in schema since `resource.ts:2047-2061`. `api.ts:798` `MarketRate & {pinned}` — schema has it (`resource.ts:1300`).
- ~19 ops reached via `api().mutations as unknown as {...}` all exist in resource.ts now: settleInvoice:3322, payInvoice:3344, previewPlanCancellation:3364, cancelPlanByCustomer:3384, previewVisitChange:3406, cancelVisit:3424, rescheduleVisit:3443, assignRecoveryOwner:3479, staffRoster:2916, changeStaffRoles:2929, offboardStaff:2949, createLead:2750, logLeadTouch:2782, setLeadDisposition:2805, assignLeadOwner:2833, saveTechnicianLicense:2556, setLicenseStatus:2578, previewLifecycleTransition:3208. Each hand-typed input shape can drift from `.arguments()` with zero compile error.
- Same pattern elsewhere: `portal/Requests.tsx:40,53` vs `CustomerDetail.tsx:3187,3316` — two differing hand copies each of `PortalRequestRow`/`CallbackRow` shadowing real models (`resource.ts:1413,1437`); `Work.tsx:745` `InFlightBooking` + `Dashboard.tsx:81` `DiscountBooking` shadowing BookingRequest fields that landed (`resource.ts:692,703,704,755`); `AddService.tsx:108-117` widened `createSetupIntent` (in schema at `resource.ts:3131`); `api.ts:1051` `as never[]`.
- Canonical: generated Schema types. Caveat: `tsc -p amplify` depth-ceiling fragility (V6Client/TS2321) — verify HEAD is green via worktree before/after de-widening.

### T3. Lambda boundary drift — server emits untyped literals, clients type by eye
- booking-public REST has no server-side response types; `bookingApi.ts` is the only wire declaration, maintained by eye. Verified deltas: `PendingQuote.stage` declares `"BUILDING_AVAILABILITY"` which the server never emits (`handler.ts:1634,1665`); `BookedResponse` omits `processing` which the server emits at `handler.ts:3209` (safe only inside the trusted portal branch at :3097 — nothing enforces that).
- crm-billing ↔ booking-public IAM invoke typed independently on each side: `booking-public/handler.ts:303-315` `InternalOp`/`InternalResult` vs `crm-billing/handler.ts:377-379` inline re-declaration. Same repo, money path for portal add-service — export and share.
- crm-docs: grab-bag `Args` (`handler.ts:194`) + 8 ad-hoc `event.arguments as unknown as` re-casts (411,436,455,479,491,496,512,621); crm-admin same (244,250,409,414). Each op's argument shape declared twice; drift surfaces as runtime `undefined`.

### T4. technicianDay — CRM type overstates the wire
- Server deliberately strips Job money fields and reduces Customer (`shared/technicianReads.ts:66-86`, GL-13); CRM declares `jobs: Job[]`, `customers: Record<string, Customer>` (`api.ts:225`; same for TechnicianJobDetail `api.ts:264`) — tech-screen code reading `job.priceCents` type-checks and gets undefined. Canonical: reduced response type exported from technicianReads.ts.

### T5. Portal AddService — lossy third copy of the quote payload with a live functional gap
- `AddService.tsx:87` `QuoteResult` re-declares PricedQuote all-optional, dropping `offSeason`/`offSeasonMessage`/`invoiceEligible`/`expiresAt`/`statusToken`. Portal sells MOSQUITO/MOSQUITO_TICK (:41-42); off-season quote returns `offSeason: true` + empty days (`booking-public/handler.ts:2045-2053`); `confirmBooking` hard-requires a selected date (:223); funnel's `BookRequest.date` is nullable for exactly this case (`bookingApi.ts:208`). Result: off-season portal add-service quotes fine, then dead-ends.

### T6. Enum/union drift
- WorkKind declared twice with no tie: TS union `shared/workPolicy.ts:24` (canonical per header) vs schema `a.enum` `resource.ts:192`. 36 kinds, hand-synced; `workPolicy.test.ts` guards the policy table but nothing guards the schema mirror. Fix: `const WORK_KINDS = [...] as const`, spread into `a.enum`.
- Cadence/frequency ×5: `shared/marketRateKeys.ts:24` PlanCadence (3), `bookingApi.ts:63` RecurringFrequency (3), `booking-public/handler.ts:522` QuoteFrequency (3), schema ServiceFrequency `resource.ts:79` (4, adds SEMIANNUAL), inline 4-value union `api.ts:158`. Bridged by cast at `bookingFunnel.ts:42`.
- PropertyKind/PropertyClass ×4: `serviceCatalog.ts:37` (canonical), `bookingApi.ts:62`, `AddService.tsx:37`, schema enum `resource.ts:626` — while `Job.propertyClass` + 4 other schema fields are untyped `a.string()` (`resource.ts:377,1702,2735,3028,3050`), forcing `revenue.ts:73` to type it `string | null` with an UNCLASSIFIED bucket.
- `PricingLog.tsx:19` Outcome re-declares schema PricingOutcome (`resource.ts:78`).
- Healthy counter-example, don't "fix": `apps/crm/src/lib/leadStage.ts` re-exports the shared union and documents its one deliberate divergence.

### T7. any/cast density (non-test)
| File | Count | Nature |
|---|---|---|
| apps/crm/src/lib/api.ts | 27 | stale widened layer (T2) |
| crm-docs/handler.ts | 13 | 8× arguments re-casts (T3) + models widenings (:768, :1328) |
| daily-reminders/handler.ts | 11 | `listAll(...) as unknown as LocalRow[]` (:1805,:2079,:2119,:2127,:2820,:2855) — each invents a local projection |
| booking-public/handler.ts | 5 | :970 documented `client: any`; :357 untyped IAM boundary; :3174/:3280 |
| shared/bookingFinalize.ts | 5 | `booking as unknown as BookingRecord` ×3 (:244,:255,:288) — two booking-row shapes in one module |
| crm-admin/handler.ts | 5 | arguments casts |
| shared/groupChange.ts | 4 | models widenings |
Other load-bearing: `bookingFunnel.ts:37` (hides T1); `ProductLog.tsx:156` raw `JSON.parse as {...}` of AWSJSON, no validation.

### T8. AWSJSON handling
- `toAwsJson` (the fix for the known parsed-arg gotcha) lives only in `crm-docs/handler.ts:174` (applied :5222). Belongs in shared/ — any other function forwarding a parsed `a.json()` arg re-creates the productsUsed bug. All other AWSJSON writes audited: explicit `JSON.stringify` today (booking-public :1427,:1991,:2024; crm-pricing :741,:1369; lifecycleCommand :318,:333; deactivation :336; crm-docs :3218,:4655) — consistent now, unguarded.
- Read side inconsistent: tolerant `api.ts:1071 jsonField` / crm-docs `parseProducts` (:155) vs unvalidated casts at `ProductLog.tsx:156`, `ProductUsage.tsx:54`, `Schedule.tsx:708`, `MarketRates.tsx:306`.
- `api.ts:1107` `opResult` maps malformed JSON to null → callers report domain errors ("Job not found") for parse failures.
- `ProductRow` (`JobDetail.tsx:41`, `amountValue?: string`) vs `ReportProduct` (`shared/inventory.ts:15`, `amountValue?: number`) — converted at `JobDetail.tsx:1427-1442` but untied; canonical `ReportProduct` with a UI `Omit/&` wrapper. (inventory.ts NUL byte ~offset 7140 — grep needs `-a`/`-uu`.)

---

## 5. MISSING PATTERNS

### M1. `<ServicePage>` template — 15 files are the same page
`apps/web/src/pages/services/` — 15 files, 6,883 lines, each 447–503 lines; letters-stripped diff of RodentControl vs TickProgram = 4 structural lines. Rot already visible: `HumaneRemoval.tsx:9-14` mojibake emoji from a bad paste; Wildlife.tsx got icon images the other 14 never received. Shape: `<ServicePage {...data}/>` + typed per-service data. ~6,400 lines → ~600.

### M2. `durableCommand` + `acquireLeasedClaim` in shared/atomicLock.ts
See D4/D5. Six claim skeletons + three command state machines + three saga inlines; also `daily-reminders/handler.ts:2335-2400` resume sweep.

### M3. `useLoad<T>` hook (CRM)
21 files define the identical data/error/load-useCallback/useEffect quartet (`PricingLog.tsx:33-48`, `Inventory.tsx:53`, `PromoCodes.tsx:44`, `ProductLog.tsx:35`, `portal/Requests.tsx:82`, every office/portal/tech screen). ~20 pages × ~15 lines; would also standardize error strings (D13).

### M4. `useAsyncAction` (CRM)
42 `const [busy|saving, set...]` occurrences across 15+ files, each with its own try/catch/finally; eliminates forgot-to-clear-busy-on-throw. Kit `Button` could take `busy`.

### M5. Confirm primitive (CRM)
19 `window.confirm` sites / 10 files (list in D15); `ui/kit.tsx` has `Sheet` but no confirm. Native confirm is unstyled and can be blocked in PWA standalone.

### M6. `shared/secrets.ts` getSecret
3 verbatim copies with hard-coded appId fallback `"d26qpsjewk0bee"` + `"placeholder-set-me"` sentinel: `booking-public/handler.ts:97-120`, `crm-pricing/handler.ts:383-410`, `pricing-refresh/handler.ts:126-149`. Already drifted (crm-pricing carries a cache-fix comment the others lack).

### M7. Fold `assertStripeKeyAllowed` into shared/stripeClient.ts
Two Stripe constructions with divergent safety: `shared/stripeClient.ts:9-16` (env key, no branch guard; crm-billing/crm-docs/daily-reminders/stripe-webhook) vs `booking-public/handler.ts:140-148` (getSecret + refuses live key on non-prod). Closes the live-key-on-staging gap for the CRM path.

### M8. `shared/businessIdentity.ts`
`"(508) 258-9294"` hard-coded in 32 files across all three apps; 5 files each declare their own constant (`lead-intake/handler.ts:60`, `booking-public/handler.ts:3328`, `QuoteCTA.tsx:4`, `CancelPage.tsx:18`, `TrackPage.tsx:7`); rest inline (Header, Footer, 15 service pages, shared/email.ts, shared/pdf.ts, shared/bookingFinalize.ts). Phone/email/company-name change = 32-file sweep today.

### M9. WorkKind single-source registration
New WorkKind = 6 edits (confirmed via ADDRESS_UNROUTABLE): `shared/workPolicy.ts:25` union + policy table, `shared/ownedWork.ts:13` WORK_SLA_MINUTES, `resource.ts:192` schema enum (hand-synced mirror — the silent-drift risk), producer site, `crm-admin/handler.ts`, `workPolicy.test.ts` (+ verifier in crm-docs when kind closes on verification). Export `WORK_KINDS` const array; derive union, enum, and SLA exhaustiveness. 6 places → 3.

### M10. Per-handler op registry (and the AppSync cap)
83 custom ops in resource.ts; each new op = ~20-line schema block + switch case (`crm-docs/handler.ts:265` — 48 cases; crm-admin:221 — 23; crm-billing:153 — 19; crm-pricing:104 — 5) + unchecked `event.arguments as X` + CRM call site (65 `api().mutations.*`) — at 6 CFN resources each with FunctionDirectiveStack at 499/500. Shape: `{[op]: {auth, run}}` registry replacing switch+casts; longer-term an action-arg multiplexed op collapses the schema cost.

### M11. `EmailTemplateId` union
94 free-form `template:` string literals across the Lambdas; `shared/email.ts:134,483` accept any string. A typo compiles, sends, and fragments EmailLog segmentation the resend/suppression tooling queries. Type-only change makes 94 sites typo-proof.

### M12. `shared/testStore.ts` — one Dynamo simulation instead of 60
83 of ~100 Lambda test files mock dataClient; 60 hand-roll their own in-memory model store (e.g. `shared/leadClaim.test.ts:6-27`), each re-deciding create-on-existing/pagination semantics. Only shared fixture is capacityTestFixture.ts (10 files). Shape: `memoryModel(rows)` + `mockDataClient({...})` with the conditional-write semantics `atomicLock.test.ts` documents.

### M13. Peer-invoke + envelope contract
See D7 — `shared/peerInvoke.ts` with one exported `InternalOp` type (kills the op/kind envelope fork).

### M14. Frontend shared-lib gap between apps
Nothing frontend-shaped is shared between apps/crm and apps/web, which is why addressAutocomplete (D9), the funnel money/date presentation (D2/D10), and validation (D11) got copied instead of imported. Any shared abstraction above lands twice until a `packages/` (or equivalent) exists.

### Confirmed NOT missing (checked; don't re-add)
DAY_MINUTES=540 single-sourced (`shared/capacity.ts:44`); pagination (`shared/pagination.ts`); emailShell adoption; CRM kit primitives (Badge/Sheet/Spinner/EmptyState/ListRow) adopted; CORS helper below the 3-site bar (only 2 browser-facing HTTP handlers — but see D6 for the disagreement between them).
