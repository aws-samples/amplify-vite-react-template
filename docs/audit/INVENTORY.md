# Repository inventory — 2026-08-02

Audit at `4e20a4f` (branch `staging`). Scanned read-only; ranking items 1–4 were
subsequently fixed in `46049f4`, `07379d5`, `e47db11`, `15cce63`, `51a692b` and
this document annotated in place — see the status note under the ranking.

Scope: `apps/web/src` (72 files), `apps/web/amplify` (120 files + `data/resource.ts`),
`apps/crm/src` (69 files) — 261 non-test source files, ~97k lines, plus 109 test files.
`.claude/worktrees/**` is excluded throughout: it holds three stale checkouts and
doubles every raw grep count.

This replaces the inventory written at `0b32017`. Items 2, 3 and 4 of that
document were worked in `9b8f66a`, `60f3c52`, `b58b507`, `77a5ed2`; this scan was
run fresh against the post-fix tree and reports what is there now.

Neither app has a form library, toast library, table library, state manager, or
date library in its dependencies. Every abstraction in those categories is
hand-rolled.

---

## Ranking

Ordered by blast radius × how often the divergence produces an inconsistency.
"Sites" is the number of places that would change if the item were fixed.

**✗** = produces a wrong result today. **△** = the type system or the wiring
permits the divergence but no current call site exercises it.

| # | Item | Sites | Blast radius | Wrong today? | § |
|---|---|---|---|---|---|
| 1 | ~~Zip validated nowhere in the booking path~~ | 3 | Every booking | **FIXED** `46049f4` — `shared/postalCode.ts` | 1.7 / 5.2 |
| 2 | ~~`productsUsed` typed `string` in the CRM, `number` on the wire~~ | 4 parsers | Tech report submit | **FIXED** `46049f4` — coerced at both boundaries | 4.1 |
| 3 | `pageErrors: "ignore"` swallows pagination errors | 82 | Partial reads pass as complete | **PARTLY FIXED** `e47db11` — 32 decision sites flipped; 82 remain | 1.2 |
| 4 | ~~`useAction` has zero adopters; mutations hand-rolled~~ | ~65 | Every CRM mutation incl. payment | **FIXED** `07379d5`, `15cce63`, `51a692b` (+ `useKeyedAction`) | 1.1 |
| 5 | `err instanceof Error ? …` inline | 16 | Error text, CRM | **REDUCED** 79 → 16 by the item-4 migration; 14 of 16 are loads | 1.6 |
| 6 | `crm-admin` is the only handler with no in-handler authz | 1 file | ~25 privileged ops | **✗** 2 ops absent from the schema entirely | 2.4 |
| 7 | `cadenceLabel` — 9 encodings | 9 | Quotes, dropdowns, PDFs, email | **✗** hyphenation split; `SEMIANNUAL` prints raw | 5.1 |
| 8 | Inline `res.errors[0].message` | 12 | CRM mutation errors | **✗** drops errors 2..n | 1.6 |
| 9 | Stripe live-key guard on 1 of 2 clients | 45 | Every money-moving handler | **✗** guard absent on the shared client | 1.3 |
| 10 | Email validation — 5 regexes | ~10 | Lead + booking intake | **✗** CRM accepts what the funnel rejects | 1.7 |
| 11 | `stripe-webhook:490` formats an instant with no `timeZone` | 1 | Invoice descriptions | **✗** wrong month, last ~5h of each month | 1.5 |
| 12 | `escapeHtml` — 8 copies | 8 | Every outbound email | **✗** coverage differs, not bodies | 5.3 |
| 13 | Marketing final-CTA block copied | 26 | Public site | **✗** 3 user-visible wording splits | 5.9 |
| 14 | `CRM_APP_URL` fallback inconsistent | 7 | Links in staff email | **✗** 5 sites emit dead relative links | 5.4 |
| 15 | Cross-Lambda invoke — 5 resolvers, 4 wire shapes | 5 | All service-to-service calls | **✗** throw-vs-null split | 1.2 / 4.5 |
| 16 | `getSecret` triplicated + hardcoded app id | 3 (+1) | Secret resolution | **✗** app id blocks account portability | 1.3 / 5.5 |
| 17 | `prettyDate` — 6 encodings | 6 | Emails, receipts, quotes | **✗** 3 formats for one visit date | 1.5 / 5.6 |
| 18 | `assertOffice`/`assertOwner`/`assertFinance` are aliases | 36 | Every backend authz call | **✗** `crm-pricing` "OWNER-only" is a dead check | 2.2 |
| 19 | Presigned upload — 5 copies | 5 | All file uploads | **✗** 3 of 5 send empty `Content-Type` | 1.1 |
| 20 | `setTimeout(load, 1500)` refetch | 3 | Portal billing state | **✗** stale invoice if backend is slow | 1.1 |
| 21 | `window.confirm` / `alert()` vs `Sheet` | 22 | Destructive CRM actions | **✗** native dialogs, unstyleable in PWA | 1.4 |
| 22 | `Sheet` has no `role="dialog"` / focus trap / Escape | 14 | Every CRM modal | **✗** for keyboard + screen-reader users | 1.4 |
| 23 | Service-area state gate — 2 copies | 2 | Who may be quoted | **✗** one rejects `"ma"`, the other accepts | 5.7 |
| 24 | `normalizePhone` — 4 copies | 4 | Lead + booking intake | **✗** lead-intake drops non-NANP numbers | 1.7 |
| 25 | Brand identity: phone in 4 formats, HQ address disagrees | 30+ | Site, PDFs, drive-time math | **✗** `driveTime.ts` anchors on Ware | 5.8 |
| 26 | `reasonLabel` — 5 copies + ~13 lowercase variants | 18 | CRM labels | **✗** same code, two casings | 5.10 |
| 27 | `rateKey` — 1 builder, 3 parsers | 4 | Pricing reports | **✗** unstated no-`#` invariant | 5.11 |
| 28 | CRM mirrors drop server fields (`pendingMessage`, `FAILED`) | 3 | Cancel flows | **✗** required message unreachable | 4.2 |
| 29 | `Job.cancelDisposition` — 3 vocabularies | 3 | Refund settlement | **✗** `"REFUNDED"` not in the schema's set | 4.3 |
| 30 | `money()` re-forked in the portal | 1 | Portal add-service price | **✗** `$1200` vs `$1,200.00` | 1.4 |
| 31 | `TrackPage` retries permanent errors forever | 1 | Customer tracking page | **✗** unbounded polling | 1.1 |
| 32 | Two POST-JSON clients + 3 outputs loaders | 7 | Public site transport | Partly — B loses HTTP status | 1.1 |
| 33 | `ServiceCode` — funnel union missing 2 members | 3 | Funnel typing | **△** casts hide it; runtime correct | 4.4 |
| 34 | `onsiteMinutesFor` — the 60/30 rule, 3 copies | 3 | Capacity math | No — agree today | 5.12 |
| 35 | Seasonal-window sentence — 8 prose copies | 8 | Funnel, portal, PDF, email | **✗** wording/dash style only | 5.13 |
| 36 | Environment→URL derivation — 3 encodings, 9 bare app ids | 9 | Deploy wiring | No — agree today | 5.5 |
| 37 | CSV export block — 4 copies | 4 | CRM exports | No — none handles embedded newlines | 5.14 |
| 38 | Dead code: 9 exports, 1 module, 3 components, 2 routes | 15 | — | n/a | 3 |

---

> **Status, 2026-08-02.** Items 1, 2 and 4 are closed; item 3 is closed for the
> paths where a short read inverts an answer and left open elsewhere. Item 5
> fell from 79 sites to 16 as a side effect of item 4. Section bodies below are
> annotated in place rather than rewritten, so each finding stays readable
> against the code it described.
>
> The work added three modules — `shared/postalCode.ts`,
> `crm/src/lib/productAmount.ts`, and `useKeyedAction` in
> `crm/src/lib/useAsync.ts` — and surfaced four defects that were not the
> duplication itself; they are recorded in §7.

---

## 1. Duplicate implementations

### 1.1 Frontend data access and mutation

**Already consolidated — verified, no action:**

- One `generateClient`: `apps/crm/src/lib/api.ts:18` (lazy singleton `api()`). `apps/web/src` never touches Amplify Data.
- Pagination: `listAll` re-exported at `apps/crm/src/lib/api.ts:975`, 40 call sites in 20 files, zero hand-rolled `nextToken` loops. One documented opt-out at `apps/crm/src/pages/More.tsx:299`.
- `unwrap` (`apps/crm/src/lib/api.ts:978`, 44 uses) and `opResult` (`:994`, 88 uses).
- `Spinner` / `EmptyState` / `ErrorNote` / `SuccessNote` — `apps/crm/src/ui/kit.tsx:5,309,424,443`.
- One auth context: `RolesContext`, `apps/crm/src/lib/auth.tsx:30`.
- Portal scoping: `loadMyCustomers`, `apps/crm/src/portal/portalData.ts:21`, used by 5 of 6 portal screens.

**A. `useAsync` vs hand-rolled `useCallback load` + `useEffect` — 20 vs 24**

- Canonical: `apps/crm/src/lib/useAsync.ts:48`, core `apps/crm/src/lib/asyncCore.ts:36`.
- Hand-rolled, 24 sites: `office/CustomerDetail.tsx:266,272,298,3215,3345,3349` · `office/Dashboard.tsx:129` · `office/Schedule.tsx:145,716` · `office/MarketRates.tsx:324` · `office/technicians.tsx:203` · `office/Staff.tsx:683` · `portal/Billing.tsx:78` · `portal/Requests.tsx:129` · `portal/AddService.tsx:152` · `tech/JobDetail.tsx:287,293` · `pages/More.tsx:298` · `components/LeadPanel.tsx:72` · `components/QuoteHistory.tsx:103` · `components/CollectPaymentSheet.tsx:40` · `components/CancelPlanSheet.tsx:42` · `components/VisitCancelSheet.tsx:53` · `components/ReportPhotos.tsx:13`.
- `office/technicians.tsx` and `office/Staff.tsx` use both — `useAsync` at the top level, hand-rolled in a nested sub-component of the same file.
- Most correct: `useAsync`. `asyncCore.ts:36-48` is a monotonic request guard (an older in-flight response cannot overwrite a newer one); `useAsync.ts:87` clears stale rows on dep change.
- Dep-keyed sites where this bites: `Schedule.tsx:145` (`[weekStart]`), `CustomerDetail.tsx:266` (`[id]`), `JobDetail.tsx:287` (`[jobId]`), `VisitCancelSheet.tsx:53`, `CancelPlanSheet.tsx:42`. `Schedule.tsx:719` nulls prior state manually, which hides the flash but not the out-of-order write.

**B. Stale-response guards — 4 mechanisms, 3 of them one-off**

| Mechanism | Location | Sites |
|---|---|---|
| `createRequestGuard` (monotonic + alive flag) | `apps/crm/src/lib/asyncCore.ts:36` | 20 |
| `let stale = false` | `apps/crm/src/office/CustomerDetail.tsx:277` | 1 |
| `let cancel = false` | `apps/crm/src/components/ReportPhotos.tsx:14` | 1 |
| `let stopped = false` | `apps/web/src/pages/booking/TrackPage.tsx:78`, `QuotePage.tsx:260` | 2 |
| none | the other 22 hand-rolled loads | 22 |

`AbortController` appears once and is not a fetch guard: `apps/web/src/lib/addressAutocomplete.tsx:128` and `apps/crm/src/lib/addressAutocomplete.tsx:128` (Places typeahead). No AppSync call in either app is abortable.

**C. `useAction` — exists, tested, zero adopters** — **FIXED** `07379d5`, `15cce63`, `51a692b`. 72 call sites across 28 files. Two screens route many independent writes through one keyed handler (`office/Work.tsx` 11 writes, `office/CustomerDetail.tsx` ~17) and use the new `useKeyedAction` (`lib/useAsync.ts`, gate from `createKeyedSingleFlight` in `lib/asyncCore.ts`): a per-hook gate there would let one write in flight silently refuse a press on an unrelated button, which is the failure mode the migration exists to remove. Loads are untouched — that is item D/§1.1 A, still open.

- `apps/crm/src/lib/useAsync.ts:106`; single-flight gate at `apps/crm/src/lib/asyncCore.ts:94`.
- Verified zero call sites (`grep "useAction[<(]"` excluding `lib/useAsync.ts` returns empty). `useAction` and `createSingleFlight` are exported-but-unused production code with passing tests in `asyncCore.test.ts`.
- ~50 hand-rolled `setBusy`/`try`/`catch`/`finally` handlers across ~18 files: `office/CustomerDetail.tsx:2054,2179,2341,2477,2558,2656` · `tech/JobDetail.tsx:803,920,957,1056,1091,1302` · `office/MarketRates.tsx:160,565,614,634,934,964` · `office/Schedule.tsx:179,222,245,266,734` · `portal/Requests.tsx:158,183` · `portal/AddService.tsx:183,237` · `components/CustomerDocuments.tsx:73` · `components/ReportPhotos.tsx:53` · `components/CancelPlanSheet.tsx:61` · `components/VisitCancelSheet.tsx:74` · `components/QuoteHistory.tsx:116` · `components/LeadPanel.tsx:77` · `components/CollectPaymentSheet.tsx:82` · `pages/More.tsx:207,248` · `office/Dashboard.tsx:136,158`.
- All rely on a `disabled` button, which a double-click or held Enter can beat. `useAsync.ts:88-97` documents this as the difference between one charge and two. Financially material at `components/CollectPaymentSheet.tsx:82` and `portal/Billing.tsx:85`.
- **Recommended canonical: `useAction`.**

**D. Refetch-after-mutation — 4 mechanisms**

| Mechanism | Sites |
|---|---|
| `useAsync().reload` | `office/Inventory.tsx:53`, `technicians.tsx:58`, `PromoCodes.tsx:44`, `Staff.tsx:99`, `Customers.tsx:211`, `ProductLog.tsx:37` |
| bespoke `onChanged`/`onDone`/`onSaved` prop | 34 JSX bindings in 12 files; `CustomerDetail.tsx` alone passes 13 (e.g. `:541`, `:1860`), `JobDetail.tsx` 6, `MarketRates.tsx` 3 (`:331`, `:338`) |
| **`setTimeout(() => void load(), 1500)`** | `portal/Billing.tsx:109`, `:298`; `office/CustomerDetail.tsx:1946` |
| direct `await load()` | `office/Dashboard.tsx:144`, `:164` |

