import { describe, expect, it } from "vitest";
import {
  isValidManualReason,
  isVerifiable,
  verifiedResolution,
  WORK_POLICY,
  workPolicy,
  type WorkKind,
} from "./workPolicy";

// The kinds the system actually produces (mirrors the WorkKind union). If a
// new kind is added, this list must grow too — that is the point: a kind can
// never ship without a severity, an owner, and a controlled way to close it.
const ALL_KINDS: WorkKind[] = [
  "PRICING_RESEARCH_EXHAUSTED",
  "BALANCE_COLLECTION",
  "PAYMENT_PROCESSING_OVERDUE",
  "NO_ACCESS",
  "EMAIL_FAILURE",
  "CALLBACK_PROMISE",
  "DUPLICATE_LEAD",
  "UNSTAFFED_VISIT",
  "PAID_VISIT_CANCELLATION",
  "PORTAL_FAILURE",
  "PRICING_ESCALATION",
  "MISSING_CONTACT",
  "PAID_NOT_FINALIZED",
  "LOCATION_REVIEW",
  "STAFF_OFFBOARD",
  "STAFF_SECURITY",
  "LEAD_FOLLOWUP",
  "LIFECYCLE_RECOVERY",
  "PLAN_CANCELLATION_RECOVERY",
  "VISIT_CHANGE_RECOVERY",
  "ROUTE_MISMATCH",
  "STALE_DRAFT",
  "OFFICE_FIELD_REVIEW",
  "LICENSE_LAPSE",
  "SCOPE_MISMATCH",
  "PREP_MISSING",
  "DISPATCH_NOT_READY",
  "OBLIGATION_RECOVERY",
];

describe("GL-18 work policy registry", () => {
  it("triages every WorkKind — severity, owner, impact, and a way to close", () => {
    for (const kind of ALL_KINDS) {
      const p = WORK_POLICY[kind];
      expect(p, kind).toBeTruthy();
      expect(["CRITICAL", "HIGH", "ROUTINE"], kind).toContain(p.severity);
      expect(["OPS", "SALES", "FINANCE"], kind).toContain(p.ownerTeam);
      expect(p.customerImpact.length, kind).toBeGreaterThan(0);
      // Every kind must offer at least one controlled close: a verified action
      // (in-place or external) or, failing that, an owner override reason.
      expect(p.manualReasons.length, kind).toBeGreaterThan(0);
      expect(p.manualReasons.some((r) => r.code === "OTHER"), kind).toBe(true);
    }
  });

  it("has no kinds outside the produced set", () => {
    expect(Object.keys(WORK_POLICY).sort()).toEqual([...ALL_KINDS].sort());
  });

  it("marks a kind verifiable exactly when it has a verified or external action", () => {
    expect(isVerifiable("NO_ACCESS")).toBe(true); // external rebook
    expect(isVerifiable("MISSING_CONTACT")).toBe(true); // in-place verifier
    expect(isVerifiable("LOCATION_REVIEW")).toBe(false); // manual only
    expect(isVerifiable("nonsense")).toBe(false);
  });

  it("resolves a verified action by id and validates manual reasons", () => {
    expect(verifiedResolution("MISSING_CONTACT", "CONTACT_ADDED")?.verifier).toBe(
      "CUSTOMER_HAS_EMAIL"
    );
    expect(verifiedResolution("MISSING_CONTACT", "BOGUS")).toBeNull();
    expect(isValidManualReason("LOCATION_REVIEW", "PRESENCE_CONFIRMED")).toBe(true);
    expect(isValidManualReason("LOCATION_REVIEW", "REFUNDED")).toBe(false);
  });

  it("returns null for an unknown kind", () => {
    expect(workPolicy("SOMETHING_ELSE")).toBeNull();
  });
});
