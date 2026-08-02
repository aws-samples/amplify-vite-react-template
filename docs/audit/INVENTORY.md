# Repository inventory — 2026-08-02

Read-only audit at `0b32017` (branch `staging`, clean tree). No code changed.

Scope: `apps/web/**`, `apps/crm/**`. 387 source files (`.ts`/`.tsx`), excluding
tests where noted. `.claude/worktrees/**` is excluded throughout — it holds three
stale copies of the tree and doubles every raw grep count.

Neither app has a form library, toast library, table library, state manager, or
date library in its dependencies. Every abstraction in those categories is
hand-rolled, which is the root cause of most of section 1.

---

## Ranking

Ordered by blast radius × how often the divergence produces an inconsistency.
"Sites" is the number of places that would change if the item were fixed.

Items marked **✗** already produce a wrong result today; the rest are debt that has
not yet diverged.

| # | Item | Sites | Blast radius | Diverges today? | § |
|---|---|---|---|---|---|
| 1 | `lead-intake` public endpoint has no server-side gate | 1 | Unauthenticated writes to `Customer`/`Lead` | **✗** wildcard CORS contradicts the CDK allowlist | 1.3 |
| 2 | ~~Money formatting — 9 helpers + 89 inline `toFixed(2)`~~ | ~98 | Every customer-facing price surface | **FIXED** `9b8f66a` — one `shared/money.ts` | 1.4 |
| 3 | ~~`quoteJson` parsed unvalidated~~ | 9 shapes | The card-charge amount | **FIXED** `60f3c52` — one validating `shared/quoteSnapshot.ts` | 4.3–4.4 |
| 4 | Async load/error state copy-pasted (no `useAsync`) | ~78 | Every CRM + portal screen | **PARTLY FIXED** `b58b507`, `77a5ed2` — hooks + 16 screens; mutation sites remain | 1.6 |
| 5 | `err instanceof Error ? …` inline | 144 | All error text, both apps | **✗** ~85 distinct fallback strings | 1.7 |
| 6 | `pageErrors: "ignore"` swallowed pagination errors | 110 | Partial reads pass as complete | **✗** by construction | 1.8 |
| 7 | `.catch(() => undefined)` in money/scheduling paths | 114 | Capacity + payment bookkeeping leaks | **✗** silent state drift | 1.8 |
| 8 | `statusTone` keyed by `string`, not the enums | ~15 badges | Every status badge in the CRM | **✗** `NO_ACCESS`, all `PricingDecision` render grey | 4.2 |
| 9 | MA/RI territory rule — 3 encodings | 3 | Who may be quoted online | **✗** 2 reject `"Massachusetts"` | 5.1 |
| 10 | CRM screens bypass `lib/api.ts` | 137 | All CRM data access | Partly — 49 mutations unwrapped | 1.1 |
| 11 | `NO_ACCESS_LABEL` duplicated frontend/backend | 2 maps | Tech app vs office audit record | **✗** 3 of 6 labels differ | 5.2 |
| 12 | `CRM_APP_URL` fallback inconsistent | 8 | Links in outbound email | **✗** 5 sites emit dead relative links | 5.4 |
| 13 | Handler error conventions | 18 | Every Lambda boundary | **✗** 6 conventions | 1.7 |
| 14 | Four names for one owner predicate | 48 | Every backend authz check | No — aliases agree | 1.3 |
| 15 | `addDays` — 6 implementations | 6 | Scheduling, aging, recurrence | **✗** CRM copy mixes local/UTC | 1.5 |
| 16 | Cross-Lambda invoke — 6 clients, 3 protocols | 6 | All service-to-service calls | **✗** discriminator name differs | 1.2 / 4.5 |
| 17 | `window.confirm` / `alert()` vs `Sheet` | 22 | Destructive CRM actions | **✗** 2 confirm styles | 1.6 |
| 18 | Pretty-date rendering — 7 implementations | 7 | Emails, PDFs, CRM, funnel | **✗** 4 anchoring strategies | 1.5 |
| 19 | `servicePages.ts` missing — `RELATED` copied 14× | 14 | Public site navigation | **✗** 4 slugs carry two labels | 5.5 |
| 20 | Presigned S3 upload — 5 backend + 5 frontend | 10 | All file uploads | **✗** 4 of 5 mis-send Content-Type | 1.2 / 1.1 |
| 21 | Idempotency — 5 mechanisms, 4 Stripe key formats | ~30 | Retry safety on money paths | **✗** key formats differ | 1.7 |
| 22 | `ServiceCode` / cadence enums re-declared | 4 + 5 | Funnel ↔ schema | **✗** funnel type omits both mosquito services | 4.1 |
| 23 | `VISIT_NOTE` missing `SEMIANNUAL` | 1 | Start-billing confirmation | **✗** cadence sentence silently omitted | 4.1 |
| 24 | `rateKey` — 1 builder, 3 parsers | 4 | Pricing reports | **✗** one parser has no `NaN` guard | 5.3 |
| 25 | `CANCEL_FULL_REFUND_HOURS` — "72 hours" hard-typed | ~18 | Refund copy incl. CRM UI | No — agrees today | 5.9 |
| 26 | Two `stripeClient()` factories | 21 | All Stripe calls | **✗** 19 sites lack the live-key guard | 1.2 |
| 27 | `getSecret()` triplicated | 3 | Secret resolution | **✗** 2 cache negative lookups | 1.2 |
| 28 | `addressAutocomplete.tsx` forked across apps | 2 | Address entry in both apps | No — 3 comment lines only | 1.1 |

---

> **Status, 2026-08-02.** Items 2, 3 and 4 have been worked. Sections below
> are left as written at audit time so the findings stay readable against the
> code they described; see the fix commits for what changed, and note the
> correction to item 3 recorded in §4.3.

## 1. Duplicate implementations

### 1.1 Frontend data access

**CRM screens bypass the shared api layer.** `apps/crm/src/lib/api.ts` exports 40
typed helpers wrapping 34 operations. 28 component files call the generated
client directly instead.

- Canonical: [apps/crm/src/lib/api.ts:118](apps/crm/src/lib/api.ts:118)–949
- Bypasses: 137 raw `api().` calls
  (`grep -rn "api()\." apps/crm/src --include='*.tsx' | grep -v 'lib/api.ts'`)
  — `models` 67, `mutations` 66, `queries` 4
- 49 distinct mutations are invoked with no wrapper; only 19 have one
- Worst offenders: [CustomerDetail.tsx](apps/crm/src/office/CustomerDetail.tsx) 34,
  [Schedule.tsx](apps/crm/src/office/Schedule.tsx) 12,
  [JobDetail.tsx](apps/crm/src/tech/JobDetail.tsx) 11,
  [MarketRates.tsx](apps/crm/src/office/MarketRates.tsx) 10,
  [GroupDetail.tsx](apps/crm/src/office/GroupDetail.tsx) 8

Most used: raw client (137 vs 34). Most correct: `lib/api.ts` — typed inputs plus
consistent `unwrap`/`opResult` handling. **Canonical: `lib/api.ts`.**

**`addressAutocomplete.tsx` is forked across both apps.** 247 lines each;
`diff` reports only three differing comment lines (106–108, 120). Both issue
byte-identical Google Places `places:autocomplete` and place-details fetches.

- [apps/web/src/lib/addressAutocomplete.tsx](apps/web/src/lib/addressAutocomplete.tsx)
- [apps/crm/src/lib/addressAutocomplete.tsx](apps/crm/src/lib/addressAutocomplete.tsx)

The CRM already cross-imports `apps/web/amplify/functions/shared/*`
([api.ts:3](apps/crm/src/lib/api.ts:3)), so a shared module is precedented.
**Canonical: one copy under `shared/`.**

**Function-URL resolution from `amplify_outputs.json` — 3 copies, one dead.**

| Impl | Location | Callers |
|---|---|---|
| `getBookingApiUrl` | [bookingApi.ts:18](apps/web/src/lib/bookingApi.ts:18) | 4 booking pages |
| `getLeadIntakeUrl` | [leadIntakeApi.ts:18](apps/web/src/lib/leadIntakeApi.ts:18) | 2 |
| `getCustomOutput` | [apps/crm/src/lib/backend.ts:28](apps/crm/src/lib/backend.ts:28) | **0 — dead** |

`leadIntakeApi.ts:3` states it "Mirrors `bookingApi.ts`'s URL resolution". The
POST transport below it is duplicated too: [bookingApi.ts:300](apps/web/src/lib/bookingApi.ts:300)
`post<T>()` vs [leadIntakeApi.ts:67](apps/web/src/lib/leadIntakeApi.ts:67) `submitLead()`.
**Canonical: `post<T>()` — generic over path and response type.**

**Presigned-upload client — 5 copies of the same fetch block.**
[Requests.tsx:168](apps/crm/src/portal/Requests.tsx:168),
[ReportPhotos.tsx:64](apps/crm/src/components/ReportPhotos.tsx:64),
[CustomerDocuments.tsx:84](apps/crm/src/components/CustomerDocuments.tsx:84),
[JobDetail.tsx:940](apps/crm/src/tech/JobDetail.tsx:940),
[JobDetail.tsx:1074](apps/crm/src/tech/JobDetail.tsx:1074).

Only `ReportPhotos.tsx:59-70` falls back to `image/jpeg` when `file.type` is
empty. iOS HEIC pickers send a blank type, so the other four send an empty
`Content-Type` and mismatch the presigned signature. **Canonical: `ReportPhotos`'
version, extracted to `lib/api.ts`.**

**Portal customer scan — 2 copies.** [portalData.ts:21](apps/crm/src/portal/portalData.ts:21)
`loadMyCustomers` is used by 5 portal screens; [Group.tsx:25](apps/crm/src/portal/Group.tsx:25)
inlines its own `CustomerGroup.get` + filtered `Customer.list` and is the only
portal screen that does not import it.

**Dead canonical helper with 11 hand-rolled copies.** `jsonField<T>()`
([api.ts:958](apps/crm/src/lib/api.ts:958)) has zero call sites. The inline
`typeof raw === "string" ? JSON.parse(raw) : raw` it exists to replace appears at
[ProductLog.tsx:156](apps/crm/src/office/ProductLog.tsx:156),
[ProductUsage.tsx:54](apps/crm/src/office/ProductUsage.tsx:54),
[CustomerDetail.tsx:335](apps/crm/src/office/CustomerDetail.tsx:335),
[MarketRates.tsx:306](apps/crm/src/office/MarketRates.tsx:306),
[Schedule.tsx:706](apps/crm/src/office/Schedule.tsx:706),
[QuoteHistory.tsx:34](apps/crm/src/components/QuoteHistory.tsx:34),
[CustomerDocuments.tsx:38](apps/crm/src/components/CustomerDocuments.tsx:38),
[JobDetail.tsx:101,167,181](apps/crm/src/tech/JobDetail.tsx:101).

### 1.2 Backend data access and service calls

**Cross-Lambda invoke — 6 hand-rolled clients, 3 incompatible payload protocols.**

| Caller → target | Location | Protocol |
|---|---|---|
| crm-billing → booking-public | [handler.ts:365](apps/web/amplify/functions/crm-billing/handler.ts:365) | `{internalOp:{kind}}` |
| thumbtack → booking-public | [autoQuote.ts:93](apps/web/amplify/functions/thumbtack-webhook/autoQuote.ts:93) | `{internalOp:{kind}}` |
| booking-public → crm-pricing | [handler.ts:1117](apps/web/amplify/functions/booking-public/handler.ts:1117) | `{internalOp:{**op**}}` — different discriminator |
| pricing-refresh → booking-public | [handler.ts:381](apps/web/amplify/functions/pricing-refresh/handler.ts:381) | synthesized `APIGatewayProxyEventV2` |
| booking-public → pricing-refresh | [handler.ts:931](apps/web/amplify/functions/booking-public/handler.ts:931) | `{rateKey, source}` |
| crm-pricing → pricing-refresh | [handler.ts:143](apps/web/amplify/functions/crm-pricing/handler.ts:143) | `{rateKey, source}` — same job as above |
| daily-reminders → crm-admin | [handler.ts:2326](apps/web/amplify/functions/daily-reminders/handler.ts:2326) | synthesized AppSync resolver event |

Each re-implements the `FunctionError` → `JSON.parse(Buffer.from(Payload))` →
`{ok}` unwrap. Most correct: `invokeBookingPublic`
([crm-billing/handler.ts:365](apps/web/amplify/functions/crm-billing/handler.ts:365))
— smallest, unwraps the documented envelope. **Canonical: one
`shared/invokeFunction.ts` with a single `internalOp` envelope; drop both
synthesized-event variants.** Collapse `booking-public:931` and
`crm-pricing:143` first — identical operation.

**The same endpoint is reachable three ways.** `booking-public`'s `quote`/`book`:

1. Public Function URL — [handler.ts:391](apps/web/amplify/functions/booking-public/handler.ts:391), called by [bookingApi.ts:300](apps/web/src/lib/bookingApi.ts:300)
2. IAM invoke via `handleInternalOp` — [handler.ts:317](apps/web/amplify/functions/booking-public/handler.ts:317)
3. IAM invoke with a **fake HTTP event** re-entering the public route table — [handler.ts:402](apps/web/amplify/functions/booking-public/handler.ts:402), from [pricing-refresh/handler.ts:381](apps/web/amplify/functions/pricing-refresh/handler.ts:381)

Path 3 deliberately bypasses `handleInternalOp` and lands in the CORS/origin gate
with an empty `headers` object. **Canonical: `handleInternalOp` for all
server-side callers.**

**`getSecret()` triplicated verbatim.**
[booking-public/handler.ts:97](apps/web/amplify/functions/booking-public/handler.ts:97),
[pricing-refresh/handler.ts:126](apps/web/amplify/functions/pricing-refresh/handler.ts:126)
(comment: "same lookup as booking-public"),
[crm-pricing/handler.ts:383](apps/web/amplify/functions/crm-pricing/handler.ts:383).

