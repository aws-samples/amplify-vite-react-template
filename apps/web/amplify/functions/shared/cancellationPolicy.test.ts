import { describe, expect, it } from "vitest";
import {
  addDays,
  computeVisitCancellationPolicy,
  easternEpochMs,
  windowStartHour,
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
    expect(p.explanation).toMatch(/isn't refunded/i);
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

describe("GL-07 R6 — the hour-exact 72-hour rule", () => {
  // Visit on the 10th with an 8am start (Eastern). 72 hours before is the
  // 7th, 8:00 AM ET. Strictly earlier refunds; at/after does not.
  const visit = "2026-08-10";
  const eightAmEt = Date.parse("2026-08-07T08:00:00-04:00"); // EDT

  it("refunds strictly more than 72 hours before the scheduled start", () => {
    const p = computeVisitCancellationPolicy({
      scheduledDate: visit,
      amountPaidCents: 15000,
      today: "2026-08-07",
      nowMs: eightAmEt - 30 * 60_000, // 7:30 AM on the 7th — 72.5h out
      timeWindow: "8-10am",
    });
    expect(p.withinFreeWindow).toBe(true);
    expect(p.refundableCents).toBe(15000);
  });

  it("refuses at exactly 72 hours or less — where the whole-day rule would have flipped a day earlier", () => {
    const p = computeVisitCancellationPolicy({
      scheduledDate: visit,
      amountPaidCents: 15000,
      today: "2026-08-07",
      nowMs: eightAmEt + 5 * 60_000, // 8:05 AM on the 7th — inside 72h
      timeWindow: "8-10am",
    });
    expect(p.withinFreeWindow).toBe(false);
    expect(p.refundableCents).toBe(0);
    expect(p.explanation).toMatch(/72 hours/);
    expect(p.explanation).toMatch(/no override and no account credit/i);
  });

  it("uses the time window's start hour — an afternoon visit extends the free window", () => {
    const onePmEt = Date.parse("2026-08-07T13:00:00-04:00");
    const p = computeVisitCancellationPolicy({
      scheduledDate: visit,
      amountPaidCents: 15000,
      today: "2026-08-07",
      nowMs: onePmEt - 10 * 60_000, // 12:50 PM on the 7th — >72h before a 1 PM start
      timeWindow: "1-3pm",
    });
    expect(p.withinFreeWindow).toBe(true);
  });

  it("windowStartHour parses common window formats and defaults to the 8 AM open", () => {
    expect(windowStartHour("8-10am")).toBe(8);
    expect(windowStartHour("10am-12pm")).toBe(10);
    expect(windowStartHour("1-3pm")).toBe(13);
    expect(windowStartHour("1:30 PM")).toBe(13);
    expect(windowStartHour(null)).toBe(8);
    expect(windowStartHour("afternoon")).toBe(8);
  });

  it("without a judging instant the legacy whole-day comparison still applies", () => {
    const p = computeVisitCancellationPolicy({
      scheduledDate: visit,
      amountPaidCents: 15000,
      today: "2026-08-07",
    });
    expect(p.withinFreeWindow).toBe(false); // 3 days out, not MORE than 3
  });

  it("crosses a weekend hour-exactly where the whole-day rule cannot", () => {
    // Visit Monday 2026-07-20, 8 AM ET. 72h before is Friday 8 AM ET. The
    // whole-day rule sees Mon − Fri = 3 days and refuses ALL day Friday; the
    // hour-exact rule refunds at 73h (Fri 7 AM) and refuses at 71h (Fri 9 AM).
    const mondayVisit = "2026-07-20";
    const at = (iso: string) => ({
      scheduledDate: mondayVisit,
      amountPaidCents: 15000,
      today: "2026-07-17",
      nowMs: Date.parse(iso),
      timeWindow: "8-10am",
    });
    expect(
      computeVisitCancellationPolicy(at("2026-07-17T07:00:00-04:00")).withinFreeWindow
    ).toBe(true); // 73h out
    expect(
      computeVisitCancellationPolicy(at("2026-07-17T09:00:00-04:00")).withinFreeWindow
    ).toBe(false); // 71h out
    // The whole-day rule would refuse the 73h case too — proof they differ.
    expect(
      computeVisitCancellationPolicy({
        scheduledDate: mondayVisit,
        amountPaidCents: 15000,
        today: "2026-07-17",
      }).withinFreeWindow
    ).toBe(false);
  });

  it("easternEpochMs is DST-correct (EDT in summer, EST in winter)", () => {
    // Midnight Eastern is 04:00Z in July (EDT, −04:00)…
    expect(easternEpochMs("2026-07-20", 0)).toBe(
      Date.parse("2026-07-20T00:00:00-04:00")
    );
    // …and 05:00Z in January (EST, −05:00).
    expect(easternEpochMs("2026-01-20", 8)).toBe(
      Date.parse("2026-01-20T08:00:00-05:00")
    );
  });
});

