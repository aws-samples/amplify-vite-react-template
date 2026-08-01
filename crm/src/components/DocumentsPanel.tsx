import { useEffect, useRef, useState } from "react";
import { uploadData, getUrl, remove } from "aws-amplify/storage";
import { client, friendlyError, type CrmDocument } from "../lib/client";
import type { Schema } from "../../amplify/data/resource";
import FilePreviewModal, { canPreview } from "./FilePreview";
import FileButton from "./FileButton";
import ConfirmButton from "./ConfirmButton";
import { SaveStatus, useSaveStatus } from "./SaveStatus";
import { useSort, SortTh } from "../lib/useSort";

type EntityType = Schema["DocumentEntityType"]["type"];
type Category = NonNullable<Schema["DocumentCategory"]["type"]>;

// Alphabetical by label.
const CATEGORIES: { value: Category; label: string }[] = [
  { value: "BUDGET", label: "Budget" },
  { value: "CONDO_DOCS", label: "Condo documents" },
  { value: "DUES_SCHEDULE", label: "Dues per unit" },
  { value: "LICENSE", label: "License" },
  { value: "LOSS_RUNS", label: "Loss runs" },
  { value: "OTHER", label: "Other" },
  { value: "POLICY_DOC", label: "Policy document" },
  { value: "PRIOR_POLICY", label: "Prior policy packet" },
  { value: "QUOTE_DOC", label: "Quote document" },
];

const OCR_BADGE: Record<string, { cls: string; label: string }> = {
  PENDING: { cls: "gray", label: "OCR queued" },
  PROCESSING: { cls: "amber", label: "OCR running" },
  COMPLETE: { cls: "green", label: "OCR done" },
  FAILED: { cls: "red", label: "OCR failed" },
  SKIPPED: { cls: "gray", label: "No OCR" },
};

/**
 * Attach-to-anything documents panel: uploads to
 * documents/{entityType}/{entityId}/{documentId}/{filename}, which the
 * Textract Lambda watches. observeQuery keeps OCR status live in the UI.
 */
