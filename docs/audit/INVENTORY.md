# INVENTORY

Read-only audit of `HOAInsuranceAgency` @ `f0e07b6` (branch `staging`).
Scope: `crm/` (React SPA + Amplify Gen2), `web/` (Astro + React islands), `shared/`.
140 tracked `.ts`/`.tsx`/`.astro` files, 25,493 lines. No code was changed.

Supersedes the audit at `9a8d055`. Four of that pass's top five findings have since been
remediated (`d1b2e2a` enums, `c464605` backend typecheck, `a7c22a8` read path, `f0e07b6`
cascade delete), and `docs/audit/PATTERNS.md` records the resulting conventions. Verified
closed: **0** hand-rolled read triads remain (33 `useAsyncResource` sites, 0 surviving
`.then(setX)` fetches); `enums.ts` ↔ `resource.ts` have **no** drift and are compile-enforced;
`crm/amplify/**` is type-checked before deploy; `Account`/`Quote`/`Document` delete is
group-gated.

**The dominant finding is unchanged in kind: adoption, not absence.** Three primitives remain
built, tested, and called by nothing, against ~100 live hand-rolled call sites. Two new
categories have moved up: the write path (`{data, errors}`) has no primitive at all, and `web/`
has received none of the consolidation `crm/` has had.

---

## MASTER RANKING

Ranked by blast radius × how often it produces an inconsistency.

| # | Finding | Blast radius | Inconsistency rate | § |
|---|---|---|---|---|
| 1 | `storage.ts`, `formCodec.ts`, `useTextFilter.tsx` — built, tested, **zero callers** | 559 src + 936 test lines dead; ~100 live hand-rolled sites | Every upload, form write, filter | 1.1 |
| 2 | No `unwrap({data,errors})`; 36 sites in 3 spellings, 10 non-throwing | 24 files | Every failed write | 1.2 |
| 3 | 18 bare `.list()` bypass `listAllPages` | 12 files | Silently, at 100+ rows | 1.3 |
| 4 | `web` lead pipeline hand-rolled 5×; 4 of 5 misread FormSubmit's `200 {"success":"false"}` | 5 forms | Every rejected web lead reports success | 1.4 |
| 5 | Quote wizard's state select omits NY and OK while the site markets and prefills both | 1 select, 2 states | Every NY/OK visitor | 4.4 |
| 6 | Loading/error/empty ladder written out 12×; `Team.tsx:176` has **no error branch** | 12 list views | Failed read renders "No users found." | 5.1 |
| 7 | Extraction field catalogue hand-copied 3× across the Lambda boundary | 25 keys | Every schema/field change | 4.2 |
| 8 | `web/` has no typecheck at all — `astro build` does not check types | All of `web/src` | Silent on every `web` edit | 4.7 |
| 9 | `shared/agency.ts` unadopted in `web`: 13 literals, **3 spellings of one phone number** | 4 files | Every agency-detail edit | 1.9 |
| 10 | `Quote` and `Policy` duplicate 20 columns; `CoverageForm` casts across the union unguarded | 2 models, 1 shared form | Every coverage save | 4.3 |
| 11 | Carrier/entity name lookup duplicated 9× in 2 shapes (Map vs O(n) `.find`) | 7 files | Every carrier-name render | 1.6 |
| 12 | gtag conversion block duplicated 4×; `ContactForm` fires **none** | 4 tsx + 4 astro | 1 of 5 forms never converts | 1.5 |
| 13 | `TeamUser` consumer drops `status`/`enabled` the producer sends | 1 screen | Unconfirmed users render as active | 4.1 |
| 14 | Google Places loader 3×; `InstantAssessment` lacks the no-key guard | 3 files, 2 apps | Whenever the key is unset | 1.7 |
| 15 | Quote-wizard labels declared twice; **5 of 21 members already disagree** | 2 files, 12 uses | Every quote submission | 1.8 |
| 16 | `fmtDate` mis-parses timestamps; 5 call sites pre-slice by hand | ~20 date renders | Every timestamp render | 1.10 |
| 17 | `(x ?? []).filter(Boolean).join(", ") \|\| "—"` — 29 sites, varying separator/fallback | 12 files | Every list-cell render | 1.11 |
| 18 | `client.ts` is a 420-line grab-bag of 8 unrelated concerns; `US_STATES` drags in `generateClient()` | 8 consumers + 2 test stubs | Static | 2.3 |
| 19 | 4 validators + 2 types dead; ~30 over-exports; 4 unused `crm` deps | ~160 lines | Static | 3.2–3.4 |
| 20 | `AllMarketingTasks` (a route) and `bind()` (the Quote→Policy transition) live inside component files | 2 files | Static | 2.2 |
| 21 | Tolerant `a.json()` decoder duplicated 3×; `Team.tsx` omits the double-parse | 3 sites | On a double-encoded response | 1.12 |
| 22 | 2 deletes discard `errors` and drop the row anyway; 5 storage deletes swallow silently | 7 sites | Every refused delete | 1.13 |
| 23 | `auth.ts:13` `Role` re-types `UserRole` — documented as deliberate, enforced by nothing | 1 type | On a role change | 4.5 |
| 24 | ACORD producer/insured header written twice; success panel written twice | 4 files | Every agency-identity change | 1.14 |
| 25 | Committed live Buildium credentials (**carried over, still present**) | Credential | Static until rotated | 6.1 |

---

## 1. DUPLICATE IMPLEMENTATIONS

### 1.1 Three canonical modules with zero callers

The highest-leverage cluster in the repo. Each module is complete, documented, and covered by
a substantial test suite; each has a worse hand-rolled counterpart shipping in production.

| Module | Src | Test | Verification |
|---|---|---|---|
| `crm/src/lib/storage.ts` | 313 | 400 | Only importer is `storage.test.ts:34` |
| `crm/src/lib/useTextFilter.tsx` | 149 | 382 | Zero references outside its own test |
| `crm/src/lib/formCodec.ts` | 97 | 154 | 2 references, both comments declining to use it |

**1.1a — S3 upload / download / delete.** `crm/src/lib/storage.ts` has 0 production imports;
12 files import `aws-amplify/storage` directly instead.

| Job | Canonical (0 sites) | Live implementations |
|---|---|---|
| Upload a blob | `storage.ts:110` `uploadFile` | 7 raw `uploadData`: `FormsTab.tsx:139`, `SignatureManager.tsx:60`, `DocumentsPanel.tsx:85`, `property/PhotosCard.tsx:34`, `Settings.tsx:105`, `NewLead.tsx:102`, `CertificatesTab.tsx:145` |
| Row → upload → link | `storage.ts:164` `uploadDocument` | `DocumentsPanel.tsx:63-101`, `NewLead.tsx:84-112` |
| Download to a tab | `storage.ts:253` `downloadFile` | 3 byte-identical: `DocumentsPanel.tsx:103-106`, `DocumentSearch.tsx:61-64`, `CertificatesTab.tsx:193-197` |
| Delete an object | `storage.ts:294` `deleteFile` | 5 `remove(...).catch(() => {})`: `DocumentsPanel.tsx:112`, `PhotosCard.tsx:44,55`, `SignatureManager.tsx:97`, `DeleteLeadZone.tsx:76` |

