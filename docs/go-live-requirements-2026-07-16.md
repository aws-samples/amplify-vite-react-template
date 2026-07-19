# BuzzKill — remaining go-live requirements

**Business review date:** 19 July 2026

**Latest commit review:** 11 commits after `f70e621`, from `3717092` through `cc76773`; newest
implementation commit `cc76773`

**Decision:** **NO-GO until every gate in this document is closed**

**Remaining:** **23 gates / 123 business requirements**, ordered by launch priority and expected impact

**Average Opus 4.8 / Ultracode full-gate closure likelihood:** **66.9%**

**Review seats:** CEO, leadership, operations, customer, technician

**Business policy inputs approved:** 18–19 July 2026

This is a **delta-only** business requirements document. It excludes completed capabilities,
implementation detail, and proof-only tasks. The latest implementation commits affect GL-14, GL-13,
and the staff/dispatch-verifier portions of GL-18. Completed and removed from GL-14: durable
pre-change access commands (required idempotency key, single-winner claim, exclusive-lease resume,
persisted outcomes), fail-safe role reduction with confirmed security cases, serialized owner changes,
condition-checked and read-back-verified job/work/lead handoff, and the reasoned Schedule entrance.
Completed and removed from GL-13: per-job assignment checks in the day view with owned mismatch work,
employment/licence-bound reads, owner-bound purged local drafts with recorded stale-draft dispositions,
the seven-year personally-authored document scope, the immutable reassignment audit, and reason-gated,
reviewed, non-impersonating office field access. GL-14 now carries only the production two-owner
operating setup; GL-13 only its policy-vocabulary approvals. The other gates remain because the new
commits did not close them. An omitted item is not a request to rebuild it.

The approved business-policy pass in this revision removes decision-only work for launch scope, payment
methods, visit refunds, technician availability/base routing, seasonal treatment, callback eligibility,
license modeling, and shared Office ownership. Requirements now state those rules as implementation
acceptance criteria. Gate counts do not fall until the corresponding behavior is implemented and verified.

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

## Systemic issues behind several gates

- **X1 — Customer, lead, exception, and visit-change history can still disappear.**
  `CustomerLifecycleEvent`, `LeadActivity`, `WorkEvent`, and `VisitChangeEvent` writes can still occur
  after the business change or fail without a durably confirmed fallback. The lifecycle screen ignores
  read errors and shows only its first 100 rows; the lead screen likewise substitutes an empty list on
  failure and stops at 100. Visit-change history is now fully paged and business-readable, but a lost
  event or recovery case can still be ignored and an already-canceled replay defaults missing history to
  **Sent/Complete**. Sensitive customer, sales, ownership, money, and schedule changes can therefore still
  be applied without durable, complete history.
- **X2 — An exception can still turn green before the business obligation is fulfilled.** A canceled
  visit can count as money settled while a paid charge remains; adding an email can count as delivering
  the missed notice; any technician ID can count as safe staffing; plan-cancellation recovery can count a
  partial refund as settled and ignores final notice plus unresolved paid/in-progress visits; a
  lead-follow-up can close even when its activity/state write failed; materially different paid-booking
  problems are offered the same retry action even when no booking exists to retry; and lifecycle recovery
  can be closed for fixing only the portal or audit while status, billing, scheduled work, notice, or
  another transition effect is still wrong. Visit-change recovery has no verifier, its resume can no-op
  after cancel or refuse reschedule, and cancellation itself can report complete after an invoice-void
  failure.
- **X3 — Customer communication is still best-effort after provider acceptance.** An accepted email can
  lose its log and provider ID; transient failures have no actual retry; delivery-event processing can
  acknowledge and discard a failed update; and the business record that originated the message is not
  brought back out of “sent” when the later outcome is a bounce or complaint.
- **X4 — Payment status and capacity can still tell different stories.** A processing payment is called a
  held slot even though availability does not reserve or count it; a succeeded payment is called booked
  before the server confirms finalization; and concurrent webhook events can overwrite a later state
  because their transitions are not single-winner decisions.

## Gate register

| Priority | ID | Remaining gate | Accountable business owner | Impact if missed | Opus 4.8 / Ultracode likelihood |
|---|---|---|---|---|---|
| P0 | GL-14 | Production two-owner setup — engineering closed (`3717092`) | CEO | Partial access or handoff changes leave live privilege, stranded work, or missing history | **15% — Very low (ops setup only)** |
| P0 | GL-13 | Policy-vocabulary approvals — engineering closed (`27ca1fb`) | CEO | A technician sees a peer's job/customer, or a departed tech keeps field access | **12% — Very low (approvals only)** |
| P0 | GL-15 | Compliance sign-off of encoded rules — engineering closed (`bbcf0c3`) | Compliance owner | Invalid, duplicate, or falsely "delivered" legal record reaches a customer | **15% — Very low (sign-off + SES wiring)** |
| P0 | GL-17 | Mosquito sale-path decision — engineering closed (`580d71c`) | CEO + Compliance owner | Work billed out of season or performed without a current technician license | **20% — Low (product decision + ratification)** |
| P0 | GL-12 | Copy/vocabulary approvals — engineering closed (`5c8c6ef`) | Head of Operations | An unsafe or unperformable visit is dispatched | **18% — Very low (approvals + backfill)** |
| P0 | GL-05 | Copy sign-off + policy definitions — engineering closed (`cc76773`) | CEO + Engineering lead | A confirmation duplicates, or a paid booking silently disagrees with the money | **15% — Very low (sign-offs)** |
| P0 | GL-09 | Finish failure-safe customer lifecycle transitions | Head of Operations | An interrupted transition leaves billing, access, service, or status wrong while the screen reports success | **66% — Medium** |
| P0 | GL-08 | Finish exact, terminal customer plan cancellation | CEO | Concurrent recovery or a false settlement leaves billing, a refund, visit, or promised notice unfinished | **76% — High** |
| P0 | GL-07 | Finish terminal office cancel/reschedule | Head of Operations | A visit reports complete while a charge, refund, staffing, notice, or concurrent change remains wrong | **74% — High** |
| P0 | GL-18 | Finish truthful, usable exception resolution | Head of Operations + Finance lead | A case closes while money or customer work remains, or routine work waits for an OWNER | **72% — High** |
| P0 | GL-04 | Capacity that cannot be oversold | Head of Operations | Two customers buy the last slot; a day is sold with no one to work it | **82% — High** |
| P0 | GL-06 | Finish honest, race-safe processing and failed payments | CEO + Finance lead | A processing customer is promised a nonexistent hold, or an async success oversells the day | **80% — High** |
| P0 | GL-16 | Prompt-governed AI pricing with rollback | CEO + Finance lead | A bad prompt/model output silently changes live prices without rapid detection or recovery | **78% — High** |
| P0 | GL-01 | One truthful, complete service catalog | CEO | An advertised service cannot be quoted, staffed, or documented | **52% — Medium** |
| P0 | GL-20 | Public promises and legal terms match operations | CEO | Contract, regulatory, and brand exposure from unbacked claims | **22% — Low** |
| P0 | GL-21 | Production accounts and integration readiness | Engineering lead + Finance lead | A staging assumption, stale secret, or unstaffed mailbox fails with real money | **38% — Low** |
| P0 | GL-22 | Monitoring, recovery, retention, and incident ownership | CEO + Engineering lead | A background failure stays silent, or records cannot be restored | **58% — Medium** |
| P1 | GL-19 | Launch reconciliation and command view | CEO + Finance lead | Leadership cannot see money, plan, or sales mismatches each morning | **70% — High** |
| P1 | GL-10 | Guarantee, callback, and no-access lifecycle | Head of Operations | A public promise becomes uncontrolled free work or a dispute | **82% — High** |
| P1 | GL-03 | Finish durable fallback promises and email recovery | Head of Sales + Head of Operations | A promised follow-up disappears, or an undelivered message remains falsely complete | **68% — Medium** |
| P1 | GL-02 | Finish a failure-safe lead lifecycle | Head of Sales | A lead bypasses ownership, is mislabeled as contacted, or duplicates during conversion | **70% — High** |
| P1 | GL-11 | Minimum complete customer/group portal | Head of Operations | Reschedule, callback, and help requests fall back to phone calls | **84% — High** |
| P2 | GL-23 | Production master data and launch-day operating model | Head of Operations | Correct software runs on wrong facts, or a queue has no owner | **50% — Medium** |

