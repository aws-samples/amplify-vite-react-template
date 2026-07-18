# BuzzKill — remaining go-live requirements

**Business review date:** 17 July 2026

**Latest implementation review:** commits `108ea58` and `2949dd5`

**Decision:** **NO-GO until every gate in this document is closed**

**Review seats:** CEO, leadership, operations, customer, technician

This is a **delta-only** document. It intentionally excludes capabilities that are already working
in the reviewed draft. The current two latest commits were verified against their code and tests;
only their unclosed residuals remain in GL-05 and GL-13. An omitted item is not a request to rebuild
it.

The standard is the “McDonald's test”: a week-one employee must be able to do the right thing
without remembering policy, performing mental math, interpreting system internals, or inventing
free-text workarounds. The system must prevent an unsafe or financially incorrect action, explain
the one next step in plain language, and put failures in an owned queue.

## Go-live rule

Go-live requires all of the following:

1. Every requirement below is marked **Passed** by its named business owner using the stated
   acceptance evidence.
2. There are no open launch-severity defects and no open operational exceptions created during
   the final end-to-end rehearsal.
3. Any offer, promise, role, or workflow that will not be supported at launch is removed from the
   site and app before approval. “Staff will remember not to use it” is not an acceptable control.
4. A failure test is required wherever money, customer status, access, scheduling capacity, or a
   regulated service record changes. A happy-path demonstration alone does not pass a gate.

## Priority model

- **P0 — Critical:** Close first. Failure can create unauthorized access or charges, invalid
  regulated records, direct financial loss, or a customer commitment the business cannot honor.
- **P1 — High:** Close after P0. Failure creates predictable revenue leakage, service breakdown,
  repeat work, or customer escalation.
- **P2 — Launch proof:** Close after the product gates. These prove that real data, people,
  procedures, and first-week users can operate the release safely.

Priority changes implementation order, not launch status: **P0, P1, and P2 are all go-live
blockers.**

## Gate register

| Priority | ID | Remaining gate | Accountable business owner | Impact if missed |
|---|---|---|---|---|
| P0 | GL-05 | Finish paid-booking reconciliation and communication durability | CEO + Engineering lead | Succeeded payment can remain invisible or customer confirmation can be lost |
| P0 | GL-13 | Finish technician read scope and audited override | CEO | Customer-data exposure persists outside the guarded field actions |
| P0 | GL-15 | Legally reliable service-report completion | Compliance owner | Invalid or undelivered regulated record |
| P0 | GL-04 | Capacity that cannot be oversold | Head of Operations | Sell work the company cannot staff or legally perform |
| P0 | GL-16 | Governed pricing and margin protection | CEO + Finance lead | AI/employee can publish loss-making or nonsensical prices |
| P0 | GL-09 | Atomic customer and plan lifecycle controls | Head of Operations | Billing, access, service, and status disagree |
| P0 | GL-08 | Finish failure-safe customer plan cancellation | CEO | Customer believes billing stopped when it may continue |
| P0 | GL-06 | Honest handling of processing and failed payments | Finance lead | Customer promise made before money is settled |
| P0 | GL-07 | One safe office cancel/reschedule workflow | Head of Operations | Incorrect refund, route, plan, or customer notice |
| P0 | GL-14 | Staff identity, linking, and offboarding | CEO | Departed/unlinked staff retain access or work |
| P0 | GL-01 | One truthful, complete service catalog | CEO | Unsupported service sold; downstream rules have no owner |
| P0 | GL-20 | Public promises and legal terms match operations | CEO | Contract, regulatory, and brand exposure |
| P0 | GL-21 | Production accounts, integrations, and live money rehearsal | Engineering lead + Finance lead | Staging assumptions or secrets fail with real customers/money |
| P0 | GL-22 | Monitoring, recovery, retention, and incident ownership | CEO + Engineering lead | Critical failure stays silent or records cannot be restored |
| P1 | GL-02 | A lead lifecycle in which no lead can disappear | Head of Sales | Revenue leaks through unowned or stale leads |
| P1 | GL-03 | Honest fallback contact and communication outcomes | Head of Sales | Customer waits on a contact that did not happen |
| P1 | GL-10 | Guarantee, callback, and no-access lifecycle | Head of Operations | Public promise becomes uncontrolled free work or customer dispute |
| P1 | GL-12 | Finish service-specific dispatch readiness | Head of Operations | Unsafe, unperformable, or inefficient field visit |
| P1 | GL-17 | Seasonal plan and licensed-scope decisions | CEO + Compliance owner | Wrong billing season or work outside licensed scope |
| P1 | GL-18 | Verifiable exception resolution | Head of Operations | Dashboard turns green while customer problem remains |
| P1 | GL-19 | Launch reconciliation and command view | CEO + Finance lead | Leadership cannot detect revenue/work/customer mismatches |
| P1 | GL-11 | Minimum complete customer/group portal | Head of Operations | Property/customer requests and records fall back to calls |
| P2 | GL-23 | Production master data and launch-day operating model | Head of Operations | Correct software runs with wrong facts or no queue owner |
| P2 | GL-24 | Low-skill usability and role certification | Head of Operations | Launch still depends on tribal knowledge |

