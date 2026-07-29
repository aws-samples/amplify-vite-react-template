import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { uploadData, getUrl, remove } from "aws-amplify/storage";
import {
  client,
  fmtDate,
  fmtMoney,
  friendlyError,
  validateAccountFields,
  type Account,
  type Carrier,
  type Certificate,
  type Policy,
  type UserProfile,
} from "../lib/client";
import { fillAcord25 } from "../lib/acord";
import DocumentsPanel from "../components/DocumentsPanel";
import QuotesPanel, { commissionCell, termsSummary } from "../components/QuotesPanel";
import CoverageForm from "../components/CoverageForm";
import FilePreviewModal from "../components/FilePreview";
import PropertyPanel from "../components/PropertyPanel";
import FormsTab from "../components/FormsTab";
import ExtractionPanel from "../components/ExtractionPanel";
import Celebration from "../components/Celebration";

type Tab = "overview" | "quotes" | "policies" | "documents" | "certificates";

const VALID_TABS: Tab[] = [
  "overview",
  "quotes",
  "policies",
  "documents",
  "certificates",
];

export default function AccountDetail({ profile }: { profile: UserProfile }) {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const initialTab = searchParams.get("tab") as Tab | null;
  const [account, setAccount] = useState<Account | null>(null);
  const [tab, setTab] = useState<Tab>(
    initialTab && VALID_TABS.includes(initialTab) ? initialTab : "overview"
  );
  const [notFound, setNotFound] = useState(false);
  const [celebrate, setCelebrate] = useState(false);
  const prevStage = useRef<string | null>(null);

  // Fire the celebration on a LEAD → CLIENT transition (quote bound).
  useEffect(() => {
    const stage = account?.stage ?? null;
    if (prevStage.current === "LEAD" && stage === "CLIENT") setCelebrate(true);
    prevStage.current = stage;
  }, [account?.stage]);

  useEffect(() => {
    if (!id) return;
    client.models.Account.get({ id }).then(({ data }) => {
      if (data) setAccount(data);
      else setNotFound(true);
    });
  }, [id]);

  if (notFound) return <p>Account not found.</p>;
  if (!account) return <p className="muted">Loading…</p>;

  return (
    <>
      {celebrate && (
        <Celebration name={account.name} onDone={() => setCelebrate(false)} />
      )}
      <h1>
        {account.name}{" "}
        <span className={`badge ${account.stage === "CLIENT" ? "green" : "blue"}`}>
          {account.stage}
        </span>
      </h1>
      <p className="sub">
        {account.type} · {[account.city, account.state].filter(Boolean).join(", ") || "no location"}
        {account.convertedAt && ` · client since ${fmtDate(account.convertedAt.slice(0, 10))}`}
      </p>

      <div className="tabs">
        {(
          [
            ["overview", "Overview"],
            ["quotes", "Quotes"],
            ["policies", "Policies"],
            ["documents", "Documents"],
            ["certificates", "Certificates"],
          ] as [Tab, string][]
        ).map(([t, label]) => (
          <button
            key={t}
            className={tab === t ? "active" : ""}
            onClick={() => setTab(t)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "overview" && (
        <>
          <OverviewTab account={account} onChange={setAccount} />
          <PropertyPanel account={account} onChange={setAccount} />
          {account.stage === "LEAD" && <DeleteLeadZone account={account} />}
        </>
      )}
      {tab === "quotes" && (
        <div className="card">
          <QuotesPanel account={account} onAccountChange={setAccount} />
        </div>
      )}
      {tab === "policies" && <PoliciesTab accountId={account.id} />}
      {tab === "documents" && (
        <>
          <div className="card">
            <DocumentsPanel entityType="ACCOUNT" entityId={account.id} />
          </div>
          <ExtractionPanel account={account} onChange={setAccount} />
          <FormsTab account={account} />
        </>
      )}
      {tab === "certificates" && (
        <CertificatesTab account={account} profile={profile} />
      )}
    </>
  );
}

function OverviewTab({
  account,
  onChange,
}: {
  account: Account;
  onChange: (a: Account) => void;
}) {
  const [form, setForm] = useState({
    name: account.name,
    contactFirstName: account.contactFirstName ?? "",
    contactLastName: account.contactLastName ?? "",
    contactEmail: account.contactEmail ?? "",
    contactPhone: account.contactPhone ?? "",
    totalInsuredValue: account.totalInsuredValue?.toString() ?? "",
    currentAgent: account.currentAgent ?? "",
    currentPolicyExpiration: account.currentPolicyExpiration ?? "",
    source: account.source ?? "",
    notes: account.notes ?? "",
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => {
    setSaved(false);
    setForm((f) => ({ ...f, [k]: e.target.value }));
  };

  async function save() {
    const problems = validateAccountFields(form);
    if (problems.length) {
      setError(problems.join(" "));
      return;
    }
    setSaving(true);
    setError("");
    const { data, errors } = await client.models.Account.update({
      id: account.id,
      name: form.name.trim() || account.name,
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
    setSaving(false);
    if (errors?.length || !data) {
      setError(friendlyError(new Error(errors?.[0]?.message), "Save failed"));
      return;
    }
    onChange(data);
    setSaved(true);
  }

  return (
    <div className="card">
      <h2>Details</h2>
      <div className="form-grid">
        <div className="field">
          <label>Name</label>
          <input value={form.name} onChange={set("name")} />
        </div>
        <div className="field">
          <label>Contact first name</label>
          <input value={form.contactFirstName} onChange={set("contactFirstName")} />
        </div>
        <div className="field">
          <label>Contact last name</label>
          <input value={form.contactLastName} onChange={set("contactLastName")} />
        </div>
        <div className="field">
          <label>Contact email</label>
          <input value={form.contactEmail} onChange={set("contactEmail")} />
        </div>
        <div className="field">
          <label>Contact phone</label>
          <input value={form.contactPhone} onChange={set("contactPhone")} />
        </div>
        <div className="field">
          <label>Total insured value ($)</label>
          <input
            type="number"
            value={form.totalInsuredValue}
            onChange={set("totalInsuredValue")}
          />
        </div>
        <div className="field">
          <label>Current agent / broker</label>
          <input value={form.currentAgent} onChange={set("currentAgent")} />
        </div>
        <div className="field">
          <label>Current policy expiration</label>
          <input
            type="date"
            value={form.currentPolicyExpiration}
            onChange={set("currentPolicyExpiration")}
          />
        </div>
        <div className="field">
          <label>Source</label>
          <input value={form.source} onChange={set("source")} />
        </div>
        <div className="field full">
          <label>Notes</label>
          <textarea rows={4} value={form.notes} onChange={set("notes")} />
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

/**
 * Leads (and only leads — clients carry bound policies and stay for the
 * audit trail) can be deleted along with their quotes and documents.
 */
function DeleteLeadZone({ account }: { account: Account }) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const navigate = useNavigate();

  async function deleteLead() {
    setDeleting(true);
    setError("");
    try {
      const { data: quotes } = await client.models.Quote.list({
        filter: { accountId: { eq: account.id } },
      });
      await Promise.all(quotes.map((q) => client.models.Quote.delete({ id: q.id })));

      const { data: docs } = await client.models.Document.list({
        filter: { entityId: { eq: account.id } },
      });
      await Promise.all(
        docs.map(async (d) => {
          if (d.s3Key && d.s3Key !== "pending") {
            await remove({ path: d.s3Key }).catch(() => {});
          }
          await client.models.Document.delete({ id: d.id });
        })
      );

      const { errors } = await client.models.Account.delete({ id: account.id });
      if (errors?.length) throw new Error(errors[0].message);
      navigate("/leads");
    } catch (err) {
      setError(friendlyError(err, "Delete failed"));
      setDeleting(false);
    }
  }

  return (
    <div className="card" style={{ borderColor: "#eec8c4" }}>
      <h2 style={{ color: "var(--red)" }}>Danger zone</h2>
      {confirming ? (
        <>
          <p className="small">
            Permanently delete <strong>{account.name}</strong> and its quotes
            and documents? This can't be undone.
          </p>
          <div className="form-actions" style={{ marginTop: 8 }}>
            <button
              className="primary"
              style={{ background: "var(--red)" }}
              disabled={deleting}
              onClick={deleteLead}
            >
              {deleting ? "Deleting…" : "Yes, delete this lead"}
            </button>
            <button className="secondary" disabled={deleting} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <div className="form-actions" style={{ marginTop: 0 }}>
          <button className="secondary" onClick={() => setConfirming(true)}>
            Delete this lead…
          </button>
          <span className="muted small">
            Removes the lead, its quotes, and its documents.
          </span>
        </div>
      )}
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}

function PoliciesTab({ accountId }: { accountId: string }) {
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [carriers, setCarriers] = useState<Carrier[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState<Policy | null>(null);

  async function refresh() {
    const { data } = await client.models.Policy.list({
      filter: { accountId: { eq: accountId } },
    });
    setPolicies(
      data.sort((a, b) => (b.effectiveDate ?? "").localeCompare(a.effectiveDate ?? ""))
    );
    setLoaded(true);
  }

  useEffect(() => {
    refresh();
    client.models.Carrier.list().then(({ data }) =>
      setCarriers(data.sort((a, b) => a.name.localeCompare(b.name)))
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);

  async function updatePolicy(id: string, patch: Partial<Policy>) {
    const { data } = await client.models.Policy.update({ id, ...patch });
    if (data) setPolicies((ps) => ps.map((p) => (p.id === id ? data : p)));
  }

  const carrierName = (id: string | null | undefined) =>
    carriers.find((c) => c.id === id)?.name ?? "—";

  return (
    <div className="card">
      <h2>Policies</h2>

      {editing && (
        <CoverageForm
          key={editing.id}
          kind="policy"
          accountId={accountId}
          carriers={carriers}
          existing={editing}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
          onCancel={() => setEditing(null)}
        />
      )}

      {!loaded ? (
        <p className="muted small">Loading…</p>
      ) : policies.length === 0 ? (
        <p className="muted small">
          No policies. Policies are created by binding a quote.
        </p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Policy #</th>
                <th>Carrier</th>
                <th>Lines</th>
                <th>Premium</th>
                <th>Commission</th>
                <th>Terms</th>
                <th>Effective</th>
                <th>Expires</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {policies.map((p) => (
                <tr key={p.id}>
                  <td>{p.policyNumber || "—"}</td>
                  <td className="small">{carrierName(p.carrierId)}</td>
                  <td className="small">{(p.lines ?? []).filter(Boolean).join(", ") || "—"}</td>
                  <td>{fmtMoney(p.premium)}</td>
                  <td className="small">{commissionCell(p)}</td>
                  <td className="small">{termsSummary(p)}</td>
                  <td>{fmtDate(p.effectiveDate)}</td>
                  <td>{fmtDate(p.expirationDate)}</td>
                  <td>
                    <select
                      value={p.status}
                      onChange={(e) =>
                        updatePolicy(p.id, { status: e.target.value as Policy["status"] })
                      }
                    >
                      {["ACTIVE", "CANCELLED", "EXPIRED", "NON_RENEWED"].map((s) => (
                        <option key={s}>{s}</option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <button className="link" onClick={() => setEditing(p)}>
                      Edit
                    </button>
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

function CertificatesTab({
  account,
  profile,
}: {
  account: Account;
  profile: UserProfile;
}) {
  const [certs, setCerts] = useState<Certificate[]>([]);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [carriers, setCarriers] = useState<Carrier[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [holderName, setHolderName] = useState("");
  const [holderAddress, setHolderAddress] = useState("");
  const [description, setDescription] = useState("");
  const [selectedPolicies, setSelectedPolicies] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState<string | null>(null);
  const [genNote, setGenNote] = useState("");
  const [error, setError] = useState("");
  const [previewCert, setPreviewCert] = useState<Certificate | null>(null);

  useEffect(() => {
    client.models.Certificate.list({
      filter: { accountId: { eq: account.id } },
    }).then(({ data }) =>
      setCerts(data.sort((a, b) => (b.issuedAt ?? "").localeCompare(a.issuedAt ?? "")))
    );
    client.models.Policy.list({ filter: { accountId: { eq: account.id } } }).then(
      ({ data }) => setPolicies(data)
    );
    client.models.Carrier.list().then(({ data }) => setCarriers(data));
  }, [account.id]);

  async function issue() {
    if (!holderName.trim()) return;
    setSaving(true);
    setError("");

    // Reserve a unique, sequential certificate number (atomic server-side
    // counter) before recording the certificate.
    let certificateNumber: string | undefined;
    try {
      const { data: r, errors } = await client.mutations.reserveCertificateNumber();
      if (errors?.length) throw new Error(errors[0].message);
      const body = typeof r === "string" ? JSON.parse(r) : (r ?? {});
      certificateNumber = body?.certificateNumber;
      if (!certificateNumber) throw new Error("No number returned");
    } catch (err) {
      setSaving(false);
      setError(
        "Couldn't reserve a certificate number: " +
          (err instanceof Error ? err.message : "unknown error") +
          ". Nothing was saved — try again."
      );
      return;
    }

    const { data } = await client.models.Certificate.create({
      accountId: account.id,
      certificateNumber,
      policyIds: selectedPolicies,
      holderName: holderName.trim(),
      holderAddress: holderAddress.trim() || undefined,
      descriptionOfOperations: description.trim() || undefined,
      formType: "ACORD_25",
      issuedBy: `${profile.firstName} ${profile.lastName}`,
      issuedAt: new Date().toISOString(),
    });
    setSaving(false);
    if (data) {
      setCerts((cs) => [data, ...cs]);
      setShowForm(false);
      setHolderName("");
      setHolderAddress("");
      setDescription("");
      setSelectedPolicies([]);
      generatePdf(data); // fire the fill immediately; failures leave a retry button
    }
  }

  async function generatePdf(cert: Certificate) {
    setGenerating(cert.id);
    setGenNote("");
    setError("");
    try {
      const { bytes, missing } = await fillAcord25(account, cert, policies, carriers);
      const path = `certificates/${account.id}/${cert.id}.pdf`;
      await uploadData({
        path,
        data: new Blob([bytes as BlobPart], { type: "application/pdf" }),
        options: { contentType: "application/pdf" },
      }).result;
      const { data } = await client.models.Certificate.update({
        id: cert.id,
        s3Key: path,
      });
      if (data) setCerts((cs) => cs.map((c) => (c.id === cert.id ? data : c)));
      if (missing.length) {
        setGenNote(
          `Generated, but these fields had no match in the template: ${missing.join(", ")}. ` +
            "Use Settings → Inspect fields to extend the mapping."
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      setError(
        /Template fetch failed|NoSuchKey|403|404/.test(msg)
          ? "The ACORD 25 template hasn't been uploaded yet. Go to Settings → ACORD templates, upload the fillable PDF, then hit Generate again — this certificate record is saved and waiting."
          : `PDF generation failed: ${msg || "unknown error"}`
      );
    } finally {
      setGenerating(null);
    }
  }

  async function downloadPdf(cert: Certificate) {
    if (!cert.s3Key) return;
    const { url } = await getUrl({ path: cert.s3Key });
    window.open(url.toString(), "_blank");
  }

  return (
    <div className="card">
      <h2>Certificates of Insurance</h2>
      <p className="muted small">
        Issuing a certificate fills the ACORD 25 template (uploaded in
        Settings) from this account's policies and stores the PDF with the
        issuance record.
      </p>

      {account.stage !== "CLIENT" ? (
        <p className="muted small">COIs can be issued once this lead becomes a client.</p>
      ) : (
        <>
          <div className="toolbar">
            <div className="grow" />
            <button className="primary" onClick={() => setShowForm(!showForm)}>
              {showForm ? "Cancel" : "+ New certificate"}
            </button>
          </div>

          {showForm && (
            <div className="card" style={{ background: "#f8fafc" }}>
              <div className="form-grid">
                <div className="field">
                  <label>Certificate holder *</label>
                  <input value={holderName} onChange={(e) => setHolderName(e.target.value)} />
                </div>
                <div className="field">
                  <label>Holder address</label>
                  <input
                    value={holderAddress}
                    onChange={(e) => setHolderAddress(e.target.value)}
                  />
                </div>
                <div className="field full">
                  <label>Description of operations</label>
                  <textarea
                    rows={2}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                  />
                </div>
                <div className="field full">
                  <label>Policies on certificate</label>
                  {policies.length === 0 ? (
                    <span className="muted small">No policies on this account.</span>
                  ) : (
                    policies.map((p) => (
                      <label
                        key={p.id}
                        className="small"
                        style={{ display: "flex", gap: 6, alignItems: "center" }}
                      >
                        <input
                          type="checkbox"
                          checked={selectedPolicies.includes(p.id)}
                          onChange={(e) =>
                            setSelectedPolicies((ids) =>
                              e.target.checked
                                ? [...ids, p.id]
                                : ids.filter((i) => i !== p.id)
                            )
                          }
                        />
                        {p.policyNumber || "(no number)"} —{" "}
                        {(p.lines ?? []).filter(Boolean).join(", ")}
                      </label>
                    ))
                  )}
                </div>
              </div>
              <div className="form-actions">
                <button
                  className="primary"
                  disabled={saving || !holderName.trim()}
                  onClick={issue}
                >
                  {saving ? "Saving…" : "Record certificate"}
                </button>
              </div>
            </div>
          )}

          {genNote && <p className="small" style={{ color: "var(--amber)" }}>{genNote}</p>}
          {error && <p className="error-text">{error}</p>}

          {certs.length === 0 ? (
            <p className="muted small">No certificates issued.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Cert #</th>
                    <th>Holder</th>
                    <th>Form</th>
                    <th>Issued</th>
                    <th>By</th>
                    <th>PDF</th>
                  </tr>
                </thead>
                <tbody>
                  {certs.map((c) => (
                    <tr key={c.id}>
                      <td style={{ whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
                        {c.certificateNumber ?? "—"}
                      </td>
                      <td>{c.holderName}</td>
                      <td>
                        <span className="badge gray">{c.formType ?? "ACORD_25"}</span>
                      </td>
                      <td>{fmtDate(c.issuedAt?.slice(0, 10))}</td>
                      <td>{c.issuedBy ?? "—"}</td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        {c.s3Key ? (
                          <>
                            <button className="link" onClick={() => setPreviewCert(c)}>
                              Preview
                            </button>
                            <button className="link" onClick={() => downloadPdf(c)}>
                              Download
                            </button>
                            <button
                              className="link"
                              disabled={generating === c.id}
                              onClick={() => generatePdf(c)}
                            >
                              {generating === c.id ? "Regenerating…" : "Regenerate"}
                            </button>
                          </>
                        ) : (
                          <button
                            className="link"
                            disabled={generating === c.id}
                            onClick={() => generatePdf(c)}
                          >
                            {generating === c.id ? "Generating…" : "Generate PDF"}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {previewCert?.s3Key && (
        <FilePreviewModal
          s3Key={previewCert.s3Key}
          name={`ACORD 25 — ${previewCert.holderName}.pdf`}
          onClose={() => setPreviewCert(null)}
        />
      )}
    </div>
  );
}
