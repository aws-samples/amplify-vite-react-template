import type { AppSyncIdentity } from "aws-lambda";
import { callerIsOffice, callerSub } from "./authz";
import { assertTechnicianCompliance, hasCurrentLicense } from "./compliance";
import { licenseFactsFor } from "./licenses";
import { dataClient } from "./dataClient";
import { openOwnedWork } from "./ownedWork";

/**
 * GL-13 — technician least-privilege and assignment enforcement.
 *
 * The field-action mutations used to gate on `isStaff` alone: knowing a job or
 * report id was enough for any technician to start, end, report, finalize, or
 * pull photos on another technician's regulated work. This module is the single
 * server-side proof that the signed-in identity is the job's *current* assignee
 * (or office/owner), evaluated fresh on every action so a reassignment takes
 * effect immediately.
 *
 * Every refusal is the same opaque message whether the job is missing, assigned
 * to someone else, or the caller is an unlinked login — a known id must never
 * be enough to confirm, or act on, another technician's work.
 */

const NOT_AUTHORIZED_JOB = "Not authorized for this job";
const NOT_AUTHORIZED_REPORT = "Not authorized for this report";
// A TECH login nobody linked to a Technician record. This names the caller's
// own account state, not anything about the job, so it is safe to be specific:
// it leaks nothing about which jobs or reports exist.
const UNLINKED_TECHNICIAN =
  "Your login isn't linked to a technician record — ask the office to link it before acting on this job";

type LinkedTechnician = {
  id: string;
  name?: string | null;
  active?: boolean | null;
  licenseNumber?: string | null;
  licenseExpiresOn?: string | null;
  userSub?: string | null;
};

type JobAssignment = {
  id: string;
  technicianId?: string | null;
  scheduledDate?: string | null;
  status?: string | null;
};

/**
 * The Technician record linked to the signed-in Cognito user, or null when the
 * caller is not a linked technician (office staff, or a login nobody linked).
 * Matches the by-userSub lookup the report writer already uses.
 */
export async function technicianForCaller(
  identity: AppSyncIdentity | undefined | null
): Promise<LinkedTechnician | null> {
  const sub = callerSub(identity);
  if (!sub) return null;
  const client = await dataClient();
  const { data } = await client.models.Technician.list({ limit: 200 });
  return (data as LinkedTechnician[]).find((t) => t.userSub === sub) ?? null;
}

/**
 * Prove the caller may act on THIS job right now.
 *
 * OFFICE/OWNER always may — office scheduling and owner emergency access, both
 * carried on the verified Cognito token and audited by each action's own record.
 * A TECH may act only on a job currently assigned to their own linked
 * Technician record, and only while their applicator credential is active and
 * unexpired: an assignment is not authority to apply pesticide on a lapsed
 * licence. Anyone else — FINANCE, an unlinked login, a technician who is not the
 * assignee — is refused.
 */
export async function assertCanActOnJob(
  identity: AppSyncIdentity | undefined | null,
  job: JobAssignment | null | undefined
): Promise<void> {
  // Office/owner: audited emergency + scheduling access, no field credential
  // required (they are not the applicator).
  if (callerIsOffice(identity)) return;

  if (!job) throw new Error(NOT_AUTHORIZED_JOB);
  const tech = await technicianForCaller(identity);
  // An unlinked login gets its own account-state message (no job-info leak);
  // a linked technician who is not the assignee gets the opaque refusal, so a
  // known job id cannot confirm another technician's assignment.
  if (!tech) throw new Error(UNLINKED_TECHNICIAN);
  if (!job.technicianId || job.technicianId !== tech.id) {
    throw new Error(NOT_AUTHORIZED_JOB);
  }
  // The caller IS the assignee — from here, surfacing the real reason leaks
  // nothing. Active-credential requirement: the assignee must still be a
  // current applicator to touch a regulated job, judged against the visit date.
  // GL-17: licence currency comes from the one-to-many licence records (legacy
  // single fields only for technicians with no records yet).
  if (!tech.active) {
    throw new Error(`${tech.name ?? "This technician"} is inactive and cannot be assigned regulated work`);
  }
  const licenseFacts = await licenseFactsFor(tech, job.scheduledDate ?? undefined);
  if (!licenseFacts.current) {
    if (licenseFacts.source === "LEGACY") {
      // No records yet — the legacy single-field check names exactly which
      // fact is missing/expired (better fix-it message than a generic one).
      assertTechnicianCompliance(tech, {
        requireActive: true,
        workDate: job.scheduledDate ?? undefined,
      });
    }
    throw new Error(
      `${tech.name ?? "This technician"} has no current applicator licence on record for ${job.scheduledDate ?? "today"} — ask the office to record a current licence before acting on regulated work`
    );
  }
}

