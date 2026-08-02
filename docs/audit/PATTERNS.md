# Patterns

Rules established by working through `INVENTORY.md`. One entry per resolved
item: the rule, where the canonical implementation lives, and one example.

## 1. What day is it — ask the shop's clock

**Rule.** Anything a customer, invoice, licence, or schedule can observe uses
the Eastern calendar day. Never derive a business date from
`new Date().toISOString().slice(0, 10)` — BuzzKill runs on America/New_York, so
a UTC-derived "today" reads as *tomorrow* from roughly 7/8pm Eastern until
midnight, which is the tail of every working day.

UTC is still correct for values that only need to change once a day and agree
with whatever wrote them last: dedupe keys, day-bucket ids, hash inputs, export
filenames, and comparisons against fields the backend itself writes in UTC
(`processingExpectedBy`). Those call `todayUtc()` — named, so the choice is
visible and greppable rather than implied by an inline `toISOString`.

Two corollaries, both learned from real defects during the migration:

- A "today" and its companion offset must come from the same clock. Comparing
  an Eastern `today` against a UTC `+30 days` reintroduces the bug inside a
  single function.
- A helper that takes an injected instant (`dayKeyFor(now: Date)`) is a key
  *formatter*, not a "today" implementation. Leave those alone; re-pointing
  them at `todayUtc()` would silently discard the caller's instant.

**Canonical location.**
- Backend: `apps/web/amplify/functions/shared/dates.ts` — `todayEastern()`,
  `easternPlusDays(n)`, `todayUtc()`. Deliberately dependency-free so leaf
  modules (licences, compliance, callbacks) can ask what day it is without
  inheriting a database client.
- CRM: `apps/crm/src/lib/format.ts` — `todayEastern()`, `todayUtc()`,
  `addDays(iso, n)`. Separate because no shared frontend package exists yet
  (INVENTORY M14).

**Example.** The licence-expiry sweep in
`apps/web/amplify/functions/daily-reminders/handler.ts`, before:

```ts
const today = new Date().toISOString().slice(0, 10);
const warnDate = new Date(Date.now() + LICENSE_WARN_DAYS * 86400_000)
  .toISOString()
  .slice(0, 10);
```

after:

```ts
const today = todayEastern();
const warnDate = easternPlusDays(LICENSE_WARN_DAYS);
```

Both ends of the comparison now run on the clock the licence itself is dated
against, so a technician whose licence lapses today stops being dispatchable
today — not at 8pm the evening before.

**Migration note (2026-08-01).** Seven duplicate Eastern definitions were
deleted and 13 backend modules plus 5 CRM files now import the canonical
helpers. Business-logic call sites moved to Eastern (a deliberate behaviour
change — that was the defect); keys and filenames kept UTC via `todayUtc()` so
no once-a-day sweep could double-fire on the deploy day.
