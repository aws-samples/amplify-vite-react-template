import { useState } from "react";
import { Link } from "react-router-dom";
import { getUrl } from "aws-amplify/storage";
import {
  client,
  fmtDate,
  friendlyError,
  listAllPages,
  type CrmDocument,
} from "../lib/client";
import FilePreviewModal, { canPreview } from "../components/FilePreview";

/**
 * Global "where is that document?" search — matches file names and OCR'd
 * text across every entity. Server-side `contains` filter over the Document
 * table; fine at agency scale, swap for a search index if it ever isn't.
 */
export default function DocumentSearch() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CrmDocument[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  const [previewDoc, setPreviewDoc] = useState<CrmDocument | null>(null);

  async function search() {
    const q = query.trim();
    if (q.length < 2) return;
    setSearching(true);
    setError("");
    try {
      // Paginate the filtered scan to the end (bounded to stay sane).
      const found = await listAllPages(
        (nextToken) =>
          client.models.Document.list({
            filter: {
              or: [{ name: { contains: q } }, { ocrText: { contains: q } }],
            },
            nextToken,
          }),
        { maxPages: 25 }
      );
      setResults(
        found.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))
      );
    } catch (err) {
      setError(friendlyError(err, "Search failed"));
    } finally {
      setSearching(false);
    }
  }

  async function download(doc: CrmDocument) {
    const { url } = await getUrl({ path: doc.s3Key });
    window.open(url.toString(), "_blank");
  }

  function snippet(doc: CrmDocument): string | null {
    const q = query.trim().toLowerCase();
    const text = doc.ocrText;
    if (!text) return null;
    const idx = text.toLowerCase().indexOf(q);
    if (idx < 0) return null;
    const start = Math.max(0, idx - 60);
    const end = Math.min(text.length, idx + q.length + 60);
    return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ")}${end < text.length ? "…" : ""}`;
  }

  function entityLink(doc: CrmDocument) {
    if (doc.entityType === "ACCOUNT")
      return <Link to={`/accounts/${doc.entityId}`}>View account</Link>;
    if (doc.entityType === "CARRIER")
      return <Link to={`/carriers/${doc.entityId}`}>View carrier</Link>;
    return <span className="badge gray">{doc.entityType}</span>;
  }

  return (
    <>
      <h1>Document search</h1>
      <p className="sub">
        Search every attached document by file name or OCR'd contents
      </p>

      <div className="toolbar">
        <div className="field grow" style={{ maxWidth: 480 }}>
          <input
            placeholder="e.g. dues, deductible, carrier name, budget line…"
            value={query}
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && search()}
          />
        </div>
        <button
          className="primary"
          disabled={searching || query.trim().length < 2}
          onClick={search}
        >
          {searching ? "Searching…" : "Search"}
        </button>
      </div>
      {error && <p className="error-text">{error}</p>}

      {results && (
        <div className="card">
          {results.length === 0 ? (
            <p className="muted small">No documents match “{query.trim()}”.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Document</th>
                    <th>Match</th>
                    <th>Attached to</th>
                    <th>Uploaded</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((d) => (
                    <tr key={d.id}>
                      <td>
                        <strong>{d.name}</strong>
                        {d.category && (
                          <div>
                            <span className="badge gray">{d.category}</span>
                          </div>
                        )}
                      </td>
                      <td className="small muted" style={{ maxWidth: 380 }}>
                        {snippet(d) ?? "matched file name"}
                      </td>
                      <td>{entityLink(d)}</td>
                      <td className="small">{fmtDate(d.createdAt?.slice(0, 10))}</td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        {canPreview(d.name) && (
                          <button className="link" onClick={() => setPreviewDoc(d)}>
                            Preview
                          </button>
                        )}
                        <button className="link" onClick={() => download(d)}>
                          Download
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
      {previewDoc && (
        <FilePreviewModal
          s3Key={previewDoc.s3Key}
          name={previewDoc.name}
          onClose={() => setPreviewDoc(null)}
        />
      )}
    </>
  );
}
