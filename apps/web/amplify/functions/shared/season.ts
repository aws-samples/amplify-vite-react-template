/**
 * GL-17 — THE single encoding of the approved seasonal rule. Mosquito and
 * mosquito-plus-tick plans bill in equal monthly installments year-round and
 * owe exactly one treatment per calendar month April–October (seven annual
 * treatments), none November–March. Billing starts at enrollment even
 * off-season; an in-season first treatment satisfies that month; a missed
 * month creates NO catch-up visit. Everything that needs a seasonal fact —
 * the recurring engine, the funnel offer, plan copy, monitoring, obligations —
 * imports this module; there is no second encoding anywhere.
 *
 * Month math is done on `YYYY-MM` keys in America/New_York, because "which
 * month a treatment belongs to" is a business-calendar fact, not a UTC one.
 */

/** The approved service months for launch seasonal plans: April–October. */
export const SEASONAL_SERVICE_MONTHS = [4, 5, 6, 7, 8, 9, 10] as const;

export type SeasonalPlanFacts = {
  seasonal?: boolean | null;
  serviceMonths?: (number | null)[] | null;
};

/** The plan's service months, defaulting to the approved April–October set for
 *  a seasonal plan with no explicit list. Empty for non-seasonal plans. */
export function serviceMonthsOf(plan: SeasonalPlanFacts): number[] {
  if (!plan.seasonal) return [];
  const months = (plan.serviceMonths ?? []).filter(
    (m): m is number => typeof m === "number" && m >= 1 && m <= 12
  );
  return months.length ? [...months].sort((a, b) => a - b) : [...SEASONAL_SERVICE_MONTHS];
}

/** `YYYY-MM` for a date in America/New_York. */
export function monthKeyOf(dateIso: string): string {
  const d = new Date(dateIso);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(d);
  const year = parts.find((p) => p.type === "year")?.value ?? "1970";
  const month = parts.find((p) => p.type === "month")?.value ?? "01";
  return `${year}-${month}`;
}

/** Is this `YYYY-MM` month an in-season month for the plan? Non-seasonal plans
 *  treat every month as serviceable. */
export function isServiceMonth(plan: SeasonalPlanFacts, monthKey: string): boolean {
  if (!plan.seasonal) return true;
  const m = Number(monthKey.slice(5, 7));
  return serviceMonthsOf(plan).includes(m);
}

/**
 * The next in-season month key at-or-after `fromMonthKey`. October rolls to
 * next April, never November. Returns `fromMonthKey` itself when it is in
 * season (the caller decides whether that month is already satisfied).
 */
export function nextServiceMonth(
  plan: SeasonalPlanFacts,
  fromMonthKey: string
): string {
  if (!plan.seasonal) return fromMonthKey;
  const months = serviceMonthsOf(plan);
  let year = Number(fromMonthKey.slice(0, 4));
  let month = Number(fromMonthKey.slice(5, 7));
  for (let i = 0; i < 24; i++) {
    if (months.includes(month)) {
      return `${year}-${String(month).padStart(2, "0")}`;
    }
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return fromMonthKey;
}

/** The month key strictly after the given one. */
export function monthKeyAfter(monthKey: string): string {
  let year = Number(monthKey.slice(0, 4));
  let month = Number(monthKey.slice(5, 7)) + 1;
  if (month > 12) {
    month = 1;
    year += 1;
  }
  return `${year}-${String(month).padStart(2, "0")}`;
}

/** First weekday (Mon–Fri) of a `YYYY-MM` month, as `YYYY-MM-DD` — the target
 *  date the recurring engine aims a seasonal month's treatment at. */
export function firstWeekdayOf(monthKey: string): string {
  const year = Number(monthKey.slice(0, 4));
  const month = Number(monthKey.slice(5, 7));
  for (let day = 1; day <= 7; day++) {
    const d = new Date(Date.UTC(year, month - 1, day));
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      return `${monthKey}-${String(day).padStart(2, "0")}`;
    }
  }
  return `${monthKey}-01`;
}

/** Whether a plan name is a launch seasonal plan (mosquito / mosquito+tick).
 *  Used to stamp facts at enrollment when the offer carries no explicit flag —
 *  matching is deliberately generous on wording, never on behavior. */
export function isSeasonalPlanName(planName: string | null | undefined): boolean {
  const n = (planName ?? "").toLowerCase();
  return n.includes("mosquito");
}
