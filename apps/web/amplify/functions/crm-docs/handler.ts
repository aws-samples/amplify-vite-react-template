import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { AppSyncIdentity, AppSyncResolverEvent } from "aws-lambda";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  casTakeover,
  casFencedDelete,
  casGuardedUpdate,
} from "../shared/atomicLock";
import { dataClient } from "../shared/dataClient";
import {
  assertApplicationWithinLabel,
  assertDeliverableAddress,
  assertProductCanBeSaved,
  assertTechnicianCompliance,
  EPA_REGISTRATION_RE,
  hasCurrentLicense,
  parseLabelRules,
} from "../shared/compliance";
import { retryBookingFinalization } from "../shared/bookingFinalize";
import { opFieldName } from "../shared/opEvent";
import {
  callerEmail,
  callerGroups,
  callerIsFinance,
  callerIsOffice,
  callerIsOwner,
  callerName,
  callerSub,
} from "../shared/authz";
import { cusGroup, customerAccessGroups, grpGroup } from "../shared/dynamicGroups";
import {
  assertCanActOnJobId,
  assertCanActOnReportId,
  disposeStaleDrafts,
  technicianDocumentAllowed,
  technicianForCaller,
} from "../shared/jobAssignment";
import {
  buildTechnicianDay,
  buildTechnicianJob,
} from "../shared/technicianReads";
import { bookingLinkUrl, ensureBookingLinkToken } from "../shared/bookingLink";
import { drivingDistanceMetersFromPoint, HQ_ADDRESS } from "../shared/driveTime";
import { emailShell, notifyOffice, sendEmail } from "../shared/email";
import {
  nextVisitDate,
  prettyDate,
  scheduleNextRecurringVisit,
} from "../shared/recurring";
import {
  renderAmendmentPdf,
  renderServiceReportPdf,
  type AmendmentChange,
  type ReportProduct,
} from "../shared/pdf";
import { stripeClient } from "../shared/stripeClient";
import { startPlanBilling } from "../shared/subscription";
import {
  planCancellationSettled,
  resumePlanCancellation,
} from "../shared/planCancellation";
import { resumeVisitChange, STOPS_PER_TECH } from "../shared/visitChange";
import {
  dayEligibility,
  liveClaimsOn,
  makeLegResolver,
  notePoolMinutes,
  onsiteMinutes as slotOnsiteMinutes,
  jobScheduleGuards,
  releaseJobCapacity,
  releasePoolMinutes,
  releaseSlot,
  reserveSlot,
  slotStates,
  techBaseFor,
  windowOfTimeWindow,
  WINDOWS,
  WINDOW_MINUTES,
  type CapacityWindow,
} from "../shared/capacity";
import { queuePresenceReview } from "../shared/recovery";
import { licenseFactsFor, licenseRecordsFor, licenseValidOnDate } from "../shared/licenses";
import { isServiceMonth } from "../shared/season";
import {
  assertDispatchFacts,
  normalizePropertyClass,
  onsiteMinutesFor,
  proveRoutable,
} from "../shared/dispatchReadiness";
import {
  claimMonthForJob,
  releaseMonthForJob,
} from "../shared/obligations";
import { listAllLifecycleCommands } from "../shared/lifecycleCommand";
import {
  recordCallbackFinding,
  requestCallback,
  scheduleCallback,
} from "../shared/callbacks";
import {
  catalogEntry,
  entryForLabel,
  SERVICE_CATALOG_VERSION,
} from "../shared/serviceCatalog";
import { readOpsPause } from "../shared/opsPause";
import {
  defaultWorkOwner,
  openMissingContactWork,
  openOwnedWork,
  resolveOwnedWork,
  workItemId,
  type WorkOwnerTeam,
} from "../shared/ownedWork";
import {
  isValidManualReason,
  isVerifiable,
  verifiedResolution,
  workPolicy,
  type VerifierId,
} from "../shared/workPolicy";
import {
  assertLeadOutreachAllowed,
  logLeadTouch,
} from "../shared/leadLifecycle";
import { assertScheduleReason } from "../shared/visitChangeReasons";

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
  idempotencyKey?: string;
  notes?: string;
  contentType?: string;
  reason?: string;
  changes?: unknown;
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
  labelRulesJson?: unknown;
  active?: boolean;
  sortOrder?: number;
  servicePlanId?: string;
  serviceType?: string;
  priceCents?: number;
  scheduledDate?: string;
  timeWindow?: string;
  operation?: string;
  officeReason?: string;
  technicianId?: string;
  date?: string;
  routeId?: string;
  routeOrder?: number;
  otherJobId?: string;
  otherRouteOrder?: number;
  workItemId?: string;
  amendmentId?: string;
  action?: string;
  resolutionActionId?: string;
  reasonCode?: string;
  accessInstructions?: string;
  hazardNotes?: string;
  prepInstructions?: string;
  prepConfirmed?: boolean;
  paymentExpectation?: string;
  bookingRequestId?: string;
};

export const handler = async (event: AppSyncResolverEvent<Args>) => {
  switch (opFieldName(event)) {
    case "saveServiceReportDraft": {
      // Must own the job being reported on; editing an existing report is
      // additionally checked against that report inside the function.
      await assertCanActOnJobId(event.identity, event.arguments.jobId!);
      return saveServiceReportDraft(event.identity, {
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
      await assertCanActOnReportId(event.identity, event.arguments.reportId!);
      return setReportPhotos(
        event.arguments.reportId!,
        (event.arguments.photoKeys ?? []).filter(
          (k): k is string => typeof k === "string"
        )
      );
    }
    case "reportScopeMismatch": {
      await assertCanActOnJobId(event.identity, event.arguments.jobId!);
      await assertOfficeFieldAccess(
        event.identity,
        "reportScopeMismatch",
        event.arguments.jobId!,
        event.arguments.officeReason
      );
      return reportVisitNotPerformed("SCOPE_MISMATCH", {
        jobId: event.arguments.jobId!,
        reason: event.arguments.reason ?? "",
        note: event.arguments.note,
        photoKey: event.arguments.photoKey,
      });
    }
    case "reportPrepMissing": {
      await assertCanActOnJobId(event.identity, event.arguments.jobId!);
      await assertOfficeFieldAccess(
        event.identity,
        "reportPrepMissing",
        event.arguments.jobId!,
        event.arguments.officeReason
      );
      return reportVisitNotPerformed("PREP_MISSING", {
        jobId: event.arguments.jobId!,
        reason: event.arguments.reason ?? "",
        note: event.arguments.note,
        photoKey: event.arguments.photoKey,
      });
    }
    case "acknowledgePacket": {
      await assertCanActOnJobId(event.identity, event.arguments.jobId!);
      return acknowledgePacket(
        event.identity,
        event.arguments.jobId!,
        (event.arguments as { version?: number }).version ?? 0
      );
    }
    case "reportNoAccess": {
      await assertCanActOnJobId(event.identity, event.arguments.jobId!);
      await assertOfficeFieldAccess(
        event.identity,
        "reportNoAccess",
        event.arguments.jobId!,
        event.arguments.officeReason
      );
      return reportNoAccess({
        jobId: event.arguments.jobId!,
        reason: event.arguments.reason ?? "",
        note: event.arguments.note,
        photoKey: event.arguments.photoKey,
      });
    }
    case "getNoAccessPhotoUploadUrl": {
      await assertCanActOnJobId(event.identity, event.arguments.jobId!);
      await assertOfficeFieldAccess(
        event.identity,
        "getNoAccessPhotoUploadUrl",
        event.arguments.jobId!,
        event.arguments.officeReason
      );
      return getNoAccessPhotoUploadUrl(
        event.arguments.jobId!,
        event.arguments.contentType!
      );
    }
    case "startJob": {
      await assertCanActOnJobId(event.identity, event.arguments.jobId!);
      await assertOfficeFieldAccess(
        event.identity,
        "startJob",
        event.arguments.jobId!,
        event.arguments.officeReason
      );
      return startJob(event.arguments.jobId!);
    }
    case "endApplication": {
      await assertCanActOnJobId(event.identity, event.arguments.jobId!);
      await assertOfficeFieldAccess(
        event.identity,
        "endApplication",
        event.arguments.jobId!,
        event.arguments.officeReason
      );
      return endApplication(event.arguments.jobId!);
    }
    case "completeJob": {
      // Office-completable admin job types only (enforced in completeJob), but
      // it still ends a job and starts billing — prove assignment/office first
      // rather than leaving it open to any caller who knows the id.
      await assertCanActOnJobId(event.identity, event.arguments.jobId!);
      return completeJob(event.arguments.jobId!);
    }
    case "requestCallback": {
      // GL-10: a portal customer may request only for their OWN account (the
      // dynamic cus-<id> group proves it); the office may act for anyone.
      const cbArgs = event.arguments as unknown as {
        customerId?: string;
        originalJobId?: string;
        photoKey?: string;
        note?: string | null;
      };
      const cbCustomerId = String(cbArgs.customerId ?? "");
      const office = callerIsOffice(event.identity);
      if (
        !office &&
        !callerGroups(event.identity).includes(cusGroup(cbCustomerId))
      ) {
        throw new Error("You can only request a callback for your own account");
      }
      return requestCallback(
        {
          customerId: cbCustomerId,
          originalJobId: String(cbArgs.originalJobId ?? ""),
          photoKey: String(cbArgs.photoKey ?? ""),
          note: cbArgs.note,
        },
        { email: callerEmail(event.identity), isOffice: office }
      );
    }
    case "getCallbackPhotoUploadUrl": {
      const upArgs = event.arguments as unknown as {
        customerId?: string;
        contentType?: string;
      };
      const upCustomerId = String(upArgs.customerId ?? "");
      if (
        !callerIsOffice(event.identity) &&
        !callerGroups(event.identity).includes(cusGroup(upCustomerId))
      ) {
        throw new Error("You can only upload a photo for your own account");
      }
      return getCallbackPhotoUploadUrl(
        upCustomerId,
        String(upArgs.contentType ?? "")
      );
    }
    case "submitPortalRequest": {
      // GL-11: a portal customer may submit only for their OWN account; the
      // office may act for anyone.
      const prArgs = event.arguments as unknown as {
        customerId?: string;
        kind?: string;
        jobId?: string | null;
        preferredDate?: string | null;
        message?: string | null;
      };
      const prCustomerId = String(prArgs.customerId ?? "");
      if (
        !callerIsOffice(event.identity) &&
        !callerGroups(event.identity).includes(cusGroup(prCustomerId))
      ) {
        throw new Error("You can only submit a request for your own account");
      }
      return submitPortalRequest({
        customerId: prCustomerId,
        kind: String(prArgs.kind ?? ""),
        jobId: prArgs.jobId,
        preferredDate: prArgs.preferredDate,
        message: prArgs.message,
      });
    }
    case "resolvePortalRequest": {
      if (!callerIsOffice(event.identity)) throw new Error("Office role required");
      const rpArgs = event.arguments as unknown as {
        portalRequestId?: string;
        note?: string;
      };
      return resolvePortalRequest(
        String(rpArgs.portalRequestId ?? ""),
        String(rpArgs.note ?? ""),
        callerEmail(event.identity)
      );
    }
    case "scheduleCallback": {
      if (!callerIsOffice(event.identity)) throw new Error("Office role required");
      const scArgs = event.arguments as unknown as {
        callbackRequestId?: string;
        scheduledDate?: string;
        timeWindow?: string | null;
        technicianId?: string;
        customerRequestedLater?: boolean | null;
      };
      return scheduleCallback({
        callbackRequestId: String(scArgs.callbackRequestId ?? ""),
        scheduledDate: String(scArgs.scheduledDate ?? ""),
        timeWindow: scArgs.timeWindow,
        technicianId: String(scArgs.technicianId ?? ""),
        customerRequestedLater: scArgs.customerRequestedLater,
      });
    }
    case "recordCallbackFinding": {
      // GL-10: the office, or the technician actually assigned to the
      // callback visit — never an arbitrary tech with the id.
      const fArgs = event.arguments as unknown as {
        callbackRequestId?: string;
        finding?: string;
        note?: string;
        photoKey?: string | null;
      };
      const fId = String(fArgs.callbackRequestId ?? "");
      if (!callerIsOffice(event.identity)) {
        const { data: cbRow } = await (
          await dataClient()
        ).models.CallbackRequest.get({ id: fId });
        if (!cbRow?.callbackJobId) {
          throw new Error("This callback has no scheduled visit yet");
        }
        await assertCanActOnJobId(event.identity, cbRow.callbackJobId);
      }
      return recordCallbackFinding({
        callbackRequestId: fId,
        finding: String(fArgs.finding ?? ""),
        note: String(fArgs.note ?? ""),
        photoKey: fArgs.photoKey,
      });
    }
    case "finalizeServiceReport": {
      await assertCanActOnReportId(event.identity, event.arguments.reportId!);
      return finalizeServiceReport(event.arguments.reportId!);
    }
    case "amendServiceReport": {
      // The office issues amendments; a technician asks the office. No role
      // overwrites the issued record, so this only ever appends a new one.
      if (!callerIsOffice(event.identity)) throw new Error("Office role required");
      return amendServiceReport(event.arguments.reportId!, {
        reason: event.arguments.reason,
        changes: event.arguments.changes,
        authorSub: callerSub(event.identity),
        authorEmail: callerEmail(event.identity),
        authorName: callerName(event.identity),
      });
    }
    case "recordReportDelivery": {
      if (!callerIsOffice(event.identity)) throw new Error("Office role required");
      return recordReportDelivery({
        reportId: event.arguments.reportId,
        amendmentId: event.arguments.amendmentId,
        action: event.arguments.action!,
        note: event.arguments.note,
        actorEmail: callerEmail(event.identity),
      });
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
      // GL-13: the actor and controlled reason travel with the change into the
      // immutable assignment audit.
      if (!callerIsOffice(event.identity)) throw new Error("Office role required");
      return updateJobSchedule(event.identity, event.arguments);
    }
    case "updateJobPacket": {
      if (!callerIsOffice(event.identity)) throw new Error("Office role required");
      return updateJobPacket(event.identity, event.arguments);
    }
    case "rebookJob": {
      if (!callerIsOffice(event.identity)) throw new Error("Office role required");
      return rebookJob(
        event.arguments.jobId!,
        callerSub(event.identity),
        callerEmail(event.identity)
      );
    }
    case "retryBookingFinalization": {
      // Finance owns the PAID_NOT_FINALIZED exception this recovers, so finance
      // (as well as office) must be able to run it.
      if (!callerIsOffice(event.identity) && !callerIsFinance(event.identity)) {
        throw new Error("Office or finance role required");
      }
      return retryBookingFinalization(event.arguments.bookingRequestId!);
    }
    case "resumePlanCancellation": {
      // GL-08: the safe re-run the PLAN_CANCELLATION_RECOVERY case prescribes.
      // Finance owns cancellation recovery; office may also run it. auto:false —
      // a person pressing the button drives immediately (no attempt-cap pacing).
      if (!callerIsOffice(event.identity) && !callerIsFinance(event.identity)) {
        throw new Error("Office or finance role required");
      }
      return resumePlanCancellation(
        stripeClient(),
        event.arguments.servicePlanId!,
        { auto: false }
      );
    }
    case "resumeVisitChange": {
      // GL-07: the safe re-run the VISIT_CHANGE_RECOVERY case prescribes.
      if (!callerIsOffice(event.identity) && !callerIsFinance(event.identity)) {
        throw new Error("Office or finance role required");
      }
      return resumeVisitChange(stripeClient(), event.arguments.jobId!, {
        auto: false,
      });
    }
    case "recordNoticeAlternateDelivery": {
      if (!callerIsOffice(event.identity) && !callerIsFinance(event.identity)) {
        throw new Error("Office role required");
      }
      const altArgs = event.arguments as unknown as {
        relatedId?: string;
        template?: string;
        note?: string;
      };
      return recordNoticeAlternateDelivery(
        {
          relatedId: String(altArgs.relatedId ?? ""),
          template: String(altArgs.template ?? ""),
          note: String(altArgs.note ?? ""),
        },
        { sub: callerSub(event.identity), email: callerEmail(event.identity) }
      );
    }
    case "capacityDayFacts": {
      if (!callerIsOffice(event.identity) && !callerIsFinance(event.identity)) {
        throw new Error("Office role required");
      }
      const date = String(event.arguments.date ?? "");
      const [eligibility, slots, claims] = await Promise.all([
        dayEligibility(date),
        slotStates(date),
        liveClaimsOn(date),
      ]);
      const windowFacts = WINDOWS.map((window) => {
        const perTech = eligibility.techs.map((t) => {
          const state = slots.get(`${date}#${window}#${t.id}`);
          return {
            technicianId: t.id,
            technicianName: t.name,
            committedMinutes: state?.committedMinutes ?? 0,
            windowMinutes: WINDOW_MINUTES[window],
            verified: state?.verified !== false,
          };
        });
        const pool = slots.get(`${date}#${window}#POOL`);
        return {
          window,
          technicians: perTech,
          poolMinutes: pool?.committedMinutes ?? 0,
          sellable: perTech.some(
            (t) => t.verified && t.committedMinutes < t.windowMinutes
          ),
        };
      });
      return {
        date,
        eligibleTechs: eligibility.techs.length,
        windows: windowFacts,
        liveCheckoutClaims: claims.length,
        sellable: windowFacts.some((w) => w.sellable),
        reasons: eligibility.reasons,
      };
    }
    case "updateOwnedWork": {
      if (!callerIsOffice(event.identity) && !callerIsFinance(event.identity)) {
        throw new Error("Office or finance role required");
      }
      return updateOwnedWork({
        workItemId: event.arguments.workItemId!,
        action: event.arguments.action!,
        note: event.arguments.note,
        resolutionActionId: event.arguments.resolutionActionId ?? undefined,
        reasonCode: event.arguments.reasonCode ?? undefined,
        actorSub: callerSub(event.identity),
        actorEmail: callerEmail(event.identity),
        // GL-18: a free-text "manual override" close is limited to an owner. The
        // caller's role is read from the token here, never trusted from the args.
        actorIsOwner: callerIsOwner(event.identity),
        // GL-18 R10: money-verified closes are role-controlled — Finance (or an
        // owner), never any office login.
        actorIsFinance: callerIsFinance(event.identity),
      });
    }
    case "getDocumentUrl": {
      return getDocumentUrl(event.identity, event.arguments.key!);
    }
    // GL-13 row-scoping: the field app's only read surface. Each returns just
    // the caller's own authorized work — a technician cannot reach another
    // worker's day or job by id, because the model API no longer serves TECH.
    case "technicianDay": {
      return buildTechnicianDay(event.identity, {
        date: event.arguments.date,
        technicianId: event.arguments.technicianId,
      });
    }
    case "technicianJob": {
      return buildTechnicianJob(event.identity, event.arguments.jobId!);
    }
    case "getReportPhotoUploadUrl": {
      await assertCanActOnReportId(event.identity, event.arguments.reportId!);
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
        event.arguments.note ?? undefined,
        event.arguments.idempotencyKey!,
        { sub: callerSub(event.identity), email: callerEmail(event.identity) }
      );
    }
    default:
      throw new Error(`Unknown field ${opFieldName(event)}`);
  }
};

/**
 * GL-11 — a portal reschedule/help request: one durable case the customer
 * watches in the portal, one deduplicated owned item on the shared Office
 * queue (common one-business-day clock). Success is reported only after
 * BOTH exist — a failed submission surfaces to the customer to retry,
 * never a silent fallback to an untracked phone call.
 */
const PORTAL_REQUEST_KINDS = new Set(["RESCHEDULE", "HELP"]);
async function submitPortalRequest(opts: {
  customerId: string;
  kind: string;
  jobId?: string | null;
  preferredDate?: string | null;
  message?: string | null;
}): Promise<{ reference: string }> {
  if (!PORTAL_REQUEST_KINDS.has(opts.kind)) {
    throw new Error("Pick a request type");
  }
  const client = await dataClient();
  if (!("PortalRequest" in client.models)) {
    throw new Error("Requests are not available right now — call the office.");
  }
  const { data: customer } = await client.models.Customer.get({
    id: opts.customerId,
  });
  if (!customer) throw new Error("Customer not found");
  if (opts.kind === "RESCHEDULE") {
    if (!opts.jobId) throw new Error("Pick the visit to reschedule");
    const { data: job } = await client.models.Job.get({ id: opts.jobId });
    if (!job || job.customerId !== opts.customerId) {
      throw new Error("That visit doesn't belong to this account");
    }
    if (job.status !== "SCHEDULED" && job.status !== "UNSCHEDULED") {
      throw new Error("That visit can't be rescheduled — call the office and we'll help");
    }
  } else if (!opts.message?.trim()) {
    throw new Error("Tell us what you need help with");
  }
  // GL-11: the id is derived from WHAT was asked and WHEN (day) — a retry
  // of a failed submission converges onto the same row and the same owned
  // work item instead of minting duplicates, while a genuinely new request
  // on another day (or with different content) gets its own case.
  const requestFacts = [
    opts.customerId,
    opts.kind,
    opts.jobId ?? "",
    opts.preferredDate ?? "",
    opts.message?.trim() ?? "",
    new Date().toISOString().slice(0, 10),
  ].join("|");
  const id = `pr-${createHash("sha256").update(requestFacts).digest("hex").slice(0, 24)}`;
  const { data: created } = await client.models.PortalRequest.create({
    id,
    customerId: opts.customerId,
    kind: opts.kind,
    jobId: opts.jobId ?? undefined,
    preferredDate: opts.preferredDate ?? undefined,
    message: opts.message?.trim() || undefined,
    status: "OPEN",
    accessGroups: customerAccessGroups(
      opts.customerId,
      customer.groupId ?? undefined
    ),
  });
  if (!created) {
    // The same request already exists (a retry, or a double-tap): converge
    // onto it and RE-ENSURE its office ownership — a first submission that
    // crashed before reaching the queue becomes owned on the retry.
    const { data: existing } = await client.models.PortalRequest.get({ id });
    if (!existing) throw new Error("The request could not be saved — try again");
  }
  const opened = await openOwnedWork({
    kind: "CUSTOMER_REQUEST",
    dedupeKey: id,
    title:
      opts.kind === "RESCHEDULE"
        ? `Reschedule request: ${customer.displayName ?? opts.customerId}`
        : `Help request: ${customer.displayName ?? opts.customerId}`,
    detail:
      opts.kind === "RESCHEDULE"
        ? `The customer asked to reschedule visit ${opts.jobId}${opts.preferredDate ? ` (prefers ${opts.preferredDate})` : ""}${opts.message?.trim() ? ` — "${opts.message.trim()}"` : ""}. Answer within one business day; the customer watches request ${id} in the portal.`
        : `The customer asked for help: "${opts.message?.trim()}". Answer within one business day; the customer watches request ${id} in the portal.`,
    customerId: opts.customerId,
    relatedId: id,
    sourceUrl: `/customers/${opts.customerId}`,
    resolutionAction:
      "Handle the request with the customer, then resolve it WITH AN ANSWER from the customer screen (the portal shows your note).",
    ownerTeam: "OPS",
  });
  if (!opened) {
    // The case exists but the queue item does not — the promise would be
    // invisible to the office. Fail loudly so the customer retries (the
    // content-derived id means a retry converges, never duplicates). Only a
    // row THIS call minted is rolled back; a pre-existing row from an
    // earlier submission is never deleted by a later retry's queue fault.
    if (created) {
      await client.models.PortalRequest.delete({ id }).catch(() => undefined);
    }
    throw new Error(
      "The request couldn't reach the office queue — please try again, or call us. (Retrying is safe: it attaches to the same request.)"
    );
  }
  return { reference: id };
}

async function resolvePortalRequest(
  portalRequestId: string,
  note: string,
  actorEmail: string | null
): Promise<{ resolved: true }> {
  if (!note.trim()) throw new Error("Write the answer the customer will see");
  const client = await dataClient();
  const { data: pr } = await client.models.PortalRequest.get({
    id: portalRequestId,
  });
  if (!pr) throw new Error("Request not found");
  const { data: updated } = await client.models.PortalRequest.update({
    id: pr.id,
    status: "RESOLVED",
    resolutionNote: note.trim().slice(0, 1000),
    resolvedByEmail: actorEmail ?? "office",
    resolvedAt: new Date().toISOString(),
  });
  if (!updated) throw new Error("The request could not be resolved — try again");
  await resolveOwnedWork({
    kind: "CUSTOMER_REQUEST",
    dedupeKey: pr.id,
    note: `Resolved with the customer-visible answer: ${note.trim().slice(0, 300)}`,
  });
  const { data: customer } = await client.models.Customer.get({
    id: pr.customerId,
  });
  if (customer?.email) {
    await sendEmail({
      to: customer.email,
      subject: "Your request has been answered",
      template: "portal-request-resolved",
      customerId: pr.customerId,
      relatedId: pr.id,
      html: emailShell(
        "Your request has been answered",
        `<p>Hi ${customer.displayName ?? "there"},</p>
         <p>Your ${pr.kind === "RESCHEDULE" ? "reschedule" : "help"} request (${pr.id}) has been handled:</p>
         <p><strong>${note.trim()}</strong></p>
         <p style="color:#666;font-size:13px;">You can also see this in your portal. Anything else — just reply.</p>`
      ),
    }).catch(() => undefined);
  }
  return { resolved: true };
}

/** GL-10 — presigned PUT for the callback's REQUIRED customer photo. Keys
 *  land under callbacks/<customerId>/ so the existing document entitlements
 *  cover office viewing of the evidence. */
const callbackS3 = new S3Client();
async function getCallbackPhotoUploadUrl(
  customerId: string,
  contentType: string
): Promise<{ uploadUrl: string; key: string }> {
  if (!/^image\//.test(contentType)) {
    throw new Error("The callback photo must be an image");
  }
  const bucket = process.env.DOCS_BUCKET;
  if (!bucket) throw new Error("Document storage is not configured");
  const key = `callbacks/${customerId}/${randomUUID()}`;
  const uploadUrl = await getSignedUrl(
    callbackS3,
    new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }),
    { expiresIn: 300 }
  );
  return { uploadUrl, key };
}

