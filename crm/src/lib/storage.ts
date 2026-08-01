/**
 * S3 upload / download / delete primitives.
 *
 * Every write goes through `assertGrantedPath`, so a typo'd prefix fails
 * here with a readable message instead of as an opaque 403 from S3.
 *
 * ORDERING — the three orderings in the codebase are not interchangeable, and
 * this module keeps two of them rather than collapsing them into one:
 *
 *   create record → upload   (`uploadDocument`)
 *     Required when the object key contains the record's own id, which is the
 *     case for documents/: the OCR Lambda parses the Document id back out of
 *     the key, so the record has to exist before the object lands. The failure
 *     mode is a ghost record pointing at nothing, which the UI *does* show —
 *     so a failed upload deletes the record.
 *
 *   upload → link record     (`uploadFile`, `uploadAndLink`)
 *     Correct everywhere the key is derived from an id that already exists.
 *     The failure mode is an unreferenced S3 object, which nobody sees. The
 *     inverse (record first) would leave a record pointing at a key that
 *     404s on download — visibly broken. Prefer the invisible failure.
 *
 * Nothing here swallows an error. `deleteFile` is the one function that does
 * not throw, and it still returns the failure and logs it — see its doc.
 */
import { getUrl, remove, uploadData } from "aws-amplify/storage";
import { client, type CrmDocument } from "./client";
import type { Schema } from "../../amplify/data/resource";

type DocumentEntityType = Schema["DocumentEntityType"]["type"];
type DocumentCategory = NonNullable<Schema["DocumentCategory"]["type"]>;

/**
 * Placeholder s3Key on a Document record between "created" and "uploaded".
 * Not a real object, so delete/download must refuse it.
 */
export const PENDING_KEY = "pending";

/**
 * The prefixes `amplify/storage/resource.ts` actually grants. A path outside
 * these can only ever 403, so we refuse it before the network call.
 *
 * Deliberately no `signaturePath(profileId)` helper: `signatures/` has a known
 * open-overwrite gap (documented in resource.ts) and a convenience builder
 * would make writing to someone else's signature key a one-liner. Callers that
 * legitimately write there spell the key out themselves.
 */
export const GRANTED_PREFIXES = [
  "certificates/",
  "documents/",
  "generated/",
  "property-photos/",
  "signatures/",
  "templates/",
] as const;

/** Throws unless `path` is a well-formed key under a granted prefix. */
export function assertGrantedPath(path: string): string {
  const p = (path ?? "").trim();
  if (!GRANTED_PREFIXES.some((prefix) => p.startsWith(prefix))) {
    throw new Error(
      `"${path}" is not under a granted storage prefix (${GRANTED_PREFIXES.join(", ")}).`
    );
  }
  if (p.includes("..") || p.includes("//") || p.endsWith("/")) {
    throw new Error(`"${path}" is not a valid object key.`);
  }
  return p;
}

/** Control characters, which S3 keys must not contain. */
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001f\\u007f]", "g");

/**
 * Make one user-supplied value safe to drop into a key. A filename containing
 * a slash would otherwise add a level to the key, which breaks the OCR
 * trigger's `documents/{type}/{entity}/{documentId}/{file}` parse — and any
 * surviving `..` would be rejected by `assertGrantedPath`, turning a merely
 * odd filename into a failed upload.
 */
export function safeSegment(value: string): string {
  const cleaned = value
    .replace(CONTROL_CHARS, "")
    .replace(/[/\\]+/g, "_")
    // Flatten dot runs wherever they landed, not just at the front: the slash
    // collapse above moves a leading "../" into the middle of the segment.
    .replace(/\.{2,}/g, ".")
    .replace(/^[._]+/, "")
    .trim();
  return cleaned || "file";
}

// ── Upload ───────────────────────────────────────────────────────────

export type UploadInput = {
  path: string;
  data: Blob | File;
  /** Falsy is normalised away — S3 rejects an empty Content-Type. */
  contentType?: string;
};

/**
 * Put one object. Throws on failure; records nothing.
 *
 * For callers whose record write is a single field on an entity that already
 * exists (a photo slot, a signature key, an ACORD template with no record at
 * all) — do the update yourself afterwards. See `uploadAndLink` when a failed
 * record write should take the object with it.
 */
export async function uploadFile(input: UploadInput): Promise<string> {
  const path = assertGrantedPath(input.path);
  await uploadData({
    path,
    data: input.data,
    options: { contentType: input.contentType || undefined },
  }).result;
  return path;
}

/**
 * Put one object, then record where it went.
 *
 * `pathIsNew` is required rather than defaulted because getting it wrong
 * destroys data. It answers: "if `link` fails, is this object certainly
 * unreferenced?"
 *
 *   true  — the key is unique to this upload (a timestamp, a fresh record id).
 *           A failed link orphans it, so it is removed.
 *   false — the key is stable for the entity, so this upload may have
 *           overwritten an object some record already points at. The object
 *           stays: an orphan is cheap, a dangling reference is a broken image.
 *
 * The link error is always rethrown; cleanup never masks it.
 */
