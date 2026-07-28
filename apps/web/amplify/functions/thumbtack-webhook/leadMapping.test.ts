import { describe, expect, it } from "vitest";
import {
  halfAcresFromBand,
  mapThumbtackLead,
  propertyClassFrom,
  serviceFrom,
  sqftFromBand,
} from "./leadMapping";

/**
 * These map a marketplace questionnaire onto a real dollar amount, so the bias
 * throughout is: an answer we don't recognise becomes null and a human decides.
 * A confident wrong mapping reaches a customer as a quoted price.
 */

describe("sqftFromBand", () => {
  it("takes the TOP of a Thumbtack range — never under-quote a job", () => {
    expect(sqftFromBand("3,000 - 4,000 sq ft")).toBe(4000);
    expect(sqftFromBand("1,000-2,000 sq ft")).toBe(2000);
  });

  it("handles a single value and an open-ended band", () => {
    expect(sqftFromBand("2,500 sq ft")).toBe(2500);
    expect(sqftFromBand("5,000+ sq ft")).toBe(5000);
  });

  it("is null on an unparseable answer rather than guessing", () => {
    expect(sqftFromBand("not sure")).toBeNull();
    expect(sqftFromBand(null)).toBeNull();
    expect(sqftFromBand("")).toBeNull();
  });
});

describe("halfAcresFromBand", () => {
  it("converts a square-foot lot band to half-acres, rounding up", () => {
    // 5,000–10,000 sq ft → 10,000 / 21,780 → ceil = 1 half-acre.
    expect(halfAcresFromBand("5,000 - 10,000 sq ft")).toBe(1);
    // 20,000–30,000 → 30,000 / 21,780 = 1.38 → 2.
    expect(halfAcresFromBand("20,000 - 30,000 sq ft")).toBe(2);
  });

  it("understands answers expressed in acres", () => {
    // 1 acre = 43,560 sq ft = 2 half-acres.
    expect(halfAcresFromBand("1 acre")).toBe(2);
    // 3 acres = 130,680 sq ft = exactly 6 half-acres.
    expect(halfAcresFromBand("2 - 3 acres")).toBe(6);
  });

  it("never returns zero, and clamps to the engine's 1–8 range", () => {
    expect(halfAcresFromBand("100 sq ft")).toBe(1);
    expect(halfAcresFromBand("50 acres")).toBe(8);
  });

  it("is null when the answer says nothing numeric", () => {
    expect(halfAcresFromBand("not sure")).toBeNull();
  });
});

describe("propertyClassFrom", () => {
  it("maps the common Thumbtack answers", () => {
    expect(propertyClassFrom("Residential")).toBe("RESIDENTIAL");
    expect(propertyClassFrom("Commercial")).toBe("COMMERCIAL");
    expect(propertyClassFrom("HOA / community")).toBe("COMMUNITY");
  });

  it("is null on anything it does not recognise", () => {
    expect(propertyClassFrom("Other")).toBeNull();
    expect(propertyClassFrom(null)).toBeNull();
  });
});

describe("serviceFrom", () => {
  it("routes mosquito by category even when the pest answer is vague", () => {
    expect(serviceFrom("Outdoor Mosquito Control Services", "Mosquito breeding areas", "RESIDENTIAL")).toBe("MOSQUITO");
  });

  it("lets the PEST answer override the property-class rule for count-priced work", () => {
    // "Pest Control Services" + wasps is NOT general pest — it prices per nest.
    expect(serviceFrom("Pest Control Services", "Wasps", "RESIDENTIAL")).toBe("WASP_NEST");
    expect(serviceFrom("Pest Control Services", "Yellow jackets", "RESIDENTIAL")).toBe("WASP_NEST");
    expect(serviceFrom("Pest Control Services", "Raccoon", "RESIDENTIAL")).toBe("WILDLIFE");
    expect(serviceFrom("Pest Control Services", "Mice", "RESIDENTIAL")).toBe("RODENT");
  });

  it("splits general vs commercial pest on the property class", () => {
    expect(serviceFrom("Pest Control Services", "Ants", "RESIDENTIAL")).toBe("GENERAL_PEST");
    expect(serviceFrom("Pest Control Services", "Ants", "COMMERCIAL")).toBe("COMMERCIAL_PEST");
  });

  it("is null on an unknown category rather than defaulting to general pest", () => {
    expect(serviceFrom("Gutter Cleaning", null, "RESIDENTIAL")).toBeNull();
  });
});