---

## Priority 0 — Critical money, security, compliance, and customer commitments

### GL-05 — Finish paid-booking reconciliation and communication durability

**Business outcome:** Every succeeded booking payment is either one complete, confirmed customer
commitment or one visible refund/recovery case, including when execution stops between technical
steps.

**Why this is still a gate after commit `108ea58`:** Record creation is now resumable and
duplicate-safe, but several paid states can still be invisible or overstated. A missing/non-quoted
booking or amount mismatch returns before owned work is opened; the final **Booked** write is not
checked before confirmation is sent; communications have no durable sent marker; and the new
reconciliation predicate is not scheduled and does not yet prove the Stripe-to-booking relationship
in both directions against the actual child records.

**Required acceptance evidence:**

- Every succeeded booking PaymentIntent that cannot enter finalization—missing booking, canceled or
  expired booking, superseded intent, missing stored intent, or amount mismatch—creates a durable
  Finance-owned case with customer, amount, reason, and an approved **finish or refund** action. No
  succeeded payment may exit through only a log or silent return.
- The transition to **Booked** is checked and confirmed before customer or internal confirmation.
  If that write fails after the child records exist, retry resumes the same booking and no message
  claims completion.
- Customer confirmation and the internal booking alert have durable delivery/outbox state. A hard
  kill after **Booked** but before/after either send is detected and retried without duplicate
  commitments or untracked duplicate messages.
- A scheduled production reconciliation reads Stripe succeeded payments and the actual CRM customer,
  booking, job, plan when applicable, agreement, and paid invoice records. It proves both directions:
  each succeeded payment has exactly one complete booking, and each paid booked commitment has one
  succeeded payment for the exact amount.
- Reconciliation opens, updates, and resolves owned cases automatically for missing, duplicate, or
  contradictory records. It also detects dangling checkpoint IDs rather than treating a nonblank ID
  as proof that the child record still exists.
- The recovery action either completes the original deterministic records or records an approved
  refund and customer notice. Routine staff cannot manually resolve a paid-not-finalized case while
  the payment remains unmatched.
- Failure injection covers the early guard states, failed **Booked** write, hard termination while a
  claim is held, termination on both sides of each communication, reconciliation input/provider
  failure, duplicate/out-of-order webhooks, and deployed end-to-end recovery with real Stripe test
  events.

**Engineering status (implemented this commit):**

- No succeeded booking payment exits `finalizeBooking` through a log or silent return anymore.
  Missing booking, a `CANCELED`/`EXPIRED` booking that never finalized, a superseded PaymentIntent,
  and an amount mismatch each open a durable Finance-owned `PAID_NOT_FINALIZED` case with the
  customer, amount, reason, and a **finish or refund** action (`shared/bookingFinalize.ts`).
- The **Booked** write is checked before any confirmation is sent: if the status write does not
  persist, finalization throws (opening the exception, releasing the claim for an idempotent retry)
  and no message claims completion.
- Customer confirmation and the internal booking alert now carry durable outbox markers
  (`BookingRequest.confirmationSentAt` / `officeAlertSentAt`). A hard kill after **Booked** but
  before or between the two sends is picked up on the next webhook delivery, which resends only the
  message whose marker is unset — never a duplicate commitment or duplicate message.
- A scheduled production reconciliation runs in the daily cron (`daily-reminders`): it reads
  Stripe's succeeded booking PaymentIntents and the real booking/invoice tables and proves both
  directions — each succeeded payment has exactly one complete booking for the exact amount, and each
  BOOKED booking's checkpoint IDs still resolve to real child rows (a nonblank `jobId` is loaded and
  checked, not trusted). It opens owned cases for missing/duplicate/contradictory records and for a
  Stripe read failure, and resolves the case on a booking that proves whole
  (`shared/bookingReconcile.ts`, `daily-reminders/handler.ts`).
- Failure-injection unit tests cover the guard states, the failed **Booked** write, a kill on each
  side of the two sends, and reconciliation anomalies plus provider failure.

**Still required for the owners' sign-off (not code):** the deployed end-to-end recovery rehearsal
with real Stripe test events, and Finance's review of the first production reconciliation output.

**Pass owner:** CEO and Engineering lead jointly; Finance signs the production reconciliation.

### GL-13 — Finish technician read scope and audited override

