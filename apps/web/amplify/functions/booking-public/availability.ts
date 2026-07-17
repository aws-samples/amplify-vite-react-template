import { dataClient } from "../shared/dataClient";
import { driveMatrixFrom } from "../shared/driveTime";
import { oneTimeGrossProfitCents, type Zone } from "../crm-pricing/rateCards";

/**
 * Schedule-aware availability + day pricing for the booking funnel.
 *
 * A day is offered when adding the stop keeps every constraint intact
 * (Mon–Fri, stop capacity, rough route-minutes feasibility), and its price
 * is the deterministic rate-card base times transparent modifiers:
 *
 *   route density   −10%  a stop already within 25 drive-min that day
 *   quiet day       −5%   day under half capacity
 *   nearly full     +10%  day at ≥85% capacity
 *   rush            +15%  inside 48 hours
 *   planner         −5%   three or more weeks out
 *   floor           never below 85% of base, and never below variable cost
 *
 * Identical inputs (same schedule state) → identical prices, always.
 */

const STOPS_PER_TECH = 8;
const WORKDAY_MINUTES = 8 * 60;
const AVG_HOP_MINUTES = 20; // typical drive between consecutive stops
const ONSITE_MINUTES: Record<string, number> = {
  GENERAL_PEST: 90,
  WASP_NEST: 60,
  RODENT: 90,
  ROACH: 90,
};

export type DayQuote = {
  date: string;
  windows: string[];
  priceCents: number;
  factors: string[]; // audit trail persisted with the quote
};