describe("mapThumbtackLead — end to end on real lead shapes", () => {
  it("maps the ants lead: residential general pest with a real sqft band", () => {
    const mapped = mapThumbtackLead("Pest Control Services", [
      { question: "Property type", answer: "Residential" },
      { question: "Primary pest type", answer: "Ants" },
      { question: "Total square footage of building", answer: "3,000 - 4,000 sq ft" },
    ]);

    expect(mapped.service).toBe("GENERAL_PEST");
    expect(mapped.propertyClass).toBe("RESIDENTIAL");
    expect(mapped.sqft).toBe(4000);
    expect(mapped.gaps).toEqual([]);
  });

  it("maps the mosquito lead off lot size, not building size", () => {
    const mapped = mapThumbtackLead("Outdoor Mosquito Control Services", [
      { question: "Property type", answer: "Residential" },
      { question: "Target pests", answer: "Mosquito breeding areas" },
      { question: "Property size", answer: "5,000 - 10,000 sq ft" },
    ]);

    expect(mapped.service).toBe("MOSQUITO");
    expect(mapped.lotHalfAcres).toBe(1);
    expect(mapped.gaps).toEqual([]);
  });

  it("ALWAYS flags a count-priced service — Thumbtack never asks how many", () => {
    const mapped = mapThumbtackLead("Pest Control Services", [
      { question: "Property type", answer: "Residential" },
      { question: "Primary pest type", answer: "Wasps" },
      { question: "Total square footage of building", answer: "2,000 - 3,000 sq ft" },
    ]);

    expect(mapped.service).toBe("WASP_NEST");
    expect(mapped.gaps.join(" ")).toMatch(/nest count/);
  });

  it("does not demand square footage for a service that is not priced on it", () => {
    const mapped = mapThumbtackLead("Outdoor Mosquito Control Services", [
      { question: "Property type", answer: "Residential" },
      { question: "Property size", answer: "1 acre" },
    ]);
    expect(mapped.gaps).not.toContain("square footage");
  });

  it("reports every gap when the questionnaire is thin, instead of auto-quoting", () => {
    const mapped = mapThumbtackLead("Pest Control Services", [
      { question: "Primary pest type", answer: "Not sure" },
    ]);

    // The CATEGORY is decisive, so general pest is a fair reading — but the
    // property type is not known, and a commercial job priced as residential
    // is exactly the mistake that must never reach a customer. The gap is
    // what blocks the auto-quote.
    expect(mapped.service).toBe("GENERAL_PEST");
    expect(mapped.gaps).toContain("property type");
    expect(mapped.gaps).toContain("square footage");
  });

  it("refuses to name a service for a category we do not sell", () => {
    const mapped = mapThumbtackLead("Gutter Cleaning", [
      { question: "Property type", answer: "Residential" },
    ]);
    expect(mapped.service).toBeNull();
    expect(mapped.gaps.join(" ")).toMatch(/service/);
  });

  it("tolerates Thumbtack's varying question wording", () => {
    const mapped = mapThumbtackLead("Pest Control Services", [
      { question: "What type of property is it?", answer: "Residential" },
      { question: "What kind of pest are you dealing with?", answer: "Ants" },
      { question: "Home size", answer: "1,500 - 2,000 sq ft" },
    ]);

    expect(mapped.service).toBe("GENERAL_PEST");
    expect(mapped.sqft).toBe(2000);
    expect(mapped.gaps).toEqual([]);
  });
});
