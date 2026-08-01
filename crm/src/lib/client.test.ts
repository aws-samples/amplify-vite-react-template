import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ./client calls generateClient() at module scope, so importing anything from
// it would blow up on an unconfigured Amplify. Stubbing generateClient rather
// than the whole ./client module keeps client.ts's real exports intact and
// makes the module-scope call harmless.
vi.mock("aws-amplify/data", () => ({
  generateClient: () => ({ models: {} }),
}));

import {
  EMAIL_RE,
  daysUntil,
  daysUntilDate,
  fmtDate,
  fmtDateTime,
  validateDateRange,
  validatePositiveInt,
  validateYear,
} from "./client";

describe("EMAIL_RE", () => {
  it("accepts ordinary addresses", () => {
    for (const ok of [
      "jake@getgim.com",
      "a.b+tag@sub.example.co.uk",
      "x@y.io",
      "UPPER@EXAMPLE.COM",
    ]) {
      expect(EMAIL_RE.test(ok)).toBe(true);
    }
  });

  it("rejects malformed addresses", () => {
    for (const bad of [
      "",
      "jake",
      "jake@",
      "@getgim.com",
      "jake@getgim",
      "jake @getgim.com",
      "jake@get gim.com",
      "two@at@example.com",
    ]) {
      expect(EMAIL_RE.test(bad)).toBe(false);
    }
  });

  it("rejects a one-character TLD — the reason {2,} beat the old regex", () => {
    expect(EMAIL_RE.test("a@b.c")).toBe(false);
    expect(EMAIL_RE.test("a@b.co")).toBe(true);
  });

  it("is not sticky or global, so repeated .test() is stateless", () => {
    expect(EMAIL_RE.flags).toBe("");
    expect(EMAIL_RE.test("jake@getgim.com")).toBe(true);
    expect(EMAIL_RE.test("jake@getgim.com")).toBe(true);
  });
});

