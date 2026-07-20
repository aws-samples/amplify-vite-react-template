import { describe, expect, it } from "vitest";
import {
  attemptVsReached,
  callbackStats,
  firstResponseStats,
  qualificationFunnel,
} from "./commandMetrics";

/**
 * GL-19 — the lifecycle-derived leadership measures. Everything derives from
 * durable timestamps/facts with named windows and denominators — never from
 * coarse stage totals or open work-item counts.
 */

const SINCE = Date.parse("2026-07-01T00:00:00.000Z");
const lead = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  createdAt: "2026-07-10T12:00:00.000Z",
  ...over,
});

describe("firstResponseStats — true first-response time from activity timestamps", () => {
  it("measures creation → FIRST recorded activity, with median, worst, and not-yet counts", () => {
    const leads = [
      lead("a"), // responded in 30 min
      lead("b"), // responded in 90 min
      lead("c"), // never responded
      lead("old", { createdAt: "2026-06-01T00:00:00.000Z" }), // outside window
    ];
    const activities = [
      { customerId: "a", occurredAt: "2026-07-10T12:30:00.000Z" },
      { customerId: "a", occurredAt: "2026-07-11T09:00:00.000Z" }, // later — ignored
      { customerId: "b", occurredAt: "2026-07-10T13:30:00.000Z" },
      { customerId: "old", occurredAt: "2026-06-01T01:00:00.000Z" },
    ];

    const s = firstResponseStats(leads, activities, SINCE);

    expect(s.leadsCreated).toBe(3); // window denominator excludes "old"
    expect(s.responded).toBe(2);
    expect(s.notYetResponded).toBe(1);
    expect(s.medianMinutes).toBe(60); // median of 30 and 90
    expect(s.worstMinutes).toBe(90);
  });

  it("no leads in the window → null medians, zero denominators (never NaN)", () => {
    const s = firstResponseStats([], [], SINCE);
    expect(s).toEqual({
      leadsCreated: 0,
      responded: 0,
      medianMinutes: null,
      worstMinutes: null,
      notYetResponded: 0,
    });
  });
});

describe("attemptVsReached — attempted is NOT reached", () => {
  it("rates reached over ATTEMPTED (the honest denominator)", () => {
    const leads = [
      lead("a", { lastAttemptedAt: "x", lastReachedAt: "y" }),
      lead("b", { lastAttemptedAt: "x" }),
      lead("c", { lastAttemptedAt: "x" }),
      lead("d"), // never attempted — not in the denominator
    ];
    const s = attemptVsReached(leads, SINCE);
    expect(s).toEqual({ attempted: 3, reached: 1, reachedPct: 33 });
  });

  it("nothing attempted → null rate, not 0% or NaN", () => {
    expect(attemptVsReached([lead("a")], SINCE).reachedPct).toBeNull();
  });
});

describe("qualificationFunnel — fact fields, not stage totals", () => {
  it("counts each funnel step from its durable fact", () => {
    const leads = [
      lead("a", {
        lastAttemptedAt: "x",
        lastReachedAt: "y",
        qualificationStatus: "QUALIFIED",
        bookingLinkDeliveredAt: "z",
        convertedAt: "w",
      }),
      lead("b", { lastAttemptedAt: "x", qualificationStatus: "UNQUALIFIED" }),
      lead("c", { lostReason: "price" }),
    ];
    expect(qualificationFunnel(leads, SINCE)).toEqual({
      created: 3,
      attempted: 2,
      reached: 1,
      qualified: 1,
      unqualified: 1,
      bookingSent: 1,
      won: 1,
      lost: 1,
    });
  });
});

describe("callbackStats — GL-10 lifecycle rows over completed visits", () => {
  it("rates callbacks over completed visits and repeats over callback customers", () => {
    const jobs = [
      { id: "j1", status: "COMPLETED", completedAt: "2026-07-10T00:00:00Z" },
      { id: "j2", status: "COMPLETED", completedAt: "2026-07-11T00:00:00Z" },
      { id: "j3", status: "COMPLETED", completedAt: "2026-07-12T00:00:00Z" },
      { id: "j4", status: "COMPLETED", completedAt: "2026-06-01T00:00:00Z" }, // outside
      { id: "j5", status: "SCHEDULED", scheduledDate: "2026-07-12" }, // not completed
    ];
    const callbacks = [
      { id: "cb-j1", customerId: "c1", createdAt: "2026-07-11T00:00:00Z" },
      { id: "cb-j2", customerId: "c1", createdAt: "2026-07-12T00:00:00Z" },
      { id: "cb-j3", customerId: "c2", createdAt: "2026-07-13T00:00:00Z" },
      { id: "cb-old", customerId: "c3", createdAt: "2026-06-13T00:00:00Z" }, // outside
    ];

    const s = callbackStats(callbacks, jobs, SINCE);

    expect(s.completedVisits).toBe(3);
    expect(s.callbacksRequested).toBe(3);
    expect(s.callbackPct).toBe(100);
    expect(s.callbackCustomers).toBe(2);
    expect(s.repeatCallbackCustomers).toBe(1); // c1 twice
    expect(s.repeatPct).toBe(50);
  });

  it("no completed visits → null callback rate, not a divide-by-zero", () => {
    const s = callbackStats(
      [{ id: "cb", customerId: "c1", createdAt: "2026-07-11T00:00:00Z" }],
      [],
      SINCE
    );
    expect(s.callbackPct).toBeNull();
    expect(s.callbacksRequested).toBe(1);
  });
});
