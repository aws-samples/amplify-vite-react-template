import { describe, it, expect } from "vitest";
import { toAmountText, splitAmount, composeAmount } from "./productAmount";

describe("toAmountText", () => {
  // The regression this module exists for: the stored shape is a number, the
  // editor calls .trim() on it.
  it("converts a STORED number to editor text", () => {
    expect(toAmountText(2)).toBe("2");
    expect(toAmountText(0.5)).toBe("0.5");
    expect(toAmountText(0)).toBe("0");
  });

  it("gives every result a .trim()", () => {
    for (const stored of [2, 0.5, 0, "2", ""]) {
      const text = toAmountText(stored);
      expect(() => text?.trim()).not.toThrow();
    }
  });

  it("passes editor text through unchanged, including a half-typed value", () => {
    expect(toAmountText("2.")).toBe("2.");
    expect(toAmountText("")).toBe("");
  });

  it("drops values that are neither — absent stays absent", () => {
    expect(toAmountText(undefined)).toBeUndefined();
    expect(toAmountText(null)).toBeUndefined();
    expect(toAmountText(NaN)).toBeUndefined();
    expect(toAmountText(Infinity)).toBeUndefined();
    expect(toAmountText({})).toBeUndefined();
  });
});

describe("splitAmount", () => {
  it("splits value and unit", () => {
    expect(splitAmount("2 fl oz")).toEqual({ value: "2", unit: "fl oz" });
    expect(splitAmount("0.5 gal")).toEqual({ value: "0.5", unit: "gal" });
    expect(splitAmount("3")).toEqual({ value: "3", unit: "" });
  });

  it("returns empties for junk or absent input", () => {
    expect(splitAmount(undefined)).toEqual({ value: "", unit: "" });
    expect(splitAmount("a lot")).toEqual({ value: "", unit: "" });
  });
});

describe("composeAmount", () => {
  it("round-trips with splitAmount", () => {
    for (const s of ["2 fl oz", "0.5 gal", "3"]) {
      const { value, unit } = splitAmount(s);
      expect(composeAmount(value, unit)).toBe(s);
    }
  });

  it("is empty when there is no value", () => {
    expect(composeAmount("", "fl oz")).toBe("");
    expect(composeAmount(undefined, "fl oz")).toBe("");
  });
});
