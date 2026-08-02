import { useState } from "react";
import {
  client,
  fmtDate,
  fmtMoney,
  listAllPages,
  type Carrier,
  type Policy,
} from "../../lib/client";
import { useAsyncResource } from "../../lib/useAsyncResource";
import { useSort, SortTh } from "../../lib/useSort";
import { commissionCell, termsSummary } from "../../components/QuotesPanel";
import CoverageForm from "../../components/CoverageForm";
import { SaveStatus, useSaveStatus } from "../../components/SaveStatus";

export function PoliciesTab({ accountId }: { accountId: string }) {
  const [editing, setEditing] = useState<Policy | null>(null);
  // Persistent: the row this refers to stays on screen, so nothing about it
  // stops being true after a few seconds.
  const saveStatus = useSaveStatus();

  const policyRes = useAsyncResource(
    () =>
      listAllPages((nextToken) =>
        client.models.Policy.list({
          filter: { accountId: { eq: accountId } },
          nextToken,
        })
      ),
    [accountId],
    { initialData: [] as Policy[], errorMessage: "Failed to load policies" }
  );
  const policies = policyRes.data;
  const setPolicies = policyRes.setData;
  // Identity-stable, so CoverageForm's `onSaved` no longer closes over a
  // fresh function every render.
  const refresh = policyRes.refetch;

  // Agency-wide, not account-scoped — its own resource on its own deps, so a
  // policy refresh doesn't re-read the carrier table and an account switch
  // doesn't blank the carrier names while it does.
  const carrierRes = useAsyncResource(
    async () => (await client.models.Carrier.list()).data,
    [],
    { initialData: [] as Carrier[] }
  );
  const carrierRows = carrierRes.data;

  async function updatePolicy(id: string, patch: Partial<Policy>) {
    await saveStatus.run(
      async () => {
        // `errors` used to be dropped on the floor here: a rejected status
        // change left the <select> showing the value it had failed to save.
        const { data, errors } = await client.models.Policy.update({ id, ...patch });
        if (errors?.length || !data) throw new Error(errors?.[0]?.message);
        setPolicies((ps) => ps.map((p) => (p.id === id ? data : p)));
      },
      { savedMessage: "Policy updated.", errorMessage: "Couldn't update that policy." }
    );
  }

  // Carrier picker order only — no header to click, so the default stands.
  const { sorted: carriers } = useSort(carrierRows, { name: (c) => c.name }, "name");

  const carrierName = (id: string | null | undefined) =>
    carriers.find((c) => c.id === id)?.name ?? "—";

  // Most recently effective policy first, as the fetch used to order them.
  const { sorted, sortKey, dir, toggle } = useSort(
    policies,
    {
      number: (p) => p.policyNumber,
      carrier: (p) => (p.carrierId ? carrierName(p.carrierId) : null),
      lines: (p) => (p.lines ?? []).filter(Boolean).join(", "),
      premium: (p) => p.premium,
      commission: (p) => p.commissionPct,
      effective: (p) => p.effectiveDate,
      expires: (p) => p.expirationDate,
      status: (p) => p.status,
    },
    "effective",
    "desc"
  );

  return (
    <div className="card">
      <h2>Policies</h2>
      {/* Status changes are made from the per-row <select>, so the panel-level
          line is where their outcome lands. */}
      <SaveStatus {...saveStatus.status} />

      {editing && (
        <CoverageForm
          key={editing.id}
          kind="policy"
          accountId={accountId}
          carriers={carriers}
          existing={editing}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
          onCancel={() => setEditing(null)}
        />
      )}

      {/* Surfaced rather than ignored: without carriers every row's carrier
          column reads "—", indistinguishable from a policy with none set. */}
      {carrierRes.error && <p className="error-text">{carrierRes.error}</p>}

      {!policyRes.loaded ? (
        <p className="muted small">Loading…</p>
      ) : policyRes.error ? (
        <p className="error-text">{policyRes.error}</p>
      ) : policies.length === 0 ? (
        <p className="muted small">
          No policies. Policies are created by binding a quote.
        </p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <SortTh label="Policy #" colKey="number" sortKey={sortKey} dir={dir} onToggle={toggle} />
                <SortTh label="Carrier" colKey="carrier" sortKey={sortKey} dir={dir} onToggle={toggle} />
                <SortTh label="Lines" colKey="lines" sortKey={sortKey} dir={dir} onToggle={toggle} />
                <SortTh label="Premium" colKey="premium" sortKey={sortKey} dir={dir} onToggle={toggle} />
                <SortTh label="Commission" colKey="commission" sortKey={sortKey} dir={dir} onToggle={toggle} />
                <th>Terms</th>
                <SortTh label="Effective" colKey="effective" sortKey={sortKey} dir={dir} onToggle={toggle} />
                <SortTh label="Expires" colKey="expires" sortKey={sortKey} dir={dir} onToggle={toggle} />
                <SortTh label="Status" colKey="status" sortKey={sortKey} dir={dir} onToggle={toggle} />
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((p) => (
                <tr key={p.id}>
                  <td>{p.policyNumber || "—"}</td>
                  <td className="small">{carrierName(p.carrierId)}</td>
                  <td className="small">{(p.lines ?? []).filter(Boolean).join(", ") || "—"}</td>
                  <td>{fmtMoney(p.premium)}</td>
                  <td className="small">{commissionCell(p)}</td>
                  <td className="small">{termsSummary(p)}</td>
                  <td>{fmtDate(p.effectiveDate)}</td>
                  <td>{fmtDate(p.expirationDate)}</td>
                  <td>
                    <select
                      value={p.status}
                      onChange={(e) =>
                        updatePolicy(p.id, { status: e.target.value as Policy["status"] })
                      }
                    >
                      {["ACTIVE", "CANCELLED", "EXPIRED", "NON_RENEWED"].map((s) => (
                        <option key={s}>{s}</option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <button className="link" onClick={() => setEditing(p)}>
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
