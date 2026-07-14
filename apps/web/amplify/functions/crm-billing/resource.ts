import { defineFunction, secret } from "@aws-amplify/backend";

/**
 * Stripe operations behind userPool-authorized custom ops:
 *
 *   createSetupIntent       — collect a card or US bank account BEFORE the
 *                             first treatment (office-initiated or portal)
 *   getPaymentMethodSummary — default payment method label for UI
 *   startSubscription       — monthly Stripe subscription from a
 *                             Subscription record (price_data, no catalog)
 *   cancelSubscription      — cancel in Stripe + mark record CANCELED
 *   chargeOneTimeJob        — off-session PaymentIntent for a 1-time job,
 *                             creates an OPEN Invoice the webhook settles
 *
 * Secret setup:
 *   npx ampx sandbox secret set STRIPE_SECRET_KEY       # local
 *   Amplify Console → App settings → Secrets            # deployed branches
 */
export const crmBilling = defineFunction({
  name: "crm-billing",
  entry: "./handler.ts",
  timeoutSeconds: 30,
  environment: {
    STRIPE_SECRET_KEY: secret("STRIPE_SECRET_KEY"),
  },
});