Most used: the bespoke prop (34). Most correct: `reload`, which re-enters the request guard (`useAsync.ts:92`). The three `setTimeout` sites are a fixed sleep to outrun Stripe/backend eventual consistency with no retry — if the backend has not settled in 1500 ms the customer sees the pre-payment invoice state at `portal/Billing.tsx:109` and must refresh manually.

**E. Presigned upload — 5 copies in 4 files** — still open. Line numbers below are current as of `51a692b`; the bodies moved when their handlers became `useAction`, but the duplication and the Content-Type divergence are unchanged.

`components/CustomerDocuments.tsx:77` · `components/ReportPhotos.tsx:58` · `tech/JobDetail.tsx:922` · `tech/JobDetail.tsx:1045` · `portal/Requests.tsx:135`.

Each is: `setBusy(true)` → `opResult<{key,uploadUrl}>` → throw if missing → `fetch(url, {method:"PUT", headers:{"Content-Type":…}})` → throw on `!ok` → catch ternary → `finally setBusy(false)`.

- Most correct: `ReportPhotos.tsx:52` — the only one handling a multi-file `FileList` and sending a key delta (`:76`).
- **Content-Type divergence:** `CustomerDocuments.tsx:83` resolves a `contentType` with a fallback; `ReportPhotos.tsx:63` falls back to `image/jpeg`; `JobDetail.tsx:932`, `JobDetail.tsx:1055` and `Requests.tsx:145` pass a possibly-empty `file.type` straight through. Empty `file.type` is common for HEIC and some Android pickers.
- Canonical: one `uploadViaPresignedUrl(getUrlMutation, file)` in `apps/crm/src/lib/api.ts`, wrapped in `useAction`.

**F. Signed-document-URL fetch — 2 copies**

`components/DocButton.tsx:14` (one-shot, opens a tab, `alert()` on error) vs `components/ReportPhotos.tsx:11` (`useSignedUrls`, batched, memoised, cancel guard). `DocButton.tsx:21` is the only `alert()`-based error surface in the CRM; everything else uses `ErrorNote`.

**G. Public-site transport — 2 POST-JSON clients, 3 outputs loaders**

- `post<T>()` — `apps/web/src/lib/bookingApi.ts:300`, URL resolution `:18`, `ApiResult<T>` `:289`. 5 consumers.
- `submitLead()` — `apps/web/src/lib/leadIntakeApi.ts:67`, URL resolution `:18`, `LeadResult` `:63`. 2 consumers. `leadIntakeApi.ts:3` states it mirrors `bookingApi.ts`'s URL resolution.
- A third copy of the glob-loader + module singleton: `apps/crm/src/lib/backend.ts:12`.
- Most correct: `post<T>` — it preserves the HTTP status (`bookingApi.ts:288`), which callers branch on (`QuotePage.tsx:311` on 400/404/409/410; `CancelPage.tsx:81,89,97` on 503/404). `submitLead` collapses everything to `{ok:false,error}`.

**H. Poll loops — 2 independent implementations**

`apps/web/src/pages/booking/TrackPage.tsx:73` and `QuotePage.tsx:255`. Both: `stopped` flag + recursive `setTimeout` + a parallel `setInterval` elapsed-ticker + cleanup.

Most correct: `QuotePage` — it separates terminal HTTP statuses (`:311`, stops on 400/404/409/410) from transient failure (`:319`, retries) and backs off 3 s → 5 s past `LONG_WAIT_MS` (`:326`). `TrackPage.tsx:84` retries on **every** failure at a fixed interval including permanent ones, so a dead token polls forever.

**I. Lead-form submit — 2 copies, no shared hook**

`apps/web/src/pages/Contact.tsx:15` and `apps/web/src/components/TalkToExpertModal.tsx:21` — same `status`/`errorMsg` pair, same two validation branches (`Contact.tsx:32,36` / `TalkToExpertModal.tsx:69,73`), same analytics triple (`:57` / `:91`). `apps/web/src` has no async hook of any kind; `apps/web/src/lib/` holds only `addressAutocomplete`, `analytics`, `bookingApi`, `bookingFunnel`, `leadIntake`, `leadIntakeApi`, `portal`. The CRM's `useAsync` is not importable from web.

**J. Minor**

- Raw `.data ??` bypassing `unwrap` — 4 sites: `office/technicians.tsx:197`, `office/CustomerDetail.tsx:249`, `office/Schedule.tsx:709`, `components/LeadPanel.tsx:59`. A GraphQL error renders an empty list instead of surfacing.
- `addressAutocomplete.tsx` forked across apps — `apps/web/src/lib/` vs `apps/crm/src/lib/`, ~150 lines, differing only in comment wording at lines 106-108 and 120.
- `portal/Group.tsx:25` reimplements the group half of `loadMyCustomers`. Partial overlap only — flagged as probable, not certain.

### 1.2 Backend data access

**Already consolidated — verified, no action:**

- One `generateClient` in the backend: `functions/shared/dataClient.ts:25`. 285 `dataClient()` calls across 50 files. No per-handler client, no direct AppSync SigV4.
- One CAS layer: `functions/shared/atomicLock.ts`, ~99 call sites in 24 files. Delete-then-create is documented as the rejected prior design (`atomicLock.ts:17-22`) and no surviving instance was found.
- One pagination module: `functions/shared/pagination.ts` (`forEachPage:41`, `listAll:59`), 119 call sites in 38 files, zero hand-rolled Amplify `nextToken` loops.

**A. `pageErrors: "ignore"` — was 116 sites, now 82** — **PARTLY FIXED** `e47db11`.

`pagination.ts:19-25` documents the flag as migration debt with the instruction not to write it into new code. At audit time: **116 sites passed `"ignore"`, 0 passed `"throw"`**, ~6 relied on the safe default — a partial scan silently read as a complete one at 95% of call sites.

32 sites now pass an explicit `"throw"`: the ones where a short read does not degrade an answer but inverts it — `capacity.ts` (10, a booked day reads as free), `planCancellation.ts` (7, an outstanding balance reads as settled), `deactivation.ts` (5, missed active plans keep billing), `jobAssignment.ts` (3, an authz proof decided on half the rows), `visitChange.ts` (3), `subscription.ts` (2), `refund.ts` (1), `crm-billing/handler.ts` (1). The `PageOptions` doc now records what earns an explicit throw.

**82 remain**, deliberately: they feed reports and rosters where a short page is cosmetic. That count is still the greppable backlog. The largest holders are `daily-reminders/handler.ts` (34 — mixed reconciliation and reporting, needs per-site judgement) and `crm-docs/handler.ts` (14).

**B. Cognito pagination — 3 hand-rolled loops, 2 near-clones**

`crm-admin/handler.ts:2186`, `:2209`, `:3155`. These page `ListUsersInGroup`/`ListUsers` (capital-`N` `NextToken`), which `PageResult<T>` does not fit, so they are justified. `countOtherUsableOwners` (`:2186`) and `countUsableOwners` (`:2209`) differ only by an `exceptUsername` filter (`:2190` vs `:2213`) and should be one helper.

**C. Cross-Lambda invoke — 5 name resolvers, 4 wire shapes**

| # | Location | Import | Memoized | On unresolved |
|---|---|---|---|---|
| 1 | `crm-billing/handler.ts:345` | dynamic `:349` | no | **throws** a user-facing string `:359` |
| 2 | `pricing-refresh/handler.ts:322` | static | **yes** (`:313`) | `null` |
| 3 | `thumbtack-webhook/autoQuote.ts:71` | static | no | `null` |
| 4 | `daily-reminders/handler.ts:2312` (inline) | dynamic `:2316` | no | logs + `continue` `:2371` |
| 5 | `booking-public/handler.ts:924`, `:1103` | `process.env` only, no SSM | n/a | logs + skip |

#1, #2 and #3 resolve the same function from the same SSM parameter with three different signatures.

Wire shapes:
1. `{ internalOp: {...} }` — receivers `booking-public/handler.ts:363`, `crm-pricing/handler.ts:94`; senders `crm-billing:368`, `autoQuote:104`, `booking-public:935`.
2. Synthetic AppSync event `{ info:{fieldName}, arguments, identity:null }` — `daily-reminders/handler.ts:2375` → crm-admin. See §2.4.
3. Synthetic API-Gateway-v2 event — `pricing-refresh/handler.ts:362` → booking-public `/quote-status`.
4. Bare `{ rateKey, source }` — `booking-public:935`, `crm-pricing:151` → pricing-refresh.

Most correct: #2, the only memoized resolver; #1/#3/#4 hit SSM on every invocation. The throw-vs-null split means the same failure is a 500 in crm-billing and a silent no-op in thumbtack.

Canonical: `shared/invokeFunction.ts` exporting a memoized `resolveFunctionName(envVar, paramVar)` and `invokeInternalOp(name, op)` returning the `{ok}` envelope.

### 1.3 Secrets and the Stripe client

**A. Stripe client — 2 implementations, live-key guard on one**

| Impl | Location | Key source | Guard |
|---|---|---|---|
| shared | `functions/shared/stripeClient.ts:9` | `process.env.STRIPE_SECRET_KEY`, sync | **none** |
| booking-public local | `functions/booking-public/handler.ts:147` | `getSecret()` → env then SSM, async | **yes** — `assertStripeKeyAllowed:76` refuses `sk_live_`/`rk_live_` when `AMPLIFY_BRANCH !== "main"` |

Most used: the shared client (~45 call sites — `stripe-webhook`, `crm-billing`, `crm-docs`, `crm-admin`, `daily-reminders`, `shared/bookingFinalize.ts`). Most correct: the local one. The comment at `handler.ts:75-81` records the defect it prevents: the shared `/amplify/shared/<appId>/STRIPE_SECRET_KEY` SSM fallback holds the live key, so a missing branch secret silently ran the funnel in live mode.

The shared client reads only `secret("STRIPE_SECRET_KEY")`, which is branch-scoped (`crm-billing/resource.ts:24`, `crm-docs/resource.ts:32`, `crm-admin/resource.ts:31`, `daily-reminders/resource.ts:15`, `stripe-webhook/resource.ts:25`), so it does not traverse the shared-SSM path.

> **Not verified.** Whether Amplify's `secret()` can itself resolve to a shared/parent value on a branch with no override. That determines whether the missing guard is reachable. Recommended regardless: move `assertStripeKeyAllowed` into `shared/stripeClient.ts` — it is a 6-line pure check that already has a test.

**B. `getSecret` — 3 verbatim copies**

`booking-public/handler.ts:103` · `pricing-refresh/handler.ts:127` (comment at `:126`: "same lookup as booking-public") · `crm-pricing/handler.ts:383`.

All three hardcode the app id `"d26qpsjewk0bee"` (`:107`, `:131`, `:388`), the branch default `"staging"`, both SSM paths, and the sentinel `"placeholder-set-me"`. The sentinel also appears at `backend.ts:556` and `thumbtack-webhook/handler.ts:439` — 5 copies of one magic string. The app id appears a fourth time at `apps/crm/src/lib/bookingLink.ts:37`.

Most correct: `crm-pricing`, whose `Map<string, string|null>` and comment at `:405-407` explain hits-only caching. Canonical: `shared/secrets.ts`; drop the hardcoded app id and fail loudly when `AMPLIFY_APP_ID` is unset — it currently makes the backend non-portable across AWS accounts.

### 1.4 Notifications, modals, money display

**A. No toast library and no toast component exists** — `grep -i toast` returns zero hits in both apps.

| Mechanism | Count | Sites |
|---|---|---|
| `<ErrorNote>` (`ui/kit.tsx:424`) | 82 | CRM-wide |
| `<SuccessNote>` (`ui/kit.tsx:443`) | 3 | CRM |
| `window.confirm()` | 17 | `office/Work.tsx:246,301,330,360,392`; `office/CustomerDetail.tsx:746,769,795,961,992,1379`; `office/GroupDetail.tsx:177`; `office/Schedule.tsx:217`; `office/PromoCodes.tsx:296`; `office/MarketRates.tsx:958`; `components/QuoteHistory.tsx:111`; `components/ReportPhotos.tsx:92` |
| `alert()` | 5 | `office/Work.tsx:196,228`; `office/CustomerDetail.tsx:1909`; `office/technicians.tsx:453`; `components/DocButton.tsx:21` |
| Inline banner state (`bk-notice`/`bk-form-error`/`bk-field-error`) | 25 | `apps/web/src` — `QuotePage.tsx:537,784,829,1242,1244,1328`; `BookPage.tsx:632,852,1014`; `Contact.tsx`; `TalkToExpertModal.tsx` |

Most correct: `<ErrorNote>` — `role="alert"`, `scrollIntoView`, and a `TECHNICAL_ERROR` regex (`kit.tsx:421`) that replaces stack-trace text with friendly copy.

- 3 `SuccessNote` against 82 `ErrorNote`: most CRM mutations confirm failure but not success.
- `DocButton.tsx:21` is the only CRM error path that bypasses the technical-text filter.
- The 17 `window.confirm()` calls are native OS dialogs inside a fully styled app, and are unstyleable in the iOS PWA this CRM installs as (`components/InstallBanner.tsx`).

**B. Modals — 2 implementations, structurally fine**

`Sheet` (`ui/kit.tsx:327`) — 14 instances across 19 files; the three `*Sheet.tsx` components all compose it (`CollectPaymentSheet.tsx:10,55`, `VisitCancelSheet.tsx`, `CancelPlanSheet.tsx`). `TalkToExpertModal.tsx:106` is a hand-rolled overlay used by 14 service pages.

No hand-rolled fixed-overlay divs exist (`grep 'position: "fixed"'` in `.tsx` returns zero).

The gap here is accessibility, not duplication: `TalkToExpertModal.tsx:113` is the only one with `role="dialog"` + `aria-modal`. `kit.tsx:327` has neither, no focus trap and no Escape handling — only `aria-label="Close"` on the button (`:341`). That affects all 14 CRM modals, for every keyboard and screen-reader user, always.

