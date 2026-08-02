import { randomUUID } from "node:crypto";
import { dataClient } from "./dataClient";
import { casFencedUpdate, casTakeover } from "./atomicLock";
import { customerAccessGroups } from "./dynamicGroups";
import { openOwnedWork } from "./ownedWork";
import { forEachPage, listAll } from "./pagination";

/**
 * GL-11 — group membership as a durable, resumable, VERIFIED command.
 *
 * A group change must land on FOUR surfaces — the audit ledger, the
 * customer row, every child record's accessGroups, and Cognito group
 * membership — and a crash between any two of them used to leave the
 * surfaces silently split. This module is the staffAccessCommand/
 * lifecycleCommand transposition for that change:
 *
 *  - the command row is CLAIMED (conditional create) before anything is
 *    touched; a live lease refuses a second executor; a stale lease is
 *    seized with ONE atomic takeover;
 *  - the AUDIT lands first, and a failed audit refuses the whole change —
 *    who/when/why is never optional and never log-only;
 *  - every confirmed stage is recorded fenced on the holder nonce, so a
 *    resume continues from the last durable stage instead of guessing;
 *  - COMPLETE requires VERIFICATION: the customer row, a full re-scan of
 *    child records, and Cognito membership must all agree with the target
 *    before the command settles — anything less is PARTIAL, which opens
 *    deduplicated owned work and stays resumable (the daily run re-drives
 *    it through crm-admin, which holds the Cognito permissions).
 */

export type GroupChangeStage =
  | "REQUESTED"
  | "AUDITED"
  | "CUSTOMER_DONE"
  | "CHILDREN_DONE"
  | "COGNITO_DONE"
  | "COMPLETE"
  | "PARTIAL"
  | "FAILED";

const STAGE_ORDER: GroupChangeStage[] = [
  "REQUESTED",
  "AUDITED",
  "CUSTOMER_DONE",
  "CHILDREN_DONE",
  "COGNITO_DONE",
];
const SETTLED: GroupChangeStage[] = ["COMPLETE", "FAILED"];
const LEASE_MS = 5 * 60_000;

export const GROUP_CHILD_MODELS = [
  "ServicePlan",
  "Job",
  "Agreement",
  "ServiceReport",
  "Invoice",
] as const;

export type GroupChangeCommandRow = {
  id: string;
  customerId: string;
  fromGroupId?: string | null;
  toGroupId?: string | null;
  reason: string;
  stage: string;
  leaseUntil?: string | null;
  attemptCount?: number | null;
  lastError?: string | null;
  effects?: string | null;
};

const stageReached = (stage: string | null | undefined, target: GroupChangeStage) =>
  STAGE_ORDER.indexOf((stage ?? "REQUESTED") as GroupChangeStage) >=
  STAGE_ORDER.indexOf(target);

type Models = Record<string, unknown>;

async function listOpenCommands(
  client: { models: Models },
  customerId: string
): Promise<GroupChangeCommandRow[]> {
  const model = (
    client.models as unknown as {
      GroupChangeCommand: {
        listGroupChangeCommandByCustomerIdAndRequestedAt: (
          key: { customerId: string },
          opts: { limit: number; nextToken?: string | null }
        ) => Promise<{
          data: GroupChangeCommandRow[] | null;
          nextToken?: string | null;
          errors?: { message: string }[];
        }>;
      };
    }
  ).GroupChangeCommand;
  const all = await listAll((nextToken) =>
    model.listGroupChangeCommandByCustomerIdAndRequestedAt(
      { customerId },
      { limit: 200, nextToken }
    )
  );
  return all.filter((c) => !SETTLED.includes(c.stage as GroupChangeStage));
}

export type GroupChangeClaim =
  | { claimed: true; commandId: string; nonce: string; resumedFromStage: string | null }
  | { claimed: false; state: "IN_FLIGHT" | "CONFLICT" | "UNVERIFIED"; command: GroupChangeCommandRow | null };

/**
 * Claim a NEW group change (or take over a stale command for the SAME
 * target). A live command refuses; an open command for a DIFFERENT target
 * refuses until it settles or resumes to completion — a second
 * interpretation of a half-changed customer is exactly the split this
 * command exists to prevent.
 */