**Business outcome:** A technician can see only the minimum customer and work data needed for an
authorized assignment, while office emergency access is explicit and accountable.

**Why this is still a gate after commit `2949dd5`:** Field mutations now verify the signed-in
assignee, but the underlying models still let the TECH role read broad customer, job, plan, report,
group, route, and technician data. Document access is granted when the technician has any historical
job for the customer, not only a legitimate current assignment or approved lookback. Office/owner
bypass and reassignment also lack the required reasoned audit.

**Required acceptance evidence:**

- Technician list, search, get, and subscription results are server-scoped to the signed-in
  technician's current/approved assignments. Knowing a customer, job, route, report, plan, group, or
  technician ID cannot reveal another worker's data.
- The technician receives only the fields needed to perform the visit. Billing, plan price/provider
  identifiers, organization-wide customer/group notes, unrelated contacts, and other technicians'
  work are not exposed through the model API even if the UI hides them.
- Route create/read/update and every remaining technician-accessible model operation are restricted
  to the caller's own authorized route/work. The same rule applies to direct API calls, realtime
  subscriptions, pagination, and cached/offline data after reassignment.
- Document access is limited to the assigned visit and an Operations/Compliance-approved historical
  lookback. A completed job from years ago cannot grant indefinite access to every future agreement,
  report, or photo for that customer; inactive/expired technicians receive no document links.
- Reassignment records actor, reason, former/new technician, effective time, route effect, and stale
  draft disposition. Access changes immediately and cached work is invalidated or refused on the
  next operation.
- Office/owner emergency field access has an approved purpose, requires a reason, records the actor
  and affected job/report, and is reviewed. Shared logins and silent impersonation of the assigned
  applicator are prohibited.
- Direct authorization tests prove Technician A cannot list, fetch, subscribe to, mutate, or obtain
  document links for Technician B's data; cannot retain access after reassignment/deactivation; and
  cannot regain broad access through an old completed job.

**Pass owner:** CEO, with Compliance and Operations verification.

### GL-15 — Legally reliable service-report completion

**Business outcome:** A finalized service report is an accurate, delivered, correctable legal
record—not merely a PDF the UI says was sent.

**Why this is still a gate after commits `b9d75df`, `af289df`, and `5eff5ac`:** Finalization no longer
infers the application window—it refuses any report whose job lacks a server-stamped Start and End, so
the record's times are the real on-site times. It also refuses any product that is not an active,
label-approved catalog row (matched by EPA number and name), so an arbitrary manual pesticide can no
longer reach a finalized record—an unknown product must be reviewed into the catalog by the office
first. Completion and delivery are now separate facts: every finalized report carries a deliveryStatus
(delivered, failed, or no-email), a missing address or a bounce opens an owned delivery task instead of
passing silently, and the office and technician screens show the real delivery state rather than an
unconditional "sent". The remaining gaps stand: location evidence is not validated, and no append-only
amendment workflow exists.

**Required acceptance evidence:**

- A regulated report can use only an office-approved product and label/rate from the launch
  catalog. An unknown product requires an office/compliance approval that becomes part of the
  catalog and audit before finalization; free-text EPA details alone cannot authorize it.
- Server-side finalization refuses a report unless the application has both immutable server-stamped
  start and end times, the assigned technician and current required license, all required treatment
  fields, and all required customer/site facts. It never substitutes the finalization time.
- The Compliance owner approves the on-site presence rule: location freshness, accuracy, distance
  from service address, and documented exception process. Implausible/stale location blocks
  finalization or requires a named manager exception.
- Report completion and report delivery are separate facts. The technician/office sees **Completed,
  delivery pending/failed** until actual delivery. Missing email or send failure creates an owned
  delivery task with an approved alternate delivery method and proof.
- Corrections use an append-only amendment linked to the original report, with reason, author,
  time, changed facts, customer delivery, and original preserved. No role can overwrite the issued
  record.
- Operations can retrieve no-access evidence and all report evidence through authorized screens.
- Compliance signs a rendered sample for every launch service type and tests offline draft/retry,
  duplicate finalize, missing product, missing end, expired license, distant/stale location,
  delivery failure, and amendment.

**Pass owner:** Named Compliance owner.

### GL-04 — Capacity that cannot be oversold

**Business outcome:** Any day/window shown to a customer can actually be staffed, and two customers
cannot buy the same last unit of capacity.

**Why this is still a gate:** Public availability is based on a coarse active-technician/day count,
offers capacity even with no active technician, and only rechecks availability before payment. It
does not reserve the slot while payment completes.

**Required acceptance evidence:**

- Sellable capacity uses the technician's actual working day, approved leave/blackouts, credential
  validity on the service date, service duration, service territory, travel allowance, and time
  window. Zero eligible technicians means zero sellable dates.
