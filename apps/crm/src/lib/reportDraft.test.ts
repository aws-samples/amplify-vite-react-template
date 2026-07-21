import { describe, expect, it } from "vitest";
import {
  clearDraft,
  draftKey,
  isConnectivityError,
  isDraftStale,
  loadDraft,
  saveDraft,
  syncBadge,
  type DraftStore,
  type SyncSnapshot,
} from "./reportDraft";

/**
 * R12: the typed report survives a dead battery. The cache must round-trip
 * exactly what was typed, never throw on garbage, admit when the phone can't
 * store, and — via syncBadge — never claim the office has words it doesn't.
 */

function memoryStore(initial: Record<string, string> = {}): DraftStore & {
  data: Record<string, string>;
} {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = v;
    },
    removeItem: (k) => {
      delete data[k];
    },
  };
}

/** A store in a state (quota, private browsing) where nothing works. */
const brokenStore: DraftStore = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
  removeItem: () => {
    throw new Error("SecurityError");
  },
};

describe("saveDraft / loadDraft", () => {
  it("round-trips the typed fields, keyed by jobId", () => {
    const store = memoryStore();
    const fields = {
      servicesPerformed: "Treated baseboards",
      products: [{ name: "Termidor SC", quantity: "2 oz", custom: false }],
      inspectionOnly: false,
    };
    expect(saveDraft("job-1", fields, store)).toBe(true);
    const back = loadDraft<typeof fields>("job-1", store);
    expect(back?.fields).toEqual(fields);
    expect(back?.jobId).toBe("job-1");
  });

  it("stamps savedAt as a parseable timestamp at write time", () => {
    const store = memoryStore();
    const before = Date.now();
    saveDraft("job-1", {}, store);
    const savedAt = Date.parse(loadDraft("job-1", store)!.savedAt);
    expect(savedAt).toBeGreaterThanOrEqual(before);
    expect(savedAt).toBeLessThanOrEqual(Date.now());
  });

  it("keeps jobs' drafts separate", () => {
    const store = memoryStore();
    saveDraft("job-1", { note: "first" }, store);
    saveDraft("job-2", { note: "second" }, store);
    expect(loadDraft<{ note: string }>("job-1", store)?.fields.note).toBe(
      "first"
    );
    expect(loadDraft<{ note: string }>("job-2", store)?.fields.note).toBe(
      "second"
    );
  });

  it("returns false when the phone can't store — the indicator must not lie", () => {
    expect(saveDraft("job-1", {}, brokenStore)).toBe(false);
  });

  it("loads null for a missing draft", () => {
    expect(loadDraft("job-1", memoryStore())).toBeNull();
  });

  it("loads null, never throws, on corrupt or mismatched entries", () => {
    const store = memoryStore({
      [draftKey("corrupt")]: "{not json",
      [draftKey("wrong-job")]: JSON.stringify({
        jobId: "someone-else",
        savedAt: new Date().toISOString(),
        fields: {},
      }),
      [draftKey("no-stamp")]: JSON.stringify({ jobId: "no-stamp", fields: {} }),
      [draftKey("no-fields")]: JSON.stringify({
        jobId: "no-fields",
        savedAt: new Date().toISOString(),
      }),
      [draftKey("null-entry")]: "null",
    });
    for (const id of [
      "corrupt",
      "wrong-job",
      "no-stamp",
      "no-fields",
      "null-entry",
    ]) {
      expect(loadDraft(id, store)).toBeNull();
    }
    expect(loadDraft("anything", brokenStore)).toBeNull();
  });
});

describe("clearDraft", () => {
  it("removes only the one job's draft", () => {
    const store = memoryStore();
    saveDraft("job-1", {}, store);
    saveDraft("job-2", {}, store);
    clearDraft("job-1", store);
    expect(loadDraft("job-1", store)).toBeNull();
    expect(loadDraft("job-2", store)).not.toBeNull();
  });

  it("tolerates a store that throws", () => {
    expect(() => clearDraft("job-1", brokenStore)).not.toThrow();
  });
});

