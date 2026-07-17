import { useCallback, useEffect, useState } from "react";
import {
  api,
  opResult,
  payInvoice,
  unwrap,
  type Customer,
  type Invoice,
} from "../lib/api";
import { useRoles } from "../lib/auth";
import { fmtDate, money, todayEastern } from "../lib/format";
import { daysPastDue } from "../lib/aging";
import { isOverdue } from "../lib/recovery";
import {
  Badge,
  Button,
  Card,
  ErrorNote,
  ListRow,
  Page,
  Spinner,
  StatusBadge,
  SuccessNote,
} from "../ui/kit";
import CollectPaymentSheet from "../components/CollectPaymentSheet";
import { loadMyCustomers } from "./portalData";

export default function PortalBilling() {
  const roles = useRoles();
  const [customers, setCustomers] = useState<Customer[] | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [pm, setPm] = useState<Record<string, { hasPaymentMethod: boolean; label: string | null }>>({});
  const [collectFor, setCollectFor] = useState<string | null>(null);
  const [payingId, setPayingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
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
          return [
            c.id,
            opResult<{ hasPaymentMethod: boolean; label: string | null }>(
              res
            ) ?? { hasPaymentMethod: false, label: null },
          ] as const;
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

  // Pay one invoice off the customer's saved card. Never claims a false
  // "paid": only an explicit success settles the copy, a declined card is
  // surfaced as an error, and anything genuinely in flight says so.
  const pay = async (inv: Invoice) => {
    setPayingId(inv.id);
    setError(null);
    setNotice(null);
    try {
      // The mutation records an off-session decline as FAILED and returns it
      // rather than throwing, so a declined card must be surfaced from the
      // status — not mistaken for a pending success.
      const res = opResult<{ status?: string; failureReason?: string }>(
        await payInvoice({ invoiceId: inv.id })
      );
      const status = res?.status;
      if (status === "FAILED") {
        throw new Error(
          res?.failureReason
            ? `The card was declined — ${res.failureReason}. Try updating your payment method.`
            : "The card was declined. Try updating your payment method."
        );
      }
      setNotice(
        status === "PAID"
          ? `Paid ${money(inv.amountCents)} — thank you. A receipt is on its way.`
          : `Payment for ${money(inv.amountCents)} is processing — we'll email a receipt once it settles.`
      );
      setTimeout(() => void load(), 1500);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Payment could not be completed"
      );
    } finally {
      setPayingId(null);
    }
  };

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
      <SuccessNote message={notice} />
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
          invoices.map((i) => {
            const payable = i.status === "OPEN" || i.status === "FAILED";
            const summary = pm[i.customerId];
            const hasCard = summary?.hasPaymentMethod ?? false;
            const today = todayEastern();
            const overdue = isOverdue(i, today);
            const daysLate = daysPastDue(i, today);
            return (
              <ListRow
                key={i.id}
                title={money(i.amountCents)}
                subtitle={
                  <>
                    {`${i.description} · ${fmtDate(i.issuedAt, true)}`}
                    {i.dueDate ? (
                      <span className="nested-line">
                        {overdue
                          ? `Was due ${fmtDate(i.dueDate, true)} — ${daysLate} day${daysLate === 1 ? "" : "s"} overdue`
                          : `Due ${fmtDate(i.dueDate, true)}`}
                      </span>
                    ) : null}
                    {i.status === "FAILED" ? (
                      <span className="nested-line">
                        Card declined
                        {i.failureReason ? ` — ${i.failureReason}` : ""}. Please
                        pay below or update your card.
                      </span>
                    ) : null}
                  </>
                }
                meta={
                  <>
                    {overdue ? (
                      <Badge tone="danger">overdue</Badge>
                    ) : (
                      <StatusBadge status={i.status} />
                    )}
                    {payable ? (
                      hasCard ? (
                        <Button
                          small
                          loading={payingId === i.id}
                          disabled={payingId !== null}
                          onClick={() => void pay(i)}
                        >
                          Pay {money(i.amountCents)} now
                        </Button>
                      ) : (
                        <Button
                          small
                          variant="subtle"
                          onClick={() => setCollectFor(i.customerId)}
                        >
                          Add a card to pay
                        </Button>
                      )
                    ) : null}
                  </>
                }
              />
            );
          })
        )}
        {invoices.some((i) => i.status === "OPEN" || i.status === "FAILED") ? (
          <p className="muted small" style={{ marginTop: 8 }}>
            Paying here charges the card on file. It reaches us right away and we
            email a receipt.
          </p>
        ) : null}
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