**C. Money — 1 canonical + 257 sites, 2 divergent**

- Canonical `shared/money.ts:32` (`formatMoney`, `formatMonthly:62`, `formatYearly:68`, `NO_AMOUNT = "—"` `:38`). Re-exported at `apps/crm/src/lib/format.ts:4`, `apps/web/src/lib/bookingFunnel.ts:144`, `crm-pricing/rateCards.ts:199`.
- 257 call sites. Top: `office/CustomerDetail.tsx` 34, `shared/bookingFinalize.ts` 33, `office/Dashboard.tsx` 21, `daily-reminders/handler.ts` 15, `shared/receipts.ts` 14.
- **`apps/crm/src/portal/AddService.tsx:75`** — local `money()`: `Number.isInteger(d) ? \`$${d}\` : \`$${d.toFixed(2)}\``. Renders `$1200` where every other surface renders `$1,200.00`. This is the exact style `money.ts:12-18` documents as the bug it was written to eliminate, on a customer-facing portal page.
- **`crm-billing/handler.ts:147`** — `` `$${(amountCents/100).toLocaleString("en-US")}` `` drops cents (`2000050` → `$20,000`). Fires only above the $20k ceiling, in a refusal message about money. `money.ts:19-20` names this hazard.
- Two cents→dollars rounding rules: `shared/marketRate.ts:165` rounds to the nearest dollar; `booking-public/availability.ts:52` rounds to the nearest dollar then re-multiplies to cents (`$12.49` → `$12.00`). Both feed prices. *Not verified* whether one rate can traverse both.
- Input seeding (not display, correct): `office/CustomerDetail.tsx:2051,2257`; `office/Inventory.tsx:217`; `office/ProductLog.tsx:193`; `office/PromoCodes.tsx:202`; `office/MarketRates.tsx:428`.

### 1.5 Dates

| Module | Purpose | Zone |
|---|---|---|
| `shared/dates.ts:24` | `todayEastern`, `easternPlusDays`, `todayUtc` | Eastern, formatter hoisted |
| `shared/businessDays.ts:30` | Eastern wall-clock → UTC reconstruction `:52`, `oneBusinessDayDeadline` | Eastern |
| `shared/businessHours.ts:14` | `OPEN_HOUR=8`/`CLOSE_HOUR=18`, `isWithinBusinessHours:83`, `contactDueAt:126` | Eastern |
| `shared/season.ts:34` | `monthKeyOf` (Eastern `:36`), `firstWeekdayOf:93` (`Date.UTC`) | **mixed** |
| `shared/cancellationPolicy.ts:49` | `dayEpoch(iso)+days` | UTC epoch |
| `apps/crm/src/lib/format.ts:7` | `fmtDate`, `fmtDateTime`, `todayEastern:30`, `addDays:38` | mixed |

Most used: `todayEastern()` 39 sites, `todayUtc()` 9, `easternPlusDays()` 4; 13 backend files import `shared/dates`. Most correct: `shared/dates.ts` for calendar days (`:12-18` documents why `todayUtc` stays separate — dedupe keys must not shift their boundary on deploy), `shared/businessHours.ts` for instants.

**Duplicate "today":** `booking-public/handler.ts:1941` and `:3362` hand-roll it. That handler does not import `shared/dates` (its imports at `:89` pull only `formatMoney`), while its sibling `booking-public/availability.ts:13` does.

**17 inline `toISOString().slice(0,10)` sites:** `dates.ts:53`, `crm/lib/format.ts:36,41`, `daily-reminders/handler.ts:1897`, `cancellationPolicy.ts:49`, `businessDays.ts:80,88`, `bookingFinalize.ts:1989`, `pricingControl.ts:51`, `bookingPayment.ts:173`, `agingMath.ts:35`, `assignVisit.ts:20`, `compliance.ts:26`, `recurring.ts:33`, `availability.ts:44`, `booking-public/handler.ts:2767`, `pricing-refresh/handler.ts:639`.

**Three incompatible `YYYY-MM-DD` noon anchors:**

| Anchor | Sites |
|---|---|
| `T12:00:00` (runtime-local) | `crm/lib/format.ts:9,39,46,51`; `crm/portal/AddService.tsx:475`; `daily-reminders/handler.ts:113` |
| `T12:00:00Z` (UTC) | `shared/recurring.ts:342`; `shared/receipts.ts:28`; `shared/businessDays.ts:75`; `thumbtack-webhook/autoQuote.ts:138` |
| `T00:00:00Z` + `timeZone:"UTC"` | `shared/planCancellationPolicy.ts:181` |

**Disagreements:**

1. **`stripe-webhook/handler.ts:490-492`** — no `timeZone` and it formats a real instant (`stripeInvoice.created * 1000`), not a noon-anchored date. An invoice created after 19:00 ET on the last day of a month renders as the **next month** in the invoice description. Clearest UTC-vs-Eastern day-boundary defect in the scan.
2. **`stripe-webhook/handler.ts:1029`** pins `timeZone:"UTC"` for a dispute deadline while `shared/pdf.ts:153,160,195,747` pin `America/New_York` for every other customer-visible date.
3. **`apps/crm/src/lib/format.ts:19`** (`fmtDateTime`) has no `timeZone`, so a visit timestamp renders in the viewer's zone in the CRM and in Eastern on the PDF (`pdf.ts:153`). Permanent for any non-Eastern CRM user. (`fmtDate` at `:9` uses local noon, which is safe for ±11h.)
4. **`daily-reminders/handler.ts:113`** is the only backend date formatter with no explicit zone; it inherits the Lambda's `TZ`. Correct today because Lambda runs UTC and the anchor is noon — fragile, not currently wrong.
5. **`shared/pdf.ts:746`** (`fmtQuoteDate`) does `new Date(iso)` with `timeZone:"America/New_York"` and **no noon anchor** — the exact off-by-one `bookingFunnel.ts:149-152` documents. Callers: `pdf.ts:975,976,1105,1261`. If any receives a date-only string the quote PDF prints the previous day.
6. Bare `toLocaleDateString()`/`toLocaleString()` with no locale and no zone: `office/GroupDetail.tsx:264`, `tech/JobDetail.tsx:1630,1823`, `components/CustomerDocuments.tsx:52`.
7. `season.ts:36` derives month keys in Eastern while `season.ts:97` uses `Date.UTC` — two halves of one function on different calendars. Same-day in practice.

Canonical: `shared/dates.ts` for calendar days, `shared/businessHours.ts` for instants; add `formatEasternDate(iso)` / `formatEasternDateTime(iso)` and route the ~20 inline formatters through it. Every display formatter must pin `timeZone`.

### 1.6 Error handling

**Backend — 5 shapes:**

| Shape | Where |
|---|---|
| `throw new Error(...)` (AppSync) | `crm-docs/handler.ts` (206), `crm-admin/handler.ts` (69), `shared/leadLifecycle.ts` (62), `crm-billing/handler.ts` (51), `shared/visitChange.ts` (28), `crm-pricing/handler.ts` (28), `shared/bookingFinalize.ts` (22), `shared/callbacks.ts` (21), `shared/compliance.ts` (18), ~30 more |
| `HttpError(status, payload)` | class `booking-public/handler.ts:451`, caught `:338`, `:439`; ~20 throws, that file only |
| Raw `{statusCode, body}` | `stripe-webhook/handler.ts:46,61,186,189`; `thumbtack-webhook/handler.ts:103`; `lead-intake/handler.ts:62`; `booking-public/handler.ts:371` |
| Result union `{ok:true,data} \| {ok:false,status,error}` | `booking-public/handler.ts:320` |
| `Promise<void>` | `ops-alerts/handler.ts:60`, `ses-events/handler.ts:357`, `post-auth/handler.ts:35`, `pre-token/handler.ts:17`, `lead-sweep/handler.ts:3`, `daily-reminders/handler.ts:119` |

No `return {error: ...}` shape exists — confirmed by grep. Most correct: `HttpError`, which carries the status and the customer-safe payload together so `:440` maps it without guessing.

**Frontend — 3 shapes:**

1. `<ErrorNote>` — `ui/kit.tsx:424`, 82 usages, the only surface that filters technical text.
2. Per-page `useState<string|null>` + hand-rolled JSX — 25 sites in `apps/web/src`. **`apps/web/src` has no `ErrorNote` equivalent**, so the public funnel's ~8 error surfaces get no filtering; a raw `"Failed to fetch"` reaches a paying customer at `BookPage.tsx:990`.
3. **Inline GraphQL unwrapping — 12 copies that drop errors 2..n.** `if (res.errors?.length) throw new Error(res.errors[0].message)` at `office/technicians.tsx:223,251,436`; `office/Staff.tsx:425,465,763`; `office/CustomerDetail.tsx:2784`; `tech/JobDetail.tsx:636,685,826,1535,1540`. The version that joins all messages exists once, at `apps/crm/src/lib/api.ts:982-983`.

**`toMessage` vs inline ternary** — **REDUCED** by `07379d5`/`15cce63`/`51a692b`. `toMessage(err, fallback)` at `asyncCore.ts:14` handles a thrown bare string and treats a whitespace-only `Error.message` as absent (`:15-16`).

At audit time it had **zero direct call sites** outside `lib/`, reaching code only through the 20 `useAsync` loaders, while the inline form `err instanceof Error ? err.message : "…"` appeared **79 times across 25 files** (`office/Work.tsx` 11, `office/CustomerDetail.tsx` 10, `office/MarketRates.tsx` 7, `office/Schedule.tsx` 6, `office/GroupDetail.tsx` 5).

The `useAction` migration routes every mutation through `toMessage`, taking the inline form to **16**, of which **14 are load paths** (`"Could not load …"`) that belong to the open `useAsync` migration. The two that are not: `office/GroupDetail.tsx` and `components/LeadPanel.tsx`, both inside a `catch` that inspects the message to recover from a specific server refusal rather than to display it. `apps/web/src` has **zero** — it never used this idiom.

**Swallowed errors — 36 empty or comment-only `catch` blocks** (of 576 total `catch` occurrences). Line numbers are the closing brace:

`crm/App.tsx:104` · `office/MarketRates.tsx:318` · `components/InstallBanner.tsx:24` · `components/ReportPhotos.tsx:24` · `lib/reportDraft.ts:127,146` · `tech/JobDetail.tsx:197` · `pages/Welcome.tsx:41` · `web/src/lib/bookingApi.ts:45` · `web/src/lib/leadIntake.ts:49` · `web/src/lib/bookingFunnel.ts:356,372` · `web/src/lib/leadIntakeApi.ts:42,99` · `web/src/pages/booking/QuotePage.tsx:64,73,81` · `shared/bookingFinalize.ts:67` · `shared/marketRateKeys.ts:103` · `shared/pricingControl.ts:78` · `shared/assignVisit.ts:129` · `shared/marketRate.ts:520` · `shared/pdf.ts:827` · `shared/capacity.ts:585` · `booking-public/handler.ts:123,2068,2165,2936,2964,2981,3065,3093,3153` · `pricing-refresh/handler.ts:147` · `crm-billing/handler.ts:395` · `crm-pricing/handler.ts:404`

Most are annotated and defensible (sessionStorage in private mode, storage codecs). `booking-public/handler.ts` holds 9 of the 36; that concentration inside the paid-booking path is the subset worth auditing.

### 1.7 Forms and validation

No form library. Controlled state per field everywhere; `<Field>` (`ui/kit.tsx:151`) wraps 161 sites; ~200 `onChange` handlers. One reusable form component exists: `components/CustomerForm.tsx`, used twice (`office/CustomerDetail.tsx:1786`, `office/Leads.tsx:247`). The CRM uses zero `<form>` elements; all three `<form onSubmit>` are in `apps/web/src` (`TalkToExpertModal.tsx:134`, `Contact.tsx:106`, `QuotePage.tsx:835`, all `noValidate`).

**Email — 5 distinct rules:**

| Regex | Sites |
|---|---|
| `/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+$/` | `web/src/lib/bookingFunnel.ts:199` **and** `booking-public/handler.ts:258` — a matched client/server pair |
| `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` | `shared/leadIdentity.ts:16`, `lead-intake/handler.ts:79` |
| `/^\S+@\S+\.\S+$/` | `components/CustomerForm.tsx:70`, `office/Staff.tsx:704` |
| `/^[^@\s]+@[^@\s]+\.[^@\s]+$/` | `crm-admin/handler.ts:1635` |
| `email.includes("@")` | `crm-docs/handler.ts:1050`, `crm-admin/handler.ts:3246` |

Divergences: `foo@bar_baz.com` is rejected by the funnel pair (domain class has no `_`) and accepted by rules 2–4, so a lead created in the CRM can hold an address the funnel would refuse. `foo@bar.com.` is rejected by the funnel pair and accepted by rules 2–4 via backtracking — `lead-intake/handler.ts:81-84` exists specifically to keep AppSync's `AWSEmail` from rejecting the record, but its regex is looser than `AWSEmail`, so it does not achieve that. `crm-admin/handler.ts:3246` and `crm-docs/handler.ts:1050` accept `"a@"`.

**Phone — 4 `normalizePhone` implementations:**

| Impl | Non-US E.164 | Lowercases email |
|---|---|---|
| `web/src/lib/bookingFunnel.ts:202` | accepts `+\d{10,15}` | n/a |
| `booking-public/handler.ts:262` | byte-identical to the above | n/a |
| `shared/leadIdentity.ts:24` / `:19` | accepts (E.164 fast path) | yes |
| `lead-intake/handler.ts:91` / `:86` | **rejects** — `digitsOnly()` at `:75` strips `+` | **no**, `.trim()` only |

`+442071234567` is accepted by three paths and dropped by `lead-intake` (12 bare digits → `undefined`, phone silently moved into notes per `:81-84`). `leadIdentity.ts:4-5` states it consolidated three divergent copies; `lead-intake/handler.ts:91` is one of the old copies, still live. Separately, `lead-intake` stores `Jane@Example.com` un-lowercased while `leadIdentity.normalizeEmail` lowercases before matching, so the identity match at `leadIdentity.ts:82-95` misses that lead.

