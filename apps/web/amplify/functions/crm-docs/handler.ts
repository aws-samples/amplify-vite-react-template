import { randomBytes } from "node:crypto";
import type { AppSyncResolverEvent } from "aws-lambda";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { dataClient } from "../shared/dataClient";
import {
  assertProductCanBeSaved,
  assertTechnicianCompliance,
  EPA_REGISTRATION_RE,
} from "../shared/compliance";
import { opFieldName } from "../shared/opEvent";
import {
  callerGroups,
  callerIsOffice,
  callerSub,
  isStaff,
} from "../shared/authz";
import { cusGroup, customerAccessGroups, grpGroup } from "../shared/dynamicGroups";
import { emailShell, notifyOffice, sendEmail } from "../shared/email";
import {
  nextVisitDate,
  prettyDate,
  scheduleNextRecurringVisit,
} from "../shared/recurring";
import { renderServiceReportPdf, type ReportProduct } from "../shared/pdf";
import { stripeClient } from "../shared/stripeClient";
import { startPlanBilling } from "../shared/subscription";

const s3 = new S3Client();
const BUCKET = () => {
  const b = process.env.DOCS_BUCKET;
  if (!b) throw new Error("DOCS_BUCKET is not configured");
  return b;
};
const CRM_URL = () =>
  process.env.CRM_APP_URL ?? "https://staging.d5ln2hbbp9s2j.amplifyapp.com";
/** The public booking funnel — the only path a lead converts down. */
const FUNNEL_URL = () =>
  `${process.env.MARKETING_URL ?? "https://www.pestbuzzkill.com"}/quote`;

/** productsUsed is an AWSJSON field — may arrive as a JSON string. */
function parseProducts(raw: unknown): ReportProduct[] {
  try {
    const v = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(v) ? (v as ReportProduct[]) : [];
  } catch {
    return [];
  }
}

type Args = {
  reportId?: string;
  jobId?: string;
  key?: string;
  customerId?: string;
  kind?: string;
  note?: string;
  notes?: string;
  contentType?: string;
  reason?: string;
  photoKey?: string;
  servicesPerformed?: string;
  productsUsed?: unknown;
  targetPests?: string;
  areasTreated?: string;
  recommendations?: string;
  techNotes?: string;
  reEntryIntervalHours?: number;
  inspectionOnly?: boolean;
  geoLat?: number;
  geoLng?: number;
  geoAccuracyM?: number;
  geoCapturedAt?: string;
  photoKeys?: (string | null)[];
  productId?: string;
  name?: string;
  epaNumber?: string;
  activeIngredient?: string;
  defaultQuantity?: string;
  defaultRate?: string;
  reEntryHours?: number;
  labelApproved?: boolean;
  active?: boolean;
  sortOrder?: number;
  servicePlanId?: string;
  serviceType?: string;
  priceCents?: number;
  scheduledDate?: string;
  timeWindow?: string;
  operation?: string;
  technicianId?: string;
  routeId?: string;
  routeOrder?: number;
  otherJobId?: string;
  otherRouteOrder?: number;
};

export const handler = async (event: AppSyncResolverEvent<Args>) => {
  switch (opFieldName(event)) {
    case "saveServiceReportDraft": {
      if (!isStaff(callerGroups(event.identity))) {
        throw new Error("Staff role required");
      }
      return saveServiceReportDraft(callerSub(event.identity), {
        jobId: event.arguments.jobId!,
        reportId: event.arguments.reportId,
        servicesPerformed: event.arguments.servicesPerformed,
        productsUsed: event.arguments.productsUsed,
        targetPests: event.arguments.targetPests,
        areasTreated: event.arguments.areasTreated,
        recommendations: event.arguments.recommendations,
        techNotes: event.arguments.techNotes,
        reEntryIntervalHours: event.arguments.reEntryIntervalHours,
        inspectionOnly: event.arguments.inspectionOnly,
        geoLat: event.arguments.geoLat,
        geoLng: event.arguments.geoLng,
        geoAccuracyM: event.arguments.geoAccuracyM,
        geoCapturedAt: event.arguments.geoCapturedAt,
      });
    }
    case "setReportPhotos": {
      if (!isStaff(callerGroups(event.identity))) {
        throw new Error("Staff role required");
      }
      return setReportPhotos(
        event.arguments.reportId!,
        (event.arguments.photoKeys ?? []).filter(
          (k): k is string => typeof k === "string"
        )
      );
    }
    case "reportNoAccess": {
      if (!isStaff(callerGroups(event.identity))) {
        throw new Error("Staff role required");
      }
      return reportNoAccess({
        jobId: event.arguments.jobId!,
        reason: event.arguments.reason ?? "",
        note: event.arguments.note,
        photoKey: event.arguments.photoKey,
      });
    }
    case "getNoAccessPhotoUploadUrl": {
      if (!isStaff(callerGroups(event.identity))) {
        throw new Error("Staff role required");
      }
      return getNoAccessPhotoUploadUrl(
        event.arguments.jobId!,
        event.arguments.contentType!
      );
    }
    case "startJob": {
      if (!isStaff(callerGroups(event.identity))) {
        throw new Error("Staff role required");
      }
      return startJob(event.arguments.jobId!);
    }
    case "endApplication": {
      if (!isStaff(callerGroups(event.identity))) {
        throw new Error("Staff role required");
      }
      return endApplication(event.arguments.jobId!);
    }
    case "completeJob": {
      return completeJob(event.arguments.jobId!);
    }
    case "finalizeServiceReport": {
      if (!isStaff(callerGroups(event.identity))) {
        throw new Error("Staff role required");
      }
      return finalizeServiceReport(event.arguments.reportId!);
    }
    case "saveProduct": {
      if (!callerIsOffice(event.identity)) throw new Error("Office role required");
      return saveProduct(event.arguments);
    }
    case "createOfficeJob": {
      if (!callerIsOffice(event.identity)) throw new Error("Office role required");
      return createOfficeJob(event.arguments);
    }
    case "updateJobSchedule": {
      if (!callerIsOffice(event.identity)) throw new Error("Office role required");
      return updateJobSchedule(event.arguments);
    }
    case "getDocumentUrl": {
      return getDocumentUrl(event.arguments.key!, callerGroups(event.identity));
    }
    case "getReportPhotoUploadUrl": {
      if (!isStaff(callerGroups(event.identity))) {
        throw new Error("Staff role required");
      }
      return getReportPhotoUploadUrl(
        event.arguments.reportId!,
        event.arguments.contentType!
      );
    }
    case "sendCustomerEmail": {
      if (!callerIsOffice(event.identity)) throw new Error("Office role required");
      return sendCustomerEmail(
        event.arguments.customerId!,
        event.arguments.kind!,
        event.arguments.note ?? undefined
      );
    }
    default:
      throw new Error(`Unknown field ${opFieldName(event)}`);
  }
};