Same two SSM paths, same `placeholder-set-me` sentinel, same env-first order.
Most correct: crm-pricing — the only one that does not cache negative lookups
([:407](apps/web/amplify/functions/crm-pricing/handler.ts:407)); the other two pin
a miss for the container lifetime. **Canonical: crm-pricing's version, extracted.**

**`bookingPublicFunctionName()` — 4 copies.**
[crm-billing:346](apps/web/amplify/functions/crm-billing/handler.ts:346) (throws a
customer-facing string on miss),
[autoQuote.ts:71](apps/web/amplify/functions/thumbtack-webhook/autoQuote.ts:71),
[pricing-refresh:347](apps/web/amplify/functions/pricing-refresh/handler.ts:347),
[daily-reminders:2311](apps/web/amplify/functions/daily-reminders/handler.ts:2311)
(same shape, different target). Most correct: pricing-refresh — memoizes and
distinguishes "unconfigured" from "transient failure". **Canonical: one
`shared/functionName.ts` taking `(envVar, paramVar)`.**

**Two `stripeClient()` factories.**

| Impl | Location | Key source | Sites |
|---|---|---|---|
| shared, sync | [stripeClient.ts:9](apps/web/amplify/functions/shared/stripeClient.ts:9) | `process.env` only | 19 |
| booking-public, async, private | [handler.ts:141](apps/web/amplify/functions/booking-public/handler.ts:141) | env → SSM, plus `assertStripeKeyAllowed` live-key guard at [:130](apps/web/amplify/functions/booking-public/handler.ts:130) | 2 |

Most used is the shared one; most correct is the local one — it is the only
version that refuses a live key off `main`. The 19 sites on the shared factory
have neither the SSM fallback nor the guard. **Canonical: move booking-public's
version into `shared/stripeClient.ts`.**

**Presigned-PUT generation — 5 near-identical implementations, 5 S3 clients.**
[crm-docs:941](apps/web/amplify/functions/crm-docs/handler.ts:941) (`expiresIn:300`),
[crm-docs:5624](apps/web/amplify/functions/crm-docs/handler.ts:5624),
[crm-docs:5643](apps/web/amplify/functions/crm-docs/handler.ts:5643),
[crm-docs:5681](apps/web/amplify/functions/crm-docs/handler.ts:5681),
[crm-pricing:421](apps/web/amplify/functions/crm-pricing/handler.ts:421).
Bucket resolution is duplicated in parallel (`BUCKET()` in two files plus four raw
`process.env.DOCS_BUCKET` reads). Most correct: `getReportPhotoUploadUrl` —
validates content type against an allow-map and validates the parent record.
**Canonical: `shared/s3Presign.ts` + one `S3Client`.**

**`ensureRouteAndOrder()` copied verbatim.**
[bookingFinalize.ts:33](apps/web/amplify/functions/shared/bookingFinalize.ts:33)–92
and [assignVisit.ts:98](apps/web/amplify/functions/shared/assignVisit.ts:98)–155,
identical bodies including the identical inline comment. `assignVisit.ts:93-97`
documents the copy as intentional (bundle size), but both files already import
`shared/pagination`. **Canonical: `shared/routeOrder.ts`.**

**Cognito `ListUsersInGroup` pagination hand-rolled 3×** — the only surviving
`do…while(token)` loops:
[crm-admin:2177](apps/web/amplify/functions/crm-admin/handler.ts:2177),
[:2200](apps/web/amplify/functions/crm-admin/handler.ts:2200) (differs from the
previous only by `u.Username !== exceptUsername &&`),
[:3148](apps/web/amplify/functions/crm-admin/handler.ts:3148). Competing with
[shared/pagination.ts:41](apps/web/amplify/functions/shared/pagination.ts:41)
`forEachPage` / `:62` `listAll`, used 120× in Lambdas and 56× in the CRM, whose
header states "nobody hand-writes `do … while (nextToken)`". **Canonical:
`forEachPage` + a `listUsersInGroup` adapter for `PascalCase` `NextToken`.**

**Smaller backend duplicates.**

- Customer creation, 3 paths: [leadLifecycle.ts:275](apps/web/amplify/functions/shared/leadLifecycle.ts:275) `createLead` (canonical, dedupes via [leadIdentity.ts:74](apps/web/amplify/functions/shared/leadIdentity.ts:74)) vs [bookingFinalize.ts:1400](apps/web/amplify/functions/shared/bookingFinalize.ts:1400) (deterministic `cust-<bookingId>`, own phone-rejection retry) vs [agreementImport.ts:145](apps/web/amplify/functions/shared/agreementImport.ts:145)
- `normalizeEmail`/`normalizePhone`, 3 copies with **different return contracts** (`undefined` vs `null`): [leadIdentity.ts:18](apps/web/amplify/functions/shared/leadIdentity.ts:18), [lead-intake/handler.ts:86](apps/web/amplify/functions/lead-intake/handler.ts:86), [booking-public/handler.ts:256](apps/web/amplify/functions/booking-public/handler.ts:256)
- `parseQuoteSnapshot`, 2 copies: [quoteDoc.ts:41](apps/web/amplify/functions/shared/quoteDoc.ts:41) (exported) vs [pricing-refresh/handler.ts:306](apps/web/amplify/functions/pricing-refresh/handler.ts:306) (private re-implementation)
- [driveTime.ts](apps/web/amplify/functions/shared/driveTime.ts) issues three near-identical `computeRoutes` POSTs (`:27`, `:66`, `:106`) and two `distanceMatrix` POSTs (`:145`, `:212`) — five copies of the same headers/field-mask boilerplate

### 1.3 Auth and permission checks

Server-side role *reading* is well centralized: `cognito:groups` is parsed in
exactly two places repo-wide —
[authz.ts:17](apps/web/amplify/functions/shared/authz.ts:17) for all Lambdas and
[auth.tsx:49](apps/crm/src/lib/auth.tsx:49) for the browser. The duplication is in
layering and in identity resolution.

**Four names for one predicate.** `callerIsOffice` and `callerIsFinance` are
aliases of `callerIsOwner`; `assertOffice`/`assertFinance` alias `assertOwner`.

| Name | Location | Sites |
|---|---|---|
| `callerIsOwner` | [authz.ts:68](apps/web/amplify/functions/shared/authz.ts:68) | 9 |
| `callerIsOffice` | [authz.ts:74](apps/web/amplify/functions/shared/authz.ts:74) | 10 |
| `callerIsFinance` | [authz.ts:82](apps/web/amplify/functions/shared/authz.ts:82) | 4 |
| `assertOffice` | [authz.ts:88](apps/web/amplify/functions/shared/authz.ts:88) | 24 |
| `assertFinance` | [authz.ts:100](apps/web/amplify/functions/shared/authz.ts:100) | 10 |
| `assertOwner` | [authz.ts:108](apps/web/amplify/functions/shared/authz.ts:108) | 2 |

They agree today, so this causes no live inconsistency — but it makes the
privilege surface unreadable. One inline check inside `authz.ts` itself bypasses
the helper: [authz.ts:141](apps/web/amplify/functions/shared/authz.ts:141) uses
`groups.includes("OWNER")` where it should call `callerIsOwner`.
**Canonical: `callerIsOwner`/`assertOwner`; retire the four aliases (48 sites).**

**Role vocabulary declared 4 times.** Cognito
([auth/resource.ts:58](apps/web/amplify/auth/resource.ts:58), source of truth) vs
`STAFF_ROLES` ([staffRoles.ts:12](apps/web/amplify/functions/shared/staffRoles.ts:12))
vs `STAFF_GROUPS` ([authz.ts:94](apps/web/amplify/functions/shared/authz.ts:94),
**verbatim duplicate, zero callers**) vs `ROLE_CHOICES`
([Staff.tsx:53](apps/crm/src/office/Staff.tsx:53)).
**Canonical: `staffRoles.ts`; delete `authz.ts:94-98`.**

**Removed roles still referenced.** `OFFICE`/`FINANCE` were deleted from the pool
but survive in live branches:

- [Staff.tsx:71](apps/crm/src/office/Staff.tsx:71) — `set.has("OWNER") || set.has("OFFICE") || set.has("FINANCE")`; the latter two can never appear
- [crm-admin/handler.ts:2812](apps/web/amplify/functions/crm-admin/handler.ts:2812) — offboarding still sweeps both deleted groups
- [auth.tsx:15](apps/crm/src/lib/auth.tsx:15) keeps `office`/`finance` as aliases; ~60 sites across 10 files consume them

Not to be confused with `ownerTeam: "FINANCE"` (~60 hits) — that is a work-queue
team label from [ownedWork.ts:11](apps/web/amplify/functions/shared/ownedWork.ts:11),
unrelated to auth.

**"Which customer is this request for?" — 5 resolvers.**

| Entry | Impl | Sites |
|---|---|---|
| `customerId` | `canActForCustomer` [authz.ts:136](apps/web/amplify/functions/shared/authz.ts:136) | 9 |
| `servicePlanId` | `assertCanActForPlan` [crm-billing:113](apps/web/amplify/functions/crm-billing/handler.ts:113) | 2 |
| `invoiceId` | inline [crm-billing:1051](apps/web/amplify/functions/crm-billing/handler.ts:1051) | 1 |
| S3 `key` | inline regex [crm-docs:5798](apps/web/amplify/functions/crm-docs/handler.ts:5798) | 1 |
| `callbackRequestId` | inline [crm-docs:521](apps/web/amplify/functions/crm-docs/handler.ts:521) | 1 |
| `jobId`/`reportId` | [jobAssignment.ts:165](apps/web/amplify/functions/shared/jobAssignment.ts:165) | 15 |

The three inline variants each re-implement the "opaque error whether missing or
someone else's" idiom differently. Most correct: `canActForCustomer` — reads the
row's live `accessGroups` stamp rather than trusting the token, so group removal
takes effect without re-login. **Canonical: keep it as the leaf; add one
`assertCanActForRecord(identity, model, id)` for the three inline copies.**

**Two authorization layers, applied inconsistently.** ~110 declarative
`allow.groups(...)` gates in [resource.ts](apps/web/amplify/data/resource.ts)
vs imperative re-asserts in handlers: crm-docs 24, crm-billing 13, crm-pricing 3,
and **crm-admin 0 across all 24 cases**. Cleanest form is
[crm-pricing:103](apps/web/amplify/functions/crm-pricing/handler.ts:103) — one
blanket assert before the switch, narrowed per case. **Canonical: that shape.**

**`grp-`/`cus-` handling spread across ~5 places.** Names come from
[dynamicGroups.ts:11](apps/web/amplify/functions/shared/dynamicGroups.ts:11), but
[agreementImport.ts:133](apps/web/amplify/functions/shared/agreementImport.ts:133)
hand-builds `` `grp-${groupId}` ``, and the grant loop is written three times:
[portalProvision.ts:136](apps/web/amplify/functions/shared/portalProvision.ts:136),
[:172](apps/web/amplify/functions/shared/portalProvision.ts:172),
[crm-admin:1334](apps/web/amplify/functions/crm-admin/handler.ts:1334).
`addToGroup` ([portalProvision.ts:51](apps/web/amplify/functions/shared/portalProvision.ts:51))
and `removeFromGroup` ([crm-admin:662](apps/web/amplify/functions/crm-admin/handler.ts:662))
live in different modules. Frontend re-parses the prefix with a magic
`.slice(4)` at [auth.tsx:91,98](apps/crm/src/lib/auth.tsx:91).
**Canonical: one `syncPortalGroups(username, wanted)` in `portalProvision.ts`;
add `parseGrpGroup`/`parseCusGroup` to `dynamicGroups.ts`.**

#### Reachable entry points with no authz check

1. **[crm-admin/handler.ts:221](apps/web/amplify/functions/crm-admin/handler.ts:221)** — all 24 cases, zero in-handler assertion. Sole gate is `allow.groups(["OWNER"])` in the schema. Covers `adminCreateUser`, `changeStaffRoles`, `offboardStaff`, `revokePortalAccess`. The privilege-granting surface is the one without defense in depth.
2. **[crm-admin/handler.ts:247](apps/web/amplify/functions/crm-admin/handler.ts:247)** `resumeGroupChange` — verified absent from `resource.ts` (0 occurrences), so it is reachable only by direct Lambda invoke. The comment at `:248-250` claims an AppSync office identity may trigger it; that path does not exist.
3. **[crm-admin/handler.ts:351](apps/web/amplify/functions/crm-admin/handler.ts:351)** `reportSuspectAddresses` — same, also undeclared. Read-only, low severity.
4. **[crm-billing/handler.ts:296](apps/web/amplify/functions/crm-billing/handler.ts:296)** `assignRecoveryOwner` — the only case in that file without an assert; correct today via the schema gate, but the lone exception among 13 siblings.
5. **[lead-intake/handler.ts:187](apps/web/amplify/functions/lead-intake/handler.ts:187)** — **highest severity.** Public Function URL with `authType: NONE`. Verified: no signature, no secret, no bot token, no rate limit (`grep -nE "throttle|botToken|secret|signature|hmac|captcha"` → no matches). Writes `Customer` rows via `createLead(..., force: true)` at `:245`. [backend.ts:240](apps/web/amplify/backend.ts:240) names CORS as the protection — but the handler returns `Access-Control-Allow-Origin: "*"` at [:67](apps/web/amplify/functions/lead-intake/handler.ts:67), contradicting the CDK allowlist, and CORS is a browser policy that `curl` ignores either way. The three sibling public endpoints all gate properly: [stripe-webhook:42](apps/web/amplify/functions/stripe-webhook/handler.ts:42) verifies signatures, [thumbtack-webhook:109](apps/web/amplify/functions/thumbtack-webhook/handler.ts:109) uses `timingSafeEqual`, [booking-public:882,904](apps/web/amplify/functions/booking-public/handler.ts:882) has `verifyBotToken` + `throttleOk`.
6. **[booking-public/handler.ts:358](apps/web/amplify/functions/booking-public/handler.ts:358)** — the `internalOp` trusted branch is gated only by the *absence* of `requestContext.http`. The reasoning is sound but the whole portal add-service trust boundary rests on one negative check with no secondary marker.

