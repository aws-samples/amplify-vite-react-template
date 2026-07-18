# BuzzKill — remaining go-live requirements

**Business review date:** 18 July 2026

**Latest commit review:** 2 commits after `0e8d95b`, from `42f375d` through `0551bd0`; newest
implementation commit `42f375d`

**Decision:** **NO-GO until every gate in this document is closed**

**Review seats:** CEO, leadership, operations, customer, technician

This is a **delta-only** business requirements document. It excludes completed capabilities,
implementation detail, and proof-only tasks. The latest implementation commit affects GL-08 and the
plan-recovery, reconciliation, and monitoring portions of GL-18, GL-19, and GL-22. Completed pending-copy
unification, state-derived visit messaging, staff canceling status, a basic retained retry command, and
the purpose-built plan-cancellation recovery type/action have been removed. Those gates now contain only
the single-winner resume, terminal-state, exact-refund, retained-visit, final-delivery, policy-approval,
reconciliation, and alerting gaps that remain. The other gates remain because the new commits did not
close them. An omitted item is not a request to rebuild it.

The **"McDonald's standard"** applies: a week-one employee must be able to do the right thing without
remembering policy, doing mental math, reading system internals, or inventing free-text workarounds. The
system must **prevent** an unsafe or financially wrong action, **explain** the one next step in plain
language, and put every failure in an **owned queue**.

## Go-live rule

Go-live requires all of the following:

1. Every requirement below is marked **Passed** by its named business owner.
2. There are no open launch-severity defects and no open operational exceptions.
3. Any offer, promise, role, or workflow that will not be supported at launch is removed from the site
   and app before approval. "Staff will remember not to use it" is not an acceptable control.

## Priority model

- **P0 — Critical:** Close first. Failure can create unauthorized access or charges, invalid regulated
  records, unsafe/unlicensed work, direct financial loss, or a customer commitment the business cannot
  honor.
- **P1 — High:** Close after P0. Failure creates predictable revenue leakage, service breakdown, repeat
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
  failure and stops at 100; visit-change history has no business screen. Sensitive customer, sales,
  ownership, money, and schedule changes can therefore be applied without durable, complete,
  business-readable history.
- **X2 — An exception can still turn green before the business obligation is fulfilled.** A canceled
  visit can count as money settled while a paid charge remains; adding an email can count as delivering
  the missed notice; any technician ID can count as safe staffing; plan-cancellation recovery can count a
  partial refund as settled and ignores final notice plus unresolved paid/in-progress visits; a
  lead-follow-up can close even when its activity/state write failed; materially different paid-booking
  problems are offered the same retry action even when no booking exists to retry; and lifecycle recovery
  can be closed for fixing only the portal or audit while status, billing, scheduled work, notice, or
  another transition effect is still wrong.
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
| P0 | GL-14 | Finish durable staff-access changes and offboarding | CEO | Partial access or handoff changes leave live privilege, stranded work, or missing history | **64% — Medium** |
| P0 | GL-13 | Finish technician session, route, and historical-data boundaries | CEO | A technician sees a peer's job/customer, or a departed tech keeps field access | **68% — Medium** |
| P0 | GL-15 | Finish regulated-report durability and compliance sign-off | Compliance owner | Invalid, duplicate, or falsely "delivered" legal record reaches a customer | **58% — Medium** |
| P0 | GL-17 | Seasonal plan and licensed-scope decisions | CEO + Compliance owner | Work billed out of season or performed outside legal authority | **32% — Low** |
| P0 | GL-12 | Finish service-specific dispatch readiness | Head of Operations | An unsafe or unperformable visit is dispatched | **62% — Medium** |
| P0 | GL-05 | Complete paid-booking delivery and reconciliation controls | CEO + Engineering lead | A confirmation duplicates, or a paid booking silently disagrees with the money | **72% — High** |
| P0 | GL-09 | Finish failure-safe customer lifecycle transitions | Head of Operations | An interrupted transition leaves billing, access, service, or status wrong while the screen reports success | **66% — Medium** |
| P0 | GL-08 | Finish exact, terminal customer plan cancellation | CEO | Concurrent recovery or a false settlement leaves billing, a refund, visit, or promised notice unfinished | **68% — Medium** |
| P0 | GL-07 | Finish durable office cancel/reschedule | Head of Operations | A canceled visit still charges, promised credit vanishes, or concurrent changes conflict | **74% — High** |
| P0 | GL-18 | Finish truthful, usable exception resolution | Head of Operations + Finance lead | A case closes while money or customer work remains, or routine work waits for an OWNER | **68% — Medium** |
| P0 | GL-04 | Capacity that cannot be oversold | Head of Operations | Two customers buy the last slot; a day is sold with no one to work it | **57% — Medium** |
| P0 | GL-06 | Finish honest, race-safe processing and failed payments | CEO + Finance lead | A processing customer is promised a nonexistent hold, or an async success oversells the day | **55% — Medium** |
| P0 | GL-16 | Governed pricing and margin protection | CEO + Finance lead | AI or an employee publishes a loss-making or nonsensical price | **38% — Low** |
| P0 | GL-01 | One truthful, complete service catalog | CEO | An advertised service cannot be quoted, staffed, or documented | **30% — Low** |
| P0 | GL-20 | Public promises and legal terms match operations | CEO | Contract, regulatory, and brand exposure from unbacked claims | **22% — Low** |
| P0 | GL-21 | Production accounts and integration readiness | Engineering lead + Finance lead | A staging assumption, stale secret, or unstaffed mailbox fails with real money | **28% — Low** |
| P0 | GL-22 | Monitoring, recovery, retention, and incident ownership | CEO + Engineering lead | A background failure stays silent, or records cannot be restored | **48% — Medium** |
| P1 | GL-19 | Launch reconciliation and command view | CEO + Finance lead | Leadership cannot see money, plan, or sales mismatches each morning | **70% — High** |
| P1 | GL-10 | Guarantee, callback, and no-access lifecycle | Head of Operations | A public promise becomes uncontrolled free work or a dispute | **60% — Medium** |
| P1 | GL-03 | Finish durable fallback promises and email recovery | Head of Sales + Head of Operations | A promised follow-up disappears, or an undelivered message remains falsely complete | **68% — Medium** |
| P1 | GL-02 | Finish a failure-safe lead lifecycle | Head of Sales | A lead bypasses ownership, is mislabeled as contacted, or duplicates during conversion | **70% — High** |
| P1 | GL-11 | Minimum complete customer/group portal | Head of Operations | Reschedule, callback, and help requests fall back to phone calls | **74% — High** |
| P2 | GL-23 | Production master data and launch-day operating model | Head of Operations | Correct software runs on wrong facts, or a queue has no owner | **24% — Low** |