- Capacity rules are the same in the public funnel and the dispatch board. A day/window cannot be
  “available” to the customer and over capacity to Operations.
- Selecting checkout places a short, visible capacity hold. A successful payment consumes it;
  abandonment, failure, and expiry release it. The CEO approves the hold duration.
- A concurrency test starts two purchases for the last slot. Exactly one may be booked; the other
  receives a truthful alternate-date/refund outcome without manual database repair.
- Operations can block a day, technician, territory, or window and can see why a date is or is not
  sellable. Removing capacity immediately protects all unconsumed public slots.
- The system prevents staffing a service outside the assigned technician's active license/scope,
  even if the slot was quoted earlier.

**Pass owner:** Head of Operations.

### GL-16 — Governed pricing and margin protection

**Business outcome:** Neither AI nor a low-skill employee can publish a loss-making, nonsensical,
or unapproved price.

**Why this is still a gate:** Live market-rate changes have no complete hard bounds/approval trail,
and cost floors do not cover every sellable service, recurring cadence, add-on, and property type.

**Required acceptance evidence:**

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
- A price matrix test covers minimum/maximum inputs, each service/property/cadence, missing rate,
  outlier research, negative/zero/decimal mistakes, and price exactly at/below the margin floor.

**Pass owner:** CEO and Finance lead jointly.

### GL-09 — Atomic customer and plan lifecycle controls

**Business outcome:** Customer status, login access, billing, and scheduled work can never disagree,
and routine staff cannot bypass the approved lifecycle with a raw field change.

**Why this is still a gate:** Customer deactivation and portal revocation are separate client
actions; rebooking an inactive customer can leave a paid customer with disabled access; and broad
record-update permissions can bypass guarded status, plan, pricing, or provider-linked workflows.

**What now closes it:** Raw `Customer.update` and `ServicePlan.update`/`delete` are removed from every
browser role (data/resource.ts) — the office keeps its safe contact/address/note edits through the new
`updateCustomerContact` mutation, which can touch only those fields, and the protected lifecycle fields
(status, Stripe ids, payment-method label, portalUserSub, accessGroups, groupId, plan price/status,
delinquency, paid state) can now move only through named Lambda actions. Reactivation is folded into one
server action, `reactivateCustomer`, that restores the portal login *before* it publishes ACTIVE, so a
paying customer is never left ACTIVE with a dead login. Every deactivation and reactivation now appends
an immutable row to a new `CustomerLifecycleEvent` ledger (actor, timestamp, prior→new status, and the
money/job/access effects), browser-readable by OWNER/OFFICE/FINANCE.

**Required acceptance evidence:**

- ✅ **Deactivate customer** is one server-owned business action covering plan billing, queued visits,
  open balances, customer login, communications, and status; a partial failure leaves the customer
  ACTIVE (never a hidden live charge) and pages the office. The money/work/status half is one resumable
  action; the login half is a chained guarded mutation whose failure becomes owned work. *(shared/
  `deactivation.ts`, crm-admin `revokePortalAccess`, `deactivation.test.ts`; the ledger write is new.)*
- ✅ Reactivating an inactive customer explicitly restores the approved access state **before** the
  status is confirmed, in one server action; canceled plans stay canceled (re-subscribe via a new
  booking). *(crm-admin `reactivateCustomer`, `reactivation.test.ts`.)*
- ✅ Statuses, plan price/status, Stripe identifiers, access groups, paid state, and other protected
  lifecycle fields can change only through named business actions; office screens retain only safe
  contact/address/note edits. Enforced structurally — no browser mutation exists to write them.
  *(data/resource.ts Customer/ServicePlan auth, `updateCustomerContact`.)*
- ⚠️ Two employees performing the **same** lifecycle action cannot produce mixed state: deactivate is
  idempotent, and a reactivation of an already-ACTIVE customer reports the current fact and writes no
  second transition. **Residual:** there is no DB-level optimistic lock across *different* actions, so a
  truly interleaved deactivate-vs-reactivate is not yet conditional-write guarded.
- ⚠️ Every transition records actor, timestamp, prior state, new state, and the money/job/access effects
  in the append-only `CustomerLifecycleEvent` ledger, readable by leadership roles via the data API.
  *(shared/`lifecycleLog.ts`.)* **Residuals:** the actions don't yet prompt for a free-text reason, and a
  dedicated CRM history screen is a follow-up (the rows are readable but not yet surfaced in a view).
- ⚠️ Tests cover deactivation with active plan/queued visit/open invoice, partial provider failure,
  reactivation (fresh, idempotent, no-login, missing customer), and that the safe edit can never write a
  protected field. *(`deactivation.test.ts`, `reactivation.test.ts`.)* **Residual:** a public-funnel
  "inactive customer rebooks online" end-to-end case is not covered here.

