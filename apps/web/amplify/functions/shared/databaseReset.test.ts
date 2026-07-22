import { afterEach, describe, expect, it } from "vitest";
import { assertNotProduction } from "./databaseReset";

/**
 * The wipe guard is the only authoritative barrier to total, irreversible data
 * loss, so it must fail CLOSED: allow ONLY a known non-production branch, and
 * refuse main, an unset/empty branch, a typo, or anything unrecognized.
 */
describe("assertNotProduction — fails closed", () => {
  const original = process.env.AMPLIFY_BRANCH;
  afterEach(() => {
    if (original === undefined) delete process.env.AMPLIFY_BRANCH;
    else process.env.AMPLIFY_BRANCH = original;
  });

  it("allows the wipe on the staging branch", () => {
    process.env.AMPLIFY_BRANCH = "staging";
    expect(() => assertNotProduction()).not.toThrow();
  });

  it("tolerates surrounding whitespace and case on staging", () => {
    process.env.AMPLIFY_BRANCH = "  Staging  ";
    expect(() => assertNotProduction()).not.toThrow();
  });

  it("refuses on main", () => {
    process.env.AMPLIFY_BRANCH = "main";
    expect(() => assertNotProduction()).toThrow();
  });

  it("refuses when the branch is unset — the dangerous default", () => {
    delete process.env.AMPLIFY_BRANCH;
    expect(() => assertNotProduction()).toThrow();
  });

  it("refuses on any unrecognized branch (typo, renamed prod, empty)", () => {
    for (const branch of ["", "production", "prod", "Main", "master", "release"]) {
      process.env.AMPLIFY_BRANCH = branch;
      expect(() => assertNotProduction(), branch).toThrow();
    }
  });
});
