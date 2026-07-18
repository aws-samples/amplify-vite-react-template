/**
 * GL-02 — the lead pipeline stage is DERIVED, never stored or manually set.
 *
 * A status a week-one employee has to remember to update goes stale the moment
 * they get busy. So the stage is a pure function of facts the system already
 * records: the customer's lifecycle status, whether a booking link was sent,
 * whether any real touch was logged, and the two deliberate terminal decisions
 * (Lost with a reason, Do-not-contact). Nobody advances NEW → CONTACTED by hand.
 *
 * Mirrored, minimally, in apps/crm/src/lib/leadStage.ts for the office board.
 */

import { isWithinBusinessHours, nextBusinessOpen } from "./businessHours";

export type LeadStage =
  | "NEW"
  | "CONTACTED"
  | "BOOKING_SENT"
  | "WON"
  | "LOST"
  | "DNC";

export type LeadFacts = {
  status?: string | null;
  convertedAt?: string | null;
  doNotContact?: boolean | null;
  lostReason?: string | null;
  bookingLinkSentAt?: string | null;
  lastTouchedAt?: string | null;
  nextActionAt?: string | null;
  createdAt?: string | null;
};

/** The stage, derived from facts. Order matters: terminal states win. */
export function deriveLeadStage(c: LeadFacts): LeadStage {
  if (c.status === "ACTIVE" || c.convertedAt) return "WON";
  if (c.doNotContact) return "DNC";
  if (c.lostReason) return "LOST";
  if (c.bookingLinkSentAt) return "BOOKING_SENT";
  if (c.lastTouchedAt) return "CONTACTED";
  return "NEW";
}

/** An open lead is one still being worked — not won, lost, or do-not-contact. */
export function isLeadOpen(c: LeadFacts): boolean {
  const s = deriveLeadStage(c);
  return s === "NEW" || s === "CONTACTED" || s === "BOOKING_SENT";
}

// Follow-up SLA (Head of Sales to confirm — encoded here as the single source):
// a NEW lead should get a first touch within 1 business hour; after that, a
// touch every 2 business days; a lead untouched for 14 days is unambiguously
// overdue regardless of stage.
export const FIRST_TOUCH_MINUTES = 60;
export const FOLLOWUP_BUSINESS_DAYS = 2;
export const STALE_DAYS = 14;

/** N business days after a date, keeping the time of day (weekends skipped). */
function addBusinessDays(from: Date, days: number): Date {
  const d = new Date(from.getTime());
  let added = 0;
  while (added < days) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow >= 1 && dow <= 5) added++;
  }
  return d;
}

/**
 * When the lead's next action is due. An explicit nextActionAt the office set
 * always wins; otherwise it is derived from the stage — first contact within a
 * business hour of arrival for a NEW lead, then a business-day cadence. Null for
 * a lead that is not open (won/lost/DNC need no follow-up).
 */
export function leadNextActionAt(c: LeadFacts, now: Date = new Date()): Date | null {
  if (!isLeadOpen(c)) return null;
  if (c.nextActionAt) return new Date(c.nextActionAt);
  const stage = deriveLeadStage(c);
  if (stage === "NEW") {
    const arrival = c.createdAt ? new Date(c.createdAt) : now;
    const base = isWithinBusinessHours(arrival) ? arrival : nextBusinessOpen(arrival);
    return new Date(base.getTime() + FIRST_TOUCH_MINUTES * 60_000);
  }
  const last = c.lastTouchedAt
    ? new Date(c.lastTouchedAt)
    : c.createdAt
      ? new Date(c.createdAt)
      : now;
  return addBusinessDays(last, FOLLOWUP_BUSINESS_DAYS);
}

/** True when an open lead's next action is past due. */
export function isLeadActionOverdue(c: LeadFacts, now: Date = new Date()): boolean {
  if (!isLeadOpen(c)) return false;
  const due = leadNextActionAt(c, now);
  return !!due && now.getTime() > due.getTime();
}

/** A plain reason an open lead is overdue, for the follow-up exception detail. */
export function staleLeadReason(c: LeadFacts, now: Date = new Date()): string | null {
  if (!isLeadOpen(c)) return null;
  if (!c.lastTouchedAt && !c.nextActionAt) {
    const due = leadNextActionAt(c, now);
    if (due && now.getTime() > due.getTime()) {
      return "This lead has never been contacted and the first-touch window has passed.";
    }
    return null;
  }
  const due = leadNextActionAt(c, now);
  if (due && now.getTime() > due.getTime()) {
    const overdueSince = due.toISOString().slice(0, 10);
    return `The next action for this lead has been due since ${overdueSince}.`;
  }
  return null;
}