---

## Priority 0 — Critical money, security, compliance, safety, and customer commitments

### GL-14 — Finish durable staff-access changes and offboarding

**Business outcome:** A role change or departure cannot leave a person with unintended access, and
leadership can retrieve the complete record of who changed access, why, and what work was reassigned.

**Why this is still a gate:** The idempotency/audit record is still created only after access and work
changes, so concurrent submissions with the same key can both proceed and a process stop can leave an
unrecorded partial change. A failed add/remove/sign-out during a role change throws before the final
readback, ledger, or security case, leaving the effective role set and session state unowned. Last-owner
protection still depends on a fallible rollback after access was removed.

Downstream handoff is also not yet completion-safe. A failed future-job update is ignored, so a visit can
remain assigned to an inactive technician while the result counts only successful updates. The no-login
Schedule path does not validate its reason or confirm the technician write before recording **Complete**,
and its screen does not inspect or explain a partial outcome. Work and lead ownership are changed before
their history writes and without a condition that the departing person still owns the record; a history
failure cannot be repaired by rerunning after ownership already moved, and a concurrent new assignment
can be overwritten. Opening the recovery case is itself not confirmed before the flow depends on it.

**Remaining requirements:**

- Create and conditionally claim one durable access-change command before any provider or work change.
  The server requires a unique idempotency/version key, stores actor, target, controlled reason, prior
  and requested roles, and resumes the same command after timeout, retry, or concurrent submission. A
  duplicate request returns the same persisted progress/outcome rather than starting another change.
- A role reduction cannot leave a combined role set or an old privileged session after any failed
  add, remove, or sign-out step. Every partial state has a durably confirmed security owner and one
  safe resume action; the UI never claims a case exists when its write failed, and completion is read back
  from the provider and the durable command.
- Every job, route, technician, in-progress visit, lead, claimed exception, owner change, and history
  entry is conditionally changed and read back. **Complete** means no future job remains on an inactive
  technician; every in-progress visit has a durable disposition; every lead and exception is in a staffed
  team/active-person queue with matching history; and no offboarding handoff overwrote a newer assignment.
  Any failed item is counted individually and remains safely resumable even if its owner already moved.
- Both Staff and Schedule entrances require the same controlled reason and show the persisted
  **Complete/Partial** outcome plus one next step. Login-less technician deactivation cannot report
  complete until the technician, jobs, in-progress work, ledger, and any recovery case are confirmed.
- Owner changes are serialized so concurrent demotion/offboarding cannot require a fallible rollback
  to preserve access. At least one usable owner remains technically, and production has two named
  owners with MFA and separate recovery access.

**Pass owner:** CEO, with Operations and Sales verifying reassigned work.

### GL-13 — Finish technician session, route, and historical-data boundaries

**Business outcome:** A technician sees only the minimum data for legitimate current or
business-approved historical work, and access disappears when assignment or employment ends.

**Remaining requirements:**

- **The day view still trusts the route, not the assignment.** The technician's day is built by pulling
  every job carrying that route's ID, with no per-job check that the job is still assigned to the
  signed-in technician. A partial or inconsistent reassignment therefore exposes another technician's job
  and customer — the exact leak this gate names. Each day-view job must be checked
  the same way a single job is; a route/job mismatch is withheld and becomes owned Operations work.
- **Reads do not require an active technician.** A read only matches the caller to a technician record;
  it does not confirm the technician is still active. A deactivated employee with an unexpired session
  can still read their day, jobs, and unlocked customer documents at the code layer (today only the
  offboarding sign-out stops them). An offboarded or inactive person must receive no field data or
  document links even with an unexpired session. The business decides whether a currently employed
  technician with an expired applicator credential may review prior work.
- **Locally stored drafts and customer context survive reassignment/deactivation.** An unsent report
  draft and cached customer data remain on the device after access is removed. Reassignment or
  deactivation must render cached job/customer/report data and local drafts unreadable on the next app
  interaction, and record the approved disposition of a former technician's unsent draft.
- **Historical access has no time or scope bound.** A single assigned job grants prior-visit context
  indefinitely. Operations and Compliance approve a historical-access matrix: which completed jobs,
  reports, photos, and customer facts remain visible, to whom, and for how long. No single prior job
  grants indefinite access to every future document for that customer.
- Reassignment records actor, controlled reason, former/new technician, effective time, route effects,
  affected in-progress work, stale-draft disposition, and final access result. Office/owner emergency
  field access requires an approved purpose and reason, is reviewed, and cannot silently impersonate the
  assigned applicator.

**Pass owner:** CEO, with Compliance and Operations verification.

### GL-15 — Finish regulated-report durability and compliance sign-off

**Business outcome:** Every issued service report and correction is an accurate, durable, correctly
authored legal record with a truthful, non-duplicating customer-delivery state.

