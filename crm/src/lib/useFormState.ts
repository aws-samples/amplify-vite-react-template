import { useCallback, useEffect, useRef, useState } from "react";

/**
 * One form object, one setter, and the two flags that always came with them.
 *
 * Eighteen forms hold edit state, in four shapes: thirteen with one `useState`
 * per field (`CoverageForm` peaks at 23), four with a single object behind a
 * curried `set(k)` typed `(e: {target:{value:string}})`, and one —
 * `PropertyPanel`'s `setF` — with a single object behind a generically-typed
 * setter. This hook is that last shape, extracted.
 *
 * The curried shape is the one worth naming, because its type is the bug: a
 * setter that only accepts `{target:{value:string}}` cannot express a checkbox,
 * a chip list, or an autocomplete's multi-field fill, so every such field grows
 * a bespoke inline closure — five of them in `CarrierDetail` alone, each one
 * re-typing `setSaved(false); setForm(f => ({...f, k: v}))` by hand. Seven of
 * those `setSaved(false)` calls exist only because the setter forgot to do it.
 * Here that is structurally impossible: `form` and `saved` live in one state
 * object, and every mutation writes both in a single update. There is no way
 * to change a field and leave `saved` true, because there is no separate
 * `saved` setter to forget.
 *
 * What this deliberately does *not* do:
 *
 *  - **No validation.** A separate primitive owns validators. This hook never
 *    inspects a value, so it can hold a half-typed year without complaint.
 *  - **No null/empty-string coercion.** `T` is exactly what the inputs render
 *    — which in this codebase means every numeric is a string (see the audit on
 *    `string` holding structured data). Seeding (`?? ""`, `?.toString() ?? ""`)
 *    and writing back (`.trim() || null`, `x ? Number(x) : null`, or NewLead's
 *    `|| undefined`) are per-field decisions that depend on the column's
 *    nullability *and* on Amplify's update semantics, where `undefined` is a
 *    no-op and `null` clears. A generic `T` cannot pick between four coercions
 *    per key without a per-field schema, and guessing would be worse than the
 *    duplication it replaced. That boundary belongs to a codec that produces
 *    `initial` and consumes `form`; this hook is what sits between them, and
 *    stays out of the way of one.
 *
 * `initial` is read once, like `useState`'s. It is not re-applied when its
 * identity changes: callers build it as an object literal from props, so it is
 * a fresh object on every render, and re-seeding on identity would erase what
 * the user is typing every time the parent re-rendered. Forms that switch
 * subject already remount by `key` (`CoverageForm`, `GuideForm`) or mount only
 * after their record loads (`AccountDetail`, `CarrierDetail` both return early
 * while the record is null). Where a re-seed really is wanted, `reset(next)`
 * says so out loud.
 */
export interface FormState<T extends object> {
  /** Current field values — exactly the shape `initial` had. */
  form: T;
  /**
   * Set one field. Accepts a value or an updater, so a chip-list toggle
   * (`setF("lines", ls => ...)`) needs no closure over the render's `form`.
   * Clears `saved`. Identity-stable.
   *
   * Field values must be data, not functions: a function value is read as an
   * updater. No form in this codebase stores a callback in its state.
   */
  setF: <K extends keyof T>(key: K, value: T[K] | ((prev: T[K]) => T[K])) => void;
  /**
   * Set several fields in one update — an address autocomplete filling
   * street/city/state/zip, or picking a carrier and defaulting its commission.
   * Takes a partial or an updater returning one. Clears `saved`.
   * Identity-stable.
   */
  patch: (fields: Partial<T> | ((prev: T) => Partial<T>)) => void;
  /**
   * Any field differs from the baseline, compared **by value**: typing into a
   * field and typing the original back leaves `dirty` false, because there is
   * then nothing to save. Arrays compare element-wise (so
   * select-all-then-clear on `states` settles back to clean); anything deeper
   * compares by reference and will read dirty after an immutable replacement.
   * Recomputed per render, O(fields).
   */
  dirty: boolean;
  /**
   * A save landed and nothing has been touched since — the flag behind the
   * "Saved." tick. Only `markSaved()` sets it; every mutation clears it.
   */
  saved: boolean;
  /**
   * Record a successful save: sets `saved`, and moves the baseline to the
   * current values so `dirty` goes false and later edits are measured against
   * what was actually persisted. Identity-stable.
   */
  markSaved: () => void;
  /**
   * Return the form to its baseline — the seed values, or the values as of the
   * last `markSaved()` — clearing `dirty` and `saved`. This is the replacement
   * for the field-by-field setter cascades that clear an add-a-row sub-form
   * after a create (`AccountDetail`, `PropertyPanel`, `ContactForm`,
   * `CoverageCalculator`), which remount-by-`key` cannot serve without the
   * parent inventing a key counter.
   *
   * Pass `next` to re-seed to different values and make *those* the baseline —
   * the only way `initial` is ever re-applied. Note the ordering for a
   * create-then-clear form: `reset()` before `markSaved()`, or the baseline has
   * already moved to the values you meant to clear.
   *
   * Identity-stable.
   */
  reset: (next?: T) => void;
}

