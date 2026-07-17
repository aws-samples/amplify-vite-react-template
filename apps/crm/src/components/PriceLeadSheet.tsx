import { useEffect, useRef, useState } from "react";
import {
  api,
  jsonField,
  opResult,
  type Customer,
  type LeadPricingRun,
} from "../lib/api";
import { money } from "../lib/format";
import { Badge, Button, ErrorNote, Field } from "../ui/kit";

type PriceLine = { label: string; cents: number };
type Extracted = {
  pest?: string;
  customerName?: string | null;
  town?: string | null;
  state?: string | null;
  assumptions?: string[];
};

/**
 * AI lead pricing: paste the Thumbtack lead (or attach a screenshot), enter
 * the lead fee, and get QUOTE / PASS / ESCALATE with the exact rate-card
 * breakdown and a paste-ready reply. The reply is the whole next step — it
 * answers "what will it cost" and points the lead at the online booking
 * funnel, where they pick a day and pay by card to convert themselves.
 */
export default function PriceLeadSheet({
  customer,
}: {
  customer?: Customer | null;
}) {
  const [inputText, setInputText] = useState("");
  const [leadFee, setLeadFee] = useState("");
  const [noFee, setNoFee] = useState(false);
  const [screenshotKey, setScreenshotKey] = useState<string | null>(null);
  const [screenshotName, setScreenshotName] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "upload" | "price">(null);
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState<LeadPricingRun | null>(null);
  const [copied, setCopied] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const attach = async (file: File) => {
    if (busy) return;
    setBusy("upload");
    setError(null);
    try {
      const res = await api().mutations.getPricingUploadUrl({
        contentType: file.type || "image/png",
      });
      const target = opResult<{ key: string; uploadUrl: string }>(res);
      if (!target?.uploadUrl) throw new Error("Could not get an upload URL");
      const put = await fetch(target.uploadUrl, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": file.type || "image/png" },
      });
      if (!put.ok) throw new Error(`Upload failed (${put.status})`);
      setScreenshotKey(target.key);
      setScreenshotName(file.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Screenshot upload failed");
    } finally {
      setBusy((b) => (b === "upload" ? null : b));
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  /** Shared entry for drop/paste: only image files become the screenshot. */
  const attachIfImage = (file: File | null | undefined) => {
    if (!file) return false;
    if (!file.type.startsWith("image/")) {
      setError("That file isn't an image — attach a screenshot (PNG/JPEG)");
      return false;
    }
    void attach(file);
    return true;
  };

  const onDrop = (e: React.DragEvent) => {
    setDragOver(false);
    if (!e.dataTransfer.files?.length) return; // text drag — let the browser handle it
    e.preventDefault();
    attachIfImage(e.dataTransfer.files[0]);
  };

  // Paste works sheet-wide, not only when a field has focus. The ref keeps
  // the document listener on the latest closure (fresh busy/error state).
  const attachIfImageRef = useRef(attachIfImage);
  attachIfImageRef.current = attachIfImage;
  useEffect(() => {
    const onDocPaste = (e: ClipboardEvent) => {
      const item = Array.from(e.clipboardData?.items ?? []).find((it) =>
        it.type.startsWith("image/")
      );
      if (item && attachIfImageRef.current(item.getAsFile())) e.preventDefault();
    };
    // A drop that misses the sheet must not navigate the tab away from the
    // half-typed lead — swallow stray file drops while the sheet is open.
    const guard = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    };
    document.addEventListener("paste", onDocPaste);
    window.addEventListener("dragover", guard);
    window.addEventListener("drop", guard);
    return () => {
      document.removeEventListener("paste", onDocPaste);
      window.removeEventListener("dragover", guard);
      window.removeEventListener("drop", guard);
    };
  }, []);

  const price = async () => {
    if (busy) return;
    if (!inputText.trim() && !screenshotKey) {
      setError("Paste the lead text or attach a screenshot");
      return;
    }
    const feeCents = noFee
      ? 0
      : leadFee.trim()
        ? Math.round(parseFloat(leadFee) * 100)
        : null;
    if (feeCents !== null && (!Number.isFinite(feeCents) || feeCents < 0)) {
      setError("Lead fee doesn't look valid");
      return;
    }
    setBusy("price");
    setError(null);
    setRun(null);
    try {
      const res = await api().mutations.priceLead({
        inputText: inputText.trim() || undefined,
        screenshotKey: screenshotKey ?? undefined,
        customerId: customer?.id,
        leadFeeCents: feeCents ?? undefined,
      });
      const result = opResult<LeadPricingRun>(res);
      if (!result) throw new Error("Pricing engine returned nothing");
      setRun(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Pricing failed");
    } finally {
      setBusy(null);
    }
  };

  const copyReply = async () => {
    if (!run?.replyText) return;
    try {
      await navigator.clipboard.writeText(run.replyText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Couldn't copy — select the text manually");
    }
  };

  const breakdown = jsonField<PriceLine[]>(run?.priceBreakdown) ?? [];
  const extracted = jsonField<Extracted>(run?.extracted);
  const decisionTone =
    run?.decision === "QUOTE"
      ? "ok"
      : run?.decision === "ESCALATE"
        ? "warn"
        : run?.decision === "PASS"
          ? "muted"
          : "danger";

  return (
    <div
      className="form-grid"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false);
      }}
      onDrop={onDrop}
    >
      <Field label="Lead details" hint="Paste the Thumbtack lead — message, address, sqft, lead fee, everything">
        <textarea
          rows={6}
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          placeholder={"e.g. 'Sarah M — ants in kitchen, 1,800 sqft single family, 12 Oak St, Framingham MA. Lead fee $42.'"}
        />
      </Field>

      <div className={dragOver ? "dropzone drag" : "dropzone"}>
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => e.target.files?.[0] && void attach(e.target.files[0])}
        />
        <Button
          small
          variant="ghost"
          loading={busy === "upload"}
          onClick={() => fileInput.current?.click()}
        >
          {screenshotKey ? `📎 ${screenshotName ?? "screenshot"}` : "📎 Attach screenshot"}
        </Button>
        <span className="muted small">
          {dragOver
            ? "Drop it here"
            : screenshotKey
              ? "Attached — drop or paste to replace"
              : "or drag & drop / paste a screenshot"}
        </span>
        {screenshotKey ? (
          <Button small variant="ghost" onClick={() => { setScreenshotKey(null); setScreenshotName(null); }}>
            Remove
          </Button>
        ) : null}
      </div>

      <div className="form-row-2">
        <Field label="Thumbtack lead fee ($)" hint="Required to quote">
          <input
            inputMode="decimal"
            value={leadFee}
            disabled={noFee}
            onChange={(e) => setLeadFee(e.target.value)}
            placeholder="42"
          />
        </Field>
        <Field label="Direct lead?" hint="No Thumbtack fee">
          <label className="chip" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <input
              type="checkbox"
              checked={noFee}
              onChange={(e) => setNoFee(e.target.checked)}
              style={{ width: "auto", minHeight: 0 }}
            />
            No lead fee
          </label>
        </Field>
      </div>

      <ErrorNote error={error} />
      <Button block loading={busy === "price"} onClick={() => void price()}>
        {busy === "price" ? "Pricing…" : "Price this lead"}
      </Button>

      {run ? (
        <div className="card" style={{ padding: 14 }}>
          <div className="row-split" style={{ marginBottom: 8 }}>
            <strong>{run.service ?? extracted?.pest ?? "Lead"}</strong>
            <Badge tone={decisionTone}>{run.decision?.replace("_", " ").toLowerCase()}</Badge>
          </div>

          <dl className="kv">
            {run.zone ? (
              <>
                <dt>Zone</dt>
                <dd>
                  {run.zone}
                  {run.driveMinutes != null ? ` — ${run.driveMinutes} min from Ware` : ""}
                </dd>
              </>
            ) : null}
            {run.leadFeeCents != null ? (
              <>
                <dt>Lead fee</dt>
                <dd>{run.leadFeeCents === 0 ? "none (direct)" : money(run.leadFeeCents)}</dd>
              </>
            ) : null}
            {run.monthlyPriceCents != null ? (
              <>
                <dt>Plan</dt>
                <dd>
                  <strong>{money(run.monthlyPriceCents)}/mo</strong>
                  {run.initialFeeCents != null ? ` + ${money(run.initialFeeCents)} initial` : ""}
                </dd>
              </>
            ) : null}
            {run.oneTimePriceCents != null ? (
              <>
                <dt>One-time</dt>
                <dd>
                  <strong>{money(run.oneTimePriceCents)}</strong> flat
                </dd>
              </>
            ) : null}
          </dl>

          {breakdown.length ? (
            <div style={{ marginTop: 10 }}>
              <p className="group-label">Breakdown</p>
              {breakdown.map((l, i) => (
                <div className="row-split small" key={i}>
                  <span className="muted">{l.label}</span>
                  <span>{money(l.cents)}</span>
                </div>
              ))}
            </div>
          ) : null}

          {run.reason ? (
            <p className="small" style={{ marginTop: 10 }}>
              <Badge tone={run.decision === "ESCALATE" ? "warn" : "muted"}>why</Badge>{" "}
              {run.reason}
            </p>
          ) : null}

          {extracted?.assumptions?.length ? (
            <p className="muted small" style={{ marginTop: 8 }}>
              Assumptions: {extracted.assumptions.join("; ")}
            </p>
          ) : null}

          {run.replyText ? (
            <div style={{ marginTop: 12 }}>
              <p className="group-label">Reply to send</p>
              <p className="small" style={{ whiteSpace: "pre-wrap", background: "var(--surface-2)", borderRadius: 10, padding: 10 }}>
                {run.replyText}
              </p>
              <div className="row-split" style={{ marginTop: 8 }}>
                <Button small variant="subtle" onClick={() => void copyReply()}>
                  {copied ? "✓ Copied" : "Copy reply"}
                </Button>
              </div>
              {run.decision === "QUOTE" ? (
                <p className="muted small" style={{ marginTop: 6 }}>
                  The reply sends them to the online booking funnel — they pick
                  a day and pay by card there, which is what converts the lead.
                </p>
              ) : null}
            </div>
          ) : null}

          {run.decision === "ESCALATE" ? (
            <p className="muted small" style={{ marginTop: 8 }}>
              Jake has been emailed the computed quote — tell the prospect a
              manager will follow up same day.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