/** Office-initiated transactional emails (payment request, portal reminder,
 *  booking link — the lead's one conversion path). */
async function sendCustomerEmail(
  customerId: string,
  kind: string,
  note?: string
) {
  const client = await dataClient();
  const { data: customer } = await client.models.Customer.get({
    id: customerId,
  });
  if (!customer?.email) throw new Error("Customer has no email address on file");
  const hi = `<p>Hi ${customer.contactName ?? customer.displayName},</p>`;
  const noteHtml = note
    ? `<p style="border-left:3px solid #e4e6ea;padding-left:12px;color:#444;">${note}</p>`
    : "";

  let subject: string;
  let heading: string;
  let body: string;
  if (kind === "payment-request") {
    subject = "Action needed: add a payment method";
    heading = "Add a payment method";
    body = `${hi}
      <p>Before your first BuzzKill service visit, please add a payment method (card or bank account) to your account.</p>
      ${noteHtml}
      <p style="margin:20px 0;"><a href="${CRM_URL()}/billing" style="background:#176b2c;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600;">Add payment method</a></p>
      <p style="color:#666;font-size:13px;">Sign in with your BuzzKill account. Payment details are stored securely with Stripe — we never see your card or account number.</p>`;
  } else if (kind === "portal-reminder") {
    subject = "Your BuzzKill customer portal";
    heading = "Your customer portal";
    body = `${hi}
      <p>Your BuzzKill portal has your upcoming visits, service reports, agreements, and billing in one place.</p>
      ${noteHtml}
      <p style="margin:20px 0;"><a href="${CRM_URL()}" style="background:#176b2c;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600;">Open my portal</a></p>`;
  } else if (kind === "booking-link") {
    // The lead's one conversion path: the public funnel. Honest about what
    // happens there — price in seconds, pick a day, pay to book — and about
    // the fallback (a specialist calls when the funnel can't price it).
    const funnelUrl = FUNNEL_URL();
    subject = "Get your exact price and book your BuzzKill visit online";
    heading = "Your price and your day, in about a minute";
    body = `${hi}
      <p>You can see your exact price in seconds, pick the day that works for you, and pay online to lock in your visit — no paperwork, no back-and-forth.</p>
      ${noteHtml}
      <p style="margin:20px 0;"><a href="${funnelUrl}" style="background:#176b2c;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600;">Get my price &amp; book my visit</a></p>
      <p>If our online quote can't price your property, it will say so and a specialist will call you to sort it out.</p>
      <p style="color:#666;font-size:13px;">Or paste this link into your browser: ${funnelUrl}</p>`;
  } else {
    throw new Error(`Unknown email kind: ${kind}`);
  }

  const sent = await sendEmail({
    to: customer.email,
    subject,
    template: kind,
    customerId,
    html: emailShell(heading, body),
  });
  return { sent, to: customer.email };
}

async function saveProduct(args: Args) {
  const name = args.name?.trim() ?? "";
  if (!name) throw new Error("Product name is required");
  const fields = {
    name,
    epaNumber: args.epaNumber?.trim() || null,
    activeIngredient: args.activeIngredient?.trim() || null,
    defaultQuantity: args.defaultQuantity?.trim() || null,
    defaultRate: args.defaultRate?.trim() || null,
    reEntryHours: args.reEntryHours ?? null,
    labelApproved: args.labelApproved ?? false,
    targetPests: args.targetPests?.trim() || null,
    notes: args.notes?.trim() || null,
    active: args.active ?? false,
    sortOrder: args.sortOrder ?? null,
  };
  assertProductCanBeSaved(fields);

  const client = await dataClient();
  const result = args.productId
    ? await client.models.Product.update({ id: args.productId, ...fields })
    : await client.models.Product.create(fields);
  if (!result.data) {
    throw new Error(
      `Could not save the product: ${result.errors?.map((e) => e.message).join("; ") ?? "unknown error"}`
    );
  }
  return { productId: result.data.id };
}

