import { useEffect, useState } from "react";
import { getUrl } from "aws-amplify/storage";
import { friendlyError } from "../lib/client";

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"]);
const INLINE_EXT = new Set(["pdf", "txt", ...IMAGE_EXT]);

export function canPreview(nameOrKey: string): boolean {
  const ext = nameOrKey.split(".").pop()?.toLowerCase() ?? "";
  return INLINE_EXT.has(ext);
}

/**
 * Modal preview for any stored file: images render as <img>, PDFs and text
 * in an <iframe> via a signed URL. Everything gets a Download fallback.
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
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    getUrl({ path: s3Key })
      .then(({ url }) => setUrl(url.toString()))
      .catch((err) => setError(friendlyError(err, "Could not load file")));
  }, [s3Key]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const isImage = IMAGE_EXT.has(ext);

  return (
    <div className="preview-overlay" onClick={onClose}>
      <div className="preview-modal" onClick={(e) => e.stopPropagation()}>
        <div className="preview-head">
          <span className="preview-title" title={name}>
            {name}
          </span>
          <div>
            {url && (
              <a href={url} target="_blank" rel="noreferrer">
                <button className="secondary">Open / download</button>
              </a>
            )}{" "}
            <button className="secondary" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
        <div className="preview-body">
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
        </div>
      </div>
    </div>
  );
}
