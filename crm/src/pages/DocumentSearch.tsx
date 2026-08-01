import { useState } from "react";
import { Link } from "react-router-dom";
import { getUrl } from "aws-amplify/storage";
import {
  client,
  fmtDate,
  listAllPages,
  type CrmDocument,
} from "../lib/client";
import FilePreviewModal, { canPreview } from "../components/FilePreview";
import { useAsyncResource } from "../lib/useAsyncResource";
import { useSort, SortTh } from "../lib/useSort";

// Stable identity for "no search run yet", so the sort memo isn't rebuilt
// on every render before the first search.
const NO_RESULTS: CrmDocument[] = [];

/**
 * Global "where is that document?" search — matches file names and OCR'd
 * text across every entity. Server-side `contains` filter over the Document
 * table; fine at agency scale, swap for a search index if it ever isn't.
 */
export default function DocumentSearch() {
  const [query, setQuery] = useState("");
  const [previewDoc, setPreviewDoc] = useState<CrmDocument | null>(null);

  // `manual` because this resource has no deps to watch — it exists only when
  // someone presses Search. The hook has no "don't run" escape, so the
  // two-character floor stays at the call site below rather than becoming an
  // early `return` inside the fetcher that would look like an empty result.
  const {
    data: results,
    loading: searching,
    loaded,
    error,
    refetch,
  } = useAsyncResource(
    () => {
      const q = query.trim();
      // Paginate the filtered scan to the end (bounded to stay sane).
      return listAllPages(
        (nextToken) =>
          client.models.Document.list({
            filter: {
              or: [{ name: { contains: q } }, { ocrText: { contains: q } }],
            },
            nextToken,
          }),
        { maxPages: 25 }
      );
    },
    [],
    { manual: true, initialData: NO_RESULTS, errorMessage: "Search failed" }
  );

  function search() {
    if (query.trim().length < 2) return;
    void refetch();
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

  // Most recently uploaded first, as the search used to order the hits.
  const { sorted, sortKey, dir, toggle } = useSort(
    results,
    {
      document: (d) => d.name,
      attached: (d) => d.entityType,
      uploaded: (d) => d.createdAt,
    },
    "uploaded",
    "desc"
  );

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

      {loaded && !error && (
        <div className="card">
          {results.length === 0 ? (
            <p className="muted small">No documents match “{query.trim()}”.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <SortTh label="Document" colKey="document" sortKey={sortKey} dir={dir} onToggle={toggle} />
                    <th>Match</th>
                    <SortTh label="Attached to" colKey="attached" sortKey={sortKey} dir={dir} onToggle={toggle} />
                    <SortTh label="Uploaded" colKey="uploaded" sortKey={sortKey} dir={dir} onToggle={toggle} />
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((d) => (
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