**Remaining requirements:**

- **Finalization is not concurrency-safe.** It reads the draft, then writes the finalized report,
  completed job, billing start, and next visit with no conditional claim or version. Two simultaneous
  finalizes both see "not finalized" and both proceed into billing and scheduling. Finalization must use
  a conditional claim/version and verify the persisted report and job before reporting success, so
  concurrent, duplicate, and resumed requests converge on one report, one completion, one billing/next
  visit, and one delivery attempt.
- **Report and amendment emails can duplicate.** The "sent" marker is written after the send with no
  provider idempotency key, so a crash between provider acceptance and the marker write causes a
  duplicate on retry. Delivery must use a provider idempotency key or an equivalent outbox that covers
  the **accepted-but-marker-not-stored** window, and every marker write must be verified.
- **The legal record still calls provider acceptance “delivered.”** The general email log can later
  receive a bounce or complaint, but the service report/amendment stamps `emailedAt` and its own delivery
  status when the provider first accepts the send; the later outcome does not correct that legal record.
  One linked state must distinguish pending, mailbox-provider delivery, bounced/complained/suppressed,
  failed, no-email, and approved alternate delivery. A later failure reopens the report-delivery
  obligation and cannot leave the report screen claiming the customer received it (**see X3**).
- **Label validation is a single string match.** It compares one recorded rate string to one catalog
  default and skips entirely when that default is blank; quantity and re-entry are only checked non-blank.
  The catalog must encode every allowed product/service/site/pest combination, quantity or concentration
  range, rate/dilution, and re-entry rule, and finalization must fail closed when any recorded fact is
  outside the rule.
- **The on-site presence review can vanish.** When the durable review write fails, the fallback is
  another best-effort email inside a swallowing try/catch. A persistent recovery record — not only an
  email — must survive until Operations verifies or resolves the review. The technician stays unblocked
  under the CEO's field rule.
- Operations can retrieve the original, every amendment, delivery evidence, photos, no-access evidence,
  and location-review history through authorized screens without engineering (**see X1**). Compliance
  approves the capture-window grace, location thresholds, label rules, evidence, SLA, resolution policy,
  and issued formats for every launch service type.

**Pass owner:** Named Compliance owner; Operations signs delivery and retrieval.

### GL-17 — Seasonal plan and licensed-scope decisions

**Business outcome:** Seasonal and specialized services bill and schedule exactly as customers were told,
and are performed only under valid business and technician authority.

**Remaining requirements:**

- **No seasonal policy is encoded anywhere.** "May–Oct" exists only as a display label on a mosquito
  price line; plans carry only a frequency and a status. Nothing stops a seasonal plan from billing or
  scheduling year-round by omission. The CEO approves, for each seasonal plan: service months, number and
  frequency of visits, annual vs in-season billing, first-year proration, renewal date and notice,
  off-season customer status, pause/cancel/refund handling, and missed-visit treatment — and the system
  must stop billing and scheduling where that policy says it should.
- **Licensed scope by state is absent.** The compliance check only confirms a generic applicator license
  is present and unexpired. There is no mapping of service × state/territory → required company
  registration, credential, expiry, and prohibited scope; wildlife trapping/removal, exclusion, termite,
  pesticide, and restoration are treated as interchangeable. Compliance maps each launch service and
  state to its required authority, and expiring/expired company or technician credentials must remove
  affected capacity before an appointment is sold and raise an advance owner alert.
- Customer quote, accepted terms, schedule, invoice, and job packet all use the approved seasonal and
  licensed scope across renewal, cancellation, expired credentials, season boundaries, and unsupported
  service/state combinations.

**Pass owner:** CEO and Compliance owner jointly.

### GL-12 — Finish service-specific dispatch readiness

**Business outcome:** A technician is dispatched only with the service-specific facts and approved scope
needed to complete the visit safely, and can exit an unperformable visit without inventing a workaround.

**Remaining requirements:**

- **Readiness is still free-text based.** The dispatch gate only checks the address fields are non-blank;
  it does not prove a valid **in-area** address or enforce duration, scope, required prep, required
  instructions, credential, and approved product/constraint minimums from an approved catalog (there is
  no catalog model yet — see GL-01). Nonblank placeholders must not count as a valid address or a complete
  packet.
- The field packet must include the service's approved product/scope constraints and relevant prior
  treatment findings and callback lineage — not only the status of earlier visits.
- **Scope does not match** and **required prep missing** must be dedicated one-tap field outcomes that do
  not falsely start or complete service, open an owned Operations case, preserve the capacity and money
  facts, and send the approved customer next step. None exist today.
- Any safety/access/scope/prep change after assignment is versioned and brought to the assigned
  technician's attention; after service starts, a material change requires an audited manager action and
  technician acknowledgement. No packet versioning or acknowledgement exists today.

**Pass owner:** Head of Operations, with Compliance sign-off.

### GL-05 — Complete paid-booking delivery and reconciliation controls

**Business outcome:** Every succeeded booking payment is either one complete, correctly communicated
customer commitment or one visible, verified refund/recovery case — even when execution stops between
steps.

**Remaining requirements:**

- **The checkout calls a succeeded payment “booked” before the booking exists.** The browser switches to
  **You're booked** from Stripe's payment status without waiting for the server to confirm the customer,
  job, agreement, invoice, and booking transition. A succeeded payment must show a truthful
  **Payment received — finalizing** state until the complete commitment is read back. Finalization failure
  or delay shows the owned recovery/refund state and one safe next step; reload and redirect return to the
  same durable outcome rather than relying on browser memory.
