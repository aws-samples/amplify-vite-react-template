import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { list, uploadData } from "aws-amplify/storage";
import { ACORD_FORMS, listTemplateFields, type AcordFormDef } from "../lib/acord";
import FileButton from "../components/FileButton";
import Team from "./Team";
import Licensing from "../components/Licensing";
import SignatureManager from "../components/SignatureManager";
import { friendlyError, type UserProfile } from "../lib/client";
import { Badge, flagBadge } from "../lib/badges";
import { useIsAdmin } from "../lib/auth";

type TemplateDef = AcordFormDef;
type Tab = "templates" | "licensing" | "signature" | "team";

/** New ACORD forms: add to ACORD_FORMS + a mapping in lib/acord.ts. */
const TEMPLATES: TemplateDef[] = ACORD_FORMS;

export default function Settings({ profile }: { profile: UserProfile }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const isAdmin = useIsAdmin();

  const TABS: [Tab, string][] = [
    ["templates", "Form templates"],
    ["licensing", "Licensing"],
    // Everyone manages their own signature; the Team tab manages others'.
    ["signature", "My signature"],
    ...(isAdmin ? ([["team", "Team"]] as [Tab, string][]) : []),
  ];

  const requested = searchParams.get("tab") as Tab | null;
  const [tab, setTab] = useState<Tab>(
    requested && TABS.some(([t]) => t === requested) ? requested : "templates"
  );

  function selectTab(t: Tab) {
    setTab(t);
    // Keep the tab in the URL so Settings views are linkable.
    const next = new URLSearchParams(searchParams);
    next.set("tab", t);
    setSearchParams(next, { replace: true });
  }

  return (
    <>
      <h1>Settings</h1>
      <p className="sub">Form templates, licensing, and team</p>

      <div className="tabs">
        {TABS.map(([t, label]) => (
          <button
            key={t}
            className={tab === t ? "active" : ""}
            onClick={() => selectTab(t)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "templates" && <TemplatesPanel />}
      {tab === "licensing" && <Licensing />}
      {tab === "signature" && <MySignature profile={profile} />}
      {tab === "team" && isAdmin && <Team profile={profile} />}
    </>
  );
}

function TemplatesPanel() {
  const [uploaded, setUploaded] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string[]>>({});
  const [error, setError] = useState("");

  useEffect(() => {
    list({ path: "templates/" }).then(({ items }) => {
      const present: Record<string, boolean> = {};
      for (const item of items) present[item.path] = true;
      setUploaded(present);
    });
  }, []);

  async function upload(tpl: TemplateDef, file: File | undefined) {
    if (!file) return;
    setBusy(tpl.path);
    setError("");
    try {
      await uploadData({
        path: tpl.path,
        data: file,
        options: { contentType: "application/pdf" },
      }).result;
      setUploaded((u) => ({ ...u, [tpl.path]: true }));
      setFields((f) => ({ ...f, [tpl.path]: [] }));
    } catch (err) {
      setError(friendlyError(err, "Upload failed"));
    } finally {
      setBusy(null);
    }
  }

  async function inspect(tpl: TemplateDef) {
    setBusy(tpl.path);
    setError("");
    try {
      const names = await listTemplateFields(tpl.path);
      setFields((f) => ({ ...f, [tpl.path]: names }));
    } catch (err) {
      setError(friendlyError(err, "Could not read template"));
    } finally {
      setBusy(null);
    }
  }

  const missing = TEMPLATES.filter((t) => !uploaded[t.path]).length;

  return (
    <div className="card">
      <h2>ACORD templates</h2>
      <p className="muted small" style={{ marginTop: 0 }}>
        ACORD forms are licensed, so the fillable PDFs are uploaded here rather
        than shipped with the app. If a generated form comes out with blank
        boxes, use <em>Inspect fields</em> and send the list over — the field
        mapping needs updating.
      </p>

      {missing > 0 && (
        <p className="small" style={{ color: "var(--amber)" }}>
          {missing} template{missing === 1 ? "" : "s"} not uploaded yet —
          generating {missing === 1 ? "that form" : "those forms"} will fail
          until {missing === 1 ? "it's" : "they're"} added.
        </p>
      )}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Form</th>
              <th>Status</th>
              <th>Template file</th>
            </tr>
          </thead>
          <tbody>
            {TEMPLATES.map((tpl) => (
              <TemplateRow
                key={tpl.path}
                tpl={tpl}
                isUploaded={!!uploaded[tpl.path]}
                busy={busy === tpl.path}
                fieldNames={fields[tpl.path]}
                onUpload={(f) => upload(tpl, f)}
                onInspect={() => inspect(tpl)}
                onCloseFields={() =>
                  setFields((f) => ({ ...f, [tpl.path]: [] }))
                }
              />
            ))}
          </tbody>
        </table>
      </div>

      {error && <p className="error-text">{error}</p>}
    </div>
  );
}

function TemplateRow({
  tpl,
  isUploaded,
  busy,
  fieldNames,
  onUpload,
  onInspect,
  onCloseFields,
}: {
  tpl: TemplateDef;
  isUploaded: boolean;
  busy: boolean;
  fieldNames: string[] | undefined;
  onUpload: (file: File | undefined) => void;
  onInspect: () => void;
  onCloseFields: () => void;
}) {
  // "ACORD 25 — Certificate of Liability Insurance" → number + title, so the
  // form number can lead the column instead of being buried in a sentence.
  const [num, ...rest] = tpl.label.split(" — ");
  const title = rest.join(" — ");

  return (
    <>
      <tr>
        <td>
          <strong>{num}</strong>
          <div className="muted small">{title}</div>
          <div className="muted small">{tpl.note}</div>
        </td>
        <td>
          {/* One-off pair: this is the only place a template's presence is
              badged, so the wording stays at the call site. */}
          <Badge
            {...flagBadge(isUploaded, {
              on: { cls: "green", label: "Uploaded" },
              off: { cls: "amber", label: "Missing" },
            })}
          />
        </td>
        <td style={{ whiteSpace: "nowrap" }}>
          <div className="toolbar" style={{ margin: 0 }}>
            <FileButton
              label={isUploaded ? "Replace PDF…" : "Upload PDF…"}
              accept="application/pdf"
              busy={busy}
              onFiles={(files) => onUpload(files?.[0])}
            />
            {isUploaded && (
              <button className="secondary" disabled={busy} onClick={onInspect}>
                {busy ? "Reading…" : "Inspect fields"}
              </button>
            )}
          </div>
        </td>
      </tr>
      {fieldNames?.length ? (
        <tr>
          <td colSpan={3} style={{ background: "#f8fafc" }}>
            <div className="toolbar" style={{ marginTop: 0 }}>
              <strong className="small">
                {fieldNames.length} form fields in {num}
              </strong>
              <div className="grow" />
              <button className="link" onClick={onCloseFields}>
                Hide
              </button>
            </div>
            <div className="ocr-text" style={{ maxHeight: 240 }}>
              {fieldNames.join("\n")}
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

/**
 * Self-service signature. Everyone can set their own without an admin —
 * the Team tab exists to manage other people's.
 */
function MySignature({ profile }: { profile: UserProfile }) {
  const [me, setMe] = useState(profile);
  return (
    <div className="card">
      <h2>My signature</h2>
      <p className="muted small" style={{ marginTop: 0 }}>
        Stamped onto every ACORD form you generate — certificates and carrier
        submissions. Draw it here, or upload an image if you already have one.
      </p>
      <SignatureManager profile={me} onChange={setMe} />
    </div>
  );
}
