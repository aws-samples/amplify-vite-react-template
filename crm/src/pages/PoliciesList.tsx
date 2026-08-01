import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  client,
  fmtDate,
  fmtMoney,
  type Account,
  type Carrier,
  type Policy,
} from "../lib/client";
import { Badge, statusBadge, POLICY_STATUS_BADGE } from "../lib/badges";
import { useSort, SortTh } from "../lib/useSort";

export default function PoliciesList() {
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [carriers, setCarriers] = useState<Carrier[]>([]);
  const navigate = useNavigate();

  useEffect(() => {
    client.models.Policy.list().then(({ data }) => setPolicies(data));
    client.models.Account.list().then(({ data }) => setAccounts(data));
    client.models.Carrier.list().then(({ data }) => setCarriers(data));
  }, []);

  const accountName = useMemo(
    () => new Map(accounts.map((a) => [a.id, a.name])),
    [accounts]
  );
  const carrierName = useMemo(
    () => new Map(carriers.map((c) => [c.id, c.name])),
    [carriers]
  );

  // Default: expiration ascending — next up (or already expired) first.
  const { sorted, sortKey, dir, toggle } = useSort(
    policies,
    {
      account: (p) => accountName.get(p.accountId) ?? "",
      carrier: (p) => (p.carrierId ? carrierName.get(p.carrierId) ?? "" : null),
      number: (p) => p.policyNumber,
      premium: (p) => p.premium,
      effective: (p) => p.effectiveDate,
      expires: (p) => p.expirationDate,
      status: (p) => p.status,
    },
    "expires"
  );

  return (
    <>
      <h1>Policies</h1>
      <p className="sub">All bound policies — soonest expiration first</p>

      <div className="card">
        {sorted.length === 0 ? (
          <p className="muted small">No policies bound yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <SortTh label="Account" colKey="account" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="Carrier" colKey="carrier" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="Policy #" colKey="number" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="Premium" colKey="premium" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="Effective" colKey="effective" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="Expires" colKey="expires" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="Status" colKey="status" sortKey={sortKey} dir={dir} onToggle={toggle} />
                </tr>
              </thead>
              <tbody>
                {sorted.map((p) => (
                  <tr
                    key={p.id}
                    className="clickable"
                    onClick={() => navigate(`/accounts/${p.accountId}?tab=policies`)}
                  >
                    <td>
                      <strong>{accountName.get(p.accountId) ?? "—"}</strong>
                    </td>
                    <td>{p.carrierId ? carrierName.get(p.carrierId) ?? "—" : "—"}</td>
                    <td>{p.policyNumber ?? "—"}</td>
                    <td>{fmtMoney(p.premium)}</td>
                    <td>{fmtDate(p.effectiveDate)}</td>
                    <td>{fmtDate(p.expirationDate)}</td>
                    <td>
                      <Badge {...statusBadge(POLICY_STATUS_BADGE, p.status)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
