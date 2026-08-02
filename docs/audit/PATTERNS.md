# PATTERNS

Conventions that exist to stop a class of bug recurring. Each entry names the rule,
where the canonical implementation lives, and one worked example.

---

## Schema enums are derived, never re-typed

**Rule.** A value that comes from an `a.enum(...)` in `crm/amplify/data/resource.ts` is named
exactly once. Derive the union from the schema and pin any table keyed by it with
`as const satisfies Record<TheEnum, …>`. Never write the member list out a second time — not as
a `Record<string, …>` label map, a literal union, a runtime `Set`, a `[value, label]` array, a
list of `<option>` elements, or prose inside an LLM prompt.

Ordered lists are **derived by sorting**, not re-listed. A display order written by hand is a
second copy of the member set and drifts the same way.

`satisfies`, not `:` — it enforces exhaustiveness in both directions (a missing key *and* an
excess one) while leaving the literal key types intact for downstream derivations. Annotating
with `:` erases exactly the information the guard needs.

**Why.** Before this, 18 of 19 schema enums were hand-copied somewhere. None of the copies was
checked, so adding or renaming a member compiled clean everywhere and failed at runtime. It had
already happened: `DocumentsPanel`'s category list was missing `ACORD_FORM`, so ACORD documents
rendered with no category and sorted as `undefined`. `ConstructionType` existed in six
spellings, one of them a sentence in an Anthropic prompt.

**Canonical location.**

- `crm/src/lib/enums.ts` — every derived type, label table and option list.
- `crm/src/lib/quoteStatus.ts` — `QuoteStatus` only. It owns a three-way classification
  (open / bound / closed) that is domain logic, not a label map, and it predates this module.
  Do not restate `QuoteStatus` in `enums.ts`.
- `shared/accountType.ts` — `AccountType` alone, because `web` needs it and **cannot** import
  the schema: `crm` and `web` are separate npm projects (two `appRoot`s in `amplify.yml`, no
  workspace) and `@aws-amplify/backend` is not installed under `web/`. It is the one
  hand-written copy left standing, and `enums.ts` asserts it against the schema in both
  directions so `tsc` fails if they disagree.

**Import constraints on `enums.ts`.** It type-imports `Schema` and value-imports nothing except
the dependency-free `shared/accountType`. That is what lets a Lambda handler import it — the
`pagination.ts:13-15` convention. It must never import `client.ts`, which calls
`generateClient()` at module scope; doing so would drag the browser data client into every
handler bundle. `badges.tsx` is under the same constraint and takes types only.

**Where the rule does not apply.** Not every constant that looks like an enum is one.

- `crm/src/lib/auth.ts` `Role` — Cognito *groups*, declared in `amplify/auth/resource.ts:20`.
  Same three values as `UserRole` by design, different source of truth. Leave it.
- `CONFIDENCE_BADGE`, `US_STATES`, `LINES_OF_BUSINESS`, `LINES_OF_AUTHORITY`, `PREMISES_ROWS`,
  `OCR_EXTENSIONS` — no schema counterpart.
- `web`'s quote-wizard vocabularies (`role`, `propertyType`, `coverageNeeds`, …) — answer
  tokens, not schema members.
- Bare literals in already-typed positions (`status === "ACTIVE"`, `stage: "LEAD"`) are left
  alone. The generated client types those positions, so they are checked; the risk was always
  the *unchecked tables*.

**Example.** One table, four consumers, no second copy of the members:

```ts
// crm/src/lib/enums.ts
export type ConstructionType = Schema["ConstructionType"]["type"];

const CONSTRUCTION = {
  FRAME: { label: "Frame", phrase: "wood-frame" },
  JOISTED_MASONRY: { label: "Joisted Masonry", phrase: "joisted masonry" },
  // …
} satisfies Record<ConstructionType, { label: string; phrase: string }>;

export const CONSTRUCTION_TYPES: readonly ConstructionType[] =
  Object.freeze(Object.keys(CONSTRUCTION) as ConstructionType[]);
export const CONSTRUCTION_OPTIONS = optionsByLabel(CONSTRUCTION_LABELS);
```

Add `"ADOBE"` to the schema and `enums.ts` stops compiling until it is given a label and a
phrase — verified, not assumed:

```
src/lib/enums.ts(114,3): error TS1360: Property 'ADOBE' is missing in type … but required in
type 'Record<"FRAME" | "ADOBE" | … , { label: string; phrase: string; }>'.
```

That one table replaced `acordApp.ts`'s two maps, `ExtractionPanel`'s byte-identical copy,
`DetailsCard`'s tuple array, the extraction Lambda's JSON-schema list, and the member list
hardcoded in the prompt.

**A guard that cannot go quiet.** `satisfies Record<TheEnum, …>` only bites while the enum is a
union of literals; if codegen ever widened one to `string` every guard would silently accept
anything. `enums.test.ts` asserts `[string] extends [T] ? never : true` for all 15 types, and
reads the members back out of `resource.ts` **as source text** (importing it would execute
`@aws-amplify/backend`). Same approach as `quoteStatus.test.ts:25-41`.

This matters because it has already failed once: `80689d2` records a drift check that degraded
to a vacuous pass the moment the literals it compared were deleted. So new guards are proven by
mutation rather than trusted — add a member, remove one, change a label, and confirm the build
or the suite actually fails each time.

**Cost of a display-order change.** Option lists are sorted by label, so reordering the schema
does not reorder a dropdown, and renaming a label does reorder it. Each migrated list has a
regression lock in `enums.test.ts` pinning the exact rendered order, which is what makes a
label edit a visible, reviewed decision instead of a silent one.

---

## Backend code is type-checked before it deploys

