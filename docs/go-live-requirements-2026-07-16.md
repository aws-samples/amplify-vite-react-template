# BuzzKill — remaining go-live requirements

**Business review date:** 18 July 2026

**Implementation reviewed:** working tree at `b5a26b8` (through the GL-07 and GL-14 commits),
verified file-by-file against the Amplify backend, the public site, and the CRM app.

**Decision:** **NO-GO until every gate in this document is closed**

**Review seats:** CEO, leadership, operations, customer, technician

This is a **delta-only** document. It lists only what is *not yet done*. Where this review confirmed a
capability is genuinely built and working, it has been removed from the gate or moved to a short
**Already delivered** line so engineering keeps the credit and no one rebuilds it. An omitted item is
not a request to rebuild it. A listed item is a launch blocker.

**A note on the commit history.** Three commits describe gates as "engineering closed" — GL-14, GL-13,
and GL-15. A line-by-line read of the tree does not support those words. Real work landed in each, but
named requirements remain (session end on demotion, the day-view route-ID check, durable audit ledgers,
report-finalize concurrency, email idempotency, real delivery states). Those gates stay open below with
only the unfinished parts listed. Only **GL-07** is genuinely reduced to operational proof.

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

## Two systemic issues behind several gates

Before the gate register, two failure patterns recur across the audit. Fixing them once retires part of
several gates at the same time.

- **X1 — The audit ledgers exist but no human can read them.** The system writes immutable history for
  staff-access changes, customer lifecycle changes, and visit changes (`StaffAccessEvent`,
  `CustomerLifecycleEvent`, `VisitChangeEvent`). None of them is surfaced on any business screen — only
  the exception queue's own events are ever displayed. "Leadership can prove who changed what, and
  export it, without engineering" is therefore unmet everywhere it is promised (GL-14, GL-09, GL-15,
  GL-07). Worse, these same ledger writes are **best-effort**: the code logs and swallows a failed write,
  so the one record that proves a sensitive action can silently not exist.

- **X2 — Any office user can close any exception by typing a note.** The exception-resolution path
  accepts a single free-text note from routine OFFICE staff and closes the case, including money and
  no-access cases whose real-world outcome was never verified. This is the single change that would most
  improve trust in the whole exception system, and it undermines GL-18, GL-10, GL-05, and GL-15 at once.

## Gate register

