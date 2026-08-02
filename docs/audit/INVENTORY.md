# INVENTORY

Read-only audit of `HOAInsuranceAgency` @ `9a8d055` (branch `staging`).
Scope: `crm/` (React SPA + Amplify Gen2), `web/` (Astro + React islands), `shared/`.
136 tracked `.ts`/`.tsx`/`.astro` files, 24,288 lines. No code was changed.

Context: Waves 0–5 (commits `acd6514`..`3a406f8`) built the shared primitives
(`useFormState`, `useSort`, `useTextFilter`, `useAsyncResource`, `SaveStatus`, `Modal`,
`ConfirmButton`, `badges`, `formCodec`, `storage`, `pagination`, `shared/agency`) and split
the largest files. This pass audits the post-cleanup state. **The dominant finding is
adoption, not absence:** the primitives exist, are tested, and are correct; three of them
have zero production callers, and the remaining duplication is call sites that never
migrated.

---

## MASTER RANKING

Ranked by blast radius × how often it produces an inconsistency.

| # | Finding | Blast radius | Inconsistency rate | § |
|---|---|---|---|---|
| 1 | Schema enums hand-copied into app code; only `QuoteStatus` is compiler-guarded | 19 of 21 enums, both apps + Lambdas | Every enum edit; already drifted 4× | 4.1 |
| 2 | `crm/amplify/**` is outside every typecheck the repo runs | 7 Lambda handlers, all backend logic | Silent on every backend edit | 4.6 |
| 3 | 25 hand-rolled read triads with no error/cancel path vs `useAsyncResource` | 13 files, ~27 read sites | Every failed read renders as empty or hangs | 1.1 |
| 4 | Cascade lead delete gated client-side only; `Account`/`Quote`/`Document` are `allow.authenticated()` | Whole data model | Always exploitable | 1.3 |
| 5 | `storage.ts`, `useTextFilter.tsx`, `formCodec.ts` — built, tested, zero callers | 559 src + 936 test lines dead; 3 upload copies, 3 filter copies, ~79 coercions live | Every new upload/filter/coercion | 3.1 |
| 6 | `notes` is the de-facto untyped overflow schema on the web→CRM boundary | 5 senders, 1 handler, 8 dropped columns | Every web lead | 4.5 |
| 7 | Three `{ok:false,error}` payloads read as success | `submitWebLead`, `startLeadExtraction`, `reserveCertificateNumber` | Every backend-rejected write | 4.4 |
| 8 | `fmtDate` timezone discriminator; `.slice(0,10)` repeated at 6 call sites | ~20 date renders | Every timestamp render for US users | 1.4 |
| 9 | 12 bare `.list()` calls bypass `listAllPages` | 12 list views | At 100+ rows per table | 1.2 |
| 10 | Document upload orchestration duplicated 3× | 3 write paths, S3 + DynamoDB | Every upload; bypasses path validation | 1.6 |
| 11 | No `<Field>`; CRM has zero `<form>` and zero `htmlFor` | ~150 field blocks, 12 forms | Every form; all inaccessible | 5.3 |
| 12 | `useFormState`+`useSaveStatus` handshake wired by hand, forgotten at 6 of 12 sites | 12 CRM forms | Stale "Saved." on 6 forms | 1.5 |
| 13 | Three money shapes for one dollar amount | Screen / ACORD / PDF | Every premium render | 1.4 |
| 14 | 9 mutations discard the `errors` array | 9 write sites | Every failed write shows success | 1.1 |
| 15 | `US_STATES` checkbox/select grid duplicated 6× | 6 forms | Every state-list change | 5.4 |
| 16 | gtag conversion block duplicated 4×, same `send_to` | 4 web forms | 1 of 5 forms missing it entirely | 1.7 |
| 17 | Google Places loader duplicated 3× | 2 apps | `web`'s two copies lack single-flight dedupe | 1.7 |
| 18 | Appetite-match rule implemented twice, already divergent | Dashboard + nightly sweep | Handler filters `linesWritten`; browser does not | 1.8 |
| 19 | Tolerant `JSON.parse` decoder duplicated 3× | OCR tables | Every OCR read | 1.9 |
| 20 | `Celebration` bypasses `Modal`; no focus trap/Escape, stacks above previews | 1 overlay | Whenever a lead converts | 1.10 |
| 21 | No toast/aria-live anywhere; `.error-text` hand-rendered at ~30 sites | Both apps | Every error, for screen readers | 5.1 |
| 22 | 29 bespoke empty/loading states; 3 list pages have neither | 12 list views | Failed fetch indistinguishable from empty | 5.2 |
| 23 | `carrierName` lookup duplicated 5× | 5 list views | Every carrier-name render | 1.11 |
| 24 | ACORD producer/insured header block written twice | 2 eForm fillers | Every agency-identity change | 1.12 |
| 25 | Dead assets, phantom env vars, stray script, unused deps | 2.6 MB + 4 env vars | Static | 3.3–3.6 |

---

## 1. DUPLICATE IMPLEMENTATIONS

### 1.1 Data fetching — read path

| Implementation | Location | Call sites |
|---|---|---|
| `useAsyncResource` | `crm/src/lib/useAsyncResource.ts:80` | 10 sites / 7 files |
| Raw `useState` + `useEffect` + `.then(setX)` | 13 files | 25 reads |
| `observeQuery` subscription | `crm/src/components/DocumentsPanel.tsx:55` | 1 |
| 4s polling loop | `crm/src/components/ExtractionPanel.tsx:171` | 1 |
| Lazy Lambda client prologue (verbatim ×4) | `lead-intake/handler.ts:15`, `process-document/handler.ts:34`, `extract-lead/handler.ts:21`, `renewal-tasks/handler.ts:19` | 4 |

Hand-rolled sites, none with an error state or cancellation:
`Dashboard.tsx:25-55` (6 queries, one effect) · `Carriers.tsx:28` · `PoliciesList.tsx:15` ·
`QuotesList.tsx:16` · `CarrierDetail.tsx:11` · `AccountDetail.tsx:51` ·
`account/CertificatesTab.tsx:49` · `carrier/AppetiteGuides.tsx:19` · `FormsTab.tsx:47` ·
`property/BuildingsCard.tsx:31` · `MarketingTasks.tsx:328` · `licensing/LegacyBackfill.tsx:39` ·
`FilePreview.tsx:32` · `SignatureManager.tsx:36` · `property/PhotosCard.tsx:120` ·
`Settings.tsx:69` · `ExtractionPanel.tsx:171`.

Five use "data is still null" as the loading gate, so a failed read shows `Loading…`
permanently: `CarrierDetail.tsx:18`, `AccountDetail.tsx:60`, and the three above it.

Mutations that discard `errors` entirely (write fails, UI shows success):
`QuotesPanel.tsx:329`, `MarketingTasks.tsx:61`, `SignatureManager.tsx:100`,
`property/PhotosCard.tsx:40,56`, `NewLead.tsx:81,96`, `account/CertificatesTab.tsx:89`.
`if (errors?.length) throw …` appears 33× across 22 files — three times inside one function
at `CoverageForm.tsx:155,162,169`.

- **Most used:** bare `client.models.*` + `.then()` — 96 call sites / 34 files.
- **Most correct:** `useAsyncResource` — guarantees an error state (`:146`), clears loading in
  `finally` (`:147`), drops superseded responses via a monotonic ticket (`:127,142,148`) and
  post-unmount writes (`:117`), normalizes through `friendlyError`, returns a non-rejecting
  `refetch` (`:155`).
- **Canonical:** `useAsyncResource` for all reads; add an `unwrap({data,errors})` helper for
  writes; extract the Lambda client prologue into a shared module beside `pagination.ts`
  (which already establishes the no-imports-shareable pattern at `pagination.ts:13`).