---

## Priority 0 — Largest-impact money, security, compliance, safety, and customer commitments

### GL-14 — Finish durable staff-access changes and offboarding

**Business outcome:** A role change or departure cannot leave a person with unintended access, and
leadership can retrieve the complete record of who changed access, why, and what work was reassigned.

**Engineering closed (commit `3717092`):** every role change and offboarding now claims a durable
access-change command (required unique idempotency key, conditional single-winner create) **before**
any provider or work change; duplicates return the persisted progress/outcome; a stopped command is
resumed under an exclusive nonce-verified lease, and PARTIAL outcomes are resumable with the same key.
Role reductions apply each group op individually, still end sessions after a failed op, and land in a
truthful PARTIAL with a **confirmed** security case — the UI never claims a case that was not written,
and completion is read back from Cognito and the durable command. The job/work/lead handoff re-reads
each record immediately before writing (a newer assignment is never overwritten), writes history before
moving ownership, counts every failed item, and **Complete** additionally requires a read-back that
zero scheduled future jobs remain on the inactive technician. Removing the TECH role hands field work
over the same way. Both the Staff and Schedule entrances require the controlled reason (+ note for
OTHER) and show the persisted Complete/Partial outcome with one next step. Owner-set changes are
serialized through a mutex held across the last-owner check and the change.

**Remaining requirements:**

- Production has two named owners with MFA and separate recovery access. The last-owner guard and
  owner-change serialization are enforced in code; creating and verifying the second production owner
  login (with MFA and recovery codes) is an operating action for the CEO.

**Pass owner:** CEO, with Operations and Sales verifying reassigned work.

### GL-13 — Finish technician session, route, and historical-data boundaries

**Business outcome:** A technician sees only the minimum data for legitimate current or
business-approved historical work, and access disappears when assignment or employment ends.

**Engineering closed (commit `27ca1fb`):** the day view now checks every stop against the assignment
(the route is not the authority); a mismatch is withheld from the technician, its customer never loads,
and it becomes owned ROUTE_MISMATCH Operations work while showing flagged to the office. Every read
requires an active technician at the code layer — an offboarded person's unexpired session gets no day,
job, or document link, and the app receives an explicit access-ended state it uses to purge local
drafts; a licence-lapsed technician is limited to their own COMPLETED work (own reports only, no
other-visit history, no current/future route). Local drafts are bound to the signed-in identity and
purged on sign-out, on access-ended, and on a per-job refusal; a visit that leaves its technician with
an unsent DRAFT report gets a recorded disposition (owned STALE_DRAFT review) from both the schedule
surface and the offboarding sweep. Document links are proven per document — personally authored or on a
currently assigned job, inside the seven-year record period; agreements are never technician documents.
Every scheduling change writes one immutable JobAssignmentEvent (actor, controlled reason, former/new
technician and route, effective time, draft disposition, outcome; a failed write is owned, visible
work). Office use of a technician field action requires a recorded reason, is ledgered before the
action runs (fail closed), and opens a routine review case; office edits of a technician's draft are
refused, so the record stays the applicator's own words. Access/id token validity dropped to 15
minutes.

**Remaining requirements:**

- Operations approves the controlled reassignment-reason vocabulary (ROUTING, CUSTOMER_REQUEST,
  TECH_UNAVAILABLE, WORKLOAD_BALANCE, CORRECTION, OTHER+note) and the stale-draft dispositions
  (new-tech re-files / office completes / discard); Compliance approves the office field-action reason
  practice and its routine review cadence. The vocabularies are live in code today — approval either
  ratifies or renames them; no behavior is waiting on it.

**Pass owner:** CEO, with Compliance and Operations verification.

### GL-15 — Finish regulated-report durability and compliance sign-off

**Business outcome:** Every issued service report and correction is an accurate, durable, correctly
authored legal record with a truthful, non-duplicating customer-delivery state.

**Engineering closed (commit `bbcf0c3`):** finalization takes a conditional single-winner claim with
stale reclaim, verifies the persisted FINALIZED report and COMPLETED job before billing or emailing,
and collapses concurrent next-visit creation onto one deterministic row. Delivery is a truthful state
machine: a verified SENDING intent precedes every provider call, provider acceptance records
ACCEPTED (never "delivered"), a resume adopts the proven prior send from the email log instead of
duplicating, a lost marker becomes visible owned work, and a later bounce/complaint corrects the
report/amendment itself, reopens the delivery obligation as owned work, and cannot be un-bounced;
the office records approved alternate delivery or re-sends the exact document. Label validation fails
closed — no rate on file refuses finalization — and the catalog carries structured office-edited label
rules (rates, quantity range, pests, service types, re-entry minimum) enforced on every recorded
application. The presence-review obligation is a durable marker on the report, re-opened by the daily
reconcile when its case write fails, settled by resolving the case, never blocking the technician.
Office screens retrieve report photos, the no-access door photo, per-record delivery truth, and
amendments without engineering.

**Remaining requirements:**

- Compliance (CEO) approves the encoded rules and thresholds now enforced in code: the capture-window
  grace, the accuracy/distance review thresholds, each product's encoded label rules, evidence
  requirements, the one-business-day response rule, resolution policy, and issued formats for every
  launch service type. The mechanism is live; the sign-off ratifies the recorded values.
- Production SES configuration set + SNS topic must be wired (GL-21) for mailbox delivery events —
  without them, reports remain truthfully at ACCEPTED rather than falsely at delivered.

**Pass owner:** CEO as Compliance owner; Operations signs delivery and retrieval.

### GL-17 — Finish seasonal plans and technician license controls

**Business outcome:** Seasonal services bill and schedule exactly as customers were told, and every visit
is assigned to a technician with a current license record without hard-coding changing state law.

**Engineering closed (commit `580d71c`):** seasonal facts (seasonal + serviceMonths) are stamped on the
plan at enrollment from one shared season module — the only encoding of the April–October rule — and
every in-season month is a visible TreatmentObligation with truthful history (DUE / SCHEDULED /
SATISFIED / SKIPPED_WEATHER / SKIPPED_MISSED). The recurring engine satisfies the completed month and
targets the next in-season month (October → next April, never November); a passed unserved month is
marked SKIPPED_MISSED by the daily sweep and creates no catch-up; office job creation and assignment
refuse off-season dates and duplicate monthly visits; billing stays monthly year-round from enrollment;
plan copy, portal, completion email, monitoring, and the rate-card labels read the same facts.
Licences are one-to-many TechnicianLicense records (number, type/issuer, status, expiration, evidence,
status history) — office-added, OWNER(Compliance)-status-controlled, PENDING until marked CURRENT —
and shared/licenses.ts is the single authority read by funnel availability (per-day licensed counts,
zero licensed = zero sellable dates), assignment, reschedule, field actions, the day view, T-1
staffing, and the staffed-visit verifier. The daily sweep opens advance LICENSE_LAPSE work 30 days
before expiry and per-visit unstaffed cases on lapse; finalized reports print the licence valid on the
application date, so later changes never rewrite authorship. No state-by-service rules engine exists.

**Remaining requirements:**

