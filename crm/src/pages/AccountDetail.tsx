import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { uploadData, getUrl, remove } from "aws-amplify/storage";
import {
  client,
  fmtDate,
  fmtMoney,
  friendlyError,
  listAllPages,
  TEMPLATE_MISSING_MESSAGE,
  validateAccountFields,
  type Account,
  type Carrier,
  type Certificate,
  type Policy,
  type UserProfile,
} from "../lib/client";
import { fillAcord25, signatureFor } from "../lib/acord";
import { useIsAdmin } from "../lib/auth";
import { useAsyncResource } from "../lib/useAsyncResource";
import { useSort, SortTh } from "../lib/useSort";
import ConfirmButton from "../components/ConfirmButton";
import DocumentsPanel from "../components/DocumentsPanel";
import QuotesPanel, { commissionCell, termsSummary } from "../components/QuotesPanel";
import CoverageForm from "../components/CoverageForm";
import AccountMarketingTasks from "../components/MarketingTasks";
import FilePreviewModal from "../components/FilePreview";
import PropertyPanel from "../components/PropertyPanel";
import FormsTab from "../components/FormsTab";
import ExtractionPanel from "../components/ExtractionPanel";
import Celebration from "../components/Celebration";
import { SaveStatus, useSaveStatus } from "../components/SaveStatus";
import { useFormState } from "../lib/useFormState";

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
        <>
          <div className="card">
            <QuotesPanel account={account} onAccountChange={setAccount} />
          </div>
          <AccountMarketingTasks
            accountId={account.id}
            completedByName={`${profile.firstName} ${profile.lastName}`}
          />
        </>
      )}
      {tab === "policies" && <PoliciesTab accountId={account.id} />}
      {tab === "documents" && (
        <>
          <div className="card">
            <DocumentsPanel entityType="ACCOUNT" entityId={account.id} />
          </div>
          <ExtractionPanel account={account} onChange={setAccount} />
          <FormsTab account={account} profile={profile} />
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

/**
 * Leads (and only leads — clients carry bound policies and stay for the
 * audit trail) can be deleted along with their quotes and documents.
 *
 * Admin-only: this cascades through the quotes, the documents and their S3
 * objects, so it's gated here rather than at the call site — the zone can't
 * be rendered without the check coming with it.
 */
function DeleteLeadZone({ account }: { account: Account }) {
  const isAdmin = useIsAdmin();
  const [error, setError] = useState("");
  const navigate = useNavigate();

  // Throws rather than swallowing: <ConfirmButton> keeps the pair armed on a
  // rejection, so a failed cascade can be retried or backed out of, and the
  // message lands in `error` via onError.
  async function deleteLead() {
    setError("");
    const quotes = await listAllPages((nextToken) =>
      client.models.Quote.list({
        filter: { accountId: { eq: account.id } },
        nextToken,
      })
    );
    await Promise.all(quotes.map((q) => client.models.Quote.delete({ id: q.id })));

    const docs = await listAllPages((nextToken) =>
      client.models.Document.list({
        filter: { entityId: { eq: account.id } },
        nextToken,
      })
    );
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
  }

  if (!isAdmin) return null;

  return (
    <div className="card" style={{ borderColor: "#eec8c4" }}>
      <h2 style={{ color: "var(--red)" }}>Danger zone</h2>
      <div className="form-actions" style={{ marginTop: 0 }}>
        <ConfirmButton
          label="Delete this lead…"
          className="secondary"
          confirmLabel="Yes, delete this lead"
          cancelClassName="secondary"
          message={`Permanently delete ${account.name} and its quotes and documents? This can't be undone.`}
          onConfirm={deleteLead}
          onError={(err) => setError(friendlyError(err, "Delete failed"))}
        />
        <span className="muted small">
          Removes the lead, its quotes, and its documents.
        </span>
      </div>
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}

function PoliciesTab({ accountId }: { accountId: string }) {
  const [editing, setEditing] = useState<Policy | null>(null);
  // Persistent: the row this refers to stays on screen, so nothing about it
  // stops being true after a few seconds.
  const saveStatus = useSaveStatus();

  const policyRes = useAsyncResource(
    () =>
      listAllPages((nextToken) =>
        client.models.Policy.list({
          filter: { accountId: { eq: accountId } },
          nextToken,
        })
      ),
    [accountId],
    { initialData: [] as Policy[], errorMessage: "Failed to load policies" }
  );
  const policies = policyRes.data;
  const setPolicies = policyRes.setData;
  // Identity-stable, so CoverageForm's `onSaved` no longer closes over a
  // fresh function every render.
  const refresh = policyRes.refetch;

  // Agency-wide, not account-scoped — its own resource on its own deps, so a
  // policy refresh doesn't re-read the carrier table and an account switch
  // doesn't blank the carrier names while it does.
  const carrierRes = useAsyncResource(
    async () => (await client.models.Carrier.list()).data,
    [],
    { initialData: [] as Carrier[] }
  );
  const carrierRows = carrierRes.data;

  async function updatePolicy(id: string, patch: Partial<Policy>) {
    await saveStatus.run(
      async () => {
        // `errors` used to be dropped on the floor here: a rejected status
        // change left the <select> showing the value it had failed to save.
        const { data, errors } = await client.models.Policy.update({ id, ...patch });
        if (errors?.length || !data) throw new Error(errors?.[0]?.message);
        setPolicies((ps) => ps.map((p) => (p.id === id ? data : p)));
      },
      { savedMessage: "Policy updated.", errorMessage: "Couldn't update that policy." }
    );
  }

  // Carrier picker order only — no header to click, so the default stands.
  const { sorted: carriers } = useSort(carrierRows, { name: (c) => c.name }, "name");

  const carrierName = (id: string | null | undefined) =>
    carriers.find((c) => c.id === id)?.name ?? "—";

  // Most recently effective policy first, as the fetch used to order them.
  const { sorted, sortKey, dir, toggle } = useSort(
    policies,
    {
      number: (p) => p.policyNumber,
      carrier: (p) => (p.carrierId ? carrierName(p.carrierId) : null),
      lines: (p) => (p.lines ?? []).filter(Boolean).join(", "),
      premium: (p) => p.premium,
      commission: (p) => p.commissionPct,
      effective: (p) => p.effectiveDate,
      expires: (p) => p.expirationDate,
      status: (p) => p.status,
    },
    "effective",
    "desc"
  );

  return (
    <div className="card">
      <h2>Policies</h2>
      {/* Status changes are made from the per-row <select>, so the panel-level
          line is where their outcome lands. */}
      <SaveStatus {...saveStatus.status} />

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

      {/* Surfaced rather than ignored: without carriers every row's carrier
          column reads "—", indistinguishable from a policy with none set. */}
      {carrierRes.error && <p className="error-text">{carrierRes.error}</p>}

      {!policyRes.loaded ? (
        <p className="muted small">Loading…</p>
      ) : policyRes.error ? (
        <p className="error-text">{policyRes.error}</p>
      ) : policies.length === 0 ? (
        <p className="muted small">
          No policies. Policies are created by binding a quote.
        </p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <SortTh label="Policy #" colKey="number" sortKey={sortKey} dir={dir} onToggle={toggle} />
                <SortTh label="Carrier" colKey="carrier" sortKey={sortKey} dir={dir} onToggle={toggle} />
                <SortTh label="Lines" colKey="lines" sortKey={sortKey} dir={dir} onToggle={toggle} />
                <SortTh label="Premium" colKey="premium" sortKey={sortKey} dir={dir} onToggle={toggle} />
                <SortTh label="Commission" colKey="commission" sortKey={sortKey} dir={dir} onToggle={toggle} />
                <th>Terms</th>
                <SortTh label="Effective" colKey="effective" sortKey={sortKey} dir={dir} onToggle={toggle} />
                <SortTh label="Expires" colKey="expires" sortKey={sortKey} dir={dir} onToggle={toggle} />
                <SortTh label="Status" colKey="status" sortKey={sortKey} dir={dir} onToggle={toggle} />
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((p) => (
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

  useEffect(() => {
    listAllPages((nextToken) =>
      client.models.Certificate.list({
        filter: { accountId: { eq: account.id } },
        nextToken,
      })
    ).then((data) => setCerts(data));
    listAllPages((nextToken) =>
      client.models.Policy.list({
        filter: { accountId: { eq: account.id } },
        nextToken,
      })
    ).then((data) => setPolicies(data));
    client.models.Carrier.list().then(({ data }) => setCarriers(data));
  }, [account.id]);

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
          {error && <p className="error-text">{error}</p>}

          {certs.length === 0 ? (
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