/** Jobs created by the office always start unassigned. */
async function createOfficeJob(args: Args) {
  const customerId = args.customerId?.trim() ?? "";
  const serviceType = args.serviceType?.trim() ?? "";
  if (!customerId) throw new Error("Customer is required");
  if (!serviceType) throw new Error("Service type is required");

  const client = await dataClient();
  const { data: customer } = await client.models.Customer.get({ id: customerId });
  if (!customer) throw new Error(`Customer ${customerId} not found`);
  if (args.servicePlanId) {
    const { data: plan } = await client.models.ServicePlan.get({
      id: args.servicePlanId,
    });
    if (!plan || plan.customerId !== customerId) {
      throw new Error("That service plan does not belong to this customer");
    }
  }

  const { data: created, errors } = await client.models.Job.create({
    customerId,
    servicePlanId: args.servicePlanId || undefined,
    type: args.servicePlanId ? "RECURRING" : "ONE_TIME",
    serviceType,
    priceCents: args.priceCents ?? undefined,
    status: args.scheduledDate ? "SCHEDULED" : "UNSCHEDULED",
    scheduledDate: args.scheduledDate || undefined,
    timeWindow: args.timeWindow?.trim() || undefined,
    accessGroups: customerAccessGroups(customerId, customer.groupId),
  });
  if (!created) {
    throw new Error(
      `Could not create the job: ${errors?.map((e) => e.message).join("; ") ?? "unknown error"}`
    );
  }
  return { jobId: created.id };
}

function assertJobCanBeScheduled(job: { status?: string | null }) {
  if (job.status === "COMPLETED") {
    throw new Error("A completed job stays on the record and cannot be rescheduled");
  }
  if (job.status === "IN_PROGRESS") {
    throw new Error("This job is in progress — call the technician instead of changing its route");
  }
}

/**
 * Narrow scheduling command surface. No caller can use it to write completion
 * or pesticide-record timestamps, and ASSIGN cannot store an ineligible tech.
 */
async function updateJobSchedule(args: Args) {
  const client = await dataClient();
  const { data: job } = await client.models.Job.get({ id: args.jobId! });
  if (!job) throw new Error(`Job ${args.jobId} not found`);
  const operation = args.operation?.trim().toUpperCase();

  if (operation === "ASSIGN") {
    assertJobCanBeScheduled(job);
    if (!args.technicianId || !args.routeId || !args.scheduledDate) {
      throw new Error("Assignment requires a technician, route, and service date");
    }
    const [{ data: technician }, { data: route }] = await Promise.all([
      client.models.Technician.get({ id: args.technicianId }),
      client.models.Route.get({ id: args.routeId }),
    ]);
    if (!technician) throw new Error(`Technician ${args.technicianId} not found`);
    assertTechnicianCompliance(technician, {
      requireActive: true,
      workDate: args.scheduledDate,
    });
    if (
      !route ||
      route.technicianId !== technician.id ||
      route.date !== args.scheduledDate
    ) {
      throw new Error("The selected route does not belong to that technician and date");
    }
    const { data, errors } = await client.models.Job.update({
      id: job.id,
      routeId: route.id,
      technicianId: technician.id,
      routeOrder: args.routeOrder ?? 1,
      scheduledDate: args.scheduledDate,
      status: "SCHEDULED",
      noAccessReason: null,
      noAccessAt: null,
      noAccessNote: null,
      noAccessPhotoKey: null,
    });
    if (!data) throw new Error(errors?.map((e) => e.message).join("; ") || "Could not assign job");
    return { jobId: data.id };
  }

  if (operation === "UNASSIGN") {
    assertJobCanBeScheduled(job);
    const { data, errors } = await client.models.Job.update({
      id: job.id,
      routeId: null,
      technicianId: null,
      routeOrder: null,
      status: "UNSCHEDULED",
    });
    if (!data) throw new Error(errors?.map((e) => e.message).join("; ") || "Could not unassign job");
    return { jobId: data.id };
  }

  if (operation === "REORDER") {
    assertJobCanBeScheduled(job);
    if (args.routeOrder == null || !args.otherJobId || args.otherRouteOrder == null) {
      throw new Error("Reordering requires both stops and their positions");
    }
    const { data: other } = await client.models.Job.get({ id: args.otherJobId });
    if (!other || !job.routeId || other.routeId !== job.routeId) {
      throw new Error("Stops can only be reordered on the same route");
    }
    assertJobCanBeScheduled(other);
    const [first, second] = await Promise.all([
      client.models.Job.update({ id: job.id, routeOrder: args.routeOrder }),
      client.models.Job.update({ id: other.id, routeOrder: args.otherRouteOrder }),
    ]);
    if (!first.data || !second.data) throw new Error("Could not reorder the route");
    return { jobId: job.id, otherJobId: other.id };
  }

  if (operation === "CANCEL") {
    assertJobCanBeScheduled(job);
    const { data, errors } = await client.models.Job.update({
      id: job.id,
      status: "CANCELED",
      routeId: null,
      technicianId: null,
      routeOrder: null,
    });
    if (!data) throw new Error(errors?.map((e) => e.message).join("; ") || "Could not cancel job");
    return { jobId: data.id };
  }

  if (operation === "RESCHEDULE") {
    assertJobCanBeScheduled(job);
    const date = args.scheduledDate || null;
    const dateChanged = date !== (job.scheduledDate ?? null);
    const { data, errors } = await client.models.Job.update({
      id: job.id,
      scheduledDate: date,
      timeWindow: args.timeWindow?.trim() || null,
      status: date ? "SCHEDULED" : "UNSCHEDULED",
      ...(dateChanged
        ? { routeId: null, technicianId: null, routeOrder: null }
        : {}),
    });
    if (!data) throw new Error(errors?.map((e) => e.message).join("; ") || "Could not reschedule job");
    return { jobId: data.id };
  }

  throw new Error(`Unknown scheduling operation: ${args.operation ?? ""}`);
}

