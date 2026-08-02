import { describe, expect, it } from "vitest";
import {
  SEVERITY_LABEL,
  SEVERITY_TONE,
  WORK_POLICY,
  isVerifiable,
  workPolicy,
} from "./workPolicy";

// There is now ONE policy table — the server's — and the CRM re-exports it, so
// there is no longer a mirror to drift. What this test guards instead is the
// contract the work queue depends on: that every kind the server can raise is
// renderable here. A new server kind must never reach the office as a raw enum
// name, with no severity styling, or with an empty override dropdown.
describe("GL-18 the work queue can render every kind the server raises", () => {
  it("gives every kind a title and at least one override reason", () => {
    for (const [kind, policy] of Object.entries(WORK_POLICY)) {
      expect(
        policy.label.length,
        `"${kind}" has no label — the queue would title the row with the raw enum`
      ).toBeGreaterThan(0);
      expect(
        policy.manualReasons.length,
        `"${kind}" has no override reasons — its dropdown would be empty`
      ).toBeGreaterThan(0);
      expect(policy.manualReasons.some((r) => r.code === "OTHER"), kind).toBe(true);
    }
  });

  it("styles and words every severity the table uses", () => {
    for (const [kind, policy] of Object.entries(WORK_POLICY)) {
      expect(SEVERITY_TONE[policy.severity], kind).toBeTruthy();
      expect(SEVERITY_LABEL[policy.severity], kind).toBeTruthy();
    }
  });

  it("explains who is affected for every kind", () => {
    for (const [kind, policy] of Object.entries(WORK_POLICY)) {
      expect(policy.customerImpact.length, kind).toBeGreaterThan(0);
    }
  });

  it("tolerates the nullable kind a stored row can carry", () => {
    // Work.tsx reads `item.kind` straight off the row, where it is optional.
    expect(workPolicy(null)).toBeNull();
    expect(workPolicy(undefined)).toBeNull();
    expect(workPolicy("NOT_A_KIND")).toBeNull();
    expect(isVerifiable(null)).toBe(false);
  });
});
