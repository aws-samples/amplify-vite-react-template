import { dataClient } from "./dataClient";

/**
 * GL-17 — the monthly treatment obligations of a seasonal plan. One row per
 * in-season calendar month, id = `<servicePlanId>#<YYYY-MM>` so creation is
 * naturally idempotent (conditional create; a conflict adopts the row).
 * Status flow: DUE → SCHEDULED → SATISFIED, or → SKIPPED_WEATHER (visibly
 * rescheduled/delayed) / SKIPPED_MISSED (month passed unserved — durable
 * history that, per the locked rule, creates NO catch-up visit).
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

/** Create the month's obligation if absent; returns the current status either
 *  way. Never throws — obligations are bookkeeping the caller must not die on. */
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
    return {
      status: ((existing?.status ?? null) as ObligationStatus | null),
      created: false,
    };
  } catch (err) {
    console.error("ensureObligation failed", input.servicePlanId, input.monthKey, err);
    return { status: null, created: false };
  }
}

/** Advance an obligation's status. SATISFIED is terminal (a satisfied month is
 *  never un-satisfied by a later event); SKIPPED_* never overwrites SATISFIED. */
export async function markObligation(input: {
  servicePlanId: string;
  monthKey: string;
  status: ObligationStatus;
  jobId?: string | null;
  note?: string | null;
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
      return Boolean(created);
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
    return Boolean(updated);
  } catch (err) {
    console.error("markObligation failed", input.servicePlanId, input.monthKey, err);
    return false;
  }
}
