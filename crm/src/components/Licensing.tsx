import { Fragment, useEffect, useMemo, useState } from "react";
import {
  client,
  fmtDate,
  licenseHealth,
  LICENSE_CLASS_LABELS,
  LICENSE_STATUS_LABELS,
  LINES_OF_AUTHORITY,
  US_STATES,
  type License,
  type ProducerLicense,
  type UserProfile,
} from "../lib/client";
import DocumentsPanel from "./DocumentsPanel";
import { useSort, SortTh } from "../lib/useSort";

type HolderType = "FIRM" | "PRODUCER";

/**
 * Firm + personal licensing.
 *
 * Both kinds live in one License table separated by holderType, so renewal
 * tracking, document attachment and the state-coverage matrix are written
 * once. Supporting files (the license PDF, renewal receipts, CE certificates)
 * attach per-license as Documents with entityType=LICENSE.
 */
export default function Licensing({ profile }: { profile: UserProfile }) {
  const [licenses, setLicenses] = useState<License[]>([]);
  const [profiles, setProfiles] = useState<UserProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState<HolderType | null>(null);
  const [editing, setEditing] = useState<License | null>(null);
  const [openDocsFor, setOpenDocsFor] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [attentionOnly, setAttentionOnly] = useState(false);

  const isAdmin = profile.role === "ADMIN";

  async function load() {
    const [{ data: ls }, { data: ps }] = await Promise.all([
      client.models.License.list(),
      client.models.UserProfile.list(),
    ]);
    setLicenses(ls);
    setProfiles(ps);
    setLoading(false);
  }

  useEffect(() => {
    load().catch((e) =>
      setError(e instanceof Error ? e.message : "Failed to load licenses")
    );
  }, []);

  const allFirm = licenses.filter((l) => l.holderType === "FIRM");
  const allPersonal = licenses.filter((l) => l.holderType === "PRODUCER");

  /**
   * One filter drives every section below. At 30+ licenses per producer,
   * scanning is the bottleneck — typing "NH" should collapse the whole page
   * to New Hampshire rather than making you hunt through three tables.
   */
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (l: License) => {
      if (attentionOnly) {
        const lvl = licenseHealth(l).level;
        if (lvl !== "expired" && lvl !== "urgent" && lvl !== "soon") return false;
      }
      if (!q) return true;
      return [
        l.state,
        l.licenseNumber,
        l.npn,
        holderLabel(l, profiles),
        l.licenseClass,
        (l.linesOfAuthority ?? []).filter(Boolean).join(" "),
      ]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q));
    };
  }, [query, attentionOnly, profiles]);

  const firm = allFirm.filter(matches);
  const personal = allPersonal.filter(matches);
  const filtering = query.trim().length > 0 || attentionOnly;

  // Compliance roll-up: expired, inactive, or expiring within 60 days.
  const attentionCount = useMemo(
    () =>
      licenses.filter((l) => {
        const lvl = licenseHealth(l).level;
        return lvl === "expired" || lvl === "urgent" || lvl === "soon";
      }).length,
    [licenses]
  );

  // How many states we can actually write in: firm licensed AND a producer
  // licensed, both unexpired. Counted over every state that appears anywhere.
  const { writableStates, touchedStates } = useMemo(() => {
    const live = (l: License) => licenseHealth(l).level !== "expired";
    const states = new Set(licenses.map((l) => l.state).filter(Boolean));
    let writable = 0;
    for (const s of states) {
      const hasFirm = allFirm.some((l) => l.state === s && live(l));
      const hasProducer = allPersonal.some((l) => l.state === s && live(l));
      if (hasFirm && hasProducer) writable++;
    }
    return { writableStates: writable, touchedStates: states.size };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [licenses]);

  async function del(id: string) {
    await client.models.License.delete({ id });
    setLicenses((ls) => ls.filter((l) => l.id !== id));
  }

  if (loading) return <p className="muted small">Loading licenses…</p>;

  return (
    <>
      {error && <p className="error-text">{error}</p>}

      {isAdmin && (
        <LegacyBackfill
          licenses={licenses}
          profiles={profiles}
          onMigrated={(created) => setLicenses((ls) => [...ls, ...created])}
        />
      )}

      <div className="card lic-bar">
        <div className="lic-stats">
          <div className="lic-stat">
            <strong>{allFirm.length}</strong>
            <span className="muted small">firm</span>
          </div>
          <div className="lic-stat">
            <strong>{allPersonal.length}</strong>
            <span className="muted small">personal</span>
          </div>
          <div className="lic-stat">
            <strong>{writableStates}</strong>
            <span className="muted small">
              of {touchedStates} states writable
            </span>
          </div>
        </div>

        <div className="lic-controls">
          <input
            className="lic-search"
            type="search"
            placeholder="Filter by state, license #, NPN, person…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {attentionCount > 0 && (
            <button
              className={`lic-chip${attentionOnly ? " on" : ""}`}
              onClick={() => setAttentionOnly((v) => !v)}
              title="Expired, inactive, or expiring within 60 days"
            >
              ⚠ {attentionCount} need{attentionCount === 1 ? "s" : ""} attention
            </button>
          )}
          {filtering && (
            <button
              className="link"
              onClick={() => {
                setQuery("");
                setAttentionOnly(false);
              }}
            >
              Clear
            </button>
          )}
        </div>

        {filtering && (
          <p className="muted small" style={{ margin: "8px 0 0" }}>
            Showing {firm.length + personal.length} of{" "}
            {allFirm.length + allPersonal.length} licenses.
          </p>
        )}
      </div>

      <LicenseTable
        title="Firm licenses"
        blurb="The agency's own business-entity licenses, one per state you write in."
        rows={firm}
        profiles={profiles}
        canEdit={isAdmin}
        onAdd={() => {
          setEditing(null);
          setAdding("FIRM");
        }}
        onEdit={(l) => {
          setAdding(null);
          setEditing(l);
        }}
        onDelete={del}
        openDocsFor={openDocsFor}
        setOpenDocsFor={setOpenDocsFor}
      />

      <LicenseTable
        title="Personal licenses"
        blurb="Individual producer licenses, tied to a team member."
        rows={personal}
        profiles={profiles}
        canEdit={isAdmin}
        showHolder
        groupByHolder
        onAdd={() => {
          setEditing(null);
          setAdding("PRODUCER");
        }}
        onEdit={(l) => {
          setAdding(null);
          setEditing(l);
        }}
        onDelete={del}
        openDocsFor={openDocsFor}
        setOpenDocsFor={setOpenDocsFor}
      />

      {(adding || editing) && (
        <LicenseForm
          holderType={editing ? (editing.holderType as HolderType) : adding!}
          existing={editing}
          profiles={profiles}
          onCancel={() => {
            setAdding(null);
            setEditing(null);
          }}
          onSaved={(l) => {
            setLicenses((ls) => {
              const without = ls.filter((x) => x.id !== l.id);
              return [...without, l];
            });
            setAdding(null);
            setEditing(null);
          }}
        />
      )}

      <StateCoverage firm={firm} personal={personal} profiles={profiles} />
    </>
  );
}

