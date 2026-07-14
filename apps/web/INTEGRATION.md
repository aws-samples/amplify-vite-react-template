# Lead-form ↔ FieldRoutes integration

The contact form on the marketing site posts to an Amplify Function
(`amplify/functions/lead-intake`) which proxies the submission to the
FieldRoutes Customer API. Credentials are stored as Amplify secrets, never
shipped to the browser.

```
Browser ContactForm
        │  POST { first, last, email, phone, addr, city, state, zip, ... }
        ▼
Lambda  lead-intake (Function URL, CORS-locked)
        │  POST application/x-www-form-urlencoded
        │  https://buzzkill.pestroutes.com/api/customer/create
        │  ?authenticationKey=…&authenticationToken=…
        ▼
FieldRoutes
```

## One-time setup

### 1. Set the FieldRoutes secrets

These commands prompt you for each value; paste the credentials
FieldRoutes issued.

```bash
npx ampx sandbox secret set FIELDROUTES_KEY
npx ampx sandbox secret set FIELDROUTES_TOKEN
npx ampx sandbox secret set FIELDROUTES_SUBDOMAIN     # e.g. "buzzkill"
```

For non-sandbox branches (production, staging) set the same secrets in
the **Amplify Console → App settings → Secrets** UI, scoped to each
branch.

### 2. Run the sandbox

```bash
npx ampx sandbox
```

This deploys the function, generates the Function URL, and writes
`amplify_outputs.json` (gitignored) at the repo root. The frontend reads
the URL out of that file at runtime via `src/lib/leadIntake.ts`.

### 3. Verify locally

```bash
npm run dev
```

Open <http://localhost:5173>, scroll to the contact form, fill it out,
submit. The first time you submit:

- **Watch the CloudWatch log group** for `lead-intake`. The handler logs
  the FieldRoutes response verbatim (`FieldRoutes response { upstreamStatus, body }`).
- If FieldRoutes returns `{ success: false, errorMessage: "..." }` or an
  HTTP error, the response is surfaced to the browser as a red error
  banner and we adjust the field mapping.

## Field mapping

The handler (`amplify/functions/lead-intake/handler.ts`) translates the
form fields to FieldRoutes' Customer API names:

| Form field     | FieldRoutes field    | Notes                                         |
| -------------- | -------------------- | --------------------------------------------- |
| `first`        | `fname`              | trimmed                                       |
| `last`         | `lname`              | trimmed                                       |
| `email`        | `email`              | regex-validated                               |
| `phone`        | `phone1`             | digits only                                   |
| `addr`         | `address`            |                                                |
| `city`         | `city`               |                                                |
| `state`        | `state`              | 2-letter, uppercased                          |
| `zip`          | `zip`                | digits only, first 5                          |
| `propertyType` | `commercialAccount`  | `1` if Commercial; key omitted if Residential |
| `company`      | `companyName`        | only sent for Commercial                      |
| (constant)     | `active = -3`        | Lead status                                   |
| (constant)     | `customerSource`     | `"Website"` — adjust to a real source ID      |
| `sqft`/`units`/`freq` | `specialScheduling` | concatenated note                          |

The `active = -3` magic number is the PestRoutes / FieldRoutes
convention for "Lead." Confirm against your tenant's Swagger if
FieldRoutes ever flips it.

## Iterating on field names

The exact set of accepted fields for `customer/create` is tenant-
Swagger-defined and not publicly documented. If FieldRoutes complains
about an unknown field or a missing required field on first submission:

1. Open the Swagger:
   `https://buzzkill.pestroutes.com/api/documentation/swagger?authenticationKey=…&authenticationToken=…`
2. Find `customer/create` and check the parameter list.
3. Update `mapToFieldRoutes` in `amplify/functions/lead-intake/handler.ts`.
4. Redeploy with `npx ampx sandbox` (or merge to your branch for a
   hosted environment).

## Dry-run mode

To submit the form without actually creating a FieldRoutes customer,
set the function env var `LEAD_INTAKE_DRY_RUN=1` (in
`amplify/functions/lead-intake/resource.ts` or via the Amplify Console).
The handler will return the would-be payload to the browser and skip
the upstream call. Useful when iterating on the mapping.

## Security notes

- `authenticationKey` + `authenticationToken` are tenant secrets. They
  live in Amplify secret storage and are injected as Lambda environment
  variables. They are never exposed to the browser.
- The Function URL has `authType: NONE` (it's a public form-submit
  endpoint), so the only protection on the wire is **CORS** (origin
  allowlist in `amplify/backend.ts` and the handler's response headers)
  and the handler's own input validation.
- The CORS allowlist is intentionally tight:
  `pestbuzzkill.com`, `www.pestbuzzkill.com`,
  `buzzkill-pest-control.squarespace.com`, and `localhost:5173`. Add
  preview-branch domains there if you need them.
- There is no rate limiting today. If the form starts attracting spam,
  add an AWS WAF rule on the Function URL or wire in reCAPTCHA / Cloudflare
  Turnstile on the client.

## Hosting env vars and `amplify.yml`

Amplify Hosting does **not** automatically pass env vars set in the
Hosting Console into the Vite build process — see
[aws-amplify/amplify-backend#2190](https://github.com/aws-amplify/amplify-backend/issues/2190).

`amplify.yml` works around this with one line in the frontend phase:

```yaml
- env | grep -E '^VITE_' >> .env || true
```

That forwards any Hosting env var prefixed `VITE_` into a `.env` file
so Vite picks it up. None of our integration paths *require* this —
the lead-intake Function URL flows through `amplify_outputs.json`, not
through env vars — but the line is there so a future
`VITE_LEAD_INTAKE_URL` (or any other `VITE_*` override) just works
without surprises.

The Lambda's own env vars (`FIELDROUTES_KEY`, `FIELDROUTES_TOKEN`,
`FIELDROUTES_SUBDOMAIN`) are injected into the Lambda runtime by
CloudFormation via `secret()` and are unaffected by this issue.

## Rotating credentials

If the API key + token are ever exposed (e.g. pasted in a chat),
email FieldRoutes support and request new credentials. Then:

```bash
npx ampx sandbox secret set FIELDROUTES_KEY
npx ampx sandbox secret set FIELDROUTES_TOKEN
```

…and update them in the Amplify Console for each branch. The function
picks up new env values on next cold start (≤ a few minutes).
