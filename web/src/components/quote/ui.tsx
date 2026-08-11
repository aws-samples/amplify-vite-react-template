import { useState, useEffect, useRef, type ReactNode, type CSSProperties } from "react";
import { LIGHT, useTheme } from "./theme";
import { Icon, type IconKey } from "./icons";
import type { Agent } from "./session";

/* ──────────────────────────────────────────────────────────
   SHARED COMPONENTS
   ────────────────────────────────────────────────────────── */

export function ProgressBar({ current, total }: { current: number; total: number }) {
  const pct = Math.max(0, Math.min(100, Math.round((current / total) * 100)));
  return (
    <div className="qf-progress">
      <div className="qf-progress-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

/**
 * Segmented step indicator: one segment per question, plus a "Step N of 5" count.
 *
 * A single sliding bar tells you how far along you are but not how much is left.
 * Discrete segments plus the count answer both, which is what makes a form feel
 * finishable — the same reason the splash names the number up front.
 */
export function StepIndicator({ current, total }: { current: number; total: number }) {
  const c = useTheme();
  if (total < 1) return null;
  const clamped = Math.max(0, Math.min(current, total));
  return (
    <div className="qf-steps" role="group" aria-label={`Step ${clamped} of ${total}`}>
      <div className="qf-steps-track">
        {Array.from({ length: total }, (_, i) => {
          const done = i < clamped - 1;
          const active = i === clamped - 1;
          return (
            <span
              key={i}
              className={
                "qf-step-seg" +
                (done ? " qf-step-seg--done" : "") +
                (active ? " qf-step-seg--active" : "")
              }
              style={{
                background: done || active ? c.borderActive : c.border,
                opacity: done ? 1 : active ? 1 : 0.45,
              }}
            />
          );
        })}
      </div>
      <span className="qf-steps-label" style={{ color: c.textMuted }}>
        Step {clamped} of {total}
      </span>
    </div>
  );
}

/** Wordmark shown on every screen, so the form never looks detached from the site. */
export function BrandMark({ small = false }: { small?: boolean }) {
  return (
    <a
      href="/"
      className={"qf-brand" + (small ? " qf-brand--small" : "")}
      aria-label="HOA Insurance Agency home"
    >
      <img src="/logo.png" alt="HOA Insurance Agency" draggable={false} />
    </a>
  );
}

/** Persistent support line. A form that can be abandoned should offer a human. */
export function SupportChip({ phone, href }: { phone: string; href: string }) {
  const c = useTheme();
  return (
    <a
      className="qf-support"
      href={href}
      style={{ borderColor: c.border, color: c.text, background: c.card }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M22 16.9v3a2 2 0 01-2.2 2 19.8 19.8 0 01-8.6-3.1 19.5 19.5 0 01-6-6A19.8 19.8 0 012.1 4.2 2 2 0 014.1 2h3a2 2 0 012 1.7c.1.9.3 1.8.6 2.6a2 2 0 01-.5 2.1L8.1 9.6a16 16 0 006 6l1.2-1.1a2 2 0 012.1-.5c.8.3 1.7.5 2.6.6a2 2 0 011.7 2z" />
      </svg>
      <span className="qf-support-label">Support</span>
      <span className="qf-support-num">{phone}</span>
    </a>
  );
}

/* ── Typing animation ── */
function TypeWriter({ text, speed = 32, onDone }: { text: string; speed?: number; onDone?: () => void }) {
  const [displayed, setDisplayed] = useState("");
  const [done, setDone] = useState(false);

  useEffect(() => {
    setDisplayed("");
    setDone(false);
    let i = 0;
    const id = setInterval(() => {
      i++;
      setDisplayed(text.slice(0, i));
      if (i >= text.length) {
        clearInterval(id);
        setDone(true);
        onDone?.();
      }
    }, speed);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, speed]);

  return (
    <span>
      {displayed}
      {!done && <span className="qf-cursor">|</span>}
    </span>
  );
}


/* ── Confetti burst ── */
export function Confetti({ active }: { active: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!active || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    const colors = ["#4da6ff", "#e5c16a", "#3fb950", "#f85149", "#79bbff", "#f2d78f", "#ff6eb4", "#ffd700"];
    const particles: {
      x: number; y: number; vx: number; vy: number;
      w: number; h: number; color: string; rotation: number; spin: number;
      gravity: number; opacity: number;
    }[] = [];

    for (let i = 0; i < 120; i++) {
      particles.push({
        x: canvas.width / 2 + (Math.random() - 0.5) * 200,
        y: canvas.height * 0.4,
        vx: (Math.random() - 0.5) * 16,
        vy: -Math.random() * 18 - 4,
        w: Math.random() * 8 + 4,
        h: Math.random() * 6 + 2,
        color: colors[Math.floor(Math.random() * colors.length)],
        rotation: Math.random() * 360,
        spin: (Math.random() - 0.5) * 12,
        gravity: 0.25 + Math.random() * 0.15,
        opacity: 1,
      });
    }

    let frame: number;
    let elapsed = 0;

    function draw() {
      ctx!.clearRect(0, 0, canvas.width, canvas.height);
      elapsed++;

      for (const p of particles) {
        p.vy += p.gravity;
        p.x += p.vx;
        p.y += p.vy;
        p.rotation += p.spin;
        p.vx *= 0.99;
        if (elapsed > 60) p.opacity = Math.max(0, p.opacity - 0.015);

        ctx!.save();
        ctx!.translate(p.x, p.y);
        ctx!.rotate((p.rotation * Math.PI) / 180);
        ctx!.globalAlpha = p.opacity;
        ctx!.fillStyle = p.color;
        ctx!.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx!.restore();
      }

      if (elapsed < 180 && particles.some((p) => p.opacity > 0)) {
        frame = requestAnimationFrame(draw);
      }
    }

    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [active]);

  if (!active) return null;

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        pointerEvents: "none",
      }}
    />
  );
}

