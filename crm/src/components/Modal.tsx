import {
  useEffect,
  useId,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";

/**
 * The overlay shell, generalized out of FilePreview — the one overlay in the
 * app that already had Escape, backdrop dismissal and stopPropagation.
 *
 * The shell is all this owns: the backdrop, the box, the header (title, an
 * `actions` slot, Close), a scrolling body, and the dialog accessibility
 * contract. It knows nothing about what it is showing — loading states, error
 * text, download fallbacks and the like belong to the caller's children.
 *
 * Rendered inline in the tree, not through a portal: the app has a single
 * `#root` and no portal root, and `.preview-overlay` is `position: fixed`, so
 * inline placement already escapes any ancestor layout.
 *
 * Classes are the existing `.preview-*` rules in styles.css, so nothing needs
 * restyling when call sites migrate.
 */

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "iframe",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export interface ModalProps {
  /**
   * Visible header text and the dialog's accessible name. Also the `title`
   * attribute, since the header ellipsizes long names.
   */
  title: string;
  /** Escape, backdrop click and the Close button all call this. */
  onClose: () => void;
  /** Body content. */
  children: ReactNode;
  /** Extra header controls, rendered to the left of Close. */
  actions?: ReactNode;
  /** Label for the built-in close button. */
  closeLabel?: string;
  /** Extra class on the modal box, for per-caller sizing. */
  className?: string;
}

export default function Modal({
  title,
  onClose,
  children,
  actions,
  closeLabel = "Close",
  className,
}: ModalProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  // Escape closes from anywhere in the window — carried over verbatim from
  // FilePreview, including the listener target and the cleanup.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Move focus into the dialog on open, and hand it back to whatever had it
  // when the dialog goes away.
  useEffect(() => {
    const restoreTo = document.activeElement;
    boxRef.current?.focus();
    return () => {
      if (restoreTo instanceof HTMLElement && restoreTo.isConnected) {
        restoreTo.focus();
      }
    };
  }, []);

  // Tab cycles inside the dialog. `aria-modal` tells assistive tech the rest
  // of the page is inert, so the keyboard has to agree with it.
  function onKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key !== "Tab") return;
    const box = boxRef.current;
    if (!box) return;
    const items = Array.from(box.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (items.length === 0) {
      e.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === box)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="preview-overlay" onClick={onClose}>
      <div
        ref={boxRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={className ? `preview-modal ${className}` : "preview-modal"}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="preview-head">
          <span className="preview-title" id={titleId} title={title}>
            {title}
          </span>
          <div>
            {actions}
            {actions ? " " : null}
            <button className="secondary" onClick={onClose}>
              {closeLabel}
            </button>
          </div>
        </div>
        <div className="preview-body">{children}</div>
      </div>
    </div>
  );
}
