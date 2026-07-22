import { dataClient } from "./dataClient";
import { casGuardedUpdate } from "./atomicLock";
import { openOwnedWork } from "./ownedWork";

/**
 * GL-17 — the monthly treatment obligations of a seasonal plan. One row per
 * in-season calendar month, id = `<servicePlanId>#<YYYY-MM>` so creation is
 * naturally idempotent (conditional create; a conflict adopts the row).
 * Status flow: DUE → SCHEDULED → SATISFIED, or → SKIPPED_WEATHER (visibly
 * rescheduled/delayed) / SKIPPED_MISSED (month passed unserved — durable
 * history that, per the locked rule, creates NO catch-up visit).
 *
 * Two hard rules this module enforces:
 *  - A ledger WRITE FAILURE is owned, never swallowed: the customer's promise
 *    ("one treatment each month in season") exists whether or not the
 *    bookkeeping landed, so a failed create/advance opens OBLIGATION_RECOVERY
 *    work instead of returning quietly.
 *  - AT MOST ONE scheduled-or-done visit per plan-month, enforced ATOMICALLY:
 *    the obligation row is the month's mutex. Claiming a month is a
 *    conditional create (status SCHEDULED) or ONE guarded update DUE →
 *    SCHEDULED; two concurrent schedulers cannot both pass a read-then-write
 *    check, because there is no read-then-write — the condition is evaluated
 *    server-side in the same write.
 */

export type ObligationStatus =
  | "DUE"
  | "SCHEDULED"
  | "SATISFIED"
  | "SKIPPED_WEATHER"
  | "SKIPPED_MISSED";

export function obligationId(servicePlanId: string, monthKey: string): string {
  return `${servicePlanId}#${monthKey}`;
}

/** A ledger write failed — own it. The dedupe key collapses repeated failures
 *  for the same plan-month into one case. */
async function ownLedgerFailure(
  servicePlanId: string,
  monthKey: string,
  what: string,
  customerId?: string | null
): Promise<void> {
  await openOwnedWork({
    kind: "OBLIGATION_RECOVERY",
    dedupeKey: `obligation:${servicePlanId}#${monthKey}`,
    title: `A seasonal plan's monthly-treatment record failed to write (${monthKey})`,
    detail: `${what} for plan ${servicePlanId}, month ${monthKey}. The plan's promised-visit ledger is out of step with reality until this is corrected.`,
    customerId: customerId ?? undefined,
    relatedId: obligationId(servicePlanId, monthKey),
    sourceUrl: customerId ? `/customers/${customerId}` : "/work",
    resolutionAction:
      "Open the plan, confirm what actually happened this month (visit scheduled/completed/none), and correct the month's obligation record to match.",
    ownerTeam: "OPS",
  }).catch((err) =>
    console.error("ownLedgerFailure could not open work", servicePlanId, monthKey, err)
  );
}

/** Create the month's obligation if absent; returns the current status either
 *  way. Never throws — but a write failure is OWNED (OBLIGATION_RECOVERY),
 *  never silent bookkeeping loss. */
export async function ensureObligation(input: {
  servicePlanId: string;
  customerId?: string | null;
  monthKey: string;
  status?: ObligationStatus;
  jobId?: string | null;
  note?: string | null;
  accessGroups?: string[];
}): Promise<{ status: ObligationStatus | null; created: boolean }> {
  try {
    const client = await dataClient();
    if (!("TreatmentObligation" in client.models)) {
      return { status: null, created: false };
    }
    const id = obligationId(input.servicePlanId, input.monthKey);
    const { data: created } = await client.models.TreatmentObligation.create({
      id,
      servicePlanId: input.servicePlanId,
      customerId: input.customerId ?? undefined,
      monthKey: input.monthKey,
      status: input.status ?? "DUE",
      jobId: input.jobId ?? undefined,
      note: input.note ?? undefined,
      accessGroups: input.accessGroups ?? undefined,
    });
    if (created) return { status: (created.status as ObligationStatus) ?? null, created: true };
    const { data: existing } = await client.models.TreatmentObligation.get({ id });
    if (!existing) {
      // Neither created nor readable — the month has NO ledger row. Owned.
      await ownLedgerFailure(
        input.servicePlanId,
        input.monthKey,
        "The month's obligation row could not be created or read back",
        input.customerId
      );
      return { status: null, created: false };
    }
    return {
      status: ((existing.status ?? null) as ObligationStatus | null),
      created: false,
    };
  } catch (err) {
    console.error("ensureObligation failed", input.servicePlanId, input.monthKey, err);
    await ownLedgerFailure(
      input.servicePlanId,
      input.monthKey,
      `The month's obligation row could not be created (${err instanceof Error ? err.message : String(err)})`,
      input.customerId
    );
    return { status: null, created: false };
  }
}

/** Advance an obligation's status. SATISFIED is terminal (a satisfied month is
 *  never un-satisfied by a later event); SKIPPED_* never overwrites SATISFIED.
 *  A failed advance is OWNED, never a silently-false ledger. */
