import type { CSSProperties } from "react";
import type { QuoteStatus } from "./quoteStatus";
import type {
  AccountStage,
  MarketingTaskResolution,
  OcrStatus,
  PolicyStatus,
} from "./enums";

/**
 * Status badges — one place for "what colour and what words does this state
 * get", plus the pill that renders it.
 *
 * There are two genuinely different jobs here and they stay two functions:
 *
 *   1. `statusBadge` — enum → colour/label. A static lookup with a fallback.
 *   2. `urgencyBadge` — days-until-a-date → colour/label. A threshold ladder
 *      whose cutoffs differ per domain (a license 45 days out is fine; a
 *      marketing task 45 days past its submit-by is not the same thing).
 *
 * Folding them together would mean a lookup that secretly does arithmetic.
 * They share the `BadgeSpec` return shape and the `<Badge>` renderer, which
 * is the part that was actually duplicated.
 *
 * Deliberately importing nothing but types: `client.ts` calls
 * `generateClient()` at module scope, so a colour table must not live behind
 * it. Callers pass `daysUntil(...)`'s result in; this module never reads
 * a clock, which is also why every test below is deterministic.
 *
 * Each table that mirrors a schema enum is pinned with
 * `satisfies Record<TheEnum, BadgeSpec>`, so a status added to the schema
 * fails compilation here until it is given a colour. `BadgeMap` itself stays
 * `Record<string, …>` on purpose — `statusBadge` must keep rendering
 * *something* for a value no table knows, which is the one behaviour a
 * stricter key type would take away.
 */

/**
 * The complete set of badge modifiers in `styles.css` (`.badge.green`,
 * `.amber`, `.red`, `.blue`, `.gray`). Anything else renders as an unstyled
 * pill, so the class is typed rather than a bare string.
 */
export type BadgeClass = "green" | "amber" | "red" | "blue" | "gray";

/** A resolved badge: the class to hang off `.badge`, and the text inside. */
export interface BadgeSpec {
  cls: BadgeClass;
  label: string;
}

/** Enum value → badge. Keys are the raw stored values, not display text. */
export type BadgeMap = Record<string, BadgeSpec>;

/**
 * Look up `value` in `map`.
 *
 * An unmapped value must never render blank or throw — a status added to the
 * schema and not to a table here still shows the operator *something*. The
 * default fallback is a grey pill carrying the raw value (an em dash when
 * there is no value at all); pass `fallback` when a domain has a more
 * meaningful default than "unknown", e.g. documents treat a missing OCR
 * status as PENDING.
 */
export function statusBadge(
  map: BadgeMap,
  value: string | null | undefined,
  fallback?: BadgeSpec
): BadgeSpec {
  // Own-property only: `map["toString"]` would otherwise hand back a function
  // off Object.prototype and render it as a badge.
  if (value != null && Object.prototype.hasOwnProperty.call(map, value)) {
    return map[value];
  }
  if (fallback) return fallback;
  return { cls: "gray", label: value == null || value === "" ? "—" : value };
}

// ── Enum tables ──────────────────────────────────────────────────────
// Labels are the text these badges render today. Where an enum was shown
// raw (quote status, policy status, extraction confidence) the label is the
// token itself, so adopting these tables changes no visible words.

/** `QuoteStatus`. The one table `QuotesPanel` and `QuotesList` must share. */
export const QUOTE_STATUS_BADGE = {
  DRAFT: { cls: "gray", label: "DRAFT" },
  SUBMITTED: { cls: "blue", label: "SUBMITTED" },
  QUOTED: { cls: "amber", label: "QUOTED" },
  PRESENTED: { cls: "amber", label: "PRESENTED" },
  BOUND: { cls: "green", label: "BOUND" },
  DECLINED: { cls: "red", label: "DECLINED" },
  LOST: { cls: "red", label: "LOST" },
} satisfies Record<QuoteStatus, BadgeSpec>;

/** `PolicyStatus`. Only ACTIVE is a live policy; the three dead ends are grey. */
export const POLICY_STATUS_BADGE = {
  ACTIVE: { cls: "green", label: "ACTIVE" },
  EXPIRED: { cls: "gray", label: "EXPIRED" },
  CANCELLED: { cls: "gray", label: "CANCELLED" },
  NON_RENEWED: { cls: "gray", label: "NON_RENEWED" },
} satisfies Record<PolicyStatus, BadgeSpec>;

/** `OcrStatus`. Labels say "OCR" because the column header does not. */
export const OCR_STATUS_BADGE = {
  PENDING: { cls: "gray", label: "OCR queued" },
  PROCESSING: { cls: "amber", label: "OCR running" },
  COMPLETE: { cls: "green", label: "OCR done" },
  FAILED: { cls: "red", label: "OCR failed" },
  SKIPPED: { cls: "gray", label: "No OCR" },
} satisfies Record<OcrStatus, BadgeSpec>;

/** AI extraction per-field confidence. Lower-case: these come from the model. */
export const CONFIDENCE_BADGE: BadgeMap = {
  high: { cls: "green", label: "high" },
  medium: { cls: "amber", label: "medium" },
  low: { cls: "red", label: "low" },
};

/**
 * `AccountStage`. Shown two ways today — the account heading renders the raw
 * token, the dashboard renders "Client"/"Lead" — for the same two colours.
 * One spelling wins, and it is the sentence-case one.
 */
export const ACCOUNT_STAGE_BADGE = {
  LEAD: { cls: "blue", label: "Lead" },
  CLIENT: { cls: "green", label: "Client" },
} satisfies Record<AccountStage, BadgeSpec>;

