import { useMemo, useState } from "react";
import {
  licenseHealth,
  type License,
  type UserProfile,
} from "../../lib/client";
import { Badge, flagBadge } from "../../lib/badges";
import { useSort, SortTh } from "../../lib/useSort";
import { holderLabel } from "./holder";

/**
 * Where can we actually write? A state needs BOTH a firm license and at
 * least one licensed producer — this makes the gaps obvious at a glance.
 */
export default function StateCoverage({
  firm,
  personal,
  profiles,
}: {
  firm: License[];
  personal: License[];
  profiles: UserProfile[];
}) {
  const [open, setOpen] = useState(true);
  // Gaps are the actionable half; the writable states are just reassurance.
  const [gapsOnly, setGapsOnly] = useState(true);

  const rows = useMemo(() => {
    const states = [
      ...new Set([...firm, ...personal].map((l) => l.state).filter(Boolean)),
    ];
    const live = (l: License) => {
      const h = licenseHealth(l);
      return h.level !== "expired";
    };
    return states.map((s) => {
      const f = firm.filter((l) => l.state === s && live(l));
      const p = personal.filter((l) => l.state === s && live(l));
      return {
        state: s,
        firm: f.length > 0,
        producers: p
          .map((l) => holderLabel(l, profiles))
          .filter((v, i, a) => a.indexOf(v) === i),
      };
    });
  }, [firm, personal, profiles]);

  const gaps = rows.filter((r) => !(r.firm && r.producers.length > 0));
  const shown = gapsOnly ? gaps : rows;

  // Alphabetical by state, as the derived state list used to be ordered.
  const { sorted, sortKey, dir, toggle } = useSort(
    shown,
    {
      state: (r) => r.state,
      firm: (r) => (r.firm ? "Active" : "Missing"),
      producers: (r) => r.producers.join(", "),
      canWrite: (r) => (r.firm && r.producers.length > 0 ? "Yes" : "Gap"),
    },
    "state"
  );

  if (rows.length === 0) return null;

  return (
    <div className="card">
      <div className="toolbar" style={{ marginTop: 0, alignItems: "flex-start" }}>
        <div>
          <h2 style={{ margin: 0 }}>
            State coverage{" "}
            <span className="muted small" style={{ fontWeight: 400 }}>
              · {rows.length - gaps.length} writable, {gaps.length} gap
              {gaps.length === 1 ? "" : "s"}
            </span>
          </h2>
          <p className="muted small" style={{ margin: "4px 0 0" }}>
            A state is writable when the firm holds an active license there
            <em> and</em> at least one producer is licensed. Expired licenses
            don't count toward coverage.
          </p>
        </div>
        <div className="grow" />
        <button
          className={`lic-chip${gapsOnly ? " on" : ""}`}
          onClick={() => setGapsOnly((v) => !v)}
        >
          {gapsOnly ? "Showing gaps only" : "Show gaps only"}
        </button>
        <button className="link" onClick={() => setOpen((v) => !v)}>
          {open ? "Hide" : "Show"}
        </button>
      </div>

      {open && (
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <SortTh label="State" colKey="state" sortKey={sortKey} dir={dir} onToggle={toggle} />
              <SortTh label="Firm license" colKey="firm" sortKey={sortKey} dir={dir} onToggle={toggle} />
              <SortTh label="Licensed producers" colKey="producers" sortKey={sortKey} dir={dir} onToggle={toggle} />
              <SortTh label="Can write?" colKey="canWrite" sortKey={sortKey} dir={dir} onToggle={toggle} />
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const ok = r.firm && r.producers.length > 0;
              return (
                <tr key={r.state}>
                  <td>
                    <strong>{r.state}</strong>
                  </td>
                  <td>
                    {/* Both pairs are one-offs — this matrix is the only
                        place either is rendered — so the wording stays here
                        rather than becoming a named table in badges.tsx. */}
                    <Badge
                      {...flagBadge(r.firm, {
                        on: { cls: "green", label: "Active" },
                        off: { cls: "red", label: "Missing" },
                      })}
                    />
                  </td>
                  <td className="small">{r.producers.join(", ") || "—"}</td>
                  <td>
                    <Badge
                      {...flagBadge(ok, {
                        on: { cls: "green", label: "Yes" },
                        off: { cls: "amber", label: "Gap" },
                      })}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {shown.length === 0 && (
          <p className="muted small">
            No gaps — every state with a license on file is writable.
          </p>
        )}
      </div>
      )}
    </div>
  );
}
