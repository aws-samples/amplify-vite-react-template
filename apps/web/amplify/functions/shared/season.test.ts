import { describe, expect, it } from "vitest";
import {
  firstWeekdayOf,
  isServiceMonth,
  monthKeyAfter,
  monthKeyOf,
  nextServiceMonth,
  serviceMonthsOf,
} from "./season";

/**
 * GL-17 — the locked seasonal rule: one treatment per month April–October,
 * none November–March, October rolls to next April, and the month a date
 * belongs to is an America/New_York fact.
 */

const SEASONAL = { seasonal: true };

describe("the seasonal calendar (GL-17)", () => {
  it("defaults a seasonal plan to April–October", () => {
    expect(serviceMonthsOf(SEASONAL)).toEqual([4, 5, 6, 7, 8, 9, 10]);
    expect(serviceMonthsOf({ seasonal: false })).toEqual([]);
  });

  it("knows which months are in season", () => {
    expect(isServiceMonth(SEASONAL, "2026-04")).toBe(true);
    expect(isServiceMonth(SEASONAL, "2026-10")).toBe(true);
    expect(isServiceMonth(SEASONAL, "2026-11")).toBe(false);
    expect(isServiceMonth(SEASONAL, "2027-03")).toBe(false);
    // Non-seasonal plans serve every month.
    expect(isServiceMonth({ seasonal: false }, "2026-12")).toBe(true);
  });

  it("rolls October to NEXT April — never a November date", () => {
    expect(nextServiceMonth(SEASONAL, "2026-11")).toBe("2027-04");
    expect(nextServiceMonth(SEASONAL, monthKeyAfter("2026-10"))).toBe("2027-04");
    // Mid-season, the next month is simply the next month.
    expect(nextServiceMonth(SEASONAL, "2026-07")).toBe("2026-07");
    expect(nextServiceMonth(SEASONAL, monthKeyAfter("2026-07"))).toBe("2026-08");
    // Deep off-season lands on April too.
    expect(nextServiceMonth(SEASONAL, "2027-01")).toBe("2027-04");
  });

  it("assigns a date's month in Eastern time, not UTC", () => {
    // 2026-05-01T02:00Z is still April 30 in New York.
    expect(monthKeyOf("2026-05-01T02:00:00.000Z")).toBe("2026-04");
    expect(monthKeyOf("2026-05-01T12:00:00.000Z")).toBe("2026-05");
  });

  it("targets the first weekday of a month", () => {
    // 2026-08-01 is a Saturday → Monday the 3rd.
    expect(firstWeekdayOf("2026-08")).toBe("2026-08-03");
    // 2027-04-01 is a Thursday.
    expect(firstWeekdayOf("2027-04")).toBe("2027-04-01");
  });
});
