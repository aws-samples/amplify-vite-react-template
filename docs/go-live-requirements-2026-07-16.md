# BuzzKill — remaining go-live requirements

**Business review date:** 18 July 2026

**Latest implementation review:** 3 commits after `9276394`, from `812196f` through `18138bc`

**Decision:** **NO-GO until every gate in this document is closed**

**Review seats:** CEO, leadership, operations, customer, technician

This is a **delta-only** document. It excludes capabilities and acceptance items already achieved in
the reviewed build. The gate changed by the new implementation commit—GL-14—has been reduced to its
remaining failure, control, and business-approval requirements. The other gates remain because the
reviewed commits did not close them. An omitted item is not a request to rebuild it.

The “McDonald's standard” applies: a week-one employee must be able to do the right thing
without remembering policy, performing mental math, interpreting system internals, or inventing
free-text workarounds. The system must prevent an unsafe or financially incorrect action, explain
the one next step in plain language, and put failures in an owned queue.

## Go-live rule

Go-live requires all of the following:

1. Every requirement below is marked **Passed** by its named business owner.
2. There are no open launch-severity defects and no open operational exceptions.
3. Any offer, promise, role, or workflow that will not be supported at launch is removed from the
   site and app before approval. “Staff will remember not to use it” is not an acceptable control.

## Priority model

- **P0 — Critical:** Close first. Failure can create unauthorized access or charges, invalid
  regulated records, unsafe/unlicensed work, direct financial loss, or a customer commitment the
  business cannot honor.
- **P1 — High:** Close after P0. Failure creates predictable revenue leakage, service breakdown,
  repeat work, or customer escalation.
- **P2 — Operating readiness:** Close after the product gates. These ensure that real data, people,
  procedures, and first-week users can operate the release safely.

Within each tier, gates are ordered from highest expected business impact to lowest. Priority changes
implementation order, not launch status: **P0, P1, and P2 are all go-live blockers.**

## Gate register

| Priority | ID | Remaining gate | Accountable business owner | Impact if missed |
|---|---|---|---|---|
| P0 | GL-14 | Finish fail-safe staff access changes and offboarding | CEO | Demoted or departed staff retain live access, or access changes go unowned and unaudited |
| P0 | GL-13 | Finish technician session, route, and historical-data boundaries | CEO | Technician data survives reassignment, offboarding, or an inconsistent route |
| P0 | GL-15 | Finish regulated-report durability and compliance sign-off | Compliance owner | Invalid, duplicate, or falsely delivered legal record reaches a customer |
| P0 | GL-17 | Seasonal plan and licensed-scope decisions | CEO + Compliance owner | Work is billed out of season or performed outside legal authority |
| P0 | GL-12 | Finish service-specific dispatch readiness | Head of Operations | Unsafe or unperformable visit is dispatched |
| P0 | GL-05 | Complete paid-booking delivery and reconciliation controls | CEO + Engineering lead | Money, commitment, or confirmation can disagree or duplicate |
| P0 | GL-09 | Make customer lifecycle transitions atomic and auditable | Head of Operations | Billing, access, service, and status disagree |
| P0 | GL-08 | Finish failure-safe customer plan cancellation | CEO | Customer believes billing stopped when it may continue |
| P0 | GL-04 | Capacity that cannot be oversold | Head of Operations | Sell work the company cannot staff or legally perform |
| P0 | GL-06 | Honest handling of processing and failed payments | Finance lead | Customer promise is made before money is settled |
| P0 | GL-07 | One safe office cancel/reschedule workflow | Head of Operations | Refund, route, plan, or customer notice is wrong |
| P0 | GL-16 | Governed pricing and margin protection | CEO + Finance lead | AI or employee publishes loss-making or nonsensical prices |
| P0 | GL-01 | One truthful, complete service catalog | CEO | Unsupported service is sold and downstream rules have no owner |
| P0 | GL-20 | Public promises and legal terms match operations | CEO | Contract, regulatory, and brand exposure |
| P0 | GL-21 | Production accounts and integration readiness | Engineering lead + Finance lead | Staging assumptions or secrets fail with real customers or money |
| P0 | GL-22 | Monitoring, recovery, retention, and incident ownership | CEO + Engineering lead | Critical failure stays silent or records cannot be restored |
| P1 | GL-18 | Verifiable exception resolution | Head of Operations | Dashboard turns green while the customer problem remains |
| P1 | GL-19 | Launch reconciliation and command view | CEO + Finance lead | Leadership cannot detect revenue, work, or customer mismatches |
| P1 | GL-10 | Guarantee, callback, and no-access lifecycle | Head of Operations | Public promise becomes uncontrolled free work or a dispute |
| P1 | GL-02 | A lead lifecycle in which no lead can disappear | Head of Sales | Revenue leaks through unowned or stale leads |
| P1 | GL-03 | Honest fallback contact and communication outcomes | Head of Sales | Customer waits on a contact that did not happen |
| P1 | GL-11 | Minimum complete customer/group portal | Head of Operations | Property/customer requests and records fall back to calls |
| P2 | GL-23 | Production master data and launch-day operating model | Head of Operations | Correct software runs with wrong facts or no queue owner |
| P2 | GL-24 | Low-skill, failure-resistant workflows | Head of Operations | Launch still depends on tribal knowledge |

---

## Priority 0 — Critical money, security, compliance, safety, and customer commitments

### GL-14 — Finish fail-safe staff access changes and offboarding

