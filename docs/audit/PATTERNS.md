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

## 2. One rule decides who may act for a customer

**Rule.** "May this caller act for this customer?" is answered in exactly one
place. Never re-derive it inline from `callerGroups(...)`, and never derive a
management company's reach from `customer.groupId` — read the customer row's
live `accessGroups` stamp, which is the same rule AppSync applies to row-level
reads. A property removed from a group then loses access immediately, with no
re-issued token and no re-login.

There are three ways in, checked cheapest first: staff OWNER, the portal user
whose own `cus-<id>` group matches, and a management-company group login whose
`grp-<id>` appears in that customer's stamp. Only the third costs a read.

Use `assertCanActForCustomer` on write paths. Use the `canActForCustomer`
predicate when the decision is one input to a wider entitlement — a technician
proven against a *specific* document, say — or when the caller deserves a
message more specific than "Not authorized for this customer". Deciding with
the predicate is fine; re-deciding the rule is not.

Message wording is not part of the rule and should suit the caller. Note that
"your own account" is now wrong: a group login acting on a member property is
not acting on its own account.

**Canonical location.** `apps/web/amplify/functions/shared/authz.ts` —
`canActForCustomer(identity, customerId)` and its throwing wrapper
`assertCanActForCustomer`. Role gates live beside them: `assertOffice`,
`assertOwner`, `assertFinance`. Since the roles were consolidated to
OWNER + TECH, `!callerIsOffice(...) && !callerIsFinance(...)` is one condition
written twice — call `assertOffice` once.

**Example.** `submitPortalRequest` in `crm-docs/handler.ts`, before:

```ts
if (
  !callerIsOffice(event.identity) &&
  !callerGroups(event.identity).includes(cusGroup(prCustomerId))
) {
  throw new Error("You can only submit a request for your own account");
}
```

after:

```ts
if (!(await canActForCustomer(event.identity, prCustomerId))) {
  throw new Error("You can only submit a request for an account you manage");
}
```

**Migration note (2026-08-02).** The inline rule denied management-company
logins that the canonical rule allows, so a group login could pay a member
property's invoice (crm-billing already used the canonical rule) and read its
documents, but could not request a callback or submit a portal request for it.
Closing that gap GRANTS access on three portal paths. `getDocumentUrl` also
moved off `customer.groupId` onto the live stamp, keeping its separate
technician-per-document branch. Twenty-four role gates in crm-docs and
crm-pricing collapsed onto `assertOffice`/`assertOwner`.

## 3. The generated schema is the type — do not re-type it by hand

**Rule.** The CRM imports `Schema` from the backend *source*
(`apps/web/amplify/data/resource.ts`), not from a generated artifact, so every
model, enum and custom operation is typed the moment it is written in the
schema. There is no window in which the CRM has to describe the contract by
hand.

That makes `api().mutations as unknown as { someOp: ... }` and
`type Foo = { ...fields copied from a model... }` unnecessary, and worse than
unnecessary: a hand copy compiles happily while it disagrees with the schema,
so drift is invisible until it reaches a user. Call the op directly and let the
argument types come from `.arguments()`. Derive entity types with
`Schema["Model"]["type"]`, and enums with `Schema["SomeEnum"]["type"]`.

Deploy lag is not a reason to widen. A schema deploy affects whether an op
*answers at runtime*, never whether it *type-checks* — and a cast does nothing
to help the former.

A hand type is still fine when it is a genuinely different shape: a projection
the server deliberately reduces (`technicianReads` strips a Job's money
fields), or a wire payload that no model backs. Type those to what actually
crosses the wire, and say so.

**Canonical location.** `apps/crm/src/lib/api.ts` — the `Schema[...]["type"]`
re-exports at the top, and thin wrappers that call `api().mutations.<op>`
directly.

**Example.** Before:

```ts
return (
  api().mutations as unknown as { createLead: (i: typeof input) => OpResult }
).createLead(input);
```

after:

```ts
return api().mutations.createLead(input);
```

**Migration note (2026-08-02).** 27 casts in api.ts fell to 8, and all 8 that
remain are the separate "tolerate an absent model" wrapper (INVENTORY D16), not
schema re-typing. 11 further op widenings were removed from CustomerDetail,
Requests, Work, Schedule, MarketRates, JobDetail and AddService. Hand copies of
`Dispute`, `DisputeStatus`, `Invoice`, `MarketRate`, `PortalRequest`,
`CallbackRequest`, `InFlightBooking` and `DiscountBooking` now read off the
schema.

De-widening immediately earned its keep: the hand `Dispute` declared
`customerId: string`, but the schema has it nullable and
`stripe-webhook/handler.ts:1069` really does create a Dispute with no customer
(the dispute-closed path, when the created event never landed). The Dashboard's
recovery queue would have navigated to `/customers/undefined`. The type is now
nullable end to end and the row guards its link — which the neighbouring
disputes card had been doing all along.

## 4. A client copy of a wire payload must carry the fields that say "stop"

**Rule.** When a screen re-declares a server response by hand, the fields it
omits are not neutral. Dropping a *value* field costs a display; dropping a
field that means "this path is closed" turns a clear refusal into a dead end,
because the screen renders its normal happy path against a payload that was
telling it not to.

So a hand copy carries every field the server can send, even the ones the
screen does not act on, and says in a comment why each unused one is unused.
"Not needed here" is a claim that stops being true the moment the server grows
a case, and a comment is what makes that visible on the next read.

Copy is not interchangeable across surfaces either. The same `offSeasonMessage`
is true on the public funnel, where a customer really can enroll themselves,
and false in the portal, where the server hands the case to the office. Render
server copy only where the server's assumptions hold.

**Canonical location.** Response shapes belong to the endpoint. Until
booking-public exports them (INVENTORY T3), each client copy is a liability and
should be annotated as one — see the `QuoteResult` block in
`apps/crm/src/portal/AddService.tsx`.

**Example.** The portal's quote type omitted `offSeason`, so an off-season
mosquito quote — which the server answers with `decision: "PRICED"` and an
empty `days` board — rendered a price card, a terms checkbox, and a
permanently disabled button with nothing explaining why:

```ts
if (res.days?.length) setSelDate(res.days[0].date);   // never runs
// …
<Button disabled={!accepted || !selDate}>            // never enables
```

The type now carries `offSeason`, and the screen explains that the office sets
this one up.

**Migration note (2026-08-02).** The inventory read this as an unbookable
dead end to be opened up. It is narrower than that: `booking-public` `book`
*deliberately* refuses date-less off-season enrollment and net-terms invoicing
on the trusted portal path ("office-assisted paths, not self-serve"), and that
decision stands. The defect was only that the portal never learned of it, so
the fix is an honest explanation at quote time, not a new self-serve path.