**Zip — validated nowhere in the booking path** — **FIXED** `46049f4`. `shared/postalCode.ts` now holds both rules and keeps them apart: `isValidZip` (shape) is what the funnel and `quote()` ask; `isMaRiZip` (territory) is what `dispatchReadiness` asks, and it imports it rather than keeping a private copy. Territory was deliberately NOT added to the funnel gate — `booking-public/handler.ts:1495` routes a far address to Zone C behind a lead token, so a distant ZIP is a priceable lead, not a form error. The trusted portal invoke is exempt from the requirement: it forwards the address on file, so a customer record with no ZIP is an office data fix rather than a mid-purchase hard stop. `QuotePage.tsx:1228`'s error slot is now reachable. The finding as originally written:

- `shared/dispatchReadiness.ts:66,97` — `MA_RI_ZIP_RE = /^0[12]\d{3}(-\d{4})?$/`, hard-required at dispatch.
- `shared/leadIdentity.ts:40` — `normalizeZip`, 5 digits, no territory check.
- `web/src/lib/bookingFunnel.ts` `validateQuoteForm` (`:239-279`) — `zip` is declared at `:227` and **never checked**.
- `booking-public/handler.ts:1194-1206` — checks `street`, `city`, `state`; stores `zip` unchecked at `:1318`, `:1333`.
- `QuotePage.tsx:1223` clamps input to 5 digits and `:1228` renders `fieldError("address.zip")` — a UI slot for an error message neither client nor server can emit.

A customer can complete and pay for a booking with an empty or out-of-territory zip. The failure surfaces later at `dispatchReadiness.ts:97` as an ops-side checklist error the customer never sees.

**Required-field rule, lead intake:** client (`Contact.tsx:30-33`, `TalkToExpertModal.tsx:69`) requires name and (phone or email); server (`lead-intake/handler.ts:216-222`) has the same rule but evaluates it **after** `normalizeEmail`/`normalizePhone` (`:214`), which return `undefined` for malformed input. `name="Bob", email="bob@", phone=""` passes the client and returns 400 "email or phone missing" — an error naming a field the user filled in. The client never format-checks email on this path.

Most correct: `bookingFunnel.ts:239-279` + `booking-public/handler.ts:1194+`, the only genuinely mirrored client/server pair; `bookingFunnel.ts:236-238` documents that it uses the same keys as the server's 400 payload so both render through one path (`QuotePage.tsx:535-538`).

### 1.8 Table and list rendering — no duplication

**Zero `<table>` elements in the entire scope.** `ListRow` (`ui/kit.tsx:269`) is used 75 times across 24 files; `Card` 41; `EmptyState` 32. `statusTone` (`kit.tsx:192`) centralises status→colour. `apps/web/src` uses none of these, which is appropriate for a marketing site.

The only gap: no sortable/paginated variant exists, so screens needing sort re-implement it locally (`office/MarketRates.tsx`, `office/Work.tsx`). *Not verified* — sort logic was not audited in depth.

---

## 2. Authorization

### 2.1 Mechanism inventory

Twenty distinct ways a caller is authorised. Schema rules: 141 `allow.groups`, 13 `allow.groupsDefinedIn("accessGroups")`, 15 `allow.resource` in `data/resource.ts`.

| Mechanism | Definition | Sites |
|---|---|---|
| `assertOffice` | `shared/authz.ts:88` | 24 (crm-docs 21, crm-billing 3, crm-pricing 1) |
| `assertFinance` | `shared/authz.ts:101` | 10 (all `crm-billing/handler.ts:178-238`) |
| `assertOwner` | `shared/authz.ts:111` | 2 (`crm-pricing/handler.ts:114,117`) |
| `callerIsOffice` branch | `shared/authz.ts:74` | 6 (`crm-docs:423,522,2416,5819`; `technicianReads:98,341`) |
| `callerIsOwner` as a fact | `shared/authz.ts:67` | 6 (`crm-admin:361,367,373,379`; `crm-billing:96`; `crm-docs:675`) |
| `callerIsFinance` branch | `shared/authz.ts:82` | 3 (`crm-billing:1060,1065`; `crm-docs:678`) |
| `canActForCustomer` / `assertCanActForCustomer` | `shared/authz.ts:136` / `:165` | 8 |
| Job-scoped tech proofs | `shared/jobAssignment.ts:81,147,~172,~186` | 15 |
| `assertOfficeFieldAccess` (handler-local) | `crm-docs/handler.ts:2411` | 6 |
| **Inline raw group check** | `crm-docs/handler.ts:5811,5826` | 1 — the only raw group-string test outside `authz.ts` |
| `assertOwnerRemains` | `shared/staffRoles.ts:125` | 2 |
| Thumbtack shared secret | `thumbtack-webhook/handler.ts:110`, gate `:438` | 1 |
| Stripe signature | `stripe-webhook/handler.ts:43` | 1 |
| Magic-link token | `auth-challenge/verify.ts:52` | 1 |
| CORS allowlist (self-declared not a boundary, `:157-159`) | `booking-public/handler.ts:155` | 1 |
| Trusted-invoke shape check | `booking-public/handler.ts:363` | 1 |
| Trusted-invoke op check **before** role check | `crm-pricing/handler.ts:94`, `assertOffice` at `:103` | 1 |
| **Nothing** | `crm-admin/handler.ts:221-431` | — |

`data/resource.ts` contains no `allow.authenticated`, `allow.publicApiKey`, `allow.guest` or `allow.owner` anywhere — authorization is uniformly group-based. `TECH` has model-level access to exactly one model (`Product` read, `resource.ts:1875`), which is why the job-scoped proofs carry so much weight.

### 2.2 The three role tiers are aliases

`callerIsOffice` (`authz.ts:74`) and `callerIsFinance` (`:82`) both `return callerIsOwner(identity)`. `assertOffice:88` and `assertOwner:111` throw the identical string `"Owner role required"`; `assertFinance:101` throws a different, longer message and is the only one whose text says why.

Consequence at `crm-pricing/handler.ts:112-117`: the comment states "price authority stays role-controlled — OWNER only, checked server-side on top of the schema's group rule", but `assertOffice(event.identity)` already ran at `:103` and is the same predicate. **The two `assertOwner` calls are dead checks.** Not a vulnerability — a comment that will mislead the next person who tries to re-split the tiers.

### 2.3 One dead role-set constant

`STAFF_GROUPS` (`shared/authz.ts:95`) is consumed only by `isStaff` (`:97`), and **`isStaff` has zero callers** — the only mention is a comment at `jobAssignment.ts:12` explaining that field mutations used to gate on it. `STAFF_ROLES` (`shared/staffRoles.ts:13`) is the live one, consumed by `isStaffRole`, `staffRolesIn`, `assertValidRoleSet` and `crm-admin:100,748,2815`. Deleting `authz.ts:95-99` has zero blast radius.

### 2.4 `crm-admin` enforces nothing in-handler

`crm-admin/handler.ts:221-431` dispatches ~25 privileged operations (`adminCreateUser`, `offboardStaff`, `changeStaffRoles`, `revokePortalAccess`, `setLeadDisposition`, …) and calls `callerSub`/`callerEmail`/`callerIsOwner` only to record the actor, never to gate. Every sibling asserts: crm-billing 13, crm-docs 21, crm-pricing 3.

The schema does cover the declared operations — `allow.groups(["OWNER"])` verified on `adminCreateUser:2543`, `importAgreements:2652`, `updateCustomerContact:2738`, `createLead:2772`, `logLeadTouch:2795`, `setLeadDisposition:2825`, `assignLeadOwner:2842`, `liftEmailSuppression:2871`, `staffRoster:2919`.

But **two dispatch cases are absent from the schema entirely** — `grep` for `reportSuspectAddresses` and `resumeGroupChange` in `data/resource.ts` returns nothing. They are reachable only by direct IAM invoke, and the handler keys its switch on `opFieldName(event)` (`shared/opEvent.ts:7`) read from the invoke payload. `daily-reminders/handler.ts:2375-2387` demonstrates the synthesis:

```
{ info: { fieldName: "resumeGroupChange" }, arguments: { commandId }, identity: null }
```

Any principal holding `lambda:InvokeFunction` on crm-admin could substitute `"offboardStaff"`; with `identity: null`, `callerGroups` returns `[]` (`authz.ts:17`) and nothing rejects it. Today the only grant is `daily-reminders` (`backend.ts:403-410`, resource pattern `*crmadmin*`), so this is **defense-in-depth, not a live exploit path** — but it is the largest asymmetry in the codebase. A ~10-line allow-list at the top of the dispatch closes it.

### 2.5 `canActForCustomer` — two revocation latencies

`shared/authz.ts:140-156`. The docstring (`:110-134`) states the check reads the customer's live `accessGroups` stamp so a property removed from a group loses access immediately with no re-issued token. That holds for branch (3), the `grp-` path (`:145-155`). It does not hold for branch (2): `:141` returns `true` on `groups.includes(cusGroup(customerId))` from the token alone, with no read, so a portal user whose own `cus-` group was removed retains access until token expiry.

> **Not verified** whether this is deliberate. The performance note at `:132-134` says owners and ordinary portal customers "return on the token alone, so the existing hot path is unchanged", which suggests yes. Recorded as a documentation/behaviour mismatch, not asserted as a bug.

### 2.6 Three shapes for "portal customer acting on their own record"

- `crm-docs/handler.ts:424,445,467` — `canActForCustomer` alone, distinct per-op error strings.
- `crm-docs/handler.ts:522-530` (`finalizeCallback`) — `!callerIsOffice` → load `CallbackRequest` → `assertCanActOnJobId` (job-scoped, not customer-scoped).
- `crm-billing/handler.ts:1051-1071` (`payInvoice`) — `callerIsFinance` bypass → `assertCanActForCustomer` → catch and rewrite to a uniform `"Not authorized for this invoice"`, same message for a missing invoice (`:1059-1063`).

Only `payInvoice` normalizes errors to prevent id-probing, and is explicit about why (`:1046-1049`). Most correct; the shape to copy for future customer-scoped operations.

---

## 3. File size offenders

59 files over 500 lines — 39 non-test, 20 test. None under `.claude/`.

### 3.1 The 8 carrying genuinely unrelated responsibilities

**`amplify/functions/crm-docs/handler.ts` — 5946.** The entire field-and-office domain behind one Lambda; 48 `case` arms.
`L1-267` env accessors, `parseProducts`, `toAwsJson`, `Args` union · `L268-756` the switch router · `L756-1032` comms + portal cases · `L1032-1812` work-queue/recovery engine (`runWorkVerifier`, `updateOwnedWork`, `closeResolvedWorkItem`) · `L1812-2068` lead quote prep, `sendCustomerEmail` · `L2068-2464` product catalog, `createOfficeJob`, packet field mapping · `L2464-3365` scheduling (`updateJobSchedule` is 660 lines alone) · `L3365-3608` no-access resolution, presence assertions · `L3608-3797` report-immutability + product approval gates · `L3797-4535` report delivery + finalize · `L4535-4871` amendments · `L4871-5025` `startBillingForPlan`, `completeJob` · `L5025-5185` tech field lifecycle · `L5185-5625` report authoring · `L5625-5946` S3 upload URLs, customer documents.
Seam: `L1032-1812` moves out whole — it shares nothing with the report path but the data client. Second: `L3797-4871` as `reportFinalize.ts`.

**`amplify/data/resource.ts` — 4043.** Uniform, not tangled: `L40-64` field-auth helpers · `L66-320` 21 enums · `L321-2525` ~54 models (Customer `L352`, ServicePlan `L516`, BookingRequest `L607`, Job `L1621`, ServiceReport `L1912`, Invoice `L2016`, ~14 claim/command lock models `L773-1098`) · `L2526-4034` ~130 custom operations · `L4036-4043` exports.
Seam: `L2526-4034` is exactly half the file, depends on nothing above it, and splits mechanically into per-function operation modules.

**`amplify/functions/booking-public/handler.ts` — 3728.** `L103-176` secrets, Stripe client, CORS · `L177-350` types, sanitization, `handleInternalOp` · `L351-460` HTTP router · `L460-863` quote snapshot parse + three read endpoints · `L863-1132` anti-abuse + lead plumbing · **`L1132-2053` `quote()` — 920 lines** · `L2053-2491` Stripe intent convergence · **`L2491-3336` `book()` — 830 lines** · `L3342-3728` `cancel()` + refund policy.
Seam: `L2053-2491` → `shared/paymentIntent.ts`, self-contained Stripe reconciliation with no coupling to quoting.

**`apps/crm/src/office/CustomerDetail.tsx` — 3492.** `L80-149` helpers · **`L150-2038` `CustomerDetail()` — 1888 lines** (10+ entity loads `L150-330`, payment card `L553`, portal access `L627`, plans `L718`, jobs `L838`, records `L1083-1278`, invoices `L1279-1490`, then 12 inline `<Sheet>` bodies `L1539-2006`) · `L2038-2546` four money sheets · `L2546-2827` reschedule/amend/recovery forms · `L2827-3116` packet + job forms · `L3116-3492` group picker, portal requests, callbacks.
Seam: `L2038-2546` → `office/customer/moneySheets.tsx`; already separate components, only prop-coupled.

**`amplify/functions/crm-admin/handler.ts` — 3351.** `L111-220` arg types · `L221-441` router · `L441-662` lifecycle/technician saves · `L662-1073` Cognito identity admin · `L1073-1113` `importAgreements` (unrelated) · `L1113-1364` group assignment + portal revoke · `L1364-1705` customer reactivate/contact · `L1705-2117` technician offboarding · **`L2117-3115` GL-14 staff role management** · `L3115-3241` `staffRoster` · `L3241-3351` suppression + suspect addresses.
Seam: `L2117-3241` → `crm-admin/staff.ts` — 1124 lines, already fenced by its own banner comment and already covered by `offboarding.test.ts`.

**`amplify/functions/daily-reminders/handler.ts` — 3010.** A cron dispatcher for ~30 unrelated sweeps. `L119-298` handler sequencing · `L298-811` eight state reconcilers · `L811-1190` five ops reports · `L1190-1430` staffing/dispatch · `L1430-1768` AR/dunning · `L1768-1943` `reconcileProcessingPayments` · `L1943-2407` seven GL-19 daily reconciliations · `L2407-2528` `retryQueuedEmails` · `L2528-3010` `reconcilePaidBookings` + four private loaders.
Seam: `L2528-3010` moves whole — nothing else calls those loaders. Next: `L1430-1768`.

