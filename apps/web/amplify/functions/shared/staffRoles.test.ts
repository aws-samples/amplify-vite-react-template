import { describe, expect, it } from "vitest";
import {
  assertOwnerRemains,
  assertValidRoleSet,
  isStaffRole,
  normalizeRoles,
  staffRolesIn,
} from "./staffRoles";

describe("normalizeRoles", () => {
  it("trims, upper-cases, drops blanks, and dedupes", () => {
    expect(normalizeRoles([" office ", "OFFICE", "", "tech"])).toEqual([
      "OFFICE",
      "TECH",
    ]);
  });
});

describe("staffRolesIn / isStaffRole", () => {
  it("keeps only staff roles in canonical order", () => {
    expect(staffRolesIn(["TECH", "CUSTOMER", "OWNER", "OFFICE"])).toEqual([
      "OWNER",
      "OFFICE",
      "TECH",
    ]);
  });
  it("does not treat CUSTOMER as a staff role", () => {
    expect(isStaffRole("CUSTOMER")).toBe(false);
    expect(isStaffRole("OWNER")).toBe(true);
  });
});

describe("assertValidRoleSet", () => {
  it("accepts staff roles and CUSTOMER", () => {
    expect(() => assertValidRoleSet(["OWNER", "TECH", "CUSTOMER"])).not.toThrow();
  });
  it("rejects an unknown role and names the valid ones", () => {
    expect(() => assertValidRoleSet(["OFFICE", "ADMIN"])).toThrow(/Unknown role/);
    expect(() => assertValidRoleSet(["SUPERUSER"])).toThrow(/OWNER, OFFICE, FINANCE, TECH/);
  });
});

describe("assertOwnerRemains", () => {
  it("allows dropping OWNER when another enabled owner exists", () => {
    expect(() =>
      assertOwnerRemains({
        targetLabel: "a@x.com",
        otherUsableOwners: 1,
        targetKeepsOwner: false,
      })
    ).not.toThrow();
  });

  it("allows the change when the target itself keeps OWNER", () => {
    expect(() =>
      assertOwnerRemains({
        targetLabel: "a@x.com",
        otherUsableOwners: 0,
        targetKeepsOwner: true,
      })
    ).not.toThrow();
  });

  it("blocks removing the last usable owner", () => {
    expect(() =>
      assertOwnerRemains({
        targetLabel: "solo@buzzkill.com",
        otherUsableOwners: 0,
        targetKeepsOwner: false,
      })
    ).toThrow(/last active owner/);
  });
});
