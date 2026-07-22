import { describe, expect, it } from "vitest";
import { convert, dimensionOf, normalizeUnit, parseAmount } from "./units";

describe("normalizeUnit", () => {
  it("lowercases, strips dots, collapses spaces", () => {
    expect(normalizeUnit("FL OZ")).toBe("fl oz");
    expect(normalizeUnit("Fl. Oz.")).toBe("fl oz");
    expect(normalizeUnit("  Gallons ")).toBe("gallons");
  });
});

describe("dimensionOf", () => {
  it("separates fluid oz (volume) from oz (weight)", () => {
    expect(dimensionOf("fl oz")).toBe("volume");
    expect(dimensionOf("oz")).toBe("weight");
  });
  it("recognizes count units and plurals", () => {
    expect(dimensionOf("station")).toBe("count");
    expect(dimensionOf("stations")).toBe("count");
    expect(dimensionOf("cups")).toBe("volume");
  });
  it("returns null for the unknown", () => {
    expect(dimensionOf("smidge")).toBeNull();
    expect(dimensionOf("")).toBeNull();
  });
});

describe("convert", () => {
  it("converts within volume", () => {
    expect(convert(1, "gal", "fl oz")).toBe(128);
    expect(convert(128, "fl oz", "gal")).toBe(1);
    expect(convert(2, "qt", "gal")).toBe(0.5);
  });
  it("converts within weight", () => {
    expect(convert(1, "lb", "oz")).toBe(16);
    expect(convert(32, "oz", "lb")).toBe(2);
  });
  it("is identity for the same unit and for count", () => {
    expect(convert(3, "each", "each")).toBe(3);
    expect(convert(5, "fl oz", "fl oz")).toBe(5);
  });
  it("refuses cross-dimension and unknown units", () => {
    expect(convert(1, "oz", "gal")).toBeNull(); // weight → volume
    expect(convert(1, "gal", "oz")).toBeNull();
    expect(convert(1, "gal", "smidge")).toBeNull();
    expect(convert(Number.NaN, "gal", "fl oz")).toBeNull();
  });
});

describe("parseAmount", () => {
  it("splits a value and unit", () => {
    expect(parseAmount("2 oz")).toEqual({ value: 2, unit: "oz" });
    expect(parseAmount("1.5 fl oz")).toEqual({ value: 1.5, unit: "fl oz" });
    expect(parseAmount(".5 gal")).toEqual({ value: 0.5, unit: "gal" });
  });
  it("reads a bare number as a unitless amount", () => {
    expect(parseAmount("3")).toEqual({ value: 3, unit: "" });
  });
  it("returns null when there is no number", () => {
    expect(parseAmount("a little")).toBeNull();
    expect(parseAmount("")).toBeNull();
    expect(parseAmount(null)).toBeNull();
  });
});