/**
 * GL-18 — re-confirm a verified resolution's real-world outcome server-side, so
 * "close only from the verified event" is enforced by the data, not by trusting
 * a button. Returns why it is not yet true so the office gets the one next step.
 * Read-only and side-effect-free; the caller closes the item only on { ok }.
 */
/** GL-18 R1 — the exact per-visit money reconciliation shared by the
 *  paid-cancellation and visit-change verifiers. Every invoice on the visit
 *  must reach ONE durable disposition: fully refunded, voided, or the
 *  72-hour policy's RECORDED retained-fee outcome (the latest visit-change
 *  audit row saying FEE_RETAINED / no money owed). */
async function visitMoneySettled(
  jobId: string
): Promise<{ ok: true } | { ok: false; problem: string }> {
  const client = await dataClient();
  const { data: invoices } = await client.models.Invoice.list({
    filter: { jobId: { eq: jobId } },
    limit: 200,
  });
  const list = invoices ?? [];
  if (list.some((i) => i.status === "OPEN" && Boolean(i.stripePaymentIntentId))) {
    return {
      ok: false,
      problem: "A charge on this visit is still in flight — it can't be settled until the payment lands or fails.",
    };
  }
  if (list.some((i) => i.status === "OPEN" || i.status === "FAILED")) {
    return {
      ok: false,
      problem: "An open/unpaid invoice on this visit hasn't been voided.",
    };
  }
  const unsettledPaid = list.filter(
    (i) =>
      (i.status === "PAID" || i.status === "REFUNDED") &&
      (i.refundedAmountCents ?? 0) < (i.amountCents ?? 0)
  );
  if (unsettledPaid.length > 0) {
    // Money is still held. That is settled ONLY when the 72-hour policy's
    // retained-fee outcome is durably recorded on the change's audit ledger.
    let retainedRecorded = false;
    if ("VisitChangeEvent" in client.models) {
      const { data: events } = await client.models.VisitChangeEvent.list({
        filter: { jobId: { eq: jobId } },
        limit: 200,
      });
      const rows = (events ?? [])
        .slice()
        .sort((a, b) =>
          String(b.occurredAt ?? "").localeCompare(String(a.occurredAt ?? ""))
        );
      retainedRecorded = rows[0]?.disposition === "FEE_RETAINED";
    }
    if (!retainedRecorded) {
      return {
        ok: false,
        problem: `A paid invoice still holds $${(
          unsettledPaid.reduce(
            (t, i) =>
              t + Math.max(0, (i.amountCents ?? 0) - (i.refundedAmountCents ?? 0)),
            0
          ) / 100
        ).toFixed(2)} with no full refund and no recorded retained-fee outcome.`,
      };
    }
  }
  return { ok: true };
}

async function runWorkVerifier(
  verifier: VerifierId,
  item: {
    relatedId: string;
    customerId?: string | null;
    createdAt?: string | null;
  }
): Promise<{ ok: boolean; message: string }> {
  const client = await dataClient();
  switch (verifier) {
    case "CUSTOMER_HAS_EMAIL": {
      // GL-18 R2: merely ADDING an address never satisfies a promise to send
      // something. The case closes only when the customer has a working,
      // unsuppressed address AND a message to them was provider-accepted (or
      // delivered) AFTER this case opened — proof the missed notice went out.
      const id = item.customerId ?? item.relatedId;
      const { data: customer } = await client.models.Customer.get({ id });
      const email = customer?.email?.trim().toLowerCase();
      if (!email || !email.includes("@")) {
        return {
          ok: false,
          message:
            "Add a valid email to the customer record first, then re-send the missed message.",
        };
      }
      if ("SuppressedEmail" in client.models) {
        const { data: suppressed } = await client.models.SuppressedEmail.get({
          email,
        }).catch(() => ({ data: null }));
        if (suppressed) {
          return {
            ok: false,
            message: `${email} is suppressed (${suppressed.source ?? "bounce/complaint"}). Lift the suppression (with the customer's consent) or record a different address, then re-send.`,
          };
        }
      }
      if ("EmailLog" in client.models) {
        const since = item.createdAt ?? "";
        let sentSince = false;
        let token: string | null | undefined;
        let scanned = 0;
        do {
          const page = await client.models.EmailLog.list({
            filter: { customerId: { eq: id } },
            limit: 200,
            nextToken: token,
          });
          sentSince = (page.data ?? []).some(
            (l) =>
              (l.deliveryStatus === "SENT" || l.deliveryStatus === "DELIVERED") &&
              String(l.createdAt ?? "") >= since
          );
          scanned += (page.data ?? []).length;
          token = sentSince ? null : page.nextToken;
        } while (token && scanned < 1000);
        if (!sentSince) {
          return {
            ok: false,
            message:
              "The address is on file, but no message to this customer has gone out since this case opened — re-send the missed notice (the origin record's resend/resume action), then confirm.",
          };
        }
      }
      return { ok: true, message: "" };
    }
    case "JOB_STAFFED": {
      // "Staffed" is verified against the dispatch facts, not the presence of
      // an ID (GL-13/GL-18): a real, active, currently-licensed technician,
      // and a route that agrees with the assignment and date.
      const { data: job } = await client.models.Job.get({ id: item.relatedId });
      if (
        !job?.technicianId ||
        (job.status !== "SCHEDULED" && job.status !== "IN_PROGRESS")
      ) {
        return {
          ok: false,
          message:
            "Assign a technician and put the visit on the schedule first — then confirm it's staffed.",
        };
      }
      const { data: tech } = await client.models.Technician.get({
        id: job.technicianId,
      });
      if (
        !tech?.active ||
        !(await licenseFactsFor(tech, job.scheduledDate ?? undefined)).current
      ) {
        return {
          ok: false,
          message:
            "The assigned technician must be active with a current licence on the service date — reassign the visit, then confirm.",
        };
      }
      // Working availability: Mon–Fri is the operating week (GL-18 R3). PTO,
      // holiday, and closure calendars land with GL-04's capacity model and
      // will join this check there.
      if (job.scheduledDate) {
        const dow = new Date(`${job.scheduledDate}T00:00:00Z`).getUTCDay();
        if (dow === 0 || dow === 6) {
          return {
            ok: false,
            message:
              "The visit is dated on a weekend — technicians work Monday–Friday. Reschedule it to a weekday, then confirm.",
          };
        }
      }
      if (job.routeId) {
        const { data: route } = await client.models.Route.get({
          id: job.routeId,
        });
        if (
          !route ||
          route.technicianId !== job.technicianId ||
          route.date !== job.scheduledDate
        ) {
          return {
            ok: false,
            message:
              "The visit's route and its assigned technician/date disagree — fix the assignment on the Schedule board, then confirm.",
          };
        }
        // Route capacity: the day must actually hold this stop.
        let stops = 0;
        let token: string | null | undefined;
        do {
          const page = await client.models.Job.list({
            filter: { routeId: { eq: job.routeId } },
            limit: 200,
            nextToken: token,
          });
          stops += (page.data ?? []).filter(
            (j) => j.status !== "CANCELED"
          ).length;
          token = page.nextToken;
        } while (token);
        if (stops > STOPS_PER_TECH) {
          return {
            ok: false,
            message: `That route holds ${stops} stops — more than the ${STOPS_PER_TECH}-stop day. Move a stop off it, then confirm.`,
          };
        }
      } else if (job.status === "SCHEDULED") {
        return {
          ok: false,
          message:
            "A scheduled visit needs a route — assign it on the Schedule board, then confirm.",
        };
      }
      return { ok: true, message: "" };
    }
    case "VISIT_MONEY_SETTLED": {
      // GL-18 R1: EXACT reconciliation. Canceling the visit alone never proves
      // the money settled; a partial refund never settles a full amount; every
      // invoice on the visit reaches ONE durable disposition — fully refunded,
      // voided, or the 72-hour policy's recorded retained-fee outcome.
      const money = await visitMoneySettled(item.relatedId);
      return {
        ok: money.ok,
        message: money.ok
          ? ""
          : `${money.problem} Settle it in the billing tools (or resume the visit change), then confirm.`,
      };
    }
    case "VISIT_CHANGE_SETTLED": {
      // GL-18 R6: a visit-change case closes only when EVERYTHING agrees —
      // money exactly reconciled, the schedule fact terminal, the customer's
      // notice provider-accepted, and the immutable audit row present.
      const { data: job } = await client.models.Job.get({ id: item.relatedId });
      if (!job) return { ok: false, message: "The visit could not be read." };
      const money = await visitMoneySettled(item.relatedId);
      if (!money.ok) {
        return {
          ok: false,
          message: `${money.problem} Resume the visit change to finish it, then confirm.`,
        };
      }
      let auditExists = false;
      if ("VisitChangeEvent" in client.models) {
        const { data: events } = await client.models.VisitChangeEvent.list({
          filter: { jobId: { eq: item.relatedId } },
          limit: 200,
        });
        auditExists = (events ?? []).length > 0;
      }
      if (!auditExists) {
        return {
          ok: false,
          message:
            "The change's immutable audit row is missing — Resume the visit change (it re-records the audit), then confirm.",
        };
      }
      let noticeAccepted = false;
      if ("EmailLog" in client.models) {
        const { data: logs } = await client.models.EmailLog.listEmailLogByRelatedId(
          { relatedId: item.relatedId },
          { limit: 50 }
        );
        noticeAccepted = (logs ?? []).some(
          (l) =>
            (l.template === "visit-canceled" ||
              l.template === "visit-rescheduled") &&
            (l.deliveryStatus === "SENT" || l.deliveryStatus === "DELIVERED")
        );
      }
      if (!noticeAccepted) {
        const { data: cust } = await client.models.Customer.get({
          id: job.customerId,
        });
        if (cust?.email?.trim()) {
          return {
            ok: false,
            message:
              "The customer's change notice hasn't gone out — Resume the visit change (it re-sends or adopts the notice), then confirm.",
          };
        }
        // No email on file: the MISSING_CONTACT case owns the alternate path.
      }
      return { ok: true, message: "" };
    }
    case "LIFECYCLE_SETTLED": {
      // GL-09/X2: a lifecycle-recovery case closes only when the customer's
      // provider billing, CRM plans, status, access, and command state all
      // AGREE — portal-only or audit-only repair cannot turn a mixed customer
      // green.
      const { data: cust } = await client.models.Customer.get({
        id: item.customerId ?? item.relatedId,
      });
      if (!cust) return { ok: false, message: "The customer could not be read." };
      const problems: string[] = [];
      let planToken: string | null | undefined;
      do {
        const page = await client.models.ServicePlan.list({
          filter: { customerId: { eq: cust.id } },
          limit: 200,
          nextToken: planToken,
        });
        for (const plan of page.data ?? []) {
          if (cust.status === "INACTIVE" && plan.status === "ACTIVE") {
            problems.push(`plan ${plan.planName} is still ACTIVE`);
          }
        }
        planToken = page.nextToken;
      } while (planToken);
      if (cust.status === "INACTIVE") {
        let jobToken: string | null | undefined;
        do {
          const page = await client.models.Job.list({
            filter: { customerId: { eq: cust.id } },
            limit: 200,
            nextToken: jobToken,
          });
          for (const job of page.data ?? []) {
            if (job.status === "SCHEDULED" && !job.paidAt) {
              problems.push(`visit ${job.id} is still scheduled`);
            }
          }
          jobToken = page.nextToken;
        } while (jobToken);
      }
      if ("CustomerLifecycleCommand" in client.models) {
        // Paginated to exhaustion — a settled verdict computed over one page
        // can hide the non-settled command it exists to catch.
        const cmds = await listAllLifecycleCommands(
          client as unknown as { models: Record<string, unknown> },
          cust.id
        );
        const unfinished = cmds.filter(
          (c) => c.stage !== "COMPLETE" && c.stage !== "FAILED"
        );
        if (unfinished.length) {
          problems.push(
            `${unfinished.length} lifecycle command(s) not terminal (${unfinished.map((c) => c.stage).join(", ")})`
          );
        }
      }
      if (problems.length) {
        return {
          ok: false,
          message: `Not settled yet: ${problems.join("; ")}. Re-run the transition from the customer screen, then confirm.`,
        };
      }
      return { ok: true, message: "" };
    }
    case "TECH_LICENSED": {
      // GL-17: closable only when the technician holds a CURRENT unexpired
      // licence record, OR is inactive with no future assigned work.
      const { data: tech } = await client.models.Technician.get({
        id: item.relatedId,
      });
      if (!tech) {
        return { ok: false, message: "The technician record could not be read." };
      }
      const facts = await licenseFactsFor(tech);
      if (facts.current) return { ok: true, message: "" };
      if (!tech.active) {
        const today = new Date().toISOString().slice(0, 10);
        let hasFuture = false;
        let token: string | null | undefined;
        do {
          const page = await client.models.Job.list({
            filter: { technicianId: { eq: tech.id } },
            limit: 200,
            nextToken: token,
          });
          hasFuture = (page.data ?? []).some(
            (j) => j.status === "SCHEDULED" && (j.scheduledDate ?? "") >= today
          );
          token = hasFuture ? null : page.nextToken;
        } while (token);
        if (!hasFuture) return { ok: true, message: "" };
        return {
          ok: false,
          message:
            "The technician is inactive but still has future assigned visits — reassign them first.",
        };
      }
      return {
        ok: false,
        message:
          "Record a current licence for this technician (or offboard them and reassign their work) — then confirm.",
      };
    }
    case "DISPATCH_READY": {
      // GL-12: re-run the pure dispatch facts + staffing agreement for the
      // visit. Green only when it would actually pass the gate today.
      const { data: job } = await client.models.Job.get({ id: item.relatedId });
      if (!job) return { ok: false, message: "The visit could not be read." };
      if (
        job.status === "CANCELED" ||
        job.status === "COMPLETED" ||
        job.status === "NO_ACCESS" ||
        job.status === "SCOPE_MISMATCH" ||
        job.status === "PREP_MISSING"
      ) {
        return { ok: true, message: "" };
      }
      const { data: cust } = await client.models.Customer.get({
        id: job.customerId,
      });
      if (!cust) return { ok: false, message: "The customer could not be read." };
      try {
        assertDispatchFacts(cust, {
          propertyClass: job.propertyClass,
          serviceType: job.serviceType,
        });
      } catch (err) {
        return {
          ok: false,
          message: err instanceof Error ? err.message : "Not dispatch-ready.",
        };
      }
      return { ok: true, message: "" };
    }
    case "PLAN_CANCELLATION_SETTLED": {
      // GL-08 R4: the same settlement check the auto-resolve uses, so the case
      // can't close until billing is inactive, the plan is canceled, every
      // cancelable visit is off the schedule, no charge is in flight, and every
      // charge that posted after the accepted cancellation is refunded.
      // GL-08 R3: the verified close proves settlement against the PROVIDER
      // too — crm-docs holds the billing key, so the check fails closed only
      // when Stripe genuinely can't confirm the subscription stopped.
      const result = await planCancellationSettled(item.relatedId, {
        stripe: stripeClient(),
      });
      return { ok: result.settled, message: result.reason };
    }
    default:
      return { ok: false, message: "This exception has no automatic check." };
  }
}

