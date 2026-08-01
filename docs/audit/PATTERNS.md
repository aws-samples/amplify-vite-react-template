# Patterns

Conventions established while working through `INVENTORY.md`. One section per
pattern: the rule, where the canonical version lives, and a worked example.

---

## 1. Shared facts live on the server and are re-exported, never re-declared

*Established 2026-07-31 while closing INVENTORY.md item #1.*

### The rule

> A fact both apps need lives in **one** module under
> `apps/web/amplify/functions/shared/`, and the CRM **re-exports** it.
> The CRM never keeps a second copy.
>
> The shared module must be a **pure leaf**: its full transitive import closure
> contains no `aws-amplify*`, `@aws-amplify/*`, `@aws-sdk/*`, `@anthropic-ai/sdk`,
> `stripe`, `pdf-lib`, `$amplify/*`, or any `node:*` builtin.
>
> If the server module is not a pure leaf, **extract the pure half into a new
> leaf** and re-export it from the impure module, then share the leaf.

A "fact" here means a controlled vocabulary, a policy table, a derivation rule,
or a formatting rule that both the backend and the office UI have to agree on.
Presentation choices (tone, colour, wording local to one UI) are not shared
facts and should stay in the app that renders them.

### Why purity is the gate

The CRM bundles into a browser. A bad import does **not** fail the build:

- Vite resolves bare specifiers out of `apps/web/node_modules`, so importing a
  module that pulls in the Anthropic or AWS SDK silently ships megabytes to the
  browser.
- `node:crypto` and friends get stubbed as `__vite-browser-external` and crash at
  runtime, not at build time.
- Anything referencing `$amplify/*` fails CRM `tsc`, because that path alias
  exists only in `apps/web/amplify/tsconfig.json`.

So check the import closure **before** converting, not after, and run the bundle
guard below.

### Canonical location

```
apps/web/amplify/functions/shared/<module>.ts    <- the one copy
apps/crm/src/lib/<module>.ts                     <- re-export barrel + UI-only extras
```

The import path from the CRM is a relative path into the sibling app:
`../../../web/amplify/functions/shared/<module>`. This needs no build
configuration. It already worked before this pattern existed —
`serviceCatalog`, `inventory`, and `rateServing` have shipped this way — and
`amplify.yml` already installs and caches `apps/web/node_modules` for the CRM
build so `tsc` can resolve it.

Two rules for the barrel:

- Re-export **types** with `export type { … }`. `isolatedModules` is on, and a
  plain `export { SomeType }` will not compile.
- A `import type` that exists to keep an impure module out of the bundle is
  load-bearing. `shared/lifecycleReasons.ts:1` imports `LifecycleAction` from the
  runtime module `lifecycleLog.ts` as `import type`; dropping that keyword would
  pull DynamoDB code into the browser. Do not "tidy" it.

### Example

`apps/crm/src/lib/serviceAddress.ts` was a 63-line hand-kept copy of the server's
address composition rules, headed *"Kept in step with the server copy by hand."*
It is now a barrel:

```ts
export type { ServiceAddressFields } from "../../../web/amplify/functions/shared/serviceAddress";
export {
  displayAddress,
  qualifyUnit,
  routingAddress,
} from "../../../web/amplify/functions/shared/serviceAddress";

import type { ServiceAddressFields } from "../../../web/amplify/functions/shared/serviceAddress";
import { qualifyUnit } from "../../../web/amplify/functions/shared/serviceAddress";

const clean = (v: string | null | undefined) => (v ?? "").trim();

/** Short form for list rows: street (+ unit) and city. CRM-only presentation. */
export function shortDisplayAddress(c: ServiceAddressFields): string { … }
```

Every consumer (`tech/Today.tsx`, `tech/JobDetail.tsx`) is untouched: they still
import from `../lib/serviceAddress`. The routing/display distinction now has one
definition, and `shortDisplayAddress` stays local because no server caller wants
it.

### What was migrated

