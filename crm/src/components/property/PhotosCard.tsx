import { useEffect, useState } from "react";
import { uploadData, getUrl, remove } from "aws-amplify/storage";
import {
  client,
  friendlyError,
  type Account,
} from "../../lib/client";
import ConfirmButton from "../ConfirmButton";
import FilePreviewModal from "../FilePreview";

const PHOTO_SLOTS = [
  { key: "coverPhotoKey", label: "Cover photo" },
  { key: "aerialPhotoKey", label: "Aerial photo" },
  { key: "plotPlanKey", label: "Plot plan" },
] as const;

export default function PhotosCard({
  account,
  onChange,
}: {
  account: Account;
  onChange: (a: Account) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ s3Key: string; name: string } | null>(null);
  const [error, setError] = useState("");

  async function upload(slotKey: (typeof PHOTO_SLOTS)[number]["key"], file?: File) {
    if (!file) return;
    setBusy(slotKey);
    setError("");
    try {
      const path = `property-photos/${account.id}/${slotKey}-${file.name}`;
      await uploadData({
        path,
        data: file,
        options: { contentType: file.type || undefined },
      }).result;
      const old = account[slotKey];
      const { data } = await client.models.Account.update({
        id: account.id,
        [slotKey]: path,
      });
      if (old && old !== path) await remove({ path: old }).catch(() => {});
      if (data) onChange(data);
    } catch (err) {
      setError(friendlyError(err, "Upload failed"));
    } finally {
      setBusy(null);
    }
  }

  async function clear(slotKey: (typeof PHOTO_SLOTS)[number]["key"]) {
    const old = account[slotKey];
    if (old) await remove({ path: old }).catch(() => {});
    const { data } = await client.models.Account.update({
      id: account.id,
      [slotKey]: null,
    });
    if (data) onChange(data);
  }

  return (
    <div className="card">
      <h2>Site photos &amp; plans</h2>
      <div className="photo-row">
        {PHOTO_SLOTS.map((slot) => (
          <PhotoSlot
            key={slot.key}
            label={slot.label}
            s3Key={account[slot.key] ?? null}
            busy={busy === slot.key}
            onUpload={(f) => upload(slot.key, f)}
            onView={(s3Key) =>
              setPreview({ s3Key, name: s3Key.split("/").pop() ?? slot.label })
            }
            onClear={() => clear(slot.key)}
            // <ConfirmButton> catches the rejection either way; without this
            // it would be dropped, and a confirm that silently does nothing
            // is worse than the unguarded button it replaced.
            onClearError={(err) => setError(friendlyError(err, "Remove failed"))}
          />
        ))}
      </div>
      {error && <p className="error-text">{error}</p>}
      {preview && (
        <FilePreviewModal
          s3Key={preview.s3Key}
          name={preview.name}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  );
}

function PhotoSlot({
  label,
  s3Key,
  busy,
  onUpload,
  onView,
  onClear,
  onClearError,
}: {
  label: string;
  s3Key: string | null;
  busy: boolean;
  onUpload: (f?: File) => void;
  onView: (s3Key: string) => void;
  /** May be async — the confirm button stays busy until it settles. */
  onClear: () => void | Promise<unknown>;
  onClearError: (err: unknown) => void;
}) {
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const isImage = s3Key
    ? /\.(png|jpe?g|gif|webp)$/i.test(s3Key)
    : false;

  useEffect(() => {
    setThumbUrl(null);
    if (s3Key && isImage) {
      getUrl({ path: s3Key }).then(({ url }) => setThumbUrl(url.toString()));
    }
  }, [s3Key, isImage]);

  return (
    <div className="photo-slot">
      <div className="ph-label">{label}</div>
      {s3Key ? (
        thumbUrl ? (
          <img src={thumbUrl} alt={label} onClick={() => onView(s3Key)} />
        ) : (
          <div
            className="ph-empty"
            style={{ cursor: "pointer" }}
            onClick={() => onView(s3Key)}
          >
            {isImage ? "Loading…" : "View file"}
          </div>
        )
      ) : (
        <div className="ph-empty">{busy ? "Uploading…" : "None"}</div>
      )}
      <div style={{ marginTop: 8, display: "flex", gap: 6, justifyContent: "center" }}>
        <label className="link" style={{ cursor: "pointer" }}>
          {s3Key ? "Replace" : "Upload"}
          <input
            type="file"
            accept="image/*,.pdf"
            hidden
            disabled={busy}
            onChange={(e) => onUpload(e.target.files?.[0])}
          />
        </label>
        {s3Key && (
          /* Was unguarded: one click deleted the S3 object and nulled the
             field. */
          <ConfirmButton
            label="Remove"
            busyLabel="Removing…"
            message={`Remove the ${label.toLowerCase()}? The stored file is deleted.`}
            onConfirm={onClear}
            onError={onClearError}
          />
        )}
      </div>
    </div>
  );
}
