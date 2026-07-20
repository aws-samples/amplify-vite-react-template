import { describe, expect, it } from "vitest";
import {
  CATALOG_IDS,
  catalogEntry,
  entryForLabel,
  funnelCatalog,
  onsiteMinutesForClass,
  planNameFor,
  PUBLIC_CONFLICTS,
  SERVICE_CATALOG,
  SERVICE_CATALOG_VERSION,
  serviceLabelFor,
} from "./serviceCatalog";

/**
 * GL-01 — the ONE versioned service catalog. These tests pin the contract
 * every derived surface relies on: the funnel subset, byte-identical sold
 * labels, the resolver that adopts every historical string, the locked
 * duration rule, and the seasonal facts.
 */

describe("the catalog is the single source", () => {
  it("is versioned, and every entry carries its own id", () => {
    expect(SERVICE_CATALOG_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
    for (const id of CATALOG_IDS) {
      expect(SERVICE_CATALOG[id].id).toBe(id);
      expect(catalogEntry(id)).toBe(SERVICE_CATALOG[id]);
    }
    expect(catalogEntry("NOT_A_SERVICE")).toBeNull();
    expect(catalogEntry(null)).toBeNull();
  });

  it("the funnel dropdown derives from the catalog — the eight bookable services, wording preserved", () => {
    expect(funnelCatalog().map((e) => e.id)).toEqual([
      "GENERAL_PEST",
      "WASP_NEST",
      "RODENT",
      "ROACH",
      "TERMITE",
      "WILDLIFE",
      "MOSQUITO",
      "MOSQUITO_TICK",
    ]);
    // The dropdown wording (SERVICE_OPTIONS derives funnelLabel ?? label) is
    // exactly what customers saw before the catalog existed, plus the two
    // GL-17 seasonal plans the CEO chose to sell through the funnel.
    expect(
      funnelCatalog().map((e) => [e.id, e.funnelLabel ?? e.label])
    ).toEqual([
      ["GENERAL_PEST", "General pest control"],
      ["WASP_NEST", "Wasp / hornet nest removal"],
      ["RODENT", "Rodent treatment"],
      ["ROACH", "Roach treatment"],
      ["TERMITE", "Termite inspection & treatment"],
      ["WILDLIFE", "Wildlife removal"],
      ["MOSQUITO", "Mosquito plan (Apr–Oct)"],
      ["MOSQUITO_TICK", "Mosquito + tick plan (Apr–Oct)"],
    ]);
  });

  it("planNameFor never doubles the word 'plan' on seasonal labels", () => {
    expect(planNameFor("MOSQUITO")).toBe("Mosquito plan (Apr–Oct)");
    expect(planNameFor("MOSQUITO_TICK")).toBe("Mosquito + tick plan (Apr–Oct)");
    expect(planNameFor("GENERAL_PEST")).toBe("General pest control plan");
  });

  it("mosquito plans carry the locked seasonal facts; nothing else does", () => {
    for (const id of CATALOG_IDS) {
      expect(SERVICE_CATALOG[id].seasonal).toBe(
        id === "MOSQUITO" || id === "MOSQUITO_TICK"
      );
    }
  });

  it("duration is the LOCKED property-class rule — the class decides, never the service", () => {
    expect(onsiteMinutesForClass("RESIDENTIAL")).toBe(30);
    expect(onsiteMinutesForClass("COMMERCIAL")).toBe(60);
    expect(onsiteMinutesForClass("COMMUNITY")).toBe(60);
    expect(onsiteMinutesForClass(null)).toBe(30);
  });
});

describe("labels — byte-identical to what the funnel has always sold", () => {
  it("produces the exact historical funnel labels", () => {
    expect(serviceLabelFor("GENERAL_PEST")).toBe(
      "General pest control — one-time treatment"
    );
    expect(serviceLabelFor("WASP_NEST", { nestCount: 1 })).toBe(
      "Wasp / hornet nest removal"
    );
    expect(serviceLabelFor("WASP_NEST", { nestCount: 3 })).toBe(
      "Wasp / hornet nest removal — 3 nests"
    );
    expect(serviceLabelFor("RODENT", { sqftBucket: 2000 })).toBe(
      "Rodent treatment — up to 2,000 sqft"
    );
    expect(serviceLabelFor("ROACH", { sqftBucket: 2000 })).toBe(
      "Specialized roach treatment — up to 2,000 sqft"
    );
    expect(serviceLabelFor("TERMITE", { sqftBucket: 3000 })).toBe(
      "Termite treatment — up to 3,000 sqft"
    );
    // Wildlife prices by what needs removed + how many, not sqft.
    expect(serviceLabelFor("WILDLIFE", { removalKind: "Raccoons", removalCount: 1 })).toBe(
      "Wildlife exclusion and removal — raccoons"
    );
    expect(serviceLabelFor("WILDLIFE", { removalKind: "Squirrels", removalCount: 3 })).toBe(
      "Wildlife exclusion and removal — 3 squirrels"
    );
    expect(serviceLabelFor("WILDLIFE", { removalKind: "Other / not sure", removalCount: 2 })).toBe(
      "Wildlife exclusion and removal — 2 animals"
    );
    expect(serviceLabelFor("WILDLIFE")).toBe("Wildlife exclusion and removal");
    expect(serviceLabelFor("COMMERCIAL_PEST", { sqftBucket: 5000 })).toBe(
      "Commercial pest control — up to 5,000 sqft"
    );
    expect(serviceLabelFor("HOA_COMMON_AREA", { units: 30 })).toBe(
      "Community common-area pest control — 30 units"
    );
  });

  it("plan names match the historical strip-the-suffix derivation", () => {
    expect(planNameFor("GENERAL_PEST")).toBe("General pest control plan");
    expect(planNameFor("HOA_COMMON_AREA")).toBe(
      "Community common-area pest control plan"
    );
  });
});

describe("entryForLabel — every string this business ever wrote resolves (or honestly doesn't)", () => {
  it("round-trips every catalog label and its sized variants", () => {
    for (const id of CATALOG_IDS) {
      expect(entryForLabel(serviceLabelFor(id))?.id).toBe(id);
      expect(entryForLabel(planNameFor(id))?.id).toBe(id);
    }
    expect(
      entryForLabel("Rodent treatment — up to 2,000 sqft")?.id
    ).toBe("RODENT");
    expect(
      entryForLabel("Community common-area pest control — 30 units")?.id
    ).toBe("HOA_COMMON_AREA");
  });

  it("adopts the office's historical typed strings and lead-pricing labels", () => {
    expect(entryForLabel("General Pest Treatment")?.id).toBe("GENERAL_PEST");
    expect(entryForLabel("general pest")?.id).toBe("GENERAL_PEST");
    expect(entryForLabel("Mosquito + tick plan (Apr–Oct)")?.id).toBe(
      "MOSQUITO_TICK"
    );
    expect(entryForLabel("Mosquito plan (Apr–Oct)")?.id).toBe("MOSQUITO");
    expect(entryForLabel("Association/HOA common areas — quarterly")?.id).toBe(
      "HOA_COMMON_AREA"
    );
    expect(entryForLabel("wasp nest by the porch")?.id).toBe("WASP_NEST");
  });

  it("mosquito+tick outranks plain mosquito; commercial doesn't swallow community", () => {
    expect(entryForLabel("mosquito and tick program")?.id).toBe("MOSQUITO_TICK");
    expect(entryForLabel("mosquito only")?.id).toBe("MOSQUITO");
    expect(
      entryForLabel("Community common-area pest control (commercial-grade)")?.id
    ).toBe("HOA_COMMON_AREA");
  });

  it("genuinely uncataloged work resolves to NOTHING — the caller owns the decision", () => {
    expect(entryForLabel("attic insulation restoration")).toBeNull();
    expect(entryForLabel("")).toBeNull();
    expect(entryForLabel(null)).toBeNull();
  });
});

describe("GL-20 tie — the public-conflict inventory stays visible and complete", () => {
  it("every conflict names its files, the promise, the conflict, and a CEO-ready proposal", () => {
    expect(PUBLIC_CONFLICTS.length).toBeGreaterThanOrEqual(5);
    for (const c of PUBLIC_CONFLICTS) {
      expect(c.files.length).toBeGreaterThan(0);
      expect(c.promise.length).toBeGreaterThan(10);
      expect(c.conflict.length).toBeGreaterThan(10);
      expect(c.proposal.length).toBeGreaterThan(10);
    }
  });
});
