import { randomUUID } from "node:crypto";
import { dataClient } from "./dataClient";
import { casTakeover, casFencedUpdate } from "./atomicLock";
import type { LifecycleActor } from "./lifecycleLog";

/**
 * GL-09 — the durable customer lifecycle command engine. The transposition of
 * shared/staffAccessCommand.ts for deactivate/reactivate:
 *
 *  - the command is CLAIMED (conditional create, id = caller idempotency key)
 *    BEFORE any billing, schedule, access, status, audit, or message change;
 *  - a duplicate submission is handed the persisted progress/outcome;
 *  - a stale non-terminal command is seized with ONE atomic conditional
 *    update guarded by "lease not live AND stage not settled" — never
 *    delete-then-create — so two reclaimers cannot both win;
 *  - every progress/terminal write is fenced on the holder's nonce, so a
 *    worker that lost its lease cannot overwrite the new holder's progress;
 *  - PARTIAL is resumable with the same key; COMPLETE/FAILED are settled;
 *  - an OPPOSITE request while a non-terminal command exists is refused with
 *    that command's state — a serialized reversal, never a fresh
 *    interpretation of a partially changed customer.
 */

export type LifecycleStage =
  | "REQUESTED"
  | "INVENTORIED"
  | "BILLING_STOPPED"
  | "SCHEDULE_CLEARED"
  | "ACCESS_DONE"
  | "STATUS_DONE"
  | "AUDITED"
  | "NOTICE_SENT"
  | "COMPLETE"
  | "PARTIAL"
  | "FAILED";

const SETTLED: LifecycleStage[] = ["COMPLETE", "FAILED"];
const LEASE_MS = 5 * 60_000;

export type LifecycleCommandRow = {
  id: string;
  customerId: string;
  action: string;
  stage: string;
  outcome?: string | null;
  effects?: string | null;
  lastError?: string | null;
  attemptCount?: number | null;
  inventoryJson?: unknown;
  resultJson?: unknown;
};

export type LifecycleClaimResult =
  | {
      claimed: true;
      resumedFromStage: LifecycleStage | null;
      attempt: number;
      /** The exclusive holder nonce every subsequent command write presents. */
      nonce: string;
    }
  | {
      claimed: false;
      state: "IN_FLIGHT" | "DONE" | "OPPOSITE_IN_FLIGHT" | "UNVERIFIED";
      command: LifecycleCommandRow;
    };

function isSettled(stage: string | null | undefined): boolean {
  return SETTLED.includes((stage ?? "") as LifecycleStage);
}

/**
 * Claim the lifecycle command for this idempotency key. Also refuses when the
 * OPPOSITE action holds a non-terminal command on the same customer — the
 * reversal is serialized behind finishing (or recovering) the first.
 */
export async function claimLifecycleCommand(input: {
  idempotencyKey: string;
  customerId: string;
  action: "DEACTIVATE" | "REACTIVATE";
  actor: LifecycleActor | null | undefined;
  reasonCode: string;
  reason?: string | null;
  priorStatus?: string | null;
}): Promise<LifecycleClaimResult> {
  const id = input.idempotencyKey.trim();
  if (!id) throw new Error("An idempotency key is required");
  const client = await dataClient();
  const nonce = randomUUID();
  const unverified = (why: string): LifecycleClaimResult => ({
    claimed: false,
    state: "UNVERIFIED",
    command: {
      id,
      customerId: input.customerId,
      action: input.action,
      stage: "REQUESTED",
      lastError: why,
    },
  });
  // FAIL CLOSED: without the durable command store there is no serialization,
  // no persisted progress, and no resumability — a transition must not touch
  // the provider on hope. The caller owns the refusal (owned recovery).
  if (!("CustomerLifecycleCommand" in client.models)) {
    return unverified("The lifecycle command store is unavailable.");
  }

  // Serialized reversal: any non-terminal command for this customer — either
  // direction, ANY different key, INCLUDING a resumable PARTIAL — blocks a
  // NEW command until it settles or is resumed to completion under its own
  // key. A PARTIAL customer is mid-transition; a fresh different-key command
  // would reinterpret partially-changed state.
  try {
    const { data: existing } =
      await client.models.CustomerLifecycleCommand.listCustomerLifecycleCommandByCustomerIdAndRequestedAt(
        { customerId: input.customerId },
        { limit: 50 }
      );
    const open = (existing ?? []).find(
      (c) => c.id !== id && !isSettled(c.stage)
    );
    if (open) {
      return {
        claimed: false,
        state:
          open.action === input.action ? "IN_FLIGHT" : "OPPOSITE_IN_FLIGHT",
        command: open as LifecycleCommandRow,
      };
    }
  } catch (err) {
    // FAIL CLOSED: an unverifiable open-command scan must not run a
    // transition that might interleave with an unfinished one.
    console.error("claimLifecycleCommand: open-command scan failed", err);
    return unverified(
      "Open lifecycle commands could not be verified (read failure)."
    );
  }

  const now = Date.now();
  const fields = {
    customerId: input.customerId,
    action: input.action,
    actorSub: input.actor?.sub ?? undefined,
    actorEmail: input.actor?.email ?? "system",
    reasonCode: input.reasonCode,
    reason: input.reason ?? undefined,
    priorStatus: input.priorStatus ?? undefined,
    requestedStatus: input.action === "DEACTIVATE" ? "INACTIVE" : "ACTIVE",
    leaseUntil: new Date(now + LEASE_MS).toISOString(),
    leaseNonce: nonce,
  };

  const { data: created } = await client.models.CustomerLifecycleCommand.create({
    id,
    ...fields,
    stage: "REQUESTED",
    requestedAt: new Date(now).toISOString(),
    attemptCount: 1,
  });
  if (created) return { claimed: true, resumedFromStage: null, attempt: 1, nonce };

  const { data: existing } = await client.models.CustomerLifecycleCommand.get({
    id,
  });
  if (!existing) {
    return {
      claimed: false,
      state: "IN_FLIGHT",
      command: {
        id,
        customerId: input.customerId,
        action: input.action,
        stage: "REQUESTED",
      },
    };
  }
  const row = existing as LifecycleCommandRow;
  if (isSettled(existing.stage)) {
    return { claimed: false, state: "DONE", command: row };
  }
  const leaseLive =
    existing.leaseUntil && Date.parse(existing.leaseUntil) > now;
  if (leaseLive) return { claimed: false, state: "IN_FLIGHT", command: row };

  // Stale non-terminal (including resumable PARTIAL): seize the lease with ONE
  // guarded update — exactly one racer wins; the loser stands down. When CAS
  // wiring is unavailable, takeover is refused: blocked is safe, two winners
  // is not.
  const takeover = await casTakeover("CustomerLifecycleCommand", id, {
    nonceField: "leaseNonce",
    nonce,
    leaseField: "leaseUntil",
    leaseMs: LEASE_MS,
    bumpField: "attemptCount",
    refuseStages: { field: "stage", values: SETTLED },
  });
  if (!takeover.ok) {
    return { claimed: false, state: "IN_FLIGHT", command: row };
  }
  const priorStage =
    ((takeover.prior.stage as LifecycleStage) ?? existing.stage ?? "REQUESTED");
  const attempt = (Number(takeover.prior.attemptCount) || 1) + 1;
  return { claimed: true, resumedFromStage: priorStage, attempt, nonce };
}