function easternToday(): string {
  return new Date().toLocaleDateString("en-CA", {
    timeZone: "America/New_York",
  });
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function isWeekday(iso: string): boolean {
  const dow = new Date(`${iso}T12:00:00Z`).getUTCDay();
  return dow >= 1 && dow <= 5;
}

const tidyDollars = (cents: number) => Math.round(cents / 100) * 100;

/**
 * R62: funnel service → variable-cost kind for the discount floor
 * (`oneTimeGrossProfitCents` in crm-pricing/rateCards). Without this mapping
 * the market-rate services had no cost model, so a discounted day could
 * price below what the visit costs to run. TERMITE and WILDLIFE have NO
 * entry on purpose: no deterministic cost model exists for that work, so no
 * cost floor applies — the same no-floor decision the engine records on
 * those rate rows' basis. The lookup keys on the pest service, so a
 * COMMERCIAL-property quote for a carded pest still borrows the residential
 * visit cost as a conservative lower bound (it can only raise a discounted
 * day, never lower it); COMMUNITY quotes never reach this floor — their day
 * prices are overwritten with the fixed plan total. The 85% discount floor
 * below still bounds every day.
 */
const COST_KIND: Record<string, string> = {
  GENERAL_PEST: "one_time_gpc",
  WASP_NEST: "wasp_nest",
  RODENT: "rodent_nest",
  // Same 90-minute onsite as rodent; gel bait + IGR + included follow-up
  // materials track the $55 rodent kit, not the $15 GPC kit.
  ROACH: "rodent_nest",
};

export async function buildDayMatrix(opts: {
  routesKey: string | null;
  candidateAddress: string;
  service: string;
  baseCents: number;
  /** Drive-time zone; enables the variable-cost discount floor (R62). */
  zone?: Zone;
  onsiteMinutes?: number;
  /** Restrict to a single day — the /book live re-check (R29). */
  onlyDate?: string;
}): Promise<DayQuote[]> {
  const { routesKey, candidateAddress, service, baseCents, zone } = opts;
  const onsite =
    opts.onsiteMinutes ?? ONSITE_MINUTES[service] ?? 90;

  // R62: a discount must never take a day below its variable cost. A Zone B
  // rodent quote at the $199 clamp floor used to discount to $169 against
  // ~$177 of drive + labor + materials — a loss on every such booking.
  // Services with no cost model (termite, wildlife, commercial, community)
  // skip this floor rather than borrowing another service's economics.
  const costKind = COST_KIND[service];
  const gp =
    zone != null && costKind != null
      ? oneTimeGrossProfitCents(costKind, baseCents, zone)
      : null;
  const costCents = gp != null ? baseCents - gp : null;

  const client = await dataClient();
  const today = easternToday();
  const days = Array.from({ length: 32 }, (_, i) => addDays(today, i + 1))
    .filter(isWeekday)
    .slice(0, 22) // ~a month of business days
    // onlyDate applies after the window slice: a date the quote could never
    // have offered must not become bookable through the re-check.
    .filter((d) => !opts.onlyDate || d === opts.onlyDate);

  const [techsRes, ...jobPages] = await Promise.all([
    client.models.Technician.list({ limit: 200 }),
    ...days.map((date) =>
      client.models.Job.listJobByScheduledDate(
        { scheduledDate: date },
        { limit: 200 }
      )
    ),
  ]);
  const techCount = Math.max(
    1,
    techsRes.data.filter((t) => t.active).length
  );
  const capacity = techCount * STOPS_PER_TECH;

  type Stop = { customerId: string; serviceType: string };
  const stopsByDay = new Map<string, Stop[]>();
  days.forEach((date, i) => {
    stopsByDay.set(
      date,
      jobPages[i].data.filter(
        (j) => j.status === "SCHEDULED" || j.status === "IN_PROGRESS"
      )
    );
  });

  // One matrix call: candidate → every distinct stop address in the window
  // (soonest days first — those are the ones density discounts care about).
  const addrByCustomer = new Map<string, string>();
  outer: for (const date of days) {
    for (const stop of stopsByDay.get(date) ?? []) {
      if (addrByCustomer.size >= 50) break outer;
      if (addrByCustomer.has(stop.customerId)) continue;
      addrByCustomer.set(stop.customerId, "");
    }
  }
  if (addrByCustomer.size > 0) {
    const customers = await Promise.all(
      [...addrByCustomer.keys()].map((id) =>
        client.models.Customer.get({ id })
      )
    );
    for (const { data: c } of customers) {
      if (!c) continue;
      const addr = [c.serviceStreet, c.serviceCity, c.serviceState, c.serviceZip]
        .filter(Boolean)
        .join(", ");
      if (addr) addrByCustomer.set(c.id, addr);
    }
  }
  const matrixCustomers = [...addrByCustomer.entries()].filter(([, a]) => a);
  const minutesByCustomer = new Map<string, number>();
  if (routesKey && matrixCustomers.length > 0) {
    const minutes = await driveMatrixFrom(
      routesKey,
      candidateAddress,
      matrixCustomers.map(([, a]) => a)
    );
    matrixCustomers.forEach(([id], i) => {
      const m = minutes[i];
      if (m != null) minutesByCustomer.set(id, m);
    });
  }

  const out: DayQuote[] = [];
  for (const date of days) {
    const stops = stopsByDay.get(date) ?? [];
    if (stops.length >= capacity) continue;

    // Rough feasibility: existing onsite time + hops + this job must fit.
    const existingMinutes = stops.reduce(
      (sum, s) => sum + (ONSITE_MINUTES[s.serviceType] ?? 60) + AVG_HOP_MINUTES,
      0
    );
    const nearest = stops.reduce<number | null>((best, s) => {
      const m = minutesByCustomer.get(s.customerId);
      return m != null && (best === null || m < best) ? m : best;
    }, null);
    const insertion = nearest != null ? nearest * 2 : AVG_HOP_MINUTES * 2;
    if (existingMinutes + onsite + insertion > techCount * WORKDAY_MINUTES) {
      continue;
    }

    let factor = 1;
    const factors: string[] = [];
    if (nearest != null && nearest <= 25) {
      factor -= 0.1;
      factors.push(`route-density −10% (stop ${nearest} min away)`);
    }
    const load = stops.length / capacity;
    if (load < 0.5) {
      factor -= 0.05;
      factors.push("quiet-day −5%");
    } else if (load >= 0.85) {
      factor += 0.1;
      factors.push("nearly-full +10%");
    }
    const daysOut = Math.round(
      (new Date(`${date}T12:00:00Z`).getTime() -
        new Date(`${today}T12:00:00Z`).getTime()) /
        86_400_000
    );
    if (daysOut <= 2) {
      factor += 0.15;
      factors.push("rush +15%");
    } else if (daysOut >= 21) {
      factor -= 0.05;
      factors.push("planner −5%");
    }

    let floored = Math.max(baseCents * 0.85, baseCents * factor);
    if (costCents != null && costCents > floored) {
      floored = costCents;
      factors.push("floored at variable cost");
    }
    const priceCents = tidyDollars(floored);
    out.push({
      date,
      windows: ["MORNING", "AFTERNOON"],
      priceCents,
      factors,
    });
  }
  return out;
}