/**
 * What has to be true before a service report becomes a pesticide record.
 *
 * Every one of these was a client-side check or nothing at all, which meant the
 * document BuzzKill hands an inspector could be finalized empty. Throwing here
 * is the whole point: the technician's app must ask for these before it lets
 * them send, and the server must not take its word for it.
 */
function assertReportIsARecord(
  report: {
    inspectionOnly?: boolean | null;
    productsUsed?: unknown;
    servicesPerformed?: string | null;
    reEntryIntervalHours?: number | null;
    geoLat?: number | null;
    geoLng?: number | null;
  },
  job: { status: string | null; startedAt?: string | null }
) {
  if (job.status === "CANCELED") {
    throw new Error(
      "This job was canceled — finalizing a report against it would resurrect it as completed"
    );
  }
  if (job.status === "NO_ACCESS") {
    throw new Error(
      "This job is marked as no access — a report would be a record of an application that did not happen"
    );
  }
  if (job.status === "SCHEDULED" && !job.startedAt) {
    throw new Error(
      "This job was never started — press Start job first, so the record carries the application's real start time, then complete the report"
    );
  }
  if (!report.servicesPerformed?.trim()) {
    throw new Error("Say what was done before sending the report");
  }
  if (report.geoLat == null || report.geoLng == null) {
    throw new Error("Capture the location on site before sending the report");
  }

  const products = parseProducts(report.productsUsed);

  if (report.inspectionOnly) {
    if (products.length) {
      throw new Error(
        "This is marked inspection-only but lists products applied — untick one or the other"
      );
    }
    return;
  }

  // Zero products used to finalize and email happily. A pesticide record with
  // no pesticide on it is either a false record or an inspection, and the
  // system should know which.
  if (!products.length) {
    throw new Error(
      "Add the products you applied, or tick “inspection only — no product applied”"
    );
  }
  for (const p of products) {
    const name = p.name?.trim();
    if (!name) throw new Error("A product row is missing its name");
    if (!p.epaNumber?.trim()) {
      throw new Error(`${name} needs its EPA registration number`);
    }
    if (!EPA_REGISTRATION_RE.test(p.epaNumber.trim())) {
      throw new Error(
        `“${p.epaNumber}” isn't a valid EPA registration number for ${name} — it looks like 432-1234`
      );
    }
    if (!p.quantity?.trim()) {
      throw new Error(`How much ${name} was applied?`);
    }
    if (!p.rate?.trim()) {
      throw new Error(`Record the label application rate or dilution for ${name}`);
    }
  }
  if (report.reEntryIntervalHours == null) {
    throw new Error(
      "Set the re-entry interval — the occupant has to be told when it is safe to go back in"
    );
  }
}

