import { Fragment, useMemo, useState } from "react";
import {
  fmtDate,
  licenseHealth,
  LICENSE_CLASS_LABELS,
  type License,
  type UserProfile,
} from "../../lib/client";
import { Badge } from "../../lib/badges";
import ConfirmButton from "../ConfirmButton";
import DocumentsPanel from "../DocumentsPanel";
import { useSort, SortTh } from "../../lib/useSort";
import { holderLabel } from "./holder";

export default function LicenseTable({
  title,
  blurb,
  rows,
  profiles,
  canEdit,
  showHolder,
  groupByHolder,
  onAdd,
  onEdit,
  onDelete,
  openDocsFor,
  setOpenDocsFor,
}: {
  title: string;
  blurb: string;
  rows: License[];
  profiles: UserProfile[];
  canEdit: boolean;
  showHolder?: boolean;
  groupByHolder?: boolean;
  onAdd: () => void;
  onEdit: (l: License) => void;
  /** May be async — the row's confirm button stays busy until it settles. */
  onDelete: (id: string) => void | Promise<unknown>;
  openDocsFor: string | null;
  setOpenDocsFor: (id: string | null) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  // Grouped tables carry the holder in the group header, so the per-row
  // Holder column would just repeat it.
  const showHolderCol = !!showHolder && !groupByHolder;

  // Grouped: state order within each person. Flat: soonest expiration first,
  // so whatever needs action floats to the top.
  const { sorted, sortKey, dir, toggle } = useSort(
    rows,
    {
      state: (l) => l.state,
      holder: (l) => holderLabel(l, profiles),
      number: (l) => l.licenseNumber,
      class: (l) => l.licenseClass,
      expires: (l) => l.expirationDate,
    },
    groupByHolder ? "state" : "expires"
  );

  // Built off `sorted`, so the active column sort applies inside each group.
  const groups = useMemo(() => {
    if (!groupByHolder) return null;
    const byHolder = new Map<string, License[]>();
    for (const l of sorted) {
      const name = holderLabel(l, profiles);
      const bucket = byHolder.get(name);
      if (bucket) bucket.push(l);
      else byHolder.set(name, [l]);
    }
    return [...byHolder.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [sorted, groupByHolder, profiles]);

  function toggleGroup(name: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  // state, number, class, LOA, expires, status, files (+holder, +actions)
  const colSpan = 7 + (showHolderCol ? 1 : 0) + (canEdit ? 1 : 0);

  const renderRow = (l: License) => (
    <FragmentRow
      key={l.id}
      license={l}
      health={licenseHealth(l)}
      profiles={profiles}
      showHolder={showHolderCol}
      canEdit={canEdit}
      colSpan={colSpan}
      isOpen={openDocsFor === l.id}
      onToggleDocs={() => setOpenDocsFor(openDocsFor === l.id ? null : l.id)}
      onEdit={() => onEdit(l)}
      onDelete={() => onDelete(l.id)}
    />
  );

  return (
    <div className="card">
      <div className="toolbar" style={{ marginTop: 0, alignItems: "flex-start" }}>
        <div>
          <h2 style={{ margin: 0 }}>{title}</h2>
          <p className="muted small" style={{ margin: "4px 0 0" }}>
            {blurb}
          </p>
        </div>
        <div className="grow" />
        {canEdit && (
          <button className="primary" onClick={onAdd}>
            + Add license
          </button>
        )}
      </div>

      {rows.length === 0 ? (
        <p className="muted small">
          {canEdit
            ? "None recorded yet — use Add license to record the first one."
            : "None recorded yet."}
        </p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <SortTh label="State" colKey="state" sortKey={sortKey} dir={dir} onToggle={toggle} />
                {showHolderCol && (
                  <SortTh label="Holder" colKey="holder" sortKey={sortKey} dir={dir} onToggle={toggle} />
                )}
                <SortTh label="License #" colKey="number" sortKey={sortKey} dir={dir} onToggle={toggle} />
                <SortTh label="Class" colKey="class" sortKey={sortKey} dir={dir} onToggle={toggle} />
                <th>Lines of authority</th>
                <SortTh label="Expires" colKey="expires" sortKey={sortKey} dir={dir} onToggle={toggle} />
                <th>Status</th>
                <th>Files</th>
                {canEdit && <th></th>}
              </tr>
            </thead>
            <tbody>
              {groups
                ? groups.map(([name, groupRows]) => {
                    const isCollapsed = collapsed.has(name);
                    const needsAttention = groupRows.filter((l) => {
                      const lvl = licenseHealth(l).level;
                      return lvl === "expired" || lvl === "urgent" || lvl === "soon";
                    }).length;
                    return (
                      <Fragment key={name}>
                        <tr className="license-group">
                          <td colSpan={colSpan}>
                            <button
                              className="license-group-toggle"
                              onClick={() => toggleGroup(name)}
                              aria-expanded={!isCollapsed}
                            >
                              <span className="license-group-caret">
                                {isCollapsed ? "▸" : "▾"}
                              </span>
                              <strong>{name}</strong>
                              <span className="muted small">
                                {groupRows.length} license
                                {groupRows.length === 1 ? "" : "s"}
                              </span>
                              {needsAttention > 0 && (
                                <span className="badge amber">
                                  {needsAttention} need
                                  {needsAttention === 1 ? "s" : ""} attention
                                </span>
                              )}
                            </button>
                          </td>
                        </tr>
                        {!isCollapsed && groupRows.map(renderRow)}
                      </Fragment>
                    );
                  })
                : sorted.map(renderRow)}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function FragmentRow({
  license: l,
  health: h,
  profiles,
  showHolder,
  canEdit,
  colSpan,
  isOpen,
  onToggleDocs,
  onEdit,
  onDelete,
}: {
  license: License;
  health: ReturnType<typeof licenseHealth>;
  profiles: UserProfile[];
  showHolder?: boolean;
  canEdit: boolean;
  colSpan: number;
  isOpen: boolean;
  onToggleDocs: () => void;
  onEdit: () => void;
  onDelete: () => void | Promise<unknown>;
}) {
  return (
    <>
      <tr>
        <td>
          <strong>{l.state}</strong>
          {l.residency === "RESIDENT" && (
            <span className="badge blue" style={{ marginLeft: 6 }}>
              Resident
            </span>
          )}
        </td>
        {showHolder && <td>{holderLabel(l, profiles)}</td>}
        <td style={{ fontVariantNumeric: "tabular-nums" }}>{l.licenseNumber}</td>
        <td className="small">
          {l.licenseClass ? LICENSE_CLASS_LABELS[l.licenseClass] ?? l.licenseClass : "—"}
        </td>
        <td className="small">
          {(l.linesOfAuthority ?? []).filter(Boolean).join(", ") || "—"}
        </td>
        <td className="small" style={{ whiteSpace: "nowrap" }}>
          {fmtDate(l.expirationDate)}
        </td>
        <td>
          <Badge {...h} />
        </td>
        <td>
          <button className="link" onClick={onToggleDocs}>
            {isOpen ? "Hide files" : "Files"}
          </button>
        </td>
        {canEdit && (
          <td style={{ whiteSpace: "nowrap" }}>
            <button className="link" onClick={onEdit}>
              Edit
            </button>
            <ConfirmButton className="link" onConfirm={onDelete} />
          </td>
        )}
      </tr>
      {isOpen && (
        <tr>
          <td colSpan={colSpan} style={{ background: "#f8fafc" }}>
            <p className="muted small" style={{ marginTop: 0 }}>
              License PDF, renewal receipts, CE certificates for {l.state}{" "}
              {l.licenseNumber}.
            </p>
            <DocumentsPanel entityType="LICENSE" entityId={l.id} />
          </td>
        </tr>
      )}
    </>
  );
}
