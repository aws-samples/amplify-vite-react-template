# Patterns

Canonical implementations established while working through
[INVENTORY.md](INVENTORY.md). One entry per inventory item, added as it is
resolved. If you are about to hand-roll something listed here, don't — import
the canonical one.

---

## 1. Paginated list reads

**Rule.** Every `.list()` whose result must be complete goes through
`listAllPages`. Never call `client.models.X.list({ filter })` bare.

DynamoDB applies `filter` *after* reading a page of rows, so an unpaginated
filtered list silently returns a partial — or empty — set as soon as the
matching rows fall outside the first ~100 scanned. It reads as "no results",
not as an error, and it only starts happening once the table grows. Unfiltered
reads have the same 100-row cap without the filter compounding it.

**Canonical.** `listAllPages` — [`crm/src/lib/pagination.ts`](../../crm/src/lib/pagination.ts).

Re-exported from `crm/src/lib/client.ts`, so frontend code imports it from
`client` alongside `client` itself. Lambdas import `src/lib/pagination`
directly: `client.ts` calls `generateClient()` at module scope, and a handler
must not pull the browser data client into its bundle. `pagination.ts`
therefore has no imports of its own.

Takes an optional `{ maxPages }` when a bound is wanted instead of reading to
the end — the only current use is the global document search, where an
unbounded `contains` scan over every Document is not what you want.

**Example** — `crm/src/components/QuotesPanel.tsx`:

```ts
async function refresh() {
  const data = await listAllPages((nextToken) =>
    client.models.Quote.list({
      filter: { accountId: { eq: account.id } },
      nextToken,
    })
  );
  setQuotes(
    data.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))
  );
}
```

The callback takes `nextToken` and passes it straight through; `listAllPages`
returns the flattened rows. Sorting and everything downstream is unchanged
from the unpaginated form.

**Deleted** (all byte-identical re-implementations):

- `listAll` in `crm/amplify/functions/renewal-tasks/handler.ts` — 6 call sites
- `listAll` in `crm/amplify/functions/extract-lead/handler.ts` — 1 call site
- the bounded 25-page `for` loop in `crm/src/pages/DocumentSearch.tsx` — now
  `listAllPages(…, { maxPages: 25 })`

