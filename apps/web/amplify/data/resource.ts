import { type ClientSchema, a, defineData } from "@aws-amplify/backend";
import { crmAdmin } from "../functions/crm-admin/resource";
import { crmBilling } from "../functions/crm-billing/resource";
import { stripeWebhook } from "../functions/stripe-webhook/resource";
import { crmDocs } from "../functions/crm-docs/resource";
import { dailyReminders } from "../functions/daily-reminders/resource";
import { postAuth } from "../functions/post-auth/resource";
import { crmPricing } from "../functions/crm-pricing/resource";
import { bookingPublic } from "../functions/booking-public/resource";
import { leadIntake } from "../functions/lead-intake/resource";

/**
 * CRM data model, shared by the CRM app (apps/crm) and any backend functions.
 *
 * Authorization pattern:
 *   - OFFICE staff: full CRUD on everything.
 *   - TECH: read scheduling/customer context; create+update the records a
 *     technician produces in the field (routes, jobs, service reports).
 *   - Customers: every customer-visible record carries `accessGroups`, an
 *     array of dynamic Cognito group names (`cus-<customerId>` and, when the
 *     customer belongs to a management-company group, `grp-<groupId>`).
 *     Portal users are added to those Cognito groups by the crm-admin
 *     function, which is what makes "a user in a group can view the other
 *     customers in the same group" work as row-level read access.
 *
 * Leads are Customers with status LEAD. There is exactly one conversion
 * path: the customer books themselves through the public funnel (/quote —
 * day picked, terms accepted, paid by card), and the Stripe webhook's
 * finalization converts the lead record. No office-side conversion exists —
 * no quotes, no e-sign, no hand-created plans.
 */
