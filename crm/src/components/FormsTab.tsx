import { useEffect, useState } from "react";
import { uploadData } from "aws-amplify/storage";
import {
  client,
  friendlyError,
  listAllPages,
  TEMPLATE_MISSING_MESSAGE,
  type Account,
  type CrmDocument,
} from "../lib/client";
import {
  ACORD_FORMS,
  MAPPED_APP_FORM_KEYS,
  fillAcordApp,
  signatureFor,
  type AcordFormDef,
} from "../lib/acord";
import type { UserProfile } from "../lib/client";
import { useSort, SortTh } from "../lib/useSort";
import FilePreviewModal from "./FilePreview";
import { SaveStatus, useSaveStatus } from "./SaveStatus";

const APP_FORMS = ACORD_FORMS.filter((f) => f.key !== "acord25");

/**
 * Carrier-submission forms: fill an uploaded ACORD template (125/126/140/…)
 * from this account's data, store the PDF under generated/, and track it as
 * an ACORD_FORM document.
 */
export default function FormsTab({
  account,
  profile,
}: {
  account: Account;
  profile: UserProfile;
}) {
  const [generated, setGenerated] = useState<CrmDocument[]>([]);
  // Which row's button reads "Generating…" — per-row, so it stays. The
  // outcome is panel-level and belongs to the status machine.
  const [busyKey, setBusyKey] = useState<string | null>(null);
  // Was an amber `note` for every outcome plus a separate red `error`; the
  // note is now `run`'s warning arm and a clean generation is green.
  const genStatus = useSaveStatus();
  const [preview, setPreview] = useState<CrmDocument | null>(null);

  useEffect(() => {
    listAllPages((nextToken) =>
      client.models.Document.list({
        filter: {
          entityId: { eq: account.id },
          category: { eq: "ACORD_FORM" },
        },
        nextToken,
      })
    ).then((data) => setGenerated(data));
  }, [account.id]);

  // Most recently generated first, as the fetch used to order them.
  const { sorted, sortKey, dir, toggle } = useSort(
    generated,
    {
      file: (d) => d.name,
      generated: (d) => d.createdAt,
    },
    "generated",
    "desc"
  );

  async function generate(form: AcordFormDef) {
    setBusyKey(form.key);
    await genStatus.run(
      async () => {
        try {
          const buildings = await listAllPages((nextToken) =>
            client.models.Building.list({
              filter: { accountId: { eq: account.id } },
              nextToken,
            })
          );
          // Clients renew off their bound policies; the lead-only
          // currentPolicyExpiration field isn't used once an account converts.
          let renewalDate: string | null = null;
          let lines: string[] = [];
          if (account.stage === "CLIENT") {
            const pols = await listAllPages((nextToken) =>
              client.models.Policy.list({
                filter: { accountId: { eq: account.id } },
                nextToken,
              })
            );
            const active = pols.filter((p) => p.status === "ACTIVE");
            const ends = active
              .filter((p) => p.expirationDate)
              .map((p) => p.expirationDate as string)
              .sort();
            renewalDate = ends[0] ?? null;
            // What we're applying for = what's on the book today.
            lines = [
              ...new Set(active.flatMap((p) => (p.lines ?? []).filter(Boolean))),
            ] as string[];
          } else {
            renewalDate = account.currentPolicyExpiration ?? null;
            // A prospect has no policy yet — fall back to whatever's been quoted.
            const qs = await listAllPages((nextToken) =>
              client.models.Quote.list({
                filter: { accountId: { eq: account.id } },
                nextToken,
              })
            );
            lines = [
              ...new Set(qs.flatMap((q) => (q.lines ?? []).filter(Boolean))),
            ] as string[];
          }

          const { bytes, missing, unsigned } = await fillAcordApp(
            form,
            account,
            buildings,
            await signatureFor(profile.id),
            renewalDate,
            lines
          );

          const stamp = new Date().toISOString().slice(0, 10);
          const filename = `${form.key}-${account.name.replace(/[^\w-]+/g, "_")}-${stamp}.pdf`;
          const path = `generated/${account.id}/${Date.now()}-${filename}`;
          await uploadData({
            path,
            data: new Blob([bytes as BlobPart], { type: "application/pdf" }),
            options: { contentType: "application/pdf" },
          }).result;

          const { data: doc, errors } = await client.models.Document.create({
            entityType: "ACCOUNT",
            entityId: account.id,
            category: "ACORD_FORM",
            name: filename,
            s3Key: path,
            contentType: "application/pdf",
            sizeBytes: bytes.byteLength,
            ocrStatus: "SKIPPED",
          });
          // The PDF is in S3 either way, but without the Document row it
          // never appears in "Generated forms" — previously that failure was
          // silent and the panel still said "Generated".
          if (errors?.length || !doc) {
            throw new Error(
              errors?.[0]?.message ??
                "The PDF was created but couldn't be recorded — it won't appear in the list below."
            );
          }
          setGenerated((ds) => [doc, ...ds]);

          // Same sentences as before, composed the same way. What changed is
          // severity: unmatched fields or an unsigned form are things the
          // user has to act on, so they are `run`'s warning arm; a run with
          // neither is a clean success and takes `savedMessage` instead of
          // the same amber span every outcome used to share.
          const note = [
            missing.length
              ? `Generated. Unmatched fields (extend the mapping via Settings → Inspect fields): ${missing.join(", ")}`
              : "Generated — every mapped field matched.",
            unsigned &&
              `The form went out UNSIGNED — ${unsigned}. Sign it by hand before submitting.`,
          ]
            .filter(Boolean)
            .join(" ");
          return missing.length || unsigned ? note : "";
        } catch (err) {
          const msg = friendlyError(err, "unknown error");
          // A classified template failure already explains itself and says
          // where to go; anything else keeps the prefix naming what was being
          // done. `run` re-runs friendlyError over this, which is a no-op for
          // both shapes — neither matches a classifier once prefixed.
          throw new Error(
            msg === TEMPLATE_MISSING_MESSAGE ? msg : `Generation failed: ${msg}`
          );
        }
      },
      { savedMessage: "Generated — every mapped field matched." }
    );
    setBusyKey(null);
  }

  return (
    <>
      <div className="card">
        <h2>Generate carrier-submission forms</h2>
        <p className="muted small">
          Fills the uploaded ACORD template with this account's details
          (contacts, address, construction, buildings). The PDF stays editable
          for anything the CRM doesn't track yet.
        </p>
        <div className="table-wrap">
          <table>
            <tbody>
              {APP_FORMS.map((f) => {
                const mapped = MAPPED_APP_FORM_KEYS.has(f.key);
                return (
                  <tr key={f.key}>
                    <td>
                      <strong>{f.label}</strong>
                    </td>
                    <td style={{ width: 160 }}>
                      <button
                        className="secondary"
                        disabled={!mapped || busyKey !== null}
                        title={
                          mapped
                            ? undefined
                            : "This form has no field mapping yet — it would come out with only the producer and insured header filled in."
                        }
                        onClick={() => generate(f)}
                      >
                        {busyKey === f.key ? "Generating…" : "Generate"}
                      </button>
                      {!mapped && (
                        <div className="muted small">Mapping not built yet</div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {genStatus.status.state !== "idle" && (
          <p style={{ margin: "10px 0 0" }}>
            <SaveStatus {...genStatus.status} />
          </p>
        )}
      </div>

      <div className="card">
        <h2>Generated forms</h2>
        {generated.length === 0 ? (
          <p className="muted small">Nothing generated yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <SortTh label="File" colKey="file" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="Generated" colKey="generated" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((d) => (
                  <tr key={d.id}>
                    <td>{d.name}</td>
                    <td className="small">
                      {d.createdAt ? new Date(d.createdAt).toLocaleString("en-US") : "—"}
                    </td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      <button className="link" onClick={() => setPreview(d)}>
                        Preview
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {preview && (
        <FilePreviewModal
          s3Key={preview.s3Key}
          name={preview.name}
          onClose={() => setPreview(null)}
        />
      )}
    </>
  );
}
