/**
 * BuzzKill rate cards — the deterministic pricing core.
 *
 * Encodes the Thumbtack Lead Pricing spec verbatim. The AI extracts the
 * facts; THIS module computes every dollar amount, so identical inputs
 * always produce identical prices. Worked examples from the spec:
 *   - 3,200 sqft quarterly residential → $45 + 3×$10 = $75/mo + $99 initial
 *   - 1,800 sqft monthly, Zone B → $99 + $15 + $25 = $139/mo, initial $124
 *   - 60-unit HOA monthly → $110 + $55 + $100 + $140 = $405/mo (escalate)
 *   - Mosquito+tick ~1 acre → $139 + $30 = $169/mo, no initial fee
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

const ZONE_B = {
  MONTHLY: $(25),
  BIMONTHLY: $(13),
  QUARTERLY: $(8),
  ONE_TIME_FLAT: $(25), // one-time / specialty / initial visit
  MOSQUITO_MONTHLY: $(25),
};

const INITIAL_FEE = $(99);

/** Cumulative bracket helper: steps of `per` within (lo, hi], rounded up. */
function steps(value: number, lo: number, hi: number, per: number): number {
  if (value <= lo) return 0;
  return Math.ceil((Math.min(value, hi) - lo) / per);
}

// ---------- Residential (single-family & individual condo units) ----------

const RES_BASE: Record<Exclude<Frequency, "ONE_TIME">, number> = {
  MONTHLY: $(99),
  BIMONTHLY: $(56),
  QUARTERLY: $(45),
};
const RES_TIER_1: Record<Exclude<Frequency, "ONE_TIME">, number> = {
  MONTHLY: $(15), // 1,001–4,000 sqft, per 1,000
  BIMONTHLY: $(13),
  QUARTERLY: $(10),
};
const RES_TIER_2: Record<Exclude<Frequency, "ONE_TIME">, number> = {
  MONTHLY: $(23), // 4,001+ sqft, per 1,000
  BIMONTHLY: $(19),
  QUARTERLY: $(15),
};

export function priceResidential(opts: {
  frequency: Frequency;
  sqft: number;
  zone: Zone;
  rodentAddon?: boolean;
}): PricedPlan {
  const { frequency, sqft, zone } = opts;
  const lines: PriceLine[] = [];

  if (frequency === "ONE_TIME") {
    let cents = $(300);
    lines.push({ label: "One-time treatment (base)", cents });
    const extra = sqft > 2500 ? Math.ceil((sqft - 2500) / 1000) : 0;
    if (extra > 0) {
      const add = extra * $(13);
      lines.push({ label: `${extra} × $13 (2,501+ sqft per 1,000)`, cents: add });
      cents += add;
    }
    if (zone === "B") {
      lines.push({ label: "Zone B travel adder", cents: ZONE_B.ONE_TIME_FLAT });
      cents += ZONE_B.ONE_TIME_FLAT;
    }
    return {
      service: "Residential one-time treatment",
      frequency,
      monthlyCents: null,
      oneTimeCents: cents,
      initialFeeCents: null,
      lines,
    };
  }

  let monthly = RES_BASE[frequency];
  lines.push({ label: `Base (${freqLabel(frequency)}, up to 1,000 sqft)`, cents: monthly });

  const t1 = steps(sqft, 1000, 4000, 1000);
  if (t1 > 0) {
    const add = t1 * RES_TIER_1[frequency];
    lines.push({
      label: `${t1} × ${money(RES_TIER_1[frequency])} (1,001–4,000 sqft per 1,000)`,
      cents: add,
    });
    monthly += add;
  }
  const t2 = steps(sqft, 4000, Number.MAX_SAFE_INTEGER, 1000);
  if (t2 > 0) {
    const add = t2 * RES_TIER_2[frequency];
    lines.push({
      label: `${t2} × ${money(RES_TIER_2[frequency])} (4,001+ sqft per 1,000)`,
      cents: add,
    });
    monthly += add;
  }
  if (opts.rodentAddon) {
    lines.push({ label: "Rodent program add-on", cents: $(15) });
    monthly += $(15);
  }

  let initial = INITIAL_FEE;
  if (zone === "B") {
    lines.push({ label: "Zone B travel adder (monthly)", cents: ZONE_B[frequency] });
    monthly += ZONE_B[frequency];
    initial += ZONE_B.ONE_TIME_FLAT;
  }

  return {
    service: `Residential GPC — ${freqLabel(frequency)}`,
    frequency,
    monthlyCents: monthly,
    oneTimeCents: null,
    initialFeeCents: initial,
    lines,
  };
}

// ---------- Association / HOA (common areas) ----------

const HOA_BASE: Record<Frequency, number> = {
  MONTHLY: $(110),
  BIMONTHLY: $(90),
  QUARTERLY: $(70),
  ONE_TIME: $(312),
};
// [lo, hi, per, {freq: premium}]
const HOA_BRACKETS: Array<{
  lo: number;
  hi: number;
  per: number;
  label: string;
  premiums: Record<Frequency, number>;
}> = [
  { lo: 10, hi: 25, per: 15, label: "11–25 units (per 15)", premiums: { MONTHLY: $(55), BIMONTHLY: $(40), QUARTERLY: $(35), ONE_TIME: $(156) } },
  { lo: 25, hi: 50, per: 25, label: "26–50 units (per 25)", premiums: { MONTHLY: $(100), BIMONTHLY: $(80), QUARTERLY: $(65), ONE_TIME: $(288) } },
  { lo: 50, hi: 100, per: 50, label: "51–100 units (per 50)", premiums: { MONTHLY: $(140), BIMONTHLY: $(115), QUARTERLY: $(90), ONE_TIME: $(396) } },
  { lo: 100, hi: Number.MAX_SAFE_INTEGER, per: 100, label: "101+ units (per 100)", premiums: { MONTHLY: $(275), BIMONTHLY: $(150), QUARTERLY: $(180), ONE_TIME: $(792) } },
];