/**
 * True when two field values are indistinguishable to the UI. `Object.is`
 * plus one level of array element compare — enough for the string, boolean and
 * `string[]` fields these forms actually hold, and honest about the rest.
 */
function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  }
  return false;
}

interface Internal<T> {
  form: T;
  /** What `dirty` is measured against and what `reset()` returns to. */
  baseline: T;
  saved: boolean;
}

export interface FormStateOptions {
  /**
   * Called after every mutation (`setF`, `patch`, `reset`) — the extension
   * point for a form whose "Saved." indicator lives somewhere richer than the
   * `saved` boolean here, e.g. a save-status state machine that also owns
   * `saving`/`warning`/`error`. Wiring it once at the `useFormState` call is
   * the same guarantee `saved` gets: one place to put it, no per-field call to
   * forget. Read from a ref, so it may be a fresh closure each render.
   */
  onEdit?: () => void;
}

export function useFormState<T extends object>(
  initial: T | (() => T),
  options: FormStateOptions = {}
): FormState<T> {
  const [state, setState] = useState<Internal<T>>(() => {
    // Captured once, on mount, so `initial`'s identity churn is invisible from
    // here — see the note on the interface.
    const seed = typeof initial === "function" ? (initial as () => T)() : initial;
    return { form: seed, baseline: seed, saved: false };
  });

  // The callback closes over the caller's props, so it is a different function
  // every render; the ref is what lets the setters below keep one identity.
  // It is invoked outside the state updater, which must stay pure.
  const onEditRef = useRef(options.onEdit);
  useEffect(() => {
    onEditRef.current = options.onEdit;
  });

  const setF = useCallback(
    <K extends keyof T>(key: K, value: T[K] | ((prev: T[K]) => T[K])) => {
      onEditRef.current?.();
      setState((s) => ({
        ...s,
        form: {
          ...s.form,
          [key]:
            typeof value === "function"
              ? (value as (prev: T[K]) => T[K])(s.form[key])
              : value,
        },
        saved: false,
      }));
    },
    []
  );

  const patch = useCallback((fields: Partial<T> | ((prev: T) => Partial<T>)) => {
    onEditRef.current?.();
    setState((s) => ({
      ...s,
      form: { ...s.form, ...(typeof fields === "function" ? fields(s.form) : fields) },
      saved: false,
    }));
  }, []);

  const markSaved = useCallback(() => {
    setState((s) => ({ form: s.form, baseline: s.form, saved: true }));
  }, []);

  const reset = useCallback((next?: T) => {
    onEditRef.current?.();
    setState((s) => {
      const seed = next ?? s.baseline;
      return { form: seed, baseline: seed, saved: false };
    });
  }, []);

  const { form, baseline, saved } = state;
  const dirty = (Object.keys(form) as (keyof T)[]).some(
    (k) => !sameValue(form[k], baseline[k])
  );

  return { form, setF, patch, dirty, saved, markSaved, reset };
}
