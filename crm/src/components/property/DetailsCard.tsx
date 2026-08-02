import {
  client,
  US_STATES,
  validateAccountFields,
  type Account,
} from "../../lib/client";
import { AddressAutocomplete } from "../../lib/googlePlaces";
import { useFormState } from "../../lib/useFormState";
import { SaveStatus, useSaveStatus } from "../SaveStatus";

// Alphabetical by label.
const CONSTRUCTION_TYPES = [
  ["FIRE_RESISTIVE", "Fire Resistive"],
  ["FRAME", "Frame"],
  ["JOISTED_MASONRY", "Joisted Masonry"],
  ["MASONRY_NON_COMBUSTIBLE", "Masonry Non-Combustible"],
  ["MODIFIED_FIRE_RESISTIVE", "Modified Fire Resistive"],
  ["NON_COMBUSTIBLE", "Non-Combustible"],
] as const;

export default function DetailsCard({
  account,
  onChange,
}: {
  account: Account;
  onChange: (a: Account) => void;
}) {
  // One owner for "is the confirmation still true": `useFormState`'s `saved`
  // is left unread and `useSaveStatus` carries saving/saved/error together.
  const saveStatus = useSaveStatus();
  const { form, setF, patch } = useFormState({
    address: account.address ?? "",
    city: account.city ?? "",
    county: account.county ?? "",
    state: account.state ?? "",
    zip: account.zip ?? "",
    unitCount: account.unitCount?.toString() ?? "",
    yearBuilt: account.yearBuilt?.toString() ?? "",
    constructionType: account.constructionType ?? "",
    firewallsVerified: account.firewallsVerified ?? false,
    stories: account.stories?.toString() ?? "",
    coastal: account.coastal ?? false,
    milesToCoast: account.milesToCoast?.toString() ?? "",
    roofUpdatedYear: account.roofUpdatedYear?.toString() ?? "",
    hvacUpdatedYear: account.hvacUpdatedYear?.toString() ?? "",
    electricalUpdatedYear: account.electricalUpdatedYear?.toString() ?? "",
    plumbingUpdatedYear: account.plumbingUpdatedYear?.toString() ?? "",
    otherUpdates: account.otherUpdates ?? "",
  }, { onEdit: saveStatus.markDirty });

  const yearOk = (v: string) => {
    if (!v) return true;
    const n = Number(v);
    return Number.isInteger(n) && n >= 1600 && n <= new Date().getFullYear() + 1;
  };

  async function save() {
    const problems = validateAccountFields(form);
    if (problems.length) {
      saveStatus.markError(problems.join(" "));
      return;
    }
    const badYears = (
      [
        ["roofUpdatedYear", "Roof"],
        ["hvacUpdatedYear", "HVAC"],
        ["electricalUpdatedYear", "Electrical"],
        ["plumbingUpdatedYear", "Plumbing"],
      ] as const
    ).filter(([k]) => !yearOk(form[k]));
    if (badYears.length) {
      saveStatus.markError(
        `Check the ${badYears.map(([, l]) => l).join(", ")} year${badYears.length > 1 ? "s" : ""}.`
      );
      return;
    }
    if (form.coastal && form.milesToCoast && Number(form.milesToCoast) < 0) {
      saveStatus.markError("Miles to coast can't be negative.");
      return;
    }
    await saveStatus.run(
      async () => {
        const { data, errors } = await client.models.Account.update({
          id: account.id,
          address: form.address.trim() || null,
          city: form.city.trim() || null,
          county: form.county.trim() || null,
          state: form.state || null,
          zip: form.zip.trim() || null,
          unitCount: form.unitCount ? Number(form.unitCount) : null,
          yearBuilt: form.yearBuilt ? Number(form.yearBuilt) : null,
          constructionType: (form.constructionType || null) as Account["constructionType"],
          firewallsVerified: form.firewallsVerified,
          stories: form.stories ? Number(form.stories) : null,
          coastal: form.coastal,
          milesToCoast:
            form.coastal && form.milesToCoast ? Number(form.milesToCoast) : null,
          roofUpdatedYear: form.roofUpdatedYear ? Number(form.roofUpdatedYear) : null,
          hvacUpdatedYear: form.hvacUpdatedYear ? Number(form.hvacUpdatedYear) : null,
          electricalUpdatedYear: form.electricalUpdatedYear
            ? Number(form.electricalUpdatedYear)
            : null,
          plumbingUpdatedYear: form.plumbingUpdatedYear
            ? Number(form.plumbingUpdatedYear)
            : null,
          otherUpdates: form.otherUpdates.trim() || null,
        });
        if (errors?.length || !data) throw new Error(errors?.[0]?.message);
        onChange(data);
      },
      { errorMessage: "Save failed" }
    );
  }

  return (
    <div className="card">
      <h2>Property</h2>
      <div className="form-grid">
        <div className="field full">
          <label>Street address</label>
          <AddressAutocomplete
            value={form.address}
            onChange={(v) => setF("address", v)}
            onPlace={(p) =>
              patch((f) => ({
                address: p.address || f.address,
                city: p.city || f.city,
                state: p.state || f.state,
                zip: p.zip || f.zip,
              }))
            }
          />
        </div>
        <div className="field">
          <label>County</label>
          <input
            placeholder="Middlesex"
            value={form.county}
            onChange={(e) => setF("county", e.target.value)}
          />
        </div>
        <div className="field">
          <label>City</label>
          <input value={form.city} onChange={(e) => setF("city", e.target.value)} />
        </div>
        <div className="field">
          <label>State</label>
          <select value={form.state} onChange={(e) => setF("state", e.target.value)}>
            <option value="">—</option>
            {US_STATES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>ZIP</label>
          <input value={form.zip} onChange={(e) => setF("zip", e.target.value)} />
        </div>
        <div className="field">
          <label>Unit count</label>
          <input
            type="number"
            min={0}
            value={form.unitCount}
            onChange={(e) => setF("unitCount", e.target.value)}
          />
        </div>
        <div className="field">
          <label>Year built</label>
          <input
            type="number"
            value={form.yearBuilt}
            onChange={(e) => setF("yearBuilt", e.target.value)}
          />
        </div>
        <div className="field">
          <label>Construction type</label>
          <select
            value={form.constructionType}
            onChange={(e) => setF("constructionType", e.target.value)}
          >
            <option value="">—</option>
            {CONSTRUCTION_TYPES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Stories</label>
          <input
            type="number"
            min={1}
            value={form.stories}
            onChange={(e) => setF("stories", e.target.value)}
          />
        </div>
        <div className="field">
          <label>Firewalls verified?</label>
          <label className="small" style={{ display: "flex", gap: 6, alignItems: "center", padding: "8px 0" }}>
            <input
              type="checkbox"
              checked={form.firewallsVerified}
              onChange={(e) => setF("firewallsVerified", e.target.checked)}
            />
            Verified
          </label>
        </div>
        <div className="field">
          <label>Coastal?</label>
          <label className="small" style={{ display: "flex", gap: 6, alignItems: "center", padding: "8px 0" }}>
            <input
              type="checkbox"
              checked={form.coastal}
              onChange={(e) => setF("coastal", e.target.checked)}
            />
            Coastal exposure
          </label>
        </div>
        {form.coastal && (
          <div className="field">
            <label>Miles to coast</label>
            <input
              type="number"
              min={0}
              step="0.1"
              value={form.milesToCoast}
              onChange={(e) => setF("milesToCoast", e.target.value)}
            />
          </div>
        )}
      </div>

      <h3>System updates (year completed)</h3>
      <div className="form-grid">
        <div className="field">
          <label>Roof</label>
          <input
            type="number"
            value={form.roofUpdatedYear}
            onChange={(e) => setF("roofUpdatedYear", e.target.value)}
          />
        </div>
        <div className="field">
          <label>HVAC</label>
          <input
            type="number"
            value={form.hvacUpdatedYear}
            onChange={(e) => setF("hvacUpdatedYear", e.target.value)}
          />
        </div>
        <div className="field">
          <label>Electrical</label>
          <input
            type="number"
            value={form.electricalUpdatedYear}
            onChange={(e) => setF("electricalUpdatedYear", e.target.value)}
          />
        </div>
        <div className="field">
          <label>Plumbing</label>
          <input
            type="number"
            value={form.plumbingUpdatedYear}
            onChange={(e) => setF("plumbingUpdatedYear", e.target.value)}
          />
        </div>
        <div className="field full">
          <label>Other updates</label>
          <textarea
            rows={2}
            placeholder="Elevators 2019, windows 2021…"
            value={form.otherUpdates}
            onChange={(e) => setF("otherUpdates", e.target.value)}
          />
        </div>
      </div>

      <div className="form-actions">
        <button className="primary" disabled={saveStatus.busy} onClick={save}>
          {saveStatus.busy ? "Saving…" : "Save property"}
        </button>
        <SaveStatus {...saveStatus.status} />
      </div>
    </div>
  );
}
