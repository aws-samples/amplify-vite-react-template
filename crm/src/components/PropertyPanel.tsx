import { useEffect, useState } from "react";
import { uploadData, getUrl, remove } from "aws-amplify/storage";
import {
  client,
  friendlyError,
  listAllPages,
  US_STATES,
  validateAccountFields,
  type Account,
  type Building,
} from "../lib/client";
import ConfirmButton from "./ConfirmButton";
import FilePreviewModal from "./FilePreview";
import { AddressAutocomplete } from "../lib/googlePlaces";
import { useSort, SortTh } from "../lib/useSort";
import { useFormState } from "../lib/useFormState";
import { SaveStatus, useSaveStatus } from "./SaveStatus";

// Alphabetical by label.
const CONSTRUCTION_TYPES = [
  ["FIRE_RESISTIVE", "Fire Resistive"],
  ["FRAME", "Frame"],
  ["JOISTED_MASONRY", "Joisted Masonry"],
  ["MASONRY_NON_COMBUSTIBLE", "Masonry Non-Combustible"],
  ["MODIFIED_FIRE_RESISTIVE", "Modified Fire Resistive"],
  ["NON_COMBUSTIBLE", "Non-Combustible"],
] as const;

/** Underwriting property details: construction, system updates, buildings,
 * and site photos. Feeds the ACORD 140 autofill. */
export default function PropertyPanel({
  account,
  onChange,
}: {
  account: Account;
  onChange: (a: Account) => void;
}) {
  return (
    <>
      <DetailsCard account={account} onChange={onChange} />
      <BuildingsCard accountId={account.id} />
      <PhotosCard account={account} onChange={onChange} />
    </>
  );
}