async function finalizeServiceReport(reportId: string) {
  const client = await dataClient();
  const { data: report } = await client.models.ServiceReport.get({
    id: reportId,
  });
  if (!report) throw new Error(`ServiceReport ${reportId} not found`);
  if (report.status === "FINALIZED" && report.pdfKey) {
    return { pdfKey: report.pdfKey, emailed: false, alreadyFinalized: true };
  }

  const [{ data: job }, { data: customer }, { data: technician }] =
    await Promise.all([
      client.models.Job.get({ id: report.jobId }),
      client.models.Customer.get({ id: report.customerId }),
      client.models.Technician.get({ id: report.technicianId }),
    ]);
  if (!job || !customer) throw new Error("Report is missing its job/customer");

  // The gate was in React only. finalizeServiceReport checked nothing — not
  // products, not an EPA number, not a quantity, not the job's state — so any
  // caller could finalize an empty report on any job and email it. The fryer's
  // timer belongs in the fryer.
  assertReportIsARecord(report, job);

  const serviceAddress = [
    customer.serviceStreet,
    customer.serviceCity,
    customer.serviceState,
    customer.serviceZip,
  ]
    .filter(Boolean)
    .join(", ");

  // The application's real start is when the technician pressed Start, not when
  // the draft was first saved — a report written up the next morning used to
  // carry the wrong date on a legal record, uncorrectably. Same for the end:
  // it is when the technician said they were done (endApplication), not when
  // finalize happened to run; the fallback covers only jobs with no stamp.
  const applicationStartIso = job.startedAt ?? report.serviceDate;
  const applicationEndIso = job.applicationEndAt ?? new Date().toISOString();
  assertTechnicianCompliance(technician ?? {}, {
    workDate: applicationStartIso.slice(0, 10),
  });

  const pdf = await renderServiceReportPdf({
    reportId,
    customerName: customer.displayName,
    serviceAddress: serviceAddress || undefined,
    serviceType: job.serviceType,
    serviceDateIso: report.serviceDate,
    technicianName: technician?.name ?? "BuzzKill Technician",
    technicianLicenseNumber: technician?.licenseNumber,
    applicationStartIso,
    applicationEndIso,
    reEntryIntervalHours: report.reEntryIntervalHours,
    inspectionOnly: report.inspectionOnly,
    servicesPerformed: report.servicesPerformed,
    productsUsed: parseProducts(report.productsUsed),
    targetPests: report.targetPests,
    areasTreated: report.areasTreated,
    recommendations: report.recommendations,
    geo:
      report.geoLat != null && report.geoLng != null
        ? {
            lat: report.geoLat,
            lng: report.geoLng,
            accuracyM: report.geoAccuracyM,
            capturedAtIso: report.geoCapturedAt,
          }
        : null,
  });

  const pdfKey = `reports/${report.customerId}/${reportId}.pdf`;
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET(),
      Key: pdfKey,
      Body: pdf,
      ContentType: "application/pdf",
    })
  );

  // If this visit was part of a plan, tell them when the next one lands.
  const { data: plan } = job.servicePlanId
    ? await client.models.ServicePlan.get({ id: job.servicePlanId })
    : { data: null };
  const nextIso =
    plan && plan.status === "ACTIVE"
      ? nextVisitDate(plan.serviceFrequency, new Date().toISOString())
      : null;
  const reviewUrl = process.env.GOOGLE_REVIEW_URL;

  let emailed = false;
  if (customer.email) {
    emailed = await sendEmail({
      to: customer.email,
      subject: `Service report — ${job.serviceType}`,
      template: "service-report",
      customerId: customer.id,
      relatedId: reportId,
      attachments: [
        {
          filename: "BuzzKill-Service-Report.pdf",
          content: pdf,
          contentType: "application/pdf",
        },
      ],
      html: emailShell(
        "Your service is complete",
        `<p>Hi ${customer.contactName ?? customer.displayName},</p>
         <p>${technician?.name ?? "Your technician"} completed your <strong>${job.serviceType}</strong> service. Your full service report is attached, and it's always available in your BuzzKill portal.</p>
         ${
           nextIso
             ? `<p><strong>Your next visit is planned for around ${prettyDate(nextIso)}</strong> — we'll confirm the exact time and send reminders as it gets closer.</p>`
             : ""
         }
         ${
           reviewUrl
             ? `<p style="margin:22px 0;"><a href="${reviewUrl}" style="background:#176b2c;color:#fff;padding:11px 20px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block;">How did we do? Leave a quick review</a></p>`
             : ""
         }
         <p style="color:#666;font-size:13px;">Questions about this visit? Just reply to this email.</p>`
      ),
    });
  }

  await client.models.ServiceReport.update({
    id: reportId,
    status: "FINALIZED",
    pdfKey,
    applicationStartAt: applicationStartIso,
    applicationEndAt: applicationEndIso,
    ...(emailed ? { emailedAt: new Date().toISOString() } : {}),
  });
  const completedAt = new Date().toISOString();
  await client.models.Job.update({
    id: report.jobId,
    status: "COMPLETED",
    completedAt,
    // Backfill when finalize supplied the fallback, so job and record agree.
    applicationEndAt: applicationEndIso,
  });
  await startBillingForPlan(job);
  await scheduleNextRecurringVisit({ ...job, completedAt });

  return { pdfKey, emailed, alreadyFinalized: false };
}

/**
 * Completing a recurring plan's visit starts its billing. This is the rule the
 * business already decided — "$99 at booking, monthly starts after the first
 * visit completes" — which until now existed only as a comment and a button
 * somebody had to remember to press. Every forgotten press was $1,188/yr.
 *
 * Idempotent via startPlanBilling, so the second and later visits of a plan
 * are a no-op rather than a second subscription.
 *
 * Never throws: the technician's visit really happened and the completion must
 * stand even if the customer has no card on file. A plan that could not start
 * stays ACTIVE with no stripeSubscriptionId, which the Dashboard's
 * "not billing" tile lists until someone clears it.
 */
async function startBillingForPlan(job: {
  id: string;
  customerId: string;
  type: string;
  servicePlanId?: string | null;
}) {
  if (job.type !== "RECURRING" || !job.servicePlanId) return;

  let reason: string;
  try {
    const outcome = await startPlanBilling(stripeClient(), job.servicePlanId);
    // A plan that was already running, or one deliberately canceled, is not a
    // problem anybody needs to hear about.
    if (outcome.started) return;
    if (outcome.reason === "PLAN_NOT_ACTIVE") return;
    reason = outcome.message;
    console.error("startPlanBilling did not start after job completion", {
      jobId: job.id,
      servicePlanId: job.servicePlanId,
      reason: outcome.reason,
      message: outcome.message,
    });
  } catch (err) {
    reason = err instanceof Error ? err.message : String(err);
    console.error("startPlanBilling threw after job completion", {
      jobId: job.id,
      servicePlanId: job.servicePlanId,
      err,
    });
  }

  // The visit happened and the completion stands — but this plan is now being
  // serviced for free. The Dashboard lists it; this makes sure someone is told
  // today rather than whenever they next open the Dashboard.
  const client = await dataClient();
  const [{ data: customer }, { data: plan }] = await Promise.all([
    client.models.Customer.get({ id: job.customerId }),
    client.models.ServicePlan.get({ id: job.servicePlanId }),
  ]);
  const price = plan?.priceCents ? `$${(plan.priceCents / 100).toFixed(2)}/mo` : "";
  await notifyOffice({
    subject: `ACTION REQUIRED — plan serviced but not billing: ${customer?.displayName ?? job.customerId}`,
    heading: "A plan was serviced but billing did not start",
    template: "ops-billing-start-failed",
    customerId: job.customerId,
    relatedId: job.servicePlanId,
    bodyHtml: `<p><strong>${customer?.displayName ?? "This customer"}</strong> has had their first visit on <strong>${plan?.planName ?? "their plan"}</strong>${price ? ` (${price})` : ""}, but the subscription did not start — so they are being serviced for free.</p>
       <p>Most often this means there is no payment method on file. Collect one on their customer record, then use <strong>Start billing</strong> on the plan.</p>
       <p>They also appear under <strong>Serviced but not billing</strong> on the Dashboard until this is resolved.</p>
       <p style="color:#666;font-size:13px;">Reason: ${reason}</p>`,
  });
}

/**
 * Office-side job completion without a field report (the exception path).
 * Marks the job COMPLETED, starts plan billing, and queues the next recurring
 * visit, mirroring what finalizeServiceReport does after a report.
 */
/**
 * The defined set of administrative job types the office may complete
 * WITHOUT a technician's finalized report — stored lowercased for a
 * case-insensitive match. Field and pesticide work is never here: its
 * completion IS the tech's finalized service report, which is the legal
 * pesticide application record. Office-completing such a job would mark it
 * done with no record behind it — the exact editable-regulatory-gap the
 * report immutability work closed, reopened from the office side.
 *
 * Empty today: no administrative job type is defined, so every job
 * completes via a finalized report. Add an exact (lowercased) serviceType
 * here to make that one type office-completable. KEEP IN SYNC with
 * apps/crm/src/lib/jobTypes.ts (the UI hides the button for the same set).
 */
export const ADMIN_JOB_SERVICE_TYPES = new Set<string>([]);

export function isOfficeCompletableServiceType(
  serviceType: string | null | undefined
): boolean {
  return ADMIN_JOB_SERVICE_TYPES.has((serviceType ?? "").trim().toLowerCase());
}

async function completeJob(jobId: string) {
  const client = await dataClient();
  const { data: job } = await client.models.Job.get({ id: jobId });
  if (!job) throw new Error(`Job ${jobId} not found`);
  if (job.status === "COMPLETED") {
    return { jobId, alreadyCompleted: true };
  }
  if (job.status !== "SCHEDULED" && job.status !== "IN_PROGRESS") {
    throw new Error(`Can't complete a ${job.status.toLowerCase()} job`);
  }
  // Field/pesticide work is completed by the technician's finalized report,
  // never from the office — that report is the legal application record.
  if (!isOfficeCompletableServiceType(job.serviceType)) {
    throw new Error(
      `"${job.serviceType}" is field work — it is completed by the technician's finalized service report (the legal pesticide record), not from the office. Only defined administrative job types can be office-completed.`
    );
  }
  const completedAt = new Date().toISOString();
  await client.models.Job.update({ id: jobId, status: "COMPLETED", completedAt });
  await startBillingForPlan(job);
  await scheduleNextRecurringVisit({ ...job, completedAt });
  return { jobId, alreadyCompleted: false };
}

/**
 * The technician pressed Start. startedAt is the application's start time on
 * the pesticide record, and it used to be a plain client-side Job.update —
 * any TECH token could write (or rewrite) it with whatever time the browser
 * supplied. The model is read-only for TECH now; this stamps the server's
 * clock, and a start that already happened cannot be moved.
 */
async function startJob(jobId: string) {
  const client = await dataClient();
  const { data: job } = await client.models.Job.get({ id: jobId });
  if (!job) throw new Error(`Job ${jobId} not found`);
  if (job.startedAt) {
    return { jobId, startedAt: job.startedAt, alreadyStarted: true };
  }
  if (job.status !== "SCHEDULED" && job.status !== "IN_PROGRESS") {
    throw new Error(`Can't start a ${job.status.toLowerCase()} job`);
  }
  if (!job.technicianId) {
    throw new Error("This regulated job has no assigned technician");
  }
  const { data: technician } = await client.models.Technician.get({
    id: job.technicianId,
  });
  if (!technician) throw new Error("The assigned technician record no longer exists");
  assertTechnicianCompliance(technician, { requireActive: true });
  const startedAt = new Date().toISOString();
  const { data: updated, errors } = await client.models.Job.update({
    id: jobId,
    status: "IN_PROGRESS",
    startedAt,
  });
  if (!updated) {
    throw new Error(
      `Could not start the job: ${errors?.map((e) => e.message).join("; ") ?? "unknown error"}`
    );
  }
  return { jobId, startedAt, alreadyStarted: false };
}

/**
 * The technician finished applying. Stamps the application's end with the
 * server's clock, once: the end used to be stamped at finalize, so a report
 * finalized the next morning carried the wrong end time on a legal record —
 * the same defect class as the start. The first stamp wins, which is what
 * makes a finalize that fails on site and is retried tomorrow keep today's
 * end rather than tomorrow's.
 */
async function endApplication(jobId: string) {
  const client = await dataClient();
  const { data: job } = await client.models.Job.get({ id: jobId });
  if (!job) throw new Error(`Job ${jobId} not found`);
  if (job.applicationEndAt) {
    return { jobId, applicationEndAt: job.applicationEndAt, alreadyEnded: true };
  }
  if (job.status === "SCHEDULED" && !job.startedAt) {
    throw new Error(
      "This job was never started — press Start job first, so the record carries the application's real start time"
    );
  }
  if (job.status === "CANCELED" || job.status === "NO_ACCESS") {
    throw new Error(
      `Can't end an application on a ${job.status.toLowerCase()} job — no application happened`
    );
  }
  const applicationEndAt = new Date().toISOString();
  const { data: updated, errors } = await client.models.Job.update({
    id: jobId,
    applicationEndAt,
  });
  if (!updated) {
    throw new Error(
      `Could not record the end of the application: ${errors?.map((e) => e.message).join("; ") ?? "unknown error"}`
    );
  }
  return { jobId, applicationEndAt, alreadyEnded: false };
}

const PHOTO_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
};

