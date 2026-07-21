import { useCallback, useEffect, useMemo, useState } from "react";
import {
  api,
  listAll,
  type Product,
  type ProductStockEntry,
} from "../lib/api";
import { useRoles } from "../lib/auth";
import {
  Badge,
  Card,
  EmptyState,
  ErrorNote,
  Field,
  ListRow,
  Page,
  Spinner,
} from "../ui/kit";

/**
 * Product usage + cost-of-goods, derived from the stock ledger's USAGE entries
 * (the depletions report finalization writes). This reuses the exact amounts
 * that came off inventory — already in each product's stock unit — so there's
 * no unit-parsing here. It therefore covers TRACKED products only; untracked
 * products don't hit the ledger. Owner-only, under More.
 */

function fmtQty(n: number): string {
  return (Math.round(n * 100) / 100).toString();
}
function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
/** YYYY-MM-DD in local time, for the default range and the date inputs. */
function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

export default function ProductUsage() {
  const roles = useRoles();
  const today = useMemo(() => new Date(), []);
  const ninetyAgo = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - 90);
    return d;
  }, []);
  const [from, setFrom] = useState(isoDate(ninetyAgo));
  const [to, setTo] = useState(isoDate(today));
  const [products, setProducts] = useState<Product[] | null>(null);
  const [usage, setUsage] = useState<ProductStockEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [prods, entries] = await Promise.all([
        listAll((t) => api().models.Product.list({ limit: 500, nextToken: t })),
        listAll((t) =>
          api().models.ProductStockEntry.list({ limit: 1000, nextToken: t })
        ),
      ]);
      setProducts(prods);
      setUsage(entries.filter((e) => e.reason === "USAGE"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load usage");
      setProducts([]);
      setUsage([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo(() => {
    if (!products || !usage) return null;
    const byId = new Map(products.map((p) => [p.id, p]));
    // Inclusive date window (compare on the YYYY-MM-DD prefix of `at`).
    const inRange = usage.filter((e) => {
      const day = (e.at ?? "").slice(0, 10);
      return day && day >= from && day <= to;
    });
    const agg = new Map<
      string,
      { used: number; applications: number; costCents: number }
    >();
    for (const e of inRange) {
      const p = byId.get(e.productId);
      const used = Math.abs(e.deltaBaseUnits ?? 0); // USAGE deltas are negative
      const cur = agg.get(e.productId) ?? { used: 0, applications: 0, costCents: 0 };
      cur.used += used;
      cur.applications += 1;
      if (p?.unitCostCents != null) cur.costCents += used * p.unitCostCents;
      agg.set(e.productId, cur);
    }
    return [...agg.entries()]
      .map(([productId, v]) => ({
        product: byId.get(productId),
        productId,
        ...v,
      }))
      .sort((a, b) => b.costCents - a.costCents || b.used - a.used);
  }, [products, usage, from, to]);

  const totalCost = useMemo(
    () => (rows ?? []).reduce((s, r) => s + r.costCents, 0),
    [rows]
  );

  if (!roles.owner) {
    return (
      <Page title="Product usage" back="/more">
        <EmptyState title="Owners only" body="Product usage is owner-only." />
      </Page>
    );
  }

  return (
    <Page title="Product usage" back="/more">
      <Card title="Usage & cost of goods">
        <p className="muted small" style={{ marginBottom: 6 }}>
          Product consumed on finalized service reports, from the stock ledger.
          Covers products with inventory tracking on; cost uses each product's
          unit cost.
        </p>
        <div className="form-row-2" style={{ marginBottom: 10 }}>
          <Field label="From">
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="To">
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
        </div>
        <ErrorNote error={error} />
        {rows === null ? (
          <Spinner label="Loading usage…" />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No usage in this range"
            body="Finalized reports that use a tracked product will show here."
          />
        ) : (
          <>
            {rows.map((r) => {
              const unit = r.product?.stockUnit ?? "";
              return (
                <ListRow
                  key={r.productId}
                  title={r.product?.name ?? r.productId}
                  subtitle={`${fmtQty(r.used)} ${unit} · ${r.applications} application${
                    r.applications === 1 ? "" : "s"
                  }`}
                  meta={
                    r.product?.unitCostCents != null ? (
                      <Badge tone="muted">{money(r.costCents)}</Badge>
                    ) : (
                      <Badge tone="info">no cost set</Badge>
                    )
                  }
                />
              );
            })}
            <div
              className="row-split"
              style={{ marginTop: 10, fontWeight: 600 }}
            >
              <span>Total cost of goods</span>
              <span>{money(totalCost)}</span>
            </div>
          </>
        )}
      </Card>
    </Page>
  );
}
