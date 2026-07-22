import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";

/**
 * GL-10 — the guarantee callback REQUIRES a customer photo, and "requires"
 * means a real uploaded image, not a plausible-looking string. The presign
 * endpoint hands out keys under `callbacks/<customerId>/`; this check
 * verifies the submitted key (a) belongs to THIS customer's prefix — a key
 * can never reference another customer's file or an arbitrary bucket
 * object — and (b) actually exists in the bucket as an image. Fail closed:
 * an unverifiable photo refuses the callback with the fix named.
 */

let s3: S3Client | null = null;

export async function verifyCallbackPhoto(
  photoKey: string,
  customerId: string
): Promise<void> {
  const key = photoKey.trim();
  const prefix = `callbacks/${customerId}/`;
  if (!key.startsWith(prefix)) {
    throw new Error(
      "That photo isn't attached to this account — upload it through the callback form and resubmit."
    );
  }
  const bucket = process.env.DOCS_BUCKET;
  if (!bucket) {
    throw new Error(
      "Photo storage isn't configured, so the required photo can't be verified — call the office and we'll take the callback by hand."
    );
  }
  let contentType = "";
  try {
    if (!s3) s3 = new S3Client({});
    const head = await s3.send(
      new HeadObjectCommand({ Bucket: bucket, Key: key })
    );
    contentType = head.ContentType ?? "";
  } catch (err) {
    const name = (err as { name?: string })?.name ?? "";
    if (name === "NotFound" || name === "NoSuchKey" || name === "404") {
      throw new Error(
        "The photo upload didn't finish — try the upload again, then resubmit the callback."
      );
    }
    throw new Error(
      "The photo can't be verified right now — try again in a moment, or call the office."
    );
  }
  if (!contentType.startsWith("image/")) {
    throw new Error(
      "The uploaded file isn't an image — the guarantee callback needs a photo of what you're seeing."
    );
  }
}

/** Tests inject a fake; null restores the real S3 client. */
export function _setS3ClientForTests(client: unknown): void {
  s3 = client as S3Client | null;
}
