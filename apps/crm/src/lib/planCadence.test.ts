import { describe, expect, it } from "vitest";
import { billingCadence, planCadence } from "./planCadence";

/**
 * The exact misreading this exists to prevent: "$45/mo · service quarterly"
 * read as "$45, four times a year". It is $45 every month, and the technician
 * visits every three. Acting on the misreading would have cut quarterly
 * revenue by two thirds.
 */

describe("planCadence", () => {
  it("separates what is charged from how often anyone turns up", () => {
    expect(planCadence(4500, "QUARTERLY")).toBe(
      "$45.00 per month · technician visits every 3 months"
    );
  });

  it("never says the money moves at the visit cadence", () => {
    for (const f of ["MONTHLY", "BIMONTHLY", "QUARTERLY"]) {
      expect(planCadence(4500, f)).toContain("per month");
    }
  });

  it.each([
    ["MONTHLY", "technician visits every month"],
    ["BIMONTHLY", "technician visits every 2 months"],
    ["QUARTERLY", "technician visits every 3 months"],
  ])("describes %s visits as %s", (frequency, expected) => {
    expect(planCadence(9900, frequency)).toContain(expected);
  });

  it("handles an AI-priced template with no set price", () => {
    expect(planCadence(null, "QUARTERLY")).toBe(
      "AI-priced · technician visits every 3 months"
    );
  });

  it("degrades to the price alone on an unknown frequency", () => {
    expect(planCadence(4500, "WEEKLY")).toBe("$45.00 per month");
    expect(planCadence(4500, null)).toBe("$45.00 per month");
  });
});

describe("billingCadence", () => {
  it("says the money moves monthly, in as many words", () => {
    expect(billingCadence(4500)).toBe("$45.00 charged every month");
  });

  it("handles no price", () => {
    expect(billingCadence(null)).toBe("priced per month");
  });
});
