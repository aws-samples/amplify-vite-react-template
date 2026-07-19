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
export type Zone = "A" | "B" | "OUT" | "UNKNOWN";

export type PriceLine = { label: string; cents: number };

export type PricedPlan = {
  service: string;
  frequency: Frequency;
  monthlyCents: number | null; // null for one-time-only services
  oneTimeCents: number | null;
  initialFeeCents: number | null;
  lines: PriceLine[];
  escalate?: string; // set when the card says ESCALATE
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
    if (opts.zone === "B") {
      lines.push({ label: "Zone B travel adder", cents: ZONE_B.ONE_TIME_FLAT });
      cents += ZONE_B.ONE_TIME_FLAT;
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
  if (opts.zone === "B") {
    lines.push({ label: "Zone B travel adder (monthly)", cents: ZONE_B.MOSQUITO_MONTHLY });
    monthly += ZONE_B.MOSQUITO_MONTHLY;
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
const DRIVE = { A: { min: 40, mi: 30 }, B: { min: 65, mi: 45 } };

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
  if (zone !== "A" && zone !== "B") return null;
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
