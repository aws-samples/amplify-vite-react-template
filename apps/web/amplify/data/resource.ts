import { type ClientSchema, a, defineData } from "@aws-amplify/backend";
import { crmAdmin } from "../functions/crm-admin/resource";
import { crmBilling } from "../functions/crm-billing/resource";
import { stripeWebhook } from "../functions/stripe-webhook/resource";
import { crmDocs } from "../functions/crm-docs/resource";
import { agreementPublic } from "../functions/agreement-public/resource";
import { dailyReminders } from "../functions/daily-reminders/resource";

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
      accessGroups: a.string().array(),
      servicePlans: a.hasMany("ServicePlan", "customerId"),
      jobs: a.hasMany("Job", "customerId"),
      agreements: a.hasMany("Agreement", "customerId"),
      serviceReports: a.hasMany("ServiceReport", "customerId"),
      invoices: a.hasMany("Invoice", "customerId"),
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
]);

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: "userPool",
  },
});