**Pass owner:** Head of Operations; Finance and CEO approve protected fields and transition policy.

### GL-08 — Finish failure-safe customer plan cancellation

**Business outcome:** A customer's online cancellation is a durable instruction, and every
customer message matches the actual billing, plan, schedule, and delivery state.

**Why this is still a gate after commit `0dd973d`:** Remaining failure paths can overstate the
outcome: the pending screen promises no further charge while the Stripe subscription is still
active; an unsuccessful CRM plan or queued-job write can be followed by “canceled/visits stopped”;
and the response says a confirmation was emailed even when delivery failed or no email exists.

**Required acceptance evidence:**

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
- Failure injection covers provider failure, provider success plus CRM-plan write failure, queued-job
  write failure, pending-request/work-item write failure, missing/failed email, duplicate/concurrent
  confirmation, and an attempted cancellation of another customer's plan.

**Pass owner:** CEO, with Finance and Operations sign-off.

### GL-06 — Honest handling of processing and failed payments

**Business outcome:** A customer is never told they are booked or paid while the payment can still
fail, and Operations never dispatches an unconfirmed payment as if it were settled.

**Why this is still a gate:** A payment in `processing` can currently produce “You're booked” and
“paid today” language even though final booking creation waits for a later success event.

**Required acceptance evidence:**

- The CEO chooses which payment methods are allowed to finalize instantly and which require a
  **Payment processing—slot held, not yet booked** state.
- Processing copy states what is reserved, what is not yet confirmed, when the customer will hear,
  and what happens if payment fails. It never uses “paid” or “booked” prematurely.
- Success finalizes the held booking once. Failure/timeout releases capacity, informs the customer,
  and records the lead/customer outcome without creating a service commitment.
- Operations can distinguish **processing**, **paid/finalizing**, **booked**, and **failed** without
  interpreting Stripe terminology.
- Tests cover delayed success, delayed failure, duplicate events, events delivered out of order,
  and a payment that succeeds after its capacity hold expired.

**Pass owner:** Finance lead.

### GL-07 — One safe office cancel/reschedule workflow

**Business outcome:** An employee cannot cancel or move a paid visit without completing the money,
plan, capacity, route, and customer-notification consequences in one guided action.

**Why this is still a gate:** The office job controls change schedule state directly and do not
provide a unified refund/credit decision, recurring-plan effect, or guaranteed customer notice.

**Required acceptance evidence:**

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
- Tests cover paid/unpaid, one-time/recurring, inside/outside policy, assigned/unassigned, refund
  failure, notice failure, and two employees acting on the same visit.

**Pass owner:** Head of Operations; Finance approves money dispositions.

### GL-14 — Staff identity, linking, and offboarding

**Business outcome:** Every staff login maps to one real worker and role, and a departed or
misconfigured employee cannot retain access.

**Why this was a gate, and what this commit closes:** Staff identity is now server-enforced end to
end. `adminCreateUser` refuses a TECH login unless it is atomically bound to exactly one Technician
record with a present, current applicator licence — "invite now, link later" is gone, one technician
maps to one login, and a record already linked to another login is refused. A new owner-only staff
roster (`staffRoster`) joins Cognito to the technician records and surfaces person, email, role(s),
status, pending invite, and — for technicians — the linked profile and its licence, flagging unlinked
or lapsed technicians. Owners can change any role set (`changeStaffRoles`) and offboard any staff
role (`offboardStaff`), which disables the login, globally signs out live sessions, removes every
staff and dynamic group, returns a linked technician's future jobs to the scheduling pool, and pages
the office — in one action, preserving the Technician row and finalized reports (audit/legal records
are never deleted). The last usable owner cannot be demoted or offboarded.

**Required acceptance evidence:**

- ✅ Creating a technician login atomically creates/links exactly one technician profile with required
  active license data, or refuses with a fixable error. “Invite now, link later” is not available.
  *(crm-admin `adminCreateUser`; the CRM invite form requires the technician pick.)*
- ⚠️ An owner-only staff roster shows person, email, role(s), linked profile, status, and pending
  invite, and blocks duplicate/shared identities and unlinked users (shared identity is refused at
  creation; unlinked technicians are flagged in the roster). **Residual:** last-login is not yet
  populated — Cognito does not record last sign-in and no staff-profile store stamps it, so that
  column is deferred to a follow-up.
- ✅ Owners can change role and offboard OWNER, OFFICE, FINANCE, and TECH users. Offboarding disables
  login/sessions, removes groups, reassigns owned work and future jobs, and preserves audit/legal
  records in one guided action.