- **Mosquito sale path (CEO/product decision):** the booking funnel does not yet offer the mosquito /
  mosquito+tick services, so no seasonal plan can currently be sold end-to-end. The enrollment
  machinery is live (any plan whose accepted offer is a mosquito plan is stamped seasonal
  automatically); the CEO decides whether the sale lands in the funnel or a lead-conversion flow
  (ties to GL-01's catalog).
- Compliance-seat ratification: at launch the OWNER group is the Compliance authority for licence
  status (the CEO holds the seat). Confirm, or direct a dedicated group.
- Licence evidence is recorded as a note/document reference; if scanned-document uploads are wanted,
  a storage path decision is needed.

**Pass owner:** CEO as business and Compliance owner.

### GL-12 — Finish service-specific dispatch readiness

**Business outcome:** A technician is dispatched only with the service-specific facts and approved scope
needed to complete the visit safely, and can exit an unperformable visit without inventing a workaround.

**Engineering closed (commit `5c8c6ef`):** the dispatch gate proves a routable MA/RI address (placeholder
tokens refused, the exact office fix named) and an explicit property classification carrying the locked
30/60-minute durations, and attaches the same Google Routes result capacity uses to the assignment
decision; a day-before sweep opens owned DISPATCH_NOT_READY work with a verified re-check close. The
field packet carries prior treatment findings from finalized reports, the visit's rebook/callback
lineage, and the on-site duration. **Scope does not match** and **required prep missing** are dedicated
one-tap terminal outcomes that never start or complete service, free capacity, preserve the money
facts, open owned Operations cases, and send the approved customer next step (one-business-day promise,
missing-contact fallback); rebooking creates a new linked visit and auto-resolves the case. Every
post-assignment packet change is versioned with an immutable change record, is brought to the assigned
technician's attention (Start blocks until the new version is acknowledged, by their own identity
only), and a material change after service starts requires a recorded manager reason with mid-visit
technician notification.

**Remaining requirements:**

- Head of Operations / CEO approve the launch wording of the scope-mismatch and prep-missing customer
  next-step emails (draft copy is live), the controlled reason vocabularies, and which office roles
  count as "manager" for post-start packet changes (today: any office user, with the reason recorded).
- Existing SCHEDULED visits created before this commit carry no property classification; the day-before
  sweep flags each as DISPATCH_NOT_READY until the office sets it (a deliberate visible backfill, not a
  silent default). Compliance signs the dispatch rule as a whole.
- Approved per-service product/scope constraint sets ride on the GL-15 label rules and the GL-01
  catalog; the packet shows what was sold plus the catalog constraints once GL-01 lands the single
  catalog.

**Pass owner:** Head of Operations, with Compliance sign-off.

### GL-05 — Complete paid-booking delivery and reconciliation controls

**Business outcome:** Every succeeded booking payment is either one complete, correctly communicated
customer commitment or one visible, verified refund/recovery case — even when execution stops between
steps.

**Engineering closed (commit `cc76773`):** the checkout shows **Payment received — finalizing** and
renders **You're booked** only from the server-confirmed /booking-status readback; the URL carries the
booking identifiers so reload and redirect return to the same durable outcome, and a finalization that
needs a human shows the owned recovery state with one safe next step (never "pay again"). The
confirmation send takes a conditional outbox claim before the provider call — the
accepted-but-marker-not-stored window now resumes by adopting the proven send from the email log
instead of duplicating — and a marker that cannot be stored is visible owned work. The booking carries
its confirmation's true delivery state: a mailbox delivery upgrades it, a bounce/complaint corrects it
and reopens the communication as owned work with a booking-shaped resend/alternate path, terminal-
guarded. Reconciliation validates relationships (customer/job/plan/agreement/invoice ownership, amount,
plan linkage, committed date) — a cross-linked child cannot count healthy — and a truncated provider
scan opens owned Finance work, auto-resolves nothing, and reports not-ok.

**Remaining requirements:**

- CEO sign-off on the new at-payment customer copy ("Payment received — finalizing", the recovery
  wording) before merge to main — it changes what is promised at the moment of payment.
- Finance/Operations define who may record an "approved alternate delivery" for a bounced
  confirmation and what counts (the mechanism is live).
- Finance confirms the reconciliation window (45 days) vs expected production volume; the truncation
  alarm covers the gap either way.

**Pass owner:** CEO and Engineering lead jointly; Finance owns reconciliation and recovery approval.

### GL-09 — Finish failure-safe customer lifecycle transitions

**Business outcome:** Customer status, billing, access, scheduled work, and customer communication never
disagree, and an employee always sees the real outcome of deactivation or reactivation.

**Why this is still a gate:** The transition claim is a temporary lock, not a durable command. It records
no step progress and is deleted after a handled partial result or thrown error; a process stop can leave
provider effects with no recovery case, while a failed claim deletion can block every later transition
indefinitely. Deactivation can stop some plans before a later plan fails, or lose a job/status write,
then leave the record **ACTIVE** without a durable description of the mixed state. Reactivation can
partially enable portal access before failing and file that as a generic portal case while the customer
remains **INACTIVE**.

The employee outcome is also not yet truthful. The reactivation screen announces success for an
in-progress, partial, or unaudited server result; deactivation likewise announces success when its audit
is missing. Paid or in-progress one-time visits are skipped without an owned decision, and the preview
can say there are no visits to stop while one remains. Lifecycle history stops at 100 rows and hides a
read failure. No transition sends and tracks the final customer notice, and every reason currently runs
the same cancellation behavior even though nonpayment, a duplicate record, a move, a sale, and a normal
service end can require different balance, record, access, and communication outcomes.

**Remaining requirements:**

- Persist one lifecycle command **before** any billing, schedule, access, status, audit, or message change.
  It retains request identity, actor, controlled reason, prior/requested state, every affected plan/job/
  balance/access record, step progress, provider references, retry count, and final outcome. A worker
  resumes it after timeout or process loss; stale claims are reclaimed or escalated; and a transition is
  not released as terminal until it is complete or a confirmed recovery owner holds every unfinished
  obligation. Duplicate and opposite requests return the same persisted progress or follow a defined,
  serialized reversal—never a fresh interpretation of a partially changed customer.
- Define one business state machine for clean and partial deactivation/reactivation. The displayed state
  must distinguish **Active**, **Inactive**, and **Transition needs recovery** when billing, access,
  schedule, or status disagree. A stopped plan plus ACTIVE status, or enabled login plus INACTIVE status,
  cannot be treated as an ordinary active/inactive customer; the next employee sees one safe resume or
  reverse action and what the customer can currently access, owe, buy, or receive.
- The transition inventory and resulting disposition cover every provider subscription, CRM plan,
  outstanding invoice, queued one-time/plan visit, paid visit, in-progress visit, route assignment, portal
  login/group, and related customer/group access. Each write is read back. A paid or in-progress visit has
  a specific honor/refund/cancel/finish decision with a staffed owner and deadline; a failed schedule read
  or write cannot be skipped, counted as complete, or hidden by the final status.
- The employee confirmation is calculated from the server's current inventory and explicitly states what
  will stop, what will remain, money already paid, money still owed, customer access, and the final notice.
  The completion screen uses the persisted result and can say **Complete**, **Already complete**, **Still
  in progress**, or **Needs recovery**; it never announces reactivation/deactivation when `partial`,
  `inProgress`, or `audited: false`, and it does not claim a recovery case exists until that case is
  durably confirmed.
- Every transition produces a tracked customer notice with the approved effective date, plan/service and
  visit disposition, balance/refund next step, portal implication, and contact path. Leadership
  approves the behavior and authority for each reason—especially nonpayment, duplicate, moved/property
  sold, service ended, deactivated in error, and payment resolved—including whether to collect, write off,
  merge, retain documents, restore access, or require a new booking. The same policy drives the employee
  preview, provider actions, customer wording, and final record.
- The immutable lifecycle record and its recovery are completion requirements, not best-effort aftermath.
  Each missing transition has its own durable recovery identity; failure to create either the event or its
  case cannot return clean success. Operations and leadership can page, search, and export the complete
  history, see read failures, and reconcile actor, reason, provider effects, schedule, access, status,
  customer notice, and any recovery disposition (**GL-18**, **GL-19**, and **X1**).

**Pass owner:** Head of Operations; Finance and CEO approve protected fields, transition policy, and
recovery policy.

### GL-08 — Finish exact, terminal customer plan cancellation

**Business outcome:** A customer's online cancellation is a durable instruction, and every customer
message matches the actual billing, plan, schedule, and delivery state.

