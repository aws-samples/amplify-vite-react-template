import {
  client,
  validateAccountFields,
  type Account,
} from "../../lib/client";
import { SaveStatus, useSaveStatus } from "../../components/SaveStatus";
import { useFormState } from "../../lib/useFormState";

export function OverviewTab({
  account,
  onChange,
}: {
  account: Account;
  onChange: (a: Account) => void;
}) {
  // `useSaveStatus` owns the confirmation here — it carries saving and error
  // as well, which the two local flags used to split between them.
  // `useFormState`'s own `saved` is deliberately not destructured: two flags
  // answering "is the confirmation still true" is the bug this replaces.
  const saveStatus = useSaveStatus();
  const { form, setF } = useFormState({
    name: account.name,
    legalName: account.legalName ?? "",
    fein: account.fein ?? "",
    sicCode: account.sicCode ?? "",
    naicsCode: account.naicsCode ?? "",
    inspectionContactName: account.inspectionContactName ?? "",
    inspectionContactPhone: account.inspectionContactPhone ?? "",
    priorCarrierName: account.priorCarrierName ?? "",
    priorPolicyNumber: account.priorPolicyNumber ?? "",
    priorPremium: account.priorPremium?.toString() ?? "",
    priorTermEffective: account.priorTermEffective ?? "",
    priorTermExpiration: account.priorTermExpiration ?? "",
    contactFirstName: account.contactFirstName ?? "",
    contactLastName: account.contactLastName ?? "",
    contactEmail: account.contactEmail ?? "",
    contactPhone: account.contactPhone ?? "",
    totalInsuredValue: account.totalInsuredValue?.toString() ?? "",
    currentAgent: account.currentAgent ?? "",
    currentPolicyExpiration: account.currentPolicyExpiration ?? "",
    source: account.source ?? "",
    notes: account.notes ?? "",
  }, { onEdit: saveStatus.markDirty });

  async function save() {
    const problems = validateAccountFields(form);
    if (problems.length) {
      saveStatus.markError(problems.join(" "));
      return;
    }
    await saveStatus.run(
      async () => {
        const { data, errors } = await client.models.Account.update({
          id: account.id,
          name: form.name.trim() || account.name,
          legalName: form.legalName.trim() || null,
          fein: form.fein.trim() || null,
          sicCode: form.sicCode.trim() || null,
          naicsCode: form.naicsCode.trim() || null,
          inspectionContactName: form.inspectionContactName.trim() || null,
          inspectionContactPhone: form.inspectionContactPhone.trim() || null,
          priorCarrierName: form.priorCarrierName.trim() || null,
          priorPolicyNumber: form.priorPolicyNumber.trim() || null,
          priorPremium: form.priorPremium ? Number(form.priorPremium) : null,
          priorTermEffective: form.priorTermEffective || null,
          priorTermExpiration: form.priorTermExpiration || null,
          contactFirstName: form.contactFirstName.trim() || null,
          contactLastName: form.contactLastName.trim() || null,
          contactEmail: form.contactEmail.trim() || null,
          contactPhone: form.contactPhone.trim() || null,
          totalInsuredValue: form.totalInsuredValue
            ? Number(form.totalInsuredValue)
            : null,
          currentAgent: form.currentAgent.trim() || null,
          currentPolicyExpiration: form.currentPolicyExpiration || null,
          source: form.source.trim() || null,
          notes: form.notes.trim() || null,
        });
        if (errors?.length || !data) throw new Error(errors?.[0]?.message);
        onChange(data);
      },
      { errorMessage: "Save failed" }
    );
  }

  return (
    <div className="card">
      <h2>Details</h2>
      <div className="form-grid">
        <div className="field">
          <label>Name</label>
          <input value={form.name} onChange={(e) => setF("name", e.target.value)} />
        </div>
        <div className="field">
          <label>Full legal name (carrier submissions)</label>
          <input
            placeholder={account.name}
            value={form.legalName}
            onChange={(e) => setF("legalName", e.target.value)}
          />
        </div>
        <div className="field">
          <label>FEIN</label>
          <input value={form.fein} onChange={(e) => setF("fein", e.target.value)} />
        </div>
        <div className="field">
          <label>SIC</label>
          <input value={form.sicCode} onChange={(e) => setF("sicCode", e.target.value)} />
        </div>
        <div className="field">
          <label>NAICS</label>
          <input value={form.naicsCode} onChange={(e) => setF("naicsCode", e.target.value)} />
        </div>
        <div className="field">
          <label>Inspection contact</label>
          <input
            value={form.inspectionContactName}
            onChange={(e) => setF("inspectionContactName", e.target.value)}
          />
        </div>
        <div className="field">
          <label>Inspection contact phone</label>
          <input
            value={form.inspectionContactPhone}
            onChange={(e) => setF("inspectionContactPhone", e.target.value)}
          />
        </div>
        <div className="field">
          <label>Contact first name</label>
          <input value={form.contactFirstName} onChange={(e) => setF("contactFirstName", e.target.value)} />
        </div>
        <div className="field">
          <label>Contact last name</label>
          <input value={form.contactLastName} onChange={(e) => setF("contactLastName", e.target.value)} />
        </div>
        <div className="field">
          <label>Contact email</label>
          <input value={form.contactEmail} onChange={(e) => setF("contactEmail", e.target.value)} />
        </div>
        <div className="field">
          <label>Contact phone</label>
          <input value={form.contactPhone} onChange={(e) => setF("contactPhone", e.target.value)} />
        </div>
        <div className="field">
          <label>Total insured value ($)</label>
          <input
            type="number"
            value={form.totalInsuredValue}
            onChange={(e) => setF("totalInsuredValue", e.target.value)}
          />
        </div>
        <div className="field">
          <label>Current agent / broker</label>
          <input value={form.currentAgent} onChange={(e) => setF("currentAgent", e.target.value)} />
        </div>
        <div className="field">
          <label>Prior carrier</label>
          <input value={form.priorCarrierName} onChange={(e) => setF("priorCarrierName", e.target.value)} />
        </div>
        <div className="field">
          <label>Prior policy number</label>
          <input value={form.priorPolicyNumber} onChange={(e) => setF("priorPolicyNumber", e.target.value)} />
        </div>
        <div className="field">
          <label>Prior premium ($)</label>
          <input
            type="number"
            value={form.priorPremium}
            onChange={(e) => setF("priorPremium", e.target.value)}
          />
        </div>
        <div className="field">
          <label>Prior term effective</label>
          <input
            type="date"
            value={form.priorTermEffective}
            onChange={(e) => setF("priorTermEffective", e.target.value)}
          />
        </div>
        <div className="field">
          <label>Prior term expiration</label>
          <input
            type="date"
            value={form.priorTermExpiration}
            onChange={(e) => setF("priorTermExpiration", e.target.value)}
          />
        </div>
        {/* Lead-only: once bound, the Policy records are authoritative. */}
        {account.stage !== "CLIENT" && (
        <div className="field">
          <label>Current policy expiration</label>
          <input
            type="date"
            value={form.currentPolicyExpiration}
            onChange={(e) => setF("currentPolicyExpiration", e.target.value)}
          />
        </div>
        )}
        <div className="field">
          <label>Source</label>
          <input value={form.source} onChange={(e) => setF("source", e.target.value)} />
        </div>
        <div className="field full">
          <label>Notes</label>
          <textarea rows={4} value={form.notes} onChange={(e) => setF("notes", e.target.value)} />
        </div>
      </div>
      <div className="form-actions">
        <button className="primary" disabled={saveStatus.busy} onClick={save}>
          {saveStatus.busy ? "Saving…" : "Save changes"}
        </button>
        <SaveStatus {...saveStatus.status} />
      </div>
    </div>
  );
}
