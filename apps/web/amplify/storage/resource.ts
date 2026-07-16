import { defineStorage } from "@aws-amplify/backend";

/**
 * Document store for the CRM: service-report PDFs and signed agreements,
 * keyed under the owning customer:
 *
 *   reports/<customerId>/<reportId>.pdf
 *   agreements/<customerId>/<agreementId>.pdf
 *
 * No browser role holds access rules here, deliberately. A finalized PDF is
 * a legal record, and the OFFICE/TECH read+write grants that used to sit on
 * `reports/*` and `agreements/*` were a second write path that could
 * overwrite one after issuance — used by no UI code. Every upload goes
 * through a presigned PUT from a crm-docs mutation, and every view through
 * getDocumentUrl, which checks row-level entitlement first. Backend
 * functions get their access via explicit CDK grants in backend.ts.
 */
export const storage = defineStorage({
  name: "crmDocuments",
});