export async function claimGroupChange(input: {
  customerId: string;
  fromGroupId: string | null;
  toGroupId: string | null;
  reason: string;
  actor: { sub: string | null; email: string | null };
}): Promise<GroupChangeClaim> {
  const client = await dataClient();
  if (!("GroupChangeCommand" in client.models)) {
    return { claimed: false, state: "UNVERIFIED", command: null };
  }
  const nonce = randomUUID();
  let open: GroupChangeCommandRow[];
  try {
    open = await listOpenCommands(
      client as unknown as { models: Models },
      input.customerId
    );
  } catch (err) {
    console.error("claimGroupChange: open-command scan failed", err);
    return { claimed: false, state: "UNVERIFIED", command: null };
  }
  const existing = open[0] ?? null;
  if (existing) {
    const sameTarget = (existing.toGroupId ?? null) === (input.toGroupId ?? null);
    const leaseLive =
      existing.leaseUntil && Date.parse(existing.leaseUntil) > Date.now();
    if (!sameTarget) {
      return { claimed: false, state: "CONFLICT", command: existing };
    }
    if (leaseLive) {
      return { claimed: false, state: "IN_FLIGHT", command: existing };
    }
    const takeover = await casTakeover("GroupChangeCommand", existing.id, {
      nonceField: "leaseNonce",
      nonce,
      leaseField: "leaseUntil",
      leaseMs: LEASE_MS,
      bumpField: "attemptCount",
      refuseStages: { field: "stage", values: SETTLED },
    });
    if (!takeover.ok) {
      return { claimed: false, state: "IN_FLIGHT", command: existing };
    }
    return {
      claimed: true,
      commandId: existing.id,
      nonce,
      resumedFromStage: String(takeover.prior.stage ?? existing.stage),
    };
  }
  const id = `gc-${input.customerId}-${randomUUID()}`;
  const { data: created } = await (
    client.models as unknown as {
      GroupChangeCommand: {
        create: (input: Record<string, unknown>) => Promise<{
          data: { id: string } | null;
        }>;
      };
    }
  ).GroupChangeCommand.create({
    id,
    customerId: input.customerId,
    fromGroupId: input.fromGroupId ?? undefined,
    toGroupId: input.toGroupId ?? undefined,
    reason: input.reason,
    actorSub: input.actor.sub ?? undefined,
    actorEmail: input.actor.email ?? "office",
    stage: "REQUESTED",
    requestedAt: new Date().toISOString(),
    leaseUntil: new Date(Date.now() + LEASE_MS).toISOString(),
    leaseNonce: nonce,
    attemptCount: 1,
  });
  if (!created) {
    // A concurrent submission won the customer's open slot — re-scan and
    // report what holds it, never a silent second executor.
    return { claimed: false, state: "IN_FLIGHT", command: existing };
  }
  return { claimed: true, commandId: id, nonce, resumedFromStage: null };
}

async function recordStage(
  id: string,
  nonce: string,
  stage: GroupChangeStage,
  patch?: { effects?: string; lastError?: string | null; verifiedAt?: string }
): Promise<boolean> {
  const res = await casFencedUpdate(
    "GroupChangeCommand",
    id,
    { field: "leaseNonce", nonce },
    {
      stage,
      ...(patch?.effects ? { effects: patch.effects } : {}),
      ...(patch?.lastError !== undefined ? { lastError: patch.lastError } : {}),
      ...(patch?.verifiedAt ? { verifiedAt: patch.verifiedAt } : {}),
      ...(SETTLED.includes(stage) || stage === "PARTIAL"
        ? { leaseUntil: null }
        : {}),
    }
  );
  return res.ok;
}

export type CognitoSync = {
  /** Make Cognito match: exactly the target grp- group (or none). */
  apply: (customer: Record<string, unknown>, toGroupId: string | null) => Promise<void>;
  /** True when Cognito already matches the target. */
  verify: (customer: Record<string, unknown>, toGroupId: string | null) => Promise<boolean>;
};