**Business outcome:** A role change or departure cannot leave a person with unintended access, and
leadership can prove who changed access, why, and what work was reassigned.

**Why this is still a gate:** Removing a staff role changes provider-group membership but does not end
the person's existing sessions, so an old token can retain the removed role until it expires. Role
changes also add and remove groups sequentially without a durable request or recovery case; a failure
mid-change can leave an unintended combined role set with no audit row. Offboarding removes groups
before disabling and signing out the login, so a failure during early group removal can leave the
person enabled, and the final enabled/group/session state is not read back before success. Technician
job and profile writes are not checked for a persisted result, allowing a partial reassignment or
failed deactivation to be reported as complete. The staff-access ledger and partial-offboarding case
are best-effort writes whose result is ignored, the reason is optional free text, and there is no
business screen to prove the history. Concurrent role/offboarding actions can race, including two
owners each passing the last-owner check and removing both recovery paths.

**Remaining requirements:**

- Every role reduction and offboarding starts from a verified durable request containing the actor,
  target, prior and requested roles, required approved reason, timestamp, and idempotency/version key.
  The low-skill workflow uses controlled reasons plus optional notes; blank or unexplained access
  changes are refused.
- Removing privilege invalidates existing sessions as well as changing group membership. An old token
  and a newly issued token are both refused immediately after a demotion or offboarding; the operator
  is not told access ended until the provider's enabled state and effective groups are read back.
- Access removal is sequenced fail-safe: disable/sign-out occurs before nonessential group cleanup and
  technician/work changes. A timeout, provider error, or hard termination at any step leaves a durable
  owned security case and one idempotent resume action rather than an enabled or ambiguously privileged
  person.
- Role changes are concurrency-controlled and converge without a temporary or persistent unintended
  privilege set. Concurrent role changes, demotion/offboarding, and two-owner removal cannot both pass
  stale checks; at least one verified usable owner/recovery path must remain.
- Every future-job, route, and technician update is checked and read back. **Complete** requires the
  expected number of jobs unassigned, the technician inactive, no job still assigned on an abandoned
  route, and each in-progress visit placed in owned Operations review with an explicit disposition.
- The audit event and any partial-result case are required durable outcomes, not best-effort logging.
  Failed writes remain recoverable until appended, and the final event records actual provider state,
  work effects, actor, reason, timestamps, and outcome. Leadership can search and export the immutable
  history from an authorized business screen without engineering assistance.
- Production has at least two named usable owners with MFA and separate recovery access. The
  break-glass procedure lets either owner recover access and offboard the other without engineering
  or a shared login.

**Pass owner:** CEO, with Operations verifying reassigned work.

### GL-13 — Finish technician session, route, and historical-data boundaries

**Business outcome:** A technician can see only the minimum data for legitimate current or
business-approved historical work, and access disappears when assignment or employment ends.

**Why this is still a gate:** The technician-day response trusts route membership and returns every
job carrying that route ID without independently confirming that each job is currently assigned to
the signed-in technician. A partial or inconsistent reassignment can therefore expose another
technician's job and customer. Read and document checks also do not require an active technician
record, so a disabled employee using an unexpired session can still reach assigned work and any
customer documents unlocked by a historical job. Locally stored report drafts/customer context are
not invalidated on reassignment or deactivation. Historical access has no approved time/scope bound,
and office/owner field overrides and reassignment still lack reasoned audit.

**Remaining requirements:**

- Every technician-day job is independently checked against the signed-in technician's current
  assignment; route ID alone is never authority. A route/job technician mismatch is withheld and
  becomes owned Operations work rather than leaking the row.
- Technician job, day, report, photo, and document access verify that the linked technician is still
  active. The business explicitly approves whether a currently employed technician with an expired
  applicator credential may review prior work; an offboarded/inactive person receives no field data
  or document links even with an unexpired session.
- Operations and Compliance approve a historical-access matrix defining which completed jobs,
  reports, photos, and customer facts remain visible, to whom, and for how long. Any prior job cannot
  grant indefinite access to every future document for that customer.
- Reassignment/deactivation immediately refuses server reads and actions and removes or renders
  unreadable cached customer/job/report data and local drafts on the next app interaction. The
  workflow records the approved disposition of a former technician's unsent draft.
- Reassignment records actor, controlled reason, former/new technician, effective time, route
  effects, affected in-progress work, stale-draft disposition, and final access result.
- Office/owner emergency field access requires an approved purpose and reason, records actor and
  affected job/report, is reviewed, and cannot silently impersonate the assigned applicator.

**Pass owner:** CEO, with Compliance and Operations verification.

### GL-15 — Finish regulated-report durability and compliance sign-off

**Business outcome:** Every issued service report and correction is an accurate, durable,
correctly authored legal record with a truthful, non-duplicating customer-delivery state.

**Why this is still a gate:** Report-finalization, job-completion, delivery-status, and amendment
metadata writes are awaited but their persisted results are not verified before in-memory state or
success is reported. Concurrent requests can therefore both continue from the same draft. Report and
amendment emails are sent before the durable sent marker is stored; a hard stop or failed marker write
after provider acceptance causes an untracked duplicate on retry. **Delivered** currently means the
email provider accepted the message, not that delivery survived a later bounce or suppression. The
label check compares one free-text rate to one catalog string but does not yet enforce the approved
quantity, concentration range, target site/pest, or re-entry rule. A failed location-review write
falls back to another best-effort email and can still disappear. Required Compliance policy and
threshold decisions are also outstanding.

**Remaining requirements:**

