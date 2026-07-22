# Public site — required fixes for the UI overhaul

Findings from the July 2026 business reviews (`docs/business-reviews/`) that land on
public marketing-site UI. That UI is frozen pending the overhaul, so these were
**deliberately not fixed** in the FieldRoutes-decommission work — they need to land
with, or before, the new site.

Verified against the code on 2026-07-15. Line numbers are from that commit.

## Blockers — these are false or broken promises

### 1. "Customer Login" points at a system being decommissioned
`src/components/Header.tsx:75` and `src/components/Footer.tsx:105` both hardcode
`https://buzzkill.fieldportals.com/landing/index`. Every new customer record now lives
in the CRM portal, so this link sends customers to an account that does not contain
their records.

The replacement is the CRM app, but its URL is environment-dependent
(`https://staging.d5ln2hbbp9s2j.amplifyapp.com` vs `main.…`), so this needs an env var
(`VITE_PORTAL_URL`) rather than a hardcoded swap — which is why it wasn't a one-line fix.

### 2. The cancellation link in booking emails 404s
`amplify/functions/shared/bookingFinalize.ts:297` emails
`${MARKETING_URL}/cancel?token=…`. `src/App.tsx` declares 12 routes and none is
`/cancel`. Either build the route or stop sending the link.

Not currently reachable by customers (the booking funnel is not wired up — see below),
but it ships the moment booking goes live.

### 3. Terms of Service contradicts the enforced refund rule
`src/pages/TermsOfService.tsx:83-84` says "24-hour notice is typically required to avoid
cancellation fees." The booking API enforces a **3-day** full-refund cutoff
(`booking-public/handler.ts:645`, `CANCEL_FULL_REFUND_DAYS = 3`). Jake's decision is the
3-day rule; the published copy is wrong. There are four different cancellation policies
published across the site — exactly one matches the code.

### 4. Promised self-service does not exist
Four pages advertise online scheduling and payment. There is no public booking UI.
The portal is read-only apart from saving a card: no pay, retry, reschedule, cancel, or
request-service. Either build it or remove the claim.

### 5. Microsoft Clarity session replay runs with no consent gate
`index.html:37-44` loads Clarity (project `wan5977c41`) unconditionally, no env guard.
`src/pages/PrivacyPolicy.tsx` refers to a cookie banner that does not exist.

**Decision (Jake, 2026-07-15): keep the tag; the overhaul ships the consent banner.**
This is the overhaul's job — it is a live exposure until then.

### 6. Privacy Policy documents programs that don't exist
- Describes a full SMS program (confirmations, arrival updates, STOP/HELP). There is
  **zero** SMS capability in the codebase.
- Promises an unsubscribe link in marketing messages. No unsubscribe mechanism and no
  marketing email exist.

Either build them or delete the claims — a privacy policy describing practices you don't
have is worse than one that says nothing.

### 7. Unsubstantiated statistics
`src/pages/lp/LPProtect.tsx:18-31` hardcodes three statistics with no source, including a
bare "#1" claim. `src/pages/LicensedInsured.tsx` hardcodes licence statuses as "Active"
with no verification, and city pages claim RI-licensed *technicians* not evidenced by the
listed credentials (which show a company registration, CP-PCR-000045).

Needs sourcing or removal. **Open question for Jake:** do BuzzKill's technicians hold RI
applicator licensure, or only the company registration?

## Context the overhaul needs

### The lead form contract changed
`lead-intake` no longer talks to FieldRoutes, and no longer prices or auto-contracts.
See `apps/web/INTEGRATION.md`. Two things the new forms must preserve:

1. **Branch on `result.ok`.** Never show success otherwise. LPCall used to show success
   unconditionally with the comment *"Even on error, show success — we'll get the lead
   from CloudWatch"*; every one of its leads was destroyed. `submitLead` does **not**
   throw on a rejection — it returns `{ok: false}`, so a bare `try/catch` is not enough.
2. **`agreementUrl` is gone.** The old flow redirected customers into a signable contract
   generated from a price table that disagreed with the CRM rate card ($69 vs $99) and
   bypassed HOA escalation. The dead `agreementUrl` branches in `ContactForm`,
   `Schedule`, `LPQuote` and `LPProtect` are inert and should be deleted with the
   rewrite. Pricing belongs behind the CRM rate card, applied by a human.

`captureAttribution()` runs once on mount in `App.tsx` and stashes first-touch
utm/gclid/referrer in `sessionStorage` — keep that call, or attribution breaks. Consent
copy is rendered next to each submit button and stored as evidence; keep it visible.

### The booking funnel is not reachable
`bookingApiUrl` has no consumers in either app's `src/`, and `tcAccepted` — hard-required
at `booking-public/handler.ts:522` — is produced by nothing in the repo. The whole
paid-booking path is dead code today. Several scary-sounding review findings (capacity
oversell, charge-without-invoice) are real but have no live victims. If the overhaul
wires up booking, those become live immediately — they are launch gates, not a backlog.
