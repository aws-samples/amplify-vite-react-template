# BuzzKill — Go-live requirements

**16 July 2026 · verified against `54ae329` (staging) · suite: 187 tests passing (141 web, 46 CRM)**

This is the business review of the current draft, taken from five seats — the CEO, the
leadership team, the operations desk, the customer, and the technician — plus the two standing
lenses of the July review cycle: the McDonald's test (a week-one, $18/hour employee must be
able to run every screen without judgment, memory, mental math, or free text) and
compliance/licence. Every requirement below was independently checked against the code by an
adversarial verification pass. Four findings from this round were **refuted in verification
and must not be built**; they are listed near the bottom so they don't come back.

Requirements are stated as outcomes a tester can prove, not implementations. Each carries an
ID (R01–R83) for burn-down tracking, an owner, and a size.

---

## Where this stands

The July 15 reviews reached a NO-GO on one root cause: irreversible customer-visible acts
fired before the durable writes that made them true, and every failure resolved to a log line
plus a success message. Nine engineering commits later, **that root cause is fixed**. Verified
against the tree this round, all previously-open items from the 15-item burn-down are closed
except the ones below:

- **The compliance pair (items 7+14) closed** with `6297c0a`: a technician at a locked door
  now has an honest one-tap exit (NO_ACCESS with fixed reason chips and a door photo) that
  files no report, arms no charge, and advances no plan cadence; the service report now
  carries the MA pesticide-record fields and is **server-side immutable after finalize** —
  read-only to every browser role, with 31 new tests. Residuals are itemized below (R09–R11,
  R20) — real, but small against what closed.
- Also verified closed since rev 7: the Void button no longer renders on SIGNED agreements;
  the paid-online badge reads `Job.paidAt` written atomically with verified payment and cannot
  go stale in the double-charge direction; LPCall leads save durably end-to-end; recurring
  billing auto-starts on first completed visit with a Dashboard queue **and** a daily digest
  backstop; and the HOA escalation email now includes the computed quote instead of throwing
  it away.

What remains is no longer "the ledger is rewritable." It is: money-out flows that don't exist
yet (disputes, dunning, receipts), the last compliance residuals, an unopened booking funnel
with known launch gates, a handful of decisions only Jake can make, and console work no code
can do. That is a launch checklist, not a crisis list.

**One item is urgent independent of go-live: R81. The Buildium client secret is committed to a
public GitHub repo.** Rotate it today.

### Engineering burn-down — 16 July, afternoon pass

Closed against this document in `6af26cf` + `eed1e1b`, each implementation adversarially
verified against the tree before commit (suites now 228 web / 68 CRM, all passing):

- **R03, R05, R13** — money-out is never silent: subscription death alerts the office same-day
  with visit resolution; every cancel path resolves queued visits; every charge and refund
  emails the customer (receipt_email set as belt-and-braces, no-email customers routed to the
  office).
- **R09, R15** — `startJob`/`endApplication` stamp server time and TECH lost model-level Job
  update; finalize refuses a never-started job; browser S3 grants on `reports/*`/`agreements/*`
  and browser delete on Customer/Job/Technician are gone.
- **R23, R26, R27** — the board can't rewrite history in either direction (unassign *and*
  assign, and the pool no longer offers COMPLETED/IN_PROGRESS stops); the office Complete
  confirm discloses the billing it starts, sharing sentences with Start billing; invite
  controls render only for OWNER with honest words for everyone else.
- **R29, R59, R60, R62** — /book re-checks live availability before charging; zone UNKNOWN is
  never priced; rodent/roach carry the Zone-B adder; day prices floor at variable cost.
- **R57, R58, R75** — HOA 101+ bimonthly is $230 (derived from the bracket series — **Jake to
  confirm against the Thumbtack spec**); the phantom $99 is gone and $15/$99 are unwhitelisted;
  the licensing gate fails closed on an unresolvable state.
- **R18** — Clarity removed; the privacy policy describes only practices that exist.
- **R77** — the `/schedule/:slug` resident signup page is deleted.
- **R81 (code half)** — hardcoded Buildium credentials removed from the sync script; **rotation
  at the vendor remains open and urgent** (the secret is still in public git history).

Residuals from this pass, tracked under existing IDs: the dashboard-refund leg of R13 needs the
`charge.refunded` webhook registration (R82, console); one dist rebuild must accompany the R18
deploy so the stale built Clarity tag can't ship.

**Funnel pass, `9d0add9`** (same verification discipline; suites 301 web / 114 CRM):

- **R01 closed** — public `/quote`, `/book`, `/cancel` pages exist, routed, and styled native to
  the site; every emailed URL now resolves. Verified live in-browser against the deployed
  staging API: real-time quote, live day pricing, checkout summary. Full pay→finalize→cancel
  loop to be re-verified after the next staging deploy (the terms contract ships with it).
- **R17 funnel half closed** — checkout renders the booking & cancellation terms above the pay
  button (unchecked-by-default acceptance); `/book` requires the acknowledged terms version and
  records version + server-stamped time + IP + user-agent on the booking; the 3-day constant is
  single-sourced into every rendered copy. The cross-document half (ToS says 24-hour, agreement
  says 30-day — Jake picks one policy per product line) remains open.
- **Launch-gate status for section B**: R29, R59, R60, R62 closed earlier today; R63 (LLM
  market-rate engine cut-vs-guard) remains Jake's decision — the funnel runs with it guarded by
  the daily research budget in the meantime.
- **Go-live console needs for the funnel**: `VITE_STRIPE_PUBLISHABLE_KEY` on the marketing
  app's hosting env; Turnstile (`TURNSTILE_SECRET` + widget) before ad spend if bot volume
  appears; production Stripe webhook registration (R82) before the funnel opens on main.

