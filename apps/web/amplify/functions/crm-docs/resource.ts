import { defineFunction } from "@aws-amplify/backend";

/**
 * Document operations behind userPool-authorized custom ops:
 *
 *   sendAgreement          — generate a sign token, mark SENT, email the
 *                            lead/customer their secure signing link
 *   finalizeServiceReport  — render the technician's report (with the
 *                            geolocation stamp) to PDF, store it under the
 *                            customer record, mark the job COMPLETED, and
 *                            email the PDF to the customer
 *   getDocumentUrl         — entitlement-checked, short-lived presigned URL
 *                            for report/agreement PDFs (office, tech, the
 *                            customer, or customer-group members)
 *
 * S3 + SES permissions and the DOCS_BUCKET env come from backend.ts.
 */
export const crmDocs = defineFunction({
  name: "crm-docs",
  entry: "./handler.ts",
  timeoutSeconds: 60,
  memoryMB: 1024,
});
