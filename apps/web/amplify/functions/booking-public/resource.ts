import { defineFunction, secret } from "@aws-amplify/backend";

/**
 * Public booking-funnel API (quote / book / cancel) behind a Function URL.
 * Long timeout: first quote in a new area may run AI market research, and
 * availability pricing calls the Google Routes matrix.
 *
 * STRIPE_SECRET_KEY comes from the same branch-scoped secret() as
 * crm-billing — the custom SSM lookup in the handler is a fallback for the
 * non-money keys only. Before this, the handler's lookup missed the
 * console-set branch secret (it lives under the internal branch-id path)
 * and fell back to the shared key, which is live: a staging checkout was
 * creating real PaymentIntents.
 */
export const bookingPublic = defineFunction({
  name: "booking-public",
  entry: "./handler.ts",
  timeoutSeconds: 120,
  memoryMB: 512,
  environment: {
    STRIPE_SECRET_KEY: secret("STRIPE_SECRET_KEY"),
  },
});
