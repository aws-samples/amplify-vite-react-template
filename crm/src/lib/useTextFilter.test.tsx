import { useState } from "react";
import { render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FilterInput, useTextFilter, type FilterValue } from "./useTextFilter";

interface Row {
  name: string;
  city: string | null;
  units?: number;
  code?: string;
}

const ROWS: Row[] = [
  { name: "Harbour Point HOA", city: "Portsmouth", units: 48, code: "" },
  { name: "Cedar Ridge", city: null, units: 0 },
  { name: "Lakeview Commons", city: "Concord", units: 120, code: "LVC" },
];

/**
 * Module-scope so its identity is stable across renders — the same thing a
 * call site has to do to get the memo. Tests that need to count invocations
 * wrap their own `vi.fn` around it.
 */
const rowFields = (r: Row): FilterValue[] => [r.name, r.city, r.units, r.code];

describe("useTextFilter", () => {
  describe("query normalisation", () => {
    it("returns every item for an empty query", () => {
      const { result } = renderHook(() => useTextFilter(ROWS, "", rowFields));
      expect(result.current).toHaveLength(3);
    });

    it("returns every item for a whitespace-only query", () => {
      const { result } = renderHook(() => useTextFilter(ROWS, "   \t \n ", rowFields));
      expect(result.current).toHaveLength(3);
    });

    it("returns the same array instance when nothing is filtered", () => {
      const { result } = renderHook(() => useTextFilter(ROWS, "  ", rowFields));
      // Identity, not just equality: downstream memos (useSort) key off it.
      expect(result.current).toBe(ROWS);
    });

    it("trims the query before matching", () => {
      const { result } = renderHook(() => useTextFilter(ROWS, "  cedar  ", rowFields));
      expect(result.current.map((r) => r.name)).toEqual(["Cedar Ridge"]);
    });
  });

  describe("matching", () => {
    it("matches case-insensitively in both directions", () => {
      const lower = renderHook(() => useTextFilter(ROWS, "harbour", rowFields));
      const upper = renderHook(() => useTextFilter(ROWS, "HARBOUR", rowFields));
      const mixed = renderHook(() => useTextFilter(ROWS, "HaRbOuR", rowFields));
      for (const r of [lower, upper, mixed]) {
        expect(r.result.current.map((x) => x.name)).toEqual(["Harbour Point HOA"]);
      }
    });

    it("matches on a substring, not a whole word or a prefix", () => {
      const { result } = renderHook(() => useTextFilter(ROWS, "idge", rowFields));
      expect(result.current.map((r) => r.name)).toEqual(["Cedar Ridge"]);
    });

    it("matches across different fields for different items", () => {
      // "ports" is only ever in `city`; "commons" is only ever in `name`.
      const { result } = renderHook(() => useTextFilter(ROWS, "ports", rowFields));
      expect(result.current.map((r) => r.name)).toEqual(["Harbour Point HOA"]);

      const byName = renderHook(() => useTextFilter(ROWS, "commons", rowFields));
      expect(byName.result.current.map((r) => r.name)).toEqual(["Lakeview Commons"]);
    });

    it("keeps an item that matches on any one of several fields", () => {
      const { result } = renderHook(() => useTextFilter(ROWS, "o", rowFields));
      // Harbour/Point/HOA/Portsmouth, Commons/Concord — Cedar Ridge has no "o".
      expect(result.current.map((r) => r.name)).toEqual([
        "Harbour Point HOA",
        "Lakeview Commons",
      ]);
    });

    it("returns an empty array when nothing matches", () => {
      const { result } = renderHook(() => useTextFilter(ROWS, "zzzz", rowFields));
      expect(result.current).toEqual([]);
    });

    it("preserves the input order of the survivors", () => {
      const { result } = renderHook(() => useTextFilter(ROWS, "e", rowFields));
      expect(result.current.map((r) => r.name)).toEqual([
        "Cedar Ridge",
        "Lakeview Commons",
      ]);
    });
  });

  describe("field values that are not plain strings", () => {
    it("skips null and undefined fields instead of stringifying them", () => {
      // Cedar Ridge has city: null and no code; "null"/"undefined" must not match.
      const nul = renderHook(() => useTextFilter(ROWS, "null", rowFields));
      expect(nul.result.current).toEqual([]);
      const undef = renderHook(() => useTextFilter(ROWS, "undefined", rowFields));
      expect(undef.result.current).toEqual([]);
    });

    it("still matches an item whose other fields are null", () => {
      const { result } = renderHook(() => useTextFilter(ROWS, "cedar", rowFields));
      expect(result.current.map((r) => r.name)).toEqual(["Cedar Ridge"]);
    });

    it("matches numeric fields by their string form", () => {
      const { result } = renderHook(() => useTextFilter(ROWS, "12", rowFields));
      expect(result.current.map((r) => r.name)).toEqual(["Lakeview Commons"]);
    });

    it("treats 0 as a searchable value, not an absent one", () => {
      const { result } = renderHook(() => useTextFilter(ROWS, "0", rowFields));
      // Cedar Ridge units: 0 and Lakeview units: 120 both contain "0".
      expect(result.current.map((r) => r.name)).toEqual([
        "Cedar Ridge",
        "Lakeview Commons",
      ]);
    });

    it("skips empty-string fields", () => {
      const rows = [{ name: "", city: "Dover" }] as Row[];
      const { result } = renderHook(() => useTextFilter(rows, "dover", rowFields));
      expect(result.current).toHaveLength(1);
    });

    it("matches a caller-joined array field as one string", () => {
      interface Task {
        lines: (string | null)[] | null;
      }
      const tasks: Task[] = [
        { lines: ["PROPERTY", "GENERAL_LIABILITY"] },
        { lines: null },
      ];
      const fields = (t: Task): FilterValue[] => [
        (t.lines ?? []).filter(Boolean).join(" "),
      ];
      const { result } = renderHook(() => useTextFilter(tasks, "property gen", fields));
      // The join is what makes a query spanning two elements match.
      expect(result.current).toHaveLength(1);
    });
  });

  describe("composing a second filter dimension", () => {
    const isBig = (r: Row) => (r.units ?? 0) >= 100;

    it("applies `where` even when the query is empty", () => {
      const { result } = renderHook(() =>
        useTextFilter(ROWS, "", rowFields, { where: isBig })
      );
      expect(result.current.map((r) => r.name)).toEqual(["Lakeview Commons"]);
    });

    it("ANDs `where` with the text match", () => {
      const { result } = renderHook(() =>
        useTextFilter(ROWS, "harbour", rowFields, { where: isBig })
      );
      // Harbour matches the text but has 48 units.
      expect(result.current).toEqual([]);
    });

    it("keeps items satisfying both dimensions", () => {
      const { result } = renderHook(() =>
        useTextFilter(ROWS, "lakeview", rowFields, { where: isBig })
      );
      expect(result.current.map((r) => r.name)).toEqual(["Lakeview Commons"]);
    });

    it("evaluates `where` before asking for the item's fields", () => {
      const fields = vi.fn(rowFields);
      renderHook(() =>
        useTextFilter(ROWS, "a", fields, { where: isBig })
      );
      // Only the one row that survives `where` is ever scanned for text.
      expect(fields).toHaveBeenCalledTimes(1);
      // ...and it is handed the item alone, not filter's (item, index, array).
      expect(fields).toHaveBeenCalledExactlyOnceWith(ROWS[2]);
    });

    it("filters two lists from one query, as Licensing does", () => {
      const firm = ROWS.slice(0, 2);
      const personal = ROWS.slice(2);
      const { result } = renderHook(() => ({
        firm: useTextFilter(firm, "o", rowFields),
        personal: useTextFilter(personal, "o", rowFields),
      }));
      expect(result.current.firm.map((r) => r.name)).toEqual(["Harbour Point HOA"]);
      expect(result.current.personal.map((r) => r.name)).toEqual(["Lakeview Commons"]);
    });

    it("does not defeat the memo when `options` is a fresh object literal", () => {
      const fields = vi.fn(rowFields);
      const { rerender } = renderHook(
        ({ q }: { q: string }) => useTextFilter(ROWS, q, fields, { where: isBig }),
        { initialProps: { q: "a" } }
      );
      const afterFirst = fields.mock.calls.length;
      rerender({ q: "a" });
      expect(fields.mock.calls.length).toBe(afterFirst);
    });
  });

  describe("memoisation", () => {
    it("does not re-run the predicate when nothing changed", () => {
      const fields = vi.fn(rowFields);
      const { result, rerender } = renderHook(
        ({ q }: { q: string }) => useTextFilter(ROWS, q, fields),
        { initialProps: { q: "o" } }
      );
      const first = result.current;
      const callsAfterFirstPass = fields.mock.calls.length;
      expect(callsAfterFirstPass).toBe(ROWS.length);

      rerender({ q: "o" });
      rerender({ q: "o" });

      expect(fields.mock.calls.length).toBe(callsAfterFirstPass);
      expect(result.current).toBe(first);
    });

    it("recomputes when the query changes", () => {
      const fields = vi.fn(rowFields);
      const { result, rerender } = renderHook(
        ({ q }: { q: string }) => useTextFilter(ROWS, q, fields),
        { initialProps: { q: "o" } }
      );
      const before = fields.mock.calls.length;
      rerender({ q: "cedar" });
      expect(fields.mock.calls.length).toBeGreaterThan(before);
      expect(result.current.map((r) => r.name)).toEqual(["Cedar Ridge"]);
    });

    it("recomputes when the item array identity changes", () => {
      const fields = vi.fn(rowFields);
      const { result, rerender } = renderHook(
        ({ rows }: { rows: Row[] }) => useTextFilter(rows, "o", fields),
        { initialProps: { rows: ROWS } }
      );
      const before = fields.mock.calls.length;
      rerender({ rows: [...ROWS, { name: "Oak Hollow", city: "Dover" }] });
      expect(fields.mock.calls.length).toBeGreaterThan(before);
      expect(result.current).toHaveLength(3);
    });

    it("recomputes when `fields` identity changes, so a stale closure can't survive", () => {
      const { result, rerender } = renderHook(
        ({ suffix }: { suffix: string }) =>
          useTextFilter(ROWS, "xx", (r: Row) => [r.name + suffix]),
        { initialProps: { suffix: "" } }
      );
      expect(result.current).toEqual([]);
      rerender({ suffix: "-xx" });
      expect(result.current).toHaveLength(3);
    });

    it("recomputes when `where` identity changes", () => {
      const { result, rerender } = renderHook(
        ({ min }: { min: number }) =>
          useTextFilter(ROWS, "", rowFields, { where: (r) => (r.units ?? 0) >= min }),
        { initialProps: { min: 100 } }
      );
      expect(result.current).toHaveLength(1);
      rerender({ min: 1 });
      expect(result.current).toHaveLength(2);
    });
  });
});

