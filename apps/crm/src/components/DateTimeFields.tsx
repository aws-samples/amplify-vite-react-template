import { useMemo } from "react";

/**
 * Slick date entry for office staff: a native date picker (great on mobile,
 * fine on desktop) fronted by one-tap quick choices for the common cases.
 */

function isoPlusDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

const WEEKDAY = new Intl.DateTimeFormat("en-US", { weekday: "short" });

export function DateField({
  value,
  onChange,
  min,
  allowClear,
}: {
  value: string;
  onChange: (iso: string) => void;
  min?: string;
  allowClear?: boolean;
}) {
  const quick = useMemo(
    () => [
      { label: "Today", iso: isoPlusDays(0) },
      { label: "Tomorrow", iso: isoPlusDays(1) },
      ...[2, 3, 4].map((n) => ({
        label: WEEKDAY.format(new Date(Date.now() + n * 86400_000)),
        iso: isoPlusDays(n),
      })),
      { label: "+1 week", iso: isoPlusDays(7) },
    ],
    []
  );
  return (
    <div className="datefield">
      <input
        type="date"
        value={value}
        min={min}
        onChange={(e) => onChange(e.target.value)}
      />
      <div className="chip-row">
        {quick.map((q) => (
          <button
            key={q.label}
            type="button"
            className={`chip ${value === q.iso ? "chip-on" : ""}`}
            onClick={() => onChange(q.iso)}
          >
            {q.label}
          </button>
        ))}
        {allowClear && value ? (
          <button type="button" className="chip" onClick={() => onChange("")}>
            Clear
          </button>
        ) : null}
      </div>
    </div>
  );
}