/* Sun / moon indicator (also acts as a manual override toggle) */
export function ThemeIndicator({ isDay, onToggle }: { isDay: boolean; onToggle: () => void }) {
  const c = useTheme();
  const [hov, setHov] = useState(false);
  return (
    <button
      type="button"
      onClick={onToggle}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      aria-label={isDay ? "Switch to night theme" : "Switch to day theme"}
      title={isDay ? "Day theme — click for night" : "Night theme — click for day"}
      className="qf-theme-toggle"
      style={{
        color: hov ? c.text : c.textMuted,
        background: hov ? (isDay ? "rgba(0,0,0,0.04)" : "rgba(255,255,255,0.06)") : "transparent",
      }}
    >
      {isDay ? (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
        </svg>
      ) : (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />
        </svg>
      )}
    </button>
  );
}

export function SlideIn({ children, keyVal, direction }: { children: ReactNode; keyVal: string; direction: 1 | -1 }) {
  const [vis, setVis] = useState(false);
  useEffect(() => {
    setVis(false);
    const t = requestAnimationFrame(() => setVis(true));
    return () => cancelAnimationFrame(t);
  }, [keyVal]);
  const offset = direction === 1 ? 32 : -32;
  return (
    <div
      style={{
        opacity: vis ? 1 : 0,
        transform: vis ? "translate3d(0,0,0)" : `translate3d(${offset}px,0,0)`,
        transition: "opacity 0.42s cubic-bezier(.2,.7,.3,1), transform 0.5s cubic-bezier(.2,.7,.3,1)",
        willChange: "opacity, transform",
      }}
    >
      {children}
    </div>
  );
}

export function CardOption({
  label,
  sub,
  iconKey,
  selected,
  onClick,
  showCheck,
}: {
  label: string;
  sub?: string;
  iconKey?: IconKey;
  selected: boolean;
  onClick: () => void;
  showCheck?: boolean;
}) {
  const c = useTheme();
  const [hov, setHov] = useState(false);
  const IconCmp = iconKey ? Icon[iconKey] : null;
  const active = selected;
  const isLight = c.bg === LIGHT.bg;
  const shadowBase = isLight ? "rgba(15,23,42,0.06)" : "rgba(0,0,0,0.25)";
  const shadowHover = isLight ? "rgba(15,23,42,0.12)" : "rgba(0,0,0,0.35)";
  const shadowActive = isLight ? "rgba(15,23,42,0.14)" : "rgba(0,0,0,0.4)";
  const borderHover = isLight ? "#c8d2e1" : "#2c3a55";
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      className="qf-card-option"
      style={{
        background: active ? c.accentDim : hov ? c.cardHover : c.card,
        border: `1.5px solid ${active ? c.borderActive : hov ? borderHover : c.border}`,
        boxShadow: active
          ? `0 0 0 4px ${c.accentGlow}, 0 8px 24px ${shadowActive}`
          : hov
            ? `0 6px 20px ${shadowHover}`
            : `0 2px 8px ${shadowBase}`,
        transform: hov && !active ? "translateY(-2px)" : "translateY(0)",
        color: c.text,
      }}
    >
      {IconCmp && (
        <span
          className="qf-card-icon"
          style={{
            background: active ? c.accent : c.accentDim,
            color: active ? c.white : c.accent,
            transition: "all 0.25s ease",
          }}
        >
          <IconCmp size={26} />
        </span>
      )}
      <span className="qf-card-text">
        <span className="qf-card-label">{label}</span>
        {sub && <span className="qf-card-sub" style={{ color: c.textMuted }}>{sub}</span>}
      </span>
      {showCheck && (
        <span
          className="qf-card-check"
          style={{
            background: active ? c.accent : "transparent",
            border: `2px solid ${active ? c.accent : c.border}`,
            color: active ? c.white : "transparent",
          }}
        >
          <Icon.Check size={14} />
        </span>
      )}
    </button>
  );
}

