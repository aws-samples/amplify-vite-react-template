import { describe, expect, it } from "vitest";
import { NO_AMOUNT, formatMoney, formatMonthly, formatYearly } from "./money";

describe("formatMoney", () => {
  it("groups thousands and always shows cents", () => {
    expect(formatMoney(120000)).toBe("$1,200.00");
  });

  it("renders a whole-dollar amount with cents, not bare", () => {
    // The funnel used to print "$50" here while the agreement PDF for the same
    // sale printed "$50.00".
    expect(formatMoney(5000)).toBe("$50.00");
  });

  it("keeps a remainder the no-fraction style used to hide", () => {
    expect(formatMoney(5000050)).toBe("$50,000.50");
  });

  it.each([
    [0, "$0.00"],
    [1, "$0.01"],
    [99, "$0.99"],
    [24900, "$249.00"],
    [129900, "$1,299.00"],
    [100000000, "$1,000,000.00"],
  ])("formats %i cents as %s", (cents, expected) => {
    expect(formatMoney(cents)).toBe(expected);
  });

  it("renders a negative amount (a refund line) with its sign", () => {
    expect(formatMoney(-2500)).toBe("-$25.00");
  });

  it.each([null, undefined, Number.NaN, Number.POSITIVE_INFINITY])(
    "renders %p as a dash rather than throwing or printing $NaN",
    (value) => {
      expect(formatMoney(value)).toBe(NO_AMOUNT);
    }
  );

  it("never returns the string NaN", () => {
    expect(formatMoney(Number.NaN)).not.toContain("NaN");
  });
});

describe("suffixed helpers", () => {
  it("appends /mo", () => {
    expect(formatMonthly(4500)).toBe("$45.00/mo");
  });

  it("appends /yr", () => {
    expect(formatYearly(54000)).toBe("$540.00/yr");
  });

  it("suffixes a missing amount too, rather than inventing zero", () => {
    expect(formatMonthly(null)).toBe(`${NO_AMOUNT}/mo`);
  });
});
