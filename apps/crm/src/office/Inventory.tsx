import { useState } from "react";
import {
  api,
  listAll,
  unwrap,
  type Product,
  type ProductStockEntry,
} from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useRoles } from "../lib/auth";
import { fmtDate } from "../lib/format";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNote,
  Field,
  ListRow,
  Page,
  Sheet,
  Spinner,
} from "../ui/kit";
import { formatMoney } from "../../../web/amplify/functions/shared/money";

/**
 * Light inventory: current on-hand for every tracked product, restock, and
 * hand-count corrections. On-hand is the running sum of the append-only
 * ProductStockEntry ledger — a PURCHASE/ADJUST the office enters here, plus the
 * USAGE entries report finalization writes — so it can't drift from a counter.
 * Owner-only, under More.
 */

function fmtQty(n: number): string {
  return (Math.round(n * 100) / 100).toString();
}
function money(cents: number): string {
  return formatMoney(cents);
}

type Row = {
  product: Product;
  onHand: number;
  entries: ProductStockEntry[];
};

export default function Inventory() {
  const roles = useRoles();
  const [entryFor, setEntryFor] = useState<{ row: Row; mode: "PURCHASE" | "ADJUST" } | null>(
    null
  );

  const { data, error, reload } = useAsync<Row[]>(
    async () => {
      const products = await listAll((t) =>
        api().models.Product.list({ limit: 500, nextToken: t })
      );
      const tracked = products.filter((p) => p.trackInventory);
      const built = await Promise.all(
        tracked.map(async (product): Promise<Row> => {
          const entries = await listAll((t) =>
            api().models.ProductStockEntry.listProductStockEntryByProductId(
              { productId: product.id },
              { limit: 500, nextToken: t }
            )
          );
          const onHand = entries.reduce(
            (s, e) => s + (e.deltaBaseUnits ?? 0),
            0
          );
          return { product, onHand, entries };
        })
      );
      // Low stock first, then by name — the ones needing attention lead.
      built.sort(
        (a, b) =>
          Number(isLow(b)) - Number(isLow(a)) ||
          (a.product.name ?? "").localeCompare(b.product.name ?? "")
      );
      return built;
    },
    [],
    "Could not load inventory"
  );
  // A failed load used to fall through to the empty state beside its error,
  // rather than spinning forever — keep that.
  const rows = data ?? (error ? [] : null);

  if (!roles.owner) {
    return (
      <Page title="Inventory" back="/more">
        <EmptyState title="Owners only" body="Inventory is managed by the owner." />
      </Page>
    );
  }

  return (
    <Page title="Inventory" back="/more">
      <Card title="On hand">
        <p className="muted small" style={{ marginBottom: 6 }}>
          Stock for products marked "Track stock" in the product log. On-hand
          falls automatically when a service report using the product is
          finalized; record deliveries with <strong>Restock</strong>, and fix a
          physical count with <strong>Adjust</strong>.
        </p>
        <ErrorNote error={error} />
        {rows === null ? (
          <Spinner label="Loading inventory…" />
        ) : rows.length === 0 ? (
          <EmptyState
            title="Nothing tracked yet"
            body="Turn on “Track stock” for a product in the product log to see it here."
          />
        ) : (
          rows.map((row) => {
            const unit = row.product.stockUnit ?? "";
            const low = isLow(row);
            const value =
              row.product.unitCostCents != null
                ? money(Math.max(0, row.onHand) * row.product.unitCostCents)
                : null;
            return (
              <ListRow
                key={row.product.id}
                title={
                  <span>
                    {row.product.name}{" "}
                    {low ? <Badge tone="warn">low</Badge> : null}
                    {row.onHand < 0 ? (
                      <Badge tone="danger">oversold</Badge>
                    ) : null}
                  </span>
                }
                subtitle={
                  [
                    `${fmtQty(row.onHand)} ${unit} on hand`,
                    typeof row.product.reorderPoint === "number"
                      ? `reorder at ${fmtQty(row.product.reorderPoint)} ${unit}`
                      : null,
                    value ? `≈ ${value} at cost` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ") || undefined
                }
                meta={
                  <>
                    <Button
                      small
                      variant="ghost"
                      onClick={() => setEntryFor({ row, mode: "PURCHASE" })}
                    >
                      Restock
                    </Button>
                    <Button
                      small
                      variant="ghost"
                      onClick={() => setEntryFor({ row, mode: "ADJUST" })}
                    >
                      Adjust
                    </Button>
                  </>
                }
              />
            );
          })
        )}
      </Card>

      <Sheet
        open={entryFor !== null}
        onClose={() => setEntryFor(null)}
        title={
          entryFor?.mode === "PURCHASE"
            ? `Restock ${entryFor.row.product.name}`
            : `Adjust ${entryFor?.row.product.name ?? ""}`
        }
      >
        {entryFor ? (
          <StockEntryForm
            row={entryFor.row}
            mode={entryFor.mode}
            enteredByEmail={roles.email}
            onDone={async () => {
              setEntryFor(null);
              reload();
            }}
          />
        ) : null}
      </Sheet>
    </Page>
  );
}

function isLow(row: Row): boolean {
  return (
    typeof row.product.reorderPoint === "number" &&
    row.onHand <= row.product.reorderPoint
  );
}

function StockEntryForm({
  row,
  mode,
  enteredByEmail,
  onDone,
}: {
  row: Row;
  mode: "PURCHASE" | "ADJUST";
  enteredByEmail: string | null;
  onDone: () => Promise<void>;
}) {
  const unit = row.product.stockUnit ?? "";
  // Restock adds an amount; adjust sets the counted on-hand and stores the delta.
  const [amount, setAmount] = useState("");
  const [unitCost, setUnitCost] = useState(
    mode === "PURCHASE" && row.product.unitCostCents != null
      ? (row.product.unitCostCents / 100).toFixed(2)
      : ""
  );
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const counted = Number(amount);
  const delta =
    mode === "PURCHASE" ? counted : Number.isFinite(counted) ? counted - row.onHand : NaN;

  async function save() {
    setError(null);
    if (amount.trim() === "" || !Number.isFinite(counted)) {
      setError(mode === "PURCHASE" ? "Enter how much you received." : "Enter the counted amount.");
      return;
    }
    if (mode === "PURCHASE" && counted <= 0) {
      setError("A restock has to be a positive amount.");
      return;
    }
    if (mode === "ADJUST" && counted < 0) {
      setError("On-hand can't be negative.");
      return;
    }
    if (mode === "ADJUST" && delta === 0) {
      setError("That's already the on-hand count — nothing to adjust.");
      return;
    }
    const parsedCost = unitCost.trim() !== "" ? Number(unitCost) : null;
    if (parsedCost != null && (!Number.isFinite(parsedCost) || parsedCost < 0)) {
      setError("The unit cost must be zero or greater.");
      return;
    }
    setBusy(true);
    try {
      unwrap(
        await api().models.ProductStockEntry.create({
          productId: row.product.id,
          deltaBaseUnits: delta,
          reason: mode,
          unitCostCents:
            mode === "PURCHASE" && parsedCost != null
              ? Math.round(parsedCost * 100)
              : null,
          note: note.trim() || null,
          enteredByEmail: enteredByEmail ?? "office",
          at: new Date().toISOString(),
        })
      );
      await onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the entry");
      setBusy(false);
    }
  }

  return (
    <div className="form-grid">
      <p className="muted small">
        Currently <strong>{fmtQty(row.onHand)} {unit}</strong> on hand.
      </p>
      <Field
        label={mode === "PURCHASE" ? `Amount received (${unit})` : `Counted on hand (${unit})`}
        hint={
          mode === "ADJUST" && Number.isFinite(delta) && amount.trim() !== ""
            ? `Adjustment: ${delta > 0 ? "+" : ""}${fmtQty(delta)} ${unit}`
            : undefined
        }
      >
        <input
          type="number"
          min="0"
          step="any"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder={mode === "PURCHASE" ? "128" : fmtQty(row.onHand)}
        />
      </Field>
      {mode === "PURCHASE" ? (
        <Field label={`Cost per ${unit} (USD, optional)`}>
          <input
            type="number"
            min="0"
            step="0.01"
            value={unitCost}
            onChange={(e) => setUnitCost(e.target.value)}
            placeholder="4.00"
          />
        </Field>
      ) : null}
      <Field label="Note (optional)">
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={mode === "PURCHASE" ? "PO #1234, ordered from Univar" : "Physical count 7/21"}
        />
      </Field>
      <ErrorNote error={error} />
      <Button block loading={busy} onClick={() => void save()}>
        {mode === "PURCHASE" ? "Add stock" : "Save adjustment"}
      </Button>
      {row.entries.length > 0 ? (
        <div style={{ marginTop: 8 }}>
          <span className="field-label">Recent activity</span>
          {[...row.entries]
            .sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""))
            .slice(0, 6)
            .map((e) => (
              <div key={e.id} className="muted small" style={{ padding: "2px 0" }}>
                {e.at ? fmtDate(e.at, true) : "—"} · {e.reason} ·{" "}
                {(e.deltaBaseUnits ?? 0) > 0 ? "+" : ""}
                {fmtQty(e.deltaBaseUnits ?? 0)} {unit}
                {e.note ? ` · ${e.note}` : ""}
              </div>
            ))}
        </div>
      ) : null}
    </div>
  );
}