export async function markObligation(input: {
  servicePlanId: string;
  monthKey: string;
  status: ObligationStatus;
  jobId?: string | null;
  note?: string | null;
  customerId?: string | null;
}): Promise<boolean> {
  try {
    const client = await dataClient();
    if (!("TreatmentObligation" in client.models)) return false;
    const id = obligationId(input.servicePlanId, input.monthKey);
    const { data: existing } = await client.models.TreatmentObligation.get({ id });
    if (!existing) {
      const { data: created } = await client.models.TreatmentObligation.create({
        id,
        servicePlanId: input.servicePlanId,
        monthKey: input.monthKey,
        status: input.status,
        jobId: input.jobId ?? undefined,
        note: input.note ?? undefined,
      });
      if (!created) {
        await ownLedgerFailure(
          input.servicePlanId,
          input.monthKey,
          `The month's obligation could not be recorded as ${input.status}`,
          input.customerId
        );
        return false;
      }
      return true;
    }
    if (existing.status === "SATISFIED" && input.status !== "SATISFIED") {
      return true; // terminal — a later skip/schedule cannot regress it
    }
    const { data: updated } = await client.models.TreatmentObligation.update({
      id,
      status: input.status,
      jobId: input.jobId ?? existing.jobId ?? undefined,
      note: input.note ?? existing.note ?? undefined,
    });
    if (!updated) {
      await ownLedgerFailure(
        input.servicePlanId,
        input.monthKey,
        `The month's obligation could not be advanced to ${input.status}`,
        input.customerId
      );
      return false;
    }
    return true;
  } catch (err) {
    console.error("markObligation failed", input.servicePlanId, input.monthKey, err);
    await ownLedgerFailure(
      input.servicePlanId,
      input.monthKey,
      `The month's obligation could not be advanced to ${input.status} (${err instanceof Error ? err.message : String(err)})`,
      input.customerId
    );
    return false;
  }
}

export type MonthClaimOutcome =
  /** This job now holds the month — the visit may be created/scheduled. */
  | { ok: true }
  /** The month already has this very job — an idempotent re-run. */
  | { ok: true; alreadyThisJob: true }
  /** The month is taken (another scheduled visit, or already satisfied). */
  | {
      ok: false;
      status: ObligationStatus | null;
      holderJobId: string | null;
      /** True when the ledger/CAS was UNAVAILABLE (fail closed) rather than
       *  the month being genuinely taken. */
      unavailable?: boolean;
    };

/**
 * GL-17 — atomically claim a seasonal plan-month for ONE visit. The obligation
 * row is the mutex: either the conditional create wins (row born SCHEDULED
 * with this job), or ONE guarded update advances DUE → SCHEDULED. A month
 * already SCHEDULED for another job or SATISFIED refuses — checking only
 * SATISFIED would let two scheduled visits share a month, which is exactly
 * the double-treatment the locked rule forbids.
 */
export async function claimMonthForJob(input: {
  servicePlanId: string;
  monthKey: string;
  jobId: string;
  customerId?: string | null;
  accessGroups?: string[];
}): Promise<MonthClaimOutcome> {
  const client = await dataClient();
  // FAIL CLOSED: without the obligation ledger there is no month mutex — a
  // seasonal visit must not be scheduled on hope of exclusivity.
  if (!("TreatmentObligation" in client.models)) {
    return {
      ok: false,
      status: null,
      holderJobId: null,
      unavailable: true,
    };
  }
  const id = obligationId(input.servicePlanId, input.monthKey);

  const { data: created } = await client.models.TreatmentObligation.create({
    id,
    servicePlanId: input.servicePlanId,
    customerId: input.customerId ?? undefined,
    monthKey: input.monthKey,
    status: "SCHEDULED",
    jobId: input.jobId,
    accessGroups: input.accessGroups ?? undefined,
  });
  if (created) return { ok: true };

  // The row exists. ONE guarded update: DUE → SCHEDULED with this job, or
  // adopt when the month already belongs to this very job (idempotent re-run).
  const guarded = await casGuardedUpdate(
    "TreatmentObligation",
    id,
    { status: "SCHEDULED", jobId: input.jobId },
    [{ kind: "fieldEquals", field: "status", value: "DUE" }]
  );
  if (guarded.ok) return { ok: true };

  const { data: existing } = await client.models.TreatmentObligation.get({ id });
  if (existing?.jobId === input.jobId && existing.status === "SCHEDULED") {
    return { ok: true, alreadyThisJob: true };
  }
  if (!guarded.ok && guarded.reason === "UNSUPPORTED") {
    // FAIL CLOSED: without CAS the DUE → SCHEDULED transition is a
    // read-then-write race two schedulers can both pass — refuse instead.
    return {
      ok: false,
      status: ((existing?.status ?? null) as ObligationStatus | null),
      holderJobId: existing?.jobId ?? null,
      unavailable: true,
    };
  }
  return {
    ok: false,
    status: ((existing?.status ?? null) as ObligationStatus | null),
    holderJobId: existing?.jobId ?? null,
  };
}

/**
 * Release a month a job no longer serves (canceled, or rescheduled into a
 * different month): ONE guarded update SCHEDULED → DUE, conditioned on the
 * month still belonging to THIS job — it can never release a month a
 * different visit legitimately holds, and never regresses SATISFIED.
 */
export async function releaseMonthForJob(input: {
  servicePlanId: string;
  monthKey: string;
  jobId: string;
  note?: string | null;
}): Promise<void> {
  const client = await dataClient();
  if (!("TreatmentObligation" in client.models)) return;
  const id = obligationId(input.servicePlanId, input.monthKey);
  const guarded = await casGuardedUpdate(
    "TreatmentObligation",
    id,
    { status: "DUE", jobId: null, ...(input.note ? { note: input.note } : {}) },
    [
      { kind: "fieldEquals", field: "status", value: "SCHEDULED" },
      { kind: "fieldEquals", field: "jobId", value: input.jobId },
    ]
  );
  if (guarded.ok) return;
  // FAIL CLOSED on UNSUPPORTED too: an unguarded release could clobber a
  // month a different visit just claimed. A held month that should have been
  // released is the safe error (no double-booking); the daily obligation
  // sweep and the office ledger correction own the leftover.
}
