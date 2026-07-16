import { describe, expect, it } from "vitest";
import { oneTimeGrossProfitCents, priceMosquito } from "./rateCards";

/**
 * The cost-and-zone module. Base prices live on the AI market-rate sheets
 * now; what stays deterministic here is the cost model behind the engine's
 * floor and the 3× lead-fee test, plus the mosquito/tick card the engine
 * has no service kind for yet.
 *
 * (The residential/association price cards and their R57 monotonicity sweep
 * retired with the cards — an AI-researched sheet has no bracket constants
 * to keep honest.)
 */

describe("spec worked examples", () => {
  it("mosquito + tick ~1 acre → $169/mo, no initial fee", () => {
    const p = priceMosquito({ tick: true, halfAcres: 2, zone: "A" });

    expect(p.monthlyCents).toBe(16900);
    expect(p.initialFeeCents).toBeNull();
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