/**
 * Presigned PUT for a technician report photo. The key lives under
 * `reports/<customerId>/photos/<reportId>/…` so getDocumentUrl's existing
 * entitlement check covers viewing. The client PUTs the file, then appends
 * the key to the report's photoKeys.
 */
/**
 * Create or update a draft report, and refuse once it is finalized.
 *
 * The model is read-only from a browser, so this is the only way a report gets
 * written. The FINALIZED check is the point: the customer has a copy of that
 * PDF and an inspector may have another, and a record that can be edited after
 * issuance is worse evidence than no record at all.
 */
async function saveServiceReportDraft(
  actorSub: string | null,
  args: {
    jobId: string;
    reportId?: string | null;
    servicesPerformed?: string | null;
    productsUsed?: unknown;
    targetPests?: string | null;
    areasTreated?: string | null;
    recommendations?: string | null;
    techNotes?: string | null;
    reEntryIntervalHours?: number | null;
    inspectionOnly?: boolean | null;
    geoLat?: number | null;
    geoLng?: number | null;
    geoAccuracyM?: number | null;
    geoCapturedAt?: string | null;
  }
) {
  const client = await dataClient();
  const { data: job } = await client.models.Job.get({ id: args.jobId });
  if (!job) throw new Error(`Job ${args.jobId} not found`);

  const fields = {
    servicesPerformed: args.servicesPerformed ?? undefined,
    productsUsed: args.productsUsed ?? undefined,
    targetPests: args.targetPests ?? undefined,
    areasTreated: args.areasTreated ?? undefined,
    recommendations: args.recommendations ?? undefined,
    techNotes: args.techNotes ?? undefined,
    reEntryIntervalHours: args.reEntryIntervalHours ?? undefined,
    inspectionOnly: args.inspectionOnly ?? undefined,
    geoLat: args.geoLat ?? undefined,
    geoLng: args.geoLng ?? undefined,
    geoAccuracyM: args.geoAccuracyM ?? undefined,
    geoCapturedAt: args.geoCapturedAt ?? undefined,
  };

  if (args.reportId) {
    const { data: existing } = await client.models.ServiceReport.get({
      id: args.reportId,
    });
    if (!existing) throw new Error(`Report ${args.reportId} not found`);
    if (existing.status === "FINALIZED") {
      throw new Error(
        "This report has been finalized and sent to the customer — it is the record of the application and cannot be changed. Ask the office to issue an amendment."
      );
    }
    const { data: updated, errors } = await client.models.ServiceReport.update({
      id: args.reportId,
      ...fields,
    });
    if (!updated) {
      throw new Error(
        `Could not save the report: ${errors?.map((e) => e.message).join("; ") ?? "unknown error"}`
      );
    }
    return { reportId: updated.id, status: updated.status };
  }

  // Identity comes from the token, not the request: the technician on the
  // record is whoever is signed in.
  const { data: techs } = await client.models.Technician.list({ limit: 200 });
  const technician = techs.find((t) => t.userSub === actorSub);
  if (!technician) {
    throw new Error(
      "Your login isn't linked to a technician record — ask the office to link it before filing a report"
    );
  }
  const { data: customer } = await client.models.Customer.get({
    id: job.customerId,
  });

  const { data: created, errors } = await client.models.ServiceReport.create({
    jobId: job.id,
    customerId: job.customerId,
    technicianId: technician.id,
    serviceDate: new Date().toISOString(),
    status: "DRAFT",
    ...fields,
    accessGroups: customerAccessGroups(job.customerId, customer?.groupId),
  });
  if (!created) {
    throw new Error(
      `Could not start the report: ${errors?.map((e) => e.message).join("; ") ?? "unknown error"}`
    );
  }
  return { reportId: created.id, status: created.status };
}

