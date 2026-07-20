# BuzzKill — remaining go-live requirements

**Business review date:** 20 July 2026

**Latest commit review:** every commit after `67df267` through implementation head `21925eb`;
completed gates are omitted from this delta-only register.

**Decision:** **NO-GO until every gate in this document is closed**

**Remaining:** **7 gates / 12 remaining requirements**, ordered by launch priority and
expected impact. The count is the number of top-level bullets under the "Remaining requirements"
headings below — sub-clauses inside one bullet are not counted separately.

**Average Opus 4.8 / Ultracode full-gate closure likelihood:** **18.0%** (mean of the register column)

**Review seats:** CEO, leadership, operations, customer, technician

**Business policy inputs approved:** 18–19 July 2026

This is a **delta-only** business requirements document. It excludes completed capabilities,
implementation detail, and proof-only tasks.

**Current review outcome:** GL-20's copy-pasted service metadata is corrected (`9057015`). GL-02's
unified, failure-safe lead intake and lifecycle implementation (`b6d4e99`, merged through `632cdd5`)
and GL-03's durable email recovery are reconciled out of the remaining engineering work.

The CEO/business-policy review has ratified the completed operating decisions. Those gates have been
removed; only the approvals, production operating data, and unresolved public-promise conflicts below
remain.

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
| P0 | GL-20 | Resolve unsupported public promises and approve legal terms | CEO | Contract, regulatory, and brand exposure from unbacked claims | **22% — Low** |
| P1 | GL-02 | Sales/Compliance operating-policy approval — engineering closed (`b6d4e99`) | Head of Sales | A team can operate the correct lead controls inconsistently | **12% — Very low (approvals only)** |
| P1 | GL-03 | Sales/Operations/Compliance approval — engineering closed (`8d322e4`, `f39de9e`) | Head of Sales + Head of Operations | Staff use inconsistent promises or recovery steps | **10% — Very low (approvals only)** |
| P1 | GL-10 | Workflow/promise sign-offs — engineering closed (`b8ba8a4`) | Head of Operations | A public promise becomes uncontrolled free work or a dispute | **12% — Very low (sign-offs)** |
| P1 | GL-19 | Metrics complete — engineering closed (`1a671be`, corrected `c962f86`) | Finance lead | Leadership cannot rely on money, plan, or sales mismatches each morning | **10% — Very low (sign-offs)** |
| P1 | GL-11 | Workflow sign-off — engineering closed (`a2a2fc2`) | Head of Operations | Reschedule, callback, and help requests fall back to phone calls | **10% — Very low (sign-off)** |
| P2 | GL-23 | Production master data and launch-day operating model | Head of Operations | Correct software runs on wrong facts, or a queue has no owner | **50% — Medium** |

---

## Priority 0 — Largest-impact money, security, compliance, safety, and customer commitments

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
  human review. These are limited to services and circumstances supported by the approved service catalog
  and capacity rules, with the review fallback disclosed before payment.
- A named owner inventories every claim about price certainty, speed, guarantee/free returns, cancellation,
  license/insurance/status, response time, resident scheduling, safety, and ratings — each with evidence,
  scope, source, owner, and review/expiry date, or removed. Guarantee, cancellation, no-access, refund,
  recurring-billing, seasonal-renewal, and price-adjustment language—and the fact that account credit is
  unavailable at launch—are identical across marketing, checkout terms, accepted agreement, portal, and
  employee workflows. Legal/insurance counsel
  approves the final public terms, privacy notice, and effective dates.

**Pass owner:** CEO; Compliance/legal sign the regulated and contractual statements.

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
| CEO |  |  | GL-10, 19, 20 |  |
| Sales |  |  | GL-02, 03, 19 |  |
| Operations |  |  | GL-03, 10, 11, 19, 23 |  |
| Finance |  |  | GL-10, 19 |  |
| Compliance/legal |  |  | GL-02, 03, 20 |  |
| Engineering |  |  | GL-20 |  |

**Production go-live decision:** `NO-GO / GO`

**Decision owner:**

**Decision date/time:**

**Known exceptions accepted:** None. Any accepted scope reduction must be removed from public and staff
access before the decision is changed to **GO**.
