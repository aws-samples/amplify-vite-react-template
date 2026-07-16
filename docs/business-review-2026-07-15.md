# BuzzKill — business review of the CRM & booking funnel

**Revision 5** — updated against `31fd0aa` and `8dbca55` ("Refunds exist") · 15 July 2026

Revision 1 reviewed the app from ten perspectives: 149 features, 116 findings confirmed against code, 35 gaps verified absent. Each revision re-checks the list against the tree after a commit lands, so the work burns down.

---

## Retraction: review item #6 was wrong

**Item #6 claimed that quarterly and bimonthly plans are "billed twelve times a year — systematic overcharging." That is false, and the engineering team was right to refuse it.**

The rate card returns `monthlyCents`. `$45` for a quarterly residential plan is **forty-five dollars per month**; "quarterly" describes how often a technician visits, not how often the card is charged. `rateCards.ts:7` says so in its own worked example, and `bookingFinalize.ts` discloses it to the customer in those words. Had it been actioned, quarterly recurring revenue would have fallen by roughly two thirds.

It is now guarded by tests rather than by a comment. I reintroduced the bug myself against the tree and the suite failed exactly two tests, by name. **Item #10 carried the same error class**: my "$834/yr overcharge" figure assumed a mosquito plan *should* bill only May–October, which I never verified, and it is withdrawn. The provable defect stands — `ServicePlan` has no end condition, so the plan bills indefinitely, and whether a seasonal plan bills six months or twelve is encoded nowhere.

Where the burn-down and the retained Revision 1 analysis disagree, the burn-down is correct.

---

## Burn-down

The three residuals Revision 4 raised are **all closed**, verified against the tree:

| Residual | Now | How I checked |
|---|---|---|
| Three `notifyOffice` implementations | **CLOSED** | Exactly one definition remains, in `shared/email.ts`. The local copies and `lead-intake`'s raw SES client are gone, along with its silent `info@` fallback. Lead alerts now write `EmailLog` rows like every other send — they bypassed it entirely before. |
| The cancellation-date write sits outside the `try` | **CLOSED** | Guarded. They went further than the finding: Amplify *resolves* errors rather than throwing, so the unguarded call had two failure modes and handled neither. Both handled. Deliberately non-fatal, and when the cancellation also fails the alert now says the date was not saved — at that point the email is the only record of it. |
| `apps/crm` has no test harness | **CLOSED** | vitest stood up; `npm test` runs before `npm run build` in the CRM's own CI phase (`amplify.yml:32`). |

The fifteen:

| # | Item | Status |
|---|---|---|
| 1 | Recurring plans never start billing | **CLOSED** |
| 2 | "Internal notes" on customer PDF | **CLOSED** |
| 3 | Paid bookings look unpaid; CRM re-charges | **CLOSED** |
| 4 | Cancellation policy / refunds | **PARTIAL** — *the live half is closed: refunds exist.* The three-way policy conflict remains, and is a launch gate. |
| 5 | Cancelling never stops Stripe | **CLOSED** |
| 6 | ~~Quarterly plans billed 12×/yr~~ | **RETRACTED** |
| 7 | Service report is not a valid MA pesticide record | **PARTIAL** |
| 8 | Booking funnel has no front end | **DEFERRED** |
| 9 | No dunning; no dispute handling | **OPEN** — `charge.refunded` landed; `charge.dispute.created` did not. |
| 10 | Mosquito plans never stop | **OPEN** |
| 11 | Free-text prices; no audit trail | **PARTIAL** |
| 12 | One tap charges $20,000, no confirmation | **PARTIAL** — *and newly urgent, see below.* |
| 13 | Cost model: one-way drive, bare wage | **OPEN** |
| 14 | Technician has no honest option at a locked door | **OPEN** |
| 15 | You are still the pricing department | **PARTIAL** |

**Closed: 4. Retracted: 1. Partial: 5. Deferred: 1. Open: 4.** Suite: 76 tests, all passing (65 web, 11 CRM). I ran them.

---

## What these two commits got right

**The refund is the best-engineered thing in this codebase.** Partial refunds accumulate on `refundedAmountCents` and the invoice only flips to `REFUNDED` on the last cent, so a partly refunded invoice stays `PAID` and every revenue figure nets the refund out instead of filtering on status. Over-refunding throws. A reason is required and stored. Offline invoices refund without calling Stripe, because no card was ever charged — the same charge-versus-record split the product already makes.

**The idempotency key is the detail that shows the care**: `crm-refund-<invoiceId>-<alreadyRefunded>-<requested>`. A double-tap refunds once; a deliberate *second* partial refund has a different running total and goes through. Getting both halves of that right is not obvious.

**`charge.refunded` catches dashboard-issued refunds**, which is what made the money invisible in the first place, and it takes Stripe's `amount_refunded` as the *total* rather than adding to ours — so a replayed webhook converges instead of doubling, and it will not overwrite a reason a CSR already gave.

**It throws instead of returning an outcome, and says why.** Job completion must not fail because no card is on file; a refund has a person waiting for an answer, and one that did not happen must not look like one that did. When the money goes back but the ledger write fails, the error names the invoice and says to reconcile by hand. That is the single case where the customer has their money and the CRM still counts it as revenue, and it is called out rather than buried.

**Revenue arithmetic became a pure module** (`apps/crm/src/lib/revenue.ts`) specifically so this review's acceptance criterion could be tested. Reintroducing the original bug — counting a `PAID` invoice in full regardless of refunds — fails three tests.

**And for the third time, they reported a bug in their own work that nobody asked about**: a test fixture swapped in a failing update and never restored it, so three later tests were passing against the wrong mock. A team that volunteers that is a team whose green suite means something.

## What `8dbca55` leaves open

**1. Giving money back is now the best-guarded action in the product. Taking it is still the worst.**

This is the finding, and it is the direct consequence of building the undo before the guard.

| | Refund | Charge |
|---|---|---|
| Confirmation | Two-step, restates the amount and who it goes to | **None.** `chargeOneTimeJob` goes straight to the mutation (`CustomerDetail.tsx:654`) |
| Reason | **Required** and stored (`refundReason`) | Optional (`description: a.string()`) |
| Ceiling | The invoice's outstanding balance | **$20,000** (`crm-billing/handler.ts:276`) |
| Who | OWNER / FINANCE | OWNER / FINANCE |

A CSR who means $149.00 and types `14900` still charges $14,900 to a customer's card, instantly, with no dialog. What has changed is that a FINANCE user can now give it back — which is a real improvement, and it is why item 12 gets *more* urgent rather than less. The two controls now sit on the same screen, and the safer one is the one that does not move money out of the customer's account.

The precondition you set for fixing this — a test harness in `apps/crm` — was met by this very commit. **Commit I is unblocked and should go next.**

**2. A refund never clears `Job.paidAt`, so the row keeps saying the customer paid.**

`Job.paidAt` is written in exactly one place, `bookingFinalize.ts`. Nothing clears it. After a full refund of a booking's invoice the job row still shows the green *"paid $299 online"* badge (`CustomerDetail.tsx:617`), the Charge button stays hidden (`!j.paidAt`, `:644`), and `chargeOneTimeJob` refuses server-side (`crm-billing/handler.ts:194`). The badge asserts money that has gone back, and the only way to collect on that job afterwards is `chargeManualAmount` — the unguarded control from the row above.

Scope this honestly: only the funnel writes `Job.paidAt`, and the funnel is unreachable. **Launch gate, no live victims.** It is a small fix and it belongs with Commit L, not with a hotfix.

**3. The refund records *why* but not *who*.**

`refundReason` is required. `createdBy` still does not exist on any model in the schema — I checked, zero occurrences. So the product now compels an explanation for an action whose actor is unrecorded, which is a strange place for an audit trail to stop. It belongs to item 11 and it is two lines.

---

## Rank by reachability, not by severity

The public booking funnel **cannot be reached**. `bookingApiUrl` (`backend.ts:232`) has zero consumers in either app's `src/`, and `tcAccepted` — hard-required at `booking-public/handler.ts:523` — is produced by nothing in the repository. `finalizeBooking` has never run in production and cannot until the front end in `docs/public-ui-handoff.md` is built. The engineering team found this while verifying the reviews; I confirmed it independently.

That does not make the funnel's defects imaginary — they are launch gates. It makes them **defects with no live victims**, which is a different thing from an emergency.

**Bleeding today** — reachable through the office CRM and the tech app, both in daily use: the unguarded money screens (11, 12), the pesticide record (7), the technician with no honest option at a locked door (14), the cost model behind every Thumbtack quote (13), the escalation bottleneck (15), and dunning and disputes (9) — the office charges cards today, so a decline or a chargeback today still has nowhere to go.

**Launch gates, no live victims** — the dead cancel link, the checkout disclosure, the three-way policy conflict, capacity oversell, and the stale `paidAt` badge above.

Where this conflicts with the dollar rankings in Revision 1, reachability wins.

---

## How to whittle this down

Commits A through E are done. Four open items, five partials, one deferred.

**Commit I — "Operator-proofing the money screens"** · closes 11, 12, the residue of the retracted 6 · **next, and now unblocked**
A confirmation on charging that restates the amount in words and the card's last four — the same courtesy the refund already extends. A cap at what a BuzzKill job can plausibly cost, with the deferred approval UI above it. A required reason on a charge, matching the refund. `createdBy` on every Invoice and refund, stamped server-side. Recording an offline payment becomes a different screen with a different permission. A price that differs from the rate card requires a reason. **And the plan screen states the billing cadence in words — "$45 per month, technician visits every 3 months" — so no one repeats the mistake this review made.** The harness for all of it landed in `8dbca55`.

**Commit F — "Seasons, dunning, disputes"** · closes 9, 10
`charge.dispute.created` — an unanswered dispute is auto-lost, costs the amount plus a ~$15 fee, and counts against a ratio that puts you in a monitoring programme past ~0.75% of volume. A failed payment sends an email, retries, and creates a task; the portal grows a Pay Now button. Decide whether a seasonal plan bills six months or twelve, then encode it so `ServicePlan` stops on its own.

**Commit G — "The pesticide record is a record"** · closes 7 and the compliance cluster
Applicator licence number, application time, rate or dilution, re-entry interval. Products required to finalize. Re-finalize blocked and a FINALIZED report immutable at the model and on the server. GPS compared against the service address before the PDF asserts on-site presence. Remove `create` on `Product` from TECH, or route it through approval.

**Commit H — "The technician can tell the truth"** · closes 14
A no-access state that clears the screen without filing a report and without charging the customer. Small; removes the incentive to fabricate a legal record. Pair with G.

**Commit J — "Pricing integrity"** · closes 13 and the margin cluster
Round-trip drive, loaded labour, assumptions written down in one place. The 3× lead-fee gate applies to recurring plans on twelve-month contribution. Fix the HOA 101+ bracket by raising BIMONTHLY to about $220 — do **not** swap it with QUARTERLY, which would underprice your largest contracts by $1,080–$3,240/yr. Zone `UNKNOWN` must not silently price as Zone B. Discounts floor at cost, not at 85% of list.

**Commit K — "Delegate the pricing department"** · closes 15
HOA quotes below a threshold go out automatically; the rate card already computes them. Escalation becomes a queue with an owner and an SLA, and a failed escalation email is loud.

**Commit E2 + L — the funnel opens** · closes 4's remaining half, 8, and the stale `paidAt` badge
One cancellation policy in one place, read by the terms, the agreement template, the checkout disclosure and the enforcement code. Then the public `/book` and `/cancel` pages, per `docs/public-ui-handoff.md`. Nothing here has a live victim until the door opens, and all of it must be true before it does.

**Commit M — "Lead email goes to the sales inbox"** · *now a one-function change*

Lead-related notifications must be delivered to **`sales@pestbuzzkill.com`**, not `info@`. `31fd0aa` collapsed `notifyOffice` to a single implementation, so this is now one function with one fallback rather than three with three.

`SES_NOTIFY_EMAIL` is the recipient for every internal notification, hardcoded in `backend.ts:134` and `:155`. Its consumers are not the same kind of mail:

| Site | What it sends | Route to |
|---|---|---|
| `lead-intake` — new lead captured | A lead | **sales@** |
| `lead-intake` — "lead could not be saved" | A lead, about to be lost | **sales@** |
| `crm-pricing` — pricing escalation (HOA, termite, commercial) | A lead awaiting a quote | **sales@** |
| `booking-public` — new website booking | A won lead | **sales@** |
| `bookingFinalize` — invoice could not be written | A money alarm | ops |
| `crm-docs` — serviced plan failed to start billing | A money alarm | ops |
| `booking-public` — customer could not cancel | An ops alarm | ops |
| `booking-public` — website booking canceled | Operations | ops |

Add `SES_LEADS_EMAIL`, defaulting to `sales@`. Do not overload the existing variable; the point is that these are different audiences.

**The sender does not change.** `SES_FROM_EMAIL` stays `info@` — it is the verified SES sender and the From: address on customer mail. **If SES is still in the sandbox, `sales@` must be verified as a recipient first,** or every lead notification silently fails to send, which is the false-success class again. Update `docs/crm-setup.md:54` in the same commit.

Separately, belonging to the frozen public-UI work: the marketing site publishes `info@` in the footer, Terms, Privacy Policy, structured data, and on the Certificate of Insurance request link (`LicensedInsured.tsx:306`) — a property manager raising their hand, which is the highest-value inbound lead you get. Fold the decision into `docs/public-ui-handoff.md`.

---

_Sections below are Revision 1, retained as the evidence base. Items 1, 2, 3 and 5 are closed, item 4's refund half is closed, and item 6 is retracted; they are described below as open. The burn-down above supersedes them._

---

## Money: pricing, margin and revenue leakage

The pricing architecture is the best thing in this codebase and it should not be touched. The AI extracts facts, `apps/web/amplify/functions/crm-pricing/rateCards.ts` computes every dollar, and the model is structurally forbidden from inventing a price. Identical inputs produce identical prices. That decision was correct and it is worth defending.

Everything downstream of it leaks.

### The structural pattern

Costs are automated; revenue is manual. The van rolls, the labor bills, the chemicals get used, the visits auto-queue forever — all without human involvement. Every mechanism that turns work into money requires someone to remember to click something. That asymmetry, not any individual bug, is what this section is about.

### Revenue that never gets collected

**Recurring plans never start.** Covered as priority #1, but the arithmetic bears repeating: `startSubscription` has one caller, a button at `CustomerDetail.tsx:499`. Nothing prompts it, nothing reminds anyone, no completion path triggers it. Every forgotten click is $1,188/yr at the $99 monthly rate, and you keep paying to serve that customer. There is no report anywhere that lists ACTIVE plans with no `stripeSubscriptionId` — the exact query that would surface every instance of this.

**Manual quotes silently drop the $99 initial fee.** `QuoteSheet.tsx:78-89` creates a Quote with `priceCents` and `serviceFrequency` and no `initialFeeCents` at all. `convertQuote` gates the initial visit on `quote.initialFeeCents != null && > 0`. So a customer signs, converts with nothing on the schedule, nobody is dispatched, and $99 ($124 in Zone B) never bills. Every manually quoted recurring plan.

**Website revenue is invisible to the ledger.** `bookingFinalize.ts` writes no Invoice, so 100% of funnel cash — $299 wasp jobs, $300+ general pest, AI-priced rodent up to $2,499, every $99 initial fee — never appears on the Dashboard and cannot be reconciled against Stripe.

