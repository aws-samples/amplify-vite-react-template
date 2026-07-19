# BuzzKill — remaining go-live requirements

**Business review date:** 19 July 2026

**Latest commit review:** every commit after `f70e621` through `41020a6`; newest
implementation commit `41020a6`

**Decision:** **NO-GO until every gate in this document is closed**

**Remaining:** **23 gates / 77 remaining requirements**, ordered by launch priority and
expected impact. The count is the number of top-level bullets under the "Remaining requirements"
headings below — sub-clauses inside one bullet are not counted separately.

**Average Opus 4.8 / Ultracode full-gate closure likelihood:** **39.6%** (mean of the register column)

**Review seats:** CEO, leadership, operations, customer, technician

**Business policy inputs approved:** 18–19 July 2026

This is a **delta-only** business requirements document. It excludes completed capabilities,
implementation detail, and proof-only tasks. The newest commits close GL-06's engineering
(`1228822` — pending bank debits are real "Payment pending" commitments under one conditional payment
state machine, with exactly-once failure/settlement/cancel paths, a daily Stripe reconcile, durable
returning-customer states, and the office payments-in-flight view) and remediate the GL-16 production
cost incident (`d990d07` — one research drainer at a time, atomic per-day budget reserved before every
provider call, bounded backoff with owned exhaustion, seeding that cannot regenerate retired work, one
daily digest instead of per-rate emails, and the Market Rates engine panel; GL-16's audit/rollback
requirements remain open below). The prior commits close GL-09's engineering (`82f5fbf`)
and land a systemic remediation (`d546c10`) that every earlier "single-winner" closure claim depended
on: stale-lease takeover on every operational lock and durable command (staff access, owner serial,
lifecycle claim/command, plan cancellation, visit change, booking finalization, booking communications,
report finalization) is now ONE atomic conditional write instead of delete-then-create (which had let
two reclaimers both win), every progress/terminal write and release is fenced on the holder's nonce (an
expired worker can no longer overwrite or unlock its successor), browser roles can no longer delete any
operational lock or durable command, and deterministic interleaving tests cover two stale reclaimers,
an expired holder releasing after takeover, and an expired holder writing after takeover. The
remediation also reopened and corrected GL-17 (licence-record read failures fail closed with no legacy
fallback, none for historical authorship once records exist; seasonal-ledger write failures are owned
work; one-visit-per-month is enforced atomically by the obligation row as the month's mutex) and GL-12
(a missing Google Routes configuration refuses dispatch rather than silently skipping the proof).
Completed and removed from GL-09: the durable pre-effect lifecycle command with per-stage progress,
persisted inventory, exclusive fenced lease, serialized opposite requests, and stale-command
escalation; owned paid/in-progress visit decisions and owned sweep/read failures; the server-computed
employee preview and persisted-result completion states (never success on partial/in-progress/
unaudited); per-reason policy-driven tracked customer notices; and fully paged history with visible
read failures. GL-09 now carries only leadership sign-off of the per-reason transition policy and the
history export that rides GL-19. An omitted item is not a request to rebuild it.

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

- **X1 — Lead, exception, and visit-change history can still disappear.**
  `LeadActivity`, `WorkEvent`, and `VisitChangeEvent` writes can still occur after the business change
  or fail without a durably confirmed fallback. The lead screen substitutes an empty list on failure and
  stops at 100. Visit-change history is now fully paged and business-readable, but a lost event or
  recovery case can still be ignored and an already-canceled replay defaults missing history to
  **Sent/Complete**. (Lifecycle history is closed: `CustomerLifecycleEvent` loss keeps the transition
  PARTIAL with owned recovery, and the screen pages to exhaustion and shows read failures as failures.)
  Sensitive sales, ownership, money, and schedule changes can therefore still be applied without
  durable, complete history.
- **X2 — An exception can still turn green before the business obligation is fulfilled.** A canceled
  visit can count as money settled while a paid charge remains; adding an email can count as delivering
  the missed notice; any technician ID can count as safe staffing; plan-cancellation recovery can count a
  partial refund as settled and ignores final notice plus unresolved paid/in-progress visits; a
  lead-follow-up can close even when its activity/state write failed; and materially different
  paid-booking problems are offered the same retry action even when no booking exists to retry.
  (Lifecycle recovery is closed: the LIFECYCLE_SETTLED verifier requires billing, schedule, access,
  status, and the durable command to agree before the case closes.) Visit-change recovery has no
  verifier, its resume can no-op after cancel or refuse reschedule, and cancellation itself can report
  complete after an invoice-void failure.
- **X3 — Customer communication is still best-effort after provider acceptance.** An accepted email can
  lose its log and provider ID; transient failures have no actual retry; delivery-event processing can
  acknowledge and discard a failed update; and the business record that originated the message is not
  brought back out of “sent” when the later outcome is a bounce or complaint.

## Gate register

| Priority | ID | Remaining gate | Accountable business owner | Impact if missed | Opus 4.8 / Ultracode likelihood |
|---|---|---|---|---|---|
| P0 | GL-14 | Production two-owner setup — engineering closed (`3717092`) | CEO | Partial access or handoff changes leave live privilege, stranded work, or missing history | **15% — Very low (ops setup only)** |
| P0 | GL-13 | Policy-vocabulary approvals — engineering closed (`27ca1fb`) | CEO | A technician sees a peer's job/customer, or a departed tech keeps field access | **12% — Very low (approvals only)** |
| P0 | GL-15 | Compliance sign-off of encoded rules — engineering closed (`bbcf0c3`) | Compliance owner | Invalid, duplicate, or falsely "delivered" legal record reaches a customer | **15% — Very low (sign-off + SES wiring)** |
| P0 | GL-17 | Mosquito sale-path decision — engineering closed (`dc39f74`) | CEO + Compliance owner | Work billed out of season or performed without a current technician license | **20% — Low (product decision + ratification)** |
| P0 | GL-12 | Copy/vocabulary approvals — engineering closed (`5c8c6ef`) | Head of Operations | An unsafe or unperformable visit is dispatched | **18% — Very low (approvals + backfill)** |
| P0 | GL-05 | Copy sign-off + policy definitions — engineering closed (`cc76773`) | CEO + Engineering lead | A confirmation duplicates, or a paid booking silently disagrees with the money | **15% — Very low (sign-offs)** |
| P0 | GL-09 | Lifecycle policy sign-off + history export — engineering closed (`dc39f74`) | Head of Operations | An interrupted transition leaves billing, access, service, or status wrong while the screen reports success | **10% — Very low (sign-off; export rides GL-19)** |
| P0 | GL-08 | 72-hour copy + refund-workflow sign-off — engineering closed (`dc39f74`) | CEO | Concurrent recovery or a false settlement leaves billing, a refund, visit, or promised notice unfinished | **12% — Very low (sign-offs)** |
| P0 | GL-07 | Copy sign-off; atomic capacity rides GL-04 — engineering closed (`5b2fb76`) | Head of Operations | A visit reports complete while a charge, refund, staffing, notice, or concurrent change remains wrong | **12% — Very low (sign-offs + GL-04 tie)** |
| P0 | GL-18 | Override-authority + queue-ops sign-off — engineering closed (`f6a34a8`) | Head of Operations + Finance lead | A case closes while money or customer work remains, or routine work waits for an OWNER | **15% — Very low (sign-offs; GL-04/GL-23 ties)** |
| P0 | GL-04 | Travel-model calibration + data entry — engineering closed (`dc39f74`) | Head of Operations | Two customers buy the last slot; a day is sold with no one to work it | **15% — Very low (ops data + calibration)** |
| P0 | GL-06 | Copy + recovery-workflow sign-offs — engineering closed (`1228822`) | CEO + Finance lead | A processing customer is promised a nonexistent hold, or an async success oversells the day | **12% — Very low (sign-offs)** |
| P0 | GL-16 | Operating-value ratification — engineering closed (`41020a6`) | CEO + Finance lead | A bad prompt/model output silently changes live prices without rapid detection or recovery | **12% — Very low (sign-offs)** |
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

**Engineering:** closed (`3717092`). Only the items below remain; they are business decisions, sign-offs, production wiring, or operating data — not software this repository can finish alone.

**Remaining requirements:**

- Production has two named owners with MFA and separate recovery access. The last-owner guard and
  owner-change serialization are enforced in code; creating and verifying the second production owner
  login (with MFA and recovery codes) is an operating action for the CEO.

**Pass owner:** CEO, with Operations and Sales verifying reassigned work.

### GL-13 — Finish technician session, route, and historical-data boundaries

**Business outcome:** A technician sees only the minimum data for legitimate current or
business-approved historical work, and access disappears when assignment or employment ends.

**Engineering:** closed (`27ca1fb`). Only the items below remain; they are business decisions, sign-offs, production wiring, or operating data — not software this repository can finish alone.

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

**Engineering:** closed (`bbcf0c3`). Only the items below remain; they are business decisions, sign-offs, production wiring, or operating data — not software this repository can finish alone.

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

**Engineering:** closed (`dc39f74`). Only the items below remain; they are business decisions, sign-offs, production wiring, or operating data — not software this repository can finish alone.

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

**Engineering:** closed (`5c8c6ef`). Only the items below remain; they are business decisions, sign-offs, production wiring, or operating data — not software this repository can finish alone.

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

**Engineering:** closed (`cc76773`). Only the items below remain; they are business decisions, sign-offs, production wiring, or operating data — not software this repository can finish alone.

**Remaining requirements:**

- CEO sign-off on the new at-payment customer copy ("Payment received — finalizing", the recovery
  wording) before merge to main — it changes what is promised at the moment of payment.
- Finance/Operations define who may record an "approved alternate delivery" for a bounced
  confirmation and what counts (the mechanism is live).
- Finance confirms the reconciliation window (45 days) vs expected production volume; the truncation
  alarm covers the gap either way.

**Pass owner:** CEO and Engineering lead jointly; Finance owns reconciliation and recovery approval.

### GL-09 — Failure-safe customer lifecycle transitions

**Business outcome:** Customer status, billing, access, scheduled work, and customer communication never
disagree, and an employee always sees the real outcome of deactivation or reactivation.

**Engineering:** closed (`dc39f74`). Only the items below remain; they are business decisions, sign-offs, production wiring, or operating data — not software this repository can finish alone.

**Remaining requirements:**

- Leadership signs off the versioned per-reason transition policy now live as engineering defaults
  (`LIFECYCLE_POLICY_VERSION 2026-07-19.1`): for each deactivation reason (customer request,
  nonpayment, moved, property sold, service ended, duplicate, other) and reactivation reason, the
  balance handling (collect / report-only / write-off review), document retention on a duplicate, and
  the customer-notice wording (a duplicate record sends no notice by design). Every action records the
  policy version it ran under; sign-off ratifies or amends the recorded values.
- Leadership's page/search/**export** of the complete lifecycle history lands with the GL-19
  reconciliation and command view (the history itself is durable, paged, and read-failure-honest
  today; only the export surface is outstanding).

**Pass owner:** Head of Operations; Finance and CEO approve protected fields, transition policy, and
recovery policy.

### GL-08 — Exact, terminal customer plan cancellation

**Business outcome:** A customer's online cancellation is a durable instruction, and every customer
message matches the actual billing, plan, schedule, and delivery state.

**Engineering:** closed (`dc39f74`). Only the items below remain; they are business decisions, sign-offs, production wiring, or operating data — not software this repository can finish alone.

**Remaining requirements:**

- CEO/Finance/Operations sign off the changed customer-facing copy and workflow now live: the per-visit
  72-hour outcomes in the preview, confirmation email, and success message (this replaces the previous
  "keep it or refund it, your choice" promise for paid visits), and the prescribed-full-refund Finance
  case flow (Finance issues the exact refund; no discretionary disposition).
- Leadership's cancellation history/reconciliation view rides GL-19; the persisted command rows,
  owned cases, and per-plan email log are the durable inputs it reads.
- The `PAID_VISIT_CANCELLATION` manual close reason "Account credit applied" must be removed with
  GL-18's close-reason pass (no credit ledger exists; the disposition contradicts the locked rule).

**Pass owner:** CEO, with Finance and Operations sign-off.

### GL-07 — Terminal office cancel/reschedule

**Business outcome:** An employee cannot cancel or move a paid visit without completing the money,
capacity, route, audit, and customer-notification consequences in one guided action.

**Engineering:** closed (`5b2fb76`). Only the items below remain; they are business decisions, sign-offs, production wiring, or operating data — not software this repository can finish alone.

**Remaining requirements:**

- Head of Operations / CEO sign off the changed customer-facing wording now live: the hour-exact
  72-hour refusal copy (no owner override), and the pending-assignment reschedule notice ("we'll
  confirm your appointment once your technician is assigned" instead of a confirmed date when no
  technician is chosen).
- The single ATOMIC capacity claim for assigned reschedules lands with GL-04 (today the route's stop
  count is re-validated but two simultaneous moves could still pass one count read); the full
  dispatch-facts/licence gate already runs on the new date.

**Pass owner:** Head of Operations; Finance approves money dispositions.

### GL-18 — Truthful, usable exception resolution

**Business outcome:** A case turns green only after the exact customer, money, access, or operating
obligation is true, while a routine employee can complete ordinary recovery work without CEO-level
authority or an invented workaround.

**Engineering:** closed (`f6a34a8`). Only the items below remain; they are business decisions, sign-offs, production wiring, or operating data — not software this repository can finish alone.

**Remaining requirements:**

- CEO approves the per-class override-authority map (today: manual overrides are OWNER-only
  everywhere; money-verified closes are Finance/Owner). If leadership wants specific classes delegated
  below OWNER, name them — the enforcement point is one table.
- Finance ratifies its money-close authority boundary (which was CEO+Finance approval per the locked
  rule); Operations ratifies the release/reassign flow as the queue norm.
- PTO/holiday/closure calendars join the staffing verifier when GL-04's capacity model lands; the
  staffed Office queue, business-day calendar, and shift handoffs are established in GL-23.

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

### GL-06 — Finish honest, race-safe processing and failed payments

**Business outcome:** The customer and office always see the same payment, capacity, and booking state;
an async payment cannot create a double payment, a nonexistent hold, an oversold visit, or an obligation
that waits forever.

**Engineering:** closed (`1228822`). A pending bank debit creates the full scheduled commitment
immediately with every surface saying **Payment pending**; all payment/booking transitions are one
conditional state machine; pre/post-service failure, late success, cancel, and reconcile paths are
exactly-once; returning customers always retrieve the durable state; Operations has the payments-in-flight
view. Only the items below remain; they are sign-offs — not software this repository can finish alone.

**Remaining requirements:**

- CEO/Finance/Operations sign off the changed customer-facing copy and workflow now live: the
  "visit scheduled — payment processing, don't pay again" confirmation, the pre-service
  "visit canceled, no money collected, rebook" and post-service "outstanding balance" failure notices,
  the pending-cancel refund wording (refund completes after the debit settles), and the Finance-owned
  balance-collection flow (case closes only on a verified money settle). The leadership
  aging/reconciliation view is completed in GL-19, production webhook setup in GL-21, and durable
  notification handling in GL-03.

**Pass owner:** CEO and Finance lead jointly; Head of Operations approves the recovery workflow.

### GL-16 — Prompt-governed AI pricing with rollback

**Business outcome:** The approved pricing prompt can publish researched prices without clamps or
preapproval, while leadership can see what changed and safely recover from a bad model/prompt result.

**Engineering:** closed (`41020a6`, cost-incident controls `d990d07`). Every AI row records the versioned
prompt (label + content hash), model, inputs, raw result, sources, and run identity; rows are immutable
versions (office edits create a new pinned row with a controlled reason, never editing AI history); the
day's live changes enter the shared queue as a recorded one-business-day review; an OWNER-only audited
rollback flips the whole catalog to a prior coherent moment in one write (pinned rows still win) and back;
invalid execution fails closed into owned exhaustion work; budget, backoff, digest, and the Market Rates
engine/rollback panels are live. Only the item below remains.

**Remaining requirements:**

- CEO/Finance ratify the recorded operating values now live: the daily change-review cadence (one
  claimable review item per day of changes), the controlled office-edit and rollback reason vocabularies,
  OWNER as the sole rollback authority, and the accepted no-clamp/no-preapproval posture the mechanism
  encodes.

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