- **The confirmation email itself can still duplicate.** The marker prevents re-*booking*, but the send
  has no provider idempotency key, so a crash between provider acceptance and the marker write re-sends
  the customer confirmation on retry. And a *failed* marker write is only logged, not turned into owned
  work — so "sent but not recorded" is invisible. Delivery must use a provider idempotency key (or
  equivalent outbox) covering that window, and a failed marker write must be visible owned work.
- **The booking still treats provider acceptance as confirmation delivered.** A later bounce/complaint is
  visible only in the general email log and does not correct the booking's communication marker or the
  finalization outcome. The booking must remain linked to the exact send through pending, mailbox-provider
  delivery, bounce/complaint/suppression, failed/unknown, and approved alternate delivery; every non-
  delivered outcome has an owner, deadline, and safe resend/alternate-contact path (**see X3**).
- **Reconciliation checks existence and amount, not full ownership.** It confirms a child record resolves
  and a paid invoice for the payment exists, but does not verify the customer, job, plan, agreement,
  service, and date all belong to the *same* booking. A cross-linked (wrong-owner) child would not be
  flagged. Reconciliation must validate the relationships, not merely that records exist.
- **A truncated scan can still report green.** The provider scan stops at a page cap and then reconciles
  against the truncated set, able to return "ok" and auto-resolve healthy cases. A truncated, expired,
  or timed-out run must create an owned Finance/Engineering failure and leave prior state visible — it
  cannot report green or auto-resolve.

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
  visit disposition, balance/refund/credit next step, portal implication, and contact path. Leadership
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
still conflicts on whether coverage ends immediately or the plan stays active during recovery and has no
recorded CEO/Finance/Operations approval.

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
  agrees, no payment is still capable of settling, and the complete amount of every charge that actually
  *paid* on or after the first accepted request is provider-confirmed as refunded exactly once. Detection
  uses payment time and the durable request when the plan timestamp is absent; partial refunds remain
  open; each affected invoice is visible; and no refund promise is sent unless the command or Finance case
  that guarantees it is durably confirmed.
- Every unpaid, prepaid, and in-progress visit reaches a final, customer-approved disposition with an
  Operations owner, deadline, schedule readback, and customer contact. The plan command and its recovery
  remain open until those decisions, the exact full refunds, and the cancellation notice reach approved
  terminal outcomes. **Resume cancellation** must actually repair each residual; an unpaid schedule
  failure cannot be mislabeled as a paid-money case (**GL-18**).
- Customer, employee, and leadership views use the persisted terminal result. Outstanding balance is net
  of refunds/credits; pending and success distinguish provider stop, schedule work, refunds, and message
  delivery; provider acceptance is not called customer delivery; and the immutable history retains who
  requested the cancellation, when, every provider/money/service effect, notices, and final resolution
  (**GL-03** and **GL-19**).
- The CEO, Finance, and Operations approve one non-contradictory launch policy for effective cancellation
  and coverage time, current-period treatment, net outstanding balance, prepaid and in-progress visits,
  post-request charges/refunds, save offers, authority, and the **usually within one business day**
  commitment. Accepted terms, preview, pending state, staff recovery, reconciliation, and every customer
  notice enforce and version the approved policy.

**Pass owner:** CEO, with Finance and Operations sign-off.

### GL-07 — Finish durable office cancel/reschedule

**Business outcome:** An employee cannot cancel or move a paid visit without completing the money,
credit, capacity, route, audit, and customer-notification consequences in one guided action.

**Why this is still a gate:** A cancel/reschedule has no durable command or conditional claim before
money and schedule changes, so concurrent actions can both proceed and a hard stop after refund but
before job cancellation is not resumable. An invoice void is reported successful without checking the
write, and a visit can be canceled while a payment remains in flight—then return **Complete** if email
succeeds. Retained credit is only a best-effort Finance task, yet the customer is told the credit
exists. Visit-change audit and notification cases are best-effort and the history has no business
screen. The reschedule form does not show the consequence preview, makes reason optional, and does not
send a technician/route, so the server skips its capacity check and can mark an unassigned visit
scheduled. Repeating an already-canceled request also reports the customer notice as sent without
reading the prior outcome.

**Remaining requirements:**

- Create and conditionally claim one durable visit-change command before refund, credit, invoice,
  route, job, or message changes. Concurrent cancel/reschedule requests and retries converge on one
  decision, one money disposition, one schedule result, and one customer notice.
- A provider-accepted refund followed by a timeout or failed CRM write resumes from the same command
  and cannot refund twice or strand a paid visit as scheduled. Every provider and CRM step records a
  checked result before **Complete**.
- Cancellation does not complete while a charge is processing. The workflow stops the payment or
  owns it through settlement/refund, verifies any open invoice is void, and tells the customer the
  truthful pending or final money state.
- **Retain as account credit** creates a real customer credit balance/ledger entry before the visit is
  canceled or the customer is told it exists. Finance can see, apply, expire, reverse, and reconcile
  the credit; a best-effort task or email is not the balance.
- Reschedule uses the same visible consequence preview as cancellation, requires a controlled reason,
  and applies the shared capacity/credential rule before committing the customer date. A visit cannot
  be labeled scheduled without a valid capacity disposition and owned staffing state.
- Visit-change audit and any notification/recovery case are required durable outcomes. Operations and
  Finance can search/export the complete cancellation/reschedule history, including actor, reason,
  policy, money, prior/new schedule, delivery, partial state, and final resolution.
- Customer communication uses durable delivery state and one retry-safe notice. An already-processed
  request returns the stored money, schedule, and communication outcome rather than inventing a clean
  **Sent/Complete** result. Canceling one visit never silently cancels its recurring plan.

