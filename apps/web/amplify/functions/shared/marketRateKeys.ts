/**
 * The market-rate engine's vocabulary and key/sheet arithmetic — the pure
 * half of shared/marketRate.ts, split out (like rateServing.ts) so the CRM
 * can value-import it into the browser bundle. The engine itself imports the
 * Anthropic SDK, node:crypto, and dataClient, and must never reach a browser.
 *
 * Everything here is a derivation rule both sides must agree on: how a
 * (city, state) becomes an areaKey, which 500-sqft band a home falls in,
 * which unit-count band an HOA falls in, how a stored ratesJson parses, and
 * which number the row's required priceCents column mirrors. A disagreement
 * on any of these is a quote priced off the wrong cached row.
 */

export type MarketRateService =
  | "GENERAL_PEST"
  | "WASP_NEST"
  | "RODENT"
  | "ROACH"
  | "TERMITE"
  | "WILDLIFE"
  | "COMMERCIAL"
  | "HOA";

export type PlanCadence = "MONTHLY" | "BIMONTHLY" | "QUARTERLY";
export const PLAN_CADENCES: PlanCadence[] = [
  "MONTHLY",
  "BIMONTHLY",
  "QUARTERLY",
];

export type PlanRate = { monthlyCents: number; initialFeeCents: number };

/**
 * HOA unit-count bands, mirroring the brackets the retired deterministic
 * association card used (≤10 base, 11–25, 26–50, 51–100, 101+).
 */
export type HoaBand =
  | "UNITS_1_10"
  | "UNITS_11_25"
  | "UNITS_26_50"
  | "UNITS_51_100"
  | "UNITS_101_PLUS";
export const HOA_BANDS: HoaBand[] = [
  "UNITS_1_10",
  "UNITS_11_25",
  "UNITS_26_50",
  "UNITS_51_100",
  "UNITS_101_PLUS",
];

export function hoaBandFor(units: number): HoaBand {
  if (units <= 10) return "UNITS_1_10";
  if (units <= 25) return "UNITS_11_25";
  if (units <= 50) return "UNITS_26_50";
  if (units <= 100) return "UNITS_51_100";
  return "UNITS_101_PLUS";
}

/** HOA: per-unit MONTHLY price in cents, by unit-count band and cadence. */
export type HoaPerUnitRates = Record<HoaBand, Record<PlanCadence, number>>;

/** The full researched sheet stored on one MarketRate row (ratesJson). */
export type RateSheet = {
  /** One-time treatment (WASP_NEST: the visit including the first nest).
   *  Absent on HOA sheets — common-area work has no one-time card. */
  oneTimeCents?: number;
  /** WASP_NEST: incremental price per additional nest on the same visit. */
  extraNestCents?: number;
  /** WILDLIFE: incremental price per additional animal removed on the same
   *  visit (the base oneTimeCents covers the visit plus the first animal). */
  extraAnimalCents?: number;
  /** Recurring plans, each billed as a flat monthly price. PARTIAL on purpose:
   *  a service may sell only some cadences (rodent is quarterly-only), so every
   *  reader must handle a missing cadence rather than assume all three. */
  plans?: Partial<Record<PlanCadence, PlanRate>>;
  /** HOA: per-unit monthly rate by unit-count band and visit cadence. */
  hoaPerUnitMonthly?: HoaPerUnitRates;
};

/** What the row's required priceCents column mirrors for a given sheet. */
export function mirrorCents(sheet: RateSheet): number {
  return (
    sheet.oneTimeCents ?? sheet.hoaPerUnitMonthly?.UNITS_1_10.MONTHLY ?? 0
  );
}

/** Tolerant ratesJson parse: a corrupt or wrong-shaped value is a sheet-less
 *  row, never a throw. */
export function parseSheet(raw: unknown): RateSheet | null {
  if (raw == null) return null;
  try {
    const value = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (
      typeof value === "object" &&
      value !== null &&
      (typeof (value as RateSheet).oneTimeCents === "number" ||
        typeof (value as RateSheet).hoaPerUnitMonthly === "object")
    ) {
      return value as RateSheet;
    }
  } catch {
    /* corrupt ratesJson — treat as sheet-less row */
  }
  return null;
}

export function sqftBucket(sqft: number): number {
  return Math.max(500, Math.ceil(sqft / 500) * 500);
}

export function areaKeyFor(city: string, state: string): string {
  return `${city.trim().toLowerCase().replace(/\s+/g, "-")}-${state.trim().toLowerCase()}`;
}
