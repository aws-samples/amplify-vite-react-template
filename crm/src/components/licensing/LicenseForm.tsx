import { useState } from "react";
import {
  client,
  friendlyError,
  LICENSE_CLASS_LABELS,
  LICENSE_STATUS_LABELS,
  LINES_OF_AUTHORITY,
  US_STATES,
  type License,
  type UserProfile,
} from "../../lib/client";
import { useFormState } from "../../lib/useFormState";
import type { HolderType } from "./holder";

export default function LicenseForm({
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
  const { form, setF } = useFormState({
    userProfileId: existing?.userProfileId ?? "",
    state: existing?.state ?? "",
    licenseNumber: existing?.licenseNumber ?? "",
    npn: existing?.npn ?? "",
    // Held as plain strings, as they always were: these three are `<select>`
    // values, and the payload below already casts them back to their enums.
    // (The curried setter erased the type by spreading a computed key; the
    // typed setter needs it said out loud.)
    licenseClass: (existing?.licenseClass ??
      (holderType === "FIRM" ? "AGENCY" : "PRODUCER")) as string,
    residency: (existing?.residency ?? "NON_RESIDENT") as string,
    status: (existing?.status ?? "ACTIVE") as string,
    effectiveDate: existing?.effectiveDate ?? "",
    expirationDate: existing?.expirationDate ?? "",
    continuingEducationDueDate: existing?.continuingEducationDueDate ?? "",
    notes: existing?.notes ?? "",
    // Was hoisted out of `form` only because the curried setter couldn't type
    // a `string[]`; it is a field like any other.
    loa: (existing?.linesOfAuthority ?? []).filter((x): x is string => !!x),
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

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
      linesOfAuthority: form.loa,
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
      setError(friendlyError(errors?.[0]?.message, "Save failed"));
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
            <select value={form.userProfileId} onChange={(e) => setF("userProfileId", e.target.value)}>
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
          <select value={form.state} onChange={(e) => setF("state", e.target.value)}>
            <option value="">—</option>
            {US_STATES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>License number *</label>
          <input value={form.licenseNumber} onChange={(e) => setF("licenseNumber", e.target.value)} />
        </div>
        <div className="field">
          <label>NPN</label>
          <input value={form.npn} onChange={(e) => setF("npn", e.target.value)} />
        </div>
        <div className="field">
          <label>License class</label>
          <select value={form.licenseClass} onChange={(e) => setF("licenseClass", e.target.value)}>
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
          <select value={form.residency} onChange={(e) => setF("residency", e.target.value)}>
            <option value="NON_RESIDENT">Non-resident</option>
            <option value="RESIDENT">Resident</option>
          </select>
        </div>
        <div className="field">
          <label>Status</label>
          <select value={form.status} onChange={(e) => setF("status", e.target.value)}>
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
          <input type="date" value={form.effectiveDate} onChange={(e) => setF("effectiveDate", e.target.value)} />
        </div>
        <div className="field">
          <label>Expiration date</label>
          <input type="date" value={form.expirationDate} onChange={(e) => setF("expirationDate", e.target.value)} />
        </div>
        <div className="field">
          <label>CE due date</label>
          <input
            type="date"
            value={form.continuingEducationDueDate}
            onChange={(e) => setF("continuingEducationDueDate", e.target.value)}
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
                  checked={form.loa.includes(l)}
                  onChange={() =>
                    setF("loa", (ls) =>
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
          <textarea rows={2} value={form.notes} onChange={(e) => setF("notes", e.target.value)} />
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