**Failed payments have no path back.** No dunning email, no retry, no task, no suspension, no portal payment button. The decline reason from Stripe is discarded. The entire system has exactly one scheduled job (`daily-reminders`), and it does not do this.

**Refunds and disputes leave no trace.** `REFUNDED` appears twice in the repo: the enum member and a badge color. No code path ever writes it. A refund issued from the Stripe dashboard — the only way an office user can issue one — leaves the Invoice PAID forever, so the Dashboard counts refunded money as revenue in perpetuity.

### Prices that are wrong

| What | Where | The problem |
|---|---|---|
| ~~Quarterly/bimonthly billed monthly~~ | — | **RETRACTED — this was wrong.** Plans are priced per month; "quarterly" is the visit cadence. Billing monthly is correct. See the retraction at the top of this document. |
| Mosquito plans never stop | no end date or season field on `ServicePlan` | The plan bills every month indefinitely — through the off-season and into following years. Whether a May–Oct plan should bill 6 months or 12 is encoded nowhere. *(The "$834 overcharge" figure previously stated here assumed 6-month billing and was never verified; it is withdrawn.)* |
| HOA 101+ bracket inverted | `rateCards.ts:160` | Bimonthly $150 vs quarterly $180 per 100 units. Past 301 units, quarterly costs *more* for two fewer visits. |
| $99 fee quoted where it doesn't exist | `rateCards.ts:314` | Mosquito plans have `initialFeeCents: null` by design, but the reply quotes $99 anyway — in writing. In Zone B the real fee is $124 and it still quotes $99. |
| Zone UNKNOWN prices as Zone B | `booking-public/handler.ts:378` | A Google Routes outage or expired key silently adds $25/mo plus $25 initial to *every* customer, including the ones five minutes from HQ. ~$325 in year one, charged to your closest customers. |
| Rodent/roach get no Zone B adder | `handler.ts:455` | `baseCents = rate.priceCents` with no zone term. An 89-minute job is priced identically to a 10-minute one. |
| Rodent add-on is flat $15/mo | `rateCards.ts:119` | Every other line scales with frequency. Monthly customers get 3× the bait-station service for the same money. |

### Margin math that doesn't survive contact

The cost model in `rateCards.ts:360-362` is `LABOR_PER_HR = 42`, `VAN_PER_MI = 0.3`, and `DRIVE = { A: { min: 40, mi: 30 }, B: { min: 65, mi: 45 } }`. Three problems compound:

1. **The drive is charged one way.** Zone A is *defined* as up to 50 minutes one way. The van comes back. Every one-time job's gross profit is overstated by roughly $37–$59.
2. **$42/hr is a bare wage, not loaded cost.** Add payroll tax (~7.65%), workers' comp (pest control is a high-rate class, often 4–8% of payroll), PTO and benefits, and the real number is 1.25–1.4× that. Nothing in the model carries overhead, vehicle depreciation, or insurance.
3. **The 3× lead-fee gate exempts recurring plans.** It fires only when `monthlyCents == null` (`crm-pricing/handler.ts:646`). Recurring is precisely where CAC exposure lives, because payback is spread across twelve months of thin visits instead of collected once.

The consequence: the only profitability screen you have on paid Thumbtack leads is fed inflated gross profit and skips the category that matters. Meanwhile the $99 initial fee — sold as covering a 75-minute first visit — actually costs $141.50 in Zone A and $160.50 in Zone B to deliver.

**Discounts have a percentage floor, not a cost floor.** `availability.ts:184` computes `Math.max(baseCents * 0.85, baseCents * factor)` — 85% of the rate card, which says nothing about whether that covers *this* job. Discounts stack to −20%. At the $199 rodent floor in Zone B, a discounted booking nets negative $67.

**An LLM sets prices inside a 12.5× band.** `marketRate.ts:16-20` clamps rodent and roach to $199–$2,500 and extracts the number from prose with a regex. That band contains both a guaranteed loss and a price no customer would accept, and the office override bypasses the clamp entirely.

### The rules engineering must implement

1. Completing the first visit of a plan starts the subscription. No human step. If it cannot start (no payment method), the plan lands in a queue somebody must clear — never silently.
2. Every subscription bills at its plan's actual frequency. A quarterly plan bills every three months, or the UI stops saying "/mo".
3. Every recurring plan has an end condition. Seasonal plans stop at season end without anyone remembering.
4. Money collected at booking writes a PAID Invoice at the moment of collection. Nothing in the CRM ever offers to charge a job that already has one.
5. Cancelling anything cancels it everywhere — plan record and Stripe, in the same operation, or neither.
6. One cancellation policy exists, in one place, and every surface reads it from there: the published terms, the agreement template, the checkout disclosure, and the enforcement code.
7. A refund is a first-class action in the CRM, it writes REFUNDED, and it is the only way refunds happen.
8. A price that differs from the rate card requires a reason and records who set it. No free-text price ships without a comparison to what the card says.
9. Recording an offline payment is a different screen with a different permission from charging a card, and both stamp the Cognito sub of whoever did it.
10. Discounts floor at cost, not at a percentage of list.
11. The lead-fee gate applies to recurring plans, computed against twelve-month contribution, not first-visit profit.
12. Drive cost is round-trip and labor is loaded. Publish the assumptions in one constants file with a comment saying what they include, so the next person doesn't have to reverse-engineer whether $42 has payroll tax in it.

---

## The McDonald's test: can a low-skill employee run this?

McDonald's is bulletproof because the register has pictures, the fryer beeps, and there is exactly one right way to do each task. This CRM fails that test in dozens of places, and it fails hardest exactly where money moves. Below, by role, are the specific screens that demand judgment, memory, mental math, or free text — and what each one should look like instead.

One number frames the whole section: **there is exactly one confirmation dialog missing across every money-moving action in this product, and it is on the button that charges a customer's card.** Cancelling a plan asks. Deactivating a plan asks. Voiding a quote asks. Marking a job complete asks. Charging $299 to a Visa does not.

---

### Front desk / CSR (week one, $18/hour, phone in hand)

**The register shows an already-paid order as unpaid.** Every website booking is charged in full at checkout, but `apps/web/amplify/functions/shared/bookingFinalize.ts` creates the Customer, ServicePlan, Job and Agreement and never creates an Invoice. The Charge button's visibility test in `apps/crm/src/office/CustomerDetail.tsx:629` is `!invoice`, and the server-side duplicate guard in `apps/web/amplify/functions/crm-billing/handler.ts:279` queries the same empty table. Both are permanently blind. The moment a tech completes a paid wasp job, a blue "Charge $299" button appears on that customer's record with no confirmation and no paid indicator anywhere on the row. A CSR working the completed-jobs list will tap it. That is what the button is for.

*McDonald's version:* the job row shows a green **PAID $299 online** chip, and the Charge button is not rendered. `finalizeBooking` writes a PAID Invoice; `Job` carries a `paidAt` field; `chargeOneTimeJob` refuses server-side on that field rather than on the absence of a row.

**Any office user can charge any card, any amount, one tap, no dialog.** `CustomerDetail.tsx:1201-1208` submits straight to `chargeManualAmount`. Client validation is `cents > 0` and a non-empty description (lines 1104-1112). The server ceiling is `amountCents > 2_000_000` — $20,000 — in `crm-billing/handler.ts:352`. A CSR who means $149.00 and types `14900` into a box labeled "Amount ($)" charges $14,900 off-session, instantly, with no undo, because there is no refund anywhere in the CRM.

*McDonald's version:* a second step that restates the amount in words and figures and the card's last four — "Charge one hundred forty-nine dollars to Visa ••4242?" — with the amount re-typed above $500. Cap at what a BuzzKill job can plausibly cost (~$2,000), with an owner path above it.

**Two taps fabricate revenue.** The same sheet has a segmented control that flips to "Record offline." That mode writes an Invoice directly from the browser (`CustomerDetail.tsx:1132-1144`) with `status: PAID` and `paidAt: now`, moving no money. It defaults to RECORD whenever the customer has no card on file, and the only visual difference between marking $500 collected and actually taking $500 is which half of the control is lit. No model in `apps/web/amplify/data/resource.ts` carries a `createdBy` field, so nothing records who did it.

*McDonald's version:* two different screens, two different colors, two different permissions. Bookkeeping never sits one tap from a live charge. Every Invoice stamped server-side with the Cognito sub of whoever created it.

**The badge that gates every money action lies in both directions.** `getPaymentMethodSummary` reads only `invoice_settings.default_payment_method`, which is written exclusively by the Stripe webhook. The sheet waits a hardcoded `setTimeout(..., 1500)` (`CustomerDetail.tsx:1053`) and hopes. When the webhook is slower, the badge reads "missing" seconds after a successful card save — and a false "missing" is what defaults the charge sheet to the fake-money path. A lookup failure is swallowed at line 143 and renders identically to a real missing card, while the body simultaneously says "Checking…".

*McDonald's version:* three states, not a boolean — **on file** / **none on file** / **couldn't check, retry**. Never let "couldn't check" enable a money decision.

**Cancel and Deactivate are indistinguishable and one is permanent.** `CustomerDetail.tsx:479` says "Cancel this plan's billing?" and destroys the Stripe subscription immediately with no proration and no refund. Line 514 says "Deactivate this plan? Billing pauses and no new visits are scheduled" and is fully reversible. A customer calling to pause for the winter says the words on the irreversible button. Reactivate resumes real payment collection with no confirmation at all.

*McDonald's version:* outcome language — "Pause billing — resume anytime" versus "End this plan permanently — cannot be undone" — with the money spelled out: what they paid, what period it covers, whether a refund is issued. The permanent one requires typing the customer's name.

**"Start billing" is a small subtle button with no confirmation that begins charging a card forever.** It is the only caller of `startSubscription` anywhere in the repo (`CustomerDetail.tsx:499`). The two harmless buttons beside it both have confirms. And the row reads `$45/mo · service quarterly` while `crm-billing/handler.ts:195` hardcodes `interval: "month"` — a quarterly customer is billed twelve times a year for four visits, and no screen says so.

*McDonald's version:* a confirm restating the exact amount, the real interval, the card's last four, and the first charge date. Better: remove the button entirely and start billing automatically when the first visit completes, which is the rule Jake already locked.

**A customer calls to cancel and there is no correct action available.** Grep `apps/crm/src` for `BookingRequest` — zero hits. Grep for `refund` — zero hits. The CSR cannot see the booking, cannot see the policy, and cannot issue the refund. Her only option is a red ✕ behind "Cancel this job?" (`CustomerDetail.tsx:663`) that voids a paid appointment with no refund and no email. The 3-day rule lives only as `CANCEL_FULL_REFUND_DAYS = 3` in `apps/web/amplify/functions/booking-public/handler.ts:645`, and it is `daysOut > 3` — exactly three days out is not refundable. She must recall that from memory and count calendar days while being yelled at.

*McDonald's version:* one cancel path, server-computed, stating the answer in dollars before the tap: *"This visit was paid $299 on 7/12. It is 15 days out — cancelling issues a FULL $299 refund. Continue?"* The plain job ✕ refuses on any job carrying a booking payment and routes her here.

**She cannot find the caller.** Search matches only displayName, serviceCity, and email (`apps/crm/src/office/Customers.tsx:67-73`). Phone and street address — the two things every caller actually gives — are not searchable. Leads are on a different screen with no search box at all. When she can't find "Bob," the button she reaches for is "+ Customer," which writes `status: ACTIVE` and creates a duplicate with no plan, no card, and no history, inflating the one KPI on the Dashboard.

*McDonald's version:* search normalized phone and street across LEAD, ACTIVE and INACTIVE regardless of tab. "+ Customer" creates a LEAD and runs a duplicate check first.

**Prices are free-text boxes.** `QuoteSheet.tsx:65-69` validates `cents > 0` and nothing else — not against the template price, not against the rate card, not against a floor, with no record of who typed it. The flagship AI-priced templates prefill the box **empty**, so the standard path for BuzzKill's main product is "type a number you remember." And `QuoteSheet` never sets `initialFeeCents`, so every manually quoted plan silently drops the $99 and — because `agreement-public/handler.ts:112` gates the first visit on that field — creates no initial visit at all.

*McDonald's version:* read-only price from the rate card. Deviation requires an explicit override toggle, a typed reason, and an actor stamp. Never render an empty price box.

**The full-width red button at the bottom of the page has no confirmation.** "Mark inactive" (`CustomerDetail.tsx:856-874`) flips a status and nothing else — the Stripe subscription keeps charging, the tech keeps showing up, the portal login still works. It is the only destructive-looking control on the page without a dialog, and it sits directly below the Invoices card where a mis-scroll lands.

*McDonald's version:* a confirm that enumerates what is still live ("ACTIVE plan billing $99/mo, 2 scheduled visits, 1 portal login") and offers to stop each one in the same step, plus a churn reason from a short pick-list.

**One tap in a dropdown publishes a customer's pricing to strangers.** `GroupDetail.tsx:127-132` fires membership changes from an `onChange` with no confirmation. Because `accessGroups` stamps `grp-<id>` onto Invoice, Quote and Agreement, that click grants every portal user in the group read access to this customer's invoices, negotiated price, and signed contract. The screen says members can see "service details."

*McDonald's version:* a confirmation naming exactly what becomes visible to whom, and a data model where "can see the schedule" and "can see the money" are different grants.

---

### Technician (in a truck, gloves on, one bar of signal)

**The most common thing that goes wrong in the field has no button.** `JobStatus` in `apps/web/amplify/data/resource.ts:38-44` is `[UNSCHEDULED, SCHEDULED, IN_PROGRESS, COMPLETED, CANCELED]`. There is no NO_SHOW, no locked-gate, no could-not-access. A tech at an empty house has two options: leave the job hanging — where it keeps consuming booking capacity and keeps emailing the customer reminders — or write a report and press "Complete & send." The second one is the only one that makes the screen stop nagging. So he types two words, taps Capture Location from the driveway, and sends. That emails the customer a pesticide application record for a visit that never happened, arms the Charge button on a one-time job, and queues the next recurring visit as though service occurred.

This is the single most important item in this section. The tech is not being dishonest. **The app routes him there.** Every other field defect below is downstream of this one.

*McDonald's version:* two big buttons next to "Start job" — **Customer not home** and **Can't access** — each requiring one tap on a reason chip (no typing) and a photo of the door. That outcome frees the day's capacity, does not complete the job, does not arm any charge, does not queue the next visit, alerts the office, and creates a callback task. Add these first; they remove the incentive that every other guardrail is trying to contain.

**The field labeled "Internal notes (not shown to customer)" is emailed to the customer.** `apps/crm/src/tech/JobDetail.tsx:435` renders that label. `apps/web/amplify/functions/crm-docs/handler.ts:229` passes `techNotes` into the PDF renderer. `apps/web/amplify/functions/shared/pdf.ts:311` prints `section("Technician notes", opts.techNotes)` as a visible section on the PDF attached to the customer's email and stored in their portal. There is no filter anywhere between the two. The label is an instruction to be candid, and the app mails the result to the person being described. There is no un-finalize and no amend flow, so it cannot be recalled.

*McDonald's version:* the customer receipt and the kitchen ticket come out of different machines. Delete line 311 today, remove `techNotes` from the renderer's options type so it cannot be reintroduced, and surface the field on the office screen only.