- **Most used:** raw `aws-amplify/storage` — 12 files, ~17 call sites.
- **Most correct:** `storage.ts`. It is the only version that checks the path prefix
  (`assertGrantedPath:58`, against `GRANTED_PREFIXES:48`), sanitizes the filename segment
  (`safeSegment:81`), orders record-then-upload with ghost cleanup, distinguishes a blocked
  popup from a failed download, and returns delete failures instead of swallowing them.
  `NewLead.tsx:84-112` in particular does not delete the ghost row on failure, and interpolates
  `file.name` unsanitized into the S3 key.
- **Canonical:** `crm/src/lib/storage.ts`. Blast radius: 8 files, ~17 call sites.

**1.1b — Form-value ↔ column coercion.** `formCodec.ts` has 0 production imports.

| Impl | Location | Sites |
|---|---|---|
| Canonical `str` / `num` / `inputValue` | `formCodec.ts:58`, `:78`, `:95` | **0** |
| `x.trim() \|\| null` inline | 8 files | **36** |
| `x.trim() \|\| undefined` inline | 6 files | **17** |
| `x ? Number(x) : null \| undefined` inline | 5 files | **19** |
| File-local `num` re-declaration | `CoverageForm.tsx:27`, `AppetiteGuides.tsx:198` | 24 in-file uses |
| File-local `str` re-declaration | `CoverageForm.tsx:31`, `AppetiteGuides.tsx:166` | 21 in-file uses |

- **Most used:** inline coercion — 72 write-side sites across 11 files.
- **Most correct:** `formCodec`. The two file-local `num` copies return `NaN` for unparseable
  input where the canonical returns `null`, and write it into `a.float()` columns. The
  `|| undefined` variants are a no-op on an Amplify `update`, so a blanked field silently keeps
  its old value — `formCodec.ts:23-27` documents this bug class and names `Onboarding.tsx:91`,
  which is still present. Note the naming collision: the local `str` (column → input) runs the
  opposite direction from `formCodec.str` (input → column); `CoverageForm.tsx:29` flags this.
- **Canonical:** `crm/src/lib/formCodec.ts`. Blast radius: ~72 write sites / 11 files.

**1.1c — Text filtering.** `useTextFilter.tsx` has 0 references outside its own test.

| Impl | Location | Memoised |
|---|---|---|
| Canonical `useTextFilter` / `FilterInput` | `useTextFilter.tsx:76`, `:132` | ✅ / **0 sites** |
| Inline predicate | `AccountsList.tsx:58-65` | ❌ |
| Inline predicate | `MarketingTasks.tsx:353-360` | ❌ |
| Inline predicate + second dimension | `Licensing.tsx:65-84` | ✅ |

Search-input markup is tripled alongside it: `AccountsList.tsx:97-101` (no `type="search"`, no
aria-label), `MarketingTasks.tsx:384-390`, `Licensing.tsx:153-159`.

- **Most correct:** `useTextFilter` — the only memoised version whose `where` slot covers
  Licensing's second dimension. The two unmemoised copies re-invalidate the downstream
  `useSort` memo every render.
- **Canonical:** `crm/src/lib/useTextFilter.tsx`. Blast radius: 3 files, 6 sites.

### 1.2 Write path — `{ data, errors }` handling

Amplify resolves rather than rejects, so every mutation hand-rolls the guard. **36 sites across
24 files, in three mutually inconsistent spellings, with no primitive.**

| Spelling | Sites |
|---|---|
| `if (errors?.length) throw new Error(errors[0].message)` | `CoverageForm.tsx:146,153,160`, `QuotesPanel.tsx:108`, `ExtractionPanel.tsx:204`, `DocumentsPanel.tsx:117`, `BuildingsCard.tsx:81`, `Team.tsx:53,89`, `DeleteLeadZone.tsx:84`, `CertificatesTab.tsx:96` |
| `if (errors?.length \|\| !data) throw new Error(errors?.[0]?.message)` | `MarketingTasks.tsx:154,177`, `ExtractionPanel.tsx:243`, `SignatureManager.tsx:67`, `DocumentsPanel.tsx:80`, `DetailsCard.tsx:99`, `BuildingsCard.tsx:62`, `Carriers.tsx:66`, `Onboarding.tsx:93`, `PoliciesTab.tsx:56`, `OverviewTab.tsx:79`, `CarrierForm.tsx:76` |
| Non-throwing / ignored | `FormsTab.tsx:158`, `LicenseForm.tsx:99`, `LegacyBackfill.tsx:97`, `storage.ts:182`, `NewLead.tsx:75`, `AppetiteGuides.tsx:213`, `CertificatesTab.tsx:157`, `lead-intake/handler.ts:82`, `process-document/handler.ts:176`, `extract-lead/handler.ts:303` |

- **Most used:** spelling 2 (12 sites) — which constructs `new Error(undefined)` when `data` is
  null but `errors` is empty, yielding an empty message, rescued only by `friendlyError`'s
  `msg || fallback` (`client.ts:196`).
- **Most correct:** spelling 1, but only where `data` is genuinely unused afterward.
- **Canonical:** an `unwrap({data, errors})` in `crm/src/lib/client.ts` beside `friendlyError`
  — or in `pagination.ts` if the three Lambda sites must share it without pulling in
  `generateClient()`. Blast radius: **36 sites / 24 files.**

### 1.3 Reading a whole table

| Impl | Location | Sites |
|---|---|---|
| `listAllPages(...)` | `crm/src/lib/pagination.ts:17` | **22** |
| `(await client.models.X.list()).data` — one page, default 100 rows | 12 files | **18** |

Single-page sites: `QuotesPanel.tsx:93`, `Licensing.tsx:39,44`, `LegacyBackfill.tsx:45`,
`Dashboard.tsx:82,83`, `Team.tsx:66`, `Carriers.tsx:28,38`, `QuotesList.tsx:21,30,37`,
`AccountsList.tsx:36`, `CertificatesTab.tsx:62`, `PoliciesList.tsx:19,30,37`, `PoliciesTab.tsx:44`.

`pagination.ts:4-8` frames the problem as filter-specific, which is why every *filtered* list
migrated and no *unfiltered* one did — an unfiltered `.list()` is page-capped identically.
Within the 18, `async () => (await client.models.Carrier.list()).data` is written verbatim **5
times**; `Policy.list()` 3×; `Account.list()` 2×.

- **Most used:** `listAllPages` (22) — but the 18 holdouts are all the unfiltered reads.
- **Most correct:** `listAllPages`. **Canonical:** same, plus a no-argument `listAll(model)`
  wrapper for the unfiltered case. Blast radius: 12 files, 18 sites.

### 1.4 `web` lead submission pipeline

Identical body — `submitCrmLead` fire-and-forget → `fetch(FORMSUBMIT_URL)` with
`_subject`/`_template`/`_captcha`/`_replyto` → response check → gtag → `setSent(true)` → identical
catch — hand-rolled at 5 sites:

| Impl | Location | Response check |
|---|---|---|
| `sendQuoteEmail` | `web/src/components/quote/submission.ts:159-178` | Parses body, checks `json.success === true \|\| "true"` |
| Inline | `ContactForm.tsx:27-41` | `res.ok` only |
| Inline | `AssociationLeadForm.tsx:63-85` | `res.ok` only |
| Inline | `InstantAssessment.tsx:112-129` | `res.ok` only |
| Inline | `CoverageCalculator.tsx:245-261` | `res.ok` only |

