import { randomUUID } from "node:crypto";
import { dataClient } from "./dataClient";
import type { StaffAccessActor } from "./staffAccessLog";

/**
 * GL-14 — the durable staff access-change command.
 *
 * Every role change and offboarding starts by CLAIMING one of these — a
 * conditional create keyed by the caller's idempotency key — BEFORE any
 * Cognito, work, or lead change. That ordering is the requirement: the durable
 * record of "who asked for what, why, from which prior state" exists before the
 * first provider effect, so a process stop can never leave an unrecorded
 * partial change, and a concurrent duplicate submission loses the create and is
 * handed the same persisted progress/outcome instead of starting a second
 * change.
 *
 * The command carries an exclusive resume lease (leaseUntil + leaseNonce). A
 * retry of a stuck command may take over only after the lease expires, and the
 * takeover is verified by reading the nonce back — so two stale-claim reclaims
 * cannot both believe they own the resume. Terminal commands are never deleted:
 * the row IS the persisted outcome the screens read back.
 */

export type StaffCommandStage =
  | "REQUESTED"
  | "VALIDATED"
  | "ACCESS_DONE"
  | "HANDOFF_DONE"
  | "COMPLETE"
  | "PARTIAL"
  | "FAILED";

/** COMPLETE and FAILED are settled: a duplicate is handed the recorded outcome.
 *  PARTIAL is deliberately NOT terminal here — its whole point is that the same
 *  key can RESUME it (the finish write clears the lease, so a resume reclaims
 *  immediately and re-drives only what is still missing). */
const TERMINAL_STAGES: StaffCommandStage[] = ["COMPLETE", "FAILED"];

/** How long one attempt may hold the resume lease. Generous versus the Lambda
 *  timeout so a live attempt is never raced by an impatient retry. */
const LEASE_MS = 5 * 60_000;

export type StaffCommandRow = {
  id: string;
  action: string;
  subjectEmail: string;
  subjectSub?: string | null;
  stage: string;
  outcome?: string | null;
  effects?: string | null;
  lastError?: string | null;
  attemptCount?: number | null;
  resultJson?: unknown;
};

export type ClaimResult =
  | { claimed: true; resumedFromStage: StaffCommandStage | null; attempt: number }
  | { claimed: false; state: "IN_FLIGHT"; command: StaffCommandRow }
  | { claimed: false; state: "DONE"; command: StaffCommandRow };

type ClaimInput = {
  idempotencyKey: string;
  action: "CHANGE_ROLES" | "OFFBOARD";
  subjectEmail: string;
  actor: StaffAccessActor;
  reasonCode: string;
  reason?: string | null;
  requestedRoles?: string[] | null;
};

function isTerminal(stage: string | null | undefined): boolean {
  return TERMINAL_STAGES.includes((stage ?? "") as StaffCommandStage);
}

/**
 * Claim the command for this idempotency key, creating it if it does not
 * exist. Exactly one caller wins; the rest see the persisted state:
 *  - DONE       — a terminal outcome already exists; return it, change nothing.
 *  - IN_FLIGHT  — another attempt holds a live lease; do not act.
 *  - claimed    — this caller owns the (new or stale-reclaimed) command.
 *
 * A stale reclaim (lease expired, non-terminal stage) deletes the old row and
 * conditionally re-creates it carrying the prior stage forward, then verifies
 * its own nonce read back — the conditional create makes exactly one reclaimer
 * win, and the nonce read-back catches the losing delete/create interleave.
 */
