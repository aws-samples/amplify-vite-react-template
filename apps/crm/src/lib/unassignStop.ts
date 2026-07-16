/**
 * Whether the Schedule board may pull a stop off a route.
 *
 * Job status is what billing, the recurring engine, and the pesticide record
 * all key off, and the board's ✕ used to flip any stop back to UNSCHEDULED —
 * including COMPLETED (finalized report, billing already started) and
 * IN_PROGRESS (a tech standing on site). A completed stop is history and is
 * never unassignable; an in-progress stop is a phone call, not a button.
 *
 * Returns null when the move is plain scheduling (SCHEDULED/UNSCHEDULED),
 * otherwise the words the board shows in place of the ✕.
 */
export function unassignBlockedNote(
  status: string | null | undefined,
  techName: string
): string | null {
  if (status === "COMPLETED") return "completed — stays on the record";
  if (status === "IN_PROGRESS") return `on site — call ${techName} to pull this stop`;
  return null;
}

/**
 * Same rule in the other direction: Assign used to set any routeless job back
 * to SCHEDULED — including a COMPLETED one sitting in the pool, where a single
 * unconfirmed click rewrote a status that billing had already acted on.
 * NO_ACCESS is deliberately not blocked here: re-booking a no-access visit is
 * legitimate office work (it gets a confirm at the call site instead).
 */
export function assignBlockedNote(
  status: string | null | undefined
): string | null {
  if (status === "COMPLETED") return "completed — stays on the record";
  if (status === "IN_PROGRESS") return "on site — already being worked";
  return null;
}