- **Most used:** the `res.ok` form — 4 of 5.
- **Most correct:** `submission.ts:159-178`. FormSubmit returns **HTTP 200 with
  `{"success":"false"}`** on rejection, so the four `res.ok`-only variants report success on a
  rejected submission. Three of the five also duplicate the error string
  `"Something went wrong. Please try again or call 508-233-2261."` with the phone hardcoded
  (`AssociationLeadForm.tsx:96`, `InstantAssessment.tsx:140`, `CoverageCalculator.tsx:271`).
- **Canonical:** `postFormSubmit(payload)` in `web/src/lib/` (alongside the existing
  `crmLead.ts`), carrying `submission.ts`'s body check. Blast radius: 5 files, ~90 lines.

Submit-state is separately re-invented 5×: `ContactForm.tsx:11` (a 4-state union),
`AssociationLeadForm.tsx:28-30`, `InstantAssessment.tsx:49-51`, `CoverageCalculator.tsx:133-135`
(three booleans each), `QuoteApp.tsx:105-106`. The union makes `sending && sent`
unrepresentable; the boolean triples do not. `AssociationLeadForm.tsx:21-30` and
`InstantAssessment.tsx:43-51` additionally hold 10 and 9 per-field `useState` calls — the
pattern `crm`'s `useFormState` was built to replace.

### 1.5 Google Ads conversion

Byte-identical, including `send_to: "AW-18085022517/Csp3COKBgpscELWWzq9D"`, at
`AssociationLeadForm.tsx:87-93`, `InstantAssessment.tsx:131-137`,
`CoverageCalculator.tsx:262-268`, `QuoteApp.tsx:229-235`. The tag id is separately hardcoded in
4 Astro `<head>` blocks: `Layout.astro:74,79`, `quote.astro:23,28`,
`associations/[slug].astro:52,57`, `get-started/[...slug].astro:63,68`.

**`ContactForm.tsx` fires no conversion at all** — the copy-paste missed one of the five forms.

- **Canonical:** `CONVERSION_ID` + `fireConversion()` in `web/src/constants.ts` (already the
  home of `FORMSUBMIT_URL`, `QUOTE_URL`); the Astro blocks read the id from it.
  Blast radius: 8 files.

### 1.6 Entity-name lookup (id → display name)

| Shape | Location | Cost |
|---|---|---|
| A — `useMemo` + `new Map(...)`, `.get(id) ?? "—"` | `PoliciesList.tsx:43-50` (used `:104,106`) | O(1)/cell |
| A — byte-identical to the above | `QuotesList.tsx:43-50` (used `:114,116`) | O(1)/cell |
| B — `carriers.find(c => c.id === id)?.name ?? "—"` | `QuotesPanel.tsx:121-122` | O(n)/cell |
| B — byte-identical to the above | `PoliciesTab.tsx:66-67` | O(n)/cell |

The carrier fetch feeding these is itself repeated 7× (§1.3), and
`const { sorted: carriers } = useSort(carrierRows, { name: (c) => c.name }, "name");` is verbatim
at `QuotesPanel.tsx:119` and `PoliciesTab.tsx:64`.

- **Most correct:** shape A. **Canonical:** a `useLookup(items, key, label)` in `crm/src/lib/`
  plus a shared `useCarriers()`. Blast radius: 7 files, 9 fetch + 4 lookup sites.

### 1.7 Google Places loader

| Impl | Location | Dedupe | No-key guard | Parses |
|---|---|---|---|---|
| `googlePlaces.tsx` | `crm/src/lib/googlePlaces.tsx:21-34`, `:43-101` | ✅ module `loadPromise` | ✅ | address/city/state/zip |
| Inline | `CoverageCalculator.tsx:20-44`, `:158-197` | ❌ | ✅ | state only |
| Inline | `InstantAssessment.tsx:9-21`, `:62-91` | ❌ | ❌ | state only |

`InstantAssessment` injects `?key=&libraries=places` and fails with `InvalidKey` when the key is
unset. The crm helper is used 2× (`NewLead.tsx:177`, `DetailsCard.tsx:112`); the autocomplete
fill is duplicated verbatim between those two call sites.

- **Most correct / canonical:** `crm/src/lib/googlePlaces.tsx` — promote the *loader* (not the
  React component; the two apps render different inputs) to `shared/googlePlaces.ts`, per the
  dependency-free `shared/agency.ts` convention. Blast radius: 3 files, 2 apps.

### 1.8 Quote-wizard option labels — declared twice, already drifted

| Impl | Location | Sites |
|---|---|---|
| Labels on each `Option` inside `STEPS` | `web/src/components/quote/schema.ts:57-198` | Rendered by `QuoteApp` via `CardOption` |
| `ROLE_LABELS`, `COVERAGE_LABELS`, `PROPERTY_LABELS`, `HO6_LABELS`, `DEDUCTIBLE_LABELS` | `web/src/components/quote/submission.ts:11-41` | 12 uses (`:63,78,84,96,100,118,123,127,131,137`) |

**5 of 21 members already disagree** — the visitor sees one wording, the agent's email and the
CRM note say another:

| Visitor sees (`schema.ts`) | CRM/email gets (`submission.ts`) |
|---|---|
| `Unit owner (HO‑6)` | `Unit Owner (HO-6)` |
| `Yes, I know it` | `Yes, knows the amount` |
| `Review my existing policy` | `Review existing policy` |
| `New HO‑6 policy` | `New HO-6 policy` |
| `Not sure — help me figure it out` | `Not sure — needs guidance` |

(Two of the five differ only by U+2011 vs ASCII hyphen.)

- **Most correct:** `schema.ts` — it is what the visitor actually saw, and it is exhaustive by
  construction.
- **Canonical:** export `labelFor(stepKey, value)` derived from `STEPS`; delete all 5 maps.
  Blast radius: 2 files, 12 sites. This is a correctness fix, not tidying.

### 1.9 Agency contact facts

`shared/agency.ts:27-49` is the documented single source (`:24`: "edit `AGENCY` only"), surfaced
to `web` via `constants.ts:3-8`. `ContactForm.tsx` uses it correctly (`:60,64,68,121`). These do
not — **13 literals across 4 files**:

`AssociationLeadForm.tsx:96,116,117,251,252` · `InstantAssessment.tsx:140,160,161,269,270` ·
`CoverageCalculator.tsx:271` · `QuoteApp.tsx:243,418`.

**Three spellings of one phone number now exist:** `508-233-2261` (matches `AGENCY.phone`),
`+15082332261` (matches `AGENCY_FMT.phoneHref`), and `(508) 233-2261` at `QuoteApp.tsx:243` —
which matches nothing and would survive any edit to `shared/agency.ts`.
`crm/src/test/sharedAgency.test.ts:230` asserts a changed phone propagates, but guards only
`shared/` and cannot see these literals.

- **Canonical:** `AGENCY`/`AGENCY_FMT` via `constants.ts`. Blast radius: 4 files, 13 literals.

### 1.10 Date construction and rendering