/**
 * One-time migration of the deprecated ProducerLicense rows (captured at
 * onboarding before this system existed) into the unified License table.
 *
 * Idempotent: a legacy row is skipped when a License already exists for the
 * same holder + state + number, so re-running can't create duplicates. The
 * card hides itself entirely once there's nothing left to migrate, and the
 * legacy rows are left in place rather than deleted — nothing is destroyed.
 */
function LegacyBackfill({
  licenses,
  profiles,
  onMigrated,
}: {
  licenses: License[];
  profiles: UserProfile[];
  onMigrated: (created: License[]) => void;
}) {
  const [legacy, setLegacy] = useState<ProducerLicense[] | null>(null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    client.models.ProducerLicense.list()
      .then(({ data }) => setLegacy(data))
      .catch(() => setLegacy([]));
  }, []);

  const key = (userProfileId: unknown, state: unknown, num: unknown) =>
    `${userProfileId ?? ""}|${state ?? ""}|${String(num ?? "").trim().toUpperCase()}`;

  const pending = useMemo(() => {
    if (!legacy) return [];
    const have = new Set(
      licenses
        .filter((l) => l.holderType === "PRODUCER")
        .map((l) => key(l.userProfileId, l.state, l.licenseNumber))
    );
    return legacy.filter(
      (l) => !have.has(key(l.userProfileId, l.state, l.licenseNumber))
    );
  }, [legacy, licenses]);

  async function run() {
    setRunning(true);
    setError("");
    const created: License[] = [];
    let failed = 0;
    for (const l of pending) {
      const holder = profiles.find((p) => p.id === l.userProfileId);
      try {
        const { data, errors } = await client.models.License.create({
          holderType: "PRODUCER",
          userProfileId: l.userProfileId,
          holderName: holder ? `${holder.firstName} ${holder.lastName}` : null,
          state: l.state,
          licenseNumber: l.licenseNumber,
          npn: holder?.npn ?? null,
          licenseClass: "PRODUCER",
          // Unknowable from the legacy row — left blank rather than guessed.
          residency: null,
          status: "ACTIVE",
          expirationDate: l.expirationDate ?? null,
          linesOfAuthority: (l.linesOfAuthority ?? []).filter(
            (x): x is string => !!x
          ),
          notes: "Migrated from the original onboarding license record.",
        });
        if (errors?.length || !data) failed++;
        else created.push(data);
      } catch {
        failed++;
      }
    }
    setRunning(false);
    onMigrated(created);
    setResult(
      `Migrated ${created.length} license${created.length === 1 ? "" : "s"}.` +
        (failed ? ` ${failed} failed — re-run to retry just those.` : "")
    );
  }

  if (legacy === null) return null; // still loading
  if (pending.length === 0) {
    // Nothing outstanding: show the confirmation once, then stay hidden.
    return result ? (
      <div className="card" style={{ borderLeft: "4px solid var(--green)" }}>
        <p className="small" style={{ margin: 0, color: "var(--green)" }}>
          {result} Legacy records were left untouched as a backup.
        </p>
      </div>
    ) : null;
  }

  return (
    <div className="card" style={{ borderLeft: "4px solid var(--accent-dark)" }}>
      <h2 style={{ marginTop: 0 }}>Import licenses from onboarding</h2>
      <p className="muted small">
        {pending.length} license{pending.length === 1 ? "" : "s"} captured
        during onboarding {pending.length === 1 ? "hasn't" : "haven't"} been
        brought into licensing yet. Importing copies{" "}
        {pending.length === 1 ? "it" : "them"} over — the original record
        {pending.length === 1 ? " is" : "s are"} left in place, and running
        this twice can't create duplicates.
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Holder</th>
              <th>State</th>
              <th>License #</th>
              <th>Expires</th>
            </tr>
          </thead>
          <tbody>
            {pending.map((l) => {
              const holder = profiles.find((p) => p.id === l.userProfileId);
              return (
                <tr key={l.id}>
                  <td>
                    {holder ? `${holder.firstName} ${holder.lastName}` : "(unknown)"}
                  </td>
                  <td>{l.state}</td>
                  <td style={{ fontVariantNumeric: "tabular-nums" }}>
                    {l.licenseNumber}
                  </td>
                  <td className="small">{fmtDate(l.expirationDate)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="form-actions">
        <button className="primary" disabled={running} onClick={run}>
          {running
            ? "Importing…"
            : `Import ${pending.length} license${pending.length === 1 ? "" : "s"}`}
        </button>
        {/* Partial failures leave rows pending, so surface the outcome here
            too — not only in the all-done state below. */}
        {result && <span className="error-text">{result}</span>}
        {error && <span className="error-text">{error}</span>}
      </div>
      <p className="muted small">
        Residency isn't recorded on the old rows, so it's left blank — set it
        on each license afterward.
      </p>
    </div>
  );
}

function holderLabel(l: License, profiles: UserProfile[]): string {
  if (l.holderType === "FIRM") return "(firm)";
  const p = profiles.find((x) => x.id === l.userProfileId);
  return p ? `${p.firstName} ${p.lastName}` : l.holderName ?? "(unassigned)";
}

function LicenseTable({
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
  onDelete: (id: string) => void;
  openDocsFor: string | null;
  setOpenDocsFor: (id: string | null) => void;
}) {
  const [confirmId, setConfirmId] = useState<string | null>(null);
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
      confirming={confirmId === l.id}
      onAskDelete={() => setConfirmId(l.id)}
      onCancelDelete={() => setConfirmId(null)}
      onConfirmDelete={() => {
        onDelete(l.id);
        setConfirmId(null);
      }}
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
  confirming,
  onAskDelete,
  onCancelDelete,
  onConfirmDelete,
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
  confirming: boolean;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
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
          <span className={`badge ${h.badge}`}>{h.label}</span>
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
            {confirming ? (
              <>
                <button className="danger" onClick={onConfirmDelete}>
                  Confirm
                </button>
                <button className="link" onClick={onCancelDelete}>
                  Cancel
                </button>
              </>
            ) : (
              <button className="link" onClick={onAskDelete}>
                Delete
              </button>
            )}
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

function LicenseForm({
  holderType,
  existing,
  profiles,
  onCancel,
  onSaved,
}: {
  holderType: HolderType;
  existing: License | null;
  profiles: UserProfile[];
  onCancel: () => void;
  onSaved: (l: License) => void;
}) {
  const [form, setForm] = useState({
    userProfileId: existing?.userProfileId ?? "",
    state: existing?.state ?? "",
    licenseNumber: existing?.licenseNumber ?? "",
    npn: existing?.npn ?? "",
    licenseClass: existing?.licenseClass ?? (holderType === "FIRM" ? "AGENCY" : "PRODUCER"),
    residency: existing?.residency ?? "NON_RESIDENT",
    status: existing?.status ?? "ACTIVE",
    effectiveDate: existing?.effectiveDate ?? "",
    expirationDate: existing?.expirationDate ?? "",
    continuingEducationDueDate: existing?.continuingEducationDueDate ?? "",
    notes: existing?.notes ?? "",
  });
  const [loa, setLoa] = useState<string[]>(
    (existing?.linesOfAuthority ?? []).filter((x): x is string => !!x)
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const set =
    (k: keyof typeof form) =>
    (e: { target: { value: string } }) =>
      setForm((f) => ({ ...f, [k]: e.target.value }));

  async function save() {
    if (!form.state || !form.licenseNumber.trim()) {
      setError("State and license number are required.");
      return;
    }
    if (holderType === "PRODUCER" && !form.userProfileId) {
      setError("Pick which team member this license belongs to.");
      return;
    }
    if (
      form.effectiveDate &&
      form.expirationDate &&
      form.effectiveDate > form.expirationDate
    ) {
      setError("Effective date can't be after the expiration date.");
      return;
    }
    setSaving(true);
    setError("");
    const holder = profiles.find((p) => p.id === form.userProfileId);
    const payload = {
      holderType,
      // Omitted (not null) for firm licenses — see the schema note.
      userProfileId: holderType === "PRODUCER" ? form.userProfileId : undefined,
      holderName:
        holderType === "PRODUCER" && holder
          ? `${holder.firstName} ${holder.lastName}`
          : null,
      state: form.state,
      licenseNumber: form.licenseNumber.trim(),
      npn: form.npn.trim() || null,
      licenseClass: form.licenseClass as never,
      residency: form.residency as never,
      status: form.status as never,
      linesOfAuthority: loa,
      effectiveDate: form.effectiveDate || null,
      expirationDate: form.expirationDate || null,
      continuingEducationDueDate: form.continuingEducationDueDate || null,
      notes: form.notes.trim() || null,
    };
    const { data, errors } = existing
      ? await client.models.License.update({ id: existing.id, ...payload })
      : await client.models.License.create(payload);
    setSaving(false);
    if (errors?.length || !data) {
      setError(errors?.[0]?.message ?? "Save failed");
      return;
    }
    onSaved(data);
  }

  return (
    <div className="card" style={{ background: "#f8fafc" }}>
      <h2>
        {existing ? "Edit" : "Add"}{" "}
        {holderType === "FIRM" ? "firm" : "personal"} license
      </h2>
      <div className="form-grid">
        {holderType === "PRODUCER" && (
          <div className="field">
            <label>Team member *</label>
            <select value={form.userProfileId} onChange={set("userProfileId")}>
              <option value="">—</option>
              {[...profiles]
                .sort((a, b) =>
                  `${a.lastName}${a.firstName}`.localeCompare(
                    `${b.lastName}${b.firstName}`
                  )
                )
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.firstName} {p.lastName}
                  </option>
                ))}
            </select>
          </div>
        )}
        <div className="field">
          <label>State *</label>
          <select value={form.state} onChange={set("state")}>
            <option value="">—</option>
            {US_STATES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>License number *</label>
          <input value={form.licenseNumber} onChange={set("licenseNumber")} />
        </div>
        <div className="field">
          <label>NPN</label>
          <input value={form.npn} onChange={set("npn")} />
        </div>
        <div className="field">
          <label>License class</label>
          <select value={form.licenseClass} onChange={set("licenseClass")}>
            {Object.entries(LICENSE_CLASS_LABELS)
              .sort((a, b) => a[1].localeCompare(b[1]))
              .map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
          </select>
        </div>
        <div className="field">
          <label>Residency</label>
          <select value={form.residency} onChange={set("residency")}>
            <option value="NON_RESIDENT">Non-resident</option>
            <option value="RESIDENT">Resident</option>
          </select>
        </div>
        <div className="field">
          <label>Status</label>
          <select value={form.status} onChange={set("status")}>
            {Object.entries(LICENSE_STATUS_LABELS)
              .sort((a, b) => a[1].localeCompare(b[1]))
              .map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
          </select>
        </div>
        <div className="field">
          <label>Effective date</label>
          <input type="date" value={form.effectiveDate} onChange={set("effectiveDate")} />
        </div>
        <div className="field">
          <label>Expiration date</label>
          <input type="date" value={form.expirationDate} onChange={set("expirationDate")} />
        </div>
        <div className="field">
          <label>CE due date</label>
          <input
            type="date"
            value={form.continuingEducationDueDate}
            onChange={set("continuingEducationDueDate")}
          />
        </div>
        <div className="field full">
          <label>Lines of authority</label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 14px" }}>
            {LINES_OF_AUTHORITY.map((l) => (
              <label
                key={l}
                className="small"
                style={{ display: "flex", gap: 4, alignItems: "center" }}
              >
                <input
                  type="checkbox"
                  checked={loa.includes(l)}
                  onChange={() =>
                    setLoa((ls) =>
                      ls.includes(l) ? ls.filter((x) => x !== l) : [...ls, l].sort()
                    )
                  }
                />
                {l}
              </label>
            ))}
          </div>
        </div>
        <div className="field full">
          <label>Notes</label>
          <textarea rows={2} value={form.notes} onChange={set("notes")} />
        </div>
      </div>
      <div className="form-actions">
        <button className="primary" disabled={saving} onClick={save}>
          {saving ? "Saving…" : existing ? "Save changes" : "Add license"}
        </button>
        <button className="link" onClick={onCancel}>
          Cancel
        </button>
        {error && <span className="error-text">{error}</span>}
      </div>
      {!existing && (
        <p className="muted small">
          Save the license first, then use <em>Files</em> on its row to attach
          the license PDF and renewal paperwork.
        </p>
      )}
    </div>
  );
}

/**
 * Where can we actually write? A state needs BOTH a firm license and at
 * least one licensed producer — this makes the gaps obvious at a glance.
 */
function StateCoverage({
  firm,
  personal,
  profiles,
}: {
  firm: License[];
  personal: License[];
  profiles: UserProfile[];
}) {
  const [open, setOpen] = useState(true);
  // Gaps are the actionable half; the writable states are just reassurance.
  const [gapsOnly, setGapsOnly] = useState(true);

  const rows = useMemo(() => {
    const states = [
      ...new Set([...firm, ...personal].map((l) => l.state).filter(Boolean)),
    ].sort();
    const live = (l: License) => {
      const h = licenseHealth(l);
      return h.level !== "expired";
    };
    return states.map((s) => {
      const f = firm.filter((l) => l.state === s && live(l));
      const p = personal.filter((l) => l.state === s && live(l));
      return {
        state: s,
        firm: f.length > 0,
        producers: p
          .map((l) => holderLabel(l, profiles))
          .filter((v, i, a) => a.indexOf(v) === i),
      };
    });
  }, [firm, personal, profiles]);

  const gaps = rows.filter((r) => !(r.firm && r.producers.length > 0));
  const shown = gapsOnly ? gaps : rows;

  if (rows.length === 0) return null;

  return (
    <div className="card">
      <div className="toolbar" style={{ marginTop: 0, alignItems: "flex-start" }}>
        <div>
          <h2 style={{ margin: 0 }}>
            State coverage{" "}
            <span className="muted small" style={{ fontWeight: 400 }}>
              · {rows.length - gaps.length} writable, {gaps.length} gap
              {gaps.length === 1 ? "" : "s"}
            </span>
          </h2>
          <p className="muted small" style={{ margin: "4px 0 0" }}>
            A state is writable when the firm holds an active license there
            <em> and</em> at least one producer is licensed. Expired licenses
            don't count toward coverage.
          </p>
        </div>
        <div className="grow" />
        <button
          className={`lic-chip${gapsOnly ? " on" : ""}`}
          onClick={() => setGapsOnly((v) => !v)}
        >
          {gapsOnly ? "Showing gaps only" : "Show gaps only"}
        </button>
        <button className="link" onClick={() => setOpen((v) => !v)}>
          {open ? "Hide" : "Show"}
        </button>
      </div>

      {open && (
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>State</th>
              <th>Firm license</th>
              <th>Licensed producers</th>
              <th>Can write?</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const ok = r.firm && r.producers.length > 0;
              return (
                <tr key={r.state}>
                  <td>
                    <strong>{r.state}</strong>
                  </td>
                  <td>
                    <span className={`badge ${r.firm ? "green" : "red"}`}>
                      {r.firm ? "Active" : "Missing"}
                    </span>
                  </td>
                  <td className="small">{r.producers.join(", ") || "—"}</td>
                  <td>
                    <span className={`badge ${ok ? "green" : "amber"}`}>
                      {ok ? "Yes" : "Gap"}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {shown.length === 0 && (
          <p className="muted small">
            No gaps — every state with a license on file is writable.
          </p>
        )}
      </div>
      )}
    </div>
  );
}
