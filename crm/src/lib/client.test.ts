import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ./client calls generateClient() at module scope, so importing anything from
// it would blow up on an unconfigured Amplify. Stubbing generateClient rather
// than the whole ./client module keeps client.ts's real exports intact and
// makes the module-scope call harmless.
vi.mock("aws-amplify/data", () => ({
  generateClient: () => ({ models: {} }),
}));

import {
  EMAIL_RE,
  validateDateRange,
  validatePositiveInt,
  validateYear,
} from "./client";

describe("EMAIL_RE", () => {
  it("accepts ordinary addresses", () => {
    for (const ok of [
      "jake@getgim.com",
      "a.b+tag@sub.example.co.uk",
      "x@y.io",
      "UPPER@EXAMPLE.COM",
    ]) {
      expect(EMAIL_RE.test(ok)).toBe(true);
    }
  });

  it("rejects malformed addresses", () => {
    for (const bad of [
      "",
      "jake",
      "jake@",
      "@getgim.com",
      "jake@getgim",
      "jake @getgim.com",
      "jake@get gim.com",
      "two@at@example.com",
    ]) {
      expect(EMAIL_RE.test(bad)).toBe(false);
    }
  });

  it("rejects a one-character TLD — the reason {2,} beat the old regex", () => {
    expect(EMAIL_RE.test("a@b.c")).toBe(false);
    expect(EMAIL_RE.test("a@b.co")).toBe(true);
  });

  it("is not sticky or global, so repeated .test() is stateless", () => {
    expect(EMAIL_RE.flags).toBe("");
    expect(EMAIL_RE.test("jake@getgim.com")).toBe(true);
    expect(EMAIL_RE.test("jake@getgim.com")).toBe(true);
  });
});

describe("validateDateRange", () => {
  it("passes a normal ordered range", () => {
    expect(validateDateRange("2026-01-01", "2027-01-01")).toEqual([]);
  });

  it("treats equal dates as valid", () => {
    expect(validateDateRange("2026-01-01", "2026-01-01")).toEqual([]);
  });

  it("flags a reversed range", () => {
    expect(validateDateRange("2027-01-01", "2026-01-01")).toEqual([
      "Effective date can't be after the expiration date.",
    ]);
  });

  it("flags a range reversed by a single day", () => {
    expect(validateDateRange("2026-01-02", "2026-01-01")).toHaveLength(1);
    expect(validateDateRange("2026-01-01", "2026-01-02")).toEqual([]);
  });

  it("compares across year and month boundaries lexicographically", () => {
    expect(validateDateRange("2026-12-31", "2027-01-01")).toEqual([]);
    expect(validateDateRange("2027-01-01", "2026-12-31")).toHaveLength(1);
    expect(validateDateRange("2026-09-30", "2026-10-01")).toEqual([]);
  });

  it("skips when either side is missing", () => {
    expect(validateDateRange("2026-01-01", "")).toEqual([]);
    expect(validateDateRange("", "2026-01-01")).toEqual([]);
    expect(validateDateRange("2026-01-01", null)).toEqual([]);
    expect(validateDateRange(undefined, "2026-01-01")).toEqual([]);
  });

  it("skips when both sides are missing", () => {
    expect(validateDateRange("", "")).toEqual([]);
    expect(validateDateRange(null, undefined)).toEqual([]);
    expect(validateDateRange("  ", "  ")).toEqual([]);
  });

  it("reports non-ISO garbage on whichever side is malformed", () => {
    expect(validateDateRange("01/02/2026", "2026-03-01")).toEqual([
      "Effective date isn't a valid date.",
    ]);
    expect(validateDateRange("2026-03-01", "next tuesday")).toEqual([
      "expiration date isn't a valid date.",
    ]);
    expect(validateDateRange("nope", "also nope")).toEqual([
      "Effective date isn't a valid date.",
      "expiration date isn't a valid date.",
    ]);
  });

  it("reports malformed input even when the other side is absent", () => {
    expect(validateDateRange("garbage", "")).toEqual([
      "Effective date isn't a valid date.",
    ]);
  });

  it("does not also report ordering when a side is malformed", () => {
    // Lexicographically "9999-99-99" > "2026-01-01", but the shape problem is
    // the only useful message.
    expect(validateDateRange("9999-99-99", "2026-01-01")).toEqual([
      "Effective date isn't a valid date.",
    ]);
  });

  it("rejects impossible calendar days without using Date parsing", () => {
    expect(validateDateRange("2026-02-30", "2026-03-01")).toHaveLength(1);
    expect(validateDateRange("2026-13-01", "2026-12-01")).toHaveLength(1);
    expect(validateDateRange("2026-00-10", "2026-12-01")).toHaveLength(1);
    expect(validateDateRange("2026-01-00", "2026-12-01")).toHaveLength(1);
    expect(validateDateRange("2026-01-32", "2026-12-01")).toHaveLength(1);
    expect(validateDateRange("2026-1-1", "2026-12-01")).toHaveLength(1);
  });

  it("gets leap years right", () => {
    expect(validateDateRange("2024-02-29", "2024-03-01")).toEqual([]);
    expect(validateDateRange("2026-02-29", "2026-03-01")).toHaveLength(1);
    expect(validateDateRange("2000-02-29", "2000-03-01")).toEqual([]);
    expect(validateDateRange("1900-02-29", "1900-03-01")).toHaveLength(1);
  });

  it("accepts 30- and 31-day month ends", () => {
    expect(validateDateRange("2026-04-30", "2026-05-31")).toEqual([]);
    expect(validateDateRange("2026-04-31", "2026-05-31")).toHaveLength(1);
  });

  it("uses custom labels in every message", () => {
    expect(
      validateDateRange("2027-01-01", "2026-01-01", "Start date", "end date")
    ).toEqual(["Start date can't be after the end date."]);
    expect(validateDateRange("x", "y", "Start date", "end date")).toEqual([
      "Start date isn't a valid date.",
      "end date isn't a valid date.",
    ]);
  });

  it("tolerates surrounding whitespace", () => {
    expect(validateDateRange(" 2026-01-01 ", " 2026-06-01 ")).toEqual([]);
  });
});