| Idiom | Sites |
|---|---|
| `new Date().toISOString().slice(0, 10)` (UTC today) | `MarketingTasks.tsx:50`, `FormsTab.tsx:136`, `Dashboard.tsx:328`, `acordApp.ts:166` — **4** |
| `new Date().toISOString()` (timestamp column) | `QuotesPanel.tsx:332`, `MarketingTasks.tsx:65,151`, `CertificatesTab.tsx:119` — **4** |
| `new Date().getFullYear()` (max-year bound) | `client.ts:145,284`, `DetailsCard.tsx:45` — **3** |
| `fmtDate(x.slice(0, 10))` — pre-slicing a stored timestamp | `MarketingTasks.tsx:303`, `Team.tsx:237`, `AccountDetail.tsx:87`, `DocumentSearch.tsx:155`, `CertificatesTab.tsx:337` — **5** |

`fmtDate` (`client.ts:114-117`) only appends `T00:00:00` when the string is exactly 10
characters, so a full ISO datetime is parsed as a UTC instant and rendered on the viewer's local
calendar — shifting a day for US users. The guard is call-site discipline, not the function's:
five sites each independently pre-slice. `fmtDateTime` (`client.ts:407`) handles this internally
and has 1 call site.

- **Canonical:** fold the slice into `fmtDate`; add `isoToday()`/`isoNow()` beside `daysUntil`.
  Blast radius: 9 files, 16 sites. Money formatting is **not** duplicated —
  `client.ts:104-118` is sole, and `acordFormat.ts:16,27` are documented blank-vs-`—` wrappers.

### 1.11 List-cell join

`(x ?? []).filter(Boolean).join(", ") || "—"` — **29 sites across 12 files**, with the separator
(`", "` / `" "`) and fallback (`"—"` / `null` / `"carrier default"` / `"no location"`) varying per
site: `QuotesPanel.tsx:129,205` · `MarketingTasks.tsx:197,259,356,368,437` · `Licensing.tsx:79` ·
`LicenseTable.tsx:232` · `Carriers.tsx:165,276` · `Dashboard.tsx:213` ·
`AccountsList.tsx:75,76,153,158` · `AccountDetail.tsx:86` · `PoliciesTab.tsx:75,142` ·
`CertificatesTab.tsx:280` · `AppetiteGuides.tsx:110,124` · `acord25.ts:298` · `googlePlaces.tsx:77`.

- **Canonical:** `joinList(values, { sep, empty })` in `crm/src/lib/client.ts` beside `fmtNum`.

### 1.12 Tolerant `a.json()` decoder

Three independent implementations of "parse a possibly-double-stringified `a.json()` value,
return null/`{}` on failure": `ExtractionPanel.tsx:131-140`, `DocumentsPanel.tsx:369-378`,
`extract-lead/handler.ts:189-201`. Two do the double `JSON.parse`; **`Team.tsx:36-45` does not**,
so a double-encoded `listTeamUsers` response silently renders an empty roster.

- **Canonical:** `crm/src/lib/pagination.ts` — the established Lambda-safe, no-runtime-imports
  module. `client.ts` cannot host it, since `extract-lead` must import it.

### 1.13 Delete — errors checked vs swallowed

| Shape | Location |
|---|---|
| Checks `errors`, throws, reports via `useSaveStatus` | `BuildingsCard.tsx:74-86`, `DocumentsPanel.tsx:108-127`, `DeleteLeadZone.tsx:32-36,83-84` |
| Result ignored; row removed from local state regardless | `Licensing.tsx:115-118`, `AppetiteGuides.tsx:39-42` |

A refused delete under the second shape removes the row from the table and reports success. Both
are wired to `<ConfirmButton>`, which has an `onError` slot neither uses. Separately, all 5
storage deletes swallow with `.catch(() => {})` (§1.1a).

### 1.14 ACORD header and success panel

- **ACORD producer/insured header** — the same date + 7 producer + 9 insured fields, same
  `AGENCY.*` bindings, written twice: `crm/src/lib/acord25.ts:36-93` and
  `crm/src/lib/acordApp.ts:114-196`. `acordRegistry.ts:36-39` documents that these headers are
  shared across every eForm.
- **Success panel** — structurally identical (same 64×64 SVG, same `#d1b378`/`#d1b37820` fills,
  same `M20 32l8 8 16-18` path) at `AssociationLeadForm.tsx:102-122` and
  `InstantAssessment.tsx:146-166`, differing only in class prefix and copy. A third checkmark
  variant at `ContactForm.tsx:76-79` (48×48, CSS variables instead of hex).
- **Lead-form CSS** — `AssociationLeadForm.css:9-211,308-383` ≈ `InstantAssessment.css:9-156,257-327`;
  the Places dropdown override is duplicated at `CoverageCalculator.css:451-469` ↔
  `InstantAssessment.css:328-346`.

### 1.15 Verified single-source (no action)

`useAsyncResource` (33 sites, 0 hand-rolled survivors) · `useSaveStatus`/`SaveStatus` (16) ·
`useSort` (19) · `badges.tsx` · `enums.ts` · `quoteStatus.ts` · `pagination.ts` ·
`friendlyError` (15 + 2 hooks) · `validateAccountFields` (3) · `auth.ts` (`useIsAdmin` ×3) ·
`shared/accountType.ts` (compile-enforced both directions at `enums.ts:61-65`).
Zero `window.confirm`, zero `alert(` in `crm`. `<ConfirmButton>` has 6 sites and no competitor;
`<Modal>` has 1 (`FilePreview.tsx:43`) — under-used, not duplicated.

---

## 2. FILE SIZE OFFENDERS

Per-app weight: `crm/src` 18,528 lines / 85 files (61%) · `web/src` 8,618 / 44 ·
`crm/amplify` 2,249 / 23 · `shared/` 106 / 2 (0.3%).

### 2.1 Over 500 lines

| File | Lines | Distinct responsibilities |
|---|---|---|
| `crm/src/lib/client.test.ts` | 711 | **7 unrelated units in one file:** mock + oracle `1-35` · `EMAIL_RE` `36-78` · `friendlyError` `79-193` · `validateDateRange` `194-295` · `validateYear` `296-368` · `validatePositiveInt` `369-462` · `daysUntil` + TZ harness `464-628` · `fmtDateTime` `629-711`. Exists as one unit only because `client.ts` does; 4 of the 7 subjects have no production caller |
| `crm/amplify/data/resource.ts` | 615 | 5 concerns: 21 enum declarations `20-88` · entity models `90-335` · remaining models `337-513` · 5 custom operations `515-573` · schema authorization + `defineData` `575-615`. Single-responsibility by nature; ~40% is load-bearing auth prose. `Quote`/`Policy` duplicate 20 columns (§4.3) |
| `web/src/styles/quote.css` | 604 | 21 sections, 1:1 with `quote/ui.tsx`. Splits only when that component splits |
| `web/src/data/properties.json` | 578 | 64 pretty-printed property records. Pure data, not an offender in substance |
| `crm/src/styles.css` | 515 | **20 unrelated sections for the entire CRM.** Only `1-232` is genuinely global; `249-311` celebration, `335-368` preview modal, `376-411` auth screen, `412-447` premium chart, `448-499` licensing, `500-515` signature pad are feature-local and belong beside their components — which is what `web/` already does |
| `crm/src/pages/Dashboard.tsx` | 514 | **4 components + 2 pure functions, all three layers.** Fetch (6 parallel queries) `44-104` · shell `105-153` · `Tile` `155-168` · `RenewalsCard` `170-307` (business logic `193-232`) · `CarrierCharts` `309-455` (date presets `320-341`, aggregation `343-386`) · `BarCard` `457-514`. `193-232` and `354-386` are React-free pure functions belonging in `crm/src/lib/` |