- ⚠️ The system prevents removal of the last usable owner (enforced in `assertOwnerRemains`).
  **Residual (operational):** naming at least two owners and running one tested break-glass drill is a
  pre-launch operating step, not code.
- ✅ Tests cover abandoned invite (roster pending-invite flag), duplicate/shared email, unlinked
  technician, role change, immediate offboarding, offboarding with assigned future work, and
  attempted access using an old session (global sign-out). *(crm-admin `offboarding.test.ts`,
  shared `staffRoles.test.ts`.)*

**Pass owner:** CEO.

### GL-01 — One truthful, complete service catalog

**Business outcome:** A customer can never be promised a service the operating system cannot
price, staff, perform, document, and support profitably.

**Why this is still a gate:** The public site advertises more services than the quote funnel can
select, while the funnel says every service gets an exact price. Several distinct services collapse
into broad pricing categories with no approved duration, license scope, or service template.

**Required acceptance evidence:**

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
- A test quote for every retained site service reaches the correct price or review outcome, then
  creates the correct job/plan terms and technician packet.

**Pass owner:** CEO, with written sign-off from Operations, Finance, and Compliance.

### GL-20 — Public promises and legal terms match operations

**Business outcome:** Marketing, quote, checkout, agreement, portal, and field execution describe
the same offer and no unsupported claim creates customer, regulatory, or brand exposure.

**Why this is still a gate:** The site contains blanket exact-price/no-wait/guarantee claims,
resident-scheduling and license/status claims that are not fully supported by the product or
documented evidence, and service-page metadata/copy mismatches.

**Required acceptance evidence:**

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
- A final link/copy audit starts from every public page and verifies the actual quote, price, terms,
  phone/email, service area, and customer outcome it promises.

**Pass owner:** CEO; Compliance/legal sign the regulated and contractual statements.

### GL-21 — Production accounts, integrations, and live money rehearsal

**Business outcome:** Production does not depend on a staging assumption, missing mailbox, stale
secret, or untested provider event.

**Required acceptance evidence:**

- The previously exposed Buildium credential is rotated at the provider, the old credential is
  proven invalid, access logs are reviewed, and current credentials exist only in the approved
  secret store. Removing it from source code alone does not pass.
- Production and staging use separate, approved Stripe keys, prices, webhook secrets/endpoints, and
  customer data. The production webhook subscribes to every event the application handles:
  `setup_intent.succeeded`, `payment_intent.succeeded`, `payment_intent.payment_failed`,
  `invoice.paid`, `invoice.payment_failed`, `customer.subscription.deleted`, `charge.refunded`,
  `charge.dispute.created`, and `charge.dispute.closed`.
- A monitored `sales@pestbuzzkill.com` mailbox and the operations/finance mailbox routes actually
  exist, are staffed to the approved SLA, and pass send, receive, bounce, suppression, DKIM/SPF/
  DMARC, and after-hours escalation tests.
- Production URLs, portal links, quote/cancel links, sender identity, business phone, service area,
  maps/routes key, AI key, scheduler, and payment return URLs are verified from real delivered
  emails on phone and desktop—not inferred from environment names.
- At least two named owners can access each critical provider account with MFA and recovery codes;
  no launch dependency is controlled by one personal account.
- Using production-equivalent provider modes and low-value authorized transactions, the team
  rehearses: quote → capacity hold → payment → booking → portal access → first service/report →
  recurring start → renewal → payment failure/recovery → cancel/refund → dispute → reconciliation.
  Duplicate and out-of-order webhook delivery is included.
- Finance documents how test transactions/refunds are identified and confirms there is no orphaned
  live charge, subscription, customer, job, or capacity hold after rehearsal.

**Pass owner:** Engineering lead and Finance lead jointly.

### GL-22 — Monitoring, recovery, retention, and incident ownership

**Business outcome:** A background failure is noticed before the customer reports it, and business
records can be restored after human or provider error.

**Required acceptance evidence:**

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
- A restore drill recovers a customer, job/plan/invoice relationship, accepted agreement, service
  report, photos, and audit history into an isolated environment; the business owner verifies the
  records are usable, not merely present.
- An incident drill proves who can pause public booking, prevent new dispatch, stop/reconcile
  billing, post customer messaging, preserve evidence, and authorize restart.

**Pass owner:** CEO and Engineering lead jointly; Compliance approves retention.

---

## Priority 1 — High revenue and operating reliability

### GL-02 — A lead lifecycle in which no lead can disappear

**Business outcome:** Every lead always has an accountable person, a next action, and an auditable
outcome until it becomes a customer or is deliberately closed.

**Why this is still a gate:** A lead can currently be saved with insufficient contact information,
has no assigned owner or follow-up deadline, and has no complete stage/lost lifecycle. Duplicate
people can also be created before the safe paid-conversion path is reached.

