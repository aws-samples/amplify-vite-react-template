/** CRM mirror of the server's controlled, fact-derived GL-02 stages. */
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

export function leadNextActionAt(c: LeadFacts): Date | null {
  if (!isLeadOpen(c)) return null;
  return c.nextActionAt ? new Date(c.nextActionAt) : new Date(0);
}

export function isLeadOverdue(c: LeadFacts, now: Date = new Date()): boolean {
  const due = leadNextActionAt(c);
  return !!due && now.getTime() >= due.getTime();
}

export const LEAD_STAGE_LABEL: Record<LeadStage, string> = {
  NEW: "New",
  ATTEMPTED: "Attempted",
  REACHED: "Reached",
  QUALIFIED: "Qualified",
  UNQUALIFIED: "Unqualified",
  BOOKING_SENT: "Booking delivered",
  IDENTITY_REVIEW: "Identity decision",
  WON: "Won",
  LOST: "Lost",
  DNC: "Do not contact",
};

export const LEAD_STAGE_TONE: Record<
  LeadStage,
  "info" | "ok" | "warn" | "danger" | "muted"
> = {
  NEW: "info",
  ATTEMPTED: "warn",
  REACHED: "info",
  QUALIFIED: "ok",
  UNQUALIFIED: "warn",
  BOOKING_SENT: "info",
  IDENTITY_REVIEW: "danger",
  WON: "ok",
  LOST: "muted",
  DNC: "danger",
};

export const OPEN_LEAD_STAGES: LeadStage[] = [
  "NEW",
  "ATTEMPTED",
  "REACHED",
  "QUALIFIED",
  "UNQUALIFIED",
  "BOOKING_SENT",
  "IDENTITY_REVIEW",
];
