import { dataClient } from "./dataClient";
import { isWeekday } from "./capacity";

/**
 * GL-10/GL-03 — shared business-day arithmetic. A "business day" is a
 * Monday–Friday that is not a tracked company closure (CompanyClosure rows
 * are keyed by date). Weekends and closures never count toward a customer
 * promise.
 */

async function isClosure(date: string): Promise<boolean> {
  try {
    const client = await dataClient();
    if (!("CompanyClosure" in client.models)) {
      throw new Error("Company closure calendar is unavailable");
    }
    const { data, errors } = await client.models.CompanyClosure.get({ id: date });
    if (errors?.length) {
      throw new Error(errors.map((error) => error.message).join("; "));
    }
    return Boolean(data);
  } catch (err) {
    // An unreadable calendar must not shorten a customer promise — treat the
    // day as NOT a business day (the promise lands later, never earlier).
    console.error("businessDays: closure read failed", date, err);
    return true;
  }
}

const EASTERN_PARTS = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function easternParts(at: Date): Record<string, string> {
  return Object.fromEntries(
    EASTERN_PARTS.formatToParts(at).map((part) => [part.type, part.value])
  );
}

/** Convert one Eastern wall-clock value to its UTC instant. The second pass
 * handles both sides of daylight-saving changes without a hard-coded offset. */
function easternWallToUtc(date: string, time: string): Date {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute, second] = time.split(":").map(Number);
  let candidate = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  for (let pass = 0; pass < 2; pass++) {
    const rendered = easternParts(candidate);
    const renderedAsUtc = Date.UTC(
      Number(rendered.year),
      Number(rendered.month) - 1,
      Number(rendered.day),
      Number(rendered.hour) % 24,
      Number(rendered.minute),
      Number(rendered.second)
    );
    const wantedAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
    candidate = new Date(candidate.getTime() + wantedAsUtc - renderedAsUtc);
  }
  return candidate;
}

/** The date `n` business days after `startDate` (YYYY-MM-DD, exclusive of
 *  the start day itself). */
export async function addBusinessDays(
  startDate: string,
  n: number
): Promise<string> {
  const d = new Date(`${startDate}T12:00:00Z`);
  let remaining = n;
  // A hard bound keeps a pathological closure calendar from looping forever.
  for (let hops = 0; remaining > 0 && hops < n * 5 + 30; hops++) {
    d.setUTCDate(d.getUTCDate() + 1);
    const iso = d.toISOString().slice(0, 10);
    if (!isWeekday(iso)) continue;
    if (await isClosure(iso)) continue;
    remaining--;
  }
  if (remaining > 0) {
    throw new Error("The shared business calendar could not produce a safe deadline.");
  }
  return d.toISOString().slice(0, 10);
}

/**
 * The common Office response deadline: one complete business day after the
 * originating instant, using the same America/New_York closure calendar as
 * scheduling and guarantee callbacks. Outside business hours, the clock starts
 * at the next business opening. Eastern wall-clock time is retained across DST.
 */
export async function oneBusinessDayDeadline(
  from: Date = new Date()
): Promise<Date> {
  const { isWithinBusinessHours, nextBusinessOpen } = await import(
    "./businessHours"
  );
  const base = isWithinBusinessHours(from) ? from : nextBusinessOpen(from);
  const parts = easternParts(base);
  const startDate = `${parts.year}-${parts.month}-${parts.day}`;
  const dueDate = await addBusinessDays(startDate, 1);
  const time = `${String(Number(parts.hour) % 24).padStart(2, "0")}:${parts.minute}:${parts.second}`;
  return easternWallToUtc(dueDate, time);
}

/** Backward-compatible name used by the GL-02 lifecycle. Both gates share the
 * exact same calendar and deadline semantics. */
export const oneBusinessDayDueAt = oneBusinessDayDeadline;
