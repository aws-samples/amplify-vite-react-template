import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import {
  client,
  fmtMoney,
  LINES_OF_BUSINESS,
  listAllPages,
  US_STATES,
  type AppetiteGuide,
  type Carrier,
} from "../lib/client";
import DocumentsPanel from "../components/DocumentsPanel";

export default function CarrierDetail() {
  const { id } = useParams<{ id: string }>();
  const [carrier, setCarrier] = useState<Carrier | null>(null);

  useEffect(() => {
    if (!id) return;
    client.models.Carrier.get({ id }).then(({ data }) => setCarrier(data));
  }, [id]);

  if (!carrier) return <p className="muted">Loading…</p>;

  return (
    <>
      <h1>
        {carrier.name}{" "}
        <span className={`badge ${carrier.appointed ? "green" : "amber"}`}>
          {carrier.appointed ? "Appointed" : "Prospective"}
        </span>
      </h1>
      <p className="sub">Carrier appointment &amp; appetite</p>

      <CarrierForm carrier={carrier} onChange={setCarrier} />
      <AppetiteGuides carrierId={carrier.id} />

      <div className="card">
        <h2>Documents</h2>
        <DocumentsPanel entityType="CARRIER" entityId={carrier.id} />
      </div>
    </>
  );
}

function CarrierForm({
  carrier,
  onChange,
}: {
  carrier: Carrier;
  onChange: (c: Carrier) => void;
}) {
  const [form, setForm] = useState({
    name: carrier.name,
    appointed: carrier.appointed,
    dateAppointed: carrier.dateAppointed ?? "",
    primaryContactName: carrier.primaryContactName ?? "",
    primaryContactEmail: carrier.primaryContactEmail ?? "",
    primaryContactPhone: carrier.primaryContactPhone ?? "",
    primaryUnderwriterName: carrier.primaryUnderwriterName ?? "",
    primaryUnderwriterEmail: carrier.primaryUnderwriterEmail ?? "",
    primaryUnderwriterPhone: carrier.primaryUnderwriterPhone ?? "",
    states: (carrier.states ?? []).filter((s): s is string => !!s),
    naicCode: carrier.naicCode ?? "",
    standardCommissionPct: carrier.standardCommissionPct?.toString() ?? "",
    annualMinimumPremium: carrier.annualMinimumPremium?.toString() ?? "",
    profitSharingPremiumThreshold:
      carrier.profitSharingPremiumThreshold?.toString() ?? "",
    profitSharingLossRatioThreshold:
      carrier.profitSharingLossRatioThreshold?.toString() ?? "",
    commercialLines: carrier.commercialLines ?? false,
    personalLines: carrier.personalLines ?? false,
    notes: carrier.notes ?? "",
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  const set =
    (k: keyof typeof form) =>
    (e: { target: { value: string } }) => {
      setSaved(false);
      setForm((f) => ({ ...f, [k]: e.target.value }));
    };

  function toggleState(s: string) {
    setSaved(false);
    setForm((f) => ({
      ...f,
      states: f.states.includes(s)
        ? f.states.filter((x) => x !== s)
        : [...f.states, s].sort(),
    }));
  }

  async function save() {
    setSaving(true);
    setError("");
    const { data, errors } = await client.models.Carrier.update({
      id: carrier.id,
      name: form.name.trim() || carrier.name,
      appointed: form.appointed,
      dateAppointed: form.dateAppointed || null,
      primaryContactName: form.primaryContactName.trim() || null,
      primaryContactEmail: form.primaryContactEmail.trim() || null,
      primaryContactPhone: form.primaryContactPhone.trim() || null,
      primaryUnderwriterName: form.primaryUnderwriterName.trim() || null,
      primaryUnderwriterEmail: form.primaryUnderwriterEmail.trim() || null,
      primaryUnderwriterPhone: form.primaryUnderwriterPhone.trim() || null,
      states: form.states,
      naicCode: form.naicCode.trim() || null,
      standardCommissionPct: form.standardCommissionPct
        ? Number(form.standardCommissionPct)
        : null,
      annualMinimumPremium: form.annualMinimumPremium
        ? Number(form.annualMinimumPremium)
        : null,
      profitSharingPremiumThreshold: form.profitSharingPremiumThreshold
        ? Number(form.profitSharingPremiumThreshold)
        : null,
      profitSharingLossRatioThreshold: form.profitSharingLossRatioThreshold
        ? Number(form.profitSharingLossRatioThreshold)
        : null,
      commercialLines: form.commercialLines,
      personalLines: form.personalLines,
      notes: form.notes.trim() || null,
    });
    setSaving(false);
    if (errors?.length || !data) {
      setError(errors?.[0]?.message ?? "Save failed");
      return;
    }
    onChange(data);
    setSaved(true);
  }

  return (
    <div className="card">
      <h2>Appointment details</h2>
      <div className="form-grid">
        <div className="field">
          <label>Name</label>
          <input value={form.name} onChange={set("name")} />
        </div>
        <div className="field">
          <label>Status</label>
          <select
            value={form.appointed ? "1" : "0"}
            onChange={(e) => {
              setSaved(false);
              setForm((f) => ({ ...f, appointed: e.target.value === "1" }));
            }}
          >
            <option value="1">Appointed</option>
            <option value="0">Prospective</option>
          </select>
        </div>
        <div className="field">
          <label>Date appointed</label>
          <input type="date" value={form.dateAppointed} onChange={set("dateAppointed")} />
        </div>
        <div className="field">
          <label>NAIC code</label>
          <input value={form.naicCode} onChange={set("naicCode")} />
        </div>
        <div className="field">
          <label>Standard commission % (autofills new quotes)</label>
          <input
            type="number"
            step="0.1"
            min={0}
            max={100}
            value={form.standardCommissionPct}
            onChange={set("standardCommissionPct")}
          />
        </div>
        <div className="field">
          <label>Annual minimum premium to maintain appointment ($)</label>
          <input
            type="number"
            step="1"
            min={0}
            value={form.annualMinimumPremium}
            onChange={set("annualMinimumPremium")}
          />
        </div>
        <div className="field">
          <label>Profit sharing threshold — premium written ($)</label>
          <input
            type="number"
            step="1"
            min={0}
            value={form.profitSharingPremiumThreshold}
            onChange={set("profitSharingPremiumThreshold")}
          />
        </div>
        <div className="field">
          <label>Profit sharing loss ratio threshold (%)</label>
          <input
            type="number"
            step="0.1"
            min={0}
            max={100}
            value={form.profitSharingLossRatioThreshold}
            onChange={set("profitSharingLossRatioThreshold")}
          />
        </div>
        <div className="field">
          <label>Lines written</label>
          <div style={{ display: "flex", gap: 16, alignItems: "center", height: 38 }}>
            <label
              className="small"
              style={{ display: "flex", gap: 5, alignItems: "center" }}
            >
              <input
                type="checkbox"
                checked={form.commercialLines}
                onChange={(e) => {
                  setSaved(false);
                  setForm((f) => ({ ...f, commercialLines: e.target.checked }));
                }}
              />
              Commercial lines
            </label>
            <label
              className="small"
              style={{ display: "flex", gap: 5, alignItems: "center" }}
            >
              <input
                type="checkbox"
                checked={form.personalLines}
                onChange={(e) => {
                  setSaved(false);
                  setForm((f) => ({ ...f, personalLines: e.target.checked }));
                }}
              />
              Personal lines
            </label>
          </div>
        </div>
        <div className="field">
          <label>Primary contact</label>
          <input value={form.primaryContactName} onChange={set("primaryContactName")} />
        </div>
        <div className="field">
          <label>Contact email</label>
          <input value={form.primaryContactEmail} onChange={set("primaryContactEmail")} />
        </div>
        <div className="field">
          <label>Contact phone</label>
          <input value={form.primaryContactPhone} onChange={set("primaryContactPhone")} />
        </div>
        <div className="field">
          <label>Primary underwriter</label>
          <input
            value={form.primaryUnderwriterName}
            onChange={set("primaryUnderwriterName")}
          />
        </div>
        <div className="field">
          <label>Underwriter email</label>
          <input
            value={form.primaryUnderwriterEmail}
            onChange={set("primaryUnderwriterEmail")}
          />
        </div>
        <div className="field">
          <label>Underwriter phone</label>
          <input
            value={form.primaryUnderwriterPhone}
            onChange={set("primaryUnderwriterPhone")}
          />
        </div>
        <div className="field full">
          <label>States covered ({form.states.length})</label>
          <div className="toolbar" style={{ marginTop: 0, marginBottom: 6 }}>
            <button
              className="secondary"
              disabled={form.states.length === US_STATES.length}
              onClick={() => {
                setSaved(false);
                setForm((f) => ({ ...f, states: [...US_STATES] }));
              }}
            >
              All states
            </button>
            <button
              className="secondary"
              disabled={form.states.length === 0}
              onClick={() => {
                setSaved(false);
                setForm((f) => ({ ...f, states: [] }));
              }}
            >
              Clear
            </button>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 10px" }}>
            {US_STATES.map((s) => (
              <label
                key={s}
                className="small"
                style={{ display: "flex", gap: 3, alignItems: "center" }}
              >
                <input
                  type="checkbox"
                  checked={form.states.includes(s)}
                  onChange={() => toggleState(s)}
                />
                {s}
              </label>
            ))}
          </div>
        </div>
        <div className="field full">
          <label>Notes</label>
          <textarea rows={3} value={form.notes} onChange={set("notes")} />
        </div>
      </div>
      <div className="form-actions">
        <button className="primary" disabled={saving} onClick={save}>
          {saving ? "Saving…" : "Save changes"}
        </button>
        {saved && <span className="small" style={{ color: "var(--green)" }}>Saved.</span>}
        {error && <span className="error-text">{error}</span>}
      </div>
    </div>
  );
}

function AppetiteGuides({ carrierId }: { carrierId: string }) {
  const [guides, setGuides] = useState<AppetiteGuide[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<AppetiteGuide | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  function load() {
    listAllPages((nextToken) =>
      client.models.AppetiteGuide.list({
        filter: { carrierId: { eq: carrierId } },
        limit: 500,
        nextToken,
      })
    ).then((data) => setGuides(data as AppetiteGuide[]));
  }

  useEffect(load, [carrierId]);

  async function del(id: string) {
    await client.models.AppetiteGuide.delete({ id });
    setGuides((gs) => gs.filter((g) => g.id !== id));
    setConfirmId(null);
  }

  return (
    <div className="card">
      <div className="toolbar" style={{ marginTop: 0, alignItems: "flex-start" }}>
        <div>
          <h2 style={{ margin: 0 }}>Appetite guides</h2>
          <p className="muted small" style={{ margin: "4px 0 0" }}>
            What this carrier will look at. Drives the Appetite Finder and the
            daily renewal marketing sweep.
          </p>
        </div>
        <div className="grow" />
        <button
          className="primary"
          onClick={() => {
            setEditing(null);
            setShowForm(!showForm);
          }}
        >
          {showForm ? "Cancel" : "+ Add appetite guide"}
        </button>
      </div>

      {(showForm || editing) && (
        <GuideForm
          key={editing?.id ?? "new"}
          carrierId={carrierId}
          existing={editing}
          onSaved={(g) => {
            setGuides((gs) => {
              const without = gs.filter((x) => x.id !== g.id);
              return [...without, g];
            });
            setShowForm(false);
            setEditing(null);
          }}
          onCancel={() => {
            setShowForm(false);
            setEditing(null);
          }}
        />
      )}

      {guides.length === 0 ? (
        <p className="muted small">No appetite guides recorded.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Lines</th>
                <th>Lead time</th>
                <th>TIV range</th>
                <th>Construction years</th>
                <th>States</th>
                <th>Notes</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {guides.map((g) => (
                <tr key={g.id}>
                  <td className="small">
                    {(g.linesWritten ?? []).filter(Boolean).join(", ") || "—"}
                  </td>
                  <td>
                    {g.quoteSubmissionLeadTimeDays != null
                      ? `${g.quoteSubmissionLeadTimeDays} days`
                      : "—"}
                  </td>
                  <td className="small">
                    {fmtMoney(g.minValue)} – {fmtMoney(g.maxValue)}
                  </td>
                  <td className="small">
                    {g.minConstructionYear ?? "any"} – {g.maxConstructionYear ?? "any"}
                  </td>
                  <td className="small">
                    {(g.states ?? []).filter(Boolean).join(", ") || "carrier default"}
                  </td>
                  <td className="small">{g.notes ?? ""}</td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <button
                      className="link"
                      onClick={() => {
                        setShowForm(false);
                        setEditing(g);
                      }}
                    >
                      Edit
                    </button>
                    {confirmId === g.id ? (
                      <>
                        <button className="danger" onClick={() => del(g.id)}>
                          Confirm
                        </button>
                        <button className="link" onClick={() => setConfirmId(null)}>
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button className="link" onClick={() => setConfirmId(g.id)}>
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Create/edit one appetite guide. */
function GuideForm({
  carrierId,
  existing,
  onSaved,
  onCancel,
}: {
  carrierId: string;
  existing: AppetiteGuide | null;
  onSaved: (g: AppetiteGuide) => void;
  onCancel: () => void;
}) {
  const str = (n: number | null | undefined) => (n == null ? "" : String(n));
  const [lines, setLines] = useState<string[]>(
    (existing?.linesWritten ?? []).filter((l): l is string => !!l)
  );
  const [states, setStates] = useState<string[]>(
    (existing?.states ?? []).filter((s): s is string => !!s)
  );
  const [leadTime, setLeadTime] = useState(str(existing?.quoteSubmissionLeadTimeDays));
  const [minValue, setMinValue] = useState(str(existing?.minValue));
  const [maxValue, setMaxValue] = useState(str(existing?.maxValue));
  const [minYear, setMinYear] = useState(str(existing?.minConstructionYear));
  const [maxYear, setMaxYear] = useState(str(existing?.maxConstructionYear));
  const [notes, setNotes] = useState(existing?.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function save() {
    // Inverted ranges silently break the Appetite Finder — catch them here.
    const problems: string[] = [];
    if (minValue && maxValue && Number(minValue) > Number(maxValue))
      problems.push("Min TIV can't be greater than Max TIV.");
    if (minYear && maxYear && Number(minYear) > Number(maxYear))
      problems.push("Earliest construction year can't be after the latest.");
    if ((minValue && Number(minValue) < 0) || (maxValue && Number(maxValue) < 0))
      problems.push("TIV values can't be negative.");
    if (problems.length) {
      setError(problems.join(" "));
      return;
    }
    setError("");
    setSaving(true);
    const num = (v: string) => (v.trim() === "" ? null : Number(v));
    const payload = {
      linesWritten: lines,
      states,
      quoteSubmissionLeadTimeDays: num(leadTime),
      minValue: num(minValue),
      maxValue: num(maxValue),
      minConstructionYear: num(minYear),
      maxConstructionYear: num(maxYear),
      notes: notes.trim() || null,
    };
    const { data, errors } = existing
      ? await client.models.AppetiteGuide.update({ id: existing.id, ...payload })
      : await client.models.AppetiteGuide.create({ carrierId, ...payload });
    setSaving(false);
    if (errors?.length || !data) {
      setError(errors?.[0]?.message ?? "Save failed");
      return;
    }
    onSaved(data);
  }

  return (
    <div className="card" style={{ background: "#f8fafc" }}>
      <h3 style={{ marginTop: 0 }}>
        {existing ? "Edit" : "Add"} appetite guide
      </h3>
      <div className="form-grid">
        <div className="field full">
          <label>Lines written</label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 14px" }}>
            {LINES_OF_BUSINESS.map((l) => (
              <label
                key={l}
                className="small"
                style={{ display: "flex", gap: 4, alignItems: "center" }}
              >
                <input
                  type="checkbox"
                  checked={lines.includes(l)}
                  onChange={() =>
                    setLines((ls) =>
                      ls.includes(l) ? ls.filter((x) => x !== l) : [...ls, l].sort()
                    )
                  }
                />
                {l}
              </label>
            ))}
          </div>
        </div>
        <div className="field">
          <label>Submission lead time (days)</label>
          <input
            type="number"
            min={0}
            value={leadTime}
            onChange={(e) => setLeadTime(e.target.value)}
          />
        </div>
        <div className="field">
          <label>Min TIV ($)</label>
          <input type="number" value={minValue} onChange={(e) => setMinValue(e.target.value)} />
        </div>
        <div className="field">
          <label>Max TIV ($)</label>
          <input type="number" value={maxValue} onChange={(e) => setMaxValue(e.target.value)} />
        </div>
        <div className="field">
          <label>Earliest construction year</label>
          <input type="number" value={minYear} onChange={(e) => setMinYear(e.target.value)} />
        </div>
        <div className="field">
          <label>Latest construction year</label>
          <input type="number" value={maxYear} onChange={(e) => setMaxYear(e.target.value)} />
        </div>
        <div className="field full">
          <label>
            States ({states.length || "carrier default"})
          </label>
          <p className="muted small" style={{ margin: "0 0 6px" }}>
            Leave empty to use the carrier's states. Set them only when this
            guide is narrower than the carrier's overall footprint.
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 10px" }}>
            {US_STATES.map((s) => (
              <label
                key={s}
                className="small"
                style={{ display: "flex", gap: 3, alignItems: "center" }}
              >
                <input
                  type="checkbox"
                  checked={states.includes(s)}
                  onChange={() =>
                    setStates((ss) =>
                      ss.includes(s) ? ss.filter((x) => x !== s) : [...ss, s].sort()
                    )
                  }
                />
                {s}
              </label>
            ))}
          </div>
        </div>
        <div className="field full">
          <label>Notes</label>
          <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
      </div>
      <div className="form-actions">
        <button className="primary" disabled={saving} onClick={save}>
          {saving ? "Saving…" : existing ? "Save changes" : "Add guide"}
        </button>
        <button className="link" onClick={onCancel}>
          Cancel
        </button>
        {error && <span className="error-text">{error}</span>}
      </div>
    </div>
  );
}
