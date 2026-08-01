import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAsyncResource } from "./useAsyncResource";

/** A promise whose settlement the test controls, so "in flight" is a real state. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Nothing here rejects unobserved — every test either settles it and awaits
  // the hook, or asserts on the hook's captured error.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

/** Serves a queued promise per call, so successive fetches can be interleaved. */
function queuedFetcher<T>(...promises: Promise<T>[]) {
  let i = 0;
  return () => promises[Math.min(i++, promises.length - 1)];
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useAsyncResource", () => {
  describe("happy path", () => {
    it("fetches on mount and exposes the result", async () => {
      const d = deferred<string[]>();
      const { result } = renderHook(() =>
        useAsyncResource(() => d.promise, [], { initialData: [] as string[] })
      );

      expect(result.current.data).toEqual([]);
      expect(result.current.loading).toBe(true);
      expect(result.current.loaded).toBe(false);
      expect(result.current.error).toBe("");

      await act(async () => {
        d.resolve(["a", "b"]);
      });

      expect(result.current.data).toEqual(["a", "b"]);
      expect(result.current.loading).toBe(false);
      expect(result.current.loaded).toBe(true);
      expect(result.current.error).toBe("");
    });

    it("leaves data undefined when no initialData is given", async () => {
      const { result } = renderHook(() => useAsyncResource(async () => 42, []));
      expect(result.current.data).toBeUndefined();
      await act(async () => {});
      expect(result.current.data).toBe(42);
    });

    it("calls the fetcher exactly once on mount", async () => {
      const fetcher = vi.fn(async () => "x");
      renderHook(() => useAsyncResource(fetcher, []));
      await act(async () => {});
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
  });

  describe("error path", () => {
    it("captures a throw as an error string and stops loading", async () => {
      const d = deferred<string[]>();
      const { result } = renderHook(() =>
        useAsyncResource(() => d.promise, [], { initialData: [] as string[] })
      );

      expect(result.current.loading).toBe(true);

      await act(async () => {
        d.reject(new Error("boom"));
      });

      // The Licensing bug: loading must not stay stuck true on a throw.
      expect(result.current.loading).toBe(false);
      expect(result.current.loaded).toBe(true);
      expect(result.current.error).toBe("boom");
      // The AccountsList bug: a failed read is distinguishable from an empty one.
      expect(result.current.data).toEqual([]);
    });

    it("normalizes the error through friendlyError", async () => {
      const { result } = renderHook(() =>
        useAsyncResource(async () => {
          throw new Error("Not Authorized to access listAccounts");
        }, [])
      );
      await act(async () => {});
      expect(result.current.error).toBe("You don't have permission to do that.");
    });

    it("falls back to errorMessage when the thrown value has no message", async () => {
      const { result } = renderHook(() =>
        useAsyncResource(
          async () => {
            throw new Error("");
          },
          [],
          { errorMessage: "Failed to load licenses" }
        )
      );
      await act(async () => {});
      expect(result.current.error).toBe("Failed to load licenses");
    });

    it("refetch resolves rather than rejecting when the fetcher throws", async () => {
      // The QuotesPanel bug: `refresh()` had no `.catch()`, so a fire-and-forget
      // call raised an unhandled rejection.
      const { result } = renderHook(() =>
        useAsyncResource(
          async () => {
            throw new Error("nope");
          },
          [],
          { manual: true }
        )
      );

      let settled: unknown = "not settled";
      await act(async () => {
        settled = await result.current.refetch();
      });

      expect(settled).toBeUndefined();
      expect(result.current.error).toBe("nope");
    });

    it("keeps the last good data when a refetch fails", async () => {
      const first = deferred<string>();
      const second = deferred<string>();
      const fetcher = queuedFetcher(first.promise, second.promise);
      const { result } = renderHook(() => useAsyncResource(fetcher, []));

      await act(async () => {
        first.resolve("good");
      });
      act(() => {
        void result.current.refetch();
      });
      await act(async () => {
        second.reject(new Error("later failure"));
      });

      expect(result.current.data).toBe("good");
      expect(result.current.error).toBe("later failure");
      expect(result.current.loading).toBe(false);
    });
  });

  describe("refetch", () => {
    it("re-runs the fetcher and replaces the data", async () => {
      const first = deferred<string>();
      const second = deferred<string>();
      const fetcher = queuedFetcher(first.promise, second.promise);
      const { result } = renderHook(() => useAsyncResource(fetcher, []));

      await act(async () => {
        first.resolve("one");
      });
      expect(result.current.data).toBe("one");

      act(() => {
        void result.current.refetch();
      });
      expect(result.current.loading).toBe(true);
      // Data-during-refetch: the previous rows stay on screen.
      expect(result.current.data).toBe("one");

      await act(async () => {
        second.resolve("two");
      });
      expect(result.current.data).toBe("two");
      expect(result.current.loading).toBe(false);
    });

    it("clears a previous error once a refetch succeeds", async () => {
      const first = deferred<string>();
      const second = deferred<string>();
      const fetcher = queuedFetcher(first.promise, second.promise);
      const { result } = renderHook(() => useAsyncResource(fetcher, []));

      await act(async () => {
        first.reject(new Error("transient"));
      });
      expect(result.current.error).toBe("transient");

      act(() => {
        void result.current.refetch();
      });
      expect(result.current.error).toBe("");

      await act(async () => {
        second.resolve("recovered");
      });
      expect(result.current.error).toBe("");
      expect(result.current.data).toBe("recovered");
    });

    it("keeps one identity across renders, so it is safe as a prop", async () => {
      const { result, rerender } = renderHook(
        ({ n }: { n: number }) => useAsyncResource(async () => n, []),
        { initialProps: { n: 1 } }
      );
      await act(async () => {});
      const before = result.current.refetch;
      rerender({ n: 2 });
      rerender({ n: 3 });
      expect(result.current.refetch).toBe(before);
    });

    it("calls the fetcher from the current render, not the one it was created in", async () => {
      const { result, rerender } = renderHook(
        ({ n }: { n: number }) => useAsyncResource(async () => n, [], { manual: true }),
        { initialProps: { n: 1 } }
      );
      rerender({ n: 7 });
      await act(async () => {
        await result.current.refetch();
      });
      expect(result.current.data).toBe(7);
    });
  });

  describe("manual mode", () => {
    it("does not fetch on mount and starts idle", async () => {
      const fetcher = vi.fn(async () => "searched");
      const { result } = renderHook(() =>
        useAsyncResource(fetcher, [], { manual: true })
      );

      await act(async () => {});
      expect(fetcher).not.toHaveBeenCalled();
      expect(result.current.loading).toBe(false);
      expect(result.current.loaded).toBe(false);
      expect(result.current.data).toBeUndefined();

      await act(async () => {
        await result.current.refetch();
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(result.current.data).toBe("searched");
      expect(result.current.loaded).toBe(true);
    });
  });

  describe("deps", () => {
    it("refetches and drops the previous resource's data when deps change", async () => {
      const a = deferred<string>();
      const b = deferred<string>();
      const fetcher = queuedFetcher(a.promise, b.promise);
      const { result, rerender } = renderHook(
        ({ id }: { id: string }) => useAsyncResource(fetcher, [id], { initialData: "" }),
        { initialProps: { id: "acct-1" } }
      );

      await act(async () => {
        a.resolve("quotes for acct-1");
      });
      expect(result.current.data).toBe("quotes for acct-1");

      expect(result.current.loaded).toBe(true);

      rerender({ id: "acct-2" });
      // Not a refresh of the same resource — a different one. The old rows
      // must not sit under the new heading, and `!loaded` must re-arm so the
      // caller shows its loader rather than "none found".
      expect(result.current.data).toBe("");
      expect(result.current.loading).toBe(true);
      expect(result.current.loaded).toBe(false);

      await act(async () => {
        b.resolve("quotes for acct-2");
      });
      expect(result.current.data).toBe("quotes for acct-2");
      expect(result.current.loaded).toBe(true);
    });

    it("keeps loaded true across a refetch of the same resource", async () => {
      const first = deferred<string>();
      const second = deferred<string>();
      const fetcher = queuedFetcher(first.promise, second.promise);
      const { result } = renderHook(() => useAsyncResource(fetcher, []));

      await act(async () => {
        first.resolve("one");
      });
      act(() => {
        void result.current.refetch();
      });
      // A refresh is not a reset: the caller's placeholder must not flash.
      expect(result.current.loaded).toBe(true);
      expect(result.current.data).toBe("one");

      await act(async () => {
        second.resolve("two");
      });
      expect(result.current.loaded).toBe(true);
    });

    it("does not refetch when deps are unchanged", async () => {
      const fetcher = vi.fn(async () => "x");
      const { rerender } = renderHook(
        ({ id }: { id: string }) => useAsyncResource(fetcher, [id]),
        { initialProps: { id: "same" } }
      );
      await act(async () => {});
      rerender({ id: "same" });
      rerender({ id: "same" });
      await act(async () => {});
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
  });

  describe("ordering and lifetime", () => {
    it("does not let a slow first response overwrite a fast second one", async () => {
      const slow = deferred<string>();
      const fast = deferred<string>();
      const fetcher = queuedFetcher(slow.promise, fast.promise);
      const { result } = renderHook(() =>
        useAsyncResource(fetcher, [], { manual: true })
      );

      act(() => {
        void result.current.refetch(); // slow
        void result.current.refetch(); // fast, supersedes it
      });

      await act(async () => {
        fast.resolve("second");
      });
      expect(result.current.data).toBe("second");
      expect(result.current.loading).toBe(false);

      await act(async () => {
        slow.resolve("first");
      });
      expect(result.current.data).toBe("second");
      expect(result.current.loading).toBe(false);
    });

    it("does not let a superseded failure clobber a successful newer response", async () => {
      const slow = deferred<string>();
      const fast = deferred<string>();
      const fetcher = queuedFetcher(slow.promise, fast.promise);
      const { result } = renderHook(() =>
        useAsyncResource(fetcher, [], { manual: true })
      );

      act(() => {
        void result.current.refetch();
        void result.current.refetch();
      });
      await act(async () => {
        fast.resolve("second");
      });
      await act(async () => {
        slow.reject(new Error("stale failure"));
      });

      expect(result.current.error).toBe("");
      expect(result.current.data).toBe("second");
    });

    // Caveat on the two tests below: React 18 dropped the "state update on an
    // unmounted component" warning and silently discards the write, so the
    // hook's `mounted` guard has NO black-box observable — these tests pass
    // with the guard deleted (verified by mutation). They pin the contract
    // that survives (settling after unmount is quiet and harmless, and a
    // rejection never escapes as an unhandled one); the guard itself is what
    // keeps that true if React ever reinstates the warning, and it is asserted
    // by inspection, not here.
    it("resolving after an unmount is quiet and leaves the last state alone", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      const d = deferred<string>();
      const { result, unmount } = renderHook(() =>
        useAsyncResource(() => d.promise, [])
      );

      expect(result.current.loading).toBe(true);
      unmount();
      d.resolve("arrived too late");
      await act(async () => {
        await d.promise;
      });

      expect(spy).not.toHaveBeenCalled();
      expect(result.current.data).toBeUndefined();
      expect(result.current.loading).toBe(true);
    });

    it("a rejection landing after unmount never escapes as unhandled", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      const unhandled: unknown[] = [];
      const onUnhandled = (e: PromiseRejectionEvent) => unhandled.push(e.reason);
      window.addEventListener("unhandledrejection", onUnhandled);
      try {
        const d = deferred<string>();
        const { unmount } = renderHook(() => useAsyncResource(() => d.promise, []));

        unmount();
        d.reject(new Error("late boom"));
        await act(async () => {
          await new Promise((r) => setTimeout(r, 0));
        });

        expect(unhandled).toEqual([]);
        expect(spy).not.toHaveBeenCalled();
      } finally {
        window.removeEventListener("unhandledrejection", onUnhandled);
      }
    });
  });

  describe("setData", () => {
    it("patches the cache locally without a refetch", async () => {
      const fetcher = vi.fn(async () => [{ id: "p1", status: "ACTIVE" }]);
      const { result } = renderHook(() =>
        useAsyncResource(fetcher, [], {
          initialData: [] as { id: string; status: string }[],
        })
      );
      await act(async () => {});

      act(() => {
        result.current.setData((rows) =>
          rows.map((r) => (r.id === "p1" ? { ...r, status: "CANCELLED" } : r))
        );
      });

      expect(result.current.data).toEqual([{ id: "p1", status: "CANCELLED" }]);
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
  });
});
