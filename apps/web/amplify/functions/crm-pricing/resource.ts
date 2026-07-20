import { defineFunction } from "@aws-amplify/backend";

/**
 * AI lead-pricing engine. Claude extracts the facts from a pasted Thumbtack
 * lead (or screenshot); this function determines the zone from real drive
 * time (Google Routes API), prices deterministically from the rate cards,
 * composes the paste-ready reply, and persists a resumable LeadPricingRun.
 * Missing exact rates wake asynchronous research and return RESEARCHING;
 * the CRM resumes the same run without handing it to a manager.
 *
 * Keys are read from SSM at runtime (see backend.ts for the grant), so the
 * deploy never depends on the secrets existing:
 *   /amplify/shared/<appId>/ANTHROPIC_API_KEY
 *   /amplify/shared/<appId>/GOOGLE_ROUTES_API_KEY
 * Add both in Amplify Console → Secrets. Until then priceLead returns a
 * clear "not configured" message.
 */
export const crmPricing = defineFunction({
  name: "crm-pricing",
  entry: "./handler.ts",
  timeoutSeconds: 120,
  memoryMB: 512,
});
