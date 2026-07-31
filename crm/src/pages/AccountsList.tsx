import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { client, fmtDate, fmtMoney, fmtNum, type Account, type Policy } from "../lib/client";
import { useSort, SortTh } from "../lib/useSort";

export default function AccountsList({ stage }: { stage: "LEAD" | "CLIENT" }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    setLoading(true);
    client.models.Account.list({ filter: { stage: { eq: stage } } }).then(
      ({ data }) => {
        setAccounts(data);
        setLoading(false);
      }
    );
    client.models.Policy.list().then(({ data }) => setPolicies(data));
  }, [stage]);

  // Renewal date: clients → earliest ACTIVE policy expiration;
  // leads → incumbent policy expiration.
  const renewalByAccount = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of policies) {
      if (p.status !== "ACTIVE" || !p.expirationDate) continue;
      const cur = map.get(p.accountId);
      if (!cur || p.expirationDate < cur) map.set(p.accountId, p.expirationDate);
    }
    return map;
  }, [policies]);

  const renewalOf = (a: Account): string | null =>
    stage === "CLIENT"
      ? renewalByAccount.get(a.id) ?? null
      : a.currentPolicyExpiration ?? null;

  const q = search.trim().toLowerCase();
  const filtered = q
    ? accounts.filter((a) =>
        [a.name, a.city, a.state, a.contactFirstName, a.contactLastName, a.contactEmail]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(q))
      )
    : accounts;

  // Default: policy end date ascending — next up / expired at the top,
  // accounts without a date after, alphabetically.
  const { sorted, sortKey, dir, toggle } = useSort(
    filtered,
    {
      name: (a) => a.name,
      type: (a) => a.type,
      contact: (a) =>
        [a.contactFirstName, a.contactLastName].filter(Boolean).join(" ") || null,
      location: (a) => [a.city, a.state].filter(Boolean).join(", ") || null,
      units: (a) => a.unitCount,
      tiv: (a) => a.totalInsuredValue,
      renewal: (a) => renewalOf(a),
    },
    "renewal"
  );

  const label = stage === "LEAD" ? "Leads" : "Clients";

  return (
    <>
      <h1>{label}</h1>
      <p className="sub">
        {stage === "LEAD"
          ? "Prospects — converted to clients when a quote is bound"
          : "Bound accounts (created automatically from leads)"}
      </p>

      <div className="toolbar">
        <div className="field grow" style={{ maxWidth: 360 }}>
          <input
            placeholder={`Search ${label.toLowerCase()}…`}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {stage === "LEAD" && (
          <Link to="/leads/new">
            <button className="primary">+ New lead</button>
          </Link>
        )}
      </div>

      <div className="card">
        {loading ? (
          <p className="muted small">Loading…</p>
        ) : sorted.length === 0 ? (
          <p className="muted small">No {label.toLowerCase()} found.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <SortTh label="Name" colKey="name" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="Type" colKey="type" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="Contact" colKey="contact" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="Location" colKey="location" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="Units" colKey="units" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="TIV" colKey="tiv" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh
                    label={stage === "LEAD" ? "Incumbent expires" : "Renewal"}
                    colKey="renewal"
                    sortKey={sortKey}
                    dir={dir}
                    onToggle={toggle}
                  />
                </tr>
              </thead>
              <tbody>
                {sorted.map((a) => {
                  const renewal = renewalOf(a);
                  return (
                    <tr
                      key={a.id}
                      className="clickable"
                      onClick={() => navigate(`/accounts/${a.id}`)}
                    >
                      <td>
                        <strong>{a.name}</strong>
                      </td>
                      <td>
                        <span className="badge gray">{a.type}</span>
                      </td>
                      <td>
                        {[a.contactFirstName, a.contactLastName].filter(Boolean).join(" ") || "—"}
                        {a.contactEmail && (
                          <div className="muted small">{a.contactEmail}</div>
                        )}
                      </td>
                      <td>{[a.city, a.state].filter(Boolean).join(", ") || "—"}</td>
                      <td>{fmtNum(a.unitCount)}</td>
                      <td>{fmtMoney(a.totalInsuredValue)}</td>
                      <td>{renewal ? fmtDate(renewal) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
