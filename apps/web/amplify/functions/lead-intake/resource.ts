import { defineFunction, secret } from "@aws-amplify/backend";

/**
 * Lead-intake proxy.
 *
 * Receives a JSON form payload from the marketing site, validates it,
 * and creates a customer (in lead status, active = -3) in FieldRoutes.
 *
 * The API key and token are sourced from Amplify secrets. Set them with:
 *
 *   # Sandbox (local dev only):
 *   npx ampx sandbox secret set FIELDROUTES_KEY
 *   npx ampx sandbox secret set FIELDROUTES_TOKEN
 *
 *   # Production / deployed branches: Amplify Console → App settings →
 *   # Secrets → add FIELDROUTES_KEY and FIELDROUTES_TOKEN, scoped to
 *   # each branch you deploy to.
 *
 * The subdomain is a plain env var — `buzzkill` is the public hostname,
 * not a secret. Override per-branch in the Amplify Console only if a
 * staging tenant exists.
 */
export const leadIntake = defineFunction({
  name: "lead-intake",
  entry: "./handler.ts",
  timeoutSeconds: 30,
  environment: {
    FIELDROUTES_KEY: secret("FIELDROUTES_KEY"),
    FIELDROUTES_TOKEN: secret("FIELDROUTES_TOKEN"),
    FIELDROUTES_SUBDOMAIN: "buzzkill",
    // SES sender — must be verified in SES
    SES_FROM_EMAIL: "info@pestbuzzkill.com",
    SES_NOTIFY_EMAIL: "info@pestbuzzkill.com",
    // Optional: set to "1" to skip the FieldRoutes call and just echo
    // the would-be payload back to the client. Useful when iterating
    // on field mappings.
    LEAD_INTAKE_DRY_RUN: "0",
  },
});
