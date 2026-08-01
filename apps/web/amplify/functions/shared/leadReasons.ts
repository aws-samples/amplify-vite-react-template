/**
 * GL-02 — the controlled reasons a lead can be marked lost.
 *
 * The server validates against the codes (setLeadDisposition refuses an
 * off-list reason); the office picks from the same list in a dropdown, which
 * needs a human label per code. Both live here — a pure leaf with no imports,
 * so the CRM value-imports it into the browser bundle — because a code the
 * office can pick that the server refuses (or vice versa) is exactly the
 * drift this file exists to prevent. Order matters: it is the dropdown order.
 */

export const LEAD_LOST_REASONS = [
  "PRICE",
  "NO_RESPONSE",
  "WENT_COMPETITOR",
  "NOT_QUALIFIED",
  "OUT_OF_AREA",
  "DUPLICATE",
  "OTHER",
] as const;

export type LeadLostReason = (typeof LEAD_LOST_REASONS)[number];

export const LEAD_LOST_REASON_LABEL: Record<LeadLostReason, string> = {
  PRICE: "Price",
  NO_RESPONSE: "No response",
  WENT_COMPETITOR: "Went with a competitor",
  NOT_QUALIFIED: "Not qualified / out of scope",
  OUT_OF_AREA: "Outside service area",
  DUPLICATE: "Duplicate record",
  OTHER: "Other",
};
