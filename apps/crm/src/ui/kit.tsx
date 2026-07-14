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
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
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

export function ListRow({
  title,
  subtitle,
  meta,
  onClick,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  meta?: ReactNode;
  onClick?: () => void;
}) {
  return (
    <div
      className={`list-row ${onClick ? "list-row-tappable" : ""}`}
      onClick={onClick}
      role={onClick ? "button" : undefined}
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

export function ErrorNote({ error }: { error: string | null }) {
  if (!error) return null;
  return <p className="error-note">{error}</p>;
}
