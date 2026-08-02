import {
  hoaBandFor,
  mirrorCents,
  parseSheet,
  PLAN_CADENCES,
  type HoaBand,
  type HoaPerUnitRates,
  type MarketRateService,
  type PlanCadence,
  type PlanRate,
  type RateSheet,
} from "../../../web/amplify/functions/shared/marketRateKeys";
import type { MarketRate } from "./api";
import { SERVICE_CATALOG } from "../../../web/amplify/functions/shared/serviceCatalog";

/**
 * Client-side view of the AI market-rate engine
 * (apps/web/amplify/functions/shared/marketRate.ts). The CRM reads the same
 * cached MarketRate rows the public funnel quotes from, so the office screen
 * and the engine can never disagree about a number. The key building, band
 * brackets, parse tolerance, and priceCents mirror come from
 * shared/marketRateKeys.ts — the engine's pure leaf, value-imported so both
 * sides run the ONE copy (the engine module itself is impure and must never
 * reach the browser).
 *
 * Pinned semantics (this wave): an office-edited row is saved with
 * pinned=true and is served until the office changes it. Unpinning permits
 * a deliberate staff research request; it does not start background work.
 *
 * Serve-last-known-good (this wave): the live path is a pure read and the
 * engine serves the freshest usable row regardless of the historical
 * expiresAt marker. Age alone does not trigger AI research. Only a retired
 * row — or a combo with no sheet at all — is not served.
 */

export type { HoaBand, HoaPerUnitRates, PlanCadence, PlanRate, RateSheet };
export { hoaBandFor, mirrorCents, parseSheet, PLAN_CADENCES };

export type EngineService = MarketRateService;

// GL-01: engine-service labels derive from the ONE service catalog (a pure
// data module — the only VALUE import this file takes from apps/web, by
// design: labels are runtime data, and duplicating them is how the five
// taxonomies drifted apart in the first place).
export const SERVICE_LABEL: Record<string, string> = Object.fromEntries(
  Object.values(SERVICE_CATALOG)
    .filter((e) => e.engineService)
    .map((e) => [e.engineService as string, e.label])
);

export const CADENCE_LABEL: Record<PlanCadence, string> = {
  MONTHLY: "monthly",
  BIMONTHLY: "bi-monthly",
  QUARTERLY: "quarterly",
};

export { HOA_BANDS } from "../../../web/amplify/functions/shared/marketRateKeys";

export const HOA_BAND_LABEL: Record<HoaBand, string> = {
  UNITS_1_10: "up to 10 units",
  UNITS_11_25: "11–25 units",
  UNITS_26_50: "26–50 units",
  UNITS_51_100: "51–100 units",
  UNITS_101_PLUS: "101+ units",
};

// ------------------------------------------------------------ keys & bands

export {
  areaKeyFor,
  sqftBucket,
} from "../../../web/amplify/functions/shared/marketRateKeys";

/** The numeric sqft band on a rateKey (`SERVICE#area#band`), if any. */
export function bandOfKey(rateKey: string | null | undefined): number | null {
  const seg = (rateKey ?? "").split("#")[2];
  if (!seg) return null;
  const n = Number(seg);
  return Number.isFinite(n) ? n : null;
}

// ------------------------------------------------------------------ status

export type RateStatus = "retired" | "pinned" | "active";

/**
 * The row's honest state. Age is deliberately absent: an old sheet remains
 * active until a real quote needs a missing sheet or staff requests review.
 */
export function rateStatus(
  rate: Pick<MarketRate, "active" | "pinned" | "expiresAt">,
  _now = Date.now()
): RateStatus {
  if (!rate.active) return "retired";
  if (rate.pinned) return "pinned";
  return "active";
}

/** Would the engine serve this row? Only retired refuses. */
export function isServable(
  rate: Pick<MarketRate, "active" | "pinned" | "expiresAt">,
  now = Date.now()
): boolean {
  return rateStatus(rate, now) !== "retired";
}

// ------------------------------------------------------------------- sheet

/**
 * The sheet as the engine would serve it. For one-time sheets priceCents is
 * the mirror of the sheet's one-time and wins over a stale stored value;
 * HOA sheets have no one-time, so they serve as stored.
 */
export function sheetOf(
  rate: Pick<MarketRate, "priceCents" | "ratesJson">
): RateSheet {
  const stored = parseSheet(rate.ratesJson);
  if (stored?.hoaPerUnitMonthly) return stored;
  return { ...(stored ?? {}), oneTimeCents: rate.priceCents };
}

