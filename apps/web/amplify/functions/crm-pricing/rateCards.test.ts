import { describe, expect, it } from "vitest";
import {
  oneTimeGrossProfitCents,
  priceAssociation,
  priceMosquito,
  priceResidential,
  type Frequency,
  type Zone,
} from "./rateCards";

/**
 * The rate card is the deterministic pricing core — identical inputs must
 * always produce identical dollars, and the card must be internally sane:
 * more service can never cost less per month than less service (R57).
 *
 * The worked examples pin the card to the spec quoted in rateCards.ts's
 * header, so a typo in a bracket constant fails a test instead of shipping.
 */

describe("spec worked examples", () => {
  it("3,200 sqft quarterly residential → $75/mo + $99 initial", () => {
    const p = priceResidential({ frequency: "QUARTERLY", sqft: 3200, zone: "A" });

    expect(p.monthlyCents).toBe(7500);
    expect(p.initialFeeCents).toBe(9900);
  });

  it("1,800 sqft monthly, Zone B → $139/mo, initial $124", () => {
    const p = priceResidential({ frequency: "MONTHLY", sqft: 1800, zone: "B" });

    expect(p.monthlyCents).toBe(13900);
    expect(p.initialFeeCents).toBe(12400);
  });

  it("60-unit HOA monthly → $405/mo, escalates", () => {
    const p = priceAssociation({ frequency: "MONTHLY", units: 60, zone: "A" });

    expect(p.monthlyCents).toBe(40500);
    expect(p.escalate).toBeTruthy();
  });

  it("mosquito + tick ~1 acre → $169/mo, no initial fee", () => {
    const p = priceMosquito({ tick: true, halfAcres: 2, zone: "A" });

    expect(p.monthlyCents).toBe(16900);
    expect(p.initialFeeCents).toBeNull();
  });
});

describe("HOA frequency monotonicity (R57)", () => {
  // The 101+ bimonthly premium was $150 against a $180 quarterly premium, so
  // past ~300 units a quarterly contract cost MORE per month than bimonthly —
  // more money for less service. This sweep keeps every bracket honest.
  const monthlyPrice = (frequency: Frequency, units: number, zone: Zone) =>
    priceAssociation({ frequency, units, zone }).monthlyCents!;

  it("monthly ≥ bimonthly ≥ quarterly at every unit count, both zones", () => {
    for (const zone of ["A", "B"] as const) {
      for (let units = 1; units <= 500; units++) {
        const m = monthlyPrice("MONTHLY", units, zone);
        const b = monthlyPrice("BIMONTHLY", units, zone);
        const q = monthlyPrice("QUARTERLY", units, zone);
        expect(m, `monthly < bimonthly at ${units} units zone ${zone}`).toBeGreaterThanOrEqual(b);
        expect(b, `bimonthly < quarterly at ${units} units zone ${zone}`).toBeGreaterThanOrEqual(q);
      }
    }
  });

  it("price never decreases as the association grows", () => {
    for (const frequency of ["MONTHLY", "BIMONTHLY", "QUARTERLY"] as const) {
      let prev = 0;
      for (let units = 1; units <= 500; units++) {
        const p = monthlyPrice(frequency, units, "A");
        expect(p, `${frequency} dropped at ${units} units`).toBeGreaterThanOrEqual(prev);
        prev = p;
      }
    }
  });

  it("the 350-unit case that inverted under the old $150 premium", () => {
    // Old numbers: quarterly $800/mo vs bimonthly $775/mo at 350 units.
    const b = monthlyPrice("BIMONTHLY", 350, "A");
    const q = monthlyPrice("QUARTERLY", 350, "A");

    expect(q).toBeLessThanOrEqual(b);
  });
});

describe("oneTimeGrossProfitCents", () => {
  it("prices Zone A wasp economics from the cost constants", () => {
    // (60 onsite + 40 drive)/60 × $42 + 30 mi × $0.30 + $15 materials = $94.
    expect(oneTimeGrossProfitCents("wasp_nest", 29900, "A")).toBe(20500);
  });

  it("returns null when the zone is unknown — no cost model, no verdict", () => {
    expect(oneTimeGrossProfitCents("wasp_nest", 29900, "UNKNOWN")).toBeNull();
    expect(oneTimeGrossProfitCents("wasp_nest", 29900, "OUT")).toBeNull();
  });
});
