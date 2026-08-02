import { useCallback, useEffect, useRef, useState } from "react";
import {
  createRequestGuard,
  createSingleFlight,
  runGuarded,
  toMessage,
} from "./asyncCore";

/**
 * The two hooks every screen in this app was hand-rolling.
 *
 * There were ~78 `const [error, setError] = useState<string | null>(null)`
 * declarations across ~45 files (13 in CustomerDetail alone), 52 busy flags,
 * 48 `finally` blocks and 94 `err instanceof Error ? …` ternaries — all
 * spelling the same load-or-act shape by hand.
 *
 * Copying it that many times meant the FIXES did not travel. Exactly one of
 * ~25 list screens (office/Customers.tsx) guarded against a stale response
 * overwriting a newer one; the comment there explains the bug, and nobody
 * else adopted it. That guard now lives in `asyncCore.ts` and every caller
 * gets it.
 *
 * These are deliberately thin: the logic worth testing is in `asyncCore`,
 * which is framework-free and unit-tested in the same node environment as
 * everything else here.
 */

export { toMessage } from "./asyncCore";

export type AsyncState<T> = {
  /** `null` until the first load resolves — the app's established "still
   *  loading" signal, which the existing Spinner-vs-content branches read. */
  data: T | null;
  loading: boolean;
  error: string | null;
  /** Re-run the loader. Safe to pass straight to onClick. */
  reload: () => void;
  /** Update in place after a mutation, instead of a full refetch. */
  setData: (next: T | null) => void;
};

/**
 * Load when `deps` change, with the stale-response guard applied.
 *
 * `deps` is the dependency array for the loader, exactly like `useEffect`.
 * `fallbackMessage` is the error text when the failure carries none.
 */
export function useAsync<T>(
  load: () => Promise<T>,
  deps: unknown[],
  fallbackMessage = "Could not load"
): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const guardRef = useRef(createRequestGuard());
  useEffect(() => {
    const guard = guardRef.current;
    return () => guard.dispose();
  }, []);

  // Read from the latest render rather than from `deps`: callers write the
  // loader inline, so depending on its identity would re-run every render.
  const loadRef = useRef(load);
  loadRef.current = load;

  const run = useCallback(() => {
    const isCurrent = guardRef.current.begin();
    setError(null);
    setLoading(true);
    void runGuarded(
      () => loadRef.current(),
      isCurrent,
      {
        data: setData,
        error: setError,
        settled: () => setLoading(false),
      },
      fallbackMessage
    );
  }, [fallbackMessage]);

  useEffect(() => {
    // Clear stale rows so the caller shows its spinner rather than the
    // previous selection's data while the new one is in flight.
    setData(null);
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, loading, error, reload: run, setData };
}

export type ActionState<A extends unknown[]> = {
  /** Runs the action. Resolves `true` on success, `false` if it threw or was
   *  refused as a double-submit — so a caller can close a sheet only when the
   *  write actually landed. Never rejects: the message is in `error`. */
  run: (...args: A) => Promise<boolean>;
  busy: boolean;
  error: string | null;
  clearError: () => void;
};

/** A mutation: busy flag, captured error, and no double-submit. */
export function useAction<A extends unknown[]>(
  action: (...args: A) => Promise<unknown>,
  fallbackMessage = "Could not save"
): ActionState<A> {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const gateRef = useRef(createSingleFlight());
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const actionRef = useRef(action);
  actionRef.current = action;

  const run = useCallback(
    async (...args: A): Promise<boolean> => {
      if (!gateRef.current.tryEnter()) return false;
      setBusy(true);
      setError(null);
      try {
        await actionRef.current(...args);
        return true;
      } catch (err) {
        if (aliveRef.current) setError(toMessage(err, fallbackMessage));
        return false;
      } finally {
        gateRef.current.exit();
        if (aliveRef.current) setBusy(false);
      }
    },
    [fallbackMessage]
  );

  return { run, busy, error, clearError: useCallback(() => setError(null), []) };
}
