/**
 * The recovery queue: everything with money at risk that someone has to chase,
 * derived as pure functions so the SLA arithmetic and the ordering are pinned
 * by tests, not by a screenshot of the Dashboard.
 *
 * A recovery item is one of three things (contract R02/R78):
 *   - an OVERDUE invoice   — OPEN and past its due date
 *   - a FAILED invoice     — a declined charge, in (or awaiting) dunning
 *   - an open DISPUTE      — a chargeback with a legal evidence deadline
 *
 * Each carries its SLA (how overdue / where in the retry cadence / how long
 * until the dispute deadline) and its owner. The queue is sorted most-urgent
 * first so the office works the top of the list.
 */

import { daysBetween, daysPastDue, toYmd, type AgingInvoice } from "./aging";

export type RecoveryInvoice = AgingInvoice & {
  id: string;
  customerId: string;
  amountCents: number;
  status?: string | null;
  failureReason?: string | null;
  dunningAttempts?: number | null;
  nextDunningAt?: string | null;
  lastDunningAt?: string | null;
  ownerSub?: string | null;
  ownerEmail?: string | null;
};

export type RecoveryDispute = {
  id: string;
  /** Nullable: the dispute-closed webhook path records a chargeback even when
   *  the created event never landed, so there is no matched customer. */
  customerId?: string | null;
  amountCents: number;
  reason?: string | null;
  status?: string | null;
  evidenceDueBy?: string | null;
  ownerSub?: string | null;
  ownerEmail?: string | null;
};

/** An OPEN invoice past its due date has money the office should be chasing. */
export function isOverdue(inv: RecoveryInvoice, today: string): boolean {
  return inv.status === "OPEN" && daysPastDue(inv, today) > 0;
}

/** A FAILED invoice is a declined charge — in dunning until it settles or is written off. */
export function isInDunning(inv: RecoveryInvoice): boolean {
  return inv.status === "FAILED";
}

/** A dispute the office still has to act on (as opposed to WON/LOST/closed). */
export function isOpenDispute(d: RecoveryDispute): boolean {
  return d.status === "NEEDS_RESPONSE" || d.status === "UNDER_REVIEW";
}

/**
 * Days until a dispute's evidence deadline as of `today`; negative once the
 * deadline has passed, null when no deadline is on the record.
 */
export function daysUntilEvidenceDue(
  d: RecoveryDispute,
  today: string
): number | null {
  if (!d.evidenceDueBy) return null;
  return daysBetween(today, toYmd(d.evidenceDueBy));
}

/**
 * A short, honest label for where a failed charge sits in the retry cadence.
 * Reads the dunning fields the backend stamps: how many retries have run, and
 * when the next one is scheduled.
 */
export function dunningStateLabel(inv: RecoveryInvoice, today: string): string {
  const attempts = inv.dunningAttempts ?? 0;
  if (inv.nextDunningAt) {
    const days = daysBetween(today, toYmd(inv.nextDunningAt));
    const when = days <= 0 ? "due now" : `in ${days}d`;
    return attempts > 0
      ? `Retry ${attempts} · next ${when}`
      : `Next retry ${when}`;
  }
  return attempts > 0
    ? `${attempts} ${attempts === 1 ? "retry" : "retries"}, no next retry`
    : "Payment failed";
}

const plural = (n: number) => (n === 1 ? "" : "s");

export type RecoveryItemKind = "OVERDUE" | "FAILED" | "DISPUTE";

export type RecoveryItem = {
  kind: RecoveryItemKind;
  /** "invoice" or "dispute" — which model `id` points at (drives assign + links). */
  refType: "invoice" | "dispute";
  id: string;
  /** Null only for an unmatched dispute (see RecoveryDispute.customerId). */
  customerId: string | null;
  amountCents: number;
  /** The SLA, said plainly: "12 days overdue", "Retry 2 · next in 3d", "2 days to respond". */
  slaLabel: string;
  /** Time-critical enough to style loudly. */
  urgent: boolean;
  ownerSub: string | null;
  ownerEmail: string | null;
  stripeDisputeId?: string | null;
  reason?: string | null;
  failureReason?: string | null;
  /** Sort tier: disputes over failed over overdue (see buildRecoveryQueue). */
  tier: number;
  /** Within-tier urgency, higher is more urgent. */
  metric: number;
};