/**
 * Prove the caller may READ this job right now — the row-scoping half of GL-13.
 *
 * Office/owner always may. A technician may read only a job currently assigned
 * to their own linked record, so a reassignment removes the former technician's
 * read on the very next fetch, and a known job id belonging to another
 * technician yields the same opaque refusal as a missing one. Two employment
 * boundaries on top of assignment:
 *
 *  - An INACTIVE (offboarded/deactivated) technician receives no field data at
 *    all, even while an already-issued access token is still unexpired — the
 *    code layer, not only the sign-out, ends their reads.
 *  - An employed technician with NO current licence may review only COMPLETED
 *    work they personally performed (the assignee check above is the
 *    personally-performed proof). Current or future work — the thing they can
 *    no longer be dispatched to — is refused with the same opaque message.
 */
export async function assertCanReadJob(
  identity: AppSyncIdentity | undefined | null,
  job: JobAssignment | null | undefined
): Promise<void> {
  if (callerIsOffice(identity)) return;
  if (!job) throw new Error(NOT_AUTHORIZED_JOB);
  const tech = await technicianForCaller(identity);
  if (!tech) throw new Error(UNLINKED_TECHNICIAN);
  if (!tech.active) throw new Error(NOT_AUTHORIZED_JOB);
  if (!job.technicianId || job.technicianId !== tech.id) {
    throw new Error(NOT_AUTHORIZED_JOB);
  }
  if (job.status !== "COMPLETED") {
    const facts = await licenseFactsFor(tech);
    if (!facts.current) throw new Error(NOT_AUTHORIZED_JOB);
  }
}

/** Same proof, fetching the job by id first (dispatch-layer convenience). */
export async function assertCanActOnJobId(
  identity: AppSyncIdentity | undefined | null,
  jobId: string
): Promise<void> {
  const client = await dataClient();
  const { data: job } = await client.models.Job.get({ id: jobId });
  await assertCanActOnJob(identity, job);
}

/**
 * Same proof for a report-scoped action: the caller must be able to act on the
 * job the report belongs to. A missing report is the opaque report-level
 * refusal, so a report id is no more probeable than a job id.
 */
export async function assertCanActOnReportId(
  identity: AppSyncIdentity | undefined | null,
  reportId: string
): Promise<void> {
  const client = await dataClient();
  const { data: report } = await client.models.ServiceReport.get({
    id: reportId,
  });
  if (!report) {
    // Office/owner get the precise error; a non-office caller cannot tell a
    // missing report from someone else's.
    if (callerIsOffice(identity)) throw new Error(`Report ${reportId} not found`);
    throw new Error(NOT_AUTHORIZED_REPORT);
  }
  // Delegate to the job proof and let it speak: a non-assignee gets the opaque
  // refusal, but the assignee's real credential/linkage errors surface intact
  // (they own the job, so there is nothing to hide from them).
  await assertCanActOnJobId(identity, report.jobId);
}

/** The business record-retention period (locked rule: seven years). A document
 *  older than this is outside every technician's historical scope. */
const RECORD_RETENTION_YEARS = 7;

/**
 * GL-13 — the per-DOCUMENT proof for a technician's document link.
 *
 * The old rule ("ever had a job for this customer") entitled a technician to
 * every report, photo, agreement, and future document for a once-served
 * customer, forever. This proves the specific document instead:
 *
 *  - The caller must be an ACTIVE linked technician (an offboarded login gets
 *    nothing, even before its token expires).
 *  - `agreements/…` keys are refused outright — a customer's signed contract is
 *    office/portal material the field never needs.
 *  - A report PDF or report photo is allowed only when the underlying
 *    ServiceReport was personally authored by the caller, OR belongs to a job
 *    CURRENTLY assigned to the caller with a current licence (their live work
 *    context). Another technician's report at a shared customer is refused.
 *  - The report must fall inside the approved seven-year record period.
 *
 * Amendment PDFs never match a ServiceReport row here, so they stay office/
 * portal-only — the tech app does not display them.
 */
