import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { friendlyError } from "../lib/client";

/**
 * One save-feedback state machine, one way to render it.
 *
 * There is no toast system in this app, so every mutation invented its own
 * confirmation. Six variants exist, five of which hand-duplicate the same
 * `<span className="small" style={{ color: "var(--green)" }}>`:
 *
 *  - a `saved` bool (`AccountDetail`, `PropertyPanel`, `CarrierDetail`),
 *  - a `notice` string that is never cleared (`Team`),
 *  - an `applied` bool with different copy (`ExtractionPanel`),
 *  - an amber `note`/`genNote` for partial success (`FormsTab`, `AccountDetail`),
 *  - a `result` string rendered green in one branch and red in another
 *    (`Licensing`),
 *
 * plus nine mutations that report nothing at all. The variants differ in ways
 * nobody chose: severity, copy, whether the message survives the next edit.
 *
 * What this primitive makes unreachable, rather than merely discouraged:
 *
 *  - **Severity is carried by the value, not decided at the render site.**
 *    `Licensing` proves the failure mode: one `result` string is printed green
 *    at `:356` and red (`.error-text`) at `:413`, and which one you get depends
 *    on how many rows are still pending — not on whether anything failed. Here
 *    a message is never separable from its state, so the same value cannot
 *    render green in one place and red in another.
 *  - **The `saved` flag can't be left stale.** `CarrierDetail` clears it by
 *    hand in seven places (`:82,87,150,219,230,281,291`); miss one and the
 *    form says "Saved." over unsaved edits. `markDirty` is one identity-stable
 *    callback to put in the form setter, so there is one place to miss.
 *  - **A message-carrying state can't render empty.** Every state has default
 *    copy, so `markError("")` still reads as a failure instead of an empty red
 *    span that swallows the error.
 *  - **`warning` is a first-class outcome, not a second success flag.** The
 *    "generated UNSIGNED" note (`AccountDetail:678`, `FormsTab:126`) is a
 *    partial success that the user must act on; it is amber, it carries its
 *    own text, and it is not `saved`.
 *
 * Colors are the stylesheet's (`--green`, `--amber`, and `.error-text`'s
 * `--red`); nothing here invents a hex value.
 */

export type SaveState = "idle" | "saving" | "saved" | "warning" | "error";

/**
 * A state and, where the state means anything without one, its message.
 *
 * The union is the point. `warning` and `error` *require* text — a partial
 * success or a failure with nothing to read is not a thing a caller should be
 * able to construct. `saved` may carry text (`Team`'s invite notice,
 * `ExtractionPanel`'s "Applied — review the Overview tab.") and defaults to
 * "Saved." without. `idle` and `saving` cannot carry one at all.
 */
export type SaveStatusValue =
  | { state: "idle"; message?: undefined }
  | { state: "saving"; message?: undefined }
  | { state: "saved"; message?: string }
  | { state: "warning"; message: string }
  | { state: "error"; message: string };

const IDLE: SaveStatusValue = { state: "idle" };
const SAVING: SaveStatusValue = { state: "saving" };

/**
 * Copy of last resort. A state that renders nothing is indistinguishable from
 * no feedback at all, which is the bug this component exists to remove — so
 * every visible state has text even when the caller supplied none.
 */
const DEFAULT_MESSAGE: Record<Exclude<SaveState, "idle">, string> = {
  saving: "Saving…",
  saved: "Saved.",
  warning: "Saved — but check the note above.",
  error: "Save failed.",
};

/**
 * Renders one `SaveStatusValue`. Stateless: no timers, no effects, nothing to
 * leak. `idle` renders nothing.
 *
 * Props are the same union the hook returns, so the call site is
 * `<SaveStatus {...status} />` — or a literal `<SaveStatus state="saved" />`
 * for a component that isn't using the hook yet.
 *
 * `data-save-state` is the stable hook for tests and for any future CSS: it
 * distinguishes the states without anyone having to assert on a color.
 */
export function SaveStatus(props: SaveStatusValue) {
  const { state } = props;
  if (state === "idle") return null;

  const text = props.message?.trim() || DEFAULT_MESSAGE[state];

  // A failure is the one state worth interrupting a screen reader for; the
  // rest are polite.
  const role = state === "error" ? "alert" : "status";

  if (state === "error") {
    return (
      <span className="error-text" role={role} data-save-state={state}>
        {text}
      </span>
    );
  }
  if (state === "saving") {
    return (
      <span className="muted small" role={role} data-save-state={state}>
        {text}
      </span>
    );
  }
  return (
    <span
      className="small"
      role={role}
      data-save-state={state}
      style={{ color: state === "warning" ? "var(--amber)" : "var(--green)" }}
    >
      {text}
    </span>
  );
}

/**
 * A task run by {@link SaveStatusApi.run}.
 *
 * Resolving with a non-empty string means "it worked, but the user needs to
 * know this" — that is the `warning` state, and it is how `FormsTab`'s
 * `setNote(...)` and `AccountDetail`'s `setGenNote(...)` become return values
 * instead of a second parallel piece of state. Resolving with nothing is a
 * clean success. Throwing is a failure.
 */
export type SaveTask = () => Promise<string | void>;

export interface SaveRunOptions {
  /** Copy for a clean success. Defaults to "Saved." */
  savedMessage?: string;
  /** Fallback passed to `friendlyError` when the throw carries no message. */
  errorMessage?: string;
}

