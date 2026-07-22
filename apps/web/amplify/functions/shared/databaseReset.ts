import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import { dataClient } from "./dataClient";

/**
 * Staging-only "clean start": snapshot every data model to S3, then delete
 * every record — with a 30-day archive you can roll back to. This is the
 * engine behind the CRM's Danger Zone (wipeDatabase / rollbackDatabase).
 *
 * Four independent guards keep this off production, because it is irreversible
 * data loss:
 *   1. the button is hidden on the production CRM hostnames (frontend);
 *   2. the route + mutations are OWNER-only (Cognito group);
 *   3. the handler re-checks callerIsOwner (server-side);
 *   4. assertNotProduction() throws when AMPLIFY_BRANCH === "main". This one is
 *      authoritative — the branch is baked into the Lambda env at deploy time
 *      from AWS_BRANCH, so a main deploy can never run the wipe no matter what
 *      the caller sends.
 *
 * Every wipe writes its pre-wipe snapshot to s3://$DOCS_BUCKET/db-archives/
 * and a DatabaseArchive manifest row. Objects auto-expire after 30 days via an
 * S3 lifecycle rule (see backend.ts); rollback restores from a chosen archive
 * whose object still exists.
 */

const ARCHIVE_PREFIX = "db-archives/";
const ARCHIVE_TTL_DAYS = 30;

/** How many list/delete/create round-trips to run at once. Keeps a wipe of
 *  staging test-data volumes well under the AppSync 30s resolver ceiling. */
const CONCURRENCY = 40;

/** Bookkeeping that must OUTLIVE a wipe — deleting the manifest would orphan
 *  every archive's own record and make rollback undiscoverable. Excluded from
 *  both the snapshot and the delete sweep. */
const PRESERVED_MODELS = new Set(["DatabaseArchive"]);

/** Models whose primary key is not `id`. Deletes must key on these fields. */
const CUSTOM_IDENTIFIERS: Record<string, string[]> = {
  SuppressedEmail: ["email"],
};

/** Amplify-managed columns that are read-only on create — stripped before a
 *  restore re-creates the record. */
const SYSTEM_FIELDS = new Set(["createdAt", "updatedAt", "__typename"]);

type AnyModel = {
  list: (args: {
    limit?: number;
    nextToken?: string | null;
  }) => Promise<{
    data: Record<string, unknown>[];
    nextToken?: string | null;
    errors?: { message: string }[];
  }>;
  create: (
    input: Record<string, unknown>
  ) => Promise<{ errors?: { message: string }[] }>;
  delete: (
    id: Record<string, unknown>
  ) => Promise<{ errors?: { message: string }[] }>;
};

/** The whole model map, deliberately loose: the generated client type is so
 *  large that touching it strongly (Object.keys, indexing) trips TS's depth
 *  ceiling, so we work through this narrow shape via a single `unknown` cast. */
type ModelMap = Record<string, AnyModel>;

type ArchiveModel = {
  get: (id: { id: string }) => Promise<{
    data: Record<string, unknown> | null;
    errors?: { message: string }[];
  }>;
  create: (
    input: Record<string, unknown>
  ) => Promise<{ errors?: { message: string }[] }>;
  update: (
    input: Record<string, unknown>
  ) => Promise<{ errors?: { message: string }[] }>;
};

/** One narrow view of the generated client — the only place we cross from the
 *  deep generated types into our loose shapes. */
async function resetClient(): Promise<{
  models: ModelMap;
  archive: ArchiveModel;
}> {
  const client = await dataClient();
  const models = client.models as unknown as ModelMap;
  const archive = (
    client.models as unknown as { DatabaseArchive: ArchiveModel }
  ).DatabaseArchive;
  return { models, archive };
}

export type ResetSummary = {
  archiveId?: string;
  totalRecords: number;
  counts: Record<string, number>;
  models: number;
};

/** The load-bearing production guard. Throws on the main branch. */
export function assertNotProduction(): void {
  const branch = process.env.AMPLIFY_BRANCH ?? "";
  if (branch === "main") {
    throw new Error(
      "Database reset is disabled on production. This tool runs on staging only."
    );
  }
}

function bucket(): string {
  const name = process.env.DOCS_BUCKET;
  if (!name) throw new Error("DOCS_BUCKET is not configured");
  return name;
}

const s3 = new S3Client({});

/** Every wipeable model name on the live client, minus the preserved ones. */
function wipeableModelNames(models: ModelMap): string[] {
  return Object.keys(models).filter((n) => !PRESERVED_MODELS.has(n));
}

async function listAll(model: AnyModel): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let token: string | null | undefined;
  do {
    const page = await model.list({ limit: 1000, nextToken: token });
    if (page.errors?.length) {
      throw new Error(page.errors.map((e) => e.message).join("; "));
    }
    out.push(...page.data);
    token = page.nextToken;
  } while (token);
  return out;
}

/** Run `fn` over `items` at most CONCURRENCY at a time. */
async function inBatches<T>(
  items: T[],
  fn: (item: T) => Promise<void>
): Promise<void> {
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    await Promise.all(items.slice(i, i + CONCURRENCY).map(fn));
  }
}

function identifierOf(
  modelName: string,
  record: Record<string, unknown>
): Record<string, unknown> {
  const keys = CUSTOM_IDENTIFIERS[modelName] ?? ["id"];
  const id: Record<string, unknown> = {};
  for (const k of keys) id[k] = record[k];
  return id;
}