describe("FilterInput", () => {
  it("renders a searchbox carrying the lic-search class", () => {
    render(<FilterInput value="" onChange={() => {}} placeholder="Filter licences…" />);
    const input = screen.getByRole("searchbox");
    expect(input).toHaveClass("lic-search");
    expect(input).toHaveAttribute("type", "search");
  });

  it("takes its accessible name from the placeholder", () => {
    render(<FilterInput value="" onChange={() => {}} placeholder="Filter licences…" />);
    expect(screen.getByRole("searchbox", { name: "Filter licences…" })).toBeInTheDocument();
  });

  it("lets an explicit aria-label override the placeholder as the name", () => {
    render(
      <FilterInput
        value=""
        onChange={() => {}}
        placeholder="state, licence #, NPN…"
        aria-label="Filter licences"
      />
    );
    expect(screen.getByRole("searchbox", { name: "Filter licences" })).toBeInTheDocument();
    expect(screen.getByRole("searchbox")).toHaveAttribute(
      "placeholder",
      "state, licence #, NPN…"
    );
  });

  it("reflects the value it is given", () => {
    render(<FilterInput value="Concord" onChange={() => {}} placeholder="Filter…" />);
    expect(screen.getByRole("searchbox")).toHaveValue("Concord");
  });

  it("reports the new value — not the event — on change", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<FilterInput value="" onChange={onChange} placeholder="Filter…" />);
    await user.type(screen.getByRole("searchbox"), "a");
    expect(onChange).toHaveBeenCalledExactlyOnceWith("a");
  });

  it("stays controlled as the user types", async () => {
    const user = userEvent.setup();
    function Harness() {
      const [q, setQ] = useState("");
      return (
        <>
          <FilterInput value={q} onChange={setQ} placeholder="Filter…" />
          <output>{q}</output>
        </>
      );
    }
    render(<Harness />);
    await user.type(screen.getByRole("searchbox"), "cedar");
    expect(screen.getByRole("searchbox")).toHaveValue("cedar");
    expect(screen.getByRole("status")).toHaveTextContent("cedar");
  });

  it("clears back to empty when the value is reset", async () => {
    const user = userEvent.setup();
    function Harness() {
      const [q, setQ] = useState("");
      return (
        <>
          <FilterInput value={q} onChange={setQ} placeholder="Filter…" />
          <button onClick={() => setQ("")}>Clear</button>
        </>
      );
    }
    render(<Harness />);
    await user.type(screen.getByRole("searchbox"), "abc");
    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.getByRole("searchbox")).toHaveValue("");
  });

  it("appends an extra className without dropping lic-search", () => {
    render(
      <FilterInput value="" onChange={() => {}} placeholder="Filter…" className="grow" />
    );
    const input = screen.getByRole("searchbox");
    expect(input).toHaveClass("lic-search");
    expect(input).toHaveClass("grow");
  });

  it("drives useTextFilter end to end", async () => {
    const user = userEvent.setup();
    function Harness() {
      const [q, setQ] = useState("");
      const rows = useTextFilter(ROWS, q, rowFields);
      return (
        <>
          <FilterInput value={q} onChange={setQ} placeholder="Filter…" />
          <ul>
            {rows.map((r) => (
              <li key={r.name}>{r.name}</li>
            ))}
          </ul>
        </>
      );
    }
    render(<Harness />);
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    await user.type(screen.getByRole("searchbox"), "concord");
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Lakeview Commons",
    ]);
  });
});
