/**
 * The shop's calendar day.
 *
 * BuzzKill schedules, bills, and measures compliance on America/New_York
 * calendar days — a job booked for "the 3rd" is the 3rd on the shop's wall
 * clock, not in UTC. Between roughly 7/8pm and midnight Eastern the two
 * calendars disagree, so a UTC-derived "today" reads as tomorrow for the last
 * four or five hours of every working day. That window is why this module
 * exists: one Eastern helper, used everywhere a business decision needs to
 * know what day it is.
 *
 * `todayUtc` is deliberately kept and deliberately named. Dedupe keys, day-
 * bucket ids, and export filenames only need a value that changes once a day
 * and agrees with whatever wrote the key last; re-pointing those at Eastern
 * would shift the boundary and let a once-a-day sweep fire twice (or skip) on
 * the day it deployed. Reach for `todayEastern` for anything a customer,
 * invoice, licence, or schedule can observe — and for a key, reach for
 * `todayUtc` on purpose, not by habit.
 *
 * Kept dependency-free so leaf modules (licences, compliance, callbacks) can
 * ask what day it is without inheriting a database client.
 */

const EASTERN_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Today's date (YYYY-MM-DD) on the shop's clock. */
export function todayEastern(): string {
  return EASTERN_DAY.format(new Date());
}

/**
 * The date (YYYY-MM-DD) `n` days from now on the shop's clock; `n` may be
 * negative. Offsets by whole 24-hour spans before resolving the Eastern day,
 * so a span crossing a daylight-saving change lands on the day the wall clock
 * actually reached — the behaviour the reminder sweeps have always had.
 */
export function easternPlusDays(n: number): string {
  return EASTERN_DAY.format(new Date(Date.now() + n * MS_PER_DAY));
}

/**
 * Today's UTC date (YYYY-MM-DD). For dedupe keys, day-bucket ids, and export
 * filenames only — see the note above before using it for a business rule.
 */
export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}