describe("validateDateRange", () => {
  it("passes a normal ordered range", () => {
    expect(validateDateRange("2026-01-01", "2027-01-01")).toEqual([]);
  });

  it("treats equal dates as valid", () => {
    expect(validateDateRange("2026-01-01", "2026-01-01")).toEqual([]);
  });

  it("flags a reversed range", () => {
    expect(validateDateRange("2027-01-01", "2026-01-01")).toEqual([
      "Effective date can't be after the expiration date.",
    ]);
  });

  it("flags a range reversed by a single day", () => {
    expect(validateDateRange("2026-01-02", "2026-01-01")).toHaveLength(1);
    expect(validateDateRange("2026-01-01", "2026-01-02")).toEqual([]);
  });

  it("compares across year and month boundaries lexicographically", () => {
    expect(validateDateRange("2026-12-31", "2027-01-01")).toEqual([]);
    expect(validateDateRange("2027-01-01", "2026-12-31")).toHaveLength(1);
    expect(validateDateRange("2026-09-30", "2026-10-01")).toEqual([]);
  });

  it("skips when either side is missing", () => {
    expect(validateDateRange("2026-01-01", "")).toEqual([]);
    expect(validateDateRange("", "2026-01-01")).toEqual([]);
    expect(validateDateRange("2026-01-01", null)).toEqual([]);
    expect(validateDateRange(undefined, "2026-01-01")).toEqual([]);
  });

  it("skips when both sides are missing", () => {
    expect(validateDateRange("", "")).toEqual([]);
    expect(validateDateRange(null, undefined)).toEqual([]);
    expect(validateDateRange("  ", "  ")).toEqual([]);
  });

  it("reports non-ISO garbage on whichever side is malformed", () => {
    expect(validateDateRange("01/02/2026", "2026-03-01")).toEqual([
      "Effective date isn't a valid date.",
    ]);
    expect(validateDateRange("2026-03-01", "next tuesday")).toEqual([
      "expiration date isn't a valid date.",
    ]);
    expect(validateDateRange("nope", "also nope")).toEqual([
      "Effective date isn't a valid date.",
      "expiration date isn't a valid date.",
    ]);
  });

  it("reports malformed input even when the other side is absent", () => {
    expect(validateDateRange("garbage", "")).toEqual([
      "Effective date isn't a valid date.",
    ]);
  });

  it("does not also report ordering when a side is malformed", () => {
    // Lexicographically "9999-99-99" > "2026-01-01", but the shape problem is
    // the only useful message.
    expect(validateDateRange("9999-99-99", "2026-01-01")).toEqual([
      "Effective date isn't a valid date.",
    ]);
  });

  it("rejects impossible calendar days without using Date parsing", () => {
    expect(validateDateRange("2026-02-30", "2026-03-01")).toHaveLength(1);
    expect(validateDateRange("2026-13-01", "2026-12-01")).toHaveLength(1);
    expect(validateDateRange("2026-00-10", "2026-12-01")).toHaveLength(1);
    expect(validateDateRange("2026-01-00", "2026-12-01")).toHaveLength(1);
    expect(validateDateRange("2026-01-32", "2026-12-01")).toHaveLength(1);
    expect(validateDateRange("2026-1-1", "2026-12-01")).toHaveLength(1);
  });

  it("gets leap years right", () => {
    expect(validateDateRange("2024-02-29", "2024-03-01")).toEqual([]);
    expect(validateDateRange("2026-02-29", "2026-03-01")).toHaveLength(1);
    expect(validateDateRange("2000-02-29", "2000-03-01")).toEqual([]);
    expect(validateDateRange("1900-02-29", "1900-03-01")).toHaveLength(1);
  });

  it("accepts 30- and 31-day month ends", () => {
    expect(validateDateRange("2026-04-30", "2026-05-31")).toEqual([]);
    expect(validateDateRange("2026-04-31", "2026-05-31")).toHaveLength(1);
  });

  it("uses custom labels in every message", () => {
    expect(
      validateDateRange("2027-01-01", "2026-01-01", "Start date", "end date")
    ).toEqual(["Start date can't be after the end date."]);
    expect(validateDateRange("x", "y", "Start date", "end date")).toEqual([
      "Start date isn't a valid date.",
      "end date isn't a valid date.",
    ]);
  });

  it("tolerates surrounding whitespace", () => {
    expect(validateDateRange(" 2026-01-01 ", " 2026-06-01 ")).toEqual([]);
  });
});

describe("validateYear", () => {
  const THIS_YEAR = 2026;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(`${THIS_YEAR}-07-31T12:00:00`));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("accepts a plausible year", () => {
    expect(validateYear("1985", "Year built")).toEqual([]);
    expect(validateYear(1985, "Year built")).toEqual([]);
  });

  it("skips empty and absent values", () => {
    expect(validateYear("", "Year built")).toEqual([]);
    expect(validateYear(null, "Year built")).toEqual([]);
    expect(validateYear(undefined, "Year built")).toEqual([]);
    expect(validateYear("   ", "Year built")).toEqual([]);
  });

  // Default bounds: 1600..currentYear+5, matching validateAccountFields.
  it("holds the default lower bound at 1600", () => {
    expect(validateYear("1600", "Year built")).toEqual([]);
    expect(validateYear("1599", "Year built")).toEqual([
      `Year built should be between 1600 and ${THIS_YEAR + 5}.`,
    ]);
  });

  it("holds the default upper bound at currentYear + 5", () => {
    expect(validateYear(String(THIS_YEAR + 5), "Year built")).toEqual([]);
    expect(validateYear(String(THIS_YEAR + 6), "Year built")).toEqual([
      `Year built should be between 1600 and ${THIS_YEAR + 5}.`,
    ]);
  });

  // PropertyPanel's renovation years: 1600..currentYear+1.
  it("honours maxYearsAhead: 1 for renovation years", () => {
    const o = { maxYearsAhead: 1 };
    expect(validateYear(String(THIS_YEAR), "Roof updated year", o)).toEqual([]);
    expect(validateYear(String(THIS_YEAR + 1), "Roof updated year", o)).toEqual(
      []
    );
    expect(validateYear(String(THIS_YEAR + 2), "Roof updated year", o)).toEqual([
      `Roof updated year should be between 1600 and ${THIS_YEAR + 1}.`,
    ]);
    // The +5 default would have let this through — the two ranges differ.
    expect(validateYear(String(THIS_YEAR + 2), "Roof updated year")).toEqual([]);
  });

  it("honours a custom min", () => {
    expect(validateYear("1899", "Built", { min: 1900 })).toEqual([
      `Built should be between 1900 and ${THIS_YEAR + 5}.`,
    ]);
    expect(validateYear("1900", "Built", { min: 1900 })).toEqual([]);
  });

  it("rejects non-numeric and non-integer input", () => {
    expect(validateYear("abcd", "Year built")).toHaveLength(1);
    expect(validateYear("19x5", "Year built")).toHaveLength(1);
    expect(validateYear("1985.5", "Year built")).toHaveLength(1);
    expect(validateYear("-1985", "Year built")).toHaveLength(1);
  });

  it("names the field in the message", () => {
    expect(validateYear("1", "HVAC updated year")[0]).toContain(
      "HVAC updated year"
    );
  });
});