export type SheetEdits = {
  oneTimeCents?: number;
  extraNestCents?: number | null;
  plans?: Partial<Record<PlanCadence, PlanRate>>;
  hoaPerUnitMonthly?: HoaPerUnitRates;
};

/**
 * Merge an office edit into the stored sheet, preserving any components this
 * screen doesn't know about, and keep priceCents mirrored the way the
 * engine mirrors it — that mirror is the continuity contract.
 */
export function mergeSheetEdits(
  rate: Pick<MarketRate, "priceCents" | "ratesJson">,
  edits: SheetEdits
): { ratesJson: string; priceCents: number } {
  const existing = parseSheet(rate.ratesJson);
  const sheet: RateSheet = { ...(existing ?? {}) };
  if (edits.oneTimeCents != null) sheet.oneTimeCents = edits.oneTimeCents;
  if (edits.extraNestCents != null) sheet.extraNestCents = edits.extraNestCents;
  if (edits.plans) {
    const merged = { ...(existing?.plans ?? {}) } as Record<
      PlanCadence,
      PlanRate
    >;
    for (const cadence of PLAN_CADENCES) {
      const edit = edits.plans[cadence];
      if (edit) merged[cadence] = edit;
    }
    sheet.plans = merged;
  }
  if (edits.hoaPerUnitMonthly) sheet.hoaPerUnitMonthly = edits.hoaPerUnitMonthly;
  return { ratesJson: JSON.stringify(sheet), priceCents: mirrorCents(sheet) };
}

// --------------------------------------------------------------- selection

/**
 * Pick the cached row a quote for (service, area, size) should price from:
 * only rows the engine would serve; exact sqft band first, then the
 * smallest band that covers the size. Never a smaller band — a 2,000 sqft
 * rate is not a price for a 3,000 sqft home. HOA rows carry no key band
 * (all unit bands live inside the one sheet), so they pass band=null.
 */
export function selectPlanRate(
  rows: MarketRate[],
  service: EngineService,
  areaKey: string,
  band: number | null,
  now = Date.now()
): MarketRate | null {
  const candidates = rows.filter(
    (r) => r.service === service && r.areaKey === areaKey && isServable(r, now)
  );
  if (band == null) {
    return candidates.find((r) => bandOfKey(r.rateKey) == null) ?? null;
  }
  const exact = candidates.find((r) => bandOfKey(r.rateKey) === band);
  if (exact) return exact;
  return (
    candidates
      .filter((r) => (bandOfKey(r.rateKey) ?? -1) >= band)
      .sort((a, b) => (bandOfKey(a.rateKey) ?? 0) - (bandOfKey(b.rateKey) ?? 0))[0] ??
    null
  );
}

export type PlanPrefill = {
  monthlyCents: number;
  initialFeeCents: number | null;
  /**
   * Set for HOA rows, where the sheet rate is per unit per month: this is
   * the sheet number the server-side deviation guard can vouch for, while
   * monthlyCents (= per-unit × units) is the price the quote carries.
   */
  perUnitMonthlyCents?: number;
};

/**
 * The recurring-plan price a cached row prefills for a cadence. HOA sheets
 * store PER-UNIT monthly rates by unit-count band, so the unit count picks
 * the band and multiplies in here; HOA has no initial fee. Null when the
 * row has no plan rates (one-time-only services) or HOA has no usable unit
 * count.
 */
export function planPrefill(
  rate: Pick<MarketRate, "service" | "priceCents" | "ratesJson">,
  cadence: PlanCadence,
  opts?: { units?: number | null }
): PlanPrefill | null {
  const sheet = sheetOf(rate);
  if (rate.service === "HOA") {
    const units = opts?.units ?? null;
    if (units == null || !Number.isFinite(units) || units <= 0) return null;
    const perUnit = sheet.hoaPerUnitMonthly?.[hoaBandFor(units)]?.[cadence];
    if (typeof perUnit !== "number") return null;
    return {
      monthlyCents: perUnit * units,
      initialFeeCents: null,
      perUnitMonthlyCents: perUnit,
    };
  }
  const plan = sheet.plans?.[cadence];
  if (!plan || typeof plan.monthlyCents !== "number") return null;
  return {
    monthlyCents: plan.monthlyCents,
    initialFeeCents:
      typeof plan.initialFeeCents === "number" ? plan.initialFeeCents : null,
  };
}
