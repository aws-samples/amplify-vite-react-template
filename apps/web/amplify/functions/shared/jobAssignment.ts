import type { AppSyncIdentity } from "aws-lambda";
import { callerIsOffice, callerSub } from "./authz";
import { assertTechnicianCompliance } from "./compliance";
import { dataClient } from "./dataClient";

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
  assertTechnicianCompliance(tech, {
    requireActive: true,
    workDate: job.scheduledDate ?? undefined,
  });
}

/**
 * Prove the caller may READ this job right now — the row-scoping half of GL-13.
 *
 * Same shape as assertCanActOnJob, minus the active-licence requirement: viewing
 * one's own assigned or completed work is not applying pesticide, so a technician
 * whose credential has lapsed can still review their record even though they can
 * no longer act on it. Office/owner always may. A technician may read only a job
 * currently assigned to their own linked record, so a reassignment removes the
 * former technician's read on the very next fetch, and a known job id belonging
 * to another technician yields the same opaque refusal as a missing one.
 */
export async function assertCanReadJob(
  identity: AppSyncIdentity | undefined | null,
  job: JobAssignment | null | undefined
): Promise<void> {
  if (callerIsOffice(identity)) return;
  if (!job) throw new Error(NOT_AUTHORIZED_JOB);
  const tech = await technicianForCaller(identity);
  if (!tech) throw new Error(UNLINKED_TECHNICIAN);
  if (!job.technicianId || job.technicianId !== tech.id) {
    throw new Error(NOT_AUTHORIZED_JOB);
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

/**
 * A technician may pull a customer's document links only for a customer they
 * actually serve — i.e. one they have (or had) an assigned job for. Office/owner
 * and the customer's own portal access are handled by the caller; this is the
 * technician-scoping half of GL-13's "cannot obtain document links for another
 * technician's customer".
 */
export async function technicianServesCustomer(
  identity: AppSyncIdentity | undefined | null,
  customerId: string
): Promise<boolean> {
  const tech = await technicianForCaller(identity);
  if (!tech) return false;
  const client = await dataClient();
  const { data } = await client.models.Job.list({
    filter: {
      customerId: { eq: customerId },
      technicianId: { eq: tech.id },
    },
    limit: 1,
  });
  return data.length > 0;
}
