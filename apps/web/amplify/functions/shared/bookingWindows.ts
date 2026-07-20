/**
 * The two customer-facing booking windows and their human labels — the SINGLE
 * source shared by finalize (which stamps job.timeWindow) and the public cancel
 * path (which must judge the hour-exact 72-hour line from the SAME start hour).
 *
 * The label form matters: computeVisitCancellationPolicy → windowStartHour reads
 * the start hour out of this string ("morning (8am–12pm)" → 8, "afternoon
 * (12pm–5pm)" → 12). If the public cancel judged from the raw "AFTERNOON" enum
 * instead, windowStartHour would find no hour and default to the 8am open —
 * putting the office and public refund decisions 4 hours apart for an afternoon
 * visit. GL-08 requires every path to agree, so every path maps through here.
 */
export const WINDOW_LABEL: Record<string, string> = {
  MORNING: "morning (8am–12pm)",
  AFTERNOON: "afternoon (12pm–5pm)",
};

/** The stored timeWindow label for a raw booking-window value — the mapped
 *  label for a known window, else the value lower-cased (an already-labelled or
 *  unknown window falls back to the 8am open, same as the jobs would). */
export function windowLabelFor(window: string | null | undefined): string {
  const key = window ?? "";
  return WINDOW_LABEL[key] ?? key.toLowerCase();
}