- The launch catalog encodes every allowed product/service/site/pest combination, quantity or
  concentration range, rate/dilution, and re-entry rule from the approved label. Finalization fails
  closed when any recorded application fact is outside that rule; matching one product name and one
  default-rate string is insufficient.
- Finalization uses a conditional claim/version and verifies the persisted report and job results
  before continuing or reporting success. Concurrent, duplicate, and resumed requests converge on
  one report, one completion, one billing/next-visit outcome, and one delivery attempt.
- No customer message says the service/report is complete until the durable report and job state
  support it. Report and amendment delivery use a provider-supported idempotency key or equivalent
  outbox protocol that covers **accepted but marker not stored**; every marker/status write is
  verified.
- Delivery distinguishes **Pending/provider accepted**, **Delivered**, **Bounced/suppressed**,
  **Failed**, **No email**, and approved alternate delivery with proof. Provider delivery events
  update the report/amendment and owned case; provider acceptance alone cannot display “sent to
  customer.”
- Amendment creation, PDF storage, metadata, issuer identity, and delivery are one resumable,
  checked issuance. Retry cannot duplicate the row, overwrite an already issued correction with
  changed facts, or send a second customer email after an ambiguous provider result.
- Every required on-site presence review is durably queued. If the primary queue is unavailable, a
  persistent recovery record—not only another best-effort email—survives until Operations verifies
  or resolves the review. The technician remains unblocked under the CEO's field rule.
- Operations can retrieve the original, every amendment, delivery evidence, photos, no-access
  evidence, and location-review history through authorized screens without engineering assistance.
- Compliance approves the capture-window grace, location thresholds, label rules, evidence, SLA,
  resolution policy, and issued original/amendment format for every launch service type.

**Pass owner:** Named Compliance owner; Operations signs delivery and retrieval.

### GL-17 — Seasonal plan and licensed-scope decisions

**Business outcome:** Seasonal and specialized services bill and schedule exactly as customers were
told, and are performed only under valid business and technician authority.

**Why this is still a gate:** The business has not encoded a final mosquito/seasonal billing and
renewal policy, while some specialized/RI service claims require explicit scope and credential
validation.

**Remaining requirements:**

- The CEO approves for each seasonal plan: service months, number/frequency of visits, annual vs
  in-season billing, first-year proration, renewal date/notice, off-season customer status, pause/
  cancel/refund handling, and missed-visit treatment.
- The system stops billing and scheduling where the approved policy says it should; it cannot leave
  an in-season cadence or monthly charge running indefinitely by omission.
- Compliance maps each launch service and state/territory to the required company registration,
  supervisor/applicator credential, expiry, and prohibited scope. Wildlife trapping/removal,
  exclusion, termite, pesticide, and restoration scopes are not treated as interchangeable.
- Expiring/expired company or technician credentials remove affected capacity before an appointment
  is sold and create an advance owner alert with enough time to renew/reassign.
- Customer quote, accepted terms, schedule, invoice, and job packet all use the approved seasonal
  and licensed scope across renewal, cancellation, expired credentials, season boundaries, and
  unsupported service/state combinations.

**Pass owner:** CEO and Compliance owner jointly.

### GL-12 — Finish service-specific dispatch readiness

**Business outcome:** A technician is dispatched only with the service-specific facts and approved
scope needed to complete the visit safely, and can exit an unperformable visit without inventing a
workaround.

**Why this is still a gate after commit `940a4b9`:** Readiness is still based on free-text service
data; the address is not proven valid/in service area; products, constraints, and prior treatment
findings are absent; and scope mismatch or missing prep has no dedicated field outcome. Packet
changes after assignment/start also have no technician acknowledgement or versioned safety trail.

**Remaining requirements:**

- Before assignment, the approved GL-01 catalog enforces the selected service's valid in-area
  address, duration, scope, required prep/confirmation, required instructions, credential, and
  approved product/constraint minimums. Nonblank placeholders do not count as a valid address or
  complete packet.
- The field packet includes the service's approved product/scope constraints and relevant prior
  treatment findings/callback lineage—not only the status of earlier visits.
- **Scope does not match** and **required prep missing** are dedicated one-tap field outcomes. They
  do not falsely start/complete service, create an owned operations case, preserve capacity/money
  facts, and send the approved customer next step.
- Any safety/access/scope/prep change after assignment is versioned and brought to the assigned
  technician's attention. After service starts, material changes require an audited manager action
  and technician acknowledgement.

**Pass owner:** Head of Operations, with Compliance sign-off.

### GL-05 — Complete paid-booking delivery and reconciliation controls

**Business outcome:** Every succeeded booking payment is either one complete, correctly communicated
customer commitment or one visible, verified refund/recovery case—even when execution stops between
steps.

**Why this is still a gate:** A message can be accepted by the email provider and execution can stop
before the sent marker is durably stored, causing an untracked duplicate on retry. A marker write can
also fail without changing the reported outcome. Reconciliation does not reliably prove that every
paid booking has a succeeded Stripe payment or that every child record belongs to the same customer,
service, amount, and booking. A capped or partial provider scan can finish without an owned
incomplete-run result, and staff can manually close a paid exception with a note while money and
records still disagree.

**Remaining requirements:**

- Customer confirmation and the internal booking alert use a provider-supported idempotency key or
  equivalent durable outbox state that covers the ambiguous **sent but not marked** window. Retry
  cannot create an untracked duplicate, and a failed marker write is visible owned work rather than
  success.
