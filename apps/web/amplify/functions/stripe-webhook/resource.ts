import { defineFunction, secret } from "@aws-amplify/backend";

/**
 * Stripe webhook receiver (public Function URL, signature-verified).
 * Settles Invoice records (PAID/FAILED), mirrors subscription lifecycle,
 * and promotes newly saved payment methods to customer default.
 *
 * Register the Function URL (from amplify_outputs.json custom.stripeWebhookUrl)
 * in the Stripe dashboard with events:
 *   setup_intent.succeeded, payment_intent.succeeded,
 *   payment_intent.payment_failed, invoice.paid, invoice.payment_failed,
 *   customer.subscription.deleted, charge.refunded,
 *   charge.dispute.created, charge.dispute.closed
 * then set the signing secret:
 *   npx ampx sandbox secret set STRIPE_WEBHOOK_SECRET   # local
 *   Amplify Console → App settings → Secrets            # deployed branches
 */
export const stripeWebhook = defineFunction({
  name: "stripe-webhook",
  entry: "./handler.ts",
  timeoutSeconds: 30,
  environment: {
    STRIPE_SECRET_KEY: secret("STRIPE_SECRET_KEY"),
    STRIPE_WEBHOOK_SECRET: secret("STRIPE_WEBHOOK_SECRET"),
  },
});