**`amplify/functions/shared/bookingFinalize.ts` — 2831.** `L22-122` slot/route helpers · **`L122-188` agreement document marketing copy** (masthead, covered-pest grid — content, not logic) · `L188-648` `finalizeBooking` · `L648-761` retry/reclaim · `L761-1210` customer matching and conversion · **`L1210-2075` `finalizeClaimed()` — 865 lines** · `L2075-2595` comms claim + delivery · `L2595-2831` failure settlement.
Seam: `L2075-2595` → `shared/bookingComms.ts`, a distinct idempotency domain with its own lock. `L122-188` belongs in a content module.

**`apps/crm/src/tech/JobDetail.tsx` — 2011.** `L41-186` product-row model + helpers · `L205-751` `TechJob()` shell · `L751-801` label tables · `L801-895` `ScopePrepExits` · `L895-1046` `CallbackFindingCard` · `L1046-1183` `NoAccessCard` · **`L1183-1879` `ReportForm` — 696 lines** · `L1879-2011` `ProductRowEditor`.
Seam: `L1183-2011` plus the `L41-186` helpers they own → `tech/ReportForm.tsx`, ~1000 lines, leaving JobDetail as the job shell.

### 3.2 The rest, with their seams

| File | Lines | Distinct responsibilities | Clearest seam |
|---|---|---|---|
| `shared/visitChange.ts` | 1999 | types/invoice classification `L51-166`; preview `L166-405`; notify `L289-405`; `cancelVisit` + held-lock machine `L405-1058`; claim lifecycle `L1058-1296`; `resumeVisitChange` `L1296-1398`; `rescheduleVisit` `L1418-1999` | `L1058-1296` → shared claim module |
| `shared/pdf.ts` | 1596 | four unrelated renderers on a shared toolkit: primitives `L152-400`; agreement `L400-737`; quote helpers `L737-877`; quote `L877-1122`; service report `L1124-1413`; amendment `L1421-1596` | `L1124-1596` |
| `shared/capacity.ts` | 1533 | constants `L44-101`; tech eligibility `L101-370`; slot ledger `L370-660`; claim lifecycle `L651-916`; **routing/travel math `L916-1103`**; tour + reconcile `L1103-1533` | `L916-1191` → `shared/routing.ts` (pure geometry, no Dynamo semantics) |
| `crm-pricing/handler.ts` | 1532 | env/router `L58-134`; research wake `L134-270`; rollback `L270-421`; upload/drive `L421-469`; sheet→offer + reply composition `L469-654`; **`priceLead()` 838 lines `L654-1492`**; `extractQuoteIntent` `L1492-1532` | `L469-654` |
| `apps/web/src/pages/booking/QuotePage.tsx` | 1386 | sessionStorage codec `L44-141`; **`QuotePage()` 1140 lines `L142-1282`** (poll `:266`, wizard `:835`, three result sections); loading screen `L1282-1386` | wizard body `L817-1280` → `QuoteWizard.tsx` |
| `pricing-refresh/handler.ts` | 1334 | backoff `L74-127`; queue selection `L127-297`; **rate-ready customer email + PDF `L297-486`**; digest HTML `L578-747`; failure settle `L858-1012`; run summary `L1012-1334` | `L297-486` — customer-facing delivery inside a queue drainer |
| `shared/planCancellation.ts` | 1269 | preview `L48-243`; outcome union `L243-321`; settlement `L321-604`; held drive `L604-880`; cancel/repair/reclaim `L880-1065`; resume + confirmation `L1065-1269` | `L48-243` (read-only projection) |
| `crm-billing/handler.ts` | 1119 | args/actor/guards `L47-152`; router `L152-317`; setup intent + cross-Lambda `L317-410`; portal proxies `L401-410`; subscription ops `L410-529`; charging `L529-771`; **invoice ops `L771-1050`**; recovery owner `L1085-1119` | `L771-1050` → `crm-billing/invoices.ts` (already has `money.test.ts`) |
| `stripe-webhook/handler.ts` | 1090 | verify + router `L40-193`; funnel payments `L193-355`; subscription invoices `L355-744`; refunds/deletions `L744-952`; disputes `L952-1090` | `L952-1090` |
| `apps/crm/src/office/MarketRates.tsx` | 1063 | three unrelated admin panels: `EnginePanel` `L98-233`; list `L233-425`; `RateForm` 438 lines `L425-893`; `RollbackPanel` `L893-1063` | `L893-1063` and `L98-233` both lift cleanly |
| `apps/crm/src/office/Schedule.tsx` | 1062 | board + 5 mutations `L46-637`; `AvailabilityPanel` (own data, own `act()` at `L730`) `L637-1062` | `L637-1062` |
| `apps/web/src/pages/booking/BookPage.tsx` | 1060 | **`BookPage()` 886 lines `L47-933`**; `PaymentForm` `L933-1034`; shell `L1034-1060` | body is one function — needs extraction, not a move |
| `shared/marketRate.ts` | 1058 | config `L26-152`; price math `L152-257`; **catalog versioning/rollback `L257-444`**; cache read `L444-534`; notify queue `L496-643`; **LLM research `L643-1058`** | `L643-1058` → `shared/rateResearch.ts` |
| `shared/leadLifecycle.ts` | 1058 | constants `L33-75`; activity/recovery `L75-195`; `createLead` `L195-392`; outreach gating `L392-547`; **funnel ingress adapters `L547-679`**; disposition `L679-937`; ownership `L937-1058` | `L547-679` |
| `apps/crm/src/lib/api.ts` | 1008 | **largely cohesive** — one typed client facade: ~60 types interleaved with ~40 thin wrappers; `L958-1008` is generic result plumbing | split types from calls; no behavioural tangle |
| `shared/deactivation.ts` | 1001 | types `L60-121`; **`deactivateCustomer` 533 lines `L121-654`**; sweep `L654-829`; inventory `L829-918`; notice `L918-1001` | `L829-1001` |
| `amplify/backend.ts` | 966 | Cognito hardening `L56-136`; CAS lock IAM `L137-240`; Function URLs `L240-281`; **~340 lines of per-function env + IAM `L281-623`**; SES `L623-670`; booking URL `L670-695`; **alarms `L695-966`** | `L695-966` → `amplify/observability.ts` |
| `apps/crm/src/office/Dashboard.tsx` | 935 | aggregation `L129`; `drillRowsFor` `L308`; ten independent `<Card>` panels `L432-766`; drill panel `L798-935` | `L592-766` (the four exception queues) |
| `apps/crm/src/office/Work.tsx` | 842 | `WorkQueue()` 698 lines `L45-743`; **`PaymentsInFlight` `L743-842`** — different data, different purpose, only co-located | `L743-842` |
| `apps/crm/src/office/Staff.tsx` | 776 | roster `L93-221`; `AccessHistory` (own fetch) `L221-344`; badges `L344-374`; `StaffActions` `L374-671`; `InviteForm` `L671-776` | `L221-344` |
| `apps/crm/src/office/technicians.tsx` | 740 | roster `L54-170`; `LicenseRecords` (own entity, own mutations) `L170-362`; `TechForm` 378 lines `L362-740` | `L170-362` |
| `shared/subscription.ts` | 725 | Stripe ensure-ers `L32-152`; `startPlanBilling` `L152-291`; **queued-visit cancellation `L291-576`** (job/scheduling work in a Stripe module); `cancelPlanBilling` `L576-725` | `L291-576` |
| `shared/email.ts` | 597 | shell `L17-92`; MIME + send `L92-302`; resend/suppression `L302-402`; logging + **`openEmailFailureWork` `L402-479`** (reaches into the work-item domain from transport); ops notify `L479-597` | `L430-479` |
| `apps/crm/src/portal/AddService.tsx` | 515 | types + capability matrix + helpers `L27-128`; wizard `L132-515` | `L27-128` |

### 3.3 Big but cohesive — leave alone

- `shared/workPolicy.ts` (824) — `L123-796` is a single declarative `WORK_POLICY` table keyed by work kind; the size is data, not logic.
- `shared/atomicLock.ts` (552) — one DynamoDB conditional-write primitive plus its test double.
- `apps/web/src/lib/bookingApi.ts` (503) — ~25 request/response types dominate.
- `apps/web/src/pages/residential/Residential.tsx` (554), `services/Wildlife.tsx` (503), `services/HumaneRemoval.tsx` (501) — static marketing content, no branching logic.

### 3.4 Functions over 500 lines on their own

Not fixable by moving symbols between files:

| Function | Location | Lines |
|---|---|---|
| `CustomerDetail()` | `apps/crm/src/office/CustomerDetail.tsx:150-2038` | 1888 |
| `QuotePage()` | `apps/web/src/pages/booking/QuotePage.tsx:142-1282` | 1140 |
| `quote()` | `booking-public/handler.ts:1132-2053` | 920 |
| `BookPage()` | `apps/web/src/pages/booking/BookPage.tsx:47-933` | 886 |
| `finalizeClaimed()` | `shared/bookingFinalize.ts:1210-2075` | 865 |
| `book()` | `booking-public/handler.ts:2491-3336` | 845 |
| `priceLead()` | `crm-pricing/handler.ts:654-1492` | 838 |
| `ReportForm` | `apps/crm/src/tech/JobDetail.tsx:1183-1879` | 696 |
| `updateJobSchedule()` | `crm-docs/handler.ts:2464-3124` | 660 |
| `deactivateCustomer()` | `shared/deactivation.ts:121-654` | 533 |

### 3.5 Test files over 500 lines

20 files, largest first: `crm-docs/compliance.test.ts` 2248 · `crm-admin/offboarding.test.ts` 1932 · `booking-public/quote.test.ts` 1920 · `shared/bookingFinalize.test.ts` 1751 · `pricing-refresh/handler.test.ts` 1674 · `booking-public/book.test.ts` 1218 · `crm-pricing/handler.test.ts` 1165 · `shared/capacity.test.ts` 1107 · `shared/visitChange.test.ts` 1035 · `shared/marketRate.test.ts` 1035 · `shared/planCancellation.test.ts` 785 · `shared/subscription.test.ts` 781 · `shared/leadLifecycle.test.ts` 708 · `crm-billing/money.test.ts` 699 · `stripe-webhook/handler.test.ts` 647 · `shared/deactivation.test.ts` 639 · `shared/callbacks.test.ts` 551 · `booking-public/cancel.test.ts` 524 · `web/src/lib/bookingFunnel.test.ts` 516 · `daily-reminders/handler.test.ts` 503.

These are large by scenario count and `describe`-partitioned. The structural issue is the **mock/fixture preamble before the first `describe`**: 522 lines in `offboarding.test.ts`, 418 in `quote.test.ts`, 409 in `bookingFinalize.test.ts`, 404 in `pricing-refresh/handler.test.ts`, 322 in `book.test.ts`, 314 in `crm-pricing/handler.test.ts`, 301 in `deactivation.test.ts`, 279 in `visitChange.test.ts` — roughly 4,500 lines of scaffolding, much of it rebuilding the same fake Amplify data client and Stripe stubs. Seam: a shared `functions/shared/__fixtures__` module.

### 3.6 One duplicated pattern across the large files

The claim/lease lifecycle (reclaim orphan → write claim → release → sweep) is reimplemented in at least four places: `shared/visitChange.ts:1058-1296`, `shared/planCancellation.ts:1005-1065`, `shared/bookingFinalize.ts:709-761` and `:2075-2147`, `crm-docs/handler.ts:4082-4154`.

---

## 4. Type drift

**Structural cause.** ~100 custom operations in the schema declare `.returns(a.json())` (`resource.ts:2542`–`4012`). Every CRM↔Lambda RPC return is therefore untyped `AWSJSON`, unwrapped by a blind cast at `apps/crm/src/lib/api.ts:994-1008` (`opResult<T>` → `JSON.parse(data) as T`). Nothing in the type system connects a Lambda's return type to the CRM's declared shape for it, so every mirror in §4.2 is unchecked by construction.

### 4.1 `productsUsed` — `string` in the CRM, `number` on the wire (live crash) — **FIXED** `46049f4`

The type was not flipped: `ProductRow.amountValue` is a `string` on purpose — it is the text buffer of a controlled input, so a half-typed `"2."` stays renderable. The defect was the missing coercion at the parse boundary. `toAmountText` now runs on every row entering from the AWSJSON blob (`parseProducts`) and from a restored localStorage draft (`normalizeRow`, which the draft path reaches without passing through `parseProducts`). The amount codec moved to `crm/src/lib/productAmount.ts` so it is testable without importing the 2000-line component (8 tests). The finding as originally written:

| Declaration | Location | `amountValue` |
|---|---|---|
| Wire/server (canonical) | `shared/inventory.ts:15-31` | `amountValue?: number` |
| CRM tech UI | `apps/crm/src/tech/JobDetail.tsx:41-60` | `amountValue?: string` |

The writer coerces correctly (`JobDetail.tsx:1416` `Number(p.amountValue)`, written as a number at `:1431`). The reader does not: `parseProducts` (`:98-105`) blind-casts stored JSON to `ProductRow[]`, and `normalizeRow` (`:138`) passes the value through unchanged, so state holds a **number**. Three `.trim()` call sites then run on it: `:190`, `:1416`, `:1695`.

Reopening an existing draft service report that already has a structured amount and saving without touching the amount input reaches `p.amountValue?.trim()` on a number → `TypeError: ... .trim is not a function`. TypeScript cannot see it because `parseProducts` casts.

Also: `quantity`/`targetPest` are required in `ProductRow`, optional in `ReportProduct`. Four independent parsers of the same blob exist — `tech/JobDetail.tsx:98`, `office/ProductUsage.tsx:52`, `crm-docs/handler.ts:159`, consumed by `shared/pdf.ts:1143`.

### 4.2 CRM mirrors that drop server fields

**`PlanCancellationPreview`** — server `shared/planCancellation.ts:57-91` declares and populates `pendingMessage: string` (required, produced at `:239`); the CRM copy `apps/crm/src/lib/api.ts:389-411` stops at `saveOfferAvailable`. `components/CancelPlanSheet.tsx:92` renders `outcome.message` and never reads `preview.pendingMessage`. The server comment at `:87-89` states its purpose is precisely that the portal render it — the field is computed on every preview and is unreachable from the client.

