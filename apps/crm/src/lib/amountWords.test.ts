import { describe, expect, it } from "vitest";
import { amountInWords, numberToWords } from "./amountWords";

/**
 * The confirmation's whole job is to make a decimal slip unmissable. If the
 * words for $149.00 and $14,900.00 aren't obviously different at a glance, the
 * control doesn't work.
 */

describe("amountInWords", () => {
  it("distinguishes the typo this exists to catch", () => {
    // The review's scenario: meant $149.00, typed 14900.
    expect(amountInWords(14900)).toBe("one hundred and forty-nine dollars");
    expect(amountInWords(1490000)).toBe("fourteen thousand nine hundred dollars");
  });

  it("writes cents as digits", () => {
    expect(amountInWords(14950)).toBe("one hundred and forty-nine dollars and 50 cents");
    expect(amountInWords(101)).toBe("one dollar and 1 cent");
  });

  it("gets the singular right", () => {
    expect(amountInWords(100)).toBe("one dollar");
    expect(amountInWords(200)).toBe("two dollars");
  });

  it("handles a zero amount", () => {
    expect(amountInWords(0)).toBe("zero dollars");
  });

  it.each([
    [2999, "twenty-nine dollars and 99 cents"],
    [29900, "two hundred and ninety-nine dollars"],
    [50000, "five hundred dollars"],
    [250000, "two thousand five hundred dollars"],
    [500000, "five thousand dollars"],
    [409000, "four thousand and ninety dollars"],
  ])("writes %i cents as %s", (cents, expected) => {
    expect(amountInWords(cents)).toBe(expected);
  });

  it("rounds a fractional cent rather than emitting nonsense", () => {
    expect(amountInWords(149.4)).toBe("one dollar and 49 cents");
  });

  it("returns nothing for a negative amount", () => {
    expect(amountInWords(-100)).toBe("");
  });

  it("returns nothing above a million dollars, which is not a charge", () => {
    expect(amountInWords(100_000_000)).toBe("");
  });
});

describe("numberToWords", () => {
  it.each([
    [0, "zero"],
    [7, "seven"],
    [13, "thirteen"],
    [20, "twenty"],
    [21, "twenty-one"],
    [99, "ninety-nine"],
    [100, "one hundred"],
    [149, "one hundred and forty-nine"],
    [999, "nine hundred and ninety-nine"],
    [1000, "one thousand"],
    [1001, "one thousand and one"],
    [14900, "fourteen thousand nine hundred"],
    [20000, "twenty thousand"],
  ])("writes %i as %s", (n, expected) => {
    expect(numberToWords(n)).toBe(expected);
  });
});
