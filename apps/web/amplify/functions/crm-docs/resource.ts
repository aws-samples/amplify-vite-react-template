import { defineFunction, secret } from "@aws-amplify/backend";

/**
 * Document operations behind userPool-authorized custom ops:
 *
 *   finalizeServiceReport  — render the technician's report (with the
 *                            geolocation stamp) to PDF, store it under the
 *                            customer record, mark the job COMPLETED, and
 *                            email the PDF to the customer
 *   getDocumentUrl         — entitlement-checked, short-lived presigned URL
 *                            for report/agreement PDFs (office, tech, the
 *                            customer, or customer-group members)
 *   sendCustomerEmail      — office-initiated transactional emails, including
 *                            the booking-link email that sends a lead to the
 *                            public funnel (their only conversion path)
 *   prepareLeadQuote       — validate a lead and mint the exact prefilled
 *                            public-funnel handoff used by office staff
 *
 * S3 + SES permissions and the DOCS_BUCKET + MARKETING_URL envs come from
 * backend.ts.
 *
 * STRIPE_SECRET_KEY is needed because completing the first visit of a recurring
 * plan is what starts its subscription — the rule Jake locked. Before that,
 * billing waited on someone remembering to press a button in the office.
 */
export const crmDocs = defineFunction({
  name: "crm-docs",
  entry: "./handler.ts",
  timeoutSeconds: 60,
  memoryMB: 1024,
  environment: {
    STRIPE_SECRET_KEY: secret("STRIPE_SECRET_KEY"),
  },
});
