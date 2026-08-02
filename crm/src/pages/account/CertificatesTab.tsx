import { useState } from "react";
import { uploadData, getUrl } from "aws-amplify/storage";
import {
  client,
  fmtDate,
  friendlyError,
  listAllPages,
  TEMPLATE_MISSING_MESSAGE,
  type Account,
  type Carrier,
  type Certificate,
  type Policy,
  type UserProfile,
} from "../../lib/client";
import { fillAcord25, signatureFor } from "../../lib/acord";
import { useSort, SortTh } from "../../lib/useSort";
import { useAsyncResource } from "../../lib/useAsyncResource";
import FilePreviewModal from "../../components/FilePreview";
import { SaveStatus, useSaveStatus } from "../../components/SaveStatus";
import { useFormState } from "../../lib/useFormState";

export function CertificatesTab({
  account,
  profile,
}: {
  account: Account;
  profile: UserProfile;
}) {
  const certRes = useAsyncResource(
    () =>
      listAllPages((nextToken) =>
        client.models.Certificate.list({
          filter: { accountId: { eq: account.id } },
          nextToken,
        })
      ),
    [account.id],
    { initialData: [] as Certificate[], errorMessage: "Failed to load certificates" }
  );
  const certs = certRes.data;
  const setCerts = certRes.setData;

  const policyRes = useAsyncResource(
    () =>
      listAllPages((nextToken) =>
        client.models.Policy.list({
          filter: { accountId: { eq: account.id } },
          nextToken,
        })
      ),
    [account.id],
    { initialData: [] as Policy[], errorMessage: "Failed to load policies" }
  );
  const policies = policyRes.data;

  /**
   * Surfaced rather than ignored, and this one is not cosmetic: `carriers` is
   * handed to `fillAcord25`, so a failed read produces a certificate PDF with
   * the insurer block silently blank.
   */
  const carrierRes = useAsyncResource(
    async () => (await client.models.Carrier.list()).data,
    [],
    { initialData: [] as Carrier[], errorMessage: "Failed to load carriers" }
  );
  const carriers = carrierRes.data;

  const [showForm, setShowForm] = useState(false);
  const { form, setF, reset } = useFormState({
    holderName: "",
    holderAddress: "",
    description: "",
    selectedPolicies: [] as string[],
  });
  const [saving, setSaving] = useState(false);
  // Which certificate is being filled — the button label is per row, so this
  // stays alongside the panel-level status below.
  const [generating, setGenerating] = useState<string | null>(null);
  // The amber "generated UNSIGNED" note and the red failure were two separate
  // pieces of state that could both be on screen at once, describing the same
  // run. One state machine now, with the note as `run`'s warning return.
  const genStatus = useSaveStatus();
  const [error, setError] = useState("");
  const [previewCert, setPreviewCert] = useState<Certificate | null>(null);

  async function issue() {
    if (!form.holderName.trim()) return;
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
          friendlyError(err, "unknown error") +
          ". Nothing was saved — try again."
      );
      return;
    }

    const { data } = await client.models.Certificate.create({
      accountId: account.id,
      certificateNumber,
      policyIds: form.selectedPolicies,
      holderName: form.holderName.trim(),
      holderAddress: form.holderAddress.trim() || undefined,
      descriptionOfOperations: form.description.trim() || undefined,
      formType: "ACORD_25",
      issuedBy: `${profile.firstName} ${profile.lastName}`,
      issuedAt: new Date().toISOString(),
    });
    setSaving(false);
    if (data) {
      setCerts((cs) => [data, ...cs]);
      setShowForm(false);
      // Baseline is still the blanks this mounted with — markSaved is never
      // called here — so `reset()` is the four setters it replaces.
      reset();
      generatePdf(data); // fire the fill immediately; failures leave a retry button
    }
  }

  async function generatePdf(cert: Certificate) {
    setGenerating(cert.id);
    setError("");
    await genStatus.run(async () => {
      try {
        const { bytes, missing, unsigned } = await fillAcord25(
          account,
          cert,
          policies,
          carriers,
          await signatureFor(profile.id)
        );
        const path = `certificates/${account.id}/${cert.id}.pdf`;
        await uploadData({
          path,
          data: new Blob([bytes as BlobPart], { type: "application/pdf" }),
          options: { contentType: "application/pdf" },
        }).result;
        const { data, errors } = await client.models.Certificate.update({
          id: cert.id,
          s3Key: path,
        });
        // The PDF is in S3 either way, but without the s3Key on the record
        // the Preview/Download buttons never appear — previously that failure
        // was silent and the row just kept saying "Generate PDF".
        if (errors?.length || !data) {
          throw new Error(
            errors?.[0]?.message ??
              "The PDF was created but couldn't be attached to the certificate — try Regenerate."
          );
        }
        setCerts((cs) => cs.map((c) => (c.id === cert.id ? data : c)));
        const notes: string[] = [];
        if (missing.length) {
          notes.push(
            `Generated, but these fields had no match in the template: ${missing.join(", ")}. ` +
              "Use Settings → Inspect fields to extend the mapping."
          );
        }
        if (unsigned) {
          notes.push(
            `The certificate went out UNSIGNED — ${unsigned}. Sign it by hand before sending it to the holder.`
          );
        }
        // A note means the PDF exists but the user has to act on it: that is
        // `run`'s warning arm, not a second success flag.
        return notes.join(" ");
      } catch (err) {
        const msg = friendlyError(err, "unknown error");
        // A classified template failure already explains itself and says where
        // to go; anything else keeps the prefix naming what was being done.
        // `run` re-runs friendlyError over this, which is a no-op for both
        // shapes — neither matches a classifier once it has been prefixed.
        throw new Error(
          msg === TEMPLATE_MISSING_MESSAGE ? msg : `PDF generation failed: ${msg}`
        );
      }
    }, { savedMessage: "Certificate PDF generated." });
    setGenerating(null);
  }

  async function downloadPdf(cert: Certificate) {
    if (!cert.s3Key) return;
    const { url } = await getUrl({ path: cert.s3Key });
    window.open(url.toString(), "_blank");
  }

  // Most recently issued first, as the fetch used to order them.
  const { sorted, sortKey, dir, toggle } = useSort(
    certs,
    {
      number: (c) => c.certificateNumber,
      holder: (c) => c.holderName,
      form: (c) => c.formType ?? "ACORD_25",
      issued: (c) => c.issuedAt,
      by: (c) => c.issuedBy,
    },
    "issued",
    "desc"
  );

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
                  <input value={form.holderName} onChange={(e) => setF("holderName", e.target.value)} />
                </div>
                <div className="field">
                  <label>Holder address</label>
                  <input
                    value={form.holderAddress}
                    onChange={(e) => setF("holderAddress", e.target.value)}
                  />
                </div>
                <div className="field full">
                  <label>Description of operations</label>
                  <textarea
                    rows={2}
                    value={form.description}
                    onChange={(e) => setF("description", e.target.value)}
                  />
                </div>
                <div className="field full">
                  <label>Policies on certificate</label>
                  {!policyRes.loaded ? (
                    <span className="muted small">Loading…</span>
                  ) : policies.length === 0 ? (
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
                          checked={form.selectedPolicies.includes(p.id)}
                          onChange={(e) =>
                            setF("selectedPolicies", (ids) =>
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
                  disabled={saving || !form.holderName.trim()}
                  onClick={issue}
                >
                  {saving ? "Saving…" : "Record certificate"}
                </button>
              </div>
            </div>
          )}

          {genStatus.status.state !== "idle" && (
            <p style={{ margin: "10px 0" }}>
              <SaveStatus {...genStatus.status} />
            </p>
          )}
          {/* `error` is the issue/generate failure; the reads have their own. */}
          {error && <p className="error-text">{error}</p>}
          {carrierRes.error && <p className="error-text">{carrierRes.error}</p>}
          {policyRes.error && <p className="error-text">{policyRes.error}</p>}

          {!certRes.loaded ? (
            <p className="muted small">Loading…</p>
          ) : certRes.error ? (
            <p className="error-text">{certRes.error}</p>
          ) : certs.length === 0 ? (
            <p className="muted small">No certificates issued.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <SortTh label="Cert #" colKey="number" sortKey={sortKey} dir={dir} onToggle={toggle} />
                    <SortTh label="Holder" colKey="holder" sortKey={sortKey} dir={dir} onToggle={toggle} />
                    <SortTh label="Form" colKey="form" sortKey={sortKey} dir={dir} onToggle={toggle} />
                    <SortTh label="Issued" colKey="issued" sortKey={sortKey} dir={dir} onToggle={toggle} />
                    <SortTh label="By" colKey="by" sortKey={sortKey} dir={dir} onToggle={toggle} />
                    <th>PDF</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((c) => (
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
