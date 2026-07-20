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
