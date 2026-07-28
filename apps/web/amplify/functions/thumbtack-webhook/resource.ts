import { defineFunction, secret } from "@aws-amplify/backend";

/**
 * Inbound Thumbtack webhook receiver.
 *
 * Thumbtack has two delivery tiers and they send the SAME object shapes, so
 * this one function serves both:
 *
 *  - Self-serve webhook (Services → Apps → Webhooks in the pro account). No
 *    approval needed, outbound-only, authenticated with whatever value you put
 *    in its "Authorization type" field. Point it at this Function URL today.
 *  - Partner Platform (approval via teampartnerships@thumbtack.com). Calls the
 *    same `/v1/lead`, `/v1/message`, `/v1/lead/update`, `/v1/review` routes,
 *    and additionally lets US call Thumbtack to reply on a thread. Turning it
 *    on is a credential change here, not a rewrite.
 *
 * THUMBTACK_WEBHOOK_SECRET is the shared secret we require on every inbound
 * request (compared in constant time). Set it before pointing Thumbtack here:
 *
 *   npx ampx sandbox secret set THUMBTACK_WEBHOOK_SECRET       # local
 *   Amplify Console → Hosting → Secrets                        # branches
 *
 * The timeout is deliberately generous: a lead POST fans out to a drive-time
 * matrix call, a market-rate read, and a capacity read before it answers.
 */
export const thumbtackWebhook = defineFunction({
  name: "thumbtack-webhook",
  entry: "./handler.ts",
  timeoutSeconds: 60,
  environment: {
    THUMBTACK_WEBHOOK_SECRET: secret("THUMBTACK_WEBHOOK_SECRET"),
  },
});
