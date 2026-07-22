import { defineFunction } from "@aws-amplify/backend";

/**
 * GL-22 — the alarm-to-owned-work bridge. Every CloudWatch alarm (Lambda
 * errors, scheduled jobs that did not run, the email-event dead-letter
 * queue) publishes to the ops-alarms SNS topic; this function turns each
 * alarm into ONE deduplicated shared-Office work item (INFRA_ALERT, keyed
 * by alarm name, common one-business-day clock, escalation via the normal
 * overdue sweep) and an office email. A background failure pages the queue
 * — never only a log group.
 */
export const opsAlerts = defineFunction({
  name: "ops-alerts",
  entry: "./handler.ts",
  timeoutSeconds: 60,
  memoryMB: 256,
});