export async function technicianDocumentAllowed(
  identity: AppSyncIdentity | undefined | null,
  key: string
): Promise<boolean> {
  const tech = await technicianForCaller(identity);
  if (!tech || !tech.active) return false;

  const client = await dataClient();
  type ReportRow = {
    id: string;
    jobId?: string | null;
    technicianId?: string | null;
    serviceDate?: string | null;
    pdfKey?: string | null;
    photoKeys?: (string | null)[] | null;
  };
  let report: ReportRow | null = null;

  const photoMatch = /^reports\/[^/]+\/photos\/([^/]+)\//.exec(key);
  if (photoMatch) {
    const { data } = await client.models.ServiceReport.get({
      id: photoMatch[1],
    });
    report = (data as ReportRow | null) ?? null;
  } else if (key.startsWith("reports/")) {
    // A report PDF: find the row whose pdfKey is exactly this key. There is no
    // key index, so page the customer's reports (bounded by one customer).
    const customerId = key.split("/")[1];
    let token: string | null | undefined;
    do {
      const page = await client.models.ServiceReport.list({
        filter: { customerId: { eq: customerId } },
        limit: 200,
        nextToken: token,
      });
      report =
        ((page.data as ReportRow[]) ?? []).find(
          (r) => r.pdfKey === key || (r.photoKeys ?? []).includes(key)
        ) ?? null;
      token = report ? null : page.nextToken;
    } while (token);
  } else {
    // agreements/ and anything else: never a technician document.
    return false;
  }
  if (!report) return false;

  // Seven-year historical bound.
  if (report.serviceDate) {
    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - RECORD_RETENTION_YEARS);
    if (new Date(report.serviceDate).valueOf() < cutoff.valueOf()) return false;
  }

  // Personally authored — their own record, reviewable while employed.
  if (report.technicianId && report.technicianId === tech.id) return true;

  // Live work context: the report's job is currently assigned to the caller and
  // they hold a current licence (an unlicensed tech gets no new customer
  // context, only their own history).
  if (report.jobId && (await licenseFactsFor(tech)).current) {
    const { data: job } = await client.models.Job.get({
      id: String(report.jobId),
    });
    if (job?.technicianId === tech.id) return true;
  }
  return false;
}

/**
 * GL-13 — when a visit leaves its technician (unassign, cancel, date move,
 * assignment to someone else, or an offboarding sweep) while that technician
 * has an unsent DRAFT report, the draft gets a recorded disposition: an owned
 * office-review case. Returns the disposition string for the audit row and
 * whether every case write was confirmed. The draft itself is never silently
 * reused as another applicator's words.
 */
export async function disposeStaleDrafts(
  jobId: string,
  priorTechnicianId: string | null,
  newTechnicianId: string | null
): Promise<{ draftDisposition: string; caseConfirmed: boolean }> {
  if (!priorTechnicianId || priorTechnicianId === newTechnicianId) {
    return { draftDisposition: "NONE", caseConfirmed: true };
  }
  try {
    const client = await dataClient();
    const { data: reports } =
      await client.models.ServiceReport.listServiceReportByJobId({ jobId });
    const drafts = (reports ?? []).filter(
      (r) => r.status === "DRAFT" && r.technicianId === priorTechnicianId
    );
    if (drafts.length === 0) {
      return { draftDisposition: "NONE", caseConfirmed: true };
    }
    let caseConfirmed = true;
    for (const d of drafts) {
      const opened = await openOwnedWork({
        kind: "STALE_DRAFT",
        dedupeKey: `stale-draft:${d.id}`,
        title: "A reassigned visit has the former technician's unsent draft report",
        detail: `Visit ${jobId} moved off technician ${priorTechnicianId} while draft report ${d.id} was unsent. Decide its disposition — the new technician files their own report; the draft is never silently reused as another applicator's words.`,
        relatedId: d.id,
        sourceUrl: "/work",
        resolutionAction:
          "Open the draft, decide whether the new technician re-files, the office completes the record, or the draft is discarded, and close this with the matching reason.",
        ownerTeam: "OPS",
      });
      if (!opened) caseConfirmed = false;
    }
    return { draftDisposition: "OFFICE_REVIEW", caseConfirmed };
  } catch (err) {
    console.error("disposeStaleDrafts failed", jobId, err);
    return { draftDisposition: "UNKNOWN", caseConfirmed: false };
  }
}