### 1.4 Money formatting

Storage is unambiguously cents — every money field in the schema is `a.integer()`
with a `Cents` suffix, and no dollar-denominated persisted field exists. Rounding
mode is consistently `Math.round`, and no float accumulation was found: totals sum
integer cents and divide by 100 only at the render boundary. **Proration, tax, and
discount are each single-sourced** (Stripe `proration_behavior: "none"`, Stripe tax
rates, and [promo.ts:118](apps/web/amplify/functions/booking-public/promo.ts:118)
`discountFor`). The problem is display.

**9 named formatters plus 89 inline `toFixed(2)` sites. No `Intl.NumberFormat`
anywhere (0 hits).**

| Group | Shape | Copies |
|---|---|---|
| A | `toLocaleString` w/ 2 fraction digits | 5 byte-identical: [cancellationPolicy.ts:51](apps/web/amplify/functions/shared/cancellationPolicy.ts:51), [planCancellationPolicy.ts:43](apps/web/amplify/functions/shared/planCancellationPolicy.ts:43), [visitChange.ts:91](apps/web/amplify/functions/shared/visitChange.ts:91), [pdf.ts:191](apps/web/amplify/functions/shared/pdf.ts:191), [deactivation.ts:651](apps/web/amplify/functions/shared/deactivation.ts:651) |
| B | `toFixed(2)`, no separator | [receipts.ts:20](apps/web/amplify/functions/shared/receipts.ts:20) + 89 inline |
| C | whole dollars stay whole | 2: [rateCards.ts:197](apps/web/amplify/functions/crm-pricing/rateCards.ts:197), [bookingFunnel.ts:142](apps/web/src/lib/bookingFunnel.ts:142) |
| D | `Intl` via `style:"currency"` | 1: [format.ts:1](apps/crm/src/lib/format.ts:1) — the only null-safe one |
| E | no fraction digits | 1: [crm-billing:147](apps/web/amplify/functions/crm-billing/handler.ts:147) |

Verified divergence for `priceCents = 120000`: A → `$1,200.00`, B → `$1200.00`,
C → `$1200`, D → `$1,200.00`, E → `$1,200`. A single plan price therefore renders
four different ways depending on whether the customer is looking at the booking
funnel (C), the PDF agreement (A), the receipt email (B), or the CRM (D).

Group B's 89 inline sites concentrate in
[bookingFinalize.ts](apps/web/amplify/functions/shared/bookingFinalize.ts) (29),
[daily-reminders](apps/web/amplify/functions/daily-reminders/handler.ts) (14),
[stripe-webhook](apps/web/amplify/functions/stripe-webhook/handler.ts) (11).

Most correct: [format.ts:1](apps/crm/src/lib/format.ts:1) — locale-aware, null-safe,
correct grouping. **Canonical: a shared `money.ts` exporting
`formatMoney(cents, {compactWholeDollars?})` backed by a module-level
`Intl.NumberFormat`** (construct once — `dates.ts:24` and `businessHours.ts:18`
already hoist their `Intl` instances; none of the 9 money helpers do).

**Dollars→cents conversion — ~13 sites, no shared helper**, all
`Math.round(x * 100)` but with **different input validation**:
[autoQuote.ts:68](apps/web/amplify/functions/thumbtack-webhook/autoQuote.ts:68)
guards `Number.isFinite`; [marketRate.ts:952](apps/web/amplify/functions/shared/marketRate.ts:952)
guards finite-and-positive; the four sites in
[CustomerDetail.tsx:2057,2185,2344,2995](apps/crm/src/office/CustomerDetail.tsx:2057)
call bare `parseFloat` and yield `NaN` cents on malformed input.
**Canonical: `dollarsToCents(input): number | null` with the guard baked in.**

Naming collision worth fixing: `tidy`
([marketRate.ts:164](apps/web/amplify/functions/shared/marketRate.ts:164), rounds to
a `$X9` ending) vs `tidyDollars`
([availability.ts:52](apps/web/amplify/functions/booking-public/availability.ts:52),
rounds to a whole dollar). Different jobs, near-identical names, different results
(`12750` → `$129` vs `$128`).

### 1.5 Date handling

No date library. `dates.ts` documents an intentional Eastern/UTC split, and the
UTC callers mostly hold to it (dedupe keys, day-bucket ids, export filenames), so
this is not the "UTC-today" class of bug — that was closed in `635fafa`.

**`addDays(iso, n)` — 6 implementations.**
[cancellationPolicy.ts:47](apps/web/amplify/functions/shared/cancellationPolicy.ts:47),
[assignVisit.ts:17](apps/web/amplify/functions/shared/assignVisit.ts:17),
[recurring.ts:30](apps/web/amplify/functions/shared/recurring.ts:30),
[availability.ts:41](apps/web/amplify/functions/booking-public/availability.ts:41),
[agingMath.ts:32](apps/web/amplify/functions/shared/agingMath.ts:32) (comment
acknowledges the copy: "like recurring.ts"),
[format.ts:41](apps/crm/src/lib/format.ts:41).

The CRM copy is the odd one out — **verified**: it constructs at local noon
(`` new Date(`${isoDate}T12:00:00`) ``), mutates with `setDate`, then extracts with
`toISOString()` (UTC). Correct at any UTC-negative offset, so correct for all US
staff; it returns `n-1` for a browser at UTC+13 or beyond. It feeds
[format.ts:48](apps/crm/src/lib/format.ts:48) `startOfWeek` and the Schedule week
grid. Narrow in practice, but it is the only one of the six that depends on the
viewer's timezone. Most correct: `cancellationPolicy.ts:47` — pure calendar
arithmetic with no wall-clock anchor. **Canonical: promote it into `dates.ts`.**

**Day-difference — 4 implementations, one with different semantics.**
[agingMath.ts:64](apps/web/amplify/functions/shared/agingMath.ts:64) `daysBetween`
(shared, tested) vs inline copies at
[cancellationPolicy.ts:123](apps/web/amplify/functions/shared/cancellationPolicy.ts:123),
[businessHours.ts:114](apps/web/amplify/functions/shared/businessHours.ts:114),
[recovery.ts:49](apps/web/amplify/functions/shared/recovery.ts:49) (re-derives
`utcDayNumber` in a file that already imports from `agingMath`), and
[Work.tsx:783](apps/crm/src/office/Work.tsx:783) — which is **instant-based, not
calendar-based**: a job completed 23h ago reads 0 days regardless of how many
midnights passed, diverging from the AR aging semantics used everywhere else.

The day-length constant is spelled five ways: `MS_PER_DAY` (twice, two different
literals), `DAY_MS`, bare `86_400_000` (11 sites), bare `24*60*60*1000` (6 sites),
`86400_000` (2 sites).

**`isWeekday` — 4 implementations** ([capacity.ts:68](apps/web/amplify/functions/shared/capacity.ts:68)
is shared and already imported by `businessDays.ts`; `assignVisit.ts:23`,
`availability.ts:47`, `businessHours.ts:79` re-derive), plus a fifth spelling in
[season.ts:105](apps/web/amplify/functions/shared/season.ts:105). All agree on
output. **Canonical: `capacity.ts:68`.**

**Pretty-date rendering — 7 implementations, 4 anchoring strategies.**

| Location | Anchor | Render TZ |
|---|---|---|
| [recurring.ts:341](apps/web/amplify/functions/shared/recurring.ts:341) | `T12:00:00Z` | explicit UTC |
| [receipts.ts:26](apps/web/amplify/functions/shared/receipts.ts:26) | `T12:00:00Z` | explicit UTC |
| [planCancellationPolicy.ts:183](apps/web/amplify/functions/shared/planCancellationPolicy.ts:183) | `T00:00:00Z` | explicit UTC |
| [autoQuote.ts:138](apps/web/amplify/functions/thumbtack-webhook/autoQuote.ts:138) | `T12:00:00Z` | America/New_York |
| [daily-reminders:111](apps/web/amplify/functions/daily-reminders/handler.ts:111) | `T12:00:00` (no `Z`) | **none** |
| [bookingFunnel.ts:152](apps/web/src/lib/bookingFunnel.ts:152) | local parts | none |
| [format.ts:11](apps/crm/src/lib/format.ts:11) | `T12:00:00` (no `Z`) | none |

`daily-reminders:111` is correct only because Lambda runs `TZ=UTC`; it is the
only server-side "weekday, month day" formatter omitting both the `Z` and the
`timeZone`. Separately, instant formatting diverges by design boundary: server
PDFs render Eastern ([pdf.ts:151,158,749](apps/web/amplify/functions/shared/pdf.ts:151))
while CRM screens render the viewer's zone ([format.ts:20](apps/crm/src/lib/format.ts:20))
— the same timestamp shows two different times.

`America/New_York` appears as a bare literal 23 times; `BUSINESS_TZ`
([businessHours.ts:14](apps/web/amplify/functions/shared/businessHours.ts:14)) is
the only named constant and has zero external importers.

**Invoice due-date — 2 implementations.**
[agingMath.ts:39](apps/web/amplify/functions/shared/agingMath.ts:39)
`dueDateForTerms` (shared, tested, 2 callers) vs the hand-rolled
`due.setUTCDate(due.getUTCDate() + 30)` at
[booking-public/handler.ts:2753](apps/web/amplify/functions/booking-public/handler.ts:2753),
which bypasses `normalizeTerms`/`TERMS_DAYS`. Its comment claims it "drives AR
aging exactly like any other net-terms bill", but it is the one net-terms bill not
produced by the shared function — a change to `TERMS_DAYS` silently misses the
booking funnel. **Canonical: `dueDateForTerms`.**

**Eastern wall-clock → UTC instant — 2 implementations.**
[businessDays.ts:48](apps/web/amplify/functions/shared/businessDays.ts:48)
`easternWallToUtc` uses a two-pass convergence with no hard-coded offset.
[cancellationPolicy.ts:67](apps/web/amplify/functions/shared/cancellationPolicy.ts:67)
`easternEpochMs` parses `shortOffset` with a regex and **falls back to `-5` when
the regex misses** ([:75](apps/web/amplify/functions/shared/cancellationPolicy.ts:75)),
which is wrong half the year. It is also single-pass, so an instant near a DST
transition can resolve with the wrong offset. Its docstring claims it is the one
place callers share "this one DST-correct boundary maths" — but `businessDays.ts:48`
is the other one, and it is the more robust. This sits on the refund-window
boundary. **Canonical: `easternWallToUtc`.**

`businessDays.ts` / `businessHours.ts` / `season.ts` are otherwise the healthiest
cluster in the repo — genuinely single-sourced.

### 1.6 Forms, modals, lists, and component state

`apps/crm/src/ui/kit.tsx` (454 lines) is a real, well-adopted design kit —
`<Page>` 46 uses, `<Card>` 27 files, `<Button>` 35 files vs 8 files with raw
`<button>`. **`apps/web/src` has no shared UI primitives at all**; every form
control there is a raw `<input>` plus `bk-*` CSS classes.

**Forms.** No form library and no `useForm` hook. Four competing patterns:

| Pattern | Where |
|---|---|
| `useState`-per-field + inline `if (!x)` | [TalkToExpertModal.tsx:20](apps/web/src/components/TalkToExpertModal.tsx:20), [Contact.tsx:15](apps/web/src/pages/Contact.tsx:15) |
| Pure validator → field-keyed error map | [bookingFunnel.ts:238](apps/web/src/lib/bookingFunnel.ts:238) `validateQuoteForm`, consumed by [QuotePage.tsx:397](apps/web/src/pages/booking/QuotePage.tsx:397) |
| `values` object + `set(key)` curry | [CustomerForm.tsx:58](apps/crm/src/components/CustomerForm.tsx:58) |
| Ad-hoc `useState` in a `<Sheet>`, validation = `disabled={!x.trim()}` | ~35 CRM surfaces |

There are 3 `<form>` elements in the repo, all in `apps/web`. **`apps/crm` has
zero** across ~38 data-entry surfaces — no Enter-to-submit, no native validation.
`CustomerDetail.tsx` alone hosts 13 sheets.

Repeated validation:
- **Three competing email regexes** — [bookingFunnel.ts:198](apps/web/src/lib/bookingFunnel.ts:198) (strict, mirrors the server), [CustomerForm.tsx:70](apps/crm/src/components/CustomerForm.tsx:70) and [Staff.tsx:710](apps/crm/src/office/Staff.tsx:710) (both `/^\S+@\S+\.\S+$/`, retyped). `Contact.tsx` and `TalkToExpertModal.tsx` validate email **not at all**
- `normalizePhone` exists once ([bookingFunnel.ts:202](apps/web/src/lib/bookingFunnel.ts:202)) and is used only by `validateQuoteForm`; the CRM has no phone validation anywhere
- `onlyDigits` defined byte-identically twice: [QuotePage.tsx:135](apps/web/src/pages/booking/QuotePage.tsx:135), [AddService.tsx:79](apps/crm/src/portal/AddService.tsx:79)
- ZIP validated only at [QuotePage.tsx:1223](apps/web/src/pages/booking/QuotePage.tsx:1223)
- **~45-line verbatim duplicated lead-submit block**: [Contact.tsx:24-64](apps/web/src/pages/Contact.tsx:24) vs [TalkToExpertModal.tsx:62-98](apps/web/src/components/TalkToExpertModal.tsx:62) — same guards, same error copy, same name-splitting, same analytics triple; differs only in `formId` and 3 fields

**Toasts/notifications.** No toast system — `grep -rni "toast|snackbar|notification"`
returns 0 hits.