export async function updateOwnedWork(args: {
  workItemId: string;
  action: string;
  note?: string;
  /** GL-18: which controlled resolution the caller chose (a verified id). */
  resolutionActionId?: string;
  /** GL-18: the controlled reason for an owner manual override. */
  reasonCode?: string;
  actorSub: string | null;
  actorEmail: string | null;
  /** True only for an OWNER token — gates the manual-override close. */
  actorIsOwner?: boolean;
  /** True for a FINANCE token — money-verified closes are Finance/Owner only. */
  actorIsFinance?: boolean;
  /**
   * Set by trusted server callers (e.g. rebookJob) that have already carried out
   * the verified real-world event, so the close records as verified without a
   * human owner/override. Never set from a browser argument.
   */
  verified?: boolean;
}) {
  const client = await dataClient();
  const { data: item } = await client.models.WorkItem.get({ id: args.workItemId });
  if (!item) throw new Error("Work item not found");
  const actorEmail = args.actorEmail ?? args.actorSub ?? "unknown staff";
  const now = new Date().toISOString();

  if (args.action === "CLAIM") {
    if (item.status !== "OPEN") throw new Error("Resolved work cannot be claimed");
    if (item.ownerSub && item.ownerSub === args.actorSub) {
      // Idempotent: already the claimer.
      return { workItemId: item.id, status: "OPEN", ownerEmail: actorEmail };
    }
    // GL-18 R11: ONE winner. The claim is a single guarded write conditioned on
    // the item still being OPEN and UNCLAIMED — two concurrent claimers cannot
    // both own it, and a claim can never silently steal an already-claimed
    // case (release or an owner reassign first).
    const guarded = await casGuardedUpdate(
      "WorkItem",
      item.id,
      { ownerSub: args.actorSub ?? actorEmail, ownerEmail: actorEmail },
      [
        { kind: "fieldEquals", field: "status", value: "OPEN" },
        { kind: "fieldMissingOrNull", field: "ownerSub" },
      ]
    );
    if (!guarded.ok && guarded.reason === "LOST") {
      throw new Error(
        item.ownerSub
          ? `This case is already claimed by ${item.ownerEmail}. Ask them to release it, or an owner to reassign it.`
          : "Someone else claimed this case just now — refresh the queue."
      );
    }
    if (!guarded.ok) {
      // UNSUPPORTED (no CAS wiring): the pre-checked plain write, with the
      // steal refusal enforced from the read above.
      if (item.ownerSub) {
        throw new Error(
          `This case is already claimed by ${item.ownerEmail}. Ask them to release it, or an owner to reassign it.`
        );
      }
      const claimed = await client.models.WorkItem.update({
        id: item.id,
        ownerSub: args.actorSub ?? undefined,
        ownerEmail: actorEmail,
      });
      if (!claimed.data) {
        throw new Error(
          claimed.errors?.map((error) => error.message).join("; ") ||
            "Could not claim work"
        );
      }
    }
    const claimEvent = await client.models.WorkEvent.create({
      workItemId: item.id,
      eventType: "CLAIMED",
      actorSub: args.actorSub ?? undefined,
      actorEmail,
      note: args.note?.trim() || "Claimed responsibility for this work.",
      occurredAt: now,
    });
    if (!claimEvent.data) {
      // Keep the queue honest: without history, the ownership change did not
      // happen. Roll it back (guarded — never clobber a NEWER claim) so the
      // user can retry the whole action.
      await casGuardedUpdate(
        "WorkItem",
        item.id,
        { ownerSub: item.ownerSub ?? null, ownerEmail: item.ownerEmail },
        [
          {
            kind: "fieldEquals",
            field: "ownerSub",
            value: args.actorSub ?? actorEmail,
          },
        ]
      );
      throw new Error(
        claimEvent.errors?.map((error) => error.message).join("; ") ||
          "Could not record ownership history"
      );
    }
    return { workItemId: item.id, status: "OPEN", ownerEmail: actorEmail };
  }

  if (args.action === "RELEASE") {
    // GL-18 R9: a routine employee can hand a claimed case back to the shared
    // queue (or an owner can release anyone's) — completing ordinary work
    // never depends on the original claimer or an OWNER close.
    if (item.status !== "OPEN") throw new Error("Resolved work cannot be released");
    if (!item.ownerSub) {
      return { workItemId: item.id, status: "OPEN", ownerEmail: item.ownerEmail };
    }
    if (item.ownerSub !== args.actorSub && !args.actorIsOwner) {
      throw new Error(
        `Only ${item.ownerEmail} (or an owner) can release this case.`
      );
    }
    // History BEFORE the ownership move (the offboarding sweep's rule), then
    // ONE guarded write conditioned on the owner being unchanged — a release
    // can never clobber a newer claim.
    const releaseEvent = await client.models.WorkEvent.create({
      workItemId: item.id,
      eventType: "RELEASED",
      actorSub: args.actorSub ?? undefined,
      actorEmail,
      note: args.note?.trim() || "Returned to the shared team queue.",
      occurredAt: now,
    });
    if (!releaseEvent.data) {
      throw new Error("Could not record the release history — try again.");
    }
    const team = (item.ownerTeam as WorkOwnerTeam) ?? "OPS";
    const released = await casGuardedUpdate(
      "WorkItem",
      item.id,
      { ownerSub: null, ownerEmail: defaultWorkOwner(team) },
      [{ kind: "fieldEquals", field: "ownerSub", value: item.ownerSub }]
    );
    if (!released.ok && released.reason === "UNSUPPORTED") {
      await client.models.WorkItem.update({
        id: item.id,
        ownerSub: null,
        ownerEmail: defaultWorkOwner(team),
      });
    }
    return {
      workItemId: item.id,
      status: "OPEN",
      ownerEmail: defaultWorkOwner(team),
    };
  }

  if (args.action === "RESOLVE") {
    if (item.status === "RESOLVED") {
      return { workItemId: item.id, status: "RESOLVED", alreadyResolved: true };
    }
    const kind = item.kind ?? "";
    const policy = workPolicy(kind);
    const note = args.note?.trim();

    // Path 1 — a trusted server caller (e.g. rebookJob) has already carried out
    // the verified real-world event. It closes as a verified resolution with no
    // owner/override needed. Never reachable from a browser argument.
    if (args.verified) {
      return closeResolvedWorkItem({
        item,
        actorSub: args.actorSub,
        actorEmail,
        now,
        note: note || "Closed by a verified system action.",
        eventType: "RESOLVED",
        kind,
        relatedId: item.relatedId,
      });
    }

    // Path 2 — a routine OFFICE/FINANCE user runs an in-place verified close.
    // The server re-checks the real-world outcome; the item closes only if true.
    const chosen = args.resolutionActionId
      ? verifiedResolution(kind, args.resolutionActionId)
      : null;
    if (chosen) {
      // GL-18 R10: money authority is role-controlled — the money-settlement
      // verified closes require FINANCE (or an owner); any other office user
      // is told who can run it instead of being able to settle money.
      const MONEY_VERIFIERS: VerifierId[] = [
        "VISIT_MONEY_SETTLED",
        "PLAN_CANCELLATION_SETTLED",
        "VISIT_CHANGE_SETTLED",
      ];
      if (
        MONEY_VERIFIERS.includes(chosen.verifier) &&
        !args.actorIsOwner &&
        !args.actorIsFinance
      ) {
        throw new Error(
          "Confirming a money settlement needs the Finance role (or an owner) — ask Finance to run this close."
        );
      }
      const check = await runWorkVerifier(chosen.verifier, item);
      if (!check.ok) {
        throw new Error(`This isn't done yet, so it can't be closed. ${check.message}`);
      }
      return closeResolvedWorkItem({
        item,
        actorSub: args.actorSub,
        actorEmail,
        now,
        note: note || `${chosen.label} — confirmed.`,
        eventType: "RESOLVED",
        kind,
        relatedId: item.relatedId,
      });
    }

    // Path 3 — a manual override: no verified outcome, so this is a manager
    // decision. Owner only, a controlled reason, evidence, and recorded as a
    // separately-reportable MANUAL_OVERRIDE (GL-18 / X2). A routine user is
    // steered to the verified action instead of being able to close by note.
    if (!args.actorIsOwner) {
      if (policy && isVerifiable(kind)) {
        const how =
          policy.externalAction?.label ??
          policy.verified[0]?.label ??
          "its verified action";
        throw new Error(
          `Close this by running "${how}" so the outcome is verified. To close it any other way, an owner must record a manual override.`
        );
      }
      throw new Error(
        "Only an owner can close this. It has no automatic check, so closing it is a manager decision recorded as a manual override with a reason and evidence."
      );
    }
    const reasonCode = args.reasonCode?.trim();
    if (!reasonCode) {
      throw new Error("Choose a reason for this manual override before closing it.");
    }
    if (policy && !isValidManualReason(kind, reasonCode)) {
      throw new Error("That reason isn't one of the allowed reasons for this exception.");
    }
    if (!note) {
      throw new Error("Add a short note of evidence for this manual override.");
    }
    return closeResolvedWorkItem({
      item,
      actorSub: args.actorSub,
      actorEmail,
      now,
      note,
      eventType: "MANUAL_OVERRIDE",
      manualOverride: true,
      reasonCode,
      kind,
      relatedId: item.relatedId,
    });
  }

  throw new Error("Unknown work action — use CLAIM or RESOLVE");
}

/**
 * Flip a WorkItem RESOLVED and append its immutable close event, with the same
 * fail-safe the queue has always had: a resolution the ledger did not record is
 * reopened so the action stays visible and can be retried. eventType is RESOLVED
 * for a verified close and MANUAL_OVERRIDE for an owner override (which also
 * stamps resolvedManualOverride/resolvedReason so overrides can be reported on
 * their own).
 */
async function closeResolvedWorkItem(input: {
  item: {
    id: string;
    ownerSub?: string | null;
    ownerEmail: string;
  };
  actorSub: string | null;
  actorEmail: string;
  now: string;
  note: string;
  eventType: "RESOLVED" | "MANUAL_OVERRIDE";
  manualOverride?: boolean;
  reasonCode?: string;
  kind?: string | null;
  relatedId?: string | null;
}) {
  const client = await dataClient();
  const { item, actorSub, actorEmail, now, note } = input;
  // GL-18 R11: ONE winner completes a case. The terminal write is guarded on
  // the item not already being RESOLVED, so two employees who both passed the
  // OPEN check cannot both close it (and both run the money action it gates).
  const guarded = await casGuardedUpdate(
    "WorkItem",
    item.id,
    {
      status: "RESOLVED",
      ownerSub: actorSub ?? item.ownerSub ?? null,
      ownerEmail: actorEmail,
      resolvedAt: now,
      resolvedBySub: actorSub ?? null,
      resolvedByEmail: actorEmail,
      resolutionNote: note,
      resolvedManualOverride: input.manualOverride ?? false,
      resolvedReason: input.reasonCode ?? null,
    },
    [{ kind: "fieldNotIn", field: "status", values: ["RESOLVED"] }]
  );
  if (!guarded.ok && guarded.reason === "LOST") {
    return { workItemId: item.id, status: "RESOLVED", alreadyResolved: true };
  }
  if (!guarded.ok) {
    const resolved = await client.models.WorkItem.update({
      id: item.id,
      status: "RESOLVED",
      ownerSub: actorSub ?? item.ownerSub ?? undefined,
      ownerEmail: actorEmail,
      resolvedAt: now,
      resolvedBySub: actorSub ?? undefined,
      resolvedByEmail: actorEmail,
      resolutionNote: note,
      resolvedManualOverride: input.manualOverride ?? false,
      resolvedReason: input.reasonCode ?? null,
    });
    if (!resolved.data) {
      throw new Error(
        resolved.errors?.map((error) => error.message).join("; ") ||
          "Could not resolve work"
      );
    }
  }
  const resolutionEvent = await client.models.WorkEvent.create({
    workItemId: item.id,
    eventType: input.eventType,
    actorSub: actorSub ?? undefined,
    actorEmail,
    note,
    occurredAt: now,
  });
  if (!resolutionEvent.data) {
    // Reopen ONLY our own resolution (guarded on resolvedByEmail) — a rollback
    // must never clobber a concurrent winner's completed close.
    await casGuardedUpdate(
      "WorkItem",
      item.id,
      {
        status: "OPEN",
        ownerSub: item.ownerSub ?? null,
        ownerEmail: item.ownerEmail,
        resolvedAt: null,
        resolvedBySub: null,
        resolvedByEmail: null,
        resolutionNote: null,
        resolvedManualOverride: null,
        resolvedReason: null,
      },
      [{ kind: "fieldEquals", field: "resolvedByEmail", value: actorEmail }]
    );
    throw new Error(
      resolutionEvent.errors?.map((error) => error.message).join("; ") ||
        "Could not record resolution history"
    );
  }
  // GL-15: resolving a presence-review case settles the durable obligation on
  // the report itself, so a resumed finalize / the daily sweep stop re-opening
  // it. Best-effort — the resolved case is already the authoritative history.
  if (
    input.kind === "LOCATION_REVIEW" &&
    input.relatedId &&
    "ServiceReport" in client.models
  ) {
    await client.models.ServiceReport.update({
      id: input.relatedId,
      presenceReviewStatus: "RESOLVED",
    }).catch(() => undefined);
  }
  return {
    workItemId: item.id,
    status: "RESOLVED",
    manualOverride: Boolean(input.manualOverride),
  };
}

/** Office-initiated transactional emails (payment request, portal reminder,
 *  booking link — the lead's one conversion path). */
async function sendCustomerEmail(
  customerId: string,
  kind: string,
  note?: string,
  idempotencyKey?: string,
  actor: { sub: string | null; email: string | null } = { sub: null, email: null }
) {
  if (!idempotencyKey?.trim()) throw new Error("An idempotency key is required.");
  const client = await dataClient();
  const { data: customer } = await client.models.Customer.get({
    id: customerId,
  });
  if (!customer?.email) {
    if (customer) {
      await openMissingContactWork({
        customerId,
        displayName: customer.displayName,
        context: `The office tried to send the ${kind} message.`,
      });
    }
    throw new Error("Customer has no email address on file");
  }
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
      <p style="margin:20px 0;"><a href="${CRM_URL()}/portal/billing" style="background:#176b2c;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600;">Add payment method</a></p>
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
    //
    // The link carries this lead's identity (?lead=<token>) so the paid
    // booking converts exactly this record — not whatever email matching
    // guesses. Minted on first send; a mint failure still sends the bare
    // link (email matching remains the fallback).
    const token = await ensureBookingLinkToken(client, {
      id: customer.id,
      bookingLinkToken: customer.bookingLinkToken,
    });
    const funnelUrl = bookingLinkUrl(FUNNEL_URL(), token);
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

  const isLead = customer.status === "LEAD";
  const leadChannel = kind === "booking-link" ? "BOOKING_LINK" : "EMAIL";
  if (isLead) {
    await assertLeadOutreachAllowed(
      customer as unknown as Record<string, unknown>,
      leadChannel
    );
  }

  const sent = await sendEmail({
    to: customer.email,
    subject,
    template: kind,
    customerId,
    html: emailShell(heading, body),
  });

  // GL-02: record provider acceptance as an attempted lead touch. It does not
  // claim customer delivery; only a delivery event advances Booking-sent.
  if (isLead) {
    await logLeadTouch({
      customerId,
      channel: leadChannel,
      direction: "OUTBOUND",
      outcome: sent ? "SENT" : "FAILED",
      note: `${kind} email`,
      idempotencyKey: `office-email:${idempotencyKey.trim()}`,
    }, actor);
  }

  return { sent, to: customer.email };
}

/**
 * GL-15 — the office's controlled delivery actions for a finalized report or
 * amendment. ALTERNATE records an approved alternate delivery (mail/hand-off,
 * note required) — the resolution path for NO_EMAIL/BOUNCED; RESEND clears the
 * failed state and re-runs the normal idempotent delivery (finalize /
 * amendment resume paths), which adopts any proven prior send instead of
 * duplicating. Both re-read the persisted record and return the VERIFIED new
 * state.
 */
async function recordReportDelivery(input: {
  reportId?: string | null;
  amendmentId?: string | null;
  action: string;
  note?: string | null;
  actorEmail: string | null;
}) {
  const action = input.action.trim().toUpperCase();
  if (action !== "ALTERNATE" && action !== "RESEND") {
    throw new Error("Unknown delivery action — use RESEND or ALTERNATE");
  }
  const client = await dataClient();
  const isAmendment = Boolean(input.amendmentId);
  const id = (input.amendmentId ?? input.reportId)?.trim();
  if (!id) throw new Error("A report or amendment is required");

  if (action === "ALTERNATE") {
    const note = input.note?.trim();
    if (!note) {
      throw new Error(
        "Say how the document was delivered (mailed, handed to the customer…) — the record needs the method."
      );
    }
    if (isAmendment) {
      const { data } = await client.models.ServiceReportAmendment.update({
        id,
        deliveryStatus: "ALTERNATE_DELIVERED",
      });
      if (!data) throw new Error("Could not record the alternate delivery");
    } else {
      const { data } = await client.models.ServiceReport.update({
        id,
        deliveryStatus: "ALTERNATE_DELIVERED",
        emailedAt: new Date().toISOString(),
      });
      if (!data) throw new Error("Could not record the alternate delivery");
    }
    await resolveOwnedWork({
      kind: isAmendment ? "MISSING_CONTACT" : "MISSING_CONTACT",
      dedupeKey: isAmendment
        ? `report-amendment-delivery:${id}`
        : `service-report-delivery:${id}`,
      note: `Alternate delivery recorded by ${input.actorEmail ?? "office"}: ${note}`,
    });
    await resolveOwnedWork({
      kind: "EMAIL_FAILURE",
      dedupeKey: isAmendment
        ? `report-amendment-delivery:${id}`
        : `service-report-delivery:${id}`,
      note: `Alternate delivery recorded by ${input.actorEmail ?? "office"}: ${note}`,
    });
    // Verified readback — the screen shows the persisted state.
    const { data: verify } = isAmendment
      ? await client.models.ServiceReportAmendment.get({ id })
      : await client.models.ServiceReport.get({ id });
    return {
      id,
      deliveryStatus: verify?.deliveryStatus ?? "ALTERNATE_DELIVERED",
      recorded: verify?.deliveryStatus === "ALTERNATE_DELIVERED",
    };
  }

  // RESEND: clear the failed/bounced state so the idempotent delivery path
  // re-attempts (it adopts a proven prior send from the EmailLog rather than
  // duplicating). For a report, re-run the finalize resume; the amendment
  // resume runs through amendServiceReport with the same request.
  if (isAmendment) {
    const { data } = await client.models.ServiceReportAmendment.update({
      id,
      deliveryStatus: "FAILED",
      emailedAt: null,
    });
    if (!data) throw new Error("Could not queue the resend");
    return {
      id,
      deliveryStatus: "FAILED",
      recorded: true,
      nextStep:
        "Re-issue the same amendment from the report screen — the resume sends only what never went out.",
    };
  }
  const { data: report } = await client.models.ServiceReport.get({ id });
  if (!report || report.status !== "FINALIZED") {
    throw new Error("Only a finalized report's delivery can be re-run");
  }
  const { data } = await client.models.ServiceReport.update({
    id,
    deliveryStatus: "FAILED",
    emailedAt: null,
  });
  if (!data) throw new Error("Could not queue the resend");
  const result = await finalizeServiceReport(id);
  return {
    id,
    deliveryStatus: (result as { deliveryStatus?: string }).deliveryStatus ?? null,
    recorded: true,
  };
}