export function priceAssociation(opts: {
  frequency: Frequency;
  units: number;
  zone: Zone;
}): PricedPlan {
  const { frequency, units, zone } = opts;
  const lines: PriceLine[] = [];
  let total = HOA_BASE[frequency];
  lines.push({ label: `Base (${freqLabel(frequency)}, up to 10 units)`, cents: total });

  for (const b of HOA_BRACKETS) {
    const n = steps(units, b.lo, b.hi, b.per);
    if (n > 0) {
      const add = n * b.premiums[frequency];
      lines.push({ label: `${n} × ${money(b.premiums[frequency])} (${b.label})`, cents: add });
      total += add;
    }
  }

  const isRecurring = frequency !== "ONE_TIME";
  let initial: number | null = isRecurring ? INITIAL_FEE : null;
  if (zone === "B") {
    const adder = isRecurring ? ZONE_B[frequency] : ZONE_B.ONE_TIME_FLAT;
    lines.push({ label: "Zone B travel adder", cents: adder });
    total += adder;
    if (initial !== null) initial += ZONE_B.ONE_TIME_FLAT;
  }

  return {
    service: `Association/HOA common areas — ${freqLabel(frequency)}`,
    frequency,
    monthlyCents: isRecurring ? total : null,
    oneTimeCents: isRecurring ? null : total,
    initialFeeCents: initial,
    lines,
    // Every association/HOA lead escalates before booking, quote attached.
    escalate: "All association/HOA leads escalate to Jake (insurance & contract review)",
  };
}

// ---------- Commercial (non-food only) ----------

export function priceCommercial(opts: {
  frequency: Frequency;
  sqft: number;
  zone: Zone;
}): PricedPlan {
  const { frequency, sqft, zone } = opts;
  if (sqft > 15000) {
    return {
      service: "Commercial (over 15,000 sqft)",
      frequency,
      monthlyCents: null,
      oneTimeCents: null,
      initialFeeCents: null,
      lines: [],
      escalate: "Commercial over 15,000 sqft — Jake quotes custom",
    };
  }
  const small = sqft <= 5000;
  const card: Record<Frequency, number | null> = small
    ? { MONTHLY: $(149), BIMONTHLY: $(119), QUARTERLY: $(99), ONE_TIME: $(399) }
    : { MONTHLY: $(199), BIMONTHLY: $(159), QUARTERLY: $(129), ONE_TIME: null };

  const base = card[frequency];
  if (base === null) {
    return {
      service: "Commercial one-time (5,001–15,000 sqft)",
      frequency,
      monthlyCents: null,
      oneTimeCents: null,
      initialFeeCents: null,
      lines: [],
      escalate: "Commercial one-time over 5,000 sqft — Jake quotes custom",
    };
  }

  const lines: PriceLine[] = [
    { label: `Base (${small ? "≤5,000" : "5,001–15,000"} sqft, ${freqLabel(frequency)})`, cents: base },
  ];
  let total = base;
  const isRecurring = frequency !== "ONE_TIME";
  let initial: number | null = isRecurring ? INITIAL_FEE : null;
  if (zone === "B") {
    const adder = isRecurring ? ZONE_B[frequency] : ZONE_B.ONE_TIME_FLAT;
    lines.push({ label: "Zone B travel adder", cents: adder });
    total += adder;
    if (initial !== null) initial += ZONE_B.ONE_TIME_FLAT;
  }

  return {
    service: `Commercial — ${freqLabel(frequency)}`,
    frequency,
    monthlyCents: isRecurring ? total : null,
    oneTimeCents: isRecurring ? null : total,
    initialFeeCents: initial,
    lines,
  };
}

// ---------- Mosquito & tick (seasonal, May–October) ----------

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
    service: opts.tick ? "Mosquito + tick plan (May–Oct)" : "Mosquito plan (May–Oct)",
    frequency: "MONTHLY",
    monthlyCents: monthly,
    oneTimeCents: null,
    initialFeeCents: null, // mosquito/tick-only plans have no initial fee
    lines,
  };
}

// ---------- Specialty (one-time, flat) ----------

const SPECIALTY: Record<string, { label: string; cents: number | null }> = {
  wasp_nest: { label: "Wasp / hornet nest removal", cents: $(299) },
  rodent_nest: { label: "Rodent nest removal", cents: $(399) },
  rodent_exclusion: { label: "Rodent exclusion (exterior only)", cents: $(600) },
  termite: { label: "Termite (any)", cents: null }, // always escalates
};

export function priceSpecialty(kind: string, zone: Zone): PricedPlan | null {
  const card = SPECIALTY[kind];
  if (!card) return null;
  if (card.cents === null) {
    return {
      service: card.label,
      frequency: "ONE_TIME",
      monthlyCents: null,
      oneTimeCents: null,
      initialFeeCents: null,
      lines: [],
      escalate: "Termite work — Jake quotes custom",
    };
  }
  const lines: PriceLine[] = [{ label: card.label, cents: card.cents }];
  let total = card.cents;
  if (zone === "B") {
    lines.push({ label: "Zone B travel adder", cents: ZONE_B.ONE_TIME_FLAT });
    total += ZONE_B.ONE_TIME_FLAT;
  }
  return {
    service: card.label,
    frequency: "ONE_TIME",
    monthlyCents: null,
    oneTimeCents: total,
    initialFeeCents: null,
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