**Required acceptance evidence:**

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
- The CEO sets response and follow-up SLAs by lead source. The launch rehearsal proves a new lead,
  failed contact, overdue follow-up, duplicate, booking, and lost lead all land in the correct queue.
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

**Required acceptance evidence:**

- A quote that needs human review captures a usable preferred contact channel. If a call is
  promised, a valid phone number and call consent are required; otherwise the promise says email.
- The customer sees a specific response window the sales team has accepted and can meet during
  published business hours. After-hours submissions receive a truthful next-business-window time.
- Every send action branches on the delivery result: **sent**, **not sent—fix this now**, or
  **queued for retry**. Only the first state can display “sent.”
- Bounce, suppression, missing mailbox, and provider failure create an owned exception tied to the
  lead/customer and expose an approved alternate-contact next step.
- A test using an invalid address and a suppressed address proves that neither the customer record
  nor the employee screen falsely records successful contact.

**Pass owner:** Head of Sales.

### GL-10 — Guarantee, callback, and no-access lifecycle

**Business outcome:** Every public service promise has a defined, measurable operational path, and
a failed access visit cannot be “resolved” without actually completing the approved customer and
money outcome.

**Why this is still a gate:** Public pages promise return service/guarantees, but the app has no
distinct linked callback lifecycle. No-access evidence and customer status are incomplete, and the
resolution can be closed without verifying notification, refund, or rebooking.

**Required acceptance evidence:**

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
- Tests cover guaranteed/not guaranteed, repeat callback, linked zero-price visit, no access with
  paid/unpaid work, evidence access, refund failure, notice failure, and rebooking collision.

**Pass owner:** Head of Operations; CEO approves promises and Finance approves money policy.

### GL-12 — Finish service-specific dispatch readiness

**Business outcome:** A technician is dispatched only with the service-specific facts and approved
scope needed to complete the visit safely, and can exit an unperformable visit without inventing a
workaround.

**Why this is still a gate after commit `940a4b9`:** Readiness is still based on free-text service
data; the address is not proven valid/in service area; products, constraints, and prior treatment
findings are absent; and scope mismatch or missing prep has no dedicated field outcome. Packet
changes after assignment/start also have no technician acknowledgement or versioned safety trail.

**Required acceptance evidence:**

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
- Tests cover each retained service type, invalid/out-of-area address, missing service minimum,
  product/scope restriction, packet edit after assignment/start, scope mismatch, missing prep, and
  retry of the resulting office/customer actions.

**Pass owner:** Head of Operations, with Compliance sign-off.

### GL-17 — Seasonal plan and licensed-scope decisions

**Business outcome:** Seasonal and specialized services bill and schedule exactly as customers were
told, and are performed only under valid business and technician authority.

**Why this is still a gate:** The business has not encoded a final mosquito/seasonal billing and
renewal policy, while some specialized/RI service claims require explicit scope and credential
validation.

**Required acceptance evidence:**

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
  and licensed scope. Tests cross season boundaries, renewal, cancellation, expired credentials,
  and an unsupported service/state combination.

**Pass owner:** CEO and Compliance owner jointly.

### GL-18 — Verifiable exception resolution

**Business outcome:** An operational failure stays visible until the promised real-world outcome is
true; employees cannot make the dashboard green by writing a note.

**Why this is still a gate:** Generic manual resolution can close cases whose refund, email,
rebooking, duplicate merge, access restoration, or other corrective action has not been verified.

**Required acceptance evidence:**

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
- The final rehearsal deliberately causes every exception type and proves it reaches the right
  owner, cannot falsely close, and clears automatically after the real corrective outcome.

**Pass owner:** Head of Operations.

### GL-19 — Launch reconciliation and command view

**Business outcome:** Leadership can tell each morning whether customers, work, and money agree,
without asking engineering to query production.

**Why this is still a gate:** Existing operational views do not provide one launch reconciliation
across the payment provider, bookings, plans, invoices/refunds, staffing, lead SLA, and required
service records.

**Required acceptance evidence:**

- A daily money reconciliation proves: successful provider payments equal CRM paid invoices;
  refunds/disputes equal CRM dispositions; net cash is explainable; and every mismatch is an owned
  case. Finance signs the report during rehearsal.
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
- During the final rehearsal, the command view is run on a fixed daily schedule and all induced
  mismatches are detected without reading logs.

**Pass owner:** CEO and Finance lead jointly; Sales and Operations sign their views.

### GL-11 — Minimum complete customer/group portal

**Business outcome:** A customer or property manager can complete the tasks the business directs
them to the portal for without calling the office.

**Why this is still a gate:** The group/property-manager view lacks the financial and service
documents needed to manage properties, and the portal lacks key ongoing-service request paths.

