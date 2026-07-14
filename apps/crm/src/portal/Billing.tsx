import { useCallback, useEffect, useState } from "react";
import { api, unwrap, type Customer, type Invoice } from "../lib/api";
import { useRoles } from "../lib/auth";
import { fmtDate, money } from "../lib/format";
import { Badge, Button, Card, ErrorNote, ListRow, Page, Spinner, StatusBadge } from "../ui/kit";
import CollectPaymentSheet from "../components/CollectPaymentSheet";
import { loadMyCustomers } from "./portalData";

export default function PortalBilling() {
  const roles = useRoles();
  const [customers, setCustomers] = useState<Customer[] | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [pm, setPm] = useState<Record<string, { hasPaymentMethod: boolean; label: string | null }>>({});
  const [collectFor, setCollectFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const mine = await loadMyCustomers(roles);
      setCustomers(mine);
      const invLists = await Promise.all(
        mine.map((c) =>
          api().models.Invoice.list({
            filter: { customerId: { eq: c.id } },
            limit: 200,
          })
        )
      );
      setInvoices(
        invLists
          .flatMap((r) => unwrap(r))
          .sort((a, b) => (b.issuedAt ?? "").localeCompare(a.issuedAt ?? ""))
      );
      const summaries = await Promise.all(
        mine.map(async (c) => {
          const res = await api().queries.getPaymentMethodSummary({
            customerId: c.id,
          });
          return [c.id, res.data as { hasPaymentMethod: boolean; label: string | null }] as const;
        })
      );
      setPm(Object.fromEntries(summaries));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load billing");
    }
  }, [roles]);

  useEffect(() => {
    if (!roles.loading) void load();
  }, [roles.loading, load]);

  if (!customers) {
    return (
      <Page title="Billing">
        <ErrorNote error={error} />
        <Spinner />
      </Page>
    );
  }

  return (
    <Page title="Billing">
      <ErrorNote error={error} />
      {customers.map((c) => {
        const summary = pm[c.id];
        return (
          <Card
            key={c.id}
            title={customers.length > 1 ? `Payment method — ${c.displayName}` : "Payment method"}
            actions={
              summary?.hasPaymentMethod ? (
                <Badge tone="ok">on file</Badge>
              ) : (
                <Badge tone="warn">needed</Badge>
              )
            }
          >
            <p style={{ marginBottom: 10 }}>
              {summary === undefined
                ? "Checking…"
                : summary?.hasPaymentMethod
                  ? summary.label
                  : "Add a card or bank account so service can be billed."}
            </p>
            <Button small variant="subtle" onClick={() => setCollectFor(c.id)}>
              {summary?.hasPaymentMethod ? "Update payment method" : "Add payment method"}
            </Button>
          </Card>
        );
      })}

      <Card title="Invoices">
        {invoices.length === 0 ? (
          <p className="muted small">No invoices yet.</p>
        ) : (
          invoices.map((i) => (
            <ListRow
              key={i.id}
              title={money(i.amountCents)}
              subtitle={`${i.description} · ${fmtDate(i.issuedAt, true)}`}
              meta={<StatusBadge status={i.status} />}
            />
          ))
        )}
      </Card>

      {collectFor ? (
        <CollectPaymentSheet
          customerId={collectFor}
          open
          onClose={() => setCollectFor(null)}
          onSaved={() => {
            setCollectFor(null);
            setTimeout(() => void load(), 1500);
          }}
        />
      ) : null}
    </Page>
  );
}