### 2.2 Misplaced responsibilities (independent of line count)

- **`crm/src/components/MarketingTasks.tsx:325-454`** — `AllMarketingTasks` is the route-level
  `/tasks` **page**, with its own state, fetch, sort and render, living in a component file. Also
  `settleSatisfiedTasks` (`:42-71`) performs API **writes** from a render module, and
  `taskUrgency` (`:22-40`) is domain classification. Both belong in `crm/src/lib/` beside
  `quoteStatus.ts`.
- **`crm/src/components/QuotesPanel.tsx:290-343`** — `bind()` creates a Policy, flips the Account
  to CLIENT and updates the Quote: the lifecycle transition documented at `resource.ts:12-15`,
  and the single most consequential write in the app, living inside a form component. It also
  exports two formatters (`commissionCell:22`, `termsSummary:34`) that `PoliciesTab.tsx:12`
  imports — a page reaching into a component file for pure functions.
- **`crm/src/pages/account/CertificatesTab.tsx:132-198`** — `generatePdf`/`downloadPdf` call
  `uploadData`/`getUrl` directly, bypassing `storage.ts` (§1.1a). The clearest single
  misplacement in the repo.
- **`crm/src/lib/client.ts:46-81`** — `licenseHealth` imports `urgencyBadge`/`LICENSE_EXPIRY_SCALE`
  from `badges.tsx`: a lib module reaching into presentation. The one true layering violation.
- **`crm/src/lib/enums.ts:213-221`** — `ACORD25_AGGREGATE_FIELDS` is ACORD form-field mapping in
  the enum module; belongs with `acordRegistry.ts`/`acord25.ts`.

### 2.3 350–500 (secondary tier, 20 files — 6 tests)

| File | Lines | Notes |
|---|---|---|
| `SaveStatus.test.tsx` | 494 | One module tested three ways. Legitimate |
| `web/src/components/quote/ui.tsx` | 492 | **13 unrelated presentational components**, bound only by `useTheme`. Clean layer separation; a mechanical split into `quote/ui/` |
| `CoverageCalculator.css` | 492 | Co-located, one feature |
| `web/src/components/CoverageCalculator.tsx` | 485 | Places loader `20-45` · state map `47-64` · **underwriting rule engine `66-107`** · icons `109-124` · dual submission `207-292` · 190 lines JSX `293-485`. Mixes all three layers |
| `MarketingTasks.tsx` | 454 | See §2.2 |
| `useAsyncResource.test.ts` | 440 | Single module, 7 behaviour groups. Justified |
| `web/src/components/QuoteApp.tsx` | 435 | Theme + `localStorage` + 60s interval `32-86` · flow `88-147` · handlers `149-216` · `submitForm` `217-251` · 5 renderers `278-435`. `33-69` belongs in `quote/theme.ts`/`session.ts`, which already exist; `217-251` duplicates `quote/submission.ts` |
| `crm/src/lib/acordApp.ts` | 427 | One 327-line function (`buildAppFormValues:87-413`) of 6 independent field groups that never reference each other |
| `crm/src/lib/client.ts` | 420 | **The grab-bag — 8 concerns:** Amplify client + 12 type aliases `1-19` · `listAllPages` re-export `21-25` · `LINES_OF_AUTHORITY` `27-45` · `licenseHealth` `46-81` · `US_STATES`/`LINES_OF_BUSINESS` `83-102` · formatters `103-118` · `validateAccountFields` `119-156` · `friendlyError` `157-198` · validators `199-316` · date arithmetic `317-420`. Natural split: `client.ts` (1-25), `format.ts`, `validate.ts`, `dates.ts`, `licensing.ts`. **Coupling defect:** `generateClient()` at module scope means all 8 consumers of a pure constant like `US_STATES` construct the network client; two test files carry identical stubs solely to work around it |
| `ExtractionPanel.tsx` | 416 | Types `14-40` · helpers `42-70` · **58-line field catalogue `72-130`** · decoder `131-140` · 4s poll `142-196` · `apply()` `214-273` · 141-line review table `275-416` |
| `AssociationLeadForm.css` | 408 | Near-identical to `InstantAssessment.css` (§1.14) |
| `enums.test.ts` | 408 | Single subject, but `330-349` tests the extraction Lambda and `388-408` tests `shared/accountType.ts` — both belong with their subjects |
| `storage.test.ts` | 400 | Cohesive — 400 lines testing code nothing calls (§3.1) |
| `QuotesPanel.tsx` | 386 | See §2.2 |
| `CoverageForm.tsx` | 386 | Size is field count (24-key form), not tangled responsibility. GL-limits block `301-350` is the 6-field shape declared on both Quote and Policy |
| `CertificatesTab.tsx` | 383 | 3 parallel fetches `22-84` · `issue()` `86-130` · `generatePdf()` `132-191` · form `237-302` · table `316-374` |
| `useTextFilter.test.tsx` | 382 | 382 lines testing code nothing calls (§3.1) |
| `DocumentsPanel.tsx` | 378 | **Two features fused:** document CRUD, and an OCR text-search/viewer (`129-178` + `295-360`, ~110 lines) |
| `InstantAssessment.css` | 371 | Duplicated against `AssociationLeadForm.css` |
| `crm/src/lib/enums.ts` | 356 | Cohesive by design; size is the enum count |

---

## 3. DEAD CODE

Method: 291 named exports extracted across `crm/src`, `crm/amplify`, `web/src`, `web/scripts`,
`shared/`; every relative import specifier resolved into an import graph; per-symbol counts
cross-checked by word-boundary grep over the full repo including tests and configs. Framework
default exports excluded.

### 3.1 Modules dead in production — 1,495 lines

The three modules in §1.1. Their only importers are their own test files
(`storage.test.ts:34`, `useTextFilter.test.tsx:5`, `formCodec.test.ts:2`). They are the only
files unreachable from any production entry point.

**559 source + 936 test lines covering nothing shipped.** Security-relevant: `assertGrantedPath`
(`storage.ts:58`) and `safeSegment` (`storage.ts:81`) are a path guard and a filename sanitizer
that enforce nothing today — `GRANTED_PREFIXES` (`storage.ts:48`) is checked only inside the
dead module.

### 3.2 Exports with no production consumer

**Dead logic (test-only, ~160 lines):** `client.ts:252` `validateDateRange` · `:277`
`validateYear` · `:298` `validatePositiveInt` · `:219` `EMAIL_RE`. Between them, 89 test
assertions and zero call sites, while §5.2 lists 7 live hand-rolled re-implementations.
`client.ts:200-206` is a commented usage example for a migration that never landed.
`EMAIL_RE`'s own doc comment says "Exported so `web` can drop its private copy" — the copy at
`web/src/components/quote/schema.ts:25` is still there.

**Fully dead — zero references anywhere:** `shared/agency.ts:72` `Agency` · `:73`
`AgencyFormatted`. The only mention is prose in this document.

**Test-only exports of otherwise-live modules** (over-exported, logic live):
`quoteStatus.ts:97` `ALL_QUOTE_STATUSES` · `:105` `CLOSED_QUOTE_STATUSES` · `enums.ts:284`
`USER_ROLES` · `badges.tsx:52` `BadgeMap`, `:179` `UrgencyScale` · `SaveStatus.tsx:56`
`SaveStatusValue` · `enums.ts:44,48,50-53` (6 derived enum types).