| Priority | ID | Remaining gate | Accountable business owner | Impact if missed |
|---|---|---|---|---|
| P0 | GL-14 | Finish fail-safe staff access changes and offboarding | CEO | Demoted or departed staff keep live access; changes go unowned and unprovable |
| P0 | GL-13 | Finish technician session, route, and historical-data boundaries | CEO | A technician sees a peer's job/customer, or a departed tech keeps field access |
| P0 | GL-15 | Finish regulated-report durability and compliance sign-off | Compliance owner | Invalid, duplicate, or falsely "delivered" legal record reaches a customer |
| P0 | GL-17 | Seasonal plan and licensed-scope decisions | CEO + Compliance owner | Work billed out of season or performed outside legal authority |
| P0 | GL-12 | Finish service-specific dispatch readiness | Head of Operations | An unsafe or unperformable visit is dispatched |
| P0 | GL-05 | Complete paid-booking delivery and reconciliation controls | CEO + Engineering lead | A confirmation duplicates, or a paid booking silently disagrees with the money |
| P0 | GL-09 | Make customer lifecycle transitions atomic and auditable | Head of Operations | Deactivation leaves a live portal login, or status disagrees with billing |
| P0 | GL-08 | Finish failure-safe customer plan cancellation | CEO | Customer told billing stopped while the subscription is still live |
| P0 | GL-04 | Capacity that cannot be oversold | Head of Operations | Two customers buy the last slot; a day is sold with no one to work it |
| P0 | GL-06 | Honest handling of processing and failed payments | Finance lead | Customer told "booked/paid" while the payment can still fail |
| P0 | GL-07 | One safe office cancel/reschedule workflow | Head of Operations | *(Engineering closed — operational proof only)* |
| P0 | GL-16 | Governed pricing and margin protection | CEO + Finance lead | AI or an employee publishes a loss-making or nonsensical price |
| P0 | GL-01 | One truthful, complete service catalog | CEO | An advertised service cannot be quoted, staffed, or documented |
| P0 | GL-20 | Public promises and legal terms match operations | CEO | Contract, regulatory, and brand exposure from unbacked claims |
| P0 | GL-21 | Production accounts and integration readiness | Engineering lead + Finance lead | A staging assumption, stale secret, or unstaffed mailbox fails with real money |
| P0 | GL-22 | Monitoring, recovery, retention, and incident ownership | CEO + Engineering lead | A background failure stays silent, or records cannot be restored |
| P1 | GL-18 | Verifiable exception resolution | Head of Operations | Dashboard turns green while the customer problem remains |
| P1 | GL-19 | Launch reconciliation and command view | CEO + Finance lead | Leadership cannot see money, plan, or sales mismatches each morning |
| P1 | GL-10 | Guarantee, callback, and no-access lifecycle | Head of Operations | A public promise becomes uncontrolled free work or a dispute |
| P1 | GL-02 | A lead lifecycle in which no lead can disappear | Head of Sales | Revenue leaks through unowned, unstaged, or duplicate leads |
| P1 | GL-03 | Honest fallback contact and communication outcomes | Head of Sales | Customer waits on a call that was promised but never owned |
| P1 | GL-11 | Minimum complete customer/group portal | Head of Operations | Reschedule, callback, and help requests fall back to phone calls |
| P2 | GL-23 | Production master data and launch-day operating model | Head of Operations | Correct software runs on wrong facts, or a queue has no owner |
| P2 | GL-24 | Low-skill, failure-resistant workflows | Head of Operations | Launch still depends on tribal knowledge |

---

## Priority 0 — Critical money, security, compliance, safety, and customer commitments

### GL-14 — Finish fail-safe staff access changes and offboarding

**Business outcome:** A role change or departure cannot leave a person with unintended access, and
leadership can prove who changed access, why, and what work was reassigned.

**Already delivered (verified this review):** Offboarding ends the login for real — it disables the
Cognito user and forces a global sign-out, not just a group change. There is a last-owner guard so the
company cannot lock itself out. A role change reads the person's effective roles back and reports a
partial result if they do not converge. Technician and login records are linked atomically at creation.
Future jobs are unassigned with a per-job check, and a downstream failure opens an owned Operations case
instead of a false "done." The immutable `StaffAccessEvent` ledger model exists and is read-only.

**What remains the gate:**

- **A demotion does not end the person's sessions.** Removing a role only changes group membership; the
  old token keeps the removed role until it expires. Removing privilege must invalidate existing
  sessions the same way offboarding does — an old token and a freshly issued token are both refused
  immediately after a demotion, and the operator is not told access ended until the provider's enabled
  state and effective groups are read back.
- **The offboarding sequence is not fail-safe.** The disable-the-login step currently removes groups
  *before* disabling, so a failure early in that step can leave the person enabled with a changed role
  set. Disable and sign-out must happen first; a timeout or provider error at any step must leave a
  durable owned **security** case with one idempotent resume action, not an enabled or ambiguously
  privileged person.
- **There is no durable request behind the change.** Every role reduction and offboarding must start
  from a written request holding actor, target, prior and requested roles, an **approved reason
  (controlled list, not optional free text)**, timestamp, and an idempotency/version key. Blank or
  unexplained access changes are refused. Concurrency control must prevent two simultaneous changes — or
  two owners each removing the other — from both passing a stale check; at least one usable owner and
  recovery path must always remain.
