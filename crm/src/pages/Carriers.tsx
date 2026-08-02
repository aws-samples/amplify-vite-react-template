import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  client,
  fmtMoney,
  US_STATES,
  type AppetiteGuide,
  type Carrier,
} from "../lib/client";
import { Badge, flagBadge, CARRIER_APPOINTMENT_BADGE } from "../lib/badges";
import { useSort, SortTh } from "../lib/useSort";
import { useFormState } from "../lib/useFormState";
import { SaveStatus, useSaveStatus } from "../components/SaveStatus";
import { useAsyncResource } from "../lib/useAsyncResource";

export default function Carriers() {
  const [showForm, setShowForm] = useState(false);
  // Persistent: a successful create navigates away, so what this is really
  // for is the failure that used to be swallowed entirely.
  const saveStatus = useSaveStatus();
  const { form, setF } = useFormState(
    { name: "", appointed: true },
    { onEdit: saveStatus.markDirty }
  );
  const navigate = useNavigate();

  const carrierRes = useAsyncResource(
    async () => (await client.models.Carrier.list()).data,
    [],
    { initialData: [] as Carrier[], errorMessage: "Failed to load carriers" }
  );
  const carriers = carrierRes.data;

  // Surfaced, not ignored: the guides drive the appetite finder's verdict and
  // the "Lines written" column. Without them the finder answers "no appetite"
  // for every risk, which is a wrong answer rather than a missing one.
  const guideRes = useAsyncResource(
    async () => (await client.models.AppetiteGuide.list()).data,
    [],
    { initialData: [] as AppetiteGuide[], errorMessage: "Failed to load appetite guides" }
  );
  const guides = guideRes.data;

  const { sorted, sortKey, dir, toggle } = useSort(
    carriers,
    {
      name: (c) => c.name,
      status: (c) => (c.appointed ? "Appointed" : "Prospective"),
      underwriter: (c) => c.primaryUnderwriterName,
      commission: (c) => c.standardCommissionPct,
      states: (c) => (c.states ?? []).filter(Boolean).length || null,
    },
    "name"
  );

  async function create() {
    if (!form.name.trim()) return;
    await saveStatus.run(
      async () => {
        // `errors` used to be dropped: a rejected create just re-enabled the
        // button, leaving no carrier and no explanation.
        const { data, errors } = await client.models.Carrier.create({
          name: form.name.trim(),
          appointed: form.appointed,
        });
        if (errors?.length || !data) throw new Error(errors?.[0]?.message);
        navigate(`/carriers/${data.id}`);
      },
      { errorMessage: "Couldn't create that carrier." }
    );
  }

  return (
    <>
      <h1>Carriers</h1>
      <p className="sub">Appointments, prospective appointments, and appetite guides</p>

      {/* Gated on `loaded`: the finder answers "no appointed carrier has
          appetite for this risk", and before the reads land that is a false
          negative rather than a placeholder. */}
      {carrierRes.loaded && guideRes.loaded && (
        <AppetiteFinder carriers={carriers} guides={guides} />
      )}
      {guideRes.error && <p className="error-text">{guideRes.error}</p>}

      <div className="toolbar">
        <div className="grow" />
        <button className="primary" onClick={() => setShowForm(!showForm)}>
          {showForm ? "Cancel" : "+ Add carrier"}
        </button>
      </div>

      {showForm && (
        <div className="card" style={{ background: "#f8fafc" }}>
          <div className="form-grid">
            <div className="field">
              <label>Carrier name *</label>
              <input value={form.name} onChange={(e) => setF("name", e.target.value)} />
            </div>
            <div className="field">
              <label>Status</label>
              <select
                value={form.appointed ? "1" : "0"}
                onChange={(e) => setF("appointed", e.target.value === "1")}
              >
                <option value="1">Appointed</option>
                <option value="0">Prospective</option>
              </select>
            </div>
          </div>
          <div className="form-actions">
            <button
              className="primary"
              disabled={saveStatus.busy || !form.name.trim()}
              onClick={create}
            >
              {saveStatus.busy ? "Creating…" : "Create carrier"}
            </button>
            <SaveStatus {...saveStatus.status} />
          </div>
        </div>
      )}

      <div className="card">
        {!carrierRes.loaded ? (
          <p className="muted small">Loading…</p>
        ) : carrierRes.error ? (
          <p className="error-text">{carrierRes.error}</p>
        ) : carriers.length === 0 ? (
          <p className="muted small">No carriers yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <SortTh label="Carrier" colKey="name" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="Status" colKey="status" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="Underwriter" colKey="underwriter" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="Commission" colKey="commission" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="States" colKey="states" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <th>Lines written</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((c) => {
                  const cGuides = guides.filter((g) => g.carrierId === c.id);
                  const lines = [
                    ...new Set(cGuides.flatMap((g) => g.linesWritten ?? []).filter(Boolean)),
                  ];
                  return (
                    <tr
                      key={c.id}
                      className="clickable"
                      onClick={() => navigate(`/carriers/${c.id}`)}
                    >
                      <td>
                        <strong>{c.name}</strong>
                      </td>
                      <td>
                        <Badge {...flagBadge(c.appointed, CARRIER_APPOINTMENT_BADGE)} />
                      </td>
                      <td>{c.primaryUnderwriterName ?? "—"}</td>
                      <td>{c.standardCommissionPct != null ? `${c.standardCommissionPct}%` : "—"}</td>
                      <td className="small">
                        {(c.states ?? []).filter(Boolean).join(", ") || "—"}
                      </td>
                      <td className="small">{lines.join(", ") || "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

/**
 * "Where do I submit this risk?" — filters appointed carriers by state, TIV,
 * and construction year against their appetite guides.
 */
function AppetiteFinder({
  carriers,
  guides,
}: {
  carriers: Carrier[];
  guides: AppetiteGuide[];
}) {
  const [state, setState] = useState("");
  const [tiv, setTiv] = useState("");
  const [year, setYear] = useState("");

  const active = state || tiv || year;

  const matches = !active
    ? []
    : carriers
        .filter((c) => c.appointed)
        .map((c) => {
          const cGuides = guides.filter((g) => g.carrierId === c.id);
          const matching = cGuides.filter((g) => {
            const states = (g.states?.filter(Boolean).length ? g.states : c.states) ?? [];
            if (state && states.filter(Boolean).length > 0 && !states.includes(state))
              return false;
            // Normalize possibly-inverted ranges (guarded at entry now, but
            // legacy rows may still be reversed — never silently zero-match).
            const [loV, hiV] =
              g.minValue != null && g.maxValue != null && g.minValue > g.maxValue
                ? [g.maxValue, g.minValue]
                : [g.minValue, g.maxValue];
            const [loY, hiY] =
              g.minConstructionYear != null &&
              g.maxConstructionYear != null &&
              g.minConstructionYear > g.maxConstructionYear
                ? [g.maxConstructionYear, g.minConstructionYear]
                : [g.minConstructionYear, g.maxConstructionYear];
            const tivN = tiv ? Number(tiv) : null;
            if (tivN != null && loV != null && tivN < loV) return false;
            if (tivN != null && hiV != null && tivN > hiV) return false;
            const yearN = year ? Number(year) : null;
            if (yearN != null && loY != null && yearN < loY) return false;
            if (yearN != null && hiY != null && yearN > hiY) return false;
            return true;
          });
          return { carrier: c, guides: matching };
        })
        .filter((m) => m.guides.length > 0);

  return (
    <div className="card">
      <h2>Appetite finder</h2>
      <div className="form-grid">
        <div className="field">
          <label>State</label>
          <select value={state} onChange={(e) => setState(e.target.value)}>
            <option value="">Any</option>
            {US_STATES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>TIV ($)</label>
          <input type="number" value={tiv} onChange={(e) => setTiv(e.target.value)} />
        </div>
        <div className="field">
          <label>Year built</label>
          <input type="number" value={year} onChange={(e) => setYear(e.target.value)} />
        </div>
      </div>
      {active && (
        <div style={{ marginTop: 14 }}>
          {matches.length === 0 ? (
            <p className="muted small">No appointed carrier has appetite for this risk.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Carrier</th>
                    <th>Lines</th>
                    <th>TIV range</th>
                    <th>Lead time</th>
                  </tr>
                </thead>
                <tbody>
                  {matches.map(({ carrier, guides: gs }) =>
                    gs.map((g) => (
                      <tr key={g.id}>
                        <td>
                          <strong>{carrier.name}</strong>
                        </td>
                        <td className="small">
                          {(g.linesWritten ?? []).filter(Boolean).join(", ") || "—"}
                        </td>
                        <td className="small">
                          {fmtMoney(g.minValue)} – {fmtMoney(g.maxValue)}
                        </td>
                        <td className="small">
                          {g.quoteSubmissionLeadTimeDays != null
                            ? `${g.quoteSubmissionLeadTimeDays} days`
                            : "—"}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