**Why this is still a gate:** The retained command and daily resumer improve outage recovery, but neither
owns an exclusive resume lease. Two stale-claim reclaims, manual resumes, or a manual and scheduled resume
can all drive the same cancellation concurrently. The command records no completed phases and is deleted
after the provider/CRM cancel even when visits, a full refund, or the final notice remain unresolved. If a
process stops after the plan becomes CANCELED but before schedule or notice work finishes, every later
resume bypasses those steps; the sweep reports the command complete even while leaving it stuck and may
never open a case.

The new settlement check can also report green too early. It trusts CRM status without confirming the
subscription is inactive at the provider, treats any nonzero refund as settling a full late charge, and
does not require a paid/in-progress visit decision or the promised final notice. Late-charge detection
uses when an invoice was created rather than when payment actually posted, so an invoice created before
the request but charged afterward receives an ordinary receipt and no refund case. If the mutable plan's
request-time write failed, the webhook ignores the durable command's timestamp. A customer can be told a
refund is coming before the recovery case is confirmed, and failure to create that case is swallowed.
The preview also overstates an outstanding balance after partial refunds, while centralized policy copy
still conflicts with the approved rule that cancellation is immediate, future recurring billing stops,
and each affected visit independently receives the 72-hour money outcome.

**Remaining requirements:**

- One cancellation command owns the accepted request and every phase through **terminal** completion:
  provider stop, CRM state, each visit, every post-request charge/refund, final customer delivery, and
  immutable outcome. Every scheduled, manual, or customer-triggered resume must conditionally acquire one
  current lease/version; stale recovery is atomic; duplicate workers return persisted progress rather
  than both acting. The command cannot be raw-deleted or marked complete while any phase or confirmed
  recovery owner is missing.
- Resume from the last confirmed phase after every process stop. A plan already marked CANCELED must still
  repair unread/failed schedule work, paid and in-progress decisions, refund work, and final notice rather
  than short-circuiting. Failure to write the pending flag, command progress, or recovery case remains
  discoverable from the accepted request, and the recovery cadence and escalation meet the approved
  customer promise rather than depending on a once-daily log-only pass.
- **Settled** is proved against both Stripe and CRM: the provider subscription is inactive, CRM plan state
  agrees, and every future recurring charge is stopped. Each scheduled visit is evaluated from the first
  accepted cancellation time: strictly more than 72 hours away receives a full original-method refund,
  while exactly 72 hours or less receives no refund. Detection uses payment time and the durable request
  when the plan timestamp is absent; every affected invoice and pending bank debit remains visible until
  its exact refund, canceled-payment, failed-payment, or approved no-refund outcome is confirmed once.
  Partial refunds remain open, and no refund promise is sent unless the command or Finance case that
  guarantees it is durably confirmed.
- Every unpaid, prepaid, pending-bank, and in-progress visit reaches the server-calculated 72-hour
  disposition with an Operations owner, one-business-day response deadline, schedule readback, and
  customer contact. Cancellation takes effect immediately even when money recovery continues; no save
  offer, provider delay, or exception postpones it. The command remains open until the exact refunds or
  no-refund outcomes and cancellation notice reach terminal outcomes. **Resume cancellation** repairs
  each residual; an unpaid schedule failure cannot be mislabeled as a paid-money case (**GL-18**).
- Customer, employee, and leadership views use the persisted terminal result. Outstanding balance is net
  of refunds; pending and success distinguish provider stop, schedule work, refunds, and message
  delivery; provider acceptance is not called customer delivery; and the immutable history retains who
  requested the cancellation, when, every provider/money/service effect, notices, and final resolution
  (**GL-03** and **GL-19**).
- Accepted terms, preview, pending state, staff recovery, reconciliation, and every customer notice enforce
  and version the approved policy: cancellation is immediate; future recurring billing stops immediately;
  each visit receives the non-overridable 72-hour refund/no-refund result; no account credit exists; and
  every resulting Office item receives the common one-business-day response commitment.

**Pass owner:** CEO, with Finance and Operations sign-off.

### GL-07 — Finish terminal office cancel/reschedule

**Business outcome:** An employee cannot cancel or move a paid visit without completing the money,
capacity, route, audit, and customer-notification consequences in one guided action.

**Why this is still a gate:** The new command is acquired before work begins, but stale reclaim and resume
do not conditionally acquire an exclusive lease; multiple employees or the daily worker can drive the
same change. A successful refund checkpoint, invoice void, recovery-case write, audit write, and command
release can each fail without changing the final result. Only the first paid and first open invoice are
handled, an invoice-void exception can be logged and then reported **Complete**, and a processing payment
is promised a refund even though no settlement webhook completes that promise. The visit is then marked
CANCELED and the command deleted, so **Resume visit change** becomes a no-op.

Reschedule is less recoverable than cancellation: validation or update errors strand the command without
a case, automatic resume refuses all RESCHEDULE commands, and the original date/route/actor are not stored
for a safe retry. The current office screen sends no technician or route, so every dated move bypasses
capacity and qualification checks, publishes SCHEDULED, and depends on a best-effort unstaffed case that
may not exist. Where assignment is supplied, capacity is still a read-then-write count that concurrent
moves can oversubscribe. Both actions release their command after provider email acceptance—not delivery—
and ignore a missing audit. If history is missing, an already-canceled replay fabricates **Sent/Complete**
rather than showing recovery is required. Although the direct account-credit choice was removed, the
employee preview still says a refund **or credit** will be confirmed and the recovery menu still lets
Finance close a paid-cancellation case as **Account credit applied** despite having no credit ledger.

**Remaining requirements:**

- One durable command stores the original actor, controlled reason, action, decision, prior state, proposed
  date/route/technician, every affected invoice, and every required phase. Each initial action, retry,
  manual resume, and scheduled resume conditionally acquires one current lease/version; stale recovery is
  atomic; and cancel versus reschedule cannot interleave. The command remains until the exact terminal
  result or a durably confirmed cause-specific recovery owner exists, and raw staff deletion cannot erase
  an accepted change.
- Cancellation reconciles **all** invoices and provider payments for the visit. Every refund is exact and
  idempotent, every unpaid invoice is confirmed void, offline money requires a recorded real-world
  disposition, and no thrown/null write can fall through to **Complete**. A pending bank debit remains
  linked to the command: when cancellation is more than 72 hours away it is canceled if possible or fully
  refunded on success; at exactly 72 hours or less its no-refund outcome is retained without calling it
  settled early. Ledger readback and customer notice are required, and the command/case cannot disappear
  after merely canceling the job.
- Resume continues from the last confirmed phase even when the job already reads CANCELED. It can finish
  money, route, notice, and audit work without duplicating a refund or message. A missing/stale command or
  event produces **Needs recovery**, never a fabricated prior outcome, and success automatically resolves
  the recovery case only after the full business result is re-verified (**GL-18**).
- Reschedule failures are durably resumable with the employee's intended destination and original actor.
  A dated visit becomes customer-confirmed **Scheduled** only after one atomic capacity claim and the full
  dispatch rule pass: active/qualified technician, license/scope on the service date, availability,
  territory, duration/travel capacity, route ownership, and unique route position. Otherwise it remains
  visibly pending assignment with a confirmed Operations owner; failure to open that work cannot publish
  a clean schedule or send a confirmed-date notice (**GL-04**, **GL-12**, and **GL-17**).
- Audit, recovery ownership, and the customer communication are required phases. The original employee and
  approved policy remain attached through automatic recovery; every provider/CRM write is read back; and
  **Complete** requires a retry-safe notice at its approved delivered/alternate-contact outcome rather
  than provider acceptance. The existing Operations/Finance history shows the original employee, policy,
  every money/schedule/delivery result, and final resolution; a missing audit or case appears as an
  operational failure rather than being hidden (**GL-03** and **X1**).
- The server calculates one non-overridable visit policy from the scheduled start in
  `America/New_York`: strictly more than 72 hours receives a full original-method refund; exactly 72 hours
  or less receives none. Preview, accepted terms, employee action, provider money, invoice, audit,
  recovery, customer notice, and reconciliation show that same result. Account credit, arbitrary refund
  amounts, and a manager choice that contradicts the cutoff are removed. The approved reason lists,
  reschedule/unscheduled rules, closures, and customer wording are versioned with the action.

**Pass owner:** Head of Operations; Finance approves money dispositions.

