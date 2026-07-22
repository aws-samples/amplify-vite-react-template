import { describe, expect, it } from "vitest";
import {
  assertDispatchFacts,
  normalizePropertyClass,
  onsiteMinutesFor,
} from "./dispatchReadiness";

/**
 * GL-12 — dispatch readiness is proven facts, not non-blank strings: a real
 * MA/RI address (placeholders refused), and an explicit property
 * classification carrying the locked 30/60-minute durations.
 */

const GOOD = {
  displayName: "Dana Whitlock",
  serviceStreet: "18 Cedar Ln",
  serviceCity: "Providence",
  serviceState: "RI",
  serviceZip: "02906",
};
const JOB = { propertyClass: "RESIDENTIAL", serviceType: "General pest" };

describe("the dispatch gate (GL-12)", () => {
  it("passes a real MA/RI address with an explicit classification", () => {
    expect(() => assertDispatchFacts(GOOD, JOB)).not.toThrow();
    expect(() =>
      assertDispatchFacts(
        { ...GOOD, serviceState: "Massachusetts", serviceZip: "01082" },
        JOB
      )
    ).not.toThrow();
  });

  it("refuses placeholder tokens that satisfy non-blank", () => {
    for (const street of ["n/a", "NA", "tbd", "xxx", "----", "?", "123"]) {
      expect(() =>
        assertDispatchFacts({ ...GOOD, serviceStreet: street }, JOB)
      ).toThrow(/isn't a real street address|needs fixing/i);
    }
    expect(() =>
      assertDispatchFacts({ ...GOOD, serviceCity: "same" }, JOB)
    ).toThrow(/isn't a real city/i);
  });

  it("refuses addresses outside the MA/RI launch territory", () => {
    expect(() =>
      assertDispatchFacts({ ...GOOD, serviceState: "CT", serviceZip: "06010" }, JOB)
    ).toThrow(/must be MA or RI/i);
    expect(() =>
      assertDispatchFacts({ ...GOOD, serviceZip: "90210" }, JOB)
    ).toThrow(/isn't a Massachusetts\/Rhode Island ZIP/i);
  });

  it("requires the explicit property classification", () => {
    expect(() =>
      assertDispatchFacts(GOOD, { propertyClass: null, serviceType: "x" })
    ).toThrow(/property classification/i);
    expect(() =>
      assertDispatchFacts(GOOD, { propertyClass: "MANSION", serviceType: "x" })
    ).toThrow(/property classification/i);
  });

  it("carries the locked durations: residential 30, commercial/community 60", () => {
    expect(onsiteMinutesFor("RESIDENTIAL")).toBe(30);
    expect(onsiteMinutesFor("COMMERCIAL")).toBe(60);
    expect(onsiteMinutesFor("COMMUNITY")).toBe(60);
    expect(normalizePropertyClass(" residential ")).toBe("RESIDENTIAL");
    expect(normalizePropertyClass("mansion")).toBeNull();
  });
});