**Required acceptance evidence:**

- An authorized group/property manager can retrieve service reports, agreements, receipts/invoices,
  and amounts for the correct properties without gaining access to unrelated customers.
- Customers can initiate the approved reschedule request, callback/guarantee request, and general
  service help path with a visible response commitment and case/reference number.
- Portal actions show current status and do not disappear after submission. Failed submissions are
  visibly pending and enter an owned operations queue.
- The business defines what a group manager may see and do versus an individual resident. Tests
  prove both allowed access and denial across two unrelated groups.
- Public claims that residents can schedule in-unit service are either backed by an approved,
  property-scoped resident flow or removed before launch.

**Pass owner:** Head of Operations.

---

## Priority 2 — Launch proof and operating readiness

### GL-23 — Production master data and launch-day operating model

**Business outcome:** The production app contains the real facts needed to sell and serve, and every
queue has a staffed owner from the first lead through the last payment exception.

**Required acceptance evidence:**

- Production contains CEO-approved service areas, catalog/rates/cost floors, durations, products and
  label data, technician identities/licenses/expiry dates, working calendars, territories, customer
  communication templates, policy versions, and finance/provider mappings.
- Every production technician and staff user is a named real person with the correct role and
  linked profile. Test/demo identities and data are absent or unmistakably isolated.
- Sales, Operations, Finance, Compliance, and CEO exception queues have named primary/backup owners,
  hours, response SLA, handoff rule, and vacation/offboarding coverage.
- Operations documents the daily opening checklist, next-day dispatch review, mid-day exception
  review, end-of-day money/work reconciliation, and after-hours customer escalation.
- Launch support has a published command channel, issue intake, severity owner, decision log, and
  twice-daily review. Leadership knows the pause/rollback authority and customer communication path.
- The team completes a clean rehearsal using a copy of production configuration, then verifies all
  test leads, bookings, charges, subscriptions, users, reports, and alerts are removed or isolated
  before accepting real traffic.

**Pass owner:** Head of Operations.

### GL-24 — Low-skill usability and role certification

**Business outcome:** The system makes the safe action the obvious action for a new employee and
does not depend on tribal knowledge.

**Required acceptance evidence:**

- Recruit representative first-week users who did not build the product. With written role cards
  but no live coaching, each completes the scripts below and explains what happened to the customer
  and money.
- Sales scripts: new lead, incomplete contact, duplicate, failed email, follow-up, booking link,
  won, lost, and do-not-contact.
- Operations scripts: new paid booking, processing/failed payment, schedule/reassign, missing job
  data, customer reschedule, cancel/refund, no access, callback, inactive rebooking, and exception
  handoff.
- Technician scripts: today view, safety/access review, start/end, approved product, offline draft,
  finalize/delivery failure, no access, wrong/unsafe site, callback, reassignment, and expired
  license.
- Finance/leadership scripts: recovery, refund/dispute, plan cancellation, daily reconciliation,
  mismatch investigation, rate approval/rollback, staff offboarding, and launch pause decision.
- Every irreversible confirmation uses customer/business language, states the consequence, prevents
  duplicate clicks, and returns a receipt/reference. Error messages identify what happened, whether
  money/customer state changed, who owns it, and the one safe next step.
- No critical script requires memorizing a policy, copying an ID, calculating money/capacity,
  interpreting a raw provider status, opening developer tools, or entering invented free text.
- Pass threshold is 100% correct completion for money, access, regulated record, customer-status,
  and dispatch-safety steps; zero false-success messages; zero unowned failures. Any miss reopens
  the relevant requirement and requires a repeat test with a different first-week user.

**Pass owner:** Head of Operations; each functional leader signs their role scripts.

---

## Final approval record

The launch approver should use this table only after attaching the evidence named above. A verbal
demo or “engineering says it is fixed” is insufficient.

| Function | Named approver | Date | Gates accepted | Evidence location |
|---|---|---|---|---|
| CEO |  |  | GL-01, 05, 08, 13, 14, 16, 17, 19, 20, 22 |  |
| Sales |  |  | GL-02, 03, 19 |  |
| Operations |  |  | GL-04, 07, 09–12, 18, 19, 23, 24 |  |
| Finance |  |  | GL-05–09, 16, 17, 19, 21 |  |
| Compliance/legal |  |  | GL-01, 10, 13, 15, 17, 20, 22 |  |
| Engineering |  |  | Failure evidence for all gates; GL-05, 21, 22 |  |

**Production go-live decision:** `NO-GO / GO`

**Decision owner:**

**Decision date/time:**

**Known exceptions accepted:** None. Any accepted scope reduction must be removed from public and
staff access before the decision is changed to **GO**.