describe("validatePositiveInt", () => {
  it("accepts whole numbers as string or number", () => {
    expect(validatePositiveInt("42", "Unit count")).toEqual([]);
    expect(validatePositiveInt(42, "Unit count")).toEqual([]);
  });

  it("accepts zero by default — the bound is 'not negative'", () => {
    expect(validatePositiveInt("0", "Unit count")).toEqual([]);
    expect(validatePositiveInt(0, "Unit count")).toEqual([]);
  });

  it("skips empty and absent values, but not the number zero", () => {
    expect(validatePositiveInt("", "Unit count")).toEqual([]);
    expect(validatePositiveInt(null, "Unit count")).toEqual([]);
    expect(validatePositiveInt(undefined, "Unit count")).toEqual([]);
    expect(validatePositiveInt("  ", "Unit count")).toEqual([]);
    expect(validatePositiveInt(0, "Unit count")).toEqual([]);
  });

  it("rejects negatives", () => {
    expect(validatePositiveInt("-1", "Unit count")).toEqual([
      "Unit count should be a whole number of at least 0.",
    ]);
    expect(validatePositiveInt(-1, "Unit count")).toHaveLength(1);
  });

  it("rejects decimals", () => {
    expect(validatePositiveInt("1.5", "Unit count")).toHaveLength(1);
    expect(validatePositiveInt(1.5, "Unit count")).toHaveLength(1);
    // A decimal that lands on a whole number is still whole.
    expect(validatePositiveInt("2.0", "Unit count")).toEqual([]);
  });

  it("rejects non-numeric input", () => {
    expect(validatePositiveInt("abc", "Unit count")).toHaveLength(1);
    expect(validatePositiveInt("12abc", "Unit count")).toHaveLength(1);
    expect(validatePositiveInt(NaN, "Unit count")).toHaveLength(1);
    expect(validatePositiveInt(Infinity, "Unit count")).toHaveLength(1);
  });

  it("honours a custom min at the boundary and either side", () => {
    const o = { min: 1 };
    expect(validatePositiveInt("0", "Stories", o)).toEqual([
      "Stories should be a whole number of at least 1.",
    ]);
    expect(validatePositiveInt("1", "Stories", o)).toEqual([]);
    expect(validatePositiveInt("2", "Stories", o)).toEqual([]);
  });

  it("honours a max at the boundary and either side, and says so", () => {
    const o = { max: 100000 };
    expect(validatePositiveInt("99999", "Unit count", o)).toEqual([]);
    expect(validatePositiveInt("100000", "Unit count", o)).toEqual([]);
    expect(validatePositiveInt("100001", "Unit count", o)).toEqual([
      "Unit count should be a whole number between 0 and 100000.",
    ]);
  });

  it("names the field in the message", () => {
    expect(validatePositiveInt("-3", "Miles to coast")[0]).toContain(
      "Miles to coast"
    );
  });

  it("composes by concatenation, the validateAccountFields contract", () => {
    const problems = [
      ...validatePositiveInt("-1", "Unit count"),
      ...validateDateRange("2027-01-01", "2026-01-01"),
    ];
    expect(problems).toHaveLength(2);
    expect(problems.join(" ")).toBe(
      "Unit count should be a whole number of at least 0. " +
        "Effective date can't be after the expiration date."
    );
  });
});