**AI pricing rearchitecture, `e734ee5` + `fe85d00`** (Jake's directive, 16 July: "absolutely
everything priced with AI — no other way is acceptable"; suites 364 web / 134 CRM):

- **R63 resolved by reversal**: the LLM market-rate engine is not cut — it is now the ONLY
  pricing engine. One cached research per service+area+size band returns a full rate sheet
  (one-time, extra nests, all plan cadences with initial fees, HOA per-unit by unit band);
  the funnel and the office/Thumbtack engine both price from it. Deterministic survivors, by
  Jake's explicit choice: the drive-time day-pricing overlay + zone adders (locked decision)
  and the variable-cost floor. **Clamps and review gates were explicitly declined — there is
  no upper price bound**; the compensating control is the new-rate office email plus the
  Market Rates console (full-sheet edit, pin/un-pin — a pinned override never re-researches).
- **HOA auto-quotes** — the every-HOA-lead-escalates-to-Jake policy is retired (this also
  resolves section C's "HOA auto-quote threshold": there is none; escalation remains only the
  research-failure fallback). The two-weeks-off test now passes by construction.
- **Plan templates retired** (Jake: "simpler is better; production never used") — model,
  screen, and mutation gone; quotes verify their baseline against the live AI sheet
  server-side with the deviation guard intact; agreement bodies come from the code template,
  closing R65's direction for the quote flow. R57's monotonicity suite retired with the
  hand-priced HOA card it kept honest. Rodent/roach's guard work from R63 is moot (the office
  override is now the pinned sheet, not a free-text bypass).
- Residuals now tracked: commercial + mosquito still price from their deterministic cards (no
  engine service kind yet); plan cadences and HOA rates carry no cost floor (no per-visit cost
  constants exist — noted on each rate row); CRM quotes don't apply the Zone-B travel adder
  the funnel applies (product decision needed); template pest photos on e-sign pages died with
  templates.

