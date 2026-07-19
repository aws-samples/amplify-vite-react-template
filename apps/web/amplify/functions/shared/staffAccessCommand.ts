import { randomUUID } from "node:crypto";
import { dataClient } from "./dataClient";
import { casTakeover, casFencedUpdate, casFencedDelete } from "./atomicLock";
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
 * The command carries an exclusive resume lease (leaseUntil + leaseNonce).
 * Takeover of an expired lease is ONE atomic conditional update (atomicLock)
 * guarded by "no live lease AND not settled" — never delete-then-create, which
 * would let a second reclaimer delete the first winner's row and also start.
 * Every progress and terminal write is fenced on the holder's nonce, so a
 * worker that lost its lease cannot overwrite the new holder's progress.
 * Terminal commands are never deleted: the row IS the persisted outcome the
 * screens read back.
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
  | {
      claimed: true;
      resumedFromStage: StaffCommandStage | null;
      attempt: number;
      /** The exclusive holder nonce — every progress/terminal write and the
       *  release must present it. */
      nonce: string;
    }
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
 * A stale reclaim (lease expired, non-terminal stage) is ONE conditional
 * update installing this caller's nonce + fresh lease, guarded server-side by
 * the lease still being expired and the stage still being unsettled — so two
 * concurrent reclaimers cannot both win, and a settled command can never be
 * reopened by a late reclaimer. When CAS wiring is unavailable (unit-test
 * fakes without an injected store, a container straddling a deploy) takeover
 * is REFUSED — blocked-until-lease-logic-deploys is safe; two winners is not.
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
    return { claimed: true, resumedFromStage: null, attempt: 1, nonce };
  }

  // Lost the create — someone else holds (or held) this key. Read the truth.
  const { data: existing } = await client.models.StaffAccessCommand.get({ id });
  if (!existing) {
    // Extremely narrow window (row settled and vanished between create and
    // get). Treat as in-flight; the caller reports "try again" rather than
    // acting blind.
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

  // Stale, non-terminal command: seize the lease with ONE atomic guarded
  // update. Exactly one racer's condition ("lease not live AND stage not
  // settled") passes; the loser is told IN_FLIGHT and stands down.
  const takeover = await casTakeover("StaffAccessCommand", id, {
    nonceField: "leaseNonce",
    nonce,
    leaseField: "leaseUntil",
    leaseMs: LEASE_MS,
    bumpField: "attemptCount",
    refuseStages: { field: "stage", values: TERMINAL_STAGES },
  });
  if (!takeover.ok) {
    return { claimed: false, state: "IN_FLIGHT", command: row };
  }
  const priorStage =
    ((takeover.prior.stage as StaffCommandStage) ?? existing.stage ?? "REQUESTED");
  const attempt = (Number(takeover.prior.attemptCount) || 1) + 1;
  return { claimed: true, resumedFromStage: priorStage, attempt, nonce };
}

/**
 * Record confirmed step progress on the command. With the holder's nonce the
 * write is a single fenced conditional update — it lands only while the nonce
 * is still ours, so "true" is a fact, and a worker whose lease was taken over
 * can never scribble on the new holder's progress. Without CAS wiring it
 * falls back to a verified plain write (safe there: takeover is disabled, so
 * a single holder exists).
 */
export async function recordCommandStage(
  id: string,
  stage: StaffCommandStage,
  patch?: { priorRoles?: string[]; subjectSub?: string; effects?: string; lastError?: string | null },
  fence?: { nonce: string }
): Promise<boolean> {
  try {
    const sets: Record<string, string | null> = { stage };
    if (patch?.priorRoles) sets.priorRoles = patch.priorRoles.join(", ");
    if (patch?.subjectSub) sets.subjectSub = patch.subjectSub;
    if (patch?.effects) sets.effects = patch.effects;
    if (patch?.lastError) sets.lastError = patch.lastError;
    if (fence) {
      const fenced = await casFencedUpdate(
        "StaffAccessCommand",
        id,
        { field: "leaseNonce", nonce: fence.nonce },
        sets
      );
      if (fenced.ok) return true;
      if (fenced.reason === "LOST") return false;
      // UNSUPPORTED — fall through to the verified plain write.
    }
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
 * persisted result the screens read back. Fenced on the holder's nonce like
 * every progress write. Returns whether the terminal write itself durably
 * persisted — a false means the change's effects stand but the command still
 * reads unfinished, and the caller must report PARTIAL.
 */
export async function finishCommand(
  id: string,
  terminal: {
    stage: Extract<StaffCommandStage, "COMPLETE" | "PARTIAL" | "FAILED">;
    outcome: string;
    effects: string;
    lastError?: string | null;
    result?: Record<string, unknown>;
  },
  fence?: { nonce: string }
): Promise<boolean> {
  try {
    if (fence) {
      const fenced = await casFencedUpdate(
        "StaffAccessCommand",
        id,
        { field: "leaseNonce", nonce: fence.nonce },
        {
          stage: terminal.stage,
          outcome: terminal.outcome,
          effects: terminal.effects,
          ...(terminal.lastError ? { lastError: terminal.lastError } : {}),
          ...(terminal.result
            ? { resultJson: JSON.stringify(terminal.result) }
            : {}),
          // A terminal command holds no lease (PARTIAL resumes immediately).
          leaseUntil: null,
        }
      );
      if (fenced.ok) return true;
      if (fenced.reason === "LOST") return false;
    }
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
 * A crashed holder's expired lease is seized with ONE conditional update
 * (never delete-then-create), and release is fenced on the holder value so an
 * expired worker can never delete a newer worker's mutex.
 */
export async function acquireOwnerSerial(holder: string): Promise<boolean> {
  const client = await dataClient();
  const now = Date.now();
  const { data: created } = await client.models.OwnerChangeSerial.create({
    id: OWNER_SERIAL_ID,
    holder,
    leaseUntil: new Date(now + OWNER_SERIAL_LEASE_MS).toISOString(),
  });
  if (created) return true;
  const { data: existing } = await client.models.OwnerChangeSerial.get({
    id: OWNER_SERIAL_ID,
  });
  if (
    existing?.leaseUntil &&
    Date.parse(existing.leaseUntil) > now
  ) {
    return false;
  }
  if (!existing) {
    // Released between our create and get — one more conditional create.
    const { data: retried } = await client.models.OwnerChangeSerial.create({
      id: OWNER_SERIAL_ID,
      holder,
      leaseUntil: new Date(now + OWNER_SERIAL_LEASE_MS).toISOString(),
    });
    return Boolean(retried);
  }
  // Stale — seize it atomically. Exactly one concurrent reclaimer wins.
  const takeover = await casTakeover("OwnerChangeSerial", OWNER_SERIAL_ID, {
    nonceField: "holder",
    nonce: holder,
    leaseField: "leaseUntil",
    leaseMs: OWNER_SERIAL_LEASE_MS,
  });
  return takeover.ok;
}

/** Release the owner-change mutex — fenced on the holder, so a worker whose
 *  lease was taken over cannot release the new holder's lock. Idempotent; a
 *  failure only delays the next owner change until the lease expires. */
export async function releaseOwnerSerial(holder: string): Promise<void> {
  const released = await casFencedDelete("OwnerChangeSerial", OWNER_SERIAL_ID, {
    field: "holder",
    nonce: holder,
    allowMissingFence: true,
  });
  if (released !== "UNSUPPORTED") return;
  // No CAS wiring (takeover disabled there, so this holder is the only one).
  const client = await dataClient();
  await client.models.OwnerChangeSerial.delete({ id: OWNER_SERIAL_ID }).catch(
    () => undefined
  );
}
