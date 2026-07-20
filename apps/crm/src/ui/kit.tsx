import { useEffect, useRef } from "react";
import type { ReactNode, ButtonHTMLAttributes } from "react";
import { useNavigate } from "react-router-dom";

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="spinner-wrap" role="status">
      <div className="spinner" />
      {label ? <p>{label}</p> : null}
    </div>
  );
}

export function Page({
  title,
  back,
  actions,
  children,
}: {
  title: string;
  back?: string | true;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  return (
    <div className="page">
      <header className="topbar">
        {back ? (
          <button
            className="topbar-back"
            aria-label="Back"
            onClick={() =>
              back === true ? navigate(-1) : navigate(back)
            }
          >
            ‹
          </button>
        ) : null}
        <h1>{title}</h1>
        {actions ? <div className="topbar-actions">{actions}</div> : null}
      </header>
      <div className="page-body">{children}</div>
    </div>
  );
}

export function Card({
  children,
  title,
  actions,
  className,
}: {
  children: ReactNode;
  title?: string;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card ${className ?? ""}`}>
      {title || actions ? (
        <div className="card-head">
          {title ? <h2>{title}</h2> : <span />}
          {actions}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function Button({
  variant = "primary",
  block,
  small,
  loading,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "danger" | "subtle";
  block?: boolean;
  small?: boolean;
  loading?: boolean;
}) {
  return (
    <button
      className={[
        "btn",
        `btn-${variant}`,
        block ? "btn-block" : "",
        small ? "btn-small" : "",
      ].join(" ")}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <span className="btn-spinner" /> : null}
      {children}
    </button>
  );
}

export function Field({
  label,
  hint,
  children,
  group,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  /** Composite content (multiple controls): render a group, not a <label>. */
  group?: boolean;
}) {
  const body = (
    <>
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </>
  );
  if (group) {
    return (
      <div className="field" role="group" aria-label={label}>
        {body}
      </div>
    );
  }
  return <label className="field">{body}</label>;
}

export type BadgeTone = "ok" | "warn" | "danger" | "muted" | "info";

export function Badge({
  tone = "muted",
  children,
}: {
  tone?: BadgeTone;
  children: ReactNode;
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export const statusTone: Record<string, BadgeTone> = {
  LEAD: "info",
  ACTIVE: "ok",
  INACTIVE: "muted",
  PAUSED: "warn",
  CANCELED: "muted",
  UNSCHEDULED: "warn",
  SCHEDULED: "info",
  IN_PROGRESS: "warn",
  COMPLETED: "ok",
  COMPLETE: "ok",
  PLANNED: "info",
  DRAFT: "muted",
  SENT: "info",
  VIEWED: "warn",
  SIGNED: "ok",
  VOID: "muted",
  FINALIZED: "ok",
  OPEN: "warn",
  PAID: "ok",
  FAILED: "danger",
  REFUNDED: "muted",
};

export function StatusBadge({ status }: { status?: string | null }) {
  if (!status) return null;
  return (
    <Badge tone={statusTone[status] ?? "muted"}>
      {status.replace(/_/g, " ").toLowerCase()}
    </Badge>
  );
}

/**
 * A finalized report's delivery state — separate from completion. A report can
 * be complete and still not have reached the customer, so this never says
 * "sent" unless it was. `emailedAt` covers reports finalized before
 * deliveryStatus existed: a stamped time means it was delivered.
 */
/**
 * GL-15 — one truthful sentence about where a legal document actually is.
 * Provider ACCEPTANCE is never called delivered: only the mailbox-provider
 * event (DELIVERED) earns the green "delivered", and a later bounce/complaint
 * reopens the obligation visibly. No emailedAt fallback — an old timestamp is
 * not proof of receipt.
 */
export function DeliveryBadge({
  status,
  emailedAt,
}: {
  status?: string | null;
  emailedAt?: string | null;
}) {
  // Legacy rows predating the delivery states: emailedAt alone proves only
  // provider acceptance.
  const resolved = status ?? (emailedAt ? "ACCEPTED" : null);
  if (resolved === "DELIVERED") return <Badge tone="ok">delivered</Badge>;
  if (resolved === "ACCEPTED")
    return <Badge tone="info">sent — awaiting delivery confirmation</Badge>;
  if (resolved === "SENDING")
    return <Badge tone="warn">sending — not yet confirmed</Badge>;
  if (resolved === "BOUNCED")
    return <Badge tone="danger">bounced — customer does NOT have it</Badge>;
  if (resolved === "COMPLAINED")
    return <Badge tone="danger">marked spam — delivery reopened</Badge>;
  if (resolved === "SUPPRESSED")
    return <Badge tone="danger">address suppressed — not sent</Badge>;
  if (resolved === "FAILED")
    return <Badge tone="danger">delivery failed — office notified</Badge>;
  if (resolved === "NO_EMAIL")
    return <Badge tone="warn">no email on file — office will deliver</Badge>;
  if (resolved === "ALTERNATE_DELIVERED")
    return <Badge tone="ok">delivered another way (recorded)</Badge>;
  return null;
}

export function ListRow({
  title,
  subtitle,
  meta,
  onClick,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  meta?: ReactNode;
  onClick?: () => void;
  className?: string;
}) {
  return (
    <div
      className={`list-row ${onClick ? "list-row-tappable" : ""} ${className ?? ""}`}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
    >
      <div className="list-row-main">
        <div className="list-row-title">{title}</div>
        {subtitle ? <div className="list-row-sub">{subtitle}</div> : null}
      </div>
      {meta ? <div className="list-row-meta">{meta}</div> : null}
      {onClick ? <span className="list-row-chevron">›</span> : null}
    </div>
  );
}

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {body ? <p className="empty-body">{body}</p> : null}
      {action}
    </div>
  );
}

export function Sheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2>{title}</h2>
          <button className="sheet-close" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}

export function SegControl<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button
          key={o.value}
          className={o.value === value ? "seg-on" : ""}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: ReactNode;
  tone?: BadgeTone;
}) {
  return (
    <div className={`stat ${tone ? `stat-${tone}` : ""}`}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

/** Raw exception text helps nobody — show friendly copy, log the rest. */
const TECHNICAL_ERROR =
  /is not a function|Cannot read propert|undefined is not|Failed to fetch|NetworkError|^\[object|Unexpected token/i;

export function ErrorNote({ error }: { error: string | null }) {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (error) {
      if (TECHNICAL_ERROR.test(error)) console.error("[BuzzKill]", error);
      ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [error]);
  if (!error) return null;
  return (
    <p className="error-note" role="alert" ref={ref}>
      {TECHNICAL_ERROR.test(error)
        ? "Something went wrong on our side — please try again. (Details are in the browser console.)"
        : error}
    </p>
  );
}

/** Transient success confirmation for actions with no visible state change. */
export function SuccessNote({ message }: { message: string | null }) {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (message) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [message]);
  if (!message) return null;
  return (
    <p className="success-note" role="status" ref={ref}>
      ✓ {message}
    </p>
  );
}
