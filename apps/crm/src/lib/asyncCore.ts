/**
 * The framework-free core behind `useAsync` / `useAction`.
 *
 * The logic worth testing here is not React — it is "which response is allowed
 * to write state" and "can this action run twice". Both are plain state
 * machines, so they live outside the hooks and are unit-tested in the same
 * node environment as the rest of the suite. `useAsync.ts` is a thin wrapper
 * that wires these to `useState`.
 */

/** Turn an unknown thrown value into something worth showing a person.
 *  `fallback` covers throws that carry no usable message — never
 *  `String(err)`, which renders "[object Object]" at people. */
export function toMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message.trim()) return err.message;
  if (typeof err === "string" && err.trim()) return err;
  return fallback;
}

export type RequestGuard = {
  /** Start a request; returns a predicate that is true only while this is
   *  still the newest one and the owner is alive. */
  begin: () => () => boolean;
  /** Owner went away (unmount). Every outstanding request becomes stale. */
  dispose: () => void;
};

/**
 * Monotonic request guard.
 *
 * Rapid tab or filter switches must not let a slower older response overwrite
 * the newer one's data — and a request that resolves after the owner is gone
 * is stale by definition. Exactly one screen in the app (office/Customers)
 * hand-rolled this; every `useAsync` caller now gets it.
 */
export function createRequestGuard(): RequestGuard {
  let latest = 0;
  let alive = true;
  return {
    begin() {
      const id = ++latest;
      return () => alive && id === latest;
    },
    dispose() {
      alive = false;
    },
  };
}

/** Where a guarded run reports to. Each is called at most once per run, and
 *  never at all if the run turned out to be stale. */
export type AsyncSink<T> = {
  data: (value: T) => void;
  error: (message: string) => void;
  settled: () => void;
};

/**
 * Run `load`, reporting to `sink` only while `isCurrent()` holds.
 *
 * Never rejects: a failure is reported as a message. `settled` fires on both
 * paths so a caller can clear its busy flag in one place.
 */
export async function runGuarded<T>(
  load: () => Promise<T>,
  isCurrent: () => boolean,
  sink: AsyncSink<T>,
  fallbackMessage: string
): Promise<void> {
  try {
    const value = await load();
    if (isCurrent()) sink.data(value);
  } catch (err) {
    if (isCurrent()) sink.error(toMessage(err, fallbackMessage));
  } finally {
    if (isCurrent()) sink.settled();
  }
}

export type SingleFlight = {
  /** True if the caller may proceed; false if a run is already in flight. */
  tryEnter: () => boolean;
  exit: () => void;
  readonly busy: boolean;
};

/**
 * One run at a time.
 *
 * The hand-written version of this relied on a disabled button, which a
 * double-click or a held Enter key can beat — on a charge sheet that is a
 * second charge.
 */
export function createSingleFlight(): SingleFlight {
  let inFlight = false;
  return {
    tryEnter() {
      if (inFlight) return false;
      inFlight = true;
      return true;
    },
    exit() {
      inFlight = false;
    },
    get busy() {
      return inFlight;
    },
  };
}
