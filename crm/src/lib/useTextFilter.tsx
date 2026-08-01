import { useMemo } from "react";

/**
 * A single searchable value pulled off an item.
 *
 * Deliberately *not* `string[]` — the array-valued columns (`linesOfAuthority`,
 * `lines`) are joined by their call sites before they get here, because joining
 * and matching the joined string is what the existing code does and it is
 * observably different from matching each element: `["AUTO","LIFE"]` joined to
 * `"AUTO LIFE"` matches the query `"auto l"`, and element-wise matching would
 * not. Keeping the join at the call site preserves that and keeps this type
 * flat.
 */
export type FilterValue = string | number | null | undefined;

export interface TextFilterOptions<T> {
  /**
   * A second, non-textual filter dimension, ANDed with the text match and
   * evaluated *first* — so an item excluded here is never asked for its
   * searchable fields. Applies even when `query` is empty, which is the whole
   * point: `Licensing`'s "needs attention" chip narrows the page on its own.
   *
   * Identity matters (see the memoisation note on `useTextFilter`): a `where`
   * that closes over component state wants `useCallback`.
   */
  where?: (item: T) => boolean;
}

/**
 * Substring search across a per-item list of candidate fields.
 *
 * Three components had hand-rolled the same predicate — normalise the query,
 * build an array of candidate fields, keep the item if any of them contains
 * the query as a substring. This is that predicate, once, with the two things
 * only one of the three copies got right folded in:
 *
 *  - The result is memoised, so a parent re-render that changes nothing does
 *    not re-scan the list, and — because the array identity is preserved —
 *    does not invalidate the `useSort` memo hanging off it either.
 *  - A second filter dimension composes through `options.where` instead of
 *    forcing the call site back to a hand-rolled `.filter()` around this one.
 *
 * An empty or whitespace-only `query` with no `where` returns the *same array
 * instance* that was passed in, rather than a filtered copy. "No filter" is
 * the common case and it should cost nothing downstream.
 *
 * ### Memoisation depends on `fields` and `where` being stable
 *
 * Both are held in the dependency list by identity, so an inline arrow
 * declared in the component body re-runs the filter every render — correct,
 * but unmemoised. Define `fields` at module scope when it closes over nothing
 * (the usual case), or wrap it in `useCallback` over exactly the values it
 * captures. This is the ordinary React contract rather than a ref-and-forget
 * trick, and it is deliberate: a stale closure hidden behind a ref would
 * silently search yesterday's data, which is worse than an extra pass over an
 * array of thirty licences.
 *
 * ### Query state lives at the call site
 *
 * `query` is an argument, not something this hook owns, because every one of
 * the three sites needs the query for something other than filtering — a
 * "Clear" button, a "showing N of M" line, a "no matches" empty state that
 * differs from the "nothing here yet" one — and one of them (`Licensing`)
 * drives *two* lists from a single query and composes it with a second piece
 * of state into one `filtering` flag. A hook-owned `query` would have to hand
 * all of that back out again, and would make one of the two calls the
 * arbitrary owner of state the other one reads.
 *
 * @param items  The list to filter.
 * @param query  Raw user input; trimmed and lowercased here, not by the caller.
 * @param fields Candidate values for one item. `null`, `undefined` and `""`
 *               entries are skipped; everything else is stringified and
 *               compared case-insensitively. `0` is a searchable value, not a
 *               skipped one.
 */
export function useTextFilter<T>(
  items: T[],
  query: string,
  fields: (item: T) => readonly FilterValue[],
  options: TextFilterOptions<T> = {}
): T[] {
  // Destructured out of `options` so a fresh object literal at the call site
  // does not defeat the memo — only the predicate's own identity counts.
  const { where } = options;

  return useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q && !where) return items;
    return items.filter((item) => {
      if (where && !where(item)) return false;
      if (!q) return true;
      return fields(item).some(
        (value) =>
          value != null && value !== "" && String(value).toLowerCase().includes(q)
      );
    });
  }, [items, query, fields, where]);
}

export interface FilterInputProps {
  /** Current query. Controlled — pair with the state `useTextFilter` reads. */
  value: string;
  /** Receives the new query directly, so `onChange={setQuery}` is the usual call. */
  onChange: (value: string) => void;
  /**
   * Doubles as the accessible name unless `aria-label` overrides it, so write
   * it as a description of the field ("Filter by account, carrier, or line…")
   * rather than as an instruction.
   */
  placeholder: string;
  /** Accessible name, when the placeholder is too terse to serve as one. */
  "aria-label"?: string;
  /** Appended to `lic-search`, for the odd site that needs a width cap. */
  className?: string;
}

/**
 * The search box that goes with `useTextFilter`.
 *
 * `type="search"` is load-bearing twice over: it gives the field the implicit
 * `searchbox` role (so tests and screen readers can find it by role) and the
 * native clear affordance in WebKit. `lic-search` supplies only layout —
 * `flex: 1 1 280px; min-width: 0` plus padding and font size — so this must
 * sit inside a flex row (`.toolbar`, `.lic-controls`) to size correctly, and
 * it inherits the browser's default input chrome rather than the bordered
 * `.field input` treatment used by form fields.
 *
 * The accessible name falls back to the placeholder. That is what the existing
 * markup already resolves to, but by spec fallback rather than by declaration;
 * naming it explicitly pins it.
 */
export function FilterInput({
  value,
  onChange,
  placeholder,
  "aria-label": ariaLabel,
  className,
}: FilterInputProps) {
  return (
    <input
      className={className ? `lic-search ${className}` : "lic-search"}
      type="search"
      placeholder={placeholder}
      aria-label={ariaLabel ?? placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