| CRM file | Outcome |
|---|---|
| `lib/accessGroups.ts` | Deleted. Zero importers; duplicated `shared/dynamicGroups.ts`. |
| `lib/serviceAddress.ts` | Barrel over `shared/serviceAddress.ts`; keeps `shortDisplayAddress`. |
| `lib/leadStage.ts` | Barrel over `shared/leadStage.ts`; keeps the queue-ordering half (below). |
| `lib/workPolicy.ts` | Barrel over `shared/workPolicy.ts`; keeps `SEVERITY_TONE`/`SEVERITY_LABEL`. 567 lines to 41. |
| `lib/api.ts` | Six reason vocabularies now re-exported from `shared/visitChangeReasons.ts`, `shared/staffRoles.ts`, `shared/lifecycleReasons.ts`. |
| `tech/JobDetail.tsx` | `AMOUNT_UNITS` now `shared/units.ts` `COMMON_UNITS`. |

To make the workPolicy barrel possible, the server table gained a `label` field
(38 entries, values taken from the CRM copy — the server never rendered its own
strings) and `workPolicy()`/`isVerifiable()` were widened to accept a nullable
kind, since callers read it off a stored row.

### A deliberate divergence is not drift

Sharing is the default, but two implementations that answer *different
questions* should stay apart, with the reason written down.

`leadNextActionAt` is the case in this codebase. The server treats a lead with no
stored deadline as due **now**, which is right for a sweep asking "is this
overdue?". The office queue asks "what do I work first?", and treats it as
**epoch** so an un-actioned lead sorts to the top. Both say "overdue: yes"; they
differ only in ordering. The CRM keeps its own, and the module header says why.

The test for whether something is drift: if the two copies are trying to answer
the same question and merely disagree, that is drift. If they answer different
questions, name the questions in a comment and keep both.

### Blocked — do not attempt as a re-export

