import { useMemo, useState } from "react";

type SortDir = "asc" | "desc";
type SortAccessor<T> = (item: T) => string | number | null | undefined;

/**
 * Column sorting for tables. Null/undefined values always sort last
 * (regardless of direction) — so "no renewal date" never beats a real one.
 */
export function useSort<T>(
  items: T[],
  accessors: Record<string, SortAccessor<T>>,
  defaultKey: string,
  defaultDir: SortDir = "asc"
) {
  const [sortKey, setSortKey] = useState(defaultKey);
  const [dir, setDir] = useState<SortDir>(defaultDir);

  function toggle(key: string) {
    if (key === sortKey) {
      setDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setDir("asc");
    }
  }

  const sorted = useMemo(() => {
    const acc = accessors[sortKey];
    if (!acc) return items;
    const mult = dir === "asc" ? 1 : -1;
    return [...items].sort((a, b) => {
      const va = acc(a);
      const vb = acc(b);
      const aNull = va == null || va === "";
      const bNull = vb == null || vb === "";
      if (aNull && bNull) return 0;
      if (aNull) return 1; // nulls last, always
      if (bNull) return -1;
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * mult;
      return String(va).localeCompare(String(vb), undefined, { sensitivity: "base" }) * mult;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, sortKey, dir]);

  return { sorted, sortKey, dir, toggle };
}

export function SortTh({
  label,
  colKey,
  sortKey,
  dir,
  onToggle,
}: {
  label: string;
  colKey: string;
  sortKey: string;
  dir: SortDir;
  onToggle: (key: string) => void;
}) {
  const active = colKey === sortKey;
  return (
    <th className="sortable" onClick={() => onToggle(colKey)}>
      {label}
      <span className="arrow">{active ? (dir === "asc" ? " ▲" : " ▼") : ""}</span>
    </th>
  );
}
