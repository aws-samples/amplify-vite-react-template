import { getUrl } from "aws-amplify/storage";
import { useAsyncResource } from "../lib/useAsyncResource";
import Modal from "./Modal";

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"]);
const INLINE_EXT = new Set(["pdf", "txt", ...IMAGE_EXT]);

export function canPreview(nameOrKey: string): boolean {
  const ext = nameOrKey.split(".").pop()?.toLowerCase() ?? "";
  return INLINE_EXT.has(ext);
}

/**
 * Modal preview for any stored file: images render as <img>, PDFs and text
 * in an <iframe> via a signed URL. Everything gets a Download fallback.
 *
 * The shell this used to hand-roll now lives in `<Modal>`; what is left here
 * is the file-specific part — the signed-URL fetch, the loading and error
 * branches, and the img-vs-iframe-vs-nothing choice. The download link is a
 * header control, not body content, so it goes through Modal's `actions`.
 */
export default function FilePreviewModal({
  s3Key,
  name,
  onClose,
}: {
  s3Key: string;
  name: string;
  onClose: () => void;
}) {
  const res = useAsyncResource(
    async () => (await getUrl({ path: s3Key })).url.toString(),
    [s3Key],
    { initialData: null as string | null, errorMessage: "Could not load file" }
  );
  const url = res.data;
  const error = res.error;

  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const isImage = IMAGE_EXT.has(ext);

  return (
    <Modal
      title={name}
      onClose={onClose}
      actions={
        url ? (
          <a href={url} target="_blank" rel="noreferrer">
            <button className="secondary">Open / download</button>
          </a>
        ) : null
      }
    >
      {error ? (
        <p className="error-text">{error}</p>
      ) : !url ? (
        <p className="muted small">Loading…</p>
      ) : isImage ? (
        <img src={url} alt={name} />
      ) : canPreview(name) ? (
        <iframe src={url} title={name} />
      ) : (
        <p className="muted small">
          No inline preview for this file type — use Open / download.
        </p>
      )}
    </Modal>
  );
}
