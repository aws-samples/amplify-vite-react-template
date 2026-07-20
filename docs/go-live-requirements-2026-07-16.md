# BuzzKill — remaining go-live requirements

**Business review date:** 19 July 2026

**Latest commit review:** every commit after `67df267` through the current branch head; newest
implementation commits `f238d82` (GL-17 funnel) corrected by `04f4143` (off-season date-less sale,
required acreage) and hardened by `b9d9efb` (single-winner payment-attempt contract), `136f02a`
(GL-09 export) corrected by `4ede082` (Eastern business dates + formula neutralization), `3f97ced`
(GL-07 atomic reschedules) superseded by `8e420e2` then corrected by `fd17f44` (dedicated
TechDayStops model that truly creates; delta-correct move math), and `1a671be` (GL-19 metrics)
corrected by `c962f86` (genuine first contact, cohort-tied callback rates)

**Decision:** **NO-GO until every gate in this document is closed**

**Remaining:** **22 gates / 37 remaining requirements**, ordered by launch priority and
expected impact. The count is the number of top-level bullets under the "Remaining requirements"
headings below — sub-clauses inside one bullet are not counted separately.

**Average Opus 4.8 / Ultracode full-gate closure likelihood:** **25.4%** (mean of the register column)

**Review seats:** CEO, leadership, operations, customer, technician

**Business policy inputs approved:** 18–19 July 2026

This is a **delta-only** business requirements document. It excludes completed capabilities,
implementation detail, and proof-only tasks.

**Current review outcome:** GL-09 now durably records its policy version on every lifecycle event
(`95e39d3`, staging verified in `3483b5c`); GL-20's copy-pasted service metadata is corrected
(`9057015`); and the hour-exact GL-08 cancellation implementation is merged. GL-02's unified,
failure-safe lead intake and lifecycle implementation (`b6d4e99`, merged through `632cdd5`) and
GL-03's durable email recovery are also reconciled out of the remaining engineering work.

The CEO/business-policy review has now ratified the GL-13 operating vocabularies, GL-15 report rules,
GL-12 dispatch wording and authority, GL-07 cancellation/reschedule copy, GL-18 override map, GL-05
payment copy, GL-09 lifecycle policy, GL-16 no-clamp posture, GL-19 pause threshold and decision holder,
GL-01 catalog, and the currently published GL-20 license/rating facts. Those completed decision items
have been removed; outside co-signs, production configuration, operating data, and unresolved public
promise conflicts remain.

The **"McDonald's standard"** applies: a week-one employee must be able to do the right thing without
remembering policy, doing mental math, reading system internals, or inventing free-text workarounds. The
system must **prevent** an unsafe or financially wrong action, **explain** the one next step in plain
language, and put every failure in an **owned queue**.

## Go-live rule

Go-live requires all of the following:

1. Every requirement below is marked **Passed** by its named business owner.
2. There are no open launch defects and no open operational exceptions.
3. Any offer, promise, role, or workflow that will not be supported at launch is removed from the site
   and app before approval. "Staff will remember not to use it" is not an acceptable control.

## Locked business rules for the remaining gates

- **Authorized product scope:** implementation is limited to the CRM, approved lead-form components, and
  their shared backend. Launch services are the services selectable by those forms, for Massachusetts and
  Rhode Island. Public marketing pages, copy, metadata, SEO, and promises are not changed without explicit
  CEO approval; a conflict there remains visible rather than being silently edited.
- **Payment and cancellation:** cards and US bank accounts are supported. A visit canceled strictly more
  than 72 hours before its scheduled start in `America/New_York` receives a full refund to the original
  payment method; at exactly 72 hours or less, it receives no refund. Account credit is not a launch
  disposition. A pending bank debit is sufficient to book, hold capacity, and perform service; it is not
  described as settled. If it later fails before service, the slot is released. If it fails after service,
  the invoice becomes an outstanding balance with one-business-day customer notice, retry path, and
  shared-Office ownership. A late success is applied exactly once to that same obligation. Subscription
  cancellation is effective immediately: future recurring billing stops immediately, while each affected
  scheduled visit independently receives a full refund only when it is more than 72 hours away and no
  refund at exactly 72 hours or less.
- **Technician capacity:** technicians normally work Monday–Friday, 8:00 a.m.–5:00 p.m. Eastern. Every
  residential stop consumes 30 on-site minutes; every commercial and community/common-area stop consumes
  60. Each technician has a private office-managed starting/ending location, including a reasoned daily
  override; Google Routes travel time, route order, company holidays, closures, and technician-specific
  PTO consume or remove capacity. All active, currently licensed BuzzKill technicians may perform every
  launch service and may work anywhere in MA/RI.