- **Success is not read back.** Offboarding reports the login disabled and the technician inactive
  without confirming either persisted. **Complete** must mean the expected jobs are unassigned, the
  technician is verified inactive, no job is left on an abandoned route, and each in-progress visit is in
  owned Operations review.
- **The audit ledger is best-effort and invisible (see X1).** Its write result is ignored, so the record
  can silently fail to exist, and no business screen can search or export it. The event and any
  partial-result case must be **required durable outcomes**; leadership must be able to search and export
  the immutable history from an authorized screen without engineering.
- Production has at least two named usable owners with MFA and separate recovery access, and a
  break-glass procedure that lets either owner recover access and offboard the other without engineering
  or a shared login.

**Pass owner:** CEO, with Operations verifying reassigned work.

### GL-13 — Finish technician session, route, and historical-data boundaries

**Business outcome:** A technician sees only the minimum data for legitimate current or
business-approved historical work, and access disappears when assignment or employment ends.

**Already delivered (verified this review):** When a technician opens a *single* job, the server proves
that job is currently assigned to them (or refuses opaquely), and reassignment removes the former
assignee's access on the next fetch. Field actions additionally require an active technician and an
unexpired license. Payloads are least-privilege: the technician gets visit fields only, never billing,
plan price, provider IDs, or a peer's license. Document links are scoped to customers the technician
serves.

**What remains the gate:**

- **The day view still trusts the route, not the assignment.** The technician's day is built by pulling
  every job carrying that route's ID, with no per-job check that the job is still assigned to the
  signed-in technician. A partial or inconsistent reassignment therefore exposes another technician's job
  and customer — the exact leak this gate names, and it has no test. Each day-view job must be checked
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

**Already delivered (verified this review):** Report finalization is durable before any customer message
and resumes rather than restarts. A correction is an append-only amendment with a content-derived
identity, so a retry lands the same row instead of a second correction. The issuer's identity comes from
their authenticated session, not a free-text field.

**What remains the gate:**

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
- **"Delivered" only means the provider accepted the message.** The delivery state is limited to
  Delivered / Failed / No-email, and is set the instant the provider accepts — there is no
  Pending, Bounced, or Suppressed state and no handler for provider bounce/complaint events. Delivery
  must distinguish Pending, Delivered, Bounced/suppressed, Failed, No-email, and approved alternate
  delivery with proof; provider acceptance alone cannot display "sent to customer."
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

**What remains the gate:**

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

**What remains the gate** *(the engineering commit itself lists these as not-yet-closed):*

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

**Already delivered (verified this review):** Finalization is an atomic, resumable claim, so concurrent
webhook deliveries cannot both finalize the same booking and a retry resumes rather than duplicates.
Confirmation and office-alert each have a durable "sent" marker, so a resumed finalization sends only the
message that was missed — never a duplicate booking. Any money without a complete booking (missing,
wrong-status, stale, or amount-mismatched) always becomes an owned Finance case. A daily reconciliation
proves **both directions** for the accounting window — every succeeded payment maps to exactly one whole
booking and every booked commitment to one paid invoice for the exact amount — and a provider read error
opens owned work instead of reading as "all clear." Cases are written only server-side.

**What remains the gate:**

- **The confirmation email itself can still duplicate.** The marker prevents re-*booking*, but the send
  has no provider idempotency key, so a crash between provider acceptance and the marker write re-sends
  the customer confirmation on retry. And a *failed* marker write is only logged, not turned into owned
  work — so "sent but not recorded" is invisible. Delivery must use a provider idempotency key (or
  equivalent outbox) covering that window, and a failed marker write must be visible owned work.
- **Confirmation is shown as delivered on provider acceptance only.** There is no bounce, suppression,
  timeout, or alternate-delivery state (same root cause as GL-15). Each must carry a truthful status,
  owner, deadline, and retry/proof path.
