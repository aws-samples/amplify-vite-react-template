import { describe, expect, it } from "vitest";
import {
  quoteInputFromExtraction,
  type Extraction,
} from "./leadExtraction";

/**
 * Freeform text reaches a price ONLY through this mapping, and the mapping only
 * ever chooses the same inputs the structured form collects. The model never
 * returns money, so the guardrail that matters here is the refusal boundary:
 * anything that cannot be mapped confidently must become a callback, never a
 * guess. Guessing general pest when someone meant roach is a real price gap.
 */

const base: Extraction = {
  eligibility: "ok",
  propertyType: "residential",
  specialtyKind: "none",
  pest: "ants",
  customerName: null,
  town: null,
  state: null,
  fullAddress: null,
  sqft: 2000,
  units: null,
  nestCount: null,
  animalCount: null,
  halfAcres: null,
  tick: false,
  frequencyInterest: "unspecified",
  leadFeeCents: null,
  rodentInterest: false,
  multiProperty: false,
  competitorMatchBelowFloor: false,
  complianceDocsRequested: false,
  assumptions: [],
} as unknown as Extraction;

describe("the mapping never invents a price input", () => {
  it("maps a plain residential ask to general pest on square footage", () => {
    const r = quoteInputFromExtraction(base);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.input).toMatchObject({
        service: "GENERAL_PEST",
        propertyKind: "RESIDENTIAL",
        sqft: 2000,
      });
    }
  });

  it("carries a requested cadence through", () => {
    const r = quoteInputFromExtraction({
      ...base,
      frequencyInterest: "quarterly",
    } as Extraction);
    expect(r.ok && r.input.recurringPreference).toBe("QUARTERLY");
  });

  it("a named specialty beats the property type", () => {
    // "wasps at my condo" is a wasp job, not a per-unit common-area program.
    const r = quoteInputFromExtraction({
      ...base,
      propertyType: "association",
      specialtyKind: "wasp_nest",
      nestCount: 2,
      units: 40,
    } as Extraction);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.input.service).toBe("WASP_NEST");
      expect(r.input.nestCount).toBe(2);
      expect(r.input.units).toBeUndefined();
    }
  });

  it("routes an association to the per-unit program on its unit count", () => {
    const r = quoteInputFromExtraction({
      ...base,
      propertyType: "association",
      units: 24,
      sqft: null,
    } as Extraction);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.input).toMatchObject({ propertyKind: "COMMUNITY", units: 24 });
    }
  });

  it("picks the tick plan only when ticks were actually mentioned", () => {
    const mosquito = { ...base, propertyType: "mosquito", halfAcres: 2, sqft: null };
    expect(
      (quoteInputFromExtraction(mosquito as Extraction) as { input: { service: string } }).input.service
    ).toBe("MOSQUITO");
    expect(
      (quoteInputFromExtraction({ ...mosquito, tick: true } as Extraction) as { input: { service: string } }).input.service
    ).toBe("MOSQUITO_TICK");
  });
});

describe("refusals — a callback beats a wrong price", () => {
  it("every ineligible kind refuses with a reason, and never a price input", () => {
    for (const kind of [
      "bed_bugs",
      "food_service",
      "fumigation",
      "wildlife",
      "out_of_area",
    ] as const) {
      const r = quoteInputFromExtraction({ ...base, eligibility: kind } as Extraction);
      expect(r.ok, kind).toBe(false);
      if (!r.ok) {
        expect(r.reason.length, kind).toBeGreaterThan(0);
        expect(r.eligibility, kind).toBe(kind);
      }
    }
  });

  it("refuses rather than guessing when the ask is unreadable", () => {
    const r = quoteInputFromExtraction({
      ...base,
      propertyType: "unknown",
      specialtyKind: "none",
    } as Extraction);
    expect(r.ok).toBe(false);
  });

  it("refuses when the SIZE that sets the price is missing", () => {
    // Missing sqft/units/nests is the difference between a real price and a
    // made-up one, so each is an ask-back rather than a default.
    expect(quoteInputFromExtraction({ ...base, sqft: null } as Extraction).ok).toBe(false);
    expect(
      quoteInputFromExtraction({
        ...base,
        propertyType: "association",
        units: null,
        sqft: null,
      } as Extraction).ok
    ).toBe(false);
    expect(
      quoteInputFromExtraction({
        ...base,
        specialtyKind: "wasp_nest",
        nestCount: null,
      } as Extraction).ok
    ).toBe(false);
    expect(
      quoteInputFromExtraction({
        ...base,
        propertyType: "mosquito",
        halfAcres: null,
        sqft: null,
      } as Extraction).ok
    ).toBe(false);
  });

  it("only ever emits fields the structured form already collects", () => {
    // The mapping cannot introduce a pricing input of its own — that is what
    // keeps freeform text on exactly one pricing engine.
    const allowed = new Set([
      "service",
      "propertyKind",
      "sqft",
      "units",
      "nestCount",
      "removalKind",
      "removalCount",
      "lotHalfAcres",
      "recurringPreference",
    ]);
    const r = quoteInputFromExtraction(base);
    if (r.ok) {
      for (const k of Object.keys(r.input)) expect(allowed.has(k), k).toBe(true);
    }
  });
});