export function TextField({
  placeholder,
  value,
  onChange,
  onSubmit,
  type = "text",
  autoFocus = true,
}: {
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  type?: string;
  autoFocus?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocus && ref.current) {
      const t = setTimeout(() => ref.current?.focus(), 250);
      return () => clearTimeout(t);
    }
  }, [autoFocus]);
  return (
    <input
      ref={ref}
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onSubmit();
        }
      }}
      placeholder={placeholder}
      className="qf-input"
      autoComplete="off"
    />
  );
}

/**
 * Native <select>. Deliberately not the CardOption grid the other choice steps
 * use: fifty-one states as tappable cards would be a screen of scrolling, and a
 * native picker is also what mobile keyboards handle best.
 */
export function SelectField({
  value,
  onChange,
  options,
  placeholder = "Select…",
  autoFocus = false,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const ref = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    if (autoFocus && ref.current) {
      const t = setTimeout(() => ref.current?.focus(), 250);
      return () => clearTimeout(t);
    }
  }, [autoFocus]);
  return (
    <select
      ref={ref}
      className="qf-input qf-select"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{placeholder}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function PrimaryButton({
  onClick,
  label = "Continue",
  disabled = false,
  loading = false,
}: {
  onClick: () => void;
  label?: string;
  disabled?: boolean;
  loading?: boolean;
}) {
  const c = useTheme();
  const [hov, setHov] = useState(false);
  const style: CSSProperties = {
    background: disabled ? c.border : hov ? c.accentHover : c.accent,
    color: disabled ? c.textMuted : c.white,
    boxShadow: disabled ? "none" : hov ? `0 14px 32px ${c.accentGlow}` : `0 8px 22px ${c.accentGlow}`,
    transform: hov && !disabled ? "translateY(-1px)" : "translateY(0)",
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.55 : 1,
  };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      className="qf-primary-btn"
      style={style}
    >
      <span>{loading ? "Sending…" : label}</span>
      {!loading && <Icon.ArrowRight size={18} />}
    </button>
  );
}

export function BackButton({
  onClick,
  label = "Back",
}: {
  onClick: () => void;
  label?: string;
}) {
  const c = useTheme();
  const [hov, setHov] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      className="qf-back-btn"
      style={{ color: hov ? c.text : c.textMuted }}
    >
      <Icon.ArrowLeft size={16} />
      <span>{label}</span>
    </button>
  );
}

export function RestartButton({ onClick }: { onClick: () => void }) {
  const c = useTheme();
  const [hov, setHov] = useState(false);
  const isLight = c.bg === LIGHT.bg;
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      aria-label="Start over"
      title="Start over"
      className="qf-restart-btn"
      style={{
        color: hov ? c.text : c.textMuted,
        background: hov ? (isLight ? "rgba(15,23,42,0.05)" : "rgba(255,255,255,0.06)") : "transparent",
      }}
    >
      <Icon.Restart size={18} />
    </button>
  );
}

/* ── Friendly headshot header (Lemonade-style) ── */
export function AgentHeader({
  agent,
  greeting,
  compact,
  typeGreeting,
}: {
  agent: Agent;
  greeting?: string;
  compact?: boolean;
  typeGreeting?: boolean;
}) {
  const c = useTheme();
  const [imgFailed, setImgFailed] = useState(false);
  useEffect(() => setImgFailed(false), [agent.photo]);
  return (
    <div className={"qf-agent-header" + (compact ? " qf-agent-header--compact" : "")}>
      <div
        className="qf-agent-avatar"
        style={{
          background: c.accentDim,
          borderColor: c.border,
          position: "relative",
        }}
      >
        {!imgFailed ? (
          <img
            src={agent.photo}
            alt={agent.name}
            onError={() => setImgFailed(true)}
            draggable={false}
          />
        ) : (
          <FallbackAvatar accent={c.accent} />
        )}
      </div>
      {greeting && (
        <p className="qf-agent-greeting" style={{ color: c.textMuted }}>
          {typeGreeting ? <TypeWriter text={greeting} speed={28} /> : greeting}
        </p>
      )}
    </div>
  );
}

function FallbackAvatar({ accent }: { accent: string }) {
  return (
    <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <clipPath id="qf-avatar-clip">
          <circle cx="50" cy="50" r="50" />
        </clipPath>
      </defs>
      <g clipPath="url(#qf-avatar-clip)">
        <rect width="100" height="100" fill="#fde6d2" />
        <ellipse cx="50" cy="100" rx="42" ry="32" fill={accent} />
        <rect x="44" y="58" width="12" height="14" fill="#f4cba6" />
        <circle cx="50" cy="44" r="20" fill="#f4cba6" />
        <path d="M30 40 Q30 22 50 22 Q70 22 70 42 Q66 30 50 28 Q34 30 32 44 Z" fill="#5a3e2a" />
        <circle cx="43" cy="45" r="1.6" fill="#2a2a2a" />
        <circle cx="57" cy="45" r="1.6" fill="#2a2a2a" />
        <path d="M43 52 Q50 57 57 52" stroke="#2a2a2a" strokeWidth="1.6" fill="none" strokeLinecap="round" />
      </g>
    </svg>
  );
}
