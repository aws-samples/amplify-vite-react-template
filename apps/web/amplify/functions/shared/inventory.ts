/**
 * Light inventory: turning a finalized service report's product rows into
 * stock-ledger depletions, and summing the ledger back to on-hand. Pure and
 * unit-tested; the crm-docs finalize handler and the daily-reminders low-stock
 * check wrap these with the actual data-client reads/writes.
 */
import { convert, parseAmount } from "./units";
import type { ReportProduct } from "./pdf";

/** The catalog fields inventory cares about (a subset of the Product model). */
export type InventoryProduct = {
  id: string;
  name?: string | null;
  epaNumber?: string | null;
  trackInventory?: boolean | null;
  stockUnit?: string | null;
  reorderPoint?: number | null;
  unitCostCents?: number | null;
};

/**
 * Resolve a report's product row to its catalog product: the exact `productId`
 * link when the tech app recorded one, otherwise the same case-insensitive
 * name+EPA match finalize validation uses. Null when nothing matches.
 */
export function matchCatalogProduct<T extends InventoryProduct>(
  row: ReportProduct,
  catalog: T[]
): T | null {
  if (row.productId) {
    const byId = catalog.find((c) => c.id === row.productId);
    if (byId) return byId;
  }
  const name = (row.name ?? "").trim().toLowerCase();
  const epa = (row.epaNumber ?? "").trim();
  if (!name && !epa) return null;
  return (
    catalog.find(
      (c) =>
        (c.epaNumber ?? "").trim() === epa &&
        (c.name ?? "").trim().toLowerCase() === name
    ) ?? null
  );
}

/**
 * The numeric amount + unit a row represents — the structured fields when the
 * tech app wrote them, otherwise a parse of the free-text quantity ("2 oz").
 */
export function usageAmount(
  row: ReportProduct
): { value: number; unit: string } | null {
  if (typeof row.amountValue === "number" && row.amountUnit) {
    return { value: row.amountValue, unit: row.amountUnit };
  }
  return parseAmount(row.quantity);
}

export type Depletion = {
  productId: string;
  /** Negative — the stock consumed, in the product's stockUnit. */
  deltaBaseUnits: number;
  /** Human note stored on the ledger entry, e.g. "2 fl oz". */
  note: string;
};

export type DepletionSkip = {
  productId: string;
  reason: "no-stock-unit" | "no-amount" | "inconvertible";
  detail: string;
};

/**
 * Pure: what a finalized report should deplete. One depletion per TRACKED
 * catalog product with a convertible amount; untracked products are ignored
 * (not inventory), and a tracked product with no stock unit, no readable
 * amount, or an amount that can't convert into its stock unit is returned as a
 * skip so the caller can log it rather than silently guessing.
 */
export function depletionsForReport(
  products: ReportProduct[],
  catalog: InventoryProduct[]
): { deplete: Depletion[]; skips: DepletionSkip[] } {
  const deplete: Depletion[] = [];
  const skips: DepletionSkip[] = [];
  for (const row of products) {
    const match = matchCatalogProduct(row, catalog);
    if (!match || !match.trackInventory) continue;
    const label = match.name ?? match.id;
    if (!match.stockUnit) {
      skips.push({ productId: match.id, reason: "no-stock-unit", detail: label });
      continue;
    }
    const amt = usageAmount(row);
    if (!amt || amt.value <= 0) {
      skips.push({ productId: match.id, reason: "no-amount", detail: label });
      continue;
    }
    const inStock = convert(amt.value, amt.unit, match.stockUnit);
    if (inStock == null || inStock <= 0) {
      skips.push({
        productId: match.id,
        reason: "inconvertible",
        detail: `${label}: ${amt.value} ${amt.unit} → ${match.stockUnit}`,
      });
      continue;
    }
    deplete.push({
      productId: match.id,
      deltaBaseUnits: -inStock,
      note: `${amt.value} ${amt.unit}`,
    });
  }
  return { deplete, skips };
}

/** On-hand = the running sum of a product's ledger deltas. */
export function onHandFromEntries(
  entries: { deltaBaseUnits?: number | null }[]
): number {
  return entries.reduce((sum, e) => sum + (e.deltaBaseUnits ?? 0), 0);
}

/** Whether a product is at or below its reorder point (only for tracked
 *  products that set one). */
export function isLowStock(
  product: InventoryProduct,
  onHand: number
): boolean {
  return (
    !!product.trackInventory &&
    typeof product.reorderPoint === "number" &&
    onHand <= product.reorderPoint
  );
}