| Pattern | Count |
|---|---|
| `<ErrorNote>` ([kit.tsx:424](apps/crm/src/ui/kit.tsx:424)) | 82 uses / 34 files |
| `<SuccessNote>` ([kit.tsx:443](apps/crm/src/ui/kit.tsx:443)) | 3 |
| `alert()` | 5 |
| Hand-rolled `role="alert"` divs in `apps/web` | 17, across **3 competing class names** (`bk-field-error`, `bk-form-error`, `bk-notice`) |

Most correct: `ErrorNote` — handles `role="alert"`, scroll-into-view, and hides
raw exception text. **Canonical: export `ErrorNote`/`SuccessNote` into a package
shared with `apps/web`.** Note the 82:3 ratio — success feedback is largely absent.

**Modals.** `<Sheet>` ([kit.tsx:327](apps/crm/src/ui/kit.tsx:327)) used 39×; one
hand-rolled overlay ([TalkToExpertModal.tsx:106](apps/web/src/components/TalkToExpertModal.tsx:106));
zero `<dialog>`; **17 `window.confirm()`** for destructive actions.

Capability split: the web modal implements Escape-to-close, autofocus, and
scroll-lock; `Sheet` implements none of these and has no `role="dialog"`/
`aria-modal`. Neither has a focus trap. **Canonical: `Sheet`'s API + the web
modal's behavior; replace the 17 `window.confirm` with a `ConfirmSheet`** — that
pattern already exists twice as [VisitCancelSheet.tsx:98](apps/crm/src/components/VisitCancelSheet.tsx:98)
and [CancelPlanSheet.tsx:86](apps/crm/src/components/CancelPlanSheet.tsx:86).

**Lists.** There are **zero `<table>` elements** in either frontend; all tabular
data renders as div lists. `<ListRow>` ([kit.tsx:269](apps/crm/src/ui/kit.tsx:269))
is used 75×/24 files. [CustomerDocuments.tsx:160](apps/crm/src/components/CustomerDocuments.tsx:160)
re-implements the markup by hand and invents `list-row-subtitle` where the kit
uses `list-row-sub` — a live CSS divergence.

Per-list concerns re-implemented each time: 31 inline `.sort()` calls with no
shared comparator (the date-desc `localeCompare` idiom appears ≥8×); the
`q.trim().toLowerCase()` filter written 4×; `<EmptyState>` used 32× but
hand-rolled as `<p className="muted small">No … yet.</p>` in ~10 more places; no
loading skeletons; **no pagination UI anywhere** — every list full-fetches with
`listAll(... limit: 500 ...)`.

**Async state.** No `useAsync`/`useFetch`/`useQuery` hook exists. Only 2 Contexts
in the entire frontend ([auth.tsx:30](apps/crm/src/lib/auth.tsx:30),
[TalkToExpertModal.tsx:10](apps/web/src/components/TalkToExpertModal.tsx:10)); 5
custom hooks total, none of them fetch abstractions.

| Grep | Count |
|---|---|
| `const [error, setError] = useState<string \| null>(null)` | ~78 across ~45 files (13 in `CustomerDetail.tsx` alone) |
| busy/loading/saving state declarations | 52 |
| `} finally {` | 48 across 19 files |
| `catch (` | 95 |

The copy-pasted shape is `setBusy(true); setError(null); try { … } catch (err)
{ setError(err instanceof Error ? err.message : "Could not X") } finally
{ setBusy(false) }`. Of ~25 list screens, exactly one guards against stale
responses: [Customers.tsx:32](apps/crm/src/office/Customers.tsx:32) uses a
monotonic `reqRef`, with a comment explaining the bug. **Nobody else adopted it**,
so every other tab- or filter-switching list carries the same latent race. Zero
uses of the `let alive = true` cleanup idiom, so unmount-after-fetch `setState` is
unguarded everywhere. **Canonical: one `useAsync<T>(fn, deps)` with the `reqRef`
guard baked in, plus `useAction(fn, fallbackMsg)` for mutations.**

**Cross-app duplication.** Beyond `addressAutocomplete`: `money` (§1.4),
`formatDay`/`fmtDate`, `onlyDigits`, the email regex, and the office phone number
— hard-coded **14 times in 3 formats** across `apps/web/src`
([TalkToExpertModal.tsx:6](apps/web/src/components/TalkToExpertModal.tsx:6),
[Contact.tsx:8](apps/web/src/pages/Contact.tsx:8),
[QuoteCTA.tsx:4](apps/web/src/components/QuoteCTA.tsx:4),
[BookPage.tsx:38](apps/web/src/pages/booking/BookPage.tsx:38),
[SEO.tsx:139,166,276](apps/web/src/components/SEO.tsx:139), and 6 more).

### 1.7 Error handling

**No shared error module exists.** One error class
([`HttpError`, booking-public/handler.ts:445](apps/web/amplify/functions/booking-public/handler.ts:445))
— not exported, not reused. `grep -rn "AppError|ErrorCode|class .*Error"` → 1 hit.

**Six mutually incompatible handler conventions across 18 entry points:**

| Convention | Handlers |
|---|---|
| `HttpError` → `{statusCode, body:{error}}` | booking-public |
| `{statusCode, body:"<plain string>"}` — not JSON | stripe-webhook |
| `jsonResponse(status,{error})` | lead-intake, thumbtack-webhook |
| bare `throw new Error("free text")` → GraphQL `errors[]` | crm-docs (206 throws), crm-admin (69), crm-billing (51), crm-pricing (28) |
| domain result `{ok:false, …}` — **4 different field names** (`message`, `problem`, `reason`, `error`) | [crm-docs:967](apps/web/amplify/functions/crm-docs/handler.ts:967), [:1206](apps/web/amplify/functions/crm-docs/handler.ts:1206), [:4430](apps/web/amplify/functions/crm-docs/handler.ts:4430), [crm-billing:379](apps/web/amplify/functions/crm-billing/handler.ts:379) |
| collect `{task,error}[]`, open owned work, throw at end | daily-reminders, ses-events, ops-alerts — **the same pattern implemented three times** |

Outliers: [thumbtack-webhook:487](apps/web/amplify/functions/thumbtack-webhook/handler.ts:487)
returns HTTP **200** with `{ok:false}` after a failure (deliberate, to kill provider
retries, but it is the only handler reporting success on failure);
[pricing-refresh:1170](apps/web/amplify/functions/pricing-refresh/handler.ts:1170)
never throws; `pre-token` and `lead-sweep` have no error boundary at all.

Most correct: the daily-reminders/ses-events/ops-alerts triad — partial failure is
collected, made durably visible as owned work, *and* rethrown so the CloudWatch
alarm fires. **Canonical: one `shared/lambdaResult.ts` (`HttpError` moved out of
booking-public, one `httpFail`, one `runSubtasks`).**

**`err instanceof Error ? err.message : …` written out 144 times.** No
`errMessage()` helper exists (`grep -rn "function errMessage|toMessage|errorText"`
→ 0). In the frontend this pairs with ~85 distinct hand-written fallback strings
("Could not load", "Could not save", …), several duplicated verbatim.

**Customer-facing leakage: clean.** The catch-all at
[booking-public:434](apps/web/amplify/functions/booking-public/handler.ts:434)
returns fixed copy, and all 74 `throw new HttpError` payloads are author-written.
Raw `err.message` reaches only office-facing surfaces
([:3537](apps/web/amplify/functions/booking-public/handler.ts:3537) owned-work
detail, [:3558](apps/web/amplify/functions/booking-public/handler.ts:3558) ops
email, escaped). This is achieved by discipline, not by a mechanism — the other 14
handlers have no way to express the customer/ops split. **Canonical: `AppError`
with `customerMessage` (safe, always returned) vs `cause` (ops-only, never
serialized).**

**Idempotency — 5 mechanisms.** CAS conditional writes
([atomicLock.ts](apps/web/amplify/functions/shared/atomicLock.ts)) are the real
primitive. Above them sit two near-identical durable-command claim state machines
with different failure vocabularies —
[lifecycleCommand.ts:109](apps/web/amplify/functions/shared/lifecycleCommand.ts:109)
and [staffAccessCommand.ts:102](apps/web/amplify/functions/shared/staffAccessCommand.ts:102)
— plus deterministic digest ids, owned-work `dedupeKey`, and **four ad-hoc Stripe
idempotency key formats** ([refund.ts:117](apps/web/amplify/functions/shared/refund.ts:117),
[recovery.ts:180](apps/web/amplify/functions/shared/recovery.ts:180),
[subscription.ts:267](apps/web/amplify/functions/shared/subscription.ts:267),
[leadLifecycle.ts:558](apps/web/amplify/functions/shared/leadLifecycle.ts:558)).

On `recovery.ts:180`: the minute bucket in that key is **deliberate and
documented** — the comment explains it lets a customer retry with a new card
instead of replaying a 24h-cached decline. Worth noting only because the key
already includes `pm.id`, which covers that case on its own; the residual effect
is that a genuine double-submit straddling a minute boundary produces two charges.

`bookingFinalize.ts` documents idempotency in 13 places but has no helper of its
own. **Canonical: one `shared/idempotency.ts` on top of `atomicLock`, plus one
`stripeIdempotencyKey(scope, id, discriminator)` builder.**

**Logging.** No structured logger. `shared/opEvent.ts` is not one — it is a
15-line AppSync field-name resolver. Three unrelated structured-event writers
exist (`lifecycleLog`, `staffAccessLog`, `ownedWork`); everything else is raw
console: ~180 `console.error` across 38 files, 32 `console.log`, 9 `console.warn`,
0 structured loggers. Modules that log *only* to console — a failure there is
log-search-only — include [receipts.ts](apps/web/amplify/functions/shared/receipts.ts) (5),
[capacity.ts](apps/web/amplify/functions/shared/capacity.ts) (7),
[planCancellation.ts](apps/web/amplify/functions/shared/planCancellation.ts) (6),
[marketRate.ts](apps/web/amplify/functions/shared/marketRate.ts) (5).
**Canonical: `shared/log.ts` emitting one JSON line, with a rule that any
`console.error` in a money/scheduling/auth path is paired with `openOwnedWork`.**

### 1.8 Swallowed errors

Three idioms, all hand-written at each site.

**`.catch(() => <fallback>)` — 114 backend sites**
(`=> undefined` ×90, `=> ({data:null})` ×12, `=> null` ×5, `=> false` ×3).
Most consequential, all in money or scheduling paths:

| Location | What is masked |
|---|---|
| [bookingFinalize.ts:26](apps/web/amplify/functions/shared/bookingFinalize.ts:26) | `releaseSlot` failure — reserved capacity minutes leak after a failed finalize |
| [bookingFinalize.ts:551](apps/web/amplify/functions/shared/bookingFinalize.ts:551) | CAS stamp coerced to `{ok:false, reason:"UNSUPPORTED"}` — a real CAS error is indistinguishable from missing wiring |
| [bookingFinalize.ts:556,561,577](apps/web/amplify/functions/shared/bookingFinalize.ts:556) | the compensating releases on that path are themselves swallowed |
| [capacity.ts:521](apps/web/amplify/functions/shared/capacity.ts:521), [:619](apps/web/amplify/functions/shared/capacity.ts:619) | stop-counter giveback — a stop leaks on every refused claim / failed release |
| [capacity.ts:710,716,727](apps/web/amplify/functions/shared/capacity.ts:710) | the "move a hold to a new day" path: update and both releases all swallow |
| [capacity.ts:776](apps/web/amplify/functions/shared/capacity.ts:776) | `extendCapacityClaim` returns `false` on error identically to "no such claim" |
| [stripe-webhook:107,120](apps/web/amplify/functions/stripe-webhook/handler.ts:107) | pending-bank-debit re-claim — a slot silently not re-held |
| [planCancellation.ts](apps/web/amplify/functions/shared/planCancellation.ts) ×8 | settlement writes |

**`catch (e) { console.error(...) }` with no rethrow and no caller signal —
~120 sites.** Most consequential:

| Location | Path | What is lost |
|---|---|---|
| [bookingFinalize.ts:1231](apps/web/amplify/functions/shared/bookingFinalize.ts:1231) | money | default payment method never set — renewals fail later with no marker |
| [bookingFinalize.ts:2725](apps/web/amplify/functions/shared/bookingFinalize.ts:2725) | money | a failed bank debit can leave a live subscription |
| [bookingFinalize.ts:2172](apps/web/amplify/functions/shared/bookingFinalize.ts:2172) | comms | catch **returns `true`** ("treat as sent") — a deliberate but silent lie |
| [receipts.ts:103,151,191,237,286](apps/web/amplify/functions/shared/receipts.ts:103) | money | all five customer money notices swallow identically — 5 copies of one 4-line block |
| [booking-public:3421,3427](apps/web/amplify/functions/booking-public/handler.ts:3421) | money | `cancelRequestedAt` anchor not persisted — a later retry recomputes refundability from a different instant |

**`pageErrors: "ignore"` — 110 sites.** Defined once, correctly, at
[pagination.ts:14](apps/web/amplify/functions/shared/pagination.ts:14), whose
docstring already names it as debt and says "do not write it into new code".
Concentration: [daily-reminders](apps/web/amplify/functions/daily-reminders/handler.ts) 34,
[crm-docs](apps/web/amplify/functions/crm-docs/handler.ts) 14,
[capacity.ts](apps/web/amplify/functions/shared/capacity.ts) 10,
[technicianReads.ts](apps/web/amplify/functions/shared/technicianReads.ts) 7,
[planCancellation.ts](apps/web/amplify/functions/shared/planCancellation.ts) 7.

**Frontend `} catch { }` returning a benign value — 52 sites.** Notable:
[api.ts:943](apps/crm/src/lib/api.ts:943) `listLifecycleCommands` returns `[]` on
failure, so a read error renders as "no stuck transitions" and the recovery banner
disappears. [api.ts:908](apps/crm/src/lib/api.ts:908) is the only site in the repo
that signals partial failure (`{data, readFailed:true}`) — 1 of 7 sibling call
sites. **No `ErrorBoundary` exists in either frontend** (0 hits).