**"Complete & send" is one tap, irreversible, customer-facing, with no confirmation and no preview.** It emails a PDF, marks the job done, and queues the next visit. There is no un-finalize anywhere in the product.

*McDonald's version:* a dialog naming the customer — *"This emails the report to Sarah Kelly and marks the job done. This can't be undone."*

**A tech can arrow forward to next Tuesday and complete a job that hasn't happened.** Day navigation in `apps/crm/src/tech/Today.tsx:131` has no bound, and nothing in `JobDetail.tsx` or `crm-docs/handler.ts` compares `job.scheduledDate` to today.

*McDonald's version:* future-dated jobs render read-only — address, notes, and a banner reading "Scheduled for Tuesday, Jul 21." Enforce it in the Lambda too.

**Both validation gates live in React only.** `JobDetail.tsx:486-493` checks for a GPS point and a non-empty services description. `finalizeServiceReport` (`crm-docs/handler.ts:190`) checks neither, and checks no products, no EPA number, no quantity, no ownership, and no date. Any tech calling the mutation finalizes an empty report on any job.

*McDonald's version:* the fryer's timer is in the fryer, not in a poster on the wall. Move every check server-side and require at least one product row with a format-valid EPA number and a numeric quantity plus unit — or an explicit "inspection only, no product applied" tick.

**The GPS stamp asserts something the system never checked.** `pdf.ts:329` prints "Location captured from the technician's device at the time the report was filed, confirming on-site presence." The coordinates are never compared to the customer's address. There is no geofence and no accuracy floor — ±5,000 metres passes. Worse, the stamp is sticky: `JobDetail.tsx:247` seeds it from the saved draft, so a point captured at the house yesterday reprints as proof today, and line 253 fabricates a capture time of "now" when none was stored.

*McDonald's version:* geocode the service address, compare, and print the measured distance ("captured 18 m from the service address") — or delete the sentence. Never print an assertion the system cannot support.

**Every narrative field is a blank box on a phone.** Services performed, target pests, areas treated, recommendations — nothing is a pick-list, so two techs describing the same ant treatment produce two different legal documents. "Amount" is free text: `2 oz`, `a bit`, or blank all save.

*McDonald's version:* tap, don't type. Pick-lists for pests and areas, a checklist per service type, and a numeric quantity plus a unit dropdown so "a bit" is unrepresentable.

**A tech can permanently alter the company's regulated pesticide catalog from his phone.** `JobDetail.tsx:564-572` calls `Product.create` with `epaNumber: null` when blank and `active: true` hardcoded, validating only a non-empty name. It appears in every other tech's picker instantly. Techs have create but not update, so his typo is permanent, and nothing tells the office it happened.

*McDonald's version:* remove `create` from the TECH grant in `resource.ts:439`. Let him type a manual row for this report only, and route it to an office approval queue.

**All typed work is discarded on a network error.** `apps/crm/public/sw.js:68-70` returns early on non-GET and cross-origin requests, and the Amplify API is a cross-origin POST — so nothing the tech types is cached or queued. There is no offline draft, no write queue, no `navigator.onLine` check anywhere in `apps/crm/src`. He types five fields in a crawlspace, taps send, gets a raw network error, and it is gone. After that happens twice he stops reporting in the field and writes it up that night — which is what makes `serviceDate` wrong (it is stamped at draft-save time in `JobDetail.tsx:330`, not from the job) and the GPS stamp meaningless.

*McDonald's version:* save the draft locally on every keystroke, queue the send, and show a banner — "Offline — saved on this phone, will send when you have signal."

**He cannot see what the job is worth and has no way to report extra work.** No tech screen references `priceCents`. There is no "found extra work" action. Every on-site upsell dies in the van.

*McDonald's version:* show the price on the job card, and add one button that opens a picker of rate-card items with the price already computed, writing an office task. The tech reports what he saw; the rate card does the money.

---

### Office manager / dispatcher (7am, one tech just called in sick)

**Assigning a job silently moves the customer's paid appointment.** `apps/crm/src/office/Schedule.tsx:112` writes `scheduledDate: date` unconditionally, where `date` is whatever day the board is showing. The pool row prints "· wants 2026-08-04" one line above the button that destroys it. No confirmation, no customer notification.

*McDonald's version:* if the job carries a paid date, it is not assignable on any other day — grey the button and say "Booked for Aug 4 — open that day to assign."

**A tech calling in sick has no representation in the system.** The Technician model is `{name, email, phone, active, userSub, color}`. Grep for `pto|vacation|sick|unavailable` returns nothing. The only lever is Deactivate, whose confirm reads "Their history stays, but they disappear from Schedule and My day" — reassuring and incomplete. Their eight assigned jobs then render nowhere: route cards only show active techs, and the pool requires `!routeId`. Those jobs stay SCHEDULED, keep firing T-1 reminders telling eight customers a tech is coming, and keep consuming booking capacity.

*McDonald's version:* a per-tech unavailability record that removes their capacity for those dates only, surfaces their jobs as "Needs re-assignment — tech out," and suppresses reminders for jobs with no active tech. Block deactivation entirely while a tech holds future scheduled work.

**The 8-stops-per-tech rule is enforced against strangers on the internet and not against staff.** `STOPS_PER_TECH = 8` exists only in `apps/web/amplify/functions/booking-public/availability.ts:21`. Grep `apps/crm/src` for it — zero hits. The assign sheet lists technicians by bare name: no stop count, no load, no distance. The board also assigns freely on Saturdays, which the funnel forbids.

*McDonald's version:* "Dave — 6 / 8 stops" with a color state, load and drive-minutes shown in the assign sheet, and a hard block on the ninth behind a recorded override. The route card already computes `routeJobs.length` forty lines above the sheet that omits it.

**There is no "move to another tech."** The only rebalance path is unassign-then-reassign. Unassign (`Schedule.tsx:128-136`) flips the job to UNSCHEDULED but leaves the date — which kills the customer's reminder (reminders match SCHEDULED only) while the appointment still stands, and frees booking capacity on a day the crew still owes. The ✕ that does this sits flush against the ↑/↓ reorder arrows with no confirmation.

*McDonald's version:* one "Move to another tech" action that rewrites the route atomically and never touches status or date. Reserve ✕ for a real "remove from route" that keeps the job dated and scheduled.

**A paid booking is invisible until the morning it is due.** The pool (`Schedule.tsx:64-67`) matches jobs on the displayed date or with status UNSCHEDULED. A paid booking is SCHEDULED with a future date and matches neither — while the office alert email from `bookingFinalize.ts:312` says "The job is on the Needs-scheduling board for route assignment." That is false for every future booking and trains the office to trust a board that isn't showing it.

*McDonald's version:* a forward-looking pool — every non-cancelled job with no route and a date from today onward, grouped by date, paid bookings badged with price and PAID — plus a Dashboard tile reading "3 paid jobs unassigned, soonest is tomorrow."

**There is no 7am "is today deliverable?" screen.** The Dashboard reports Billed, Paid, Unpaid, Failed, Open leads and Active customers — nothing operational. The route card badge reads PLANNED forever, because `Route.create` is the only Route write in the entire codebase.

*McDonald's version:* a day-health header — per-tech load against capacity, route minutes against the 480-minute workday, count of paid jobs unassigned in the next seven days, count of jobs assigned to inactive techs. Make the status badge transition or delete it.

**Any office user can create another office user in one tap.** `More.tsx:161-189` enables the invite button on a name and a loose email regex. No confirmation, no owner approval, no notification to Jake. `auth/resource.ts` defines exactly three groups — OFFICE, TECH, CUSTOMER — so there is no tier above OFFICE to restrict it to. And there is no delete-user, disable-user, or remove-role anywhere in the codebase: "Deactivate technician" flips `active` and never touches Cognito, so a fired employee's login still works while the office believes access is cut.

*McDonald's version:* an owner tier that alone can grant OFFICE; plain-language consequences under the dropdown ("Office staff can charge customer cards and change prices"); an email to Jake on every staff invite; and a one-tap Remove access that disables the login and strips the groups.

**The one tool for "did the customer get it?" returns confident wrong answers.** `More.tsx:295` calls `EmailLog.list({limit: 100})` with no index and sorts client-side, so it is an arbitrary hundred rows, not the newest hundred. There is no search, no customer filter, no resend, and the `error` field — which distinguishes a bounce from a throttle — is stored at `resource.ts:509` and never displayed. Meanwhile the send itself lies: `sendAgreement` stamps status SENT *before* calling SES and swallows the failure, and the screen toasts "Agreement emailed to bob@example.com" either way.

*McDonald's version:* send first, stamp second, and never render a success message on an unverified send. Index the log by date, filter by customer, show the error, and put one Resend button on the failed row.

---

### The four rules

Apply these to every new screen, every new button, and every existing one on the list above.

1. **A money button states the money before it moves.** Payee, amount in words and figures, card last four, and what happens next — in a confirmation the employee must clear. If the action is irreversible, say so in the dialog. No exceptions: today the *only* money-moving action without a confirmation is the one that charges a customer's card.

2. **If the label promises something, the code must enforce it.** "Internal notes (not shown to customer)" must be structurally incapable of reaching a customer. "Collect before the first treatment" must block the job. "Confirming on-site presence" must be measured. A screen that asserts what the system never checked is worse than a screen that says nothing, because an employee acts on it.

3. **Every real-world outcome gets a button, and the honest button is the easy one.** A locked door, a sick tech, a customer who wants to pause — if the outcome has no control, the employee will use the nearest one, and the nearest one is usually the destructive one. When the only button that clears the screen is the one that fabricates a record, that is the app's defect, not the employee's.

4. **Failure lands in a queue somebody clears to zero, not in a log nobody reads.** A failed payment, an unassigned paid job, an active plan that isn't billing, a report stuck in draft, a lead promised a call within the hour — each must appear on one screen with an age, an owner, and a button. CloudWatch is not a queue. A shared inbox is not a queue. A red badge nobody was told to look at is not a queue.

---

## Feature-by-feature verdict

All 149 features the engineering team built, graded against one question: does it help the business?

A calibration note, because it matters for how you read this. The first grading pass marked 120 of 149 features "fix the business logic" and gave exactly one clean KEEP across the entire product. That spread is not credible — it reflects graders primed by a long list of findings, not an app where 80% of features are broken. The tables below carry those original verdicts because the *evidence* behind each one is sound and traceable to code, but treat the verdict column as "needs attention" rather than "is broken." Where a row says FIX, read the "what must change" cell to judge severity for yourself. The priority list above is the honest ranking; this section is the exhaustive inventory.

Verdict key: **FIX** = the business rule itself is wrong · **GUARDRAIL** = rule is right, an untrained employee can get it wrong · **SIMPLIFY** = works, costs more decisions than it's worth · **CUT** = should not exist · **KEEP** = fine as-is. McD = McDonald's test (can a week-one employee use it correctly every time).

### Booking funnel (website) (26 features)

