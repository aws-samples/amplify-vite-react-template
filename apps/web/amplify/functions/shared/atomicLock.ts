import {
  DynamoDBClient,
  UpdateItemCommand,
  DeleteItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";

/**
 * Atomic compare-and-swap primitives for the operational locks and durable
 * commands (StaffAccessCommand, OwnerChangeSerial, CustomerLifecycleClaim/
 * Command, PlanCancellationClaim, VisitChangeClaim, BookingFinalization,
 * BookingCommsSend, ServiceReportFinalizeClaim, TreatmentObligation).
 *
 * WHY THIS EXISTS: AppSync's generated mutations only give us one atomic
 * primitive — `create` conditional on the id not existing. That is enough to
 * serialize two FRESH claims, but stale-lease takeover implemented as
 * delete-then-create is NOT exclusive: worker A deletes/creates/verifies and
 * starts working; worker B then deletes A's row, creates its own, verifies,
 * and also starts. An unconditional release has the mirror bug — an expired
 * worker can delete a newer holder's lock. Both are real single-winner
 * violations, so every takeover, progress write, and release goes through ONE
 * conditional DynamoDB write against the same Amplify-generated table:
 *
 *  - takeover  = UpdateItem guarded by "the lease is not live" (and, for
 *    durable commands, "the stage is not settled") — exactly one racer's
 *    condition passes; the loser gets ConditionalCheckFailed, never a row it
 *    thinks it owns;
 *  - progress/terminal writes = UpdateItem guarded by "the holder nonce is
 *    still mine" — a worker that lost its lease cannot overwrite the new
 *    holder's progress;
 *  - release = DeleteItem guarded by the same fence — an expired worker
 *    cannot release a newer worker's lock.
 *
 * Table names are derived at runtime (`<Model>-<apiId>-NONE`, the Amplify Gen2
 * naming rule). The apiId comes from an SSM parameter backend.ts publishes
 * from INSIDE the data stack (env var AMPLIFY_DATA_API_ID_PARAM names it) —
 * the same runtime-resolution pattern Amplify itself uses for the GraphQL
 * endpoint, so backend.ts only has to grant IAM by name pattern and no CDK
 * cross-stack table references exist (those would cycle with the schema's
 * handler references). The apiId is NOT derivable from the GraphQL endpoint
 * hostname — that prefix is a separate DNS id, and deriving from it made
 * every deployed CAS write target a nonexistent table (the July staging
 * defect: ResourceNotFoundException read as "lease held"). When the wiring
 * is unavailable (unit-test fakes, a container straddling a deploy, the
 * parameter unreadable) every call reports UNSUPPORTED and the caller falls
 * back to its create-only behavior: fresh claims stay serialized and stale
 * takeover is REFUSED — blocked is safe, two winners is not. Infrastructure
 * failures on the write itself (table missing, access denied) are ALSO
 * UNSUPPORTED, never LOST: "somebody else holds it" must mean somebody
 * else actually holds it.
 */

export type LockCondition =
  /** The lease field is missing, null, or expired (NOT (#f >= now)). */
  | { kind: "notLiveLease"; field: string; nowIso: string }
  | { kind: "fieldEquals"; field: string; value: string | number | boolean }
  /** Legacy-tolerant fence: the field equals the value OR was never written. */
  | { kind: "fieldEqualsOrMissing"; field: string; value: string | number | boolean }
  | { kind: "fieldIn"; field: string; values: (string | number)[] }
  /** The field is missing or not any of the given values. */
  | { kind: "fieldNotIn"; field: string; values: (string | number)[] }
  /** The field was never written or holds null (e.g. "unclaimed"). */
  | { kind: "fieldMissingOrNull"; field: string }
  /** The numeric field is missing (treated as 0 via if_not_exists semantics)
   *  or at most the given value — the capacity-fit guard. */
  | { kind: "fieldAtMostOrMissing"; field: string; value: number }
  /** The numeric field exists and is at least the given value — the
   *  never-go-negative guard on decrements. */
  | { kind: "fieldAtLeast"; field: string; value: number };

export type LockSets = Record<string, string | number | boolean | null>;

export type LockUpdateResult =
  | { ok: true; prior: Record<string, unknown> }
  | { ok: false; reason: "LOST" | "UNSUPPORTED" };

export type LockDeleteResult = "OK" | "LOST" | "UNSUPPORTED";

export type LockStore = {
  /** One atomic guarded update. `sets` null values REMOVE the attribute;
   *  `bumpField` does SET #b = if_not_exists(#b, 0) + 1 in the same write.
   *  Always implicitly conditioned on the row existing — a guarded update
   *  must never mint a fresh row. Returns the row's PRIOR attributes. */
  conditionalUpdate(
    model: string,
    id: string,
    sets: LockSets,
    conditions: LockCondition[],
    opts?: {
      bumpField?: string;
      /** Atomic numeric adds in the same guarded write (negative = decrement). */
      addFields?: Record<string, number>;
    }
  ): Promise<LockUpdateResult>;
  /** One atomic guarded delete. */
  conditionalDelete(
    model: string,
    id: string,
    conditions: LockCondition[]
  ): Promise<LockDeleteResult>;
};

// ---------------------------------------------------------------------------
// Production store: DynamoDB conditional writes on the Amplify tables
// ---------------------------------------------------------------------------

let tableSuffixPromise: Promise<string | null> | null = null;

/** Reads the apiId from the SSM parameter the data stack publishes. Exposed
 *  (with an injectable reader) so the resolution rule itself is unit-tested. */
export async function _resolveTableSuffix(
  env: Record<string, string | undefined> = process.env,
  readParameter: (name: string) => Promise<string | undefined> = async (
    name
  ) => {
    const out = await new SSMClient({}).send(
      new GetParameterCommand({ Name: name })
    );
    return out.Parameter?.Value;
  }
): Promise<string | null> {
  const paramName = env.AMPLIFY_DATA_API_ID_PARAM;
  if (!paramName) return null;
  const apiId = (await readParameter(paramName))?.trim();
  if (!apiId || !/^[a-z0-9]+$/.test(apiId)) return null;
  return `-${apiId}-NONE`;
}

/** `-<apiId>-NONE`. Successful resolution is cached for the container's
 *  lifetime; a failed attempt is NOT cached, so a transient SSM error does
 *  not permanently disable the CAS layer. Null = UNSUPPORTED. */
function tableSuffix(): Promise<string | null> {
  if (!tableSuffixPromise) {
    tableSuffixPromise = (async () => {
      try {
        return await _resolveTableSuffix();
      } catch (err) {
        console.error("atomicLock: table-suffix resolution failed", err);
        return null;
      }
    })().then((suffix) => {
      if (!suffix) tableSuffixPromise = null;
      return suffix;
    });
  }
  return tableSuffixPromise;
}

function buildCondition(
  conditions: LockCondition[],
  names: Record<string, string>,
  values: Record<string, unknown>,
  requireExists: boolean
): string {
  const parts: string[] = requireExists ? ["attribute_exists(#pk)"] : [];
  if (requireExists) names["#pk"] = "id";
  conditions.forEach((c, i) => {
    const n = `#c${i}`;
    names[n] = c.field;
    switch (c.kind) {
      case "notLiveLease":
        // Missing and NULL-typed attributes both fail the >= comparison, so
        // NOT(...) covers "never leased", "lease cleared", and "lease expired"
        // in one server-evaluated expression. ISO-8601 compares lexically.
        values[`:c${i}`] = c.nowIso;
        parts.push(`NOT (${n} >= :c${i})`);
        break;
      case "fieldEquals":
        values[`:c${i}`] = c.value;
        parts.push(`${n} = :c${i}`);
        break;
      case "fieldEqualsOrMissing":
        values[`:c${i}`] = c.value;
        parts.push(`(attribute_not_exists(${n}) OR ${n} = :c${i})`);
        break;
      case "fieldIn":
        parts.push(
          `(${c.values
            .map((v, j) => {
              values[`:c${i}v${j}`] = v;
              return `${n} = :c${i}v${j}`;
            })
            .join(" OR ")})`
        );
        break;
      case "fieldNotIn":
        parts.push(
          `(attribute_not_exists(${n}) OR (${c.values
            .map((v, j) => {
              values[`:c${i}v${j}`] = v;
              return `${n} <> :c${i}v${j}`;
            })
            .join(" AND ")}))`
        );
        break;
      case "fieldMissingOrNull":
        values[`:c${i}`] = null;
        parts.push(`(attribute_not_exists(${n}) OR ${n} = :c${i})`);
        break;
      case "fieldAtMostOrMissing":
        values[`:c${i}`] = c.value;
        parts.push(`(attribute_not_exists(${n}) OR ${n} <= :c${i})`);
        break;
      case "fieldAtLeast":
        values[`:c${i}`] = c.value;
        parts.push(`${n} >= :c${i}`);
        break;
    }
  });
  return parts.join(" AND ");
}

function dynamoStore(): LockStore {
  let ddb: DynamoDBClient | null = null;
  const clientFor = () => {
    if (!ddb) ddb = new DynamoDBClient({});
    return ddb;
  };
  return {
    async conditionalUpdate(model, id, sets, conditions, opts) {
      const suffix = await tableSuffix();
      if (!suffix) return { ok: false, reason: "UNSUPPORTED" };
      const names: Record<string, string> = {};
      const values: Record<string, unknown> = {};
      const setParts: string[] = [];
      const removeParts: string[] = [];
      // Keep AppSync readers honest about when a guarded write last touched
      // the row (AppSync auto-timestamps don't fire on direct writes).
      const withStamp: LockSets = {
        ...sets,
        updatedAt: new Date().toISOString(),
      };
      Object.entries(withStamp).forEach(([field, value], i) => {
        const n = `#s${i}`;
        names[n] = field;
        if (value === null) {
          removeParts.push(n);
        } else {
          values[`:s${i}`] = value;
          setParts.push(`${n} = :s${i}`);
        }
      });
      if (opts?.bumpField) {
        names["#bump"] = opts.bumpField;
        values[":bumpZero"] = 0;
        values[":bumpOne"] = 1;
        setParts.push(`#bump = if_not_exists(#bump, :bumpZero) + :bumpOne`);
      }
      if (opts?.addFields) {
        Object.entries(opts.addFields).forEach(([field, delta], j) => {
          const n = `#a${j}`;
          names[n] = field;
          values[`:aZero${j}`] = 0;
          values[`:a${j}`] = delta;
          setParts.push(`${n} = if_not_exists(${n}, :aZero${j}) + :a${j}`);
        });
      }
      const update =
        `SET ${setParts.join(", ")}` +
        (removeParts.length ? ` REMOVE ${removeParts.join(", ")}` : "");
      try {
        const out = await clientFor().send(
          new UpdateItemCommand({
            TableName: `${model}${suffix}`,
            Key: marshall({ id }),
            UpdateExpression: update,
            ConditionExpression: buildCondition(conditions, names, values, true),
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: marshall(values, {
              removeUndefinedValues: true,
            }),
            ReturnValues: "ALL_OLD",
          })
        );
        return {
          ok: true,
          prior: out.Attributes ? unmarshall(out.Attributes) : {},
        };
      } catch (err) {
        if ((err as { name?: string }).name !== "ConditionalCheckFailedException") {
          console.error(`atomicLock: conditionalUpdate(${model}, ${id}) failed`, err);
        }
        // Any failure means the guarded write did NOT happen. LOST is
        // reserved for a real condition race; a broken CAS layer (missing
        // table, denied access) is UNSUPPORTED so callers refuse-and-alarm
        // instead of concluding another worker holds the resource.
        return { ok: false, reason: _classifyLockError(err) };
      }
    },
    async conditionalDelete(model, id, conditions) {
      const suffix = await tableSuffix();
      if (!suffix) return "UNSUPPORTED";
      const names: Record<string, string> = {};
      const values: Record<string, unknown> = {};
      const expr = buildCondition(conditions, names, values, false);
      try {
        await clientFor().send(
          new DeleteItemCommand({
            TableName: `${model}${suffix}`,
            Key: marshall({ id }),
            ...(expr
              ? {
                  ConditionExpression: expr,
                  ExpressionAttributeNames: names,
                  ...(Object.keys(values).length
                    ? {
                        ExpressionAttributeValues: marshall(values, {
                          removeUndefinedValues: true,
                        }),
                      }
                    : {}),
                }
              : {}),
          })
        );
        return "OK";
      } catch (err) {
        if ((err as { name?: string }).name !== "ConditionalCheckFailedException") {
          console.error(`atomicLock: conditionalDelete(${model}, ${id}) failed`, err);
        }
        return _classifyLockError(err) === "UNSUPPORTED" ? "UNSUPPORTED" : "LOST";
      }
    },
  };
}

/** ConditionalCheckFailed = a genuine race (LOST). Misconfiguration that
 *  means the write could not even be ATTEMPTED against the real table —
 *  table missing, access denied — is UNSUPPORTED: the caller must treat the
 *  CAS layer as down, not conclude a competitor holds the resource. Unknown
 *  errors (network, throttle) stay LOST: the write may have been rejected
 *  for real, and "blocked" is the safe reading. */
export function _classifyLockError(err: unknown): "LOST" | "UNSUPPORTED" {
  const name = (err as { name?: string })?.name ?? "";
  return name === "ResourceNotFoundException" ||
    name === "AccessDeniedException" ||
    name === "UnrecognizedClientException"
    ? "UNSUPPORTED"
    : "LOST";
}

let activeStore: LockStore | null = null;

function store(): LockStore {
  if (!activeStore) activeStore = dynamoStore();
  return activeStore;
}

/** Tests inject a deterministic in-memory store; null restores production. */
export function _setLockStoreForTests(s: LockStore | null): void {
  activeStore = s;
}

// ---------------------------------------------------------------------------
// The protocol wrappers every lock/command module uses
// ---------------------------------------------------------------------------

/**
 * Atomically seize an EXPIRED lease on an existing row: one guarded update
 * that installs this worker's nonce + fresh lease (and bumps the attempt
 * count) only while no live lease exists — and, for durable commands, only
 * while the stage is not settled. Exactly one concurrent reclaimer's
 * condition passes. Returns the row's prior attributes so the winner resumes
 * from the recorded stage. LOST = someone else holds or re-took it;
 * UNSUPPORTED = no CAS wiring, and the caller MUST refuse the takeover.
 */
export async function casTakeover(
  model: string,
  id: string,
  opts: {
    nonceField: string;
    nonce: string;
    leaseField: string;
    leaseMs: number;
    bumpField?: string;
    /** Refuse when the row's stage settled while we raced (e.g. COMPLETE/FAILED). */
    refuseStages?: { field: string; values: string[] };
    extraSets?: LockSets;
  }
): Promise<LockUpdateResult> {
  const now = new Date();
  const conditions: LockCondition[] = [
    { kind: "notLiveLease", field: opts.leaseField, nowIso: now.toISOString() },
  ];
  if (opts.refuseStages) {
    conditions.push({
      kind: "fieldNotIn",
      field: opts.refuseStages.field,
      values: opts.refuseStages.values,
    });
  }
  return store().conditionalUpdate(
    model,
    id,
    {
      ...(opts.extraSets ?? {}),
      [opts.nonceField]: opts.nonce,
      [opts.leaseField]: new Date(now.getTime() + opts.leaseMs).toISOString(),
    },
    conditions,
    opts.bumpField ? { bumpField: opts.bumpField } : undefined
  );
}

/** A progress/terminal write fenced by the holder's nonce: it lands only while
 *  the nonce is still ours, so a worker that lost its lease can never
 *  overwrite the new holder's progress. */
export async function casFencedUpdate(
  model: string,
  id: string,
  fence: { field: string; nonce: string },
  sets: LockSets
): Promise<LockUpdateResult> {
  return store().conditionalUpdate(model, id, sets, [
    { kind: "fieldEquals", field: fence.field, value: fence.nonce },
  ]);
}

/** A release fenced by the holder's nonce — an expired worker cannot delete a
 *  newer worker's lock. `allowMissingFence` tolerates pre-migration rows that
 *  never carried a nonce. */
export async function casFencedDelete(
  model: string,
  id: string,
  fence: { field: string; nonce: string; allowMissingFence?: boolean }
): Promise<LockDeleteResult> {
  return store().conditionalDelete(model, id, [
    fence.allowMissingFence
      ? { kind: "fieldEqualsOrMissing", field: fence.field, value: fence.nonce }
      : { kind: "fieldEquals", field: fence.field, value: fence.nonce },
  ]);
}

/** A guarded delete that is not fence-shaped (e.g. sweeping a claim row that
 *  provably has NO live holder). */
export async function casGuardedDelete(
  model: string,
  id: string,
  conditions: LockCondition[]
): Promise<LockDeleteResult> {
  return store().conditionalDelete(model, id, conditions);
}

/** A guarded ATOMIC numeric add (e.g. the capacity ledger): the adds land
 *  only while every condition holds, evaluated with the write. */
export async function casGuardedAdd(
  model: string,
  id: string,
  addFields: Record<string, number>,
  conditions: LockCondition[]
): Promise<LockUpdateResult> {
  return store().conditionalUpdate(model, id, {}, conditions, { addFields });
}

/** A guarded state transition that is not lease-shaped (e.g. a seasonal
 *  month's DUE → SCHEDULED claim, conditioned on it still being DUE). */
export async function casGuardedUpdate(
  model: string,
  id: string,
  sets: LockSets,
  conditions: LockCondition[]
): Promise<LockUpdateResult> {
  return store().conditionalUpdate(model, id, sets, conditions);
}

// ---------------------------------------------------------------------------
// Deterministic in-memory store for unit tests
// ---------------------------------------------------------------------------

/**
 * An in-memory LockStore over the SAME row maps a test's dataClient fake uses,
 * so AppSync-path reads/creates and CAS-path guarded writes see one truth.
 * Condition evaluation + application is synchronous (no await between check
 * and write), which models DynamoDB's per-item atomicity: two interleaved
 * callers serialize, and exactly one guarded takeover can win.
 */
export function memoryLockStore(
  tables: Record<string, Map<string, Record<string, unknown>>>
): LockStore {
  const evaluate = (
    row: Record<string, unknown> | undefined,
    conditions: LockCondition[],
    requireExists: boolean
  ): boolean => {
    if (!row) return !requireExists && conditions.length === 0;
    for (const c of conditions) {
      const v = row[c.field];
      switch (c.kind) {
        case "notLiveLease":
          if (typeof v === "string" && v >= c.nowIso) return false;
          break;
        case "fieldEquals":
          if (v !== c.value) return false;
          break;
        case "fieldEqualsOrMissing":
          if (v !== undefined && v !== null && v !== c.value) return false;
          break;
        case "fieldIn":
          if (!c.values.includes(v as string | number)) return false;
          break;
        case "fieldNotIn":
          if (v !== undefined && v !== null && c.values.includes(v as string | number))
            return false;
          break;
        case "fieldMissingOrNull":
          if (v !== undefined && v !== null) return false;
          break;
        case "fieldAtMostOrMissing":
          if (v !== undefined && v !== null && Number(v) > c.value) return false;
          break;
        case "fieldAtLeast":
          if (v === undefined || v === null || Number(v) < c.value) return false;
          break;
      }
    }
    return true;
  };
  return {
    async conditionalUpdate(model, id, sets, conditions, opts) {
      const table = tables[model];
      if (!table) return { ok: false, reason: "UNSUPPORTED" };
      const row = table.get(id);
      if (!row || !evaluate(row, conditions, true)) {
        return { ok: false, reason: "LOST" };
      }
      const prior = { ...row };
      for (const [field, value] of Object.entries(sets)) {
        if (value === null) delete row[field];
        else row[field] = value;
      }
      row.updatedAt = new Date().toISOString();
      if (opts?.bumpField) {
        row[opts.bumpField] = (Number(prior[opts.bumpField]) || 0) + 1;
      }
      if (opts?.addFields) {
        for (const [field, delta] of Object.entries(opts.addFields)) {
          row[field] = (Number(prior[field]) || 0) + delta;
        }
      }
      return { ok: true, prior };
    },
    async conditionalDelete(model, id, conditions) {
      const table = tables[model];
      if (!table) return "UNSUPPORTED";
      const row = table.get(id);
      if (!row || !evaluate(row, conditions, true)) return "LOST";
      table.delete(id);
      return "OK";
    },
  };
}
