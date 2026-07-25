import { describe, expect, it } from "vitest";
import {
  displayAddress,
  qualifyUnit,
  routingAddress,
  streetLooksLikeItHidesAUnit,
} from "./serviceAddress";

/**
 * The split that exists because of a real outage: a unit typed into the street
 * line ("290 Eliot Street, Unit 289 America blvd") could not be geocoded, which
 * made one technician's whole day unmeasurable, which failed closed into a
 * false "that day is fully booked" on a nearly empty day.
 */

const CONDO = {
  serviceStreet: "290 Eliot Street",
  serviceUnit: "289",
  serviceCity: "Ashland",
  serviceState: "MA",
  serviceZip: "01721",
};

describe("routingAddress — geocodable, never carries the unit", () => {
  it("omits the unit entirely", () => {
    expect(routingAddress(CONDO)).toBe("290 Eliot Street, Ashland, MA, 01721");
    expect(routingAddress(CONDO)).not.toMatch(/289|unit/i);
  });

  it("is unchanged whether or not a unit is present", () => {
    const noUnit = { ...CONDO, serviceUnit: null };
    expect(routingAddress(noUnit)).toBe(routingAddress(CONDO));
  });

  it("skips blank parts rather than emitting empty commas", () => {
    expect(
      routingAddress({ serviceStreet: "1 Main St", serviceCity: "  ", serviceZip: "01001" })
    ).toBe("1 Main St, 01001");
  });

  it("is empty when there is nothing to route", () => {
    expect(routingAddress({})).toBe("");
  });
});

describe("displayAddress — what a human reads, unit included", () => {
  it("includes the unit so the technician can find the door", () => {
    expect(displayAddress(CONDO)).toBe(
      "290 Eliot Street, Unit 289, Ashland, MA, 01721"
    );
  });

  it("does not double-qualify an already-labelled unit", () => {
    expect(displayAddress({ ...CONDO, serviceUnit: "Apt 4B" })).toContain("Apt 4B");
    expect(displayAddress({ ...CONDO, serviceUnit: "Apt 4B" })).not.toContain(
      "Unit Apt"
    );
  });

  it("reads the same as routing when there is no unit", () => {
    const noUnit = { ...CONDO, serviceUnit: "" };
    expect(displayAddress(noUnit)).toBe(routingAddress(noUnit));
  });
});

describe("qualifyUnit", () => {
  it("labels a bare number", () => {
    expect(qualifyUnit("289")).toBe("Unit 289");
  });

  it("leaves qualified forms alone", () => {
    for (const u of ["Apt 4B", "Suite 200", "#12", "Building C", "Floor 3"]) {
      expect(qualifyUnit(u)).toBe(u);
    }
  });
});

describe("streetLooksLikeItHidesAUnit — reports suspects, never rewrites", () => {
  it("flags the exact shape that caused the outage", () => {
    expect(
      streetLooksLikeItHidesAUnit("290 Eliot Street, Unit 289 America blvd")
    ).toBe(true);
  });

  it("flags a unit keyword after the street", () => {
    expect(streetLooksLikeItHidesAUnit("12 Oak Rd, Apt 3")).toBe(true);
    expect(streetLooksLikeItHidesAUnit("12 Oak Rd #3")).toBe(true);
  });

  it("flags two streets jammed into one line", () => {
    expect(streetLooksLikeItHidesAUnit("290 Eliot Street 289 America blvd")).toBe(
      true
    );
  });

  it("does NOT flag an ordinary address", () => {
    expect(streetLooksLikeItHidesAUnit("81 Greenwich Rd")).toBe(false);
    expect(streetLooksLikeItHidesAUnit("9 John Hancock Dr")).toBe(false);
    expect(streetLooksLikeItHidesAUnit("")).toBe(false);
  });
});