**Canonical: `Result<T> = {ok:true,data:T} | {ok:false,code,message,partial?:T}`
plus one `bestEffort(fn, {reason})` that logs *and* records an ops marker.**

---

## 2. File size offenders

60 non-test files exceed 500 lines. The 20 test files over 500 lines are listed at
the end and are not analysed — large test files are not the same defect.

| File | Lines | Distinct responsibilities |
|---|---|---|
| [crm-docs/handler.ts](apps/web/amplify/functions/crm-docs/handler.ts) | 5946 | **21** — dispatch table (~48 cases), portal requests, per-visit money reconciliation, 8 work-item verifiers, office email, job creation + dispatch packet, assignment events + field authz, geo presence + accuracy review, report validation, PDF delivery, finalize claim lease, inventory depletion, 4-checkpoint finalize saga, amendment parsing, plan billing start, On-My-Way tracking, draft save + photo attach, no-access exits, 4 presign endpoints, customer document registry |
| [data/resource.ts](apps/web/amplify/data/resource.ts) | 4043 | 6 — field-auth helpers, ~22 enums, ~50 `a.model()` entities, ~10 saga/claim models, ~85 custom ops across 6 handlers, `defineData` |
| [booking-public/handler.ts](apps/web/amplify/functions/booking-public/handler.ts) | 3716 | 12 — SSM/Stripe/CORS shell, internal-op path, 8-suffix HTTP router, quote parsing, track/status polling, bot+throttle, lead prefill, **~900-line `quote`**, Stripe intent convergence, promo preview, **~800-line `book`**, cancel + refund policy |
| [office/CustomerDetail.tsx](apps/crm/src/office/CustomerDetail.tsx) | 3492 | 14 — container with ~25 state slices, payment method, portal access, plans, jobs, records/history, invoices, 5 sheet hosts, `RefundSheet`, `ChargeCardSheet`, `RecordPaymentSheet`+`SettleInvoiceSheet`, reschedule/amend/recovery forms, packet+job forms, `GroupPicker`, portal requests, callbacks |
| [crm-admin/handler.ts](apps/web/amplify/functions/crm-admin/handler.ts) | 3351 | 12 — ~28-case dispatch, lifecycle preview, technician + license, Cognito membership + login kill, invite provisioning, group sync, portal revoke/restore, reactivate + contact, job reassignment + offboard notify, staff roles + owner-count guards, `changeStaffRoles`, `offboardStaff`, roster query, suppression lift |
| [daily-reminders/handler.ts](apps/web/amplify/functions/daily-reminders/handler.ts) | 3009 | 13 — cron orchestrator + 5 reconciler groups, 5 ops reports, staffing digest, dunning + delinquency, invoice reminders, AR aging + dispute deadlines, processing-payment recon, ownership/group recon, queued email retry, paid-booking recon, overdue escalation |
| [shared/bookingFinalize.ts](apps/web/amplify/functions/shared/bookingFinalize.ts) | 2838 | 10 — slot release + route creation, agreement content constants, finalize entry + claim, retry/orphan reclaim, attribution parsing, existing-customer matching, pricing won-marking, **`finalizeClaimed` (863 lines)**, comms claim lease, comms delivery + drain, late-payment settlement |
| [tech/JobDetail.tsx](apps/crm/src/tech/JobDetail.tsx) | 2011 | 8 — product row helpers + localStorage memory, `useOnline`, job container, On-My-Way controls, detail cards, `ScopePrepExits`, `CallbackFindingCard`, `NoAccessCard`, **`ReportForm` (696 lines)**, `ProductRowEditor` |
| [shared/visitChange.ts](apps/web/amplify/functions/shared/visitChange.ts) | 2002 | 9 — lease constants, invoice classification, preview building, event recording, notification, **`cancelVisit` saga (653 lines)**, claim lifecycle, outcome derivation, `resumeVisitChange`, **`rescheduleVisit` (601 lines)** |
| [shared/pdf.ts](apps/web/amplify/functions/shared/pdf.ts) | 1599 | 6 — `PdfWriter` primitive, brand constants, `AgreementDoc`, and four document renderers (agreement, quote, service report, amendment) |
| [shared/capacity.ts](apps/web/amplify/functions/shared/capacity.ts) | 1533 | 8 — keys/constants, tech base resolution, day eligibility, slot reads, reserve/release, pool minutes, day claim lease, schedule guards, feasibility + `bestSlotFor`, closed-tour routing, day reconciliation |
| [crm-pricing/handler.ts](apps/web/amplify/functions/crm-pricing/handler.ts) | 1514 | 8 — clients, 5-case dispatch, research request, rollback, presign, drive-minutes, reply composition, **`priceLead` (~840 lines)**, `extractQuoteIntent` |
| [booking/QuotePage.tsx](apps/web/src/pages/booking/QuotePage.tsx) | 1386 | 7 — pending-quote localStorage, field types, container with ~15 state slices, lead prefill, form render, priced result + date selection, loading screen |
| [pricing-refresh/handler.ts](apps/web/amplify/functions/pricing-refresh/handler.ts) | 1353 | 9 — budget/backoff, secret cache, row listing, work selection, quote snapshot parsing, cross-Lambda recompute, rate-ready PDF email, digest formatting, failure settlement, orchestration |
| [shared/planCancellation.ts](apps/web/amplify/functions/shared/planCancellation.ts) | 1268 | 8 — preview types + balance, `buildCancellationPreview`, outcome types, settlement, invoice facts, drive saga, claim write + `cancelPlanForCustomer`, orphan reclaim + resume, confirmation email |
| [crm-billing/handler.ts](apps/web/amplify/functions/crm-billing/handler.ts) | 1119 | 9 — arg types, actor + charge-ceiling authz, ~19-case dispatch, setup intent, booking-public bridge, payment summary, subscription lifecycle, charges, invoice ops, recovery assignment |
| [stripe-webhook/handler.ts](apps/web/amplify/functions/stripe-webhook/handler.ts) | 1089 | 8 — verify + 11-case dispatch, setup intent, funnel payment, subscription invoice paid, post-cancellation staging, decline reasons, refunds, subscription deleted, disputes |
| [office/MarketRates.tsx](apps/crm/src/office/MarketRates.tsx) | 1063 | 5 — status maps, `EnginePanel`, container, `RateForm`, `RollbackPanel` |
| [office/Schedule.tsx](apps/crm/src/office/Schedule.tsx) | 1062 | 5 — week date math, container, week board, needs-scheduling pool + assignment, `AvailabilityPanel` (PTO/closures) |
| [booking/BookPage.tsx](apps/web/src/pages/booking/BookPage.tsx) | 1060 | 7 — constants, container with ~25 state slices, terms acceptance, promo, payment mode + intent, finalize polling, `PaymentForm`, layout |
| [shared/marketRate.ts](apps/web/amplify/functions/shared/marketRate.ts) | 1058 | 8 — re-exports, TTL/model constants, HOA multiplier, tidying + floors, key derivation, rollback + catalog snapshot, cache read, enqueue, research + LLM prompt/parse |
| [shared/leadLifecycle.ts](apps/web/amplify/functions/shared/leadLifecycle.ts) | 1057 | 8 — actor/channel types, id helpers, activity append, recovery work, `createLead`, consent gate, `logLeadTouch`, website intake ×3, `setLeadDisposition`, ownership assignment |
| [lib/api.ts](apps/crm/src/lib/api.ts) | 1008 | 7 — client factory, ~25 type re-exports, lead constants, lead ops, technician queries, work/suppression ops, invoice ops, plan cancellation, visit change |
| [shared/deactivation.ts](apps/web/amplify/functions/shared/deactivation.ts) | 1006 | 5 — option types, **`deactivateCustomer` (~530 lines)**, cents formatting, job sweep, inventory building, notice email, balance |
| [amplify/backend.ts](apps/web/amplify/backend.ts) | 966 | 10 — backend registration, Cognito hardening, CAS lock IAM, SSM publication, 4 function URLs, S3 + SES policy, cross-invoke SSM names, SES config set + SNS + DLQ, CloudWatch alarms, backup vault |
| [office/Dashboard.tsx](apps/crm/src/office/Dashboard.tsx) | 935 | 8 — period types, container loads, revenue + discounts, AR aging, recovery queue, disputes, 4 exception cards, `DrillPanel` |
| [office/Work.tsx](apps/crm/src/office/Work.tsx) | 843 | 5 — kind labels, container, open/resolved lists, override sheet, `PaymentsInFlight` |
| [shared/workPolicy.ts](apps/web/amplify/functions/shared/workPolicy.ts) | 824 | 3 — types, **~40-entry `WORK_POLICY` data table (673 lines)**, lookup helpers. *Mostly data; least urgent on this list.* |
| [office/Staff.tsx](apps/crm/src/office/Staff.tsx) | 782 | 5 — role mapping, roster, `AccessHistory`, `RosterBadges`, `StaffActions`, `InviteForm` |
| [office/technicians.tsx](apps/crm/src/office/technicians.tsx) | 746 | 4 — compliance derivation, roster, `LicenseRecords`, `TechForm` |
| [shared/subscription.ts](apps/web/amplify/functions/shared/subscription.ts) | 724 | 5 — Stripe resource ensures, cycle anchor, `startPlanBilling`, queued visit cancellation, job money facts, `cancelPlanBilling` |
| [shared/email.ts](apps/web/amplify/functions/shared/email.ts) | 597 | 6 — SES client, `emailShell` template, MIME building, send + resend, consent/suppression gates, logging + failure work, ops notifications |
| [residential/Residential.tsx](apps/web/src/pages/residential/Residential.tsx) | 554 | 2 — 192 lines of static content data, then 11 marketing sections |
| [shared/atomicLock.ts](apps/web/amplify/functions/shared/atomicLock.ts) | 552 | 5 — types + store interface, table suffix resolution, condition building, `dynamoStore` + error classification, 6 CAS operations, memory test double |
| [portal/AddService.tsx](apps/crm/src/portal/AddService.tsx) | 515 | 4 — service types + needs, result types, container, confirmation render |
| [services/Wildlife.tsx](apps/web/src/pages/services/Wildlife.tsx) | 503 | 2 — 119 lines of content data, 9 marketing sections |
| [lib/bookingApi.ts](apps/web/src/lib/bookingApi.ts) | 503 | 4 — URL discovery, ~20 request/response types, generic `post`, lead token storage, 7 endpoint wrappers |
| [services/HumaneRemoval.tsx](apps/web/src/pages/services/HumaneRemoval.tsx) | 501 | 2 — 181 lines of content data, 9 marketing sections |

**Patterns across the list.** Four recurring shapes drive most of the bulk:

1. **Dispatch-table handlers** (`crm-docs` 48 cases, `crm-admin` 28, `crm-billing` 19, `stripe-webhook` 11) — the router and every operation body live in one file.
2. **Saga bodies** — single functions of 500–900 lines: `finalizeClaimed` (863), `priceLead` (~840), `quote` (~900), `book` (~800), `cancelVisit` (653), `rescheduleVisit` (601), `deactivateCustomer` (~530).
3. **Container + every sheet it opens** — `CustomerDetail.tsx` holds 8 sheet components; `JobDetail.tsx` holds 5 cards plus a 696-line form.
4. **Marketing pages inlining their content** — `Residential`, `Wildlife`, `HumaneRemoval` are 35–40% static data arrays. These three also share an identical 9-section structure and are the natural home for the shared service-page component noted in §5.

Test files over 500 lines (not analysed): `crm-docs/compliance.test.ts` 2248,
`crm-admin/offboarding.test.ts` 1932, `booking-public/quote.test.ts` 1920,
`bookingFinalize.test.ts` 1751, `pricing-refresh/handler.test.ts` 1674,
`booking-public/book.test.ts` 1218, `crm-pricing/handler.test.ts` 1145,
`capacity.test.ts` 1107, `visitChange.test.ts` 1035, `marketRate.test.ts` 1035,
`planCancellation.test.ts` 785, `subscription.test.ts` 781,
`leadLifecycle.test.ts` 708, `crm-billing/money.test.ts` 699,
`stripe-webhook/handler.test.ts` 647, `deactivation.test.ts` 639,
`callbacks.test.ts` 551, `booking-public/cancel.test.ts` 524,
`bookingFunnel.test.ts` 516, `daily-reminders/handler.test.ts` 503.

---

## 3. Dead code

Method: every identifier in 431 files tokenized and cross-referenced against 861
extracted export declarations. NUL bytes stripped so `inventory.ts` indexed fully.
Spot-validated against manual `grep -w` on 10 symbols.

### 3.1 Unused exports — 225 total

**219 with zero references outside their own file; 6 referenced only by tests.**

Whole modules that are dead:

| Module | Note |
|---|---|
| [apps/web/src/lib/analytics.ts](apps/web/src/lib/analytics.ts) | `GA_EVENTS:19`, `GAEventName`, `trackEvent:49` — **verified zero references**. The tracker components (`ClickTracker`, `ScrollDepthTracker`, `AnalyticsTracker`) do not import it. The entire GA event API is unused. |
| [shared/planCancellationPolicy.ts](apps/web/amplify/functions/shared/planCancellationPolicy.ts) | all 6 exports dead (5 sentence builders + the policy const) |
| [shared/pricingControl.ts](apps/web/amplify/functions/shared/pricingControl.ts) | all 4 exports dead |
| [apps/crm/src/lib/amountWords.ts](apps/crm/src/lib/amountWords.ts) | sole export `numberToWords:60` dead outside its own test |

Test-only exports (dead as production code):