**Unnecessary `export` — used only inside the defining file** (~30):
`magic-link/token.ts:13` `TOKEN_TTL_MS` · `ConfirmButton.tsx:19` · `Modal.tsx:36` ·
`SaveStatus.tsx:45,134,136,143,176` · `badges.tsx:46,137,166,169` · `client.ts:46`
`LicenseLevel` · `enums.ts:72` `EnumOption` · `quoteStatus.ts:57,59,61,127` ·
`useAsyncResource.ts:45,71` · `useFormState.ts:48,125` · `sync-buildium.ts:77` `Property`.

### 3.3 Routes

**CRM — clean.** All 12 routes in `App.tsx:286-300` have inbound navigation. `/quotes` and
`/policies` are absent from `NAV_ITEMS` (`App.tsx:239-247`) but reached via Dashboard tiles
(`Dashboard.tsx:135,140`). No linked path lacks a route.

**Web — two unlinked families, both apparently intentional:**
- `/get-started` + 7 slugs (`web/src/pages/get-started/[...slug].astro`) — zero inbound links
  site-wide; the only `get-started` strings are its own `canonical` (`:55`) and `og:url`
  (`:60`). It **is** in the sitemap, so it reads as paid-landing. Note it is the sole importer
  of `web/src/components/InstantAssessment.tsx` (~275 lines).
- `/associations/{slug}` — zero inbound links, explicitly excluded from the sitemap
  (`astro.config.mjs:10-12`, "PM-distributed links, not organic SEO targets") and `noindex`.

### 3.4 Orphaned components — none

Every file under `crm/src/components`, `crm/src/pages` and `web/src/components` has at least one
production importer, verified per-file by exact relative-specifier grep. `Team.tsx` and
`Licensing.tsx` are live via `Settings.tsx` despite not being routed directly. All 11 Amplify
`defineFunction`/`defineAuth`/`defineStorage` exports are wired into `backend.ts` or
`data/resource.ts`.

### 3.5 Commented-out code — none

Every `//` and `/* */` candidate resolved to a doc comment, a doc example
(`client.ts:200-206`), prose (`PhotosCard.tsx:78-80`), or string content
(`accept="image/*,.pdf"` at `PhotosCard.tsx:150`, `resource.ts:437`). No disabled executable
code, no `TODO`/`FIXME`/`HACK`, no `if (false)`, no feature flags.

### 3.6 Unused dependencies

`crm/package.json` — 4: `esbuild` (`:50`, zero references, not in `overrides`) · `constructs`
(`:49`, zero imports; peer of `aws-cdk-lib` — verify CDK synth before removing) · `tsx` (`:52`,
no `crm` script invokes it, unlike `web`'s `sync`) · `@testing-library/dom` (`:38`, peer of
`@testing-library/react`).

Retained despite naive-grep misses: `@types/aws-lambda`, `@types/google.maps`,
`@aws-amplify/backend-cli` (`ampx`). **`web/package.json` is clean** — all 10 deps used.

### 3.7 Removable total

| Item | Lines |
|---|---|
| `storage.ts` + test | 713 |
| `useTextFilter.tsx` + test | 531 |
| `formCodec.ts` + test | 251 |
| 3 validators + `EMAIL_RE` + their `client.test.ts` blocks | ~160 |
| `Agency`, `AgencyFormatted` | 2 |

**~1,657 lines** — but §1.1 and §5.2 are the reason to *adopt* the first three rather than
delete them.

---

## 4. TYPE DRIFT

Baseline: this is a well-typed repo. `client.ts:8-19` aliases all 12 models off `Schema`;
`enums.ts:40-65` derives 14 enums with `satisfies` exhaustiveness plus a bidirectional assertion
pinning `shared/accountType.ts`. **`enums.ts` ↔ `resource.ts` have no drift and cannot acquire
any silently.** What follows is the residue.

### 4.1 `TeamUser` — producer/consumer divergence

Writer `team-admin/handler.ts:117-124` vs reader `Team.tsx:10-15`, bridged by an unchecked
`as TeamUser[]` at `Team.tsx:54`:

| Field | Handler | `TeamUser` |
|---|---|---|
| `userId` | `string \| undefined` | `string` — used as the React `key` (`:197`) |
| `email` | `string \| undefined` | `string` — compared to `profile.email` (`:200`) |
| `groups` | `(string \| undefined)[]` | `string[]` |
| `status` (`u.UserStatus`) | present | **absent** |
| `enabled` (`u.Enabled ?? true`) | present | **absent** |

An invited-but-unconfirmed user renders identically to an active one. Separately, `Team.tsx:119`
and `:211` treat `u.groups[0]` (a Cognito group) and `p?.role` (schema `UserRole`) as the same
value type; they coincide by convention, documented at `enums.ts:297-302` but not typed.

### 4.2 Extraction result — three hand-written copies of one key list

Both sides describe `Account.aiExtraction` (`resource.ts:144`, `a.json()`).

| | Consumer `ExtractionPanel.tsx:14-27` | Producer `extract-lead/handler.ts:41-65,116-128` |
|---|---|---|
| `value` | `string \| number \| boolean \| null` | `{type:"string"}` only; `""` means absent |
| `evidence`/`source` | `string \| null` | `{type:"string"}`, never null |
| `buildings[]` | `{label?, sqft?}` both optional | `{label: string; sqft: string}` both **required** |
| `usage` | absent | written at `handler.ts:296-299` |
| shape | `[key: string]: unknown` | 26 named keys, `additionalProperties: false` |

`ALL_FIELD_DEFS` (`ExtractionPanel.tsx:72-123`, 25 keys) must simultaneously match
`EXTRACTION_SCHEMA.properties` (`handler.ts:134-162`) **and** `Account` column names for
`kind:"patch"` entries, with nothing checking either. `required` (`handler.ts:136-163`) is a
third hand-written copy of the same key list inside one file. That is what
`patch: Record<string, unknown>` (`ExtractionPanel.tsx:218`) hides, spread straight into
`Account.update({id, ...patch})` at `:239-242`. Casts papering the gap:
`ExtractionPanel.tsx:139,181,222,338`, plus `as never` at `:187,371`.

### 4.3 `Quote` and `Policy` — 20 duplicated columns

`resource.ts:206-229` and `:254-274` declare the same 20 columns verbatim (`lines`, `premium`,
`commissionPct`, `gl*`×6, `glClaimsMade`, `glAggregateAppliesTo`, `perOccurrenceDeductible`,
`perUnitDeductible`, `blanketLimit`, `coinsurancePct`, `replacementCostType`, `effectiveDate`,
`expirationDate`, `notes`). Only `status` differs, plus `policyNumber`/`quoteId`. There is no
shared fragment. `CoverageForm.tsx` serves both and pays for it:

- `:50` `existing as Policy | null` — unguarded cast of a `Quote | Policy` union, purely to read
  `policyNumber` at `:54`.
- `:55` `status` widened to `string` in form state, re-narrowed three times by assertion
  (`:144` `as Policy["status"]`, `:151`/`:158` `as Quote["status"]`). Nothing checks the string
  belongs to the right union — a `PolicyStatus` value can be assigned to a Quote.
- `:123`, `:131` — the same string→enum widening for `replacementCostType`,
  `glAggregateAppliesTo`.

