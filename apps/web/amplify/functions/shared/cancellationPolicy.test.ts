import { describe, expect, it } from "vitest";
import {
  addDays,
  computeVisitCancellationPolicy,
} from "./cancellationPolicy";

/**
 * GL-07 — the pure visit-cancellation policy. The office never types an amount;
 * this is the single source the preview and the refund both read, so it is worth
 * exercising at every boundary.
 */

const TODAY = "2026-07-18";

describe("computeVisitCancellationPolicy", () => {
  it("refunds in full more than the free-cancel window before the visit", () => {
    const p = computeVisitCancellationPolicy({
      scheduledDate: "2026-07-30", // 12 days out
      amountPaidCents: 15000,
      today: TODAY,
    });
    expect(p.withinFreeWindow).toBe(true);
    expect(p.refundableCents).toBe(15000);
    expect(p.feeCents).toBe(0);
    // deadline is 3 days before the visit.
    expect(p.policyDeadline).toBe("2026-07-27");
  });

  it("retains the whole amount as a late fee inside the window", () => {
    const p = computeVisitCancellationPolicy({
      scheduledDate: "2026-07-20", // 2 days out
      amountPaidCents: 15000,
      today: TODAY,
    });
    expect(p.withinFreeWindow).toBe(false);
    expect(p.refundableCents).toBe(0);
    expect(p.feeCents).toBe(15000);
    expect(p.explanation).toMatch(/late-cancellation fee/i);
  });

  it("treats exactly the cutoff day as a late cancel (more-than, not at-least)", () => {
    // CANCEL_FULL_REFUND_DAYS = 3; a visit exactly 3 days out is NOT refundable.
    const p = computeVisitCancellationPolicy({
      scheduledDate: addDays(TODAY, 3),
      amountPaidCents: 10000,
      today: TODAY,
    });
    expect(p.daysUntilVisit).toBe(3);
    expect(p.withinFreeWindow).toBe(false);
    expect(p.refundableCents).toBe(0);
  });

  it("is refundable at one day past the cutoff (4 days out)", () => {
    const p = computeVisitCancellationPolicy({
      scheduledDate: addDays(TODAY, 4),
      amountPaidCents: 10000,
      today: TODAY,
    });
    expect(p.withinFreeWindow).toBe(true);
    expect(p.refundableCents).toBe(10000);
  });

  it("an unscheduled paid visit is fully refundable with no deadline", () => {
    const p = computeVisitCancellationPolicy({
      scheduledDate: null,
      amountPaidCents: 8000,
      today: TODAY,
    });
    expect(p.policyDeadline).toBeNull();
    expect(p.withinFreeWindow).toBe(true);
    expect(p.refundableCents).toBe(8000);
    expect(p.daysUntilVisit).toBeNull();
  });

  it("an unpaid visit has nothing to refund either way", () => {
    const inside = computeVisitCancellationPolicy({
      scheduledDate: "2026-07-19",
      amountPaidCents: 0,
      today: TODAY,
    });
    expect(inside.refundableCents).toBe(0);
    expect(inside.feeCents).toBe(0);
    expect(inside.explanation).toMatch(/nothing has been paid/i);
  });
});