### GL-18 — Finish truthful, usable exception resolution

**Business outcome:** A case turns green only after the exact customer, money, access, or operating
obligation is true, while a routine employee can complete ordinary recovery work without CEO-level
authority or an invented workaround.

**Why this is still a gate:** A paid-cancellation case currently counts a canceled visit as money
settled even when a paid invoice has not been refunded, voided, or given its approved retained-fee or
offline-money disposition. Its manual menu still offers **Account credit applied** even though the launch
decision removed credit and no real credit ledger exists. A missing-contact case closes when an email
address merely exists, not when the missed notice is delivered. An unstaffed visit closes for any
technician ID without proving that person is active,
qualified, available, and valid for the service. All paid-booking exceptions show the same retry action
even though some represent an orphan payment, duplicate record, provider outage, or amount mismatch
that cannot be fixed by retrying a booking. An unpaid visit stranded by a plan cancel is still filed as
**Paid cancellation**, whose instructions are about settling money, and the plan-level schedule-read
failure is not linked to a job its normal verifier can inspect. The new plan-cancellation verifier can
count a partial refund as full settlement, ignores final customer delivery and unresolved paid/in-progress
visits, and its resume action cannot repair residual work after the plan reads CANCELED. Visit-change
recovery also has no verifier: its resume action becomes a no-op after cancellation, refuses reschedule,
cannot reconstruct a missing audit, and never automatically resolves its case after a repaired outcome.
Lifecycle recovery can likewise close after only the portal or missing audit row is handled. Eleven of
the seventeen exception types have no verified normal completion path. The lead-follow-up type is one:
it can be manually closed as **contacted**, **booking sent**, **lost**, or **do-not-contact** without
verifying the corresponding lead fact, and the automatic path can resolve it after a swallowed activity
or state-write failure. Callbacks, delivery failures, duplicate leads, portal failures, pricing decisions,
location reviews, and staff-access recovery likewise depend on an OWNER manual override. For email
failures, the instruction says to correct, unsuppress, and resend, but the case provides no bounded action
to do those things or identify every message the customer missed. That turns routine work into an
executive bottleneck and treats a normal completion as an exception to policy. Claim and close actions
also have no single-winner control, so two employees can act on the same case.

**Remaining requirements:**

- A paid-cancellation case remains open until the full amount owed has one durable disposition: provider-
  confirmed refund, successfully voided unpaid invoice, or approved retained-fee/offline-money outcome.
  Canceling the visit alone never proves the money is settled; partial refunds and multiple invoices
  reconcile to the exact amount owed. The unsupported account-credit close reason and promise are removed
  from both policy definitions and every employee/customer surface.
- A missing-contact or delivery case lists every affected message and remains open until each specific
  notice is delivered or has an approved alternate-contact outcome. A permitted business role can correct
  the address, release suppression when consent and address validity support it, resend the exact message,
  and see the new terminal result without developer tools. Merely adding an address does not satisfy a
  promise to send a confirmation, report, amendment, cancellation notice, or other customer document.
- An unstaffed case closes only when the assignment passes the same launch-approved dispatch rule used
  everywhere else: active technician, valid license/scope, working availability, territory/capacity, and
  a scheduled route disposition. An ID in the technician field is not proof that the visit can occur.
- Each paid-booking exception shows only an action that fits its actual cause and records the resulting
  money and booking state. Orphan payments, duplicate payments/records, amount mismatches, and provider
  outages must not offer a misleading **Retry finalization** action.
- Plan-cancellation cases and actions match the actual remaining obligation. The plan-level verifier
  confirms provider and CRM stop, the exact full refund of every affected invoice, every paid/unpaid/
  in-progress visit decision, and final customer delivery. Its resume action repairs those residuals even
  after the plan is CANCELED; an unpaid stranded visit is not presented as a refund case; and a plan-level
  schedule-read failure cannot close before the schedule is actually read (**GL-08**).
- A visit-change case stays open until every affected invoice/provider payment, job/route/staffing fact,
  final customer delivery, and audit row is verified. **Resume visit change** repairs both cancellation
  and reschedule after the job has already changed, and successful re-verification automatically resolves
  the linked case. Each cause has a bounded action for an appropriate routine role; owner-only manual
  close is not the normal path (**GL-07**).
- A lifecycle-recovery case stays open until the intended transition is verified across provider billing,
  CRM plans and status, all paid/unpaid/in-progress visits and routes, portal login/groups, outstanding
  balance disposition, customer notice, and immutable audit. Portal-only or audit-only closure cannot
  turn a mixed customer green; each missing transition remains separately visible and recoverable
  (**GL-09**).
- A lead-follow-up case closes only after the matching durable lead fact exists: recorded attempt and its
  actual outcome, confirmed booking-link send, controlled lost decision, do-not-contact decision, or paid
  conversion. Closing today's task must also leave the next approved action and due time visible; a free-
  text/manual close cannot make an open lead disappear from follow-up.
- Every ordinary exception enters one shared Office queue with age, impact, evidence, one common
  one-business-day response deadline, and a bounded normal action that an authorized routine employee can
  claim, release, reassign, and complete. The queue has no critical/high/routine response classes. Callback,
  delivery, merge, portal-recovery, pricing, and staff-recovery outcomes do not depend on a permanently
  named person or OWNER access; a manual override remains reserved for a genuine exception.
- The CEO approves which role may override each exception class. Finance separately approves money-case
  authority. Every override has a controlled reason, meaningful evidence, and an accountable review path;
  the policy shown to employees is the same policy enforced when they act.
- Claiming, resolving, reopening, and releasing a case has one winner. Concurrent employees cannot both
  own or complete the same customer or money action; offboarding cannot overwrite a newer claim; and the
  ownership change plus immutable history are one recoverable outcome rather than a release that succeeds
  before its history fails. The staffed Office queue, business-day calendar, common response commitment,
  and shift handoffs are established in GL-23.

**Pass owner:** Head of Operations; Finance approves money outcomes and the CEO approves override
authority.

### GL-04 — Capacity that cannot be oversold

**Business outcome:** Any day/window shown to a customer can actually be staffed, and two customers
cannot buy the same last unit of capacity.

**Remaining requirements:**

- **No slot is ever reserved.** There is no capacity-hold concept in the system; two concurrent bookings
  for the last slot both pass the check because capacity is derived from existing jobs and nothing is
  written to claim the slot. A **PROCESSING** booking is also excluded from availability even though the
  customer is told “Your slot is held.” Selecting checkout must atomically claim capacity for one payment
  attempt. Card success consumes that claim into the final booking; an accepted pending bank debit consumes
  it into a scheduled **Payment pending** job immediately and remains counted even though money has not
  settled. Bank failure before service cancels/releases the job and slot; failure after service preserves
  the historical capacity and creates the collectible balance. Concurrent purchases yield exactly one
  claim without manual repair.
- **Capacity is a coarse technician-per-day count that offers slots even with zero technicians.** It
  multiplies active-technician count by a fixed stops-per-tech and floors that count at one. Replace it
  with a minute-based Monday–Friday 8:00–5:00 Eastern schedule: 30 minutes on site for residential and 60
  for commercial/community, plus Google Routes travel from the
  technician's office-only starting/ending location and between stops. Company holidays/closures,
  individual PTO, inactive status, and absence of a current license remove capacity; zero eligible
  technicians means zero sellable dates. An office user can maintain each base location and create a
  reasoned one-day override without exposing it to peers or customers.
- **The funnel, dispatch board, and office reschedule do not share one capacity rule** — their fixed
  stops-per-tech value is duplicated and the office move uses a count-then-write check that two concurrent
  moves can both pass. They must use one atomic rule/claim so a day cannot be available to the customer,
  over capacity to Operations, or oversubscribed by simultaneous office changes.
- Operations can maintain holidays, closures, technician PTO, base-location overrides, and other
  availability and see why a date is or is not sellable. A change immediately protects all unconsumed
  slots and flags affected commitments. All technicians may work anywhere in MA/RI and perform every
  launch service, but an inactive technician or one with no current license contributes no capacity.

**Pass owner:** Head of Operations.