Same `<select>`-value-asserted-into-a-schema-enum pattern, with no `isX()` guard, at
`PoliciesTab.tsx:152`, `QuotesPanel.tsx:229`, `DocumentsPanel.tsx:187`, `DetailsCard.tsx:83`,
`NewLead.tsx:55`, `Onboarding.tsx:179` — despite `enums.ts` already shipping `isUserRole`
(`:303`) and `isAccountType` (`:354`) as the pattern.

### 4.4 The web→CRM boundary

`web/src/lib/crmLead.ts:17-35` `CrmLeadInput` is **field-for-field identical** to
`submitWebLead`'s arguments (`resource.ts:520-535`), and `type?: AccountType` correctly imports
from `shared/accountType.ts`. Three problems remain:

1. **The GraphQL document (`crmLead.ts:37-50`) is a third hand-written copy** of the same 15
   parameter names, restated twice within itself (declaration + argument) and checked by nothing.
   A renamed schema argument compiles clean in both apps, fails at runtime, and is swallowed by
   `submitCrmLead`'s fail-soft catch (`:66-69`) into a `console.warn`.
2. **Fields typed as first-class inputs but stored as prose.** `contactPhone` (`:22`) is sent and
   then discarded at `lead-intake/handler.ts:69` (`contactPhone: undefined`) and re-encoded into
   `notes` at `:77`. `unitNumber` and `currentCarrier` (`:29-30`) have **no `Account` column at
   all** and are folded into `notes` at `handler.ts:56-57`.
3. **`FormData` is an untyped string bag.** `quote/schema.ts:216`
   `Record<string, string | string[]>` is the wizard's entire state; field names are string
   literals with no relation to `CrmLeadInput` keys, and `submission.ts:45,108` defend with
   `typeof data[k] === "string" ? … : ""`. `session.ts:42-54` rehydrates it from `localStorage`
   through three unchecked casts.

**Live defect at this boundary — the state select.** `web/src/data/states.ts` serves six states
(`MA:17`, `RI:34`, `NH:51`, `CT:68`, **`NY:85`, `OK:102`**) and `quote/session.ts:80-87`
prefills all six from the URL slug — but the wizard's own select
(`quote/schema.ts:75-82`) offers only `MA`, `RI`, `CT`, `NH`, `OTHER`. A visitor arriving from
`/hoa-insurance-new-york` is prefilled `state: "NY"`, which the select cannot represent, and
`submission.ts:152` then drops it as neither a listed option nor `"OTHER"`. Both states are
marketed on `index.astro:55`.

### 4.5 `auth.ts:13` `Role` — the one hand-written enum copy left

```ts
export type Role = "ADMIN" | "STAFF" | "PRODUCER";
```

`PATTERNS.md:49-50` records this as deliberate: these are Cognito *groups* declared in
`amplify/auth/resource.ts:20`, a different source of truth from `UserRole` (`resource.ts:58`,
derived at `enums.ts:44`). The members currently agree; **nothing enforces either the schema
side or the Cognito side.** Consumed at `auth.ts:44` `roleFromGroups` and
`Onboarding.tsx:4,42,86`, where the value is written into `UserProfile.role`. Adding a fourth
role compiles clean and fails at runtime. Listed as unenforced, not as a rule violation.

### 4.6 `any`, casts, `!`

**`any` — 5 sites.** `extract-lead/handler.ts:318-319` `event: any` hides a genuine two-shape
union — the AppSync resolver event (`event.arguments.accountId`, `:327`) and the self-invoke
worker payload (`event.work.accountId`, `:321`, produced at `:337-343`) — and forfeits the
schema's `startLeadExtraction` argument type. Every sibling handler is properly typed
(`lead-intake/handler.ts:37` uses `Schema["submitWebLead"]["functionHandler"]`;
`team-admin/handler.ts:131` uses `AppSyncResolverEvent<…>`).
`(window as any).gtag` ×4 — `QuoteApp.tsx:229`, `AssociationLeadForm.tsx:87`,
`InstantAssessment.tsx:131`, `CoverageCalculator.tsx:262` — hides the absence of a `Window`
augmentation, though `googlePlaces.tsx:14` shows the correct pattern in-repo.

**`list()` looseness asserted away.** `MarketingTasks.tsx:115` states it outright — "list()
yields a structurally looser type than the model type" — then casts at `:116,121,343`; also
`AppetiteGuides.tsx:24`. The looseness is real (lazy-loader properties that `listAllPages<T>`
erases); the fix belongs in `listAllPages`' signature, not at each call site.

**No `@ts-ignore`.** The 4 `@ts-expect-error` are intentional negative type-tests
(`useFormState.test.ts:269-275`); the one `as unknown as` is a test double
(`storage.test.ts:311`). `as never` ×5 defeats checking rather than widening:
`LicenseForm.tsx:83-85`, `ExtractionPanel.tsx:187,371`.

**Non-null `!`** — `team-admin/handler.ts:27` `process.env.USER_POOL_ID!`, `:114` `u.Username!`.
Minor: `Settings.tsx:32` and `AccountDetail.tsx:36` cast `searchParams.get("tab")` *before* the
membership check on the next line (order backwards, harmless); `Licensing.tsx:235`
`editing.holderType as HolderType` + `adding!`.

### 4.7 Typecheck coverage

No `strict:false` anywhere, and `crm/amplify/**` is now gated (`c464605`,
`npm run typecheck:backend` in the `backend` phase of `amplify.yml`, ahead of
`ampx pipeline-deploy`). The remaining gap is **`web`**:

| File | Setting | Consequence |
|---|---|---|
| `web/package.json` | **no `typecheck`/`astro check` script** | `astro build` does not type-check. Nothing verifies `web/src` — including the 4 `(window as any).gtag` sites, the `CrmLeadInput` contract the CRM depends on, and the untyped `FormData` bag |
| `web/tsconfig.json:2` | `astro/tsconfigs/strict`, not `strictest` | `noUncheckedIndexedAccess`, `noUnusedLocals`, `exactOptionalPropertyTypes` off — which is what lets `submission.ts:45` and `schema.ts:63,221` index freely |

Adding it needs `@astrojs/check` + `typescript` as `web` devDependencies. `PATTERNS.md:133-136`
already records this as the open half of the backend-typecheck work.

### 4.8 All five custom operations return `a.json()`

`resource.ts:537,548,554,562,571`. Every consumer re-invents the parse (§1.12), and the return
type is erased at the boundary even where the writer has one —
`cert-number/handler.ts:27-31` is typed, and `CertificatesTab.tsx:76` reads it through an
untyped `JSON.parse`.

---

## 5. MISSING PATTERNS

Evidence threshold: 3+ independent hand-rolled sites. Ranked by call sites currently improvising.

1. **`unwrap({data, errors})`** — §1.2. **36 sites / 24 files**, three spellings, 10 of them
   non-throwing. Lives in `crm/src/lib/client.ts` beside `friendlyError`, or `pagination.ts` if
   the 3 Lambda sites must share it.
