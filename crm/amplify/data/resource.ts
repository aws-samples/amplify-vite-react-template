import { type ClientSchema, a, defineData } from "@aws-amplify/backend";
import { processDocument } from "../functions/process-document/resource";
import { leadIntake } from "../functions/lead-intake/resource";
import { teamAdmin } from "../functions/team-admin/resource";
import { extractLead } from "../functions/extract-lead/resource";
import { certNumber } from "../functions/cert-number/resource";

/**
 * HOA CRM data model.
 *
 * Lifecycle: an Account starts as stage=LEAD. Binding (accepting) a Quote
 * creates a Policy and flips the Account to stage=CLIENT in place — this is
 * the only path to Client, and it preserves all documents/quotes/history
 * without re-linking.
 *
 * "CarrierAppointment" here means an agency appointment with a carrier
 * (authority to write), not a calendar appointment.
 */
const schema = a
  .schema({
    // ── Lifecycle enums ────────────────────────────────────────────────
    AccountStage: a.enum(["LEAD", "CLIENT"]),
    AccountType: a.enum(["ASSOCIATION", "PERSONAL", "COMMERCIAL_OTHER"]),
    QuoteStatus: a.enum([
      "DRAFT",
      "SUBMITTED",
      "QUOTED",
      "PRESENTED",
      "BOUND",
      "DECLINED",
      "LOST",
    ]),
    PolicyStatus: a.enum(["ACTIVE", "EXPIRED", "CANCELLED", "NON_RENEWED"]),
    DocumentEntityType: a.enum([
      "ACCOUNT",
      "QUOTE",
      "POLICY",
      "CARRIER",
      "CERTIFICATE",
      "USER_PROFILE",
      "LICENSE",
    ]),
    DocumentCategory: a.enum([
      "PRIOR_POLICY",
      "CONDO_DOCS",
      "BUDGET",
      "DUES_SCHEDULE",
      "LOSS_RUNS",
      "QUOTE_DOC",
      "POLICY_DOC",
      "LICENSE",
      "ACORD_FORM", // generated carrier-submission forms
      "OTHER",
    ]),
    OcrStatus: a.enum(["PENDING", "PROCESSING", "COMPLETE", "FAILED", "SKIPPED"]),
    ExtractionStatus: a.enum(["PENDING", "PROCESSING", "COMPLETE", "FAILED"]),
    UserRole: a.enum(["ADMIN", "STAFF", "PRODUCER"]),
    // ── Licensing ──
    // FIRM  = the agency entity licensed in a state (agency/business entity license)
    // PRODUCER = an individual staff member's personal license
    LicenseHolderType: a.enum(["FIRM", "PRODUCER"]),
    LicenseClass: a.enum([
      "PRODUCER",
      "AGENCY",
      "SURPLUS_LINES",
      "ADJUSTER",
      "CONSULTANT",
    ]),
    // Every licensee has exactly one resident state; the rest are non-resident.
    LicenseResidency: a.enum(["RESIDENT", "NON_RESIDENT"]),
    LicenseStatus: a.enum(["ACTIVE", "PENDING", "INACTIVE", "LAPSED", "EXPIRED"]),
    // ISO construction classes
    ConstructionType: a.enum([
      "FRAME",
      "JOISTED_MASONRY",
      "NON_COMBUSTIBLE",
      "MASONRY_NON_COMBUSTIBLE",
      "MODIFIED_FIRE_RESISTIVE",
      "FIRE_RESISTIVE",
    ]),
    ReplacementCostType: a.enum(["RC", "ERC", "GRC"]),

    // ── Account: Lead → Client, converted in place ─────────────────────
    Account: a
      .model({
        stage: a.ref("AccountStage").required(),
        type: a.ref("AccountType").required(),
        name: a.string().required(), // association / insured name
        contactFirstName: a.string(),
        contactLastName: a.string(),
        contactEmail: a.email(),
        // Free-form: a.phone() only accepts E.164 and rejects "555-123-4567"
        contactPhone: a.string(),
        address: a.string(),
        city: a.string(),
        state: a.string(),
        zip: a.string(),
        unitCount: a.integer(),
        yearBuilt: a.integer(),
        totalInsuredValue: a.float(),
        // ── Property / underwriting details ──
        constructionType: a.ref("ConstructionType"),
        firewallsVerified: a.boolean(),
        stories: a.integer(),
        coastal: a.boolean(),
        milesToCoast: a.float(), // only meaningful when coastal
        roofUpdatedYear: a.integer(),
        hvacUpdatedYear: a.integer(),
        electricalUpdatedYear: a.integer(),
        plumbingUpdatedYear: a.integer(),
        otherUpdates: a.string(),
        coverPhotoKey: a.string(), // S3 keys under property-photos/
        aerialPhotoKey: a.string(),
        plotPlanKey: a.string(),
        // ── AI document extraction ──
        extractionStatus: a.ref("ExtractionStatus"),
        aiExtraction: a.json(), // per-field values + confidence + evidence
        extractionError: a.string(),
        buildings: a.hasMany("Building", "accountId"),
        // Incumbent broker/agent currently servicing the account
        currentAgent: a.string(),
        // Incumbent policy expiration (drives lead renewal pipeline; for
        // clients the bound Policy records are authoritative)
        currentPolicyExpiration: a.date(),
        buildiumId: a.string(), // lineage from web lead forms / Buildium sync
        source: a.string(), // e.g. "website", "referral", "cold"
        notes: a.string(),
        convertedAt: a.datetime(), // set when first quote is bound
        producerId: a.string(), // Cognito sub of owning producer
        quotes: a.hasMany("Quote", "accountId"),
        policies: a.hasMany("Policy", "accountId"),
        certificates: a.hasMany("Certificate", "accountId"),
      })
      .secondaryIndexes((index) => [index("stage").sortKeys(["name"])]),

    // Individual buildings on a property; total buildings/sqft are derived.
    Building: a.model({
      accountId: a.id().required(),
      account: a.belongsTo("Account", "accountId"),
      label: a.string(), // "Building A", "Clubhouse", …
      sqft: a.integer(),
    }),

    // ── Quotes: tied to an account; binding creates a Policy ───────────
    Quote: a.model({
      accountId: a.id().required(),
      account: a.belongsTo("Account", "accountId"),
      carrierId: a.id(),
      carrier: a.belongsTo("Carrier", "carrierId"),
      status: a.ref("QuoteStatus").required(),
      lines: a.string().array(), // e.g. ["Property", "GL", "D&O", "Umbrella"]
      premium: a.float(),
      // Agency commission, % of premium. NOTE: already baked into the
      // quoted premium — commission $ is informational, never additive.
      commissionPct: a.float(),
      // ── Property terms ──
      perOccurrenceDeductible: a.float(),
      perUnitDeductible: a.float(),
      blanketLimit: a.float(),
      coinsurancePct: a.float(),
      replacementCostType: a.ref("ReplacementCostType"),
      effectiveDate: a.date(),
      expirationDate: a.date(),
      submittedAt: a.date(),
      notes: a.string(),
      policy: a.hasOne("Policy", "quoteId"),
    }),

    // ── Policies: created on bind; source data for COI generation ──────
    Policy: a.model({
      accountId: a.id().required(),
      account: a.belongsTo("Account", "accountId"),
      quoteId: a.id(),
      quote: a.belongsTo("Quote", "quoteId"),
      carrierId: a.id(),
      carrier: a.belongsTo("Carrier", "carrierId"),
      policyNumber: a.string(),
      status: a.ref("PolicyStatus").required(),
      lines: a.string().array(),
      premium: a.float(),
      commissionPct: a.float(), // carried from the bound quote; baked into premium
      perOccurrenceDeductible: a.float(),
      perUnitDeductible: a.float(),
      blanketLimit: a.float(),
      coinsurancePct: a.float(),
      replacementCostType: a.ref("ReplacementCostType"),
      effectiveDate: a.date(),
      expirationDate: a.date(),
      limits: a.json(), // per-line limits/deductibles, shape evolves with ACORD needs
      notes: a.string(),
    }),

    // ── Carriers & appointments ────────────────────────────────────────
    Carrier: a.model({
      name: a.string().required(),
      appointed: a.boolean().required(), // false = prospective appointment
      dateAppointed: a.date(),
      primaryContactName: a.string(),
      primaryContactEmail: a.email(),
      primaryContactPhone: a.string(),
      primaryUnderwriterName: a.string(),
      primaryUnderwriterEmail: a.email(),
      primaryUnderwriterPhone: a.string(),
      states: a.string().array(), // states they cover
      naicCode: a.string(), // used on ACORD forms
      standardCommissionPct: a.float(), // autofills onto new quotes
      annualMinimumPremium: a.float(), // min premium written to maintain appointment
      profitSharingPremiumThreshold: a.float(), // premium written to qualify for profit sharing
      profitSharingLossRatioThreshold: a.float(), // max loss ratio % to qualify for profit sharing
      commercialLines: a.boolean(), // writes commercial lines
      personalLines: a.boolean(), // writes personal lines
      notes: a.string(),
      appetiteGuides: a.hasMany("AppetiteGuide", "carrierId"),
      quotes: a.hasMany("Quote", "carrierId"),
      policies: a.hasMany("Policy", "carrierId"),
    }),

    AppetiteGuide: a.model({
      carrierId: a.id().required(),
      carrier: a.belongsTo("Carrier", "carrierId"),
      linesWritten: a.string().array(),
      quoteSubmissionLeadTimeDays: a.integer(),
      minValue: a.float(), // TIV range
      maxValue: a.float(),
      minConstructionYear: a.integer(),
      maxConstructionYear: a.integer(),
      states: a.string().array(), // override carrier states if narrower
      notes: a.string(),
    }),

    // ── Documents: polymorphic, attach to anything, OCR'd by Textract ──
    Document: a
      .model({
        entityType: a.ref("DocumentEntityType").required(),
        entityId: a.string().required(),
        category: a.ref("DocumentCategory"),
        name: a.string().required(),
        s3Key: a.string().required(),
        contentType: a.string(),
        sizeBytes: a.integer(),
        uploadedBy: a.string(),
        ocrStatus: a.ref("OcrStatus"),
        ocrText: a.string(), // full extracted text, searched in-app
        ocrTables: a.json(), // Textract TABLES output (budgets, dues schedules)
        ocrError: a.string(),
      })
      .secondaryIndexes((index) => [index("entityId")]),

    // ── Certificates (ACORD 25 issuance history) ───────────────────────
    Certificate: a.model({
      accountId: a.id().required(),
      account: a.belongsTo("Account", "accountId"),
      certificateNumber: a.string(), // unique record-keeping ID, e.g. HOA-2026-00011
      policyIds: a.string().array(),
      holderName: a.string().required(),
      holderAddress: a.string(),
      descriptionOfOperations: a.string(),
      formType: a.string().default("ACORD_25"), // future: ACORD 27/28, carrier forms
      s3Key: a.string(), // generated PDF
      issuedBy: a.string(),
      issuedAt: a.datetime(),
    }),

    // ── Users & onboarding ─────────────────────────────────────────────
    UserProfile: a
      .model({
        userId: a.string().required(), // Cognito sub
        email: a.email().required(),
        firstName: a.string().required(),
        lastName: a.string().required(),
        role: a.ref("UserRole").required(), // privileges are placeholder for now
        npn: a.string(), // required for producers at onboarding (app-enforced)
        onboardingComplete: a.boolean().required(),
        licenses: a.hasMany("ProducerLicense", "userProfileId"), // deprecated
        stateLicenses: a.hasMany("License", "userProfileId"),
      })
      .secondaryIndexes((index) => [index("userId")]),

    /**
     * DEPRECATED — superseded by the unified `License` model below, which
     * covers both firm and personal licenses with dates, files and status.
     * Kept so existing onboarding rows aren't dropped; no new writes.
     */
    ProducerLicense: a.model({
      userProfileId: a.id().required(),
      userProfile: a.belongsTo("UserProfile", "userProfileId"),
      state: a.string().required(),
      licenseNumber: a.string().required(),
      expirationDate: a.date(),
      linesOfAuthority: a.string().array(),
    }),

    /**
     * Unified licensing record — one row per (holder, state, license).
     *
     * Firm licenses (holderType=FIRM) have no userProfileId; personal
     * licenses point at the producer's UserProfile. Both share the same
     * fields so renewal tracking, file attachment and the state-coverage
     * matrix are written once and work for either kind.
     *
     * Supporting files (the license PDF, renewal receipts, CE certificates)
     * attach as Documents with entityType=LICENSE, entityId=<license id>.
     */
    License: a.model({
      holderType: a.ref("LicenseHolderType").required(),
      // Null for FIRM licenses; set for PRODUCER licenses.
      userProfileId: a.id(),
      userProfile: a.belongsTo("UserProfile", "userProfileId"),
      // Denormalized so firm rows and orphaned rows still render a name.
      holderName: a.string(),
      state: a.string().required(),
      licenseNumber: a.string().required(),
      npn: a.string(), // National Producer Number (firms have one too)
      licenseClass: a.ref("LicenseClass"),
      residency: a.ref("LicenseResidency"),
      linesOfAuthority: a.string().array(),
      status: a.ref("LicenseStatus"),
      effectiveDate: a.date(),
      expirationDate: a.date(),
      continuingEducationDueDate: a.date(),
      notes: a.string(),
    }),

    // ── Public website → CRM lead intake ───────────────────────────────
    // API-key-only surface for protectmyhoa.com forms. The handler forces
    // stage=LEAD; this cannot create clients or touch existing records.
    submitWebLead: a
      .mutation()
      .arguments({
        type: a.string(), // ASSOCIATION | PERSONAL | COMMERCIAL_OTHER
        name: a.string().required(),
        contactFirstName: a.string(),
        contactLastName: a.string(),
        contactEmail: a.string(),
        contactPhone: a.string(),
        address: a.string(),
        city: a.string(),
        state: a.string(),
        zip: a.string(),
        unitNumber: a.string(),
        currentCarrier: a.string(),
        buildiumId: a.string(),
        source: a.string(),
        notes: a.string(),
      })
      .returns(a.json())
      .authorization((allow) => [allow.publicApiKey()])
      .handler(a.handler.function(leadIntake)),

    // ── Team administration (ADMIN group only) ─────────────────────────
    inviteUser: a
      .mutation()
      .arguments({
        email: a.string().required(),
        role: a.string(), // ADMIN | STAFF | PRODUCER (default STAFF)
      })
      .returns(a.json())
      .authorization((allow) => [allow.groups(["ADMIN"])])
      .handler(a.handler.function(teamAdmin)),

    listTeamUsers: a
      .query()
      .returns(a.json())
      .authorization((allow) => [allow.groups(["ADMIN"])])
      .handler(a.handler.function(teamAdmin)),

    // ── AI extraction: kick off async document → datapoints extraction ──
    startLeadExtraction: a
      .mutation()
      .arguments({ accountId: a.string().required() })
      .returns(a.json())
      .authorization((allow) => [allow.authenticated()])
      .handler(a.handler.function(extractLead)),

    // ── Certificate numbering: atomically reserve the next COI number ──
    // Returns { certificateNumber, year, seq }. Uniqueness is guaranteed by
    // an atomic DynamoDB counter — see the cert-number function.
    reserveCertificateNumber: a
      .mutation()
      .returns(a.json())
      .authorization((allow) => [allow.authenticated()])
      .handler(a.handler.function(certNumber)),
  })
  .authorization((allow) => [
    // Placeholder privileges: any signed-in user has full access.
    // Tighten with group-based rules when roles are built out.
    allow.authenticated(),
    // The Textract pipeline function writes OCR results back to Document.
    allow.resource(processDocument),
    // The web-lead intake function creates Account records.
    allow.resource(leadIntake),
    // The AI extraction function reads Documents and updates Accounts.
    allow.resource(extractLead),
  ]);

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: "userPool",
    // Only the submitWebLead mutation opts into API key auth.
    apiKeyAuthorizationMode: {
      expiresInDays: 365,
    },
  },
});