/** Attach or remove report photos. Refuses once the report is FINALIZED. */
async function setReportPhotos(reportId: string, photoKeys: string[]) {
  const client = await dataClient();
  const { data: report } = await client.models.ServiceReport.get({ id: reportId });
  if (!report) throw new Error(`Report ${reportId} not found`);
  if (report.status === "FINALIZED") {
    throw new Error(
      "This report has been finalized — its photos are part of the record and cannot be changed"
    );
  }
  const { data: updated, errors } = await client.models.ServiceReport.update({
    id: reportId,
    photoKeys,
  });
  if (!updated) {
    throw new Error(
      `Could not update the photos: ${errors?.map((e) => e.message).join("; ") ?? "unknown error"}`
    );
  }
  return { reportId, photoKeys: updated.photoKeys };
}

const NO_ACCESS_LABEL: Record<string, string> = {
  NOBODY_HOME: "Nobody home",
  LOCKED_OUT: "Couldn't get in — locked gate or door",
  DOG_LOOSE: "Dog loose in the treatment area",
  REFUSED_ENTRY: "Customer refused entry",
  UNSAFE_CONDITIONS: "Unsafe conditions on site",
  WRONG_ADDRESS: "Address is wrong",
};

/**
 * The technician attended and could not do the work.
 *
 * Read the list of what this deliberately does not do: no ServiceReport (a
 * pesticide record for an application that never happened is a false legal
 * document), no COMPLETED status (which would arm the charge), and no call to
 * scheduleNextRecurringVisit (the cadence should not advance on a visit that
 * did not occur). It ends the job for today and tells the office.
 */