- **Reconciliation checks existence and amount, not full ownership.** It confirms a child record resolves
  and a paid invoice for the payment exists, but does not verify the customer, job, plan, agreement,
  service, and date all belong to the *same* booking. A cross-linked (wrong-owner) child would not be
  flagged. Reconciliation must validate the relationships, not merely that records exist.
- **A truncated scan can still report green.** The provider scan stops at a page cap and then reconciles
  against the truncated set, able to return "ok" and auto-resolve healthy cases. A truncated, expired,
  or timed-out run must create an owned Finance/Engineering failure and leave prior state visible — it
  cannot report green or auto-resolve.
- **Paid-not-finalized cases can still be closed by a note (see X2).** They must close only after the
  system verifies a complete commitment or a settled refund plus customer notice.

**Pass owner:** CEO and Engineering lead jointly; Finance owns reconciliation and recovery approval.

### GL-09 — Make customer lifecycle transitions atomic and auditable

**Business outcome:** Customer status, billing, access, scheduled work, and customer communication never
disagree, and an employee always sees the real outcome of deactivation or reactivation.

**Already delivered (verified this review):** Reactivation is one server action that restores access,
then status, then records the event, and heals a partially-restored customer without a second
transition. The money-and-work side of deactivation is coordinated in the right order (money first,
status last) with partial-plan-cancel detection and an idempotent re-run. The safe-edit path blocks
protected lifecycle fields. The immutable `CustomerLifecycleEvent` ledger model exists.

**What remains the gate:**

- **"Deactivate customer" is still two actions chained in the browser.** The screen calls the money/work
  deactivation, then separately calls revoke-portal-access. If the browser dies or the second call fails,
  the customer is **Inactive with a live portal login**. Deactivation must be one server action that
  coordinates plan billing, queued and paid visits, open balances, portal access, customer notice, and
  final status, so the employee never has to remember a second step. (Reactivation is already unified;
  deactivation must match.)
- **There is no durable step state across the money↔access split**, so a failure between the two steps is
  neither owned nor resumable. Each transition needs durable step state and a safe resume action that
  names exactly what changed, what is still live, who owns it, and whether the customer can still be
  charged or served.
- **No controlled reason is required** — deactivation takes no reason at all. Every transition must
  require a controlled reason and record actor, time, prior/new state, provider results, affected
  plans/jobs/balance/access, communication outcome, and final disposition.
- **Status writes are not read back, and the audit write is best-effort (see X1).** A status update can
  fail while the screen reports Active/Inactive, and a lost audit write is swallowed. Every status,
  access, plan, job, and audit write must be verified before success; a failed audit write creates
  blocking owned recovery.
- **No version/conditional control**, so interleaved deactivate/reactivate requests can still produce
  mixed state. Duplicate requests must return the same transition and outcome.
- Leadership can see the complete transition history on a business screen (**see X1**).

**Pass owner:** Head of Operations; Finance and CEO approve protected fields, transition policy, and
recovery policy.

### GL-08 — Finish failure-safe customer plan cancellation

**Business outcome:** A customer's online cancellation is a durable instruction, and every customer
message matches the actual billing, plan, schedule, and delivery state.

**Already delivered (verified this review):** A duplicate click is a no-op success. Cancellation attempts
the provider first and treats an already-canceled subscription as success. When the provider call fails,
the system sets a pending flag and opens a durable owned case with an office alert. Whether a confirmation
email was actually sent is tracked as a truthful flag, and a missing or failed email opens owned work.

**What remains the gate:**

- **The pending screen still promises "you won't be charged again" while the subscription is live.** On a
  provider failure — where billing is explicitly still active — the customer message tells them they will
  not be charged again, with no enforceable automatic stop or refund behind it (the fix is a manual
  owned task). While the subscription is still active, the portal must state the truthful pending status,
  resolution time, and what happens if a charge posts.
- **"Recurring visits stopped" is claimed even when visits remain**, and a failed visit-removal is only an
  office email, not owned work. The screen may say visits stopped only when every cancelable visit was
  actually removed; any failed schedule write creates durable owned work and a truthful outstanding-visit
  disposition.
