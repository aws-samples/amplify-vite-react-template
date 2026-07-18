/**
 * GL-02 — the CRM's mirror of the derived lead stage (server source of truth is
 * amplify/functions/shared/leadStage.ts). The stage is never stored or set by
 * hand; it is inferred from facts the office board reads off the Customer.
 */

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

export function deriveLeadStage(c: LeadFacts): LeadStage {
  if (c.status === "ACTIVE" || c.convertedAt) return "WON";
  if (c.doNotContact) return "DNC";
  if (c.lostReason) return "LOST";
  if (c.bookingLinkSentAt) return "BOOKING_SENT";
  if (c.lastTouchedAt) return "CONTACTED";
  return "NEW";
}

export function isLeadOpen(c: LeadFacts): boolean {
  const s = deriveLeadStage(c);
  return s === "NEW" || s === "CONTACTED" || s === "BOOKING_SENT";
}

/** Approximate the next-action due for the board's overdue highlight. An explicit
 *  nextActionAt wins; otherwise ~1 hour after arrival for a NEW lead, else ~2
 *  days after the last touch (the server is authoritative and business-hours
 *  aware; this is display only). */
export function leadNextActionAt(c: LeadFacts): Date | null {
  if (!isLeadOpen(c)) return null;
  if (c.nextActionAt) return new Date(c.nextActionAt);
  const stage = deriveLeadStage(c);
  if (stage === "NEW") {
    const created = c.createdAt ? new Date(c.createdAt) : new Date();
    return new Date(created.getTime() + 60 * 60 * 1000);
  }
  const last = c.lastTouchedAt
    ? new Date(c.lastTouchedAt)
    : c.createdAt
      ? new Date(c.createdAt)
      : new Date();
  return new Date(last.getTime() + 2 * 24 * 60 * 60 * 1000);
}

export function isLeadOverdue(c: LeadFacts, now: Date = new Date()): boolean {
  const due = leadNextActionAt(c);
  return !!due && now.getTime() > due.getTime();
}

export const LEAD_STAGE_LABEL: Record<LeadStage, string> = {
  NEW: "New",
  CONTACTED: "Contacted",
  BOOKING_SENT: "Booking sent",
  WON: "Won",
  LOST: "Lost",
  DNC: "Do not contact",
};

export const LEAD_STAGE_TONE: Record<
  LeadStage,
  "info" | "ok" | "warn" | "danger" | "muted"
> = {
  NEW: "info",
  CONTACTED: "warn",
  BOOKING_SENT: "info",
  WON: "ok",
  LOST: "muted",
  DNC: "danger",
};

/** The open stages, in pipeline order, for the board's columns. */
export const OPEN_LEAD_STAGES: LeadStage[] = ["NEW", "CONTACTED", "BOOKING_SENT"];