- A confirmation is shown as delivered only from durable provider evidence. Missing email, bounce,
  suppression, provider timeout, and alternate delivery each have a truthful status, owner, deadline,
  and retry/proof path.
- Reconciliation proves both directions for the full approved accounting window: every succeeded
  Stripe booking payment has exactly one complete commitment, and every paid **Booked** commitment
  has exactly one succeeded Stripe payment and one paid invoice for the exact amount.
- Reconciliation validates relationships, not merely record existence: customer, job, plan when
  applicable, agreement, invoice, service, date, and amount all belong to the same booking. A
  dangling or cross-linked record is an exception.
- A truncated page scan, expired lookback, provider read error, table read error, or timed-out run
  cannot report green or auto-resolve cases. It creates an owned Finance/Engineering failure and the
  prior unresolved state remains visible.
- **Paid—not finalized** and reconciliation cases close only after the system verifies a complete
  commitment or a settled refund plus customer notice. Routine staff cannot close an unmatched-money
  case by typing a note.

**Pass owner:** CEO and Engineering lead jointly; Finance owns reconciliation and recovery approval.

### GL-09 — Make customer lifecycle transitions atomic and auditable

**Business outcome:** Customer status, billing, access, scheduled work, and customer communication
never disagree, and an employee always sees the real outcome of deactivation or reactivation.

**Why this is still a gate:** Deactivation requires separate money/work and portal-access actions
from the employee screen. Canceling several plans can partially succeed and leave a mixed customer
state. Final status writes and audit writes are not all verified; reactivation can restore access and
then report **Active** even if the status write did not persist. Opposing concurrent actions have no
durable transition claim, reasons are not required, and the history is not available as a complete
business view.

**Remaining requirements:**

- **Deactivate customer** is one named business action that durably records the customer's
  instruction, then coordinates plan billing, queued and paid visits, open balances, portal access,
  customer notice, and final status. The employee never has to remember a second action.
- **Reactivate customer** is one named action that restores only the approved access/service state.
  Canceled subscriptions stay canceled unless a separate, explicitly accepted sale creates a new
  plan.
- Each transition has durable step state and a safe resume action. If one of several provider or CRM
  steps succeeds and a later step fails, the screen names exactly what changed, what remains live,
  who owns it, and whether the customer may still be charged or served. It never returns a false
  **Inactive** or **Active** result.
- Every status, access, plan, job, and audit write is checked before success is returned. A failed
  audit write creates blocking owned recovery; leadership history cannot silently lose a transition.
- Conditional transition/version control prevents interleaved deactivate/reactivate requests from
  producing mixed state. Duplicate requests return the same transition and outcome.
- Every transition requires a controlled reason and records actor, time, prior/new state, provider
  results, affected plans/jobs/balance/access, communication outcome, exceptions, and final
  disposition in a leadership-visible history.

**Pass owner:** Head of Operations; Finance and CEO approve protected fields, transition policy, and
the recovery policy.

### GL-08 — Finish failure-safe customer plan cancellation

**Business outcome:** A customer's online cancellation is a durable instruction, and every
customer message matches the actual billing, plan, schedule, and delivery state.

**Why this is still a gate after commit `0dd973d`:** Remaining failure paths can overstate the
outcome: the pending screen promises no further charge while the Stripe subscription is still
active; an unsuccessful CRM plan or queued-job write can be followed by “canceled/visits stopped”;
and the response says a confirmation was emailed even when delivery failed or no email exists.

**Remaining requirements:**

- A cancellation request is durably recorded before or with the provider attempt. Failure to write
  the pending request, owner case, or retry state cannot reduce the customer's instruction to a log
  line.
- A **Canceled** result appears only after the provider subscription is confirmed stopped and the
  CRM plan transition is confirmed written. A provider success followed by a CRM write failure
  resumes the same cancellation; it never reports the plan as active billing or creates a second
  action.
- While the provider subscription remains active, the portal does not promise “you won't be charged
  again” unless the business has an enforceable automatic stop/refund guarantee. It states the
  truthful pending status, resolution time, and what happens if a charge posts.
- The screen and confirmation say recurring visits stopped only when all cancelable queued visits
  were actually removed. Any failed schedule write creates durable owned work and a truthful
  outstanding-visit disposition; an office email alone is not the system of record.
- “Confirmation emailed” appears only when delivery succeeded. Missing/failed email produces an
  on-screen confirmation plus an owned alternate-delivery task without weakening the cancellation.
- Duplicate or concurrent clicks return the same request/outcome. Customer-visible pending state
  clears only after the real provider, CRM, schedule, and notice outcomes are recorded.

**Pass owner:** CEO, with Finance and Operations sign-off.

### GL-04 — Capacity that cannot be oversold

**Business outcome:** Any day/window shown to a customer can actually be staffed, and two customers
cannot buy the same last unit of capacity.

**Why this is still a gate:** Public availability is based on a coarse active-technician/day count,
offers capacity even with no active technician, and only rechecks availability before payment. It
does not reserve the slot while payment completes.

**Remaining requirements:**

- Sellable capacity uses the technician's actual working day, approved leave/blackouts, credential
  validity on the service date, service duration, service territory, travel allowance, and time
  window. Zero eligible technicians means zero sellable dates.
- Capacity rules are the same in the public funnel and the dispatch board. A day/window cannot be
  “available” to the customer and over capacity to Operations.
- Selecting checkout places a short, visible capacity hold. A successful payment consumes it;
  abandonment, failure, and expiry release it. The CEO approves the hold duration.