### 1.2 Pagination

`listAllPages` (`crm/src/lib/pagination.ts:17`) — 20 browser sites + 7 Lambda sites.
Bypassed by 12 bare `.list()` calls that stop at the first DynamoDB page:
`QuotesList.tsx:23-25`, `PoliciesList.tsx:21-23`, `Carriers.tsx:29-30`, `Dashboard.tsx:46-47`,
`Licensing.tsx:39,45`, `Team.tsx:65`, `CertificatesTab.tsx:62`, `QuotesPanel.tsx:93`,
`PoliciesTab.tsx:43`, `AccountsList.tsx:36`, `LegacyBackfill.tsx:40`.
The unpaged **Carrier** list specifically is repeated at 7 of those sites.
No UI paging exists anywhere; every list renders all rows.

- **Canonical:** `listAllPages` everywhere; a shared `useCarriers()` for the 7-way repeat.

### 1.3 Auth / permission checks

| Mechanism | Location | Call sites |
|---|---|---|
| Cognito groups (the only enforced source) | `crm/src/lib/auth.ts:23` `fetchUserGroups` | 1 (`App.tsx:82`) |
| `isAdminGroup` / `roleFromGroups` | `auth.ts:36,44` | `App.tsx:134,127` |
| `useIsAdmin()` context | `auth.ts:57` | 3: `Settings.tsx:21`, `Licensing.tsx:31`, `DeleteLeadZone.tsx:22` |
| `UserProfile.role` | `resource.ts:405` | Display only — **no code gates on it** (`App.tsx:281`, `Team.tsx:118,208`) |
| AppSync `@auth` rules | `crm/amplify/data/resource.ts` | per model |

Correctly paired client + server: `Settings.tsx:28,64` ↔ `resource.ts:520,526`;
`Licensing.tsx:195,214` ↔ `resource.ts:481-484`.

**Client-only, no server counterpart** — verified: `Account`, `Quote` and `Document` declare
no `.authorization()` block, so they inherit the schema default `allow.authenticated()`
(`resource.ts:564`), which permits delete.

- `crm/src/pages/account/DeleteLeadZone.tsx:59` — `if (!isAdmin) return null` is the only gate
  on a cascade that deletes Quote (`:37`), Document + S3 object (`:50`) and Account (`:54`).
  Any signed-in STAFF user can perform the same deletes through the API. The file comment
  (`:16-19`) asserts the gate "can't be rendered without the check coming with it" — true of
  the UI, not of the data.
- `crm/src/components/Licensing.tsx:126` — `LegacyBackfill` admin-gated; `License` create is
  authenticated-open (`resource.ts:482`).
- `crm/amplify/storage/resource.ts:~68` — `signatures/*` writable by any authenticated user at
  a predictable key; signatures are stamped onto issued ACORD certificates. Already marked a
  KNOWN GAP in-file.
- `crm/amplify/auth/resource.ts:14` — comment "privileges are not enforced yet" is stale;
  they are enforced at `resource.ts:483,520,526`.
- `crm/amplify/functions/team-admin/handler.ts:129-149` — no role check inside the Lambda;
  trusts AppSync. `invokedBy` (`:132`) is logged only.

- **Canonical:** a `deleteLead` custom mutation behind `allow.groups(["ADMIN"])`, plus a
  `<RequireAdmin>` wrapper so the client gate and the model rule are introduced together.
  Today `useIsAdmin()` is spot-checked in three different shapes (`return null`, tab-array
  splice, `canEdit` prop) with no convention linking either half.

### 1.4 Date & money formatting

**Date — 5 app implementations, 3 Lambda:**

| | Location | Output |
|---|---|---|
| `fmtDate` | `crm/src/lib/client.ts:129` | `8/2/2026`, `—` when falsy |
| `fmtDateTime` | `client.ts:422` | `8/2/2026, 3:04 PM` |
| `fmtUs` | `acordFormat.ts:16` | as `fmtDate`, `""` when absent |
| `todayUs` | `acordFormat.ts:34` | local Y/M/D → `fmtDate` |
| Inline `Intl` | `web/src/components/quote/submission.ts:58` | `Sunday, August 2, 2026 at 3:04 PM` |
| `isoDay`/`addDays` | `renewal-tasks/handler.ts:31` | `2026-08-02`, UTC |
| `getUTCFullYear` + pad | `cert-number/handler.ts:32,48` | `HOA-2026-00042` |

`fmtDate` is used at ~20 sites; `fmtDateTime` at exactly one (`FormsTab.tsx:254`).

Correctness:
- `client.ts:131` — the `d.length === 10` discriminator means a **timestamp** is parsed as a
  UTC instant and rendered on the viewer's local calendar, shifting a day for US users. Six
  call sites work around it by hand-slicing first, repeating `.slice(0,10)` verbatim:
  `Team.tsx:234`, `DocumentSearch.tsx:155`, `AccountDetail.tsx:75`, `CertificatesTab.tsx:307`,
  `MarketingTasks.tsx:303`. The guard is call-site discipline, not the function's.
- `client.ts:131` renders the literal `Invalid Date` for a malformed 10-char string;
  `fmtDateTime:425` returns `—` for the same input.
- `acordApp.ts:181-184` — local parse → `+1 year` → `.toISOString()` (UTC). Off by one day for
  UTC+X.
- `Dashboard.tsx:260-273` — `from` uses local year (`:266`), `to` uses UTC day (`:261`); on
  Dec 31 local / Jan 1 UTC the YTD range spans 12 months + 1 day.
- `ExtractionPanel.tsx:124-129` renders raw ISO in a table whose sibling columns use `fmtDate`.
- `MarketingTasks.tsx:50` uses UTC deliberately to match the sweep — documented, not a bug.
- `client.ts:392` `daysUntil` — exact civil-day subtraction against local today; correct.

**Money — 3 shapes for one amount:**
`fmtMoney` (`client.ts:124`) → `$11,000`, cents rounded away, ~15 sites ·
`amt` (`acordFormat.ts:27`) → `1,000,000`, **no `$`** ·
`acordApp.ts:225` → `toFixed(2)` → `12345.00`, **no separators**, three lines from `fmtUs` calls.
KB formatting duplicated byte-for-byte: `DocumentsPanel.tsx:250` ↔ `NewLead.tsx:263`.
**Percent has no shared formatter** — 4 inline unrounded sites (`Carriers.tsx:142`,
`QuotesPanel.tsx:31,45`, `Dashboard.tsx:437`); a stored `12.345` renders `12.345%`.

- **Canonical:** `fmtDate` with the `.slice(0,10)` folded in and an `Invalid Date` guard;
  `fmtMoney` for all screen money; add `fmtPercent`; `acordFormat` keeps its `""`-not-`—`
  variants for PDF only.

### 1.5 Form state

| Approach | Location | Sites |
|---|---|---|
| `useFormState` | `crm/src/lib/useFormState.ts:137` | 12, all CRM |
| Per-field `useState` | — | 7 (all of `web/` + `QuotesPanel.tsx:279`, `MagicLinkSignIn.tsx:15`) |
| Schema/flow-driven | `web/src/components/quote/schema.ts:46` | 1 (`QuoteApp.tsx:134`) |
| Uncontrolled (file/Places refs) | `FileButton.tsx:41`, `googlePlaces.tsx:54` | 3 |