**Engineering status — closed (Opus 4.8, commit `d9446ab`):** Office cancel/reschedule is now a durable,
resumable, truthful command.
- *R1/R2/R7 durable command:* a new `VisitChangeClaim` (id = jobId) is taken BEFORE any money/schedule
  change, so concurrent actions converge on one result. A stage machine records each checked result;
  `resumeVisitChange` + a daily `reconcileVisitChanges` sweep re-drive a stuck cancel from the last
  completed step and can never refund twice or strand a refunded-but-scheduled visit; a concurrent cancel
  loses the claim and reports in-progress; an already-canceled replay returns the STORED ledger outcome,
  not a fabricated Sent/Complete.
- *R3 processing:* a live PaymentIntent is retrieved and branched — a cancelable pre-processing intent is
  canceled and the invoice voided (read back); a genuinely processing charge yields a PENDING outcome,
  owned through settlement by a finance case, with a truthful "still processing, we'll refund it" notice.
  The visit is never reported COMPLETE while money is in motion, and every void is read back.
- *R4 (business decision 2026-07-18: credit dropped for launch):* "keep as account credit" is removed from
  the cancel options everywhere — no real credit ledger existed, so it promised a balance backed by
  nothing. Cancel offers refund-to-card, an owner manager exception, or a policy fee-retained.
- *R5 reschedule parity:* reschedule requires a controlled reason and shows the same consequence preview;
  a dated-but-unstaffed visit opens an owned `UNSTAFFED_VISIT` case rather than a silent "scheduled".
- *R6 durable audit + history:* `recordVisitChangeEvent` is blocking-on-failure (opens a
  `VISIT_CHANGE_RECOVERY` case); a new **Visit changes** screen (search + CSV export) is reachable by
  Operations AND Finance.
- Controlled reason codes (`VISIT_CANCEL_REASONS` / `VISIT_RESCHEDULE_REASONS`) feed the exportable "why".
Full amplify (865) and CRM (188) tests pass; `tsc -p amplify` and CRM `tsc` clean. **Residuals needing a
human:** the reason-code lists, the processing-charge stance (flip-canceled-with-owned-settlement), and the
reschedule capacity rule (per-tech stop count, weekend office override) are engineering defaults that need
Ops/Finance sign-off; a **real account-credit ledger** is deferred (credit dropped for launch) and would be
its own gate; and the resume sweep + processing branch should be validated against real Stripe in staging.

**Pass owner:** Head of Operations; Finance approves money and credit dispositions.

### GL-18 — Finish truthful, usable exception resolution

**Business outcome:** A case turns green only after the exact customer, money, access, or operating
obligation is true, while a routine employee can complete ordinary recovery work without CEO-level
authority or an invented workaround.

**Why this is still a gate:** A paid-cancellation case currently counts a canceled visit as money
settled even when a paid invoice has not been refunded, voided, or converted to a real credit. A
missing-contact case closes when an email address merely exists, not when the missed notice is
delivered. An unstaffed visit closes for any technician ID without proving that person is active,
qualified, available, and valid for the service. All paid-booking exceptions show the same retry action
even though some represent an orphan payment, duplicate record, provider outage, or amount mismatch
that cannot be fixed by retrying a booking. An unpaid visit stranded by a plan cancel is still filed as
**Paid cancellation**, whose instructions are about settling money, and the plan-level schedule-read
failure is not linked to a job its normal verifier can inspect. The new plan-cancellation verifier can
count a partial refund as full settlement, ignores final customer delivery and unresolved paid/in-progress
visits, and its resume action cannot repair residual work after the plan reads CANCELED. Lifecycle
recovery can likewise close after only the portal or missing audit row is handled. Ten of the sixteen
exception types have no verified normal completion path. The lead-follow-up type is one: it can be
manually closed as **contacted**, **booking sent**, **lost**, or **do-not-contact** without verifying the
corresponding lead fact, and the automatic path can resolve it after a swallowed activity or state-write
failure. Callbacks, delivery failures, duplicate leads, portal failures, pricing decisions,
location reviews, and staff-access recovery likewise depend on an OWNER manual override. For email
failures, the instruction says to correct, unsuppress, and resend, but the case provides no bounded action
to do those things or identify every message the customer missed. That turns routine work into an
executive bottleneck and treats a normal completion as an exception to policy. Claim and close actions
also have no single-winner control, so two employees can act on the same case.

**Remaining requirements:**

- A paid-cancellation case remains open until the full amount owed has one durable disposition: provider-
  confirmed refund, successfully voided unpaid invoice, or posted customer credit. Canceling the visit
  alone never proves the money is settled; partial refunds and multiple invoices reconcile to the exact
  amount owed.
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
- A lifecycle-recovery case stays open until the intended transition is verified across provider billing,
  CRM plans and status, all paid/unpaid/in-progress visits and routes, portal login/groups, outstanding
  balance disposition, customer notice, and immutable audit. Portal-only or audit-only closure cannot
  turn a mixed customer green; each missing transition remains separately visible and recoverable
  (**GL-09**).
- A lead-follow-up case closes only after the matching durable lead fact exists: recorded attempt and its
  actual outcome, confirmed booking-link send, controlled lost decision, do-not-contact decision, or paid
  conversion. Closing today's task must also leave the next approved action and due time visible; a free-
  text/manual close cannot make an open lead disappear from follow-up.
- For every exception type, the Head of Operations approves the normal resolution event a routine role
  may complete and what system or business evidence proves it. Ordinary callback, delivery, merge,
  portal-recovery, pricing, and staff-recovery outcomes use bounded actions; a manual override is reserved
  for a genuine exception to the approved path, not the standard way work is finished.
- The CEO approves which role may override each exception class. Finance separately approves money-case
  authority. Every override has a controlled reason, meaningful evidence, and an accountable review path;
  the policy shown to employees is the same policy enforced when they act.