/** `MarketingTaskResolution` — how a closed marketing task was satisfied. */
export const MARKETING_RESOLUTION_BADGE = {
  QUOTED: { cls: "green", label: "Quoted" },
  OUT_OF_APPETITE: { cls: "gray", label: "Out of appetite" },
} satisfies Record<MarketingTaskResolution, BadgeSpec>;

// ── Two-state flags ──────────────────────────────────────────────────

/** A badge for each side of a boolean. */
export interface BadgePair {
  on: BadgeSpec;
  off: BadgeSpec;
}

/** Null and undefined are "off" — an unset flag is not a set one. */
export function flagBadge(
  flag: boolean | null | undefined,
  pair: BadgePair
): BadgeSpec {
  return flag ? pair.on : pair.off;
}

/**
 * Carrier appointment. The only boolean badge written out twice (the carrier
 * list and the carrier heading); the rest are one-offs that read fine inline.
 */
export const CARRIER_APPOINTMENT_BADGE: BadgePair = {
  on: { cls: "green", label: "Appointed" },
  off: { cls: "amber", label: "Prospective" },
};

// ── Days-until ladder ────────────────────────────────────────────────

/**
 * Where a date falls on its domain's ladder. `overdue` is the date having
 * passed; `unknown` is there being no date. Callers that expose their own
 * vocabulary (licences call `overdue` "expired") rename at their boundary.
 */
export type UrgencyLevel = "overdue" | "urgent" | "soon" | "calm" | "unknown";

/** An urgency badge, with the rung it landed on. */
export interface UrgencySpec extends BadgeSpec {
  level: UrgencyLevel;
}

/**
 * One domain's cutoffs and wording.
 *
 * The cutoffs are the whole point of this being a parameter: how much notice
 * a deadline needs is a property of the deadline, not of badges.
 */
export interface UrgencyScale {
  /** `days <= urgent` → red. Omit for a ladder with no red-but-not-yet rung. */
  urgent?: number;
  /** `days <= soon` → amber. */
  soon: number;
  /** Anything past `soon`. Green where far-off is *healthy*, grey where it is
   * merely not-yet — a renewal 80 days out is not good news, just not news. */
  calm: BadgeClass;
  /** Rendered when there is no date at all. */
  unknown: BadgeSpec;
  /** Wording for a date still ahead (`days >= 0`). */
  label: (days: number) => string;
  /** Wording for a date already passed. `daysPast` is positive. */
  overdue: (daysPast: number) => string;
}

/**
 * Place `days` on `scale`.
 *
 * Past-due always wins and is always red — no domain here wants a soft colour
 * on a blown deadline. Cutoffs are inclusive: exactly-at-the-cutoff belongs to
 * the more urgent rung, so a 30-days-left licence is still red.
 */
export function urgencyBadge(
  days: number | null | undefined,
  scale: UrgencyScale
): UrgencySpec {
  if (days == null) return { ...scale.unknown, level: "unknown" };
  if (days < 0) {
    return { cls: "red", label: scale.overdue(-days), level: "overdue" };
  }
  if (scale.urgent != null && days <= scale.urgent) {
    return { cls: "red", label: scale.label(days), level: "urgent" };
  }
  if (days <= scale.soon) {
    return { cls: "amber", label: scale.label(days), level: "soon" };
  }
  return { cls: scale.calm, label: scale.label(days), level: "calm" };
}

/**
 * Licence expiry: 30/60 days.
 *
 * A state licence renewal is a filing with a regulator — fees, CE credits,
 * sometimes fingerprints — so the amber warning starts two months out and the
 * red one a month out. Far-off is green: a current licence is a good state to
 * be in, not merely a quiet one.
 */
export const LICENSE_EXPIRY_SCALE: UrgencyScale = {
  urgent: 30,
  soon: 60,
  calm: "green",
  unknown: { cls: "gray", label: "No expiration on file" },
  label: (days) => `${days}d left`,
  overdue: (days) => `Expired ${days}d ago`,
};

/**
 * Marketing-task submit-by: 7/21 days.
 *
 * Tighter than licences on purpose, and not drift. `submitBy` is itself a
 * derived deadline — `expiration − leadTime` in the nightly sweep — and the
 * sweep does not raise the task until `today >= submitBy − 14`. So a task's
 * whole visible life is a fortnight or less: on a 30/60 ladder every task
 * ever raised would render red on day one and the badge would say nothing.
 * Amber at three weeks and red inside one is what fits that window.
 */
export const MARKETING_SUBMIT_SCALE: UrgencyScale = {
  urgent: 7,
  soon: 21,
  calm: "green",
  unknown: { cls: "gray", label: "—" },
  label: (days) => `submit in ${days}d`,
  overdue: (days) => `${days}d past submit-by`,
};

/**
 * Dashboard renewal horizon: 30 days, two rungs.
 *
 * No red-ahead rung, and calm is grey rather than green, because the list is
 * already filtered to a 30/60/90-day horizon — every row is a renewal that
 * needs work eventually, so the badge only distinguishes "this month" from
 * "later". Green would read as "nothing to do".
 */
export const RENEWAL_HORIZON_SCALE: UrgencyScale = {
  soon: 30,
  calm: "gray",
  unknown: { cls: "gray", label: "—" },
  label: (days) => `${days}d`,
  overdue: (days) => `${days}d overdue`,
};

// ── Renderer ─────────────────────────────────────────────────────────

/**
 * The pill. Spread a spec into it — `<Badge {...statusBadge(MAP, value)} />` —
 * or name a class and label directly for a one-off chip.
 */
export function Badge({
  cls,
  label,
  style,
}: BadgeSpec & { style?: CSSProperties }) {
  return (
    <span className={`badge ${cls}`} style={style}>
      {label}
    </span>
  );
}