async function saveProduct(args: Args) {
  const name = args.name?.trim() ?? "";
  if (!name) throw new Error("Product name is required");
  // GL-15: structured label rules, validated for shape before they become the
  // authority finalization fails closed against.
  let labelRulesJson: string | null = null;
  if (args.labelRulesJson != null && args.labelRulesJson !== "") {
    const rules = parseLabelRules(args.labelRulesJson);
    if (!rules) {
      throw new Error(
        "The label rules could not be read — they must be valid JSON (allowedServiceTypes, allowedPests, quantity {min,max,unit}, rates, minReEntryHours)."
      );
    }
    if (
      rules.quantity &&
      (!Number.isFinite(rules.quantity.min) ||
        !Number.isFinite(rules.quantity.max) ||
        rules.quantity.min > rules.quantity.max ||
        !rules.quantity.unit?.trim())
    ) {
      throw new Error(
        "The label quantity rule needs a numeric min ≤ max and a unit (e.g. oz)."
      );
    }
    labelRulesJson = JSON.stringify(rules);
  }
  const fields = {
    name,
    epaNumber: args.epaNumber?.trim() || null,
    activeIngredient: args.activeIngredient?.trim() || null,
    defaultQuantity: args.defaultQuantity?.trim() || null,
    defaultRate: args.defaultRate?.trim() || null,
    reEntryHours: args.reEntryHours ?? null,
    labelApproved: args.labelApproved ?? false,
    targetPests: args.targetPests?.trim() || null,
    labelRulesJson,
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

/** GL-12: only the two approved technician-facing payment postures. Anything
 *  else (blank, a stray string) resolves to DUE_THROUGH_OFFICE — the safe
 *  default that still means "collect nothing in the field". */
function normalizePaymentExpectation(
  value: string | null | undefined
): "COLLECT_NOTHING" | "DUE_THROUGH_OFFICE" | undefined {
  const v = value?.trim().toUpperCase();
  if (v === "COLLECT_NOTHING") return "COLLECT_NOTHING";
  if (v === "DUE_THROUGH_OFFICE") return "DUE_THROUGH_OFFICE";
  return undefined;
}

/** The job-specific dispatch-packet fields, normalized from raw mutation args. */
function packetFields(args: Args) {
  return {
    accessInstructions: args.accessInstructions?.trim() || undefined,
    hazardNotes: args.hazardNotes?.trim() || undefined,
    prepInstructions: args.prepInstructions?.trim() || undefined,
    prepConfirmed:
      typeof args.prepConfirmed === "boolean" ? args.prepConfirmed : undefined,
    paymentExpectation: normalizePaymentExpectation(args.paymentExpectation),
  };
}

/** Jobs created by the office always start unassigned. */
async function createOfficeJob(args: Args) {
  const customerId = args.customerId?.trim() ?? "";
  let serviceType = args.serviceType?.trim() ?? "";
  if (!customerId) throw new Error("Customer is required");
  if (!serviceType) throw new Error("Service type is required");

  const client = await dataClient();
  const { data: customer } = await client.models.Customer.get({ id: customerId });
  if (!customer) throw new Error(`Customer ${customerId} not found`);

  // GL-01: every office visit is a CONTROLLED catalog selection — free text
  // cannot invent a service. "NOT_IN_CATALOG" routes the request to an owned
  // catalog decision (add it / map it / decline it) and creates NO job; an
  // unrecognized legacy string is refused the same way rather than silently
  // becoming work the business cannot price, staff, or document.
  const requestedCode = (args as { serviceCode?: string | null }).serviceCode?.trim();
  if (requestedCode === "NOT_IN_CATALOG") {
    await openOwnedWork({
      kind: "SERVICE_CATALOG_DECISION",
      dedupeKey: `catalog:${customerId}:${serviceType.toLowerCase()}`,
      title: `Catalog decision needed: "${serviceType}"`,
      detail: `The office asked to schedule "${serviceType}" for ${customer.displayName ?? customerId}, which is not a catalog service. No job was created. Decide within one business day: add it to the catalog (engineering change), map it to an existing service and schedule that, or decline and tell the customer.`,
      customerId,
      relatedId: customerId,
      sourceUrl: `/customers/${customerId}`,
      resolutionAction:
        "Decide the catalog question, then either create the job under the right catalog service or tell the customer we don't offer it.",
      ownerTeam: "OPS",
    });
    return {
      catalogDecisionOpened: true,
      message:
        "That service isn't in the catalog. The request is now an owned catalog decision (one business day) — no job was created.",
    };
  }
  const catalogService = requestedCode
    ? catalogEntry(requestedCode)
    : entryForLabel(serviceType);
  if (requestedCode && !catalogService) {
    throw new Error(
      `Unknown catalog service "${requestedCode}" — pick a service from the catalog, or use "Something else…" to request a catalog decision.`
    );
  }
  if (!catalogService) {
    throw new Error(
      `"${serviceType}" doesn't match a catalog service. Pick one from the list, or use "Something else…" to request a catalog decision — jobs are never created outside the catalog.`
    );
  }
  // The stored label is the catalog's canonical root unless a more specific
  // catalog-derived label was passed (funnel labels carry size/nest facts).
  if (requestedCode) serviceType = catalogService.label;
  // A job created with a service date is already dispatch-bound — it lands
  // SCHEDULED and shows up on the board to be routed. Hold it to the same
  // dispatch facts as assignment (routable MA/RI address, no placeholders,
  // explicit property classification), so the gap can never be created in the
  // first place. A date-less job (scheduled later) is allowed through;
  // updateJobSchedule enforces the full gate before it can reach a technician.
  if (args.scheduledDate) {
    // GL-22: a dispatch pause also stops NEW dated visits from being minted.
    const pause = await readOpsPause();
    if (pause.dispatchPaused) {
      throw new Error(
        `Dispatch is paused by an incident owner${pause.reason ? ` (${pause.reason})` : ""} — create the job without a date, or wait for the pause to lift.`
      );
    }
    assertDispatchFacts(customer, {
      propertyClass: (args as { propertyClass?: string | null }).propertyClass,
      serviceType,
    });
  }
  let seasonalClaim: {
    servicePlanId: string;
    monthKey: string;
    jobId: string;
  } | null = null;
  if (args.servicePlanId) {
    const { data: plan } = await client.models.ServicePlan.get({
      id: args.servicePlanId,
    });
    if (!plan || plan.customerId !== customerId) {
      throw new Error("That service plan does not belong to this customer");
    }
    // GL-17: a seasonal plan's visit may only land in an in-season month, and
    // never a second visit in a month whose treatment already happened — there
    // is no free-text bypass around the seasonal promise.
    if (plan.seasonal && args.scheduledDate) {
      const monthKey = args.scheduledDate.slice(0, 7);
      if (!isServiceMonth(plan, monthKey)) {
        throw new Error(
          "This plan's treatments run April–October. Pick an in-season month — November–March has no routine treatment (the plan still bills monthly year-round)."
        );
      }
      // Claim the month ATOMICALLY with a pre-minted job id — the obligation
      // row is the mutex, so two concurrent creates cannot both land a visit
      // in one month (checking only SATISFIED would allow two SCHEDULED).
      seasonalClaim = {
        servicePlanId: plan.id,
        monthKey,
        jobId: randomUUID(),
      };
      const monthClaim = await claimMonthForJob({
        ...seasonalClaim,
        customerId,
      });
      if (!monthClaim.ok) {
        throw new Error(
          monthClaim.unavailable
            ? "The seasonal-month ledger can't be verified right now — nothing was changed. Try again in a moment."
            : monthClaim.status === "SATISFIED"
              ? `This plan's ${monthKey} treatment already happened — a seasonal plan gets exactly one treatment per month. Pick the next month instead.`
              : `This plan already has its ${monthKey} visit scheduled — a seasonal plan gets exactly one treatment per month. Pick a different month, or reschedule the existing visit.`
        );
      }
    }
  }

  const { data: created, errors } = await client.models.Job.create({
    ...(seasonalClaim ? { id: seasonalClaim.jobId } : {}),
    customerId,
    servicePlanId: args.servicePlanId || undefined,
    type: args.servicePlanId ? "RECURRING" : "ONE_TIME",
    serviceType,
    // GL-01: the immutable catalog reference this visit was created under.
    serviceCode: catalogService.id,
    catalogVersion: SERVICE_CATALOG_VERSION,
    priceCents: args.priceCents ?? undefined,
    status: args.scheduledDate ? "SCHEDULED" : "UNSCHEDULED",
    scheduledDate: args.scheduledDate || undefined,
    timeWindow: args.timeWindow?.trim() || undefined,
    // GL-04: pool facts are STAMPED at birth so the one canonical release
    // path can give exactly these minutes back exactly once.
    ...(args.scheduledDate
      ? {
          capacityWindow: windowOfTimeWindow(args.timeWindow ?? null),
          capacityMinutes: slotOnsiteMinutes(
            normalizePropertyClass(
              (args as { propertyClass?: string | null }).propertyClass
            )
          ),
        }
      : {}),
    ...packetFields(args),
    propertyClass:
      normalizePropertyClass(
        (args as { propertyClass?: string | null }).propertyClass
      ) ?? undefined,
    packetVersion: 1,
    accessGroups: customerAccessGroups(customerId, customer.groupId),
  });
  if (!created) {
    // The month claim must not outlive a job that was never born.
    if (seasonalClaim) await releaseMonthForJob(seasonalClaim);
    throw new Error(
      `Could not create the job: ${errors?.map((e) => e.message).join("; ") ?? "unknown error"}`
    );
  }
  // GL-04: a dated office-created visit shows on the POOL accounting slot
  // until its real technician-window claim happens at assignment.
  if (args.scheduledDate) {
    await notePoolMinutes(
      args.scheduledDate,
      windowOfTimeWindow(args.timeWindow ?? null),
      slotOnsiteMinutes(
        normalizePropertyClass(
          (args as { propertyClass?: string | null }).propertyClass
        )
      )
    ).catch(() => undefined);
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
  // A no-access or canceled visit is a terminal record: its reason, time,
  // note, and door photo are evidence that the attempt happened. Reusing the
  // row (assign flipping it back to SCHEDULED) destroys that record. Rebooking
  // is a new, linked visit — see rebookJob — never a mutation of this one.
  if (
    job.status === "NO_ACCESS" ||
    job.status === "SCOPE_MISMATCH" ||
    job.status === "PREP_MISSING" ||
    job.status === "CANCELED"
  ) {
    throw new Error(
      "This visit reached a terminal outcome and cannot be reused — rebook it to create a new linked visit"
    );
  }
}

/**
 * GL-13 — write one immutable assignment-audit row. Returns whether the row
 * durably persisted (data read back non-null); a false is a real gap the
 * caller must surface, never hide.
 */
async function recordAssignmentEvent(input: {
  jobId: string;
  customerId?: string | null;
  action: string;
  actor: { sub: string | null; email: string | null };
  reasonCode?: string | null;
  reason?: string | null;
  priorTechnicianId?: string | null;
  newTechnicianId?: string | null;
  priorRouteId?: string | null;
  newRouteId?: string | null;
  priorScheduledDate?: string | null;
  newScheduledDate?: string | null;
  draftDisposition?: string | null;
  effects?: string | null;
  outcome: string;
}): Promise<boolean> {
  try {
    const client = await dataClient();
    if (!("JobAssignmentEvent" in client.models)) return false;
    const { data } = await client.models.JobAssignmentEvent.create({
      jobId: input.jobId,
      customerId: input.customerId ?? undefined,
      action: input.action,
      actorSub: input.actor.sub ?? undefined,
      actorEmail: input.actor.email ?? "system",
      reasonCode: input.reasonCode ?? undefined,
      reason: input.reason ?? undefined,
      priorTechnicianId: input.priorTechnicianId ?? undefined,
      newTechnicianId: input.newTechnicianId ?? undefined,
      priorRouteId: input.priorRouteId ?? undefined,
      newRouteId: input.newRouteId ?? undefined,
      priorScheduledDate: input.priorScheduledDate ?? undefined,
      newScheduledDate: input.newScheduledDate ?? undefined,
      draftDisposition: input.draftDisposition ?? undefined,
      effects: input.effects ?? undefined,
      outcome: input.outcome,
      occurredAt: new Date().toISOString(),
    });
    return Boolean(data);
  } catch (err) {
    console.error("recordAssignmentEvent failed", input.jobId, input.action, err);
    return false;
  }
}

/**
 * GL-13 — office/owner emergency use of a technician field action. The
 * assigned technician (an owner who is also the linked tech) passes untouched;
 * any other office caller must carry a reason, the use is written to the
 * immutable assignment ledger BEFORE the action runs (fail-closed: no record,
 * no action), and a routine review case is opened. Emergency access can
 * therefore never be silent — and the action itself still records under the
 * signed-in identity, never the applicator's.
 */
async function assertOfficeFieldAccess(
  identity: AppSyncIdentity | undefined | null,
  action: string,
  jobId: string,
  officeReason?: string | null
): Promise<void> {
  if (!callerIsOffice(identity)) return;
  const client = await dataClient();
  const { data: job } = await client.models.Job.get({ id: jobId });
  const tech = await technicianForCaller(identity);
  if (tech && job?.technicianId === tech.id) return;
  const reason = officeReason?.trim();
  if (!reason) {
    throw new Error(
      "Doing a technician's field action from the office needs a short reason — it is recorded and reviewed. Add the reason and try again."
    );
  }
  const recorded = await recordAssignmentEvent({
    jobId,
    customerId: job?.customerId ?? null,
    action: "OFFICE_FIELD_ACTION",
    actor: { sub: callerSub(identity), email: callerEmail(identity) },
    reason: `${action}: ${reason}`,
    priorTechnicianId: job?.technicianId ?? null,
    newTechnicianId: job?.technicianId ?? null,
    effects: `Office performed ${action} on the visit with a recorded reason.`,
    outcome: "RECORDED",
  });
  if (!recorded) {
    throw new Error(
      "Could not record the office field-action audit — nothing was done. Try again."
    );
  }
  await openOwnedWork({
    kind: "OFFICE_FIELD_REVIEW",
    dedupeKey: `office-field:${jobId}:${new Date().toISOString().slice(0, 10)}`,
    title: "Office field action needs review",
    detail: `${callerEmail(identity) ?? "An office member"} performed ${action} on visit ${jobId}: ${reason}`,
    relatedId: jobId,
    sourceUrl: "/work",
    resolutionAction:
      "Review the recorded reason and close with the matching review outcome.",
    ownerTeam: "OPS",
  });
}

/**
 * Narrow scheduling command surface. No caller can use it to write completion
 * or pesticide-record timestamps, and ASSIGN cannot store an ineligible tech.
 * Every operation that moves the assignment or date carries a controlled
 * reason and lands one immutable audit row with the actor, former/new
 * technician and route, effective time, any stale-draft disposition, and the
 * result (GL-13).
 */
async function updateJobSchedule(
  identity: AppSyncIdentity | undefined | null,
  args: Args
) {
  const client = await dataClient();
  const { data: job } = await client.models.Job.get({ id: args.jobId! });
  if (!job) throw new Error(`Job ${args.jobId} not found`);
  const operation = args.operation?.trim().toUpperCase();
  // GL-22: while dispatch is paused, NEW assignments are refused honestly.
  // Cancels/unassigns still work — containment must be able to pull work.
  if (operation === "ASSIGN") {
    const pause = await readOpsPause();
    if (pause.dispatchPaused) {
      throw new Error(
        `Dispatch is paused by an incident owner${pause.reason ? ` (${pause.reason})` : ""} — no new visit may be assigned until the pause is lifted from the Dashboard's emergency controls.`
      );
    }
  }
  const reasonCode = assertScheduleReason(
    operation ?? "",
    (args as { reasonCode?: string | null }).reasonCode,
    (args as { note?: string | null }).note
  );
  const actor = { sub: callerSub(identity), email: callerEmail(identity) };
  const prior = {
    technicianId: job.technicianId ?? null,
    routeId: job.routeId ?? null,
    scheduledDate: job.scheduledDate ?? null,
  };

  /** Audit + stale-draft disposition after a successful operation. A failed
   *  audit write cannot be silent: it opens an owned case and is reported in
   *  the result, so a schedule change with no record is visible work. */
  const finish = async (result: Record<string, unknown>, after: {
    technicianId?: string | null;
    routeId?: string | null;
    scheduledDate?: string | null;
    effects: string;
  }) => {
    const { draftDisposition, caseConfirmed } = await disposeStaleDrafts(
      String(job.id),
      prior.technicianId,
      after.technicianId ?? null
    );
    const auditRecorded = await recordAssignmentEvent({
      jobId: String(job.id),
      customerId: job.customerId,
      action: operation ?? "UNKNOWN",
      actor,
      reasonCode,
      reason: (args as { note?: string | null }).note ?? null,
      priorTechnicianId: prior.technicianId,
      newTechnicianId: after.technicianId ?? null,
      priorRouteId: prior.routeId,
      newRouteId: after.routeId ?? null,
      priorScheduledDate: prior.scheduledDate,
      newScheduledDate: after.scheduledDate ?? null,
      draftDisposition,
      effects: after.effects,
      outcome: caseConfirmed ? "COMPLETE" : "PARTIAL",
    });
    if (!auditRecorded) {
      await openOwnedWork({
        kind: "ROUTE_MISMATCH",
        dedupeKey: `assign-audit:${String(job.id)}`,
        title: "A schedule change could not write its audit record",
        detail: `${operation} on visit ${String(job.id)} by ${actor.email ?? "office"} succeeded, but its immutable assignment-audit row could not be written. The change stands; the proof does not.`,
        relatedId: String(job.id),
        sourceUrl: "/schedule",
        resolutionAction:
          "Reconstruct the assignment history for this visit from this case (actor, reason, former/new technician) so the record is complete.",
        ownerTeam: "OPS",
      });
    }
    return { ...result, auditRecorded, draftDisposition };
  };

  if (operation === "ASSIGN") {
    assertJobCanBeScheduled(job);
    if (!args.technicianId || !args.routeId || !args.scheduledDate) {
      throw new Error("Assignment requires a technician, route, and service date");
    }
    const [{ data: technician }, { data: route }, { data: customer }] =
      await Promise.all([
        client.models.Technician.get({ id: args.technicianId }),
        client.models.Route.get({ id: args.routeId }),
        client.models.Customer.get({ id: job.customerId }),
      ]);
    // GL-12: the job cannot be routed to a technician without the full
    // dispatch facts — a routable MA/RI address (no placeholders), an explicit
    // property classification (the locked 30/60-minute durations hang off it),
    // and a Google Routes drive-time proof attached to the decision. Checked
    // before the technician's own credential so the office sees every blocker,
    // and never bypassable — there is no override branch.
    if (!customer) throw new Error(`Customer ${job.customerId} no longer exists`);
    assertDispatchFacts(customer, {
      propertyClass: job.propertyClass,
      serviceType: job.serviceType,
    });
    if (!technician) throw new Error(`Technician ${args.technicianId} not found`);
    if (!technician.active) {
      throw new Error(
        `${technician.name ?? "This technician"} is inactive and cannot be assigned regulated work`
      );
    }
    // GL-17: licence currency on the SERVICE DATE comes from the one-to-many
    // licence records (legacy single fields only when no records exist).
    {
      const facts = await licenseFactsFor(technician, args.scheduledDate);
      if (!facts.current) {
        if (facts.source === "ERROR") {
          // GL-17: fail CLOSED on a records read failure — and say so, rather
          // than claiming the technician is unlicensed.
          throw new Error(
            `${technician.name ?? "This technician"}'s licence records could not be read just now — try again in a moment. Regulated work can't be assigned until the licence check succeeds.`
          );
        }
        if (facts.source === "LEGACY") {
          // No records yet — the legacy check names the exact missing fact.
          assertTechnicianCompliance(technician, {
            requireActive: true,
            workDate: args.scheduledDate,
          });
        }
        throw new Error(
          `${technician.name ?? "This technician"} has no current applicator licence on record for ${args.scheduledDate} — record a current licence (or pick another technician) before assigning regulated work`
        );
      }
    }
    // GL-04: the routability proof is measured from the ASSIGNED technician's
    // private base (or that day's reasoned override) — the leg that actually
    // gets driven — never a fixed HQ constant. An unavailable base (PTO,
    // closure, weekend, or unverifiable availability facts) fails the
    // assignment closed.
    const assignBase = await techBaseFor(technician.id, args.scheduledDate);
    if (!assignBase) {
      throw new Error(
        `${technician.name ?? "This technician"} isn't available on ${args.scheduledDate} (PTO, closure, weekend, or unverifiable availability facts) — pick another technician or day.`
      );
    }
    const routeProof = await proveRoutable(
      process.env.GOOGLE_ROUTES_API_KEY,
      assignBase,
      customer
    );
    // Every pure validation runs BEFORE any mutex is taken, so a refusal can
    // never strand a claimed month or reserved minutes.
    if (
      !route ||
      route.technicianId !== technician.id ||
      route.date !== args.scheduledDate
    ) {
      throw new Error("The selected route does not belong to that technician and date");
    }
    // GL-17: a seasonal plan's visit may only land in an in-season month, and
    // the month is claimed ATOMICALLY — the obligation row is the mutex, so
    // two concurrent assigns cannot both put a visit in the same month. The
    // PRIOR month is released only AFTER the schedule write actually lands,
    // and a failed publish rolls the fresh claim back (compensation) — a
    // failure can never leave both months held or the old month freed early.
    const priorDate = job.scheduledDate ?? null;
    let seasonalPlanId: string | null = null;
    let claimedTargetMonth: string | null = null;
    let priorMonthToRelease: string | null = null;
    if (job.servicePlanId) {
      const { data: plan } = await client.models.ServicePlan.get({
        id: job.servicePlanId,
      });
      if (plan?.seasonal) {
        const targetMonth = args.scheduledDate.slice(0, 7);
        if (!isServiceMonth(plan, targetMonth)) {
          throw new Error(
            "This plan's treatments run April–October — pick an in-season date (the plan still bills monthly year-round)."
          );
        }
        const priorMonth = job.scheduledDate?.slice(0, 7) ?? null;
        // The ledger is ALWAYS consulted — even when the job's current date
        // already sits in the target month. scheduledDate is not proof of
        // ledger ownership (a reschedule can move the date without the
        // month), so trusting it would dispatch into a month another job
        // holds. claimMonthForJob is idempotent for the rightful holder.
        const monthClaim = await claimMonthForJob({
          servicePlanId: plan.id,
          monthKey: targetMonth,
          jobId: job.id,
          customerId: job.customerId,
        });
        if (!monthClaim.ok) {
          throw new Error(
            monthClaim.unavailable
              ? "The seasonal-month ledger can't be verified right now — nothing was changed. Try again in a moment."
              : monthClaim.status === "SATISFIED"
                ? `This plan's ${targetMonth} treatment already happened — a seasonal plan gets exactly one treatment per month. Pick the next month instead.`
                : `This plan already has its ${targetMonth} visit scheduled — a seasonal plan gets exactly one treatment per month. Pick a different month, or reschedule the existing visit.`
          );
        }
        seasonalPlanId = plan.id;
        // A month the job ALREADY owned is not rolled back on failure — the
        // job stays scheduled in it, so releasing would let a second visit in.
        if (!("alreadyThisJob" in monthClaim && monthClaim.alreadyThisJob)) {
          claimedTargetMonth = targetMonth;
        }
        priorMonthToRelease = priorMonth !== targetMonth ? priorMonth : null;
      }
    }
    const compensateMonth = async () => {
      if (seasonalPlanId && claimedTargetMonth) {
        await releaseMonthForJob({
          servicePlanId: seasonalPlanId,
          monthKey: claimedTargetMonth,
          jobId: job.id,
          note: "Assignment failed — the month claim was rolled back.",
        }).catch(() => undefined);
      }
    };
    // GL-04: ONE atomic technician-WINDOW slot claim. The minutes are the
    // locked on-site duration + the REAL Routes leg from the assigned
    // technician's private base (routeProof is measured from that base) —
    // round trip. No proof ⇒ no claim ⇒ no assignment (fail closed). Two
    // simultaneous assigns cannot both take a slot's last minutes.
    const targetWindow = windowOfTimeWindow(
      args.timeWindow ?? job.timeWindow ?? null
    );
    // proveRoutable THROWS when the key exists but the address won't route,
    // and when no key exists without the explicit dev escape — so a null
    // proof here can only be the ALLOW_UNVERIFIED_ROUTES local-dev path,
    // which schedules on the locked on-site minutes alone.
    const slotMinutes =
      slotOnsiteMinutes(job.propertyClass) +
      (routeProof ? routeProof.driveMinutes * 2 : 0);
    const reserved = await reserveSlot(
      args.scheduledDate,
      targetWindow,
      technician.id,
      slotMinutes
    );
    if (!reserved.ok) {
      await compensateMonth();
      throw new Error(reserved.message);
    }
    // The publish is GUARDED on the schedule this assignment validated: a
    // concurrent reschedule that moved the visit (and its month claim) makes
    // this write LOSE instead of silently dating the job into a month whose
    // ledger row was released under us.
    const published = await casGuardedUpdate(
      "Job",
      job.id,
      {
        routeId: route.id,
        technicianId: technician.id,
        routeOrder: args.routeOrder ?? 1,
        scheduledDate: args.scheduledDate,
        status: "SCHEDULED",
        capacityWindow: targetWindow,
        capacityMinutes: slotMinutes,
        // A real assignment supersedes the checkout-time hold — the release
        // below gives that hold back from the pre-update row.
        capacityTechnicianId: null,
        ...(routeProof
          ? {
              dispatchDriveMinutes: routeProof.driveMinutes,
              dispatchRouteCheckedAt: routeProof.checkedAt,
            }
          : {}),
      },
      jobScheduleGuards(job)
    );
    if (!published.ok) {
      await compensateMonth();
      await releaseSlot(
        args.scheduledDate,
        targetWindow,
        technician.id,
        slotMinutes
      ).catch(() => undefined);
      throw new Error(
        published.reason === "UNSUPPORTED"
          ? "The scheduling lock store is unavailable — nothing was changed. Try again in a moment."
          : "This visit's schedule changed while assigning — refresh and try again."
      );
    }
    // Publish landed: NOW the prior month/slot are given back.
    if (priorMonthToRelease && seasonalPlanId) {
      await releaseMonthForJob({
        servicePlanId: seasonalPlanId,
        monthKey: priorMonthToRelease,
        jobId: job.id,
        note: "Visit moved to a different month.",
      }).catch(() => undefined);
    }
    // The prior hold — technician slot, checkout-time funnel hold, or pool
    // note — comes back strictly from the pre-update stamps.
    await releaseJobCapacity(job);
    return finish(
      { jobId: job.id },
      {
        technicianId: technician.id,
        routeId: route.id,
        scheduledDate: args.scheduledDate,
        effects: `Assigned to ${technician.name ?? technician.id} on route ${route.id} for ${args.scheduledDate}.`,
      }
    );
  }

  if (operation === "UNASSIGN") {
    assertJobCanBeScheduled(job);
    // GL-04: unassigning ENDS the technician-window hold ASSIGN reserved.
    // The write clears the assignment and restamps pending-assignment pool
    // facts in the SAME update; the old hold is released from the pre-update
    // row, so a repeated unassign cannot double-release, and a later
    // re-assign releases pool facts — never the stale technician stamp.
    const poolWindow = windowOfTimeWindow(job.timeWindow);
    const poolMinutes = slotOnsiteMinutes(job.propertyClass);
    const published = await casGuardedUpdate(
      "Job",
      job.id,
      {
        routeId: null,
        technicianId: null,
        routeOrder: null,
        status: "UNSCHEDULED",
        capacityWindow: job.scheduledDate ? poolWindow : null,
        capacityMinutes: job.scheduledDate ? poolMinutes : null,
        capacityTechnicianId: null,
      },
      jobScheduleGuards(job)
    );
    if (!published.ok) {
      throw new Error(
        published.reason === "UNSUPPORTED"
          ? "The scheduling lock store is unavailable — nothing was changed. Try again in a moment."
          : "This visit's schedule changed while unassigning — refresh and try again."
      );
    }
    await releaseJobCapacity(job);
    if (job.scheduledDate) {
      await notePoolMinutes(job.scheduledDate, poolWindow, poolMinutes).catch(
        () => undefined
      );
    }
    return finish(
      { jobId: job.id },
      {
        technicianId: null,
        routeId: null,
        scheduledDate: job.scheduledDate ?? null,
        effects: "Returned to the unscheduled pool.",
      }
    );
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
    return finish(
      { jobId: job.id, otherJobId: other.id },
      {
        technicianId: prior.technicianId,
        routeId: prior.routeId,
        scheduledDate: prior.scheduledDate,
        effects: `Route order swapped with stop ${other.id} (${args.routeOrder} ↔ ${args.otherRouteOrder}).`,
      }
    );
  }

  if (operation === "CANCEL") {
    assertJobCanBeScheduled(job);
    // The cancel WRITE comes first and clears the capacity stamps in the same
    // update; the releases below read the pre-update row. A retried cancel
    // re-reads a job with no stamps and releases nothing — exactly once. The
    // write is guarded on the schedule this cancel read, so a concurrent
    // move can't leave the month/slot release keyed to a stale date.
    const published = await casGuardedUpdate(
      "Job",
      job.id,
      {
        status: "CANCELED",
        routeId: null,
        technicianId: null,
        routeOrder: null,
        capacityWindow: null,
        capacityMinutes: null,
        capacityTechnicianId: null,
      },
      jobScheduleGuards(job)
    );
    if (!published.ok) {
      throw new Error(
        published.reason === "UNSUPPORTED"
          ? "The scheduling lock store is unavailable — nothing was changed. Try again in a moment."
          : "This visit's schedule changed while canceling — refresh and try again."
      );
    }
    // GL-17: a canceled seasonal visit gives its month back (guarded on the
    // month still belonging to this job).
    if (job.servicePlanId && job.scheduledDate) {
      await releaseMonthForJob({
        servicePlanId: job.servicePlanId,
        monthKey: job.scheduledDate.slice(0, 7),
        jobId: job.id,
        note: "Visit canceled — the month is owed again.",
      }).catch(() => undefined);
    }
    // GL-04: the canceled visit's minutes go back to its technician-window
    // slot (or the pool accounting slot) — strictly from its stamps.
    await releaseJobCapacity(job);
    return finish(
      { jobId: job.id },
      {
        technicianId: null,
        routeId: null,
        scheduledDate: prior.scheduledDate,
        effects: "Visit canceled and taken off its route.",
      }
    );
  }

  if (operation === "RESCHEDULE") {
    assertJobCanBeScheduled(job);
    const date = args.scheduledDate || null;
    const dateChanged = date !== (job.scheduledDate ?? null);
    const newWindow = date
      ? windowOfTimeWindow(args.timeWindow?.trim() || null)
      : null;

    // GL-17: a date move on a seasonal plan is a MONTH move — the ledger is
    // consulted BEFORE publishing, in-season enforced, and a claim taken for
    // a publish that never lands is rolled back.
    let claimedTargetMonth: string | null = null;
    if (date && job.servicePlanId) {
      const { data: plan } = await client.models.ServicePlan.get({
        id: job.servicePlanId,
      });
      if (!plan) {
        throw new Error(
          "The visit's plan could not be read just now — the move was refused rather than risking the one-treatment-per-month rule. Try again in a moment."
        );
      }
      if (plan.seasonal) {
        const targetMonth = date.slice(0, 7);
        if (!isServiceMonth(plan, targetMonth)) {
          throw new Error(
            "This plan's treatments run April–October — pick an in-season date (the plan still bills monthly year-round)."
          );
        }
        const monthClaim = await claimMonthForJob({
          servicePlanId: plan.id,
          monthKey: targetMonth,
          jobId: job.id,
          customerId: job.customerId,
        });
        if (!monthClaim.ok) {
          throw new Error(
            monthClaim.unavailable
              ? "The seasonal-month ledger can't be verified right now — nothing was changed. Try again in a moment."
              : monthClaim.status === "SATISFIED"
                ? `This plan's ${targetMonth} treatment already happened — a seasonal plan gets exactly one treatment per month. Pick the next month instead.`
                : `This plan already has its ${targetMonth} visit scheduled — a seasonal plan gets exactly one treatment per month. Pick a different month, or reschedule the existing visit.`
          );
        }
        if (!("alreadyThisJob" in monthClaim && monthClaim.alreadyThisJob)) {
          claimedTargetMonth = targetMonth;
        }
      }
    }
    const rollbackMonth = async () => {
      if (claimedTargetMonth && job.servicePlanId) {
        await releaseMonthForJob({
          servicePlanId: job.servicePlanId,
          monthKey: claimedTargetMonth,
          jobId: job.id,
          note: "Reschedule failed before publishing — the month claim was rolled back.",
        }).catch(() => undefined);
      }
    };

    // GL-04: capacity moves WITH the visit. A date change drops the
    // assignment, so accounting moves to the pool for the new date. A
    // window-only change must fit the held slot's OTHER window first —
    // refused when it doesn't. The hold may ride on the assigned technician
    // OR a funnel checkout's capacityTechnicianId; window moves move THAT
    // slot, and the attribution survives so the eventual release hits the
    // same ledger row.
    const heldTech = !dateChanged
      ? (job.technicianId ?? job.capacityTechnicianId ?? null)
      : null;
    const windowChanged =
      !dateChanged &&
      date != null &&
      newWindow != null &&
      (job.capacityWindow ?? windowOfTimeWindow(job.timeWindow)) !== newWindow;
    let stamped: { window: CapacityWindow; minutes: number } | null = null;
    if (date) {
      if (heldTech && windowChanged && job.capacityMinutes != null) {
        const movedRes = await reserveSlot(
          date,
          newWindow!,
          heldTech,
          job.capacityMinutes
        );
        if (!movedRes.ok) {
          await rollbackMonth();
          throw new Error(movedRes.message);
        }
        stamped = { window: newWindow!, minutes: job.capacityMinutes };
      } else if (heldTech) {
        // Same slot (or an unstamped legacy hold): stamps carry over.
        stamped =
          job.capacityWindow && job.capacityMinutes != null
            ? {
                window: job.capacityWindow as CapacityWindow,
                minutes: job.capacityMinutes,
              }
            : null;
      } else {
        stamped = {
          window: newWindow!,
          minutes: slotOnsiteMinutes(job.propertyClass),
        };
      }
    }
    // Guarded on the schedule this move validated — a concurrent mover wins
    // at most once (see ASSIGN).
    const published = await casGuardedUpdate(
      "Job",
      job.id,
      {
        scheduledDate: date,
        timeWindow: args.timeWindow?.trim() || null,
        status: date ? "SCHEDULED" : "UNSCHEDULED",
        capacityWindow: stamped?.window ?? null,
        capacityMinutes: stamped?.minutes ?? null,
        capacityTechnicianId: dateChanged
          ? null
          : (job.capacityTechnicianId ?? null),
        ...(dateChanged
          ? { routeId: null, technicianId: null, routeOrder: null }
          : {}),
      },
      jobScheduleGuards(job)
    );
    if (!published.ok) {
      await rollbackMonth();
      if (heldTech && windowChanged && job.capacityMinutes != null && date) {
        await releaseSlot(date, newWindow!, heldTech, job.capacityMinutes).catch(
          () => undefined
        );
      }
      throw new Error(
        published.reason === "UNSUPPORTED"
          ? "The scheduling lock store is unavailable — nothing was changed. Try again in a moment."
          : "This visit's schedule changed while rescheduling — refresh and try again."
      );
    }
    // Publish landed: the PRIOR hold and month come back, from the
    // pre-update row — a retry re-reads fresh stamps and cannot double-release.
    const capacityMoved =
      dateChanged || windowChanged || (!heldTech && date != null) || !date;
    if (capacityMoved) {
      await releaseJobCapacity(job);
    }
    if (date && !heldTech) {
      await notePoolMinutes(
        date,
        newWindow!,
        slotOnsiteMinutes(job.propertyClass)
      ).catch(() => undefined);
    }
    if (job.servicePlanId && job.scheduledDate) {
      const priorMonth = job.scheduledDate.slice(0, 7);
      if (!date || priorMonth !== date.slice(0, 7)) {
        await releaseMonthForJob({
          servicePlanId: job.servicePlanId,
          monthKey: priorMonth,
          jobId: job.id,
          note: "Visit moved out of the month.",
        }).catch(() => undefined);
      }
    }
    return finish(
      { jobId: job.id },
      {
        technicianId: dateChanged ? null : prior.technicianId,
        routeId: dateChanged ? null : prior.routeId,
        scheduledDate: date,
        effects: dateChanged
          ? `Rescheduled to ${date ?? "no date"}; assignment cleared for re-routing.`
          : `Time window updated for ${date ?? "no date"}.`,
      }
    );
  }

  throw new Error(`Unknown scheduling operation: ${args.operation ?? ""}`);
}

/** The packet fields whose change is MATERIAL — safety/access/scope/prep. A
 *  material change after service starts needs an audited manager reason. */
const MATERIAL_PACKET_FIELDS = [
  "accessInstructions",
  "hazardNotes",
  "prepInstructions",
  "prepConfirmed",
  "propertyClass",
] as const;

/**
 * GL-12: write the dispatch packet on an existing job, VERSIONED. Every change
 * to a safety/access/scope/prep fact bumps packetVersion, writes one immutable
 * JobPacketEvent (who, what, before/after), and is brought to the assigned
 * technician's attention (their app shows the change until they acknowledge
 * the new version; startJob refuses on an unacknowledged change). A material
 * change AFTER service started additionally requires a recorded manager
 * reason. A finalized/terminal visit's packet is history and not editable.
 */
async function updateJobPacket(
  identity: AppSyncIdentity | undefined | null,
  args: Args
) {
  const client = await dataClient();
  const { data: job } = await client.models.Job.get({ id: args.jobId! });
  if (!job) throw new Error(`Job ${args.jobId} not found`);
  if (
    job.status === "COMPLETED" ||
    job.status === "NO_ACCESS" ||
    job.status === "SCOPE_MISMATCH" ||
    job.status === "PREP_MISSING" ||
    job.status === "CANCELED"
  ) {
    throw new Error(
      "This visit is closed — its packet is part of the record and cannot be edited"
    );
  }
  const packet = packetFields(args);
  const propertyClass = normalizePropertyClass(
    (args as { propertyClass?: string | null }).propertyClass
  );

  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  const jobAny = job as unknown as Record<string, unknown>;
  const next: Record<string, unknown> = {
    accessInstructions: packet.accessInstructions ?? null,
    hazardNotes: packet.hazardNotes ?? null,
    prepInstructions: packet.prepInstructions ?? null,
    prepConfirmed: packet.prepConfirmed ?? null,
    propertyClass: propertyClass ?? jobAny.propertyClass ?? null,
  };
  const changed: string[] = [];
  for (const f of MATERIAL_PACKET_FIELDS) {
    const prev = jobAny[f] ?? null;
    const val = next[f] ?? null;
    if (JSON.stringify(prev) !== JSON.stringify(val)) {
      changed.push(f);
      before[f] = prev;
      after[f] = val;
    }
  }

  // The audited manager gate: a material change after service started needs a
  // recorded reason — never a silent rewrite under a technician mid-visit.
  const afterStart = Boolean(job.startedAt);
  const managerReason = (args as { managerReason?: string | null }).managerReason
    ?.trim();
  if (changed.length > 0 && afterStart && !managerReason) {
    throw new Error(
      "Service has already started — changing the packet now needs a short manager reason (recorded and shown to the technician)."
    );
  }

  const newVersion =
    changed.length > 0 ? (job.packetVersion ?? 1) + 1 : job.packetVersion ?? 1;
  const { data, errors } = await client.models.Job.update({
    id: job.id,
    // Explicit nulls so clearing a field actually clears it: an office user who
    // deletes a stale hazard note must not have the old one silently retained.
    accessInstructions: packet.accessInstructions ?? null,
    hazardNotes: packet.hazardNotes ?? null,
    prepInstructions: packet.prepInstructions ?? null,
    prepConfirmed: packet.prepConfirmed ?? null,
    paymentExpectation: packet.paymentExpectation ?? null,
    ...(propertyClass ? { propertyClass } : {}),
    ...(changed.length > 0
      ? { packetVersion: newVersion, packetChangedAt: new Date().toISOString() }
      : {}),
  });
  if (!data) {
    throw new Error(
      errors?.map((e) => e.message).join("; ") || "Could not update the job packet"
    );
  }

  let eventRecorded = true;
  if (changed.length > 0) {
    try {
      const { data: ev } = await client.models.JobPacketEvent.create({
        jobId: job.id,
        version: newVersion,
        changedFields: changed.join(", "),
        beforeJson: JSON.stringify(before),
        afterJson: JSON.stringify(after),
        changedBySub: callerSub(identity) ?? undefined,
        changedByEmail: callerEmail(identity) ?? undefined,
        afterStart,
        managerReason: managerReason || undefined,
        occurredAt: new Date().toISOString(),
      });
      eventRecorded = Boolean(ev);
    } catch (err) {
      console.error("JobPacketEvent write failed", job.id, err);
      eventRecorded = false;
    }
    if (!eventRecorded) {
      await openOwnedWork({
        kind: "ROUTE_MISMATCH",
        dedupeKey: `packet-audit:${job.id}:${newVersion}`,
        title: "A packet change could not write its audit record",
        detail: `Visit ${job.id}'s packet changed to version ${newVersion} (${changed.join(", ")}) but the immutable change record could not be written.`,
        relatedId: job.id,
        sourceUrl: "/schedule",
        resolutionAction:
          "Reconstruct the packet-change history for this visit from this case.",
        ownerTeam: "OPS",
      });
    }
    // Bring the change to the assigned technician's attention immediately —
    // the app also blocks Start until they acknowledge the new version.
    if (job.technicianId && afterStart) {
      const { data: tech } = await client.models.Technician.get({
        id: job.technicianId,
      });
      if (tech?.email) {
        await sendEmail({
          to: tech.email,
          subject: "A visit you are on changed — check the packet",
          template: "tech-packet-changed",
          relatedId: job.id,
          html: emailShell(
            "Your current visit's packet changed",
            `<p>The office changed ${changed.join(", ")} on the visit you started${managerReason ? `: ${managerReason}` : ""}. Open the job in the app and review before continuing.</p>`
          ),
        });
      }
    }
  }
  return {
    jobId: data.id,
    packetVersion: newVersion,
    changedFields: changed,
    eventRecorded,
  };
}

/**
 * GL-12 — the technician's acknowledgement of the packet version they read.
 * Only the ASSIGNED technician's own identity can acknowledge (office cannot
 * ack on their behalf), and the watermark never moves backwards.
 */
async function acknowledgePacket(
  identity: AppSyncIdentity | undefined | null,
  jobId: string,
  version: number
) {
  const client = await dataClient();
  const { data: job } = await client.models.Job.get({ id: jobId });
  if (!job) throw new Error(`Job ${jobId} not found`);
  const tech = await technicianForCaller(identity);
  if (!tech || job.technicianId !== tech.id) {
    throw new Error(
      "Only the assigned technician can acknowledge their packet — the point is that THEY read it."
    );
  }
  const current = job.packetVersion ?? 1;
  const ackTo = Math.min(version || current, current);
  if ((job.packetAckVersion ?? 0) >= ackTo) {
    return { jobId, packetAckVersion: job.packetAckVersion ?? 0, already: true };
  }
  const { data } = await client.models.Job.update({
    id: jobId,
    packetAckVersion: ackTo,
    packetAckAt: new Date().toISOString(),
  });
  if (!data) throw new Error("Could not record the acknowledgement");
  return { jobId, packetAckVersion: ackTo, already: false };
}

/**
 * Rebook a terminal visit that did not happen — NO_ACCESS (couldn't get in)
 * or CANCELED — as a NEW, linked visit attempt. The original is never
 * touched: its reason, time, note, and door photo stay as the record of that
 * attempt. The new job carries rebookedFromJobId so the attempts stay linked.
 *
 * A COMPLETED visit is not rebooked (it succeeded — a new service is its own
 * job); a live SCHEDULED/UNSCHEDULED job is assigned, not rebooked.
 */
async function rebookJob(
  jobId: string,
  actorSub: string | null,
  actorEmail: string | null
) {
  const client = await dataClient();
  const { data: job } = await client.models.Job.get({ id: jobId });
  if (!job) throw new Error(`Job ${jobId} not found`);
  if (
    job.status !== "NO_ACCESS" &&
    job.status !== "SCOPE_MISMATCH" &&
    job.status !== "PREP_MISSING" &&
    job.status !== "CANCELED"
  ) {
    throw new Error(
      "Only a visit that reached a terminal outcome (no access, scope mismatch, prep missing, canceled) is rebooked — a live job is scheduled, and a completed one stays on the record"
    );
  }
  const rebookedJobId = `rebook-${job.id}`;
  const { data: existingRebook } = await client.models.Job.get({
    id: rebookedJobId,
  });
  if (existingRebook) {
    await resolveRebookedNoAccessWork(job, existingRebook.id, actorSub, actorEmail);
    return {
      jobId: existingRebook.id,
      rebookedFromJobId: job.id,
      alreadyRebooked: true,
    };
  }
  const { data: created, errors } = await client.models.Job.create({
    id: rebookedJobId,
    customerId: job.customerId,
    servicePlanId: job.servicePlanId ?? undefined,
    type: job.type,
    serviceType: job.serviceType,
    description: job.description ?? undefined,
    priceCents: job.priceCents ?? undefined,
    // A rebook is the same paid service attempt, not a second sale. Carry the
    // up-front payment marker so no later screen can charge this visit again.
    paidAt: job.paidAt ?? undefined,
    paidPaymentIntentId: job.paidPaymentIntentId ?? undefined,
    timeWindow: job.timeWindow ?? undefined,
    notes: job.notes ?? undefined,
    status: "UNSCHEDULED",
    rebookedFromJobId: job.id,
    accessGroups: job.accessGroups ?? undefined,
  });
  if (!created) {
    throw new Error(
      errors?.map((e) => e.message).join("; ") || "Could not rebook the visit"
    );
  }
  await resolveRebookedNoAccessWork(job, created.id, actorSub, actorEmail);
  return {
    jobId: created.id,
    rebookedFromJobId: job.id,
    alreadyRebooked: false,
  };
}

/** Rebooking is the concrete resolution for a no-access exception. */
async function resolveRebookedNoAccessWork(
  sourceJob: { id: string; status?: string | null },
  rebookedJobId: string,
  actorSub: string | null,
  actorEmail: string | null
) {
  const kind =
    sourceJob.status === "NO_ACCESS"
      ? ("NO_ACCESS" as const)
      : sourceJob.status === "SCOPE_MISMATCH"
        ? ("SCOPE_MISMATCH" as const)
        : sourceJob.status === "PREP_MISSING"
          ? ("PREP_MISSING" as const)
          : null;
  if (!kind) return;
  const client = await dataClient();
  if (!("WorkItem" in client.models) || !("WorkEvent" in client.models)) return;
  try {
    await updateOwnedWork({
      workItemId: workItemId(kind, sourceJob.id),
      action: "RESOLVE",
      note: `Rebooked as linked visit ${rebookedJobId}; the original record remains unchanged.`,
      actorSub,
      actorEmail,
      // The rebook IS the verified event — close as verified, not as a note.
      verified: true,
    });
  } catch (err) {
    // A legacy no-access row may predate owned work. That is the only benign
    // miss; a real history/write failure must make the idempotent mutation
    // retry so the job can never be rebooked while its obligation stays open.
    if (err instanceof Error && err.message === "Work item not found") return;
    throw err;
  }
}

/**
 * What has to be true before a service report becomes a pesticide record.
 *
 * Every one of these was a client-side check or nothing at all, which meant the
 * document BuzzKill hands an inspector could be finalized empty. Throwing here
 * is the whole point: the technician's app must ask for these before it lets
 * them send, and the server must not take its word for it.
 */
/**
 * A GPS reading captured this far outside the real application window is treated
 * as stale — it belongs to a different visit, not this one. Measured against the
 * server-stamped window, never against finalize time, so a report legitimately
 * written up the next morning still validates against yesterday's capture. This
 * is a sanity bound on "same visit", not the Compliance precision policy.
 */
const GEO_CAPTURE_GRACE_MS = 2 * 60 * 60 * 1000;
/**
 * A clean outdoor GPS lock reads to within ~5–20 m; against a building or under
 * cover, ~30–65 m; indoors it degrades to wifi/cell fallback (hundreds of m or
 * more). A fix worse than this isn't proof of standing at an address — but it
 * does NOT block the technician: it flags the finalized report for an after-the-
 * fact on-site-presence review. Tunable by the Compliance owner.
 */
const GEO_REVIEW_ACCURACY_M = 100;
/**
 * How far the captured point may be from the service address before the report
 * is flagged for review. One mile is deliberately generous — it absorbs road-vs-
 * straight-line inflation and never penalizes rural areas where a tech parks
 * down the road. Also non-blocking; also the Compliance owner's to tune.
 */
const GEO_REVIEW_DISTANCE_M = 1609;

/**
 * The blocking half of the location rule: is there a real reading at all? A
 * report with no coordinate, an impossible point, no timestamp, no accuracy, or
 * a capture from outside the visit window has no usable evidence, and every one
 * of those is fixed by tapping "capture" again on site — so it is safe to
 * refuse. What is NOT refused here is an imprecise or far-from-address fix: a
 * technician in a basement or a dead-zone cannot GPS their way out of it, so
 * those are handled by flagLocationForReview as owned work, never a block.
 */
function assertLocationIsPresence(
  report: {
    geoLat?: number | null;
    geoLng?: number | null;
    geoAccuracyM?: number | null;
    geoCapturedAt?: string | null;
  },
  job: { startedAt?: string | null; applicationEndAt?: string | null }
) {
  if (report.geoLat == null || report.geoLng == null) {
    throw new Error("Capture the location on site before sending the report");
  }
  if (
    !Number.isFinite(report.geoLat) ||
    !Number.isFinite(report.geoLng) ||
    Math.abs(report.geoLat) > 90 ||
    Math.abs(report.geoLng) > 180 ||
    (report.geoLat === 0 && report.geoLng === 0)
  ) {
    throw new Error(
      "The captured location isn't a real point on the map — capture it again on site"
    );
  }
  if (report.geoCapturedAt == null || report.geoAccuracyM == null) {
    throw new Error(
      "Re-capture the location on site — this reading is missing its time or its accuracy, so it can't stand as proof you were there"
    );
  }
  if (!Number.isFinite(report.geoAccuracyM) || report.geoAccuracyM <= 0) {
    throw new Error(
      "The location reading has no real accuracy — capture it again on site"
    );
  }
  const capturedMs = Date.parse(report.geoCapturedAt);
  if (Number.isNaN(capturedMs)) {
    throw new Error(
      "The location reading's timestamp is unreadable — capture it again on site"
    );
  }
  const startMs = Date.parse(job.startedAt ?? "");
  const endMs = Date.parse(job.applicationEndAt ?? "");
  if (
    !Number.isNaN(startMs) &&
    !Number.isNaN(endMs) &&
    (capturedMs < startMs - GEO_CAPTURE_GRACE_MS ||
      capturedMs > endMs + GEO_CAPTURE_GRACE_MS)
  ) {
    throw new Error(
      "The location was captured outside the time you were on site — re-capture it during the visit so the record proves you were there"
    );
  }
}

/**
 * The non-blocking half of the on-site-presence rule. The report is already
 * finalized; this only asks, after the fact, "does the captured GPS look like
 * the technician was actually at the address?" — an imprecise fix, or one that
 * routes more than a mile from the service address. Either raises an owned OPS
 * review task; neither blocks the technician and neither waits on a manager.
 *
 * Best-effort by construction: no service address, no routing key, or an
 * un-routable address (rural, new construction) all mean "can't tell", which is
 * silence, not a flag. It never throws into finalize — a review that could not
 * run must not undo a completed record.
 */
async function flagLocationForReview(input: {
  reportId: string;
  customerId: string;
  customerName: string;
  serviceType: string;
  serviceAddress: string;
  geoLat: number;
  geoLng: number;
  geoAccuracyM: number;
}): Promise<void> {
  try {
    const client = await dataClient();
    // The durable marker is the truth a resumed finalize and the daily sweep
    // read — a settled review never re-runs, an unsettled one always does.
    const { data: current } = await client.models.ServiceReport.get({
      id: input.reportId,
    });
    const status = current?.presenceReviewStatus ?? null;
    if (status === "NOT_NEEDED" || status === "QUEUED" || status === "RESOLVED") {
      return;
    }

    let detail: string;
    if (status === "FLAGGED") {
      // A prior pass established the obligation but could not confirm the case
      // — re-attempt the queue without recomputing (the flag IS the fact).
      detail = `${input.customerName}'s ${input.serviceType} service report was flagged for an on-site presence review, but the review case did not persist on the first attempt. The record stands; this is a check, not a hold.`;
    } else {
      const reasons: string[] = [];
      if (input.geoAccuracyM > GEO_REVIEW_ACCURACY_M) {
        reasons.push(
          `the GPS fix was only accurate to about ${Math.round(input.geoAccuracyM)} m`
        );
      }
      const apiKey = process.env.GOOGLE_ROUTES_API_KEY;
      if (apiKey && input.serviceAddress) {
        const meters = await drivingDistanceMetersFromPoint(
          apiKey,
          { lat: input.geoLat, lng: input.geoLng },
          input.serviceAddress
        );
        // null = couldn't route (no coverage/geocode). Unknown, not far.
        if (meters != null && meters > GEO_REVIEW_DISTANCE_M) {
          reasons.push(
            `the captured location is about ${(meters / 1609).toFixed(1)} mi from the service address`
          );
        }
      }
      if (!reasons.length) {
        await client.models.ServiceReport.update({
          id: input.reportId,
          presenceReviewStatus: "NOT_NEEDED",
        });
        return;
      }
      // The FLAGGED marker is the PERSISTENT recovery record, written and
      // verified BEFORE the queue attempt — a failed case write can no longer
      // silently erase the obligation; the daily sweep re-opens it from here.
      const { data: marked } = await client.models.ServiceReport.update({
        id: input.reportId,
        presenceReviewStatus: "FLAGGED",
      });
      if (!marked) {
        console.error(
          "flagLocationForReview: could not persist FLAGGED marker",
          input.reportId
        );
      }
      detail = `${input.customerName}'s ${input.serviceType} service report is finalized, but its on-site location may not confirm presence — ${reasons.join(
        " and "
      )}. The record stands; this is a check, not a hold.`;
    }

    const queued = await queuePresenceReview({
      reportId: input.reportId,
      customerId: input.customerId,
      customerName: input.customerName,
      serviceType: input.serviceType,
      detail,
    });
    // Secondary alarm only — the durable FLAGGED marker plus the daily sweep
    // are the real recovery; the email is a same-day nudge.
    if (!queued) {
      await notifyOffice({
        subject: `On-site presence review couldn't be queued: ${input.customerName}`,
        heading: "A location review could not be recorded",
        template: "ops-location-review-unqueued",
        customerId: input.customerId,
        relatedId: input.reportId,
        bodyHtml: `<p>${detail}</p>
         <p>The automatic review task could not be saved; the daily reconcile will retry it. To act now: confirm the technician was on site (job-site photos, notes, customer contact).</p>`,
      });
    }
  } catch (err) {
    // A presence review is a safety net, never a gate. If it cannot run, the
    // finalized record still stands — the FLAGGED marker (or the absent
    // NOT_NEEDED marker) keeps the obligation discoverable by the sweep.
    console.error("flagLocationForReview failed", input.reportId, err);
  }
}

function assertReportIsARecord(
  report: {
    inspectionOnly?: boolean | null;
    productsUsed?: unknown;
    servicesPerformed?: string | null;
    reEntryIntervalHours?: number | null;
    geoLat?: number | null;
    geoLng?: number | null;
    geoAccuracyM?: number | null;
    geoCapturedAt?: string | null;
  },
  job: {
    status: string | null;
    startedAt?: string | null;
    applicationEndAt?: string | null;
  }
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
  // Both ends of the application window are server-stamped facts (Start job,
  // End application) — never inferred at finalize. A legal record whose times
  // the server invented is not a record of when the application happened; it is
  // a record of when someone pressed send. Refuse rather than substitute.
  if (!job.startedAt) {
    throw new Error(
      "This job was never started — press Start job first, so the record carries the application's real start time, then complete the report"
    );
  }
  if (!job.applicationEndAt) {
    throw new Error(
      "The application was never ended — the record needs the real time you finished on site, not the moment this report was sent"
    );
  }
  if (!report.servicesPerformed?.trim()) {
    throw new Error("Say what was done before sending the report");
  }
  assertLocationIsPresence(report, job);

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

type CatalogProduct = {
  name?: string | null;
  epaNumber?: string | null;
  active?: boolean | null;
  labelApproved?: boolean | null;
  /** The office-recorded label rate/dilution, checked against the approved
   *  product label. The authority a report's applied rate is validated to. */
  defaultRate?: string | null;
  /** Label re-entry minimum (hours). */
  reEntryHours?: number | null;
  /** GL-15 structured label rules — see shared/compliance LabelRules. */
  labelRulesJson?: unknown;
};

/**
 * GL-15, bullet 1: a regulated report may only carry office-approved products
 * from the launch catalog. assertReportIsARecord checks that each product row is
 * *shaped* like a record — a name, a format-valid EPA number, a quantity, a rate
 * — but a technician can type all of that by hand from a crawlspace, inventing a
 * product and a plausible EPA number that no one ever reviewed against a label.
 * Free-text is not authorization. The catalog is the control: an unknown product
 * has to be reviewed and approved into it by the office (saveProduct, the
 * label-approval gate) before it can appear on a legal record.
 *
 * Matching is by EPA number and name against an *active, label-approved* catalog
 * row, so a real number under the wrong name, a retired/inactive product, or one
 * that was added but never label-approved is refused here — not silently
 * finalized onto the document a customer keeps and an inspector may read.
 */
function assertProductsAreApproved(
  products: { name?: string | null; epaNumber?: string | null }[],
  catalog: CatalogProduct[]
): void {
  const approved = catalog.filter((c) => c.active && c.labelApproved);
  for (const p of products) {
    const name = p.name?.trim() ?? "";
    const epa = p.epaNumber?.trim() ?? "";
    const match = approved.find(
      (c) =>
        (c.epaNumber?.trim() ?? "") === epa &&
        (c.name?.trim().toLowerCase() ?? "") === name.toLowerCase()
    );
    if (!match) {
      throw new Error(
        `“${name}” (EPA ${epa || "—"}) isn't an approved product in the catalog. A product has to be reviewed and added to the product log by the office before it can go on a service report — free-text details can't authorize a pesticide record. Ask the office to add it, then pick it here.`
      );
    }
  }
}

/**
 * GL-15, bullet 4: every recorded application fact is held to the product's
 * label rules, and the check FAILS CLOSED — a catalog product that cannot be
 * validated (no recorded rate or rules) refuses finalization with the office
 * fix named, rather than passing silently onto a legal record. The rules
 * themselves (allowed rates, quantity range, pest/service applicability,
 * re-entry minimum) live on the catalog row (labelRulesJson + defaultRate +
 * reEntryHours); the validation logic is shared/compliance's
 * assertApplicationWithinLabel, pure and unit-tested.
 */
function assertProductsWithinLabelRules(
  products: {
    name?: string | null;
    epaNumber?: string | null;
    rate?: string | null;
    quantity?: string | null;
  }[],
  catalog: CatalogProduct[],
  report: { reEntryIntervalHours?: number | null; targetPests?: string | null },
  job: { serviceType?: string | null }
): void {
  const approved = catalog.filter((c) => c.active && c.labelApproved);
  for (const p of products) {
    const name = p.name?.trim() ?? "";
    const epa = p.epaNumber?.trim() ?? "";
    const match = approved.find(
      (c) =>
        (c.epaNumber?.trim() ?? "") === epa &&
        (c.name?.trim().toLowerCase() ?? "") === name.toLowerCase()
    );
    // Unmatched rows are already refused by assertProductsAreApproved.
    if (!match) continue;
    assertApplicationWithinLabel({
      productName: name,
      recordedQuantity: p.quantity,
      recordedRate: p.rate,
      reportReEntryHours: report.reEntryIntervalHours,
      reportPests: report.targetPests,
      jobServiceType: job.serviceType,
      catalogDefaultRate: match.defaultRate,
      catalogReEntryHours: match.reEntryHours,
      rules: parseLabelRules(match.labelRulesJson),
    });
  }
}

/** Re-fetch a finalized report's stored PDF for a resumed delivery. A missing
 *  object returns null — the caller records a failed delivery (owned work)
 *  rather than sending a "complete" email with no report attached. */
async function loadReportPdf(pdfKey?: string | null): Promise<Uint8Array | null> {
  if (!pdfKey) return null;
  try {
    const res = await s3.send(
      new GetObjectCommand({ Bucket: BUCKET(), Key: pdfKey })
    );
    const bytes = await res.Body?.transformToByteArray();
    return bytes ?? null;
  } catch (err) {
    console.error("finalizeServiceReport: could not load report PDF", pdfKey, err);
    return null;
  }
}

/**
 * Deliver a finalized report to the customer, idempotently. Delivery is a
 * separate fact from finalization and runs only after the report and job are
 * durable — so no "your service is complete" message can go out ahead of the
 * record that backs it.
 *
 * emailedAt is the durable outbox marker (set only after a successful send): a
 * resumed finalize whose report is already marked delivered returns without
 * sending again, so a retry never emails the customer twice. A prior FAILED
 * attempt (no marker) is re-attempted; a customer with no email on file is
 * owned delivery work, not a silent gap.
 */
/**
 * GL-15 — was this exact document already accepted by the provider on a prior
 * pass whose marker write was lost? SES has no idempotency key, so the outbox
 * check is the EmailLog: a SENT/DELIVERED row for this record + template means
 * the customer HAS the message and a resend would duplicate a legal notice.
 */
async function priorAcceptedSend(
  relatedId: string,
  template: string
): Promise<{ sentAt: string } | null> {
  try {
    const client = await dataClient();
    if (!("EmailLog" in client.models)) return null;
    const { data } = await client.models.EmailLog.listEmailLogByRelatedId(
      { relatedId },
      { limit: 50 }
    );
    const hit = (data ?? []).find(
      (l) =>
        l.template === template &&
        (l.deliveryStatus === "SENT" || l.deliveryStatus === "DELIVERED")
    );
    return hit ? { sentAt: hit.sentAt } : null;
  } catch (err) {
    console.error("priorAcceptedSend lookup failed", relatedId, err);
    // Unknown ≠ safe to resend a legal notice blind — the caller treats a
    // lookup failure as "assume sent" and routes through owned work instead.
    return { sentAt: new Date().toISOString() };
  }
}

async function deliverServiceReport(
  report: {
    id: string;
    customerId: string;
    serviceDate: string;
    emailedAt?: string | null;
    deliveryStatus?: string | null;
    pdfKey?: string | null;
  },
  job: { serviceType: string; servicePlanId?: string | null },
  customer: {
    id: string;
    email?: string | null;
    displayName: string;
    contactName?: string | null;
    portalUserSub?: string | null;
  },
  technicianName: string,
  pdfInMemory?: Uint8Array
): Promise<{
  emailed: boolean;
  deliveryStatus: string;
}> {
  // Already sent on a prior pass — the durable marker means the provider took
  // the customer message. Never re-send it. (Later mailbox events may upgrade
  // or reopen the state; that is ses-events' job, not a resend trigger.)
  if (report.emailedAt) {
    return {
      emailed: false,
      deliveryStatus: report.deliveryStatus ?? "ACCEPTED",
    };
  }

  const client = await dataClient();

  // A prior pass durably intended a send (SENDING) but its marker never
  // landed. The EmailLog is the outbox truth: adopt a proven send instead of
  // duplicating the customer's legal notice.
  if (report.deliveryStatus === "SENDING") {
    const prior = await priorAcceptedSend(report.id, "service-report");
    if (prior) {
      await client.models.ServiceReport.update({
        id: report.id,
        deliveryStatus: "ACCEPTED",
        emailedAt: prior.sentAt,
      });
      return { emailed: false, deliveryStatus: "ACCEPTED" };
    }
    // Nothing left the building — fall through and send for real.
  }

  if (!customer.email) {
    await openOwnedWork({
      kind: "MISSING_CONTACT",
      dedupeKey: `service-report-delivery:${report.id}`,
      title: `Service report undelivered — no email on file: ${customer.displayName}`,
      detail: `${customer.displayName}'s ${job.serviceType} service report is finalized and is the pesticide record, but there is no email address on file to deliver their copy to.`,
      customerId: customer.id,
      relatedId: report.id,
      sourceUrl: `/customers/${customer.id}`,
      resolutionAction:
        "Add and verify the customer's email and re-send the report, or deliver the copy by an approved alternate method (mail or hand-off) and record how it was delivered.",
      ownerTeam: "OPS",
    });
    if (report.deliveryStatus !== "NO_EMAIL") {
      await client.models.ServiceReport.update({
        id: report.id,
        deliveryStatus: "NO_EMAIL",
      });
    }
    return { emailed: false, deliveryStatus: "NO_EMAIL" };
  }

  const pdf = pdfInMemory ?? (await loadReportPdf(report.pdfKey));
  if (!pdf) {
    // The record stands, but its PDF could not be attached to deliver. Record a
    // failed delivery and own it, rather than emailing "complete" with no report.
    await openOwnedWork({
      kind: "EMAIL_FAILURE",
      dedupeKey: `service-report-delivery:${report.id}`,
      title: `Service report couldn't be delivered: ${customer.displayName}`,
      detail: `${customer.displayName}'s ${job.serviceType} service report is finalized, but its PDF could not be retrieved to email. Delivery will retry on the next finalize.`,
      customerId: customer.id,
      relatedId: report.id,
      sourceUrl: `/customers/${customer.id}`,
      resolutionAction:
        "Re-send the finalized report to the customer, or deliver the copy by an approved alternate method and record how.",
      ownerTeam: "OPS",
    });
    if (report.deliveryStatus !== "FAILED") {
      await client.models.ServiceReport.update({
        id: report.id,
        deliveryStatus: "FAILED",
      });
    }
    return { emailed: false, deliveryStatus: "FAILED" };
  }

  // The durable outbox intent, written and VERIFIED before the provider call:
  // a crash between SES acceptance and the marker write now leaves SENDING —
  // discoverable, resumable via the EmailLog check above — instead of an
  // invisible duplicate-send window. If the intent cannot persist, we do not
  // send (a send we could not mark is a duplicate waiting to happen).
  if (report.deliveryStatus !== "SENDING") {
    const { data: intent } = await client.models.ServiceReport.update({
      id: report.id,
      deliveryStatus: "SENDING",
    });
    if (!intent) {
      await openOwnedWork({
        kind: "EMAIL_FAILURE",
        dedupeKey: `service-report-delivery:${report.id}`,
        title: `Service report delivery could not start: ${customer.displayName}`,
        detail: `${customer.displayName}'s ${job.serviceType} report is finalized, but the delivery-intent marker could not be written, so the send was not attempted (a send that can't be marked risks a duplicate).`,
        customerId: customer.id,
        relatedId: report.id,
        sourceUrl: `/customers/${customer.id}`,
        resolutionAction:
          "Re-send the finalized report from the customer screen once the system recovers.",
        ownerTeam: "OPS",
      });
      return { emailed: false, deliveryStatus: report.deliveryStatus ?? "FAILED" };
    }
    report.deliveryStatus = "SENDING";
  }

  // If this visit was part of a plan, tell them when the next one lands.
  const { data: plan } = job.servicePlanId
    ? await client.models.ServicePlan.get({ id: job.servicePlanId })
    : { data: null };
  const nextIso =
    plan && plan.status === "ACTIVE"
      ? nextVisitDate(plan.serviceFrequency, new Date().toISOString(), plan)
      : null;
  const reviewUrl = process.env.GOOGLE_REVIEW_URL;

  const emailed = await sendEmail({
    to: customer.email,
    subject: `Service report — ${job.serviceType}`,
    template: "service-report",
    customerId: customer.id,
    relatedId: report.id,
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
         <p>${technicianName} completed your <strong>${job.serviceType}</strong> service. Your full service report is attached${customer.portalUserSub ? ", and it's always available in your BuzzKill portal" : ""}.</p>
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

  // Record the outcome. ACCEPTED — the provider took it; a legal record never
  // calls acceptance "delivered" (ses-events upgrades to DELIVERED on the
  // mailbox event, or reopens the obligation on a bounce). emailedAt is the
  // marker a resumed finalize reads to know the send already happened. A
  // failed send already opened EMAIL_FAILURE work inside sendEmail; FAILED
  // (not SENDING) lets the next finalize re-attempt cleanly.
  const deliveryStatus = emailed ? "ACCEPTED" : "FAILED";
  const { data: marked } = await client.models.ServiceReport.update({
    id: report.id,
    deliveryStatus,
    ...(emailed ? { emailedAt: new Date().toISOString() } : {}),
  });
  // A send that happened but could not be marked is visible owned work — never
  // a silent "sent but not recorded" (the SENDING state + EmailLog also make
  // it discoverable to the resume path).
  if (emailed && !marked) {
    await openOwnedWork({
      kind: "EMAIL_FAILURE",
      dedupeKey: `service-report-delivery:${report.id}`,
      title: `Service report sent but not recorded: ${customer.displayName}`,
      detail: `${customer.displayName}'s ${job.serviceType} report email was accepted by the provider, but the sent marker could not be written. Do NOT blind-resend — verify the EmailLog first.`,
      customerId: customer.id,
      relatedId: report.id,
      sourceUrl: `/customers/${customer.id}`,
      resolutionAction:
        "Check the email log for this report. If the send is there, re-run finalize to adopt it; only resend if nothing was accepted.",
      ownerTeam: "OPS",
    });
  }
  return { emailed, deliveryStatus };
}

/**
 * Turn a saved draft into the finalized pesticide record, deterministically and
 * resumably. The steps — validate, render/store the PDF, finalize the report,
 * complete the job, start plan billing, queue the next visit, review on-site
 * presence, deliver to the customer — are each idempotent and gated on their
 * own persisted state, so a hard kill at any step leaves a retry to resume from
 * exactly there without a duplicate document, email, invoice, or next visit.
 *
 * Order matters: the report and job are made durable BEFORE the customer is told
 * anything (deliverServiceReport), so a failed write can never leave a delivered
 * "complete" message pointing at a still-draft record.
 */
/** How long a finalize claim may sit before a retry may reclaim it — past any
 *  Lambda timeout, so a live attempt is never raced. */
const FINALIZE_CLAIM_STALE_MS = 5 * 60_000;

/**
 * GL-15 — the single-winner finalize claim (conditional create, id = reportId).
 * Returns true when this caller owns finalization; false when another attempt
 * holds a fresh claim. A stale claim (crashed holder) is reclaimed.
 */
async function acquireFinalizeClaim(
  reportId: string
): Promise<{ won: true; holder: string } | { won: false }> {
  const client = await dataClient();
  const holder = randomUUID();
  const attempt = async () => {
    const { data } = await client.models.ServiceReportFinalizeClaim.create({
      id: reportId,
      requestedAt: new Date().toISOString(),
      holder,
      leaseUntil: new Date(Date.now() + FINALIZE_CLAIM_STALE_MS).toISOString(),
    });
    return Boolean(data);
  };
  if (await attempt()) return { won: true, holder };
  const { data: held } = await client.models.ServiceReportFinalizeClaim.get({
    id: reportId,
  });
  if (
    held?.requestedAt &&
    Date.now() - Date.parse(held.requestedAt) < FINALIZE_CLAIM_STALE_MS
  ) {
    return { won: false };
  }
  if (!held) {
    // Released between our create and get — one more conditional create.
    return (await attempt()) ? { won: true, holder } : { won: false };
  }
  // Stale: seize the claim with ONE guarded update conditioned on "no live
  // lease" — never delete-then-create, which would let two reclaimers both
  // believe they own finalization and both bill, schedule, and email.
  const takeover = await casTakeover("ServiceReportFinalizeClaim", reportId, {
    nonceField: "holder",
    nonce: holder,
    leaseField: "leaseUntil",
    leaseMs: FINALIZE_CLAIM_STALE_MS,
  });
  if (takeover.ok) return { won: true, holder };
  if (takeover.reason === "LOST") return { won: false };
  // UNSUPPORTED (unit fakes / deploy straddling): takeover impossible for
  // every racer — fall back to the age-gated conditional create.
  await client.models.ServiceReportFinalizeClaim.delete({ id: reportId }).catch(
    () => undefined
  );
  return (await attempt()) ? { won: true, holder } : { won: false };
}

/** Fenced release — an expired finalize attempt waking up late can never
 *  delete the claim out from under the newer holder. */
async function releaseFinalizeClaim(
  reportId: string,
  holder: string
): Promise<void> {
  const released = await casFencedDelete(
    "ServiceReportFinalizeClaim",
    reportId,
    { field: "holder", nonce: holder, allowMissingFence: true }
  );
  if (released !== "UNSUPPORTED") return;
  const client = await dataClient();
  await client.models.ServiceReportFinalizeClaim.delete({ id: reportId }).catch(
    () => undefined
  );
}

async function finalizeServiceReport(reportId: string) {
  const client = await dataClient();
  const { data: report } = await client.models.ServiceReport.get({
    id: reportId,
  });
  if (!report) throw new Error(`ServiceReport ${reportId} not found`);

  // GL-15: one winner. Two simultaneous finalizes must not both see
  // "not finalized" and both bill, schedule, and email — the loser reports the
  // honest in-progress state instead of proceeding.
  const finalizeClaim = await acquireFinalizeClaim(reportId);
  if (!finalizeClaim.won) {
    return {
      inProgress: true,
      emailed: false,
      deliveryStatus: report.deliveryStatus ?? null,
      message:
        "This report is already being finalized. Wait a moment, then refresh — the outcome will be recorded.",
    };
  }
  const reportRow = report;
  try {
    return await runFinalize();
  } finally {
    await releaseFinalizeClaim(reportId, finalizeClaim.holder);
  }

  async function runFinalize() {
  // Narrowed alias — hoisted declarations do not inherit the null check above.
  const report = reportRow;
  const [{ data: job }, { data: customer }, { data: technician }] =
    await Promise.all([
      client.models.Job.get({ id: report.jobId }),
      client.models.Customer.get({ id: report.customerId }),
      client.models.Technician.get({ id: report.technicianId }),
    ]);
  if (!job || !customer) throw new Error("Report is missing its job/customer");

  const technicianName = technician?.name ?? "BuzzKill Technician";
  const serviceAddress = [
    customer.serviceStreet,
    customer.serviceCity,
    customer.serviceState,
    customer.serviceZip,
  ]
    .filter(Boolean)
    .join(", ");

  // Fully done already (finalized AND delivery settled AND the presence-review
  // obligation settled): a resumed finalize has nothing left to do. NO_EMAIL is
  // settled (there is nothing to send to); only a real send stamps emailedAt. A
  // FAILED delivery is NOT settled — it falls through so the send is
  // re-attempted. A FLAGGED (or unrecorded) presence review is NOT settled —
  // the resume re-runs checkpoint 3 so the obligation cannot vanish.
  const deliverySettled =
    !!report.emailedAt || report.deliveryStatus === "NO_EMAIL";
  const reviewSettled =
    report.presenceReviewStatus === "NOT_NEEDED" ||
    report.presenceReviewStatus === "QUEUED" ||
    report.presenceReviewStatus === "RESOLVED";
  if (
    report.status === "FINALIZED" &&
    report.pdfKey &&
    deliverySettled &&
    reviewSettled
  ) {
    return {
      pdfKey: report.pdfKey,
      emailed: false,
      deliveryStatus: report.deliveryStatus ?? "ACCEPTED",
      alreadyFinalized: true,
    };
  }

  // --- Checkpoint 1: make the report a durable finalized record. ---
  // Idempotent on report.status: skipped on a resume where a prior pass already
  // finalized it. Runs the validation + render + store + state flip as one step.
  let pdf: Uint8Array | undefined;
  if (report.status !== "FINALIZED" || !report.pdfKey) {
    // The gate was in React only. finalizeServiceReport checked nothing — not
    // products, not an EPA number, not a quantity, not the job's state — so any
    // caller could finalize an empty report on any job and email it.
    assertReportIsARecord(report, job);

    // Every product must be an office-approved catalog product AND carry the
    // approved label rate — not a free-text row (or strength) a technician typed
    // on site. Inspection-only reports have no products, so this is a no-op.
    const productsUsed = parseProducts(report.productsUsed);
    if (productsUsed.length) {
      const { data: catalog } = await client.models.Product.list({ limit: 1000 });
      const approved = catalog ?? [];
      assertProductsAreApproved(productsUsed, approved);
      assertProductsWithinLabelRules(productsUsed, approved, report, job);
    }

    // assertReportIsARecord has already refused any report whose job is missing
    // a server-stamped start or end, so both are real times the technician's
    // Start job / End application produced on site — never invented here, so a
    // report written up the next morning still carries yesterday's real window.
    const applicationStartIso = job.startedAt!;
    const applicationEndIso = job.applicationEndAt!;
    assertTechnicianCompliance(technician ?? {}, {
      workDate: applicationStartIso.slice(0, 10),
    });

    // GL-17: the record prints the licence that was valid ON THE APPLICATION
    // DATE — a later renewal, expiry, or revocation never rewrites authorship.
    let authorship: { number: string | null } = { number: null };
    if (technician) {
      const authorRecords = await licenseRecordsFor(technician.id);
      // A records read failure fails closed: print NO licence number rather
      // than let the legacy field resurrect a possibly-revoked one.
      authorship =
        authorRecords === null
          ? { number: null }
          : licenseValidOnDate(
              authorRecords,
              technician,
              applicationStartIso.slice(0, 10)
            );
    }
    pdf = await renderServiceReportPdf({
      reportId,
      customerName: customer.displayName,
      serviceAddress: serviceAddress || undefined,
      serviceType: job.serviceType,
      serviceDateIso: report.serviceDate,
      technicianName,
      technicianLicenseNumber: authorship.number,
      applicationStartIso,
      applicationEndIso,
      reEntryIntervalHours: report.reEntryIntervalHours,
      inspectionOnly: report.inspectionOnly,
      servicesPerformed: report.servicesPerformed,
      productsUsed,
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

    const { data: finalized, errors: finalizeErrors } =
      await client.models.ServiceReport.update({
        id: reportId,
        status: "FINALIZED",
        pdfKey,
        applicationStartAt: applicationStartIso,
        applicationEndAt: applicationEndIso,
      });
    // VERIFY the persisted record before anything downstream: a silently
    // failed status write must not bill, schedule, or email "complete" over a
    // still-draft report (GL-15).
    const { data: verifyReport } = await client.models.ServiceReport.get({
      id: reportId,
    });
    if (!finalized || verifyReport?.status !== "FINALIZED" || !verifyReport.pdfKey) {
      throw new Error(
        `The report could not be durably finalized${
          finalizeErrors?.length
            ? `: ${finalizeErrors.map((e) => e.message).join("; ")}`
            : ""
        }. Nothing was billed or sent — try again.`
      );
    }
    // Mirror onto the in-memory record so the checkpoints below see it as
    // finalized without a re-read.
    report.status = "FINALIZED";
    report.pdfKey = pdfKey;
    report.applicationStartAt = applicationStartIso;
    report.applicationEndAt = applicationEndIso;
  }

  // --- Checkpoint 2: complete the job and its downstream billing effects. ---
  // The job flip is idempotent on job.status; startBillingForPlan and
  // scheduleNextRecurringVisit are independently idempotent and never throw, so
  // they run on every pass and safely resume whichever a prior attempt missed.
  if (job.status !== "COMPLETED") {
    const completedAt = new Date().toISOString();
    // A job that is ALREADY canceled when this (possibly resumed) pass reads
    // it must not be resurrected by a guard pinned to its own canceled
    // snapshot — it takes the same Finance-conflict branch a mid-flight
    // cancel does.
    let completedRes: Awaited<ReturnType<typeof casGuardedUpdate>> =
      job.status === "CANCELED"
        ? { ok: false, reason: "LOST" }
        : // GUARDED on the snapshot this finalization read. If a cancel (with
          // its refund) landed while the technician was on site, the flip
          // LOSES: the canceled record stands, billing/next-visit are NOT
          // run, and a Finance case owns the real conflict — service was
          // performed on a visit the customer concurrently canceled. The
          // finalized report itself is already durable either way (it is the
          // legal application record).
          await casGuardedUpdate(
            "Job",
            report.jobId,
            { status: "COMPLETED", completedAt },
            jobScheduleGuards(job)
          );
    if (!completedRes.ok && completedRes.reason === "LOST") {
      const { data: freshJob } = await client.models.Job.get({
        id: report.jobId,
      });
      if (freshJob?.status === "CANCELED") {
        await openOwnedWork({
          kind: "VISIT_CHANGE_RECOVERY",
          dedupeKey: `completed-after-cancel:${report.jobId}`,
          title: `Service was performed on a concurrently canceled visit`,
          detail: `The technician finalized the service report for job ${report.jobId}, but the visit was canceled (and its money disposition applied) while the work was happening. The report is durable and legal; the visit record stays CANCELED. Decide the money outcome: the work WAS done, so a refund issued by the cancel may need to be re-invoiced, or the cancellation honored as goodwill.`,
          customerId: job.customerId,
          relatedId: report.jobId,
          sourceUrl: `/customers/${job.customerId}`,
          resolutionAction:
            "Compare the cancel's refund against the performed work and settle the invoice one way — then close this.",
          ownerTeam: "FINANCE",
        });
        return {
          reportId: report.id,
          jobId: report.jobId,
          finalized: true,
          jobCompleted: false,
          message:
            "The report is finalized and saved, but this visit was canceled while you were on site — the office has a case to settle the money. Nothing was billed.",
        } as never;
      }
      // Any other concurrent change (a move): retry once against the fresh
      // snapshot — the work happened; the completion stands on the new state.
      if (freshJob && freshJob.status !== "COMPLETED") {
        completedRes = await casGuardedUpdate(
          "Job",
          report.jobId,
          { status: "COMPLETED", completedAt },
          jobScheduleGuards(freshJob)
        );
      } else if (freshJob?.status === "COMPLETED") {
        completedRes = { ok: true, prior: {} };
      }
    }
    // VERIFY: billing and the next visit key off COMPLETED — a silently failed
    // flip must stop here (the report is finalized and durable; a retry
    // resumes from this checkpoint).
    const { data: verifyJob } = await client.models.Job.get({
      id: report.jobId,
    });
    if (!completedRes.ok || verifyJob?.status !== "COMPLETED") {
      throw new Error(
        "The job could not be marked completed. The report is finalized and safe — try again to finish billing and delivery."
      );
    }
    job.status = "COMPLETED";
    job.completedAt = completedAt;
  }
  await startBillingForPlan(job);
  await scheduleNextRecurringVisit(job);

  // --- Checkpoint 3: on-site presence review (durable, idempotent). ---
  // The record already stands; assertLocationIsPresence guaranteed a real,
  // in-window reading, so these are non-null. Never blocks, never throws — an
  // imprecise or far fix becomes durable OPS review work, not a hold.
  await flagLocationForReview({
    reportId,
    customerId: customer.id,
    customerName: customer.displayName,
    serviceType: job.serviceType,
    serviceAddress,
    geoLat: report.geoLat!,
    geoLng: report.geoLng!,
    geoAccuracyM: report.geoAccuracyM!,
  });

  // --- Checkpoint 4: deliver to the customer (only now that the record is
  // durable), idempotently via the emailedAt marker. ---
  const delivery = await deliverServiceReport(
    report,
    job,
    customer,
    technicianName,
    pdf
  );

  return {
    pdfKey: report.pdfKey!,
    emailed: delivery.emailed,
    deliveryStatus: delivery.deliveryStatus,
    alreadyFinalized: false,
  };
  }
}

/** Corrected facts as they arrive from the office UI (AWSJSON, may be a string). */
function parseAmendmentChanges(raw: unknown): AmendmentChange[] {
  let list: unknown;
  try {
    list = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  return list
    .map((c) => {
      const row = (c ?? {}) as { label?: unknown; field?: unknown; from?: unknown; to?: unknown };
      const label = String(row.label ?? row.field ?? "").trim();
      return {
        label,
        from: row.from == null ? "" : String(row.from),
        to: row.to == null ? "" : String(row.to),
      };
    })
    // A correction has to name what changed and give its corrected value. A blank
    // "to" is not a correction, it is an erasure with no record of what now stands.
    .filter((c) => c.label && c.to.trim());
}

/**
 * A deterministic id for an amendment, derived from the correction request
 * itself — the report, the reason, the changed facts, and the issuer. A retry of
 * the SAME correction resumes onto the same row instead of appending a second
 * amendment, which is what makes issuance idempotent: no duplicate or orphaned
 * amendment survives a hard kill mid-issuance. Two genuinely different
 * corrections differ in reason or changes and so get different ids.
 */
function amendmentRequestId(
  reportId: string,
  reason: string,
  changes: AmendmentChange[],
  authorSub: string | null
): string {
  const canonical = JSON.stringify({
    reportId,
    reason,
    changes,
    authorSub: authorSub ?? "",
  });
  return `amd-${createHash("sha256").update(canonical).digest("hex").slice(0, 40)}`;
}

/**
 * Issue an append-only correction to a finalized report, deterministically and
 * resumably. The original record is never touched — this creates a new, linked
 * document carrying the reason, the actual signed-in issuer (from the token, not
 * the request and not the original technician), the time, and the changed facts,
 * and delivers it to the customer the same way a report is delivered.
 *
 * The amendment id is derived from the correction request, so create, render,
 * store, deliver, and metadata are one resumable issuance: a retry after a
 * partial failure lands on the same amendment — no duplicate row, document, or
 * email. A draft is not amended (it is still editable); an amendment only
 * corrects an issued record.
 */
async function amendServiceReport(
  reportId: string,
  input: {
    reason?: string | null;
    changes?: unknown;
    authorSub: string | null;
    authorEmail: string | null;
    authorName: string | null;
  }
) {
  const client = await dataClient();
  const { data: original } = await client.models.ServiceReport.get({ id: reportId });
  if (!original) throw new Error(`ServiceReport ${reportId} not found`);
  if (original.status !== "FINALIZED") {
    throw new Error(
      "Only an issued report can be amended — an unfinalized draft is corrected by editing it, not by an amendment"
    );
  }
  const reason = input.reason?.trim();
  if (!reason) {
    throw new Error("An amendment needs the reason the record is being corrected");
  }
  const changes = parseAmendmentChanges(input.changes);
  if (!changes.length) {
    throw new Error(
      "An amendment needs at least one corrected fact — name what changed and its corrected value"
    );
  }

  const [{ data: customer }, { data: job }] = await Promise.all([
    client.models.Customer.get({ id: original.customerId }),
    client.models.Job.get({ id: original.jobId }),
  ]);
  if (!customer) throw new Error("The amended report is missing its customer");
  const serviceType = job?.serviceType ?? "service";

  const amendmentId = amendmentRequestId(reportId, reason, changes, input.authorSub);

  // Resume onto the existing row if a prior attempt already created it; only
  // create it once. The id is deterministic on the request, so a retry never
  // appends a second amendment.
  const existing = await client.models.ServiceReportAmendment.get({ id: amendmentId });
  let amendment = existing.data;
  const issuedAt = amendment?.issuedAt ?? new Date().toISOString();
  if (!amendment) {
    const created = await client.models.ServiceReportAmendment.create({
      id: amendmentId,
      originalReportId: reportId,
      customerId: original.customerId,
      jobId: original.jobId,
      reason,
      changes: JSON.stringify(changes),
      authorSub: input.authorSub ?? undefined,
      authorEmail: input.authorEmail ?? undefined,
      issuedAt,
      accessGroups: customerAccessGroups(original.customerId, customer.groupId),
    });
    amendment = created.data;
    if (!amendment) {
      // A concurrent retry may have won the deterministic create — re-read
      // before giving up, so a race resumes rather than errors.
      const reread = await client.models.ServiceReportAmendment.get({ id: amendmentId });
      amendment = reread.data;
      if (!amendment) {
        throw new Error(
          created.errors?.map((e) => e.message).join("; ") ||
            "Could not create the amendment"
        );
      }
    }
  }

  // Fully issued already: the row exists, its PDF is stored, and delivery is
  // settled (delivered, or no email to deliver to). Nothing left to redo, and
  // in particular nothing to re-send.
  const deliverySettled =
    !!amendment.emailedAt || amendment.deliveryStatus === "NO_EMAIL";
  if (amendment.pdfKey && deliverySettled) {
    return {
      amendmentId,
      pdfKey: amendment.pdfKey,
      deliveryStatus: amendment.deliveryStatus ?? "ACCEPTED",
      emailed: false,
      alreadyIssued: true,
    };
  }

  const serviceAddress = [
    customer.serviceStreet,
    customer.serviceCity,
    customer.serviceState,
    customer.serviceZip,
  ]
    .filter(Boolean)
    .join(", ");

  // The document names the actual signed-in issuer of the correction — never the
  // original report's technician, who did not issue it.
  const pdf = await renderAmendmentPdf({
    amendmentId,
    originalReportId: reportId,
    customerName: customer.displayName,
    serviceAddress: serviceAddress || undefined,
    serviceType,
    originalServiceDateIso: original.serviceDate,
    reason,
    changes,
    authorName: input.authorName ?? input.authorEmail ?? "BuzzKill office",
    authorEmail: input.authorEmail,
    issuedAtIso: issuedAt,
  });

  // Deterministic key so a retry overwrites the same object instead of orphaning.
  const pdfKey = `reports/${original.customerId}/${reportId}/amendments/${amendmentId}.pdf`;
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET(),
      Key: pdfKey,
      Body: pdf,
      ContentType: "application/pdf",
    })
  );

  // Deliver only if a prior attempt has not already sent (emailedAt is the
  // durable marker). GL-15: re-read the row RIGHT BEFORE deciding — a
  // concurrent duplicate that lost the deterministic create must not race the
  // winner's marker into a second customer email — then write the SENDING
  // intent (verified) before the provider call, and adopt a proven prior send
  // from the EmailLog instead of blind-resending.
  const { data: freshAmendment } =
    await client.models.ServiceReportAmendment.get({ id: amendmentId });
  const current = freshAmendment ?? amendment;
  let emailed = false;
  if (!current.emailedAt && customer.email) {
    if (current.deliveryStatus === "SENDING") {
      const prior = await priorAcceptedSend(
        amendmentId,
        "service-report-amendment"
      );
      if (prior) {
        await client.models.ServiceReportAmendment.update({
          id: amendmentId,
          pdfKey,
          deliveryStatus: "ACCEPTED",
          emailedAt: prior.sentAt,
        });
        return {
          amendmentId,
          pdfKey,
          deliveryStatus: "ACCEPTED",
          emailed: false,
          alreadyIssued: true,
        };
      }
    }
    const { data: intent } = await client.models.ServiceReportAmendment.update({
      id: amendmentId,
      deliveryStatus: "SENDING",
    });
    if (!intent) {
      await openOwnedWork({
        kind: "EMAIL_FAILURE",
        dedupeKey: `report-amendment-delivery:${amendmentId}`,
        title: `Amendment delivery could not start: ${customer.displayName}`,
        detail: `The correction to ${customer.displayName}'s ${serviceType} report is issued, but the delivery-intent marker could not be written, so the send was not attempted.`,
        customerId: customer.id,
        relatedId: amendmentId,
        sourceUrl: `/customers/${customer.id}`,
        resolutionAction:
          "Re-send the amendment from the customer screen once the system recovers.",
        ownerTeam: "OPS",
      });
      await client.models.ServiceReportAmendment.update({
        id: amendmentId,
        pdfKey,
      });
      return {
        amendmentId,
        pdfKey,
        deliveryStatus: current.deliveryStatus ?? "FAILED",
        emailed: false,
        alreadyIssued: false,
      };
    }
    emailed = await sendEmail({
      to: customer.email,
      subject: `Corrected service report — ${serviceType}`,
      template: "service-report-amendment",
      customerId: customer.id,
      relatedId: amendmentId,
      attachments: [
        {
          filename: "BuzzKill-Service-Report-Amendment.pdf",
          content: pdf,
          contentType: "application/pdf",
        },
      ],
      html: emailShell(
        "Your service report has been corrected",
        `<p>Hi ${customer.contactName ?? customer.displayName},</p>
         <p>We've issued a correction to your <strong>${serviceType}</strong> service report. The corrected details are in the attached amendment${customer.portalUserSub ? ", and it's always available in your BuzzKill portal" : ""}. Your original report is unchanged and still on file.</p>
         <p style="color:#666;font-size:13px;">Reason for the correction: ${reason}</p>
         <p style="color:#666;font-size:13px;">Questions? Just reply to this email.</p>`
      ),
    });
  }
  // Delivery is a separate fact from issuance, exactly as it is for a report —
  // and provider ACCEPTANCE is never called delivered on a legal record.
  const deliveryStatus: "ACCEPTED" | "FAILED" | "NO_EMAIL" = current.emailedAt
    ? "ACCEPTED"
    : emailed
      ? "ACCEPTED"
      : customer.email
        ? "FAILED"
        : "NO_EMAIL";
  if (deliveryStatus === "NO_EMAIL") {
    await openOwnedWork({
      kind: "MISSING_CONTACT",
      dedupeKey: `report-amendment-delivery:${amendmentId}`,
      title: `Report amendment undelivered — no email on file: ${customer.displayName}`,
      detail: `A correction to ${customer.displayName}'s ${serviceType} service report was issued, but there is no email address on file to deliver the amendment.`,
      customerId: customer.id,
      relatedId: amendmentId,
      sourceUrl: `/customers/${customer.id}`,
      resolutionAction:
        "Add and verify the customer's email and re-send the amendment, or deliver the corrected report by an approved alternate method and record how.",
      ownerTeam: "OPS",
    });
  }

  const { data: marked } = await client.models.ServiceReportAmendment.update({
    id: amendmentId,
    pdfKey,
    deliveryStatus,
    ...(emailed ? { emailedAt: new Date().toISOString() } : {}),
  });
  // A send that happened but could not be marked is visible owned work — the
  // SENDING state + EmailLog make it adoptable by the next attempt, never a
  // blind duplicate.
  if (emailed && !marked) {
    await openOwnedWork({
      kind: "EMAIL_FAILURE",
      dedupeKey: `report-amendment-delivery:${amendmentId}`,
      title: `Amendment sent but not recorded: ${customer.displayName}`,
      detail: `The correction to ${customer.displayName}'s ${serviceType} report was accepted by the provider, but the sent marker could not be written. Do NOT blind-resend — verify the EmailLog first.`,
      customerId: customer.id,
      relatedId: amendmentId,
      sourceUrl: `/customers/${customer.id}`,
      resolutionAction:
        "Check the email log for this amendment. If the send is there, re-run the amendment to adopt it; only resend if nothing was accepted.",
      ownerTeam: "OPS",
    });
  }

  return {
    amendmentId,
    pdfKey,
    deliveryStatus,
    emailed,
    alreadyIssued: false,
  };
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
  // GUARDED: a cancel landing after the read must not be overwritten into a
  // COMPLETED-and-billed visit.
  const completedRes = await casGuardedUpdate(
    "Job",
    jobId,
    { status: "COMPLETED", completedAt },
    jobScheduleGuards(job)
  );
  if (!completedRes.ok) {
    throw new Error(
      completedRes.reason === "UNSUPPORTED"
        ? "The scheduling lock store is unavailable — try again in a moment."
        : "This job changed while completing (it may have just been canceled or moved) — refresh and check its state."
    );
  }
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
  // GL-12: a packet change since assignment must reach the technician BEFORE
  // work starts — the app shows the change; acknowledging it unblocks Start.
  if ((job.packetVersion ?? 1) > 1 && (job.packetAckVersion ?? 0) < (job.packetVersion ?? 1)) {
    throw new Error(
      "The job packet changed since it was assigned — review the change in the packet and tap Acknowledge before starting."
    );
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
  // GUARDED on the snapshot this start validated: a cancel that lands after
  // the read makes the start LOSE instead of resurrecting a canceled (and
  // possibly refunded) visit into IN_PROGRESS.
  const started = await casGuardedUpdate(
    "Job",
    jobId,
    { status: "IN_PROGRESS", startedAt },
    jobScheduleGuards(job)
  );
  if (!started.ok) {
    throw new Error(
      started.reason === "UNSUPPORTED"
        ? "The scheduling lock store is unavailable — try again in a moment."
        : "This visit changed while starting (it may have just been canceled or moved) — refresh the job and check before starting."
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
  identity: AppSyncIdentity | undefined | null,
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
    // The caller proved they own args.jobId; make sure the report they're
    // editing actually belongs to that job, so a valid job id can't be paired
    // with another job's report id to edit it.
    if (existing.jobId !== args.jobId) {
      throw new Error("This report does not belong to that job");
    }
    if (existing.status === "FINALIZED") {
      throw new Error(
        "This report has been finalized and sent to the customer — it is the record of the application and cannot be changed. Ask the office to issue an amendment."
      );
    }
    // GL-13: a draft is the applicator's own words. Only the technician who is
    // writing it may edit it — an office (or any other) caller is refused, so
    // an office edit can never be indistinguishable from the applicator's own
    // record. Corrections to a finalized report go through amendments; a
    // takeover goes through reassignment (which routes the draft to owned
    // office review).
    const callerTech = await technicianForCaller(identity);
    if (!callerTech || callerTech.id !== existing.technicianId) {
      throw new Error(
        "Only the technician writing this draft can edit it. To take over the visit, reassign it on the Schedule board (the draft goes to office review); to correct a finalized report, issue an amendment."
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
  const technician = await technicianForCaller(identity);
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
  // GUARDED: a concurrent cancel (with its refund disposition) must not be
  // overwritten by a no-access record — the loser refuses and re-reads.
  const reported = await casGuardedUpdate(
    "Job",
    args.jobId,
    {
      status: "NO_ACCESS",
      noAccessReason: args.reason,
      noAccessAt: nowIso,
      noAccessNote: args.note?.trim() || null,
      noAccessPhotoKey: args.photoKey ?? null,
      // Off the route: the stop is done for today and the day's capacity is free.
      routeId: null,
      routeOrder: null,
    },
    jobScheduleGuards(job)
  );
  if (!reported.ok) {
    throw new Error(
      reported.reason === "UNSUPPORTED"
        ? "The scheduling lock store is unavailable — try again in a moment."
        : "This visit changed while reporting (it may have just been canceled or moved) — refresh the job and check its state before reporting."
    );
  }

  const [{ data: customer }, { data: technician }] = await Promise.all([
    client.models.Customer.get({ id: job.customerId }),
    job.technicianId
      ? client.models.Technician.get({ id: job.technicianId })
      : Promise.resolve({ data: null }),
  ]);

  await openOwnedWork({
    kind: "NO_ACCESS",
    dedupeKey: job.id,
    title: `Resolve no-access visit: ${customer?.displayName ?? job.customerId}`,
    detail: `${label}${args.note?.trim() ? ` — ${args.note.trim()}` : ""}. No service was performed${job.paidAt ? "; the visit was already paid up front" : " and no charge was made"}. GL-10 locked rule: no access is the appointment's NONREFUNDABLE cancellation under the 72-hour policy — there is no refund, fee, or credit decision to make. The one next step is rebooking the visit with the customer.`,
    customerId: job.customerId,
    relatedId: job.id,
    sourceUrl: `/customers/${job.customerId}`,
    resolutionAction:
      "Rebook the visit with the customer (the attendance evidence is on the job). No money decision exists — the no-access outcome is nonrefundable by policy.",
    ownerTeam: "OPS",
  });

  // GL-10: the customer hears the no-refund result and the rebooking path
  // directly — the winner of the guarded transition sends exactly once (a
  // replayed report loses the transition and returns alreadyReported).
  if (customer?.email) {
    await sendEmail({
      to: customer.email,
      subject: "We couldn't get in today — let's rebook your visit",
      template: "no-access-notice",
      customerId: job.customerId,
      relatedId: job.id,
      html: emailShell(
        "We couldn't complete today's visit",
        `<p>Hi ${customer.displayName ?? "there"},</p>
         <p>Our technician arrived for your ${job.serviceType}${job.scheduledDate ? ` on ${job.scheduledDate}` : ""} but couldn't get access (${label.toLowerCase()}).</p>
         <p>Under the cancellation policy, a visit we can't access counts as a same-day cancellation and <strong>isn't refundable</strong>${job.paidAt ? " — but your payment stays with your visit: we'll rebook it with you at no additional charge" : ""}.</p>
         <p>Our office will reach out within one business day to set the new time — or just reply to this email with a day that works.</p>`
      ),
    }).catch(() => undefined);
  }

  // The office owns rebooking. There is no fee/refund/credit choice — the
  // policy already decided the money.
  await notifyOffice({
    subject: `Couldn't access: ${customer?.displayName ?? job.customerId} — ${label}`,
    heading: "A technician couldn't do the job",
    template: "ops-no-access",
    customerId: job.customerId,
    relatedId: job.id,
    bodyHtml: `<p><strong>${technician?.name ?? "A technician"}</strong> attended <strong>${customer?.displayName ?? "this customer"}</strong> for ${job.serviceType}${job.scheduledDate ? ` on ${job.scheduledDate}` : ""} and couldn't do the work.</p>
       <p><strong>${label}</strong>${args.note?.trim() ? ` — ${args.note.trim()}` : ""}</p>
       <p>No service report was filed and no new charge was made. The customer has been told the no-access outcome is nonrefundable under the policy and that we'll rebook. The one next step: <strong>rebook the visit</strong>${job.paidAt ? " (their payment stays applied to it)" : ""}.</p>
       <p style="margin:20px 0;"><a href="${CRM_URL()}/customers/${job.customerId}" style="background:#176b2c;color:#fff;padding:11px 20px;border-radius:8px;text-decoration:none;font-weight:600;">Open the customer</a></p>`,
  });

  return { jobId: args.jobId, status: "NO_ACCESS", alreadyReported: false };
}

/** GL-12 — controlled reasons for the two honest one-tap exits. */
const SCOPE_MISMATCH_LABEL: Record<string, string> = {
  DIFFERENT_PEST: "The pest on site isn't the pest on the work order",
  DIFFERENT_PROPERTY: "The property/structure doesn't match the work order",
  WRONG_SERVICE_SOLD: "The sold service can't address what's on site",
  OUT_OF_SCOPE_AREA: "The area needing treatment isn't in the sold scope",
};
const PREP_MISSING_LABEL: Record<string, string> = {
  AREAS_NOT_CLEARED: "The areas to treat weren't cleared or prepared",
  PETS_NOT_SECURED: "Pets weren't secured",
  OCCUPANTS_PRESENT: "Occupants present who needed to vacate",
  PREP_NOT_DONE: "The required preparation visibly wasn't done",
};

/**
 * GL-12 — the technician's honest one-tap exit when the visit cannot
 * legitimately proceed: SCOPE_MISMATCH (the work on the packet isn't the work
 * the site needs) or PREP_MISSING (the required customer prep didn't happen).
 * Mirrors reportNoAccess: never writes startedAt/completedAt or a report,
 * frees the day's capacity (off the route), preserves the money facts
 * (paidAt stays for the office decision), opens an owned Operations case, and
 * sends the customer the approved next step (or opens missing-contact work).
 * Idempotent — re-reporting the same exit returns the recorded state.
 */
async function reportVisitNotPerformed(
  kind: "SCOPE_MISMATCH" | "PREP_MISSING",
  args: {
    jobId: string;
    reason: string;
    note?: string | null;
    photoKey?: string | null;
  }
) {
  const labels = kind === "SCOPE_MISMATCH" ? SCOPE_MISMATCH_LABEL : PREP_MISSING_LABEL;
  const label = labels[args.reason];
  if (!label) {
    throw new Error(
      `Unknown reason "${args.reason}" — use one of: ${Object.keys(labels).join(", ")}`
    );
  }

  const client = await dataClient();
  const { data: job } = await client.models.Job.get({ id: args.jobId });
  if (!job) throw new Error(`Job ${args.jobId} not found`);
  if (job.status === kind) {
    return { jobId: args.jobId, status: kind, alreadyReported: true };
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
  // GUARDED: a concurrent cancel/move must not be overwritten by this
  // terminal outcome — the loser refuses and re-reads.
  const recorded = await casGuardedUpdate(
    "Job",
    args.jobId,
    {
      status: kind,
      notPerformedReason: args.reason,
      notPerformedAt: nowIso,
      notPerformedNote: args.note?.trim() || null,
      notPerformedPhotoKey: args.photoKey ?? null,
      // Off the route: the stop is done for today and the day's capacity frees.
      routeId: null,
      routeOrder: null,
    },
    jobScheduleGuards(job)
  );
  if (!recorded.ok) {
    throw new Error(
      recorded.reason === "UNSUPPORTED"
        ? "The scheduling lock store is unavailable — try again in a moment."
        : "This visit changed while recording (it may have just been canceled or moved) — refresh the job and check its state before reporting."
    );
  }

  const [{ data: customer }, { data: technician }] = await Promise.all([
    client.models.Customer.get({ id: job.customerId }),
    job.technicianId
      ? client.models.Technician.get({ id: job.technicianId })
      : Promise.resolve({ data: null }),
  ]);

  const isScope = kind === "SCOPE_MISMATCH";
  await openOwnedWork({
    kind,
    dedupeKey: job.id,
    title: isScope
      ? `Scope doesn't match: ${customer?.displayName ?? job.customerId}`
      : `Required prep missing: ${customer?.displayName ?? job.customerId}`,
    detail: `${label}${args.note?.trim() ? ` — ${args.note.trim()}` : ""}. No service was performed${job.paidAt ? "; the visit was already paid up front and that money fact is preserved" : " and no charge was made"}.`,
    customerId: job.customerId,
    relatedId: job.id,
    sourceUrl: `/customers/${job.customerId}`,
    resolutionAction: isScope
      ? "Review what the site actually needs, correct the service/scope (and price if needed) with the customer, then rebook the corrected visit or settle the money."
      : "Confirm the prep steps with the customer, then rebook the visit once they're ready. The office decides any money outcome — the technician made no charge.",
    ownerTeam: "OPS",
  });

  // The approved customer next step — one business day, plainly said. A
  // customer with no email becomes owned missing-contact work instead of a
  // silent gap.
  if (customer?.email) {
    await sendEmail({
      to: customer.email,
      subject: isScope
        ? "About today's visit — we need to adjust your service"
        : "About today's visit — we couldn't treat yet",
      template: isScope ? "scope-mismatch-next-step" : "prep-missing-next-step",
      customerId: customer.id,
      relatedId: job.id,
      html: emailShell(
        isScope ? "We need to adjust your service" : "We couldn't treat today",
        `<p>Hi ${customer.contactName ?? customer.displayName},</p>
         ${
           isScope
             ? `<p>Our technician visited today and found the situation on site isn't what your booked service covers (${label.toLowerCase()}). No work was performed${job.paidAt ? ", and your payment stays attached to your visit while we sort this out" : " and you were not charged"}.</p>
                <p><strong>We'll contact you within one business day</strong> with the right service and next steps.</p>`
             : `<p>Our technician visited today but couldn't treat because the preparation steps weren't in place (${label.toLowerCase()}).${job.prepInstructions ? ` As a reminder: ${job.prepInstructions}` : ""}</p>
                <p>No work was performed${job.paidAt ? ", and your payment stays attached to your visit" : " and you were not charged"}. <strong>We'll contact you within one business day</strong> to reschedule once you're ready.</p>`
         }
         <p style="color:#666;font-size:13px;">Questions? Just reply to this email.</p>`
      ),
    });
  } else {
    await openMissingContactWork({
      customerId: job.customerId,
      displayName: customer?.displayName ?? job.customerId,
      context: isScope
        ? "A scope-mismatch visit outcome needs to reach the customer."
        : "A prep-missing visit outcome needs to reach the customer.",
    });
  }

  await notifyOffice({
    subject: `${isScope ? "Scope mismatch" : "Prep missing"}: ${customer?.displayName ?? job.customerId} — ${label}`,
    heading: isScope
      ? "A visit's scope doesn't match the site"
      : "A visit's required prep wasn't done",
    template: isScope ? "ops-scope-mismatch" : "ops-prep-missing",
    customerId: job.customerId,
    relatedId: job.id,
    bodyHtml: `<p><strong>${technician?.name ?? "A technician"}</strong> attended <strong>${customer?.displayName ?? "this customer"}</strong> for ${job.serviceType}${job.scheduledDate ? ` on ${job.scheduledDate}` : ""} and made the honest exit: <strong>${label}</strong>${args.note?.trim() ? ` — ${args.note.trim()}` : ""}.</p>
       <p>No service was started or completed, no report filed, no new charge.${job.paidAt ? " The visit was already paid online — that money is preserved for your decision." : ""} The customer has been told we'll follow up within one business day.</p>
       <p style="margin:20px 0;"><a href="${CRM_URL()}/customers/${job.customerId}" style="background:#176b2c;color:#fff;padding:11px 20px;border-radius:8px;text-decoration:none;font-weight:600;">Open the customer</a></p>`,
  });

  return { jobId: args.jobId, status: kind, alreadyReported: false };
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
async function getDocumentUrl(
  identity: AppSyncIdentity | undefined | null,
  key: string
) {
  // reports/<cid>/…, agreements/<cid>/…, and jobs/<cid>/no-access/… (the
  // no-access door-photo evidence, GL-15 retrieval).
  const match = /^(reports|agreements|jobs)\/([^/]+)\//.exec(key);
  if (!match) throw new Error("Invalid document key");
  if (match[1] === "jobs" && !/^jobs\/[^/]+\/no-access\//.test(key)) {
    throw new Error("Invalid document key");
  }
  const customerId = match[2];
  const groups = callerGroups(identity);

  // Office/owner may pull any document. A TECH is proven against the SPECIFIC
  // document (GL-13): active technician, report personally authored or on a job
  // currently assigned to them, inside the seven-year record period; agreements
  // are never technician documents. A once-served customer no longer entitles a
  // technician to other workers' reports or every future document. The
  // customer's own portal access is unchanged.
  if (!callerIsOffice(identity)) {
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
    if (!allowed && groups.includes("TECH")) {
      allowed = await technicianDocumentAllowed(identity, key);
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

/**
 * GL-08/GL-18 — the office reached the customer another way (phone, in
 * person) and records HOW. Marks the newest matching EmailLog row
 * ALTERNATE_DELIVERED with the evidence note appended, verified by
 * read-back — settlement can then read a terminal delivery outcome. A
 * bounced row may be superseded this way; a mailbox-DELIVERED row needs no
 * alternate and is left alone.
 */
async function recordNoticeAlternateDelivery(
  args: { relatedId: string; template: string; note: string },
  actor: { sub: string | null; email: string | null }
): Promise<{ recorded: boolean; message: string }> {
  if (!args.relatedId || !args.template) {
    throw new Error("The notice's record id and template are required.");
  }
  if (!args.note.trim()) {
    throw new Error(
      "A short note is required — how was the customer actually reached?"
    );
  }
  const client = await dataClient();
  if (!("EmailLog" in client.models)) {
    throw new Error("The email log is unavailable here.");
  }
  const { data: logs } = await client.models.EmailLog.listEmailLogByRelatedId(
    { relatedId: args.relatedId },
    { limit: 50 }
  );
  const rows = (logs ?? [])
    .filter((l) => l.template === args.template)
    .sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
  const target = rows[0];
  if (!target) {
    throw new Error(
      "No send of that notice exists to mark — re-send it first (or check the template)."
    );
  }
  if (target.deliveryStatus === "DELIVERED") {
    return {
      recorded: true,
      message: "The mailbox already confirmed delivery — nothing to record.",
    };
  }
  await client.models.EmailLog.update({
    id: target.id,
    deliveryStatus: "ALTERNATE_DELIVERED",
    error: `Alternate delivery recorded by ${actor.email ?? actor.sub ?? "staff"}: ${args.note.trim()}`,
  });
  const { data: verify } = await client.models.EmailLog.get({ id: target.id });
  if (verify?.deliveryStatus !== "ALTERNATE_DELIVERED") {
    throw new Error("The alternate delivery could not be recorded — try again.");
  }
  return {
    recorded: true,
    message: "Alternate delivery recorded — the notice now reads as reached.",
  };
}
