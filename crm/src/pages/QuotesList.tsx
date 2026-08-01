import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  client,
  fmtDate,
  fmtMoney,
  type Account,
  type Carrier,
  type Quote,
} from "../lib/client";
import { Badge, statusBadge, QUOTE_STATUS_BADGE } from "../lib/badges";
import { useSort, SortTh } from "../lib/useSort";

const OPEN = ["DRAFT", "SUBMITTED", "QUOTED", "PRESENTED"];

export default function QuotesList() {
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [carriers, setCarriers] = useState<Carrier[]>([]);
  const [openOnly, setOpenOnly] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    client.models.Quote.list().then(({ data }) => setQuotes(data));
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

  const visible = openOnly ? quotes.filter((q) => OPEN.includes(q.status)) : quotes;

  const { sorted, sortKey, dir, toggle } = useSort(
    visible,
    {
      account: (q) => accountName.get(q.accountId) ?? "",
      carrier: (q) => (q.carrierId ? carrierName.get(q.carrierId) ?? "" : null),
      premium: (q) => q.premium,
      effective: (q) => q.effectiveDate,
      status: (q) => q.status,
    },
    "account"
  );

  return (
    <>
      <h1>Quotes</h1>
      <p className="sub">All quotes across leads and clients</p>

      <div className="toolbar">
        <div className="chip-row">
          <button className={openOnly ? "on" : ""} onClick={() => setOpenOnly(true)}>
            In flight
          </button>
          <button className={!openOnly ? "on" : ""} onClick={() => setOpenOnly(false)}>
            All
          </button>
        </div>
      </div>

      <div className="card">
        {sorted.length === 0 ? (
          <p className="muted small">No quotes.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <SortTh label="Account" colKey="account" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="Carrier" colKey="carrier" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="Premium" colKey="premium" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="Effective" colKey="effective" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="Status" colKey="status" sortKey={sortKey} dir={dir} onToggle={toggle} />
                </tr>
              </thead>
              <tbody>
                {sorted.map((q) => (
                  <tr
                    key={q.id}
                    className="clickable"
                    onClick={() => navigate(`/accounts/${q.accountId}?tab=quotes`)}
                  >
                    <td>
                      <strong>{accountName.get(q.accountId) ?? "—"}</strong>
                    </td>
                    <td>{q.carrierId ? carrierName.get(q.carrierId) ?? "—" : "—"}</td>
                    <td>{fmtMoney(q.premium)}</td>
                    <td>{fmtDate(q.effectiveDate)}</td>
                    <td>
                      <Badge {...statusBadge(QUOTE_STATUS_BADGE, q.status)} />
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