- Claiming, resolving, reopening, and releasing a case has one winner. Concurrent employees cannot both
  own or complete the same customer or money action; offboarding cannot overwrite a newer claim; and the
  ownership change plus immutable history are one recoverable outcome rather than a release that succeeds
  before its history fails. The real staffed inboxes, primary/backup owners, SLAs, and handoffs are
  established in GL-23.

**Pass owner:** Head of Operations; Finance approves money outcomes and the CEO approves override
authority.

### GL-04 — Capacity that cannot be oversold

**Business outcome:** Any day/window shown to a customer can actually be staffed, and two customers
cannot buy the same last unit of capacity.

**Remaining requirements:**

- **No slot is ever reserved.** There is no capacity-hold concept in the system; two concurrent bookings
  for the last slot both pass the check because capacity is derived from existing jobs and nothing is
  written to claim the slot. A **PROCESSING** booking is also excluded from availability even though the
  customer is told “Your slot is held,” so another customer can buy the last capacity before the async
  payment settles; the later success then creates an oversold job. Selecting checkout must place a real,
  expiring hold that availability counts, that only its payment can consume, and that abandonment,
  failure, and expiry release. Concurrent or async purchases for the last slot yield exactly one booking
  and a truthful alternate-date/refund outcome for the other, with no manual database repair. The CEO
  approves hold duration by permitted payment method.
- **Capacity is a coarse technician-per-day count that offers slots even with zero technicians.** It
  multiplies active-technician count by a fixed stops-per-tech and floors that count at one, so a day with
  **no** active technician still offers capacity. Sellable capacity must use each technician's actual
  working day, approved leave/blackouts, credential validity on the service date, service duration,
  territory, and travel allowance — and zero eligible technicians must mean zero sellable dates. None of
  leave/blackout, per-tech schedules, territory, or on-date license validity is considered in the funnel
  today.
- **The funnel and dispatch board do not share one capacity rule** — the stops-per-tech constant is
  duplicated in two files "kept in step" by hand. They must be one rule so a day cannot be available to
  the customer and over capacity to Operations.
- Operations can block a day, technician, territory, or window and see why a date is or is not sellable;
  removing capacity immediately protects all unconsumed public slots. The system prevents staffing a
  service outside the assigned technician's active license/scope even if the slot was quoted earlier.

**Pass owner:** Head of Operations.

### GL-06 — Finish honest, race-safe processing and failed payments

**Business outcome:** The customer and office always see the same payment, capacity, and booking state;
an async payment cannot create a double payment, a nonexistent hold, an oversold visit, or an obligation
that waits forever.

**Why this is still a gate:** A processing customer is told **Your slot is held**, but no capacity record
is created and availability does not count the PROCESSING booking. The customer is also told no charge was
made, which is not an approved method-specific description of every pending bank or wallet transaction.
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

- The CEO and Finance approve the launch payment methods. If launch is cards-only, async methods are
  disabled in the provider and removed from customer/staff promises. If async methods remain, every rule
  below is required and the accepted terms disclose the pending-payment, capacity, cancellation, and
  refund behavior for each method.
- **Held** is displayed only after a real capacity hold is durably read back. The hold is counted by all
  availability and dispatch decisions, belongs to one payment attempt, has an approved expiry, and is
  consumed, released, or converted exactly once. A payment that succeeds after its hold is lost receives
  an approved alternate date or automatic refund; it never silently oversells the day (**GL-04**).
- Payment and booking transitions use one approved, conditional state machine. Processing, success,
  failure, cancellation, expiry, and retry events apply only to the current payment attempt and allowed
  prior state; duplicate, concurrent, stale, or out-of-order events cannot regress BOOKED or overwrite a
  later business decision. Every rejected or failed transition remains visible and owned.
- PROCESSING has a durable start time, customer promise, next check, expiry, and owner. Reconciliation
  re-reads the provider until success/failure, finds missing webhook events, and raises an owned case before
  the promise expires. A timeout follows one CEO/Finance-approved cancel, extend, alternate-date, or refund
  outcome and sends one durable notice.
- Returning, refreshing, or retrying customers retrieve the durable state: processing means **do not pay
  again**, succeeded-but-incomplete means **payment received—finalizing**, booked means the full commitment
  exists, and failed means no booking plus the approved retry path. No state falls through to **Quote not
  found** or invites another payment without first proving the prior attempt is terminal (**GL-05**).
- Customer copy describes funds truthfully for the enabled method—authorized, pending, settled, failed,
  reversed, or refunded—and never promises an available slot after the system releases it. Finance
  approves this language and the timing of customer notices.
- Operations has a plain-language view of every processing/failed attempt showing customer, amount,
  method, selected slot/hold, age, provider state, notice state, owner, and one safe next action. The
  leadership aging/reconciliation view is completed in GL-19, production webhook setup in GL-21, and
  durable notification handling in GL-03.

**Pass owner:** CEO and Finance lead jointly; Head of Operations approves the recovery workflow.

### GL-16 — Governed pricing and margin protection

**Business outcome:** Neither AI nor a low-skill employee can publish a loss-making, nonsensical, or
unapproved price.

**Decision required before this gate can be worked.** The pricing engine is *deliberately* ungoverned:
the code states there are intentionally no minimum/maximum clamps, no review queue, and no approval gate,
citing a standing "no review gates, no clamps" rule. That is a live business decision, not an engineering
gap. The CEO and Finance must explicitly choose one:

- **(a) Accept ungoverned AI pricing as a launch risk** — in which case GL-16 is replaced by a monitoring
  and rollback requirement (a live-rate change alert, a daily current-vs-prior price review, and a fast
  owner rollback), and the acceptance is recorded here; **or**
- **(b) Govern it**, in which case the following apply.

**Remaining requirements:**

