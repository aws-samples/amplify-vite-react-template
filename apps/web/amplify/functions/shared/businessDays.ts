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
    if (!("CompanyClosure" in client.models)) return false;
    const { data } = await client.models.CompanyClosure.get({ id: date });
    return Boolean(data);
  } catch (err) {
    // An unreadable calendar must not shorten a customer promise — treat the
    // day as NOT a business day (the promise lands later, never earlier).
    console.error("businessDays: closure read failed", date, err);
    return true;
  }
}

/**
 * GL-03 — the closure-aware ONE-BUSINESS-DAY contact deadline: one business
 * day (weekends AND tracked closures excluded) after the moment the promise
 * was made, at the same Eastern wall-clock hour, with an after-hours clock
 * starting at the next open. The pure businessHours.contactDueAt stays the
 * calendar-free fallback for sync contexts; every deadline that can await
 * uses THIS.
 */
export async function oneBusinessDayDeadline(from: Date): Promise<Date> {
  const { contactDueAt, isWithinBusinessHours, nextBusinessOpen } =
    await import("./businessHours");
  const base = isWithinBusinessHours(from) ? from : nextBusinessOpen(from);
  const baseEastern = new Date(
    base.toLocaleString("en-US", { timeZone: "America/New_York" })
  );
  const baseDate = `${baseEastern.getFullYear()}-${String(baseEastern.getMonth() + 1).padStart(2, "0")}-${String(baseEastern.getDate()).padStart(2, "0")}`;
  const dueDate = await addBusinessDays(baseDate, 1);
  // Same wall-clock hour on the due date — reuse the pure helper's math by
  // computing its weekday-only answer and shifting to the closure-aware date.
  const pure = contactDueAt(from);
  const pureDate = new Date(
    pure.toLocaleString("en-US", { timeZone: "America/New_York" })
  );
  const pureDateStr = `${pureDate.getFullYear()}-${String(pureDate.getMonth() + 1).padStart(2, "0")}-${String(pureDate.getDate()).padStart(2, "0")}`;
  if (pureDateStr === dueDate) return pure; // no closure in the way
  const dayMs = 24 * 60 * 60_000;
  const shiftDays = Math.round(
    (Date.parse(`${dueDate}T12:00:00Z`) - Date.parse(`${pureDateStr}T12:00:00Z`)) / dayMs
  );
  return new Date(pure.getTime() + shiftDays * dayMs);
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
  return d.toISOString().slice(0, 10);
}
