/**
 * GL-03 — the shop's contact/callback business hours, so a promise made to a
 * lead is truthful about WHEN they will actually hear back. Mon–Fri 8am–6pm in
 * the shop's timezone; everything else is after-hours and gets a truthful
 * next-window promise, never "within the hour".
 *
 * Business policy (Head of Sales to confirm): Monday–Friday, 08:00–18:00
 * America/New_York. Change the three constants below to move the window.
 *
 * Pure and now-injectable, so the phrasing and the exception deadline are unit
 * tested without waiting for a Tuesday at 5pm.
 */

export const BUSINESS_TZ = "America/New_York";
export const OPEN_HOUR = 8; // 08:00 local
export const CLOSE_HOUR = 18; // 18:00 local

const PARTS_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: BUSINESS_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const DAY_NAME_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: BUSINESS_TZ,
  weekday: "long",
});

type EtParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
};

function etParts(at: Date): EtParts {
  const map: Record<string, string> = {};
  for (const p of PARTS_FMT.formatToParts(at)) map[p.type] = p.value;
  const year = Number(map.year);
  const month = Number(map.month);
  const day = Number(map.day);
  // Some engines render midnight as "24"; normalize so hour is 0–23.
  const hour = Number(map.hour) % 24;
  const minute = Number(map.minute);
  // Day-of-week is the same for a calendar date in any zone, so derive it from
  // the shop-local Y-M-D rather than the raw instant.
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return { year, month, day, hour, minute, weekday };
}

/** The UTC instant for a wall-clock time (year, month, day, hour) in the shop tz. */
function etWallToUtc(
  year: number,
  month: number,
  day: number,
  hour: number
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, 0, 0);
  const asStr: Record<string, string> = {};
  for (const p of PARTS_FMT.formatToParts(new Date(naive))) asStr[p.type] = p.value;
  const wallAsUtc = Date.UTC(
    Number(asStr.year),
    Number(asStr.month) - 1,
    Number(asStr.day),
    Number(asStr.hour) % 24,
    Number(asStr.minute)
  );
  const offsetMs = wallAsUtc - naive;
  return new Date(naive - offsetMs);
}

function isWeekday(weekday: number): boolean {
  return weekday >= 1 && weekday <= 5;
}

export function isWithinBusinessHours(now: Date = new Date()): boolean {
  const p = etParts(now);
  return isWeekday(p.weekday) && p.hour >= OPEN_HOUR && p.hour < CLOSE_HOUR;
}

/** The next instant the shop is open (returns `now` if it is already open). */
export function nextBusinessOpen(now: Date = new Date()): Date {
  if (isWithinBusinessHours(now)) return now;
  const p = etParts(now);
  const beforeOpenToday = isWeekday(p.weekday) && p.hour < OPEN_HOUR;
  const start = beforeOpenToday ? 0 : 1;
  for (let i = start; i < start + 8; i++) {
    const cand = etWallToUtc(p.year, p.month, p.day + i, OPEN_HOUR);
    if (isWeekday(etParts(cand).weekday)) return cand;
  }
  // Unreachable (a weekday always lands within 8 days) — a safe fallback.
  return etWallToUtc(p.year, p.month, p.day + 1, OPEN_HOUR);
}

/**
 * GL-03 — the APPROVED customer commitment is ONE BUSINESS DAY for every
 * accepted request, from every source, with no faster or slower classes.
 * The phrase names the real day so the promise is concrete without
 * promising an hour the approved rule doesn't.
 */
export function nextContactPhrase(now: Date = new Date()): string {
  const due = contactDueAt(now);
  const nowP = etParts(now);
  const dueP = etParts(due);
  const nowMid = Date.UTC(nowP.year, nowP.month - 1, nowP.day);
  const dueMid = Date.UTC(dueP.year, dueP.month - 1, dueP.day);
  const diffDays = Math.round((dueMid - nowMid) / 86_400_000);
  if (diffDays <= 0) return "within one business day";
  if (diffDays === 1) return "within one business day (by tomorrow)";
  return `within one business day (by ${DAY_NAME_FMT.format(due)})`;
}

/**
 * GL-03 — when the office must have responded: ONE BUSINESS DAY after the
 * request was accepted (an after-hours request's clock starts at the next
 * open). The deadline lands at the equivalent time on the next weekday, so
 * it never falls in the middle of the night.
 */
export function contactDueAt(now: Date = new Date()): Date {
  const base = isWithinBusinessHours(now) ? now : nextBusinessOpen(now);
  // One business day later: the next weekday at the same wall-clock time.
  const p = etParts(base);
  for (let i = 1; i <= 4; i++) {
    const cand = etWallToUtc(p.year, p.month, p.day + i, p.hour);
    if (isWeekday(etParts(cand).weekday)) return cand;
  }
  return etWallToUtc(p.year, p.month, p.day + 1, p.hour);
}
