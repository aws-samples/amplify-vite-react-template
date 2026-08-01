# Codebase Inventory

Read-only audit. No code was changed. Paths are relative to the repo root.

Scope: `crm/src`, `crm/amplify`, `web/src` — 16,751 lines across 45 TS/TSX files plus Astro pages.

Ranking key: **blast radius** = how much breaks or silently misreports when the
pattern is wrong. **Frequency** = how often the inconsistency is hit or copied.
Ranked descending by the product of the two.

Resolved items are removed from the table and the remainder renumbered, so the
list always reads 1..N. Item numbers are therefore **positional and will
shift** — they identify a row in the current table, not a finding across time.
Cite a finding by name or section number if the reference needs to survive the
next pass. Canonical implementations for resolved findings live in
[PATTERNS.md](PATTERNS.md).

Resolved so far: filtered `.list()` without pagination
([PATTERNS.md §1](PATTERNS.md#1-paginated-list-reads)); Wave 0 shipping bugs
([PATTERNS.md §2–§6](PATTERNS.md)); Wave 1 authorization
([PATTERNS.md §7–§8](PATTERNS.md)).

---

## WAVE 3 STATUS — primitives exist, nothing is migrated

Twelve primitives are built and unit-tested (327 tests; Vitest is now set up
in `crm`). **No call site uses any of them yet** — Wave 4 migrates, one
primitive per commit, every call site or none. Until then each finding below
is still fully present in the code.

| Finding | Primitive | Location |
|---|---|---|
| [5.1](#51-async-resource-hook--8-occurrences) | `useAsyncResource` | `crm/src/lib/useAsyncResource.ts` |
| [1.6](#16-form-handling--validation) state | `useFormState` | `crm/src/lib/useFormState.ts` |
| [1.6](#16-form-handling--validation) validation | `validateDateRange`/`validateYear`/`validatePositiveInt`, `EMAIL_RE` | `crm/src/lib/client.ts` |
| [1.3](#13-tablelist-rendering) filter | `useTextFilter` + `<FilterInput>` | `crm/src/lib/useTextFilter.tsx` |
| [1.8](#18-toastsnotifications) | `<SaveStatus>` + `useSaveStatus` | `crm/src/components/SaveStatus.tsx` |
| [1.9](#19-modals--overlays) | `<Modal>`, `<ConfirmButton>` | `crm/src/components/` |
| [5.7](#57-badge--status-mapping-helper--5-maps--15-inline-ternaries) | `statusBadge`/`urgencyBadge`/`<Badge>` | `crm/src/lib/badges.tsx` |
| [5.3](#53-shared-entity-edit-form--5-occurrences) | `str`/`num`/`inputValue` | `crm/src/lib/formCodec.ts` |
| [5.8](#58-shared-open-quote-statuses-constant--4-occurrences) | `OPEN_QUOTE_STATUSES` + friends | `crm/src/lib/quoteStatus.ts` |
| [5.5](#55-s3-upload--record-update--7-occurrences-3-orderings) | `uploadFile`/`uploadAndLink`/`uploadDocument`/`downloadFile`/`deleteFile` | `crm/src/lib/storage.ts` |
| [1.7](#17-date--money--number-formatting) | `fmtDateTime`, `daysUntil` | `crm/src/lib/client.ts` |
| [5.9](#59-shared-constants-between-crm-and-web--4-values-duplicated) | `AGENCY` + `AGENCY_FMT` | `shared/agency.ts` |

### Wave 4 migration hazards found while building these

Each was discovered by reading the real call sites, and each will bite a
mechanical migration:

1. **`CoverageForm`'s local `str` is the read side, not the write side** — it
   is `inputValue`, not `str`. Migrating it to `str` silently inverts 12 seed
   calls.
2. **Removing the 5 redundant `.slice(0,10)` before `fmtDate` is a behavior
   change, not a cleanup.** `fmtDate` parses a datetime through `new Date` and
   renders the *local* day; the slice pins the *nominal* day. On a `createdAt`
   these differ west of UTC. The audit's "redundant" call was wrong.
3. **`AccountsList`'s search input will shift visually** on `<FilterInput>` —
   it is the one of three not already using `lic-search`, and it loses its
   border, radius, background, focus ring and 360px cap.
4. **`AccountDetail`'s stage pill changes text** `CLIENT` → `Client` when it
   adopts the shared badge table. Only user-visible text change in the batch.
5. **`Licensing` and `Onboarding` have two live `undefined`-vs-`null` bugs**
   (§4.4) that the coercion helpers do NOT cover — both are ternaries on a
   non-string condition spread into *both* create and update, so a demoted
   producer keeps a stale NPN forever. Needs a decision, not a swap.
6. **`MarketingTasks` cannot adopt `useAsyncResource` as-is** — its `load()`
   also *writes* (`settleSatisfiedTasks`), guarded by a `settledOnce` ref the
   caller's effect resets. The hook owns that effect. Change the guard to
   per-accountId inside the fetcher.
7. **`Celebration.tsx` should be dropped from the `<Modal>` migration list.**
   It is a self-dismissing toast, not a dialog; trapping focus in it would be
   worse than its missing Escape.
8. **`QuotesList` renders a flat grey badge for statuses `QuotesPanel`
   colour-codes** — an omission, not a decision. Both adopt the shared table.
9. **`Licensing`'s `result` string is rendered green in one branch and red in
   another** for the same value, keyed on pending-row count rather than on
   success. A clean migration shows up in error red.

---

## RANKED SUMMARY

| # | Finding | Blast radius | Frequency | Section |
|---|---|---|---|---|
| 1 | `signatures/*` storage is writable by every authenticated user; signatures are stamped onto issued certificates | High | 1 prefix | [1.5](#15-authpermission-checks) |
| 2 | `acord.ts` — 1,092 lines, 8 responsibilities | High | 1 file, all PDF output | [2](#2-file-size-offenders) |
| 3 | Error handling: `friendlyError` bypassed at 10 of 22 sites | Medium-high | 22 sites | [1.4](#14-error-handling) |
| 4 | Same entity re-fetched by up to 7 components independently | Medium | 7 models | [1.2](#12-state-management) |
| 5 | Sorting: 15 hand-rolled sorts vs 6 using `useSort` | Medium | 21 tables | [1.3](#13-tablelist-rendering) |
| 6 | Form state: 13 forms one-`useState`-per-field vs 5 object-based | Medium | 18 forms | [1.6](#16-form-handling--validation) |
| 7 | `as never` ×4 and `as` ×40 papering over enum/list-type mismatches | Medium | 44 casts | [4](#4-type-drift) |
| 8 | Date/money formatting bypassing the shared helpers | Medium | 24 sites | [1.7](#17-date--money--number-formatting) |
| 9 | Timezone split: UTC in Lambda, local in browser, on the same fields | Medium | 5 sites | [1.7](#17-date--money--number-formatting) |
| 10 | 18 remaining silent catches (the 6 hiding data loss are fixed) | Medium | 18 sites | [1.4](#14-error-handling) |
| 11 | Business rule "quote satisfies task" implemented twice (semantics now agree) | Medium | 2 impls | [5.12](#512-shared-business-rule-frontend--lambda) |
| 12 | No toast system — 6 success-feedback variants, 8 mutations with no feedback | Low-medium | 14 sites | [1.8](#18-toastsnotifications) |
| 13 | Confirm-destructive rebuilt 4× with 3 label sets; 2 destructive actions unguarded | Medium | 6 sites | [1.9](#19-modals--overlays) |
| 14 | 15 of 18 registered ACORD forms still have no field mapping (Generate is now disabled for them) | Low-medium | 15 forms | [3.5](#35-registered-but-unmapped-acord-forms) |
| 15 | 8 models still on the `allow.authenticated()` schema default | Low-medium | 8 models | [1.5](#15-authpermission-checks) |
| 16 | Dead schema fields and unused exports | Low | 21 symbols | [3](#3-dead-code) |

---

## 1. DUPLICATE IMPLEMENTATIONS

### 1.1 API/data fetching

**Pagination — resolved.** The 4 duplicate helpers and all 16 unpaginated filtered reads were consolidated onto `listAllPages` (`crm/src/lib/pagination.ts`, re-exported from `client.ts`). See [PATTERNS.md §1](PATTERNS.md#1-paginated-list-reads).

Two pieces of that finding were deliberately left open:

**Unfiltered `.list()` — 18 sites, same 100-row cap**

No filter compounding it, so these truncate rather than empty out, but they still silently cap: `Dashboard.tsx:43,44`, `AccountsList.tsx:29`, `PoliciesList.tsx:20,21,22`, `QuotesList.tsx:23,24,25`, `Carriers.tsx:22,23`, `AccountDetail.tsx:459,589`, `QuotesPanel.tsx:86`, `Team.tsx:46`, `Licensing.tsx:42,43,278`.

**Page size diverges across callers that set one**

`limit: 500` (`Dashboard.tsx:48`, `MarketingTasks.tsx:85`/`92`/`268`, `CarrierDetail.tsx:341`), `1000` (`extract-lead/handler.ts:219`), `200` (`renewal-tasks/handler.ts:58-66`), unset everywhere else — including all 16 newly-migrated sites, which now page at the default 100. On a filtered scan the filter is applied *after* the page is read, so a larger `limit` is fewer round trips.

**Live-read strategy — 3 implementations**

| Impl | Location |
|---|---|
| `observeQuery` subscription | `crm/src/components/DocumentsPanel.tsx:57` (sole instance) |
| `setInterval` 4s poll | `crm/src/components/ExtractionPanel.tsx:170` |
| Manual `refresh()` on user action | `QuotesPanel.tsx:71`, `AccountDetail.tsx:437`, `MarketingTasks.tsx:80`, `Licensing.tsx:40`, `Team.tsx:35`, `CarrierDetail.tsx:337` |

- Most used: manual refresh (6).
- Most correct for server-mutated status: `observeQuery` (`DocumentsPanel.tsx:57`) — server-pushed, no interval leak, no stale window.
- **Canonical: `observeQuery` for server-mutated status fields** (would replace the `ExtractionPanel.tsx:170` poller); manual `refresh()` only for user-initiated writes.

### 1.2 State management

**Server-data holder — 3 patterns**

- `useState` + manual `refresh()`: 16 sites — `QuotesPanel.tsx:64,71`, `AccountDetail.tsx:432,437`, `MarketingTasks.tsx:74,80` and `:260,264`, `Licensing.tsx:28,40`, `Team.tsx:16,35`, `CarrierDetail.tsx:332,337`, `Carriers.tsx:13,21`, `Dashboard.tsx:15-20,23`, `AccountsList.tsx:7,13`, `PoliciesList.tsx:14,19`, `QuotesList.tsx:16,22`, `PropertyPanel.tsx:320,328`, `FormsTab.tsx:22,28`, `App.tsx:62,65`.
- `useState` + optimistic local splice, never re-fetched: `PropertyPanel.tsx:352,362`, `Licensing.tsx:116,239-243`, `CarrierDetail.tsx:351,383-386`, `FormsTab.tsx:106`, `AccountDetail.tsx:457,613,645`, `MarketingTasks.tsx:127,140`, `Team.tsx:185-187`.
- `observeQuery`: `DocumentsPanel.tsx:57`.

**Same entity fetched independently by multiple components**

| Model | Distinct components | Sites |
|---|---|---|
| Carrier | 7 | `Dashboard.tsx:41`, `PoliciesList.tsx:22`, `QuotesList.tsx:25`, `Carriers.tsx:22`, `QuotesPanel.tsx:82`, `AccountDetail.tsx:449`, `AccountDetail.tsx:573` |
| Quote | 6 | `Dashboard.tsx:30`, `QuotesList.tsx:23`, `QuotesPanel.tsx:72`, `AccountDetail.tsx:367`, `FormsTab.tsx:70`, `MarketingTasks.tsx:90` |
| Policy | 6 | `Dashboard.tsx:40`, `AccountsList.tsx:21`, `PoliciesList.tsx:20`, `AccountDetail.tsx:438`, `AccountDetail.tsx:570`, `FormsTab.tsx:54` |
| Account | 4 | `Dashboard.tsx:24,27`, `AccountsList.tsx:15`, `PoliciesList.tsx:21`, `QuotesList.tsx:24` |
| Document | 4 | `DocumentsPanel.tsx:57`, `FormsTab.tsx:29`, `AccountDetail.tsx:372`, `DocumentSearch.tsx:29` |
| UserProfile | 3 | `App.tsx:66`, `Licensing.tsx:43`, `Team.tsx:46` |

Three Carrier fetches occur inside a single `AccountDetail` render (`QuotesPanel.tsx:82`, `AccountDetail.tsx:449`, `:573`), each sorting its own copy and rebuilding its own `carrierName` lookup (`QuotesPanel.tsx:93`, `AccountDetail.tsx:460`). Identical `useMemo(new Map(...))` at `PoliciesList.tsx:29` and `QuotesList.tsx:32`.

- Most correct: single fetch + prop-drill — `Carriers.tsx:22-23` → `:54`; `Licensing.tsx:41-44` → `:189,208,249`.
- **Canonical: hoist to the route component and prop-drill.**

### 1.3 Table/list rendering

**Sorting — 3 placements**

- `useSort` + `SortTh` (`crm/src/lib/useSort.tsx:10,49`) — 6 tables: `AccountsList.tsx:52`, `PoliciesList.tsx:35`, `QuotesList.tsx:39`, `Carriers.tsx:26`, `MarketingTasks.tsx:287`, `Licensing.tsx:450`.
- Sorted at fetch time inside `.then()`, not user-sortable, 5 of 6 mutating the array in place: `QuotesPanel.tsx:76,83`, `AccountDetail.tsx:442,450,568`, `PropertyPanel.tsx:331`, `FormsTab.tsx:36`, `DocumentSearch.tsx:40`, `DocumentsPanel.tsx:62` (only copying variant).
- Sorted inline in JSX: `MarketingTasks.tsx:186`, `Team.tsx:152`, `Dashboard.tsx:156,296`, `Licensing.tsx:472,938`.
- No sort: `CarrierDetail.tsx:414`, `Carriers.tsx:232`, `Settings.tsx:143`, `ExtractionPanel.tsx:132`, `Licensing.tsx:371`, `NewLead.tsx:245`, `FormsTab.tsx:137`, `MarketingTasks.tsx:223`.

- Most used: hand-rolled (15 sorts across ~17 non-`useSort` tables) vs 6 `useSort`.
- Most correct: `useSort` (`crm/src/lib/useSort.tsx:10`) — the only one with nulls-always-last (`:35-39`) and locale-aware compare (`:41`).
- **Canonical: `useSort` + `SortTh` for every `<table>` with a `<thead>`.**

**Nulls-first ordering — resolved.** Every hand-rolled sort was walked. Only
three were ascending on a `?? ""` fallback and therefore sorted missing values
first: `MarketingTasks.tsx:204` (`submitBy`), `PropertyPanel.tsx:336` (building
`label`), `Team.tsx:152` (`email`). All three now match `useSort`'s null-last
semantics. The remaining hand-rolled sorts are `createdAt`-descending, where
`?? ""` already lands nulls last — verified per site, left alone. See
[PATTERNS.md §2](PATTERNS.md#2-null-ordering-in-hand-rolled-sorts). (The
original audit cited `AccountDetail.tsx:442` as an ascending exemplar; it is
descending and was always correct.)

Direct conflict: `MarketingTask` is sorted by `useSort` at `MarketingTasks.tsx:287` and by inline `localeCompare` at `MarketingTasks.tsx:186` — same file.

**Search/filter — 3 copies of one predicate**

`AccountsList.tsx:41-48` / input `:80-85`; `MarketingTasks.tsx:277-284` / input `:308-314`; `Licensing.tsx:64-83` / input `:152-158`.

All three: `query.trim().toLowerCase()` → candidate field array → `.filter(Boolean).some(v => String(v).toLowerCase().includes(q))`.

- Most correct: `Licensing.tsx:64-83` — only memoized version, only one composing a second filter dimension.
- **Canonical: extract as `useTextFilter(items, fields)` + a shared `<FilterInput>` using the `lic-search` markup.**

**Empty states — 4 variants**

`<p className="muted small">` at 15 sites; `return null` at `MarketingTasks.tsx:148`, `Licensing.tsx:959`, `:337`; table-with-message-below at `Licensing.tsx:1025-1029`; sentinel-gated block at `DocumentSearch.tsx:100`, `PropertyPanel.tsx:417`.

**Loading states — 4 variants, 9 tables with none**

`loading` bool (`AccountsList.tsx:10`, `Licensing.tsx:30`, `App.tsx:63`); `loaded` bool (`MarketingTasks.tsx:75,261`, `AccountDetail.tsx:434`); null-sentinel (`Team.tsx:133`, `AccountDetail.tsx:65`, `CarrierDetail.tsx:23`, `Licensing.tsx:337`); none — empty state shown during load (`PoliciesList.tsx:55`, `QuotesList.tsx:68`, `Carriers.tsx:90`, `QuotesPanel.tsx:130`, `DocumentsPanel.tsx:188`, `PropertyPanel.tsx:417`, `CarrierDetail.tsx:397`, `FormsTab.tsx:162`, `Dashboard.tsx:57-73`).

- **Canonical: `!loaded ? Loading… : rows.length === 0 ? <empty> : <table>` per `AccountDetail.tsx:482-488`.**

### 1.4 Error handling

| Impl | Sites |
|---|---|
| `friendlyError` (`crm/src/lib/client.ts:176`) | 7 — `NewLead.tsx:72`, `AccountDetail.tsx:213,388`, `PropertyPanel.tsx:134,483`, `ExtractionPanel.tsx:212,263` |
| Raw `err instanceof Error ? err.message : "…"` | 15 — `CoverageForm.tsx:171`, `FilePreview.tsx:32`, `QuotesPanel.tsx:287`, `SignatureManager.tsx:63`, `Licensing.tsx:52`, `FormsTab.tsx:114`, `DocumentsPanel.tsx:104`, `Settings.tsx:94,107`, `AccountDetail.tsx:594,653`, `Onboarding.tsx:101`, `Team.tsx:43,73`, `DocumentSearch.tsx:43` |
| Raw `errors?.[0]?.message ?? "Save failed"` | 3 — `CarrierDetail.tsx:130,528`, `Licensing.tsx:775` |
| `console.warn`/`error` only, no UI | 4 — `MagicLinkSignIn.tsx:69,89`, `web/src/lib/crmLead.ts:64`, `QuoteApp.tsx:1384` |

Duplicated regex classification: `AccountDetail.tsx:655` `/Template fetch failed|NoSuchKey|403|404/` vs `FormsTab.tsx:116` `/Template fetch failed|403|404/` — same advice, two regexes, two message strings.

Three shapes of `errors?.length` handling coexist: throw (`CoverageForm.tsx:153,160,167`, `AccountDetail.tsx:385,586`, `ExtractionPanel.tsx:208,248`, `Team.tsx:39,64`, `Onboarding.tsx:81`); set-and-return (`NewLead.tsx:70`, `AccountDetail.tsx:212`, `PropertyPanel.tsx:133`, `CarrierDetail.tsx:129,527`, `Licensing.tsx:774`); **ignored entirely** (`PropertyPanel.tsx:343,476,492`, `Carriers.tsx:41`, `AccountDetail.tsx:456,600`, `QuotesPanel.tsx:89`, `MarketingTasks.tsx:54,120,133`, `SignatureManager.tsx:49,86`, `FormsTab.tsx:96`, `DocumentsPanel.tsx:91,121`).

- Most used: raw idiom (15 vs 7).
- Most correct: `friendlyError` — only one translating AppSync `Variable 'x' has an invalid value` and `Not Authorized`, and accepts `unknown` so it can't itself throw.
- **Canonical: `friendlyError` everywhere in `crm/src`; fold the template-missing regex into it.**

**Silent catches hiding data loss — resolved (6 of 24).** All six now surface
the failure through whatever channel their file already had. See
[PATTERNS.md §3](PATTERNS.md#3-a-catch-block-may-not-render-the-success-or-empty-state).

Remaining silent catches (18), none currently known to hide data loss: `MagicLinkSignIn.tsx:36`, `ExtractionPanel.tsx:142`, `DocumentsPanel.tsx:100,119,353`, `Licensing.tsx:325`, `SignatureManager.tsx:59,83`, `googlePlaces.tsx:84`, `Team.tsx:28`, `AccountDetail.tsx:378`, `PropertyPanel.tsx:480,491`, `acord.ts:423,452,565,578,602,605`, `QuoteApp.tsx:132,140,148,848,1182,1193`, `InstantAssessment.tsx:82`, `CoverageCalculator.tsx:182`, `crmLead.ts:62`. Line numbers predate the Wave 0 edits.

Two adjacent gaps found while fixing the six, deliberately left for a later
wave because neither renders as absent data: `AllMarketingTasks`
(`MarketingTasks.tsx:275-285`) has a `.then()` with no `.catch()`, so a failed
load sits on "Loading…" forever with an unhandled rejection; `stampSignature`'s
internal `catch { return false }` (`acord.ts:423`) is still silent, but its
`false` now reaches the user via `FillResult.unsigned`.

Unawaited CRM writes (`void submitCrmLead(...)`) — failures invisible: `AssociationLeadForm.tsx:45`, `InstantAssessment.tsx:99`, `ContactForm.tsx:17`, `CoverageCalculator.tsx:226`.

### 1.5 Auth/permission checks

**Resolved in Wave 1** ([PATTERNS.md §7](PATTERNS.md#7-authorization-derives-from-the-cognito-group-never-a-database-row),
[§8](PATTERNS.md#8-per-model-authorization-and-what-lambdas-actually-bypass)).

The two unsynchronized authorities are gone. Every UI gate now reads
`cognito:groups` off the ID token via `crm/src/lib/auth.ts`; `UserProfile.role`
is written from the user's actual group and gates nothing. ADMIN is no longer
selectable at onboarding — the picker is read-only. `UserProfile`, `License`,
`Certificate` and `Policy` carry per-model `.authorization()`, with
`UserProfile` writes owner-scoped on `userId`. `DeleteLeadZone` is admin-only.
Five error sites that will now deny were moved to `friendlyError`.

**Still open:**

1. **`signatures/*` is writable by any authenticated user** — see summary row 1.
   The path is `signatures/{UserProfile.id}.{ext}`, a predictable key on an id
   every signed-in user can list. Not fixable in place: Amplify's `{entity_id}`
   token substitutes the Cognito *identity-pool* id, and `signatures/*` cannot
   coexist with `signatures/{entity_id}/*`. Needs an `identityId` on
   `UserProfile`, a new prefix, a backfill of existing keys, and a retargeted
   `SignatureManager`. Reasoning recorded at `crm/amplify/storage/resource.ts:42`.
2. **8 models remain on the schema-level `allow.authenticated()` default** —
   `Account`, `Building`, `Quote`, `Carrier`, `AppetiteGuide`, `Document`,
   `MarketingTask`, `ProducerLicense`. Notably a non-admin can still
   cascade-delete a lead through the API; Wave 1 removed the button, not the
   ability.
3. **`startLeadExtraction` and `reserveCertificateNumber` are
   `allow.authenticated()`** (`resource.ts:535`, `:545`) — any signed-in user
   can burn certificate sequence numbers from a gap-free ledger, or trigger
   paid Anthropic extraction calls.
4. **`leadIntake` has IAM access to the whole API.** `allow.resource()` grants
   are API-wide, not model-scoped, and it is reachable via the public-API-key
   `submitWebLead`. Only its handler code confines it to creating leads.
5. **No in-app way to change a group after invite.** `inviteUser` sets the group
   only at `AdminCreateUser` time, and the Lambda's IAM policy has no
   `AdminRemoveUserFromGroup`. Role changes are an AWS console job. The
   originally-planned `teamAdmin`-writes-role work was not needed to close the
   escalation path and is deferred with this.
6. `UserProfile.role` is owner-writable, so a user can still set their own to
   `"ADMIN"`. Nothing reads it for authorization, so this is cosmetic drift —
   but it will mislead anyone reading the row.

**Unverified.** No rule in Wave 1b is exercised by anything — there are no tests,
and `tsc` covers `amplify/data/resource.ts` only (via the `Schema` import in
`client.ts`), not storage, `backend.ts`, or any handler. First real check is a
deployed sandbox.

### 1.6 Form handling + validation

**State patterns**

| Pattern | Count | Sites |
|---|---|---|
| Single `form` object + curried `set(k)` typed `(e: {target:{value:string}})` | 4 | `NewLead.tsx:13`/`:33`, `AccountDetail.tsx:145`/`:172`, `CarrierDetail.tsx:53`/`:79`, `Licensing.tsx:706`/`:725` |
| Single `form` object + generically-typed `setF(k, v)` | 1 | `PropertyPanel.tsx:49`/`:72` |
| One `useState` per field | 13 | `CoverageForm.tsx:64-97` (**23 hooks**), `AccountDetail.tsx:554-562`, `CarrierDetail.tsx:482-495`, `PropertyPanel.tsx:321-326`, `Onboarding.tsx:34-40`, `Carriers.tsx:16-18`, `Team.tsx:18-19`, `MagicLinkSignIn.tsx:15`, `DocumentSearch.tsx:13`, `ContactForm.tsx:7-11`, `AssociationLeadForm.tsx:21-30`, `InstantAssessment.tsx:43-51`, `CoverageCalculator.tsx:127-140` |
| Step-machine + localStorage | 1 | `QuoteApp.tsx:1238-1254` |

- Most used: one-`useState`-per-field (13).
- Most correct: `PropertyPanel.tsx:72` `setF` — the only generically-typed setter (`<K extends keyof typeof form>`), so it handles booleans as well as text and resets `saved` in one place. The curried variants force bespoke closures: `CarrierDetail.tsx:149,218,229,280,290` (five), `Licensing.tsx:719` (hoists `loa` separately).
- **Canonical: extract `PropertyPanel.tsx:72`'s shape as `useFormState<T>(initial)` returning `{form, setF, dirty, saved}`. Highest-value migration: `CoverageForm.tsx:64-97`, 23 hooks → 1.**

**Validation**

- Shared: `validateAccountFields` (`crm/src/lib/client.ts:140`) — 3 call sites: `NewLead.tsx:41`, `AccountDetail.tsx:178`, `PropertyPanel.tsx:84`.
- Ad-hoc `problems: string[]`: `CarrierDetail.tsx:499-509`.
- Ad-hoc single-guard-and-return: `NewLead.tsx:37`, `CoverageForm.tsx:114`, `Licensing.tsx:731,735,739`, `Onboarding.tsx:52,56,60`, `PropertyPanel.tsx:77,89-100,101`, `PropertyPanel.tsx:336`, `SignatureManager.tsx:71`.
- Separate validator in `web`: `QuoteApp.tsx:326` `validateText`, returns `string | null`.
- **No JS validation at all** (HTML5 only): `ContactForm.tsx:15`, `AssociationLeadForm.tsx:38`, `InstantAssessment.tsx:95-96`, `CoverageCalculator.tsx:224` (no email-shape check).

Duplicated rules:
- Email regex — `client.ts:149` `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` vs `QuoteApp.tsx:324` `/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/`
- Year range — `client.ts:161-166` (1600..+5) vs `PropertyPanel.tsx:77-81` (1600..+1); `PropertyPanel.save()` runs both against different fields
- Effective ≤ expiration — `CoverageForm.tsx:114` and `Licensing.tsx:739`, identical message

- **Canonical: extend `client.ts` with `validateDateRange`/`validateYear`/`validatePositiveInt` returning `string[]`; export the email regex for `web/src/lib/crmLead.ts`.**

**Reset**

Field-by-field setter cascades: `AccountDetail.tsx:615-618`, `PropertyPanel.tsx:353-356`, `ContactForm.tsx:43-46`, `CoverageCalculator.tsx:275`. Remount-by-`key` (correct): `CoverageForm` via `QuotesPanel.tsx:113` / `AccountDetail.tsx:469`; `GuideForm` via `CarrierDetail.tsx:379`.

### 1.7 Date / money / number formatting

Canonical helpers: `fmtDate` `client.ts:132`, `fmtMoney` `:127`, `fmtNum` `:122`, `daysUntilDate` `:72`.

**Dates bypassing `fmtDate`**

- `crm/src/lib/acord.ts:85-86` `fmtUs` — exact duplicate of `fmtDate` except the null case returns `""` not `"—"`. 13 call sites: `acord.ts:243,250,326,334,352,356,381,385,774,821,822,853,857`.
- `acord.ts:98`, `:748` — inline `new Date().toLocaleDateString("en-US")`
- `FormsTab.tsx:179` — `toLocaleString`, the only date+time render; no shared `fmtDateTime`
- `QuoteApp.tsx:584` — `web` has no date helper at all

**Money/numbers bypassing `fmtMoney`/`fmtNum`**

- `acord.ts:256-257` `amt` — local re-implementation of `fmtNum` with rounding
- `acord.ts:397` — inlines `amt`'s body rather than calling it, 6 lines away
- `acord.ts:849` — `.toFixed(2)`
- `PropertyPanel.tsx:373`, `:431`, `ExtractionPanel.tsx:384` — `toLocaleString()` **without `"en-US"`**, so these render per browser locale unlike `fmtNum`

**"Days until" — 3 implementations**

| Impl | Today origin |
|---|---|
| `client.ts:72-77` `daysUntilDate` | local midnight via `toDateString()` |
| `Dashboard.tsx:108-112` `daysUntil` | local midnight via `setHours` |
| `renewal-tasks/handler.ts:44-49` `isoDay`/`addDays` | UTC |

`Dashboard.tsx:108` is a behavioural clone of `daysUntilDate` (same divisor, same `Math.round`) in a file already importing from `client.ts` at `:5-7`. Used at `:139`, `:150`.

**Inline day math** — `acord.ts:784-790` (add one year), `Dashboard.tsx:259-260` (minus one year), `Dashboard.tsx:256` (hand-built ISO day), `handler.ts:189-190`.

**Ad-hoc ISO-day stamping** — `Dashboard.tsx:251`, `FormsTab.tsx:87`, `acord.ts:788`, `handler.ts:44`.

**Timezone inconsistencies**

- Local `"T00:00:00"` (`client.ts:74`, `acord.ts:86,786`, `Dashboard.tsx:111`) vs UTC `"T00:00:00Z"` (`handler.ts:46`) on the same fields. Lambda-computed `submitBy`/`triggerDate` are produced on a UTC calendar and consumed by `daysUntilDate` on a local one.
- `Dashboard.tsx:250-251,257,262` and `FormsTab.tsx:87` — local `new Date()` serialized via `.toISOString()`; east of UTC−0 after 20:00 local, "today" resolves to tomorrow.
- `acord.ts:786-788` — parses local, re-serializes UTC; west of UTC this shifts the ACORD 125 proposed expiration back a day.
- Two spellings of local midnight: `client.ts:75` vs `Dashboard.tsx:109-110`.

**Redundant `.slice(0,10)` before `fmtDate`** (which already branches on length at `client.ts:134`): `MarketingTasks.tsx:236`, `AccountDetail.tsx:80`, `:781`, `Team.tsx:192`, `DocumentSearch.tsx:131`.

### 1.8 Toasts / notifications

No toast system. Six variants, five of which hand-duplicate the same inline `<span className="small" style={{color:"var(--green)"}}>`:

1. `saved` bool → green span — `AccountDetail.tsx:169`/`:346`, `PropertyPanel.tsx:69`/`:312`, `CarrierDetail.tsx:76`/`:324` (**7 manual `setSaved(false)` clears**: `:82,87,150,219,230,281,291`)
2. `notice` string, never auto-cleared — `Team.tsx:21`/`:117`
3. `applied` bool, different copy — `ExtractionPanel.tsx:160`/`:404`
4. amber `note`/`genNote` for partial success — `FormsTab.tsx:24`/`:156`, `AccountDetail.tsx:560`/`:753`
5. `result` string rendered **green at `Licensing.tsx:342` and red at `:397` for the same value**
6. Full-screen replacement — `ContactForm.tsx:74`, `AssociationLeadForm.tsx:102`, `InstantAssessment.tsx:146`, `CoverageCalculator.tsx:133`, `Celebration.tsx:112`, `QuoteApp.tsx:1254`

No feedback at all after a successful mutation: `PropertyPanel.tsx:335,360`, `Carriers.tsx:38`, `QuotesPanel.tsx:88`, `AccountDetail.tsx:455`, `MarketingTasks.tsx:118,131`, `SignatureManager.tsx:79`, `DocumentsPanel.tsx:117`.

- **Canonical: `<SaveStatus state={"idle"|"saving"|"saved"|"warning"|"error"}/>` + `useSaveStatus()` whose `markDirty()` is wired into the form setter.**

### 1.9 Modals / overlays

- True modal with backdrop + Escape: `FilePreview.tsx:46` (Escape `:36`, stopPropagation `:47`) — 5 call sites: `AccountDetail.tsx:819`, `PropertyPanel.tsx:519`, `DocumentsPanel.tsx:265`, `FormsTab.tsx:195`, `DocumentSearch.tsx:151`
- Second overlay, separate implementation, **no Escape**: `Celebration.tsx:112`
- Fixed tooltip: `Dashboard.tsx:371`
- Native `window.confirm`: `QuoteApp.tsx:1258` (only blocking confirm in the repo)
- Inline expanding row: `Licensing.tsx:678-688` (computed colSpan `:485`), `Settings.tsx:217-234` (hardcoded `colSpan={3}`), `DocumentsPanel.tsx:272` (below the table, not a row)
- Inline expanding panel: `ExtractionPanel.tsx:308-316`, `Licensing.tsx:985-990`
- Show-a-form toggle, 4 sites: `Carriers.tsx:58`, `CarrierDetail.tsx:366`, `QuotesPanel.tsx:100`, `AccountDetail.tsx:685`

**Confirm-destructive — 4 hand-rolled, 3 label sets**

| Site | Labels |
|---|---|
| `CarrierDetail.tsx:444-457` | Confirm / Cancel |
| `Licensing.tsx:661-674` | Confirm / Cancel (4 props threaded, `:499-505`) |
| `DocumentsPanel.tsx:241-254` | **Confirm delete / Keep** |
| `AccountDetail.tsx:396-425` | Yes, delete this lead / Cancel (+ `deleting` busy state the others lack) |

**Unguarded destructive actions:** `PropertyPanel.tsx:433` (deletes a Building outright; `del()` at `:360` also ignores errors), `PropertyPanel.tsx:489-497` (deletes S3 photo and nulls the field with no prompt).

- Most correct: `FilePreview.tsx:16` — only overlay with Escape, backdrop dismissal, stopPropagation, loading, error, and download fallback.
- **Canonical: generalize `FilePreview`'s shell into `<Modal onClose>`; extract `<ConfirmButton>` and apply at all four sites plus the two unguarded ones.**

---

## 2. FILE SIZE OFFENDERS

Files over 500 lines.

| Lines | File | Distinct responsibilities |
|---|---|---|
| 1,634 | `web/src/components/QuoteApp.tsx` | Step-machine wizard engine; question schema; validation (`:324-326`); localStorage persistence (`:112-148`); theme mode; agent assignment; FormSubmit email post; CRM lead mapping (`:633-681`); Google Ads conversion; confetti; results rendering |
| 1,092 | `crm/src/lib/acord.ts` | Template registry (`:30-75`); ACORD 25 mapping (`:89`); shared eForm header (`:745-779`); ACORD 125 mapping (`:781`); ACORD 140 mapping (`:1016`); date helper `fmtUs` (`:85`); money helper `amt` (`:256`); operations-summary prose generator (`:670`); signature stamping (`:409-460`); signature lookup (`:487`); S3 template fetch (`:512`); field-fill engine + NeedAppearances fallback (`:537-610`) |
| 1,048 | `crm/src/components/Licensing.tsx` | Data load (`:40`); text+attention filter (`:64-83`); summary stats (`:86-100`); legacy `ProducerLicense` backfill (`:263-347`); license table + grouping + collapse (`:428-700`); license create/edit form (`:695-930`); state-coverage matrix (`:935-1032`) |
| 850 | `crm/src/pages/AccountDetail.tsx` | Tab routing (`:37-45`); celebration trigger (`:60-70`); Overview form (`:141-350`); `DeleteLeadZone` cascade delete (`:357-428`); PoliciesTab (`:430-540`); CertificatesTab incl. COI generation (`:545-825`) |
| 633 | `crm/src/pages/CarrierDetail.tsx` | Carrier detail form (`:45-330`); appetite guide list + delete confirm (`:308-470`); appetite guide create/edit form (`:475-630`) |
| 608 | `crm/src/components/PropertyPanel.tsx` | Property form (`:40-300`); buildings CRUD (`:309-450`); photo upload/preview/delete ×3 (`:455-530`) |
| 505 | `crm/amplify/data/resource.ts` | 12 models + 15 enums + 6 custom operations + authorization |

---

## 3. DEAD CODE

### 3.1 Exported symbols — resolved

All 16 verified-unused exports were demoted to file-local (the `export` keyword
dropped; every symbol has same-file uses, so none was deleted). `CrmLeadInput`
was **not** demoted — the audit row was stale, `QuoteApp.tsx` imports it as of
Wave 0. See [PATTERNS.md §9](PATTERNS.md#9-export-means-another-file-imports-it).

Thinnest live export: `fmtNum` (`client.ts`), sole call site `AccountsList.tsx`.

### 3.2 Orphaned components — none

Every file in `crm/src/components` and `web/src/components` is imported. Specifically verified: `FormsTab.tsx` reachable via `AccountDetail.tsx`; `Celebration.tsx` reachable via `AccountDetail.tsx`.

### 3.3 Dead schema fields — resolved

Removed from `crm/amplify/data/resource.ts`: `Account.producerId`,
`Quote.submittedAt`, `Policy.limits`. Removed from `Team.tsx`'s `TeamUser`
interface: `status`, `enabled` (the `teamAdmin` Lambda still returns both).

**`Account.buildiumId` was kept deliberately.** It is write-only, not dead —
`lead-intake/handler.ts:73` sets it and nothing reads it back — but it is the
only link from an account to its Buildium property record, and removing it
would change Lambda behavior. Documented at the field.

`ProducerLicense` was kept: read-only, but the read is live, feeding the
one-way `LegacyBackfill` in `Licensing.tsx`.

Note this removes the last candidate ownership anchor from the data model —
relevant if per-producer authorization scoping is ever revisited
([1.5](#15-authpermission-checks)).

### 3.4 Routes

All routes in `crm/src/App.tsx:236-248` resolve. `/quotes` and `/policies` (`:244-245`) are absent from `NAV_ITEMS` (`:188-196`) but reachable from `Dashboard.tsx:62`, `:67`. `Team.tsx` and `Onboarding.tsx` are page-shaped with no route by design (`Settings.tsx:62`; `App.tsx:78`).

No TODO/FIXME/XXX/HACK markers and no commented-out code blocks in scope.

### 3.5 Registered-but-unmapped ACORD forms

`buildAppFormValues` (`crm/src/lib/acord.ts:709`) has three `formKey` branches: `acord125` (`:781`), `acord126` (`:1011` — **empty, comment only**), `acord140` (`:1016`). `acord25` never reaches this function (excluded at `FormsTab.tsx:8`; served by `buildAcord25Values` at `:89`).

**15 of 18 registry entries receive only the shared header.** `acord126`, `acord131`, `acord141`, `acord159`, `acord160`, `acord810`, `acord823`, `acord45`, `acord101`, `acord24`, `acord27`, `acord28`, `acord35`, `acord36`, `acord75`.

Mapped: `acord125`, `acord140` (both via `buildAppFormValues`), `acord25` (via `buildAcord25Values`).

**Live Generate button — resolved.** `MAPPED_APP_FORM_KEYS` (`crm/src/lib/acord.ts:719`) is the single source of truth; `FormsTab.tsx` disables Generate for anything outside it and says why. See [PATTERNS.md §5](PATTERNS.md#5-a-generate-button-is-gated-on-a-mapping-existing). The 15 mappings themselves remain unwritten — a feature gap, no longer a way to emit a blank form.

### 3.6 Redundant code inside the one real mapping — resolved

The 15-key no-op overwrite in the `acord125` branch is deleted (all 15 verified
value-identical first; four were spelled as locals rather than inline
expressions, so a textual diff would not have shown it). ACORD 25's
`producerContact` now uses `AGENCY.contactName` like the shared header, so the
COI prints the contact person and not the LLC in the CONTACT NAME slot.

**Still open:** the `acord125` branch sets `proposedEffective` targeting the
same PDF field (`Policy_EffectiveDate_A`) with the same value as the header's
`policyEffective` — a duplicate write under a different logical key, not a
re-assignment.

---

## 4. TYPE DRIFT

### 4.1 Same entity typed more than one way

| # | Entity | Typings |
|---|---|---|
| 1 | `TeamUser` | `Team.tsx:5-12` all six fields required vs producer `team-admin/handler.ts:115-122` yielding `undefined` for four (`:116,117,118,121`). Transport is `a.json()` (`resource.ts:459`), so the mismatch is invisible; reconciled by unchecked cast at `Team.tsx:41` |
| 2 | `Risk` | `renewal-tasks/handler.ts:55-63` — `sourceType` hand-duplicates `MarketingTaskSource` (`resource.ts:63`); `expirationDate: string` required vs `a.date()` nullable (`:326`); `lines: string[]` vs `(string\|null)[]\|null` (`:325`); `policyId?: string` vs `a.id()` nullable (`:318`) |
| 3 | `BuildingInfo` | `acord.ts:638-643` structural subset of `Schema["Building"]["type"]`; `FormsTab.tsx:78-84` passes real `Building[]` — compiles structurally only |
| 4 | `ExtractedField` | `ExtractionPanel.tsx:11-16` says `string\|number\|boolean\|null`; producer emits **always string** (`extract-lead/handler.ts:43-49`, prompt rule `:169`). Bridged by casts at `:188`, `:227`, `:332` |
| 5 | `sqft` | Four typings of one value: `ExtractionPanel.tsx:20` `string\|number\|null`; wire string (`extract-lead/handler.ts:124`); column `a.integer()` (`resource.ts:165`); consumer `number\|null` (`acord.ts:640`) |
| 6 | `ConstructionType` | Copied 4×: `resource.ts:79-86` (source), `acord.ts:629-636`, `ExtractionPanel.tsx:26-33` (verbatim duplicate of the same map), `acord.ts:648-655`, `PropertyPanel.tsx:15-22`. All `Record<string,string>` — a typo compiles |
| 7 | `UserRole` | `resource.ts:58`, `Onboarding.tsx:5`, `team-admin/handler.ts:27` (runtime Set), `Team.tsx:19` (bare string) + `:103-105` (raw options) |
| 8 | `LicenseHolderType` | `resource.ts:67` vs `Licensing.tsx:17` |
| 9 | `LicenseDraft` | `Onboarding.tsx:7-12` re-declares a `License` subset; `residency` a local literal union (`:11`) |
| 10 | Lead intake payload | `crmLead.ts:16` 3-way union → `resource.ts:426` `a.string()` → `resource.ts:94` `AccountType` enum, re-narrowed at `lead-intake/handler.ts:63` |
| 11 | `QuoteStatus` | `resource.ts:25-33` vs `QuotesPanel.tsx:12-20`, `:22`, `CoverageForm.tsx:19` |
| 12 | `LicenseStatus`/`LicenseClass` | `client.ts:55-61`, `:63-69` widen the enums to `Record<string,string>` |
| 13 | `replacementCostType` | `QuotesPanel.tsx:41` declares `string\|null` where the model has the enum (`resource.ts:199`, `:234`); `AccountDetail.tsx:513` passes a real `Policy` through it |

### 4.2 Casts

**`as never` (4) — disables all checking; any string compiles**

`Licensing.tsx:761` (`licenseClass`), `:762` (`residency`), `:763` (`status`) — form state is plain `string`, targets are enums. `ExtractionPanel.tsx:194` ×2, `:367` — `b.label`/`b.sqft` into `isEmpty(v: ExtractedField["value"])`.

**Amplify `list()` result vs model type (4)** — `listAllPages<T>` infers `T` from the page shape, structurally looser than `Schema[X]["type"]`; admitted in a comment at `MarketingTasks.tsx:97`: `MarketingTasks.tsx:98`, `:102`, `:272`, `CarrierDetail.tsx:344`.

**DOM `string` → schema enum (11)** — `CoverageForm.tsx:130`, `:138`, `:151`, `:158`, `:165` (one `useState<string>` at `:66` feeding two different enums), `:339`; `QuotesPanel.tsx:177`; `DocumentsPanel.tsx:167`; `PropertyPanel.tsx:116`; `AccountDetail.tsx:520`; `Onboarding.tsx:124`, `:168`.

**Unvalidated JSON asserted into a shape (7)** — `ExtractionPanel.tsx:145` (after a bare `typeof v === "object"`), `:188`, `:227`, `:332`, `:255`, `:383`; `DocumentsPanel.tsx:356` (after only `Array.isArray`); `Team.tsx:32`, `:41`; `AccountDetail.tsx:587-588`; `extract-lead/handler.ts:224`.

**`.filter(Boolean)` isn't a type guard (5)** — `FormsTab.tsx:60`, `:66`, `:75`; `QuotesPanel.tsx:237`; `renewal-tasks/handler.ts:120`.

**Lambda env shape (5)** — `process.env as never` at `lead-intake/handler.ts:20`, `renewal-tasks/handler.ts:22`, `extract-lead/handler.ts:24`, `process-document/handler.ts:40`; `cert-number/handler.ts:15` `process.env.SEQ_TABLE as string` (silently `undefined` if unset).

**Union narrowed with no discriminant** — `CoverageForm.tsx:62` `existing as Policy | null` on a `Quote | Policy` union, then reads `policyNumber` (`:65`) off what may be a `Quote`.

**Other (9)** — `Licensing.tsx:231`; `QuotesPanel.tsx:171`; `Settings.tsx:26`, `:29`; `AccountDetail.tsx:40`, `:91`; `Dashboard.tsx:344`; `MagicLinkSignIn.tsx:34` (hand-base64-decoded JWT segment); `magic-link/token.ts:52`; `team-admin/handler.ts:144`; `lead-intake/handler.ts:63`; `googlePlaces.tsx:11`.

**pdf-lib ↔ DOM (2)** — `FormsTab.tsx:92`, `AccountDetail.tsx:638` `bytes as BlobPart`.

**`any` (9)** — `extract-lead/handler.ts:343` `event: any` (only bare `any` in `crm`; every other handler types its event); `(window as any).gtag` ×8 at `AssociationLeadForm.tsx:87,88`, `InstantAssessment.tsx:131,132`, `CoverageCalculator.tsx:259,260`, `QuoteApp.tsx:1372,1373` — no `gtag` global declared, contrast `googlePlaces.tsx:14` which does declare `interface Window`.

**`QuoteApp` (7)** — `:116` `Partial<PersistedState>`, `:126`, `:128` immediately re-asserted as complete; `:571`, `:1323`, `:1407`, `:1465` `data[k] as string` narrowing away the array arm of `Record<string, string|string[]>` (`:515`); `:645` untyped network response.

### 4.3 `string` holding structured data

**Dates.** Every `a.date()`/`a.datetime()` is a bare string: `resource.ts:139`, `:147-148`, `:152`, `:200-202`, `:235-236`, `:246`, `:326-329`, `:332`, `:349`, `:379`, `:414-416`.

- Lexicographic compare standing in for date compare (correct only because ISO-8601 sorts): `CoverageForm.tsx:114`, `Licensing.tsx:742`, `FormsTab.tsx:61`, `MarketingTasks.tsx:51`, `renewal-tasks/handler.ts:164`, `:173`
- Type discriminated by string length: `client.ts:134` — `d.length === 10` decides date vs datetime
- `.slice(0,10)` as a datetime→date downcast: `Team.tsx:192`, `AccountDetail.tsx:80`, `MarketingTasks.tsx:46`, `:51`, `renewal-tasks/handler.ts:164`, `:230`
- Divergent null-fallback for the same comparison — resolved; both sides now use `?? today` on the UTC calendar ([5.12](#512-shared-business-rule-frontend--lambda))

**JSON-in-a-string.** `resource.ts:132`, `:237`, `:292`, and every custom op (`:442`, `:454`, `:459`, `:467`, `:476`). Consumers defend against single- *or* double-encoding — the encoding depth is itself unknown: `ExtractionPanel.tsx:140-141`, `DocumentsPanel.tsx:351-352` (both call `JSON.parse` twice), `Team.tsx:24-33`, `AccountDetail.tsx:587`.

**Numbers-in-a-string.** `extract-lead/handler.ts:43-48` types every extracted value as `{type:"string"}` (rationale `:36-40`: structured-outputs union cap). Re-parsed at `ExtractionPanel.tsx:57-70`, `:252`. Form state holds all numerics as strings: `PropertyPanel.tsx:55-65`, `CoverageForm.tsx:43`, `CarrierDetail.tsx:66-70`. Stringified back out at `acord.ts:729-731`, `:849`, `:983`, `:1026`.

### 4.4 Nullable vs optional mismatches

- `Team.tsx:5-12` — six required fields vs a producer emitting `undefined` for four; `undefined` vs schema `null` never reconciled
- `renewal-tasks/handler.ts:60`, `:62` — required `string` and optional `?:` both writing to nullable columns (`resource.ts:326`, `:318`); optional and nullable used interchangeably on the same field
- **Same `License` fields written `undefined` in one path and `null` in the other:** `Onboarding.tsx:91`, `:95` vs `Licensing.tsx:760`, `:766`. On Amplify `update`, `undefined` is a no-op and `null` clears — different semantics for identical user intent
- `Licensing.tsx:753` — `userProfileId: … : undefined` in a payload spread into **both** `update` (`:771`) and `create` (`:772`); the update path can never clear a stale value
- `resource.ts:323-324` — `accountName`/`carrierName` nullable, rendered unguarded and used as sort accessors at `MarketingTasks.tsx:290-291`
- `resource.ts:328` — `submitBy` nullable; `MarketingTasks.tsx:25-26` handles null but `renewal-tasks/handler.ts:213` always writes it, so the UI's null path is dead
- The nullable-schema/empty-string-UI boundary is re-implemented in four forms: `PropertyPanel.tsx:50-66`/`:109-130`, `AccountDetail.tsx:147-157`/`:206`, `CarrierDetail.tsx:66-72`/`:115-125`, `NewLead.tsx:65` (writes `|| undefined`, the odd one out)

---

## 5. MISSING PATTERNS

### 5.1 Async-resource hook — 8 occurrences

Every list-bearing component hand-rolls `useState` triple + `useEffect` + `catch → setError`, each omitting a different piece.

| Site | Declared | Divergence |
|---|---|---|
| `AccountsList.tsx:7-22` | rows, loading | **no error state** — a failed `.list()` shows an empty table forever |
| `Licensing.tsx:28-54` | rows, loading, error | `setLoading(false)` inside `load()` (`:47`), so a throw leaves `loading` stuck true |
| `Team.tsx:16-52` | rows, error | no loading flag |
| `MarketingTasks.tsx:74-109` | rows, `loaded` | third spelling; no error state |
| `QuotesPanel.tsx:64-86` | rows, error | `refresh()` with no `.catch()` — unhandled rejection |
| `AccountDetail.tsx:437-448` | rows | no loading, no error |
| `DocumentSearch.tsx:16,29-43` | rows, error | |
| `App.tsx:63-66` | profile, loading | |

`refresh` is threaded by hand through `QuotesPanel.tsx:81,90,121,206` and `AccountDetail.tsx:448,476`.

### 5.2 Consistent paginated-list usage — resolved

Every filtered read now goes through `listAllPages`; 29 call sites, one implementation. See [PATTERNS.md §1](PATTERNS.md#1-paginated-list-reads). The unfiltered-`.list()` and page-size remnants are tracked at [1.1](#11-apidata-fetching).

### 5.3 Shared entity edit-form — 5 occurrences

| Site | form | flags | setter | save |
|---|---|---|---|---|
| `AccountDetail.tsx:145` | `:145-167` | `:168-170` | `:172-175` | `:177-218` |
| `CarrierDetail.tsx:53` | `:53-74` | `:75-77` | `:79-84` | `:96-130` |
| `NewLead.tsx:13` | `:13-32` | `:10-11` | `:33-34` | — |
| `PropertyPanel.tsx:49` | `:49-67` | `:68-70` | `:72` | — |
| `Licensing.tsx:706` | `:706-725` | `:722-723` | `:726-728` | — |

`AccountDetail.tsx:172-175` and `CarrierDetail.tsx:79-84` are the same six lines.

**Field-coercion idiom:** `x.trim() || null` appears **49 times** (`AccountDetail.tsx` ×17, `NewLead.tsx` ×10, `CarrierDetail.tsx` ×9, `PropertyPanel.tsx` ×7, `CoverageForm.tsx` ×2, `Licensing.tsx` ×2, `QuotesPanel.tsx`, `Onboarding.tsx`); `x ? Number(x) : null` **19 times** (`PropertyPanel.tsx` ×8, `CarrierDetail.tsx` ×4, `NewLead.tsx` ×3, `AccountDetail.tsx` ×2, `Carriers.tsx` ×2). `CoverageForm.tsx:42-43` already names them `num`/`str` but keeps them file-local.

### 5.4 Confirm-destructive component — 4 hand-rolled, 2 gaps

See [1.9](#19-modals--overlays).

### 5.5 S3 upload + record update — 7 occurrences, 3 orderings

| Site | Order | Orphan handling |
|---|---|---|
| `DocumentsPanel.tsx:77-107` | create(`s3Key:"pending"`) → update → upload | deletes the record on failure (`:99-101`) |
| `NewLead.tsx:80-101` | same three steps | **empty catch (`:98-100`)** — leaves the ghost record `DocumentsPanel` explicitly cleans up |
| `PropertyPanel.tsx:464-487` | upload → update → remove(old) | `friendlyError` |
| `SignatureManager.tsx:42-67` | upload → update → re-`getUrl` | inline error |
| `AccountDetail.tsx:623-651` | upload → update | inline |
| `FormsTab.tsx:87-106` | upload → create | inline |
| `Settings.tsx:81-98` | upload only | inline |

`DocumentsPanel.tsx:90-97` and `NewLead.tsx:91-97` are the same eight lines, same path template.

**Download** — `getUrl` + `window.open(url.toString(), "_blank")` verbatim 3×: `DocumentsPanel.tsx:112-115`, `DocumentSearch.tsx:49-52`, `AccountDetail.tsx:664-668`.

**Delete** — `await remove({path}).catch(() => {})` 5×: `DocumentsPanel.tsx:119`, `PropertyPanel.tsx:480`, `:491`, `SignatureManager.tsx:83`, `AccountDetail.tsx:378`.

### 5.6 Role/permission helper — 2 declarations, 7 threaded positions

Resolved in Wave 1 — one `useIsAdmin()` reading the Cognito group. See [1.5](#15-authpermission-checks).

### 5.7 Badge / status-mapping helper — 5 maps + ~15 inline ternaries

Three `Record` maps, each with its own fallback: `QuotesPanel.tsx:12-20` → `:157` `?? "gray"`; `DocumentsPanel.tsx:24` (`{cls,label}` shape) → `:204` `?? OCR_BADGE.PENDING`; `ExtractionPanel.tsx:148` → `:353` `?? "gray"`.

Two function-style variants returning `{badge,label}`: `client.ts:85-99` `licenseHealth`; `MarketingTasks.tsx:21-31` `taskUrgency` — same day-threshold ladder as `licenseHealth:95-98` with different cutoffs (7/21 vs 30/60). `Dashboard.tsx:213-219` re-derives the same ladder a third time.

Inline ternaries where no map exists: `PoliciesList.tsx:87`, `Carriers.tsx:121`, `CarrierDetail.tsx:29`, `AccountDetail.tsx:74`, `Dashboard.tsx:207`, `Settings.tsx:197`, `Licensing.tsx:1010`, `:1016`, `Team.tsx:175-177`. `QuotesList.tsx:96` renders a flat grey badge for the very statuses `QuotesPanel.tsx:12` colour-codes.

### 5.8 Shared "open quote statuses" constant — 4 occurrences

`QuotesPanel.tsx:22` `OPEN_STATUSES`; `QuotesList.tsx:13` `OPEN` (same array, different name); `Dashboard.tsx:32-37` (same four as a GraphQL `or:` filter); `CoverageForm.tsx:19-26` `QUOTE_STATUSES` (superset, exported, not consumed by the other three).

`CoverageForm.tsx:13-16` carries a docblock warning that split field lists "drift apart every time a term is added" — which is what happened to this list.

### 5.9 Shared constants between `crm` and `web` — 4 values duplicated

`crm/src/lib/agency.ts:1-15` states in its own docblock "Mirrors web/src/constants.ts".

| Value | crm | web |
|---|---|---|
| `508-233-2261` | `agency.ts:13` | `constants.ts:1`, `:2` |
| `insurance@ProtectMyHOA.com` | `agency.ts:14` | `constants.ts:3`, `:4` |
| `420 Lakeside Ave, Suite 202` | `agency.ts:9` | `constants.ts:5` |
| Marlborough / MA / 01752 | `agency.ts:10-12` (split) | `constants.ts:6` (joined) |

Stored two different ways, so the ACORD producer block and the website footer cannot be kept in sync by one edit.

Drift inside `web` itself: `QuoteApp.tsx:534-535` hardcodes `"insurance@protectmyhoa.com"` (different casing) and rebuilds the FormSubmit URL rather than importing from `constants.ts:3,8`.

### 5.10 Lead-submission / analytics wrapper — 4 occurrences

Identical seven-line Google Ads conversion block, same `send_to: "AW-18085022517/Csp3COKBgpscELWWzq9D"`: `AssociationLeadForm.tsx:87-93`, `InstantAssessment.tsx:131-137`, `CoverageCalculator.tsx:259-265`, `QuoteApp.tsx:1372-1378`. Each preceded by the same `fetch(FORMSUBMIT_URL, {… _captcha:"false" …})`: `AssociationLeadForm.tsx:63-69`, `InstantAssessment.tsx:112-118`, `ContactForm.tsx:27-33`, `CoverageCalculator.tsx:243-249`, `QuoteApp.tsx:535`+`:580`.

**Lost quote-wizard leads — resolved.** All five forms now pair the email post
with `submitCrmLead`; `QuoteApp.tsx:1419` fires it via `buildCrmLead`
(`:633-681`), which maps the wizard's 16 answer fields onto `CrmLeadInput`. See
[PATTERNS.md §4](PATTERNS.md#4-every-lead-capture-form-writes-to-the-crm). The
wrapper consolidation itself (one shared submit-lead-plus-conversion helper) is
still outstanding — that is the duplication above.

### 5.11 Error-normalizer used consistently — 15 bypasses vs 7 uses

See [1.4](#14-error-handling). Three sites wrap a GraphQL errors array back into an `Error` just to feed the helper: `PropertyPanel.tsx:134`, `NewLead.tsx:72`, `AccountDetail.tsx:213`.

### 5.12 Shared business rule frontend ↔ Lambda

"A quote satisfies an open marketing task" is implemented twice: `MarketingTasks.tsx:39-64` `settleSatisfiedTasks` and `renewal-tasks/handler.ts:159-165` + `:228-240`. Both compute `since = t.triggerDate ?? t.createdAt?.slice(0,10)`, match on `carrierId` + `accountId` + `createdAt.slice(0,10) >= since`, and write the same completion payload.

**Divergent null semantics — resolved.** The client used `?? ""`, and `x >= ""`
is always true, so *any* quote for that carrier — including one from a prior
term — silently completed an open task on every mount of the account Quotes
tab. Both sides now use `?? today` on the UTC calendar (the right-hand operand
is a server-assigned UTC `createdAt`, so UTC is correct on the merits, not only
for parity). See [PATTERNS.md §6](PATTERNS.md#6-a-rule-shared-with-a-lambda-matches-the-lambda).

**Open:** the rule is still written twice. Extracting it into a module both the
browser and the handler import is later-wave work. Also worth a separate data
check: `MarketingTask` rows with `completedBy: "system (quote created)"` may
have been completed by the unbounded comparison and never actually marketed.

### 5.13 Sort-by-`createdAt`-descending — 4 occurrences

`(b.createdAt ?? "").localeCompare(a.createdAt ?? "")` at `FormsTab.tsx:45`, `QuotesPanel.tsx:80`, `DocumentsPanel.tsx:62-64`, `DocumentSearch.tsx:37`. `crm/src/lib/useSort.tsx` already exists as the home for a newest-first default. All four are correct as written (descending puts the `""` fallback last) — this is duplication, not a bug.