These look migratable and are not without more work. When the server module
is impure, the fix is a pure-leaf extraction — that is pattern [2](#2-a-shared-fact-trapped-in-an-impure-module-gets-a-pure-leaf-extraction)
below, and every mirror that was listed here has since been closed by it.

| Mirror | Blocker | Outcome |
|---|---|---|
| `lib/planCadence.ts`, `lib/billingDisclosure.ts`, `lib/customerPresentation.ts` | No backend original. These are not mirrors. | `planCadence.ts` header now says so; the phantom `seasonalCadenceCopy()` (zero callers) was deleted in `d81922c`. |

`shared/units.ts` is now load-bearing via `COMMON_UNITS`. It was previously
listed as dead code; do not delete it in a dead-code pass.

### Verifying a migration

```bash
cd apps/crm && npx tsc --noEmit -p tsconfig.json   # the real gate: CRM `npm test` does NOT typecheck
cd apps/crm && npm test && npm run build
cd apps/web  && npm test && npm run build
```

Bundle guard, mandatory after any new value import, because a leak is silent:

```bash
cd apps/crm && npm run build && du -sh dist/assets && \
  grep -rlE "@aws-sdk|@anthropic-ai|__vite-browser-external" dist/assets/ || echo clean
```

For a migration that claims no behaviour change, the strongest check is an
equivalence test: extract the pre-change module with `git show HEAD:<path>` and
assert the new barrel produces identical output across a table of inputs. That
was used here to compare all 38 policy entries, 7 address shapes, 14 lead-fact
shapes, and the 6 reason vocabularies before and after. Delete it once green.

### Known rough edges (pre-existing, not introduced here)

- `npm run dev` in the CRM serves files outside `apps/crm` only via Vite 7's
  `safeModulePaths`; `server.fs.allow` resolves to `apps/crm` alone. Smoke-test
  dev, not just build, and consider pinning Vite or setting `server.fs.allow`.
- `apps/crm` has **no eslint config** and its `npm test` does not typecheck. The
  only CRM typecheck gate is `npm run build`.
- `apps/web`'s `npm run lint` reports ~151k errors, of which ~151,270 are in
  `.amplify/` generated code that the eslint ignore list does not cover. Lint is
  not wired into `amplify.yml`.
- The `amplify.yml` CRM preBuild comment says "nothing from apps/web ships in the
  CRM bundle". That has been false since `serviceCatalog` was value-imported.

---

## 2. A shared fact trapped in an impure module gets a pure-leaf extraction

*Established 2026-07-31 while closing the second half of INVENTORY.md item #1.*

### The rule

> When a fact both apps need lives inside a server module that is not a pure
> leaf (it imports an SDK, `node:*`, or `dataClient`), do **not** copy the fact
> into the CRM and do not try to import the impure module. Instead:
>
> 1. **Extract** the pure half into a new leaf under
>    `apps/web/amplify/functions/shared/` — definitions moved **verbatim**,
>    zero imports.
> 2. The impure module **imports the leaf and re-exports its old public
>    surface**, so none of its existing importers change.
> 3. The CRM **value-imports the leaf** (directly, or through its existing
>    `lib/` barrel so CRM callers don't change either).
>
> Both sides keep their own wrappers when they answer differently-shaped
> questions — the *fact* is shared, the *signature* need not be.

The result is that pattern [1](#1-shared-facts-live-on-the-server-and-are-re-exported-never-re-declared)
applies again: one copy, on the server, re-exported.

### Canonical location

```
apps/web/amplify/functions/shared/<domain>.ts       <- impure engine (unchanged surface)
apps/web/amplify/functions/shared/<domainLeaf>.ts   <- NEW pure leaf: the extracted facts
apps/crm/src/lib/<module>.ts                        <- barrel over the leaf + CRM-only extras
```

Leaves created this way, with the engine each was cut from:

| Leaf | Cut from | Facts |
|---|---|---|
| `agingMath.ts` | `recovery.ts` (Stripe/SES/dataClient) | AR bucket boundaries + labels, due-basis rule, whole-day UTC arithmetic, terms→due-date |
| `marketRateKeys.ts` | `marketRate.ts` (Anthropic SDK, `node:crypto`) | rate vocabulary/types, area/sqft/HOA-band keys, `parseSheet`, `mirrorCents` |
| `adminJobTypes.ts` | `crm-docs/handler.ts` (5,900-line Lambda) | office-completable job types + match rule |
| `leadReasons.ts` | `leadLifecycle.ts` (`node:crypto`, dataClient) | lead lost-reason codes **and** their dropdown labels |
| `rateServing.ts` | `marketRate.ts` | (pre-existing precedent this pattern generalizes) |

### Example

`shared/recovery.ts` and the CRM's `lib/aging.ts` each carried the AR aging
contract, and each said so — "mirrored on the frontend — keep the boundaries
identical" on one side, "must agree — to the dollar" on the other. The CRM
could not import the server copy because `recovery.ts` charges cards.

The contract moved to `shared/agingMath.ts`; `recovery.ts` re-exports its old
names (`export { agingBucketForDays as agingBucket } from "./agingMath"`), so
`daily-reminders`, `stripe-webhook`, and `crm-billing` were untouched. The
CRM's `aging.ts` became a barrel plus the CRM-shaped wrappers — its
`daysPastDue(inv, today)` takes an explicit Eastern `today` while the server
ages against UTC-now, a deliberate divergence now named in its header. The
CRM's `api.ts` had a *third* private copy of `dueDateForTerms`; it is now a
re-export.

Commits: `03bb6fb` (agingMath), `0c129ab` (marketRateKeys), `b2e8339`
(adminJobTypes), `810c485` (leadReasons), `d81922c` (planCadence — the
sixth listed mirror, which turned out not to be one; its phantom zero-caller
"canonical" was deleted instead).

### What to watch

- **Verbatim means verbatim.** The leaf's function bodies are cut-pasted, not
  rewritten. Where the two old copies disagreed in shape (Set vs array,
  differing empty-string guards in `adminJobTypes`), reconcile explicitly and
  pin the reconciliation with the equivalence test below.
- **Renamed identifiers are allowed only when internal.** The aging migration
  unified the CRM's bucket ids onto the server's (`"1-30"` → `"D1_30"`). That
  was safe because the ids never left the process — `useState` drill keys and
  a `switch` — and every user-visible label was asserted identical. An id that
  is persisted, or in a URL, is an API: keep it or migrate the stored data.
- **Sentences are not facts.** Five sites "duplicating" the seasonal-cadence
  wording were each composing their own customer-facing sentence around the
  same facts. Sharing the facts (`season.ts`) is right; collapsing the
  sentences would be a customer-visible copy change, not a refactor.
- **The equivalence gate from pattern 1 applies with more force here**, since
  extraction touches the engine too: run the pre-migration implementations
  (verbatim, from `git show HEAD:<path>`) against the new code across boundary
  inputs — bucket edges, DST/leap dates, parse-tolerance cases — then delete
  the scratch test. The engine side should additionally stay pinned by its
  existing unit tests without edits (`recovery.test.ts`, `marketRate.test.ts`
  did).
- **Run the bundle guard from pattern 1 after every one of these** — each adds
  a new cross-app value import, which is exactly the silent-leak scenario.