// ── daysUntil / fmtDateTime ──────────────────────────────────────────
//
// Both read a clock or a zone, so every test below pins both. `TZ` is set
// through `vi.stubEnv`; Node re-reads it on the next `Date` call, so no
// re-import of ./client is needed — verified, not assumed (the LA/Kiritimati
// pair below fails outright if the stub does not take effect).
//
// System time is always given as an absolute `…Z` instant so that the
// instant itself never depends on the ambient zone — only its local
// *interpretation* does, which is exactly what is under test.

/** Pin the reader's zone and the wall clock. */
function pin(tz: string, instantUtc: string) {
  vi.stubEnv("TZ", tz);
  vi.useFakeTimers();
  vi.setSystemTime(new Date(instantUtc));
}

describe("daysUntil", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  // Noon UTC in LA (UTC−7 in July) is 05:00 local on the same day, so local
  // and UTC agree here and the arithmetic is isolated from the zone question.
  const NOON = "2026-07-31T12:00:00Z";

  it("counts forward to a future day", () => {
    pin("America/Los_Angeles", NOON);
    expect(daysUntil("2026-08-30")).toBe(30);
    expect(daysUntil("2027-07-31")).toBe(365);
  });

  it("counts backward past a lapsed day", () => {
    pin("America/Los_Angeles", NOON);
    expect(daysUntil("2026-07-01")).toBe(-30);
    expect(daysUntil("2025-07-31")).toBe(-365);
  });

  it("returns exactly 0 for today", () => {
    pin("America/Los_Angeles", NOON);
    expect(daysUntil("2026-07-31")).toBe(0);
  });

  it("returns ±1 on the one-day boundaries either side of today", () => {
    pin("America/Los_Angeles", NOON);
    expect(daysUntil("2026-08-01")).toBe(1);
    expect(daysUntil("2026-07-30")).toBe(-1);
  });

  it("crosses month and year ends without an off-by-one", () => {
    pin("America/Los_Angeles", "2026-12-31T12:00:00Z");
    expect(daysUntil("2027-01-01")).toBe(1);
    expect(daysUntil("2026-12-31")).toBe(0);
    expect(daysUntil("2026-12-30")).toBe(-1);
    // 2028 is a leap year, so Feb has 29 days in the span.
    pin("America/Los_Angeles", "2028-02-28T12:00:00Z");
    expect(daysUntil("2028-03-01")).toBe(2);
  });

  it("returns null for absent input", () => {
    pin("America/Los_Angeles", NOON);
    expect(daysUntil(null)).toBeNull();
    expect(daysUntil(undefined)).toBeNull();
    expect(daysUntil("")).toBeNull();
    expect(daysUntil("   ")).toBeNull();
  });

  it("returns null — never NaN — for a malformed day", () => {
    pin("America/Los_Angeles", NOON);
    for (const bad of [
      "garbage",
      "next tuesday",
      "07/31/2026",
      "2026-7-31",
      "2026-02-30",
      "2026-13-01",
      "2026-00-10",
      "2026-01-32",
      "2026",
    ]) {
      expect(daysUntil(bad)).toBeNull();
    }
    // The regression this fixes: `daysUntilDate` returned NaN, which slid
    // through `licenseHealth`'s `days == null` guard into a green "NaNd left".
    expect(Number.isNaN(daysUntilDate("garbage") as number)).toBe(true);
  });

  it("reads a full datetime string as its nominal day", () => {
    pin("America/Los_Angeles", NOON);
    // Everything past position 10 is ignored, so the day as written wins.
    expect(daysUntil("2026-08-05T00:00:00Z")).toBe(5);
    expect(daysUntil("2026-08-05T23:59:59Z")).toBe(5);
    expect(daysUntil("2026-08-05T12:00:00.123Z")).toBe(5);
    expect(daysUntil("2026-08-05")).toBe(5);
    expect(daysUntil("2026-08-05T00:00:00Z")).toBe(daysUntil("2026-08-05"));
  });

  it("trims surrounding whitespace", () => {
    pin("America/Los_Angeles", NOON);
    expect(daysUntil(" 2026-08-01 ")).toBe(1);
  });

  it("reads a Lambda-computed submitBy literally, not re-zoned", () => {
    // renewal-tasks/handler.ts derives submitBy on the UTC calendar:
    //   addDays("2026-09-01", -30) === "2026-08-02".
    // That result is a bare calendar day. Whatever zone the operator's
    // browser is in, it must be read as the 2nd of August.
    const submitBy = "2026-08-02";
    pin("America/Los_Angeles", NOON);
    expect(daysUntil(submitBy)).toBe(2);
    pin("Europe/Berlin", NOON);
    expect(daysUntil(submitBy)).toBe(2);
  });

  // ── The calendar ruling, asserted ──────────────────────────────────
  //
  // "Today" is the *reader's* today. A UTC-today implementation disagrees
  // with a local-today one exactly when the two calendars are on different
  // days, which is what these two cases construct.

  it("uses the reader's calendar west of UTC, where UTC is already tomorrow", () => {
    // 03:00Z on 1 Aug is 20:00 on 31 Jul in Los Angeles. The operator's
    // "today" is the 31st, so a policy expiring on the 1st has 1 day left.
    pin("America/Los_Angeles", "2026-08-01T03:00:00Z");
    expect(new Date().getDate()).toBe(31); // local calendar really is the 31st
    expect(daysUntil("2026-08-01")).toBe(1);
    expect(daysUntil("2026-07-31")).toBe(0);
    // A UTC-today build would have said 0 and 1 less, i.e. "expires today"
    // to someone whose evening it still is.
    const utcToday = new Date().toISOString().slice(0, 10);
    expect(utcToday).toBe("2026-08-01");
  });

  it("uses the reader's calendar east of UTC, where UTC is still yesterday", () => {
    // Kiritimati is UTC+14: 12:00Z on 31 Jul is already 02:00 on 1 Aug there.
    pin("Pacific/Kiritimati", "2026-07-31T12:00:00Z");
    expect(new Date().getDate()).toBe(1);
    expect(daysUntil("2026-08-01")).toBe(0);
    expect(daysUntil("2026-07-31")).toBe(-1);
    expect(new Date().toISOString().slice(0, 10)).toBe("2026-07-31");
  });

  it("is unaffected by the zone when local and UTC agree on the day", () => {
    for (const tz of ["UTC", "America/Los_Angeles", "Europe/Berlin", "Asia/Tokyo"]) {
      pin(tz, "2026-07-31T09:00:00Z");
      expect(daysUntil("2026-08-15")).toBe(15);
      vi.useRealTimers();
      vi.unstubAllEnvs();
    }
  });

  it("stays an exact integer across a DST transition", () => {
    // US DST begins 8 Mar 2026: the local span 7→9 March is 47 hours, not 48.
    pin("America/Los_Angeles", "2026-03-07T20:00:00Z"); // 12:00 local, 7 Mar
    expect(daysUntil("2026-03-09")).toBe(2);
    expect(daysUntil("2026-03-08")).toBe(1);
    for (let i = 0; i <= 20; i++) {
      const day = `2026-03-${String(i + 1).padStart(2, "0")}`;
      const n = daysUntil(day) as number;
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBe(i + 1 - 7);
    }
  });

  it("matches daysUntilDate on every well-formed input, so Wave 4 is a rename", () => {
    pin("America/Los_Angeles", NOON);
    for (const d of [
      "2026-07-31",
      "2026-08-01",
      "2026-07-30",
      "2026-12-25",
      "2025-01-01",
      "2027-02-28",
    ]) {
      expect(daysUntil(d)).toBe(daysUntilDate(d));
    }
    expect(daysUntil(null)).toBe(daysUntilDate(null));
  });
});

