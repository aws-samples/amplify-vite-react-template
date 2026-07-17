import { describe, expect, it } from "vitest";
import {
  assertProductCanBeSaved,
  assertTechnicianCanBeSaved,
  assertTechnicianCompliance,
} from "./compliance";

const validTechnician = () => ({
  name: "Marco Reyes",
  active: true,
  licenseNumber: "MA-12345",
  licenseExpiresOn: "2099-12-31",
});

const validProduct = () => ({
  name: "Suspend PolyZone",
  active: true,
  labelApproved: true,
  epaNumber: "432-1514",
  defaultRate: "1 oz / gal",
  reEntryHours: 4,
});

describe("technician compliance", () => {
  it("allows an active technician only with current license facts", () => {
    expect(() => assertTechnicianCanBeSaved(validTechnician())).not.toThrow();
  });

  it.each([
    ["licenseNumber", null, /license number/i],
    ["licenseExpiresOn", null, /expiration date/i],
  ] as const)("blocks active when %s is missing", (field, value, error) => {
    expect(() =>
      assertTechnicianCanBeSaved({ ...validTechnician(), [field]: value })
    ).toThrow(error);
  });

  it("keeps incomplete inactive records for history", () => {
    expect(() =>
      assertTechnicianCanBeSaved({ name: "Former tech", active: false })
    ).not.toThrow();
  });

  it("blocks assignment when the license expires before the service date", () => {
    expect(() =>
      assertTechnicianCompliance(
        { ...validTechnician(), licenseExpiresOn: "2026-08-01" },
        { requireActive: true, workDate: "2026-08-02" }
      )
    ).toThrow(/expired/i);
  });
});

describe("active product compliance", () => {
  it("accepts a reviewed, complete label and treats zero-hour re-entry as real", () => {
    expect(() =>
      assertProductCanBeSaved({ ...validProduct(), reEntryHours: 0 })
    ).not.toThrow();
  });

  it.each([
    ["labelApproved", false, /reviewed and approved/i],
    ["epaNumber", null, /EPA registration number/i],
    ["defaultRate", null, /application rate or dilution/i],
    ["reEntryHours", null, /re-entry rule/i],
    ["reEntryHours", -1, /re-entry rule/i],
  ] as const)("blocks activation when %s is %s", (field, value, error) => {
    expect(() =>
      assertProductCanBeSaved({ ...validProduct(), [field]: value })
    ).toThrow(error);
  });

  it("rejects a malformed EPA number", () => {
    expect(() =>
      assertProductCanBeSaved({ ...validProduct(), epaNumber: "unknown" })
    ).toThrow(/isn't a valid EPA registration number/i);
  });

  it("allows an incomplete product to remain inactive while its label is reviewed", () => {
    expect(() =>
      assertProductCanBeSaved({ name: "Draft product", active: false })
    ).not.toThrow();
  });
});
