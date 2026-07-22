import { describe, expect, it } from "vitest";
import {
  groupChangeSummary,
  isTechnicalLifecycleReason,
  lifecycleActionTitle,
  lifecycleReasonSummary,
} from "./customerPresentation";

describe("customer lifecycle presentation", () => {
  it("does not mislabel a group change as a reactivation", () => {
    expect(lifecycleActionTitle("GROUP_CHANGE")).toBe("Customer group changed");
    expect(lifecycleActionTitle("DEACTIVATE")).toBe("Customer deactivated");
    expect(lifecycleActionTitle("REACTIVATE")).toBe("Customer reactivated");
  });

  it("translates internal group ids into business names", () => {
    expect(
      groupChangeSummary("group: none → group-1", [
        { id: "group-1", name: "Maple Ridge" },
      ]),
    ).toBe("Changed from no group to Maple Ridge");
  });

  it("turns controlled reason codes into readable text without losing notes", () => {
    expect(lifecycleReasonSummary("CUSTOMER_REQUEST — Moving away")).toBe(
      "Customer request — Moving away",
    );
    expect(lifecycleReasonSummary("New property manager")).toBe(
      "New property manager",
    );
  });

  it("does not expose a stale internal group id", () => {
    expect(groupChangeSummary("group: old-drill-id → none", [])).toBe(
      "Changed from an archived group to no group",
    );
  });

  it("recognizes drill labels that belong behind technical details", () => {
    expect(
      isTechnicalLifecycleReason("GL-11 drill complete: reverting to no group"),
    ).toBe(true);
    expect(isTechnicalLifecycleReason("New property manager")).toBe(false);
  });
});
