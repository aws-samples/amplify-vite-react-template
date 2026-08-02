import { useCallback, useMemo, useState } from "react";
import { api, listAll, type Product } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useRoles } from "../lib/auth";
import {
  aggregateProductUsage,
  type ReportProduct,
  type UsageAggregateRow,
} from "../../../web/amplify/functions/shared/inventory";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNote,
  Field,
  ListRow,
  Page,
  Spinner,
} from "../ui/kit";
import { formatMoney } from "../../../web/amplify/functions/shared/money";

/**
 * Product usage across a custom date range: the total amount of every chemical
 * USED (not bought) on finalized service reports. Sourced from each report's
 * productsUsed rather than the stock ledger, so it covers EVERY product a tech
 * recorded — inventory-tracked or not. Amounts fold into a product's stock unit
 * where convertible and stay per-unit where not (see aggregateProductUsage).
 * Cost of goods is computed for tracked products with a unit cost. Owner-only.
 */

function fmtQty(n: number): string {
  return (Math.round(n * 100) / 100).toString();
}
function money(cents: number): string {
  return formatMoney(cents);
}
/** YYYY-MM-DD in local time, for the default range and the date inputs. */
function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}
/** The joined per-unit total, e.g. "128 fl oz · 6 each", or a dash when the
 *  amount was never recorded. */
function usedLabel(row: UsageAggregateRow): string {
  if (!row.byUnit.length) return "amount not recorded";
  return row.byUnit.map((u) => `${fmtQty(u.value)} ${u.unit}`).join(" · ");
}
/** Coerce a report's productsUsed json into typed rows, tolerating null and a
 *  legacy stringified value. */
function toReportRows(v: unknown): ReportProduct[] {
  if (Array.isArray(v)) return v as ReportProduct[];
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? (parsed as ReportProduct[]) : [];
    } catch {
      return [];
    }
  }
  return [];
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
  const { data, error } = useAsync<{
    products: Product[];
    reportRows: ReportProduct[][];
  }>(
    async () => {
      // Bound the scan to FINALIZED reports in the range. serviceDate is a
      // UTC-Z ISO string, so a lexical `between` on the day bounds is correct;
      // an exact client-side prefix filter belts-and-suspenders the edges.
      const toEnd = `${to}T23:59:59.999Z`;
      const [prods, reports] = await Promise.all([
        listAll((t) => api().models.Product.list({ limit: 500, nextToken: t })),
        listAll((t) =>
          api().models.ServiceReport.list({
            limit: 500,
            nextToken: t,
            filter: {
              status: { eq: "FINALIZED" },
              serviceDate: { between: [from, toEnd] },
            },
          })
        ),
      ]);
      return {
        products: prods,
        reportRows: reports
          .filter((r) => {
            const day = (r.serviceDate ?? "").slice(0, 10);
            return day && day >= from && day <= to;
          })
          .map((r) => toReportRows(r.productsUsed)),
      };
    },
    [from, to],
    "Could not load usage"
  );

  const rows = useMemo(() => {
    // A failed load used to aggregate two empty lists, landing on the empty
    // state beside its error rather than spinning forever — keep that.
    if (!data) return error ? [] : null;
    return aggregateProductUsage(data.reportRows, data.products);
  }, [data, error]);

  const totalCost = useMemo(
    () => (rows ?? []).reduce((s, r) => s + r.costCents, 0),
    [rows]
  );

  const exportCsv = useCallback(() => {
    if (!rows) return;
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const header = [
      "Product",
      "EPA number",
      "Used",
      "Applications",
      "Inventory tracked",
      "Cost of goods",
    ];
    const lines = [
      header.join(","),
      ...rows.map((r) =>
        [
          r.name,
          r.epaNumber ?? "",
          usedLabel(r),
          r.applications,
          r.tracked ? "yes" : "no",
          r.costCents > 0 ? money(r.costCents) : "",
        ]
          .map(esc)
          .join(",")
      ),
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `product-usage-${from}-to-${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [rows, from, to]);

  if (!roles.owner) {
    return (
      <Page title="Product usage" back="/more">
        <EmptyState title="Owners only" body="Product usage is owner-only." />
      </Page>
    );
  }

  return (
    <Page title="Product usage" back="/more">
      <Card title="Chemical usage">
        <p className="muted small" style={{ marginBottom: 6 }}>
          Total amount of each product applied on finalized service reports in
          the range — every chemical a tech recorded, not just inventory-tracked
          ones. Cost of goods is shown for tracked products with a unit cost.
        </p>
        <div className="form-row-2" style={{ marginBottom: 10 }}>
          <Field label="From">
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="To">
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            marginBottom: 8,
          }}
        >
          <Button
            small
            variant="ghost"
            disabled={!rows || rows.length === 0}
            onClick={exportCsv}
          >
            Export CSV
          </Button>
        </div>
        <ErrorNote error={error} />
        {rows === null ? (
          <Spinner label="Loading usage…" />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No usage in this range"
            body="Finalized reports that applied a product will show here."
          />
        ) : (
          <>
            {rows.map((r) => (
              <ListRow
                key={r.productId ?? `${r.name}·${r.epaNumber ?? ""}`}
                title={r.name}
                subtitle={`${usedLabel(r)} · ${r.applications} application${
                  r.applications === 1 ? "" : "s"
                }${r.hasUnmeasuredUse ? " · some amounts not recorded" : ""}`}
                meta={
                  r.costCents > 0 ? (
                    <Badge tone="muted">{money(r.costCents)}</Badge>
                  ) : r.tracked ? (
                    <Badge tone="info">no cost set</Badge>
                  ) : (
                    <Badge tone="info">untracked</Badge>
                  )
                }
              />
            ))}
            <div className="row-split" style={{ marginTop: 10, fontWeight: 600 }}>
              <span>Total cost of goods (tracked)</span>
              <span>{money(totalCost)}</span>
            </div>
          </>
        )}
      </Card>
    </Page>
  );
}
