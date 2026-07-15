import { type ClientSchema, a, defineData } from "@aws-amplify/backend";
import { crmAdmin } from "../functions/crm-admin/resource";
import { crmBilling } from "../functions/crm-billing/resource";
import { stripeWebhook } from "../functions/stripe-webhook/resource";
import { crmDocs } from "../functions/crm-docs/resource";
import { agreementPublic } from "../functions/agreement-public/resource";
import { dailyReminders } from "../functions/daily-reminders/resource";
import { postAuth } from "../functions/post-auth/resource";
import { crmPricing } from "../functions/crm-pricing/resource";

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
 * Leads are Customers with status LEAD — converting a lead is a status flip
 * plus the conversion requirements (active subscription or scheduled
 * one-time job), which keeps the full history on one record.
 */
const schema = a.schema({
  CustomerStatus: a.enum(["LEAD", "ACTIVE", "INACTIVE"]),
  ServicePlanStatus: a.enum(["ACTIVE", "PAUSED", "CANCELED"]),
  QuoteStatus: a.enum(["DRAFT", "SENT", "CONVERTED", "VOID"]),
  PricingDecision: a.enum(["QUOTE", "PASS", "ESCALATE", "NEEDS_INFO"]),
  PricingOutcome: a.enum(["PENDING", "SENT", "WON", "LOST", "PASSED"]),
  ServiceFrequency: a.enum(["MONTHLY", "BIMONTHLY", "QUARTERLY"]),
  JobType: a.enum(["ONE_TIME", "RECURRING"]),
  JobStatus: a.enum([
    "UNSCHEDULED",
    "SCHEDULED",
    "IN_PROGRESS",
    "COMPLETED",
    "CANCELED",
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
      allow.groups(["OFFICE"]).to(["create", "read", "update", "delete"]),
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
      quotes: a.hasMany("Quote", "customerId"),
      pricingRuns: a.hasMany("LeadPricingRun", "customerId"),
    })
    .secondaryIndexes((index) => [
      index("status").sortKeys(["displayName"]),
      index("portalUserSub"),
    ])
    .authorization((allow) => [
      allow.groups(["OFFICE"]).to(["create", "read", "update", "delete"]),
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
    .authorization((allow) => [
      allow.groups(["OFFICE"]).to(["create", "read", "update", "delete"]),
      allow.groups(["TECH"]).to(["read"]),
      allow.groupsDefinedIn("accessGroups").to(["read"]),
    ]),

  /**
   * Global plan catalog: office defines the plans BuzzKill sells once, then
   * quotes/plans for a customer are created *from* a template. Each template
   * carries the default agreement sent when a lead is quoted (placeholders
   * {{customerName}}, {{planName}}, {{price}}, {{frequency}}, {{address}}
   * are substituted at quote time).
   */
  PlanTemplate: a
    .model({
      name: a.string().required(),
      description: a.string(),
      // Optional list price. Real quotes are priced by the AI pricing
      // engine (crm-pricing) from the rate cards; this is a display anchor.
      priceCents: a.integer(),
      serviceFrequency: a.ref("ServiceFrequency").required(),
      agreementTitle: a.string().required(),
      agreementBody: a.string().required(),
      // Pest photos shown on the e-sign page and embedded in the signed PDF.
      imageKeys: a.string().array(),
      active: a.boolean().required(),
      sortOrder: a.integer(),
      quotes: a.hasMany("Quote", "planTemplateId"),
    })
    .authorization((allow) => [
      allow.groups(["OFFICE"]).to(["create", "read", "update", "delete"]),
      allow.groups(["TECH"]).to(["read"]),
    ]),

  /**
   * A stored quote for a lead: a plan template (with optional price
   * override) plus the agreement sent for signature. Signing the agreement
   * converts the quote — lead becomes an ACTIVE customer with a ServicePlan
   * created from the quote (billing still starts explicitly once a payment
   * method is on file).
   */
  Quote: a
    .model({
      customerId: a.id().required(),
      customer: a.belongsTo("Customer", "customerId"),
      planTemplateId: a.id(),
      planTemplate: a.belongsTo("PlanTemplate", "planTemplateId"),
      planName: a.string().required(),
      priceCents: a.integer().required(),
      initialFeeCents: a.integer(),
      serviceFrequency: a.ref("ServiceFrequency").required(),
      status: a.ref("QuoteStatus").required(),
      notes: a.string(),
      servicePlanId: a.id(),
      quotedAt: a.datetime(),
      convertedAt: a.datetime(),
      accessGroups: a.string().array(),
      agreements: a.hasMany("Agreement", "quoteId"),
    })
    .authorization((allow) => [
      allow.groups(["OFFICE"]).to(["create", "read", "update", "delete"]),
      allow.groups(["TECH"]).to(["read"]),
      allow.groupsDefinedIn("accessGroups").to(["read"]),
    ]),

  /**
   * One run of the AI lead-pricing engine: the pasted/screenshotted lead,
   * what the model extracted, the deterministic rate-card price, and the
   * decision + reply. This is the pricing log Jake reviews weekly (date,
   * town, service, zone, lead fee, quoted price, outcome).
   */
  LeadPricingRun: a
    .model({
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
      quoteId: a.id(),
    })
    .authorization((allow) => [
      allow.groups(["OFFICE"]).to(["create", "read", "update", "delete"]),
    ]),

  Technician: a
    .model({
      name: a.string().required(),
      email: a.email(),
      phone: a.phone(),
      active: a.boolean().required(),
      userSub: a.string(),
      color: a.string(),
      routes: a.hasMany("Route", "technicianId"),
      jobs: a.hasMany("Job", "technicianId"),
      serviceReports: a.hasMany("ServiceReport", "technicianId"),
    })
    .secondaryIndexes((index) => [index("userSub")])
    .authorization((allow) => [
      allow.groups(["OFFICE"]).to(["create", "read", "update", "delete"]),
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
      allow.groups(["OFFICE"]).to(["create", "read", "update", "delete"]),
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
      completedAt: a.datetime(),
      notes: a.string(),
      accessGroups: a.string().array(),
      serviceReports: a.hasMany("ServiceReport", "jobId"),
      invoices: a.hasMany("Invoice", "jobId"),
    })
    .secondaryIndexes((index) => [
      index("scheduledDate"),
      index("status").sortKeys(["scheduledDate"]),
    ])
    .authorization((allow) => [
      allow.groups(["OFFICE"]).to(["create", "read", "update", "delete"]),
      allow.groups(["TECH"]).to(["read", "update"]),
      allow.groupsDefinedIn("accessGroups").to(["read"]),
    ]),

  Agreement: a
    .model({
      customerId: a.id().required(),
      customer: a.belongsTo("Customer", "customerId"),
      quoteId: a.id(),
      quote: a.belongsTo("Quote", "quoteId"),
      title: a.string().required(),
      bodyText: a.string().required(),
      status: a.ref("AgreementStatus").required(),
      signToken: a.string(),
      sentAt: a.datetime(),
      viewedAt: a.datetime(),
      signedAt: a.datetime(),
      signerName: a.string(),
      signerEmail: a.email(),
      signerIp: a.string(),
      signerUserAgent: a.string(),
      pdfKey: a.string(),
      imageKeys: a.string().array(),
      accessGroups: a.string().array(),
    })
    .secondaryIndexes((index) => [index("signToken")])
    .authorization((allow) => [
      allow.groups(["OFFICE"]).to(["create", "read", "update", "delete"]),
      allow.groupsDefinedIn("accessGroups").to(["read"]),
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
    .authorization((allow) => [
      allow.groups(["OFFICE"]).to(["create", "read", "update", "delete"]),
      allow.groups(["TECH"]).to(["create", "read", "update"]),
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
      accessGroups: a.string().array(),
    })
    .secondaryIndexes((index) => [
      index("status").sortKeys(["issuedAt"]),
      index("stripePaymentIntentId"),
    ])
    .authorization((allow) => [
      allow.groups(["OFFICE"]).to(["create", "read", "update", "delete"]),
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
      allow.groups(["OFFICE"]).to(["create", "read"]),
    ]),

  /**
   * Provision a Cognito login for staff (roles OFFICE/TECH — "both" is
   * simply both roles) or a customer (roles ["CUSTOMER"] + customerId).
   * Cognito emails the invite with a temporary password. Optionally links
   * a Technician record via technicianId; pass resend to re-invite.
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
    .authorization((allow) => [allow.groups(["OFFICE"])])
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
    .authorization((allow) => [allow.groups(["OFFICE"])])
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
    .authorization((allow) => [allow.groups(["OFFICE", "CUSTOMER"])])
    .handler(a.handler.function(crmBilling)),

  getPaymentMethodSummary: a
    .query()
    .arguments({ customerId: a.string().required() })
    .returns(a.json())
    .authorization((allow) => [allow.groups(["OFFICE", "CUSTOMER"])])
    .handler(a.handler.function(crmBilling)),

  startSubscription: a
    .mutation()
    .arguments({ servicePlanId: a.string().required() })
    .returns(a.json())
    .authorization((allow) => [allow.groups(["OFFICE"])])
    .handler(a.handler.function(crmBilling)),

  cancelSubscription: a
    .mutation()
    .arguments({ servicePlanId: a.string().required() })
    .returns(a.json())
    .authorization((allow) => [allow.groups(["OFFICE"])])
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
    .authorization((allow) => [allow.groups(["OFFICE"])])
    .handler(a.handler.function(crmBilling)),

  resumePlan: a
    .mutation()
    .arguments({ servicePlanId: a.string().required() })
    .returns(a.json())
    .authorization((allow) => [allow.groups(["OFFICE"])])
    .handler(a.handler.function(crmBilling)),

  chargeOneTimeJob: a
    .mutation()
    .arguments({ jobId: a.string().required() })
    .returns(a.json())
    .authorization((allow) => [allow.groups(["OFFICE"])])
    .handler(a.handler.function(crmBilling)),

  /** Email a lead/customer their secure e-sign link for an agreement. */
  sendAgreement: a
    .mutation()
    .arguments({ agreementId: a.string().required() })
    .returns(a.json())
    .authorization((allow) => [allow.groups(["OFFICE"])])
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
    .authorization((allow) => [allow.groups(["OFFICE", "TECH"])])
    .handler(a.handler.function(crmDocs)),

  /**
   * AI lead pricing: paste a Thumbtack lead (or attach a screenshot) and the
   * engine extracts the facts with Claude, determines the zone from real
   * drive time, prices deterministically from the rate cards, and returns
   * QUOTE / PASS / ESCALATE with a paste-ready reply. Persists a
   * LeadPricingRun and emails Jake on ESCALATE.
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
    .authorization((allow) => [allow.groups(["OFFICE"])])
    .handler(a.handler.function(crmPricing)),

  /** Presigned PUT for a lead screenshot to price (pricing/<uuid>.png). */
  getPricingUploadUrl: a
    .mutation()
    .arguments({ contentType: a.string().required() })
    .returns(a.json())
    .authorization((allow) => [allow.groups(["OFFICE"])])
    .handler(a.handler.function(crmPricing)),

  /**
   * Presigned PUT for a plan-template pest photo. Keys land under
   * `templates/<templateId>/…`; shown on the e-sign page and embedded in
   * the signed agreement PDF.
   */
  getTemplateImageUploadUrl: a
    .mutation()
    .arguments({
      templateId: a.string().required(),
      contentType: a.string().required(),
    })
    .returns(a.json())
    .authorization((allow) => [allow.groups(["OFFICE"])])
    .handler(a.handler.function(crmDocs)),

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
    .authorization((allow) => [allow.groups(["OFFICE", "TECH"])])
    .handler(a.handler.function(crmDocs)),

  /** Entitlement-checked, short-lived presigned URL for a stored PDF. */
  getDocumentUrl: a
    .query()
    .arguments({ key: a.string().required() })
    .returns(a.json())
    .authorization((allow) => [allow.groups(["OFFICE", "TECH", "CUSTOMER"])])
    .handler(a.handler.function(crmDocs)),

  /** Office-initiated transactional emails: payment-request, portal-reminder. */
  sendCustomerEmail: a
    .mutation()
    .arguments({
      customerId: a.string().required(),
      kind: a.string().required(),
      note: a.string(),
    })
    .returns(a.json())
    .authorization((allow) => [allow.groups(["OFFICE"])])
    .handler(a.handler.function(crmDocs)),
}).authorization((allow) => [
  allow.resource(crmAdmin),
  allow.resource(crmBilling),
  allow.resource(stripeWebhook),
  allow.resource(crmDocs),
  allow.resource(agreementPublic),
  allow.resource(dailyReminders),
  allow.resource(postAuth),
  allow.resource(crmPricing),
]);

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: "userPool",
  },
});