| Symbol | Location |
|---|---|
| `driveMatrixTo` | [driveTime.ts:137](apps/web/amplify/functions/shared/driveTime.ts:137) |
| `WORK_SUPPRESSED` | [ownedWork.ts:193](apps/web/amplify/functions/shared/ownedWork.ts:193) |
| `PRICING_MODEL` | [marketRate.ts:106](apps/web/amplify/functions/shared/marketRate.ts:106) |
| `collectLeadActivityPages` | [api.ts:99](apps/crm/src/lib/api.ts:99) |
| `solveClosedTsp` | [routeOptimizer.ts:165](apps/web/amplify/functions/shared/routeOptimizer.ts:165) |
| `_setS3ClientForTests` | [photoVerify.ts:58](apps/web/amplify/functions/shared/photoVerify.ts:58) — **zero refs even in tests**, unlike its `_setLockStoreForTests` sibling (20 test files) |

`_setLockStoreForTests` ([atomicLock.ts:351](apps/web/amplify/functions/shared/atomicLock.ts:351))
and `capacityFixtureModels` ([capacityTestFixture.ts:12](apps/web/amplify/functions/shared/capacityTestFixture.ts:12))
are deliberate test seams — not dead.

98 further value exports have zero non-test importers. Notable clusters in
`shared/`: `bookingLink.ts` (2), `bookingPayment.ts` (4), `businessHours.ts` (4 —
including `BUSINESS_TZ`, the only named timezone constant, while 23 bare
`America/New_York` literals exist), `callbacks.ts` (3), `capacity.ts` (3),
`marketRate.ts` (4), `serviceCatalog.ts` (4), `subscription.ts` (3),
`lifecycleReasons.ts` (2), `units.ts` (2). In `apps/crm/src/lib/`: `bookingLink.ts`
(3), `marketRates.ts` (3), `recovery.ts` (3), `revenue.ts` (3), `installPrompt.ts`
(2), `billingDisclosure.ts` (2).

A further **121 type/interface exports** have no non-test importers, concentrated
in [bookingApi.ts](apps/web/src/lib/bookingApi.ts) (11), `revenue.ts` (6),
`bookingFunnel.ts` (5), `groupChange.ts` (5), `pdf.ts` (4), `marketRate.ts` (4),
`inventory.ts` (4), `deactivation.ts` (4), `capacity.ts` (4), `atomicLock.ts` (4),
`workQueues.ts` (4). Most are still used *inside* their own file — the fix is
dropping `export`, not deleting the type. This list is not separated by that
distinction; treat it as a review queue, not a delete list.

### 3.2 Routes

**Web — 6 routes with no in-app reference:**

| Route | Component |
|---|---|
| `/lp/protect` | `pages/lp/LPProtect` |
| `/lp/quote` | `pages/lp/LPQuote` |
| `/lp/call` | `pages/lp/LPCall` |
| `/request-quote` | `<Navigate to="/quote">` — [App.tsx:207](apps/web/src/App.tsx:207) |
| `/residential/termite/treatment` | `TermiteTreatment` — the `/services/...` twin *is* linked |
| `/residential/wildlife/humane-removal` | `HumaneRemoval` — same |

The three `/lp/*` pages are paid-ad landing targets and are plausibly unlinked by
design; the other three are legacy/SEO aliases. **None are safe to delete without
checking ad configs and the sitemap.**

**CRM — no orphaned routes.** An earlier pass in this audit flagged `/work`,
`/schedule`, and the `/portal/*` routes as unlinked; that is **wrong** — all are
linked via `<Tab to=...>` at [App.tsx:255-280](apps/crm/src/App.tsx:255).
`/welcome` is a magic-link email landing target, and `/groups/:id` is a parameter
route reached by navigation. Correction recorded because the raw grep signal
("no literal `"/work"` string outside App.tsx") is misleading here.

**Page components never routed: none.** Every page under `apps/web/src/pages/**`
and `apps/crm/src/{pages,office,tech,portal}/**` is imported by its router.

**Stale remnant:** [App.tsx:229-231](apps/crm/src/App.tsx:229) is a 3-line JSX
comment describing a "Staging-only database reset" screen with no accompanying
`<Route>`. The component was removed in `9c9bff4`; only the comment survives.

### 3.3 Orphaned components — 3, all verified

| File | Verification |
|---|---|
| [apps/web/src/components/WhyUs.tsx](apps/web/src/components/WhyUs.tsx) | zero references outside itself |
| [apps/web/src/components/NumberedSteps.tsx](apps/web/src/components/NumberedSteps.tsx) | zero references outside itself |
| [apps/web/src/components/ServiceSection.tsx](apps/web/src/components/ServiceSection.tsx) | zero references outside itself |

All three are default-exported presentational components. Notably, they are
exactly the abstractions the marketing pages re-implement inline (§5) — they look
like an extraction that was started and abandoned rather than accidental orphans.

### 3.4 Commented-out code and markers

**No commented-out code blocks exist.** Two independent scans (runs of 5+ `//`
lines containing code-shaped content, and separately all `//`-runs ≥8 lines plus
`{/* <Component` and `/* …` block comments) found zero. The longest comment runs
are prose rationale, e.g. [crm-docs/handler.ts:2669-2688](apps/web/amplify/functions/crm-docs/handler.ts:2669)
and [resource.ts:491-510](apps/web/amplify/data/resource.ts:491).

**Marker comments: TODO 0, FIXME 0, HACK 0, `@deprecated` 0.** The 4 `XXX` hits
are false positives inside the base64 PNG literal at
[logoAsset.ts:13](apps/web/amplify/functions/shared/logoAsset.ts:13).

This is unusual and worth stating plainly: the codebase carries its debt in prose
rationale and in one machine-greppable flag (`pageErrors: "ignore"`), not in
marker comments.

### 3.5 Dangling references to deleted docs

Four source comments cite audit docs removed in `0b32017`:

| Location | Reference |
|---|---|
| [pagination.ts:6](apps/web/amplify/functions/shared/pagination.ts:6) | `docs/audit/PATTERNS.md, pattern 3` |
| [pagination.ts:22](apps/web/amplify/functions/shared/pagination.ts:22) | `INVENTORY.md item on swallowed errors` |
| [dynamicGroups.ts:9](apps/web/amplify/functions/shared/dynamicGroups.ts:9) | `docs/audit/PATTERNS.md` |
| [apps/crm/src/lib/api.ts:973](apps/crm/src/lib/api.ts:973) | `docs/audit/PATTERNS.md pattern 3` |

This file restores the `INVENTORY.md` referent. `PATTERNS.md` remains dangling.

### 3.6 Not verified

- `export { a, b } from "…"` re-export blocks (14 sites) were not enumerated; some pass-through names may also be dead.
- The 121 type exports conflate "should lose `export`" with "should be deleted".
- Non-TS consumers (HTML, CSS, JSON config, CDK string references) were not scanned for symbol usage.

---

## 4. Type drift

Baseline: only **two files** in either frontend derive types from the schema of
record — [apps/crm/src/lib/api.ts](apps/crm/src/lib/api.ts) (24 model types,
correctly) and [portalData.ts](apps/crm/src/portal/portalData.ts).
**`apps/web/src/**` derives zero types from `resource.ts`.** The drift is
concentrated in (a) the public funnel's hand-written wire types and (b) everything
returned through `.returns(a.json())` custom ops.

### 4.1 Same entity typed differently

**Service vocabulary — 4 declarations, one of them incomplete (live).**

| Declaration | Members |
|---|---|
| [resource.ts:632](apps/web/amplify/data/resource.ts:632) `BookingRequest.service` | 8 |
| [serviceCatalog.ts:39](apps/web/amplify/functions/shared/serviceCatalog.ts:39) `CatalogServiceId` | 10 |
| [bookingApi.ts:54](apps/web/src/lib/bookingApi.ts:54) `ServiceCode` | **6 — missing `MOSQUITO`, `MOSQUITO_TICK`** |
| [AddService.tsx:27](apps/crm/src/portal/AddService.tsx:27) `ServiceCode` | 8 |

[serviceCatalog.ts:250,266](apps/web/amplify/functions/shared/serviceCatalog.ts:250)
mark both mosquito services `funnel: true`, so the public dropdown offers services
its own type cannot express. Two casts hide it:
[bookingFunnel.ts:37](apps/web/src/lib/bookingFunnel.ts:37) `e.id as ServiceCode`
and [QuotePage.tsx:409](apps/web/src/pages/booking/QuotePage.tsx:409).

**Plan cadence — 5 spellings; one map is missing a member (live).**

| Declaration | Members |
|---|---|
| [resource.ts:79](apps/web/amplify/data/resource.ts:79) `ServiceFrequency` | 4, incl. `SEMIANNUAL` |
| [marketRateKeys.ts:24](apps/web/amplify/functions/shared/marketRateKeys.ts:24) `PlanCadence` | 3 |
| [bookingApi.ts:63](apps/web/src/lib/bookingApi.ts:63) `RecurringFrequency` | 3 |
| [api.ts:161](apps/crm/src/lib/api.ts:161), [LeadPanel.tsx:51](apps/crm/src/components/LeadPanel.tsx:51) | 4 |
| [AddService.tsx:83](apps/crm/src/portal/AddService.tsx:83) `RecurringOffer.frequency` | `string` |

**Verified live defect:** [billingDisclosure.ts:16](apps/crm/src/lib/billingDisclosure.ts:16)
`VISIT_NOTE: Record<string, string>` has `MONTHLY`, `BIMONTHLY`, `QUARTERLY` — **no
`SEMIANNUAL`**. It is read at [:38](apps/crm/src/lib/billingDisclosure.ts:38)
(`VISIT_NOTE[plan.serviceFrequency ?? ""]`) inside `firstChargeWords`, which
reaches `startBillingConfirmText`, which [CustomerDetail.tsx:44](apps/crm/src/office/CustomerDetail.tsx:44)
imports. [LeadPanel.tsx:235](apps/crm/src/components/LeadPanel.tsx:235) lets the
office sell a SEMIANNUAL plan, and the start-billing confirmation then silently
omits the visit-cadence sentence. Because the map is keyed by `string`, tsc cannot
catch it. The sibling map [planCadence.ts:22](apps/crm/src/lib/planCadence.ts:22)
*does* include `SEMIANNUAL` — two parallel maps of one enum, one incomplete.

(Note: `VISIT_NOTE` appears in the §3.1 unused-export list. That is accurate about
the `export` keyword only — it has no external importer but is live via the
internal read at `:38`. Do not delete it.)

**Property class — 3 vocabularies.** [resource.ts:626](apps/web/amplify/data/resource.ts:626)
`propertyKind` (`RESIDENTIAL|COMMUNITY|COMMERCIAL`) vs `Customer.propertyClass` /
`Job.propertyClass` typed as plain `a.string()` in the schema itself vs
[leadIntakeApi.ts:54](apps/web/src/lib/leadIntakeApi.ts:54) `"Residential" |
"Association" | "Specialty"` (title case, different member names) vs
[revenue.ts:55](apps/crm/src/lib/revenue.ts:55) `ClientType`, which adds a fourth
`UNCLASSIFIED` and re-normalizes via a cast at `:81`.

**The funnel wire types shadow `BookingRequest` wholesale.**
[bookingApi.ts](apps/web/src/lib/bookingApi.ts) declares 25 types with no link to
the schema. `PricedQuote.service` is `string` where the schema has an 8-member
enum; `BookedResponse` ([:249](apps/web/src/lib/bookingApi.ts:249)) is **missing
`processing`**, which [booking-public/handler.ts:3209](apps/web/amplify/functions/booking-public/handler.ts:3209)
actually returns. Server-side, the same model is shadowed again by
`QuotableBooking` ([quoteDoc.ts:26](apps/web/amplify/functions/shared/quoteDoc.ts:26)),
`ReadyBooking` ([pricing-refresh:315](apps/web/amplify/functions/pricing-refresh/handler.ts:315)),
and two row types in daily-reminders.

**Technician read surface — server strips fields the client types as present.**
[technicianReads.ts:55-60](apps/web/amplify/functions/shared/technicianReads.ts:55)
`pickJob()` deletes `priceCents` and `paidPaymentIntentId`;
[:44-50](apps/web/amplify/functions/shared/technicianReads.ts:44) `pickCustomer()`
keeps 11 of ~55 Customer fields. The client
([api.ts:220](apps/crm/src/lib/api.ts:220)) types them as full
`Schema["Job"]["type"]` / `Schema["Customer"]["type"]`. Every stripped field reads
as present-and-typed in `tech/JobDetail.tsx` and `tech/Today.tsx`.

**Cancellation outcomes — narrower unions and dropped fields.**

| Client | Server | Drift |
|---|---|---|
| [api.ts:481](apps/crm/src/lib/api.ts:481) `VisitCancelOutcome` | [visitChange.ts:423](apps/web/amplify/functions/shared/visitChange.ts:423) | client union **missing `"FAILED"`** — the conflicting-terminal state where money already moved falls through [VisitCancelSheet.tsx:104](apps/crm/src/components/VisitCancelSheet.tsx:104)'s `!== "COMPLETE"` as a plain warning |
| [api.ts:389](apps/crm/src/lib/api.ts:389) `PlanCancellationPreview` | [planCancellation.ts:56](apps/web/amplify/functions/shared/planCancellation.ts:56) | missing `pendingMessage` — never referenced anywhere in `apps/crm/src`, though the field exists specifically so the portal stops rendering "you won't be charged again" against live billing |
| [api.ts:422](apps/crm/src/lib/api.ts:422) `CustomerCancelOutcome` | [planCancellation.ts:242](apps/web/amplify/functions/shared/planCancellation.ts:242) | missing `stripeSubscriptionCanceled`, `settled` |
| [CustomerDetail.tsx:1639](apps/crm/src/office/CustomerDetail.tsx:1639) (inline, 5 fields) | [deactivation.ts:83](apps/web/amplify/functions/shared/deactivation.ts:83) (11 fields) | office is never told how many plans/visits the deactivation stopped |