- **The CRM plan write is not confirmed.** After the provider succeeds, the plan is marked canceled with
  no error check or read-back, so a provider-success + CRM-write-failure reports the plan canceled while
  the plan row may remain active. **Canceled** must appear only after the provider stop and the CRM
  transition are both confirmed written; a CRM failure resumes the same cancellation.
- **The instruction is only recorded on the failure path.** The pending flag and owned case are written
  inside the catch, so a crash after the provider cancels but before any CRM write loses the instruction
  entirely. The request must be durably recorded before or with the provider attempt.
- **Concurrent (not just sequential) clicks are unprotected** — there is no conditional/version guard;
  two simultaneous requests both read Active and both proceed. Duplicate or concurrent clicks must return
  the same request and outcome.
- "Confirmation emailed" language must appear only when delivery succeeded (the honest flag exists; the
  success prose does not yet always respect it).

**Pass owner:** CEO, with Finance and Operations sign-off.

### GL-04 — Capacity that cannot be oversold

**Business outcome:** Any day/window shown to a customer can actually be staffed, and two customers
cannot buy the same last unit of capacity.

**Already delivered (verified this review):** Availability accounts for service on-site duration and real
drive-time between stops, and the booking step re-checks the specific day against the live schedule
before taking payment.

**What remains the gate:**

- **No slot is ever reserved.** There is no capacity-hold concept in the system; two concurrent bookings
  for the last slot both pass the check because capacity is derived from existing jobs and nothing is
  written to claim the slot. Selecting checkout must place a short, visible hold that a successful payment
  consumes and that abandonment, failure, and expiry release; concurrent purchases for the last slot must
  yield exactly one booking and a truthful alternate-date/refund outcome for the other, with no manual
  database repair. The CEO approves the hold duration.
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

### GL-06 — Honest handling of processing and failed payments

**Business outcome:** A customer is never told they are booked or paid while the payment can still fail,
and Operations never dispatches an unconfirmed payment as if it were settled.

**Already delivered (verified this review):** The webhook finalizes a booking only on a *succeeded*
payment; a payment still processing does not create a booking, and a failed payment is handled on its own
path.

**What remains the gate:**

- **The customer UI announces "You're booked" and "paid today" on a still-processing payment.** The
  success screen renders those headings for both succeeded and processing states, softening only the
  smaller text. And a repeat booking attempt on a processing intent tells the customer it is "already
  paid — check your email," though no confirmation email has been or will be sent yet. Processing copy
  must state what is reserved, what is not yet confirmed, when the customer will hear, and what happens if
  payment fails — never "paid" or "booked" prematurely.
