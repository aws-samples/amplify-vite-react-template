/**
 * Route chunks that survive a deploy.
 *
 * Pages are code-split, so the running app fetches each route's JS on demand
 * using the hashed filenames baked into the index.html it booted from. Ship a
 * new build and those files are replaced: every hash changes, and the old ones
 * stop existing. Any session already open is now holding a list of URLs that
 * 404 — and the next route it navigates to fails to load.
 *
 * That was observed on staging as a BLANK WHITE PAGE at /book: the customer had
 * a priced quote, pressed "Continue to booking", and got nothing at all. React
 * has no error boundary between a rejected `lazy()` import and the root, so the
 * whole tree — header and footer included — unmounted. The worst possible place
 * for it (checkout) and the worst possible presentation (no error, no retry,
 * nothing to click).
 *
 * The fix is a reload, because the reload is what fetches the new index.html
 * and with it the new hashes. Done ONCE per session and only for a genuine
 * fetch failure, so a module that throws while evaluating — a real bug, which
 * reloading cannot fix — still reaches the error boundary instead of putting
 * the page in a refresh loop.
 */
import { lazy, type ComponentType } from "react";

/** Set immediately before a recovery reload, cleared on the next chunk that
 *  loads cleanly. sessionStorage (not local) so it dies with the tab. */
const RELOAD_FLAG = "bk:chunk-reload";

/** Storage is unavailable in some privacy modes, and throwing here would turn
 *  a recoverable chunk error into the blank page we are fixing. */
function readFlag(): boolean {
  try {
    return window.sessionStorage.getItem(RELOAD_FLAG) !== null;
  } catch {
    // Can't remember whether we already reloaded ⇒ assume we did. Refusing to
    // reload shows an honest error; reloading blindly could loop forever.
    return true;
  }
}

function writeFlag(): void {
  try {
    window.sessionStorage.setItem(RELOAD_FLAG, "1");
  } catch {
    /* best-effort */
  }
}

function clearFlag(): void {
  try {
    window.sessionStorage.removeItem(RELOAD_FLAG);
  } catch {
    /* best-effort */
  }
}

/**
 * Whether this rejection is "the file isn't there", as opposed to the module
 * having thrown. Browsers word it differently and none of them use an error
 * code, so the message is all there is: Chrome/Firefox say "Failed to fetch
 * dynamically imported module", Safari "Importing a module script failed".
 */
export function isChunkLoadError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed|failed to load module script/i.test(
    message
  );
}

/**
 * The whole policy, as a decision: reload once for a chunk that isn't there,
 * otherwise let the error reach the boundary. Separated from the promise
 * plumbing so the rule that decides whether a customer sees a reload or an
 * error page is testable without a DOM.
 */
export function chunkRecovery(
  error: unknown,
  alreadyReloaded: boolean
): "reload" | "rethrow" {
  if (!isChunkLoadError(error)) return "rethrow"; // a real bug; reloading repeats it
  return alreadyReloaded ? "rethrow" : "reload";
}

/**
 * `React.lazy`, plus one automatic recovery from a stale-deploy chunk 404.
 *
 * Drop-in: every route in App.tsx uses this instead of `lazy` directly, so a
 * new page cannot forget to opt in.
 */
export default function lazyPage<
  // Mirrors React.lazy's own constraint so this stays a drop-in replacement;
  // narrowing the props type here only makes valid page components unassignable.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  T extends ComponentType<any>,
>(factory: () => Promise<{ default: T }>) {
  return lazy(() =>
    factory().then(
      (mod) => {
        // A chunk loaded, so whatever went wrong is behind us and the next
        // stale-deploy failure deserves its own reload.
        clearFlag();
        return mod;
      },
      (error: unknown) => {
        if (chunkRecovery(error, readFlag()) === "rethrow") throw error;
        writeFlag();
        // Discards no work: the page is mid-navigation with nothing rendered.
        window.location.reload();
        // Never settles — the document is being torn down, and resolving would
        // flash an error the reload is about to make irrelevant.
        return new Promise<{ default: T }>(() => {});
      }
    )
  );
}