describe("fmtDateTime", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  // 22:04:05Z on 31 Jul is 15:04:05 local in Los Angeles (UTC−7 in July).
  const STAMP = "2026-07-31T22:04:05Z";

  it("renders a stored timestamp as date + time", () => {
    pin("America/Los_Angeles", STAMP);
    expect(fmtDateTime(STAMP)).toBe("7/31/2026, 3:04 PM");
  });

  it("drops the seconds FormsTab's bare toLocaleString prints", () => {
    pin("America/Los_Angeles", STAMP);
    // The current call site: `new Date(d.createdAt).toLocaleString("en-US")`.
    expect(new Date(STAMP).toLocaleString("en-US")).toBe("7/31/2026, 3:04:05 PM");
    expect(fmtDateTime(STAMP)).toBe("7/31/2026, 3:04 PM");
  });

  it("keeps the date half byte-identical to fmtDate", () => {
    pin("America/Los_Angeles", STAMP);
    expect(fmtDateTime(STAMP).split(",")[0]).toBe(fmtDate("2026-07-31"));
  });

  it("renders the instant in the reader's zone", () => {
    pin("America/Los_Angeles", STAMP);
    expect(fmtDateTime(STAMP)).toBe("7/31/2026, 3:04 PM");
    vi.useRealTimers();
    vi.unstubAllEnvs();
    pin("Asia/Tokyo", STAMP); // UTC+9 — already the next morning
    expect(fmtDateTime(STAMP)).toBe("8/1/2026, 7:04 AM");
  });

  it("falls back to fmtDate for a date-only string, inventing no midnight", () => {
    pin("America/Los_Angeles", STAMP);
    expect(fmtDateTime("2026-07-31")).toBe("7/31/2026");
    expect(fmtDateTime("2026-07-31")).toBe(fmtDate("2026-07-31"));
    expect(fmtDateTime("2026-07-31")).not.toContain("12:00 AM");
  });

  it("renders midnight and noon unambiguously on a real timestamp", () => {
    pin("UTC", STAMP);
    expect(fmtDateTime("2026-07-31T00:00:00Z")).toBe("7/31/2026, 12:00 AM");
    expect(fmtDateTime("2026-07-31T12:00:00Z")).toBe("7/31/2026, 12:00 PM");
    expect(fmtDateTime("2026-07-31T00:09:00Z")).toBe("7/31/2026, 12:09 AM");
  });

  it("honours an explicit offset in the string", () => {
    pin("UTC", STAMP);
    expect(fmtDateTime("2026-07-31T22:04:05+02:00")).toBe("7/31/2026, 8:04 PM");
  });

  it("returns an em dash for absent input", () => {
    pin("America/Los_Angeles", STAMP);
    expect(fmtDateTime(null)).toBe("—");
    expect(fmtDateTime(undefined)).toBe("—");
    expect(fmtDateTime("")).toBe("—");
    expect(fmtDateTime("   ")).toBe("—");
  });

  it("returns an em dash — never 'Invalid Date' — for malformed input", () => {
    pin("America/Los_Angeles", STAMP);
    for (const bad of [
      "garbage",
      "not a date at all",
      "2026-02-30", // 10 chars, but no such day
      "2026-13-01",
      "2026-07-31T99:99:99Z",
    ]) {
      expect(fmtDateTime(bad)).toBe("—");
    }
    // What the bare call site does with the same input today.
    expect(new Date("garbage").toLocaleString("en-US")).toBe("Invalid Date");
  });

  it("trims surrounding whitespace", () => {
    pin("America/Los_Angeles", STAMP);
    expect(fmtDateTime(` ${STAMP} `)).toBe("7/31/2026, 3:04 PM");
    expect(fmtDateTime(" 2026-07-31 ")).toBe("7/31/2026");
  });
});
