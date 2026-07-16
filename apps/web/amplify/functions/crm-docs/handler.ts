import { randomBytes } from "node:crypto";
import type { AppSyncResolverEvent } from "aws-lambda";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { dataClient } from "../shared/dataClient";
import { opFieldName } from "../shared/opEvent";
import { callerGroups, callerIsOffice, isStaff } from "../shared/authz";
import { cusGroup, grpGroup } from "../shared/dynamicGroups";
import { emailShell, sendEmail } from "../shared/email";
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
  agreementId?: string;
  reportId?: string;
  jobId?: string;
  amountCents?: number;
  description?: string;
  key?: string;
  customerId?: string;
  kind?: string;
  note?: string;
  contentType?: string;
  templateId?: string;
};

export const handler = async (event: AppSyncResolverEvent<Args>) => {
  switch (opFieldName(event)) {
    case "sendAgreement": {
      if (!callerIsOffice(event.identity)) throw new Error("Office role required");
      return sendAgreement(event.arguments.agreementId!);
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
    case "getDocumentUrl": {
      return getDocumentUrl(event.arguments.key!, callerGroups(event.identity));
    }
    case "getTemplateImageUploadUrl": {
      if (!callerIsOffice(event.identity)) throw new Error("Office role required");
      return getTemplateImageUploadUrl(
        event.arguments.templateId!,
        event.arguments.contentType!
      );
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

/** Office-initiated transactional emails (payment request, portal reminder). */
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

async function sendAgreement(agreementId: string) {
  const client = await dataClient();
  const { data: agreement } = await client.models.Agreement.get({
    id: agreementId,
  });
  if (!agreement) throw new Error(`Agreement ${agreementId} not found`);
  if (agreement.status === "SIGNED") {
    throw new Error("Agreement is already signed");
  }
  const { data: customer } = await client.models.Customer.get({
    id: agreement.customerId,
  });
  if (!customer?.email) {
    throw new Error("Customer has no email address on file");
  }

  const signToken = agreement.signToken ?? randomBytes(24).toString("hex");
  await client.models.Agreement.update({
    id: agreementId,
    signToken,
    status: "SENT",
    sentAt: new Date().toISOString(),
  });

  const link = `${CRM_URL()}/sign/${signToken}`;
  const emailed = await sendEmail({
    to: customer.email,
    subject: `Your BuzzKill service agreement: ${agreement.title}`,
    template: "agreement-link",
    customerId: customer.id,
    relatedId: agreementId,
    html: emailShell(
      "Your service agreement is ready to sign",
      `<p>Hi ${customer.contactName ?? customer.displayName},</p>
       <p>Please review and electronically sign your service agreement, <strong>${agreement.title}</strong>.</p>
       <p style="margin:20px 0;"><a href="${link}" style="background:#176b2c;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600;">Review &amp; sign</a></p>
       <p style="color:#666;font-size:13px;">This link is unique to you — please don't forward it. Once signed, you'll receive a copy for your records.</p>`
    ),
  });

  return { sent: emailed, to: customer.email, link };
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

  const serviceAddress = [
    customer.serviceStreet,
    customer.serviceCity,
    customer.serviceState,
    customer.serviceZip,
  ]
    .filter(Boolean)
    .join(", ");

  const pdf = await renderServiceReportPdf({
    reportId,
    customerName: customer.displayName,
    serviceAddress: serviceAddress || undefined,
    serviceType: job.serviceType,
    serviceDateIso: report.serviceDate,
    technicianName: technician?.name ?? "BuzzKill Technician",
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
    ...(emailed ? { emailedAt: new Date().toISOString() } : {}),
  });
  const completedAt = new Date().toISOString();
  await client.models.Job.update({
    id: report.jobId,
    status: "COMPLETED",
    completedAt,
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
  type: string;
  servicePlanId?: string | null;
}) {
  if (job.type !== "RECURRING" || !job.servicePlanId) return;
  try {
    const outcome = await startPlanBilling(stripeClient(), job.servicePlanId);
    if (!outcome.started) {
      console.error("startPlanBilling did not start after job completion", {
        jobId: job.id,
        servicePlanId: job.servicePlanId,
        reason: outcome.reason,
        message: outcome.message,
      });
    }
  } catch (err) {
    console.error("startPlanBilling threw after job completion", {
      jobId: job.id,
      servicePlanId: job.servicePlanId,
      err,
    });
  }
}

/**
 * Office-side job completion without a field report (the exception path).
 * Marks the job COMPLETED, starts plan billing, and queues the next recurring
 * visit, mirroring what finalizeServiceReport does after a report.
 */
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
  const completedAt = new Date().toISOString();
  await client.models.Job.update({ id: jobId, status: "COMPLETED", completedAt });
  await startBillingForPlan(job);
  await scheduleNextRecurringVisit({ ...job, completedAt });
  return { jobId, alreadyCompleted: false };
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

// Template photos are embedded in PDFs (pdf-lib) — JPEG/PNG only.
const TEMPLATE_IMAGE_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
};

/** Presigned PUT for a plan-template pest photo (templates/<id>/…). */
async function getTemplateImageUploadUrl(templateId: string, contentType: string) {
  const ext = TEMPLATE_IMAGE_TYPES[contentType.toLowerCase()];
  if (!ext) {
    throw new Error("Unsupported image type — pest photos must be JPEG or PNG");
  }
  const client = await dataClient();
  const { data: template } = await client.models.PlanTemplate.get({
    id: templateId,
  });
  if (!template) throw new Error(`Template ${templateId} not found`);
  const key = `templates/${templateId}/${Date.now()}-${randomBytes(4).toString("hex")}.${ext}`;
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
 * `reports/<customerId>/...`, `agreements/<customerId>/...`, or
 * `templates/<templateId>/...` (staff-only); entitlement is office/tech,
 * the customer's own dynamic group, or their customer-group.
 */
async function getDocumentUrl(key: string, groups: string[]) {
  // Plan-template pest photos: staff only (signers get them via the
  // token-gated agreement-public endpoint; customers get the signed PDF).
  if (/^templates\/[^/]+\//.test(key)) {
    if (!isStaff(groups)) {
      throw new Error("Not authorized for this document");
    }
    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: BUCKET(), Key: key }),
      { expiresIn: 900 }
    );
    return { url, expiresInSeconds: 900 };
  }

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