- Concurrent purchases for the last slot result in exactly one booking; the other customer receives
  a truthful alternate-date or refund outcome without manual database repair.
- Operations can block a day, technician, territory, or window and can see why a date is or is not
  sellable. Removing capacity immediately protects all unconsumed public slots.
- The system prevents staffing a service outside the assigned technician's active license/scope,
  even if the slot was quoted earlier.

**Pass owner:** Head of Operations.

### GL-06 — Honest handling of processing and failed payments

**Business outcome:** A customer is never told they are booked or paid while the payment can still
fail, and Operations never dispatches an unconfirmed payment as if it were settled.

**Why this is still a gate:** A payment in `processing` can currently produce “You're booked” and
“paid today” language even though final booking creation waits for a later success event.

**Remaining requirements:**

- The CEO chooses which payment methods are allowed to finalize instantly and which require a
  **Payment processing—slot held, not yet booked** state.
- Processing copy states what is reserved, what is not yet confirmed, when the customer will hear,
  and what happens if payment fails. It never uses “paid” or “booked” prematurely.
- Success finalizes the held booking once. Failure/timeout releases capacity, informs the customer,
  and records the lead/customer outcome without creating a service commitment.
- Operations can distinguish **processing**, **paid/finalizing**, **booked**, and **failed** without
  interpreting Stripe terminology.

**Pass owner:** Finance lead.

### GL-07 — One safe office cancel/reschedule workflow

**Business outcome:** An employee cannot cancel or move a paid visit without completing the money,
plan, capacity, route, and customer-notification consequences in one guided action.

**Why this is still a gate (narrowed by commit `0709bc5`):** The engineering half is now closed. The
office no longer changes a visit's schedule state with a bare confirm. A read-only preview
(`previewVisitChange`) shows every consequence before the employee commits — customer and visit, amount
paid and open, the policy deadline and the calculated refund/credit/fee, the plan consequence (canceling
a visit never cancels the plan), the route consequence, and the exact notice — and the employee picks a
plain decision (Cancel and refund, Cancel and retain credit, Manager exception, or Reschedule); the
server computes every amount from one shared policy (`cancellationPolicy`, the same free-cancel window
the booking funnel enforces), so staff never type one. `cancelVisit` performs all consequences as one
fail-safe action — refund or retained credit, void an open invoice safely, take the visit off its route,
notify the customer — and on any partial failure opens an owned exception and returns PARTIAL rather than
claiming completion; a refund that cannot be issued leaves the visit uncanceled. `rescheduleVisit`
revalidates the technician's license for the new date and the route's ownership and capacity, moves the
route, and emails the customer the old and new details. Every action records an immutable
`VisitChangeEvent` (initiator, reason, policy, amount, disposition, communication result, outcome), and
a manager exception is owner-only. Covered by 22 handler/policy tests (paid/unpaid, one-time/recurring,
inside/outside policy, assigned/unassigned, refund failure, notice failure, two employees on one visit).
**What remains the gate — operational proof only:** a retained account credit is recorded and handed to
finance as owned work rather than auto-applied to a future invoice, so its redemption needs the finance
operating step; and, like every money gate, the live end-to-end rehearsal (a real cancel + Stripe refund
against the production account, GL-21) must be witnessed before sign-off.

**Remaining requirements:**

- Before confirmation, the employee sees customer, visit, amount paid/open, policy deadline,
  calculated refund/credit/fee, plan consequence, route consequence, and exact notice to be sent.
- The allowed choices are plain business decisions such as **Reschedule**, **Cancel and refund**,
  **Cancel and retain approved credit**, or **Manager exception**. Staff never calculate an amount.
- One confirmation performs all approved consequences. If any consequence fails, the screen does
  not claim completion and the case stays in an owned exception with a safe resume action.
- Rescheduling revalidates capacity and technician license, moves the capacity claim, updates the
  route, and notifies the customer with old and new details.
- Cancellation records initiator, reason, policy used, amount and disposition, timestamps, and the
  customer communication result. Recurring-plan cancellation is never implied by canceling one
  visit unless the employee explicitly chooses it.

**Pass owner:** Head of Operations; Finance approves money dispositions.

### GL-16 — Governed pricing and margin protection

**Business outcome:** Neither AI nor a low-skill employee can publish a loss-making, nonsensical,
or unapproved price.

**Why this is still a gate:** Live market-rate changes have no complete hard bounds/approval trail,
and cost floors do not cover every sellable service, recurring cadence, add-on, and property type.

**Remaining requirements:**

- Finance approves fully loaded cost and minimum gross-margin rules for every launch catalog item,
  including labor time, drive time, material, lead cost, payment fee, callback allowance, overhead,
  seasonality, property size, recurring cadence, and add-ons.
- Hard minimums, maximums, sensible size/quantity progression, and input-validity rules apply before
  any price reaches a customer. Missing/invalid inputs fall to review; they never guess or sell.
- AI/researched rate changes cannot become live merely because they were generated. The CEO sets
  approval thresholds; material changes require owner/finance approval and a preview of affected
  quotes, margin, and current-vs-proposed prices.
- Every live rate change records actor/source, reason, evidence date, prior/new value, approval, and
  effective time; an owner can roll back safely.
- Routine office users cannot edit live rates or protected plan prices. Emergency overrides are
  owner-only, time-limited, reasoned, and reported.

**Pass owner:** CEO and Finance lead jointly.

