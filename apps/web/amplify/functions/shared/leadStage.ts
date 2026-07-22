/** GL-02 controlled lead stages, derived only from durable business facts. */
export type LeadStage =
  | "NEW"
  | "ATTEMPTED"
  | "REACHED"
  | "QUALIFIED"
  | "UNQUALIFIED"
  | "BOOKING_SENT"
  | "IDENTITY_REVIEW"
  | "WON"
  | "LOST"
  | "DNC";

export type LeadFacts = {
  status?: string | null;
  convertedAt?: string | null;
  doNotContact?: boolean | null;
  lostReason?: string | null;
  bookingLinkDeliveredAt?: string | null;
  lastAttemptedAt?: string | null;
  lastReachedAt?: string | null;
  qualificationStatus?: string | null;
  conversionReviewBookingId?: string | null;
  nextActionAt?: string | null;
  createdAt?: string | null;
};

export function deriveLeadStage(c: LeadFacts): LeadStage {
  if (c.status === "ACTIVE" || c.convertedAt) return "WON";
  if (c.doNotContact) return "DNC";
  if (c.lostReason) return "LOST";
  if (c.conversionReviewBookingId) return "IDENTITY_REVIEW";
  if (c.bookingLinkDeliveredAt) return "BOOKING_SENT";
  if (c.qualificationStatus === "QUALIFIED") return "QUALIFIED";
  if (c.qualificationStatus === "UNQUALIFIED") return "UNQUALIFIED";
  if (c.lastReachedAt) return "REACHED";
  if (c.lastAttemptedAt) return "ATTEMPTED";
  return "NEW";
}

export function isLeadOpen(c: LeadFacts): boolean {
  return !["WON", "LOST", "DNC"].includes(deriveLeadStage(c));
}

/** Every safe write persists the calendar-derived obligation. A legacy record
 * with no due time is due now rather than hidden behind an invented clock. */
export function leadNextActionAt(c: LeadFacts, now: Date = new Date()): Date | null {
  if (!isLeadOpen(c)) return null;
  return c.nextActionAt ? new Date(c.nextActionAt) : now;
}

export function isLeadActionOverdue(c: LeadFacts, now: Date = new Date()): boolean {
  const due = leadNextActionAt(c, now);
  return !!due && now.getTime() >= due.getTime();
}

export function staleLeadReason(c: LeadFacts, now: Date = new Date()): string | null {
  if (!isLeadOpen(c)) return null;
  if (!c.nextActionAt) {
    return "This lead has no durable next-action deadline. Work it now and record the outcome.";
  }
  const due = leadNextActionAt(c, now);
  return due && now.getTime() >= due.getTime()
    ? `The next action for this lead has been due since ${due.toISOString()}.`
    : null;
}