`useFormState` + `useSaveStatus` are always paired but wired by hand via
`{ onEdit: saveStatus.markDirty }` — present at 6 sites (`CarrierForm.tsx:36`,
`DetailsCard.tsx:49`, `BuildingsCard.tsx:26`, `Team.tsx:32`, `Carriers.tsx:24`,
`OverviewTab.tsx:42`), **forgotten at 6** (`CoverageForm.tsx:93`, `LicenseForm.tsx:49`,
`NewLead.tsx:11`, `Onboarding.tsx:52`, `AppetiteGuides.tsx:165`, `CertificatesTab.tsx:38`),
which then hand-roll `saving`/`error` and get no ARIA and no stale-"Saved." retraction.

- **Most used:** `useFormState` + inline `if`-guards in an async `save()` + one joined error
  banner.
- **Most correct:** `CarrierForm.tsx` / `DetailsCard.tsx` / `OverviewTab.tsx` /
  `BuildingsCard.tsx` — the in-flight guard is owned by the same machine that runs the
  mutation (`SaveStatus.tsx:198`), and `SaveStatus.tsx:97` is the only ARIA-carrying error
  surface in the repo.
- **Canonical:** one `useForm({ initial, validate, submit })` that composes both.

### 1.6 File upload / download

| | Location | Status |
|---|---|---|
| `uploadDocument` etc. | `crm/src/lib/storage.ts:154-217` | canonical, **0 callers** |
| Inline copy | `DocumentsPanel.tsx:63-100` | live |
| Inline copy | `NewLead.tsx:79-107` | live |

Both live copies hardcode `"pending"` where `storage.ts:37` exports `PENDING_KEY`, and neither
sanitizes the filename — `NewLead.tsx:95` interpolates `file.name` straight into the S3 key,
which breaks the OCR key parse at `process-document/handler.ts:143` for any name containing `/`.
Neither validates the path prefix (`storage.ts:58` `assertGrantedPath`).

Download-and-open: `storage.ts:253` (unused, handles popup blocking) vs three live copies with
neither error handling nor popup detection: `DocumentsPanel.tsx:104`, `DocumentSearch.tsx:62`,
`CertificatesTab.tsx:174`.
All 6 live delete sites swallow failures with `.catch(() => {})`: `SignatureManager.tsx:97`,
`DocumentsPanel.tsx:112`, `PhotosCard.tsx:44,55`, `DeleteLeadZone.tsx:48`.
12 files import `aws-amplify/storage` directly.

- **Canonical:** `crm/src/lib/storage.ts` — it is the only version that validates the prefix,
  sanitizes segments, orders record-then-upload, cleans up ghosts, and reports delete failures.

### 1.7 `web/` form submission

The FormSubmit envelope + `res.ok` check + gtag conversion block (same
`send_to: "AW-18085022517/…"`) is copy-pasted across 5 files: `quote/submission.ts:159-178`,
`AssociationLeadForm.tsx:63-93`, `InstantAssessment.tsx:112-137`,
`CoverageCalculator.tsx:245-268`, `ContactForm.tsx:27-40`.
`sendQuoteEmail` is the only one that inspects the response body.
`ContactForm.tsx` is the only one **missing the gtag block entirely**.

Google Places script loader duplicated 3×: `crm/src/lib/googlePlaces.tsx:21` (has single-flight
`loadPromise` dedupe), `CoverageCalculator.tsx:20`, `InstantAssessment.tsx:9` (neither does).
Three separate `address_components` parsers (`googlePlaces.tsx:69` full, the other two
state-only), and the autocomplete fill is duplicated verbatim at `NewLead.tsx:173-180` ↔
`DetailsCard.tsx:124-131`.

- **Canonical:** `submitToFormSubmit(payload)` + `trackConversion()` in `web/src/lib/`;
  promote `crm/src/lib/googlePlaces.tsx` to `shared/`.

### 1.8 Appetite matching (client ↔ server)