### GL-01 — One truthful, complete service catalog

**Business outcome:** A customer can never be promised a service the operating system cannot
price, staff, perform, document, and support profitably.

**Why this is still a gate:** The public site advertises more services than the quote funnel can
select, while the funnel says every service gets an exact price. Several distinct services collapse
into broad pricing categories with no approved duration, license scope, or service template.

**Remaining requirements:**

- The CEO approves one launch catalog that maps every marketed service to all of: supported
  property types, service area, intake questions, price method, minimum margin, expected duration,
  required technician credential, job instructions, allowed products, report requirements,
  cancellation rule, and guarantee/return-service rule.
- Every public call-to-action has one valid result: a genuinely bookable service, or an honest
  specialist-review path. It may not send a customer to an option that does not exist.
- Services not approved for self-serve quoting are clearly labeled for review before the customer
  supplies payment. “Exact price” and “no callback” language appears only where it is true.
- Termite, wildlife, exclusion, attic/restoration, mosquito/tick, community, commercial, and other
  specialized offers are individually approved or removed from launch. They may not inherit a
  generic service merely because no matching category exists.
- The same catalog drives marketing, quoting, scheduling duration, technician instructions,
  reporting, plans, callbacks, refunds, and leadership reporting. A service cannot mean something
  different in each screen.

**Pass owner:** CEO, with written sign-off from Operations, Finance, and Compliance.

### GL-20 — Public promises and legal terms match operations

**Business outcome:** Marketing, quote, checkout, agreement, portal, and field execution describe
the same offer and no unsupported claim creates customer, regulatory, or brand exposure.

**Why this is still a gate:** The site contains blanket exact-price/no-wait/guarantee claims,
resident-scheduling and license/status claims that are not fully supported by the product or
documented evidence, and service-page metadata/copy mismatches.

**Remaining requirements:**

- A named business owner inventories every claim about price certainty, speed, guarantee/free
  returns, cancellation, license/insurance/status, response time, resident scheduling, safety,
  ratings/rank, and performance statistics. Each has evidence, scope, source, owner, and review/
  expiry date—or is removed.
- “Every service,” “exact price,” “no callbacks,” and “no waiting” are limited to services and
  circumstances that pass GL-01 and GL-04. The review fallback is disclosed before payment.
- Guarantee, cancellation, no-access, refund/credit, recurring billing, seasonal renewal, and price
  adjustment language is identical in marketing, checkout terms, accepted agreement, portal, and
  employee workflows.
- License and insurance badges reflect verified current facts rather than hard-coded “active” copy.
  State-specific technician/company wording is approved by Compliance.
- Resident/community scheduling claims match the actual launch portal path under GL-11 or are
  removed.
- Service-page titles, descriptions, structured data, and body copy name the correct service and do
  not reuse unrelated pest claims. Unsourced rankings/statistics are removed or substantiated.
- Legal/insurance counsel approves the final public terms, privacy notice, guarantee, cancellation,
  recurring authorization, field-service record delivery, and effective/last-updated dates.
- Every public page links to and displays the approved quote, price, terms, phone/email, service
  area, and customer outcome it promises.

**Pass owner:** CEO; Compliance/legal sign the regulated and contractual statements.

### GL-21 — Production accounts and integration readiness

**Business outcome:** Production does not depend on a staging assumption, missing mailbox, stale
secret, or unconfigured provider event.

**Remaining requirements:**

- The previously exposed Buildium credential is rotated and revoked at the provider, access logs are
  reviewed, and current credentials exist only in the approved secret store. Removing it from source
  code alone does not pass.
- Production and staging use separate, approved Stripe keys, prices, webhook secrets/endpoints, and
  customer data. The production webhook subscribes to every event the application handles:
  `setup_intent.succeeded`, `payment_intent.succeeded`, `payment_intent.payment_failed`,
  `invoice.paid`, `invoice.payment_failed`, `customer.subscription.deleted`, `charge.refunded`,
  `charge.dispute.created`, and `charge.dispute.closed`.
- A monitored `sales@pestbuzzkill.com` mailbox and the operations/finance mailbox routes exist, are
  staffed to the approved SLA, and correctly handle sending, receipt, bounce, suppression, DKIM/SPF/
  DMARC, and after-hours escalation.
- Delivered customer communications use the approved production URLs, portal and quote/cancel links,
  sender identity, business phone, service area, maps/routes key, AI key, scheduler, and payment
  return URLs on supported phone and desktop devices.
- At least two named owners can access each critical provider account with MFA and recovery codes;
  no launch dependency is controlled by one personal account.

**Pass owner:** Engineering lead and Finance lead jointly.

### GL-22 — Monitoring, recovery, retention, and incident ownership

**Business outcome:** A background failure is noticed before the customer reports it, and business
records can be restored after human or provider error.

**Remaining requirements:**

- Alerts cover booking/quote/webhook errors and throttles, scheduled jobs that did not run, email
  failures, reconciliation mismatches, capacity anomalies, document generation/storage failure,
  and growing/overdue exception queues. Alerts reach a named primary and backup, not only logs.
- The CEO approves severity levels and response/communication targets for double charge, paid-no-
  job, unauthorized data exposure, unlicensed dispatch, outage, lost report, email outage, and
  provider outage. Each has a one-page first-response playbook.
- An idempotent replay/recovery procedure exists for failed webhooks, booking finalization,
  scheduled billing/visit creation, emails, documents, and portal provisioning. Routine recovery
  does not require hand-editing the database.