export async function uploadAndLink<T>(opts: {
  path: string;
  data: Blob | File;
  contentType?: string;
  link: (path: string) => Promise<T>;
  pathIsNew: boolean;
}): Promise<{ result: T; path: string }> {
  const path = await uploadFile({
    path: opts.path,
    data: opts.data,
    contentType: opts.contentType,
  });
  try {
    return { result: await opts.link(path), path };
  } catch (err) {
    if (opts.pathIsNew) await deleteFile(path);
    throw err;
  }
}

/**
 * Attach a file to an entity: create the Document row, put the object at
 * `documents/{entityType}/{entityId}/{documentId}/{filename}`, point the row
 * at it.
 *
 * Record-first is forced here — the key embeds the row's id. So a failed
 * upload leaves a row the Documents tab would render with a download button
 * that 404s; the row is deleted before the error is rethrown.
 */
export async function uploadDocument(opts: {
  entityType: DocumentEntityType;
  entityId: string;
  category: DocumentCategory;
  file: File;
}): Promise<CrmDocument> {
  const { entityType, entityId, category, file } = opts;

  const { data: doc, errors } = await client.models.Document.create({
    entityType,
    entityId,
    category,
    name: file.name,
    s3Key: PENDING_KEY,
    contentType: file.type,
    sizeBytes: file.size,
    ocrStatus: "PENDING",
  });
  if (errors?.length || !doc) {
    throw new Error(errors?.[0]?.message ?? `Couldn't record "${file.name}".`);
  }

  try {
    const path = assertGrantedPath(
      [
        "documents",
        safeSegment(entityType),
        safeSegment(entityId),
        safeSegment(doc.id),
        safeSegment(file.name),
      ].join("/")
    );
    const { data: linked, errors: linkErrors } = await client.models.Document.update({
      id: doc.id,
      s3Key: path,
    });
    if (linkErrors?.length) throw new Error(linkErrors[0].message);

    await uploadFile({ path, data: file, contentType: file.type });
    return linked ?? { ...doc, s3Key: path };
  } catch (err) {
    // Don't leave a ghost record behind for a file that never landed.
    try {
      const { errors: delErrors } = await client.models.Document.delete({ id: doc.id });
      if (delErrors?.length) throw new Error(delErrors[0].message);
    } catch (cleanupErr) {
      console.warn(
        `[storage] "${file.name}" failed to upload and its record ${doc.id} could not be ` +
          `removed — it will show as a document with no file: ${describe(cleanupErr)}`
      );
    }
    throw err;
  }
}

// ── Download ─────────────────────────────────────────────────────────

/**
 * Signed URL for an object. `validate` costs an extra HEAD but turns a
 * missing key into a catchable error instead of a tab full of S3 XML.
 */
export async function getFileUrl(
  path: string,
  opts?: { validate?: boolean }
): Promise<string> {
  const { url } = await getUrl({
    path,
    options: { validateObjectExistence: opts?.validate ?? false },
  });
  return url.toString();
}

export type DownloadResult = {
  url: string;
  /**
   * False when the browser refused the new tab. The three existing copies of
   * this open couldn't tell, so a blocked popup looked like a dead button.
   * Callers should offer `url` as a plain link when this is false.
   */
  opened: boolean;
};

/**
 * Open an object in a new tab.
 *
 * Throws if no URL could be produced (missing object, no permission, key not
 * uploaded yet) — that is a real failure the caller should show. A blocked
 * popup is not a failure of the download, so it comes back as `opened: false`.
 */
export async function downloadFile(
  path: string | null | undefined
): Promise<DownloadResult> {
  if (!path || !path.trim() || path === PENDING_KEY) {
    throw new Error("That file hasn't finished uploading yet.");
  }
  const url = await getFileUrl(path, { validate: true });
  // No "noopener" in the feature string: browsers return null for it even on
  // success, which would make every open look blocked. Drop the back-reference
  // afterwards instead.
  const opened = window.open(url, "_blank");
  if (!opened || opened.closed) return { url, opened: false };
  try {
    opened.opener = null;
  } catch {
    // Cross-origin by the time it navigated; nothing to do.
  }
  return { url, opened: true };
}

// ── Delete ───────────────────────────────────────────────────────────

export type DeleteResult =
  | { status: "deleted"; path: string }
  /** Nothing to remove: no key, or the record never got past "pending". */
  | { status: "skipped"; path: string | null }
  | { status: "failed"; path: string | null; error: string };

/**
 * Remove an object.
 *
 * This is the one function here that does not throw, and the reason is
 * specific: every caller deletes the object as a prelude to deleting (or
 * unlinking) the record, and a failed S3 delete must not abort that — you'd
 * strand the user with a record they can't get rid of, to fix an orphaned
 * object they can't see.
 *
 * But not throwing is not the same as `.catch(() => {})`. The failure comes
 * back in the result so a caller can surface it, and is logged either way, so
 * "the object is still there" is never invisible.
 */
export async function deleteFile(
  path: string | null | undefined
): Promise<DeleteResult> {
  if (!path || !path.trim() || path === PENDING_KEY) {
    return { status: "skipped", path: path ?? null };
  }
  try {
    const safe = assertGrantedPath(path);
    await remove({ path: safe });
    return { status: "deleted", path: safe };
  } catch (err) {
    const error = describe(err);
    console.warn(`[storage] couldn't delete "${path}" — object is now orphaned: ${error}`);
    return { status: "failed", path, error };
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err ?? "unknown error");
}