`crm/amplify/functions/renewal-tasks/handler.ts:117-147` `guideFits` (comment at `:116`: "Mirrors
the Appetite Finder") vs `crm/src/pages/Carriers.tsx:182-205`. Same state fallback, same
inverted-range normalization (`handler.ts:39` `order()` vs `Carriers.tsx:188-197` inline
ternaries), same TIV/year bounds. **Already divergent:** the handler additionally filters on
`linesWritten` (`:142-145`); the browser copy does not.

- **Canonical:** one appetite module both sides import; both already import the same
  `AppetiteGuide` schema type.

### 1.9 Tolerant JSON decoder

Double-`JSON.parse` OCR-table decoder duplicated 3×: `DocumentsPanel.tsx:369-378`,
`ExtractionPanel.tsx:141-148`, `extract-lead/handler.ts:194-206`.
Writer sets the field to `undefined` when >100 KB (`process-document/handler.ts:167`), which is
indistinguishable from "no tables" on every read side.

Also duplicated 3× with no shared test-util module: the `deferred<T>()` helper —
`SaveStatus.test.tsx:10`, `useAsyncResource.test.ts:6`, `ConfirmButton.test.tsx:7`. And the
`generateClient` stub — `client.test.ts:15` ↔ `storage.test.ts:13`.

### 1.10 Modals / overlays

| Impl | Location | Escape | Focus trap | Focus restore | ARIA | Scroll lock |
|---|---|---|---|---|---|---|
| `Modal` | `crm/src/components/Modal.tsx:108` | ✅`:68` | ✅`:87` | ✅`:75` | ✅`:112` | ❌ |
| `FilePreviewModal` | `FilePreview.tsx:45` | inherits | inherits | inherits | inherits | ❌ |
| `Celebration` | `Celebration.tsx:113` | ❌ | ❌ | ❌ | ❌ none | ❌ |
| CRM sidebar drawer | `App.tsx:254-267` | ❌ | ❌ | ❌ | partial | ❌ |
| web nav drawer | `Navbar.astro:53-67` | ❌ | ❌ | ❌ | no `aria-expanded` | ❌ |

`Modal` is reached only through `FilePreviewModal` (5 render sites).
`Celebration` (z-index 200, `styles.css:252`) stacks above `.preview-overlay` (z-index 100,
`styles.css:340`) — a conversion celebration covers an open file preview with an overlay that
traps nothing and has no Escape.
Two confirm idioms across the monorepo: `ConfirmButton` (crm, 6 sites, accessible) vs
`window.confirm` (`QuoteApp.tsx:113`).

- **Canonical:** `Modal.tsx` (+ scroll lock and a portal); route `Celebration` through it.

### 1.11 Carrier-name lookup

Byte-identical at `QuotesPanel.tsx:121-122` ↔ `PoliciesTab.tsx:65-66`; same concept as a Map at
`PoliciesList.tsx:30`, `QuotesList.tsx:32`, inline at `Dashboard.tsx:302`.
Note the direction of one dependency: `PoliciesTab.tsx:12` imports two pure formatters
(`commissionCell`, `termsSummary`) **from a component module** (`QuotesPanel.tsx:22,34`).

### 1.12 ACORD eForm header block

The producer + insured header (date, 7 producer fields, 9 insured fields) is written twice:
`crm/src/lib/acord25.ts:36-93` and `crm/src/lib/acordApp.ts:142-165` — same field names, same
`AGENCY.*` bindings. `acordRegistry.ts:36-39` documents that these headers are shared across
every eForm.

### 1.13 Validation

| Approach | Location | Sites |
|---|---|---|
| Problem-list validator | `client.ts:137` `validateAccountFields` | 3 |
| Field validators | `client.ts:234,267,292,313` | **0 production** |
| Schema-declared | `quote/schema.ts:27` `validateText` | 1 |
| Inline `if` in `save()` | — | 10 |
| HTML `required` | — | 4 web files; **zero in CRM** |

- **Email — 4 live copies, 2 regex shapes:** `client.ts:146` (inline, `+` TLD) ·
  `client.ts:234` `EMAIL_RE` (`{2,}`, exported, **unused** — its own comment at `:232` says
  "Exported so `web` can drop its private copy") · `quote/schema.ts:25` (the private copy,
  still there) · `lead-intake/handler.ts:50` · `team-admin/handler.ts:33`.
- **Date-range ordering** hand-rolled twice with identical condition *and* message string
  (`CoverageForm.tsx:112-119`, `LicenseForm.tsx:61-68`) while `validateDateRange` sits unused.
- **Year bounds** twice (`client.ts:158-163`, `DetailsCard.tsx:51-55`) while `validateYear`
  sits unused.
- `validateAccountFields` re-implements `EMAIL_RE`, `validateYear` and `validatePositiveInt`
  from **the same file**.
- **Unit count — 5 incompatible treatments:** `client.ts:153` (int 0–100000) ·
  `NewLead.tsx:60` (`Number()`) · `DetailsCard.tsx:90` (`Number()`) ·
  `CoverageCalculator.tsx:145` (`parseInt||0`) · `InstantAssessment.tsx:200` (raw string).
- `quote/schema.ts:96` declares `unitCount`/`yearBuilt` as `inputType:"number"` but
  `validateText` (`:27-44`) has no numeric branch — any text passes.
- **Defect:** `QuoteApp.tsx:183` `handleTextSubmit` has no in-flight guard. The button is
  disabled (`:361`) but the Enter path (`quote/ui.tsx:334-337`) is not, so Enter-Enter on the
  final step fires `submitForm` twice.
- `ContactForm.tsx:15` returns silently on invalid input, leaving the button stuck with no
  message.

---

## 2. FILE SIZE OFFENDERS

**Only two files exceed 500 lines**, one of them a test — the Wave 5 splits
(`3a406f8`..`367f872`) cleared this tier.

### Over 500

**`crm/src/lib/client.test.ts` — 711 (test)**
10 responsibilities: mock harness `L1-21` · `legacyDaysUntilDate` differential oracle `L22-34` ·
`EMAIL_RE` `L35-73` · `friendlyError` `L74-192` · `validateDateRange` `L193-294` ·
`validateYear` `L295-367` · `validatePositiveInt` `L368-444` · TZ/fake-timer helper `L445-462` ·
`daysUntil` `L463-627` · `fmtDateTime` `L628-711`.
Tracks its subject: 4 of the 6 units it covers have no production caller.

**`crm/amplify/data/resource.ts` — 586 (source)**
18 responsibilities: Lambda imports `L1-19` · **22 enum declarations `L20-89`** · `Account`
(~60 fields) `L90-161` · `Building` `L162-173` · `Quote` `L174-207` · `Policy` `L208-251` ·
`Carrier`/`AppetiteGuide` `L252-289` · `Document` `L290-307` · `MarketingTask` `L308-347` ·
`Certificate` `L348-371` · `UserProfile` `L372-422` · deprecated `ProducerLicense` `L423-436` ·
`License` `L437-485` · `submitWebLead` `L486-511` · `inviteUser`/`listTeamUsers` `L512-528` ·
`startLeadExtraction`/`reserveCertificateNumber` `L529-545` · schema authorization `L546-573` ·
`defineData` `L574-586`.
Exports 2. `Quote` and `Policy` are hand-duplicated field-for-field (19 identical fields,
`L186-205` vs `L228-245`) with no shared fragment. This file is the origin of §4.1.

### 300–500 (secondary tier, 25 files — 8 tests)

Non-test files carrying ≥3 distinct responsibilities:

| File | Lines | Distinct responsibilities | Hooks | Exports |
|---|---|---|---|---|
| `web/src/components/quote/ui.tsx` | 492 | 14 unrelated UI primitives in one module (`ProgressBar`, `TypeWriter`, `ProgressRing`, canvas `Confetti` `L92-175`, `ThemeIndicator`, `SlideIn`, `CardOption`, `TextField`, `PrimaryButton`, `BackButton`, `RestartButton`, `AgentHeader`, `FallbackAvatar`) | 9/5/2 | 10 |
| `web/src/components/CoverageCalculator.tsx` | 485 | Places loader `L17-45` · state map `L46-64` · **underwriting rule engine `L65-94`** · risk copy `L95-107` · 7 inline SVGs `L108-124` · CRM+FormSubmit+gtag POST `L223-276` · 190 lines JSX `L295-485` | 11/2 | 1 |
| `crm/src/pages/Dashboard.tsx` | 447 | 4 components: `Dashboard` (6 queries in one effect) `L24-86` · `Tile` · `RenewalsCard` `L114-241` · `CarrierCharts` `L246-389` · `BarCard` `L390-447` | 11/1 | 1 |
| `crm/src/lib/acordApp.ts` | 444 | Constant maps `L15-51` · prose builder `L52-89` · shared eForm header `L97-175` · acord125 dates/indicators `L176-250` · LOB map `L251-284` · policy info `L285-321` · premises schedule `L322-385` · acord140 `L392-427` | — | 2 |
| `crm/src/components/MarketingTasks.tsx` | 443 | 2 unrelated components + **a write-performing auto-close rule in a render module** (`settleSatisfiedTasks` `L36-71`) + a hand-rolled fetch `L325-364` alongside a sibling that uses the hook | 5/1 | 2 |
| `crm/src/lib/client.ts` | 435 | **13 concerns**: network client singleton `L1-22` · licensing vocabulary `L24-51` · `licenseHealth` `L53-96` · `US_STATES`/`LINES_OF_BUSINESS` `L98-116` · formatters `L118-132` · `validateAccountFields` `L134-170` · `friendlyError` `L172-212` · `EMAIL_RE` `L214-239` · `isIsoDay` `L241-256` · `validateDateRange` `L258-283` · `validateYear`/`validatePositiveInt` `L285-330` · `daysUntil` `L332-400` · `fmtDateTime` `L402-435` | — | **33** |
| `web/src/components/QuoteApp.tsx` | 435 | Theme state + localStorage + 60s day/night re-eval `L32-86` · flow hydration `L88-110` · restart dedupe loop `L111-132` · nav handlers `L149-215` · `submitForm` (CRM + email + gtag + confetti) `L217-248` · 5 step renderers `L278-435` | 12/5 | 1 |
| `crm/src/components/ExtractionPanel.tsx` | 424 | Types + labels `L13-48` · value helpers `L50-78` · **24-entry field table `L80-137`** · JSON decoder `L139-148` · 4s poll `L171-182` · `apply()` transaction `L222-281` · review table `L283-424` | 5/2 | 1 |
| `crm/src/components/CoverageForm.tsx` | 394 | Constants + file-local codecs `L22-40` · `useFormState` over **26 fields** `L42-94` · commission autofill `L96-109` · `save()` with inline validation + 3-way write branch `L111-177` · **196 lines JSX** `L187-382` | 3/0 | 1 |
| `crm/src/components/QuotesPanel.tsx` | 386 | 2 formatters `L22-49` · fetches `L51-98` · status mutation `L99-116` · panel JSX `L140-266` · **quote→policy bind transaction `L290-343`** · BindForm JSX `L345-386` | 6/0 | 3 |
| `crm/src/components/DocumentsPanel.tsx` | 378 | Categories `L15-26` · `observeQuery` `L54-61` · upload orchestration `L63-101` · delete `L108-127` · regex highlight `L129-135` · Ctrl+F `<mark>` indexing `L156-178` · table `L180-283` · preview + OCR viewer `L285-360` · `parseTables` `L365-378` | 8/2 | 1 |
| `crm/src/pages/account/CertificatesTab.tsx` | 353 | 3 queries in one effect, no loading/error `L49-63` · `issue()` `L65-109` · `generatePdf()` (fill + S3 + patch + warnings) `L111-170` · download `L172-176` · form JSX `L212-273` · table `L275-341` | 8/1 | 1 |
| `crm/amplify/functions/extract-lead/handler.ts` | 349 | Schema builders `L33-73` · **`EXTRACTION_SCHEMA` `L75-165` (never sent to the API — only `Object.keys()` at `L251` is used; ~90 dead lines)** · prompt `L167-176` · budget packing `L208-247` · Anthropic call `L248-290` · write-back `L292-319` · dual-shape handler `L321-349` | — | 1 |
| `crm/src/lib/acord25.ts` | 338 | **~100-line field-mapping table inside a function body `L22-119`** · insurer letters `L121-144` · GL row `L146-178` · GL limits `L180-228` · umbrella `L230-260` · WC `L262-282` · OTHER `L284-321` | — | 1 |
| `crm/src/lib/storage.ts` | 313 | Path grants `L32-55` · validation `L56-91` · `uploadFile` `L92-118` · `uploadAndLink` `L119-153` · `uploadDocument` `L154-217` · `getFileUrl` `L218-234` · `downloadFile` `L235-271` · `deleteFile` `L272-309` | — | 13 (all dead) |
| `crm/src/components/SaveStatus.tsx` | 311 | Presentational component `L77-123` + state machine `L197-311`. **Not mixed** — clean separation | 13 | 8 |
| `crm/src/pages/carrier/AppetiteGuides.tsx` | 307 | List + `load()` + `del()` `L14-35` · guides table `L78-138` · `GuideForm` + local `str`/`num` `L139-167` · `save()` `L168-207` · form JSX incl. 50-state grid `L208-307` | 5/1 | 1 |
| `crm/src/pages/NewLead.tsx` | 306 | `useFormState` over 17 fields `L9-35` · validation `L36-47` · 17-field create mapping `L48-74` · **staged-upload loop `L75-121`** · form JSX `L125-239` · file table `L240-281` | 4/0 | 1 |
| `crm/src/App.tsx` | 304 | `AuthGate` `L34-66` · `ProfileGate` (fetch + error + loading + onboarding + admin context) `L67-138` · `NotFound` · **9 inline SVG icon components, 86 lines `L151-237`** · `NAV_ITEMS` `L238-247` · `Shell` + 12 routes `L248-304` | 1/0 | 1 |

**Fetching + business logic + presentation mixed in one module:** 12 of 19 non-test source
files audited — `CoverageCalculator`, `Dashboard`, `MarketingTasks`, `QuoteApp`,
`ExtractionPanel`, `CoverageForm`, `QuotesPanel`, `DocumentsPanel`, `CertificatesTab`,
`AppetiteGuides`, `NewLead`, partially `App`.
**Clean separation:** `quote/ui.tsx`, `SaveStatus.tsx`, `storage.ts`, `acord25.ts`,
`acordApp.ts`, `resource.ts`, `extract-lead/handler.ts`.

**Inline literal data belonging in a data module:**

| File | Lines | Content |
|---|---|---|
| `acord25.ts` | `L22-119` (~100) | ACORD field-mapping table inside a function body |
| `extract-lead/handler.ts` | `L75-165` (~90) | `EXTRACTION_SCHEMA` — body is dead |
| `App.tsx` | `L152-237` (86) | `iconProps` + 9 SVG icon components |
| `CoverageCalculator.tsx` | `L47-50,66-92,96-105,109-123` (~60) | State map, rule engine copy, risk strings, `ICONS` — while `web/src/data/` already exists |
| `ExtractionPanel.tsx` | `L80-131` (52) | `ALL_FIELD_DEFS` — must stay in sync with the Lambda, no shared source |
| `client.ts` | `L26-51,98-116` (~45) | 5 reference tables in the module that instantiates the network client |
| `acordApp.ts` | `L17-50,254-263` | 5 label/phrase maps + `LOB_FIELDS` |

**Coupling defect:** `client.ts` calls `generateClient()` at module scope, so all 8 consumers
of a pure constant like `US_STATES` transitively construct the network client. Two test files
carry identical stubs solely to work around it (`client.test.ts:15`, `storage.test.ts:13`).

---

## 3. DEAD CODE

### 3.1 Orphaned modules — nothing but their own test imports them

| Module | Src | Test | Verification |
|---|---|---|---|
| `crm/src/lib/storage.ts` | 313 | 400 | `git grep "lib/storage"` → 1 hit: `storage.test.ts:34`. All 12 app files import `aws-amplify/storage` directly |
| `crm/src/lib/useTextFilter.tsx` | 149 | 382 | `git grep -w useTextFilter` → only its own test + self doc-comments |
| `crm/src/lib/formCodec.ts` | 97 | 154 | 1 real import (`formCodec.test.ts:2`); the other 2 hits are comments in `CoverageForm.tsx:38` and `AppetiteGuides.tsx:152` saying they are *not* using it |

**559 source + 936 test lines covering nothing shipped.** Each has a live hand-rolled
counterpart: 3 upload copies (§1.6), 3 filter copies (`AccountsList.tsx:58`, `Licensing.tsx:65`,
`MarketingTasks.tsx:344` — the exact three its docstring names), ~79 hand-written coercions
(38 `.trim() || null`, 17 `.trim() || undefined`, ~24 `? Number(x) : null`).

### 3.2 Exports with no production consumer

Only their own test file references these:
- `client.ts:234` `EMAIL_RE` · `:267` `validateDateRange` · `:292` `validateYear` ·
  `:313` `validatePositiveInt`
- `quoteStatus.ts:71` `isQuoteStatus` · `:83` `isClosedQuoteStatus` · `:90`
  `isSelectableQuoteStatus` · `:97` `ALL_QUOTE_STATUSES` · `:105` `CLOSED_QUOTE_STATUSES` ·
  `:130` `quoteStatusFilter`
- `SaveStatus.tsx:56` `SaveStatusValue`

Exported but used only inside the defining file (should be un-exported) — each verified with
`git grep -ln -w` returning exactly one file:
`Modal.tsx:36` `ModalProps` · `ConfirmButton.tsx:19` `ConfirmButtonProps` ·
`SaveStatus.tsx:45,134,136,143,176` · `badges.tsx:32,123,155` · `client.ts:61` `LicenseLevel` ·
`useFormState.ts:48,125` · `useAsyncResource.ts:45,71` · `quoteStatus.ts:57,59,61,127` ·
`magic-link/token.ts:13` `TOKEN_TTL_MS`.
`shared/agency.ts:72,73` `Agency`, `AgencyFormatted` — **zero references anywhere**.

### 3.3 Dead assets

`web/src/assets/images/` — **all 11 files, 2.6 MB.** Verified: `grep -rn "assets/images\|\.\./assets" web/src`
→ zero hits. Every image on the site is a public-dir URL resolving to `web/public/images/`,
which holds its own copies. 6 of the 11 (`about.jpg`, `building-icon.png`, `community.jpg`,
`what-we-do.jpg`, `why-choose.png`, `hero.jpg`) have no `public/` counterpart at all.

### 3.4 Phantom env vars

`web/.env.example:11-22` — documented, never read. `git grep "ZAPIER_HOOK\|OWNER_LOOKUP_URL"`
over all source → **zero hits**:
`PUBLIC_ZAPIER_HOOK_HO6`, `PUBLIC_ZAPIER_HOOK_QUOTE`, `PUBLIC_ZAPIER_HOOK_LEAD`,
`PUBLIC_OWNER_LOOKUP_URL`. The comment also points at `scripts/lookup-worker`, which does not
exist (`web/scripts/` contains only `sync-buildium.ts`).

### 3.5 Stray script

`crm/scan.mjs` (15 lines, tracked) — ad-hoc ACORD PDF field dumper writing to
`/tmp/acord-fields.json`. Zero references in any `package.json`/`yml`/`md`/`ts`.

### 3.6 Unused dependencies

- `crm` devDep **`tsx`** — zero imports; no `crm` script invokes it. (`web`'s `tsx` **is** used
  by `"sync"`.)
- `crm` devDep **`esbuild`** — zero imports, not in `overrides`. Likely an Amplify bundler pin;
  confirm before removing.

Not flagged despite zero literal imports (all legitimate): `@types/*` (ambient), `typescript`,
`@aws-amplify/backend-cli` (`ampx`), `constructs`, `@testing-library/dom`, `web`'s `react-dom`.

### 3.7 Dead schema surface

- `resource.ts:416` `licenses: a.hasMany("ProducerLicense")  // deprecated` — no code reads
  `profile.licenses`. Dead relationship.
- `extract-lead/handler.ts:75-165` `EXTRACTION_SCHEMA` — never passed to the API (`:263-276`
  sends no `tools`); only `Object.keys(...properties)` at `:251` is used. ~90 lines are an
  unused body around a key list.
- `Account.buildiumId` (`resource.ts:152`) — write-only; zero readers in `crm/src`.
- `Account.priorCarrierName` (`:144`) and `priorPremium` (`:146`) exist and are never filled
  from extraction, while extraction invents untyped `currentCarrier`/`currentAnnualPremium`
  keys that land in `notes`.

### 3.8 Not dead — verified reachable

- All 12 Amplify models are queried from `crm/src`; all 5 custom operations are live.
- All 12 CRM routes reachable. `/quotes` and `/policies` are absent from `NAV_ITEMS`
  (`App.tsx:239-247`) but reached via `Dashboard.tsx:68,73`.
- `ProducerLicense` (marked DEPRECATED) is still queried at `LegacyBackfill.tsx:40`, rendered
  behind an admin gate at `Licensing.tsx:127` — a one-time migration UI still shipped.
- `web/src/pages/associations/[slug].astro` — deliberately unlinked (`robots.txt:3`,
  `astro.config.mjs:12`), PM-distributed.
- `web/src/pages/get-started/[...slug].astro` — zero inbound internal links; reachable only via
  sitemap/ads. Likely intentional.
- **Commented-out code: none.** The only candidate (`client.ts:214-225`) is an illustrative
  usage example, not disabled code. No `TODO`/`FIXME`/`HACK`, no `if (false)`, no feature flags.

---

## 4. TYPE DRIFT

`crm/src/lib/client.ts:7-18` re-exports every model as `Schema[M]["type"]`, so the **model
types never drift**. All drift is in (a) hand-copied enums, (b) hand-written shapes for
`a.json()` operations, (c) the web→CRM wire.

### 4.1 Enum vocabulary — 19 of 21 hand-copied, 1 guarded

`crm/src/lib/quoteStatus.ts:50` uses `satisfies Record<QuoteStatus, …>` and fails compilation on
drift. **It is the only enum in the repo with that guard.** Every other copy is a
`Record<string, …>`, which TypeScript cannot check for exhaustiveness.

| Schema enum | Copies | Locations |
|---|---|---|
| `ConstructionType` `:79-86` | **6** | `acordApp.ts:17-24` **and** `:36-43`, `ExtractionPanel.tsx:28-35` (byte-identical to `acordApp.ts:17-24`), `DetailsCard.tsx:12-19`, `extract-lead/handler.ts:92-99`, **`:260` as an LLM prompt string** |
| `AccountType` `:24` | **5** | `crmLead.ts:16`, `lead-intake/handler.ts:33` (runtime `Set`), `NewLead.tsx:50` (cast), `:135-137` (`<option>`), `submission.ts:144` |
| `UserRole` `:58` | **4** | `auth.ts:13`, `team-admin/handler.ts:27` (runtime `Set`), `Onboarding.tsx:7-11`, `Team.tsx:146-148` |
| `PolicyStatus` `:34` | 3 | `CoverageForm.tsx:22-27`, `PoliciesTab.tsx:154`, `badges.tsx:81-86` — order differs (`CANCELLED` before `EXPIRED` in the form) |
| `QuoteStatus` `:25-33` | 3 | `quoteStatus.ts:42-50` ✅ guarded; `badges.tsx:70-78` **not** guarded — a new status silently yields a grey pill, caught only by `badges.test.tsx` |
| `DocumentCategory` `:44-55` | 2 | `DocumentsPanel.tsx:16-25` (**9 of 10 — omits `ACORD_FORM`**), `extract-lead/handler.ts:179-190` |
| `LicenseClass`/`LicenseStatus` | 2 ea | `client.ts:37-43`, `:45-51` |
| `ConstructionType`, `ReplacementCostType` `:87` | 2 | `CoverageForm.tsx:30-34` |
| `AggregateAppliesTo` `:88` | 2 | `acord25.ts:218-223`; `:224` silently defaults unknown → `"POLICY"` |
| `ExtractionStatus` `:57` | no table | 4 inline literal branches: `ExtractionPanel.tsx:172,295-298,306,314` |
| `MarketingTaskStatus` `:60` | no table | inline at `renewal-tasks/handler.ts:207,221,226`, `MarketingTasks.tsx:335` |
| `LicenseHolderType`, `LicenseResidency`, `MarketingTaskSource` | 1 ea | literal unions re-declared at `licensing/holder.ts:3`, `Onboarding.tsx:17`, `renewal-tasks/handler.ts:43` |

**Live consequence:** generated ACORD forms are written with `category:"ACORD_FORM"`
(`FormsTab.tsx:137`) and filtered on it (`:52`), but the category is **unselectable and
unlabeled** in the Documents panel because `DocumentsPanel.tsx:16-25` omits it.

**Certificate form identity:** `Certificate.formType` defaults to `"ACORD_25"`
(`resource.ts:362`, written at `CertificatesTab.tsx:96`) while the registry spells the same
form `"acord25"` (`acordRegistry.ts:19`). Two vocabularies, never reconciled.

**License "needs attention" predicate** spelled 3× independently:
`Licensing.tsx:70`, `:95`, `LicenseTable.tsx:151` — each
`lvl === "expired" || lvl === "urgent" || lvl === "soon"`.

### 4.2 Entity shapes typed more than once

**`TeamUser` — the sharpest divergence.** Writer `team-admin/handler.ts:115-123` vs reader
`Team.tsx:9-14`, bridged by an unchecked `as TeamUser[]` (`Team.tsx:53`):

| field | handler | `TeamUser` |
|---|---|---|
| `userId`, `email` | `string \| undefined` | `string` |
| `status` (`u.UserStatus`) | present | **absent** |
| `enabled` | present | **absent** |
| `groups` | `(string \| undefined)[]` | `string[]` |

An invited-but-unconfirmed user renders identically to an active one because `status` was
never typed in.

Others:
- **`Account`** — 3 form shapes hold every numeric column as `string`
  (`OverviewTab.tsx:21-42` 22 fields, `DetailsCard.tsx` 17, `NewLead.tsx:17-33` 17) and coerce
  with bare `Number()`; `Number("")` → 0, guarded only by inconsistent truthiness checks.
  **Erase semantics differ:** `OverviewTab.tsx:54-76` and `DetailsCard.tsx:85-106` write
  `|| null`; `NewLead.tsx:51-67` writes `|| undefined` for the same columns.
- **`Building`** — `sqft` is `a.integer()` in the schema, `"string, digits only"` in the
  extraction (`extract-lead/handler.ts:126`), `string | number | null` in the reader
  (`ExtractionPanel.tsx:22`), `string` in the form (`BuildingsCard.tsx:20`). **Four
  representations of one integer.** `BuildingInfo` (`acordApp.ts:26-31`) omits `accountId`/`id`;
  the extraction's building object has only `{label, sqft}` — no `streetAddress`, no
  `description`, the two fields ACORD 125 premises rows need (`acordApp.ts:331,371`).
- **`Quote`/`Policy`** — `CoverageForm.tsx:59` `existing as Policy | null` is an unchecked
  downcast on a union that may be a Quote. Bind (`QuotesPanel.tsx:295-320`) copies 18 fields
  but **drops `quote.notes`** though `Policy.notes` exists (`resource.ts:245`), and converts
  `null → undefined` 18× because Amplify create rejects `null` where update accepts it.
- **`ExtractionResult`** — `ALL_FIELD_DEFS` (`ExtractionPanel.tsx:80-131`, 24 keys) mirrors
  `EXTRACTION_SCHEMA.properties` (`extract-lead/handler.ts:75-135`) with no shared source; a key
  added on one side is silently never reviewable on the other. `required` (`:136-163`) is a
  **third** hand-written copy of the same key list within that one file.

### 4.3 `any` / casts / `!`

**`any` — 5 sites:** `extract-lead/handler.ts:322` `event: any` (papers over the
resolver-vs-self-invoke dual shape, discriminated at `:324,330` with no type) ·
`(window as any).gtag` ×4 (`AssociationLeadForm.tsx:87`, `QuoteApp.tsx:229`,
`InstantAssessment.tsx:131`, `CoverageCalculator.tsx:262`) — no ambient gtag declaration,
though `googlePlaces.tsx:14` shows the correct pattern.

**No `@ts-ignore`.** The 4 `@ts-expect-error` are intentional negative type-tests
(`useFormState.test.ts:269-275`). The one `as unknown as` is a test double
(`storage.test.ts:311`).

**Enum-widening casts** (form state is `string`, schema wants an enum):
`CoverageForm.tsx:132,140,153,160,167` · `QuotesPanel.tsx:229` · `PoliciesTab.tsx:151` ·
`DetailsCard.tsx:92` · `NewLead.tsx:50` · `lead-intake/handler.ts:63`.
`licensing/LicenseForm.tsx:83-85` uses **`as never` ×3**, which defeats all checking, not just
widening. `ExtractionPanel.tsx:195,379` also use `as never`.

**Response-shape casts** (`a.json()` ⇒ client type is `unknown`): `Team.tsx:43,53` ·
`CertificatesTab.tsx:76-77` · `ExtractionPanel.tsx:147,189,230,346` ·
`DocumentsPanel.tsx:377` and `extract-lead/handler.ts:203` (`as string[][][]`) ·
`MarketingTasks.tsx:116,121,339` · `AppetiteGuides.tsx:26`.
`FormsTab.tsx:101,113` `as string[]` after `.filter(Boolean)` — because `a.string().array()`
yields `(string|null)[]` and `filter(Boolean)` isn't a type guard; the correct predicate form is
already used at `QuotesPanel.tsx:301`, `CoverageForm.tsx:65`, `renewal-tasks/handler.ts:88`.

**Non-null `!` on data** — all in Lambdas: `process-document/handler.ts:57` `start.JobId!`,
`:100` `b.Id!`; `team-admin/handler.ts:23` `process.env.USER_POOL_ID!`, `:112` `u.Username!`.

### 4.4 JSON blob fields — writer/reader agreement

| Field / op | Writer | Reader | Agree? |
|---|---|---|---|
| `Account.aiExtraction` `:132` | `extract-lead/handler.ts:295-303` | `ExtractionPanel.tsx:139-148` | Partly — writer's `usage:{inputTokens,outputTokens}` is never declared or read; per-field shape asserted per-key, never validated. **The writer's contract lives only in the LLM prompt (`:254-260`) — a string, not a type** |
| `Document.ocrTables` `:303` | `process-document/handler.ts:166` | 2 independent copies | Shape agrees; parser duplicated 3× and the >100 KB→`undefined` case is indistinguishable from "no tables" |
| `submitWebLead` `:508` | `lead-intake/handler.ts:42,83,86` `{ok,…}` | `crmLead.ts:60-61` reads GraphQL `errors` only | **No** — `{ok:false,error:"name is required"}` returns HTTP 200 and is silently discarded |
| `startLeadExtraction` `:533` | `extract-lead/handler.ts:326,331,348` | `ExtractionPanel.tsx:209-212` ignores payload | **No** — `{ok:false}` renders as success |
| `listTeamUsers` `:525` | `team-admin/handler.ts:126` | `Team.tsx:35-53` | **No** — see §4.2 |
| `reserveCertificateNumber` `:543` | `cert-number/handler.ts:27-31` — **typed** | `CertificatesTab.tsx:76` untyped `JSON.parse` | Type exists on the writer and is erased by `.returns(a.json())` |
| `inviteUser` `:519` | `team-admin/handler.ts:96` | `Team.tsx:89-90` | Agrees by accident; both `unknown` |

Magic-link token payload has **two independent readers with no shared type**:
`magic-link/token.ts:50-58` (validates — the one disciplined parse) and
`MagicLinkSignIn.tsx:32-34` (re-implements the decode client-side).

### 4.5 The web→CRM boundary

`crmLead.ts:15-31` (15 fields) → GraphQL string `:33-46` → `resource.ts:491-507` →
`lead-intake/handler.ts:41-79`.

| `CrmLeadInput` | mutation arg | handler | Account column |
|---|---|---|---|
| `type?` union of 3 | `a.string()` — **union collapsed** `:492` | re-validates via `Set` `:44` | cast back `:63` |
| `contactEmail?` | `:496` | **dropped to notes if regex fails** `:50,54` | `a.email()` `:105` |
| `contactPhone?` | `:497` | **writes `undefined`**, phone → notes `:76` | `:107` exists, unused |
| `state?` | `:500` | **truncated to 2 chars** then uppercased `:71` | ✓ |
| `unitNumber?`, `currentCarrier?` | `:502,503` | → notes `:55,56` | **no column**; `priorCarrierName` `:144` exists and is unused |

`unitCount`, `yearBuilt`, `totalInsuredValue`, `currentPolicyExpiration` are Account columns
**no web sender can reach**. `submission.ts:143-156` sends 10 of 15 fields while holding
`unitCount`, `yearBuilt`, `propertyType`, `renewalDate`, `coverageNeeds`
(`schema.ts:91-144`) — and serializes all of them into the `notes` string
(`submission.ts:117-141`) instead.

**`notes` is the de-facto untyped overflow schema — three writers, one free-text column
(`resource.ts:154`), zero parsers:** web (`submission.ts:118-138` `Role:`, `Unit count:`,
`Coverage needs:`), handler (`lead-intake/handler.ts:52-77` `Unit:`, `Current carrier:`,
`Phone:`, `Email (unvalidated):`), ExtractionPanel (`:242` `[From documents] …`).

**Marketing-site vocabularies with no schema counterpart:** role `board/manager/owner`
(`schema.ts:58-60`) · property type `condo/townhouse/mixed/other` (`:103-106`) · coverage needs
(`:122-128`) where `ordinance` and `not_sure` have no CRM line and `Earthquake`, `Flood`,
`HO-6`, `Workers Comp` have no web option — and the web values **never reach `Quote.lines`**
(`resource.ts:181`), only `notes`.
State: 5 web values (`schema.ts:76-80`) vs 51 (`client.ts:98-103`).

Failure is invisible in both directions: `crmLead.ts:62-65` swallows every error to
`console.warn`, and the handler's `{ok:false}` is never read.

### 4.6 Typecheck coverage

No `strict:false` anywhere. The gap is **coverage**:

| File | Setting | Consequence |
|---|---|---|
| `crm/tsconfig.json:19` | `"include": ["src"]` | **`crm/amplify/**` is outside the build typecheck.** `crm/package.json` runs `tsc -b && vite build` against this config with no `references`. `data/resource.ts` is checked only incidentally because `client.ts:2` imports it — **the 7 Lambda handlers are never type-checked by any build or CI step** |
| `crm/amplify/tsconfig.json` | `strict:true`, no `include` | **No npm script invokes it.** `amplify.yml:27` runs `ampx pipeline-deploy`, which esbuild-bundles without a typecheck |
| `web/tsconfig.json:2` | `astro/tsconfigs/strict` (not `strictest`) | `noUncheckedIndexedAccess`, `noUnusedLocals`, `exactOptionalPropertyTypes` all **off** — which is what lets `submission.ts:45` `data[k]` and `schema.ts:63,221` index freely |
| `web/package.json` | **no `typecheck`/`astro check` script** | `astro build` does not typecheck; the 4 `(window as any).gtag` sites and every `crmLead.ts` mismatch are unverified |

`noUncheckedIndexedAccess` is off everywhere, and `Record<string, …>` is the repo's default
enum-table idiom (18 occurrences, §4.1) with every lookup assumed to hit.

---

## 5. MISSING PATTERNS

Ranked by the number of call sites currently improvising.

1. **A derive-from-schema convention for enums.** `quoteStatus.ts:50`'s
   `satisfies Record<QuoteStatus, …>` is the pattern that closes every row of §4.1 and is
   applied to exactly one of 21 enums. — *19 enums, ~40 hand-copied literal sites.*
2. **A validation runner.** The pieces exist (`validateAccountFields`, `validateDateRange`,
   `validateYear`, `validatePositiveInt`, `EMAIL_RE`) and 4 of 5 have zero callers. What's
   missing is the thing that would make forms reach for them: a per-field rule map returning
   `Record<keyof T, string>` so errors attach to fields. All 10 `save()` functions re-implement
   the guard-clause cascade, and every form collapses its problems into one banner
   (`problems.join(" ")` at `NewLead.tsx:43`, `DetailsCard.tsx:60`, `OverviewTab.tsx:48`).
   **No form in either app has per-field touched state or per-field error rendering.**
3. **A `<Field>` component.** The
   `<div className="field"><label>X</label><input value={form.k} onChange={…} /></div>` block
   appears **150+ times**. CRM has **zero `<form>` elements and zero `htmlFor`/`id` pairing** —
   every `<label>` is a sibling of its control (`CoverageForm.tsx:194`, `LicenseForm.tsx:130`,
   `DetailsCard.tsx:147`, `CarrierForm.tsx:88`), so no click-to-focus and nothing associated
   for screen readers; only checkbox labels wrap correctly. No Enter-to-submit except two
   ad-hoc `onKeyDown` handlers. `ContactForm.tsx:86-118` has **no `<label>` at all**.
4. **A `<StateGrid>` / `<CheckboxChipList>`.** The 50-state checkbox grid is byte-identical at
   `AppetiteGuides.tsx:270-289` ↔ `CarrierForm.tsx:229-243`, and the same `US_STATES.map` grid
   appears at `DetailsCard.tsx:150`, `LicenseForm.tsx:133`, `Carriers.tsx:218`,
   `Onboarding.tsx:162` — **6 copies.** The toggle-a-`string[]` idiom repeats at
   `CoverageForm.tsx:96-100,361-376`, `LicenseForm.tsx:195-214`, `CarrierForm.tsx:38-42,229-244`.
5. **A toast / transient notification system.** Acknowledged in-code at `SaveStatus.tsx:7`.
   `SaveStatus` covers form-adjacent feedback; nothing covers "this happened elsewhere on the
   page", which is why `Celebration` is bespoke and 9 mutations report nothing. **No
   toast/snackbar/aria-live region exists in either app** — the only `role="status"`/`role="alert"`
   in the codebase is `SaveStatus.tsx:97`, while `.error-text` is hand-rendered at ~30 sites.
6. **A shared empty/loading state.** No skeleton and no empty-state component. 10 inline
   loading implementations across 2 class conventions, 19 bespoke empty strings. Gate ordering
   differs per page — `QuotesPanel.tsx:182-186` has no loading branch (renders "No quotes yet."
   during the fetch); `QuotesList.tsx:70`, `PoliciesList.tsx:56`, `Carriers.tsx:108` have
   **neither loading nor error**, so a failed fetch is indistinguishable from an empty table.
7. **An `unwrap({data, errors})` helper.** `errors?.length` appears 33× across 22 files; 9
   mutation sites forget it entirely.
8. **A shared Lambda data-client module.** The 26-line `getDataClient()` prologue is verbatim in
   4 handlers. `pagination.ts:13` already establishes the no-imports-shareable pattern.
9. **A permission-guard primitive.** No `<RequireAdmin>`, no route-level guard in
   `App.tsx:286-300`, and **no convention that a client gate must be paired with a model
   rule** — which is exactly how `DeleteLeadZone` ended up client-only (§1.3).
10. **A shared appetite-match module** (§1.8) and **a shared ACORD header block** (§1.12).
11. **`web/src/lib/` submission + conversion helpers** (§1.7), and an ambient `gtag`
    declaration to retire 4 `as any`.
12. **A shared icon module.** `App.tsx:152-237` holds 9 inline SVGs + `iconProps`;
    `FileButton.tsx:29-34` re-declares the attribute set by hand. In `web/`,
    `CoverageCalculator.tsx:109-117` duplicates SVG paths byte-for-byte from its own sibling
    `quote/icons.tsx:56-88`, and `quote/ui.tsx:176-207,472-492` inlines SVGs while already
    importing from that module. The map-pin SVG repeats at `AssociationLeadForm.tsx:136`,
    `InstantAssessment.tsx:207`, `ContactForm.tsx:67`.
13. **A test-util module.** `deferred<T>()` ×3, `generateClient` stub ×2 (§1.9).
14. **A path alias for `shared/`.** Imported as `../../../shared/agency`
    (`crm/src/lib/agency.ts:8`) and `../../../../shared/agency`
    (`web/src/pages/get-started/[...slug].astro:5`). `shared/` currently holds only
    `agency.ts`; the cross-app duplicates in §1.7, §1.10 and §5.4 have nowhere to live.
    A drift guard already exists (`crm/src/test/sharedAgency.test.ts:211`).
15. **Splitting pure constants out of `client.ts`** so `US_STATES` doesn't drag in
    `generateClient()` (§2).

---

## FLAGGED IN PASSING

Outside the five requested categories; surfaced during the scan.

1. **Committed live credentials.** `web/scripts/sync-buildium.ts:57-60` hardcodes
   `BUILDIUM_CLIENT_ID` and `BUILDIUM_CLIENT_SECRET` as fallback defaults. Verified present in
   the working tree and in git history on `staging`. `web/.env.example:24-26` documents both as
   env vars, so the fallbacks appear unintended. Rotation is the only remediation that works —
   removing the lines does not clear history.
2. **STAFF users can delete any lead and its history through the API** — §1.3, item 1.
3. **`signatures/*` is writable by any authenticated user at a predictable key**
   (`crm/amplify/storage/resource.ts:~68`); those signatures are stamped onto issued ACORD
   certificates. Marked a KNOWN GAP in-file.
4. **Double-submit on the quote wizard's final step** — `QuoteApp.tsx:183` (§1.13).
5. **Unsanitized S3 keys** — `NewLead.tsx:95` interpolates `file.name` directly; a `/` in the
   filename breaks the OCR key parse at `process-document/handler.ts:143` (§1.6).
