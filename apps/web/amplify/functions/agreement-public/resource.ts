import { defineFunction } from "@aws-amplify/backend";

/**
 * Public, unauthenticated API behind the /sign/<token> page in the CRM.
 * Access is gated by the unguessable per-agreement sign token (and CORS);
 * the caller never needs a login — leads sign before they have one.
 *
 *   GET  ?token=…  — agreement content for review (marks VIEWED)
 *   POST {token, signerName, signatureDataUrl?}
 *                  — records the signature with an audit trail (IP, UA,
 *                    timestamp), renders the signed PDF to S3 under the
 *                    customer record, emails copies to the signer + office
 *
 * S3 + SES permissions and DOCS_BUCKET come from backend.ts.
 */
export const agreementPublic = defineFunction({
  name: "agreement-public",
  entry: "./handler.ts",
  timeoutSeconds: 60,
  memoryMB: 1024,
});