### GL-06 — Finish honest, race-safe processing and failed payments

**Business outcome:** The customer and office always see the same payment, capacity, and booking state;
an async payment cannot create a double payment, a nonexistent hold, an oversold visit, or an obligation
that waits forever.

**Why this is still a gate:** A processing customer is told **Your slot is held**, but no capacity record
is created and availability does not count the PROCESSING booking. The customer is also told no charge was
made, which is not a truthful description of a pending bank debit that may proceed to service.
The repeat-booking endpoint rejects any persisted status other than QUOTED before it reaches its
“still processing—do not pay again” branch, so a returning processing customer can instead receive
**Quote not found** and be offered a fresh payment path.

Processing, failed, and successful webhook handlers read a status and then write without a conditional
transition. Concurrent events can therefore both read QUOTED and let a late processing/failure update
overwrite a BOOKED success; failed writes are not checked before the event is acknowledged. There is no
processing start/expiry, stale-processing sweep, provider reconciliation, owned timeout case, or office
screen for these states. The failed-payment email is marked only after provider acceptance with an
unchecked write, so replay can duplicate it and a failed delivery follows the unresolved X3 path.

**Remaining requirements:**

- A pending bank debit creates one real scheduled commitment immediately: customer, agreement/mandate,
  pending invoice, job, capacity claim, payment attempt, and truthful confirmation are linked and read
  back. It may be dispatched and completed while payment remains pending; every customer, Office, route,
  technician, and leadership view says **Payment pending**, not paid or settled (**GL-04** and **GL-05**).
- Payment and booking transitions use one approved, conditional state machine. Processing, success,
  failure, cancellation, expiry, and retry events apply only to the current payment attempt and allowed
  prior state; duplicate, concurrent, stale, or out-of-order events cannot regress BOOKED or overwrite a
  later business decision. Every rejected or failed transition remains visible and owned.
- PROCESSING has a durable start time, method, customer promise, next check, expected provider date, job/
  invoice references, and shared-Office ownership. Reconciliation re-reads Stripe until success/failure,
  finds missing webhook events, and raises work that receives a response within one business day when the
  provider result is late or contradictory.
- Bank failure before service cancels the pending commitment, releases capacity once, voids the pending
  invoice, and sends one retry path. Failure after service never erases or cancels completed work: the
  invoice becomes **Balance due**, the customer receives a one-business-day payment-retry notice, and the
  shared Office queue owns collection. A later provider success or retry applies exactly once to that
  balance; concurrent failure/success events cannot double-collect or turn it back into pending.
- Returning, refreshing, or retrying customers retrieve the durable state: processing means **do not pay
  again—the visit is scheduled with payment pending**, succeeded-but-incomplete means **payment
  received—finalizing**, settled means paid, pre-service failure means canceled plus retry, and post-service
  failure means balance due. No state falls through to **Quote not found** or invites another payment
  without proving how the prior attempt affects the job and balance (**GL-05**).
- Customer copy distinguishes card authorization/settlement from a bank debit that may take several
  business days: authorized, processing, settled, failed, reversed, or refunded. It never says no money
  moved while a debit is pending. The accepted mandate, payment-method label, expected date, service
  status, balance consequence, and durable notices remain linked to the attempt.
- Operations has a plain-language view of every processing/failed attempt showing customer, amount,
  method, selected slot/hold, age, provider state, notice state, owner, and one safe next action. The
  leadership aging/reconciliation view is completed in GL-19, production webhook setup in GL-21, and
  durable notification handling in GL-03.

**Pass owner:** CEO and Finance lead jointly; Head of Operations approves the recovery workflow.

### GL-16 — Prompt-governed AI pricing with rollback

**Business outcome:** The approved pricing prompt can publish researched prices without clamps or
preapproval, while leadership can see what changed and safely recover from a bad model/prompt result.

**Why this is still a gate:** AI-researched rows become active immediately, but the business cannot
reconstruct the exact prompt/model/input/source evidence behind every live value, receive a durable alert
for every material change, complete the one-business-day review, or restore a coherent prior rate sheet.
The CEO accepts the absence of price clamps and preapproval; the remaining control is visibility and
rollback, not silently changing the model's result.

**Remaining requirements:**

- Treat the designed pricing prompt as versioned business policy. Every research run and resulting rate
  records prompt version/hash, model, normalized inputs, sources/evidence date, raw structured result,
  derived live values, affected catalog/version, run identity, and effective time so the exact price can be
  explained and reproduced.
- Fail closed only for invalid execution—not for a high or low valid price. Missing required inputs,
  malformed/non-numeric output, absent source evidence, model/provider failure, or a result that cannot map
  to the approved catalog becomes shared-Office work; it does not publish a guessed/default value. No
  minimum/maximum clamp or human preapproval is added.
- Every live AI or manual/pinned change creates durable current-versus-prior visibility and enters the
  shared Office queue for review within one business day. The review records who saw it and any action but
  does not delay publication. Repeated refresh failures, stale research, or an unexplained catalog gap is
  visible to leadership and reconciliation.
- Preserve immutable rate-sheet versions and provide one reasoned, authorized rollback that atomically
  restores the complete prior compatible sheet without editing history or producing a mixed catalog. The
  customer-facing quote and CRM immediately read the restored version, and rollback itself is audited.
- Manual Office edits/pins cannot erase AI history or bypass the same version/change/rollback record.
  Access remains role-controlled, every edit has a controlled reason, and unpinning returns the row to the
  designed prompt on its next refresh.

**Pass owner:** CEO and Finance lead jointly.

### GL-01 — One truthful, complete service catalog

**Business outcome:** A customer can never be promised a service the operating system cannot price,
staff, perform, document, and support profitably.

**Remaining requirements:**

- **There is no single source of truth for services.** Service definitions are hand-duplicated across at
  least four taxonomies plus a separate CRM pricing vocabulary. Create one versioned catalog for the
  services selectable in the approved CRM/lead forms. It drives lead intake/pricing, CRM-created visits,
  property kind and approved duration, technician instructions and allowed products, reporting, plans,
  callbacks, cancellation/refunds, seasonal behavior, margin protection, and leadership reporting. Every
  active technician with a current license remains eligible for every catalog service.
- Replace the free-text CRM service entry and duplicated allow-lists/enums with a controlled catalog
  selection and immutable service/version reference. Residential, commercial, and community classification
  is explicit because duration and pricing depend on it. Mosquito/mosquito-plus-tick lead pricing uses the
  same catalog and approved April–October treatment/year-round billing policy; unsupported text becomes an
  owned catalog decision rather than a silently invented job.
- Public-site service promises remain outside authorized edit scope. The CRM catalog reports each mismatch
  with public calls-to-action—including specialized services that have no equivalent selectable CRM/lead
  outcome—and requests explicit CEO approval before any public component is changed (**GL-20**).

**Pass owner:** CEO, with written sign-off from Operations, Finance, and Compliance.

### GL-20 — Public promises and legal terms match operations

**Business outcome:** Marketing, quote, checkout, agreement, portal, and field execution describe the
same offer, and no unsupported claim creates customer, regulatory, or brand exposure.

**Remaining requirements:**

- **Public implementation is approval-blocked.** The following public-site findings remain go-live issues,
  but current authorization permits only CRM and approved lead-form changes. Engineering presents the exact
  proposed public files/copy and receives explicit CEO approval before changing them; the CRM may not
  conceal or contradict a mismatch.
- **License status and numbers are hard-coded "Active."** The licensed/insured page renders credential
  cards with the word "Active" and fixed license numbers as static text, not driven by verified current
  data. Badges must reflect verified current facts; state-specific technician/company wording is approved
  by Compliance.
- **A "4.9 Google Rating" is hard-coded site-wide** in the announcement banner, while the structured-data
  layer deliberately omits an aggregate rating "until reviews are collected." Unsourced rankings and
  statistics are removed or substantiated.
- **Several specialized service pages ship copy-pasted ant-control metadata** — attic restoration, rodent
  entry-sealing, wood-boring, and the tick program carry ant-control titles, descriptions, and
  breadcrumbs pointing at general pest. Service-page titles, descriptions, structured data, and body copy
  must name the correct service.
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

