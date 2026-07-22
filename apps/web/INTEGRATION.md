# Lead-form → CRM integration

Every public form on the marketing site posts to an Amplify Function
(`amplify/functions/lead-intake`) which writes the lead directly into the CRM
as a `Customer` in `LEAD` status. The CRM is the only system of record.

```
Browser (ContactForm, Schedule, lp/LPQuote, lp/LPProtect, lp/LPCall)
        │  POST { first, last, email, phone, addr, …, formId, consentToContact, attribution }
        ▼
Lambda  lead-intake (Function URL, CORS-locked, no auth)
        │  Customer.create({ status: "LEAD", … })   via IAM-authorized Amplify Data
        ▼
CRM     Leads screen (apps/crm/src/office/Leads.tsx)
```

## Contract

The endpoint has exactly two outcomes. There is no partial success.

| Result | Meaning |
| --- | --- |
| `200 { ok: true, leadId }` | The lead is durably in the CRM. Safe to thank the customer. |
| `422 { error, missing }` | Not enough to act on — no name, or no email *and* no phone. |
| `502 { error }` | The CRM write failed. The lead is **not** stored; the office is paged by email with the raw payload. The form must show the error and the phone number. |

Callers must branch on `result.ok`. Never show a success state otherwise — a
customer who is told "we'll call you" when nothing was recorded is a lost sale
and a broken promise.

## What this endpoint deliberately does not do

It does **not** price, quote, or generate an agreement.

Until July 2026 it auto-generated a signable contract from a price table that
lived in the Lambda. That table disagreed with the CRM rate card (residential
monthly was $69 here and $99 there), and it auto-contracted HOA properties that
the rate card says must be escalated for manual review. Pricing now happens only
behind the CRM rate card, where escalation rules and margin floors are applied
by a human before anything is sent to a customer.

## Validation

Minimal by design: a name, plus an email address or a phone number. Everything
else — property type, frequency, unit counts, square footage — is captured into
`leadNotes` for the office to chase.

`Customer.email` and `Customer.phone` are format-validated by AppSync, so a
malformed value would reject the whole record. The handler normalizes what it
can (10/11-digit US numbers → E.164) and preserves anything unusable verbatim in
`leadNotes` rather than dropping the lead.

## Consent and attribution

- `consentToContact` / `consentText` are stored on the Customer as
  `contactConsent` / `contactConsentAt` — TCPA evidence for calling or texting.
  Absent means email-only follow-up, and the office notification says so.
- `attribution` (utm_*, gclid, referrer, landing page) is captured **first-touch**
  by `captureAttribution()` in `src/lib/leadIntake.ts`, called once on app mount
  in `App.tsx` and stashed in `sessionStorage`. Reading the URL at submit time
  would credit every lead to the form's own page.

## Local development

```bash
cd apps/web
npx ampx sandbox     # generates amplify_outputs.json with the Function URL
npm run dev
```

`src/lib/leadIntake.ts` resolves the endpoint from `VITE_LEAD_INTAKE_URL` if
set, otherwise from `amplify_outputs.json` (`custom.leadIntakeUrl`, published by
`amplify/backend.ts`). With neither, submitting surfaces an error rather than
failing silently.

## Deployed branches

No secrets are required. The function needs schema access, granted by
`allow.resource(leadIntake)` in `amplify/data/resource.ts`; `SES_FROM_EMAIL`,
`SES_NOTIFY_EMAIL` and `CRM_APP_URL` are injected in `amplify/backend.ts`.