**`CustomerCancelOutcome`** — server `planCancellation.ts:243-261` CANCELED variant has `stripeSubscriptionCanceled: boolean` (required) and `settled?: boolean`; CRM mirror `api.ts:422-433` has neither. `settled` is documented at `:253-255` as the flag a sweep must not ignore. Zero references to either in `apps/crm/src`.

**`VisitCancelOutcome.outcome`** — server `shared/visitChange.ts:405-422` is `"COMPLETE" | "PARTIAL" | "PENDING" | "FAILED"`; CRM mirror `api.ts:481-493` omits `"FAILED"`. It is documented at `visitChange.ts:415-419` as the conflicting-terminal-outcome case that a Finance case owns. No CRM call site currently compares against it, so today it falls to a default branch — live drift, currently silent.

The rest of these pairs are faithful: `VisitRescheduleOutcome` (`visitChange.ts:1398` vs `api.ts:530`), `VisitCancellationPolicy` (`cancellationPolicy.ts:21` vs `api.ts:446`), `VisitChangePreview` (`visitChange.ts:166` vs `api.ts:456`).

### 4.3 `Job.cancelDisposition` — a free-text column with three vocabularies

Schema `resource.ts:1678` types it `a.string()`; the comment at `:1674-1677` documents `REFUND_OWED | FEE_RETAINED | AWAIT_SETTLEMENT | NONE`.

- `shared/visitChange.ts:843-851` writes `"AWAIT_SETTLEMENT" | "REFUNDED" | "REFUND_OWED" | "FEE_RETAINED" | "NONE"` — **`"REFUNDED"` is not in the documented set.**
- `shared/subscription.ts:420-427` writes only the four documented values.
- `shared/planCancellation.ts:434-444` re-reads it via a local inline cast and branches only on `"FEE_RETAINED"`; everything else, including `"REFUNDED"`, falls into the not-settled path guarded by `paidRemainingCents`.
- The in-memory `Disposition` type at `visitChange.ts:279` is a third vocabulary — `"REFUND" | "FEE_RETAINED" | "NONE"` — mapped to the persisted form only inside the ternary at `:845-849`.

### 4.4 Enums re-declared as string unions

**`ServiceCode`** — schema `resource.ts:632-643` has 8 members; `shared/serviceCatalog.ts:39-49` has 10 (adds `COMMERCIAL_PEST`, `HOA_COMMON_AREA`); `apps/crm/src/portal/AddService.tsx:26-34` has the full 8; **`apps/web/src/lib/bookingApi.ts:54-61` has 6 — missing `MOSQUITO` and `MOSQUITO_TICK`.** Two casts keep it compiling: `bookingFunnel.ts:37` (`e.id as ServiceCode`) and `QuotePage.tsx:409` (`fields.service as ServiceCode`). `serviceCatalog.ts:268` marks `MOSQUITO_TICK` as `funnel: true`, so those codes are in `SERVICE_OPTIONS` at runtime and are sent as `service`. Runtime is correct only because `quoteFieldNeeds(service: string, …)` (`bookingFunnel.ts:84`) is widened to `string` and never narrows exhaustively.

**`ServiceFrequency` / cadence** — schema `resource.ts:79-87` has 4 including `SEMIANNUAL`. Funnel-side copies have 3: `bookingApi.ts:63`, `booking-public/handler.ts:515`, `shared/marketRateKeys.ts:24-29`. Office paths have all 4: `api.ts:161`, `components/LeadPanel.tsx:51,228`, `lib/planCadence.ts:22-27`, `shared/recurring.ts:26`, `shared/leadLifecycle.ts:770,789`. The schema comment at `:82-84` states the public funnel does not sell `SEMIANNUAL` — **intentional and correctly partitioned**. One consequence: `planPrefill(rate, cadence: PlanCadence)` (`apps/crm/src/lib/marketRates.ts:208-210`) cannot be called for a semiannual plan, so an office-created semiannual plan has no market-rate prefill path.

**Schema fields declared `a.string()` with an enum in the comment** — no generated union, no checking anywhere:
`resource.ts:333` `CustomerGroup.status` (while `CustomerStatus` exists at `:66`) · `:377` `Customer.propertyClass` and `:1702` `Job.propertyClass` (while the same concept is a real enum as `BookingRequest.propertyKind` at `:628`; the untyped form repeats in mutation args at `:2735`, `:3028`, and binds to a free-text CRM field at `components/CustomerForm.tsx:16`) · `:1234`, `:1261` `TechnicianLicense.status` · `:1420` `PortalRequest.status` (comment `// OPEN | RESOLVED` while `WorkStatus` exists at `:293`) · `:1444` `CallbackRequest.status` · saga `stage` fields at `:819, 859, 968, 1004, 1044` · `:2531` and `:2933` `roles: a.string().required().array()` — the whole role vocabulary is a bare string array on the wire.

### 4.5 Cross-boundary drift

| Boundary | Sender | Receiver | Status |
|---|---|---|---|
| CRM → AppSync → Lambda | hand-written arg objects in `apps/crm/src/lib/api.ts` | `event.arguments as unknown as {…}`, 14 sites | unchecked both ways |
| Lambda → AppSync → CRM | Lambda return, `.returns(a.json())` | `opResult<T>` cast, `api.ts:994` | unchecked both ways — root cause of §4.2 |
| Web → booking-public HTTP | `bookingApi.ts:65-108` | `booking-public/handler.ts:177-210` | deliberately asymmetric; server treats input as untrusted and sanitizes at `:227+` |
| Web → lead-intake HTTP | `leadIntakeApi.ts:49-61` | `lead-intake/handler.ts:29-59` | already diverged both directions |
| crm-billing → booking-public | `crm-billing/handler.ts:366-382` | `booking-public/handler.ts:309-320, 363` | three declarations, one payload |
| crm-docs → CRM tech app | `technicianReads.ts:63, 275` (`AnyRecord`) | `api.ts:220, 259` (full model types) | over-promised |

**Lead intake** — the client declares `first` and `formId` as required where the server has both optional, and the server additionally accepts `idempotencyKey`, `addr`, `city`, `state`, `zip`, `sqft`, `units`, `freq`, `company`, `specialtyService`, `specialtyPropertyType`, none declared client-side. Callers currently send only declared fields (`Contact.tsx:42`, `TalkToExpertModal.tsx:79`) — theoretical, but the two declarations have already diverged in both directions.

