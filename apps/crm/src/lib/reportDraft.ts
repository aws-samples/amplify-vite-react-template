/**
 * Local draft cache for the technician's service report (R12).
 *
 * The typed report used to live only in React state: a dead battery or a
 * dropped connection ate the whole thing, and a tech who loses work twice
 * starts writing reports at night — night-written pesticide records carry
 * wrong times. Every edit is mirrored here (localStorage, keyed by jobId),
 * restored on mount when it says anything the office's copy doesn't, and
 * cleared the moment the office verifiably has it.
 *
 * The sync words are the other half: the indicator must never say more than
 * is true (rule 2). "Saved to this phone" and "saved to the office" are
 * different facts and get different words — and a phone that can't store
 * drafts says so instead of pretending.
 */

/** The subset of Storage the cache needs — injectable so tests mock it. */
export type DraftStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const KEY_PREFIX = "bk-report-draft-";

/**
 * GL-13: drafts are bound to the signed-in identity. The key carries the
 * owner's sub, and the payload records it — so after a reassignment or
 * deactivation, a different login on the same device can never restore another
 * person's report words, and a purge can target everything at once.
 */
export function draftKey(jobId: string, ownerSub?: string | null): string {
  return ownerSub ? `${KEY_PREFIX}${ownerSub}-${jobId}` : KEY_PREFIX + jobId;
}

export type ReportDraft<F> = {
  jobId: string;
  /** The signed-in user the draft belongs to (GL-13). */
  ownerSub?: string | null;
  /** When the tech last typed (ISO) — compared against the server copy's updatedAt. */
  savedAt: string;
  fields: F;
};

/**
 * Mirror the form to durable storage. Returns false when the write failed
 * (quota, private browsing) — the caller's indicator must then stop claiming
 * "saved to this phone", because it isn't.
 */
export function saveDraft<F>(
  jobId: string,
  fields: F,
  store: DraftStore = localStorage,
  ownerSub?: string | null
): boolean {
  const draft: ReportDraft<F> = {
    jobId,
    ownerSub: ownerSub ?? null,
    savedAt: new Date().toISOString(),
    fields,
  };
  try {
    store.setItem(draftKey(jobId, ownerSub), JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

/** Read a draft back; anything missing, corrupt, or mislabeled is null, never a throw. */
export function loadDraft<F>(
  jobId: string,
  store: DraftStore = localStorage,
  ownerSub?: string | null
): ReportDraft<F> | null {
  try {
    // Owner-keyed first; the legacy unkeyed slot is honored only when it
    // carries no other owner's sub (pre-GL-13 drafts had none).
    const raw =
      store.getItem(draftKey(jobId, ownerSub)) ?? store.getItem(draftKey(jobId));
    if (!raw) return null;
    const v: unknown = JSON.parse(raw);
    if (
      !v ||
      typeof v !== "object" ||
      (v as ReportDraft<F>).jobId !== jobId ||
      typeof (v as ReportDraft<F>).savedAt !== "string" ||
      !("fields" in v)
    ) {
      return null;
    }
    const owner = (v as ReportDraft<F>).ownerSub ?? null;
    // Another login's draft is unreadable here — GL-13.
    if (owner && ownerSub && owner !== ownerSub) return null;
    return v as ReportDraft<F>;
  } catch {
    return null;
  }
}

export function clearDraft(
  jobId: string,
  store: DraftStore = localStorage,
  ownerSub?: string | null
): void {
  try {
    store.removeItem(draftKey(jobId, ownerSub));
    store.removeItem(draftKey(jobId));
  } catch {
    /* a failed clear only means a stale draft that loses the newer-than check */
  }
}

/**
 * GL-13 — render every cached draft unreadable at once: on sign-out, and when
 * the server says the caller's field access ended (reassignment/deactivation).
 * Works on any Storage-shaped store that also exposes key/length (localStorage
 * does); silently does nothing where enumeration is unavailable.
 */
export function clearAllDrafts(store: Storage = localStorage): void {
  try {
    const doomed: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (k && k.startsWith(KEY_PREFIX)) doomed.push(k);
    }
    for (const k of doomed) store.removeItem(k);
  } catch {
    /* best effort — the owner-keying still prevents cross-login reads */
  }
}

/**
 * Is this failure the connection's fault (keep the draft, offer retry) or the
 * server telling us no (show the real error)? Browser network failures have
 * no reliable shape — fetch rejects with a TypeError whose message varies by
 * engine — so this matches the known family, plus the device knowing it's
 * offline, which outranks any message.
 */
export function isConnectivityError(
  err: unknown,
  online: boolean = typeof navigator === "undefined" ? true : navigator.onLine
): boolean {
  if (!online) return true;
  const msg =
    err instanceof Error ? `${err.name}: ${err.message}` : String(err ?? "");
  return /network|failed to fetch|load failed|timed?\s?out|offline|connection/i.test(
    msg
  );
}

/** Matches BadgeTone in ui/kit — kept as a plain union so this module stays UI-free. */
export type SyncTone = "ok" | "warn" | "danger" | "muted" | "info";

export type SyncSnapshot = {
  /** navigator.onLine as tracked by the screen. */
  online: boolean;
  /** A save or finalize is in flight right now. */
  sending: boolean;
  /** Edits exist that the office has not confirmed received. */
  dirty: boolean;
  /** Those edits made it into this phone's storage. */
  persisted: boolean;
  /** The last send attempt failed on connectivity. */
  sendFailed: boolean;
  /** The office holds some saved version of this report. */
  hasServerCopy: boolean;
};

/**
 * The one honest sentence about where the report currently lives.
 * Null means there is nothing to claim (pristine form, nothing anywhere).
 */
export function syncBadge(
  s: SyncSnapshot
): { label: string; tone: SyncTone } | null {
  if (s.sending) return { label: "Sending to the office…", tone: "info" };
  if (!s.dirty) {
    return s.hasServerCopy
      ? { label: "Saved to the office", tone: "ok" }
      : null;
  }
  // Dirty from here down — the office does not have the latest words.
  if (!s.persisted) {
    return {
      label:
        "Not saved — this phone can't store drafts. Don't leave this page.",
      tone: "danger",
    };
  }
  if (!s.online) {
    return {
      label: "Offline — saved to this phone. Will send when signal returns.",
      tone: "warn",
    };
  }
  if (s.sendFailed) {
    return {
      label:
        "Saved to this phone — the office didn't get it yet. Tap Save to retry.",
      tone: "warn",
    };
  }
  return {
    label: "Saved to this phone — not yet sent to the office.",
    tone: "muted",
  };
}
