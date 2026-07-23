/**
 * BuzzKill cost-and-zone module.
 *
 * Base PRICES come from the AI market-rate engine (shared/marketRate) — the
 * residential, association/HOA, specialty, and commercial price cards that
 * used to live here are retired. What remains is everything deterministic
 * that overlays or bounds an AI price:
 *   - the Zone B travel adders (R60) and zoneFromMinutes,
 *   - the Step-5 variable-cost constants and oneTimeGrossProfitCents (the
 *     engine's price floor and the 3× lead-fee test),
 *   - the one card the engine has no service kind for yet: seasonal
 *     mosquito/tick (worked example: mosquito+tick ~1 acre →
 *     $139 + $30 = $169/mo, no initial fee).
 */

export type Frequency = "MONTHLY" | "BIMONTHLY" | "QUARTERLY" | "ONE_TIME";
export type Zone = "A" | "B" | "C" | "OUT" | "UNKNOWN";

export type PriceLine = { label: string; cents: number };

export type PricedPlan = {
  service: string;
  frequency: Frequency;
  monthlyCents: number | null; // null for one-time-only services
  oneTimeCents: number | null;
  initialFeeCents: number | null;
  lines: PriceLine[];
};

const $ = (dollars: number) => Math.round(dollars * 100);

// ---------- Zone B adders ----------

export const ZONE_B = {
  MONTHLY: $(25),
  BIMONTHLY: $(13),
  QUARTERLY: $(8),
  ONE_TIME_FLAT: $(25), // one-time / specialty / initial visit
  MOSQUITO_MONTHLY: $(25),
};

// ---------- Zone C adders (far zone, beyond 90 min) ----------
// The public funnel never auto-sells Zone C — an out-of-area visitor still gets
// a callback. This surcharge applies only when the OFFICE issues the quote (the
// lead-specific "Open prefilled website quote" link), so a distant address the
// office chose to service prices itself with a fixed far-zone travel add-on.
//
// PLACEHOLDER AMOUNTS — set to 2× Zone B. Confirm/tune these with the owner;
// they are the only business number here and change nothing structurally.
export const ZONE_C = {
  MONTHLY: $(50),
  BIMONTHLY: $(26),
  QUARTERLY: $(16),
  ONE_TIME_FLAT: $(50),
  MOSQUITO_MONTHLY: $(50),
};

/**
 * The travel add-on for a zone, by adder kind. A and OUT/UNKNOWN carry none;
 * B and C read their table. Centralized so every pricing site applies the
 * same rule and Zone C can never be half-wired into one service and not another.
 */
export function travelAdderCents(
  zone: Zone,
  kind: keyof typeof ZONE_B
): number {
  if (zone === "B") return ZONE_B[kind];
  if (zone === "C") return ZONE_C[kind];
  return 0;
}

// ---------- Mosquito & tick (seasonal, Apr–October) ----------

export function priceMosquito(opts: {
  tick: boolean;
  halfAcres: number; // total yard size in half-acres, min 1
  zone: Zone;
  oneTime?: boolean;
}): PricedPlan {
  const halfAcres = Math.max(1, Math.ceil(opts.halfAcres));
  const extra = halfAcres - 1;
  const lines: PriceLine[] = [];

  if (opts.oneTime) {
    let cents = $(199);
    lines.push({ label: "One-time event spray (mosquito, up to ½ acre)", cents });
    if (extra > 0) {
      lines.push({ label: `${extra} × $40 (each additional ½ acre)`, cents: extra * $(40) });
      cents += extra * $(40);
    }
    {
      const adder = travelAdderCents(opts.zone, "ONE_TIME_FLAT");
      if (adder > 0) {
        lines.push({ label: `Zone ${opts.zone} travel adder`, cents: adder });
        cents += adder;
      }
    }
    return {
      service: "Mosquito one-time event spray",
      frequency: "ONE_TIME",
      monthlyCents: null,
      oneTimeCents: cents,
      initialFeeCents: null,
      lines,
    };
  }

  let monthly = opts.tick ? $(139) : $(119);
  lines.push({
    label: `${opts.tick ? "Mosquito + tick" : "Mosquito"} plan (up to ½ acre)`,
    cents: monthly,
  });
  if (extra > 0) {
    lines.push({ label: `${extra} × $30 (each additional ½ acre)`, cents: extra * $(30) });
    monthly += extra * $(30);
  }
  {
    const adder = travelAdderCents(opts.zone, "MOSQUITO_MONTHLY");
    if (adder > 0) {
      lines.push({ label: `Zone ${opts.zone} travel adder (monthly)`, cents: adder });
      monthly += adder;
    }
  }
  return {
    service: opts.tick ? "Mosquito + tick plan (Apr–Oct)" : "Mosquito plan (Apr–Oct)",
    frequency: "MONTHLY",
    monthlyCents: monthly,
    oneTimeCents: null,
    initialFeeCents: null, // mosquito/tick-only plans have no initial fee
    lines,
  };
}

// ---------- Step 5: lead-fee economics (one-time / specialty only) ----------

const LABOR_PER_HR = 42;
const VAN_PER_MI = 0.3;
const DRIVE = {
  A: { min: 40, mi: 30 },
  B: { min: 65, mi: 45 },
  // Zone C (far, office-issued only): representative round-trip cost so the
  // variable-cost discount floor still protects a Zone C day quote.
  C: { min: 110, mi: 75 },
};

const ONSITE_MIN: Record<string, number> = {
  one_time_gpc: 90,
  wasp_nest: 60,
  rodent_nest: 90,
  rodent_exclusion: 180,
  mosquito_one_time: 35,
};
const MATERIALS: Record<string, number> = {
  one_time_gpc: 15,
  wasp_nest: 15,
  rodent_nest: 55,
  rodent_exclusion: 100,
  mosquito_one_time: 20,
};

/** Gross profit for a one-time job; null when zone unknown. */
export function oneTimeGrossProfitCents(
  kind: string,
  priceCents: number,
  zone: Zone
): number | null {
  if (zone !== "A" && zone !== "B" && zone !== "C") return null;
  const onsite = ONSITE_MIN[kind] ?? 90;
  const materials = MATERIALS[kind] ?? 15;
  const drive = DRIVE[zone];
  const variableCost =
    ((onsite + drive.min) / 60) * LABOR_PER_HR + drive.mi * VAN_PER_MI + materials;
  return priceCents - Math.round(variableCost * 100);
}

/** One-time leads must clear 3× the lead fee in gross profit. */
export function clearsLeadFee(
  gpCents: number | null,
  leadFeeCents: number | null
): boolean | null {
  if (gpCents === null || leadFeeCents === null) return null;
  return gpCents >= 3 * leadFeeCents;
}

// ---------- helpers ----------

export function freqLabel(f: Frequency): string {
  return f === "MONTHLY"
    ? "monthly"
    : f === "BIMONTHLY"
      ? "every 2 months"
      : f === "QUARTERLY"
        ? "quarterly"
        : "one-time";
}

export function money(cents: number): string {
  const d = cents / 100;
  return Number.isInteger(d) ? `$${d}` : `$${d.toFixed(2)}`;
}

/** Zone from drive minutes (from 81 Greenwich Rd, Ware MA). */
export function zoneFromMinutes(minutes: number): Zone {
  if (minutes <= 50) return "A";
  if (minutes <= 90) return "B";
  return "OUT";
}
