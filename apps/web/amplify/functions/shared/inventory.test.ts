import { describe, expect, it } from "vitest";
import {
  aggregateProductUsage,
  depletionsForReport,
  isLowStock,
  matchCatalogProduct,
  onHandFromEntries,
  usageAmount,
  type InventoryProduct,
} from "./inventory";
import type { ReportProduct } from "./pdf";

const TERMIDOR: InventoryProduct = {
  id: "prod-termidor",
  name: "Termidor SC",
  epaNumber: "7969-210",
  trackInventory: true,
  stockUnit: "fl oz",
  reorderPoint: 8,
  unitCostCents: 400,
};
const STATIONS: InventoryProduct = {
  id: "prod-stations",
  name: "Bait Stations",
  epaNumber: "",
  trackInventory: true,
  stockUnit: "each",
  reorderPoint: 20,
};
const UNTRACKED: InventoryProduct = {
  id: "prod-inspect",
  name: "Inspection Mirror",
  trackInventory: false,
  stockUnit: "each",
};
const CATALOG = [TERMIDOR, STATIONS, UNTRACKED];

describe("matchCatalogProduct", () => {
  it("prefers the exact productId link", () => {
    const row: ReportProduct = { productId: "prod-termidor", name: "wrong name" };
    expect(matchCatalogProduct(row, CATALOG)?.id).toBe("prod-termidor");
  });
  it("falls back to case-insensitive name + EPA", () => {
    const row: ReportProduct = { name: "termidor sc", epaNumber: "7969-210" };
    expect(matchCatalogProduct(row, CATALOG)?.id).toBe("prod-termidor");
  });
  it("returns null when nothing matches", () => {
    expect(matchCatalogProduct({ name: "Nope", epaNumber: "1-1" }, CATALOG)).toBeNull();
    expect(matchCatalogProduct({}, CATALOG)).toBeNull();
  });
});

describe("usageAmount", () => {
  it("prefers structured fields", () => {
    expect(usageAmount({ amountValue: 2, amountUnit: "fl oz", quantity: "9 gal" })).toEqual({
      value: 2,
      unit: "fl oz",
    });
  });
  it("falls back to parsing the quantity string", () => {
    expect(usageAmount({ quantity: "1.5 fl oz" })).toEqual({ value: 1.5, unit: "fl oz" });
  });
});

describe("depletionsForReport", () => {
  it("depletes tracked products in their stock unit, converting as needed", () => {
    const products: ReportProduct[] = [
      { productId: "prod-termidor", amountValue: 1, amountUnit: "gal" }, // 128 fl oz
      { name: "Bait Stations", quantity: "6 stations" }, // 6 each
    ];
    const { deplete, skips } = depletionsForReport(products, CATALOG);
    expect(skips).toEqual([]);
    expect(deplete).toEqual([
      { productId: "prod-termidor", deltaBaseUnits: -128, note: "1 gal" },
      { productId: "prod-stations", deltaBaseUnits: -6, note: "6 stations" },
    ]);
  });

  it("ignores untracked products entirely (not a skip)", () => {
    const { deplete, skips } = depletionsForReport(
      [{ productId: "prod-inspect", quantity: "1 each" }],
      CATALOG
    );
    expect(deplete).toEqual([]);
    expect(skips).toEqual([]);
  });

  it("skips an inconvertible amount rather than guessing", () => {
    // oz (weight) into fl oz (volume) — genuinely inconvertible.
    const { deplete, skips } = depletionsForReport(
      [{ productId: "prod-termidor", amountValue: 2, amountUnit: "oz" }],
      CATALOG
    );
    expect(deplete).toEqual([]);
    expect(skips[0]).toMatchObject({ productId: "prod-termidor", reason: "inconvertible" });
  });

  it("skips a tracked product with no readable amount", () => {
    const { skips } = depletionsForReport(
      [{ productId: "prod-termidor", quantity: "some" }],
      CATALOG
    );
    expect(skips[0]).toMatchObject({ reason: "no-amount" });
  });
});

describe("aggregateProductUsage", () => {
  it("sums a tracked product across reports, folding units into its stock unit", () => {
    const rows = aggregateProductUsage(
      [
        [{ productId: "prod-termidor", amountValue: 1, amountUnit: "gal" }], // 128 fl oz
        [{ name: "Termidor SC", epaNumber: "7969-210", quantity: "2 fl oz" }],
      ],
      CATALOG
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      productId: "prod-termidor",
      tracked: true,
      applications: 2,
      byUnit: [{ unit: "fl oz", value: 130 }],
      costCents: 130 * 400,
      hasUnmeasuredUse: false,
    });
  });

  it("includes UNtracked products the ledger never sees, keyed by name+EPA", () => {
    const rows = aggregateProductUsage(
      [[{ name: "Wasp Freeze", epaNumber: "1234-5", quantity: "3 oz" }]],
      CATALOG
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      productId: null,
      name: "Wasp Freeze",
      tracked: false,
      byUnit: [{ unit: "oz", value: 3 }],
      costCents: 0,
    });
  });

  it("keeps inconvertible units separate rather than summing across dimensions", () => {
    // A tracked product (stockUnit fl oz) recorded once in fl oz and once in oz
    // (weight) — the weight reading can't fold into fl oz.
    const rows = aggregateProductUsage(
      [
        [{ productId: "prod-termidor", amountValue: 2, amountUnit: "fl oz" }],
        [{ productId: "prod-termidor", amountValue: 3, amountUnit: "oz" }],
      ],
      CATALOG
    );
    expect(rows[0].byUnit).toEqual([
      { unit: "oz", value: 3 },
      { unit: "fl oz", value: 2 },
    ]);
    // Only the convertible fl-oz portion is costed.
    expect(rows[0].costCents).toBe(2 * 400);
  });

  it("flags an application whose amount was not readable", () => {
    const rows = aggregateProductUsage(
      [[{ name: "Termidor SC", epaNumber: "7969-210", quantity: "as needed" }]],
      CATALOG
    );
    expect(rows[0]).toMatchObject({
      applications: 1,
      byUnit: [],
      hasUnmeasuredUse: true,
    });
  });
});

describe("onHandFromEntries", () => {
  it("sums signed deltas", () => {
    expect(
      onHandFromEntries([
        { deltaBaseUnits: 128 },
        { deltaBaseUnits: -2 },
        { deltaBaseUnits: -0.5 },
        { deltaBaseUnits: null },
      ])
    ).toBe(125.5);
  });
});

describe("isLowStock", () => {
  it("is true at or below the reorder point for a tracked product", () => {
    expect(isLowStock(TERMIDOR, 8)).toBe(true);
    expect(isLowStock(TERMIDOR, 7.9)).toBe(true);
    expect(isLowStock(TERMIDOR, 8.1)).toBe(false);
  });
  it("is false for untracked or no-reorder-point products", () => {
    expect(isLowStock(UNTRACKED, 0)).toBe(false);
    expect(isLowStock({ id: "x", trackInventory: true }, 0)).toBe(false);
  });
});
