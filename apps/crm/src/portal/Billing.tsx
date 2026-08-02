import { useCallback, useEffect, useState } from "react";
import {
  api,
  listAll,
  opResult,
  payInvoice,
  type Customer,
  type Invoice,
} from "../lib/api";
import { useRoles } from "../lib/auth";
import { useAction } from "../lib/useAsync";
import { fmtDate, money, todayEastern } from "../lib/format";
import { daysPastDue } from "../lib/aging";
import { isOverdue } from "../lib/recovery";
import {
  Badge,
  Button,
  Card,
  CollapsibleCard,
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
          listAll((t) =>
            api().models.Invoice.list({
              filter: { customerId: { eq: c.id } },
              limit: 200,
              nextToken: t,
            })
          )
        )
      );
      setInvoices(
        invLists
          .flat()
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
  // The single-flight gate is what stops a double-click from charging the card
  // twice; the `disabled` button alone never did.
  const payAction = useAction(async (inv: Invoice) => {
    setError(null);
    setNotice(null);
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
  }, "Payment could not be completed");

  // `payingId` stays: the gate allows only one payment at a time, but the row
  // that is paying still needs its own spinner.
  const pay = async (inv: Invoice) => {
    setPayingId(inv.id);
    try {
      await payAction.run(inv);
    } finally {
      setPayingId(null);
    }
  };

  if (!customers) {
    return (
      <Page title="Billing">
        <ErrorNote error={error ?? payAction.error} />
        <Spinner />
      </Page>
    );
  }

  return (
    <Page title="Billing">
      <ErrorNote error={error ?? payAction.error} />
      <SuccessNote message={notice} />
      {customers.map((c) => {
        const summary = pm[c.id];
        // Until the summary actually arrives we know NOTHING about this
        // property's payment method — so show nothing. Rendering the tile
        // early flashed a false "needed" badge (and an "Add payment method"
        // button) at a property that already had a card on file.
        const checking = summary === undefined;
        return (
          <Card
            key={c.id}
            title={customers.length > 1 ? `Payment method — ${c.displayName}` : "Payment method"}
            actions={
              checking ? null : summary.hasPaymentMethod ? (
                <Badge tone="ok">on file</Badge>
              ) : (
                <Badge tone="warn">needed</Badge>
              )
            }
          >
            {/* Only the FACTS wait on the lookup — the action stays available.
                A failed summary query never resolves, so gating the button on
                it would leave a property unable to add a payment method. */}
            {checking ? (
              <p className="muted small" style={{ marginBottom: 10 }}>
                Checking…
              </p>
            ) : (
              <p style={{ marginBottom: 10 }}>
                {summary.hasPaymentMethod
                  ? summary.label
                  : "Add a card or bank account so service can be billed."}
              </p>
            )}
            <Button small variant="subtle" onClick={() => setCollectFor(c.id)}>
              {checking
                ? "Add or update payment method"
                : summary.hasPaymentMethod
                  ? "Update payment method"
                  : "Add payment method"}
            </Button>
          </Card>
        );
      })}

      <CollapsibleCard
        title="Invoices"
        count={invoices.length}
        // A collapsed card still has to surface money owed, or a portfolio
        // login could close the page without noticing an overdue balance.
        summary={
          invoices.length === 0
            ? "No invoices yet."
            : (() => {
                const open = invoices.filter(
                  (i) => i.status === "OPEN" || i.status === "FAILED"
                );
                const due = open.reduce((sum, i) => sum + (i.amountCents ?? 0), 0);
                return open.length === 0
                  ? "All paid. Open to review."
                  : `${open.length} awaiting payment · ${money(due)} due. Open to pay.`;
              })()
        }
      >
        {invoices.length === 0 ? (
          <p className="muted small">No invoices yet.</p>
        ) : (
          invoices.map((i) => {
            // GL-06: an in-flight bank debit is not payable — offering "Pay
            // now" while it clears would charge the customer twice.
            const debitClearing = Boolean(
              (i as { pendingDebitIntentId?: string | null })
                .pendingDebitIntentId
            );
            const payable =
              (i.status === "OPEN" || i.status === "FAILED") && !debitClearing;
            const summary = pm[i.customerId];
            const hasCard = summary?.hasPaymentMethod ?? false;
            const today = todayEastern();
            const overdue = isOverdue(i, today);
            const daysLate = daysPastDue(i, today);
            // A management-company login sees every property's invoices in one
            // list, so each row must name the property it belongs to.
            const propertyName =
              customers.length > 1
                ? customers.find((c) => c.id === i.customerId)?.displayName
                : null;
            return (
              <ListRow
                key={i.id}
                title={
                  propertyName ? `${money(i.amountCents)} · ${propertyName}` : money(i.amountCents)
                }
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
                    {debitClearing ? (
                      <span className="nested-line">
                        Your bank payment is processing — this can take a few
                        business days. No action needed, and please don&rsquo;t
                        pay again.
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
      </CollapsibleCard>

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