async function reportNoAccess(args: {
  jobId: string;
  reason: string;
  note?: string | null;
  photoKey?: string | null;
}) {
  const label = NO_ACCESS_LABEL[args.reason];
  if (!label) throw new Error(`Unknown no-access reason: ${args.reason}`);

  const client = await dataClient();
  const { data: job } = await client.models.Job.get({ id: args.jobId });
  if (!job) throw new Error(`Job ${args.jobId} not found`);
  if (job.status === "NO_ACCESS") {
    return { jobId: args.jobId, status: "NO_ACCESS", alreadyReported: true };
  }
  if (job.status === "COMPLETED") {
    throw new Error(
      "This job is already completed — if that was a mistake, tell the office rather than overwriting it"
    );
  }
  if (job.status === "CANCELED") {
    throw new Error("This job was canceled — nothing to report against it");
  }

  const nowIso = new Date().toISOString();
  const { data: updated, errors } = await client.models.Job.update({
    id: args.jobId,
    status: "NO_ACCESS",
    noAccessReason: args.reason as
      | "NOBODY_HOME"
      | "LOCKED_OUT"
      | "DOG_LOOSE"
      | "REFUSED_ENTRY"
      | "UNSAFE_CONDITIONS"
      | "WRONG_ADDRESS",
    noAccessAt: nowIso,
    noAccessNote: args.note?.trim() || undefined,
    noAccessPhotoKey: args.photoKey ?? undefined,
    // Off the route: the stop is done for today and the day's capacity is free.
    routeId: null,
    routeOrder: null,
  });
  if (!updated) {
    throw new Error(
      `Could not report no access: ${errors?.map((e) => e.message).join("; ") ?? "unknown error"}`
    );
  }

  const [{ data: customer }, { data: technician }] = await Promise.all([
    client.models.Customer.get({ id: job.customerId }),
    job.technicianId
      ? client.models.Technician.get({ id: job.technicianId })
      : Promise.resolve({ data: null }),
  ]);

  // The office owns what happens next: rebook, charge a no-access fee, or let
  // it go. None of those are the technician's call from a driveway.
  await notifyOffice({
    subject: `Couldn't access: ${customer?.displayName ?? job.customerId} — ${label}`,
    heading: "A technician couldn't do the job",
    template: "ops-no-access",
    customerId: job.customerId,
    relatedId: job.id,
    bodyHtml: `<p><strong>${technician?.name ?? "A technician"}</strong> attended <strong>${customer?.displayName ?? "this customer"}</strong> for ${job.serviceType}${job.scheduledDate ? ` on ${job.scheduledDate}` : ""} and couldn't do the work.</p>
       <p><strong>${label}</strong>${args.note?.trim() ? ` — ${args.note.trim()}` : ""}</p>
       <p>No service report was filed and nothing has been charged. The job is off the route and is waiting on a decision: rebook it, charge a no-access fee, or let it go.</p>
       <p style="margin:20px 0;"><a href="${CRM_URL()}/customers/${job.customerId}" style="background:#176b2c;color:#fff;padding:11px 20px;border-radius:8px;text-decoration:none;font-weight:600;">Open the customer</a></p>`,
  });

  return { jobId: args.jobId, status: "NO_ACCESS", alreadyReported: false };
}

/** Presigned PUT for the door photo. The job has no report to hang it off. */
async function getNoAccessPhotoUploadUrl(jobId: string, contentType: string) {
  const ext = PHOTO_TYPES[contentType.toLowerCase()];
  if (!ext) {
    throw new Error("Unsupported image type — use JPEG, PNG, WEBP, or HEIC");
  }
  const client = await dataClient();
  const { data: job } = await client.models.Job.get({ id: jobId });
  if (!job) throw new Error(`Job ${jobId} not found`);

  const key = `jobs/${job.customerId}/no-access/${jobId}/${Date.now()}-${randomBytes(4).toString("hex")}.${ext}`;
  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: BUCKET(), Key: key, ContentType: contentType }),
    { expiresIn: 900 }
  );
  return { uploadUrl, key };
}

async function getReportPhotoUploadUrl(reportId: string, contentType: string) {
  const ext = PHOTO_TYPES[contentType.toLowerCase()];
  if (!ext) {
    throw new Error("Unsupported image type — use JPEG, PNG, WEBP, or HEIC");
  }
  const client = await dataClient();
  const { data: report } = await client.models.ServiceReport.get({
    id: reportId,
  });
  if (!report) throw new Error(`Report ${reportId} not found`);
  if (report.status === "FINALIZED") {
    throw new Error("Report is finalized — photos can no longer be added");
  }
  const key = `reports/${report.customerId}/photos/${reportId}/${Date.now()}-${randomBytes(4).toString("hex")}.${ext}`;
  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: BUCKET(),
      Key: key,
      ContentType: contentType,
    }),
    { expiresIn: 900 }
  );
  return { key, uploadUrl, expiresInSeconds: 900 };
}

/**
 * Presign a document for viewing. Keys are always
 * `reports/<customerId>/...` or `agreements/<customerId>/...`; entitlement
 * is office/tech, the customer's own dynamic group, or their
 * customer-group.
 */
async function getDocumentUrl(key: string, groups: string[]) {
  const match = /^(reports|agreements)\/([^/]+)\//.exec(key);
  if (!match) throw new Error("Invalid document key");
  const customerId = match[2];

  const staff = isStaff(groups);
  if (!staff) {
    let allowed = groups.includes(cusGroup(customerId));
    if (!allowed) {
      const client = await dataClient();
      const { data: customer } = await client.models.Customer.get({
        id: customerId,
      });
      allowed = Boolean(
        customer?.groupId && groups.includes(grpGroup(customer.groupId))
      );
    }
    if (!allowed) throw new Error("Not authorized for this document");
  }

  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: BUCKET(), Key: key }),
    { expiresIn: 900 }
  );
  return { url, expiresInSeconds: 900 };
}
