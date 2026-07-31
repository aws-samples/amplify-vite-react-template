import { useEffect, useRef, useState } from "react";

/**
 * Draw-to-sign pad.
 *
 * Produces a transparent PNG cropped to the ink, which matters: generated
 * ACORD forms scale the signature to fit the field's rectangle, so an
 * uncropped canvas would stamp a postage-stamp-sized squiggle floating in
 * whitespace. Pointer events cover mouse, trackpad, touch and stylus.
 */
export default function SignaturePad({
  onSave,
  onCancel,
  busy,
}: {
  onSave: (png: Blob) => void | Promise<void>;
  onCancel: () => void;
  busy?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const [hasInk, setHasInk] = useState(false);

  // Back the canvas at device resolution so strokes aren't soft on retina.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.lineWidth = 2.2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#0f172a";
  }, []);

  function pos(e: React.PointerEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function start(e: React.PointerEvent<HTMLCanvasElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    last.current = pos(e);
  }

  function move(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx || !last.current) return;
    const p = pos(e);
    // Midpoint quadratic keeps the line smooth at speed.
    const mid = { x: (last.current.x + p.x) / 2, y: (last.current.y + p.y) / 2 };
    ctx.beginPath();
    ctx.moveTo(last.current.x, last.current.y);
    ctx.quadraticCurveTo(last.current.x, last.current.y, mid.x, mid.y);
    ctx.stroke();
    last.current = p;
    if (!hasInk) setHasInk(true);
  }

  function end() {
    drawing.current = false;
    last.current = null;
  }

  function clear() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
    setHasInk(false);
  }

  /** Crop to the drawn pixels so the saved image is all signature. */
  function cropped(canvas: HTMLCanvasElement): HTMLCanvasElement | null {
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const { width, height } = canvas;
    const { data } = ctx.getImageData(0, 0, width, height);
    let minX = width, minY = height, maxX = -1, maxY = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        // Alpha channel only — the canvas has no background.
        if (data[(y * width + x) * 4 + 3] === 0) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (maxX < 0) return null; // nothing drawn

    const pad = 6;
    minX = Math.max(0, minX - pad);
    minY = Math.max(0, minY - pad);
    maxX = Math.min(width - 1, maxX + pad);
    maxY = Math.min(height - 1, maxY + pad);

    const out = document.createElement("canvas");
    out.width = maxX - minX + 1;
    out.height = maxY - minY + 1;
    out
      .getContext("2d")
      ?.drawImage(canvas, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
    return out;
  }

  async function save() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const trimmed = cropped(canvas);
    if (!trimmed) return;
    const blob = await new Promise<Blob | null>((resolve) =>
      trimmed.toBlob(resolve, "image/png")
    );
    if (blob) await onSave(blob);
  }

  return (
    <div className="sig-pad">
      <canvas
        ref={canvasRef}
        className="sig-canvas"
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerLeave={end}
        onPointerCancel={end}
      />
      <p className="muted small" style={{ margin: "6px 0" }}>
        Sign above using a mouse, trackpad or finger. Saved as a transparent
        PNG cropped to your signature.
      </p>
      <div className="toolbar" style={{ marginTop: 0 }}>
        <button className="primary" disabled={!hasInk || busy} onClick={save}>
          {busy ? "Saving…" : "Save signature"}
        </button>
        <button className="secondary" disabled={!hasInk || busy} onClick={clear}>
          Clear
        </button>
        <button className="link" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