- The CEO chooses which payment methods finalize instantly and which require a **Payment
  processing — slot held, not yet booked** state. Success finalizes the held booking once; failure or
  timeout releases capacity (ties to GL-04's hold), informs the customer, and records the outcome without
  creating a commitment.
- Operations can distinguish **processing**, **paid/finalizing**, **booked**, and **failed** without
  interpreting provider terminology.

**Pass owner:** Finance lead.

### GL-07 — One safe office cancel/reschedule workflow *(engineering closed)*

**Business outcome:** An employee cannot cancel or move a paid visit without completing the money, plan,
capacity, route, and customer-notification consequences in one guided action.

**Engineering is genuinely closed here — verified this review.** A read-only preview shows every
consequence before the employee commits (customer and visit, amount paid and open, the policy deadline,
the policy-computed refund/credit/fee, the plan consequence, the route consequence, and the exact notice),
and the employee picks a plain decision. The server computes every amount from one shared cancellation
policy — the same free-cancel window the booking funnel enforces — so staff never type an amount. Cancel
performs all consequences money-first and fail-safe: a refund that cannot be issued leaves the visit
uncanceled and opens an owned exception, and any partial failure returns PARTIAL rather than claiming
completion. Reschedule revalidates the technician's license for the new date and the route's ownership and
capacity. Every action records an immutable `VisitChangeEvent`, and a manager exception is owner-only.
Covered by 22 handler/policy tests.

**What remains — operational proof only:**

- A retained account credit is handed to Finance as owned work rather than auto-applied, so its redemption
  needs the Finance operating step defined (GL-18/GL-23).
- Like every money gate, the live end-to-end rehearsal — a real cancel plus provider refund against the
  production account (GL-21) — must be witnessed before sign-off.
- The `VisitChangeEvent` history must be visible on a business screen (**see X1**).

**Pass owner:** Head of Operations; Finance approves money dispositions.

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

**If (b): what remains the gate:**

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

**What remains the gate:**

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

**What remains the gate (specific unbacked claims found live on the site):**

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

**Already delivered (verified this review):** The Stripe webhook handler already processes all nine event
types the application relies on (`setup_intent.succeeded`, `payment_intent.succeeded`,
`payment_intent.payment_failed`, `invoice.paid`, `invoice.payment_failed`,
`customer.subscription.deleted`, `charge.refunded`, `charge.dispute.created`, `charge.dispute.closed`),
idempotently. No credentials are hard-coded in source (Buildium and provider keys read from environment
/ secret store). A branch guard blocks live Stripe keys on non-production branches.

**What remains the gate (operational — not provable from source):**

- The previously exposed Buildium credential is rotated and revoked **at the provider**, its access logs
  reviewed, and current credentials exist only in the approved secret store. Removing it from code does
  not pass.
- The **production** Stripe webhook endpoint is confirmed subscribed to all nine events above, and
  production and staging use separate approved keys, prices, webhook secrets, and customer data.
- A monitored `sales@pestbuzzkill.com` mailbox plus the operations/finance routes exist, are staffed to
  the approved SLA, and correctly handle sending, receipt, bounce, suppression, and DKIM/SPF/DMARC.
- Delivered customer communications use the approved production URLs, portal and quote/cancel links,
  sender identity, phone, service area, maps key, AI key, scheduler, and payment return URLs on supported
  phone and desktop devices.
- At least two named owners can access each critical provider account with MFA and recovery codes; no
  launch dependency is controlled by one personal account.

**Pass owner:** Engineering lead and Finance lead jointly.

### GL-22 — Monitoring, recovery, retention, and incident ownership

**Business outcome:** A background failure is noticed before the customer reports it, and business records
can be restored after human or provider error.

**Already delivered (verified this review):** Idempotent replay/recovery logic exists on the code side —
dunning cadence, a single card-charge path, replay-safe webhooks, and a reconciliation retry that opens
owned work rather than requiring database hand-edits.

**What remains the gate:**

- **There is no infrastructure alerting at all.** The backend defines no CloudWatch alarms, no SNS topics,
  and no metric filters; every "alert" today is an application email to a shared inbox. A silent Lambda
  crash, a scheduled job that never fired, or a run of email-send failures would page no one. Alerts must
  cover booking/quote/webhook errors and throttles, scheduled jobs that did not run, email failures,
  reconciliation mismatches, capacity anomalies, document generation/storage failure, and growing/overdue
  exception queues, and reach a named primary and backup.
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

### GL-18 — Verifiable exception resolution

**Business outcome:** An operational failure stays visible until the promised real-world outcome is true;
employees cannot make the dashboard green by writing a note.

**Already delivered (verified this review):** The exception queue is genuinely solid on structure. A
recurrence reopens the same underlying item with a fresh SLA cycle and an occurrence count rather than
vanishing. The queue supports claim, escalation, age, due dates, and an automated overdue sweep. Some
cases already auto-resolve only from a verified event (paid-not-finalized on a real booking; no-access on
a real rebook).

**What remains the gate:**

- **Any routine OFFICE user can close any exception with a free-text note (X2).** The resolve path requires
  only a non-empty note and is open to routine staff, including money and no-access cases whose outcome
  was never verified. Where the app can verify the outcome, it must close only from the verified event
  (refund settled, message delivered or alternate contact recorded, job rebooked, payment finalized,
  portal access restored, duplicate decision completed). Manual closure must be limited to an
  owner/manager, require a controlled reason plus evidence, and be separately reported.
- **Exceptions have no severity, customer-impact label, or controlled set of valid resolution actions** —
  each type carries only a deadline, an owner team, and one free-text action. Each type needs a named
  team/owner, severity, response deadline, customer-impact label, and a small set of valid resolution
  actions.
- Until claimed, a required action is owned by a shared team inbox; no required action may be owned only
  by a shared mailbox or a person who has been offboarded.

**Pass owner:** Head of Operations.

### GL-19 — Launch reconciliation and command view

**Business outcome:** Leadership can tell each morning whether customers, work, and money agree, without
asking engineering to query production.

**Already delivered (verified this review):** A daily booking reconciliation runs and proves the
succeeded-payment ↔ whole-booking relationship both ways, flags paid-not-finalized, duplicate
bookings/invoices, amount mismatches, and dangling child records, and opens owned Finance cases (an
outage opens work rather than reading clean). An operations command dashboard exists showing the
exception queue, open leads, AR aging, a recovery queue, card disputes, completed-but-never-charged jobs,
serviced-but-not-billing plans, and active plans with no next visit.

**What remains the gate:**

- **No daily money reconciliation** proving successful provider payments equal CRM paid invoices with net
  cash explainable and every mismatch an owned, Finance-signed case (today only *booking* payment intents
  are matched, not the full charge/invoice/refund ledger).
- **No plan reconciliation** — provider subscription vs CRM plan mismatches, canceled-still-billing,
  delinquent-still-scheduled, and active-plan-without-next-service as a reconciliation report.
- **No dedicated sales view** (leads by stage/owner/age, first-response SLA, overdue next action, source,
  conversion/loss) and **no service-quality view** (completion, report delivery, no-access, callbacks,
  repeat-callback rate, technician trends).
- **No codified pause/rollback thresholds.** The CEO defines the launch thresholds that force
  pause/rollback — any double charge, paid customer without a job, unauthorized access, unlicensed
  assignment, or unexplained money mismatch — and names who decides.

**Pass owner:** CEO and Finance lead jointly; Sales and Operations sign their views.

### GL-10 — Guarantee, callback, and no-access lifecycle

**Business outcome:** Every public service promise has a defined, measurable operational path, and a
failed access visit cannot be "resolved" without actually completing the approved customer and money
outcome.

**Already delivered (verified this review):** No-access rebooking is well built — a rebooked job is
linked to the original and carries the prior payment forward so it cannot be recharged as a new sale, and
that rebook resolves the no-access case from a real event.

**What remains the gate:**

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
- No-access and callback resolution close only after the chosen rebook/refund/credit/notice outcome is
  verified — not by a typed note (X2). Operations sees callback volume, reason, original
  technician/service, days to resolution, and repeat-callback rate as a quality and margin signal.

**Pass owner:** Head of Operations; CEO approves promises and Finance approves money policy.

### GL-02 — A lead lifecycle in which no lead can disappear

**Business outcome:** Every lead always has an accountable person, a next action, and an auditable outcome
until it becomes a customer or is deliberately closed.

**Already delivered (verified this review):** Intake refuses a lead with no usable contact route (name
plus email or phone required), and email/phone normalization helpers exist.

**What remains the gate:**

- **There is no pipeline.** Customer status is only Lead / Active / Inactive — none of New, Attempting
  contact, Qualified, Booking sent, Booked/Won, Lost, or Do-not-contact exists. The business approves that
  small, unambiguous pipeline.
- **A lead has no owner, next action, or due time, and no overdue queue.** Every open lead needs an owner,
  created time, last-touch time, next action, and due time, and missing or overdue actions appear in an
  owner and manager queue — not by browsing a list. (There is no lead follow-up work type and no stale-lead
  sweep today.)
- **No duplicate detection at intake.** Creation runs with no duplicate lookup and no Use-existing /
  Create-separate / Ask-manager decision; a possible duplicate is only flagged after payment. Normalization
  and duplicate detection must run before creation, and the system never silently merges people.
- **Incomplete third-party contact data is rejected rather than owned.** When incomplete data must be
  accepted, the save creates an owned "obtain contact information" exception automatically.
- **No controlled lost reason and no do-not-contact suppression.** Lost leads require a controlled reason;
  do-not-contact immediately suppresses non-essential outreach and records who decided.
- Every call, email, text, and booking-link attempt records time, channel, actor, and actual outcome — a
  failed delivery is not a successful touch. The CEO sets response and follow-up SLAs by source and decides
  how phone-only and non-card customers are handled (a supported path with the same controls, or a truthful
  close reason — not a dead end).

**Pass owner:** Head of Sales.

### GL-03 — Honest fallback contact and communication outcomes

**Business outcome:** Customers are told what will actually happen, and staff never see a success message
for a communication that was not delivered.

**Already delivered (verified this review):** A synchronous email-send failure opens an owned exception,
and report delivery already carries a proper Delivered/Failed/No-email state with owned work.

**What remains the gate:**

- **The quote fallback promises a call even when there is no phone or consent.** Phone is optional in the
  funnel, yet every review fallback tells the customer a specialist will call within the hour, and
  after-hours submissions get the same "within the hour." A quote needing review must capture a usable
  channel: if a call is promised, a valid phone number and call consent are required, otherwise the
  promise says email — and after-hours submissions receive a truthful next-business-window time.
- **Sends are binary, with no "queued for retry" state**, and only synchronous provider errors are caught.
  There is no handler for asynchronous bounce/complaint/suppression, so a message the provider accepts and
  then bounces stays "sent" forever. Every send must branch on the delivery result — sent /
  not-sent-fix-this-now / queued — and bounce, suppression, missing mailbox, and provider failure must
  create an owned exception tied to the lead/customer with an approved alternate-contact next step.

**Pass owner:** Head of Sales.

### GL-11 — Minimum complete customer/group portal

**Business outcome:** A customer or property manager can complete the tasks the business directs them to
the portal for without calling the office.

**Already delivered (verified this review):** An authorized group/property manager can retrieve service
reports, agreements, and invoices scoped to their own properties (Cognito group scoping), without reaching
unrelated customers. The portal supports paying invoices, viewing documents, and canceling a plan, and
those actions persist.

**What remains the gate:**

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

**What remains the gate:**

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

### GL-24 — Low-skill, failure-resistant workflows

**Business outcome:** The system makes the safe action the obvious action for a new employee and does not
depend on tribal knowledge.

**Already delivered (verified this review):** Positive signals exist — error and notification emails state
the consequence and one safe next step and never route an alert through the failing subsystem, and
idempotent handlers prevent duplicate charges from retries.

**What remains the gate:**

- Every irreversible confirmation uses customer/business language, states the consequence, prevents
  duplicate clicks, and returns a receipt/reference. Error messages identify what happened, whether
  money/customer state changed, who owns it, and the one safe next step. (Duplicate-click prevention and
  plain-language confirmation across the full CRM UI were not exhaustively verified and must be signed off.)
- No critical workflow requires memorizing a policy, copying an ID, calculating money or capacity,
  interpreting a raw provider status, opening developer tools, or entering invented free text. In
  particular, the free-text exception close (X2) and the two-step deactivation (GL-09) are the current
  violations of this rule.

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

**Known exceptions accepted:** None. Any accepted scope reduction must be removed from public and staff
access before the decision is changed to **GO**.
