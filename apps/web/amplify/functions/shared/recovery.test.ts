import { describe, expect, it } from "vitest";
import {
  agingBucket,
  daysPastDue,
  dueDateForTerms,
  DUNNING_RETRY_OFFSET_DAYS,
  MAX_DUNNING_ATTEMPTS,
  nextDunningAtIso,
  normalizeTerms,
} from "./recovery";

/**
 * The pure spine of the recovery lifecycle. These functions are mirrored on the
 * frontend, so the boundaries have to be exact — an off-by-one on day 30 vs 31
 * puts money in the wrong aging bucket on one side and not the other.
 */

describe("dueDateForTerms", () => {
  it("DUE_ON_RECEIPT is the issue date", () => {
    expect(dueDateForTerms("DUE_ON_RECEIPT", "2026-07-17T15:00:00Z")).toBe(
      "2026-07-17"
    );
  });
  it("NET_15 is +15 days, NET_30 is +30", () => {
    expect(dueDateForTerms("NET_15", "2026-07-17T00:00:00Z")).toBe("2026-08-01");
    expect(dueDateForTerms("NET_30", "2026-07-17T00:00:00Z")).toBe("2026-08-16");
  });
  it("an unknown term falls back to due-on-receipt", () => {
    expect(dueDateForTerms("WHENEVER", "2026-07-17T00:00:00Z")).toBe(
      "2026-07-17"
    );
  });
});

describe("normalizeTerms", () => {
  it("keeps known terms and defaults the rest", () => {
    expect(normalizeTerms("net_15")).toBe("NET_15");
    expect(normalizeTerms("NET_30")).toBe("NET_30");
    expect(normalizeTerms("")).toBe("DUE_ON_RECEIPT");
    expect(normalizeTerms(null)).toBe("DUE_ON_RECEIPT");
  });
});

describe("daysPastDue + agingBucket boundaries", () => {
  const now = new Date("2026-07-17T12:00:00Z");
  const at = (dueDate: string) => daysPastDue({ dueDate, now });

  it("not yet due is CURRENT (zero or negative days)", () => {
    expect(at("2026-07-20")).toBe(-3);
    expect(agingBucket(at("2026-07-20"))).toBe("CURRENT");
    expect(agingBucket(at("2026-07-17"))).toBe("CURRENT"); // due today
  });

  it("day 1 through day 30 is the 1-30 bucket", () => {
    expect(agingBucket(1)).toBe("D1_30");
    expect(agingBucket(30)).toBe("D1_30");
  });

  it("day 31 crosses into 31-60; day 60 is still 31-60", () => {
    expect(agingBucket(31)).toBe("D31_60");
    expect(agingBucket(60)).toBe("D31_60");
  });

  it("day 61 crosses into 61-90; day 90 is still 61-90", () => {
    expect(agingBucket(61)).toBe("D61_90");
    expect(agingBucket(90)).toBe("D61_90");
  });

  it("day 91 is 90+", () => {
    expect(agingBucket(91)).toBe("D90_PLUS");
    expect(agingBucket(365)).toBe("D90_PLUS");
  });

  it("aging falls back to issuedAt when there is no dueDate", () => {
    const days = daysPastDue({ issuedAt: "2026-06-17T00:00:00Z", now });
    expect(days).toBe(30);
    expect(agingBucket(days)).toBe("D1_30");
  });

  it("dueDate wins over issuedAt when both are present", () => {
    const days = daysPastDue({
      dueDate: "2026-07-31",
      issuedAt: "2026-01-01T00:00:00Z",
      now,
    });
    expect(days).toBeLessThan(0); // due in the future, not overdue
    expect(agingBucket(days)).toBe("CURRENT");
  });
});

describe("dunning cadence", () => {
  it("retries at +3, +5, +7 days then exhausts", () => {
    expect(DUNNING_RETRY_OFFSET_DAYS).toEqual([3, 5, 7]);
    expect(MAX_DUNNING_ATTEMPTS).toBe(3);
    const from = "2026-07-17T00:00:00Z";
    expect(nextDunningAtIso(0, from)!.slice(0, 10)).toBe("2026-07-20"); // +3
    expect(nextDunningAtIso(1, from)!.slice(0, 10)).toBe("2026-07-22"); // +5
    expect(nextDunningAtIso(2, from)!.slice(0, 10)).toBe("2026-07-24"); // +7
  });

  it("returns null once the cadence is exhausted — the suspend signal", () => {
    expect(nextDunningAtIso(3, "2026-07-17T00:00:00Z")).toBeNull();
    expect(nextDunningAtIso(4, "2026-07-17T00:00:00Z")).toBeNull();
  });
});