| Feature | Verdict | Value | McD | What must change |
|---|---|---|---|---|
| AI market-rate research + 90-day cache (marketRate) | CUT | Neg | FAIL | Delete marketRate.ts, the MarketRate model in resource.ts, and… |
| Abuse control: Turnstile + per-IP throttle +… | FIX | High | FAIL | 1. TURNSTILE — pick one, do not ship as-is. Either (a) DELETE verifyBotToken, the botToken… |
| Auto-generated signed service agreement + PDF | FIX | High | FAIL | Do not launch the funnel until disclosure precedes the charge. Six changes, all small:  1.… |
| Booking cancellation + refund policy (POST /cancel) | FIX | High | FAIL | Do not ship the funnel until all five land.  1. One cancellation path, server-owned. Promote… |
| Booking finalization → schedule insertion | FIX | High | FAIL | Three changes, in priority order. (1) STOP THE OVERSELL — this is the one that costs money… |
| Booking-funnel capacity model & day availability… | FIX | High | FAIL | Ship in this order — 1 and 2 are one-liners that stop active money loss.  1. COUNT COMMITTED… |
| Booking-funnel payment → CRM record creation… | FIX | High | FAIL | 1. THE ONE-LINE-LEVERAGE FIX — write the Invoice. In finalizeClaimed, immediately after… |
| CORS origin lock on the public API | GUARDRAIL | Low | PASS | 1) Alarm, don't just 403: emit a CloudWatch metric on "Forbidden origin" in prod and alert… |
| Cancellation preview + refund policy enforcement… | FIX | High | FAIL | Four changes, in this order, none optional before launch. (1) Stop the billing bug now — this… |
| Customer self-service cancellation → schedule… | FIX | High | FAIL | 1. BLOCKER — one function owns plan cancellation. The funnel cancel path must call the… |
| Data-model access control for the booking tables | GUARDRAIL | High | PASS | 1. MarketRate: drop OFFICE create and delete. Leave read + update. Any price override must go… |
| Deterministic base pricing (GENERAL_PEST +… | FIX | High | FAIL | In priority order, all before this funnel takes another dollar:  1. Delete the price tables in… |
| Drive-time matrix for route density | CUT | Neg | FAIL | Delete the driveMatrixFrom call and the route-density modifier from buildDayMatrix… |
| Dynamic day pricing (surge/discount modifiers) | SIMPLIFY | Neg | FAIL | 1. Add a cost floor using the function that already exists. Import `oneTimeGrossProfitCents`… |
| Live drive-time zone assignment | FIX | High | FAIL | 1. Never let UNKNOWN produce a bookable price. Replace `priceZone = zone === "UNKNOWN" ? "B" :… |
| Payment collection (POST /book) and PaymentIntent… | FIX | High | PASS | Three changes, all inside this endpoint, none of them large:  1. Make the consent a record… |
| Public quote endpoint (POST /quote) | FIX | High | FAIL | Ship-blockers, in order:  1. Invert the zone fallback. `zone === "UNKNOWN"` must route to… |
| Quote persistence, quoteJson snapshot, and 24-hour… | FIX | High | FAIL | 1. In /book, before creating the PaymentIntent, rebuild live availability for the chosen date… |
| Recurring-plan charge policy (initial fee now,… | FIX | Neg | FAIL | 1. AUTOMATE THE RULE (blocks launch). Call startSubscription from both completion paths in… |
| Schedule-aware availability matrix (buildDayMatrix) | SIMPLIFY | High | FAIL | CUT the route-minutes feasibility block (availability.ts:144-155) and… |
| Schedule-aware dynamic day pricing | FIX | Neg | FAIL | 1. SHIP THE FACTORS. Stop stripping factors[] at handler.ts:510. Show "Thursday $299 — your… |
| Secret resolution for Stripe / Anthropic / Google… | FIX | Neg | FAIL | 1. Delete handler.ts:378. When zone is UNKNOWN, do not invent a Zone B adder and do not price… |
| Specialist-callback routing (CONTACT decision) | FIX | High | FAIL | Ordered by money:  1. MOVE THE BUDGET CHECK INSIDE marketRate(), AFTER THE CACHE LOOKUP.… |
| Stripe-webhook booking finalization… | FIX | High | FAIL | BLOCKING — do not take a live booking until these land:  1. Write a PAID Invoice in… |
| Transactional email: confirmation, cancellation,… | FIX | High | FAIL | 1. Do not send the cancel link until /cancel exists. Either ship the page in the same release… |
| Website quotes logged to the weekly pricing review… | FIX | Med | FAIL | 1. Add `bookingId: a.id()` to LeadPricingRun in resource.ts and set it on the website create —… |

### Portal, e-sign & comms (21 features)

| Feature | Verdict | Value | McD | What must change |
|---|---|---|---|---|
| Agreement authoring, sending, link-copying, and… | FIX | High | FAIL | 1. Delete the free-text editor from the send path. The agreement body becomes configuration,… |
| Agreement authoring: default template, placeholder… | FIX | High | FAIL | 1) Reconcile the terms with the code before this touches another customer. Pick ONE… |
| Central email sender + EmailLog audit record | FIX | High | FAIL | In priority order. (1) Never render a promise on an unverified send. Thread the sent boolean… |
| Complete catalog of system-sent email | GUARDRAIL | High | FAIL | 1) Cap the review ask: before rendering the review CTA in crm-docs/handler.ts:285-289, query… |
| Customer portal billing (invoice history +… | FIX | High | FAIL | Ship in this order; items 1-3 are the release gate.  1. STOP THE TRAP BUTTON (smallest fix,… |
| Customer portal invite / resend | FIX | Med | FAIL | 1) Ship a revoke path before anything else — a "Revoke portal access" button on the Portal… |
| Customer portal — Billing (payment method + invoice… | FIX | High | FAIL | 1. (Cash-critical) In onSetupIntentSucceeded, after setting the customer default PM, list that… |
| Customer portal — Documents | FIX | High | FAIL | Ship in this order:  1. WIDEN THE SCOPE (do this first — it is nearly free). In Docs.tsx, load… |
| Customer portal — Group view (management companies) | FIX | High | FAIL | 1. SPLIT THE GRANT (blocks any new group account). Change customerAccessGroups() so grp-<id>… |
| Customer portal — Home ("My services") | FIX | High | FAIL | In priority order:  1. Never say "nothing scheduled" when something is queued. Include… |
| Email log viewer (More → Email log) | FIX | High | FAIL | 1. Make "most recent" true. Add a secondary index to EmailLog… |
| Portal access management (invite / resend / send… | FIX | Med | FAIL | Minimum to ship (do these before the next customer is invited):  1. Build revokePortalAccess… |
| Public e-sign page (/sign/:token) and signature… | FIX | High | PASS | 1. Capture consent for real. POST must send consentedToElectronicRecords: true plus the exact… |
| Read-only finalized report view +… | FIX | High | FAIL | Ship in this order:  1. Correction flow first (it is what makes the rest enforceable). Add an… |
| Service report PDF rendering (pdf.ts) | FIX | High | FAIL | SHIP TODAY (one line, removes a live liability): delete `section("Technician notes",… |
| Signature-triggered quote conversion (convertQuote) | FIX | High | FAIL | 1) Make billing automatic, not a button. In the job-completion path (crm-docs… |
| agreement-public GET — token-gated agreement… | SIMPLIFY | High | FAIL | Keep the GET exactly as-is. Remove the VIEWED machinery and replace it with a follow-up cue… |
| agreement-public POST — signature capture, audit… | FIX | High | PASS | 1. CONSENT — Require `consentedToElectronicRecords: true` plus the exact consent text and a… |
| getDocumentUrl — entitlement-checked presigned… | FIX | High | FAIL | 1. Delete the TECH short-circuit at crm-docs/handler.ts:427. Techs pass the same entitlement… |
| sendAgreement — email the customer a secure e-sign… | FIX | High | FAIL | 1. Make failure loud. Reorder sendAgreement to send FIRST and only stamp status SENT + sentAt… |
| sendCustomerEmail — office-initiated transactional… | SIMPLIFY | Med | FAIL | Three changes, in priority order — net effect is the feature gets smaller, not bigger:  1. FIX… |

### Billing & money (20 features)

| Feature | Verdict | Value | McD | What must change |
|---|---|---|---|---|
| "Email request" payment-method nudge… | FIX | Med | FAIL | Four changes, all small, before this is safe for an untrained operator. (1) Fix the link:… |
| Auto-promote a newly saved card to account default… | FIX | High | FAIL | Make the customer default the single source of truth for which card gets charged. Preferred… |
| Auto-queue the next recurring visit after completion | FIX | High | FAIL | Keep the function and its call sites; fix four business rules. (1) STOP SWALLOWING THE FAILURE… |
| Cancel subscription (cancelSubscription) | FIX | High | FAIL | 1. Extract the body of cancelSubscription (crm-billing/handler.ts:214-235) into a shared… |
| Charge a completed one-time job (chargeOneTimeJob) | FIX | High | FAIL | Four changes, in priority order. (1) finalizeBooking must write a PAID Invoice for every… |
| Charge an arbitrary amount to the card on file… | GUARDRAIL | High | FAIL | Six changes, in priority order. (1) Split CHARGE and RECORD into two separate screens with… |
| Manual charge / record-offline-payment escape hatch… | GUARDRAIL | High | FAIL | Five locks, in priority order. (1) SPLIT THE MODES into two separate actions on two screens… |
| Mirror Stripe-side subscription cancellation… | GUARDRAIL | High | FAIL | Keep the status flip exactly as written — it is correct and load-bearing. Add two guardrails,… |
| Mirror subscription invoices into the CRM… | FIX | High | FAIL | Fix the ledger, then build the ladder.  Ledger (stops the revenue lie): 1. Add… |
| No office-side refund capability | FIX | Neg | FAIL | Before launch, five changes. (1) Add a refundInvoice OFFICE mutation to crm-billing… |
| Pause / resume a plan (pausePlan, resumePlan) | GUARDRAIL | High | FAIL | 1. Break the adjacency. Make pause the primary action on an ACTIVE plan — "Pause billing… |
| Payment method on file: collect, update, and email… | FIX | High | FAIL | 1) Fix the query, not the delay: have getPaymentMethodSummary fall back to… |
| Payment method summary lookup… | FIX | High | FAIL | 1) Make the state ternary, not boolean: return "ON_FILE" / "NONE" / "UNKNOWN". Stop swallowing… |
| Record an offline payment / open invoice… | FIX | High | FAIL | 1) Split the two functions onto separate screens. "Record offline payment" is bookkeeping, not… |
| Save a payment method (createSetupIntent +… | FIX | High | FAIL | 1. Make the default PM real at save time, not at webhook time. In createSetupIntent's success… |
| Service plan lifecycle: create, start billing,… | FIX | High | FAIL | 1. MAKE BILLING AUTOMATIC — THE FRYER BEEPS. Call startSubscription from the completion path… |
| Settle a one-time charge from Stripe… | FIX | High | FAIL | Five changes, in this order:  1. TERMINAL-STATE GUARD — ship this in or before the refund PR,… |
| Start monthly subscription billing… | FIX | High | FAIL | 1) MAKE IT AUTOMATIC (fixes the money hole). In crm-docs/handler.ts at both completion paths… |
| Stripe customer + catalog product provisioning… | FIX | High | FAIL | 1. (Priority) Make ensureStripeCustomer idempotent. Pass { idempotencyKey:… |
| Stripe webhook receiver: signature verification +… | FIX | High | FAIL | 1) Handle the money-out events. charge.refunded and charge.refund.updated -> set Invoice… |

### Pricing & rate cards (19 features)

