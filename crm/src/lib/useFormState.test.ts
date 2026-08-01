import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useFormState } from "./useFormState";

/**
 * A form shaped like the real ones: text, an enum-ish string, a boolean, a
 * numeric held as a string (every numeric in this codebase is), a chip list,
 * and one genuine number to prove the generic isn't string-only.
 */
function seed() {
  return {
    name: "Maple Ridge HOA",
    state: "MA",
    appointed: false,
    unitCount: "42",
    lines: ["PROPERTY", "GL"] as string[],
    stories: 3,
  };
}
type Form = ReturnType<typeof seed>;

describe("useFormState", () => {
  describe("seeding", () => {
    it("takes the initial values from an object", () => {
      const { result } = renderHook(() => useFormState(seed()));
      expect(result.current.form).toEqual(seed());
      expect(result.current.dirty).toBe(false);
      expect(result.current.saved).toBe(false);
    });

    it("takes them from a lazy initializer, calling it once", () => {
      let calls = 0;
      const { result, rerender } = renderHook(() =>
        useFormState(() => {
          calls++;
          return seed();
        })
      );
      rerender();
      act(() => result.current.setF("name", "x"));
      expect(calls).toBe(1);
      expect(result.current.form.name).toBe("x");
    });

    it("does not re-seed when `initial` changes identity", () => {
      // The case that would break every caller: `initial` is an inline object
      // literal, so it is a new identity on every render of the parent.
      const { result, rerender } = renderHook(
        ({ initial }: { initial: Form }) => useFormState(initial),
        { initialProps: { initial: seed() } }
      );

      act(() => result.current.setF("name", "half-typed"));
      rerender({ initial: { ...seed(), name: "Reloaded From Server" } });

      expect(result.current.form.name).toBe("half-typed");
      expect(result.current.dirty).toBe(true);
    });
  });

  describe("setF", () => {
    it("updates one field and leaves the rest alone", () => {
      const { result } = renderHook(() => useFormState(seed()));
      act(() => result.current.setF("name", "Oak Ridge HOA"));
      expect(result.current.form).toEqual({ ...seed(), name: "Oak Ridge HOA" });
    });

    it("takes non-string values: boolean, number, and an array", () => {
      // The whole reason the curried `(e: {target:{value:string}})` setter had
      // to be abandoned.
      const { result } = renderHook(() => useFormState(seed()));
      act(() => result.current.setF("appointed", true));
      act(() => result.current.setF("stories", 7));
      act(() => result.current.setF("lines", ["PROPERTY"]));
      expect(result.current.form.appointed).toBe(true);
      expect(result.current.form.stories).toBe(7);
      expect(result.current.form.lines).toEqual(["PROPERTY"]);
    });

    it("takes an updater, so a chip-list toggle needs no closure", () => {
      const { result } = renderHook(() => useFormState(seed()));
      const toggle = (line: string) =>
        result.current.setF("lines", (ls) =>
          ls.includes(line) ? ls.filter((l) => l !== line) : [...ls, line]
        );
      act(() => toggle("UMBRELLA"));
      expect(result.current.form.lines).toEqual(["PROPERTY", "GL", "UMBRELLA"]);
      act(() => toggle("GL"));
      expect(result.current.form.lines).toEqual(["PROPERTY", "UMBRELLA"]);
    });

    it("does not lose a write when two fields are set in one handler", () => {
      const { result } = renderHook(() => useFormState(seed()));
      act(() => {
        result.current.setF("name", "Two");
        result.current.setF("state", "NH");
      });
      expect(result.current.form.name).toBe("Two");
      expect(result.current.form.state).toBe("NH");
    });
  });

  describe("patch", () => {
    it("sets several fields in one update", () => {
      const { result } = renderHook(() => useFormState(seed()));
      act(() => result.current.patch({ state: "NH", unitCount: "80" }));
      expect(result.current.form).toEqual({
        ...seed(),
        state: "NH",
        unitCount: "80",
      });
    });

    it("takes an updater that reads the previous values", () => {
      // AddressAutocomplete's onPlace: keep what the user typed for any field
      // the place lookup didn't fill.
      const { result } = renderHook(() => useFormState(seed()));
      const place = { name: "", state: "RI" };
      act(() =>
        result.current.patch((f) => ({
          name: place.name || f.name,
          state: place.state || f.state,
        }))
      );
      expect(result.current.form.name).toBe("Maple Ridge HOA");
      expect(result.current.form.state).toBe("RI");
    });
  });

  describe("dirty", () => {
    it("is false initially and true after a change", () => {
      const { result } = renderHook(() => useFormState(seed()));
      expect(result.current.dirty).toBe(false);
      act(() => result.current.setF("unitCount", "43"));
      expect(result.current.dirty).toBe(true);
    });

    it("goes back to false when the value is typed back to the original", () => {
      // Value semantics, not a latch: there is nothing to save, so nothing
      // should claim there is.
      const { result } = renderHook(() => useFormState(seed()));
      act(() => result.current.setF("name", "Maple Ridge HO"));
      expect(result.current.dirty).toBe(true);
      act(() => result.current.setF("name", "Maple Ridge HOA"));
      expect(result.current.dirty).toBe(false);
    });

    it("compares arrays element-wise, so select-all-then-clear settles clean", () => {
      const { result } = renderHook(() => useFormState(seed()));
      act(() => result.current.setF("lines", []));
      expect(result.current.dirty).toBe(true);
      act(() => result.current.setF("lines", ["PROPERTY", "GL"]));
      expect(result.current.dirty).toBe(false);
    });

    it("sees a boolean flipped and flipped back", () => {
      const { result } = renderHook(() => useFormState(seed()));
      act(() => result.current.setF("appointed", true));
      expect(result.current.dirty).toBe(true);
      act(() => result.current.setF("appointed", false));
      expect(result.current.dirty).toBe(false);
    });

    it("is true when a patch changes any one of its fields", () => {
      const { result } = renderHook(() => useFormState(seed()));
      act(() => result.current.patch({ name: seed().name, state: "NH" }));
      expect(result.current.dirty).toBe(true);
    });
  });

  describe("saved", () => {
    it("is set by markSaved and cleared by the next edit", () => {
      const { result } = renderHook(() => useFormState(seed()));
      act(() => result.current.markSaved());
      expect(result.current.saved).toBe(true);
      act(() => result.current.setF("name", "Elm Court HOA"));
      expect(result.current.saved).toBe(false);
    });

    it("is cleared by a patch and by a reset too", () => {
      const { result } = renderHook(() => useFormState(seed()));
      act(() => result.current.markSaved());
      act(() => result.current.patch({ state: "NH" }));
      expect(result.current.saved).toBe(false);

      act(() => result.current.markSaved());
      act(() => result.current.reset());
      expect(result.current.saved).toBe(false);
    });

    it("is cleared even when the edit writes the same value back", () => {
      // The canonical setter cleared it unconditionally; keep that, so a field
      // touched after a save never leaves a stale "Saved." on screen.
      const { result } = renderHook(() => useFormState(seed()));
      act(() => result.current.markSaved());
      act(() => result.current.setF("state", "MA"));
      expect(result.current.saved).toBe(false);
      expect(result.current.dirty).toBe(false);
    });
  });

  describe("markSaved moves the baseline", () => {
    it("clears dirty, and measures later edits against the saved values", () => {
      const { result } = renderHook(() => useFormState(seed()));
      act(() => result.current.setF("unitCount", "50"));
      expect(result.current.dirty).toBe(true);

      act(() => result.current.markSaved());
      expect(result.current.dirty).toBe(false);
      expect(result.current.form.unitCount).toBe("50");

      // Back to the *original* value is now a change, not a revert.
      act(() => result.current.setF("unitCount", "42"));
      expect(result.current.dirty).toBe(true);
      act(() => result.current.setF("unitCount", "50"));
      expect(result.current.dirty).toBe(false);
    });
  });

  describe("reset", () => {
    it("returns to the seed values and clears the flags", () => {
      const { result } = renderHook(() => useFormState(seed()));
      act(() => result.current.patch({ name: "", state: "", lines: [] }));
      act(() => result.current.reset());
      expect(result.current.form).toEqual(seed());
      expect(result.current.dirty).toBe(false);
      expect(result.current.saved).toBe(false);
    });

    it("returns to the last saved values once a save has landed", () => {
      const { result } = renderHook(() => useFormState(seed()));
      act(() => result.current.setF("name", "Renamed"));
      act(() => result.current.markSaved());
      act(() => result.current.setF("name", "Half-typed edit"));
      act(() => result.current.reset());
      expect(result.current.form.name).toBe("Renamed");
      expect(result.current.dirty).toBe(false);
    });

    it("re-seeds and re-baselines when given explicit values", () => {
      // The add-a-row sub-form case: clear back to blanks after a create.
      const blank: Form = {
        name: "",
        state: "",
        appointed: false,
        unitCount: "",
        lines: [],
        stories: 0,
      };
      const { result } = renderHook(() => useFormState(seed()));
      act(() => result.current.reset(blank));
      expect(result.current.form).toEqual(blank);
      expect(result.current.dirty).toBe(false);

      act(() => result.current.setF("name", "Building 2"));
      expect(result.current.dirty).toBe(true);
      act(() => result.current.reset());
      expect(result.current.form).toEqual(blank);
    });
  });

  describe("typing", () => {
    it("rejects a value of the wrong type for the key", () => {
      // Checked by `tsc`, which runs in the same gate as this suite: the
      // `@ts-expect-error`s below fail the build if the setter ever loosens to
      // the string-only shape this replaced.
      const { result } = renderHook(() => useFormState(seed()));
      act(() => {
        // @ts-expect-error `appointed` is a boolean, not a string
        result.current.setF("appointed", "yes");
        // @ts-expect-error `stories` is a number, not a string
        result.current.setF("stories", "3");
        // @ts-expect-error no such field
        result.current.setF("nope", "x");
        // @ts-expect-error `patch` is keyed by the same shape
        result.current.patch({ appointed: "yes" });
      });
      expect(result.current.form.appointed).toBe("yes");
    });
  });

  describe("onEdit", () => {
    it("fires on every mutation, and not on markSaved", () => {
      const onEdit = vi.fn();
      const { result } = renderHook(() => useFormState(seed(), { onEdit }));
      act(() => result.current.setF("name", "A"));
      act(() => result.current.patch({ state: "NH" }));
      act(() => result.current.reset());
      expect(onEdit).toHaveBeenCalledTimes(3);
      act(() => result.current.markSaved());
      expect(onEdit).toHaveBeenCalledTimes(3);
    });

    it("calls the latest closure, without changing setter identity", () => {
      const first = vi.fn();
      const second = vi.fn();
      const { result, rerender } = renderHook(
        ({ onEdit }: { onEdit: () => void }) => useFormState(seed(), { onEdit }),
        { initialProps: { onEdit: first } }
      );
      const setF = result.current.setF;
      rerender({ onEdit: second });
      act(() => result.current.setF("name", "A"));
      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledTimes(1);
      expect(result.current.setF).toBe(setF);
    });
  });

  describe("identity", () => {
    it("keeps every callback stable across renders", () => {
      const { result, rerender } = renderHook(() => useFormState(seed()));
      const first = result.current;
      act(() => result.current.setF("name", "Changed"));
      rerender();
      expect(result.current.setF).toBe(first.setF);
      expect(result.current.patch).toBe(first.patch);
      expect(result.current.markSaved).toBe(first.markSaved);
      expect(result.current.reset).toBe(first.reset);
    });
  });
});