export async function claimStaffAccessCommand(
  input: ClaimInput
): Promise<ClaimResult> {
  const id = input.idempotencyKey.trim();
  if (!id) throw new Error("An idempotency key is required");
  const client = await dataClient();
  const nonce = randomUUID();
  const now = Date.now();

  const fields = {
    action: input.action,
    subjectEmail: input.subjectEmail.trim().toLowerCase(),
    actorSub: input.actor.sub ?? undefined,
    actorEmail: input.actor.email ?? "system",
    reasonCode: input.reasonCode,
    reason: input.reason ?? undefined,
    requestedRoles: (input.requestedRoles ?? []).join(", ") || undefined,
    leaseUntil: new Date(now + LEASE_MS).toISOString(),
    leaseNonce: nonce,
  };

  const { data: created } = await client.models.StaffAccessCommand.create({
    id,
    ...fields,
    stage: "REQUESTED",
    requestedAt: new Date(now).toISOString(),
    attemptCount: 1,
  });
  if (created) {
    return { claimed: true, resumedFromStage: null, attempt: 1 };
  }

  // Lost the create — someone else holds (or held) this key. Read the truth.
  const { data: existing } = await client.models.StaffAccessCommand.get({ id });
  if (!existing) {
    // Extremely narrow window (row deleted between create and get). Treat as
    // in-flight; the caller reports "try again" rather than acting blind.
    return {
      claimed: false,
      state: "IN_FLIGHT",
      command: {
        id,
        action: input.action,
        subjectEmail: fields.subjectEmail,
        stage: "REQUESTED",
      },
    };
  }
  const row: StaffCommandRow = {
    id: existing.id,
    action: existing.action,
    subjectEmail: existing.subjectEmail,
    subjectSub: existing.subjectSub,
    stage: existing.stage,
    outcome: existing.outcome,
    effects: existing.effects,
    lastError: existing.lastError,
    attemptCount: existing.attemptCount,
    resultJson: existing.resultJson,
  };
  if (isTerminal(existing.stage)) {
    return { claimed: false, state: "DONE", command: row };
  }
  const leaseLive =
    existing.leaseUntil && Date.parse(existing.leaseUntil) > now;
  if (leaseLive) {
    return { claimed: false, state: "IN_FLIGHT", command: row };
  }

  // Stale, non-terminal command: reclaim it. Delete + conditional create keeps
  // exactly one winner; carrying the stage forward keeps the resume honest.
  const priorStage = (existing.stage as StaffCommandStage) ?? "REQUESTED";
  const attempt = (existing.attemptCount ?? 1) + 1;
  await client.models.StaffAccessCommand.delete({ id }).catch(() => undefined);
  const { data: reclaimed } = await client.models.StaffAccessCommand.create({
    id,
    ...fields,
    // Preserve the original request identity; this attempt only refreshes the
    // lease and attempt count.
    reasonCode: existing.reasonCode ?? input.reasonCode,
    reason: existing.reason ?? input.reason ?? undefined,
    requestedRoles:
      existing.requestedRoles ??
      ((input.requestedRoles ?? []).join(", ") || undefined),
    priorRoles: existing.priorRoles ?? undefined,
    subjectSub: existing.subjectSub ?? undefined,
    stage: priorStage,
    requestedAt: existing.requestedAt,
    attemptCount: attempt,
    lastError: existing.lastError ?? undefined,
    effects: existing.effects ?? undefined,
  });
  if (!reclaimed) {
    return { claimed: false, state: "IN_FLIGHT", command: row };
  }
  // Verify the nonce read back — if a racing reclaimer's delete/create landed
  // after ours, the row is theirs and this caller must stand down.
  const { data: verify } = await client.models.StaffAccessCommand.get({ id });
  if (verify?.leaseNonce !== nonce) {
    return {
      claimed: false,
      state: "IN_FLIGHT",
      command: row,
    };
  }
  return { claimed: true, resumedFromStage: priorStage, attempt };
}

/**
 * Record confirmed step progress on the command. Verified: returns true only
 * when the write persisted (read back), so callers can treat "progress
 * recorded" as a fact, not a hope.
 */