function stripSystemFields(
  record: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    // Drop Amplify system columns and any null-valued keys (a null relation or
    // absent optional field must not be sent as an explicit null on create).
    if (SYSTEM_FIELDS.has(k) || v === null) continue;
    out[k] = v;
  }
  return out;
}

/** Snapshot every wipeable model into one keyed object. */
async function snapshot(models: ModelMap): Promise<{
  data: Record<string, Record<string, unknown>[]>;
  counts: Record<string, number>;
  total: number;
}> {
  const names = wipeableModelNames(models);
  const data: Record<string, Record<string, unknown>[]> = {};
  const counts: Record<string, number> = {};
  let total = 0;
  for (const name of names) {
    const model = models[name];
    const records = await listAll(model);
    data[name] = records;
    counts[name] = records.length;
    total += records.length;
  }
  return { data, counts, total };
}

/** Delete every record in every wipeable model. */
async function deleteEverything(
  models: ModelMap,
  data: Record<string, Record<string, unknown>[]>
): Promise<void> {
  for (const [name, records] of Object.entries(data)) {
    const model = models[name];
    await inBatches(records, async (record) => {
      const res = await model.delete(identifierOf(name, record));
      if (res.errors?.length) {
        throw new Error(
          `Delete ${name}: ${res.errors.map((e) => e.message).join("; ")}`
        );
      }
    });
  }
}

async function putSnapshot(key: string, body: unknown): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket(),
      Key: key,
      Body: JSON.stringify(body),
      ContentType: "application/json",
    })
  );
}

async function getSnapshot(
  key: string
): Promise<Record<string, Record<string, unknown>[]>> {
  const res = await s3.send(
    new GetObjectCommand({ Bucket: bucket(), Key: key })
  );
  const text = await res.Body!.transformToString();
  return JSON.parse(text) as Record<string, Record<string, unknown>[]>;
}

/**
 * Snapshot the whole database to S3, record a DatabaseArchive manifest, then
 * delete every record. The manifest row is what the Danger Zone lists and what
 * rollback keys on.
 */
export async function wipeDatabase(label?: string | null): Promise<ResetSummary> {
  assertNotProduction();
  const { models, archive } = await resetClient();

  const { data, counts, total } = await snapshot(models);

  const archiveId = randomUUID();
  const key = `${ARCHIVE_PREFIX}${archiveId}.json`;
  const now = new Date();
  const expiresAt = new Date(
    now.getTime() + ARCHIVE_TTL_DAYS * 24 * 60 * 60 * 1000
  );

  await putSnapshot(key, data);

  const manifest = await archive.create({
    id: archiveId,
    label: label?.trim() || `Wipe ${now.toISOString().slice(0, 16).replace("T", " ")}`,
    s3Key: key,
    branch: process.env.AMPLIFY_BRANCH ?? "staging",
    takenAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    totalRecords: total,
    counts,
    status: "ACTIVE",
  });
  if (manifest.errors?.length) {
    throw new Error(
      `Archive manifest: ${manifest.errors.map((e) => e.message).join("; ")}`
    );
  }

  await deleteEverything(models, data);

  return {
    archiveId,
    totalRecords: total,
    counts,
    models: Object.keys(data).length,
  };
}

/**
 * Restore the database from an archive: wipe whatever is there now, then
 * re-create every record from the archive's S3 snapshot. Marks the archive
 * RESTORED. Only the archive's models are recreated; DatabaseArchive manifests
 * are preserved throughout.
 */
export async function rollbackDatabase(archiveId: string): Promise<ResetSummary> {
  assertNotProduction();
  if (!archiveId) throw new Error("archiveId is required");
  const { models, archive } = await resetClient();

  const found = await archive.get({ id: archiveId });
  if (found.errors?.length) {
    throw new Error(found.errors.map((e) => e.message).join("; "));
  }
  const manifest = found.data;
  if (!manifest) throw new Error("That archive no longer exists");
  const key = manifest.s3Key as string;

  let data: Record<string, Record<string, unknown>[]>;
  try {
    data = await getSnapshot(key);
  } catch {
    throw new Error(
      "This archive's snapshot has expired (archives are kept 30 days) and can no longer be restored."
    );
  }

  // Clear current data first so the restore is a true replace, not a merge.
  const current = await snapshot(models);
  await deleteEverything(models, current.data);

  let total = 0;
  const counts: Record<string, number> = {};
  for (const [name, records] of Object.entries(data)) {
    const model = models[name];
    // A model in an old snapshot that no longer exists in the schema is skipped.
    if (!model) continue;
    counts[name] = 0;
    await inBatches(records, async (record) => {
      const res = await model.create(stripSystemFields(record));
      if (res.errors?.length) {
        throw new Error(
          `Restore ${name}: ${res.errors.map((e) => e.message).join("; ")}`
        );
      }
      counts[name] += 1;
      total += 1;
    });
  }

  const updated = await archive.update({
    id: archiveId,
    status: "RESTORED",
    restoredAt: new Date().toISOString(),
  });
  if (updated.errors?.length) {
    throw new Error(updated.errors.map((e) => e.message).join("; "));
  }

  return { archiveId, totalRecords: total, counts, models: Object.keys(counts).length };
}
