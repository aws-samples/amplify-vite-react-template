import { useMemo, useState } from "react";
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
import { isOpenQuoteStatus } from "../lib/quoteStatus";
import { useAsyncResource } from "../lib/useAsyncResource";

export default function QuotesList() {
  const [openOnly, setOpenOnly] = useState(true);
  const navigate = useNavigate();

  const quoteRes = useAsyncResource(
    async () => (await client.models.Quote.list()).data,
    [],
    { initialData: [] as Quote[], errorMessage: "Failed to load quotes" }
  );
  const quotes = quoteRes.data;

  // Name lookups. Surfaced rather than ignored for the same reason as
  // PoliciesList: a missing name renders "—", which reads as data, not failure.
  const accountRes = useAsyncResource(
    async () => (await client.models.Account.list()).data,
    [],
    { initialData: [] as Account[], errorMessage: "Failed to load account names" }
  );
  const accounts = accountRes.data;

  const carrierRes = useAsyncResource(
    async () => (await client.models.Carrier.list()).data,
    [],
    { initialData: [] as Carrier[], errorMessage: "Failed to load carrier names" }
  );
  const carriers = carrierRes.data;

  const accountName = useMemo(
    () => new Map(accounts.map((a) => [a.id, a.name])),
    [accounts]
  );
  const carrierName = useMemo(
    () => new Map(carriers.map((c) => [c.id, c.name])),
    [carriers]
  );

  const visible = openOnly
    ? quotes.filter((q) => isOpenQuoteStatus(q.status))
    : quotes;

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

      {accountRes.error && <p className="error-text">{accountRes.error}</p>}
      {carrierRes.error && <p className="error-text">{carrierRes.error}</p>}

      <div className="card">
        {!quoteRes.loaded ? (
          <p className="muted small">Loading…</p>
        ) : quoteRes.error ? (
          <p className="error-text">{quoteRes.error}</p>
        ) : sorted.length === 0 ? (
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
