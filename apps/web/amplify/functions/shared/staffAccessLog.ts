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
 * Best-effort on purpose, exactly like recordCustomerLifecycleEvent: by the time
 * we get here the access change itself (groups removed, login disabled + signed
 * out, jobs reassigned) is already durably applied. Failing the whole operation
 * because the audit row didn't write — and thereby inviting a re-run that
 * double-applies — is worse than a loudly-logged miss. So a write failure is
 * surfaced to the function logs, not thrown.
 */

export type StaffAccessActor = {
  sub: string | null;
  email: string | null;
};

/** CHANGE_ROLES | OFFBOARD — the named staff-access actions this ledger records. */
export type StaffAccessAction = "CHANGE_ROLES" | "OFFBOARD";

/** COMPLETE — every effect verified; PARTIAL — access was removed but a
 *  downstream effect (reassignment, deactivation) is owned by a case. */
export type StaffAccessOutcome = "COMPLETE" | "PARTIAL";

export async function recordStaffAccessEvent(input: {
  subjectEmail: string;
  subjectSub?: string | null;
  action: StaffAccessAction;
  actor: StaffAccessActor | null | undefined;
  reason?: string | null;
  /** Effective staff roles before and after — the truth read back from Cognito,
   *  not merely what was requested. */
  priorRoles?: string[] | null;
  newRoles?: string[] | null;
  /** Human-readable summary of the login/session result, linked technician
   *  state, and reassigned/in-progress work. */
  effects?: string | null;
  outcome: StaffAccessOutcome;
}): Promise<void> {
  try {
    const client = await dataClient();
    await client.models.StaffAccessEvent.create({
      subjectEmail: input.subjectEmail,
      subjectSub: input.subjectSub ?? undefined,
      action: input.action,
      actorSub: input.actor?.sub ?? undefined,
      // An actor is always expected on an owner-initiated action; "system" marks
      // the rare path with no verified identity so the row is never blank.
      actorEmail: input.actor?.email ?? "system",
      reason: input.reason ?? undefined,
      priorRoles: (input.priorRoles ?? []).join(", ") || undefined,
      newRoles: (input.newRoles ?? []).join(", ") || undefined,
      effects: input.effects ?? undefined,
      outcome: input.outcome,
      occurredAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error(
      `Failed to record staff access event (${input.action} on ${input.subjectEmail}) — the access change itself was applied; the audit row was not`,
      err
    );
  }
}