- Finance approves fully-loaded cost and minimum gross-margin rules for every launch catalog item —
  labor time, drive time, material, lead cost, payment fee, callback allowance, overhead, seasonality,
  property size, recurring cadence, and add-ons. Today a variable-cost floor is applied only to one-time
  jobs in one zone; termite, wildlife, commercial, every plan cadence, extra-nest, and HOA per-unit carry
  no floor, and there are no maximums.
- Hard minimums, maximums, sensible size/quantity progression, and input-validity rules apply before any
  price reaches a customer; missing or invalid inputs fall to review rather than guessing.
- AI/researched rate changes cannot go live merely because they were generated — today they are written
  active immediately. The CEO sets approval thresholds; material changes require owner/finance approval
  and a preview of affected quotes, margin, and current-vs-proposed prices.
- Every live rate change records actor/source, reason, evidence date, prior/new value, approval, and
  effective time (today only a single prior-price mirror is kept), and an owner can roll back safely.
- Routine office users cannot edit live rates or protected plan prices — today routine OFFICE staff can
  create, update, and delete live market rates directly. Emergency overrides are owner-only, time-limited,
  reasoned, and reported.

**Pass owner:** CEO and Finance lead jointly.

### GL-01 — One truthful, complete service catalog

**Business outcome:** A customer can never be promised a service the operating system cannot price,
staff, perform, document, and support profitably.

**Remaining requirements:**

- **There is no single source of truth for services.** Service definitions are hand-duplicated across at
  least four taxonomies (the funnel's six flat codes, the wire codes, the server allow-list, and the
  database enum) plus a separate CRM pricing vocabulary — a guaranteed drift hazard. Each service carries
  only display flags; **no** duration, credential, instructions, allowed products, report requirements,
  cancellation rule, or guarantee is mapped to it. The CEO approves one launch catalog that maps every
  marketed service to all of those, and that same catalog drives marketing, quoting, scheduling duration,
  technician instructions, reporting, plans, callbacks, refunds, and leadership reporting.
- **The site advertises services the funnel cannot quote.** Mosquito & Tick is prominently marketed (nav,
  service pages, tick sub-program) but has no funnel code — its pricing lives only in the CRM engine,
  never the public instant quote — while the funnel copy asserts "every service on this form prices
  instantly." Flea & Silverfish and the rodent/termite sub-services collapse into generic paths the same
  way. Every public call-to-action must have one valid result: a genuinely bookable service or an honest
  specialist-review path. "Exact price" and "no callback" language appears only where it is true.
- Termite, wildlife, exclusion, attic/restoration, mosquito/tick, community, commercial, and other
  specialized offers are each individually approved or removed from launch — they may not inherit a
  generic category because no matching one exists.

**Pass owner:** CEO, with written sign-off from Operations, Finance, and Compliance.

### GL-20 — Public promises and legal terms match operations

**Business outcome:** Marketing, quote, checkout, agreement, portal, and field execution describe the
same offer, and no unsupported claim creates customer, regulatory, or brand exposure.

**Remaining requirements:**

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
  scope, source, owner, and review/expiry date, or removed. Guarantee, cancellation, no-access,
  refund/credit, recurring-billing, seasonal-renewal, and price-adjustment language is identical across
  marketing, checkout terms, accepted agreement, portal, and employee workflows. Legal/insurance counsel
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
- A monitored `sales@pestbuzzkill.com` mailbox plus the operations/finance routes exist, are staffed to
  the approved SLA, and own incoming replies, failed messages, alternate contact, and vacation coverage.
- Production SES is enabled for the required launch volume; the approved sending domain/identity has
  DKIM, SPF, and DMARC in force; and the deployed configuration set, event destination, permissions, and
  suppression policy apply to every production sender. Staging cannot send as production or alter the
  production suppression list.
- Delivered customer communications use the approved production URLs, portal and quote/cancel links,
  sender identity, phone, service area, maps key, AI key, scheduler, and payment return URLs on supported
  phone and desktop devices.
- At least two named owners can access each critical provider account with MFA and recovery codes; no
  launch dependency is controlled by one personal account.

**Pass owner:** Engineering lead and Finance lead jointly.

### GL-22 — Monitoring, recovery, retention, and incident ownership

**Business outcome:** A background failure is noticed before the customer reports it, and business records
can be restored after human or provider error.

**Remaining requirements:**

- **There is still no actionable infrastructure alerting.** The new SES topic transports delivery events;
  it does not page an operator. There are no CloudWatch alarms or business-impact metric thresholds, so a
  silent Lambda crash, scheduled job that never fired, or run of email-send failures would page no one.
  The plan-cancellation resumer likewise logs pending/failed counts but returns a successful scheduled run
  instead of paging Finance or Engineering.
  Alerts must cover booking/quote/webhook errors and throttles, scheduled jobs that did not run, email
  failures, stale plan-cancellation or lifecycle commands/claims, cancellation/lifecycle promises nearing
  or missing deadline, mixed customer status/billing/access/schedule state, a lead sweep that stopped
  partway or missed its promised first-response window, access/offboarding partial outcomes or missing
  recovery cases, reconciliation mismatches, capacity anomalies, document generation/storage failure,
  and growing/overdue exception queues, and reach a named primary and backup. A subtask that catches its
  own failure and returns success is not a healthy scheduled run.
- **A failed email-delivery event can be permanently acknowledged.** The event consumer catches malformed
  messages and database/work-queue failures and then returns success; there is no retained failure queue
  or operator alert. Every provider event must be retried until its email state, suppression decision, and
  owned recovery action are durably recorded, or be held in a visible dead-letter queue with a named owner.
  Duplicate or out-of-order events cannot move a bounced/complained message back to delivered (**see X3**).