export interface SaveStatusApi {
  /** Spread straight into `<SaveStatus {...status} />`. */
  status: SaveStatusValue;
  /** `status.state === "saving"`. For `disabled={busy}` on the save button. */
  busy: boolean;
  /**
   * The form changed, so any previous outcome no longer describes it: back to
   * `idle` from `saved`, `warning`, or `error`. A save in flight is left
   * alone — typing during a save does not mean the save stopped happening.
   *
   * Identity-stable for the life of the hook, so it is safe inside a form
   * setter, in a dependency array, or passed down as a prop. Calling it when
   * already idle does not re-render.
   */
  markDirty: () => void;
  markSaving: () => void;
  markSaved: (message?: string) => void;
  markWarning: (message: string) => void;
  markError: (message: string) => void;
  /**
   * Run a mutation and drive the whole lifecycle from it: `saving` while it is
   * in flight, then `saved` / `warning` / `error`. Never rejects, so
   * `void run(...)` in an onClick can't raise an unhandled rejection. Errors
   * go through `friendlyError` here for the same reason `useAsyncResource`
   * does it internally — the call sites were split between that and a
   * hand-rolled `e instanceof Error ? e.message : fallback`.
   *
   * Amplify's `{ data, errors }` shape doesn't throw, so a task wrapping one
   * should `throw new Error(errors[0].message)` itself.
   */
  run: (task: SaveTask, options?: SaveRunOptions) => Promise<void>;
}

export interface SaveStatusOptions {
  /**
   * Milliseconds after which `saved` returns to `idle`. **Off by default.**
   *
   * Every existing site is persistent — `saved` survives until the next edit,
   * `notice` and `applied` are never cleared at all — and for a form that is
   * right: the confirmation stops being true when the form goes dirty again,
   * which is a semantic event (`markDirty`), not a temporal one. A timer would
   * hide the confirmation from a user who looked away, and would fire during
   * the next edit rather than because of it.
   *
   * It is opt-in for the mutations that have no form to dirty — delete a
   * building, add a task, upload a document — where nothing would ever clear
   * the message and it would sit there over unrelated work.
   *
   * Only `saved` auto-clears. `warning` and `error` never do: the "generated
   * UNSIGNED" warning is the only place the user is told to sign by hand, and
   * a failure that erases itself is a failure the user never saw.
   */
  autoClearMs?: number;
}

export function useSaveStatus(options: SaveStatusOptions = {}): SaveStatusApi {
  const { autoClearMs = 0 } = options;

  const [status, setStatus] = useState<SaveStatusValue>(IDLE);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoClearRef = useRef(autoClearMs);
  useEffect(() => {
    autoClearRef.current = autoClearMs;
  });

  // Declared before anything that schedules work, so it is torn down last on
  // unmount and `mounted.current` is still true for cleanups that run first.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, []);

  // Monotonic ticket: only the newest run may write. Save buttons are disabled
  // while `busy`, but nothing forces a caller to honour that, and a superseded
  // save resolving late must not stamp "Saved." over the current one.
  const ticket = useRef(0);

  const clearTimer = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  /** The single writer. Every transition goes through here, so the pending
   * auto-clear timer is cancelled exactly once per transition. */
  const apply = useCallback(
    (next: SaveStatusValue) => {
      clearTimer();
      if (!mounted.current) return;
      setStatus(next);
      const ms = autoClearRef.current;
      if (next.state === "saved" && ms > 0) {
        timer.current = setTimeout(() => {
          timer.current = null;
          if (mounted.current) setStatus(IDLE);
        }, ms);
      }
    },
    [clearTimer]
  );

  const markDirty = useCallback(() => {
    clearTimer();
    // Returning the identical value makes React bail out, so wiring this into
    // a form setter costs nothing on the keystrokes where it is already idle.
    setStatus((s) => (s.state === "saving" ? s : IDLE));
  }, [clearTimer]);

  const markSaving = useCallback(() => apply(SAVING), [apply]);
  const markSaved = useCallback(
    (message?: string) => apply({ state: "saved", message }),
    [apply]
  );
  const markWarning = useCallback(
    (message: string) => apply({ state: "warning", message }),
    [apply]
  );
  const markError = useCallback(
    (message: string) => apply({ state: "error", message }),
    [apply]
  );

  const run = useCallback(
    async (task: SaveTask, runOptions: SaveRunOptions = {}): Promise<void> => {
      const id = ++ticket.current;
      apply(SAVING);
      try {
        const warning = await task();
        if (!mounted.current || id !== ticket.current) return;
        if (typeof warning === "string" && warning.trim())
          apply({ state: "warning", message: warning });
        else apply({ state: "saved", message: runOptions.savedMessage });
      } catch (err) {
        if (!mounted.current || id !== ticket.current) return;
        apply({
          state: "error",
          message: friendlyError(
            err,
            runOptions.errorMessage ?? "Save failed — please try again."
          ),
        });
      }
    },
    [apply]
  );

  return useMemo(
    () => ({
      status,
      busy: status.state === "saving",
      markDirty,
      markSaving,
      markSaved,
      markWarning,
      markError,
      run,
    }),
    [status, markDirty, markSaving, markSaved, markWarning, markError, run]
  );
}