### GL-22 — Monitoring, recovery, retention, and incident ownership

**Business outcome:** A background failure is noticed before the customer reports it, and business records
can be restored after human or provider error.

**Remaining requirements:**

- **There is still no actionable infrastructure alerting.** The new SES topic transports delivery events;
  it does not page an operator. There are no CloudWatch alarms or business-impact metric thresholds, so a
  silent Lambda crash, scheduled job that never fired, or run of email-send failures would page no one.
  The plan-cancellation and visit-change resumers likewise log pending/failed counts but return successful
  scheduled runs instead of paging Finance, Operations, or Engineering.
  Alerts must cover booking/quote/webhook errors and throttles, scheduled jobs that did not run, email
  failures, stale plan-cancellation, visit-change, or lifecycle commands/claims, cancellation/lifecycle
  promises and processing-refund commitments nearing or missing deadline, mixed customer status/billing/
  access/schedule state, a lead sweep that stopped partway or missed its promised first-response window,
  access/offboarding partial outcomes or missing
  recovery cases, reconciliation mismatches, capacity anomalies, document generation/storage failure,
  and growing/overdue exception queues. Every alert creates or updates a deduplicated shared-Office item
  with a one-business-day response deadline, current on-duty visibility, and escalation when unclaimed or
  overdue; it does not depend on a permanently named primary or use critical/high/routine response classes.
  A subtask that catches its own failure and returns success is not a healthy scheduled run.
- **A failed email-delivery event can be permanently acknowledged.** The event consumer catches malformed
  messages and database/work-queue failures and then returns success; there is no retained failure queue
  or operator alert. Every provider event must be retried until its email state, suppression decision, and
  owned recovery action are durably recorded, or be held in a visible dead-letter queue with a named owner.
  Duplicate or out-of-order events cannot move a bounced/complained message back to delivered (**see X3**).
- **There is no point-in-time recovery and no document backup/versioning configured.** Point-in-time
  database recovery and versioned/retained document backup must be enabled for the seven-year
  legal/financial retention period, and recovery must restore the complete customer/job/plan/invoice
  relationship, accepted agreement, service report, photos, and audit history as usable records.
- Double charge, paid-no-job, unauthorized data exposure, unlicensed dispatch, outage, lost report, and
  email/provider outage each have a one-page response playbook and the same one-business-day owned-response
  commitment. Impact facts may drive different containment actions, but not a different response class or
  deadline. Authorized incident owners can pause CRM/approved lead-form booking, prevent new dispatch,
  stop/reconcile billing, post approved customer messaging, preserve evidence, and authorize restart. A
  deletion/retention policy covers customer requests without deleting records the business must retain.

**Pass owner:** CEO and Engineering lead jointly; Compliance approves retention.

---

## Priority 1 — High revenue and operating reliability

### GL-19 — Launch reconciliation and command view

**Business outcome:** Leadership can tell each morning whether customers, work, and money agree, without
asking engineering to query production.

**Remaining requirements:**

- **No daily money reconciliation** proving successful provider payments equal CRM paid invoices with net
  cash explainable and every mismatch an owned, Finance-signed case (today only *booking* payment intents
  are matched, not the full charge/invoice/refund ledger).
- **No processing-payment aging view.** Leadership cannot see attempts still processing, their selected
  capacity/hold, how long they have waited, whether the provider and CRM agree, whether the customer was
  notified, or which attempts exceeded the approved GL-06 promise. Stale, failed, late-succeeded, and
  customer-retried attempts must reconcile without an engineering query.
- **No plan reconciliation** — the new daily pass re-drives retained cancellation commands, but it does
  not prove provider subscriptions agree with CRM or give leadership a business view. Canceled-still-
  billing, delinquent-still-scheduled, active-plan-without-next-service, racing/stale/false-terminal
  commands, pending cancellations past promise, exact post-request charges/refunds, stranded visits, and
  missing final notices must appear in one owned reconciliation view.
- **No visit-change reconciliation** — the new history screen is an audit list, and the daily pass only
  re-drives retained cancellation claims while treating an already-canceled job as terminal. Leadership
  cannot see a canceled visit with an open/processing charge, incomplete refund or invoice void; a
  reschedule stranded without a resumable command, staffing case, or valid capacity; a missing audit or
  final notice; or stale/racing commands. Each mismatch needs one accountable owner, age, customer and
  money impact, and a safe next action.
- **No customer-lifecycle reconciliation** — leadership cannot see stale lifecycle claims/commands,
  partial transitions, ACTIVE customers whose billing or access was stopped, INACTIVE customers with live
  access or scheduled/paid work, missing transition audits/notices, or recovery cases that closed while
  those facts still disagree. Each mismatch needs one accountable owner, age, customer impact, and safe
  next action.
- **The new Sales board is an operating list, not yet a leadership command view.** It groups leads by
  derived stage and flags overdue rows, but does not show the actual next action/due time or provide
  first-response performance, attempt-vs-reached, qualification, conversion/loss, duplicate/contact-data
  exception aging, source/owner trends, or manager workload totals. Leadership needs those measures plus
  a **service-quality view** covering completion, report delivery, no-access, callbacks, repeat-callback
  rate, and technician trends.
- **No codified pause/rollback thresholds.** The CEO defines the launch thresholds that force
  pause/rollback — any double charge, paid customer without a job, unauthorized access, unlicensed
  assignment, or unexplained money mismatch — and names who decides.

**Pass owner:** CEO and Finance lead jointly; Sales and Operations sign their views.

### GL-10 — Guarantee, callback, and no-access lifecycle

**Business outcome:** Every public service promise has a defined, measurable operational path, and a
failed access visit cannot be "resolved" without actually completing the approved customer and money
outcome.

**Remaining requirements:**

- Create a distinct callback lifecycle linked to the original completed appointment and active
  residual-service subscription. One-time work is ineligible. A customer or Office employee cannot submit
  or schedule it without a retained photo, and one original appointment can create at most one callback.
  The customer receives a reference and owned response within one business day, plus an eligibility result
  and a return date no later than seven business days after the accepted request; tracked holidays/closures
  do not count as business days.
- The callback job carries the original service, report, product, findings, technician, photo, and prior
  callback count. The callback technician records a controlled, evidenced finding: **treatable unexpected
  activity** continues through completion, while **untreatable condition** or **expected behavior** ends
  the guarantee with the technician's evidence and a final customer notice. The CRM does not promise an
  additional callback or appeal after that terminal finding.
- A no-access outcome is the original appointment's nonrefundable cancellation under the 72-hour policy.
  The technician records controlled reason and evidence; the customer receives the no-refund result and
  next paid-rebooking path; and Operations can open the evidence. No employee chooses or calculates a fee,
  refund, or account credit.
- Callback and no-access cases have verified routine Office/technician actions for eligibility, photo
  deficiency, scheduling, completion, terminal technician finding, notice, rebook, and unreachable
  customer. They do not require OWNER closure. Operations sees callback volume, seven-business-day
  compliance, original technician/service, finding, repeat attempts, and margin impact.

**Pass owner:** Head of Operations; CEO approves promises and Finance approves money policy.

### GL-03 — Finish durable fallback promises and email recovery

**Business outcome:** Every promised follow-up becomes one durable, owned Sales action with a deadline the
team can meet, and every customer message reaches a truthful terminal outcome that a routine employee can
recover without engineering.

**Why this is still a gate:** The fallback response is returned even when creation of its owned action
silently fails, and there is no sweep that rebuilds a missing action from a CONTACT booking. The fixed
Monday–Friday calendar has no holidays, closures, or coverage exceptions, and current copy still promises
an hourly response rather than the approved one-business-day response. Other customer copy
still says an unpriceable booking will receive a call regardless of the lead's recorded choice. The
checkbox grants “call or text” permission, while the flow records only one boolean and uses only calls;
it does not retain the exact consent wording/version as a business record.

