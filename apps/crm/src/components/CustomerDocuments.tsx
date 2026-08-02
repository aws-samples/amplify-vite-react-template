import { useRef, useState } from "react";
import { api, opResult, unwrap, type Customer } from "../lib/api";
import { useAction } from "../lib/useAsync";
import { Badge, Button, ErrorNote } from "../ui/kit";
import DocButton from "./DocButton";

/**
 * Office-uploaded documents on a customer — most often an agreement signed
 * OUTSIDE the software, plus letters, inspections, insurance. Files go straight
 * to S3 via a presigned PUT (getCustomerDocumentUploadUrl); the entry is then
 * appended to Customer.documents (recordCustomerDocument). Viewing reuses the
 * entitlement-checked getDocumentUrl (DocButton).
 *
 * Distinct from the Agreements section above it: those are locked legal records
 * the system generates behind a payment; these are arbitrary files the office
 * attaches by hand.
 */

type DocEntry = {
  id: string;
  title: string;
  kind?: string;
  fileKey: string;
  contentType?: string;
  sizeBytes?: number;
  uploadedByEmail?: string;
  uploadedAt?: string;
};

const KINDS = ["AGREEMENT", "INSPECTION", "INSURANCE", "INVOICE", "OTHER"];
const ACCEPT = "application/pdf,image/jpeg,image/png,image/webp,image/heic";

function parseDocuments(raw: unknown): DocEntry[] {
  const v = typeof raw === "string" ? safeParse(raw) : raw;
  return Array.isArray(v) ? (v as DocEntry[]) : [];
}
function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
function fmtSize(bytes?: number): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function fmtDate(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString();
}

export default function CustomerDocuments({
  customer,
  onChanged,
}: {
  customer: Customer;
  onChanged: () => Promise<void> | void;
}) {
  const docs = parseDocuments((customer as { documents?: unknown }).documents)
    .slice()
    .sort((a, b) => (b.uploadedAt ?? "").localeCompare(a.uploadedAt ?? ""));

  const fileInput = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState("AGREEMENT");

  const upload = useAction(async (file: File) => {
    const contentType = file.type || "application/pdf";
    const urlRes = await api().mutations.getCustomerDocumentUploadUrl({
      customerId: customer.id,
      contentType,
    });
    const target = opResult<{ key: string; uploadUrl: string }>(urlRes);
    if (!target?.uploadUrl) throw new Error("Could not get an upload URL");

    const put = await fetch(target.uploadUrl, {
      method: "PUT",
      body: file,
      headers: { "Content-Type": contentType },
    });
    if (!put.ok) throw new Error(`Upload failed (${put.status})`);

    unwrap(
      await api().mutations.recordCustomerDocument({
        customerId: customer.id,
        key: target.key,
        title: title.trim() || file.name,
        kind,
        contentType,
        sizeBytes: file.size,
      })
    );
    setTitle("");
    await onChanged();
  }, "Document upload failed");

  const pickFile = async (file: File) => {
    await upload.run(file);
    // Cleared either way, so the same file can be picked again after a failure.
    if (fileInput.current) fileInput.current.value = "";
  };

  return (
    <div className="customer-documents">
      <ErrorNote error={upload.error} />

      <div className="doc-upload-row">
        <input
          type="text"
          placeholder="Document title (e.g. Signed agreement)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          disabled={upload.busy}
          aria-label="Document title"
        />
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          disabled={upload.busy}
          aria-label="Document type"
        >
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {k.charAt(0) + k.slice(1).toLowerCase()}
            </option>
          ))}
        </select>
        <input
          ref={fileInput}
          type="file"
          accept={ACCEPT}
          disabled={upload.busy}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void pickFile(f);
          }}
          style={{ display: "none" }}
        />
        <Button
          small
          loading={upload.busy}
          onClick={() => fileInput.current?.click()}
        >
          Upload document
        </Button>
      </div>

      {docs.length === 0 ? (
        <p className="muted small records-empty">No documents.</p>
      ) : (
        docs.map((d) => (
          <div key={d.id} className="list-row">
            <div className="list-row-main">
              <div className="list-row-title">{d.title}</div>
              <div className="list-row-subtitle muted small">
                {[
                  d.kind ? d.kind.charAt(0) + d.kind.slice(1).toLowerCase() : null,
                  fmtDate(d.uploadedAt),
                  fmtSize(d.sizeBytes),
                  d.uploadedByEmail,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
            </div>
            <div className="list-row-meta">
              {d.kind ? <Badge tone="muted">{d.kind}</Badge> : null}
              <DocButton docKey={d.fileKey} label="View" />
            </div>
          </div>
        ))
      )}
    </div>
  );
}
