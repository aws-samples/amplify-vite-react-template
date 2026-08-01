import { useState } from "react";
import { act, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SaveStatus,
  useSaveStatus,
  type SaveStatusValue,
} from "./SaveStatus";

/** A promise whose settlement the test controls, so "in flight" is a real state. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Every test either settles this and awaits the hook, or asserts on the
  // error the hook captured — nothing rejects unobserved.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("<SaveStatus>", () => {
  describe("the five states render distinguishably", () => {
    it("renders nothing at all for idle", () => {
      const { container } = render(<SaveStatus state="idle" />);
      expect(container).toBeEmptyDOMElement();
    });

    it("gives each visible state its own data-save-state and copy", () => {
      const cases: SaveStatusValue[] = [
        { state: "saving" },
        { state: "saved" },
        { state: "warning", message: "Generated UNSIGNED." },
        { state: "error", message: "Save failed: network." },
      ];
      const seen = cases.map((value) => {
        const { container, unmount } = render(<SaveStatus {...value} />);
        const el = container.firstElementChild as HTMLElement;
        const snapshot = {
          state: el.getAttribute("data-save-state"),
          role: el.getAttribute("role"),
          text: el.textContent,
        };
        unmount();
        return snapshot;
      });

      expect(seen.map((s) => s.state)).toEqual([
        "saving",
        "saved",
        "warning",
        "error",
      ]);
      // Four distinct strings: no two states read the same.
      expect(new Set(seen.map((s) => s.text)).size).toBe(4);
      expect(seen.every((s) => (s.text ?? "").trim().length > 0)).toBe(true);
    });

    it("colors saved green and warning amber from the stylesheet's vars", () => {
      const { unmount } = render(<SaveStatus state="saved" />);
      expect(screen.getByRole("status")).toHaveStyle({ color: "var(--green)" });
      unmount();

      render(<SaveStatus state="warning" message="Partly done." />);
      expect(screen.getByRole("status")).toHaveStyle({ color: "var(--amber)" });
    });

    it("renders the error with the repo's red .error-text class, as an alert", () => {
      render(<SaveStatus state="error" message="Nope." />);
      const el = screen.getByRole("alert");
      expect(el).toHaveClass("error-text");
      expect(el).toHaveTextContent("Nope.");
    });

    it("announces the non-error states politely", () => {
      render(<SaveStatus state="saving" />);
      expect(screen.getByRole("status")).toHaveTextContent("Saving…");
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
  });

  describe("message-carrying states", () => {
    it("renders the warning's own message rather than generic copy", () => {
      render(
        <SaveStatus
          state="warning"
          message="The certificate went out UNSIGNED — sign it by hand."
        />
      );
      expect(screen.getByRole("status")).toHaveTextContent(
        "The certificate went out UNSIGNED — sign it by hand."
      );
    });

    it("renders the error's own message rather than generic copy", () => {
      render(<SaveStatus state="error" message="Template fetch failed (404)." />);
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Template fetch failed (404)."
      );
    });

    it("lets saved carry custom copy, and defaults to 'Saved.' without", () => {
      const { unmount } = render(
        <SaveStatus state="saved" message="Applied — review the Overview tab." />
      );
      expect(screen.getByRole("status")).toHaveTextContent(
        "Applied — review the Overview tab."
      );
      unmount();

      render(<SaveStatus state="saved" />);
      expect(screen.getByRole("status")).toHaveTextContent("Saved.");
    });

    it("never swallows an error into an empty span", () => {
      render(<SaveStatus state="error" message="   " />);
      const el = screen.getByRole("alert");
      expect(el).toBeInTheDocument();
      expect(el.textContent?.trim()).toBe("Save failed.");
    });

    it("never renders a blank warning either", () => {
      render(<SaveStatus state="warning" message="" />);
      expect(screen.getByRole("status").textContent?.trim()).not.toBe("");
    });
  });
});

describe("useSaveStatus", () => {
  it("starts idle, not busy, with no message", () => {
    const { result } = renderHook(() => useSaveStatus());
    expect(result.current.status).toEqual({ state: "idle" });
    expect(result.current.busy).toBe(false);
  });

  describe("the save lifecycle", () => {
    it("goes idle → saving → saved", async () => {
      const d = deferred<void>();
      const { result } = renderHook(() => useSaveStatus());

      expect(result.current.status.state).toBe("idle");

      let done!: Promise<void>;
      act(() => {
        done = result.current.run(() => d.promise);
      });
      expect(result.current.status.state).toBe("saving");
      expect(result.current.busy).toBe(true);

      await act(async () => {
        d.resolve();
        await done;
      });
      expect(result.current.status).toEqual({ state: "saved", message: undefined });
      expect(result.current.busy).toBe(false);
    });

    it("goes idle → saving → error, keeping the failure's message", async () => {
      const d = deferred<void>();
      const { result } = renderHook(() => useSaveStatus());

      let done!: Promise<void>;
      act(() => {
        done = result.current.run(() => d.promise);
      });
      expect(result.current.status.state).toBe("saving");

      await act(async () => {
        d.reject(new Error("Account.update rejected the FEIN"));
        await done;
      });
      expect(result.current.status).toEqual({
        state: "error",
        message: "Account.update rejected the FEIN",
      });
      expect(result.current.busy).toBe(false);
    });

    it("routes the failure through friendlyError", async () => {
      const { result } = renderHook(() => useSaveStatus());
      await act(async () => {
        await result.current.run(async () => {
          throw new Error("Not Authorized to access updateAccount");
        });
      });
      expect(result.current.status.message).toBe(
        "You don't have permission to do that."
      );
    });

    it("falls back to the caller's errorMessage when the throw carries none", async () => {
      const { result } = renderHook(() => useSaveStatus());
      await act(async () => {
        await result.current.run(
          async () => {
            throw new Error("");
          },
          { errorMessage: "Couldn't generate that form." }
        );
      });
      expect(result.current.status).toEqual({
        state: "error",
        message: "Couldn't generate that form.",
      });
    });

    it("never rejects, so `void run(...)` in an onClick is safe", async () => {
      const { result } = renderHook(() => useSaveStatus());
      await act(async () => {
        await expect(
          result.current.run(async () => {
            throw new Error("boom");
          })
        ).resolves.toBeUndefined();
      });
    });

    it("treats a returned string as partial success — warning, not saved", async () => {
      const { result } = renderHook(() => useSaveStatus());
      await act(async () => {
        await result.current.run(async () => "Generated UNSIGNED — sign by hand.");
      });
      expect(result.current.status).toEqual({
        state: "warning",
        message: "Generated UNSIGNED — sign by hand.",
      });
    });

    it("treats an empty returned string as a clean success", async () => {
      const { result } = renderHook(() => useSaveStatus());
      await act(async () => {
        await result.current.run(async () => "", { savedMessage: "Invite sent." });
      });
      expect(result.current.status).toEqual({
        state: "saved",
        message: "Invite sent.",
      });
    });

    it("lets a superseded run lose to the newer one", async () => {
      const slow = deferred<void>();
      const fast = deferred<void>();
      const { result } = renderHook(() => useSaveStatus());

      let first!: Promise<void>;
      let second!: Promise<void>;
      act(() => {
        first = result.current.run(() => slow.promise);
      });
      act(() => {
        second = result.current.run(() => fast.promise, { savedMessage: "Second." });
      });

      await act(async () => {
        fast.resolve();
        await second;
      });
      expect(result.current.status).toEqual({ state: "saved", message: "Second." });

      await act(async () => {
        slow.reject(new Error("stale"));
        await first;
      });
      expect(result.current.status).toEqual({ state: "saved", message: "Second." });
    });
  });

  describe("markDirty", () => {
    it("returns to idle from saved", async () => {
      const { result } = renderHook(() => useSaveStatus());
      await act(async () => {
        await result.current.run(async () => {});
      });
      expect(result.current.status.state).toBe("saved");

      act(() => result.current.markDirty());
      expect(result.current.status).toEqual({ state: "idle" });
    });

    it("returns to idle from warning and from error", async () => {
      const { result } = renderHook(() => useSaveStatus());

      act(() => result.current.markWarning("Partly done."));
      expect(result.current.status.state).toBe("warning");
      act(() => result.current.markDirty());
      expect(result.current.status.state).toBe("idle");

      act(() => result.current.markError("Nope."));
      expect(result.current.status.state).toBe("error");
      act(() => result.current.markDirty());
      expect(result.current.status.state).toBe("idle");
    });

    it("leaves a save that is still in flight alone", async () => {
      const d = deferred<void>();
      const { result } = renderHook(() => useSaveStatus());

      let done!: Promise<void>;
      act(() => {
        done = result.current.run(() => d.promise);
      });
      act(() => result.current.markDirty());
      expect(result.current.status.state).toBe("saving");
      expect(result.current.busy).toBe(true);

      await act(async () => {
        d.resolve();
        await done;
      });
      expect(result.current.status.state).toBe("saved");
    });

    it("keeps one identity across renders, so it can live in a form setter", () => {
      const { result, rerender } = renderHook(() => useSaveStatus());
      const first = result.current.markDirty;
      act(() => result.current.markSaved());
      rerender();
      expect(result.current.markDirty).toBe(first);
      expect(result.current.run).toBe(result.current.run);
    });
  });

  describe("auto-clearing", () => {
    it("does not auto-clear by default, however long you wait", async () => {
      vi.useFakeTimers();
      const { result } = renderHook(() => useSaveStatus());
      act(() => result.current.markSaved());

      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      expect(result.current.status.state).toBe("saved");
      expect(vi.getTimerCount()).toBe(0);
    });

    it("clears saved back to idle after autoClearMs when asked", () => {
      vi.useFakeTimers();
      const { result } = renderHook(() => useSaveStatus({ autoClearMs: 3000 }));
      act(() => result.current.markSaved("Building deleted."));
      expect(result.current.status.state).toBe("saved");

      act(() => {
        vi.advanceTimersByTime(2999);
      });
      expect(result.current.status.state).toBe("saved");

      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(result.current.status).toEqual({ state: "idle" });
    });

    it("never auto-clears a warning or an error", () => {
      vi.useFakeTimers();
      const { result } = renderHook(() => useSaveStatus({ autoClearMs: 1000 }));

      act(() => result.current.markWarning("Generated UNSIGNED."));
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      expect(result.current.status.state).toBe("warning");

      act(() => result.current.markError("Save failed."));
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      expect(result.current.status.state).toBe("error");
    });

    it("cancels the pending timer when a later transition supersedes it", () => {
      vi.useFakeTimers();
      const { result } = renderHook(() => useSaveStatus({ autoClearMs: 1000 }));
      act(() => result.current.markSaved());
      expect(vi.getTimerCount()).toBe(1);

      act(() => result.current.markDirty());
      expect(vi.getTimerCount()).toBe(0);
      expect(result.current.status.state).toBe("idle");
    });

    it("leaves no timer behind on unmount", () => {
      vi.useFakeTimers();
      const { result, unmount } = renderHook(() =>
        useSaveStatus({ autoClearMs: 5000 })
      );
      act(() => result.current.markSaved());
      expect(vi.getTimerCount()).toBe(1);

      unmount();
      expect(vi.getTimerCount()).toBe(0);

      // And nothing fires into the void afterwards.
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      expect(error).not.toHaveBeenCalled();
    });
  });

  it("does not touch state after unmounting mid-save", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const d = deferred<void>();
    const { result, unmount } = renderHook(() => useSaveStatus());

    let done!: Promise<void>;
    act(() => {
      done = result.current.run(() => d.promise);
    });
    expect(result.current.status.state).toBe("saving");

    unmount();
    await act(async () => {
      d.resolve();
      await done;
    });

    // Last snapshot before unmount, unchanged: nothing was written after.
    expect(result.current.status.state).toBe("saving");
    expect(error).not.toHaveBeenCalled();
  });
});

describe("hook + component together", () => {
  /** The shape a Wave 4 call site takes: markDirty in the setter, status spread. */
  function SaveForm({ onSave }: { onSave: () => Promise<string | void> }) {
    const [name, setName] = useState("");
    const save = useSaveStatus();
    return (
      <div>
        <input
          aria-label="Name"
          value={name}
          onChange={(e) => {
            save.markDirty();
            setName(e.target.value);
          }}
        />
        <button disabled={save.busy} onClick={() => void save.run(onSave)}>
          Save changes
        </button>
        <SaveStatus {...save.status} />
      </div>
    );
  }

  it("shows nothing, then Saved., then nothing again once the form is edited", async () => {
    const user = userEvent.setup();
    render(<SaveForm onSave={async () => {}} />);

    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(screen.getByRole("status")).toHaveTextContent("Saved.");

    await user.type(screen.getByLabelText("Name"), "a");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("surfaces a failure as an alert instead of a silent no-op", async () => {
    const user = userEvent.setup();
    render(
      <SaveForm
        onSave={async () => {
          throw new Error("Network error while saving");
        }}
      />
    );

    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Network problem — check your connection and try again."
    );
  });

  it("surfaces a partial success as an amber warning, not as Saved.", async () => {
    const user = userEvent.setup();
    render(<SaveForm onSave={async () => "Form generated UNSIGNED."} />);

    await user.click(screen.getByRole("button", { name: "Save changes" }));
    const el = screen.getByRole("status");
    expect(el).toHaveTextContent("Form generated UNSIGNED.");
    expect(el).toHaveAttribute("data-save-state", "warning");
    expect(el).toHaveStyle({ color: "var(--amber)" });
  });
});
