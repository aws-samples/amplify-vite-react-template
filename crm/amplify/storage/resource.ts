import { defineStorage } from "@aws-amplify/backend";
import { processDocument } from "../functions/process-document/resource";

/**
 * Document storage.
 *
 * Uploaded documents live under:
 *   documents/{entityType}/{entityId}/{documentId}/{filename}
 * so the OCR trigger can find the Document record from the object key.
 *
 * Generated certificate PDFs live under certificates/; ACORD fillable
 * templates under templates/.
 *
 * NOTE on groups: users in a Cognito group assume that group's IAM role
 * (not the base authenticated role), so every group needs its own grant —
 * allow.authenticated alone silently locks out group members.
 */
const ALL_GROUPS = ["ADMIN", "STAFF", "PRODUCER"];

export const storage = defineStorage({
  name: "crmDocuments",
  access: (allow) => ({
    "documents/*": [
      allow.authenticated.to(["read", "write", "delete"]),
      allow.groups(ALL_GROUPS).to(["read", "write", "delete"]),
      allow.resource(processDocument).to(["read"]),
    ],
    "certificates/*": [
      allow.authenticated.to(["read", "write", "delete"]),
      allow.groups(ALL_GROUPS).to(["read", "write", "delete"]),
    ],
    "templates/*": [
      allow.authenticated.to(["read", "write", "delete"]),
      allow.groups(ALL_GROUPS).to(["read", "write", "delete"]),
    ],
    // Generated ACORD submission forms — outside documents/ so the OCR
    // trigger doesn't re-read our own output.
    "generated/*": [
      allow.authenticated.to(["read", "write", "delete"]),
      allow.groups(ALL_GROUPS).to(["read", "write", "delete"]),
    ],
    /**
     * Producer signature images, stamped onto generated ACORD forms.
     *
     * KNOWN GAP — deliberately left open, do not "fix" by narrowing this list.
     * The path is `signatures/{UserProfile.id}.{ext}` (SignatureManager), a
     * predictable key on an id every signed-in user can list off UserProfile.
     * So any signed-in user can overwrite anyone's signature, and that image
     * gets stamped onto issued certificates.
     *
     * It is not fixable here. Per-user scoping in Amplify storage is only
     * expressible with the `{entity_id}` token, which substitutes the Cognito
     * *identity-pool* id — not UserProfile.id and not the user-pool sub. And
     * "signatures/*" cannot coexist with a "signatures/{entity_id}/*" path:
     * validateStorageAccessPaths rejects any path that is a prefix of an
     * entity-token path.
     *
     * Closing it properly needs all of: a new top-level prefix, storing each
     * user's identityId on UserProfile at onboarding (the Team tab lets an
     * admin manage a teammate's signature, and an admin's browser cannot
     * otherwise derive another user's identity id), and a backfill of existing
     * signatureKey values. That is its own commit.
     *
     * Narrowing write/delete to ADMIN here is NOT the interim fix: it breaks
     * self-service signatures for staff and producers and leaves the overwrite
     * hole open for every admin anyway.
     */
    "signatures/*": [
      allow.authenticated.to(["read", "write", "delete"]),
      allow.groups(ALL_GROUPS).to(["read", "write", "delete"]),
    ],
    // Property photos (cover, aerial, plot plan) — no OCR.
    "property-photos/*": [
      allow.authenticated.to(["read", "write", "delete"]),
      allow.groups(ALL_GROUPS).to(["read", "write", "delete"]),
    ],
  }),
  triggers: {
    onUpload: processDocument,
  },
});