function DetailsCard({
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

function BuildingsCard({ accountId }: { accountId: string }) {
  const [buildings, setBuildings] = useState<Building[]>([]);
  // Persistent: the new row is on screen next to the confirmation, so the
  // message keeps describing something the user can still see.
  const addStatus = useSaveStatus();
  const { form, setF, reset } = useFormState(
    {
      label: "",
      sqft: "",
      street: "",
      desc: "",
    },
    { onEdit: addStatus.markDirty }
  );
  // Auto-clearing: the row a delete confirmation refers to is gone, so
  // nothing here will ever go dirty and clear it.
  const delStatus = useSaveStatus({ autoClearMs: 4000 });

  useEffect(() => {
    listAllPages((nextToken) =>
      client.models.Building.list({
        filter: { accountId: { eq: accountId } },
        nextToken,
      })
    ).then((data) => setBuildings(data));
  }, [accountId]);

  async function add() {
    const n = Number(form.sqft);
    if (form.sqft && (!Number.isInteger(n) || n <= 0)) {
      addStatus.markError("Sq ft should be a positive whole number.");
      return;
    }
    const label = form.label.trim() || `Building ${buildings.length + 1}`;
    await addStatus.run(
      async () => {
        // `errors` used to be dropped: a rejected create cleared nothing and
        // said nothing, so the form just sat there looking untouched.
        const { data, errors } = await client.models.Building.create({
          accountId,
          label,
          sqft: form.sqft ? n : undefined,
          streetAddress: form.street.trim() || undefined,
          description: form.desc.trim() || undefined,
        });
        if (errors?.length || !data) throw new Error(errors?.[0]?.message);
        setBuildings((bs) => [...bs, data]);
        // Baseline is still the blanks this mounted with — nothing ever calls
        // markSaved here — so `reset()` is the four setters it replaces. Its
        // `onEdit` fires while the status is still "saving", which markDirty
        // deliberately ignores, so it can't wipe the confirmation below.
        reset();
      },
      { savedMessage: `${label} added.`, errorMessage: "Couldn't add that building." }
    );
  }

  async function del(id: string) {
    const label = buildings.find((b) => b.id === id)?.label ?? "Building";
    await delStatus.run(
      async () => {
        // `errors` used to be dropped: a rejected delete still removed the row
        // from the table, so the building looked gone until the next reload.
        const { errors } = await client.models.Building.delete({ id });
        if (errors?.length) throw new Error(errors[0].message);
        setBuildings((bs) => bs.filter((b) => b.id !== id));
      },
      { savedMessage: `${label} removed.`, errorMessage: "Couldn't remove that building." }
    );
  }

  const totalSqft = buildings.reduce((s, b) => s + (b.sqft ?? 0), 0);

  // By label, unlabelled last — useSort puts nulls last in either direction.
  const { sorted, sortKey, dir, toggle } = useSort(
    buildings,
    {
      building: (b) => b.label,
      sqft: (b) => b.sqft,
    },
    "building"
  );

  return (
    <div className="card">
      <h2>
        Buildings{" "}
        <span className="muted small" style={{ fontWeight: 400 }}>
          — {buildings.length} total
          {totalSqft ? ` · ${totalSqft.toLocaleString()} sq ft` : ""}
        </span>
      </h2>
      <div className="toolbar">
        <div className="field">
          <label>Label</label>
          <input
            placeholder={`Building ${buildings.length + 1}`}
            value={form.label}
            onChange={(e) => setF("label", e.target.value)}
          />
        </div>
        <div className="field">
          <label>Street address</label>
          <input
            placeholder="2 John Hancock Dr"
            value={form.street}
            onChange={(e) => setF("street", e.target.value)}
          />
        </div>
        <div className="field">
          <label>Sq ft</label>
          <input
            type="number"
            min={1}
            value={form.sqft}
            onChange={(e) => setF("sqft", e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
          />
        </div>
        <div className="field" style={{ flex: "1 1 260px" }}>
          <label>Description (prints on ACORD 125)</label>
          <input
            placeholder="2, 4, 10, 12 John Hancock. Two-story wood frame…"
            value={form.desc}
            onChange={(e) => setF("desc", e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
          />
        </div>
        <button className="secondary" disabled={addStatus.busy} onClick={add}>
          + Add building
        </button>
        <SaveStatus {...addStatus.status} />
      </div>
      <SaveStatus {...delStatus.status} />
      {buildings.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <SortTh label="Building" colKey="building" sortKey={sortKey} dir={dir} onToggle={toggle} />
                <SortTh label="Sq ft" colKey="sqft" sortKey={sortKey} dir={dir} onToggle={toggle} />
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((b) => (
                <tr key={b.id}>
                  <td>{b.label}</td>
                  <td>{b.sqft?.toLocaleString() ?? "—"}</td>
                  <td>
                    {/* Was unguarded: one click deleted the building. */}
                    <ConfirmButton
                      label="Remove"
                      busyLabel="Removing…"
                      message={`Remove ${b.label ?? "this building"}?`}
                      onConfirm={() => del(b.id)}
                    />
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

const PHOTO_SLOTS = [
  { key: "coverPhotoKey", label: "Cover photo" },
  { key: "aerialPhotoKey", label: "Aerial photo" },
  { key: "plotPlanKey", label: "Plot plan" },
] as const;

function PhotosCard({
  account,
  onChange,
}: {
  account: Account;
  onChange: (a: Account) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ s3Key: string; name: string } | null>(null);
  const [error, setError] = useState("");

  async function upload(slotKey: (typeof PHOTO_SLOTS)[number]["key"], file?: File) {
    if (!file) return;
    setBusy(slotKey);
    setError("");
    try {
      const path = `property-photos/${account.id}/${slotKey}-${file.name}`;
      await uploadData({
        path,
        data: file,
        options: { contentType: file.type || undefined },
      }).result;
      const old = account[slotKey];
      const { data } = await client.models.Account.update({
        id: account.id,
        [slotKey]: path,
      });
      if (old && old !== path) await remove({ path: old }).catch(() => {});
      if (data) onChange(data);
    } catch (err) {
      setError(friendlyError(err, "Upload failed"));
    } finally {
      setBusy(null);
    }
  }

  async function clear(slotKey: (typeof PHOTO_SLOTS)[number]["key"]) {
    const old = account[slotKey];
    if (old) await remove({ path: old }).catch(() => {});
    const { data } = await client.models.Account.update({
      id: account.id,
      [slotKey]: null,
    });
    if (data) onChange(data);
  }

  return (
    <div className="card">
      <h2>Site photos &amp; plans</h2>
      <div className="photo-row">
        {PHOTO_SLOTS.map((slot) => (
          <PhotoSlot
            key={slot.key}
            label={slot.label}
            s3Key={account[slot.key] ?? null}
            busy={busy === slot.key}
            onUpload={(f) => upload(slot.key, f)}
            onView={(s3Key) =>
              setPreview({ s3Key, name: s3Key.split("/").pop() ?? slot.label })
            }
            onClear={() => clear(slot.key)}
            // <ConfirmButton> catches the rejection either way; without this
            // it would be dropped, and a confirm that silently does nothing
            // is worse than the unguarded button it replaced.
            onClearError={(err) => setError(friendlyError(err, "Remove failed"))}
          />
        ))}
      </div>
      {error && <p className="error-text">{error}</p>}
      {preview && (
        <FilePreviewModal
          s3Key={preview.s3Key}
          name={preview.name}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  );
}

function PhotoSlot({
  label,
  s3Key,
  busy,
  onUpload,
  onView,
  onClear,
  onClearError,
}: {
  label: string;
  s3Key: string | null;
  busy: boolean;
  onUpload: (f?: File) => void;
  onView: (s3Key: string) => void;
  /** May be async — the confirm button stays busy until it settles. */
  onClear: () => void | Promise<unknown>;
  onClearError: (err: unknown) => void;
}) {
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const isImage = s3Key
    ? /\.(png|jpe?g|gif|webp)$/i.test(s3Key)
    : false;

  useEffect(() => {
    setThumbUrl(null);
    if (s3Key && isImage) {
      getUrl({ path: s3Key }).then(({ url }) => setThumbUrl(url.toString()));
    }
  }, [s3Key, isImage]);

  return (
    <div className="photo-slot">
      <div className="ph-label">{label}</div>
      {s3Key ? (
        thumbUrl ? (
          <img src={thumbUrl} alt={label} onClick={() => onView(s3Key)} />
        ) : (
          <div
            className="ph-empty"
            style={{ cursor: "pointer" }}
            onClick={() => onView(s3Key)}
          >
            {isImage ? "Loading…" : "View file"}
          </div>
        )
      ) : (
        <div className="ph-empty">{busy ? "Uploading…" : "None"}</div>
      )}
      <div style={{ marginTop: 8, display: "flex", gap: 6, justifyContent: "center" }}>
        <label className="link" style={{ cursor: "pointer" }}>
          {s3Key ? "Replace" : "Upload"}
          <input
            type="file"
            accept="image/*,.pdf"
            hidden
            disabled={busy}
            onChange={(e) => onUpload(e.target.files?.[0])}
          />
        </label>
        {s3Key && (
          /* Was unguarded: one click deleted the S3 object and nulled the
             field. */
          <ConfirmButton
            label="Remove"
            busyLabel="Removing…"
            message={`Remove the ${label.toLowerCase()}? The stored file is deleted.`}
            onConfirm={onClear}
            onError={onClearError}
          />
        )}
      </div>
    </div>
  );
}
