import { describe, expect, it } from "vitest";
import {
  areaKeyFor,
  bandOfKey,
  hoaBandFor,
  isServable,
  mergeSheetEdits,
  parseSheet,
  planPrefill,
  rateStatus,
  selectPlanRate,
  sheetOf,
  sqftBucket,
} from "./marketRates";
import type { MarketRate } from "./api";

/**
 * The CRM's client-side view of the market-rate engine: the same rows the
 * public funnel quotes from drive the office's prefills and the pricing
 * console. These tests pin the semantics the screens rely on — pinned rows
 * never expire, office edits preserve sheet components they don't render,
 * and band selection never prices a big home off a small home's rate.
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-07-16T12:00:00Z");

function rate(over: Partial<MarketRate>): MarketRate {
  return {
    id: "r1",
    rateKey: "GENERAL_PEST#ware-ma#2000",
    service: "GENERAL_PEST",
    areaKey: "ware-ma",
    priceCents: 24900,
    ratesJson: JSON.stringify({
      oneTimeCents: 24900,
      plans: {
        MONTHLY: { monthlyCents: 6900, initialFeeCents: 14900 },
        BIMONTHLY: { monthlyCents: 5900, initialFeeCents: 14900 },
        QUARTERLY: { monthlyCents: 4900, initialFeeCents: 16900 },
      },
    }),
    active: true,
    expiresAt: new Date(NOW + 30 * DAY).toISOString(),
    ...over,
  } as MarketRate;
}

describe("keys and bands (must mirror the engine)", () => {
  it("areaKeyFor matches the engine's normalization", () => {
    expect(areaKeyFor(" East  Longmeadow ", "MA")).toBe("east-longmeadow-ma");
  });

  it("sqftBucket rounds up to 500 with a floor of 500", () => {
    expect(sqftBucket(1)).toBe(500);
    expect(sqftBucket(2000)).toBe(2000);
    expect(sqftBucket(2001)).toBe(2500);
  });

  it("hoaBandFor matches the engine's brackets", () => {
    expect(hoaBandFor(8)).toBe("UNITS_1_10");
    expect(hoaBandFor(11)).toBe("UNITS_11_25");
    expect(hoaBandFor(40)).toBe("UNITS_26_50");
    expect(hoaBandFor(60)).toBe("UNITS_51_100");
    expect(hoaBandFor(150)).toBe("UNITS_101_PLUS");
  });

  it("bandOfKey reads the third key segment", () => {
    expect(bandOfKey("GENERAL_PEST#ware-ma#2500")).toBe(2500);
    expect(bandOfKey("WASP_NEST#ware-ma")).toBeNull();
  });
});

describe("pinned semantics", () => {
  it("an expired row is expired — unless pinned, which never expires", () => {
    const expired = rate({ expiresAt: new Date(NOW - DAY).toISOString() });
    expect(rateStatus(expired, NOW)).toBe("expired");
    expect(isServable(expired, NOW)).toBe(false);

    const pinned = rate({
      expiresAt: new Date(NOW - DAY).toISOString(),
      pinned: true,
    });
    expect(rateStatus(pinned, NOW)).toBe("pinned");
    expect(isServable(pinned, NOW)).toBe(true);
  });

  it("retired wins over everything — a retired row is never served", () => {
    const retired = rate({ active: false, pinned: true });
    expect(rateStatus(retired, NOW)).toBe("retired");
    expect(isServable(retired, NOW)).toBe(false);
  });
});

describe("sheet parsing and office edits", () => {
  it("parseSheet tolerates junk; a sheet needs a one-time or HOA rates", () => {
    expect(parseSheet(null)).toBeNull();
    expect(parseSheet("not json")).toBeNull();
    expect(parseSheet(JSON.stringify({ oneTimeCents: "249" }))).toBeNull();
    expect(parseSheet(JSON.stringify({ oneTimeCents: 24900 }))).toEqual({
      oneTimeCents: 24900,
    });
    expect(
      parseSheet(JSON.stringify({ hoaPerUnitMonthly: {} }))
    ).toEqual({ hoaPerUnitMonthly: {} });
  });

  it("sheetOf mirrors priceCents over a stale stored one-time", () => {
    const r = rate({ priceCents: 19900 });
    expect(sheetOf(r).oneTimeCents).toBe(19900);
  });

  it("sheetOf serves HOA sheets as stored — no one-time to mirror over", () => {
    const r = rate({
      service: "HOA",
      priceCents: 500,
      ratesJson: JSON.stringify({
        hoaPerUnitMonthly: { UNITS_1_10: { MONTHLY: 700 } },
      }),
    });
    expect(sheetOf(r).oneTimeCents).toBeUndefined();
    expect(sheetOf(r).hoaPerUnitMonthly?.UNITS_1_10?.MONTHLY).toBe(700);
  });

  it("mergeSheetEdits mirrors priceCents to the edited one-time", () => {
    const merged = mergeSheetEdits(rate({}), { oneTimeCents: 27900 });
    expect(merged.priceCents).toBe(27900);
    expect(JSON.parse(merged.ratesJson).oneTimeCents).toBe(27900);
  });

  it("HOA edits mirror priceCents the engine's way (smallest band, monthly)", () => {
    const hoaRates = {
      UNITS_1_10: { MONTHLY: 900, BIMONTHLY: 800, QUARTERLY: 700 },
      UNITS_11_25: { MONTHLY: 700, BIMONTHLY: 600, QUARTERLY: 500 },
      UNITS_26_50: { MONTHLY: 600, BIMONTHLY: 500, QUARTERLY: 400 },
      UNITS_51_100: { MONTHLY: 500, BIMONTHLY: 400, QUARTERLY: 300 },
      UNITS_101_PLUS: { MONTHLY: 400, BIMONTHLY: 300, QUARTERLY: 200 },
    };
    const r = rate({ service: "HOA", ratesJson: JSON.stringify({}) });
    const merged = mergeSheetEdits(r, { hoaPerUnitMonthly: hoaRates });
    expect(merged.priceCents).toBe(900);
    expect(JSON.parse(merged.ratesJson).hoaPerUnitMonthly).toEqual(hoaRates);
  });

  it("edits preserve sheet components this screen didn't touch", () => {
    const r = rate({
      ratesJson: JSON.stringify({
        oneTimeCents: 24900,
        extraNestCents: 9900,
        someFutureField: 42,
        plans: {
          MONTHLY: { monthlyCents: 6900, initialFeeCents: 14900 },
        },
      }),
    });
    const merged = mergeSheetEdits(r, {
      oneTimeCents: 25900,
      plans: { QUARTERLY: { monthlyCents: 5500, initialFeeCents: 15900 } },
    });
    const sheet = JSON.parse(merged.ratesJson);
    expect(sheet.extraNestCents).toBe(9900);
    expect(sheet.someFutureField).toBe(42);
    expect(sheet.plans.MONTHLY.monthlyCents).toBe(6900);
    expect(sheet.plans.QUARTERLY.monthlyCents).toBe(5500);
  });
});

describe("selectPlanRate", () => {
  const rows = [
    rate({ id: "small", rateKey: "GENERAL_PEST#ware-ma#1500" }),
    rate({ id: "exact", rateKey: "GENERAL_PEST#ware-ma#2000" }),
    rate({ id: "big", rateKey: "GENERAL_PEST#ware-ma#3000" }),
  ];

  it("prefers the exact band", () => {
    expect(selectPlanRate(rows, "GENERAL_PEST", "ware-ma", 2000, NOW)?.id).toBe(
      "exact"
    );
  });

  it("falls to the smallest covering band, never a smaller one", () => {
    expect(selectPlanRate(rows, "GENERAL_PEST", "ware-ma", 2500, NOW)?.id).toBe(
      "big"
    );
    expect(selectPlanRate(rows, "GENERAL_PEST", "ware-ma", 3500, NOW)).toBeNull();
  });

  it("skips rows the engine would refuse (expired, retired) but serves pinned", () => {
    const stale = [
      rate({
        id: "expired",
        rateKey: "GENERAL_PEST#ware-ma#2000",
        expiresAt: new Date(NOW - DAY).toISOString(),
      }),
      rate({ id: "retired", rateKey: "GENERAL_PEST#ware-ma#2000", active: false }),
    ];
    expect(selectPlanRate(stale, "GENERAL_PEST", "ware-ma", 2000, NOW)).toBeNull();

    const pinned = [
      rate({
        id: "pinned",
        rateKey: "GENERAL_PEST#ware-ma#2000",
        expiresAt: new Date(NOW - DAY).toISOString(),
        pinned: true,
      }),
    ];
    expect(selectPlanRate(pinned, "GENERAL_PEST", "ware-ma", 2000, NOW)?.id).toBe(
      "pinned"
    );
  });

  it("never crosses service or area", () => {
    expect(selectPlanRate(rows, "RODENT", "ware-ma", 2000, NOW)).toBeNull();
    expect(
      selectPlanRate(rows, "GENERAL_PEST", "palmer-ma", 2000, NOW)
    ).toBeNull();
  });
});

describe("planPrefill", () => {
  it("returns the cadence's monthly + initial fee", () => {
    expect(planPrefill(rate({}), "QUARTERLY")).toEqual({
      monthlyCents: 4900,
      initialFeeCents: 16900,
    });
  });

  it("returns null when the sheet has no plan rates (one-time services)", () => {
    const oneTimeOnly = rate({
      service: "RODENT",
      ratesJson: JSON.stringify({ oneTimeCents: 34900 }),
    });
    expect(planPrefill(oneTimeOnly, "MONTHLY")).toBeNull();
  });

  it("HOA rates are per unit: the unit count picks the band and multiplies", () => {
    const hoa = rate({
      service: "HOA",
      rateKey: "HOA#ware-ma",
      priceCents: 900,
      ratesJson: JSON.stringify({
        hoaPerUnitMonthly: {
          UNITS_1_10: { MONTHLY: 900, BIMONTHLY: 800, QUARTERLY: 700 },
          UNITS_11_25: { MONTHLY: 700, BIMONTHLY: 600, QUARTERLY: 500 },
          UNITS_26_50: { MONTHLY: 600, BIMONTHLY: 500, QUARTERLY: 400 },
          UNITS_51_100: { MONTHLY: 500, BIMONTHLY: 400, QUARTERLY: 300 },
          UNITS_101_PLUS: { MONTHLY: 400, BIMONTHLY: 300, QUARTERLY: 200 },
        },
      }),
    });
    // 40 units → 26–50 band, quarterly $4.00/unit/mo → $160/mo. No initial
    // fee exists for HOA common-area work.
    expect(planPrefill(hoa, "QUARTERLY", { units: 40 })).toEqual({
      monthlyCents: 16000,
      initialFeeCents: null,
      perUnitMonthlyCents: 400,
    });
    // No unit count → no honest price to suggest.
    expect(planPrefill(hoa, "QUARTERLY")).toBeNull();
    expect(planPrefill(hoa, "QUARTERLY", { units: 0 })).toBeNull();
  });

  it("an HOA row is found without a key band (all bands live in one sheet)", () => {
    const hoa = rate({
      id: "hoa",
      service: "HOA",
      rateKey: "HOA#ware-ma",
      ratesJson: JSON.stringify({
        hoaPerUnitMonthly: { UNITS_1_10: { MONTHLY: 900 } },
      }),
    });
    expect(selectPlanRate([hoa], "HOA", "ware-ma", null, NOW)?.id).toBe("hoa");
  });
});