// Disputes carry a legal deadline and a hard financial loss, so they sit above
// failed charges (money already declined, actively retrying), which sit above
// merely-overdue invoices (owed, not yet chased to a decline).
const TIER = { DISPUTE: 3, FAILED: 2, OVERDUE: 1 } as const;

// Days-past-due at which owed money is loud rather than routine.
const OVERDUE_URGENT_DAYS = 30;
// Days-until-deadline inside which a dispute is loud.
const DISPUTE_URGENT_DAYS = 3;

function overdueItem(inv: RecoveryInvoice, today: string): RecoveryItem {
  const days = daysPastDue(inv, today);
  return {
    kind: "OVERDUE",
    refType: "invoice",
    id: inv.id,
    customerId: inv.customerId,
    amountCents: inv.amountCents,
    slaLabel: `${days} day${plural(days)} overdue`,
    urgent: days > OVERDUE_URGENT_DAYS,
    ownerSub: inv.ownerSub ?? null,
    ownerEmail: inv.ownerEmail ?? null,
    tier: TIER.OVERDUE,
    metric: days,
  };
}

function failedItem(inv: RecoveryInvoice, today: string): RecoveryItem {
  const days = Math.max(0, daysPastDue(inv, today));
  return {
    kind: "FAILED",
    refType: "invoice",
    id: inv.id,
    customerId: inv.customerId,
    amountCents: inv.amountCents,
    slaLabel: dunningStateLabel(inv, today),
    urgent: days > OVERDUE_URGENT_DAYS,
    ownerSub: inv.ownerSub ?? null,
    ownerEmail: inv.ownerEmail ?? null,
    failureReason: inv.failureReason ?? null,
    tier: TIER.FAILED,
    metric: days,
  };
}

function disputeItem(d: RecoveryDispute, today: string): RecoveryItem {
  const days = daysUntilEvidenceDue(d, today);
  const slaLabel =
    days === null
      ? "Respond ASAP"
      : days < 0
        ? `${-days} day${plural(-days)} past deadline`
        : days === 0
          ? "Due today"
          : `${days} day${plural(days)} to respond`;
  return {
    kind: "DISPUTE",
    refType: "dispute",
    id: d.id,
    customerId: d.customerId ?? null,
    amountCents: d.amountCents,
    slaLabel,
    urgent: days === null || days <= DISPUTE_URGENT_DAYS,
    ownerSub: d.ownerSub ?? null,
    ownerEmail: d.ownerEmail ?? null,
    reason: d.reason ?? null,
    tier: TIER.DISPUTE,
    // Fewer days remaining is more urgent, so negate; a null deadline is
    // treated as "now" (0) rather than sorted to the bottom.
    metric: days === null ? 0 : -days,
  };
}

/**
 * Compare two recovery items, most-urgent first. Tier decides first (dispute >
 * failed > overdue), then within-tier metric, then the bigger dollar amount,
 * then id for a stable order.
 */
export function compareRecoveryItems(a: RecoveryItem, b: RecoveryItem): number {
  if (a.tier !== b.tier) return b.tier - a.tier;
  if (a.metric !== b.metric) return b.metric - a.metric;
  if (a.amountCents !== b.amountCents) return b.amountCents - a.amountCents;
  return a.id.localeCompare(b.id);
}

/**
 * Build the recovery queue from all invoices and disputes, sorted most-urgent
 * first. Membership: overdue OPEN invoices, all FAILED invoices, and open
 * disputes. Not-yet-due OPEN invoices are deliberately excluded — there is
 * nothing to recover until they are late; they show in the aging "current"
 * bucket instead.
 */
export function buildRecoveryQueue(
  invoices: RecoveryInvoice[],
  disputes: RecoveryDispute[],
  today: string
): RecoveryItem[] {
  const items: RecoveryItem[] = [];
  for (const inv of invoices) {
    if (isInDunning(inv)) items.push(failedItem(inv, today));
    else if (isOverdue(inv, today)) items.push(overdueItem(inv, today));
  }
  for (const d of disputes) {
    if (isOpenDispute(d)) items.push(disputeItem(d, today));
  }
  return items.sort(compareRecoveryItems);
}