**Migrated:** all 16 unpaginated filtered reads listed in
[INVENTORY.md §1.1](INVENTORY.md#11-apidata-fetching) — `App.tsx`,
`AccountDetail.tsx` ×5, `Dashboard.tsx` ×3, `AccountsList.tsx`,
`QuotesPanel.tsx`, `PropertyPanel.tsx`, `FormsTab.tsx` ×4.

**Still open, deliberately out of scope of this pass:**

- The ~18 bare unfiltered `.list()` calls (`Dashboard.tsx:40,41`,
  `PoliciesList.tsx:20-22`, `QuotesList.tsx:23-25`, `Carriers.tsx:22,23`,
  `Team.tsx:46`, `Licensing.tsx:42,43,278`, `AccountDetail.tsx` Carrier reads)
  still truncate at 100 rows.
- Page size still diverges across callers that set one — 500, 1000, 200, or
  unset. Migrated sites set no `limit`, so they page at the default 100. A
  larger `limit` means fewer round trips on a filtered scan, since the filter
  is applied after the page is read.

---

## 2. Null ordering in hand-rolled sorts

**Rule.** A sort comparison that falls back to `""` for a missing value must
put missing values **last**, in either direction. `?? ""` alone does not do
this: descending gets it right by accident, ascending puts every blank row on
top.

**Canonical.** `useSort` — [`crm/src/lib/useSort.tsx:35-41`](../../crm/src/lib/useSort.tsx). Empty-or-null → last, both empty → equal, then a plain
locale-aware `localeCompare`. Any hand-rolled sort mirrors those five lines
until it is migrated to `useSort` outright.

**Example** — `crm/src/pages/Team.tsx`, ascending on a nullable `email`:

```ts
const A = a.email ?? "";
const B = b.email ?? "";
if (!A) return B ? 1 : 0;   // missing sorts last, not first
if (!B) return -1;
return A.localeCompare(B);
```

Fixed at three sites: `MarketingTasks.tsx` (`submitBy`), `PropertyPanel.tsx`
(building `label`), `Team.tsx` (`email`). Every other hand-rolled sort in
`crm/src` is `createdAt`-descending and was verified correct.

---

## 3. A catch block may not render the success or empty state

**Rule.** A failure must never be indistinguishable from "there is no data" or
from success. Concretely: no `setSaved(true)`-style call inside a `catch`, and
no `catch {}` on a read whose only other rendering is an empty state.

Empty catches on *reads* are the dangerous half. `catch { setRows([]) }` and a
successful read of an empty table render identically, so a broken load looks
like a working feature with nothing in it — and nobody files a bug.

**Canonical.** Each site uses the error channel its own file already has —
`friendlyError` ([`crm/src/lib/client.ts:176`](../../crm/src/lib/client.ts))
where the file already imports it, the local `error` state otherwise. For a
library that has no UI, the outcome rides back on the return value: `fillTemplate`
returns `FillResult.unsigned` ([`crm/src/lib/acord.ts:83`](../../crm/src/lib/acord.ts))
and the callers append it to the amber partial-success note they already render.

**Example** — `web/src/components/CoverageCalculator.tsx`:

```ts
} catch {
-  /* silently fail — results still show */
-  setEmailSent(true);
+  setEmailError("Something went wrong. Please try again or call 508-233-2261.");
}
```

Fixed at the six data-loss sites in
[INVENTORY.md §1.4](INVENTORY.md#14-error-handling). 18 silent catches remain,
none of them currently on a data-loss path.

---

## 4. Every lead-capture form writes to the CRM

**Rule.** A form that captures a prospect calls `submitCrmLead` alongside the
FormSubmit notification email. The email is a notification; the CRM record is
the lead. A form that only emails has no lead once the inbox is triaged.

**Canonical.** `submitCrmLead` — [`web/src/lib/crmLead.ts`](../../web/src/lib/crmLead.ts).
Called fire-and-forget (`void`) before the email post, so a CRM failure cannot
take down the notification and vice versa.

**Example** — `web/src/components/QuoteApp.tsx:1418`:

```ts
// CRM lead (fail-soft, runs alongside the notification email)
void submitCrmLead(buildCrmLead(finalData, agent.name));
```

`buildCrmLead` (`:633-681`) maps the wizard's answers onto `CrmLeadInput`.
Fields the wizard never asks for — street address, ZIP, unit number, Buildium
id — are left `undefined` rather than filled with a near-miss. The `state`
answer's `"OTHER"` option is a flow branch, not a state code, and is dropped.

All five web forms now do this: `AssociationLeadForm`, `InstantAssessment`,
`ContactForm`, `CoverageCalculator`, `QuoteApp`.

---

## 5. A Generate button is gated on a mapping existing

**Rule.** A UI affordance that produces a document is enabled only for inputs
the code can actually produce a document for, and the gate is derived from the
same constant the producer branches on — never a second hand-kept list.

**Canonical.** `MAPPED_APP_FORM_KEYS` — [`crm/src/lib/acord.ts:719`](../../crm/src/lib/acord.ts),
declared directly above `buildAppFormValues` so a new mapping branch and its
button light up together.

**Example** — `crm/src/components/FormsTab.tsx`:

```tsx
const mapped = MAPPED_APP_FORM_KEYS.has(f.key);
<button disabled={!mapped} title={mapped ? undefined : "…header only…"}>
```

Before this, 15 of 18 registered ACORD forms shipped a live Generate button
that emitted a PDF containing only the producer/insured header — a blank form
that looks filed. The 15 mappings are still unwritten; the button now says so.

---

## 6. A rule shared with a Lambda matches the Lambda

**Rule.** When the same business rule runs in the browser and in a handler,
the handler's semantics win, including its calendar. Divergence here is
invisible: both sides "work", and they simply disagree about the data.

**Canonical.** `renewal-tasks/handler.ts:228-240` — the nightly sweep is the
authority for "a quote satisfies an open marketing task";
`MarketingTasks.tsx:44-50` mirrors it.

**Example:**

```ts
const today = new Date().toISOString().slice(0, 10);
const since = t.triggerDate ?? t.createdAt?.slice(0, 10) ?? today;
```

The client previously fell back to `""`. `x >= ""` is always true, so any quote
for the carrier — including one from a prior term — completed the task on every
mount of the account Quotes tab. UTC (not local) is correct on both sides: the
right-hand operand is a server-assigned `createdAt`.

The rule is still written twice. Extracting it into one importable module is
tracked at [INVENTORY.md §5.12](INVENTORY.md#512-shared-business-rule-frontend--lambda).

---

## 7. Authorization derives from the Cognito group, never a database row

**Rule.** A privilege check reads `cognito:groups` off the ID token. It never
reads `UserProfile.role`. `role` is a display mirror of the group — writing it
grants nothing, and nothing may gate on it.

The two were independent stores for the life of the app: `inviteUser` wrote the
group, Onboarding wrote the role, nothing reconciled them. A user could hold
`role: "ADMIN"` with no group (sees every admin screen, every mutation 401s) or
the reverse (full team-admin power, tab hidden). And `role` sat under
`allow.authenticated()`, so picking `"ADMIN"` from a dropdown — or a one-line
`update` from the browser console — was the whole escalation.

**Canonical.** [`crm/src/lib/auth.ts`](../../crm/src/lib/auth.ts) — `fetchUserGroups()`
reads the claim, `isAdminGroup`/`roleFromGroups` derive from it, `AdminContext`
+ `useIsAdmin()` distribute it.

Two properties that are load-bearing, not incidental:

- The claim is **omitted entirely** when a user is in no group — it is
  `undefined`, not `[]`. Narrow with `Array.isArray`, never index it directly.
- Groups resolve in `ProfileGate` inside the *existing* `Promise.all`, behind
  the *existing* loading flag. Admin status is known before `Shell` first
  paints. Resolving it later makes every gated control flash hidden→shown.

**Example** — `crm/src/pages/Settings.tsx`:

```tsx
const isAdmin = useIsAdmin();   // was: profile.role === "ADMIN"
```

**Corollary — a UI gate is not a control.** Every gate here was cosmetic until
§8 landed. `DeleteLeadZone` returning `null` removes a button, not the ability
to cascade-delete a lead through the API.

---

## 8. Per-model authorization, and what Lambdas actually bypass

**Rule.** A model that needs more than "any signed-in user" declares its own
`.authorization()`. The schema-level default at the bottom of
[`resource.ts`](../../crm/amplify/data/resource.ts) is a floor, not a policy.

**Canonical.** The four hardened models. Shapes, and why each is shaped that way:

| Model | Rule | Why |
|---|---|---|
| `UserProfile` | authenticated read; `ownerDefinedIn("userId").identityClaim("sub")` create/update; ADMIN delete | Reads stay open because Licensing and Team both join the full roster for holder names — scoping reads renders them as `—`, which looks like data loss, not a denial |
| `Policy`, `Certificate` | authenticated read/create/update; ADMIN delete | No ownership anchor exists: `Account.producerId` is declared but never read or written (null on every row) and `Certificate.issuedBy` is a display name, not an id |
| `License` | authenticated read/create; ADMIN update/delete | Create stays open because producers self-create their licenses at onboarding, before an admin sees them |

**`.identityClaim("sub")` is required, not decoration.** The default owner claim
is `sub::username`, which matches no row this app has ever written —
`Onboarding` stores the bare sub. Omitting it locks every non-admin out of
their own profile.

**Two things that look like traps and are not:**

1. **`allow.resource()` does not need re-declaring per model.** The model-level
   allow modifier is `Omit<AllowModifier, 'resource'>` — it isn't callable
   there. `allow.resource()` is stripped before any `@auth` directive is
   generated and becomes an API-wide IAM policy.
2. **Lambda data access bypasses `@auth` entirely.** Amplify sets
   `enableIamAuthorizationMode: true` unconditionally; the construct's own docs
   say *"If enabled @auth directive rules are not applied."* So no model rule
   can break the four handlers — and equally, no model rule confines them. Only
   handler code does.

**Before adding a rule, check what the read path is.** `App.tsx` loads the
profile with a filtered `list`, not a `get`. A rule that returns `[]` there
produces `profile === null`, which renders Onboarding, which `create`s a
**duplicate profile row** — a silent re-onboarding, not an error.

---

## 9. `export` means another file imports it

**Rule.** The `export` keyword is a statement that something is part of a
module's public surface. A symbol used only inside its own file is file-local,
and marking it `export` is a false claim: it makes dead code look load-bearing,
defeats `noUnusedLocals`, and invites the next person to import it rather than
look for the canonical thing.

**Canonical.** Demote, don't delete. Every symbol in this pass had same-file
uses — dropping `export` is the whole fix, and deleting would have broken the
file. Only delete when there are no uses at all.

**Example** — `crm/src/lib/useSort.tsx`:

```ts
-export type SortDir = "asc" | "desc";
+type SortDir = "asc" | "desc";
```

16 symbols demoted across `acord.ts`, `useSort.tsx`, `CoverageForm.tsx`,
`MarketingTasks.tsx`, `DocumentsPanel.tsx`, `googlePlaces.tsx` and the three
`web/src/data` modules.

**Re-verify before demoting.** `CrmLeadInput` was on the audit's list and is
now genuinely imported — the audit predates the import. An audit row is a lead,
not a fact.

**A field a Lambda writes is not dead.** `Account.buildiumId` has no reader in
the app, which reads as dead to a grep, but `lead-intake` sets it and it is the
only link to the Buildium property record. Write-only ≠ unused: check the
producers, not just the consumers, before deleting a schema field.

---

## 10. The shared primitives

**Rule.** Before hand-rolling a fetch triple, a form setter, a text filter, a
save confirmation, a modal, a confirm-destructive, a status badge, a field
coercion, an S3 upload, a date format, or an agency constant — import the one
that exists. The registry and each primitive's location are in
[INVENTORY.md's Wave 3 status table](INVENTORY.md#wave-3-status--primitives-exist-nothing-is-migrated).

Every one was derived from the call site the audit named "most correct", then
widened only where a second real site demanded it. They are unit-tested; the
repo now has Vitest (`cd crm && npm run test:run`).

**Three rules worth stating on their own, because they are not obvious from
the code:**

**A primitive is built from the real call sites, not from the finding.** Every
one of these turned up something the audit missed — a fifth copy, an inverted
helper, a "redundant" call that wasn't. The audit is a lead, not a spec. Read
the sites.

**Do not unify constants that differ for a reason.** The licence badge ladder
is 30/60 and the marketing one is 7/21, and that is correct: the renewal sweep
raises a task at most 14 days before its deadline, so on the licence ladder
every task would be red on day one. Parameterize; don't average.

**Where a helper lives is constrained by `generateClient()`.** `client.ts`
calls it at module scope, so a Lambda cannot import from it — which is why
`pagination.ts` exists, why `badges.tsx` and `formCodec.ts` are separate
modules, and why the inline day math was deliberately *not* absorbed into
`client.ts`: two of its four sites are in a handler, so it would have become a
third implementation rather than removing the second.

**Example** — the shape every primitive follows, from `crm/src/lib/quoteStatus.ts`:

```ts
const QUOTE_STATUS_KIND = { … } as const satisfies Record<QuoteStatus, Kind>;
```

One table, typed against the schema enum, with every list derived from it — so
adding a status to `resource.ts` fails `tsc` until it is classified, and all
four lists plus the GraphQL filter update from that one edit.

---

## 11. Migrating is where the primitive gets tested

**Rule.** A primitive is a hypothesis until every call site adopts it. Migrate
all of them or none — a half-migration leaves two patterns where there was one,
and the reader can no longer tell which is canonical.

**What "every call site or none" actually bought**, across eight migrations:

- **The count is never right.** Every migration found sites the audit missed —
  a 9th fetch triple, a 5th quote-status copy, three raw error idioms, a 14th
  one-`useState`-per-field form. Migrate by grepping the pattern, not by
  working down the audit's list.
- **Two sites that look identical often aren't.** `CoverageForm`'s local `str`
  is the *read* side; `formCodec`'s is the *write* side. Same name, opposite
  direction. Swapping mechanically would have inverted 12 seed calls silently.
- **The migration surfaces bugs the audit couldn't see.** `LicenseForm` had no
  `key`, so editing licence A then B saved A's values onto B — invisible until
  someone read every edit form in one pass and noticed one was different.

**Do not let a migration quietly change behavior — and do not let it quietly
preserve a bug either.** Both happened here and both were called out:

- The audit's "redundant `.slice(0,10)` before `fmtDate`" is not redundant.
  `fmtDate` appends `T00:00:00` only at length 10, so the slice pins the
  nominal day where `fmtDate` renders the local one. Removing them would have
  shifted dates by a day either side of UTC. **Left in place.**
- Adding save feedback to a mutation that drops its `errors` array would have
  made it report success on failure — worse than the silence it replaced. So
  those 11 sites had to start surfacing errors. **That is a behavior change,
  and it was ruled on rather than absorbed.**

**Example** — the shape of a correct non-migration, from `acord.ts`:

```ts
const fmtUs = (d?: string | null) => (d ? fmtDate(d) : "");
```

`fmtDate` returns `"—"` for null; a PDF form field needs `""`. The em dash is a
presentation-medium rule, not a formatting rule, so only the formatting is
shared and the emptiness stays local. Migrating the whole helper would have
printed a literal em dash onto a form a carrier reads.
