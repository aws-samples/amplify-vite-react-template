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
