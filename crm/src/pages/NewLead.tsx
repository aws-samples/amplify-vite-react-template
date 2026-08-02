import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { uploadData } from "aws-amplify/storage";
import { client, friendlyError, US_STATES, validateAccountFields } from "../lib/client";
import { AddressAutocomplete } from "../lib/googlePlaces";
import FileButton from "../components/FileButton";
import { useFormState } from "../lib/useFormState";
import {
  ACCOUNT_TYPE_OPTIONS,
  DEFAULT_ACCOUNT_TYPE,
  type AccountType,
} from "../lib/enums";

export default function NewLead() {
  const navigate = useNavigate();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [stagedFiles, setStagedFiles] = useState<File[]>([]);
  // Set once the lead exists — pressing Create again would duplicate it.
  const [createdId, setCreatedId] = useState<string | null>(null);
  const { form, setF, patch } = useFormState({
    type: DEFAULT_ACCOUNT_TYPE as string,
    name: "",
    contactFirstName: "",
    contactLastName: "",
    contactEmail: "",
    contactPhone: "",
    address: "",
    city: "",
    state: "",
    zip: "",
    unitCount: "",
    yearBuilt: "",
    totalInsuredValue: "",
    currentAgent: "",
    currentPolicyExpiration: "",
    source: "",
    notes: "",
  });

  async function save() {
    if (!form.name.trim()) {
      setError("Name is required.");
      return;
    }
    const problems = validateAccountFields(form);
    if (problems.length) {
      setError(problems.join(" "));
      return;
    }
    setSaving(true);
    setError("");
    const { data, errors } = await client.models.Account.create({
      stage: "LEAD",
      type: form.type as AccountType,
      name: form.name.trim(),
      contactFirstName: form.contactFirstName.trim() || undefined,
      contactLastName: form.contactLastName.trim() || undefined,
      contactEmail: form.contactEmail.trim() || undefined,
      contactPhone: form.contactPhone.trim() || undefined,
      address: form.address.trim() || undefined,
      city: form.city.trim() || undefined,
      state: form.state || undefined,
      zip: form.zip.trim() || undefined,
      unitCount: form.unitCount ? Number(form.unitCount) : undefined,
      yearBuilt: form.yearBuilt ? Number(form.yearBuilt) : undefined,
      totalInsuredValue: form.totalInsuredValue
        ? Number(form.totalInsuredValue)
        : undefined,
      currentAgent: form.currentAgent.trim() || undefined,
      currentPolicyExpiration: form.currentPolicyExpiration || undefined,
      source: form.source.trim() || undefined,
      notes: form.notes.trim() || undefined,
    });
    if (errors?.length || !data) {
      setSaving(false);
      setError(friendlyError(errors?.[0]?.message, "Failed to create lead."));
      return;
    }

    // Upload any staged documents to the new account so OCR + AI extraction
    // are ready when they land on the Documents tab.
    const failedUploads: string[] = [];
    for (const file of stagedFiles) {
      try {
        const { data: doc } = await client.models.Document.create({
          entityType: "ACCOUNT",
          entityId: data.id,
          category: "OTHER",
          name: file.name,
          s3Key: "pending",
          contentType: file.type,
          sizeBytes: file.size,
          ocrStatus: "PENDING",
        });
        if (!doc) {
          failedUploads.push(file.name);
          continue;
        }
        const path = `documents/ACCOUNT/${data.id}/${doc.id}/${file.name}`;
        await client.models.Document.update({ id: doc.id, s3Key: path });
        await uploadData({
          path,
          data: file,
          options: { contentType: file.type || undefined },
        }).result;
      } catch {
        // A failed upload shouldn't block lead creation, but navigating away
        // without saying so loses the attachment silently.
        failedUploads.push(file.name);
      }
    }

    setSaving(false);
    if (failedUploads.length) {
      const many = failedUploads.length > 1;
      setCreatedId(data.id);
      setError(
        `The lead was created, but ${failedUploads.length} document${many ? "s" : ""} didn't upload: ` +
          `${failedUploads.join(", ")}. Open the lead and add ${many ? "them" : "it"} from the Documents tab.`
      );
      return;
    }
    // Land on Documents so OCR completes and AI extraction is the next step.
    navigate(`/accounts/${data.id}?tab=documents`);
  }

  const isPersonal = form.type === "PERSONAL";

  return (
    <>
      <h1>New lead</h1>
      <p className="sub">Association or individual prospect</p>

      <div className="card">
        <div className="form-grid">
          <div className="field">
            <label>Type</label>
            <select value={form.type} onChange={(e) => setF("type", e.target.value)}>
              {ACCOUNT_TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Name (association / insured) *</label>
            <input value={form.name} onChange={(e) => setF("name", e.target.value)} />
          </div>
          <div className="field">
            <label>Source</label>
            <input
              placeholder="website, referral, cold…"
              value={form.source}
              onChange={(e) => setF("source", e.target.value)}
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
            <input type="email" value={form.contactEmail} onChange={(e) => setF("contactEmail", e.target.value)} />
          </div>
          <div className="field">
            <label>Contact phone</label>
            <input value={form.contactPhone} onChange={(e) => setF("contactPhone", e.target.value)} />
          </div>
          <div className="field">
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
          {!isPersonal && (
            <div className="field">
              <label>Unit count</label>
              <input type="number" min={0} value={form.unitCount} onChange={(e) => setF("unitCount", e.target.value)} />
            </div>
          )}
          <div className="field">
            <label>Year built</label>
            <input type="number" value={form.yearBuilt} onChange={(e) => setF("yearBuilt", e.target.value)} />
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
            <input
              placeholder="Incumbent agency"
              value={form.currentAgent}
              onChange={(e) => setF("currentAgent", e.target.value)}
            />
          </div>
          <div className="field">
            <label>Current policy expiration</label>
            <input
              type="date"
              value={form.currentPolicyExpiration}
              onChange={(e) => setF("currentPolicyExpiration", e.target.value)}
            />
          </div>
          <div className="field full">
            <label>Notes</label>
            <textarea rows={3} value={form.notes} onChange={(e) => setF("notes", e.target.value)} />
          </div>
        </div>

        <h3>Documents (optional)</h3>
        <p className="muted small" style={{ marginTop: 0 }}>
          Attach prior policy packets, budgets, or condo docs now. They're
          OCR'd on the account, then AI extraction can auto-fill the details.
        </p>
        <div className="toolbar">
          <FileButton
            label="Add documents…"
            multiple
            onFiles={(files) =>
              files &&
              setStagedFiles((prev) => [...prev, ...Array.from(files)])
            }
          />
        </div>
        {stagedFiles.length > 0 && (
          <div className="table-wrap" style={{ marginBottom: 4 }}>
            <table>
              <tbody>
                {stagedFiles.map((f, i) => (
                  <tr key={i}>
                    <td>{f.name}</td>
                    <td className="muted small">
                      {Math.max(1, Math.round(f.size / 1024))} KB
                    </td>
                    <td style={{ width: 60 }}>
                      <button
                        className="danger"
                        onClick={() =>
                          setStagedFiles((prev) => prev.filter((_, j) => j !== i))
                        }
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="form-actions">
          {createdId ? (
            <button
              className="primary"
              onClick={() => navigate(`/accounts/${createdId}?tab=documents`)}
            >
              Go to the lead
            </button>
          ) : (
            <button className="primary" disabled={saving} onClick={save}>
              {saving
                ? stagedFiles.length
                  ? "Creating & uploading…"
                  : "Creating…"
                : stagedFiles.length
                  ? `Create lead & upload ${stagedFiles.length} document${stagedFiles.length > 1 ? "s" : ""}`
                  : "Create lead"}
            </button>
          )}
          {error && <span className="error-text">{error}</span>}
        </div>
      </div>
    </>
  );
}
