/**
 * GL-02 lead stages for the CRM.
 *
 * The stage derivation itself lives in amplify/functions/shared/leadStage.ts
 * and is re-exported here — it used to be a hand-kept copy, so the office and
 * the nightly sweep could disagree about what stage a lead was in.
 *
 * What stays local is the queue-ordering half, and it stays local DELIBERATELY:
 *
 *  - The server's `leadNextActionAt` treats a lead with no stored deadline as
 *    due *now*, which is right for a sweep asking "is this overdue yet?".
 *  - The office queue asks a different question — "what do I work first?" — and
 *    a lead that has never been given a deadline is the oldest debt on the
 *    board, so it sorts to the top (epoch). See Leads.tsx sorting.
 *
 * Both answer "overdue: yes"; they differ only in ordering, so keep them apart
 * rather than collapsing one into the other.
 */

export type {
  LeadFacts,
  LeadStage,
} from "../../../web/amplify/functions/shared/leadStage";
export {
  deriveLeadStage,
  isLeadOpen,
} from "../../../web/amplify/functions/shared/leadStage";

import type { LeadFacts, LeadStage } from "../../../web/amplify/functions/shared/leadStage";
import { isLeadOpen } from "../../../web/amplify/functions/shared/leadStage";

/**
 * Queue ordering, not sweep timing: a lead with no stored deadline sorts to the
 * top of the office queue rather than to "now". Intentionally NOT the server's
 * `leadNextActionAt` — see the module note.
 */
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