describe("validateYear", () => {
  const THIS_YEAR = 2026;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(`${THIS_YEAR}-07-31T12:00:00`));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("accepts a plausible year", () => {
    expect(validateYear("1985", "Year built")).toEqual([]);
    expect(validateYear(1985, "Year built")).toEqual([]);
  });

  it("skips empty and absent values", () => {
    expect(validateYear("", "Year built")).toEqual([]);
    expect(validateYear(null, "Year built")).toEqual([]);
    expect(validateYear(undefined, "Year built")).toEqual([]);
    expect(validateYear("   ", "Year built")).toEqual([]);
  });

  // Default bounds: 1600..currentYear+5, matching validateAccountFields.
  it("holds the default lower bound at 1600", () => {
    expect(validateYear("1600", "Year built")).toEqual([]);
    expect(validateYear("1599", "Year built")).toEqual([
      `Year built should be between 1600 and ${THIS_YEAR + 5}.`,
    ]);
  });

  it("holds the default upper bound at currentYear + 5", () => {
    expect(validateYear(String(THIS_YEAR + 5), "Year built")).toEqual([]);
    expect(validateYear(String(THIS_YEAR + 6), "Year built")).toEqual([
      `Year built should be between 1600 and ${THIS_YEAR + 5}.`,
    ]);
  });

  // PropertyPanel's renovation years: 1600..currentYear+1.
  it("honours maxYearsAhead: 1 for renovation years", () => {
    const o = { maxYearsAhead: 1 };
    expect(validateYear(String(THIS_YEAR), "Roof updated year", o)).toEqual([]);
    expect(validateYear(String(THIS_YEAR + 1), "Roof updated year", o)).toEqual(
      []
    );
    expect(validateYear(String(THIS_YEAR + 2), "Roof updated year", o)).toEqual([
      `Roof updated year should be between 1600 and ${THIS_YEAR + 1}.`,
    ]);
    // The +5 default would have let this through — the two ranges differ.
    expect(validateYear(String(THIS_YEAR + 2), "Roof updated year")).toEqual([]);
  });

  it("honours a custom min", () => {
    expect(validateYear("1899", "Built", { min: 1900 })).toEqual([
      `Built should be between 1900 and ${THIS_YEAR + 5}.`,
    ]);
    expect(validateYear("1900", "Built", { min: 1900 })).toEqual([]);
  });

  it("rejects non-numeric and non-integer input", () => {
    expect(validateYear("abcd", "Year built")).toHaveLength(1);
    expect(validateYear("19x5", "Year built")).toHaveLength(1);
    expect(validateYear("1985.5", "Year built")).toHaveLength(1);
    expect(validateYear("-1985", "Year built")).toHaveLength(1);
  });

  it("names the field in the message", () => {
    expect(validateYear("1", "HVAC updated year")[0]).toContain(
      "HVAC updated year"
    );
  });
});

