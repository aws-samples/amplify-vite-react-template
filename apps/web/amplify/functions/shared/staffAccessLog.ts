import { dataClient } from "./dataClient";

/**
 * The staff-access audit trail (GL-14).
 *
 * A role change or an offboarding moves who can sign in, what they can do, and
 * — for a technician — what work is theirs, all at once. Leadership must be able
 * to answer "who changed this access, when, why, and what work moved" without
 * engineering pulling Cognito logs. That history lives in the append-only
 * StaffAccessEvent model — one immutable row per action, OWNER-read-only in the
 * browser, written only here from a Lambda authenticating as IAM.
 *
 * The write is a REQUIRED durable outcome, not best-effort (GL-14 / X1): the one
 * record that proves a sensitive access change must not be allowed to silently
 * not exist. recordStaffAccessEvent returns whether the row was written, and the
 * caller treats a miss as a partial result — opening an owned STAFF_SECURITY case
 * so a human reconstructs the record — rather than reporting a clean success.
 */

export type StaffAccessActor = {
  sub: string | null;
  email: string | null;
};

/** CHANGE_ROLES | OFFBOARD — the named staff-access actions this ledger records. */
export type StaffAccessAction = "CHANGE_ROLES" | "OFFBOARD";

/** COMPLETE — every effect verified; PARTIAL — access was removed but a
 *  downstream effect (reassignment, deactivation, or the audit write) is owned
 *  by a case. */
export type StaffAccessOutcome = "COMPLETE" | "PARTIAL";

export type StaffAccessEventInput = {
  subjectEmail: string;
  subjectSub?: string | null;
  action: StaffAccessAction;
  actor: StaffAccessActor | null | undefined;
  /** The approved controlled reason code (never blank on a real change). */
  reasonCode?: string | null;
  reason?: string | null;
  /** Effective staff roles before and after — the truth read back from Cognito,
   *  not merely what was requested. */
  priorRoles?: string[] | null;
  /** What the actor asked for, recorded alongside the verified newRoles. */
  requestedRoles?: string[] | null;
  newRoles?: string[] | null;
  /** Caller idempotency/version key, so a replay can be recognized. */
  idempotencyKey?: string | null;
  /** Human-readable summary of the login/session result, linked technician
   *  state, and reassigned/in-progress work. */
  effects?: string | null;
  outcome: StaffAccessOutcome;
};

/**
 * Write one immutable audit row. Returns true if the row was durably written,
 * false if it could not be — the caller must not report a clean success on
 * false. Unlike the best-effort lifecycle log, a failure here is a real gap the
 * caller is expected to own.
 */
export async function recordStaffAccessEvent(
  input: StaffAccessEventInput
): Promise<boolean> {
  try {
    const client = await dataClient();
    const { data, errors } = await client.models.StaffAccessEvent.create({
      subjectEmail: input.subjectEmail,
      subjectSub: input.subjectSub ?? undefined,
      action: input.action,
      actorSub: input.actor?.sub ?? undefined,
      // An actor is always expected on an owner-initiated action; "system" marks
      // the rare path with no verified identity so the row is never blank.
      actorEmail: input.actor?.email ?? "system",
      reasonCode: input.reasonCode ?? undefined,
      reason: input.reason ?? undefined,
      priorRoles: (input.priorRoles ?? []).join(", ") || undefined,
      requestedRoles: (input.requestedRoles ?? []).join(", ") || undefined,
      newRoles: (input.newRoles ?? []).join(", ") || undefined,
      idempotencyKey: input.idempotencyKey ?? undefined,
      effects: input.effects ?? undefined,
      outcome: input.outcome,
      occurredAt: new Date().toISOString(),
    });
    if (!data) {
      console.error(
        `Staff access event write returned no row (${input.action} on ${input.subjectEmail}): ${errors?.map((e) => e.message).join("; ") ?? "unknown"}`
      );
      return false;
    }
    return true;
  } catch (err) {
    console.error(
      `Failed to record staff access event (${input.action} on ${input.subjectEmail})`,
      err
    );
    return false;
  }
}

/**
 * Has an action with this idempotency key already been recorded? Returns the
 * prior row's stored fields so a replay can return the original outcome instead
 * of applying a second change. Best-effort: a lookup failure returns null and
 * the action proceeds (at-least-once), which the Cognito/Stripe-style idempotent
 * steps below tolerate.
 */
export async function findStaffAccessEventByKey(
  idempotencyKey: string
): Promise<{ outcome: string; effects: string | null } | null> {
  const key = idempotencyKey.trim();
  if (!key) return null;
  try {
    const client = await dataClient();
    const { data } = await client.models.StaffAccessEvent.listStaffAccessEventByIdempotencyKey(
      { idempotencyKey: key },
      { limit: 1 }
    );
    const row = data?.[0];
    if (!row) return null;
    return { outcome: String(row.outcome), effects: row.effects ?? null };
  } catch (err) {
    console.error(`Staff access idempotency lookup failed for ${key}`, err);
    return null;
  }
}
