import { useEffect, useState } from "react";
import {
  client,
  fmtDate,
  fmtMoney,
  friendlyError,
  listAllPages,
  type Account,
  type Carrier,
  type Quote,
} from "../lib/client";
import { useSort, SortTh } from "../lib/useSort";
import CoverageForm from "./CoverageForm";

const STATUS_BADGE: Record<string, string> = {
  DRAFT: "gray",
  SUBMITTED: "blue",
  QUOTED: "amber",
  PRESENTED: "amber",
  BOUND: "green",
  DECLINED: "red",
  LOST: "red",
};

const OPEN_STATUSES = ["DRAFT", "SUBMITTED", "QUOTED", "PRESENTED"] as const;

/** Commission is baked into the premium — the $ figure is the agency's cut,
 * never an addition on top. */
export function commissionCell(q: {
  premium?: number | null;
  commissionPct?: number | null;
}): string {
  if (q.commissionPct == null) return "—";
  const dollars =
    q.premium != null ? fmtMoney((q.premium * q.commissionPct) / 100) : null;
  return dollars ? `${q.commissionPct}% · ${dollars}` : `${q.commissionPct}%`;
}

export function termsSummary(q: {
  perOccurrenceDeductible?: number | null;
  perUnitDeductible?: number | null;
  blanketLimit?: number | null;
  coinsurancePct?: number | null;
  replacementCostType?: string | null;
}): string {
  const parts = [
    q.perOccurrenceDeductible != null && `${fmtMoney(q.perOccurrenceDeductible)} occ ded`,
    q.perUnitDeductible != null && `${fmtMoney(q.perUnitDeductible)} unit ded`,
    q.blanketLimit != null && `${fmtMoney(q.blanketLimit)} blanket`,
    q.coinsurancePct != null && `${q.coinsurancePct}% coins`,
    q.replacementCostType,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "—";
}

/**
 * Quotes for an account. Binding a quote is the conversion event: it creates
 * a Policy and flips the account LEAD → CLIENT in place.
 */
export default function QuotesPanel({
  account,
  onAccountChange,
}: {
  account: Account;
  onAccountChange: (a: Account) => void;
}) {
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [carrierRows, setCarrierRows] = useState<Carrier[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Quote | null>(null);
  const [binding, setBinding] = useState<Quote | null>(null);
  const [error, setError] = useState("");

  async function refresh() {
    const data = await listAllPages((nextToken) =>
      client.models.Quote.list({
        filter: { accountId: { eq: account.id } },
        nextToken,
      })
    );
    setQuotes(data);
  }

  useEffect(() => {
    refresh();
    client.models.Carrier.list().then(({ data }) => setCarrierRows(data));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account.id]);

  async function setStatus(quote: Quote, status: Quote["status"]) {
    await client.models.Quote.update({ id: quote.id, status });
    refresh();
  }

  // Carrier picker order only — no header to click, so the default stands.
  const { sorted: carriers } = useSort(carrierRows, { name: (c) => c.name }, "name");

  const carrierName = (id: string | null | undefined) =>
    carriers.find((c) => c.id === id)?.name ?? "—";

  // Newest quote first, as the fetch used to order them.
  const { sorted, sortKey, dir, toggle } = useSort(
    quotes,
    {
      carrier: (q) => (q.carrierId ? carrierName(q.carrierId) : null),
      lines: (q) => (q.lines ?? []).filter(Boolean).join(", "),
      premium: (q) => q.premium,
      commission: (q) => q.commissionPct,
      effective: (q) => q.effectiveDate,
      status: (q) => q.status,
      created: (q) => q.createdAt,
    },
    "created",
    "desc"
  );

  return (
    <div>
      <div className="toolbar">
        <div className="grow" />
        <button
          className="primary"
          onClick={() => {
            setEditing(null);
            setShowForm(!showForm);
          }}
        >
          {showForm ? "Cancel" : "+ New quote"}
        </button>
      </div>

      {(showForm || editing) && (
        <CoverageForm
          key={editing?.id ?? "new"}
          kind="quote"
          accountId={account.id}
          carriers={carriers}
          existing={editing}
          onSaved={() => {
            setShowForm(false);
            setEditing(null);
            refresh();
          }}
          onCancel={() => {
            setShowForm(false);
            setEditing(null);
          }}
        />
      )}

      {quotes.length === 0 ? (
        <p className="muted small">No quotes yet.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <SortTh label="Carrier" colKey="carrier" sortKey={sortKey} dir={dir} onToggle={toggle} />
                <SortTh label="Lines" colKey="lines" sortKey={sortKey} dir={dir} onToggle={toggle} />
                <SortTh label="Premium" colKey="premium" sortKey={sortKey} dir={dir} onToggle={toggle} />
                <SortTh label="Commission" colKey="commission" sortKey={sortKey} dir={dir} onToggle={toggle} />
                <th>Terms</th>
                <SortTh label="Effective" colKey="effective" sortKey={sortKey} dir={dir} onToggle={toggle} />
                <SortTh label="Status" colKey="status" sortKey={sortKey} dir={dir} onToggle={toggle} />
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((qt) => (
                <tr key={qt.id}>
                  <td>{carrierName(qt.carrierId)}</td>
                  <td className="small">{(qt.lines ?? []).filter(Boolean).join(", ") || "—"}</td>
                  <td>{fmtMoney(qt.premium)}</td>
                  <td className="small">{commissionCell(qt)}</td>
                  <td className="small">{termsSummary(qt)}</td>
                  <td>{fmtDate(qt.effectiveDate)}</td>
                  <td>
                    <span className={`badge ${STATUS_BADGE[qt.status] ?? "gray"}`}>
                      {qt.status}
                    </span>
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <button
                      className="link"
                      onClick={() => {
                        setShowForm(false);
                        setEditing(qt);
                      }}
                    >
                      Edit
                    </button>
                    {(OPEN_STATUSES as readonly string[]).includes(qt.status) && (
                      <>
                        <select
                          className="small"
                          value={qt.status}
                          onChange={(e) =>
                            setStatus(qt, e.target.value as Quote["status"])
                          }
                        >
                          {[...OPEN_STATUSES, "DECLINED", "LOST"]
                            .slice()
                            .sort((a, b) => a.localeCompare(b))
                            .map((s) => (
                              <option key={s}>{s}</option>
                            ))}
                        </select>{" "}
                        <button className="link" onClick={() => setBinding(qt)}>
                          Bind
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {binding && (
        <BindForm
          quote={binding}
          account={account}
          onDone={(updated) => {
            setBinding(null);
            refresh();
            if (updated) onAccountChange(updated);
          }}
          onError={setError}
        />
      )}
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}

function BindForm({
  quote,
  account,
  onDone,
  onError,
}: {
  quote: Quote;
  account: Account;
  onDone: (updatedAccount: Account | null) => void;
  onError: (msg: string) => void;
}) {
  const [policyNumber, setPolicyNumber] = useState("");
  const [saving, setSaving] = useState(false);

  // A quote must carry real terms before it can become a policy.
  const blockers = [
    !quote.carrierId && "a carrier",
    !(quote.premium && quote.premium > 0) && "a premium",
    !quote.effectiveDate && "an effective date",
    !(quote.lines ?? []).filter(Boolean).length && "at least one line",
  ].filter(Boolean) as string[];

  async function bind() {
    setSaving(true);
    onError("");
    try {
      // 1. Policy from the accepted quote (terms + commission carry over)
      const { data: policy, errors: pErr } = await client.models.Policy.create({
        accountId: account.id,
        quoteId: quote.id,
        carrierId: quote.carrierId ?? undefined,
        policyNumber: policyNumber.trim() || undefined,
        status: "ACTIVE",
        lines: (quote.lines ?? []).filter((l): l is string => !!l),
        premium: quote.premium ?? undefined,
        commissionPct: quote.commissionPct ?? undefined,
        // Limits are what print on the COI — they must survive the bind.
        glEachOccurrence: quote.glEachOccurrence ?? undefined,
        glDamageToRentedPremises: quote.glDamageToRentedPremises ?? undefined,
        glMedicalExpense: quote.glMedicalExpense ?? undefined,
        glPersonalAdvInjury: quote.glPersonalAdvInjury ?? undefined,
        glGeneralAggregate: quote.glGeneralAggregate ?? undefined,
        glProductsCompletedOps: quote.glProductsCompletedOps ?? undefined,
        glClaimsMade: quote.glClaimsMade ?? undefined,
        glAggregateAppliesTo: quote.glAggregateAppliesTo ?? undefined,
        perOccurrenceDeductible: quote.perOccurrenceDeductible ?? undefined,
        perUnitDeductible: quote.perUnitDeductible ?? undefined,
        blanketLimit: quote.blanketLimit ?? undefined,
        coinsurancePct: quote.coinsurancePct ?? undefined,
        replacementCostType: quote.replacementCostType ?? undefined,
        effectiveDate: quote.effectiveDate ?? undefined,
        expirationDate: quote.expirationDate ?? undefined,
      });
      if (pErr?.length || !policy) throw new Error(pErr?.[0]?.message);

      // 2. Mark the quote bound
      await client.models.Quote.update({ id: quote.id, status: "BOUND" });

      // 3. Convert the lead in place — the only path to CLIENT
      let updated: Account | null = null;
      if (account.stage === "LEAD") {
        const { data } = await client.models.Account.update({
          id: account.id,
          stage: "CLIENT",
          convertedAt: new Date().toISOString(),
        });
        updated = data;
      }
      onDone(updated);
    } catch (err) {
      onError(friendlyError(err, "Bind failed"));
      onDone(null);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card" style={{ background: "#f0f7ef", marginTop: 14 }}>
      <h3 style={{ marginTop: 0 }}>Bind quote</h3>
      <p className="small muted">
        Creates a policy{account.stage === "LEAD" ? " and converts this lead to a client" : ""}.
      </p>
      {blockers.length > 0 ? (
        <>
          <p className="error-text">
            This quote can't be bound yet — it needs {blockers.join(", ")}.
            Edit the quote details first.
          </p>
          <div className="form-actions">
            <button className="secondary" onClick={() => onDone(null)}>
              Close
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="form-grid">
            <div className="field">
              <label>Policy number (can be added later)</label>
              <input
                value={policyNumber}
                onChange={(e) => setPolicyNumber(e.target.value)}
              />
            </div>
          </div>
          <div className="form-actions">
            <button className="primary" disabled={saving} onClick={bind}>
              {saving ? "Binding…" : "Confirm bind"}
            </button>
            <button className="secondary" onClick={() => onDone(null)}>
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}
