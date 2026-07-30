import { defineFunction } from "@aws-amplify/backend";

/**
 * Daily renewal-marketing sweep.
 *
 * For every expiring risk (bound policies + leads' current-policy
 * expirations), works out the submission window — carrier lead time plus a
 * 14-day head start — and raises one marketing task per appetite-matched
 * appointed carrier once that window opens.
 *
 * Also closes out tasks that have since been satisfied by a quote, so the
 * open-task list converges without anyone tidying it by hand.
 *
 * Runs 5am Eastern so the queue is ready before the day starts. Pinned to a
 * timezone rather than UTC so it doesn't drift an hour twice a year.
 */
export const renewalTasks = defineFunction({
  name: "renewal-tasks",
  entry: "./handler.ts",
  schedule: {
    cron: "0 5 * * ? *",
    timezone: "America/New_York",
    description: "Daily renewal marketing task sweep",
  },
  timeoutSeconds: 300,
  memoryMB: 512,
  resourceGroupName: "data",
});
