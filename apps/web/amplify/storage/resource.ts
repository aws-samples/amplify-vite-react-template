import { defineStorage } from "@aws-amplify/backend";

/**
 * Document store for the CRM: service-report PDFs and signed agreements,
 * keyed under the owning customer:
 *
 *   reports/<customerId>/<reportId>.pdf
 *   agreements/<customerId>/<agreementId>.pdf
 *
 * Staff access is direct (below). Customer/group access is NOT granted
 * here — portal users get short-lived presigned URLs from the
 * getDocumentUrl query, which checks row-level entitlement first.
 * Backend functions are granted access via allow.resource() as they are
 * added.
 */
export const storage = defineStorage({
  name: "crmDocuments",
  access: (allow) => ({
    "reports/*": [allow.groups(["OFFICE", "TECH"]).to(["read", "write"])],
    "agreements/*": [allow.groups(["OFFICE"]).to(["read", "write"])],
  }),
});