| Feature | Verdict | Value | McD | What must change |
|---|---|---|---|---|
| AI fact extraction from lead text/screenshot | GUARDRAIL | High | FAIL | 1. Fix the rodent leak first — it is live money. Thread rodentAddon through every re-price in… |
| AI lead pricing orchestration (priceLead) | GUARDRAIL | High | FAIL | Ship it, but not until all four land:  1. KILL THE LEAD-FEE ESCAPE HATCH. Remove the "No lead… |
| AI reply composition with price-consistency guard | FIX | High | FAIL | Do not patch the whitelist — make the feature's own claim true. It advertises that inventing a… |
| Association / HOA common-area rate card… | FIX | High | FAIL | THREE CHANGES, IN PRIORITY ORDER.  1. FIX THE INVERTED BRACKET (rateCards.ts:160). Change the… |
| Commercial rate card (priceCommercial, non-food… | FIX | High | FAIL | 1. Unknown sqft on commercial must return NEEDS_INFO, never a price. In handler.ts:554-557,… |
| Deterministic reply template fallback… | FIX | Neg | FAIL | Ordered by money at risk.  1. Delete "$15" and "$99" from the guard's allowed set… |
| Drive-time zone resolution (Google Routes API) | FIX | High | FAIL | 1) Never let UNKNOWN produce a bookable price. In booking-public/handler.ts, delete the `zone… |
| Hard eligibility PASS gate + 5 canned decline… | FIX | High | FAIL | Ordered by money. (1) Resolve the service state from the geocoder, not the LLM: driveMinutes()… |
| Lead fee required before quoting | FIX | High | FAIL | 1. Add `recurringYearOneGrossProfitCents(plan, zone)` to rateCards.ts: initialFee +… |
| Lead screenshot upload (getPricingUploadUrl) | GUARDRAIL | High | FAIL | 1. SIZE CAP (blocking). Enforce a hard limit before the PUT. In PriceLeadSheet.tsx, reject or… |
| Lead-fee 3x gross-profit gate + variable cost model | FIX | High | FAIL | In priority order. Items 1-3 are cheap and must ship together; 4-6 follow.  1. ROUND-TRIP THE… |
| MA/RI licensing state gate | FIX | High | FAIL | 1. FAIL CLOSED on missing state. Delete `?? "MA"` from handler.ts:472 — it is the single most… |
| MarketRate AI research engine with clamps and… | SIMPLIFY | Low | FAIL | Keep the MarketRate model, the cache-key scheme, and the CRM screen. Cut the runtime LLM and… |
| Mosquito & tick rate card (priceMosquito) | FIX | High | FAIL | Ordered by money at risk. All are business-logic changes, none are refactors.  1. STOP THE… |
| Office market-rate review + override screen | FIX | High | FAIL | 1) Apply the same CLAMPS to office overrides in MarketRates.tsx that constrain the AI, and… |
| One-time → quarterly plan pivot (residential) | CUT | Neg | FAIL | 1. DELETE the pivot block (handler.ts:588-599) and the `pivotedFromOneTimeCents` variable, its… |
| Residential GPC rate card (priceResidential) | FIX | High | FAIL | Ordered by money at risk:  1. Kill the DRIVE constants. Pass the real `minutes` (already… |
| Rule-driven escalation triggers + escalation email… | FIX | High | FAIL | 1. NEVER render a promise on an unverified send. Capture sendEmail's boolean through… |
| Specialty flat-price cards (priceSpecialty) | FIX | High | FAIL | In priority order.  1. Stop selling rodent exclusion at a flat price. Change rodent_exclusion… |

### Office CRM (18 features)

| Feature | Verdict | Value | McD | What must change |
|---|---|---|---|---|
| AI lead pricing → one-tap quote (PriceLeadSheet) | FIX | High | FAIL | In priority order — 1 and 2 before this screen sends another agreement.  1. STOP SENDING… |
| Customer / lead data entry form (CustomerForm.tsx) | FIX | High | FAIL | Ranked by money:  1. Make leadSource an enum dropdown, required on lead create: Thumbtack /… |
| Customer directory (Customers.tsx) | FIX | High | FAIL | 1. SEARCH PHONE AND STREET. Normalize to digits-only and match on the last 7/10 digits so… |
| Customer groups: create, membership, and portal… | FIX | Neg | FAIL | 1. Narrow the grant. Keep `grp-` on Job and ServiceReport only — schedule and proof-of-service… |
| Customer status toggle (Mark inactive / Reactivate) | FIX | Neg | FAIL | Make the write a real churn transaction, not a flag flip. (1) Block marking a customer… |
| Lead inbox (Leads.tsx) | FIX | High | FAIL | 1. SORT BY AGE, NEWEST FIRST. Add a `status + createdAt` secondary index to Customer and query… |
| Lead-to-customer conversion (three separate,… | FIX | High | FAIL | Collapse to ONE conversion path and make money impossible to skip.  1. DELETE the silent flip.… |
| LeadPricingRun audit trail + dead… | FIX | High | FAIL | Ranked by business impact.  1. Auto-flip the outcome to WON. In… |
| Manual quoting (QuoteSheet.tsx) | FIX | High | FAIL | 1. STOP THE BLEED (ship first). Add initialFeeCents to PlanTemplate. QuoteSheet resolves it… |
| MarketRates screen: office review, override, retire | FIX | High | FAIL | 1. Move the clamp AFTER tidy() in marketRate.ts so the floor is actually enforced (tidy(5000)… |
| More page: staff invites, email log, password… | FIX | Med | FAIL | 1. ADD AN OWNER TIER (blocks the CRITICAL). Add "OWNER" to auth/resource.ts groups; put Jake… |
| Office dashboard metrics (Dashboard.tsx) | FIX | Neg | FAIL | Do these before anyone trusts another number on this screen.  MAKE THE FOUR TILES TRUE: 1.… |
| Office revenue dashboard + outstanding-invoice… | FIX | High | FAIL | In priority order. (1) LEDGER FIRST — finalizeBooking must create an Invoice (status PAID,… |
| Plan template catalog (PlanTemplates.tsx) | FIX | High | FAIL | 1. Add initialFeeCents to PlanTemplate (default 9900 for recurring, null for… |
| PriceLeadSheet: one-tap QUOTE → Quote + signed… | FIX | High | FAIL | 1. DECOUPLE THE FIRST VISIT FROM THE FEE. In agreement-public/handler.ts:112, always create… |
| PricingLog: weekly review + won/lost outcome… | SIMPLIFY | High | FAIL | 1) DELETE the outcome SegControl and the Save-outcome button entirely. No employee should ever… |
| Product log (master pesticide catalog) | FIX | High | FAIL | Do these in order; 1-4 are cheap and stop the bleeding now. (1) Remove `create` from the TECH… |
| Resident in-unit HOA signup page (/schedule/:slug) | CUT | Neg | FAIL | IMMEDIATE (today): remove the /schedule/:slug route from App.tsx. It is live,… |

### Technician & field (18 features)

| Feature | Verdict | Value | McD | What must change |
|---|---|---|---|---|
| "Complete & send" finalize gate (client-side… | FIX | Neg | FAIL | In business-value order:  1. ADD THE EXIT FIRST (removes the incentive, cheapest fix, biggest… |
| "Start job" status transition (tech field app) | FIX | High | FAIL | Four changes, in this order:  1. STOP THE BILLING PATH (ship first, today). In… |
| Finalize idempotency guard | FIX | Med | FAIL | 1) CLAIM BEFORE SIDE EFFECTS — this is the load-bearing correction, and the tagged fix… |
| GPS on-site verification stamp | FIX | Neg | FAIL | Today, before anything else (one line, stops the bleeding): delete the sentence at pdf.ts:329.… |
| Internal tech notes printed on the customer's… | FIX | Neg | FAIL | Ship today, in this order. (1) Delete line 311 of… |
| Job context card: address deep-link, tap-to-call,… | FIX | High | FAIL | 1. Show the money. Render job.priceCents and job.description on the context card. The data is… |
| Job creation, scheduling, rescheduling,… | FIX | High | FAIL | P0, ship before another website booking completes — four changes, all required:  1.… |
| Job-site photo capture and upload (presigned S3 PUT) | FIX | Neg | FAIL | Connect the pipeline to its outlet, or remove the button. Ranked by business impact:  1.… |
| No tech-side exception paths (no-show, skip,… | FIX | Neg | FAIL | 1) Add NO_ACCESS (nobody home / locked gate / dog out / refused entry) and NEEDS_RETURN… |
| PWA install banner (Android/Chromium prompt + iOS… | SIMPLIFY | Low | PASS | 1) Gate to TECH only. Change App.tsx:216 from `roles.office // roles.tech` to tech-only (and… |
| Products applied: catalog picker with manual… | FIX | High | FAIL | Make the pesticide record mandatory and server-enforced:  1. **Server-side gate in… |
| Service report draft form (free-text narrative… | FIX | High | FAIL | Ship in this order — 1 through 3 are ship-blockers.  1. STOP THE LEAK (hours, do it today).… |
| Service worker caching — app shell only, no offline… | FIX | High | FAIL | 1) Persist the report draft locally on every keystroke — IndexedDB (or localStorage as a… |
| Tech "My day" route list (TechToday) | FIX | High | FAIL | 1. Replace the filtered scan in Today.tsx:76-80 with an index query on routeId (add a… |
| Technician identity resolution + office… | SIMPLIFY | High | FAIL | 1. DELETE the `all[0]` fallback (Today.tsx:47-48). There is no acceptable silent default — an… |
| Technicians can create Products in the master… | CUT | Neg | FAIL | 1. Remove `create` from the TECH authorization on Product —… |
| Unrestricted day navigation (past and future) in… | GUARDRAIL | Med | FAIL | 1) Keep the chevrons; make any date != todayEastern() read-only in the tech app. No "Start… |
| finalizeServiceReport: PDF → S3 → customer email →… | FIX | High | FAIL | Ship in this order.  TODAY (one line, removes live liability): delete `section("Technician… |

### Scheduling & dispatch (17 features)

| Feature | Verdict | Value | McD | What must change |
|---|---|---|---|---|
| "Needs scheduling" pool (office Schedule board) | FIX | High | FAIL | 1. SPLIT THE POOL INTO TWO CARDS. They are different jobs with different rules; stop… |
| Daily appointment reminders (T-1 and T-7) | FIX | High | FAIL | Ordered by money, not by effort:  1. GATE THE PROMISE ON DELIVERABILITY. Only email a customer… |
| Date and time-window entry (DateTimeFields.tsx) | FIX | High | FAIL | 1) Delete `isoPlusDays`. Replace with `addDays(todayEastern(), n)` using the existing correct… |
| Day board (per-technician route cards) | FIX | High | FAIL | 1) Stop the date theft: if job.scheduledDate is set and differs from the board date, either… |
| Drive-time service (Google Routes) and zone… | FIX | High | FAIL | — |
| Job assignment to a technician's route (dispatch… | FIX | High | FAIL | 1. SPLIT THE FIELD — do not add a dialog. Give Job a `dateCommitted: boolean` (or `targetDate`… |
| Job status lifecycle (JobStatus state machine) | FIX | High | FAIL | 1. Add NO_ACCESS and NEEDS_RETURN to JobStatus (resource.ts:38). NO_ACCESS = nobody home /… |
| Lazy route creation (ensureRoute) | SIMPLIFY | Neg | FAIL | 1) Delete the Route model. Job.technicianId + Job.scheduledDate + Job.routeOrder already IS… |
| Manual stop reordering (↑ / ↓ arrows) on the office… | FIX | Med | FAIL | 1) Render geography on the route-stop row in Schedule.tsx:266-267 — add customerCity(j)… |
| Office job cancellation (red ✕ in CustomerDetail) | FIX | Neg | FAIL | 1) Add a real queryable field to Job (e.g. paidPaymentIntentId + paidAmountCents) in… |
| Office reschedule / schedule a job | FIX | High | FAIL | Ship in this order; 1–3 are release-blocking.  1. SPLIT "on the calendar" FROM "on a route."… |
| Recurring next-visit auto-scheduling… | FIX | High | FAIL | Ship in this order.  P0 — close the money hole. In both completion paths, when the completed… |
| Technician "My day" route view | FIX | High | FAIL | 1. PRIMARY (one query, fixes three defects): In… |
| Technician create / edit / deactivate + CRM login… | FIX | High | FAIL | Ship in this order:  1. BLOCK THE FOOTGUN (hours, stops the bleeding). On Deactivate, query… |
| Unassign job from route (✕ on a stop) | FIX | Neg | FAIL | Split one overloaded button into two honest ones, and stop letting status launder capacity. … |
| completeJob mutation (office completion without a… | GUARDRAIL | Med | FAIL | Keep the mutation and its scheduleNextRecurringVisit call — do not touch the logic. Make the… |
| finalizeServiceReport → implicit job completion | FIX | High | FAIL | 1) Start the money. In finalizeServiceReport, after the Job goes COMPLETED, if the job belongs… |

### Auth & access (10 features)

| Feature | Verdict | Value | McD | What must change |
|---|---|---|---|---|
| Dynamic Cognito group row-level access (cus-<id> /… | FIX | High | FAIL | 1. Split schedule-visibility from money-visibility. Keep grp-<id> on Job, ServiceReport and… |
| Handler-side customer authorization… | KEEP | High | PASS | — |
| Magic-link redemption (/welcome landing page) | FIX | High | PASS | In apps/crm/src/pages/Welcome.tsx, stop letting a pre-existing session short-circuit… |
| Magic-link sign-in request ("Email me a sign-in… | FIX | High | FAIL | 1. Stop the two token paths from clobbering each other. Either give invites their own… |
| Post-authentication login stamp | FIX | Low | FAIL | Guarantee the stamp cannot fail a login — this is the only blocking change. (1) In… |
| Role resolution, route guards and role-specific tab… | FIX | High | FAIL | 1. Make the tab bar a cascade, not disjoint sets, so every user with any role always gets a… |
| Role-based navigation and route gating (App.tsx) | FIX | High | FAIL | Fix the backend first; the App.tsx change is cosmetic without it. (1) Delete the TECH… |
| Self-service password set / change (More → "Set or… | CUT | Neg | FAIL | Delete the "Set or change password" ListRow (More.tsx lines 39-43), the passwordSheet state… |
| Staff invite (adminCreateUser, roles… | GUARDRAIL | Med | FAIL | In priority order:  1. SHIP OFFBOARDING BEFORE ANYTHING ELSE. Add deactivateUser… |
| setCustomerGroup — move a customer into/out of a… | FIX | High | FAIL | Four changes, all small. Do NOT do the batched/resumable rewrite.  1. Add client.models.Quote… |

---

## What Is Missing

Everything below is a capability the system does not have. Not a bug — an absence. Each one costs money today, and the cost compounds because nobody can see it happening.

The ordering is by business urgency at BuzzKill's actual scale — a few techs, a few hundred customers, one owner who is also the pricing department, the refund department, and the escalation queue.

---

### Needed before this replaces FieldRoutes

These are the gaps where cutting over to this CRM makes BuzzKill *worse off* than it is today. Two of them are outright regressions against the software you are decommissioning.

#### 1. A failed card is a permanent, silent revenue stop

**What it is:** There is no dunning. When a card declines, the invoice flips to `FAILED` with the hardcoded string "Subscription payment failed" — the real reason from Stripe is thrown away at `apps/web/amplify/functions/stripe-webhook/handler.ts:176` — and a red badge appears on the Dashboard's Outstanding list. That is the complete list of what happens. No customer email, no office alert, no retry button, no way for the customer to pay.

**What it costs:** At a few hundred customers on $45–$99/mo autopay, a normal decline rate is 5–10% a year. So roughly 15–30 of your plans will fail in a year. Here is the part that turns a collection problem into a loss: `apps/web/amplify/functions/shared/recurring.ts:57` keys the next-visit engine on `plan.status === "ACTIVE"`, and a failed payment never changes plan status — because no status exists that means "the card stopped working." `ServicePlanStatus` is `ACTIVE | PAUSED | CANCELED`. So your tech keeps driving out every 30/60/90 days at $42/hr plus van, servicing a customer whose card died in March. You do not stop, because nothing tells you to stop. The customer does not fix it, because nothing asks them to. A failed card today is discovered when someone eventually notices the Dashboard's red badge — or when you reconcile Stripe at tax time and find you serviced a house eleven times for free.

The customer is structurally unable to help you even if they want to. `apps/crm/src/portal/Billing.tsx` renders invoices read-only with a status badge and no Pay button. The `failureReason` field is written in three places and read in zero. A customer looking at a red "failed" badge sees no amount, no reason, and no button. Their only recourse is the phone call this app exists to eliminate. Rough order of magnitude: $6k–12k/yr of leak, and it grows with headcount.

**Minimum viable shape:** Three pieces. Email the customer on `invoice.payment_failed` with the real decline reason (the webhook already has it — store it instead of discarding it) and a working link to fix the card. Add a "Pay now" button to every OPEN/FAILED invoice in the portal. Add a "Retry charge" button to each row of the Outstanding list, and a rule that suspends new visit auto-queueing after N failures so you stop servicing for free. The rule to hold onto: no dollar should be able to fail without exactly one person being told and exactly one button existing to fix it.

#### 2. A technician calling in sick has no representation in the system

**What it is:** The `Technician` record is `{name, email, phone, active, userSub, color}`. There is no PTO, sick day, or unavailability concept anywhere. `active` is a global boolean — it cannot express "out today, back Thursday."

**What it costs:** At three techs, one person out is a third of your delivery capacity, and it happens weekly. The office has exactly one lever — Deactivate — and it is actively harmful. Deactivating hides the tech from the Schedule board, and because a route card only renders for active techs (`apps/crm/src/office/Schedule.tsx:60`) while the Needs-scheduling pool requires `!routeId`, their eight already-assigned jobs render *nowhere at all*. They stay SCHEDULED. The reminder cron (`apps/web/amplify/functions/daily-reminders/handler.ts:51`) filters only on `status === "SCHEDULED"` with no check that a technician exists, so all eight customers still get emailed "BuzzKill Pest Control is scheduled to visit." Nobody comes. Meanwhile the booking funnel still counts those eight stops against the day's capacity, so it will not sell replacement slots.

So: eight no-show-by-BuzzKill events per sick day, each a refund and a Google review risk, plus roughly $2,400 of one-time work that is neither delivered nor resellable. The alternative — leave the tech active — shows a full route for someone who is not coming, and nothing flags it. There is no bulk reassign and no "move this route to another tech"; recovery is roughly 24 manual interactions.

Two things make this worse than a missing feature. First, the deactivate confirmation says "Their history stays, but they disappear from Schedule and My day" — it reassures about history and never mentions that eight scheduled jobs vanish with them. The only warning the app gives states the safe half of the truth. Second, this is a regression: FieldRoutes has a time clock and availability handling. Shipping this CRM and retiring FieldRoutes destroys a capability Jake currently has.

**Minimum viable shape:** A `TechAvailability` record — technician, date range, reason — that does three things: removes that tech's capacity from the booking funnel's tech count *for those dates only*, surfaces their assigned jobs in the Needs-scheduling pool under a distinct "Needs re-assignment — tech unavailable" heading, and suppresses reminders for jobs with no active assigned tech. Plus one button: "Move this route to another tech." And block deactivation entirely when a tech holds future scheduled jobs — deactivation is for employment ending, never for a sick day.

#### 3. There is no way to record a callback, and the contract promises them for free

**What it is:** Clause 4 of the standard agreement (`apps/crm/src/lib/agreementTemplate.ts:17`) is in every signed contract: "If covered pests return between scheduled visits, BuzzKill will re-treat at no additional charge." Every one-time AI-generated reply promises a "30-day guarantee." Neither is implemented anywhere. `JobType` is exactly `ONE_TIME | RECURRING` — there is no CALLBACK or WARRANTY. Job has no field linking a re-visit to the original. ServiceReport has no "pest returned" outcome.

**What it costs:** Three ways, all money. First, an untrained office employee books the callback through the same job form as any other job — free-text service type, a price box. If she types a price, the job completes as a billable one-time and the no-confirmation "Charge $X" button appears. She bills a customer for the free re-treatment the contract promised them. Nothing warns her the visit was covered. Second, callback rate is *the* quality metric in pest control — it is how you know which tech is doing bad work, which product is failing, which pest you are underpricing. You cannot compute it, because nothing marks a visit as a callback. One sloppy tech can eat the margin on a whole town and the Dashboard shows nothing but healthy active customers. Third, a callback is pure cost — $42/hr labor, van, and a stop out of eight — and it is invisible in every revenue and cost number you have.

The one-time case is the sharpest: that job only cleared the 3× lead-fee profit hurdle assuming *one* visit. A free second visit silently violates the underwriting rule the company deliberately built into the rate card.

This is also a regression. FieldRoutes models re-service as first class — the reference docs are sitting in this repo (`docs/fieldroutes-api.md`) with a `reserviceReasonID` on every appointment and a dedicated reason-code entity. The incumbent tracks re-treats with a reason. The replacement dropped the concept.

**Minimum viable shape:** Add CALLBACK to the job type and an `originalJobId` link on Job. A callback is always priced at zero and must render "Covered — re-treatment guarantee" where the Charge button would be. Add one number to the Dashboard: callback rate over the last 90 days, sliceable by technician and by product. That single number tells you whether the work is good.

#### 4. A cancelling customer leaves no reason, and cancel is a one-way door

**What it is:** `ServicePlan` has `status`, `canceledAt`, and `notes` — no reason, no churn code, no exit capture. Every cancel path writes the same thing and captures nothing. The confirmation dialog is one line: "Cancel this plan's billing?"

**What it costs:** This is a recurring-revenue business, so churn is the number that decides whether it works, and six months from now Jake cannot answer "did we lose them on price, on a bad tech visit, or because they moved?" — the exact question that decides whether to raise prices, which is the stated purpose of the whole pricing-log phase. Unlogged reasons are gone forever and nothing else in the system records them. You cannot reconstruct it from a spreadsheet, because nothing is written down.

There is a second, sharper problem. Pause is reversible; cancel is not. The pause function refuses to act on a cancelled plan ("Plan is canceled — create a new plan instead"). So the retention offer — "pause for the winter instead of cancelling" — is labeled "Deactivate," sits beside a red "Cancel plan," and an office employee handling "I'm going away for the winter" must have tribal knowledge that the right button is the one that does not say cancel. Getting it wrong is unrecoverable: it forces a new plan, re-triggers the $99 initial-fee decision, and loses start-date continuity. There is no save flow: pause exists, is never offered to a cancelling customer, and is unreachable from the portal.

FieldRoutes has cancellation reason codes. Another regression.

**Minimum viable shape:** A reason field on the plan (too expensive / moved / problem not solved / bad visit / seasonal / other) plus an optional note, made required by a single cancel action that all three current cancel paths route through. Make the confirmation a two-step sheet: reason buttons first (tap, don't type), then confirm. Offer pause as the *first* option on that sheet rather than as a separate button somewhere else. Then one Dashboard tile: plans cancelled this month, MRR lost, top reason.

#### 5. There is no payroll time record, and the CRM is the only system that knows when anyone worked

**What it is:** No time entry, no clock in/out, no shift, no daily total. The Job model has `completedAt` and no `startedAt`. The "Start job" button in `apps/crm/src/tech/JobDetail.tsx:176` writes exactly one thing — `status: "IN_PROGRESS"` — and discards the timestamp at the precise moment it exists.

**What it costs:** If techs are W2 hourly, federal and Massachusetts law require true and accurate daily hours records, kept for years. The CRM is the only system with any idea when a technician was working — it has their route, their stops, a GPS stamp, a start action, and a complete action — and it records none of it as time. Whatever you pay people is reconstructed from memory, texts, or paper. In an hours dispute or an audit, the burden falls on the employer who kept no records, which means the employee's reasonable estimate is what stands.

This is not the same gap as job costing. Payroll hours must include compensable travel *between* sites and shop time, which a per-job duration would not capture even if you added one.

And this is a regression again: FieldRoutes has a documented time clock with paid/unpaid categories and timesheet permissions. Cutting over destroys a record Jake currently possesses.

**Minimum viable shape:** A minimal time entry — technician, clock in, clock out, date — with a clock-in/out button on the tech's My Day screen. The GPS capture already in the report gives you location proof for free. Even if payroll runs in Gusto, the hours have to come from somewhere defensible. Today they come from nowhere. This is survivable and cheap to fix at three techs; it gets expensive exactly once.

---

### Needed within 6 months

These do not block cutover, but each one is either money leaking now or a decision Jake is making blind.

#### 6. You cannot raise the price of an existing customer

**What it is:** No mechanism exists. Subscriptions are created with the price baked in at signup (`apps/web/amplify/functions/crm-billing/handler.ts:186`), and the function that creates them immediately returns if a subscription already exists — so it can never re-price. No screen anywhere writes a plan's price after creation; there is no edit-plan screen at all. The only other Stripe subscription update in the codebase sets pause behavior and nothing else.

**What it costs:** Annual price increases are the single biggest margin lever in a recurring service business, and this app makes one structurally impossible. Labor is $42/hr and rising; van cost is $0.30/mi and rising; the $45/mo quarterly plan you sell in 2026 still bills $45 in 2031. Margin only ever goes one direction.

The bitter part is that the app knows this is supposed to exist — the pricing log's header comment says the log "drives the price-increase phase," and the whole won/lost outcome apparatus was built to inform it. No price-increase logic exists anywhere in the repo.

The available workaround is genuinely bad: cancel the subscription (which cancels immediately with no proration and no refund), create a new plan, click "Start billing" again (which charges a full month instantly). The customer sees a cancellation, then a fresh charge on a new date, their billing anchor resets, and their history splits across two records. No employee will do that correctly, and at 200 customers nobody will do it 200 times.

You can raise prices for *new* signups today by editing the plan template. That does not reach the installed base — which is the whole point of a price increase.

One trap worth knowing: if Jake works around this by editing the amount in the Stripe dashboard, the customer portal will keep showing the OLD price (it reads the stale plan record) while the card is charged the NEW one. That is a customer-facing misstatement and a chargeback risk.

**Minimum viable shape:** A price-change action on the plan that updates Stripe with an explicit proration choice (likely none, new rate starting next cycle), writes the new price, and keeps an audit row of old → new → who → when. Then the thing that makes it a business capability rather than a button: a list of all active plans with their price and start date and months since last increase, with the ability to stage an increase across a cohort and send the notice. The contract already promises 30 days' notice for changes; the mechanism to honor that should live in the same action.

#### 7. Sent quotes and agreements rot silently, and the buying signal you capture is thrown away

**What it is:** No expiry, no follow-up, no worklist. The Quote model has a quoted date and a converted date and no expiry. Quote status is DRAFT / SENT / CONVERTED / VOID — no declined, no expired — so a sent quote is indistinguishable at three days and at three years. The only scheduled job in the entire system sends appointment reminders; nothing chases a quote. And the Dashboard loads invoices, customers, plans and jobs and never loads quotes or agreements, so "who did we quote that hasn't signed?" can only be answered by opening customer records one at a time.

**What it costs:** This is the leakiest joint in the funnel. You paid the Thumbtack lead fee, the AI priced it, the agreement went out for signature — and then nothing happens, forever. Follow-up on an existing quote is the cheapest revenue in the business because the acquisition cost is already sunk.

The bitter part: you already capture the single best follow-up cue and drop it on the floor. `apps/web/amplify/functions/agreement-public/handler.ts:156` stamps the agreement as VIEWED the moment the customer opens it. That timestamp has *zero readers* anywhere in the codebase — even the office's own agreement row renders the signed or sent date and never the viewed date. Nobody is ever told "Sarah opened her agreement twice yesterday and hasn't signed." The same rot applies one stage earlier: the Leads page sorts alphabetically with no age indicator, so the oldest coldest lead and the one that arrived an hour ago look identical.

The team already knows how to do expiry — they built it for the public booking funnel (24-hour quotes, enforced) and for the AI price cache (90-day shelf life). They skipped it on the one model where a human has to chase the money.

**Minimum viable shape:** A Dashboard card: "Quotes waiting" — every SENT quote, oldest first, showing days since sent and whether it has been viewed, linking to the customer. Add automated follow-up to the existing daily cron at two days and seven days on unsigned agreements. Add EXPIRED and DECLINED to the quote status so a dead quote leaves the queue with a reason instead of sitting in it forever.

#### 8. Seasonal mosquito plans bill 12 months for 6 months of service, and nothing reactivates them next May

**What it is:** The rate card literally names the service "Mosquito + tick plan (May–Oct)" and then hardcodes the frequency as MONTHLY. The plan record has a start date and a cancelled date and no end date. The subscription is created with a monthly interval and no end. There is no seasonal concept anywhere in the model.

**What it costs:** A $139/mo mosquito+tick customer is billed $1,668/year for six months of service — an $834 overcharge for service you never promised. That is not revenue; it is a chargeback and a Massachusetts consumer-protection problem, and every dollar of it reverses with a penalty attached. The only escape is for someone to remember to hit "Deactivate" in October and then remember, unprompted, to hit "Reactivate" the following May. Nothing reminds them: the system contains exactly one scheduled job and it sends one template.

Both failure modes lose the customer. Bill them through the winter and they cancel angry and dispute the charges. Pause them and you silently forfeit the entire next season (~$834) because nobody remembered — and there is no "last year's mosquito customers" list and no April email anywhere.

Worse, the pause workaround is itself broken. Resuming a plan restarts billing but creates no visit — the next-visit engine only fires on job completion. So a May reactivation charges $139/mo while the customer receives nothing until someone hand-creates a job. And the recurring engine has no seasonal awareness at all, so it will cheerfully queue a mosquito treatment in January and dispatch a tech to spray a frozen yard.

This is a regression too: FieldRoutes carries seasonal start and end dates as first-class subscription fields.

**Minimum viable shape:** Add an end date (or season start/end months) to the plan, and have the subscription pass Stripe a cancel-at date so billing stops in October by itself. Gate the recurring engine on the season window so no visit is queued outside May–October. Then the reactivation is a second scheduled job: every April, list plans that ended last season and email a one-click "same as last year?" — the highest-margin email in the business, and it does not exist.

Today is mid-July. The deadline is roughly three months out.

#### 9. Marketing attribution is a free-text box that nothing reads, so Thumbtack ROI is unknowable

**What it is:** Lead source is an unvalidated text input with the placeholder "Website, referral, Thumbtack…". It is read in exactly two places, both cosmetic — a line on the customer's own detail page and a subtitle on the Leads list. No enum, no aggregation, no report. "Thumbtack", "thumbtack", "TT" and "Tumbtack" are four different sources. And the field disappears from the edit form the moment a lead converts (`apps/crm/src/office/CustomerDetail.tsx:882` passes `showLeadSource={isLead}`) — so at the exact moment attribution starts to matter, it becomes uncorrectable.

The other half is equally dead. The lead fee is stored on every pricing run and read in exactly two places, both per-row display. There is no sum anywhere. And the outcome that would make it computable is never set: every run is stamped PENDING on creation, nothing ever writes WON, and the outcome control on the pricing log omits SENT — the one value the engine itself writes — so a run whose agreement was sent renders with nothing selected and the value is destroyed once a human touches it. Even the manual workaround is sabotaged. The pricing engine also never sets the source field, so website runs and Thumbtack runs are indistinguishable in the log.

**What it costs:** The decision that most affects margin — keep paying Thumbtack lead fees or not — cannot be answered from this app. You cared enough to build an entire 3× gross-profit gate around the lead fee and to make the engine refuse to quote until someone enters it. Then nothing adds it up. You cannot compute cost per acquisition, cost per won job, or revenue per channel. At the end of Q3 the log has 300 rows, nearly all still PENDING because nobody does manual outcome tagging, with no source field to separate the channels. The renewal decision gets made on gut feel.

The app also already writes "Website booking" as a source string from the booking funnel, so the machine and the humans are writing different vocabularies into the same column — before any typo.

Note this is a *reporting* gap, not a data gap: every field already exists on the pricing run. The fix is a group-by and a sum, not new plumbing, which makes the omission harder to justify.

**Minimum viable shape:** Two things. Close the loop automatically: when a quote converts or an agreement is signed or a booking finalizes, flip the originating pricing run to WON — the linkage already exists via the quote id. Add SENT to the outcome control so a human can no longer destroy the value the engine wrote. Then put the number on the Dashboard: lead-fee spend this month, won revenue attributed to those leads, and the ratio, split by source (which needs the pricing engine to actually write the source field it leaves null). Make lead source an enum written by the code paths that already know the truth, and keep it editable after conversion.

#### 10. The Dashboard cannot state your recurring revenue

**What it is:** The office Dashboard has six numbers — Billed, Paid, Unpaid, Failed, Open leads, Active customers. None of them is MRR. The screen loads every service plan into the browser and uses it for exactly one thing: building the "needs attention" list. The plan price is never summed. There is no MRR, no ARR, no churn, no revenue retention, no plan mix. The word MRR does not appear anywhere in the codebase.

**What it costs:** Recurring plans are the business, and the app can tell you what was billed last month (with several known distortions) but cannot tell you what you are contracted to bill next month — the number that tells you whether the company is growing.

This lands harder than usual because of the billing gap: your ACTIVE plans and your actually-billing plans are different sets, and nothing distinguishes them. The Dashboard filters plans on `status === "ACTIVE"`, not on whether a Stripe subscription exists. So the single report that would expose the biggest money hole in the product — "active plans not billing, and the monthly dollars at risk" — is one subtraction away from data already sitting in the browser, and it does not exist.

Stripe's own dashboard shows MRR for subscriptions it holds, which partly covers Jake. But Stripe structurally *cannot* answer this one, because it only knows plans that have a subscription. "What did I sell but am not billing" exists nowhere.

There is a related blind spot on the customer record: no page anywhere shows lifetime spend, so when a customer calls to cancel, the office cannot tell a four-year $99/mo account from a one-time wasp nest. Retention effort is allocated blind.

**Minimum viable shape:** Two tiles, both computed from data the Dashboard already has in memory. Contracted MRR — the sum of prices across active plans *with a live subscription*. And "At risk" — the same sum across active plans with no subscription, rendered as a clickable list. That second tile is the biggest money hole in the product expressed as a number, and it should be a daily worklist until the billing automation ships. Add lifetime paid to the customer record. Add churn once a cancel reason exists to attribute it to.

#### 11. You cannot send a customer an invoice they can pay, which disqualifies HOA and commercial accounts

**What it is:** There is exactly one way money enters this system: an employee charges a card that is already saved on file. There is no Stripe invoice, no hosted payment page, no payment link, no "email this customer a bill" action, and no due date, terms, or PO field on the invoice model. (There are technically three money-in paths — saved card, saved bank account via ACH, and the booking funnel's self-pay checkout — but none of them is "send a bill and let them pay it.")

**What it costs:** This is survivable for residential autopay. It is fatal for the accounts you most want. Your rate cards explicitly price HOA common areas and commercial properties — your largest tickets, every one of which escalates to Jake personally by design. But an HOA does not hand a pest control vendor a credit card. A property management company pays by check, on net-30, against an emailed invoice with a PO number, approved at a board meeting. Many association bylaws prohibit leaving a card on file for auto-debit. BuzzKill cannot produce that document, transmit it, give it a due date, or track it as a receivable.

That is why "Record offline" exists in the manual charge sheet: it is a crutch compensating for a missing capability, and it is the same two-tap control that lets an employee mark any balance collected with no audit trail. So the "Unpaid" tile is crude AR — it counts what someone typed as owed, not what was billed.

There is a workaround: Jake can send a net-30 invoice from the Stripe dashboard in about two minutes. But it does not reach the CRM. The webhook that mirrors invoices bails out unless the invoice carries subscription metadata, so a hand-made HOA invoice paid in Stripe is silently dropped — the money lands in the bank and never appears in Billed/Paid/Unpaid. Your revenue numbers quietly understate reality with no error and nothing to notice.

And the customer cannot pay from the portal either: the invoice list is read-only with no Pay button. A customer shown a debt and given no way to settle it reads as broken.

**Minimum viable shape:** Add a due date, terms (due on receipt / net 15 / net 30) and a PO field to the invoice, plus a billing mode on the customer or group (auto-charge vs invoice terms). For terms accounts, generate a real Stripe invoice with send-invoice collection and a due date, expose the hosted payment link in the portal, and add CHECK to the payment method options so the office can record a mailed check against a specific invoice. Add aging buckets to the Outstanding list — today it shows a date and no age.

#### 12. Every profitability constant in the business is unfalsifiable

**What it is:** The 3× lead-fee gate is the only thing standing between you and paying Thumbtack more for a lead than the job earns. It runs entirely on invented constants: 90 minutes on site for general pest, 60 for a wasp nest, and a drive model of 40 minutes / 30 miles for Zone A and 65 / 45 for Zone B. Not one of those has ever been compared to a real visit, and the app is architecturally incapable of doing so — the "Start job" button discards the arrival time at the moment it exists.

**What it costs:** Two compounding errors. The drive constants are a *single leg* — your tech drives home too — so Zone A understates drive labor by about 28 minutes and van cost by 30 miles, overstating gross profit by roughly $30/job and passing leads that actually lose money. And if a wasp nest really takes 85 minutes instead of 60, every wasp break-even is wrong and you will never know. At a few hundred customers this is the difference between Thumbtack being a profit center and a slow bleed, and you currently cannot tell which.

**Minimum viable shape:** Fix the round-trip drive immediately — that is a one-line change worth ~$30/job of decision accuracy. Add a start timestamp to the job, written from the existing "Start job" button (the hook already exists, and techs already press it because the report form is gated behind it, so the data would be near-complete from day one). Then a monthly estimated-vs-actual readout per service kind, so the constants get corrected from data instead of memory.

#### 13. No customer complaint can be recorded

**What it is:** There is no complaint, issue, or ticket concept. Eighteen models exist and none is about a customer being unhappy. The customer record has free-text notes and lead notes; the service report has no follow-up or pest-returned field.

**What it costs:** When a customer calls to say the ants are back, that call lands in a paragraph of free text — if the employee types it at all — and is never linked to the job, the technician, or the product applied. The pure analytics version of this argument does not justify itself at three techs (Jake hears the complaints). What justifies it is the contract: the signed agreement promises a free re-treatment, and the system cannot record the trigger event of a term it is obligated to honor, cannot distinguish guarantee work from billable work, and gives an untrained employee no defined path when the call comes in. Combined with the missing callback concept, quality at BuzzKill is entirely unmeasured — the only feedback loop is churn you discover after it happens.

**Minimum viable shape:** A lightweight complaint record — customer, job, technician, reason picker, opened/resolved — with a "Log a complaint" button on the customer record and an open count on the Dashboard. It only earns its keep if it links to the job and the tech; that linkage is the entire point. Build it as a linked re-treatment request, not a ticketing system.

#### 14. There is no weather or bad-day escape hatch

**What it is:** No bulk operation exists anywhere — no reassign, no batch move, no select-all. Rescheduling is one job per modal, one at a time.

**What it costs:** Your mosquito and tick programs are yard sprays and the general-pest plan's core deliverable is an exterior barrier — all rain-dependent. In New England a washed-out day happens several times a season. When it does, the office opens each stop individually and reschedules it, and no code path notifies the customer of the change. A 20-stop rain day is roughly 40 manual writes and 20 phone calls, done under time pressure by whoever is at the desk. There is also a silence gap: the reminder cron runs at 8am Eastern, and rain calls happen mid-morning *after* it runs — so moving Tuesday's jobs to Wednesday at 9am means Wednesday's reminders already fired without them. Those customers get no email at all, and their last message said Tuesday.

Worth naming precisely: the booking funnel is the one component that handles this correctly — it checks Mon–Fri, the 8-stop cap, and drive-time feasibility against a live read of the schedule. The office has none of those guardrails. So the public website is forbidden from doing what the desk person can do freely by hand, under time pressure, with nothing catching it.

**Minimum viable shape:** Do not build weather detection — Jake looks out the window. Build a "Move this day" action that bulk-reschedules a route to the next feasible day and emails every affected customer, and lift the funnel's capacity validation into a shared path the office also calls. That covers weather, a sick tech, a van breakdown, and every other bad day.

---

### Later

Real, correctly evidenced, and not urgent at this scale.

#### 15. No alerting on silent money-loss paths

The one uncovered case that matters: when the next-visit queueing fails, the error is swallowed to a log line, job completion still reports success, and that plan's next visit is lost forever. The Dashboard's "Needs attention" card *structurally cannot* catch it — its filter excludes anyone with an active plan, which is exactly and only the affected population. A paying plan silently stops generating visits and the screen says "All caught up."

The other two paths named in the review are already covered and should not be rebuilt: every email failure writes a log row with the error text and shows a red badge in the More → Email log screen (weak, but not silent), and webhook exceptions return a 500 so Stripe retries for up to three days and surfaces repeated failures in its own dashboard.

**Minimum viable shape:** Widen the existing "Needs attention" query to also flag active plans with no upcoming job. It reuses a screen the office already opens, needs no new infrastructure, and catches the loss by observing the missing record rather than trusting a notification to fire. Note: do *not* route ops alerts through the email sender — that would run the alarm through the exact subsystem whose failures it is meant to report.

#### 16. No referral mechanism, while you pay Thumbtack $60–95 a lead

Pest control is a neighbor-tells-neighbor business, and referral is the only acquisition channel with zero marginal cost. It does not exist: no referred-by field, no referral code, no credit or reward object, and no referral ask in any of the fourteen emails the system sends. Meanwhile the entire pricing engine's economics gate exists *because* a Thumbtack lead costs $60–95 against a one-time job netting $185–244 gross profit. A referred customer costs $0 and skips the gate entirely. You have built elaborate machinery to survive expensive leads and nothing at all to generate free ones.

Referrals almost certainly already happen and get typed into the lead source box as text. What is missing is the ask and the attribution, not the phenomenon.

**Minimum viable shape:** Add a referred-by link on the customer and put a referral ask in the one email a happy customer already opens — the service report, right beside the existing review link. A two-sided incentive needs a real credit object, so start with the ask and the attribution; the incentive can follow. Do not build codes and a reward ledger at this size — the self-referral fraud surface and untrained staff dispensing money cost more than the feature returns.

#### 17. No commission or upsell capture from the field

There is no commission or incentive concept anywhere. More usefully: the technician standing in the crawlspace looking at rodent droppings — the person with the single best view of an upsell — has no way to tell the office what they saw. The "Recommendations for customer" box is the closest thing, and it goes into a PDF that no office screen renders and no worklist reads. Every in-home upsell your crew notices dies in the van.

**Minimum viable shape:** Do not build commission — it is enterprise overhead at this headcount and creates a mis-selling incentive. Do surface the recommendation field the tech already fills in on the office side, and add a one-tap "flag opportunity" that creates a lead or task. It is a render change on an existing field, not a new subsystem.

#### 18. No aggregation on technician performance

The technician id is written on every job, route, and service report and never grouped, counted, or summed anywhere. There is no technicians screen (the roster is buried inside the Schedule board), no reporting screen, and the Dashboard shows only invoice money plus two counts. You cannot answer "how many stops did Dave do last month" or "who is my best technician."

Two things make this genuinely low priority. No data is being lost — the fields are all captured, so a reporting screen built in month six reconstructs months one through five in full. And the Dashboard already loads every job into the browser, so the fix is a group-by and a few lines, not new plumbing. It is also worth noting the Schedule board already shows each tech's stop count for the selected day, which is the at-capacity signal in practice.

**Minimum viable shape:** One "per technician, this month" readout: stops completed, revenue attributed, callback rate, hours. Do the callback and hours fields first — this screen is worthless without them and near-free with them.

#### 19. No applicator license expiry tracking

The technician record has no license number, category, or expiry, and the service report PDF — the legal record of a pesticide application — carries no applicator license number. Meanwhile the public site publishes three real credentials with a hardcoded green "Active" status and no expiry date rendered anywhere, so when a license lapses the site keeps telling HOA boards "Active" until someone edits the source and redeploys.

Expiry tracking with dispatch-blocking is a twenty-tech feature. At one to three licenses, a calendar reminder is the right tool, and Jake is the applicator — there is no low-skill employee making this decision. The two genuine app-caused defects are cheap: a public page asserting an unverifiable "Active," and the application record omitting the license number.

**Minimum viable shape:** Add a license number to the technician record and print it on the service report PDF. Render real expiry dates on the public credentials page, or remove the hardcoded "Active" badge and rely on the "Verify credential" links to the state lookups that are already there — delegating truth to the state is the correct design.

#### 20. No inventory, vehicle, or equipment tracking

None exists. This is correctly a non-gap at BuzzKill's scale — a couple of techs sharing one or two vans do not need a warehouse system, stale counts are worse than no counts, and van cost is already priced into every quote at $0.30/mi. A tech finding an empty jug is a phone call, and at this headcount a phone call is the cheapest correct mechanism.

The one real defect hiding inside this area is small and worth doing: the amount field on a product application is free text and is never required, so a report can be filed with a blank or garbage quantity into a legally-required Massachusetts pesticide record. The office already sets a default amount per product that pre-fills the tech's field, so the common path already produces a valid record — the gap is a missing required-field check.

**Minimum viable shape:** Do not build inventory. Make the amount a required field with a number and a unit dropdown.

#### 21. No cross-cutting audit trail

No model carries a created-by or actor field, and no audit log or history table exists. Any office user can rewrite the entire legal contract body in a free textarea before sending it, override a market rate to any value with no clamp, and free-text a quote price over the template price — with no record of who typed what or what it replaced.

The enterprise-governance framing is inflated at three staff, and the actor half substantially overlaps the invoice-actor gap already flagged elsewhere. What makes this worth mentioning at all is that the *before* values already persist independently — the plan template retains its price and agreement body, the quote retains its template link, and the market rate retains its researched value and basis — so a contract-body diff and a price override are both computable after the fact. What is genuinely absent is *who* and *why*, plus the fact that nobody runs the comparison, so overrides are invisible in practice despite the data existing.

**Minimum viable shape:** Do the cheap half. Stamp the acting user's identity server-side on every money-touching and price-touching write (the identity is already in hand at every function boundary and is simply discarded), add a required reason field on overrides, and add one exception report that flags quotes deviating from template price. Skip the full audit-log build.

---

### A note on ordering

The five cutover blockers share a shape worth naming: three of them (technician availability, callbacks, cancellation reasons) plus the time clock are **capability regressions against FieldRoutes** — the software you are paying to leave. Retiring FieldRoutes without them does not just fail to improve the business, it destroys records and controls Jake currently has. The reference documentation for two of them is sitting in this repository.

The six-month list is dominated by a single theme: **the system captures the data and never reads it.** Lead fees are collected per lead and never summed. Viewed timestamps are stamped and read by nobody. Plan prices are loaded into the browser and never totaled. Technician ids are on every record and never grouped. In almost every case the fix is a query and a screen, not new plumbing — which is what makes these worth doing and what makes their absence hard to defend.

---

## Risk, compliance and the Jake bottleneck

BuzzKill is a licensed pesticide applicator. The right to operate depends on producing compliant application records on demand. The app does not produce them.

### The pesticide record

The service report is the only artifact you hand a customer as proof of application, and it is what goes in a property manager's compliance binder and in front of an MDAR inspector. It is missing every field that makes it a record:

- **No applicator license number.** No certification, anywhere in the model.
- **No application time**, only a date — and the date is wrong (below).
- **No rate or dilution.** No EPA-registered application rate.
- **No re-entry interval**, and no pet, child, food-surface or aquarium disclosure anywhere in the product. Telling the occupant when it is safe to come back is the applicator's duty to warn.
- **Products are optional.** A report can be finalized and emailed with zero products, zero EPA numbers and zero quantities. The finalize gate is client-side only.

Three of these compound into something worse than absence:

**The service date is the wrong date.** `serviceDate` is stamped when the draft is first saved and the update path never touches it. A report written up the next morning, or on a Sunday catching up on paperwork, carries the wrong date on a legal record, and it can never be corrected.

**The record is mutable after finalize.** A tech can rewrite a report that has already been sent. A regulatory record that can be edited after issuance has no evidentiary value — and in an enforcement action it is affirmative evidence of an uncontrolled system. That is worse than having kept nothing.

**Techs write the catalog.** `Product` grants create to TECH. A technician in manual-product mode taps "Save to log" and that row becomes a permanent, active entry in the master pesticide catalog that every other tech picks from — instantly, with a blank or invented EPA number, no approval, no notification. The catalog is the control that is supposed to make records correct by construction. It is writable from a phone in a crawlspace.

### The GPS attestation is a false statement

The PDF asserts in writing that the technician was physically on the customer's property. The stamp is never compared to the service address, has no accuracy floor, and carries over from a previous day's draft. That is a claim of proof the system does not have, printed on a document you would hand a lawyer in a misapplication claim.

It gets worse in combination with #14 on the priority list: a tech facing a locked door has no way to say "nobody was home." The only way to clear the screen is to file a report for a visit that never happened. The system's path of least resistance is a fabricated pesticide record carrying an unverified GPS attestation. You have not just failed to prevent that — you have made it the easiest thing to do.

### The e-signature may not be enforceable

E-SIGN and UETA make an electronic signature binding only if you can show the signer intended to sign and consented to electronic records. The PDF asserts both. The code supports neither: the consent checkbox is client-side only, and `signerEmail` is copied from the customer record rather than verified against the person who actually signed. You capture name, IP, timestamp and user agent — real evidence — attached to a consent you cannot prove and an identity you never checked.

Separately, the contract itself is a textarea. Any office user can rewrite binding terms free-hand, and the shipped default contradicts the company's actual cancellation behavior.

### The contract contradicts itself three ways

Covered in the priority list, and it belongs here too: published Terms say 24 hours, the agreement says 30 days, the code enforces 3. Ambiguity in your own drafting is construed against you, so each customer effectively gets whichever term suits them best. And `/book` hard-requires `tcAccepted === true` while never rendering the terms being accepted — an acceptance of nothing, recorded as consent.

### Who can see what

Every technician can read every customer's signed agreements, service reports, and the full customer table including billing addresses and card metadata. Your field roster is where turnover is highest and background depth is lowest, and each of them holds the entire book of business. A tech needs today's stops and the history for the property they are standing at. That is the access to grant.

Inside the office role there is no privilege boundary at all. Any office user can mint another office user in one tap — a role that can charge $20,000 to any card, record fake payments, and rewrite contract text. No confirm, no owner approval, no way to remove one.

### The Jake bottleneck

You asked whether this lets you take two weeks off. It does not, and the code says exactly why.

Every association and HOA lead escalates unconditionally (`rateCards.ts:199`). Termite always escalates. Commercial over 15,000 sqft escalates. Commercial one-time over 5,000 sqft escalates. All of it routes to one inbox, by hand, with no queue, no SLA, no tracking, no second reviewer — and the escalation email can fail silently while the screen promises the customer a callback.

The cruelty of it is that HOA is your highest-value segment, $110–$405/mo per property multiplied across a portfolio, and it is the *only* segment with zero automation. The rate card already computes an HOA price correctly. It computes it, and then throws it away and emails you.

For you to be unreachable for two weeks, four things must be true:

1. **HOA quotes below a threshold you set go out automatically.** The card already prices them. Let it. Escalate on contract value or insurance complexity, not on the word "association."
2. **Escalations are a queue with an owner and an SLA, not an email.** A record with a state, visible on a screen, that someone other than you can clear. Email delivery failure must be loud.
3. **Someone other than you can approve an off-card price.** Today the alternative to your judgment is a free-text box with no approval — which is not delegation, it is abdication.
4. **The termite and large-commercial paths have a named human who is not you.** If there isn't one, that is a hiring decision the software cannot solve, and you should know that is what it is.

---

## What Engineering Should Do Next

### 1. STOP

**Stop adding features to the booking funnel.** Roughly 4,000 lines of backend — live drive-time zones, an availability engine, dynamic day pricing, AI market research, Stripe idempotency, auto-generated agreements, a refund policy engine — cannot be reached by a single human being. `apps/web/src/App.tsx` defines no `/book`, no `/quote`, and no `/cancel` route, and `grep bookingApiUrl` across `apps/web/src` returns nothing. Every hour spent refining pricing modifiers or capacity math on this funnel earns $0 until someone builds the page. Either commit to shipping the front end (with the fixes in section 2) or stop maintaining the backend.

**Stop building on the AI market-rate engine.** `apps/web/amplify/functions/booking-public/marketRate.ts` has an LLM setting the price for two of six bookable services inside a 12.5x band, scraped from prose with a regex, cached 90 days, with an office override that bypasses the clamp entirely. It replaced a half-hour of Jake writing a table with a 640-row review queue nobody will work. Jake has priced rodent and roach jobs by hand for years. Do not extend it, do not fix it — replace it with rate-card rows.

**Stop treating the GPS stamp as proof of anything.** `apps/web/amplify/functions/shared/pdf.ts:329` prints "confirming on-site presence" on a customer-facing legal document. The coordinates are never compared to the customer's address; the service address is assembled ten lines earlier in the same handler and never used. Do not build more on top of this assertion until it is either verified or deleted.

**Stop the "Save to log" button in the tech app.** `apps/crm/src/tech/JobDetail.tsx:565` lets a technician write a permanent, active row into the company's regulated pesticide catalog with a blank EPA number. It unblocks nothing — the manual row already saves to the report without it. It only writes to the master list every other tech picks from, and the tech cannot fix their own typo.

---

### 2. FIX BEFORE LAUNCH

These are the rules that must be true before this replaces FieldRoutes. Each is stated so a tester can prove it.

**Money in**

1. **Every payment the booking funnel collects must create a PAID Invoice row.** `apps/web/amplify/functions/shared/bookingFinalize.ts` creates a Customer, ServicePlan, Job, and Agreement and no Invoice. Test: pay for a wasp job on the website; an Invoice with status PAID, the Stripe PaymentIntent id, and the job id must exist within seconds. This single change repairs the Dashboard, the portal invoice list, and the double-charge guard at once. It is the highest-leverage line of code in the review.

2. **A job that has already been paid must not display a Charge button.** Test: complete a website-booked one-time job in `apps/crm/src/office/CustomerDetail.tsx`; the row must show a green "PAID $299 online" chip and no charge control. The current visibility test is `!invoice`, which is permanently true for every website booking.

3. **No button that moves money fires without a confirmation that restates the amount, the customer, and the card.** Test: tap Charge; a dialog reads "Charge Jane Smith $299.00 to Visa ••4242? This cannot be undone from the CRM." Today the only money-moving button in `CustomerDetail.tsx` is the only one without a confirm — Complete and Cancel both have one.

4. **A manual charge above $500 must require the amount to be re-typed, and the ceiling must be a plausible BuzzKill job.** The current cap is $20,000 in `apps/web/amplify/functions/crm-billing/handler.ts:352`, which sits above every realistic typo and therefore catches none. Test: type 14900 in the Amount field; the system refuses or forces a second confirmation before $14,900 leaves a customer's card.

**Money out**

5. **The office must be able to refund a customer from the CRM.** Test: open a PAID invoice, tap Refund, enter an amount; Stripe refunds it and the Invoice status becomes REFUNDED. Today the only `refunds.create` in the repo is `apps/web/amplify/functions/booking-public/handler.ts:689`, reachable only through a link that 404s. Until this exists, Jake personally is the refund department and cannot take a vacation.

6. **A refund or dispute issued in the Stripe dashboard must appear in the CRM.** Test: refund a charge in Stripe; the Invoice flips to REFUNDED and drops out of the Dashboard's Billed figure. `apps/web/amplify/functions/stripe-webhook/handler.ts` handles six events; `charge.refunded`, `charge.dispute.created`, and `charge.dispute.closed` are not among them.

7. **Cancelling a paid appointment must state the refund outcome in dollars before the tap, and issue it.** Test: cancel a job the customer paid $299 for, 15 days out; the confirm reads "This visit was paid $299 on 7/12. It is 15 days out — cancelling refunds $299 in full. Continue?" and the refund is issued. Today `CustomerDetail.tsx:663` is a raw status write behind "Cancel this job?" — no refund, no email, no invoice touch.

8. **Cancelling a plan must cancel the Stripe subscription.** Test: cancel a booking through the funnel path; `stripe.subscriptions.cancel` is called before the record is written. `booking-public/handler.ts:702` writes `status: "CANCELED"` and never touches Stripe. Charging a customer after they cancel, under a contract that says "Cancel anytime," is the fact pattern that ends payment processing relationships.

**Recurring revenue**

9. **Completing the first visit on a plan must start the subscription.** Test: finalize the first service report on a recurring plan with no `stripeSubscriptionId`; a Stripe subscription is created, anchored to the visit date. This is Jake's locked rule and it currently exists only as a comment at `bookingFinalize.ts:172`. `startSubscription` has exactly one caller in the entire repo — a small button at `CustomerDetail.tsx:499`. A forgotten click is $1,188/yr of lost margin per customer while you keep sending a tech.

10. **An active plan with no subscription must appear on the Dashboard.** Test: create a plan, don't start billing; a tile reads "Plans active but not billing (1) — $99/mo at risk" and a worklist lists it. Today `Dashboard.tsx:102-104` counts an ACTIVE plan as coverage regardless of whether it bills, so the leak is invisible by construction. Ship this tile before the automation lands — it converts a silent leak into a visible chore in an afternoon.

11. **A quarterly plan must not bill twelve times a year unless the row says so.** `crm-billing/handler.ts:195` hardcodes `interval: "month"` while the row renders "$45/mo · service quarterly". Decide which is true, then make the screen say what is actually charged and how often. If monthly billing of a quarterly visit schedule is intentional (and the code suggests it is), the label must read "$45/mo, billed monthly · visits quarterly" so a CSR can say it out loud to a customer.

12. **A seasonal mosquito plan must stop billing at season end.** Test: create a mosquito plan in June; Stripe stops collecting after October without anyone clicking anything. `rateCards.ts:310` labels it "(May–Oct)" and bills it monthly forever. That is $834/yr per customer charged for service never promised.

**The field**

13. **A technician facing a locked door must have a button for it.** Add NO_ACCESS to JobStatus in `apps/web/amplify/data/resource.ts:38`, with a one-tap reason and a photo. Test: tap "Customer not home"; the job does not complete, no charge button arms, no next recurring visit is queued, the day's capacity is freed, and an office task is created. Today the only control that clears the tech's screen is the one that fabricates a service record. This is the highest-value missing button in the product, and it removes the incentive behind three other findings.

14. **The field labeled "Internal notes (not shown to customer)" must not be printed on the customer's PDF.** Delete `section("Technician notes", opts.techNotes)` at `apps/web/amplify/functions/shared/pdf.ts:311` and drop the argument at `crm-docs/handler.ts:229`. Ship this today. It is one line, and it is a defamation letter waiting for a bad day. Then audit already-sent reports — some are already out.

15. **A service report must not finalize without a pesticide record.** Test: call `finalizeServiceReport` directly with no product rows; it is rejected. Both current checks live only in React. Require at least one product with a name, an EPA number matching a real format, a quantity with a unit, and a target pest — or an explicit "inspection only, no product applied" flag.

16. **A report must not finalize for a job dated in the future, and only the assigned technician may finalize it.** Test: arrow forward to next Tuesday, open a job; the report form does not render. Today nothing anywhere compares `job.scheduledDate` to today, and `crm-docs/handler.ts:60` authorizes any TECH to finalize any report on any job.

17. **A technician must not be able to read a customer they were not assigned.** Delete the staff short-circuit at `crm-docs/handler.ts:427` and scope the TECH read on Customer in `data/resource.ts:117`. Strip billing address, Stripe customer id, and card metadata from anything a TECH token can resolve. No technician's job requires knowing a household's card brand. Pair with a disable-user mutation so a departing tech is offboarded in one tap rather than an AWS console session.

**Dispatch and capacity**

18. **Assigning a job must not silently move an appointment the customer paid for.** Test: with the board on July 15, assign a job whose row reads "wants Aug 4"; the system refuses and says to open Aug 4, or forces a confirm naming both dates. `Schedule.tsx:112` writes `scheduledDate: date` unconditionally.

19. **The office board must enforce the same capacity rule as the website.** `STOPS_PER_TECH = 8` exists only in `booking-public/availability.ts`. Test: assign a ninth stop to a tech; the board blocks it or requires a recorded override, and each tech's card reads "6 / 8". Today the funnel refuses a stranger's ninth booking while the board lets a new hire pile on thirty.

20. **A technician being out for a day must be expressible without hiding their work.** Add a per-tech unavailability record. Test: mark a tech out Thursday; their capacity leaves Thursday only, their assigned jobs appear in the pool as "Needs re-assignment," and no customer gets a T-1 reminder for a visit nobody will make. Today the only lever is Deactivate, which hides eight jobs while they keep emailing customers and keep consuming booking capacity — and cannot be reversed from the UI.

21. **A paid, dated job with no technician must not generate a customer reminder.** `daily-reminders/handler.ts:51` filters on status alone. Test: create a paid booking, assign nobody, wait for T-1; the customer gets nothing and the office gets an alert instead.

**Disclosure and contracts**

22. **A customer must see the cancellation policy before their card is charged.** Move `CANCEL_POLICY_TEXT` out of `bookingFinalize.ts:11` into a shared module the quote endpoint, the book endpoint, the agreement, and the website all read. Test: the quote response carries the verbatim policy text and a version; the page renders it above the pay button; `/book` records the acknowledged version, the click timestamp, the source IP, and the user-agent on the BookingRequest. Today the terms exist only in a PDF generated after the money moves, and `/book` accepts a bare boolean.

23. **The published Terms of Service must state the policy the code enforces.** `apps/web/src/pages/TermsOfService.tsx:83` says 24-hour notice; the agreement template says 30 days; `booking-public/handler.ts:645` enforces 3 days. Three live policies, construed against the drafter. Pick one per product line, define it once, import it everywhere.

24. **The 30-day notice clause must be implemented or deleted.** `agreementTemplate.ts:13` promises it; `crm-billing/handler.ts:223` cancels immediately on every single cancellation, waiving it by conduct every time.

25. **An office employee must not be able to free-hand contract terms.** Lock the agreement body to the PlanTemplate, version it, and remove the textarea from the send path. Test: open "+ Agreement"; there is no editable body. Today any office user can rewrite binding terms and email them with no approval, no diff, and no record of what changed.

26. **A quote must not price below the rate card without an explicit, recorded override.** `QuoteSheet.tsx:66` validates only `cents > 0` — $1.00/mo is a valid contract — and AI-priced templates prefill the box empty. Test: the price field is read-only and populated from the rate card; deviating requires a toggle, a typed reason, and stamps the acting user.

27. **A manually quoted recurring plan must carry the initial fee.** `QuoteSheet.tsx:78` never sets `initialFeeCents`, and `agreement-public/handler.ts:112` gates the initial-visit job on it being greater than zero. So the manual path — the one a CSR uses for anyone who phones in — drops $99 and creates no first visit. Test: quote a quarterly plan manually; the Quote carries the fee and signing creates the initial visit.

**Pricing correctness**

28. **The gross-profit model must charge for the round trip.** `rateCards.ts:389` adds the drive once, while Zone A is defined as up to 50 minutes *one way*. Every one-time job's margin is overstated by $37–$59, so the 3x lead-fee gate is approving leads it was written to reject. Re-derive every break-even afterward and show Jake the new numbers before the gate starts declining leads he is used to winning.

29. **The HOA rate card's 101+ bracket must be monotonic.** `rateCards.ts:160` has BIMONTHLY at $150 and QUARTERLY at $180. At 301 units, quarterly costs $800/mo and bimonthly $775 — the customer pays more for two fewer visits a year, and you deliver 50% more truck rolls for 11% less money. Add a test asserting quarterly < bimonthly < monthly across every bracket and unit count.

30. **The price-consistency guard must not whitelist the prices it exists to catch.** `crm-pricing/handler.ts:345` unconditionally allows the literals "$15" and "$99". In Zone B the initial fee is $124. Delete the exemption, and make `templateReply` omit the initial-fee clause when there is no fee rather than defaulting to $99 — which currently promises a phantom $99 charge on every mosquito lead.

31. **An unknown drive time must not produce a bookable price.** `booking-public/handler.ts:378` prices UNKNOWN as Zone B "to be safe." That overcharges every customer near HQ during a Google outage and lets an unroutable Vermont address book an instant price, because the out-of-area gate only tests for OUT. Route UNKNOWN to the callback path the funnel already has for six other conditions, and alarm when it fires.

---

### 3. BUILD NEXT

In order.

1. **A BookingRequest screen in the CRM.** Zero files in `apps/crm/src` reference BookingRequest. The model is already indexed on status and cancel token with office read and update permissions — the backend is built and no human can see any of it. Every website lead, every paid booking, every "a specialist will call you within the hour" promise lives in a table with no screen. Build the worklist: CONTACT rows oldest first, an age timer that turns red at sixty minutes, an owner, and a required outcome. **Business reason:** these are the highest-intent leads on the website — termite, wildlife, commercial, HOA — and today they exist only as an email in a shared inbox.

2. **The booking page and the cancel page.** Ship them together with the disclosure fixes above. **Business reason:** it is the only revenue channel with no lead fee and no office labor, and the backend is done.

3. **The daily exception sweep.** One cron, one queue somebody clears to zero each morning: paid jobs unassigned within seven days, plans active with no subscription, invoices failed or open past N days, reports stuck in draft, jobs left in progress overnight. **Business reason:** every silent failure in this review shares one root cause — nothing tells a human. The app has exactly one scheduled job today and it sends appointment reminders.

4. **Dunning.** On a failed payment: email the customer the real decline reason with a working link, create an office task, and after N failures pause the plan so you stop servicing for free. Add a Pay button to the portal invoice row and a Retry button to each outstanding row. **Business reason:** dead cards are the largest collection leak in any recurring business, and today a failed payment produces a red badge and nothing else — the customer cannot pay even if they want to.

5. **Rate cards for rodent and roach.** Replace the AI market-rate engine with sqft-banded cards priced through the same zone-aware, cost-floored path as general pest. Floors must be cost-derived — $199 does not clear cost at 90 minutes onsite plus $55 of materials in either zone. **Business reason:** it is cheaper, more consistent, faster (no 30-second spinner), explainable to a customer, and Jake already knows the numbers.

6. **The metrics that decide things.** Recurring revenue from plans with a live subscription; lead-fee spend against won revenue by source; churn with a reason code. All computable from data already in the tables. **Business reason:** the Dashboard currently answers none of the questions that decide whether to buy more Thumbtack leads or hire a third tech.

7. **The compliance file for portfolio accounts.** Service reports across every property in a group, filterable, exportable, with product, EPA number, quantity, target pest, date and address. The backend already authorizes it — `crm-docs/handler.ts:429-438` checks the group; the portal just never asks. **Business reason:** it is the deliverable that makes an HOA account renew, and it is one list call away.

8. **Consolidated billing for management companies.** Add a billing customer on Customer and a group id on Invoice; one Stripe customer, one payment method, one invoice with per-property lines. Add net-30 terms, a due date, and a PO field. **Business reason:** HOAs pay by check against an invoice after a board vote. Until this exists, do not sell to management companies — the segment with the best unit economics is disqualified on procurement grounds before price is discussed.

9. **Actual time on site.** Add a start timestamp to Job and stamp it on the Start button that already fires. **Business reason:** every price BuzzKill charges, the 3x lead-fee gate, and the funnel's capacity model all rest on assumed onsite minutes that have never been checked against a real visit. The data flows through the tech's phone every day and is discarded. It is one line.

10. **A "found extra work" button in the field.** The tech is the only person from BuzzKill physically at the property and the only one who can see that the quoted one nest is four. Give them a picker of rate-card items with the price already computed, writing an office task. **Business reason:** every on-site upsell currently dies in the van.

---

### How to know it worked

The proof is not in the code, it is in what stops happening.

Jake stops being the pricing department: an HOA under fifty units and a commercial job under 15,000 square feet get quoted same-day by whoever is at the desk, and the only things that reach his phone are the deals that genuinely need his judgment. He takes a week off and no quote waits for him.

A CSR hired on Monday takes a cancellation call on Tuesday, reads the refund amount off the screen, taps once, and the customer is made whole — without asking anyone, without counting days, and without knowing there is a policy. The same CSR never double-charges a website customer, because the screen says PAID in green and the button is not there.

Jake's Dashboard number matches his Stripe payouts. Every dollar the website collects appears in the ledger the day it lands. No invoice sits in FAILED for more than forty-eight hours without a human being told, and no customer is billed after they cancel.

Every active plan on the books is either billing or on a worklist with someone's name on it — and the count of unbilled active plans is zero, checked daily by someone who did not have to know to look.

A tech at a locked door taps "Customer not home," a reason, and a photo, and drives on. No customer ever receives a service report for a visit that did not happen, and no card is ever charged for one. Every pesticide record BuzzKill produces carries the applicator's license number, the product, the EPA number, the rate, and the re-entry interval — and would survive an inspector reading it.

And the number that matters most: at the end of a month, Jake can answer "did Thumbtack pay for itself?" by looking at one screen, and act on the answer.
