import { useEffect, useRef, useState } from "react";

/**
 * A tiny "zap the bugs" time-killer for the quote loading screen. It is
 * purely decorative: there is no timer, no game over, and no score gate —
 * bugs keep coming and the score just ticks up for fun while the real
 * quote resolves underneath. When the quote is ready the parent unmounts
 * this component and the funnel advances; the animation loop cancels on
 * unmount so nothing keeps running in the background.
 *
 * Skipped entirely under prefers-reduced-motion — the plain loading hint
 * carries the wait for anyone who has asked the OS for no animation.
 */

const SPLAT_GREEN = "#639922";

type BugKind = { body: string; wing: string | null; radius: number; points: number; speed: number; stripe?: boolean };

const KINDS: BugKind[] = [
  { body: "#5F5E5A", wing: "#B4B2A9", radius: 24, points: 1, speed: 2.1 },
  { body: "#854F0B", wing: "#EF9F27", radius: 28, points: 2, speed: 1.6, stripe: true },
  { body: "#4A1B0C", wing: null, radius: 20, points: 3, speed: 2.8 },
];

type Bug = { x: number; y: number; vx: number; vy: number; kind: BugKind; phase: number; life: number };
type Splat = { x: number; y: number; life: number; points: number };

export default function BugZapper() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [score, setScore] = useState(0);
  const scoreRef = useRef(0);

  const prefersReducedMotion =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  useEffect(() => {
    if (prefersReducedMotion) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const W = canvas.width;
    const H = canvas.height;

    // Deterministic PRNG so we never reach for Math.random in a loop.
    let seed = 1;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };

    const bugs: Bug[] = [];
    const splats: Splat[] = [];
    let frame = 0;
    let lastSpawn = 0;
    let raf = 0;

    const spawn = () => {
      const kind = KINDS[Math.floor(rnd() * KINDS.length)];
      const edge = Math.floor(rnd() * 4);
      let px: number;
      let py: number;
      if (edge === 0) {
        px = rnd() * W;
        py = -30;
      } else if (edge === 1) {
        px = W + 30;
        py = rnd() * H;
      } else if (edge === 2) {
        px = rnd() * W;
        py = H + 30;
      } else {
        px = -30;
        py = rnd() * H;
      }
      const tx = W * 0.2 + rnd() * W * 0.6;
      const ty = H * 0.2 + rnd() * H * 0.6;
      const a = Math.atan2(ty - py, tx - px);
      bugs.push({ x: px, y: py, vx: Math.cos(a) * kind.speed, vy: Math.sin(a) * kind.speed, kind, phase: rnd() * 6.28, life: 0 });
    };

    const drawBug = (b: Bug) => {
      const wobble = Math.sin(b.phase + b.life * 0.25) * 0.35;
      const angle = Math.atan2(b.vy, b.vx);
      const r = b.kind.radius;
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(angle + wobble);
      if (b.kind.wing) {
        ctx.fillStyle = b.kind.wing;
        ctx.globalAlpha = 0.6;
        const flap = Math.sin(b.life * 0.9) * 0.5 + 0.7;
        ctx.beginPath();
        ctx.ellipse(-r * 0.1, -r * 0.9, r * 0.7, r * 0.4 * flap, -0.5, 0, 6.28);
        ctx.fill();
        ctx.beginPath();
        ctx.ellipse(-r * 0.1, r * 0.9, r * 0.7, r * 0.4 * flap, 0.5, 0, 6.28);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      ctx.strokeStyle = b.kind.body;
      ctx.lineWidth = 2.5;
      for (let i = -1; i < 2; i++) {
        ctx.beginPath();
        ctx.moveTo(i * r * 0.35, 0);
        ctx.lineTo(i * r * 0.35 - 4, r * 0.9);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(i * r * 0.35, 0);
        ctx.lineTo(i * r * 0.35 - 4, -r * 0.9);
        ctx.stroke();
      }
      ctx.fillStyle = b.kind.body;
      ctx.beginPath();
      ctx.ellipse(0, 0, r, r * 0.55, 0, 0, 6.28);
      ctx.fill();
      if (b.kind.stripe) {
        ctx.fillStyle = "#412402";
        for (let s = -1; s < 2; s++) {
          ctx.beginPath();
          ctx.ellipse(s * r * 0.5, 0, r * 0.14, r * 0.55, 0, 0, 6.28);
          ctx.fill();
        }
      }
      ctx.fillStyle = b.kind.body;
      ctx.beginPath();
      ctx.arc(r * 0.95, 0, r * 0.4, 0, 6.28);
      ctx.fill();
      ctx.restore();
    };

    const drawSplat = (s: Splat) => {
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.globalAlpha = Math.max(0, 1 - s.life / 28);
      ctx.fillStyle = SPLAT_GREEN;
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * 6.28;
        const d = s.life * 1.6 + 8;
        ctx.beginPath();
        ctx.arc(Math.cos(a) * d, Math.sin(a) * d, 6, 0, 6.28);
        ctx.fill();
      }
      ctx.globalAlpha = Math.max(0, 1 - s.life / 18);
      ctx.fillStyle = "#0A0A0A";
      ctx.font = "bold 32px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("+" + s.points, 0, -s.life * 1.4);
      ctx.restore();
    };

    const loop = () => {
      frame++;
      ctx.clearRect(0, 0, W, H);

      // Steady trickle, capped so the swarm never overwhelms the card.
      if (frame - lastSpawn > 28 && bugs.length < 8) {
        spawn();
        lastSpawn = frame;
      }

      for (let i = bugs.length - 1; i >= 0; i--) {
        const b = bugs[i];
        b.life++;
        b.x += b.vx;
        b.y += b.vy;
        b.vx += Math.cos(b.phase + b.life * 0.05) * 0.05;
        b.vy += Math.sin(b.phase + b.life * 0.05) * 0.05;
        const sp = Math.hypot(b.vx, b.vy);
        if (sp > b.kind.speed * 1.6) {
          b.vx *= 0.96;
          b.vy *= 0.96;
        }
        if (b.x < -60 || b.x > W + 60 || b.y < -60 || b.y > H + 60) {
          bugs.splice(i, 1);
          continue;
        }
        drawBug(b);
      }

      for (let j = splats.length - 1; j >= 0; j--) {
        const s = splats[j];
        s.life++;
        if (s.life > 30) {
          splats.splice(j, 1);
          continue;
        }
        drawSplat(s);
      }

      raf = requestAnimationFrame(loop);
    };

    const zap = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect();
      const sx = ((clientX - rect.left) / rect.width) * W;
      const sy = ((clientY - rect.top) / rect.height) * H;
      for (let i = bugs.length - 1; i >= 0; i--) {
        const b = bugs[i];
        if (Math.hypot(b.x - sx, b.y - sy) < b.kind.radius + 18) {
          splats.push({ x: b.x, y: b.y, life: 0, points: b.kind.points });
          bugs.splice(i, 1);
          scoreRef.current += b.kind.points;
          setScore(scoreRef.current);
          return;
        }
      }
    };

    const onPointer = (e: PointerEvent) => {
      e.preventDefault();
      zap(e.clientX, e.clientY);
    };

    canvas.addEventListener("pointerdown", onPointer);
    for (let k = 0; k < 3; k++) spawn();
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      canvas.removeEventListener("pointerdown", onPointer);
    };
  }, [prefersReducedMotion]);

  if (prefersReducedMotion) return null;

  return (
    <div className="bk-bug-zapper">
      <div className="bk-bug-zapper__bar">
        <span>Zap the bugs while we work</span>
        <span className="bk-bug-zapper__score">
          Zapped <b>{score}</b>
        </span>
      </div>
      <canvas
        ref={canvasRef}
        width={1040}
        height={520}
        className="bk-bug-zapper__canvas"
        aria-label="A mini game: tap the bugs to zap them while your quote is prepared."
        role="img"
      />
    </div>
  );
}
