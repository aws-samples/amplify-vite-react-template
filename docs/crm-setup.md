# BuzzKill CRM — deployment setup

What Jake needs to configure in the consoles before the CRM's Stripe billing
goes live. Everything else deploys automatically with the repo.

## 1. Stripe (required for billing)

Create/log into the BuzzKill Stripe account (test mode first), then:

**Secrets on the WEB Amplify app (`BuzzKill`, d26qpsjewk0bee — it owns the
backend), per branch (staging/main):** Amplify Console → App settings →
Secrets:

| Secret | Value |
| --- | --- |
| `STRIPE_SECRET_KEY` | `sk_test_…` (later `sk_live_…`) |
| `STRIPE_WEBHOOK_SECRET` | signing secret from step below |

**Webhook registration** (Stripe dashboard → Developers → Webhooks → Add
endpoint): the endpoint URL is in the deployed `amplify_outputs.json` as
`custom.stripeWebhookUrl` (also visible in the Amplify build logs). Events:

```
setup_intent.succeeded
payment_intent.succeeded
payment_intent.payment_failed
invoice.paid
invoice.payment_failed
customer.subscription.deleted
```

Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.

**Env var on the CRM Amplify app (`BuzzKill CRM`, d5ln2hbbp9s2j):**
`VITE_STRIPE_PUBLISHABLE_KEY` = `pk_test_…`. (Amplify build forwards `VITE_`
vars into the bundle.)

Sandbox equivalents: `npx ampx sandbox secret set STRIPE_SECRET_KEY` etc. in
`apps/web`, and a local `.env` with `VITE_STRIPE_PUBLISHABLE_KEY` in
`apps/crm`.

## 2. Google Maps address autocomplete

Create a **browser API key** in Google Cloud Console (APIs & Services →
Credentials) with **Places API (New)** enabled (the Maps JavaScript API is not
required — the forms call the Places REST endpoints directly). Restrict the
key by HTTP referrer to the app domains (and `localhost` for dev), then set
env var `VITE_GOOGLE_MAPS_API_KEY` on **both** Amplify apps and rebuild.
Without the key the address fields are plain inputs — everything still works,
just no suggestions.

## 3. SES

Already working: `info@pestbuzzkill.com` is the verified sender used for
service reports, agreement links, reminders, and payment requests. If email
volume grows or messages land in spam, add DKIM for the domain in SES.
Cognito login invites use Cognito's default mailer.

## 4. Customer portal domain

The production CRM and customer portal use `https://app.pestbuzzkill.com`.
Set `CRM_APP_URL=https://app.pestbuzzkill.com` on the WEB app's production
branch; it is baked into agreement links, billing links, and Cognito invite
emails. Staging continues to use the staging Amplify hostname.

## 5. Bootstrapping the first office user

The CRM is invite-only, and invites are sent from the CRM by office staff.
Create the *first* office login once per environment with the AWS CLI
(user pool id is in `amplify_outputs.json` → `auth.user_pool_id`):

```bash
aws cognito-idp admin-create-user --user-pool-id <POOL> \
  --username you@pestbuzzkill.com \
  --user-attributes Name=email,Value=you@pestbuzzkill.com Name=email_verified,Value=true Name=name,Value="Your Name" \
  --region us-east-1
aws cognito-idp admin-add-user-to-group --user-pool-id <POOL> \
  --username you@pestbuzzkill.com --group-name OFFICE --region us-east-1
```

(Add `TECH` too for a "both" role.) After that, everyone else is invited from
More → Invite a staff member, or per-customer with "Invite to portal".

## What was E2E-verified in the sandbox (2026-07-14)

- Lead → convert (plan or scheduled 1-time job) → active customer
- Portal invite: Cognito user + dynamic `cus-<id>`/`grp-<id>` groups
- Technician + daily route auto-creation, job assignment/reorder
- Tech mobile service report → geolocation stamp → PDF to S3 → emailed via
  SES → job COMPLETED (PDF verified, including the GPS block)
- Agreement: office send → tokenized public /sign page → signed PDF with
  audit trail (name, IP, timestamp, device) → emailed copies
- Customer portal: role routing, own-records visibility, documents with
  entitlement-checked presigned URLs, billing screen
- Reporting dashboard renders (invoice data flows in once Stripe is live)

## Not yet verified (needs real Stripe test keys)

- SetupIntent flow end-to-end (card + US bank via PaymentElement)
- startSubscription / chargeOneTimeJob / webhook settlement of invoices

The UI degrades cleanly without keys (clear error messages), so this can be
tested any time after step 1 by walking a customer through
Collect now → Start billing → Charge.
