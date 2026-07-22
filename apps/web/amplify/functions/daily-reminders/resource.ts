import { defineFunction, secret } from "@aws-amplify/backend";

/**
 * Runs every morning (12:00 UTC ≈ 7/8am ET). Emails service reminders, and
 * drives the money-out recovery lifecycle: the dunning retry cadence on failed
 * cards (which needs Stripe), open-invoice reminders, the AR-aging digest, and
 * dispute-deadline alerts.
 */
export const dailyReminders = defineFunction({
  name: "daily-reminders",
  entry: "./handler.ts",
  timeoutSeconds: 300,
  schedule: "0 12 * * ? *",
  environment: {
    STRIPE_SECRET_KEY: secret("STRIPE_SECRET_KEY"),
  },
});
