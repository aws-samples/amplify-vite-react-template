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
  // Terminal visits are immutable evidence — you rebook them, never move them.
  if (status === "NO_ACCESS") return "no access — a terminal record; rebook instead";
  if (status === "CANCELED") return "canceled — a terminal record; rebook instead";
  return null;
}

/**
 * Same rule in the other direction: Assign used to set any routeless job back
 * to SCHEDULED — including a COMPLETED one sitting in the pool, where a single
 * unconfirmed click rewrote a status that billing had already acted on.
 * Terminal visits (COMPLETED, CANCELED, NO_ACCESS) are immutable: assigning
 * one used to flip it back to SCHEDULED and clear a no-access visit's reason,
 * time, note, and door photo — destroying the record. Rebooking a no-access
 * or canceled visit creates a NEW linked visit instead (see rebookJob), so
 * they are blocked here and offered a Rebook control on the board.
 */
export function assignBlockedNote(
  status: string | null | undefined
): string | null {
  if (status === "COMPLETED") return "completed — stays on the record";
  if (status === "IN_PROGRESS") return "on site — already being worked";
  if (status === "NO_ACCESS") return "no access — rebook to create a new visit";
  if (status === "CANCELED") return "canceled — rebook to create a new visit";
  return null;
}