export async function recordCommandStage(
  id: string,
  stage: StaffCommandStage,
  patch?: { priorRoles?: string[]; subjectSub?: string; effects?: string; lastError?: string | null }
): Promise<boolean> {
  try {
    const client = await dataClient();
    const { data } = await client.models.StaffAccessCommand.update({
      id,
      stage,
      priorRoles: patch?.priorRoles ? patch.priorRoles.join(", ") : undefined,
      subjectSub: patch?.subjectSub,
      effects: patch?.effects,
      lastError: patch?.lastError === null ? undefined : patch?.lastError,
    });
    if (!data) return false;
    const { data: verify } = await client.models.StaffAccessCommand.get({ id });
    return verify?.stage === stage;
  } catch (err) {
    console.error(`recordCommandStage(${id}, ${stage}) failed`, err);
    return false;
  }
}

/**
 * Write the command's terminal outcome (COMPLETE | PARTIAL | FAILED) with the
 * persisted result the screens read back. Returns whether the terminal write
 * itself durably persisted — a false means the change's effects stand but the
 * command still reads unfinished, and the caller must report PARTIAL.
 */
export async function finishCommand(
  id: string,
  terminal: {
    stage: Extract<StaffCommandStage, "COMPLETE" | "PARTIAL" | "FAILED">;
    outcome: string;
    effects: string;
    lastError?: string | null;
    result?: Record<string, unknown>;
  }
): Promise<boolean> {
  try {
    const client = await dataClient();
    const { data } = await client.models.StaffAccessCommand.update({
      id,
      stage: terminal.stage,
      outcome: terminal.outcome,
      effects: terminal.effects,
      lastError: terminal.lastError ?? undefined,
      resultJson: terminal.result
        ? JSON.stringify(terminal.result)
        : undefined,
      // A terminal command holds no lease.
      leaseUntil: null,
    });
    if (!data) return false;
    const { data: verify } = await client.models.StaffAccessCommand.get({ id });
    return verify?.stage === terminal.stage;
  } catch (err) {
    console.error(`finishCommand(${id}) failed`, err);
    return false;
  }
}

/** The fixed mutex id that serializes every change to the OWNER pool. */
const OWNER_SERIAL_ID = "owner-serial";
const OWNER_SERIAL_LEASE_MS = 2 * 60_000;

/**
 * GL-14 — serialize owner-set changes. Any action that grants or removes the
 * OWNER role must hold this across its last-owner check AND the change, so two
 * concurrent owner demotions/offboardings cannot both pass a point-in-time
 * count and then need a fallible rollback. Returns false when another owner
 * change is in flight — the caller refuses safely, having changed nothing.
 * A crashed holder's row is reclaimed after its lease expires.
 */
export async function acquireOwnerSerial(holder: string): Promise<boolean> {
  const client = await dataClient();
  const now = Date.now();
  const attempt = async () => {
    const { data } = await client.models.OwnerChangeSerial.create({
      id: OWNER_SERIAL_ID,
      holder,
      leaseUntil: new Date(now + OWNER_SERIAL_LEASE_MS).toISOString(),
    });
    return Boolean(data);
  };
  if (await attempt()) return true;
  const { data: existing } = await client.models.OwnerChangeSerial.get({
    id: OWNER_SERIAL_ID,
  });
  if (
    existing?.leaseUntil &&
    Date.parse(existing.leaseUntil) > now
  ) {
    return false;
  }
  // Stale — reclaim. The conditional re-create keeps exactly one winner.
  await client.models.OwnerChangeSerial.delete({ id: OWNER_SERIAL_ID }).catch(
    () => undefined
  );
  if (!(await attempt())) return false;
  const { data: verify } = await client.models.OwnerChangeSerial.get({
    id: OWNER_SERIAL_ID,
  });
  return verify?.holder === holder;
}

/** Release the owner-change mutex. Idempotent; a failure only delays the next
 *  owner change until the lease expires — it never corrupts state. */
export async function releaseOwnerSerial(): Promise<void> {
  const client = await dataClient();
  await client.models.OwnerChangeSerial.delete({ id: OWNER_SERIAL_ID }).catch(
    () => undefined
  );
}
