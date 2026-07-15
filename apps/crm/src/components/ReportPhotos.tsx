import { useEffect, useRef, useState } from "react";
import { api, opResult, unwrap, type ServiceReport } from "../lib/api";
import { Button, ErrorNote } from "../ui/kit";

/**
 * Photos on a service report. Technicians attach job-site photos (before/
 * after, findings); files go straight to S3 via a presigned PUT and the keys
 * live on the report. Read-only when the report is finalized.
 */

function useSignedUrls(keys: string[]) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  useEffect(() => {
    let cancel = false;
    (async () => {
      const missing = keys.filter((k) => !urls[k]);
      for (const key of missing) {
        try {
          const res = await api().queries.getDocumentUrl({ key });
          const { url } = opResult<{ url?: string }>(res) ?? {};
          if (url && !cancel) setUrls((u) => ({ ...u, [key]: url }));
        } catch {
          /* thumbnail just won't render */
        }
      }
    })();
    return () => {
      cancel = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys.join("|")]);
  return urls;
}

export default function ReportPhotos({
  report,
  readOnly,
  onChanged,
}: {
  report: ServiceReport;
  readOnly?: boolean;
  onChanged: () => Promise<void> | void;
}) {
  const keys = (report.photoKeys ?? []).filter(
    (k): k is string => typeof k === "string" && k.length > 0
  );
  const urls = useSignedUrls(keys);
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const upload = async (files: FileList) => {
    setBusy(true);
    setError(null);
    try {
      const added: string[] = [];
      for (const file of Array.from(files).slice(0, 10)) {
        const res = await api().mutations.getReportPhotoUploadUrl({
          reportId: report.id,
          contentType: file.type || "image/jpeg",
        });
        const target = opResult<{ key: string; uploadUrl: string }>(res);
        if (!target?.uploadUrl) throw new Error("Could not get an upload URL");
        const put = await fetch(target.uploadUrl, {
          method: "PUT",
          body: file,
          headers: { "Content-Type": file.type || "image/jpeg" },
        });
        if (!put.ok) throw new Error(`Upload failed (${put.status})`);
        added.push(target.key);
      }
      if (added.length) {
        unwrap(
          await api().models.ServiceReport.update({
            id: report.id,
            photoKeys: [...keys, ...added],
          })
        );
        await onChanged();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Photo upload failed");
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const remove = async (key: string) => {
    try {
      unwrap(
        await api().models.ServiceReport.update({
          id: report.id,
          photoKeys: keys.filter((k) => k !== key),
        })
      );
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove photo");
    }
  };

  if (readOnly && keys.length === 0) return null;

  return (
    <div className="photo-block">
      {keys.length > 0 ? (
        <div className="photo-grid">
          {keys.map((key) => (
            <div key={key} className="photo-thumb">
              {urls[key] ? (
                <a href={urls[key]} target="_blank" rel="noreferrer">
                  <img src={urls[key]} alt="Job site photo" loading="lazy" />
                </a>
              ) : (
                <div className="photo-loading" />
              )}
              {!readOnly ? (
                <button
                  type="button"
                  className="photo-remove"
                  aria-label="Remove photo"
                  onClick={() => void remove(key)}
                >
                  ✕
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {!readOnly ? (
        <>
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            capture="environment"
            multiple
            hidden
            onChange={(e) => e.target.files?.length && void upload(e.target.files)}
          />
          <Button
            small
            variant="subtle"
            loading={busy}
            onClick={() => fileInput.current?.click()}
          >
            📷 Add photos
          </Button>
        </>
      ) : null}
      <ErrorNote error={error} />
    </div>
  );
}
