import { defineFunction } from "@aws-amplify/backend";

/**
 * Runs every morning (12:00 UTC ≈ 7/8am ET) and emails every customer who
 * has a SCHEDULED job tomorrow an upcoming-service reminder.
 */
export const dailyReminders = defineFunction({
  name: "daily-reminders",
  entry: "./handler.ts",
  timeoutSeconds: 300,
  schedule: "0 12 * * ? *",
});