export type GroupChangeResult = {
  stage: "COMPLETE" | "PARTIAL";
  commandId: string;
  childrenUpdated: number;
  verified: boolean;
  lastError?: string;
};

/**
 * Drive a CLAIMED command from its recorded stage to COMPLETE. Idempotent
 * per stage; every confirmed stage is fenced-recorded; COMPLETE only after
 * the verification pass proves all four surfaces agree. Anything less
 * settles as a resumable PARTIAL with deduplicated owned work.
 */
export async function executeGroupChange(
  cmd: { commandId: string; nonce: string },
  cognito: CognitoSync
): Promise<GroupChangeResult> {
  const client = await dataClient();
  const models = client.models as unknown as {
    GroupChangeCommand: {
      get: (a: { id: string }) => Promise<{ data: GroupChangeCommandRow | null }>;
    };
    Customer: {
      get: (a: { id: string }) => Promise<{ data: Record<string, unknown> | null }>;
      update: (a: Record<string, unknown>) => Promise<{ data: unknown }>;
    };
    CustomerLifecycleEvent: {
      create: (a: Record<string, unknown>) => Promise<{ data: unknown }>;
      get?: (a: { id: string }) => Promise<{ data: unknown }>;
    };
  };
  const { data: row } = await models.GroupChangeCommand.get({ id: cmd.commandId });
  if (!row) throw new Error(`Group change ${cmd.commandId} not found`);
  const toGroupId = row.toGroupId ?? null;
  const partial = async (why: string): Promise<GroupChangeResult> => {
    await recordStage(cmd.commandId, cmd.nonce, "PARTIAL", { lastError: why });
    await openOwnedWork({
      kind: "STATE_MISMATCH",
      dedupeKey: `group-change:${cmd.commandId}`,
      title: `A group change is stuck partway: ${row.customerId}`,
      detail: `Group change ${cmd.commandId} (${row.fromGroupId ?? "none"} → ${toGroupId ?? "none"}) stopped before all four surfaces agreed: ${why} The daily run resumes it automatically; this case exists so a human notices if it keeps failing.`,
      customerId: row.customerId,
      relatedId: cmd.commandId,
      sourceUrl: `/customers/${row.customerId}`,
      resolutionAction:
        "Check the customer's group on their screen. If tomorrow's run hasn't completed the change, escalate to engineering with the command id.",
      ownerTeam: "OPS",
    }).catch(() => null);
    return {
      stage: "PARTIAL",
      commandId: cmd.commandId,
      childrenUpdated: 0,
      verified: false,
      lastError: why,
    };
  };

  const { data: customer } = await models.Customer.get({ id: row.customerId });
  if (!customer) return partial("the customer row could not be read");
  const accessGroups = customerAccessGroups(row.customerId, toGroupId ?? undefined);

  // Stage 1 — AUDIT FIRST, refuse on failure: the who/when/why record is
  // the precondition of the change, not a best-effort side effect. The
  // deterministic event id makes a resume converge instead of duplicating.
  if (!stageReached(row.stage, "AUDITED")) {
    const auditId = `gcaudit-${cmd.commandId}`;
    let auditLanded = false;
    try {
      const { data: auditRow } = await models.CustomerLifecycleEvent.create({
        id: auditId,
        customerId: row.customerId,
        action: "GROUP_CHANGE",
        actorSub: (row as { actorSub?: string | null }).actorSub ?? undefined,
        actorEmail:
          (row as { actorEmail?: string | null }).actorEmail ?? "office",
        reason: row.reason,
        effects: `group: ${row.fromGroupId ?? "none"} → ${toGroupId ?? "none"}`,
        occurredAt: new Date().toISOString(),
      });
      auditLanded = Boolean(auditRow);
    } catch {
      auditLanded = false;
    }
    if (!auditLanded) {
      // A refused create is only OK when the audit ALREADY exists (a
      // resume's duplicate id) — verified by reading it back, never assumed.
      const prior = models.CustomerLifecycleEvent.get
        ? (await models.CustomerLifecycleEvent.get({ id: auditId })).data
        : null;
      if (!prior) {
        await recordStage(cmd.commandId, cmd.nonce, "FAILED", {
          lastError: "the audit record could not be written",
        });
        throw new Error(
          "Group membership was NOT changed: the audit record could not be written. Try again."
        );
      }
    }
    if (!(await recordStage(cmd.commandId, cmd.nonce, "AUDITED"))) {
      return partial("lost the command lease after the audit stage");
    }
  }

  // Stage 2 — the customer row.
  if (!stageReached(row.stage, "CUSTOMER_DONE")) {
    const { data: updated } = await models.Customer.update({
      id: row.customerId,
      groupId: toGroupId,
      accessGroups,
    });
    if (!updated) return partial("the customer row update was refused");
    if (!(await recordStage(cmd.commandId, cmd.nonce, "CUSTOMER_DONE"))) {
      return partial("lost the command lease after the customer stage");
    }
  }

  // Stage 3 — every child record's accessGroups (always re-driven in full:
  // the write is idempotent, and a resume must catch children created
  // between the crash and now).
  let childrenUpdated = 0;
  for (const modelName of GROUP_CHILD_MODELS) {
    const model = (client.models as Models)[modelName] as
      | {
          list: (a: object) => Promise<{
            data: { id: string }[];
            nextToken?: string | null;
          }>;
          update: (a: object) => Promise<unknown>;
        }
      | undefined;
    if (!model) continue;
    await forEachPage(
      (nextToken) =>
        model.list({
          filter: { customerId: { eq: row.customerId } },
          limit: 200,
          nextToken,
        }),
      async (records) => {
        for (const record of records) {
          await model.update({ id: record.id, accessGroups });
          childrenUpdated++;
        }
      },
      { pageErrors: "ignore" }
    );
  }
  if (!(await recordStage(cmd.commandId, cmd.nonce, "CHILDREN_DONE"))) {
    return partial("lost the command lease after the children stage");
  }

  // Stage 4 — Cognito membership (injected: crm-admin holds the perms).
  try {
    await cognito.apply(customer, toGroupId);
  } catch (err) {
    return partial(
      `Cognito membership sync failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!(await recordStage(cmd.commandId, cmd.nonce, "COGNITO_DONE"))) {
    return partial("lost the command lease after the Cognito stage");
  }

  // Stage 5 — VERIFY all four surfaces before settling. The audit exists
  // (stage 1 refused otherwise); re-check the other three.
  const problems: string[] = [];
  const { data: after } = await models.Customer.get({ id: row.customerId });
  if (((after?.groupId as string | null) ?? null) !== toGroupId) {
    problems.push("the customer row's group does not match");
  }
  for (const modelName of GROUP_CHILD_MODELS) {
    const model = (client.models as Models)[modelName] as
      | {
          list: (a: object) => Promise<{
            data: { id: string; accessGroups?: (string | null)[] | null }[];
            nextToken?: string | null;
          }>;
        }
      | undefined;
    if (!model) continue;
    const records = await listAll(
      (nextToken) =>
        model.list({
          filter: { customerId: { eq: row.customerId } },
          limit: 200,
          nextToken,
        }),
      { pageErrors: "ignore" }
    );
    for (const record of records) {
      const got = [...(record.accessGroups ?? [])].filter(Boolean).sort();
      const want = [...accessGroups].sort();
      if (got.join(",") !== want.join(",")) {
        problems.push(`${modelName} ${record.id} carries stale access groups`);
      }
    }
  }
  try {
    if (!(await cognito.verify(customer, toGroupId))) {
      problems.push("Cognito membership does not match");
    }
  } catch (err) {
    problems.push(
      `Cognito membership could not be verified: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (problems.length) {
    return partial(`verification found disagreement: ${problems.join("; ")}.`);
  }

  const done = await recordStage(cmd.commandId, cmd.nonce, "COMPLETE", {
    verifiedAt: new Date().toISOString(),
    effects: `group: ${row.fromGroupId ?? "none"} → ${toGroupId ?? "none"}; ${childrenUpdated} child records; Cognito verified`,
    lastError: null,
  });
  if (!done) return partial("the verified outcome could not be recorded");
  return {
    stage: "COMPLETE",
    commandId: cmd.commandId,
    childrenUpdated,
    verified: true,
  };
}