/** Record confirmed step progress, fenced on the holder's nonce. True only
 *  when the guarded write landed while we still held the lease. */
export async function recordLifecycleStage(
  id: string,
  stage: LifecycleStage,
  patch?: {
    inventoryJson?: string;
    effects?: string;
    lastError?: string | null;
    noticeMessageId?: string;
  },
  fence?: { nonce: string }
): Promise<boolean> {
  try {
    const client = await dataClient();
    if (!("CustomerLifecycleCommand" in client.models)) return true;
    if (fence) {
      const sets: Record<string, string | null> = { stage };
      if (patch?.inventoryJson) sets.inventoryJson = patch.inventoryJson;
      if (patch?.effects) sets.effects = patch.effects;
      if (patch?.lastError) sets.lastError = patch.lastError;
      if (patch?.noticeMessageId) sets.noticeMessageId = patch.noticeMessageId;
      const fenced = await casFencedUpdate(
        "CustomerLifecycleCommand",
        id,
        { field: "leaseNonce", nonce: fence.nonce },
        sets
      );
      if (fenced.ok) return true;
      if (fenced.reason === "LOST") return false;
      // UNSUPPORTED — verified plain write (takeover is disabled there, so a
      // single holder exists).
    }
    const { data } = await client.models.CustomerLifecycleCommand.update({
      id,
      stage,
      inventoryJson: patch?.inventoryJson,
      effects: patch?.effects,
      lastError: patch?.lastError === null ? undefined : patch?.lastError,
      noticeMessageId: patch?.noticeMessageId,
    });
    if (!data) return false;
    const { data: verify } = await client.models.CustomerLifecycleCommand.get({
      id,
    });
    return verify?.stage === stage;
  } catch (err) {
    console.error(`recordLifecycleStage(${id}, ${stage}) failed`, err);
    return false;
  }
}

/** Write the terminal outcome, fenced like every progress write. False = the
 *  effects stand but the durable command still reads unfinished; the caller
 *  must report PARTIAL. */
export async function finishLifecycleCommand(
  id: string,
  terminal: {
    stage: Extract<LifecycleStage, "COMPLETE" | "PARTIAL" | "FAILED">;
    outcome: string;
    effects: string;
    lastError?: string | null;
    result?: Record<string, unknown>;
  },
  fence?: { nonce: string }
): Promise<boolean> {
  try {
    const client = await dataClient();
    if (!("CustomerLifecycleCommand" in client.models)) return true;
    if (fence) {
      const fenced = await casFencedUpdate(
        "CustomerLifecycleCommand",
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
    const { data } = await client.models.CustomerLifecycleCommand.update({
      id,
      stage: terminal.stage,
      outcome: terminal.outcome,
      effects: terminal.effects,
      lastError: terminal.lastError ?? undefined,
      resultJson: terminal.result ? JSON.stringify(terminal.result) : undefined,
      leaseUntil: null,
    });
    if (!data) return false;
    const { data: verify } = await client.models.CustomerLifecycleCommand.get({
      id,
    });
    return verify?.stage === terminal.stage;
  } catch (err) {
    console.error(`finishLifecycleCommand(${id}) failed`, err);
    return false;
  }
}
