import { describe, expect, it } from "vitest";
import { inputValue, num, str } from "./formCodec";

describe("str", () => {
  it("passes an ordinary value through", () => {
    expect(str("Maple Ridge HOA")).toBe("Maple Ridge HOA");
  });

  it("trims the value it returns", () => {
    expect(str("  Maple Ridge HOA  ")).toBe("Maple Ridge HOA");
    expect(str("\tMA\n")).toBe("MA");
  });

  it("returns null for an empty string", () => {
    expect(str("")).toBeNull();
  });

  it("returns null for whitespace only", () => {
    expect(str("   ")).toBeNull();
    expect(str("\t\n ")).toBeNull();
  });

  it("returns null for null and undefined", () => {
    expect(str(null)).toBeNull();
    expect(str(undefined)).toBeNull();
  });

  it("never returns undefined, so an update always clears a blanked field", () => {
    // The whole point: `undefined` is a no-op on Amplify update.
    for (const v of ["", "   ", null, undefined]) {
      expect(str(v)).not.toBe(undefined);
    }
  });

  it("matches `x.trim() || null` on every string the old idiom saw", () => {
    for (const v of ["a", " a ", "", "  ", "0", "false", "\t"]) {
      expect(str(v)).toStrictEqual(v.trim() || null);
    }
  });
});

describe("num", () => {
  it("parses an integer string", () => {
    expect(num("42")).toBe(42);
  });

  it("parses a decimal string", () => {
    expect(num("12.5")).toBe(12.5);
  });

  it("parses a negative", () => {
    expect(num("-3")).toBe(-3);
    expect(num("-0.5")).toBe(-0.5);
  });

  it('treats "0" as the value zero, not as blank', () => {
    // `"0"` is a truthy string, so the old `x ? Number(x) : null` also gets
    // this right. Pinned because it reads like it wouldn't.
    expect(num("0")).toBe(0);
    expect(num("0.0")).toBe(0);
    expect(num("-0")).toBe(-0);
  });

  it("returns null for an empty string", () => {
    expect(num("")).toBeNull();
  });

  it("returns null for whitespace only", () => {
    // Divergence from `x ? Number(x) : null`: `" "` is truthy and
    // `Number(" ")` is 0, so the old idiom writes 0 here.
    expect(num("   ")).toBeNull();
    expect(num("\t")).toBeNull();
    const oldIdiom = (v: string) => (v ? Number(v) : null);
    expect(oldIdiom(" ")).toBe(0);
  });

  it("trims before parsing", () => {
    expect(num("  42  ")).toBe(42);
  });

  it("returns null for text, never NaN", () => {
    expect(num("abc")).toBeNull();
    expect(num("12abc")).toBeNull();
    expect(num("--1")).toBeNull();
    expect(num("1.2.3")).toBeNull();
  });

  it("returns null rather than Infinity", () => {
    expect(num("Infinity")).toBeNull();
    expect(num("-Infinity")).toBeNull();
    expect(num("1e400")).toBeNull();
  });

  it("returns null for NaN spelled out", () => {
    expect(num("NaN")).toBeNull();
  });

  it("accepts exponent notation, which a number input can produce", () => {
    expect(num("1e3")).toBe(1000);
  });

  it("returns null for currency formatting", () => {
    // No `<input type="number">` can hold a comma or a dollar sign; the
    // formatted-text parser lives in ExtractionPanel, not here.
    expect(num("1,200")).toBeNull();
    expect(num("$1200")).toBeNull();
  });

  it("returns null for null and undefined", () => {
    expect(num(null)).toBeNull();
    expect(num(undefined)).toBeNull();
  });

  it("matches `x ? Number(x) : null` on every input a number field can hold", () => {
    // `type="number"` sanitizes anything unparseable to "", so these are the
    // real reachable values. Whitespace and text are excluded on purpose —
    // they are the two cases where this helper deliberately differs.
    for (const v of ["42", "12.5", "-3", "0", "", "1e3", "0.0"]) {
      expect(num(v)).toStrictEqual(v ? Number(v) : null);
    }
  });
});

describe("inputValue", () => {
  it("renders a number as its string", () => {
    expect(inputValue(42)).toBe("42");
    expect(inputValue(12.5)).toBe("12.5");
  });

  it("renders zero as \"0\", not blank", () => {
    expect(inputValue(0)).toBe("0");
  });

  it("passes a string through untouched, including whitespace", () => {
    expect(inputValue("Maple Ridge HOA")).toBe("Maple Ridge HOA");
    expect(inputValue("  padded  ")).toBe("  padded  ");
  });

  it("renders null and undefined as an empty string", () => {
    expect(inputValue(null)).toBe("");
    expect(inputValue(undefined)).toBe("");
  });

  it("round-trips a stored number through an untouched input", () => {
    expect(num(inputValue(42))).toBe(42);
    expect(num(inputValue(0))).toBe(0);
    expect(num(inputValue(null))).toBeNull();
  });

  it("round-trips a stored string through an untouched input", () => {
    expect(str(inputValue("Maple Ridge HOA"))).toBe("Maple Ridge HOA");
    expect(str(inputValue(null))).toBeNull();
  });
});
