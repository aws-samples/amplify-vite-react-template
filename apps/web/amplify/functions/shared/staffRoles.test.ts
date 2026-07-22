import { describe, expect, it } from "vitest";
import {
  assertOwnerRemains,
  assertReasonCode,
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
  it("keeps only staff roles in canonical order (legacy OFFICE dropped)", () => {
    expect(staffRolesIn(["TECH", "CUSTOMER", "OWNER", "OFFICE"])).toEqual([
      "OWNER",
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
    expect(() => assertValidRoleSet(["SUPERUSER"])).toThrow(/OWNER, TECH/);
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

describe("assertReasonCode (GL-14)", () => {
  it("accepts a valid code for the action and returns it normalized", () => {
    expect(assertReasonCode("CHANGE_ROLES", "promotion", null)).toBe("PROMOTION");
    expect(assertReasonCode("OFFBOARD", "ROLE_ENDED", null)).toBe("ROLE_ENDED");
  });

  it("refuses a blank reason", () => {
    expect(() => assertReasonCode("CHANGE_ROLES", "", null)).toThrow(
      /reason is required/i
    );
    expect(() => assertReasonCode("OFFBOARD", null, null)).toThrow(
      /reason is required/i
    );
  });

  it("refuses a code that isn't on the action's list", () => {
    // A valid offboard reason is not a valid role-change reason.
    expect(() => assertReasonCode("CHANGE_ROLES", "SECURITY", null)).toThrow(
      /isn't a valid reason/i
    );
    expect(() => assertReasonCode("OFFBOARD", "PROMOTION", null)).toThrow(
      /isn't a valid reason/i
    );
  });

  it("requires a note when the reason is OTHER", () => {
    expect(() => assertReasonCode("CHANGE_ROLES", "OTHER", "  ")).toThrow(
      /needs a short written note/i
    );
    expect(assertReasonCode("CHANGE_ROLES", "OTHER", "special case")).toBe("OTHER");
  });
});