An accepted email can still have no durable log or provider ID because that write is best-effort. A
transient send failure is labeled **Queued** but nothing is actually queued to retry; a transient bounce
is ignored and remains **Sent**, and an accepted message with no later event has no timeout or owner.
Delivery-event processing can discard failures (**GL-22**), duplicate/out-of-order events have no terminal
state guard, and the customer magic-link sender bypasses the log, configuration set, suppression, and
recovery path entirely. Bounce/complaint work also loses the original message/related-record ownership,
routes every case to Operations, and offers no business-operable correction, suppression-release, or
resend action.

**Remaining requirements:**

- A customer-facing fallback promise and its owned action are one durable commitment. The promise is not
  returned unless the action exists with the correct Sales owner, source record, channel, due time, and
  wording; a recurring sweep finds and repairs any CONTACT booking missing that action.
- The shared Office business-day calendar includes holidays, planned closures, emergency closure, and
  `America/New_York`. Every accepted request receives the same deadline of one business day; all approved
  lead-form messages, booking-link messages, CRM scripts, and employee copy use that rule. Any conflicting
  public marketing copy is recorded under GL-20 and is not edited without CEO approval.
- Compliance approves channel-specific consent and withdrawal language. The record retains the wording/
  policy version, time, source, and channels authorized; it does not claim text consent when no approved
  text workflow exists. A phone number without the applicable consent never creates a call promise or an
  enabled call/text action. Do-not-contact blocks every non-essential channel and sender, fails closed or
  creates an owned consent decision when its status cannot be read, and can be cleared only by an
  authorized role with a controlled reason and retained evidence (**GL-02**).
- Every send has a durable attempt/outbox record before provider submission, one retry identity, the
  originating customer/lead/business record, owner team, message purpose, and provider ID. Provider
  acceptance cannot become an untracked message when the next write fails, and a retry cannot duplicate a
  message the provider already accepted.
- **Queued** means a retry is actually scheduled with bounded backoff, expiry, and escalation. Permanent
  failure, transient bounce/delay, complaint, suppression, and a provider-accepted message that never
  reaches a terminal event all become truthful, timed states with owned recovery; none remains **Sent**
  indefinitely.
- Every production sender—including customer sign-in links—uses the same tracking, delivery-event,
  suppression, and recovery contract. Later bounce/complaint state corrects the originating booking,
  report, notice, or access outcome rather than living only in a general email log.
- The recovery case stays with the original team and lists every missed message. An authorized routine
  employee can correct contact data, record alternate delivery, release a suppression only under the
  approved consent policy, resend the exact message, and see the terminal result. Exception closure is
  governed by GL-18; durable event retry/dead-letter ownership by GL-22; production SES state by GL-21.

**Pass owner:** Head of Sales; Head of Operations approves delivery recovery and Compliance approves
consent.

### GL-02 — Finish a failure-safe lead lifecycle

**Business outcome:** Every lead always has an accountable person, a visible next action, and an auditable
outcome until it becomes a customer or is deliberately closed.

**Why this is still a gate:** The Customers screen still creates leads through the raw record path,
bypassing duplicate review, ownership, missing-contact work, and the new lifecycle command; the data
permission still allows any office client to do the same. Website intake returns success with no named
owner or due action and treats duplicate lookup/case failures as harmless. The current one-business-hour
rule conflicts with the approved one-business-day commitment, while its sweep runs only once each morning
and then gives the new case another day. The board shows only **overdue**, not the action or due time an employee should work
next.

Lead actions can also report success while their activity, customer state, owner, or next-action write
failed, because those writes are best-effort or unchecked; the history screen then hides an error as an
empty timeline and stops at 100 rows. **No answer**, **left message**, and provider-accepted email all
derive the same **Contacted** stage, while qualification has no state. Do-not-contact covers only selected
email templates, fails open when its status cannot be read, does not govern manual call/text choices, and
can be cleared by any office user without a reason. Finally, a phone-only lead is sent to a bare booking
URL while paid conversion matches only a lead reference or email, so the payment can create a second
customer and leave the original lead open.

**Remaining requirements:**

- Every lead entrance—website, Leads screen, Customers screen, and any client/API route—uses one safe
  intake contract. Success means the lead, a valid person/team owner, next action, due time, and every
  required missing-contact or duplicate decision are durably present. Retries and concurrent submissions
  converge on one intake; duplicate lookup or case-write failure cannot silently create an ordinary lead,
  and no raw staff create route can bypass these controls.
- The current action, due time, owner, and age are visible and sorted before a lead becomes late. Every
  lead receives the same one-business-day response deadline, without source- or urgency-based response
  classes. Enforcement isolates one failed lead from the rest of the queue, alerts on a missed/partial
  sweep, and escalates at the actual deadline—not a day later. Reassignment/offboarding conditionally transfers the lead and its current
  follow-up together, verifies the staffed destination and history, and cannot overwrite an assignment
  made after the handoff began (**GL-14**).
- The Head of Sales approves unambiguous stage and outcome definitions. An attempted call is not labeled
  **Contacted**, provider acceptance is not customer delivery, and the workflow distinguishes attempted,
  reached, qualified/unqualified, booking sent, won, lost, and do-not-contact to the extent Sales needs.
  Every completed action clears or replaces its prior next action so an old explicit deadline cannot
  govern the lead forever.
- A lead mutation reports success only after the requested state, immutable activity, actor, owner, and
  next obligation are confirmed. A failed audit/state write cannot advance the stage or close follow-up;
  routine case closure is evidence-based under GL-18. Sales can page, search, and export the complete
  timeline, and a read failure is shown as a failure rather than **no activity** (**X1**).
- Consent and do-not-contact are enforced at every non-essential email, call, and text entrance. A status
  lookup failure cannot authorize outreach; channel choices reflect the exact retained permission; and
  clearing suppression requires an authorized role, controlled reason, evidence, and audit (**GL-03**).
- Every supported conversion method—including a phone-only lead using a spoken link—reliably resolves the
  originating lead or creates a visible identity decision before the original can keep aging. Shared
  phone/email/household data never silently merges people, and a new paid customer cannot leave a second
  open lead representing the same conversion.
- The shared Office calendar and one-business-day response rule govern every source. Head of Sales approves
  manager escalation, follow-up cadence after first response, stage/lost-reason vocabulary, qualification
  rule, duplicate decision authority, phone-only operating path, and which calls/texts may rely on manual
  logging. Compliance approves consent, do-not-contact, essential-message, and suppression-release policy.

**Pass owner:** Head of Sales; Compliance approves consent and suppression policy.

### GL-11 — Minimum complete customer/group portal

**Business outcome:** A customer or property manager can complete the tasks the business directs them to
the portal for without calling the office.

**Remaining requirements:**

- **Customers cannot initiate a reschedule, callback/guarantee, or general help request.** Reschedule is
  office-only, and there is no customer-facing callback, guarantee, or help path. The callback entrance
  must verify an active residual subscription, identify the original appointment, enforce its one-callback
  limit, require and retain a photo, promise no later than seven business days, and return a reference.
  Reschedule and general help use the same visible case/pending behavior; a failed submission remains in
  the shared Office queue instead of falling back to an untracked call.
- A group manager has every portal view and action available to an individual, applied across every
  customer and property currently linked to that group, and nothing outside the group. Group membership
  changes remove stale access immediately and retain who changed it, when, and why. Any public claim that
  residents can schedule in-unit service is backed by the approved property-scoped flow or remains an
  explicit GL-20 conflict; public marketing copy is not edited without CEO approval.

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
| CEO |  |  | GL-01, 05, 06, 08, 13, 14, 16–20, 22 |  |
| Sales |  |  | GL-02, 03, 14, 19 |  |
| Operations |  |  | GL-03, 04, 06, 07, 09–15, 18, 19, 23 |  |
| Finance |  |  | GL-05–09, 16–19, 21 |  |
| Compliance/legal |  |  | GL-01–03, 10, 13, 15, 17, 20, 22 |  |
| Engineering |  |  | GL-05, 21, 22 |  |

**Production go-live decision:** `NO-GO / GO`

**Decision owner:**

**Decision date/time:**

**Known exceptions accepted:** None. Any accepted scope reduction must be removed from public and staff
access before the decision is changed to **GO**.
