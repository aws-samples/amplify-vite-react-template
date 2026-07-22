import { defineFunction } from "@aws-amplify/backend";

/**
 * GL-03 — receives SES bounce / complaint / delivery notifications and turns
 * them into truthful delivery state. SES publishes events (via a configuration
 * set) to an SNS topic; this function is subscribed to that topic in backend.ts.
 * For a bounce or complaint it marks the EmailLog, suppresses the address so we
 * stop mailing it, and opens an owned EMAIL_FAILURE exception tied to the
 * lead/customer with an alternate-contact next step. A delivery marks the log
 * DELIVERED — the first time "sent" means "actually reached the customer".
 */
export const sesEvents = defineFunction({
  name: "ses-events",
  entry: "./handler.ts",
  timeoutSeconds: 60,
});