2. **A loading/error/empty ladder component.** The identical four-branch JSX —
   `!loaded ? "Loading…" : error ? <p className="error-text"> : rows.length === 0 ? <p className="muted small"> : <table>`
   — is written out **12 times**: `PoliciesList.tsx:76-81`, `QuotesList.tsx:88-93`,
   `Carriers.tsx:125-130`, `AppetiteGuides.tsx:86-91`, `PoliciesTab.tsx:112-119`,
   `CertificatesTab.tsx:308-313`, `FormsTab.tsx:248-253`, `MarketingTasks.tsx:402-410`,
   `AccountsList.tsx:111-116`, `BuildingsCard.tsx:115-118`, `Dashboard.tsx:110-121`, and
   **`Team.tsx:176-179` — which has only three branches, omitting the error case, so a failed
   team read renders "No users found."** `PATTERNS.md:158-167` specifies the ladder in prose but
   ships no component. A `<ResourceBody res={…} empty="…">` in `crm/src/lib/` closes the Team
   bug by construction. — *12 files.*
3. **A `web` submit pipeline** — §1.4. `submitToFormSubmit()` + `useSubmit()` in
   `web/src/lib/`. — *5 forms.*
4. **A reference-data cache** — §1.6. `useCarriers()` over `useAsyncResource`, plus a generic
   `useLookup(items, key, label)`. — *9 fetch sites, 4 lookup sites.*
5. **`listAll(model)`** — the unfiltered counterpart to `listAllPages`, in
   `crm/src/lib/pagination.ts`. — *18 sites / 12 files.*
6. **`trackConversion()` + `CONVERSION_ID`** — §1.5, in `web/src/constants.ts`. — *8 files.*
7. **A tolerant `a.json()` unwrapper** — §1.12, in `crm/src/lib/pagination.ts`. — *3 sites,
   one of which is already wrong.*
8. **`joinList(values, { sep, empty })`** — §1.11, in `crm/src/lib/client.ts`. — *29 sites /
   12 files.*
9. **`isoToday()` / `isoNow()`, and `fmtDate` fixed to slice internally** — §1.10, in
   `crm/src/lib/client.ts`. — *16 sites / 9 files.*
10. **A shared ACORD header block and a shared `Quote`/`Policy` column fragment** — §1.14, §4.3.
11. **A path alias for `shared/`.** Imported as `../../../shared/agency`
    (`crm/src/lib/agency.ts:8`) and `../../../../shared/agency`
    (`web/src/pages/get-started/[...slug].astro:5`). `shared/` holds 2 files / 106 lines against
    the cross-app duplicates in §1.4, §1.5, §1.7 and §1.9, which have nowhere to live.
12. **A `web`-side icon module.** `CoverageCalculator.tsx:109-124` duplicates SVG paths
    byte-for-byte from its own sibling `quote/icons.tsx`; `quote/ui.tsx` inlines SVGs while
    already importing from that module; the map-pin repeats at `AssociationLeadForm.tsx:136`,
    `InstantAssessment.tsx:207`, `ContactForm.tsx:67`. In `crm`, `App.tsx:152-237` holds 9
    inline SVGs + `iconProps` and `FileButton.tsx:29-34` re-declares the attribute set.
13. **A test-util module.** `deferred<T>()` ×3 (`SaveStatus.test.tsx`, `useAsyncResource.test.ts`,
    `ConfirmButton.test.tsx`), `generateClient` stub ×2 (`client.test.ts:15`,
    `storage.test.ts:13`).

### 5.1 Adoption gaps, not missing modules

The three dead modules (§1.1) and the four dead validators (§3.2) are the largest "missing
pattern" by call-site count — **~100 sites** — but the pattern is not missing. It is written,
tested, and unimported. Hand-rolled counterparts of the dead validators:

| Canonical (0 sites) | Live copies |
|---|---|
| `client.ts:219` `EMAIL_RE` | `client.ts:131` (inline, `+` TLD — in the same file, 88 lines above), `lead-intake/handler.ts:51`, `team-admin/handler.ts:35`, `quote/schema.ts:25` |
| `client.ts:252` `validateDateRange` | `CoverageForm.tsx:103-110`, `LicenseForm.tsx:64-71` — identical logic *and* identical message string; neither checks the dates parse |
| `client.ts:277` `validateYear` | `client.ts:143-148` (`+5` window), `DetailsCard.tsx:42-46` (`+1` window, 4 fields) |
| `client.ts:298` `validatePositiveInt` | `client.ts:138-142`, `BuildingsCard.tsx:45-49`, `AppetiteGuides.tsx:183-191` |

`validateAccountFields` (`client.ts:122`, 3 call sites) re-implements `EMAIL_RE`, `validateYear`
and `validatePositiveInt` from **the same file**.

### 5.2 Checked and not found

- **Error boundary** — no `componentDidCatch`/`ErrorBoundary` in `crm/src`. But
  `useAsyncResource.error` + `useSaveStatus` cover every surfaced failure; there is no 3×
  duplication to consolidate. A robustness gap, not a missing shared abstraction.
- **Toast/notification service** — deliberately declined; `SaveStatus.tsx:6-7,176-196` argues the
  persistent-until-dirty model is correct here.
- **Permission-check helper** — `auth.ts` already provides `AdminContext`/`useIsAdmin`, 3
  consumers, no hand-rolled variants.
- **Shared `<Field>` component** — 100+ `<div className="field"><label>…` blocks, but they vary
  across selects, chip lists, date inputs and autocomplete enough that this reads as CSS-class
  convention rather than a suppressed component. (Accessibility note under §6.)
- **Mutation counterpart to `useAsyncResource`** — exists: `useSaveStatus`, 16 sites.
- **Money/date module** — exists: `client.ts:103-118,407` + `acordFormat.ts`. Not duplicated.

---

## 6. FLAGGED IN PASSING

Outside the five requested categories; surfaced during the scan.

1. **Committed live credentials — carried over from the previous audit, still present.**
   `web/scripts/sync-buildium.ts:56-60` hardcodes `BUILDIUM_CLIENT_ID` and
   `BUILDIUM_CLIENT_SECRET` as `||` fallback defaults. The file's own header (`:10-12`) documents
   both as required env vars, so the fallbacks appear unintended. Present in the working tree and
   in git history on `staging` — rotation is the only remediation that works; removing the lines
   does not clear history.
2. **Unsanitized S3 keys** — `NewLead.tsx:102` interpolates `file.name` into the S3 key; a `/` in
   the filename breaks the OCR key parse at `process-document/handler.ts:143`. `safeSegment`
   (`storage.ts:81`) exists and is unimported (§1.1a).
3. **`signatures/*` writable by any authenticated user at a predictable key** —
   `crm/amplify/storage/resource.ts:18`. Those signatures are stamped onto issued ACORD
   certificates. Marked a KNOWN GAP in-file (`:42-67`) and in `PATTERNS.md:253-257`; unchanged.
4. **CRM forms have zero `<form>` elements and zero `htmlFor`/`id` pairing** — every `<label>` is
   a sibling of its control (`CoverageForm.tsx:194`, `LicenseForm.tsx:130`, `DetailsCard.tsx:147`,
   `CarrierForm.tsx:88`), so there is no click-to-focus and nothing associated for screen readers;
   only checkbox labels wrap correctly. `ContactForm.tsx:86-118` has no `<label>` at all. The only
   `role="status"`/`role="alert"` in either app is `SaveStatus.tsx:97`, while `.error-text` is
   hand-rendered at 51 sites.
5. **`PhotosCard`'s thumbnail read still has no `.catch()`** — a genuine unhandled rejection,
   recorded as open at `PATTERNS.md:201-202`.
