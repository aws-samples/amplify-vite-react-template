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

const call = (
  customerId: string,
  occurredAt: string,
  over: Record<string, unknown> = {}
) => ({
  customerId,
  channel: "CALL",
  outcome: "NO_ANSWER",
  occurredAt,
  ...over,
});

describe("firstResponseStats — first GENUINE attempted contact, never intake noise", () => {
  it("measures creation → first real communication, with median, worst, and not-yet counts", () => {
    const leads = [
      lead("a"), // called in 30 min
      lead("b"), // emailed in 90 min
      lead("c"), // never contacted
      lead("old", { createdAt: "2026-06-01T00:00:00.000Z" }), // outside window
    ];
    const activities = [
      call("a", "2026-07-10T12:30:00.000Z"),
      call("a", "2026-07-11T09:00:00.000Z"), // later — ignored
      call("b", "2026-07-10T13:30:00.000Z", { channel: "EMAIL", outcome: "SENT" }),
      call("old", "2026-06-01T01:00:00.000Z"),
    ];

    const s = firstResponseStats(leads, activities, SINCE);

    expect(s.leadsCreated).toBe(3); // window denominator excludes "old"
    expect(s.responded).toBe(2);
    expect(s.notYetResponded).toBe(1);
    expect(s.medianMinutes).toBe(60); // median of 30 and 90
    expect(s.worstMinutes).toBe(90);
  });

  it("ADVERSARIAL: intake NOTE at creation + assignment NOTE do NOT answer the lead — the later call does", () => {
    const leads = [lead("a")]; // created 12:00
    const activities = [
      // Safe lead intake writes its own LIFECYCLE row the instant the lead
      // exists — this must never read as an answered lead.
      call("a", "2026-07-10T12:00:00.000Z", { channel: "LIFECYCLE", outcome: "NOTE" }),
      // An assignment note ten minutes later is also administrative.
      call("a", "2026-07-10T12:10:00.000Z", { channel: "LIFECYCLE", outcome: "NOTE" }),
      // A NOTE outcome on a real channel is still not an attempt.
      call("a", "2026-07-10T12:20:00.000Z", { channel: "NOTE", outcome: "NOTE" }),
      // The FIRST genuine attempt: a call three hours in.
      call("a", "2026-07-10T15:00:00.000Z"),
    ];

    const s = firstResponseStats(leads, activities, SINCE);

    expect(s.responded).toBe(1);
    expect(s.medianMinutes).toBe(180); // the CALL, not the intake note
  });

  it("an activity recorded BEFORE creation is ignored — never a zero-minute response", () => {
    const leads = [lead("a")]; // created 12:00
    const activities = [
      call("a", "2026-07-10T11:00:00.000Z"), // pre-creation import artifact
    ];

    const s = firstResponseStats(leads, activities, SINCE);

    expect(s.responded).toBe(0);
    expect(s.notYetResponded).toBe(1);
    expect(s.medianMinutes).toBeNull();
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

describe("callbackStats — cohort-tied via originalJobId", () => {
  const jobs = [
    { id: "j1", customerId: "c1", status: "COMPLETED", completedAt: "2026-07-10T00:00:00Z" },
    { id: "j2", customerId: "c1", status: "COMPLETED", completedAt: "2026-07-11T00:00:00Z" },
    { id: "j3", customerId: "c2", status: "COMPLETED", completedAt: "2026-07-12T00:00:00Z" },
    { id: "j-old", customerId: "c3", status: "COMPLETED", completedAt: "2026-06-01T00:00:00Z" }, // outside cohort
    { id: "j-open", customerId: "c2", status: "SCHEDULED", scheduledDate: "2026-07-12" }, // not completed
  ];

  it("counts only callbacks LINKED to cohort visits; repeats need multiple cohort appointments", () => {
    const callbacks = [
      { id: "cb-j1", customerId: "c1", originalJobId: "j1", createdAt: "2026-07-11T00:00:00Z" },
      { id: "cb-j2", customerId: "c1", originalJobId: "j2", createdAt: "2026-07-12T00:00:00Z" },
      { id: "cb-j3", customerId: "c2", originalJobId: "j3", createdAt: "2026-08-02T00:00:00Z" }, // linked; created later — still the cohort's
      // ADVERSARIAL: a callback against an OLD visit in this window must
      // not inflate this cohort's rate.
      { id: "cb-jold", customerId: "c3", originalJobId: "j-old", createdAt: "2026-07-13T00:00:00Z" },
      // A callback with no resolvable original visit counts nowhere.
      { id: "cb-ghost", customerId: "c9", originalJobId: "j-ghost", createdAt: "2026-07-13T00:00:00Z" },
    ];

    const s = callbackStats(callbacks, jobs, SINCE);

    expect(s.completedVisits).toBe(3); // j1, j2, j3
    expect(s.callbacksOnCohort).toBe(3); // only the linked three
    expect(s.callbackPct).toBe(100); // bounded — one per appointment
    expect(s.callbackCustomers).toBe(2);
    expect(s.repeatCallbackCustomers).toBe(1); // c1: two cohort appointments
    expect(s.repeatPct).toBe(50);
  });

  it("COHORT BOUNDARY: many unrelated callbacks in the window cannot exceed 100%", () => {
    const callbacks = [
      { id: "cb-a", customerId: "x1", originalJobId: "old-1", createdAt: "2026-07-11T00:00:00Z" },
      { id: "cb-b", customerId: "x2", originalJobId: "old-2", createdAt: "2026-07-11T00:00:00Z" },
      { id: "cb-c", customerId: "x3", originalJobId: "old-3", createdAt: "2026-07-11T00:00:00Z" },
      { id: "cb-j1", customerId: "c1", originalJobId: "j1", createdAt: "2026-07-11T00:00:00Z" },
    ];

    const s = callbackStats(callbacks, jobs, SINCE);

    expect(s.completedVisits).toBe(3);
    expect(s.callbacksOnCohort).toBe(1); // only the linked one
    expect(s.callbackPct).toBe(33);
  });

  it("no completed cohort visits → null rate, not a divide-by-zero", () => {
    const s = callbackStats(
      [{ id: "cb", customerId: "c1", originalJobId: "j9", createdAt: "2026-07-11T00:00:00Z" }],
      [],
      SINCE
    );
    expect(s.callbackPct).toBeNull();
    expect(s.callbacksOnCohort).toBe(0);
  });
});
