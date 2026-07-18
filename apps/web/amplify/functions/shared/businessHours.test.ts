import { describe, expect, it } from "vitest";
import {
  contactDueAt,
  isWithinBusinessHours,
  nextBusinessOpen,
  nextContactPhrase,
} from "./businessHours";

// All fixtures are July 2026 (EDT = UTC-4). Weekdays verified:
// 2026-07-14 Tue, 07-15 Wed, 07-17 Fri, 07-18 Sat, 07-20 Mon.
const TUE_10AM = new Date("2026-07-14T14:00:00Z"); // 10:00 ET, open
const TUE_7PM = new Date("2026-07-14T23:00:00Z"); // 19:00 ET, after close
const WED_6AM = new Date("2026-07-15T10:00:00Z"); // 06:00 ET, before open
const FRI_7PM = new Date("2026-07-17T23:00:00Z"); // 19:00 ET, after close
const SAT_10AM = new Date("2026-07-18T14:00:00Z"); // 10:00 ET, weekend

describe("business hours (GL-03)", () => {
  it("is open only Mon–Fri during the window", () => {
    expect(isWithinBusinessHours(TUE_10AM)).toBe(true);
    expect(isWithinBusinessHours(TUE_7PM)).toBe(false);
    expect(isWithinBusinessHours(WED_6AM)).toBe(false);
    expect(isWithinBusinessHours(SAT_10AM)).toBe(false);
  });

  it("promises 'within the hour' only during business hours", () => {
    expect(nextContactPhrase(TUE_10AM)).toBe("within the hour");
  });

  it("gives a truthful next-window phrase after hours and on weekends", () => {
    expect(nextContactPhrase(TUE_7PM)).toBe("first thing tomorrow morning");
    expect(nextContactPhrase(WED_6AM)).toBe("as soon as we open this morning");
    expect(nextContactPhrase(FRI_7PM)).toBe("on Monday morning");
    expect(nextContactPhrase(SAT_10AM)).toBe("on Monday morning");
  });

  it("computes the next open instant, skipping the weekend", () => {
    expect(nextBusinessOpen(TUE_10AM).toISOString()).toBe("2026-07-14T14:00:00.000Z"); // already open
    expect(nextBusinessOpen(WED_6AM).toISOString()).toBe("2026-07-15T12:00:00.000Z"); // today 8am ET
    expect(nextBusinessOpen(TUE_7PM).toISOString()).toBe("2026-07-15T12:00:00.000Z"); // Wed 8am ET
    expect(nextBusinessOpen(FRI_7PM).toISOString()).toBe("2026-07-20T12:00:00.000Z"); // Mon 8am ET
    expect(nextBusinessOpen(SAT_10AM).toISOString()).toBe("2026-07-20T12:00:00.000Z"); // Mon 8am ET
  });

  it("sets the exception deadline inside a real business window", () => {
    // Open now → within the hour.
    expect(contactDueAt(TUE_10AM).toISOString()).toBe("2026-07-14T15:00:00.000Z");
    // After hours → first hour of the next window, never overnight.
    expect(contactDueAt(FRI_7PM).toISOString()).toBe("2026-07-20T13:00:00.000Z");
  });
});
