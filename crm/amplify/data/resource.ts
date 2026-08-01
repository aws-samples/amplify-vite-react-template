import { type ClientSchema, a, defineData } from "@aws-amplify/backend";
import { processDocument } from "../functions/process-document/resource";
import { leadIntake } from "../functions/lead-intake/resource";
import { teamAdmin } from "../functions/team-admin/resource";
import { extractLead } from "../functions/extract-lead/resource";
import { certNumber } from "../functions/cert-number/resource";
import { renewalTasks } from "../functions/renewal-tasks/resource";

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
    // ── Renewal marketing tasks ──
    MarketingTaskStatus: a.enum(["OPEN", "COMPLETE"]),
    // The only two ways a marketing task can be satisfied.
    MarketingTaskResolution: a.enum(["QUOTED", "OUT_OF_APPETITE"]),
    MarketingTaskSource: a.enum(["POLICY", "LEAD"]),
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
    AggregateAppliesTo: a.enum(["POLICY", "PROJECT", "LOCATION", "OTHER"]),

    // ── Account: Lead → Client, converted in place ─────────────────────
    Account: a
      .model({
        stage: a.ref("AccountStage").required(),
        type: a.ref("AccountType").required(),
        name: a.string().required(), // association / insured name (display)
        // Full legal entity name as it must appear on carrier submissions,
        // e.g. "Freedom Village at the Villages of the Americas Condominium
        // Trust". Falls back to `name` on ACORD forms when empty.
        legalName: a.string(),
        fein: a.string(), // federal tax ID — ACORD 125 applicant block
        sicCode: a.string(), // e.g. 8641
        naicsCode: a.string(), // e.g. 813990
        contactFirstName: a.string(),
        contactLastName: a.string(),
        contactEmail: a.email(),
        // Free-form: a.phone() only accepts E.164 and rejects "555-123-4567"
        contactPhone: a.string(),
        address: a.string(),
        city: a.string(),
        state: a.string(),
        zip: a.string(),
        county: a.string(), // carriers rate by county; ACORD premises block
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
        // Who a carrier's inspector should call to get on site.
        inspectionContactName: a.string(),
        inspectionContactPhone: a.string(),
        // ── Incumbent coverage (ACORD 125 prior-carrier block) ──
        priorCarrierName: a.string(),
        priorPolicyNumber: a.string(),
        priorPremium: a.float(),
        priorTermEffective: a.date(),
        priorTermExpiration: a.date(),
        // Write-only by design: set by lead-intake from the web lead forms and
        // never read back in the app. Kept because it is the only link from an
        // account to its Buildium property record.
        buildiumId: a.string(), // lineage from web lead forms / Buildium sync
        source: a.string(), // e.g. "website", "referral", "cold"
        notes: a.string(),
        convertedAt: a.datetime(), // set when first quote is bound
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
      // Each building is its own premises row on ACORD 125, so it needs a
      // street address and an occupancy description of its own.
      streetAddress: a.string(),
      description: a.string(), // "2, 4, 10, 12 John Hancock. Two-story wood frame…"
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
      // ── General liability limits (printed on the ACORD 25 COI) ──
      glEachOccurrence: a.float(),
      glDamageToRentedPremises: a.float(),
      glMedicalExpense: a.float(),
      glPersonalAdvInjury: a.float(),
      glGeneralAggregate: a.float(),
      glProductsCompletedOps: a.float(),
      // "Occurrence" vs "Claims made" form, and what the aggregate applies to.
      glClaimsMade: a.boolean(),
      glAggregateAppliesTo: a.ref("AggregateAppliesTo"),
      // ── Property terms ──
      perOccurrenceDeductible: a.float(),
      perUnitDeductible: a.float(),
      blanketLimit: a.float(),
      coinsurancePct: a.float(),
      replacementCostType: a.ref("ReplacementCostType"),
      effectiveDate: a.date(),
      expirationDate: a.date(),
      notes: a.string(),
      policy: a.hasOne("Policy", "quoteId"),
    }),

    // ── Policies: created on bind; source data for COI generation ──────
    //
    // Authenticated read/write, ADMIN-only delete. There is no usable
    // ownership anchor to scope on: no model carries an owning-producer id.
    //
    // The nightly renewal sweep lists Policy (renewal-tasks/handler.ts:59)
    // without an explicit authMode. It is NOT affected by this rule — see the
    // note on `allow.resource` at the bottom of this file.
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
      // ── General liability limits (printed on the ACORD 25 COI) ──
      glEachOccurrence: a.float(),
      glDamageToRentedPremises: a.float(),
      glMedicalExpense: a.float(),
      glPersonalAdvInjury: a.float(),
      glGeneralAggregate: a.float(),
      glProductsCompletedOps: a.float(),
      // "Occurrence" vs "Claims made" form, and what the aggregate applies to.
      glClaimsMade: a.boolean(),
      glAggregateAppliesTo: a.ref("AggregateAppliesTo"),
      perOccurrenceDeductible: a.float(),
      perUnitDeductible: a.float(),
      blanketLimit: a.float(),
      coinsurancePct: a.float(),
      replacementCostType: a.ref("ReplacementCostType"),
      effectiveDate: a.date(),
      expirationDate: a.date(),
      notes: a.string(),
    })
      .authorization((allow) => [
        allow.authenticated().to(["read", "create", "update"]),
        allow.groups(["ADMIN"]),
      ]),

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

    /**
     * Renewal marketing task: "submit this expiring risk to this carrier".
     *
     * Created by the scheduled renewal-tasks function once a risk enters its
     * submission window (carrier lead time + 14 days before expiration), one
     * per appetite-matched appointed carrier.
     *
     * Closed only two ways, per the agency's rule: a quote gets created for
     * that carrier (QUOTED), or someone marks the carrier as not interested
     * (OUT_OF_APPETITE).
     *
     * All foreign keys are plain fields, not belongsTo — relationships make
     * them GSI keys, and policyId is legitimately empty for lead-sourced
     * tasks. The UI joins client-side.
     */
    MarketingTask: a.model({
      accountId: a.id().required(),
      carrierId: a.id().required(),
      // Set for POLICY-sourced tasks; empty when the source is a lead's
      // current-policy expiration.
      policyId: a.id(),
      sourceType: a.ref("MarketingTaskSource").required(),
      // "<sourceType>:<sourceId>:<carrierId>:<expirationDate>" — the job
      // skips any key it has already created, so daily runs never duplicate.
      dedupeKey: a.string().required(),
      // Denormalized for display without extra reads.
      accountName: a.string(),
      carrierName: a.string(),
      lines: a.string().array(),
      expirationDate: a.date(), // the term that is ending
      leadTimeDays: a.integer(), // carrier lead time the job resolved
      submitBy: a.date(), // expiration − leadTime: the real submission deadline
      triggerDate: a.date(), // submitBy − 14: when the task was raised
      status: a.ref("MarketingTaskStatus").required(),
      resolution: a.ref("MarketingTaskResolution"),
      completedAt: a.datetime(),
      completedBy: a.string(),
      notes: a.string(),
    }),

    // ── Certificates (ACORD 25 issuance history) ───────────────────────
    //
    // Authenticated read/write, ADMIN-only delete. `issuedBy` is a display
    // name string, not a user id, so it can't anchor owner-scoping — and an
    // issuance record shouldn't be erasable by whoever issued it anyway.
    // No Lambda touches this model.
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
    })
      .authorization((allow) => [
        allow.authenticated().to(["read", "create", "update"]),
        allow.groups(["ADMIN"]),
      ]),

    // ── Users & onboarding ─────────────────────────────────────────────
    /**
     * Reads stay open to every authenticated user; writes are owner-or-ADMIN.
     *
     * Reads must stay open because Licensing and Team both list the whole
     * roster and join against it for holder names — scoping reads would
     * silently render teammates as "—" rather than fail visibly. ACORD
     * generation also reads another user's profile to fetch their signature.
     *
     * The read rule is `allow.authenticated()`, which is STATIC: it authorizes
     * list/get outright, so no owner filter is ever attached to the query.
     * That matters because App.tsx resolves the signed-in user with a filtered
     * `list` on userId, not a `get` — if that list came back empty the app
     * would decide the user has no profile and re-render Onboarding, which
     * creates a second profile row. The owner rule below deliberately grants
     * only create/update, so it never participates in query authorization.
     *
     * `userId` holds the raw Cognito sub (written from AuthUser.userId, which
     * is idToken.payload.sub), so the owner rule must compare against the
     * "sub" claim — the default identity claim is "sub::username" and would
     * match no existing row.
     *
     * ADMIN gets everything because managing a teammate's signature from the
     * Team tab is deliberate (see SignatureManager). Delete is ADMIN-only:
     * nothing in the app deletes a profile, and letting someone delete their
     * own would just silently re-onboard them.
     */
    UserProfile: a
      .model({
        userId: a.string().required(), // Cognito sub
        email: a.email().required(),
        firstName: a.string().required(),
        lastName: a.string().required(),
        role: a.ref("UserRole").required(), // privileges are placeholder for now
        npn: a.string(), // required for producers at onboarding (app-enforced)
        // S3 key of a transparent-PNG signature, drawn into the signature
        // fields of generated ACORD forms. See storage: signatures/*.
        signatureKey: a.string(),
        onboardingComplete: a.boolean().required(),
        licenses: a.hasMany("ProducerLicense", "userProfileId"), // deprecated
      })
      .secondaryIndexes((index) => [index("userId")])
      .authorization((allow) => [
        allow.authenticated().to(["read"]),
        allow
          .ownerDefinedIn("userId")
          .identityClaim("sub")
          .to(["create", "update"]),
        allow.groups(["ADMIN"]),
      ]),

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
     *
     * Create stays open to authenticated users: producers self-create their
     * own License rows during onboarding (Onboarding.tsx), before any admin
     * has seen them. Editing and deleting a license — the operations that can
     * make the agency look licensed where it isn't — are ADMIN-only, which is
     * what the Licensing screen already gates its edit/delete controls on.
     * userProfileId is caller-supplied and unverified, so it can't anchor
     * owner-scoping. No Lambda touches this model.
     */
    License: a.model({
      holderType: a.ref("LicenseHolderType").required(),
      /**
       * Empty for FIRM licenses; set for PRODUCER licenses.
       *
       * Deliberately a plain field rather than a belongsTo: a relationship
       * makes this a GSI key, and DynamoDB rejects a null index key — which
       * every firm license would need. The UI joins against UserProfile
       * client-side instead (it already lists profiles for the picker).
       */
      userProfileId: a.id(),
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
    })
      .authorization((allow) => [
        allow.authenticated().to(["read", "create"]),
        allow.groups(["ADMIN"]),
      ]),

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
    // Default for every model that doesn't declare its own rules. A model
    // with its own `.authorization()` replaces `allow.authenticated()` below
    // for that model — but NOT the `allow.resource()` grants, which are not
    // per-model at all:
    //
    //   - `allow.resource()` rules are stripped out of the schema auth list
    //     before any @auth directive is generated (data-schema's
    //     extractFunctionSchemaAccess) and turned into an IAM policy granting
    //     appsync:GraphQL on <api>/types/Query|Mutation|Subscription/* — the
    //     whole API, every field.
    //   - Amplify always sets iamConfig.enableIamAuthorizationMode: true,
    //     documented as "Enables access for IAM principals. If enabled @auth
    //     directive rules are not applied."
    //
    // So these four functions keep full data access regardless of what any
    // model declares, and the model-level `allow` builder doesn't even expose
    // `.resource()` to re-declare with. Do not try.
    allow.authenticated(),
    // The Textract pipeline function writes OCR results back to Document.
    allow.resource(processDocument),
    // The web-lead intake function creates Account records.
    allow.resource(leadIntake),
    // The AI extraction function reads Documents and updates Accounts.
    allow.resource(extractLead),
    // The daily sweep reads policies/carriers/quotes and writes MarketingTasks.
    allow.resource(renewalTasks),
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
