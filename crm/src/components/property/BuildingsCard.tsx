import { useEffect, useState } from "react";
import {
  client,
  fmtNum,
  listAllPages,
  type Building,
} from "../../lib/client";
import ConfirmButton from "../ConfirmButton";
import { useSort, SortTh } from "../../lib/useSort";
import { useFormState } from "../../lib/useFormState";
import { SaveStatus, useSaveStatus } from "../SaveStatus";

export default function BuildingsCard({ accountId }: { accountId: string }) {
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
          {totalSqft ? ` · ${fmtNum(totalSqft)} sq ft` : ""}
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
                  <td>{fmtNum(b.sqft)}</td>
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
