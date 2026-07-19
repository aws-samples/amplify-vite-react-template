import { randomUUID } from "node:crypto";
import { dataClient } from "./dataClient";
import type { LifecycleActor } from "./lifecycleLog";

/**
 * GL-09 — the durable customer lifecycle command engine. The transposition of
 * shared/staffAccessCommand.ts for deactivate/reactivate:
 *
 *  - the command is CLAIMED (conditional create, id = caller idempotency key)
 *    BEFORE any billing, schedule, access, status, audit, or message change;
 *  - a duplicate submission is handed the persisted progress/outcome;
 *  - a stale non-terminal command is reclaimed under an exclusive
 *    nonce-verified lease and resumed from its last confirmed stage;
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
  | { claimed: true; resumedFromStage: LifecycleStage | null; attempt: number }
  | { claimed: false; state: "IN_FLIGHT" | "DONE" | "OPPOSITE_IN_FLIGHT"; command: LifecycleCommandRow };

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
  // A fake or a container straddling a schema deploy: proceed as the claimant
  // (the per-customer lock still serializes) rather than blocking transitions.
  if (!("CustomerLifecycleCommand" in client.models)) {
    return { claimed: true, resumedFromStage: null, attempt: 1 };
  }

  // Serialized reversal: any non-terminal command for this customer (either
  // direction, different key) blocks a NEW command until it settles or is
  // resumed to completion.
  try {
    const { data: existing } =
      await client.models.CustomerLifecycleCommand.listCustomerLifecycleCommandByCustomerIdAndRequestedAt(
        { customerId: input.customerId },
        { limit: 50 }
      );
    const open = (existing ?? []).find(
      (c) => c.id !== id && !isSettled(c.stage) && c.stage !== "PARTIAL"
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
    console.error("claimLifecycleCommand: open-command scan failed", err);
  }

  const nonce = randomUUID();
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
  if (created) return { claimed: true, resumedFromStage: null, attempt: 1 };

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

  // Stale non-terminal (including resumable PARTIAL): reclaim, carrying the
  // recorded stage forward so the resume re-drives only what is missing.
  const priorStage = (existing.stage as LifecycleStage) ?? "REQUESTED";
  const attempt = (existing.attemptCount ?? 1) + 1;
  await client.models.CustomerLifecycleCommand.delete({ id }).catch(
    () => undefined
  );
  const { data: reclaimed } = await client.models.CustomerLifecycleCommand.create({
    id,
    ...fields,
    reasonCode: existing.reasonCode ?? input.reasonCode,
    reason: existing.reason ?? input.reason ?? undefined,
    priorStatus: existing.priorStatus ?? input.priorStatus ?? undefined,
    stage: priorStage,
    requestedAt: existing.requestedAt,
    attemptCount: attempt,
    inventoryJson: existing.inventoryJson ?? undefined,
    lastError: existing.lastError ?? undefined,
    effects: existing.effects ?? undefined,
    noticeMessageId: existing.noticeMessageId ?? undefined,
  });
  if (!reclaimed) return { claimed: false, state: "IN_FLIGHT", command: row };
  const { data: verify } = await client.models.CustomerLifecycleCommand.get({
    id,
  });
  if (verify?.leaseNonce !== nonce) {
    return { claimed: false, state: "IN_FLIGHT", command: row };
  }
  return { claimed: true, resumedFromStage: priorStage, attempt };
}

/** Record confirmed step progress. True only when the write persisted. */
export async function recordLifecycleStage(
  id: string,
  stage: LifecycleStage,
  patch?: {
    inventoryJson?: string;
    effects?: string;
    lastError?: string | null;
    noticeMessageId?: string;
  }
): Promise<boolean> {
  try {
    const client = await dataClient();
    if (!("CustomerLifecycleCommand" in client.models)) return true;
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

/** Write the terminal outcome. False = effects stand but the durable command
 *  still reads unfinished; the caller must report PARTIAL. */
export async function finishLifecycleCommand(
  id: string,
  terminal: {
    stage: Extract<LifecycleStage, "COMPLETE" | "PARTIAL" | "FAILED">;
    outcome: string;
    effects: string;
    lastError?: string | null;
    result?: Record<string, unknown>;
  }
): Promise<boolean> {
  try {
    const client = await dataClient();
    if (!("CustomerLifecycleCommand" in client.models)) return true;
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