- **Seasonal service:** mosquito and mosquito-plus-tick subscriptions receive one treatment per month from
  April through October (seven annual treatments) and are billed in equal monthly installments year-round;
  there is no routine treatment November through March. Billing starts immediately even for an off-season
  enrollment; an in-season first treatment counts as that calendar month's treatment; and a missed month
  does not create a catch-up visit. This researched operating rule reflects
  Massachusetts activity from spring until hard frost and common local monthly April–October programs
  ([Massachusetts DPH](https://www.mass.gov/info-details/mosquito-repellents),
  [GreenHow](https://greenhow.com/services/pest-control/mosquito-and-tick-control/), and
  [Modern Pest Services](https://www.modernpest.com/residential-pest-control/mosquito-control/)). Product
  labels, weather, and drift rules control the exact application date; a delayed treatment is visibly
  rescheduled rather than silently skipped. The CRM must not imply that all tick activity ends in October.
- **Guarantee and no access:** the guarantee applies only to active residual-service subscriptions, never
  one-time work. Each original appointment permits at most one callback, requires a customer photo before
  scheduling, and promises a return within seven business days. The callback technician records whether
  the condition is treatable and unexpected; an untreatable condition or expected pest behavior ends the
  guarantee with evidence and customer notice. No access is a nonrefundable cancellation because it occurs
  inside the 72-hour window.
- **Licensing:** a technician can hold multiple license records. Every active technician must have at
  least one current license number; the CRM tracks each license's number, type/issuer, status, expiration,
  and evidence. Compliance controls whether a license is current. The repository does not encode or infer
  changing state-by-service law matrices. An employed technician whose license expires can review only
  their own historical completed work; they receive no future assignments. An inactive former employee
  receives no access.
- **Pricing:** AI pricing follows the existing designed research/pricing prompt without clamps or an
  approval gate. The accepted launch risk is controlled by prompt/version history, input/output validation,
  live-change visibility, one-business-day anomaly review, and safe rollback—not by changing the resulting
  price or requiring human preapproval.
- **Ownership, access, and approval:** ordinary work goes to one shared, claimable Office queue that
  remains usable as staffing changes; every work item has the same one-business-day response commitment
  and no operational critical/high/routine severity classes. Money authority stays role-controlled. A
  group manager receives the same portal capabilities as an individual for every customer/property in
  that group. The CEO supplies final legal and compliance approval. Required business, financial, legal,
  service, communication, and audit records are retained for seven years.

## Priority model

These priorities rank implementation impact only. They do not create different operating response
classes: once live, every owned item has the same one-business-day response commitment.

- **P0 — Largest launch impact:** Close first. Failure can create unauthorized access or charges, invalid regulated
  records, unsafe/unlicensed work, direct financial loss, or a customer commitment the business cannot
  honor.
- **P1 — Substantial launch impact:** Close after P0. Failure creates predictable revenue leakage, service breakdown, repeat
  work, or customer escalation.
- **P2 — Operating readiness:** Close after the product gates. These ensure real data, people,
  procedures, and first-week users can operate the release safely.

Within each tier, gates are ordered from highest expected business impact to lowest. Priority changes
implementation order, not launch status: **P0, P1, and P2 are all go-live blockers.**

## Opus 4.8 on Ultracode likelihood

These are judgment-based planning estimates, not benchmark results. Each percentage estimates the
likelihood that Opus 4.8 on Ultracode could close the **entire remaining gate** with repository access
and normal development credentials. The estimate includes implementation and integration work, but
counts business-policy decisions, legal or compliance approval, production-account access, vendor
action, and physical operating setup as dependencies the agent cannot complete alone.

- **Very high (85–95%):** Predominantly bounded code, interface, or data work.
- **High (70–84%):** Substantial code work with manageable integration or business dependencies.
- **Medium (45–69%):** Code is feasible, but major policy, provider, data, or operating inputs are
  required.
- **Low (20–44%):** Closure depends mostly on leadership, legal/compliance, production providers, or
  operating setup.
- **Very low (below 20%):** Predominantly non-software work.

## Gate register

| Priority | ID | Remaining gate | Accountable business owner | Impact if missed | Opus 4.8 / Ultracode likelihood |
|---|---|---|---|---|---|
| P0 | GL-21 | Production accounts and integration readiness | Engineering lead + Finance lead | A staging assumption, stale secret, or unstaffed mailbox fails with real money | **38% — Low** |
| P0 | GL-20 | Resolve unsupported public promises and approve legal terms | CEO | Contract, regulatory, and brand exposure from unbacked claims | **22% — Low** |
| P0 | GL-14 | Production two-owner setup — engineering closed (`3717092`) | CEO | Partial access or handoff changes leave live privilege, stranded work, or missing history | **15% — Very low (ops setup only)** |
| P0 | GL-15 | Production delivery wiring — report rules approved and engineering closed (`bbcf0c3`) | Compliance owner | Invalid or falsely "delivered" legal record reaches a customer | **15% — Very low (SES wiring)** |
| P0 | GL-22 | Policy approval and production alarm delivery — engineering closed (`041f939`, `bc20401`) | CEO + Engineering lead | A background failure stays silent, or records cannot be restored | **15% — Very low (production setup + approvals)** |
| P0 | GL-17 | Funnel sale path live — engineering REOPENED (checkout lifecycle fencing, all `/book` branches) | CEO + Compliance owner | A launch service cannot be sold through the approved path | **12% — Very low (sign-off)** |
| P0 | GL-12 | Legacy-visit backfill and final service constraints — engineering closed (`5c8c6ef`) | Head of Operations | An unsafe or unperformable visit is dispatched | **18% — Very low (ops backfill + co-signs)** |
| P0 | GL-05 | Alternate-delivery authority and reconciliation window — engineering closed (`cc76773`) | Finance lead + Head of Operations | A confirmation duplicates, or a paid booking silently disagrees with the money | **15% — Very low (business sign-offs)** |
| P0 | GL-09 | Export live — policy and engineering closed (`95e39d3`, export `136f02a`, corrected `4ede082`) | Head of Operations | Leadership cannot retrieve the complete lifecycle record | **10% — Very low (sign-off)** |
| P0 | GL-07 | Reschedule capacity fully atomic — engineering closed (`8e420e2`, corrected `fd17f44`) | Head of Operations | Two concurrent moves can consume the same last capacity | **10% — Very low (sign-offs)** |
| P0 | GL-18 | Finance/Operations recovery sign-off and launch staffing | Head of Operations + Finance lead | A case closes while money or customer work remains, or routine work waits for an OWNER | **15% — Very low (sign-offs; GL-23 tie)** |
| P0 | GL-04 | Travel-model calibration + operating data | Head of Operations | Two customers buy the last slot; a day is sold with no one to work it | **15% — Very low (ops data + calibration)** |
| P0 | GL-06 | Finance/Operations recovery-workflow sign-off — engineering closed (`1228822`) | Finance lead + Head of Operations | A processing customer is promised a nonexistent hold, or an async success oversells the day | **12% — Very low (sign-offs)** |
| P0 | GL-08 | Finance/Operations workflow sign-off — hour-exact engineering closed (`73174e8`) | CEO | Concurrent recovery or a false settlement leaves billing, a refund, visit, or promised notice unfinished | **12% — Very low (sign-offs)** |
| P0 | GL-16 | Finance ratification — engineering and CEO decision closed (`41020a6`) | Finance lead | A bad prompt/model output silently changes live prices without rapid detection or recovery | **12% — Very low (Finance sign-off)** |
| P0 | GL-01 | Operations/Finance/Compliance catalog co-signs — engineering and CEO decision closed (`abcb908`) | CEO | An advertised service cannot be quoted, staffed, or documented | **15% — Very low (co-signs)** |
| P1 | GL-02 | Sales/Compliance operating-policy approval — engineering closed (`b6d4e99`) | Head of Sales | A team can operate the correct lead controls inconsistently | **12% — Very low (approvals only)** |
| P1 | GL-03 | Sales/Operations/Compliance approval — engineering closed (`8d322e4`, `f39de9e`) | Head of Sales + Head of Operations | Staff use inconsistent promises or recovery steps | **10% — Very low (approvals only)** |
| P1 | GL-10 | Workflow/promise sign-offs — engineering closed (`b8ba8a4`) | Head of Operations | A public promise becomes uncontrolled free work or a dispute | **12% — Very low (sign-offs)** |
| P1 | GL-19 | Metrics complete — engineering closed (`1a671be`, corrected `c962f86`) | Finance lead | Leadership cannot rely on money, plan, or sales mismatches each morning | **10% — Very low (sign-offs)** |
| P1 | GL-11 | Workflow sign-off — engineering closed (`a2a2fc2`) | Head of Operations | Reschedule, callback, and help requests fall back to phone calls | **10% — Very low (sign-off)** |
| P2 | GL-23 | Production master data and launch-day operating model | Head of Operations | Correct software runs on wrong facts, or a queue has no owner | **50% — Medium** |

---

## Priority 0 — Largest-impact money, security, compliance, safety, and customer commitments

### GL-21 — Production accounts and integration readiness

**Business outcome:** Production does not depend on a staging assumption, missing mailbox, stale secret,
or unconfigured provider event.

**Remaining requirements:**

- The previously exposed Buildium credential is rotated and revoked **at the provider**, its access logs
  reviewed, and current credentials exist only in the approved secret store. Removing it from code does
  not pass.
- The **production** Stripe webhook endpoint is subscribed to all ten launch events, including
  `payment_intent.processing` and `payment_intent.payment_failed`; production and staging use separate
  approved keys, prices, webhook secrets, and customer data. Stripe automatic payment methods exactly
  match the CEO/Finance GL-06 decision—no unapproved async method can appear at checkout.
- A monitored `sales@pestbuzzkill.com` mailbox plus the operations/finance routes exist, feed the shared
  Office queue, and own incoming replies, failed messages, alternate contact, and vacation coverage under
  the common one-business-day response commitment.
- Production SES is enabled for the required launch volume; the approved sending domain/identity has
  DKIM, SPF, and DMARC in force; and the deployed configuration set, event destination, permissions, and
  suppression policy apply to every production sender. Staging cannot send as production or alter the
  production suppression list.
- Delivered customer communications use the approved production URLs, portal and quote/cancel links,
  sender identity, phone, service area, maps key, AI key, scheduler, and payment return URLs on supported
  phone and desktop devices. The repository's existing `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
  `GOOGLE_ROUTES_API_KEY`, `VITE_STRIPE_PUBLISHABLE_KEY`, and `VITE_GOOGLE_MAPS_API_KEY` names are reused;
  every new scheduling function receives only the least-privilege access it needs, and deployed branch
  configuration is read back without printing secret values.
- At least two named owners can access each key provider account with MFA and recovery codes; no
  launch dependency is controlled by one personal account.

**Pass owner:** Engineering lead and Finance lead jointly.

### GL-20 — Public promises and legal terms match operations

**Business outcome:** Marketing, quote, checkout, agreement, portal, and field execution describe the
same offer, and no unsupported claim creates customer, regulatory, or brand exposure.

**Remaining requirements:**

- **Public implementation is approval-blocked.** The following public-site findings remain go-live issues,
  but current authorization permits only CRM and approved lead-form changes. Engineering presents the exact
  proposed public files/copy and receives explicit CEO approval before changing them; the CRM may not
  conceal or contradict a mismatch.
- **"Residents can schedule in-unit service directly" is promised with no flow behind it** — the
  communities and in-unit pages say residents book directly, but no property-scoped resident scheduling
  path exists (ties to GL-11). The claim is backed by a real flow or removed.
- **Blanket "exact price / no callbacks / no waiting" appears on specialized pages** that likely need
  human review. These are limited to services and circumstances that pass GL-01 and GL-04, with the review
  fallback disclosed before payment.
- A named owner inventories every claim about price certainty, speed, guarantee/free returns, cancellation,
  license/insurance/status, response time, resident scheduling, safety, and ratings — each with evidence,
  scope, source, owner, and review/expiry date, or removed. Guarantee, cancellation, no-access, refund,
  recurring-billing, seasonal-renewal, and price-adjustment language—and the fact that account credit is
  unavailable at launch—are identical across marketing, checkout terms, accepted agreement, portal, and
  employee workflows. Legal/insurance counsel
  approves the final public terms, privacy notice, and effective dates.

**Pass owner:** CEO; Compliance/legal sign the regulated and contractual statements.

### GL-14 — Create the second production owner

**Business outcome:** A role change or departure cannot leave a person with unintended access, and
leadership can retrieve the complete record of who changed access, why, and what work was reassigned.

**Engineering:** closed (`3717092`). Only the items below remain; they are business decisions, sign-offs, production wiring, or operating data — not software this repository can finish alone.

**Remaining requirements:**

- Production has two named owners with MFA and separate recovery access. The last-owner guard and
  owner-change serialization are enforced in code; creating and verifying the second production owner
  login (with MFA and recovery codes) is an operating action for the CEO.

**Pass owner:** CEO, with Operations and Sales verifying reassigned work.

### GL-15 — Complete production report-delivery wiring

**Business outcome:** Every issued service report and correction is an accurate, durable, correctly
authored legal record with a truthful, non-duplicating customer-delivery state.

**Engineering:** closed (`bbcf0c3`), and the CEO/Compliance seat approved the encoded capture window,
distance thresholds, product-label rules, evidence, response rule, resolution policy, and issued formats.

**Remaining requirements:**

- Production SES configuration set + SNS topic must be wired (GL-21) for mailbox delivery events —
  without them, reports remain truthfully at ACCEPTED rather than falsely at delivered.

**Pass owner:** CEO as Compliance owner; Operations signs delivery and retrieval.

### GL-22 — Monitoring, recovery, retention, and incident ownership

**Business outcome:** A background failure is noticed before the customer reports it, and business records
can be restored after human or provider error.

**Engineering:** closed (`bc20401`) and verified on staging: per-function error/throttle alarms,
seven-year AWS Backup coverage, PITR, the SES DLQ, and the alarm-to-owned-work bridge are deployed.

**Remaining requirements:**

- CEO/Compliance approve the written playbooks and the seven-year deletion/retention policy; production
  alarm delivery routes every alarm and recovery to both an owned queue item and office email once
  GL-21's production SES setup is enabled.

**Pass owner:** CEO and Engineering lead jointly; Compliance approves retention.

### GL-17 — Add approved seasonal services to the lead funnel

**Business outcome:** Seasonal services bill and schedule exactly as customers were told, and every visit
is assigned to a technician with a current license record without hard-coding changing state law.

**Engineering:** closed (`dc39f74`, funnel sale path `f238d82`, corrected `04f4143`). Both mosquito
products sell through the approved funnel: deterministic card pricing (never the AI researcher),
plan-only monthly billing year-round, and the first treatment sold onto April–October dates only. A
fully off-season (November–March) ask is a REAL date-less sale, not a contact dead end: the customer
accepts and pays the first month immediately, the plan starts that day billing monthly year-round, the
first April treatment obligation and a durable owned scheduling action are created (idempotent under
payment/webhook retries), and every customer/office surface promises April as a month — the office
confirms the exact day; no invented date. A missing yard size is rejected with a field error, never
silently priced as half an acre. The date-less checkout sits behind the standard failure-safe payment
contract (`b9d9efb`): a durable single-winner attempt claim, deterministic provider idempotency keys
(one customer, one intent even under parallel double-clicks or replays), an explicit payable-reuse
allowlist shared with the standard path (canceled/succeeded/processing intents are answered
truthfully, never returned as chargeable), stale intents proven terminal before replacement, and the
intent reference + terms acceptance durably confirmed before any client secret is returned — a
persistence failure closes the intent or opens deduplicated owned Finance recovery. No other public
page, metadata, SEO, or marketing copy changed.

**Remaining requirements:**

- REOPENED: checkout persistence must be lifecycle-safe and the single-winner contract must cover
  EVERY `/book` branch (dated, plan-only, off-season) — one durable attempt boundary; persistence
  fenced on the exact attempt holder, an allowed payable lifecycle state, and the expected prior
  PaymentIntent (a concurrent webhook's PROCESSING/BOOKED, a CANCELED/EXPIRED booking, or a newer
  intent is never regressed to QUOTED); a lost fenced write re-reads booking + provider state and
  answers truthfully instead of returning a secret; a client secret is returned only after confirmed
  persistence shows this exact intent authoritative, the booking payable, and
  selection/amount/terms/capacity durable; old intents proven terminal before replacement on every
  branch; provider-success-plus-persistence-failure closes the intent and compensates capacity or
  opens confirmed deduplicated Finance recovery.
- CEO and Compliance sign the live funnel offer as sold (labels, card prices, seasonal copy) — the
  bounded engineering change is complete.

**Pass owner:** CEO as business and Compliance owner.

### GL-12 — Complete dispatch backfill and constraint co-signs

**Business outcome:** A technician is dispatched only with the service-specific facts and approved scope
needed to complete the visit safely, and can exit an unperformable visit without inventing a workaround.

**Engineering:** closed (`5c8c6ef`). The Head of Operations/CEO approved the scope-mismatch and
prep-missing copy, reason vocabularies, and any-office-manager rule with a required reason.

**Remaining requirements:**

- Existing SCHEDULED visits created before this commit carry no property classification; the day-before
  sweep flags each as DISPATCH_NOT_READY until the office sets it (a deliberate visible backfill, not a
  silent default). Compliance signs the dispatch rule as a whole.
- Operations, Finance, and Compliance co-sign the per-service product/scope constraint sets now shown
  in the dispatch packet from the GL-01 catalog and GL-15 label rules.

**Pass owner:** Head of Operations, with Compliance sign-off.

### GL-05 — Approve paid-booking recovery controls

**Business outcome:** Every succeeded booking payment is either one complete, correctly communicated
customer commitment or one visible, verified refund/recovery case — even when execution stops between
steps.

**Engineering:** closed (`cc76773`); the CEO approved the at-payment and recovery copy.

**Remaining requirements:**

- Finance/Operations define who may record an "approved alternate delivery" for a bounced
  confirmation and what counts (the mechanism is live).
- Finance confirms the reconciliation window (45 days) vs expected production volume; the truncation
  alarm covers the gap either way.

**Pass owner:** CEO and Engineering lead jointly; Finance owns reconciliation and recovery approval.

### GL-09 — Add lifecycle-history export

**Business outcome:** Customer status, billing, access, scheduled work, and customer communication never
disagree, and an employee always sees the real outcome of deactivation or reactivation.

**Engineering:** closed (`dc39f74`, `95e39d3`). Leadership approved policy version
`2026-07-19.1`, including its per-reason balance, retention, and notice dispositions; the deployed
schema now durably stamps that version on every lifecycle event (`3483b5c`).

**Engineering addendum:** the complete-history export is live on the Command view (`136f02a`,
corrected `4ede082`; `buildLifecycleCsv`): every matching event read to pagination exhaustion before
download, read failures abort with nothing produced, fields
customer/action/reason/actor/timestamp/result/policyVersion. The optional From/To range means Eastern
(America/New_York) business dates — DST-correct boundary conversion to UTC instants, the To day
inclusive through 23:59:59 Eastern — and every field is neutralized against spreadsheet formula
injection (leading = + - @ TAB CR opens with an apostrophe, content preserved).

**Remaining requirements:**

- Head of Operations signs the export's field set and access (OWNER/OFFICE/FINANCE read) as the
  retrieval record leadership will rely on.

**Pass owner:** Head of Operations; Finance and CEO approve protected fields, transition policy, and
recovery policy.

### GL-07 — Make assigned-reschedule capacity atomic

**Business outcome:** An employee cannot cancel or move a paid visit without completing the money,
capacity, route, audit, and customer-notification consequences in one guided action.

**Engineering:** closed (`5b2fb76`, `3f97ced`, `8e420e2`; corrected `fd17f44`). Review found the
first stop-ledger attempt could not create its rows against the real AppSync contract (it omitted the
required `date` field behind a type cast; the swallowed rejection made every first assigned stop read
"day full") and that moves claimed a full new stop and full minutes. Corrected: the assigned-stop
count lives on a DEDICATED backend-written TechDayStops model (required date + technicianId, id
`date#technicianId`, in the CAS table set, browsers read-only) so no CapacityDay slot/index reader
can ever see a stop row and creation failures are surfaced as an honest "try again" refusal — never a
phantom "day full". Transition math is delta-correct in both the reschedule and office-assign paths:
same technician-day moves/reorders are stop-delta 0 (a fully-booked eight-stop day can still be
reordered), same-window moves reserve only the positive minutes delta and release a shrink after
publication, cross-window same-day moves swap window minutes with no stop churn, and only
cross-technician/day moves claim +1 destination and release the source after the publish lands, with
failed publication compensating exactly the fresh delta. The nightly reconciliation creates missing
rows with the full required-field contract, repairs drifted counters, and resets stale ones; the test
fixture now enforces the real required-field schema. The Head of Operations/CEO approved the refusal
and pending-assignment wording.

**Remaining requirements:**

- Head of Operations signs the reschedule/cancel workflow as the queue norm; Finance approves the money
  dispositions the terminal workflow encodes.

**Pass owner:** Head of Operations; Finance approves money dispositions.

### GL-18 — Approve exception operations and production staffing

**Business outcome:** A case turns green only after the exact customer, money, access, or operating
obligation is true, while a routine employee can complete ordinary recovery work without CEO-level
authority or an invented workaround.

**Engineering:** closed (`f6a34a8`). The CEO approved the encoded override-authority map; manual
overrides remain OWNER-only and verified money closures remain Finance/Owner.

**Remaining requirements:**

- Finance ratifies its money-close authority boundary (which was CEO+Finance approval per the locked
  rule); Operations ratifies the release/reassign flow as the queue norm.
- Operations confirms the deployed PTO/holiday/closure staffing verifier as its queue norm; GL-23
  establishes the staffed Office queue, business-day calendar, and shift handoffs in production.

**Pass owner:** Head of Operations; Finance approves money outcomes and the CEO approves override
authority.

### GL-04 — Capacity that cannot be oversold

**Business outcome:** Any day/window shown to a customer can actually be staffed, and two customers
cannot buy the same last unit of capacity.

**Engineering:** closed (`dc39f74`). Only the items below remain; they are business decisions, sign-offs, production wiring, or operating data — not software this repository can finish alone.

**Remaining requirements:**

- Operations enters the real operating data: each technician's private base location, known
  closures/holidays (the federal-holiday list is not auto-seeded — enter them as closures), and PTO
  as it arises. Until a base is entered, a technician routes from HQ by design.
- Operations ratifies the quote-time insertion estimate (a new stop's marginal travel = the real
  Routes leg to its nearest same-window stop, both ways) against the first weeks of real routes; the
  nightly rebuild already re-measures every slot as base → stops in route order → base.

**Pass owner:** Head of Operations.

### GL-06 — Approve processing and failed-payment recovery

**Business outcome:** The customer and office always see the same payment, capacity, and booking state;
an async payment cannot create a double payment, a nonexistent hold, an oversold visit, or an obligation
that waits forever.

**Engineering:** closed (`1228822`). A pending bank debit creates the full scheduled commitment
immediately with every surface saying **Payment pending**; all payment/booking transitions are one
conditional state machine; pre/post-service failure, late success, cancel, and reconcile paths are
exactly-once; returning customers always retrieve the durable state; Operations has the payments-in-flight
view. The CEO approved the customer-facing payment copy; the outside Finance and Operations approvals
below remain.

**Remaining requirements:**

- Finance and Operations sign off the changed customer-facing workflow now live: the
  "visit scheduled — payment processing, don't pay again" confirmation, the pre-service
  "visit canceled, no money collected, rebook" and post-service "outstanding balance" failure notices,
  the pending-cancel refund wording (refund completes after the debit settles), and the Finance-owned
  balance-collection flow (case closes only on a verified money settle). The leadership
  aging/reconciliation view is completed in GL-19, production webhook setup in GL-21, and durable
  notification handling in GL-03.

**Pass owner:** CEO and Finance lead jointly; Head of Operations approves the recovery workflow.

### GL-08 — Exact, terminal customer plan cancellation

**Business outcome:** A customer's online cancellation is a durable instruction, and every customer
message matches the actual billing, plan, schedule, and delivery state.

**Engineering:** closed (`dc39f74`, hour-exact correction `73174e8`). The refund line is
enforced HOUR-EXACT in `America/New_York` on all three money-dispositive cancel paths, matching the
approved copy ("more than 72 hours away = full refund; within 72 hours = no refund"). The office path
(`driveHeldVisitCancel`) was already hour-exact; the follow-up corrected the two paths that still
decided on whole calendar days — plan cancellation (`cancelQueuedPlanVisits`, and the matching preview
`listQueuedVisits`) and the public self-cancel link (`booking-public` `cancel`) — to judge refundability
from the accepted-cancellation instant against the visit's DST-correct Eastern start. The public path
now persists that instant (`BookingRequest.cancelRequestedAt`) so a retry after an outage judges the
moment the customer was entitled to. Only the business sign-off below remains.

**Remaining requirements:**

- Finance and Operations sign off the changed customer-facing copy and workflow now live (CEO approved
  19 July 2026): the per-visit 72-hour outcomes in the preview, confirmation email, and success message
  (this replaces the previous "keep it or refund it, your choice" promise for paid visits), and the
  prescribed-full-refund Finance
  case flow (Finance issues the exact refund; no discretionary disposition).

**Pass owner:** CEO, with Finance and Operations sign-off.

### GL-16 — Obtain Finance pricing-control ratification

**Business outcome:** The approved pricing prompt can publish researched prices without clamps or
preapproval, while leadership can see what changed and safely recover from a bad model/prompt result.

**Engineering:** closed (`41020a6`, `3826eb1`, `f57817c`) and verified healthy on staging. The CEO
ratified the no-clamp/no-preapproval posture, daily review, controlled reason vocabularies, and OWNER-only
rollback authority. Finance's independent ratification remains.

**Remaining requirements:**

- Finance ratifies the recorded operating values now live: the daily change-review cadence (one
  claimable review item per day of changes), the controlled office-edit and rollback reason vocabularies,
  OWNER as the sole rollback authority, and the accepted no-clamp/no-preapproval posture the mechanism
  encodes.

**Pass owner:** CEO and Finance lead jointly.

### GL-01 — Obtain launch-catalog co-signs

**Business outcome:** A customer can never be promised a service the operating system cannot price,
staff, perform, document, and support profitably.

**Engineering:** closed (`abcb908`). One versioned catalog (`serviceCatalog.ts`) now drives the funnel
dropdown and sold labels, CRM Market Rates labels, plan naming, seasonal facts, pricing sources/cost
kinds, and the locked class-based durations; every job and plan records an immutable serviceCode +
catalog version (legacy strings adopted by the resolver); office job creation is a controlled catalog
selection with server enforcement, and "Something else" opens an owned SERVICE_CATALOG_DECISION instead
of an invented job; the CRM Service-catalog screen shows the catalog and the standing public-conflict
inventory (exact file, promise, conflict, proposed replacement). The CEO ratified the ten-entry launch
catalog and its conflict dispositions; the outside co-signs below remain.

**Remaining requirements:**

- Operations, Finance, and Compliance provide written co-signs for the CEO-ratified launch catalog's
  ten entries, property classes, cadences, seasonal facts, funnel/lead availability, and recorded
  public-site conflict dispositions (**GL-20**).

**Pass owner:** CEO, with written sign-off from Operations, Finance, and Compliance.

---

## Priority 1 — High revenue and operating reliability

### GL-02 — Approve lead operating policy

**Business outcome:** Every lead always has an accountable person, a visible next action, and an auditable
outcome until it becomes a customer or is deliberately closed.

**Engineering:** closed (`b6d4e99`, merged through `632cdd5`). Website, CRM, Customer, and API creation
now use one idempotent intake contract with no raw staff create route; owner/action/deadline/readback,
duplicate and missing-contact work, conditional claims, and shared-Office recovery are required before
success. The CRM exposes current action, owner, age, stage, due time, and lateness. A closure-aware
15-minute fenced sweep escalates at the real one-business-day deadline. Controlled stages/outcomes,
confirmed mutations, complete failure-honest history, permission/DNC enforcement, identity-safe paid
conversion, and conditional offboarding transfers are implemented. Only operating-policy approvals remain.

**Remaining requirements:**

- Head of Sales approves manager escalation, follow-up cadence after first response, controlled stages and
  outcomes, lost reasons, qualification rule, duplicate authority, phone-only operating path, and the
  manual call/text logging policy. Compliance approves the retained consent evidence/version,
  do-not-contact and essential-message classifications, and controlled suppression-release policy.

**Pass owner:** Head of Sales; Compliance approves consent and suppression policy.

### GL-03 — Approve fallback and email-recovery policy

**Business outcome:** Every promised follow-up becomes one durable, owned Sales action with a deadline the
team can meet, and every customer message reaches a truthful terminal outcome that a routine employee can
recover without engineering.

**Engineering:** closed (`8d322e4`, `f39de9e`). The ONE approved commitment — one business day, closure-
aware (weekends + tracked CompanyClosure days push the deadline; after-hours clocks start at the next
open) — is the only promise anywhere; the funnel's CONTACT fallback is not returned unless its owned
SALES action durably exists (loud 503 otherwise), and a daily sweep rebuilds any missing action with the
deadline anchored to when the promise was MADE. Consent is versioned call-only wording retained on the
record (shared/consentText.ts). The EMAIL OUTBOX: every send writes its attempt row BEFORE the provider
call (an unrecordable send is refused), outcomes settle on the same row, a failed settle leaves a visible
unknown-outcome row plus owned work that forbids blind resends; QUEUED means machine-retried from the
stored exact body (single-winner claim, three-day expiry to FAILED, attachment rows escalate to a human);
provider-accepted messages with no delivery proof become owned, timed work; the magic sign-in link rides
the same contract; and the office has a routine one-click EXACT resend on EMAIL_FAILURE cases.

**Remaining requirements:**

- Head of Sales signs the one-business-day copy set (funnel fallback, work-queue scripts); Head of
  Operations approves the delivery-recovery workflow (resend / alternate delivery / suppression-lift);
  Compliance approves the consent and withdrawal language now versioned in `shared/consentText.ts`.

**Pass owner:** Head of Sales; Head of Operations approves delivery recovery and Compliance approves
consent.

### GL-10 — Approve guarantee, callback, and no-access workflow

**Business outcome:** Every public service promise has a defined, measurable operational path, and a
failed access visit cannot be "resolved" without actually completing the approved customer and money
outcome.

**Engineering:** closed (`b8ba8a4`, corrective commit `8678623`). The callback lifecycle enforces every locked rule server-side
(active residual plan only, completed original visit, required retained photo, one callback per
appointment via a conditional create, instant reference, owned one-business-day response, and a
promised return ≤7 business days excluding weekends and tracked closures); scheduling creates the $0
callback visit carrying the original context and refuses dates beyond the promise unless the customer's
later choice is recorded; the callback technician records one controlled evidenced finding in the field
app (treatable continues; untreatable/expected ends the guarantee with evidence and exactly one final
notice, replay-proof); no-access now matches the locked rule.

**Remaining requirements:**

- Head of Operations signs the callback/no-access workflow; the CEO approves the customer-facing
  promise wording (reference email, scheduled/final notices, the no-access no-refund copy) and Finance
  the money posture ($0 callbacks; nonrefundable no-access). Richer callback analytics (repeat-attempt
  and margin trends) accrue on the Command view as real volume exists.

**Pass owner:** Head of Operations; CEO approves promises and Finance approves money policy.

### GL-19 — Approve reconciliation and command views

**Business outcome:** Leadership can tell each morning whether customers, work, and money agree, without
asking engineering to query production.

**Engineering:** closed (`1a671be`; reopened on review, corrected `c962f86`) — the core Command view,
the daily leadership reconciliations, and the final lifecycle-derived measures. The correction fixed
two review findings: first response is now the first GENUINE communication (call/text/email/booking
link that was actually attempted) strictly after lead creation — intake LIFECYCLE rows, notes,
assignment/disposition events never count and a pre-creation activity is never a zero-minute response —
and callback/repeat rates are cohort-tied through each callback's original appointment
(CallbackRequest.originalJobId): the denominator is original visits completed in the window, only
callbacks linked to those exact visits count, and the rate is bounded at 100%. Attempt-versus-reached,
the qualification funnel, labeled 30-day windows and denominators, and all-or-nothing reads stand —
never inferred from stage totals. The daily pass
now proves the FULL provider ledger against the CRM (every succeeded payment ↔ one paid invoice, every
refund recorded, net cash explained — mismatches are owned Finance MONEY_MISMATCH cases), provider
subscriptions against CRM plans (canceled-still-billing, active-but-provider-canceled, provider-only,
delinquent-still-scheduled → owned PLAN_MISMATCH cases), and lifecycle/visit state against money
(deactivated-with-live-work, canceled-visit-open-money → owned STATE_MISMATCH cases), persisting one
ReconRun summary per kind per day. The CRM **Command** screen reads those summaries plus the shared
payments-in-flight truth (age, expected settlement, notice state, safe next action), the sales command
measures (stage counts, overdue, touched/untouched, per-owner load, loss reasons, duplicate/contact
exception aging), the service-quality measures (completions, no-access, cancels, open callback promises,
per-technician trend), and the codified pause/rollback threshold defaults with their levers. Only the
items below remain.

**Remaining requirements:**

- Finance ratifies the CEO-approved pause/rollback threshold of one unexplained mismatch and the CEO as
  decision holder; Sales and Operations sign their command/service-quality views; Finance signs the
  money-reconciliation workflow.

**Pass owner:** CEO and Finance lead jointly; Sales and Operations sign their views.

### GL-11 — Approve customer/group portal workflow

**Business outcome:** A customer or property manager can complete the tasks the business directs them to
the portal for without calling the office.

**Engineering:** closed (`a2a2fc2`, corrective commit `4a80b8e`). The portal Requests tab carries customer-initiated reschedule,
guarantee-callback (every GL-10 locked rule server-enforced: active plan, completed visit, required
photo, one per appointment, reference + 7-business-day promise), and general help; every submission is a
durable portal-visible case PLUS a deduplicated shared-queue item on the common one-business-day clock —
success only when both exist, so a failed submission errors loudly instead of falling back to an
untracked call, and the office resolves "with an answer" the customer sees. Group managers act across
their whole group via the same dynamic access every portal page uses.

**Remaining requirements:**

- Head of Operations signs the portal request/callback/help workflows and the customer-facing wording;
  the in-unit-resident public claim is decided with the CEO under GL-20 (back it with a property-scoped
  flow or remove it).

**Pass owner:** Head of Operations.

---

## Priority 2 — Launch operating readiness

### GL-23 — Production master data and launch-day operating model

**Business outcome:** The production app contains the real facts needed to sell and serve, and every queue
has a staffed owner from the first lead through the last payment exception.

**Remaining requirements:**

- Production contains the approved MA/RI CRM/lead catalog, rates/cost floors, property-kind durations,
  products/labels, technician identities and multiple licenses, private base locations, PTO, holidays,
  communication templates, policy versions, and finance/provider mappings. Every production technician
  and staff user is a named real person with the correct role and linked profile; nonproduction identities
  and data are absent or unmistakably isolated. Committed CRM/lead data is real, not sample data.
- Sales, Operations, Finance, Compliance, and CEO work routes into one shared Office queue with role-based
  money/security controls. It has configurable on-duty staffing, a business-day calendar, one common
  one-business-day response deadline, claim/release, reassignment, shift handoff, vacation/offboarding
  coverage, and escalation when unclaimed or overdue. It has no critical/high/routine response classes,
  and no obligation depends on one permanently named employee.
- Operations documents the daily opening checklist, next-day dispatch review, mid-day exception review,
  end-of-day money/work reconciliation, and after-hours customer escalation. Launch support has a published
  command channel, issue intake, on-duty owner, decision log, and twice-daily review, and leadership knows
  the pause/rollback authority and customer communication path.

**Pass owner:** Head of Operations.

---

## Final approval record

The launch approver should use this table only after every named owner approves their requirements.

| Function | Named approver | Date | Gates accepted | Approval record |
|---|---|---|---|---|
| CEO |  |  | GL-01, 05, 06, 08, 14, 16–20, 22 |  |
| Sales |  |  | GL-02, 03, 14, 19 |  |
| Operations |  |  | GL-03, 04, 06, 07, 09–12, 14, 15, 18, 19, 23 |  |
| Finance |  |  | GL-05–09, 16–19, 21 |  |
| Compliance/legal |  |  | GL-01–03, 10, 15, 17, 20, 22 |  |
| Engineering |  |  | GL-05, 07, 09, 15, 17, 19, 21, 22 |  |

**Production go-live decision:** `NO-GO / GO`

**Decision owner:**

**Decision date/time:**

**Known exceptions accepted:** None. Any accepted scope reduction must be removed from public and staff
access before the decision is changed to **GO**.