**Rule.** Anything under `crm/amplify/` is checked by `npm run typecheck:backend` in the
`backend` phase of `amplify.yml`, ahead of `ampx pipeline-deploy`. Adding a Lambda, or a module
a Lambda imports, does not need new wiring — `amplify/tsconfig.json` has no `include`, so it
picks up everything under `crm/amplify/` plus whatever those files import.

**Why.** `ampx` bundles handlers with esbuild, which strips types without checking them, and
`crm/tsconfig.json` is `"include": ["src"]`, so the frontend's `tsc -b` never sees the handlers.
There is no CI — Amplify Hosting is the only pipeline. The result was that all seven handlers
deployed with zero type checking: `crm/amplify/tsconfig.json` existed and was `strict: true`,
but no script or phase invoked it. A type error in a handler passed `tsc -b` cleanly and
shipped.

**Which command gates what.**

| Command | Covers |
|---|---|
| `npm run build` (`tsc -b && vite build`) | `crm/src` only — the SPA |
| `npm run typecheck:backend` | `crm/amplify/**` + imported modules (24 files) |
| `npm run typecheck` | both |

The check sits in the `backend` phase rather than in `build` on purpose: `build` runs in the
`frontend` phase, which Amplify runs *after* the backend deploy, so a type error there would be
reported only once the broken Lambda was already live. In the backend phase it runs exactly
when a deploy would happen, and blocks it.

**Still open:** `web` has no typecheck at all. `astro build` does not type-check, there is no
`astro check` script, and adding one needs `@astrojs/check` + `typescript` as devDependencies.
Until that exists, nothing verifies `web/src` — including the four `(window as any).gtag` sites
and the `CrmLeadInput` shape the CRM depends on.

---

## One async read, one `useAsyncResource`

**Rule.** A component that reads data does it through `crm/src/lib/useAsyncResource.ts`. No
`useState` + `useEffect` + `.then(setX)`. The hook owns `data` / `loading` / `loaded` / `error` /
`refetch` / `setData`, and every one of those is something the hand-rolled version got wrong
somewhere.

**Why.** Thirteen files hand-rolled it, and **not one had a `.catch()` on the read, a
cancellation, or a read-path error state.** Every one used "the array is still empty" as the
loading gate, so in-flight, failed and genuinely-empty were the same pixels. Concretely, before
this: Dashboard rendered a complete all-zero summary during a total outage; `CarrierDetail` and
`AccountDetail` sat on `Loading…` forever on a failed read because `!data` *was* the gate;
`AllMarketingTasks` set `loaded` on the success path only, so a throw wedged it; `Settings`
asserted "N templates not uploaded yet" before the S3 listing returned.

**The gate.** One ternary chain, in this order, and `!loaded` rather than `loading` wherever a
refetch must not flash the placeholder:

```tsx
{!res.loaded ? (
  <p className="muted small">Loading…</p>
) : res.error ? (
  <p className="error-text">{res.error}</p>
) : rows.length === 0 ? (
  <p className="muted small">No … .</p>
) : (
  <div className="table-wrap">
```

An optional card that hides when empty uses `if (!loaded) return null;` then an error card —
`MarketingTasks.tsx` is the reference. Loading text is `Loading…` (U+2026) in `muted small`;
errors are a bare `<p className="error-text">{error}</p>`.

**Three rules that are easy to get wrong.**

1. **Agency-wide lookup tables are a separate hook with `[]` deps**, never folded into the
   entity's fetcher — otherwise switching account re-reads the carrier table and blanks every
   carrier name mid-render.
2. **Decide each secondary's error; never leave it dangling.** Ignore it where the table is worth
   showing without it (`AccountsList`'s renewal dates). Surface it where its absence is
   indistinguishable from real data — a missing carrier name renders `—`, which reads as "no
   carrier set" rather than "the read failed". `CertificatesTab`'s carrier read is the sharp
   case: it feeds `fillAcord25`, so a swallowed failure ships a certificate PDF with a blank
   insurer block.
3. **Never render an assertion about data you do not have yet.** A count, a verdict, or a
   warning derived from an unsettled read is a wrong answer, not a placeholder. Gate it on
   `loaded`.

**Fuse or split?** Fuse related reads into one resource with `Promise.all` when they are one
logical thing the screen cannot partially mean — `Dashboard`'s six queries, `App.tsx`'s profile +
groups, `AccountMarketingTasks`' tasks + quotes. Split when one is an independent lookup table.
Fusing costs fail-fast: one bad query blanks the screen instead of showing the parts that worked.
For a summary screen that is the right trade, because a partial dashboard cannot say which half
of itself is real.

**What does not fit.** `ExtractionPanel`'s 4-second poll stays hand-rolled, for five reasons
worth keeping written down: it is an interval rather than fetch-per-deps; it is conditional on
`status`; its result is lifted to the parent via `onChange` instead of held locally; it
deliberately drops most successful polls via a diff check so the user's checkbox selections are
not stomped; and a poll failure must stay silent, which the hook's always-write-error invariant
forbids. `SignatureManager` and `PhotosCard` also stay: the hook has **no skip/`enabled`
option**, and both need a conditional fetch. `PhotosCard` still has no `.catch()` on its
thumbnail read — a genuine unhandled rejection, still open.

**Verifying a migration.** The CRM is behind Cognito magic-link auth, so these screens cannot be
driven in a browser without a real sign-in. `MarketingTasks.test.tsx` is the substitute and the
template: stub `generateClient` (per `client.test.ts`), then assert all four states — in-flight,
error, empty, content — and specifically that the error state shows **neither** the empty message
**nor** a stuck loader. Prove such a test has teeth by reverting the component to its
hand-rolled shape and watching it fail.