- **There is no point-in-time recovery and no document backup/versioning configured.** Point-in-time
  database recovery and versioned/retained document backup must be enabled for the approved
  legal/financial retention period, and recovery must restore the complete customer/job/plan/invoice
  relationship, accepted agreement, service report, photos, and audit history as usable records.
- The CEO approves severity levels and response/communication targets for double charge, paid-no-job,
  unauthorized data exposure, unlicensed dispatch, outage, lost report, and email/provider outage, each
  with a one-page first-response playbook. Named incident owners can pause public booking, prevent new
  dispatch, stop/reconcile billing, post customer messaging, preserve evidence, and authorize restart.
  A deletion/retention policy covers customer requests without deleting records the business must retain.

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

- **No guarantee matrix and no return-service lifecycle for completed jobs.** Public pages promise
  guarantees/free returns, but a customer invoking one has no distinct linked path. The CEO approves a
  guarantee matrix by service (eligibility, term, covered pests/conditions, exclusions, customer
  obligations, maximum response time, charge, approval authority), the accepted customer terms carry the
  same matrix, and a callback/return job is visibly linked to the original service.
- **A no-access outcome notifies only the office, not the customer.** The customer must see the approved
  reason and evidence and receive a truthful next step; Operations can open the evidence from the case.
- **The no-access fee policy is not enforced by disclosure.** No fee is charged today (safe by omission),
  but the approved policy must be encoded so a fee is charged only when that exact policy was disclosed
  before purchase and the case meets it — the employee never decides or calculates a fee.
- No-access and callback cases need bounded normal outcomes for rebook, refund, credit, notice, reached,
  and approved unreachable attempts. Today only a rebook has a verified normal close; the other outcomes
  require an OWNER override rather than a routine service-recovery action (X2). Operations sees callback
  volume, reason, original technician/service, days to resolution, and repeat-callback rate as a quality
  and margin signal.

**Pass owner:** Head of Operations; CEO approves promises and Finance approves money policy.

### GL-03 — Finish durable fallback promises and email recovery

**Business outcome:** Every promised follow-up becomes one durable, owned Sales action with a deadline the
team can meet, and every customer message reaches a truthful terminal outcome that a routine employee can
recover without engineering.

**Why this is still a gate:** The fallback response is returned even when creation of its owned action
silently fails, and there is no sweep that rebuilds a missing action from a CONTACT booking. The fixed
Monday–Friday calendar has no holidays, closures, or coverage exceptions, and a request at 5:59 p.m. is
still promised “within the hour” even though the encoded workday ends at 6:00 p.m. Other customer copy
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
- The Head of Sales approves an operating calendar with holidays, planned closures, emergency closure,
  timezone, and the latest time at which a full response window can still be promised. The deadline never
  falls after staffed coverage, and all public pages, booking-link messages, scripts, and employee copy use
  the same channel and timing rule.
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
owner or due action and treats duplicate lookup/case failures as harmless. The promised one-business-hour
response is enforced by a sweep that runs only once each morning, after the deadline, and then gives the
new case another day. The board shows only **overdue**, not the action or due time an employee should work
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
- The current action, due time, owner, age, and urgency are visible and sorted before a lead becomes late.
  Enforcement runs often enough to meet the approved first-response promise, isolates one failed lead
  from the rest of the queue, alerts on a missed/partial sweep, and escalates to a manager at the actual
  deadline—not a day later. Reassignment/offboarding conditionally transfers the lead and its current
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
- Head of Sales approves the response/follow-up calendar and SLA by source, manager escalation, stage and
  lost-reason vocabulary, qualification rule, duplicate decision authority, phone-only operating path,
  and which calls/texts may rely on manual logging. Compliance approves consent, do-not-contact,
  essential-message, and suppression-release policy.

**Pass owner:** Head of Sales; Compliance approves consent and suppression policy.

### GL-11 — Minimum complete customer/group portal

**Business outcome:** A customer or property manager can complete the tasks the business directs them to
the portal for without calling the office.

**Remaining requirements:**

- **Customers cannot initiate a reschedule, callback/guarantee, or general help request.** Reschedule is
  office-only, and there is no customer-facing callback, guarantee, or help path, so these fall back to
  phone calls. Customers must be able to start the approved reschedule, callback/guarantee, and general
  help paths with a visible response commitment and a case/reference number, and a failed submission stays
  visibly pending in an owned Operations queue.
- The business defines what a group manager may see and do versus an individual resident, and any public
  claim that residents can schedule in-unit service is backed by an approved property-scoped resident flow
  or removed (ties to GL-20).

**Pass owner:** Head of Operations.

---

## Priority 2 — Launch operating readiness

### GL-23 — Production master data and launch-day operating model

**Business outcome:** The production app contains the real facts needed to sell and serve, and every queue
has a staffed owner from the first lead through the last payment exception.

**Remaining requirements:**

- Production contains CEO-approved service areas, catalog/rates/cost floors, durations, products and label
  data, technician identities/licenses/expiry dates, working calendars, territories, customer communication
  templates, policy versions, and finance/provider mappings. Every production technician and staff user is a
  named real person with the correct role and linked profile; nonproduction identities and data are absent
  or unmistakably isolated. **Confirm the committed property data feeding the site is real production data,
  not sample data.**
- Sales, Operations, Finance, Compliance, and CEO exception queues have named primary/backup owners, hours,
  response SLA, handoff rule, and vacation/offboarding coverage. This is where the retained-credit finance
  step (GL-07) and the exception-owner assignments (GL-18) are made real.
- Operations documents the daily opening checklist, next-day dispatch review, mid-day exception review,
  end-of-day money/work reconciliation, and after-hours customer escalation. Launch support has a published
  command channel, issue intake, severity owner, decision log, and twice-daily review, and leadership knows
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