Further shadows: `StaffRosterRow` ([api.ts:738](apps/crm/src/lib/api.ts:738)),
`TechnicianLicenseRecord` ([api.ts:769](apps/crm/src/lib/api.ts:769), field-for-field
copy), `ExceptionRow` ([Schedule.tsx:659](apps/crm/src/office/Schedule.tsx:659), via
`as unknown as` at `:677`), `Outcome` ([PricingLog.tsx:19](apps/crm/src/office/PricingLog.tsx:19),
exact copy of `PricingOutcome`), `RevenueInvoice`/`AgingInvoice` (which widen
`InvoiceStatus` to `string` inside the revenue math).

`PromoRow` ([promo.ts:25](apps/web/amplify/functions/booking-public/promo.ts:25)) is
a **deliberate, documented** shadow (tsc depth ceiling); its only drift is `active`
optional vs schema-required.

### 4.2 Enums as bare strings

**No typo'd enum literal exists.** Verified mechanically: all 129 enum members
extracted from `resource.ts` and diffed against every `kind:`/`status:` string
literal in the tree. The 30 non-matches are all non-enum fields (`PTO`,
`BASE_OVERRIDE`, `EN_ROUTE`, `ARRIVED`, …). The 24 `"COMPLETE"` literals are
command-stage vocabularies, not `JobStatus.COMPLETED` — no confusion between them.

**The hazard is non-exhaustive maps keyed by `string`, which tsc cannot check.**
[kit.tsx:192](apps/crm/src/ui/kit.tsx:192) `statusTone: Record<string, BadgeTone>`
— verified contents — is missing:

- `JobStatus`: **`NO_ACCESS`, `SCOPE_MISMATCH`, `PREP_MISSING`** — the three honest-failure states, rendered as neutral grey "muted". Reached at [CustomerDetail.tsx:926](apps/crm/src/office/CustomerDetail.tsx:926), [Schedule.tsx:410,539](apps/crm/src/office/Schedule.tsx:410), [JobDetail.tsx:442,547](apps/crm/src/tech/JobDetail.tsx:442), [Today.tsx:199](apps/crm/src/tech/Today.tsx:199)
- `BookingRequest.status`: `QUOTED`, `EXPIRED`, `CONTACT`, `PROCESSING`, `PAYMENT_FAILED`
- `PricingDecision`: **all six** — [PricingLog.tsx:82](apps/crm/src/office/PricingLog.tsx:82) passes `r.decision` to `StatusBadge`, so every pricing-decision badge renders grey
- `DisputeStatus`: `NEEDS_RESPONSE`, `UNDER_REVIEW`, `WON`, `LOST`

Keying `statusTone` off the schema enums instead of `string` turns ~15 silent grey
badges into compile errors. **Highest-leverage single type fix in the repo.**

Separately, 168 raw job-status literal comparisons exist with no shared `JobStatus`
constant.

### 4.3 `any`, casts, and non-null assertions

| Pattern | Count (non-test) |
|---|---|
| `as unknown as` | 78 (33 are `models as unknown as`, 12 `event.arguments as unknown as`) |
| `: any` | **3 real** (9 further hits are the word "any" in prose) |
| `as any` | 0 real (3 hits are prose) |
| `@ts-ignore` / `@ts-expect-error` | 1, test-only |
| `event.arguments.X!` | 80 (crm-docs 52, crm-billing 27) |
| `JSON.parse` | 46 |

The 3 real `: any` are all the data client
([bookingLink.ts:70](apps/web/amplify/functions/shared/bookingLink.ts:70),
[booking-public:970](apps/web/amplify/functions/booking-public/handler.ts:970),
[pricing-refresh:420](apps/web/amplify/functions/pricing-refresh/handler.ts:420)),
each documented as a tsc-instantiation-depth workaround. They are the acknowledged
root cause of the 33 `models as unknown as` sites.

**Ranked by consequence:**

1. **Money — the card is charged off an unvalidated parse chain.** [booking-public/handler.ts:2588](apps/web/amplify/functions/booking-public/handler.ts:2588) does `JSON.parse(String(booking.quoteJson ?? "{}")) as {…}` with no runtime validation, then charges via non-null assertions.
   **Correction (recorded while fixing this).** The `!` assertions were *not* the defect — they sit behind guards at `:2613-2627` that already throw, and the comment at `bookDatedAttempt` says exactly that; TS simply cannot narrow across the closure boundary. The real hole was that those guards test the recurring offer's **presence** while the parse was an unchecked cast, so a stored `recurringOffer: { frequency: "MONTHLY" }` satisfied `!stored.recurringOffer` and delivered `undefined` to `pricedWithPromo` — `NaN` as the amount charged. Fixed in `60f3c52` by making the parse all-or-nothing; the assertions went away as a consequence, not as the cure.
2. **Money — one field, two shapes in one file.** [:2462](apps/web/amplify/functions/booking-public/handler.ts:2462) (`/promo`) declares `recurringOffer?: {initialFeeCents}`; [:2588](apps/web/amplify/functions/booking-public/handler.ts:2588) (`/book`) declares `{frequency, monthlyCents, initialFeeCents}`. Preview and charge read the same bytes through different types.
3. **Money — field silently dropped on resume paths.** [bookingFinalize.ts:2218](apps/web/amplify/functions/shared/bookingFinalize.ts:2218) and [:2464](apps/web/amplify/functions/shared/bookingFinalize.ts:2464) omit `initialFeeCents` from `recurringOffer`; [:1238](apps/web/amplify/functions/shared/bookingFinalize.ts:1238) (main path) has all three.
4. **Auth — the IAM-trust branch is entered on a cast.** [booking-public/handler.ts:357](apps/web/amplify/functions/booking-public/handler.ts:357) `(event as unknown as {internalOp?}).internalOp`; nothing type-checks the payload the trusting side receives (see also §1.3 gap 6).
5. **Auth — 80 non-null assertions on optional GraphQL args** in authorization-gated mutations, e.g. [crm-docs:667](apps/web/amplify/functions/crm-docs/handler.ts:667). A missing arg becomes `undefined` inside the handler rather than a 400.
6. **Scheduling — capacity arithmetic on asserted optionals.** [visitChange.ts:1660,1721](apps/web/amplify/functions/shared/visitChange.ts:1660) `priorAssignedFacts!.minutes`; [crm-docs:2728,2799](apps/web/amplify/functions/crm-docs/handler.ts:2728) `priorHeldFacts!.minutes`. A wrong release under- or over-counts a technician-day slot.
7. **Scheduling — schema bypassed for PTO/closure writes.** [Schedule.tsx:677](apps/crm/src/office/Schedule.tsx:677) re-declares `TechnicianDayException` and `CompanyClosure` behind `api().models as unknown as {…}`.

**`opResult<T>` is the CRM's single unchecked gate.**
[api.ts:994](apps/crm/src/lib/api.ts:994) does `JSON.parse(data) as T` with zero
validation, across **53 call sites**, each naming its own inline `T`. Money sites:
[CustomerDetail.tsx:2064](apps/crm/src/office/CustomerDetail.tsx:2064) (refund),
[:1388](apps/crm/src/office/CustomerDetail.tsx:1388) (settle),
[CollectPaymentSheet.tsx:47](apps/crm/src/components/CollectPaymentSheet.tsx:47)
(client secret). [bookingApi.ts:339](apps/web/src/lib/bookingApi.ts:339) is the web
equivalent — every funnel response is an unvalidated cast.

### 4.4 `a.json()` / AWSJSON fields

19 model fields are `a.json()`; ~85 custom ops `.returns(a.json())`. **There is no
shared parse/serialize helper — there are ten local ones**, three of them
duplicated across files (`parseQuoteSnapshot` in two places and divergent,
`parseProducts` in two, `readDocuments`/`parseDocuments` in two).
`toAwsJson` ([crm-docs:177](apps/web/amplify/functions/crm-docs/handler.ts:177)) is
the only serializer and is private to one Lambda.

**Worst offender: `BookingRequest.quoteJson`
([resource.ts:675](apps/web/amplify/data/resource.ts:675)) — 9 independent reader
shapes** against one writer
([booking-public:1991](apps/web/amplify/functions/booking-public/handler.ts:1991)).
Two of the nine omit `initialFeeCents` (§4.3 item 3); one narrows `baseCents` to
non-null where the writer can emit null.

The parsed-vs-string hazard is documented at
[crm-docs:170-180](apps/web/amplify/functions/crm-docs/handler.ts:170): an
`a.json()` *argument* arrives already parsed, but an `a.json()` *model field* write
needs a string, and AppSync rejects the raw object. `toAwsJson` is the fix but is
applied at only two call sites; [crm-docs:277](apps/web/amplify/functions/crm-docs/handler.ts:277)
and [:547](apps/web/amplify/functions/crm-docs/handler.ts:547) pass through raw, and
[crm-billing:383](apps/web/amplify/functions/crm-billing/handler.ts:383) `asObject()`
is a third, inverse convention. ~25 further sites stringify by hand.

### 4.5 Cross-boundary drift

Both sides declare the shape independently at **22 boundaries**. Lambda↔Lambda:

| Sender | Receiver | Drift |
|---|---|---|
| [crm-billing:365](apps/web/amplify/functions/crm-billing/handler.ts:365) `op: Record<string, unknown>` | [booking-public:303](apps/web/amplify/functions/booking-public/handler.ts:303) `InternalOp` | sender fully untyped; receiver's union never applied to the send |
| [autoQuote.ts:109](apps/web/amplify/functions/thumbtack-webhook/autoQuote.ts:109) `input: Record<string, unknown>` | [booking-public:304](apps/web/amplify/functions/booking-public/handler.ts:304) `input: QuoteInput` | untyped on the wire, typed on arrival |
| [booking-public:1121](apps/web/amplify/functions/booking-public/handler.ts:1121) `{internalOp:{**op**}}` | [crm-pricing:98](apps/web/amplify/functions/crm-pricing/handler.ts:98) | **discriminator name differs** (`op` vs `kind`) — two incompatible "internalOp" protocols, while [crm-pricing:96](apps/web/amplify/functions/crm-pricing/handler.ts:96) comments that it is "the same shape booking-public's own internalOp uses" |
| [pricing-refresh:384](apps/web/amplify/functions/pricing-refresh/handler.ts:384) | booking-public `/quote-status` | hand-built fake `APIGatewayProxyEventV2` |
| [daily-reminders:2377](apps/web/amplify/functions/daily-reminders/handler.ts:2377) | [crm-admin:251](apps/web/amplify/functions/crm-admin/handler.ts:251) | forged AppSync event, re-cast on receipt |

Frontend↔Lambda drift is itemised in §4.1. Two further cases:
[leadIntakeApi.ts:49](apps/web/src/lib/leadIntakeApi.ts:49) `LeadRequest` cannot
express 11 fields the server accepts; and `Attribution` is declared **4 independent
times** ([leadIntake.ts:13](apps/web/src/lib/leadIntake.ts:13),
[lead-intake:18](apps/web/amplify/functions/lead-intake/handler.ts:18),
[bookingFinalize.ts:839](apps/web/amplify/functions/shared/bookingFinalize.ts:839),
[booking-public:219](apps/web/amplify/functions/booking-public/handler.ts:219)) —
the key sets currently agree, but nothing keeps them agreeing.

---

## 5. Missing patterns

Where the same knowledge is re-typed because no shared name exists. `⚠` marks
places where the sites **currently disagree** — those are defects, not just debt.

### 5.1 ⚠ `serviceTerritory.ts` — the MA/RI rule, 3 encodings, 2 of which disagree

**Verified live divergence:**

| Location | Rule |
|---|---|
| [dispatchReadiness.ts:65](apps/web/amplify/functions/shared/dispatchReadiness.ts:65) | `/^(ma\|massachusetts\|ri\|rhode\s*island)$/i` — **accepts full state names** |
| [crm-docs:1839](apps/web/amplify/functions/crm-docs/handler.ts:1839) | `new Set(["MA","RI"]).has(state.toUpperCase())` — **rejects "Massachusetts"** |
| [crm-pricing:780](apps/web/amplify/functions/crm-pricing/handler.ts:780) | `["MA","RI"].includes(state.toUpperCase())` — **rejects "Massachusetts"** |

A customer whose `serviceState` is `"Massachusetts"` passes dispatch readiness but
is refused by "build online quote" with *"Online quoting is available only for MA
and RI addresses."* `MA_RI_STATE_RE` is module-private and never exported. The ZIP
rule `/^0[12]\d{3}(-\d{4})?$/` lives only at
[dispatchReadiness.ts:66](apps/web/amplify/functions/shared/dispatchReadiness.ts:66);
the CRM form defaults `serviceState: "MA"`
([CustomerForm.tsx:33](apps/crm/src/components/CustomerForm.tsx:33)), which is why
this has not surfaced more often.

**Wants:** `isServiceableState()`, `isServiceableZip()`, `SERVICE_STATES`.

### 5.2 ⚠ `shared/noAccessReasons.ts` — labels already differ

**Verified: 3 of 6 labels diverge between the technician's app and the office
record.**

| Code | [JobDetail.tsx:763](apps/crm/src/tech/JobDetail.tsx:763) | [crm-docs:5342](apps/web/amplify/functions/crm-docs/handler.ts:5342) |
|---|---|---|
| `LOCKED_OUT` | "Couldn't get in" | "Couldn't get in — locked gate or door" |
| `DOG_LOOSE` | "Dog loose" | "Dog loose in the treatment area" |
| `UNSAFE_CONDITIONS` | "Unsafe on site" | "Unsafe conditions on site" |

The technician taps one label; the office email and audit row
([crm-docs:5366,5421](apps/web/amplify/functions/crm-docs/handler.ts:5366)) record a
different one. [leadReasons.ts](apps/web/amplify/functions/shared/leadReasons.ts)
exists *specifically* to prevent this — its header reads "a code the office can
pick that the server refuses… is exactly the drift this file exists to prevent."
The no-access vocabulary never got the same treatment.

### 5.3 ⚠ `parseRateKey` — 1 builder, 3 hand-rolled parsers

