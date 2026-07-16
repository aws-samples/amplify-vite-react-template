import { defineFunction } from "@aws-amplify/backend";

/**
 * Lead intake for the public marketing forms.
 *
 * Writes the lead straight into the CRM as a Customer in LEAD status — the CRM
 * is the only system of record. Pricing and agreements are deliberately not
 * done here: they belong behind the CRM rate card, where escalation rules and
 * margin floors are applied by a human.
 *
 * SES_FROM_EMAIL / SES_NOTIFY_EMAIL / CRM_APP_URL are injected in backend.ts.
 */
export const leadIntake = defineFunction({
  name: "lead-intake",
  entry: "./handler.ts",
  timeoutSeconds: 30,
});