// Exported for resource.test.ts, which checks that no custom operation
// redeclares a mutation/query the model transformer generates.
export const schema = a.schema({
  CustomerStatus: a.enum(["LEAD", "ACTIVE", "INACTIVE"]),
  ServicePlanStatus: a.enum(["ACTIVE", "PAUSED", "CANCELED"]),
  PricingDecision: a.enum(["QUOTE", "PASS", "ESCALATE", "NEEDS_INFO"]),
  PricingOutcome: a.enum(["PENDING", "SENT", "WON", "LOST", "PASSED"]),
  ServiceFrequency: a.enum(["MONTHLY", "BIMONTHLY", "QUARTERLY"]),
  JobType: a.enum(["ONE_TIME", "RECURRING"]),
  JobStatus: a.enum([
    "UNSCHEDULED",
    "SCHEDULED",
    "IN_PROGRESS",
    "COMPLETED",
    // The technician went and could not do the work: nobody home, locked gate,
    // dog out, entry refused. Terminal for the day and honest about it — no
    // report, no charge, no next visit queued. Without this the only way to
    // clear the screen was to file a report for a visit that never happened.
    "NO_ACCESS",
    "CANCELED",
  ]),
  NoAccessReason: a.enum([
    "NOBODY_HOME",
    "LOCKED_OUT",
    "DOG_LOOSE",
    "REFUSED_ENTRY",
    "UNSAFE_CONDITIONS",
    "WRONG_ADDRESS",
  ]),
  RouteStatus: a.enum(["PLANNED", "IN_PROGRESS", "COMPLETE"]),
  AgreementStatus: a.enum(["DRAFT", "SENT", "VIEWED", "SIGNED", "VOID"]),
  ReportStatus: a.enum(["DRAFT", "FINALIZED"]),
  InvoiceStatus: a.enum([
    "DRAFT",
    "OPEN",
    "PAID",
    "FAILED",
    "VOID",
    "REFUNDED",
  ]),
  PaymentMethodKind: a.enum(["CARD", "BANK"]),
  EmailStatus: a.enum(["SENT", "FAILED"]),

  CustomerGroup: a
    .model({
      name: a.string().required(),
      contactName: a.string(),
      contactEmail: a.email(),
      contactPhone: a.phone(),
      notes: a.string(),
      accessGroups: a.string().array(),
      customers: a.hasMany("Customer", "groupId"),
    })
    .authorization((allow) => [
      allow.groups(["OWNER", "OFFICE"]).to(["create", "read", "update", "delete"]),
      allow.groups(["TECH"]).to(["read"]),
      allow.groupsDefinedIn("accessGroups").to(["read"]),
    ]),

  Customer: a
    .model({
      displayName: a.string().required(),
      contactName: a.string(),
      email: a.email(),
      phone: a.phone(),
      serviceStreet: a.string(),
      serviceCity: a.string(),
      serviceState: a.string(),
      serviceZip: a.string(),
      billingStreet: a.string(),
      billingCity: a.string(),
      billingState: a.string(),
      billingZip: a.string(),
      status: a.ref("CustomerStatus").required(),
      leadSource: a.string(),
      leadNotes: a.string(),
      // TCPA evidence: whether this contact opted in to calls/texts, and when.
      // Absent or false means email-only follow-up.
      contactConsent: a.boolean(),
      contactConsentAt: a.datetime(),
      convertedAt: a.datetime(),
      notes: a.string(),
      groupId: a.id(),
      group: a.belongsTo("CustomerGroup", "groupId"),
      stripeCustomerId: a.string(),
      paymentMethodLabel: a.string(),
      paymentMethodKind: a.ref("PaymentMethodKind"),
      portalUserSub: a.string(),
      portalInvitedAt: a.datetime(),
      portalLastLoginAt: a.datetime(),
      accessGroups: a.string().array(),
      servicePlans: a.hasMany("ServicePlan", "customerId"),
      jobs: a.hasMany("Job", "customerId"),
      agreements: a.hasMany("Agreement", "customerId"),
      serviceReports: a.hasMany("ServiceReport", "customerId"),
      invoices: a.hasMany("Invoice", "customerId"),
      pricingRuns: a.hasMany("LeadPricingRun", "customerId"),
    })
    .secondaryIndexes((index) => [
      index("status").sortKeys(["displayName"]),
      index("portalUserSub"),
    ])
    // No browser delete: finalized service reports and signed agreements
    // reference this row, and a legal record whose customer can be
    // hard-deleted from a browser does not survive its retention window.
    // INACTIVE is how a customer leaves.
    .authorization((allow) => [
      allow.groups(["OWNER", "OFFICE"]).to(["create", "read", "update"]),
      allow.groups(["TECH"]).to(["read"]),
      allow.groupsDefinedIn("accessGroups").to(["read"]),
    ]),

  ServicePlan: a
    .model({
      customerId: a.id().required(),
      customer: a.belongsTo("Customer", "customerId"),
      planName: a.string().required(),
      priceCents: a.integer().required(),
      serviceFrequency: a.ref("ServiceFrequency").required(),
      status: a.ref("ServicePlanStatus").required(),
      stripeSubscriptionId: a.string(),
      startDate: a.date(),
      canceledAt: a.datetime(),
      notes: a.string(),
      accessGroups: a.string().array(),
      jobs: a.hasMany("Job", "servicePlanId"),
      invoices: a.hasMany("Invoice", "servicePlanId"),
    })
    // No browser create: plans are born only at booking finalization
    // (shared/bookingFinalize), where the price is whatever the customer
    // actually paid at checkout. That closes R25 structurally — a hand-typed
    // price cannot enter a subscription because no screen can create one.
    .authorization((allow) => [
      allow.groups(["OWNER", "OFFICE"]).to(["read", "update", "delete"]),
      allow.groups(["TECH"]).to(["read"]),
      allow.groupsDefinedIn("accessGroups").to(["read"]),
    ]),

  /**
   * One run of the AI lead-pricing engine: the pasted/screenshotted lead,
   * what the model extracted, the deterministic rate-card price, and the
   * decision + reply. This is the pricing log Jake reviews weekly (date,
   * town, service, zone, lead fee, quoted price, outcome).
   */
  // One row per website booking-funnel quote. All writes go through the
  // public booking Lambda (Function URL) - no public model access.
  BookingRequest: a
    .model({
      status: a.enum(["QUOTED", "BOOKED", "CANCELED", "EXPIRED", "CONTACT"]),
      propertyKind: a.enum(["RESIDENTIAL", "COMMUNITY", "COMMERCIAL"]),
      service: a.enum([
        "GENERAL_PEST",
        "WASP_NEST",
        "RODENT",
        "ROACH",
        "TERMITE",
        "WILDLIFE",
      ]),
      name: a.string().required(),
      email: a.string().required(),
      phone: a.string(),
      street: a.string(),
      city: a.string(),
      state: a.string(),
      zip: a.string(),
      units: a.integer(),
      sqft: a.integer(),
      nestCount: a.integer(),
      comments: a.string(),
      recurringPreference: a.string(),
      // First-touch ad attribution carried from the site (utm fields, gclid,
      // referrer, landing page); feeds the customer's leadSource at
      // finalization so website bookings keep their lead source.
      attribution: a.json(),
      zone: a.string(),
      driveMinutes: a.integer(),
      quoteJson: a.json(),
      selectedDate: a.date(),
      selectedWindow: a.string(),
      recurring: a.boolean(),
      amountCents: a.integer(),
      monthlyCents: a.integer(),
      stripeCustomerId: a.string(),
      stripePaymentIntentId: a.string(),
      cancelToken: a.string(),
      customerId: a.id(),
      jobId: a.id(),
      servicePlanId: a.id(),
      agreementId: a.id(),
      expiresAt: a.datetime(),
      // R17: the acceptance record for the checkout terms. tcVersion names
      // the exact BOOKING_TERMS_VERSION the customer saw; tcAcceptedAt is
      // server-stamped (never client-supplied); tcIp/tcUserAgent come from
      // the /book request itself.
      tcVersion: a.string(),
      tcAcceptedAt: a.datetime(),
      tcIp: a.string(),
      tcUserAgent: a.string(),
      // The calendar date (shop timezone) the customer FIRST asked to cancel.
      // Refundability is judged from this, not from when the cancellation
      // finally succeeded: an attempt that fails on day 4 because Stripe is
      // down must not cost the customer their refund when it retries on day 3.
      cancelRequestedOn: a.date(),
    })
    .secondaryIndexes((index) => [index("cancelToken"), index("status")])
    .authorization((allow) => [
      allow.groups(["OWNER", "OFFICE"]).to(["read", "update"]),
    ]),

  // Atomic finalization claim: create is conditional on the id not
  // existing, which is the only lock primitive AppSync gives us. Keyed by
  // BookingRequest id so concurrent Stripe webhook deliveries can't both
  // finalize the same booking.
  BookingFinalization: a
    .model({
      note: a.string(),
    })
    .authorization((allow) => [allow.groups(["OWNER", "OFFICE"]).to(["read", "delete"])]),

  // Best-effort per-IP throttle for the public quote endpoint (id =
  // "<ip>#<hour>"). Not a hard lock — it exists so a single abusive source
  // can't spin billed AI research and Routes calls unbounded.
  QuoteThrottle: a
    .model({
      count: a.integer().required(),
      windowStart: a.datetime(),
    })
    .authorization((allow) => [allow.groups(["OWNER", "OFFICE"]).to(["read", "delete"])]),

  // AI-researched market rates — the base price for every quoted service.
  // One research per service+area(+sqft band) returns a full rate sheet
  // (one-time, plan cadences with monthly + initial fees, wasp extra-nest,
  // HOA per-unit monthly rates by unit band) stored in ratesJson; priceCents
  // mirrors the sheet's one-time price. The office override surface is the
  // FULL sheet: the Market Rates screen edits ratesJson components, keeps
  // priceCents mirrored, and sets pinned — a pinned row never expires or
  // re-researches until the office un-pins or retires it. Cached so
  // identical inputs keep identical prices.
  MarketRate: a
    .model({
      rateKey: a.string().required(),
      service: a.string().required(),
      areaKey: a.string().required(),
      priceCents: a.integer().required(),
      ratesJson: a.json(),
      basis: a.string(),
      sources: a.string(),
      researchedAt: a.datetime(),
      expiresAt: a.datetime(),
      active: a.boolean().required(),
      // Office-edited. Pinned rows are the office's word and never expire.
      pinned: a.boolean(),
    })
    .secondaryIndexes((index) => [index("rateKey")])
    .authorization((allow) => [
      allow.groups(["OWNER", "OFFICE"]).to(["create", "read", "update", "delete"]),
    ]),

  LeadPricingRun: a
    .model({
      source: a.string(),
      customerId: a.id(),
      customer: a.belongsTo("Customer", "customerId"),
      decision: a.ref("PricingDecision").required(),
      outcome: a.ref("PricingOutcome"),
      inputText: a.string(),
      screenshotKey: a.string(),
      leadFeeCents: a.integer(),
      zone: a.string(), // A | B | OUT | UNKNOWN
      driveMinutes: a.integer(),
      town: a.string(),
      state: a.string(),
      service: a.string(), // human label, e.g. "Residential GPC — quarterly"
      frequency: a.string(), // MONTHLY | BIMONTHLY | QUARTERLY | ONE_TIME
      extracted: a.json(), // pest, propertyType, sqft/units, assumptions, flags
      monthlyPriceCents: a.integer(),
      initialFeeCents: a.integer(),
      oneTimePriceCents: a.integer(),
      priceBreakdown: a.json(), // [{label, cents}]
      replyText: a.string(),
      reason: a.string(), // pass/escalate/needs-info reason
      modelPriceMismatch: a.boolean(),
    })
    .authorization((allow) => [
      allow.groups(["OWNER", "OFFICE"]).to(["create", "read", "update", "delete"]),
    ]),

  Technician: a
    .model({
      name: a.string().required(),
      email: a.email(),
      phone: a.phone(),
      active: a.boolean().required(),
      userSub: a.string(),
      color: a.string(),
      // The applicator's certification. It belongs on every pesticide record
      // this business produces; a service report without it is not one.
      licenseNumber: a.string(),
      licenseExpiresOn: a.date(),
      routes: a.hasMany("Route", "technicianId"),
      jobs: a.hasMany("Job", "technicianId"),
      serviceReports: a.hasMany("ServiceReport", "technicianId"),
    })
    .secondaryIndexes((index) => [index("userSub")])
    // No browser delete: every finalized pesticide record names this
    // technician and carries their licence number. Deactivate instead —
    // the record has to outlive the employment.
    .authorization((allow) => [
      allow.groups(["OWNER", "OFFICE"]).to(["create", "read", "update"]),
      allow.groups(["TECH"]).to(["read"]),
    ]),

  Route: a
    .model({
      technicianId: a.id().required(),
      technician: a.belongsTo("Technician", "technicianId"),
      date: a.date().required(),
      status: a.ref("RouteStatus").required(),
      notes: a.string(),
      jobs: a.hasMany("Job", "routeId"),
    })
    .secondaryIndexes((index) => [
      index("technicianId").sortKeys(["date"]),
      index("date"),
    ])
    .authorization((allow) => [
      allow.groups(["OWNER", "OFFICE"]).to(["create", "read", "update", "delete"]),
      allow.groups(["TECH"]).to(["create", "read", "update"]),
    ]),

  Job: a
    .model({
      customerId: a.id().required(),
      customer: a.belongsTo("Customer", "customerId"),
      servicePlanId: a.id(),
      servicePlan: a.belongsTo("ServicePlan", "servicePlanId"),
      type: a.ref("JobType").required(),
      serviceType: a.string().required(),
      description: a.string(),
      priceCents: a.integer(),
      status: a.ref("JobStatus").required(),
      scheduledDate: a.date(),
      timeWindow: a.string(),
      routeId: a.id(),
      route: a.belongsTo("Route", "routeId"),
      routeOrder: a.integer(),
      technicianId: a.id(),
      technician: a.belongsTo("Technician", "technicianId"),
      /** When the technician pressed Start. The application's start time on the
       *  pesticide record — serviceDate is when the draft was first saved,
       *  which is a different thing and was wrong on reports written up later. */
      startedAt: a.datetime(),
      /** When the technician said the application was done (endApplication).
       *  Server-stamped, once — finalize used to stamp the end with its own
       *  clock, so a report finalized the next morning carried the wrong end
       *  time on a legal record, the same defect class as the start. */
      applicationEndAt: a.datetime(),
      completedAt: a.datetime(),
      // Set when the customer paid up front (website booking). Written in the
      // same create as the job, so it is the authoritative "already paid"
      // answer even if the Invoice write later fails. Every charge path must
      // refuse on this rather than on the absence of an Invoice row.
      paidAt: a.datetime(),
      paidPaymentIntentId: a.string(),
      // Set with status NO_ACCESS. The photo is the technician's evidence that
      // they attended, which is what an office no-access billing decision turns
      // on — and what protects them from being told they never went.
      noAccessReason: a.ref("NoAccessReason"),
      noAccessAt: a.datetime(),
      noAccessNote: a.string(),
      noAccessPhotoKey: a.string(),
      notes: a.string(),
      accessGroups: a.string().array(),
      serviceReports: a.hasMany("ServiceReport", "jobId"),
      invoices: a.hasMany("Invoice", "jobId"),
    })
    .secondaryIndexes((index) => [
      index("scheduledDate"),
      index("status").sortKeys(["scheduledDate"]),
      index("servicePlanId"),
    ])
    // TECH lost update: startedAt and applicationEndAt are the application
    // window on the pesticide record, and a TECH token with model update
    // could write either with any browser-supplied time, pre-finalize.
    // Technicians act on jobs through the guarded mutations (startJob,
    // endApplication, reportNoAccess, finalizeServiceReport), which stamp
    // the server's clock. No browser delete either: finalized service
    // reports reference this row, and a legal record whose job can be
    // hard-deleted from a browser does not survive its retention window.
    .authorization((allow) => [
      allow.groups(["OWNER", "OFFICE"]).to(["create", "read", "update"]),
      allow.groups(["TECH"]).to(["read"]),
      allow.groupsDefinedIn("accessGroups").to(["read"]),
    ]),

  /**
   * The booking agreement: the terms-acceptance record bookingFinalize writes
   * when a funnel checkout completes (SIGNED, with the acceptance recorded as
   * the electronic signature). The office and the portal view the stored PDF
   * read-only. The office e-sign flow (author → send → customer signs a
   * token link) is gone — the funnel is the only conversion path.
   */
  Agreement: a
    .model({
      customerId: a.id().required(),
      customer: a.belongsTo("Customer", "customerId"),
      title: a.string().required(),
      bodyText: a.string().required(),
      status: a.ref("AgreementStatus").required(),
      sentAt: a.datetime(),
      signedAt: a.datetime(),
      signerName: a.string(),
      signerEmail: a.email(),
      pdfKey: a.string(),
      accessGroups: a.string().array(),
    })
    // Read-only for every human role, for the same reason as Invoice and one
    // more: signedAt, signerName and signerEmail are the evidence that a
    // customer agreed to a contract. If any browser role held create/update
    // on this model, that user could write those fields directly and produce
    // a signed agreement indistinguishable from a real one — a forged
    // contract, from a browser, with no record of who did it.
    //
    // Only bookingFinalize (inside the Stripe webhook, behind a real payment)
    // writes one now.
    .authorization((allow) => [
      allow.groups(["OWNER", "OFFICE"]).to(["read"]),
      allow.groupsDefinedIn("accessGroups").to(["read"]),
    ]),

  // Master product catalog: techs pick from it on service reports; the
  // office curates it (techs can add a missing product from the field).
  Product: a
    .model({
      name: a.string().required(),
      epaNumber: a.string(),
      activeIngredient: a.string(),
      defaultQuantity: a.string(),
      /** Label rate or dilution, e.g. "0.05% dilution" or "1 oz / gal". */
      defaultRate: a.string(),
      /** Label re-entry interval in hours. 0 for baits and exterior-only work. */
      reEntryHours: a.float(),
      targetPests: a.string(),
      notes: a.string(),
      active: a.boolean().required(),
      sortOrder: a.integer(),
    })
    // The catalog is the control that makes pesticide records correct by
    // construction. TECH create is gone: a technician in manual-product mode
    // could publish a permanent, active row into the master catalog from a
    // crawlspace, with a blank or invented EPA number, that every other
    // technician then picked from. A manual product now lives on that one
    // report; adding it to the catalog is an office decision.
    .authorization((allow) => [
      allow.groups(["OWNER", "OFFICE"]).to(["create", "read", "update", "delete"]),
      allow.groups(["TECH"]).to(["read"]),
    ]),

  ServiceReport: a
    .model({
      jobId: a.id().required(),
      job: a.belongsTo("Job", "jobId"),
      customerId: a.id().required(),
      customer: a.belongsTo("Customer", "customerId"),
      technicianId: a.id().required(),
      technician: a.belongsTo("Technician", "technicianId"),
      serviceDate: a.datetime().required(),
      // When the application actually happened. serviceDate is stamped when the
      // draft is first saved, which is not the same thing — a report written up
      // the next morning carried the wrong date on a legal record and there was
      // no way to correct it.
      applicationStartAt: a.datetime(),
      applicationEndAt: a.datetime(),
      /**
       * Hours before the treated area is safe to re-enter. The applicator's
       * duty to warn: the occupant cannot be told when to come back if nobody
       * recorded it. 0 is a real answer (bait stations, exterior only) and is
       * distinct from "nobody said".
       */
      reEntryIntervalHours: a.float(),
      /** No product was applied — an inspection. Makes "zero products" a
       *  deliberate statement rather than an empty required field. */
      inspectionOnly: a.boolean(),
      servicesPerformed: a.string(),
      productsUsed: a.json(),
      targetPests: a.string(),
      areasTreated: a.string(),
      recommendations: a.string(),
      techNotes: a.string(),
      geoLat: a.float(),
      geoLng: a.float(),
      geoAccuracyM: a.float(),
      geoCapturedAt: a.datetime(),
      status: a.ref("ReportStatus").required(),
      pdfKey: a.string(),
      photoKeys: a.string().array(),
      emailedAt: a.datetime(),
      accessGroups: a.string().array(),
    })
    .secondaryIndexes((index) => [index("jobId")])
    // A finalized report is the pesticide-application record behind BuzzKill's
    // applicator licence, and it is the document a customer already has a copy
    // of. It was rewritable after issuance by both TECH and OFFICE — which is
    // worse than keeping no record at all, because in an enforcement action an
    // editable regulatory document is affirmative evidence of an uncontrolled
    // system.
    //
    // Read-only from a browser. Drafts are written through
    // saveServiceReportDraft and setReportPhotos, which refuse once the report
    // is FINALIZED; nothing edits it after that.
    .authorization((allow) => [
      allow.groups(["OWNER", "OFFICE", "TECH"]).to(["read"]),
      allow.groupsDefinedIn("accessGroups").to(["read"]),
    ]),

  Invoice: a
    .model({
      customerId: a.id().required(),
      customer: a.belongsTo("Customer", "customerId"),
      jobId: a.id(),
      job: a.belongsTo("Job", "jobId"),
      servicePlanId: a.id(),
      servicePlan: a.belongsTo("ServicePlan", "servicePlanId"),
      description: a.string().required(),
      amountCents: a.integer().required(),
      status: a.ref("InvoiceStatus").required(),
      method: a.ref("PaymentMethodKind"),
      stripeInvoiceId: a.string(),
      stripePaymentIntentId: a.string(),
      issuedAt: a.datetime(),
      paidAt: a.datetime(),
      failureReason: a.string(),
      // Refunds. Cumulative, because an invoice can be refunded more than once
      // in parts. status flips to REFUNDED only when the whole amount is back;
      // until then the invoice stays PAID with a non-zero refundedAmountCents,
      // and every revenue figure is amountCents - refundedAmountCents.
      refundedAmountCents: a.integer(),
      refundedAt: a.datetime(),
      refundReason: a.string(),
      stripeRefundId: a.string(),
      // VOID is how an invoice is withdrawn. There is no delete: a ledger that
      // can lose a row cannot be reconciled against Stripe, and "it was never
      // there" is not something a financial record should be able to say.
      voidedAt: a.datetime(),
      voidReason: a.string(),
      // Who moved the money. Stamped server-side from the caller's Cognito
      // identity — never accepted from the client, or it would be a field an
      // actor could fill in with someone else's name.
      createdBy: a.string(),
      createdByEmail: a.string(),
      refundedBy: a.string(),
      refundedByEmail: a.string(),
      voidedBy: a.string(),
      voidedByEmail: a.string(),
      accessGroups: a.string().array(),
    })
    .secondaryIndexes((index) => [
      index("status").sortKeys(["issuedAt"]),
      index("stripePaymentIntentId"),
    ])
    // Invoices are the financial record and no browser writes one. Every field
    // — the amount, the status, what was refunded, who did it — is set by a
    // Lambda: chargeOneTimeJob, chargeManualAmount, recordOfflinePayment,
    // refundInvoice, voidInvoice, the booking funnel, the subscription webhook.
    //
    // Read-only for every human role, deliberately. Closing `create` alone was
    // not enough: FINANCE — the role this audit trail exists to hold to account
    // — could still call Invoice.update({ id, createdBy: "someone else" })
    // against the GraphQL endpoint and rewrite its own name off a charge, or
    // move amountCents, status and refundedAmountCents, which are every number
    // the Dashboard reports. That the CRM's UI never offered it is not the bar.
    // The bar for an audit trail is that the audited party cannot rewrite it.
    //
    // Delete is gone too. An invoice is withdrawn with VOID, which leaves the
    // row, the reason and the actor behind.
    .authorization((allow) => [
      allow.groups(["OWNER", "FINANCE", "OFFICE"]).to(["read"]),
      allow.groupsDefinedIn("accessGroups").to(["read"]),
    ]),

  EmailLog: a
    .model({
      customerId: a.id(),
      toEmail: a.string().required(),
      subject: a.string().required(),
      template: a.string().required(),
      status: a.ref("EmailStatus").required(),
      error: a.string(),
      relatedId: a.string(),
      sentAt: a.datetime().required(),
    })
    .authorization((allow) => [
      allow.groups(["OWNER", "OFFICE"]).to(["create", "read"]),
    ]),

  /**
   * Provision a Cognito login for staff (roles OWNER/OFFICE/FINANCE/TECH —
   * combinations are simply multiple roles) or a customer (roles
   * ["CUSTOMER"] + customerId). Optionally links a Technician record via
   * technicianId; pass resend to re-invite.
   *
   * OWNER-only, and deliberately so: staff provisioning is what makes every
   * other role boundary meaningful. If OFFICE could invite, OFFICE could mint
   * itself FINANCE and the split would be decorative.
   */
  adminCreateUser: a
    .mutation()
    .arguments({
      email: a.string().required(),
      name: a.string().required(),
      roles: a.string().required().array().required(),
      customerId: a.string(),
      technicianId: a.string(),
      resend: a.boolean(),
    })
    .returns(a.json())
    .authorization((allow) => [allow.groups(["OWNER"])])
    .handler(a.handler.function(crmAdmin)),

  /**
   * Move a customer into/out of a CustomerGroup, rewriting accessGroups on
   * the customer + child records and fixing the portal user's dynamic
   * Cognito group membership.
   */
  setCustomerGroup: a
    .mutation()
    .arguments({
      customerId: a.string().required(),
      groupId: a.string(),
    })
    .returns(a.json())
    .authorization((allow) => [allow.groups(["OWNER", "OFFICE"])])
    .handler(a.handler.function(crmAdmin)),

  /**
   * Stripe: collect a payment method (card or US bank) before the first
   * treatment. Office can initiate for any customer; a portal user only
   * for their own record (handler-enforced via dynamic groups).
   */
  createSetupIntent: a
    .mutation()
    .arguments({ customerId: a.string().required() })
    .returns(a.json())
    .authorization((allow) => [allow.groups(["OWNER", "OFFICE", "CUSTOMER"])])
    .handler(a.handler.function(crmBilling)),

  getPaymentMethodSummary: a
    .query()
    .arguments({ customerId: a.string().required() })
    .returns(a.json())
    .authorization((allow) => [allow.groups(["OWNER", "OFFICE", "CUSTOMER"])])
    .handler(a.handler.function(crmBilling)),

  // ── Money movement: OWNER or FINANCE only ────────────────────────────
  // OFFICE runs the day-to-day but cannot start, stop, or take money. These
  // are the operations that reach Stripe or a customer's card.

  startSubscription: a
    .mutation()
    .arguments({ servicePlanId: a.string().required() })
    .returns(a.json())
    .authorization((allow) => [allow.groups(["OWNER", "FINANCE"])])
    .handler(a.handler.function(crmBilling)),

  cancelSubscription: a
    .mutation()
    .arguments({ servicePlanId: a.string().required() })
    .returns(a.json())
    .authorization((allow) => [allow.groups(["OWNER", "FINANCE"])])
    .handler(a.handler.function(crmBilling)),

  /**
   * Deactivate/reactivate a plan without ending it: pauses Stripe payment
   * collection when a subscription is running and flips the plan status
   * PAUSED ⇄ ACTIVE.
   */
  pausePlan: a
    .mutation()
    .arguments({ servicePlanId: a.string().required() })
    .returns(a.json())
    .authorization((allow) => [allow.groups(["OWNER", "FINANCE"])])
    .handler(a.handler.function(crmBilling)),

  resumePlan: a
    .mutation()
    .arguments({ servicePlanId: a.string().required() })
    .returns(a.json())
    .authorization((allow) => [allow.groups(["OWNER", "FINANCE"])])
    .handler(a.handler.function(crmBilling)),

  chargeOneTimeJob: a
    .mutation()
    .arguments({ jobId: a.string().required() })
    .returns(a.json())
    .authorization((allow) => [allow.groups(["OWNER", "FINANCE"])])
    .handler(a.handler.function(crmBilling)),

  /**
   * Charge an arbitrary amount to a customer's card on file (finance escape
   * hatch for one-off charges that don't map to a job).
   *
   * `description` is required — it is the charge's reason, and it is what the
   * customer sees on their statement. A charge nobody can explain afterwards is
   * the same problem as a refund nobody can explain.
   *
   * FINANCE is capped at MANUAL_CHARGE_CEILING_CENTS; an OWNER can go above it.
   * That ceiling is a backstop, not the control — the control is the
   * confirmation the CRM shows before calling this.
   */
  chargeManualAmount: a
    .mutation()
    .arguments({
      customerId: a.string().required(),
      amountCents: a.integer().required(),
      description: a.string().required(),
      idempotencyKey: a.string(),
    })
    .returns(a.json())
    .authorization((allow) => [allow.groups(["OWNER", "FINANCE"])])
    .handler(a.handler.function(crmBilling)),

  /**
   * Record a payment taken outside Stripe — cash, cheque, bank transfer — or
   * an invoice to be settled later. Moves no money.
   *
   * A mutation rather than a client-side Invoice.create so the actor is stamped
   * from the Cognito identity rather than supplied by the browser. Recording
   * $500 as collected without collecting it is the cheapest way to fabricate
   * revenue in this product; the least it can do is name who did it.
   */
  recordOfflinePayment: a
    .mutation()
    .arguments({
      customerId: a.string().required(),
      amountCents: a.integer().required(),
      description: a.string().required(),
      /** PAID for money already in hand, OPEN to invoice for it. */
      status: a.string().required(),
      /** How it arrived: CASH | CHEQUE | BANK | OTHER. Recorded in the notes. */
      method: a.string(),
      jobId: a.string(),
    })
    .returns(a.json())
    .authorization((allow) => [allow.groups(["OWNER", "FINANCE"])])
    .handler(a.handler.function(crmBilling)),

  /**
   * Refund a paid invoice, in full or in part. The only way a refund happens:
   * one issued from the Stripe dashboard leaves the CRM's invoice PAID forever
   * and the Dashboard counts the money as revenue in perpetuity.
   *
   * amountCents omitted refunds whatever is still outstanding. Invoices with no
   * stripePaymentIntentId were recorded as offline payments — no card was
   * charged, so nothing is sent to Stripe and this records the cash going back.
   */
  refundInvoice: a
    .mutation()
    .arguments({
      invoiceId: a.string().required(),
      amountCents: a.integer(),
      reason: a.string().required(),
    })
    .returns(a.json())
    .authorization((allow) => [allow.groups(["OWNER", "FINANCE"])])
    .handler(a.handler.function(crmBilling)),

  /**
   * Withdraw an invoice that should not have been raised. Status → VOID, with a
   * reason and an actor. This is the only way an invoice leaves the books:
   * there is no delete, because a ledger that can lose a row cannot be
   * reconciled and "it was never there" is not a thing a financial record
   * should be able to say.
   */
  voidInvoice: a
    .mutation()
    .arguments({
      invoiceId: a.string().required(),
      reason: a.string().required(),
    })
    .returns(a.json())
    .authorization((allow) => [allow.groups(["OWNER", "FINANCE"])])
    .handler(a.handler.function(crmBilling)),

  /**
   * Create or update a technician's draft report.
   *
   * A mutation because the model is read-only from a browser now: a FINALIZED
   * report is a pesticide record the customer already holds a copy of, and it
   * was rewritable after issuance by anyone with the app. This refuses once the
   * report is finalized, which is what "immutable" means here.
   */
  saveServiceReportDraft: a
    .mutation()
    .arguments({
      jobId: a.string().required(),
      reportId: a.string(),
      servicesPerformed: a.string(),
      productsUsed: a.json(),
      targetPests: a.string(),
      areasTreated: a.string(),
      recommendations: a.string(),
      techNotes: a.string(),
      reEntryIntervalHours: a.float(),
      inspectionOnly: a.boolean(),
      geoLat: a.float(),
      geoLng: a.float(),
      geoAccuracyM: a.float(),
      geoCapturedAt: a.datetime(),
    })
    .returns(a.json())
    .authorization((allow) => [allow.groups(["OWNER", "OFFICE", "TECH"])])
    .handler(a.handler.function(crmDocs)),

  /** Attach or remove report photos. Refuses once the report is FINALIZED. */
  setReportPhotos: a
    .mutation()
    .arguments({
      reportId: a.string().required(),
      photoKeys: a.string().required().array().required(),
    })
    .returns(a.json())
    .authorization((allow) => [allow.groups(["OWNER", "OFFICE", "TECH"])])
    .handler(a.handler.function(crmDocs)),

  /**
   * The technician attended and could not do the work.
   *
   * The whole point is what it does not do: no service report, so no pesticide
   * record for an application that never happened; no completion, so no charge
   * is armed; no next recurring visit queued, because the plan's cadence should
   * not advance on a visit that did not occur. The office is told and the day's
   * capacity is freed.
   *
   * Before this existed, a technician at a locked door had two options: leave
   * the job hanging and keep being nagged, or file a report for a visit that
   * never happened. The second one is the one that clears the screen.
   */
  reportNoAccess: a
    .mutation()
    .arguments({
      jobId: a.string().required(),
      reason: a.string().required(),
      note: a.string(),
      photoKey: a.string(),
    })
    .returns(a.json())
    .authorization((allow) => [allow.groups(["OWNER", "OFFICE", "TECH"])])
    .handler(a.handler.function(crmDocs)),

  /** Presigned PUT for the no-access door photo, before the job has a report. */
  getNoAccessPhotoUploadUrl: a
    .mutation()
    .arguments({
      jobId: a.string().required(),
      contentType: a.string().required(),
    })
    .returns(a.json())
    .authorization((allow) => [allow.groups(["OWNER", "OFFICE", "TECH"])])
    .handler(a.handler.function(crmDocs)),

  /**
   * The technician pressed Start. A mutation because startedAt is the
   * application's start time on the pesticide record: it used to be a plain
   * client-side Job.update with a browser-supplied timestamp, which any TECH
   * token could rewrite pre-finalize. There is no time argument to pass —
   * the server's clock is the record's, and a start that already happened
   * cannot be moved.
   */
  startJob: a
    .mutation()
    .arguments({ jobId: a.string().required() })
    .returns(a.json())
    .authorization((allow) => [allow.groups(["OWNER", "OFFICE", "TECH"])])
    .handler(a.handler.function(crmDocs)),

  /**
   * The technician finished applying. Stamps the application's end time with
   * the server's clock, once — finalize used to stamp it, so a report
   * finalized the next morning carried the wrong end time on a legal record.
   * The first stamp wins: a finalize retried tomorrow keeps today's end.
   */
  endApplication: a
    .mutation()
    .arguments({ jobId: a.string().required() })
    .returns(a.json())
    .authorization((allow) => [allow.groups(["OWNER", "OFFICE", "TECH"])])
    .handler(a.handler.function(crmDocs)),

  /**
   * Render a technician's report to PDF (with the on-site geolocation
   * stamp), store it under the customer record, email it to the customer,
   * and mark the job COMPLETED.
   */
  finalizeServiceReport: a
    .mutation()
    .arguments({ reportId: a.string().required() })
    .returns(a.json())
    .authorization((allow) => [allow.groups(["OWNER", "OFFICE", "TECH"])])
    .handler(a.handler.function(crmDocs)),

  /** Office-side job completion without a field report — marks COMPLETED and
   *  queues the next recurring visit. */
  completeJob: a
    .mutation()
    .arguments({ jobId: a.string().required() })
    .returns(a.json())
    .authorization((allow) => [allow.groups(["OWNER", "OFFICE"])])
    .handler(a.handler.function(crmDocs)),

  /**
   * AI lead pricing: paste a Thumbtack lead (or attach a screenshot) and the
   * engine extracts the facts with Claude, determines the zone from real
   * drive time, prices from the cached AI market-rate sheets (deterministic
   * Zone B adders on top), and returns QUOTE / PASS / ESCALATE with a
   * paste-ready reply. Research failure escalates — the human is the
   * fallback, never an invented price. Persists a LeadPricingRun and emails
   * Jake on ESCALATE.
   */
  priceLead: a
    .mutation()
    .arguments({
      inputText: a.string(),
      screenshotKey: a.string(),
      customerId: a.string(),
      leadFeeCents: a.integer(),
    })
    .returns(a.json())
    .authorization((allow) => [allow.groups(["OWNER", "OFFICE"])])
    .handler(a.handler.function(crmPricing)),

  /** Presigned PUT for a lead screenshot to price (pricing/<uuid>.png). */
  getPricingUploadUrl: a
    .mutation()
    .arguments({ contentType: a.string().required() })
    .returns(a.json())
    .authorization((allow) => [allow.groups(["OWNER", "OFFICE"])])
    .handler(a.handler.function(crmPricing)),

  /**
   * Presigned PUT for a technician report photo. Keys land under
   * `reports/<customerId>/photos/<reportId>/…` so the existing
   * getDocumentUrl entitlement covers viewing them.
   */
  getReportPhotoUploadUrl: a
    .mutation()
    .arguments({
      reportId: a.string().required(),
      contentType: a.string().required(),
    })
    .returns(a.json())
    .authorization((allow) => [allow.groups(["OWNER", "OFFICE", "TECH"])])
    .handler(a.handler.function(crmDocs)),

  /** Entitlement-checked, short-lived presigned URL for a stored PDF. */
  getDocumentUrl: a
    .query()
    .arguments({ key: a.string().required() })
    .returns(a.json())
    .authorization((allow) => [allow.groups(["OWNER", "OFFICE", "TECH", "CUSTOMER"])])
    .handler(a.handler.function(crmDocs)),

  /** Office-initiated transactional emails: payment-request, portal-reminder,
   *  booking-link (the lead's one conversion path — the public funnel). */
  sendCustomerEmail: a
    .mutation()
    .arguments({
      customerId: a.string().required(),
      kind: a.string().required(),
      note: a.string(),
    })
    .returns(a.json())
    .authorization((allow) => [allow.groups(["OWNER", "OFFICE"])])
    .handler(a.handler.function(crmDocs)),
}).authorization((allow) => [
  allow.resource(crmAdmin),
  allow.resource(crmBilling),
  allow.resource(stripeWebhook),
  allow.resource(crmDocs),
  allow.resource(dailyReminders),
  allow.resource(postAuth),
  allow.resource(crmPricing),
  allow.resource(bookingPublic),
  allow.resource(leadIntake),
]);

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: "userPool",
  },
});