describe("validatePositiveInt", () => {
  it("accepts whole numbers as string or number", () => {
    expect(validatePositiveInt("42", "Unit count")).toEqual([]);
    expect(validatePositiveInt(42, "Unit count")).toEqual([]);
  });

  it("accepts zero by default — the bound is 'not negative'", () => {
    expect(validatePositiveInt("0", "Unit count")).toEqual([]);
    expect(validatePositiveInt(0, "Unit count")).toEqual([]);
  });

  it("skips empty and absent values, but not the number zero", () => {
    expect(validatePositiveInt("", "Unit count")).toEqual([]);
    expect(validatePositiveInt(null, "Unit count")).toEqual([]);
    expect(validatePositiveInt(undefined, "Unit count")).toEqual([]);
    expect(validatePositiveInt("  ", "Unit count")).toEqual([]);
    expect(validatePositiveInt(0, "Unit count")).toEqual([]);
  });

  it("rejects negatives", () => {
    expect(validatePositiveInt("-1", "Unit count")).toEqual([
      "Unit count should be a whole number of at least 0.",
    ]);
    expect(validatePositiveInt(-1, "Unit count")).toHaveLength(1);
  });

  it("rejects decimals", () => {
    expect(validatePositiveInt("1.5", "Unit count")).toHaveLength(1);
    expect(validatePositiveInt(1.5, "Unit count")).toHaveLength(1);
    // A decimal that lands on a whole number is still whole.
    expect(validatePositiveInt("2.0", "Unit count")).toEqual([]);
  });

  it("rejects non-numeric input", () => {
    expect(validatePositiveInt("abc", "Unit count")).toHaveLength(1);
    expect(validatePositiveInt("12abc", "Unit count")).toHaveLength(1);
    expect(validatePositiveInt(NaN, "Unit count")).toHaveLength(1);
    expect(validatePositiveInt(Infinity, "Unit count")).toHaveLength(1);
  });

  it("honours a custom min at the boundary and either side", () => {
    const o = { min: 1 };
    expect(validatePositiveInt("0", "Stories", o)).toEqual([
      "Stories should be a whole number of at least 1.",
    ]);
    expect(validatePositiveInt("1", "Stories", o)).toEqual([]);
    expect(validatePositiveInt("2", "Stories", o)).toEqual([]);
  });

  it("honours a max at the boundary and either side, and says so", () => {
    const o = { max: 100000 };
    expect(validatePositiveInt("99999", "Unit count", o)).toEqual([]);
    expect(validatePositiveInt("100000", "Unit count", o)).toEqual([]);
    expect(validatePositiveInt("100001", "Unit count", o)).toEqual([
      "Unit count should be a whole number between 0 and 100000.",
    ]);
  });

  it("names the field in the message", () => {
    expect(validatePositiveInt("-3", "Miles to coast")[0]).toContain(
      "Miles to coast"
    );
  });

  it("composes by concatenation, the validateAccountFields contract", () => {
    const problems = [
      ...validatePositiveInt("-1", "Unit count"),
      ...validateDateRange("2027-01-01", "2026-01-01"),
    ];
    expect(problems).toHaveLength(2);
    expect(problems.join(" ")).toBe(
      "Unit count should be a whole number of at least 0. " +
        "Effective date can't be after the expiration date."
    );
  });
});
