import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { connectBackend, getCustomOutput } from "../lib/backend";
import { Button, Card, ErrorNote, Field, Spinner } from "../ui/kit";

type AgreementView = {
  title: string;
  bodyText: string;
  customerName: string;
  status: string;
  signedAt: string | null;
  imageUrls?: string[];
};

/**
 * Public e-sign page (no login — the unguessable token is the credential).
 * Talks to the agreement-public Function URL, not the authed data API.
 */
export default function SignPage() {
  const { token } = useParams<{ token: string }>();
  const [apiUrl, setApiUrl] = useState<string | null>(null);
  const [agreement, setAgreement] = useState<AgreementView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [signerName, setSignerName] = useState("");
  const [agreeChecked, setAgreeChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [signed, setSigned] = useState(false);
  const padRef = useRef<SignaturePadHandle>(null);

  useEffect(() => {
    (async () => {
      const ready = await connectBackend();
      const url = ready ? getCustomOutput("agreementPublicUrl") : null;
      if (!url) {
        setError("Signing is temporarily unavailable — please try again later.");
        setLoading(false);
        return;
      }
      setApiUrl(url);
      try {
        const res = await fetch(`${url}?token=${encodeURIComponent(token ?? "")}`);
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(
            res.status === 404
              ? "This signing link is invalid or has expired."
              : (body?.error ?? "Could not load the agreement.")
          );
        }
        const data = (await res.json()) as AgreementView;
        setAgreement(data);
        if (data.status === "SIGNED") setSigned(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not load the agreement.");
      } finally {
        setLoading(false);
      }
    })();
  }, [token]);

  const submit = async () => {
    if (!signerName.trim()) {
      setError("Please type your full legal name.");
      return;
    }
    if (!agreeChecked) {
      setError("Please confirm you agree to the terms.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(apiUrl!, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          signerName: signerName.trim(),
          signatureDataUrl: padRef.current?.isEmpty()
            ? undefined
            : padRef.current?.toDataUrl(),
        }),
      });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new Error(body?.error ?? "Could not submit signature.");
      setSigned(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not submit signature.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app-frame" style={{ paddingBottom: 24 }}>
      <header className="topbar">
        <h1>BuzzKill Pest Control</h1>
      </header>
      <div className="page-body">
        {loading ? (
          <Spinner label="Loading your agreement…" />
        ) : !agreement ? (
          <ErrorNote error={error} />
        ) : signed ? (
          <Card>
            <div className="empty">
              <p className="empty-title">✓ Agreement signed</p>
              <p className="empty-body">
                Thanks{signerName ? `, ${signerName}` : ""}! A copy of your
                signed agreement has been emailed to you for your records.
              </p>
            </div>
          </Card>
        ) : (
          <>
            <Card>
              <h2 style={{ marginBottom: 4 }}>{agreement.title}</h2>
              <p className="muted small" style={{ marginBottom: 12 }}>
                Prepared for {agreement.customerName}
              </p>
              <div
                style={{
                  whiteSpace: "pre-wrap",
                  fontSize: 14,
                  lineHeight: 1.55,
                  maxHeight: "45dvh",
                  overflowY: "auto",
                  border: "1px solid var(--line)",
                  borderRadius: 10,
                  padding: 12,
                }}
              >
                {agreement.bodyText}
              </div>
              {agreement.imageUrls?.length ? (
                <div style={{ marginTop: 12 }}>
                  <p className="group-label">Covered pests</p>
                  <div className="photo-grid">
                    {agreement.imageUrls.map((url, i) => (
                      <div key={i} className="photo-thumb">
                        <img src={url} alt="Covered pest" loading="lazy" />
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </Card>

            <Card title="Sign here">
              <div className="form-grid">
                <Field label="Full legal name">
                  <input
                    value={signerName}
                    onChange={(e) => setSignerName(e.target.value)}
                    placeholder="Jane Q. Smith"
                    autoComplete="name"
                  />
                </Field>
                <Field label="Signature (draw with your finger — optional)">
                  <SignaturePad ref={padRef} />
                </Field>
                <label style={{ display: "flex", gap: 10, fontSize: 14, alignItems: "flex-start" }}>
                  <input
                    type="checkbox"
                    style={{ width: "auto", marginTop: 3 }}
                    checked={agreeChecked}
                    onChange={(e) => setAgreeChecked(e.target.checked)}
                  />
                  <span>
                    I have read and agree to the terms above, and I consent to
                    signing this agreement electronically.
                  </span>
                </label>
                <ErrorNote error={error} />
                <Button block loading={busy} onClick={() => void submit()}>
                  Sign agreement
                </Button>
              </div>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}

/* ---------- Minimal canvas signature pad ---------- */

import { forwardRef, useImperativeHandle } from "react";

type SignaturePadHandle = {
  isEmpty: () => boolean;
  toDataUrl: () => string;
};

const SignaturePad = forwardRef<SignaturePadHandle>(function SignaturePad(_, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const scale = window.devicePixelRatio || 1;
    canvas.width = canvas.offsetWidth * scale;
    canvas.height = 160 * scale;
    const ctx = canvas.getContext("2d")!;
    ctx.scale(scale, scale);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.offsetWidth, 160);
    ctx.strokeStyle = "#16181d";
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
  }, []);

  useImperativeHandle(ref, () => ({
    isEmpty: () => !dirty,
    toDataUrl: () => canvasRef.current!.toDataURL("image/png"),
  }));

  const pos = (e: React.PointerEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  return (
    <div>
      <canvas
        ref={canvasRef}
        className="sig-pad"
        style={{ height: 160 }}
        onPointerDown={(e) => {
          drawing.current = true;
          canvasRef.current!.setPointerCapture(e.pointerId);
          const ctx = canvasRef.current!.getContext("2d")!;
          const { x, y } = pos(e);
          ctx.beginPath();
          ctx.moveTo(x, y);
        }}
        onPointerMove={(e) => {
          if (!drawing.current) return;
          const ctx = canvasRef.current!.getContext("2d")!;
          const { x, y } = pos(e);
          ctx.lineTo(x, y);
          ctx.stroke();
          if (!dirty) setDirty(true);
        }}
        onPointerUp={() => {
          drawing.current = false;
        }}
      />
      {dirty ? (
        <Button
          small
          variant="ghost"
          style={{ marginTop: 6 }}
          onClick={() => {
            const canvas = canvasRef.current!;
            const ctx = canvas.getContext("2d")!;
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(0, 0, canvas.offsetWidth, 200);
            setDirty(false);
          }}
        >
          Clear signature
        </Button>
      ) : null}
    </div>
  );
});