**Lead-form retirement, `cdc8c18`** (Jake's directive; suites 314 web / 114 CRM):

- The website lead form is gone everywhere (ContactForm + all three LP inline forms); the
  instant-quote funnel is the site's only intake, with the office phone as the second path. The
  funnel's CONTACT decision already covered every prospect type the form handled.
- First-touch ad attribution now rides the funnel: sanitized onto the BookingRequest and
  surfaced as the customer's `leadSource`/`leadNotes` at finalization — R73's raw material
  survives the form's removal.
- The lead-intake Lambda now has **zero site callers** — decommission it (and its Function URL)
  in a later deliberate pass; R80's "three lead notifications" reduces to the funnel's
  new-booking + needs-a-call alerts. The lead-form contract section of
  [public-ui-handoff.md](public-ui-handoff.md) is obsolete.
- Standing residual now more visible: two office phone numbers in the tree (401 vs 508) — R38's
  decision.

**Second pass, `00e26a8`** (same verification discipline; suites 262 web / 114 CRM):

- **R04, R06** — completed-but-never-charged one-time jobs and ACTIVE-plans-with-no-next-visit
  each get a Dashboard queue card and a daily digest that repeats until cleared; "All caught up"
  requires both empty.
- **R08 closed in full** — charge path checks work was performed server-side; covering-invoice
  scan paginates; idempotency key cycles per attempt (a retry can't replay a decline); voiding
  an OPEN invoice cancels its cancellable Stripe intent or honestly refuses mid-debit.
- **R21** — unstaffed visits (no route, route gone, deactivated tech) suppress the customer
  reminder and alert the office by the morning before.
- **R22** — Schedule board and tech day queries page to exhaustion.
- **R12** — report drafts persist locally on every edit, restore by content (not clocks), the
  sync badge never over-claims, and regained signal auto-sends unsent words.

---

## What "go-live" means

The public booking funnel opens to the market; the CRM runs daily operations with low-skill
staff; technicians run their day from the tech app; customers are charged, refunded, and
notified correctly; and the pesticide licence and payments compliance are protected.

The four rules every screen is graded against (unchanged from the July reviews, restated
because they are the acceptance criteria for everything below):

1. **A money button states the money before it moves.**
2. **If the label promises something, the code must enforce it.**
3. **Every real-world outcome gets a button, and the honest button is the easy one.**
4. **Failure lands in a queue somebody clears to zero, not in a log nobody reads.**

---

## A. Go-live blockers reachable today (engineering)

These run on flows that are live right now — office quoting, e-sign conversion, tech visits,
CRM billing. Grouped by what they protect.

### Money in

- **R04 — Every completed one-time job becomes a charge or a queue entry.** Completion calls
  `startBillingForPlan`, which exits immediately for anything that isn't a recurring-plan job
  (`crm-docs/handler.ts:700`); the only charge path is a per-customer button no worklist
  feeds. The recurring side has three backstops; the one-time side has zero — the Dashboard
  can read "All caught up" while completed, uncharged jobs exist. Work performed must never
  depend on someone remembering to press Charge. *(medium)*

- **R06 — Every ACTIVE plan always has a next visit, or the office is told.** The money
  direction (serviced-but-not-billing) has an email, a tile, and a daily digest; the service
  direction (billing-but-never-visited) has nothing, and `Dashboard.tsx:119-124` structurally
  excludes plan customers from "Needs attention." A customer paying monthly with no visit on
  the calendar is the highest-harm outcome in the system and a chargeback waiting to happen —
  and NO_ACCESS deliberately leaves a plan in exactly this state. One widened filter over data
  already in browser memory. *(small)*

- **R25 — No hand-typed price enters a live subscription unguarded.** The quote path got the
  deviation guard; "+ Plan" and "Convert lead" still take a free-typed monthly price straight
  into an ACTIVE plan (`CustomerDetail.tsx:1719`) — and billing now auto-starts on completion,
  so the $4-instead-of-$45 typo goes to the card with no human re-reading it. Same guard, same
  reason field, same actor stamp as `createQuote`. *(small)*

- **R26 — The office "✓ Complete" button discloses that it starts billing.** Its confirm says
  "the customer won't get a field report"; the server behind it may create a Stripe
  subscription and take the first monthly charge today. The dedicated Start-billing button
  spells all of that out; the button that now does the same thing by side effect must say the
  same words. *(small)*

- **R30 — A manual quote carries the initial fee and signing always creates the first
  visit.** `QuoteSheet` never sends `initialFeeCents` (the mutation already accepts it), so
  every phoned-in recurring quote silently drops the $99/$124 fee — and because job creation
  is coupled to the fee, signing dispatches nobody. Zero-fee plans (mosquito) can bill monthly
  with no visit ever queued and no queue catches it. Decouple the visit from the fee. *(small)*

- **R31 — An invoice raised for later payment can be settled.** `recordOfflinePayment` can
  only create an already-paid row; nothing marks an OPEN invoice paid when the check arrives —
  the only button an OPEN invoice offers is Void. The check-paying HOA/commercial segment
  additionally needs terms/due-date/PO and a send-invoice collection path; today a Stripe-
  dashboard invoice is silently dropped by the mirroring webhook, so the workaround corrupts
  the ledger. *(medium)*

- **R08 — Money fields change only through guarded server actions.** TECH holds model-level
  `update` on Job — including `priceCents`, `paidAt`, and `status` — so any tech token can
  make a job free or "already paid" via raw GraphQL with no audit row; and `chargeOneTimeJob`
  never checks job status server-side, so a NO_ACCESS or SCHEDULED job can be charged in full.
  The fryer timer goes in the fryer. *(medium)*

### Money out and the customer's view of money

- **R02 — Disputes, dunning, failed-payment recovery.** `charge.dispute.created` falls through
  to `default: break` — an unanswered dispute is auto-lost, ~$15 fee, counts toward the ratio
  that puts merchants in monitoring programs. Failed subscription invoices discard Stripe's
  real decline reason, email nobody, and the portal renders the debt read-only with no Pay
  button. Meanwhile `recurring.ts:57` keeps dispatching techs to non-paying customers because
  no plan state means "the card died." Every dollar that fails needs exactly one person told
  and exactly one button to fix it. *(large)*

- **R03 — A subscription dying at Stripe tells the office the same day.** The
  `customer.subscription.deleted` handler flips the plan and returns — no email, no retention
  queue entry, and it strands the already-queued next visit, which the Schedule pool will
  cheerfully route as a free service call while suppressing the one Dashboard card that could
  have caught the customer. Losing a recurring customer must never be a silent database
  update. *(small)*

- **R05 — Cancelling a plan resolves its queued visits, on every cancel path.** All three
  paths (office, customer self-cancel, Stripe webhook) leave the auto-queued next visit alive;
  reminders still fire, techs still dispatch, and the visit completes unbillable and silent —
  the not-billing digest scans only ACTIVE plans, so the free visit triggers nothing anywhere.
  *(small)*

- **R13 — Every charge and refund generates a customer notice.** The funnel's own emails
  prove the pattern (payment confirmation with amount; cancel email with refund amount and
  timing); the CRM and subscription paths — one-time charge, manual charge, monthly
  settlement, refunds from either origin — email nothing and set no `receipt_email`. A charge
  the customer can't recognize is a dispute; R02 makes disputes auto-lost. Wiring, not new
  capability. *(small)*

- **R19 — Cancelling or moving a paid/scheduled visit settles the money and tells the
  customer.** The office cancel is a bare `Job.update(CANCELED)` behind "Cancel this job?" —
  no refund per policy, no email, while the same row shows a "paid $299 online" badge.
  Reschedule and board-assign re-date visits silently. The rev-1 script stands: *"This visit
  was paid $299 on 7/12. It is 15 days out — cancelling refunds $299 in full. Continue?"*
  *(medium)*

- **R24 — "Mark inactive" actually stops service, or is blocked while a plan is live.** The
  red button a new hire will press when a customer says "stop my service" flips a status flag:
  the Stripe subscription keeps charging and the recurring engine keeps queueing visits,
  because nothing reads customer INACTIVE. *(small)*

### The licence: pesticide-record residuals

The record itself is now server-enforced and immutable — these are the last four gaps between
"much better" and "survives an MDAR inspector."

- **R09 — Application times are server-stamped.** `startedAt` is written by a plain client-side
  `Job.update` with a browser-supplied timestamp (any TECH token can rewrite it pre-finalize),
  and `applicationEndAt` is stamped at *finalize* time — a report written up the next morning
  records the wrong end time, the same defect class just fixed for the start. Also refuse
  finalize on a SCHEDULED job where `startedAt` is null. *(small)*

- **R10 — No record finalizes without an applicator licence number.** `licenseNumber` /
  `licenseExpiresOn` exist in the schema and are dead columns: no form writes them, no screen
  shows them, finalize never checks them, and the PDF silently omits the licence line when
  null — which today is always. Needs: an office input, a finalize gate, and an expiry
  warning. (The deploy note in `6297c0a` planned exactly this two-step; this is the second
  step, plus the ops half in section D.) *(small)*

- **R11 — Label facts are entered once by the office and prefilled, never recalled from
  memory.** `Product.defaultRate` and `reEntryHours` are dead schema fields: the office
  product form neither captures nor validates them (EPA format is checked only at finalize, on
  site, where the tech can't fix a catalog typo), picking a product carries neither rate nor
  REI, and **rate/dilution is uncapturable end-to-end** — the PDF's "Rate:" line is always
  absent. The re-entry interval is currently answered from the tech's memory of the label.
  *(medium)*

- **R15 — Legal-record artifacts survive the retention window.** Browser roles hold unused S3
  read+write grants on `reports/*` and `agreements/*` (a second write path that could overwrite
  finalized PDFs — remove it or version the bucket), and OFFICE can hard-delete Customers,
  Jobs, and Technicians that finalized records reference. *(small)*

- **R12 — A technician's typed report survives a dead battery and a dropped connection.** The
  entire report lives in React state; the service worker ignores cross-origin POSTs; there is
  no draft cache, no queue, no offline banner. This is the durability gap that *manufactures*
  compliance gaps: techs who lose work twice write reports at night, and night-written records
  carry wrong times. *(medium)*

### People and access

- **R07 — Offboarding exists.** There is no disable-user, no group removal, no sign-out
  anywhere in the tree. "Deactivate technician" flips a flag that hides the tech from the
  office while their login still resolves routes, the full customer table (including billing
  addresses and card metadata), and every report/agreement PDF via the staff bypass — and
  their assigned future jobs render on no office surface at all. A fired employee must lose
  access in minutes, and their jobs must surface for reassignment. *(medium)*

- **R27 — Every invite button an office employee can see works for them.** `adminCreateUser`
  is OWNER-gated (deliberately), but "Invite to portal," "Resend invite," and the
  new-technician invite checkbox render for all office staff and always fail server-side with
  a raw "Not Authorized" — training staff that errors are normal, and in the technician case
  leaving a half-created record. Gate the UI to who can actually do it, or add a narrow
  OFFICE-safe path. *(small)*

### Field operations and dispatch

- **R20 — NO_ACCESS creates office work that can actually be executed.** The honest exit now
  exists for the tech; the office half doesn't. The email says "rebook it, charge a no-access
  fee, or let it go," but the linked screen renders no reason, note, or photo; the door photo
  is **unviewable through any code path in the tree** (`getDocumentUrl` rejects `jobs/` keys);
  rebooking has no guarded control (board Assign silently erases the exception status); and
  from the next day the job appears on no operational surface. An email is not a queue.
  *(medium)*

- **R21 — No customer reminder for a visit nobody is staffed to make.** The reminder cron
  filters on status alone; jobs assigned to a deactivated tech, or dated with no route, still
  email "BuzzKill is scheduled to visit tomorrow." By the evening before, every dated job is
  on an active tech's route or the office is told. *(medium)*

- **R22 — Job-list queries paginate.** The Schedule pool and the tech's day view each read one
  filtered scan page (limits 500/200, filter applied post-scan, no routeId index); past that,
  stops silently vanish from the board and the truck. The `listAll` helper exists and is used
  by six other screens. *(small)*

- **R23 — The Schedule board can't rewrite job history.** Unassign (✕) acts on any stop,
  including COMPLETED (finalized report, billing started) and IN_PROGRESS (tech on site),
  flipping it back to UNSCHEDULED unconfirmed — status is what billing, the recurring engine,
  and the pesticide record all key off. *(small)*

- **R28 — The tech knows what the business knows at the doorstep.** The tech job screen
  renders service type, window, address, phone, and machine-generated notes; `Customer.notes`
  (gate codes, pets, "aggressive dog") is TECH-readable in the model and never rendered, and
  the office job form has no instructions input. A tech arriving blind is a preventable
  NO_ACCESS or a safety incident. *(small)*

### Contracts, policy, privacy — the live halves

- **R17 — One cancellation policy, one source, four readers.** Live today: the published ToS
  says 24-hour notice while the agreement template says 30 days — and clause 5 of the same
  contract says bare "written notice." (The funnel's 3-day rule and checkout disclosure are
  gated behind section B, but the constant is duplicated in two Lambdas already.) Ambiguity is
  construed against the drafter; pick one policy per product line, define it once, import it
  everywhere. *(medium)*

- **R16 — Online enrollment gets online cancellation (ROSCA).** Customers enroll in recurring
  billing via an emailed e-sign link today, and no electronic stop mechanism exists anywhere —
  the portal's only actions are card updates; `cancelSubscription` is OWNER/FINANCE-only. The
  FTC's click-to-cancel expectation is simple: enrolled electronically → can stop
  electronically. *(medium)*

- **R18 — The privacy policy describes only practices that exist; session replay is consented
  or gone.** Clarity records every visitor (including lead forms where people type name,
  phone, address) with no consent gate, while the policy promises a cookie banner that doesn't
  exist, an unsubscribe link no email carries, and a full SMS program with zero SMS capability
  in the tree. The cheapest compliant posture is to pull the tag until the site overhaul ships
  its banner; at minimum, cut the false sections. This page is where paid ads send
  Massachusetts consumers. *(small)*

---

## B. Go-live blockers gated on opening the funnel

The funnel backend is built and tested; nothing links to it (`bookingApiUrl` has zero
consumers). These must land **with or before** the public pages — they have no live victims
today and become live the moment `/book` ships. The separate engineer who owns the public UI
should treat this list as the integration contract, alongside
[public-ui-handoff.md](public-ui-handoff.md).

- **R01 — The public `/book`, `/quote`, and `/cancel` pages exist and every emailed URL
  resolves.** The confirmation email already links `/cancel?token=…`, which no route serves;
  the funnel's only customer-reachable refund path sits behind that dead link. A customer who
  can't cancel the way their receipt says will use the bank's dispute button instead. *(large)*
- **R29 — `/book` re-checks live availability before taking money.** Booking validates only
  against the 24-hour-old quote snapshot; every holder of a live quote can book the same last
  slot. Re-read the day, re-run capacity/feasibility, return "day no longer available" —
  honoring the quoted price, not repricing. (Verification note: do **not** cut the
  route-minutes feasibility block or the route-density modifier as rev-1 suggested — both
  implement Jake's locked drive-time capacity/pricing decision.) *(small)*
- **R17 (funnel half) — the checkout renders the cancellation policy above the pay button and
  records the acknowledged version, timestamp, IP, and user-agent.** Today `/book` requires
  `tcAccepted: true` while no response ever carries any terms — an acceptance of nothing.
- **R59 — Zone UNKNOWN never produces a bookable price.** A Routes-API outage or expired key
  currently reprices the whole funnel as Zone B silently; route UNKNOWN to the existing
  callback path and alert the office. (The office-side pricing path already handles UNKNOWN
  correctly — the gap is only in `booking-public`.) *(small)*
- **R60 — Rodent/roach quotes carry the Zone-B adder** like general pest and wasp already do;
  an 89-minute drive must not price like a 10-minute one. *(small)*
- **R62 — Day-price discounts floor at cost, not at 85% of list.** A Zone B rodent quote at
  the $199 clamp floor discounts to $169 against ~$236 of variable cost — a guaranteed loss on
  every discounted booking of that shape. Reuse `oneTimeGrossProfitCents`, adding the missing
  service→cost-kind mapping so the floor actually binds. *(small)*
- **R63 — Decide the LLM market-rate engine: replace with rate-card rows, or guard it.** Jake
  has priced rodent and roach by hand for years; hand-priced sqft-banded rows are cheaper,
  instant, consistent, and explainable. If it stays: clamp the office override (it currently
  bypasses the $199–$2,500 clamp entirely via a free-text money field) and fix the `tidy()`
  wasp-band floor dip. *(medium)*
- **Public-site truth items** (owned by the site overhaul, per
  [public-ui-handoff.md](public-ui-handoff.md)): the Customer Login links point at
  decommissioned FieldRoutes (needs `VITE_PORTAL_URL`); four pages advertise self-service that
  doesn't exist; statistics and licence-status claims need sourcing or removal.

---

## C. Decisions only Jake can make

No further review resolves these. Two of them block work that is otherwise ready.

1. **R32 — Does a seasonal plan bill six months or twelve?** *(Blocking — reachable today.)*
   The office can sell "Mosquito plan (May–Oct)" right now as an open-ended monthly
   subscription with no end condition; the recurring engine will queue a November visit after
   the October completion. Charging $139 in January for a winterless service is a guaranteed
   refund demand every winter. Either answer is defensible; `ServicePlan` needs the end/season
   condition either way.
2. **R33 — Does a no-access fee exist, and how much?** The NO_ACCESS office email invites
   "charge a no-access fee"; no customer document mentions one. First use is an undisclosed
   charge on a stored card — chargeback plus MA 93A exposure. Decide, then either put it in
   the agreement and checkout terms with an amount, or stop inviting the office to charge it.
3. **R34 — What is the true loaded labour rate, and what is the drive convention?**
   `LABOR_PER_HR = 42` with no burden factor (loaded pest-control labour runs 1.25–1.4× bare),
   one drive leg per job. The 3× lead-fee test — the only automated profitability gate — runs
   on these constants today for every priced Thumbtack lead. Name the numbers; engineering
   documents the basis in one constants file.
4. **HOA auto-quote threshold.** The rate card prices associations correctly and the
   escalation email now includes the computed quote — but *every* HOA lead still escalates to
   Jake by policy (`rateCards.ts:198-199`). Name the contract value above which Jake must
   personally look, and everything below it quotes same-day without him. This is the
   two-weeks-off item.
5. **R35 — What is the add-a-service-at-the-door channel?** A tech-screen control feeding an
   office queue, or a documented call-the-office process — Jake picks the scope. What cannot
   stand is on-site upsell requests living in the tech's memory.
6. **RI licensure question** (from the site handoff): do technicians hold RI applicator
   licences, or only the company registration? The city pages currently claim the former.

---

## D. Console and process gates (no code, or one flag flip)

- **R81 — Rotate the Buildium client secret. Today.** It is hardcoded in
  `apps/web/scripts/sync-buildium.ts:23` and has been in the history of the **public** GitHub
  repo since April. Rotation at the vendor is the only real fix; deleting the fallback line is
  the trivial second step. This credential fronts a partner system holding HOA resident PII.
- **R82 — Verify the Stripe webhook registrations include `charge.refunded`.** Both live and
  test endpoints were registered 2026-07-14 with six events — before the handler gained
  `charge.refunded`. Without it, every dashboard-issued refund counts as revenue forever.
  Update the six-event list in [crm-setup.md](crm-setup.md) in the same pass, and register
  the main-branch webhook when main's backend deploys (none exists yet).
- **Complete the Stripe billing smoke test.** Per [crm-setup.md](crm-setup.md) the
  SetupIntent → Start billing → charge → webhook-settlement path has never been exercised with
  real keys (staging = test mode, `4242` works there). Go-live on an untested money path is
  not go-live.
- **Enter every technician's applicator licence number, then flip the finalize requirement
  on** (pairs with R10 — the deploy note in `6297c0a` explicitly stages this two-step).
- **R83 — Provision a second OWNER.** The product fully supports it (More → Invite → role
  "Owner"). With one OWNER account, staff provisioning and any charge over $5,000 block on
  Jake's login being reachable. Document the AWS-CLI break-glass path in crm-setup §5.
- **Set `VITE_GOOGLE_MAPS_API_KEY` on the CRM app** (reserved to Jake) and rebuild — address
  autocomplete is degraded until then.
- **R80 — Stand up the sales@ lead inbox** and route the three lead notifications plus the
  new-booking alert to `SES_LEADS_EMAIL`; money/ops alarms stay on info@. If SES is still
  sandboxed, verify sales@ as a recipient first or lead alerts silently vanish. *(Small
  engineering change + mailbox setup; the notification email address is currently info@ for
  everything.)*
- **Custom domain / `CRM_APP_URL`** when the CRM gets its real domain — it is baked into
  agreement links, portal links, and invite emails.

---

## E. Required before scale — not go-live gates

Ranked within group. Everything here was code-verified this round; none of it has a live
victim big enough to hold the launch, and all of it compounds with customer count.

### Money visibility and growth (the CEO's screen)

- **R36 — Dashboard states contracted MRR and dollars-at-risk**, plus lifetime-paid on the
  customer record. "Active plans with no subscription, in dollars" is the report Stripe
  structurally cannot produce. *(small)*
- **R51 — Operational KPIs**: jobs completed by tech, no-access rate, lead→customer
  conversion. Lead outcomes never move automatically today (everything stays PENDING), so the
  Thumbtack-ROI question remains unanswerable — pairs with R73. *(medium)*
- **R73 — Attribution closes its own loop**: enum the lead source, auto-flip pricing runs to
  WON on convert/sign/finalize, sum lead-fee spend vs won revenue by source. All schema fields
  already exist; the fix is writes plus a group-by. *(medium)*
- **R72 — Quotes don't rot**: "Quotes waiting" card, 2-day/7-day follow-ups on the existing
  cron, EXPIRED/DECLINED statuses — and a reader for the agreement `viewedAt` timestamp, the
  single best follow-up cue, currently read by nothing. *(medium)*
- **R71 — Prices can be raised on existing customers**: re-price in place with an explicit
  proration choice, plan record and Stripe updated together, audit row, advance notice — and
  the agreement template needs a price-change clause (its 30-day term covers cancellation
  only). Today the only path is cancel-and-recreate, which double-charges inside a paid month.
  *(medium)*
- **R52 — Month-end close**: invoice/refund registers and AR aging as files for a fixed
  period; refunds currently restate closed months silently. *(medium)*
- **R49 / R50 — Money actions answer "who did this" on screen.** Actor stamps are already
  captured tamper-proof on every charge, refund, and void — and read by nothing; likewise
  `priceOverrideReason` has zero readers, so pricing governance is a write-only text field.
  Render them. *(small)*

### Retention and the customer's side

- **R69 — Cancellation reason + pause-first retention.** One cancel action all paths route
  through, required reason picker, pause offered first; cancel is currently a one-way door
  whose recovery re-triggers the $99 fee decision. *(small)*
- **R68 — Callbacks modeled.** Clause 4 of every signed agreement promises free re-treatment;
  a covered re-visit is currently unlabeled, unlinked, and the New-job form defaults to
  "billed separately" — charging a covered customer is the default failure mode. A zero-priced
  CALLBACK type with an `originalJobId` link also unlocks the callback-rate quality metric.
  *(medium)*
- **R37 / R38 / R39 — The customer hears from the system**: a no-access visit notifies the
  customer (today: reminder yesterday, silence today, surprise fee later — and the portal
  hides NO_ACCESS jobs entirely); every surface carries a real phone number (two different
  numbers exist in the tree today, neither shown to customers); phone-only customers stop
  silently receiving nothing — a no-email customer's pesticide record is currently
  undeliverable and nobody is told, while the tech app still says "emailed to the customer."
  *(small/medium)*
- **R41 / R40 — The portal is reachable and worth reaching**: provision access automatically
  at conversion or stop asserting it in emails (the service-report email promises "your
  BuzzKill portal" to customers who were never invited); the HOA group view gains documents
  and amounts — the entitlement layer already authorizes it, the screens never ask. *(medium)*
- **R42 / R48 — No dead ends in customer flows**: the sign page claims "a copy has been
  emailed" unconditionally (return and branch on the real send flag; offer a download link);
  the payment-request email goes only to customers who can sign in, and its link lands on the
  billing screen (today it points at a route that doesn't exist). *(small)*

### The technician's day

- **R43 — Prior-visit history at recurring stops** — products, areas, no-access history, and
  the previous tech's notes; today `techNotes` is a write-only channel nobody can ever read.
  *(medium)*
- **R44 / R45 / R46 / R47** — "Start job" fails visibly (a silent failure currently costs the
  legal application-start stamp); a NO_ACCESS stop stays on the day list as the tech's proof
  of attendance instead of vanishing; a derived one-line payment expectation at the door
  ("Paid online — collect nothing" / "Covered by their plan" / "Office bills after"); and the
  unlinked-login empty state points at a flow that actually exists. *(all small)*

### Dispatch

- **R55 — The dispatcher sees the week**, per-tech load across days, pool ordered
  oldest-due-first with overdue flags — the recurring engine's design assumes "the office
  places it on the most route-efficient nearby day," which is currently a memory task.
  *(medium)*
- **R56 — No dispatch without a service address** — today the first person to learn the
  address is missing is the tech, mid-route. *(small)*
- **R67 — Sick-day handling**: an unavailability record, orphaned stops surfaced as "needs
  re-assignment," reminder suppression, one-action route move, and Deactivate blocked while
  future work is assigned. (FieldRoutes had this; its absence is a regression the office will
  hit weekly.) *(medium)*
- **R70 — Payroll time records**, if techs are W2 hourly: clock in/out on My Day. In an hours
  dispute the burden falls on the employer who kept no records. *(medium)*

### Pricing correctness (office paths, live)

- **R57 — Fix the HOA 101+ bracket inversion** (quarterly must never cost more than bimonthly;
  the per-unit series says the bimonthly cell is the anomaly — likely ~$230, not $150 — check
  the Thumbtack spec) and add the monotonicity test; crm-pricing has no test file at all.
  *(small)*
- **R58 — Stop quoting a $99 initial fee on mosquito plans that have none** (the fallback
  template hardcodes it, in writing, on the guaranteed path), and remove "$15"/"$99" from the
  price-guard whitelist — the exact literals it exists to catch. *(small)*
- **R75 — The MA/RI licensing gate fails closed.** A lead with no extractable state currently
  skips the gate entirely, then geocodes as "<town>, MA" — Hartford, Nashua, and Brattleboro
  are all within the 90-minute zone check. Unresolvable state → NEEDS_INFO, never QUOTE.
  *(small)*

### Governance and compliance hardening

- **R65 — The agreement body stops being a free textarea** — template-locked, versioned; today
  any office user can rewrite binding terms freehand and send, and the server accepts
  arbitrary `bodyText` from any caller. *(medium)*
- **R66 — Technician data scoping**: per-customer entitlement instead of the staff bypass on
  documents, TECH customer-read scoped to assigned work, billing/card metadata stripped, and
  the `reports/*` TECH S3 write grant removed. Pairs with R07 — until both land, every current
  and former tech token holds the whole book of business. *(medium)*
- **R54 — E-sign consent evidence**: the signing POST carries the consent the PDF asserts
  (today the checkbox dies in the browser). Verification note: signer-email verification is
  *not* needed — token delivery to the email on file is the standard e-sign identity
  mechanism. *(small)*
- **R53 — CAN-SPAM readiness before the first commercial email** (the planned quote-chasers
  qualify): postal address in the shared shell now, suppression/opt-out before the first send.
  *(small)*
- **R74 — Email honesty**: send first, stamp SENT second (an agreement whose email failed
  currently reads SENT); surface the send flag on the two CustomerDetail paths that ignore it;
  make the email log newest-first with the stored error shown and a resend button. *(small)*
- **R78 — Escalations become a queue with an SLA**, not an inbox — and the escalation email
  can currently fail with zero signal while the screen promises a callback. *(small)*
- **R79 — Geofence the GPS stamp** against the geocoded service address with an accuracy
  floor; the honest-disclaimer wording already shipped, the measurement was explicitly
  deferred. *(medium)*

---

## F. Cut list

- **R77 — Remove the live `/schedule/:slug` resident signup page today.** Graded CUT with
  negative value in July; it is still routed, still submitting to lead-intake for 64 real
  property slugs, and it bypasses pricing and HOA escalation. One route deletion.
- **R63 — The LLM market-rate engine** is the other CUT candidate; decision framed in
  section B.
- **Do not cut** (verified as deliberate design this round): the drive-time capacity and
  day-pricing machinery (Jake's locked decision), monthly billing for all plan cadences, and
  the OWNER-gating of staff provisioning.

---

## G. Refuted in verification — do not build

Four findings from this round's perspective reviews died under adversarial verification.
Recorded so they are not re-raised or acted on:

1. **"Card-on-file charges lack authorization records."** Refuted: Stripe's PaymentElement
   with the SetupIntent flow already presents and records the off-session mandate; the
   integration is correct as built.
2. **"The rodent add-on must scale with visit frequency."** Refuted: flat $15/mo across
   cadences is a defensible pricing choice, not a defect. Pricing strategy belongs to Jake,
   not the bug tracker.
3. **"The 3× lead-fee gate must cover recurring plans."** Refuted on evidence, premise, and
   remedy: recurring leads passing the gate is deliberate loss-leader economics; the gate
   exists for one-time jobs.
4. **"Technicians can write the pesticide catalog."** Stale: TECH `create` on Product was
   removed in `6297c0a`.

Standing from July, still binding: **quarterly plans billing monthly is correct by design**
(the "overcharging" reading inverts it, and "fixing" it would cut that revenue by two thirds);
`adminCreateUser`'s group authorization is enforced by AppSync, not the handler.

---

## Requirements register

| ID | Gate | Owner | Size | Requirement |
|----|------|-------|------|-------------|
| R01 | B | engineering | L | Public /book, /quote, /cancel pages; every emailed URL resolves |
| R02 | A | engineering | L | Disputes handled; dunning emails with real decline reason; portal Pay/Retry; suspend after N failures |
| R03 | A | engineering | S | Stripe-side subscription death → same-day office signal + visit cleanup |
| R04 | A | engineering | M | Completed one-time job → charge or visible queue entry |
| R05 | A | engineering | S | Plan cancel resolves queued visits on all three paths |
| R06 | A | engineering | S | ACTIVE plan with no next visit → Dashboard tile + digest |
| R07 | A | engineering | M | One-action offboarding: login dies, jobs surface for reassignment |
| R08 | A | engineering | M | Money fields server-guarded; charge path checks job status |
| R09 | A | engineering | S | Application start/end times server-stamped; no finalize on never-started job |
| R10 | A | engineering | S | No pesticide record without a licence number; entry screen + expiry warning |
| R11 | A | engineering | M | Label data (rate/dilution, REI, EPA) office-entered, validated, prefilled |
| R12 | A | engineering | M | Report drafts survive offline: local persist, queued send, banner |
| R13 | A | engineering | S | Every charge and refund emails the customer a notice |
| R15 | A | engineering | S | Remove browser S3 write grants; protect records from deletion |
| R16 | A | engineering | M | Online enrollment → online cancellation (ROSCA) |
| R17 | A/B | engineering | M | One canonical cancellation policy, four readers; checkout renders + records acceptance |
| R18 | A | engineering | S | Privacy policy truthful; session replay consented or removed |
| R19 | A | engineering | M | Cancel/move of paid or scheduled visit settles money + tells customer |
| R20 | A | engineering | M | NO_ACCESS office queue; guarded rebook; viewable door photo |
| R21 | A | engineering | M | No reminder for unstaffed visits; gap surfaced as work |
| R22 | A | engineering | S | Schedule pool and tech day queries paginate |
| R23 | A | engineering | S | Board can't unassign COMPLETED/IN_PROGRESS jobs unguarded |
| R24 | A | engineering | S | Mark-inactive stops service or is blocked while plan live |
| R25 | A | engineering | S | Plan-creation prices get the deviation guard |
| R26 | A | engineering | S | Office Complete confirm discloses billing start |
| R27 | A | engineering | S | Invite buttons work for whoever sees them |
| R28 | A | engineering | S | Customer notes reach the tech; per-job instructions input |
| R29 | B | engineering | S | /book re-validates live availability before charging |
| R30 | A | engineering | S | Manual quotes carry initial fee; signing always creates first visit |
| R31 | A | engineering | M | OPEN invoices settleable; terms/PO/aging for check-paying accounts |
| R32 | C | Jake | S | Decide: seasonal plan bills 6 or 12 months; add end condition |
| R33 | C | Jake | S | Decide: no-access fee existence, amount, disclosure |
| R34 | C | Jake | S | Decide: loaded labour rate + drive convention; document constants |
| R35 | C | Jake | M | Decide: add-a-service-at-the-door channel |
| R36 | E | engineering | S | Dashboard MRR + dollars-at-risk + lifetime-paid |
| R37 | E | engineering | S | Customer notified when a visit doesn't happen |
| R38 | E | engineering | S | Real contact number on every customer surface; written-notice intake |
| R39 | E | engineering | M | Phone-only customers: acknowledge or serve; failed record delivery alerts |
| R40 | E | engineering | M | Group portal shows documents and amounts per property |
| R41 | E | engineering | M | Portal access auto-provisioned or emails stop asserting it |
| R42 | E | engineering | S | Sign page claims email only when sent; offer download link |
| R43 | E | engineering | M | Prior-visit history for techs; no write-only note fields |
| R44 | E | engineering | S | Start-job failures visible |
| R45 | E | engineering | S | NO_ACCESS stop stays on the tech's day list |
| R46 | E | engineering | S | Derived payment-expectation line on tech job screen |
| R47 | E | engineering | S | Tech login linking discoverable; empty state points at real flow |
| R48 | E | engineering | S | Payment-request email only to portal-capable customers; link works |
| R49 | E | engineering | S | Charge/refund/void actor rendered on invoice rows |
| R50 | E | engineering | S | Price-deviation review list (who, how far, why) |
| R51 | E | engineering | M | KPIs: jobs by tech, no-access rate, lead conversion |
| R52 | E | engineering | M | Month-end registers + AR aging exports; no silent restatement |
| R53 | E | engineering | S | CAN-SPAM: postal address now, opt-out before first commercial send |
| R54 | E | engineering | S | E-sign consent captured on the POST, stored on the Agreement |
| R55 | E | engineering | M | Week view: per-tech load, oldest-due-first pool, overdue flags |
| R56 | E | engineering | S | No dispatch without a service address |
| R57 | E | engineering | S | Fix HOA 101+ bracket inversion + monotonicity test |
| R58 | E | engineering | S | No phantom $99 on mosquito replies; unwhitelist $15/$99 in the guard |
| R59 | B | engineering | S | Zone UNKNOWN → callback path + office alert, never a price |
| R60 | B | engineering | S | Rodent/roach funnel quotes carry Zone-B adder |
| R62 | B | engineering | S | Funnel day-price discounts floor at cost |
| R63 | B | engineering | M | Decide cut-vs-guard on LLM market-rate engine; clamp office override |
| R65 | E | engineering | M | Agreement body template-locked and versioned |
| R66 | E | engineering | M | Tech data scoped to assigned work; strip billing metadata |
| R67 | E | engineering | M | Tech availability/sick-day handling with reassignment surfacing |
| R68 | E | engineering | M | CALLBACK job type; covered re-visits labeled; callback-rate metric |
| R69 | E | engineering | S | Cancel reason picker; pause offered first; churn tile |
| R70 | E | engineering | M | Payroll time records (clock in/out) if W2 hourly |
| R71 | E | engineering | M | In-place price change with notice, audit, matched displays |
| R72 | E | engineering | M | Quote expiry/decline statuses; follow-ups; VIEWED gets a reader |
| R73 | E | engineering | M | Source enum; auto-WON; spend-vs-won by source |
| R74 | E | engineering | S | Send-then-stamp; surface send failures; usable email log |
| R75 | E | engineering | S | Licensing-state gate fails closed |
| R77 | F | engineering | S | Remove live /schedule/:slug signup page |
| R78 | E | engineering | S | Escalation queue with SLA; no silent send failure |
| R79 | E | engineering | M | Geofence the GPS stamp vs service address |
| R80 | D | engineering | S | Lead + booking notifications → SES_LEADS_EMAIL (sales@) |
| R81 | D | Jake | S | Rotate committed Buildium secret (public repo) — today |
| R82 | D | Jake | S | Verify webhook events include charge.refunded; register main webhook |
| R83 | D | Jake/ops | S | Provision second OWNER; document break-glass |
| — | D | Jake/ops | S | Stripe live billing smoke test; licence numbers entered then required; Google Maps key on CRM; sales@ verified in SES; CRM_APP_URL on real domain |

Gate key: **A** = blocker, reachable today · **B** = blocker, lands with the funnel/site
overhaul · **C** = decision only Jake can make · **D** = console/process, no meaningful code ·
**E** = before scale, not a gate · **F** = cut.

*(R14, R61, R64, R76 were refuted in verification — see section G. There is no R84+.)*

---

## The test that should decide go-live

Not the register — this paragraph. A CSR hired Monday takes a cancellation call Tuesday and
reads the refund amount off the screen. A tech at a locked door taps two buttons and drives
on, and the office can see the photo. A dispute email from Stripe lands in a queue with a
deadline, not in spam. Jake names three numbers (season, labour, HOA threshold), takes a week
off, and no quote waits for him. Every pesticide record carries a licence number an inspector
can read. When those sentences are true, ship it.