export default function DocumentsPanel({
  entityType,
  entityId,
}: {
  entityType: EntityType;
  entityId: string;
}) {
  const [docs, setDocs] = useState<CrmDocument[]>([]);
  const [category, setCategory] = useState<Category>("OTHER");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [openDocId, setOpenDocId] = useState<string | null>(null);
  // Auto-clearing: the row this confirmation names is gone from the table, so
  // nothing on screen would ever go dirty and retire the message.
  const delStatus = useSaveStatus({ autoClearMs: 4000 });
  const [previewDoc, setPreviewDoc] = useState<CrmDocument | null>(null);
  const [ocrSearch, setOcrSearch] = useState("");
  const [matchIdx, setMatchIdx] = useState(0);
  const [matchCount, setMatchCount] = useState(0);
  const viewerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const sub = client.models.Document.observeQuery({
      filter: { entityId: { eq: entityId } },
    }).subscribe({
      next: ({ items }) => setDocs([...items]),
    });
    return () => sub.unsubscribe();
  }, [entityId]);

  async function handleUpload(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    setError("");
    for (const file of Array.from(files)) {
      let docId: string | null = null;
      try {
        const { data: doc, errors } = await client.models.Document.create({
          entityType,
          entityId,
          category,
          name: file.name,
          s3Key: "pending",
          contentType: file.type,
          sizeBytes: file.size,
          ocrStatus: "PENDING",
        });
        if (errors?.length || !doc) throw new Error(errors?.[0]?.message);
        docId = doc.id;

        const path = `documents/${entityType}/${entityId}/${doc.id}/${file.name}`;
        await client.models.Document.update({ id: doc.id, s3Key: path });
        await uploadData({
          path,
          data: file,
          options: { contentType: file.type || undefined },
        }).result;
      } catch (err) {
        // Don't leave a ghost record behind for a file that never landed.
        if (docId) {
          await client.models.Document.delete({ id: docId }).catch(() => {});
        }
        setError(
          `"${file.name}" failed to upload — ${friendlyError(err, "unknown error")}`
        );
      }
    }
    setUploading(false);
  }

  async function download(doc: CrmDocument) {
    const { url } = await getUrl({ path: doc.s3Key });
    window.open(url.toString(), "_blank");
  }

  async function deleteDoc(doc: CrmDocument) {
    await delStatus.run(
      async () => {
        if (doc.s3Key && doc.s3Key !== "pending") {
          await remove({ path: doc.s3Key }).catch(() => {});
        }
        // `errors` used to be dropped: the observeQuery subscription simply
        // kept the row, which reads as "the Confirm delete button missed".
        const { errors } = await client.models.Document.delete({ id: doc.id });
        if (errors?.length) throw new Error(errors[0].message);
      },
      {
        savedMessage: `"${doc.name}" deleted.`,
        errorMessage: "Couldn't delete that document.",
      }
    );
    // `run` never rejects, so <ConfirmButton> disarms either way — the same
    // unconditional close the hand-rolled confirm/keep pair did. The outcome
    // is reported by the panel's one SaveStatus line, not by the button.
  }

  function highlight(text: string, term: string) {
    if (!term.trim()) return text;
    const parts = text.split(new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"));
    return parts.map((p, i) =>
      p.toLowerCase() === term.toLowerCase() ? <mark key={i}>{p}</mark> : p
    );
  }

  // Most recently uploaded first, as the subscription used to order them.
  const { sorted, sortKey, dir, toggle } = useSort(
    docs,
    {
      name: (d) => d.name,
      category: (d) => CATEGORIES.find((c) => c.value === d.category)?.label,
      ocr: (d) => OCR_BADGE[d.ocrStatus ?? "PENDING"]?.label,
      size: (d) => d.sizeBytes,
      created: (d) => d.createdAt,
    },
    "created",
    "desc"
  );

  const openDoc = docs.find((d) => d.id === openDocId);
  const openTables = openDoc ? parseTables(openDoc.ocrTables) : null;

  // Ctrl+F-style match navigation: after each render, index the <mark>
  // elements (text + tables, DOM order), flag the current one, scroll to it.
  useEffect(() => {
    const container = viewerRef.current;
    if (!container) {
      if (matchCount !== 0) setMatchCount(0);
      return;
    }
    const marks = container.querySelectorAll("mark");
    if (marks.length !== matchCount) setMatchCount(marks.length);
    marks.forEach((m) => m.classList.remove("ocr-current"));
    if (marks.length > 0) {
      const idx = ((matchIdx % marks.length) + marks.length) % marks.length;
      const current = marks[idx];
      current.classList.add("ocr-current");
      current.scrollIntoView({ block: "nearest" });
    }
  }, [ocrSearch, matchIdx, openDocId, matchCount, openTables]);

  function stepMatch(delta: number) {
    if (matchCount === 0) return;
    setMatchIdx((i) => (((i + delta) % matchCount) + matchCount) % matchCount);
  }

  return (
    <div>
      <div className="toolbar">
        <div className="field">
          <label>Category</label>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as Category)}
          >
            {CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Attach files (PDF/images are OCR'd automatically)</label>
          <FileButton
            label="Choose files…"
            multiple
            busy={uploading}
            onFiles={handleUpload}
          />
        </div>
        {error && <span className="error-text">{error}</span>}
        {/* Deletes are per-row with no per-row place to report; this is the
            panel's one status line. */}
        <SaveStatus {...delStatus.status} />
      </div>

      {docs.length === 0 ? (
        <p className="muted small">No documents attached.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <SortTh label="Name" colKey="name" sortKey={sortKey} dir={dir} onToggle={toggle} />
                <SortTh label="Category" colKey="category" sortKey={sortKey} dir={dir} onToggle={toggle} />
                <SortTh label="OCR" colKey="ocr" sortKey={sortKey} dir={dir} onToggle={toggle} />
                <SortTh label="Size" colKey="size" sortKey={sortKey} dir={dir} onToggle={toggle} />
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((d) => {
                const badge = OCR_BADGE[d.ocrStatus ?? "PENDING"] ?? OCR_BADGE.PENDING;
                return (
                  <tr key={d.id}>
                    <td>{d.name}</td>
                    <td>
                      <span className="badge gray">
                        {CATEGORIES.find((c) => c.value === d.category)?.label ?? "—"}
                      </span>
                    </td>
                    <td>
                      <span className={`badge ${badge.cls}`}>{badge.label}</span>
                      {d.ocrStatus === "FAILED" && d.ocrError && (
                        <div className="muted small">{d.ocrError}</div>
                      )}
                    </td>
                    <td className="muted small">
                      {d.sizeBytes ? `${Math.max(1, Math.round(d.sizeBytes / 1024))} KB` : "—"}
                    </td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      {d.s3Key !== "pending" && canPreview(d.name) && (
                        <button className="link" onClick={() => setPreviewDoc(d)}>
                          Preview
                        </button>
                      )}
                      <button className="link" onClick={() => download(d)}>
                        Download
                      </button>
                      {d.ocrStatus === "COMPLETE" && d.ocrText && (
                        <button
                          className="link"
                          onClick={() =>
                            setOpenDocId(openDocId === d.id ? null : d.id)
                          }
                        >
                          {openDocId === d.id ? "Hide text" : "View text"}
                        </button>
                      )}
                      <ConfirmButton
                        confirmLabel="Confirm delete"
                        cancelLabel="Keep"
                        onConfirm={() => deleteDoc(d)}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {previewDoc && (
        <FilePreviewModal
          s3Key={previewDoc.s3Key}
          name={previewDoc.name}
          onClose={() => setPreviewDoc(null)}
        />
      )}

      {openDoc?.ocrText && (
        <div style={{ marginTop: 14 }} ref={viewerRef}>
          <h3>Extracted text — {openDoc.name}</h3>
          <div className="ocr-search field">
            <div className="ocr-find">
              <input
                placeholder="Find in text…"
                value={ocrSearch}
                onChange={(e) => {
                  setOcrSearch(e.target.value);
                  setMatchIdx(0);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") stepMatch(e.shiftKey ? -1 : 1);
                }}
              />
              {ocrSearch.trim() && (
                <>
                  <span className="ocr-count">
                    {matchCount === 0 ? "0 results" : `${(matchIdx % matchCount + matchCount) % matchCount + 1} of ${matchCount}`}
                  </span>
                  <button
                    className="secondary"
                    title="Previous match (Shift+Enter)"
                    disabled={matchCount === 0}
                    onClick={() => stepMatch(-1)}
                  >
                    ▲
                  </button>
                  <button
                    className="secondary"
                    title="Next match (Enter)"
                    disabled={matchCount === 0}
                    onClick={() => stepMatch(1)}
                  >
                    ▼
                  </button>
                </>
              )}
            </div>
          </div>
          <div className="ocr-text">{highlight(openDoc.ocrText, ocrSearch)}</div>

          {openTables && openTables.length > 0 && (
            <>
              <h3>
                Extracted tables ({openTables.length}) — budgets, dues
                schedules, etc.
              </h3>
              {openTables.map((table, ti) => (
                <div className="table-wrap ocr-table" key={ti}>
                  <table>
                    <tbody>
                      {table.map((row, ri) => (
                        <tr key={ri}>
                          {row.map((cell, ci) => (
                            <td key={ci}>{highlight(cell, ocrSearch)}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * ocrTables is an AWSJSON field written as a JSON string by the Lambda, so
 * it may come back single- or double-encoded depending on the write path.
 */
function parseTables(raw: unknown): string[][][] | null {
  let v: unknown = raw;
  try {
    if (typeof v === "string") v = JSON.parse(v);
    if (typeof v === "string") v = JSON.parse(v);
  } catch {
    return null;
  }
  return Array.isArray(v) && v.length ? (v as string[][][]) : null;
}