- Point-in-time database recovery and versioned/retained document backup are enabled for the
  approved legal/financial retention period. Deletion/retention policy covers customer requests
  without deleting records the business must retain.
- Recovery procedures restore the complete customer, job/plan/invoice relationship, accepted
  agreement, service report, photos, and audit history as usable records.
- Named incident owners can pause public booking, prevent new dispatch, stop/reconcile billing, post
  customer messaging, preserve evidence, and authorize restart.

**Pass owner:** CEO and Engineering lead jointly; Compliance approves retention.

---

## Priority 1 — High revenue and operating reliability

### GL-18 — Verifiable exception resolution

**Business outcome:** An operational failure stays visible until the promised real-world outcome is
true; employees cannot make the dashboard green by writing a note.

**Why this is still a gate:** Generic manual resolution can close cases whose refund, email,
rebooking, duplicate merge, access restoration, or other corrective action has not been verified.

**Remaining requirements:**

- Each exception type has a named team/owner, severity, response deadline, customer-impact label,
  and a small set of valid resolution actions.
- Where the app can verify the outcome, it closes only from the verified event: refund settled,
  message delivered/alternate contact recorded, job rebooked, payment finalized, portal access
  restored, or duplicate decision completed.
- Manual closure is limited to an owner/manager, requires a controlled reason plus evidence, and is
  separately reported. A free-text “done” from routine staff is insufficient.
- Reoccurrence reopens the same underlying issue or links the repeat; it cannot disappear because a
  prior case was closed.
- The queue supports clear handoff, claim, escalation, age, and overdue state. No required action is
  owned only by a shared mailbox or a person who has been offboarded.

**Pass owner:** Head of Operations.

### GL-19 — Launch reconciliation and command view

**Business outcome:** Leadership can tell each morning whether customers, work, and money agree,
without asking engineering to query production.

**Why this is still a gate:** Existing operational views do not provide one launch reconciliation
across the payment provider, bookings, plans, invoices/refunds, staffing, lead SLA, and required
service records.

**Remaining requirements:**

- A daily money reconciliation proves: successful provider payments equal CRM paid invoices;
  refunds/disputes equal CRM dispositions; net cash is explainable; and every mismatch is an owned
  case. Finance owns and signs the report.
- A daily booking reconciliation shows paid-not-finalized, complete booking without payment,
  duplicate customer/plan/job/payment, processing beyond SLA, and capacity/route mismatch.
- A daily plan reconciliation shows provider subscription vs CRM plan mismatches, active plans
  without next service, delinquent plans still scheduled, canceled plans still billing/scheduled,
  and recurring revenue at risk.
- A next-day operations view shows every job's staffing, credential, dispatch-readiness, customer
  notice, payment expectation, and exception state.
- A sales view shows leads by stage/owner/age, first-response SLA, overdue next action, source, and
  conversion/loss. A service-quality view shows completion, report delivery, no access, callbacks,
  repeat callbacks, and technician trends.
- The CEO defines the launch thresholds that force pause/rollback—for example any double charge,
  paid customer without a job, unauthorized access, unlicensed assignment, or unexplained money
  mismatch—and names who makes the decision.

**Pass owner:** CEO and Finance lead jointly; Sales and Operations sign their views.

### GL-10 — Guarantee, callback, and no-access lifecycle

**Business outcome:** Every public service promise has a defined, measurable operational path, and
a failed access visit cannot be “resolved” without actually completing the approved customer and
money outcome.

**Why this is still a gate:** Public pages promise return service/guarantees, but the app has no
distinct linked callback lifecycle. No-access evidence and customer status are incomplete, and the
resolution can be closed without verifying notification, refund, or rebooking.

**Remaining requirements:**

- The CEO approves a guarantee matrix by service: eligibility, term, covered pests/conditions,
  exclusions, customer obligations, maximum response time, charge, and approval authority. The
  accepted customer terms contain the same matrix.
- Customers and staff can request a callback/return service. The resulting job is visibly linked to
  the original service and cannot accidentally be charged as a new sale.
- Operations sees callback volume, reason, original technician/service, days to resolution, and
  repeat-callback rate. Leadership can use it as a quality and margin signal.
- A no-access outcome is visible to the customer, includes the approved reason and evidence, and
  sends a truthful next step. Operations can open the evidence from the case.
- The CEO approves the no-access financial policy. The system must not charge a fee unless that
  exact policy was disclosed before purchase and the case meets it; the employee never decides or
  calculates a fee ad hoc.
- No-access resolution closes only after the chosen rebook/refund/credit/customer-notice outcome is
  verified. It cannot be closed by typing a note that claims the work happened.

**Pass owner:** Head of Operations; CEO approves promises and Finance approves money policy.

### GL-02 — A lead lifecycle in which no lead can disappear

**Business outcome:** Every lead always has an accountable person, a next action, and an auditable
outcome until it becomes a customer or is deliberately closed.

**Why this is still a gate:** A lead can currently be saved with insufficient contact information,
has no assigned owner or follow-up deadline, and has no complete stage/lost lifecycle. Duplicate
people can also be created before the safe paid-conversion path is reached.

**Remaining requirements:**

- The business approves a small, unambiguous pipeline: at minimum **New**, **Attempting contact**,
  **Qualified**, **Booking sent**, **Booked/Won**, **Lost**, and **Do not contact**.
- Every open lead has an owner, created time, last-touch time, next action, and due time. Missing or
  overdue actions appear in an owner and manager queue; they are not found by browsing a list.