**`InternalOp`** — declared at `booking-public/handler.ts:309-320`; the sender re-declares the result inline at `crm-billing/handler.ts:366-382` as a hand-copy of `InternalResult`; the receiver reads it through `(event as unknown as { internalOp?: InternalOp })` at `:363`. `data` is `unknown` on both sides and gets a third independent declaration in the browser at `apps/crm/src/portal/AddService.tsx:103-118` (`decision: string` instead of the server's discriminated union).

**`TechnicianDay` / `TechnicianJobDetail`** — `technicianReads.ts:56-59` deletes `priceCents` and `paidPaymentIntentId` from every job and `:44-49` reduces Customer to the 11 fields in `CUSTOMER_VISIT_FIELDS`, while the CRM types (`api.ts:220-241`, `:259-281`) promise the full `Job` and `Customer` models. **Theoretical, not live** — `grep priceCents|paidPaymentIntentId` in `apps/crm/src/tech/` returns zero hits and all customer field reads (`tech/JobDetail.tsx:434,460,480,656`) are within `CUSTOMER_VISIT_FIELDS`.

**`Customer.documents`** — three independent parsers of one `a.json()` blob (`resource.ts:477`): writer `crm-docs/handler.ts:5703-5712` has `kind` and `uploadedAt` required; reader `components/CustomerDocuments.tsx:18-27` has both optional; `office/CustomerDetail.tsx:330-341` is an inline count-only `unknown` check. The optionality drift runs in the safe direction. `KINDS` is duplicated as a bare array at `CustomerDocuments.tsx:29` and `DOCUMENT_KINDS` at `crm-docs/handler.ts:5714-5720` — same 5 members today.

**`Attribution`** is declared four times, byte-identical in three: `web/src/lib/leadIntake.ts:13-22`, `lead-intake/handler.ts:18-27`, `shared/bookingFinalize.ts:841-850`, plus a derived form at `booking-public/handler.ts:213-225`. All eight keys agree.

### 4.6 Casts and escape hatches

| Pattern | Count (non-test, in scope) |
|---|---|
| `as any` | **0** |
| `@ts-ignore` / `@ts-expect-error` | **0** in production (one deliberate in `bookingFinalize.test.ts:962`) |
| `: any` annotation | **3** — `shared/bookingLink.ts:70`, `pricing-refresh/handler.ts:401`, `booking-public/handler.ts:963`, all `client: any` |
| `as unknown as` | **78** |

The 78 break down as:

- **≈40 (51%) benign** — `client.models as unknown as {…}`, reaching models absent from the generated `Schema` until a backend wave lands, or dodging Amplify's type-depth ceiling. `api.ts:183,516,647,677,700,844,877,918`; `portal/Requests.tsx:78`; `office/technicians.tsx:185`, `MarketRates.tsx:270`, `CustomerDetail.tsx:3188,3317`, `Schedule.tsx:677`; `crm-docs/handler.ts:759,1318`; `daily-reminders/handler.ts:2332,2420,2879`; `shared/bookingFinalize.ts:43,1262`, `lifecycleCommand.ts:83,150`, `assignVisit.ts:105`, `marketRate.ts:302,371`, `leadClaim.ts:19,68`, `capacity.ts:553,1478,1525`, `groupChange.ts:83,131,169,247`; `pricing-refresh/handler.ts:1202`; `crm-admin/handler.ts:1194`; `crm-pricing/handler.ts:286`; `booking-public/handler.ts:3186,3292`.
- **14 (18%) AppSync arg re-typing** — `event.arguments as unknown as {…}` asserts a shape AppSync does not guarantee, because the schema arg lists and these inline types are maintained separately: `crm-docs/handler.ts:416,440,459,482,494,499,515,616`; `crm-admin/handler.ts:245,251,410,415`; `crm-pricing/handler.ts:98`; `booking-public/handler.ts:363`.
- **≈24 (31%) row-shape assertions** — the ones that hide real mismatches: `daily-reminders/handler.ts:1797,2071,2111,2119,2805,2840`; `bookingFinalize.ts:247,258,291`; `crm-docs/handler.ts:1931,3149,5868`; `technicianReads.ts:307,409` (the erasure behind the over-promise above); `portal/Group.tsx:42`, `portalData.ts:41`; `leadLifecycle.ts:474`. Plus Stripe shape assertions: `stripe-webhook/handler.ts:391,424,675`; `daily-reminders/handler.ts:2037`; `crm-billing/handler.ts:514` (`"" as unknown as { behavior: "void" }`, deliberately lying to the Stripe SDK's types to clear a pause).

**Non-null `!` on cross-boundary data** (~30 total, most benign `Map.get(k)!` after a `has` check or DOM roots): `office/CustomerDetail.tsx:1586`; `BookPage.tsx:534,891` (both assert non-null on optional server response fields — `BookResponse.statusToken` at `bookingApi.ts:246` and `PricedQuote.statusToken` at `:163` are both optional); `shared/bookingFinalize.ts:1709`; `shared/agreementImport.ts:126-130`; `shared/compliance.ts:264`; `shared/leadLifecycle.ts:863-864`.

### 4.7 `a.json()` fields — producers and consumers

19 model fields plus ~100 operation returns/args.

**Correctly funnelled through one parser:** `quoteJson` (`resource.ts:675`) — `shared/quoteSnapshot.ts` is the sole reader/writer (`:95` parse, `:138` write), six consumers · `ratesJson` (`:1292`) — one `parseSheet` at `shared/marketRateKeys.ts:87` · `attribution` (`:672`) — one tolerant parser at `bookingFinalize.ts:854`.

**Parsed into different shapes at different call sites:**

- `productsUsed` (`:1938`, `:3565`) — four parsers, two target types (§4.1).
- `documents` (`:477`) — three parsers, two shapes (§4.5).
- `labelRulesJson` (`:1847`, `:2977`) — three independent reads: `office/ProductLog.tsx:149` (local shape), `tech/JobDetail.tsx:166` (inline cast), `crm-docs/handler.ts:2075` (`parseLabelRules`).
- `extracted` (`:1543`) — bare `as Extraction` + truthiness check at `crm-pricing/handler.ts:728-731`.
- `inventoryJson` (`:969`) — typed `unknown` at `lifecycleCommand.ts:50` but `string` at `:244`; written stringified at `deactivation.ts:337`, forwarded unparsed at `:256`, `:274`.
- `priceBreakdown` (`:1550`) — three producers with three line shapes (`thumbtack-webhook/handler.ts:327`, `booking-public/handler.ts:2017`, `crm-pricing/handler.ts:1387,1477`). No declared consumer type.

**The unstringified-write hazard is handled by convention, not by type.** `crm-docs/handler.ts:168-181` (`toAwsJson`) documents that an `a.json()` mutation *argument* arrives already parsed, so forwarding it into a model write is rejected by AppSync. Mirrored by explicit `JSON.stringify` at `tech/JobDetail.tsx:1404` and `office/ProductLog.tsx:250`, and by `asObject` at `crm-billing/handler.ts:385-396`. Nothing prevents a new write path from omitting it.

### 4.8 What is broken today

1. `apps/crm/src/tech/JobDetail.tsx:1416` (also `:190`, `:1695`) — `.trim()` on a number from `productsUsed`. Reproducible.
2. `apps/crm/src/lib/api.ts:389-411` — `pendingMessage` unreachable; the pending-cancel message the server computes cannot be rendered.
3. `apps/crm/src/lib/api.ts:481-493` — `"FAILED"` not representable; currently falls to a default branch.
4. `shared/visitChange.ts:846` — writes `"REFUNDED"` into `Job.cancelDisposition`, a value the schema's own documented vocabulary does not list and `subscription.ts:420-427` never produces.

Everything else in this section is a divergence the type system permits but that no current call site exercises.

---

## 5. Missing patterns

Only cases with 3+ copies, or 2 copies that already disagree. ⚠ marks a live divergence.

### 5.1 ⚠ `cadenceLabel(frequency)` — 9 encodings

Should be `shared/cadenceLabels.ts` (pure leaf, value-importable by both apps as `serviceCatalog.ts` already is). Contract: `RecurringFrequency → { short, sentence }`.

| Location | `BIMONTHLY` renders as | Handles `SEMIANNUAL`? |
|---|---|---|
| `apps/web/src/lib/bookingFunnel.ts:135` | `"Every 2 months"` | no |
| `apps/web/src/pages/booking/QuotePage.tsx:1086` | `"Every-2-months visits"` | no |
| `apps/crm/src/portal/AddService.tsx:402` | `"Every-2-months plan"` | no |
| `apps/crm/src/components/LeadPanel.tsx:233` | `"Every 2 months"` | no |
| `apps/crm/src/lib/marketRates.ts:53` | `"bi-monthly"` | no |
| `apps/crm/src/lib/planCadence.ts:24` | `"technician visits every 2 months"` | **yes** |
| `apps/crm/src/lib/billingDisclosure.ts:18` | `"A technician visits every 2 months — the charge is still monthly."` | no |
| `shared/pdf.ts:738-744` | `"Every 2 months"` (ternary chain) | no — falls through to the raw enum |
| `booking-public/handler.ts:546-550` | `"Every-2-months"` | no |

Two disagreements: hyphenation splits the customer's dropdown choice (`"Every-2-months plan"`) from the agreement PDF (`"Every 2 months"`); and `SEMIANNUAL` is a legal value (`api.ts:161`) that only `planCadence.ts:25` handles — `pdf.ts:744` prints the literal enum `SEMIANNUAL` on the agreement PDF, and `billingDisclosure.ts` returns `undefined`, dropping the visit sentence from the money-confirm sheet.

### 5.2 ~~Booking-path zip validation~~ — **FIXED** `46049f4`

The missing abstraction is now `shared/postalCode.ts`, consumed by `validateQuoteForm`, `booking-public/handler.ts` and `dispatchReadiness.ts`. It exports the shape rule and the territory rule as separate predicates, because the funnel and dispatch are asking different questions. See §1.7.

### 5.3 ⚠ `escapeHtml(s)` — 8 copies

Should move from `shared/receipts.ts:35` (already exported, nobody outside imports it) to `shared/html.ts`.

`shared/receipts.ts:35` (`escapeHtml`) · `shared/bookingPaymentFailure.ts:21` (`esc`) · `booking-public/handler.ts:3722` · `lead-intake/handler.ts:162` · `daily-reminders/handler.ts:3004` (`escapeHtmlLite`) · `thumbtack-webhook/handler.ts:422` · `pricing-refresh/handler.ts:587` (`esc`) · `crm-docs/handler.ts:5076-5080` (inline `.replace`, applied to `techFirst` only).

Bodies agree (`& < > "`, no `'`). The divergence is **coverage**: `crm-docs` escapes exactly one interpolated variable in that email; the other seven are module-level helpers callers may or may not reach for. Any new email path forks a ninth copy.

### 5.4 ⚠ `CRM_APP_URL` — one variable, two fallbacks

Should be `shared/appUrls.ts` exporting `crmAppUrl()` / `marketingUrl()` / `portalBillingUrl()`.

`?? ""` (emits a relative URL inside an HTML email): `lead-intake/handler.ts:319`, `pricing-refresh/handler.ts:693`, `:798`, `shared/portalProvision.ts:216`, `auth-challenge/verify.ts:98`.
`?? "https://app.pestbuzzkill.com"`: `crm-docs/handler.ts:153`, `shared/receipts.ts:25`.

If the variable is ever unset on a function, the first group emits `href="/customers/abc"` — a dead link in a staff email — while the second emits a working absolute URL. The two staff-facing emails that fail are the lead-intake notification and the pricing-refresh digest.

`MARKETING_URL` has the same shape across 9 sites (`thumbtack-webhook/autoQuote.ts:247`, `crm-docs/handler.ts:156`, `:5026`, `shared/bookingFinalize.ts:2193`, `:2444`, `shared/email.ts:38`, `shared/bookingPaymentFailure.ts:88`, `pricing-refresh/handler.ts:491`, `crm-pricing/handler.ts:70`) but all 9 agree.

### 5.5 Environment → URL derivation — 3 encodings, 9 bare app ids

`backend.ts:288-292` (CRM URL from `AWS_BRANCH`) · `backend.ts:534-537` (marketing URL from `branch`) · `apps/crm/src/lib/bookingLink.ts:16-37` (same decision from `window.location.hostname`, hardcoding both Amplify app ids). `backend.ts:549-551` re-encodes the split for `BOOKING_CORS_ORIGINS` and `apps/web/src/lib/portal.ts:12-14` for `PORTAL_URL`.

Two Amplify app ids appear as bare literals in 9 places: `backend.ts:204,369,537,549`, `booking-public/handler.ts:107`, `crm-pricing/handler.ts:388`, `pricing-refresh/handler.ts:131`, `crm/src/lib/bookingLink.ts:18,37`. They agree today; combined with §1.3's `getSecret` copies this is what makes the backend non-portable across AWS accounts.

### 5.6 ⚠ `prettyDate(isoDate)` — 6 encodings

Half-built already: `shared/recurring.ts:349` exports one and `crm-docs/handler.ts:53` imports it. Home should be `shared/dates.ts`.

| Location | Anchor + zone | Output |
|---|---|---|
| `shared/recurring.ts:341` (exported) | `T12:00:00Z`, UTC | `"Monday, July 21"` |
| `daily-reminders/handler.ts:112` (own copy) | `T12:00:00`, **no zone** | `"Monday, July 21"` |
| `shared/receipts.ts:27` (own copy) | `T12:00:00Z`, UTC | `"July 21, 2026"` |
| `thumbtack-webhook/autoQuote.ts:138` | `T12:00:00Z`, Eastern | `"Monday, Jul 21"` |
| `apps/crm/src/lib/format.ts:50` (`prettyWeekday`) | `T12:00:00` local | `"Monday, July 21"` |
| `apps/web/src/lib/bookingFunnel.ts:154` (`formatDay`) | local date parts | `"Mon, Jul 21"` |

The same visit date renders three ways: `"Monday, July 21"` in the reminder email, `"Monday, Jul 21"` in the Thumbtack auto-quote, `"July 21, 2026"` on the receipt.

### 5.7 ⚠ Service-area state gate — 2 copies that disagree

Should be `shared/serviceArea.ts` — `SERVED_STATES` + `isServedState(s)`.

- `crm-docs/handler.ts:1839` — `if (!new Set(["MA","RI"]).has(state))` — case-**sensitive**, rejects an empty state.
- `crm-pricing/handler.ts:798` — `if (extracted.state && !["MA","RI"].includes(extracted.state.toUpperCase()))` — case-**insensitive**, passes when `state` is falsy.

`crm-docs` rejects `"ma"` where `crm-pricing` accepts it; `crm-docs` rejects an empty state where `crm-pricing` lets it through. The same two-state footprint is encoded a third way at `apps/web/src/data/cities.ts:22-25` and a fourth as free text (`"MA • RI"`) at `components/QuoteCTA.tsx:58` and `pages/lp/LPCall.tsx:133`.

### 5.8 ⚠ Brand identity — phone in 4 formats, HQ address disagrees

Should be `shared/brand.ts` (pure leaf) consumed by web, CRM and Lambdas.

Structured copies that agree: `shared/bookingFinalize.ts:131-137` (`AGREEMENT_COMPANY`), `shared/pdf.ts:216-223` (`DEFAULT_COMPANY`, comment says it mirrors the former), `shared/email.ts:75-81`, `apps/web/src/components/SEO.tsx:139,167,277` (three JSON-LD blocks each repeating the full PostalAddress), `components/Footer.tsx:35-53`, `pages/PrivacyPolicy.tsx:190`, `pages/TermsOfService.tsx:154`.

Phone — 6 local constants in 4 display formats: `"508-258-9294"` at `components/TalkToExpertModal.tsx:6`, `pages/Contact.tsx:8`, `pages/booking/BookPage.tsx:38`; `"(508) 258-9294"` at `components/QuoteCTA.tsx:4`, `pages/booking/CancelPage.tsx:18`, `pages/booking/TrackPage.tsx:7`, `booking-public/handler.ts:3340`, `lead-intake/handler.ts:60`; `"+1-508-258-9294"` at `components/SEO.tsx:139`. Plus un-named literals at `components/QuoteCard.tsx:27,31`, `Header.tsx:149`, `Footer.tsx:41-42`, `ComingSoon.tsx:17`, `pages/services/HumaneRemoval.tsx:402-403`, `TermiteTreatment.tsx:380-381`, `Wildlife.tsx:331,335`, `pages/communities/CommonAreaProtection.tsx:179,447`, `ForUnitOwners.tsx:161,366`, `InUnitService.tsx:179`, `pages/Home.tsx:250`.

**HQ address disagrees outright:** `shared/driveTime.ts:14` — `HQ_ADDRESS = "81 Greenwich Rd, Ware, MA 01082"` against the letterhead `"420 Lakeside Ave, Suite 104, Marlborough, MA 01752"`. Drive-time and capacity math anchor on a different town from every customer-facing document. `driveTime.ts:9` labels it a legacy fallback, but it is still the fallback reached from `capacity.ts:4`.

Placeholder area codes also disagree: `bookingFunnel.ts:250` and `booking-public/handler.ts:1198` say `"e.g. (413) 555-0123"`; the field placeholder at `QuotePage.tsx:1148` says `"(508) 555-0123"`.

License `CC-0060592` appears at `pages/LicensedInsured.tsx:175`, `shared/bookingFinalize.ts:136`, `shared/pdf.ts:222`.

### 5.9 ⚠ Marketing final-CTA block — 26 copies

Should be `apps/web/src/components/ScheduleCTA.tsx` with props for eyebrow/title/sub/cta.

The `bk-schedule-section` block appears verbatim in 26 files: every `pages/services/*.tsx` (15), every `pages/communities/*.tsx` (4), `pages/residential/Residential.tsx`, `Home.tsx:367`, `Contact.tsx:216`, `PropertyManagers.tsx:354`, `Communities.tsx:425`, `ServiceAreas.tsx:248`, `LicensedInsured.tsx:241`.

Three user-visible wording splits:
- Eyebrow: `"Ready to Get BuzzKilled?"` ×16 vs `"Ready To Get BuzzKilled?"` ×3 (`PropertyManagers.tsx:357`, `communities/HOAResources.tsx:359`, `communities/ForUnitOwners.tsx:359`).
- Sub: `"…protect your property with BuzzKill."` ×13 vs `"…protect your home with BuzzKill."` ×1 (`residential/Residential.tsx:544`).
- CTA: `"Get My Instant Quote"` vs `"Get an Instant Quote"` vs `"Get Instant Quote"`.

### 5.10 ⚠ `reasonLabel(code)` — 5 copies + ~13 lowercase variants

Should be `apps/crm/src/lib/customerPresentation.ts`, which already holds the sibling `lifecycleActionTitle`.

Byte-identical bodies (`code.replace(/_/g," ").toLowerCase()` + capitalize first): `office/CustomerDetail.tsx:80-83` · `office/Staff.tsx:80-83` · `components/VisitCancelSheet.tsx:15-18` · `pages/VisitChangeHistory.tsx:31-34` · `lib/customerPresentation.ts:5-6` (inlined). `CustomerDetail.tsx:79` documents the duplication.

Lowercase-only variants without the capitalize step: `ui/kit.tsx:220`, `office/technicians.tsx:700`, `office/Dashboard.tsx:669`, `portal/Requests.tsx:386`, `office/CustomerDetail.tsx:909,1487,1577,3412`, `tech/JobDetail.tsx:535`, `components/VisitCancelSheet.tsx:125`, `shared/bookingFinalize.ts:1749,1817,1856,1857,2272`. The same reason code renders `"Customer request"` on one screen and `"customer request"` on another.

### 5.11 ⚠ `rateKey` — 1 builder, 3 hand parsers

Should be `parseRateKey(key)` beside the builder in `shared/marketRateKeys.ts`.

Builder: `shared/marketRate.ts:241-247` — `` `${service}#${areaKey}${bucket ? `#${bucket}` : ""}` ``.
Parsers: `apps/crm/src/lib/marketRates.ts:76` (`.split("#")[2]`) · `crm-pricing/handler.ts:205` (`.split("#")[2]`) · `pricing-refresh/handler.ts:582-583` (length-checked, `Number(parts[2])`).

All three assume `areaKey` contains no `#`, true only because `areaKeyFor` (`marketRateKeys.ts:111-113`) slugifies on `-`. The invariant is unstated and unenforced. `crm-pricing/handler.ts:134` additionally hand-parses `areaKey` back into `{city,state}` with no shared inverse of `areaKeyFor`.

Same unpaired shape for `` `${date}#${technicianId}` ``: built at `shared/capacity.ts:65`, `:74`, `:1446`; parsed at `:1410` (`const [, techId] = id.split("#")`).

### 5.12 `onsiteMinutesFor(propertyClass)` — the 60/30 rule, 3 copies

`shared/dispatchReadiness.ts:29-31` (the one `capacity.ts:79-81` delegates to) · `shared/serviceCatalog.ts:300-306` (`onsiteMinutesForClass`, **zero callers**) · `booking-public/handler.ts:1921` (inline ternary). All agree today. `serviceCatalog.ts:299` calls it "the LOCKED property-class rule", which is exactly the claim three copies cannot keep.

### 5.13 Seasonal-window sentence — 8 prose copies

`shared/bookingTerms.ts:35` already holds the approved sentence and `shared/season.ts:15` holds the month set, so the rule is centralised — the **wording** is not.

`QuotePage.tsx:671` (same sentence, commas instead of em dashes) · `QuotePage.tsx:1070` · `BookPage.tsx:729` · `portal/AddService.tsx:424` · `lib/planCadence.ts:40` · `crm-docs/handler.ts:2247,2626,2978` and `shared/visitChange.ts:1515` (same refusal message; three byte-identical, `:2247` differs) · `shared/bookingFinalize.ts:1814,2276,2283,2512`.

All agree on the rule; they disagree on wording and dash style across funnel, portal, PDF and email for one promise.

### 5.14 CSV export block — 4 copies

Should be `apps/crm/src/lib/csv.ts` — `toCsv(cols, rows)` + `downloadCsv(name, text)`.

`office/ProductUsage.tsx:125,149` · `office/Staff.tsx:270,275` · `pages/VisitChangeHistory.tsx:108,113` · `components/LeadPanel.tsx:438,443`. Identical `esc` + `Blob` + `createObjectURL` sequence. Copies agree; none escapes embedded newlines or emits a BOM.

### 5.15 Checked, no abstraction needed

Already centralised and consumed correctly: `shared/money.ts` (except §1.4), `shared/season.ts`, `shared/cancellationPolicy.ts` (the 72-hour rule is one constant), `shared/staffRoles.ts`, `shared/serviceCatalog.ts` labels, `shared/adminJobTypes.ts`, `shared/leadStage.ts`, `apps/web/src/data/cities.ts`, `apps/web/src/lib/portal.ts`.

Below threshold (2 copies that agree): `COST_PER_RESEARCH_USD = 0.35` (`pricing-refresh/handler.ts:96`, `office/MarketRates.tsx:84`); `onlyDigits` (`QuotePage.tsx:135`, `AddService.tsx:79`); `fmtQty` (`Inventory.tsx:34`, `ProductUsage.tsx:32`); social URLs (`Footer.tsx:57-73`, `SEO.tsx:150-153`); `SQFT_MIN`/`SQFT_MAX` 100/50000 (`bookingFunnel.ts:211-212` vs inline at `booking-public/handler.ts:1233,1238`).

---

## 6. Dead code

**Method.** Extracted 1039 exported symbols across 992 unique names, built a usage map with one bulk grep over all three trees, subtracted self-references, then classified remaining referrers as test vs non-test. Every "no external reference" hit was re-checked with an individual word-boundary grep, and in-file occurrence counts were used to separate *never referenced anywhere* from *export keyword is redundant but the symbol is live in its module*. Amplify entrypoints, React default exports in routers, and string-referenced entries were verified before exclusion — `auth-challenge/define.ts` and `create.ts` show as never-imported by path but are wired by string at `functions/auth-challenge/resource.ts:12,18`.

### 6.1 Fully dead — never referenced anywhere, including their own file (9)

| Symbol | file:line |
|---|---|
| `LEAD_OUTCOME_CODES_BY_CHANNEL` | `apps/crm/src/lib/api.ts:85` |
| `jsonField` | `apps/crm/src/lib/api.ts:958` |
| `getCustomOutput` | `apps/crm/src/lib/backend.ts:28` |
| `adaptFieldRoutesRows` | `shared/fieldRoutesImport.ts:163` |
| `bookingToProcessing` | `shared/bookingPayment.ts:148` |
| `bookingToBooked` | `shared/bookingPayment.ts:185` |
| `getBooking` | `shared/bookingPayment.ts:258` |
| `findStaffAccessEventByKey` | `shared/staffAccessLog.ts:107` |
| `invoiceAgingBucket` | `shared/recovery.ts:54` |

Plus `isStaff` / `STAFF_GROUPS` (`shared/authz.ts:95-99`) — see §2.3.

### 6.2 One whole dead module

`shared/fieldRoutesImport.ts` — 236 lines. No file anywhere imports it (`grep fieldRoutesImport` returns only the file itself). Its sibling `shared/agreementImport.ts` **is** imported by `crm-admin/handler.ts`, so this reads as a superseded migration adapter.

### 6.3 Test-only exports — 80, dead in production

Referenced outside their defining file solely by a `.test.ts`. By file: `web/src/lib/bookingFunnel.ts` 6 · `crm/src/lib/recovery.ts` 5 · `thumbtack-webhook/leadMapping.ts` 4 · `shared/marketRate.ts` 4 · `pricing-refresh/handler.ts` 4 · `daily-reminders/handler.ts` 4 · `crm/src/lib/workQueues.ts` 4 · `shared/serviceCatalog.ts` 3 · `shared/inventory.ts` 3 · `shared/atomicLock.ts` 3 · `crm/src/lib/reportDraft.ts` 3 · `crm/src/lib/marketRates.ts` 3 · `shared/units.ts`, `shared/capacity.ts`, `crm-pricing/handler.ts`, `booking-public/handler.ts`, `crm/lib/bookingLink.ts`, `crm/lib/billingDisclosure.ts` 2 each · 22 further files 1 each.

Six of these are deliberate test seams, not accidents: `_setLockStoreForTests` (`shared/atomicLock.ts:351`), `_resolveTableSuffix` (`:112`), `_classifyLockError` (`:334`), `_setS3ClientForTests` (`shared/photoVerify.ts:58`), `_resetBookingPublicNameCacheForTests` (`pricing-refresh/handler.ts:317`), and all of `shared/capacityTestFixture.ts:12`.

### 6.4 Export-redundant but live — 199, not removable

The symbol is used inside its own module; only the `export` keyword is surplus. Largest cluster is the reconciler set in `daily-reminders/handler.ts` (`:298, 349, 414, 518, 588, 640, 703, 771, 1768, 2002, 2089, 2305, 2407`), all called from the local `handler`. Also `trackEvent`/`GA_EVENTS` (`apps/web/src/lib/analytics.ts:49`, `:19`), wrapped by same-file helpers.

### 6.5 Routes

**Web (60 routes) — 2 genuinely orphaned:**

- `apps/web/src/App.tsx:150` `/residential/termite/treatment` — not in `apps/web/public/sitemap.xml`, not in the nav (`Header.tsx:93-96` lists only `/residential/termite` and `/residential/termite/wood-boring`). Its `/services/…` twin at `App.tsx:179` is sitemapped and self-links from `pages/services/TermiteTreatment.tsx:207,212`.
- `apps/web/src/App.tsx:153` `/residential/wildlife/humane-removal` — same pattern; `Header.tsx:101-103` lists only `/residential/wildlife`, and `/services/wildlife/humane-removal` (`App.tsx:184`) is sitemapped and self-linked from `pages/services/HumaneRemoval.tsx:223,228`.

Deep-link by design, not orphaned: `/lp/quote` (`:125`), `/lp/protect` (`:126`), `/lp/call` (`:127`, asserted in `lead-intake/handler.test.ts:218`), `/track/:token` (`:130`), `/request-quote` (`:211`, a legacy redirect). `/pest-control/:slug` (`:201`) is reachable via 55 concrete slugs in `sitemap.xml`.

**CRM (26 routes) — every route resolves.** `/welcome` (`apps/crm/src/App.tsx:60`) is a magic-link landing documented at `pages/Welcome.tsx:9-14`. `/work`, `/schedule` and the four `/portal/*` routes are linked from the tab bar inside `App.tsx:258-278`.

### 6.6 Orphaned components — 3, all in `apps/web/src/components`

| File | Export | Lines |
|---|---|---|
| `components/WhyUs.tsx:13` | `export default function WhyUs` | 29 |
| `components/NumberedSteps.tsx:15` | `export default function NumberedSteps` | 38 |
| `components/ServiceSection.tsx:13` | `export default function ServiceSection` | 53 |

Each carries a dead companion type (`WhyItem` at `WhyUs.tsx:3`, plus the two local `*Props`). No orphaned `.tsx` in `apps/crm/src`. `ComingSoon.tsx` looked orphaned but is live (`pages/AboutPage.tsx:1`, `pages/Reviews.tsx:1`, `pages/Careers.tsx:1`).

### 6.7 Commented-out code and markers

**None found.** An AWK scan for contiguous runs of 3+ commented lines scoring for code shape surfaced two candidates, both prose: `amplify/backend.ts:889-892` (GL-22 rationale) and `shared/workPolicy.ts:472-475` (a note inside the `STALE_DRAFT` policy). Inline `/* … */` occurrences are all short empty-catch annotations.

**Zero `TODO`, `FIXME`, `HACK`, `XXX` or `@deprecated` markers in scope.** (An initial `XXX` hit inside the base64 blob at `shared/logoAsset.ts:13` is a false positive.)

Suppression comments present: `eslint-disable-next-line react-hooks/exhaustive-deps` at `TalkToExpertModal.tsx:59`, `BookPage.tsx:243`, `QuotePage.tsx:337`, `office/CustomerDetail.tsx:294`, `components/ReportPhotos.tsx:30`, `portal/Requests.tsx:127`, `portal/AddService.tsx:163`, `lib/useAsync.ts:89`; `@typescript-eslint/no-explicit-any` at `shared/bookingLink.ts:69`, `pricing-refresh/handler.ts:400`, `booking-public/handler.ts:962`.

### 6.8 Feature flags and config

**No dead env flags.** All 36 distinct `process.env`/`import.meta.env` keys have a reader, and every `addEnvironment` write in `backend.ts` and the `resource.ts` files has a consumer. Verified individually for the flag-shaped ones: `OPS_EMAIL_MUTED` (`backend.ts:330,346` → `shared/email.ts:480`), `ALLOW_UNVERIFIED_ROUTES` (→ `shared/visitChange.ts:1615`, `shared/dispatchReadiness.ts:138`), `GOOGLE_REVIEW_URL` (`backend.ts:323` → `crm-docs/handler.ts:3996`), `BOOKING_CORS_ORIGINS` (`backend.ts:546` → `booking-public/handler.ts:156`), `RECONCILE_WINDOW_DAYS` (→ `daily-reminders/handler.ts:2012,2760`), `TURNSTILE_SECRET` (→ `booking-public/handler.ts:876`), `SES_CONFIGURATION_SET` (`backend.ts:666` → `shared/email.ts:220`), `AMPLIFY_DATA_API_ID_PARAM` (`backend.ts:237` → `shared/atomicLock.ts:123`, read via the Amplify generated `env` module rather than `process.env`). All five `VITE_*` client vars have readers.

Module-level constants that read as tunables but are exported-and-local-only: `BACKOFF_MAX_MS` (`pricing-refresh/handler.ts:88`), `DIGEST_UTC_HOUR` (`:114`), `FAILING_THRESHOLD` (`:99`), `CHECKOUT_CLAIM_MS` (`shared/capacity.ts:47`), `DRAIN_LEASE_MS`/`ROW_LEASE_MS`/`DRAIN_ID` (`shared/pricingControl.ts:45,48,41`), `PAYMENT_ATTEMPT_LEASE_MS` (`shared/bookingPayment.ts:38`), `BOOKING_LINK_TOKEN_TTL_MS` (`shared/bookingLink.ts:26`), `OPEN_HOUR`/`CLOSE_HOUR`/`BUSINESS_TZ` (`shared/businessHours.ts:15,16,14`), `WORK_SLA_MINUTES` (`shared/ownedWork.ts:13`), `SQFT_MIN`/`SQFT_MAX` (`bookingFunnel.ts:211,212`). The constant is used; the export is what is dead.

### 6.9 Not verified

- Symbols reachable only through dynamic string dispatch or GraphQL resolver wiring in `amplify/data/resource.ts` — the export scan is lexical.
- Values injected at deploy time (`amplify.yml`, Amplify Hosting console, SSM) — only the presence of a reader was confirmed, not that the value is set.
- Feature toggles expressed as data fields in `data/resource.ts` rather than env vars.

---

## 7. Defects surfaced while fixing, not by the scan

The scan found duplication. Converting it turned up four bugs the duplication
was hiding — recorded here because none of them is a consolidation task.

**7.1 `LeadPanel` idempotency keys never collapsed anything.** ✗ **FIXED** `15cce63`.
`clientActionId` (`apps/crm/src/lib/api.ts:112`) is `crypto.randomUUID()`, and it
is called inline at each click site — `components/LeadPanel.tsx:180, 259, 303,
322, 368, 397`. Every click therefore carried a *new* key, so the server-side
idempotency guard collapsed nothing and `disabled` was the only protection. Two
presses of "Add plan & convert" wrote two plans. The single-flight gate now stops
the second request; the keys themselves are still minted per click, which is
worth revisiting if any of these ops is ever retried.

**7.2 `Schedule.bump` had no `catch`.** ✗ **FIXED** `15cce63`.
`office/Schedule.tsx` reordered a route stop inside `try { … } finally {
setBusy(null) }` with no catch arm, so a failed `updateJobSchedule` REORDER was
an unhandled promise rejection: the spinner cleared, the board did not move, and
the office was told nothing.

**7.3 `LeadPanel.convert` could reject unhandled.** ✗ **FIXED** `15cce63`.
The shared `act()` helper rethrew after setting its error; five of six call sites
suppressed that with `.catch(() => undefined)` and `convert` did not.

**7.4 `PricingLog` outcome save never checks its result.** ✗ **OPEN**.
`office/PricingLog.tsx` calls `api().models.LeadPricingRun.update(...)` bare —
no `unwrap` (`lib/api.ts:978`), no `opResult` (`:994`). Amplify Data reports a
GraphQL failure in `res.errors` rather than throwing, so an authorization or
validation failure resolves normally: the sheet closes and the office believes
the outcome was recorded. Every other CRM mutation site unwraps. Left unfixed
deliberately — starting to surface those errors changes what the screen tells
the office, which is a product decision, not a refactor.

---

## Appendix — method and confidence

Seven independent read-only scans, one per dimension, run in parallel against
`4e20a4f` with `.claude/worktrees/**` excluded. `shared/inventory.ts` contains a
NUL byte that makes plain `grep` skip it; every scan that touched it used `grep -a`.

Counts stated as "N sites" come from scripted greps over the three source roots
excluding tests unless the text says otherwise; the counting method is recorded
inline where it materially affects the number.

Findings are marked **✗** only where a divergence produces a wrong result on a
path that exists today. Where a scan could not settle a question it is called out
in place rather than resolved by inference — the open ones are:

1. Whether Amplify's `secret()` can resolve to a shared/parent SSM value on a branch with no override (determines whether §1.3's missing live-key guard is reachable).
2. Whether all ~99 CAS `UNSUPPORTED` fallback branches are safe — sampled, not exhausted.
3. Whether `canActForCustomer`'s token-only `cus-` branch (§2.5) is a deliberate performance trade-off.
4. Whether a single rate can traverse both cents→dollars rounding rules in §1.4.
5. Whether the CRM's sort-capable screens (§1.8) share logic — sort was not audited.
