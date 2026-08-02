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
