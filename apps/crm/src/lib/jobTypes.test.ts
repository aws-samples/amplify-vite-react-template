import { describe, expect, it } from "vitest";
import {
  ADMIN_JOB_SERVICE_TYPES,
  isOfficeCompletableServiceType,
} from "./jobTypes";

/**
 * The office may complete a job without a technician's report only when its
 * serviceType is a defined administrative type. Field/pesticide work never
 * is — its completion is the tech's finalized report, the legal record.
 */
describe("isOfficeCompletableServiceType", () => {
  it("no administrative type is defined today — nothing is office-completable", () => {
    expect(ADMIN_JOB_SERVICE_TYPES).toHaveLength(0);
    expect(isOfficeCompletableServiceType("General Pest Treatment")).toBe(false);
    expect(isOfficeCompletableServiceType("Wasp nest removal")).toBe(false);
  });

  it("a defined administrative type is completable; field work never is", () => {
    const admin = ["office consultation"];
    expect(isOfficeCompletableServiceType("Office consultation", admin)).toBe(true);
    expect(isOfficeCompletableServiceType("General Pest Treatment", admin)).toBe(false);
  });

  it("matches case-insensitively and trims — the office types a free-text label", () => {
    const admin = ["office consultation"];
    expect(isOfficeCompletableServiceType("  OFFICE CONSULTATION  ", admin)).toBe(true);
  });

  it("empty or missing serviceType is never completable", () => {
    const admin = ["office consultation"];
    expect(isOfficeCompletableServiceType("", admin)).toBe(false);
    expect(isOfficeCompletableServiceType(null, admin)).toBe(false);
    expect(isOfficeCompletableServiceType(undefined, admin)).toBe(false);
  });
});