- A lead cannot be saved without a usable contact route. If incomplete third-party data must be
  accepted, the save creates a clearly owned “obtain contact information” exception automatically.
- Email/phone normalization and duplicate detection run before creation. A week-one employee gets
  a simple **Use existing**, **Create separate**, or **Ask manager** decision with enough context;
  the system never silently merges people.
- Every call, email, text, and booking-link attempt records time, channel, actor, and actual outcome.
  A failed delivery does not count as a successful touch.
- Lost leads require a controlled reason. Do-not-contact immediately suppresses non-essential sales
  outreach and records who made the decision.
- The CEO sets response and follow-up SLAs by lead source.
- The CEO explicitly decides how phone-only and non-card customers are handled. If they are not a
  supported launch segment, staff receive a truthful close reason instead of a dead-end conversion
  path. If they are supported, the approved path retains the same pricing, terms, identity, and
  audit controls as self-service booking.

**Pass owner:** Head of Sales.

### GL-03 — Honest fallback contact and communication outcomes

**Business outcome:** Customers are told what will actually happen, and staff never see a success
message for a communication that was not delivered.

**Why this is still a gate:** The quote fallback promises a call even when phone is optional, and
some CRM communication actions can return a non-delivery result while the screen presents success.

**Remaining requirements:**

- A quote that needs human review captures a usable preferred contact channel. If a call is
  promised, a valid phone number and call consent are required; otherwise the promise says email.
- The customer sees a specific response window the sales team has accepted and can meet during
  published business hours. After-hours submissions receive a truthful next-business-window time.
- Every send action branches on the delivery result: **sent**, **not sent—fix this now**, or
  **queued for retry**. Only the first state can display “sent.”
- Bounce, suppression, missing mailbox, and provider failure create an owned exception tied to the
  lead/customer and expose an approved alternate-contact next step.

**Pass owner:** Head of Sales.

### GL-11 — Minimum complete customer/group portal

**Business outcome:** A customer or property manager can complete the tasks the business directs
them to the portal for without calling the office.

**Why this is still a gate:** The group/property-manager view lacks the financial and service
documents needed to manage properties, and the portal lacks key ongoing-service request paths.

**Remaining requirements:**

- An authorized group/property manager can retrieve service reports, agreements, receipts/invoices,
  and amounts for the correct properties without gaining access to unrelated customers.
- Customers can initiate the approved reschedule request, callback/guarantee request, and general
  service help path with a visible response commitment and case/reference number.
- Portal actions show current status and do not disappear after submission. Failed submissions are
  visibly pending and enter an owned operations queue.
- The business defines what a group manager may see and do versus an individual resident; unrelated
  groups and residents remain inaccessible.
- Public claims that residents can schedule in-unit service are either backed by an approved,
  property-scoped resident flow or removed before launch.

**Pass owner:** Head of Operations.

---

## Priority 2 — Launch operating readiness

### GL-23 — Production master data and launch-day operating model

**Business outcome:** The production app contains the real facts needed to sell and serve, and every
queue has a staffed owner from the first lead through the last payment exception.

**Remaining requirements:**

- Production contains CEO-approved service areas, catalog/rates/cost floors, durations, products and
  label data, technician identities/licenses/expiry dates, working calendars, territories, customer
  communication templates, policy versions, and finance/provider mappings.
- Every production technician and staff user is a named real person with the correct role and
  linked profile. Nonproduction identities and data are absent or unmistakably isolated.
- Sales, Operations, Finance, Compliance, and CEO exception queues have named primary/backup owners,
  hours, response SLA, handoff rule, and vacation/offboarding coverage.
- Operations documents the daily opening checklist, next-day dispatch review, mid-day exception
  review, end-of-day money/work reconciliation, and after-hours customer escalation.
- Launch support has a published command channel, issue intake, severity owner, decision log, and
  twice-daily review. Leadership knows the pause/rollback authority and customer communication path.

**Pass owner:** Head of Operations.

### GL-24 — Low-skill, failure-resistant workflows

**Business outcome:** The system makes the safe action the obvious action for a new employee and
does not depend on tribal knowledge.

**Remaining requirements:**

- Every irreversible confirmation uses customer/business language, states the consequence, prevents
  duplicate clicks, and returns a receipt/reference. Error messages identify what happened, whether
  money/customer state changed, who owns it, and the one safe next step.
- No critical workflow requires memorizing a policy, copying an ID, calculating money/capacity,
  interpreting a raw provider status, opening developer tools, or entering invented free text.

**Pass owner:** Head of Operations; each functional leader approves their workflows.

---

## Final approval record

The launch approver should use this table only after every named owner approves their requirements.

| Function | Named approver | Date | Gates accepted | Approval record |
|---|---|---|---|---|
| CEO |  |  | GL-01, 05, 08, 13, 14, 16, 17, 19, 20, 22 |  |
| Sales |  |  | GL-02, 03, 19 |  |
| Operations |  |  | GL-04, 07, 09–15, 18, 19, 23, 24 |  |
| Finance |  |  | GL-05–09, 16, 17, 19, 21 |  |
| Compliance/legal |  |  | GL-01, 10, 13, 15, 17, 20, 22 |  |
| Engineering |  |  | GL-05, 21, 22 |  |

**Production go-live decision:** `NO-GO / GO`

**Decision owner:**

**Decision date/time:**

**Known exceptions accepted:** None. Any accepted scope reduction must be removed from public and
staff access before the decision is changed to **GO**.