Builder [marketRate.ts:241](apps/web/amplify/functions/shared/marketRate.ts:241)
lives in the *impure* module, so the CRM cannot import it. Three parsers:
[marketRates.ts:75](apps/crm/src/lib/marketRates.ts:75) (guards `Number.isFinite`),
[pricing-refresh:601](apps/web/amplify/functions/pricing-refresh/handler.ts:601)
(**no finite check** — a malformed key yields `NaN`, and `NaN &&` silently drops the
band from the report label),
[crm-pricing:205](apps/web/amplify/functions/crm-pricing/handler.ts:205) (third
variant). [marketRateKeys.ts](apps/web/amplify/functions/shared/marketRateKeys.ts)
is the pure leaf both apps already import and holds `areaKeyFor`/`sqftBucket` —
**move `rateKeyFor` there and add `parseRateKey()`.**

### 5.4 ⚠ `shared/config.ts` — env access with inconsistent fallbacks

`process.env` is read directly in 15 Lambda modules.

| Var | Reads | Fallback variance |
|---|---|---|
| `MARKETING_URL` | 9 | same literal `"https://www.pestbuzzkill.com"` retyped 9× |
| `CRM_APP_URL` | 8 | **⚠ `?? "https://app.pestbuzzkill.com"` at [crm-docs:152](apps/web/amplify/functions/crm-docs/handler.ts:152), [receipts.ts:24](apps/web/amplify/functions/shared/receipts.ts:24) but `?? ""` at [portalProvision.ts:216](apps/web/amplify/functions/shared/portalProvision.ts:216), [auth-challenge/verify.ts:98](apps/web/amplify/functions/auth-challenge/verify.ts:98), [lead-intake:319](apps/web/amplify/functions/lead-intake/handler.ts:319), [pricing-refresh:712,817](apps/web/amplify/functions/pricing-refresh/handler.ts:712)** |
| `AWS_BRANCH`/`AMPLIFY_BRANCH`/`AMPLIFY_APP_ID`/`AWS_APP_ID` | 5/4/3/2 | ⚠ four names for two facts |

The `?? ""` sites emit `href="/customers/…"` and `href="/market-rates"` — **relative
links inside outbound email, which are dead on arrival.**

**Also ⚠ environment→URL mapping encoded twice with different host sets:**
[backend.ts:286-292](apps/web/amplify/backend.ts:286) is branch-based;
[bookingLink.ts:16-19](apps/crm/src/lib/bookingLink.ts:16) is hostname-based with
its own copy of the Amplify app IDs. A branch rename in `backend.ts` does not reach
the CRM, which silently downgrades an unrecognised host to staging checkout.

### 5.5 ⚠ `servicePages.ts` — 14 copies of one array, 4 slugs with two labels

An identical 4-entry `RELATED` array is copy-pasted into **14** files under
[apps/web/src/pages/services/](apps/web/src/pages/services/) (`AntsSpiders.tsx:116`,
`Cockroach.tsx:91`, `Termite.tsx:91`, `Wildlife.tsx:90`, … ). Several self-link
(`Cockroach.tsx` lists "Cockroach Control"). Same slug, different label:

| Slug | Related-list label (×13–14) | [Header.tsx](apps/web/src/components/Header.tsx) |
|---|---|---|
| `/services/wasp-hornet-bee` | "Wasp & Hornet Control" | "Wasp / Hornet / Bee" (`:24`) |
| `/services/mosquito-tick` | "Mosquito & Tick Control" | "Yard Mosquito Treatment" (`:41`) |
| `/services/rodent-control` | "Rodent Control" | "Mice & Rat Removal" (`:31`) |
| `/services/wildlife` | "Wildlife Removal" | "Squirrel, Raccoon & Bat" (`:57`) |

Routes are a fourth list ([App.tsx:162-175](apps/web/src/App.tsx:162)) and SEO
breadcrumbs a fifth. **Wants** `apps/web/src/data/servicePages.ts` →
`{slug, label, desc, component}` driving routes, header, footer, related-lists and
breadcrumbs. Note the three orphaned components in §3.3 (`ServiceSection`,
`NumberedSteps`, `WhyUs`) are exactly the abstraction these 14 pages inline.

### 5.6 ⚠ `CADENCE_LABEL` — 7 maps, 4 phrasings for `BIMONTHLY`

"Every 2 months" ([bookingFunnel.ts:133](apps/web/src/lib/bookingFunnel.ts:133),
[pdf.ts:740](apps/web/amplify/functions/shared/pdf.ts:740)) vs "every 2 months"
([rateCards.ts:187](apps/web/amplify/functions/crm-pricing/rateCards.ts:187)) vs
**"bi-monthly"** ([marketRates.ts:51](apps/crm/src/lib/marketRates.ts:51)) vs
"technician visits every 2 months" ([planCadence.ts:22](apps/crm/src/lib/planCadence.ts:22)),
plus three `<option>` literals. The quote PDF and the funnel screen agree only by
coincidence.

### 5.7 ⚠ `humanizeCode()` — 4 identical private copies + ~24 inline, with variants

Byte-identical 2-line body in [CustomerDetail.tsx:80](apps/crm/src/office/CustomerDetail.tsx:80),
[Staff.tsx:78](apps/crm/src/office/Staff.tsx:78),
[VisitCancelSheet.tsx:14](apps/crm/src/components/VisitCancelSheet.tsx:14),
[VisitChangeHistory.tsx:30](apps/crm/src/pages/VisitChangeHistory.tsx:30); plus ~24
inline `.replace(/_/g," ").toLowerCase()` sites across both apps. ⚠ The variants
disagree on casing — some Title-case the first letter, some stay all-lowercase, and
[crm-pricing:774](apps/web/amplify/functions/crm-pricing/handler.ts:774) preserves
case.

### 5.8 Business predicates re-encoded

- **`invoiceCoversJob`** — [workQueues.ts:31](apps/crm/src/lib/workQueues.ts:31) (named) vs inline at [daily-reminders:1061](apps/web/amplify/functions/daily-reminders/handler.ts:1061) and [crm-billing:583](apps/web/amplify/functions/crm-billing/handler.ts:583). All three carry a comment saying the other side "enforces the same rule server-side" — the textbook symptom. It lives in the CRM, so the Lambdas *cannot* import it; it belongs in `amplify/functions/shared/`.
- **"uncharged one-time job"** — the same 5-clause conjunction written three ways: as a predicate ([workQueues.ts:42](apps/crm/src/lib/workQueues.ts:42)), as a query filter plus `.filter()` ([daily-reminders:1033](apps/web/amplify/functions/daily-reminders/handler.ts:1033)), and as a sequence of `throw`s ([crm-billing:539](apps/web/amplify/functions/crm-billing/handler.ts:539)).

### 5.9 Constants that want a name

- ⚠ **`PAGE_LIMIT`** — `pagination.ts` centralizes the loop but not the size: `limit: 200` ×117, `500` ×29, `1000` ×14, `100` ×12, `50` ×11. `Product.list` uses `1000` in two places and `200` elsewhere for the same model.
- ⚠ **`QUOTE_TTL_MS`** — 24h built at [booking-public:1984](apps/web/amplify/functions/booking-public/handler.ts:1984) and re-typed as customer-facing prose at [QuotePage.tsx:239,516](apps/web/src/pages/booking/QuotePage.tsx:239) and [BookPage.tsx:615](apps/web/src/pages/booking/BookPage.tsx:615). Bumping the server's TTL silently makes three sentences lie.
- ⚠ **`CANCEL_FULL_REFUND_HOURS`** — the constant exists ([bookingTerms.ts:17](apps/web/amplify/functions/shared/bookingTerms.ts:17), `= 3` days) and is derived correctly once, but "72 hours" is hard-typed in ~18 further places including the CRM UI ([VisitCancelSheet.tsx:160,170](apps/crm/src/components/VisitCancelSheet.tsx:160)) and all of [planCancellationPolicy.ts](apps/web/amplify/functions/shared/planCancellationPolicy.ts), which imports nothing from `bookingTerms`.
- **7-day TTL** — named twice (`BOOKING_LINK_TOKEN_TTL_MS`, `PROCESSING_CLAIM_MS`), inline once ([portalProvision.ts:211](apps/web/amplify/functions/shared/portalProvision.ts:211)).

Already well-named — **do not "fix" these**: `DAY_MINUTES = 540`,
`STOPS_PER_TECH = 8`, `CHECKOUT_CLAIM_MS`, `POOL_TECH`
([capacity.ts:44-59](apps/web/amplify/functions/shared/capacity.ts:44)), the zone
bands and `zoneFromMinutes`, `sqftBucket`/`hoaBandFor`,
`HOA_ONE_TIME_MULTIPLIER = 3.5`, `SEASONAL_SERVICE_MONTHS`.

### 5.10 Key builders and identifiers

- ⚠ **`${technicianId}:${date}`** ([daily-reminders:1262](apps/web/amplify/functions/daily-reminders/handler.ts:1262)) vs **`${date}#${technicianId}`** ([capacity.ts:73](apps/web/amplify/functions/shared/capacity.ts:73)) — same pair, **opposite order, different separator**.
- **`parseSlotId`** does not exist: [capacity.ts:1409](apps/web/amplify/functions/shared/capacity.ts:1409) hand-parses with `id.split("#")`, and [:1446](apps/web/amplify/functions/shared/capacity.ts:1446) rebuilds the key inline instead of calling `slotId()`.
- ⚠ **Reason envelope `"CODE — note"`** — builders in `apps/web` ([visitChangeReasons.ts:73](apps/web/amplify/functions/shared/visitChangeReasons.ts:73), [lifecycleReasons.ts:70](apps/web/amplify/functions/shared/lifecycleReasons.ts:70)), parser in `apps/crm` ([customerPresentation.ts:14](apps/crm/src/lib/customerPresentation.ts:14)) splitting on a literal `" — "`. A note containing that sequence mis-splits.
- **`ids.ts`** — ~30 inline entity-ID prefixes (`booking-`, `cust-`, `plan-`, `job-`, `agr-`, `cb-`, `gc-`, `lead-`, …). Notably `booking-${booking.id}` is the *invoice* id, built in four separate places in `bookingFinalize.ts` — one typo desynchronizes reconcile from finalize.
- **`stripeIdempotencyKey()`** — 11 ad-hoc formats (see also §1.7).
- One documented rule is violated once: [dynamicGroups.ts:7-9](apps/web/amplify/functions/shared/dynamicGroups.ts:7) says "import them from here rather than restating the prefixes"; [agreementImport.ts:133](apps/web/amplify/functions/shared/agreementImport.ts:133) restates `` `grp-${groupId}` `` two lines below a correct call to `customerAccessGroups`.

### 5.11 Hard-coded external identifiers

- **Phone `508-258-9294`** — 26 files, 3 formats, no constant (see §1.6).
- **Emails** — `info@` ×27, `system@` ×13, `sales@` ×2, plus `contact@getgim.com` ×3 and one personal address. `system@pestbuzzkill.com` is the synthetic system-actor identity and is retyped rather than named ([ownedWork.ts:295](apps/web/amplify/functions/shared/ownedWork.ts:295), [bookingFinalize.ts:1064,1125](apps/web/amplify/functions/shared/bookingFinalize.ts:1064), [daily-reminders:2976](apps/web/amplify/functions/daily-reminders/handler.ts:2976)).
- **Postal address** (`420 Lakeside Ave, Marlborough`) — 3 copies inside [SEO.tsx](apps/web/src/components/SEO.tsx) alone, plus 4 more. ⚠ Distinct from `HQ_ADDRESS = "81 Greenwich Rd, Ware, MA 01082"` ([driveTime.ts:14](apps/web/amplify/functions/shared/driveTime.ts:14)) — two different "company addresses", neither defined in terms of the other. Per prior work, Ware is not an operating location.
- **License `CC-0060592`** — 2 copies.
- **AWS** — `us-east-1` hard-coded 23× in [backend.ts](apps/web/amplify/backend.ts); the SSM path shape re-typed 12× at `:577-610`. Wants `ssmParamArn(scope, name)` + a `REGION` constant.

---

## Appendix — method and confidence

Nine parallel read-only scans, each restricted to `apps/web/**` and `apps/crm/**`.
Counts come from stated greps; the highest-severity claims were re-verified
directly against source before inclusion.

**Verified in the main pass:** the `lead-intake` gate (§1.3), `money()` divergence
(§1.4), CRM `addDays` local/UTC mix (§1.5), `easternEpochMs` DST fallback (§1.5),
`isStaff` dead (§3.1), the three orphaned components and dead `analytics.ts`
(§3.1/3.3), `resumeGroupChange`/`reportSuspectAddresses` absent from the schema
(§1.3), the MA/RI split (§5.1), `NO_ACCESS_LABEL` (§5.2), `statusTone` contents
(§4.2), `VISIT_NOTE` reachability (§4.1), and the four dangling doc references
(§3.5).

**Corrected during the audit:**

- A scan reported `/work`, `/schedule`, and the `/portal/*` routes as unlinked in the CRM. **Refuted** — all are linked via `<Tab to=…>` at [App.tsx:255-280](apps/crm/src/App.tsx:255). Only `/welcome` (magic-link target) and `/groups/:id` (param route) lack literal in-app links, both by design.
- A scan called the minute bucket in [recovery.ts:180](apps/web/amplify/functions/shared/recovery.ts:180)'s Stripe key a bug. **Softened** — it is deliberate and documented; the residual risk is narrower than stated (§1.7).
- Two scans appeared to contradict each other on `VISIT_NOTE`. **Reconciled** — the `export` is unused, but the constant is live via an internal read (§4.1).

**Not verified:** `export { … } from` re-export blocks (14 sites) were not
enumerated for dead names; the 121 unused *type* exports conflate "drop the
`export`" with "delete"; non-TS consumers (HTML, CSS, CDK string references) were
not scanned for symbol usage; the CRM route list depends on literal path strings.
