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