describe("isDraftStale — never restore over a newer office copy", () => {
  const draft = { savedAt: "2026-07-21T12:00:00.000Z" };

  it("is stale when the office copy is newer than the draft", () => {
    // Another device / an office amendment advanced the record after this
    // phone's last local save — the draft must not be restored.
    expect(isDraftStale(draft, "2026-07-21T13:00:00.000Z")).toBe(true);
  });

  it("is NOT stale when the draft is newer (the normal offline case)", () => {
    // The phone has unsent edits later than the last successful send.
    expect(isDraftStale(draft, "2026-07-21T11:00:00.000Z")).toBe(false);
  });

  it("treats an equal timestamp as stale — the server is the record of authority", () => {
    expect(isDraftStale(draft, "2026-07-21T12:00:00.000Z")).toBe(true);
  });

  it("is never stale with no office copy yet (local-only draft still restores)", () => {
    expect(isDraftStale(draft, null)).toBe(false);
    expect(isDraftStale(draft, undefined)).toBe(false);
  });

  it("fails open to not-stale on an unparseable timestamp — a bad clock never drops a draft", () => {
    expect(isDraftStale({ savedAt: "nonsense" }, "2026-07-21T13:00:00.000Z")).toBe(false);
    expect(isDraftStale(draft, "nonsense")).toBe(false);
  });
});

describe("isConnectivityError", () => {
  it("the device knowing it's offline outranks any message", () => {
    expect(isConnectivityError(new Error("Not Authorized"), false)).toBe(true);
  });

  it("matches the browser network-failure family", () => {
    for (const msg of [
      "Failed to fetch",
      "NetworkError when attempting to fetch resource.",
      "Network Error",
      "Load failed", // Safari's fetch rejection
      "The request timed out",
      "Connection refused",
    ]) {
      expect(isConnectivityError(new Error(msg), true)).toBe(true);
    }
  });

  it("a server saying no is not a connectivity problem", () => {
    expect(isConnectivityError(new Error("Not Authorized"), true)).toBe(false);
    expect(
      isConnectivityError(new Error("Report is already finalized"), true)
    ).toBe(false);
  });

  it("handles non-Error throwables without claiming connectivity", () => {
    expect(isConnectivityError("something odd", true)).toBe(false);
    expect(isConnectivityError(undefined, true)).toBe(false);
  });
});

describe("syncBadge — never claims more than is true", () => {
  const base: SyncSnapshot = {
    online: true,
    sending: false,
    dirty: false,
    persisted: true,
    sendFailed: false,
    hasServerCopy: false,
  };

  it("says nothing on a pristine form nobody has saved anywhere", () => {
    expect(syncBadge(base)).toBeNull();
  });

  it("claims 'saved to the office' only when the office has the latest", () => {
    expect(syncBadge({ ...base, hasServerCopy: true })).toEqual({
      label: "Saved to the office",
      tone: "ok",
    });
  });

  it("a server copy plus newer typing is 'this phone', never 'the office'", () => {
    const badge = syncBadge({ ...base, hasServerCopy: true, dirty: true });
    expect(badge?.tone).toBe("muted");
    expect(badge?.label).toContain("this phone");
    expect(badge?.label).not.toBe("Saved to the office");
  });

  it("in-flight send reads as sending, whatever else is true", () => {
    expect(
      syncBadge({ ...base, sending: true, dirty: true, sendFailed: true })
    ).toEqual({ label: "Sending to the office…", tone: "info" });
  });

  it("offline edits promise a retry, not a delivery", () => {
    const badge = syncBadge({ ...base, dirty: true, online: false });
    expect(badge?.tone).toBe("warn");
    expect(badge?.label).toContain("Offline");
    expect(badge?.label).toContain("saved to this phone");
  });

  it("a failed send says the office didn't get it", () => {
    const badge = syncBadge({ ...base, dirty: true, sendFailed: true });
    expect(badge?.tone).toBe("warn");
    expect(badge?.label).toContain("didn't get it");
  });

  it("a phone that can't store drafts says so — the loudest state there is", () => {
    // Even offline: "saved to this phone" would be false, so the storage
    // failure outranks the offline wording.
    const badge = syncBadge({
      ...base,
      dirty: true,
      persisted: false,
      online: false,
    });
    expect(badge?.tone).toBe("danger");
    expect(badge?.label).toContain("Not saved");
  });
});
