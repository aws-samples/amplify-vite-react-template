import { dataClient } from "../shared/dataClient";
import { driveMatrixFrom } from "../shared/driveTime";

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
 *   floor           never below 85% of base
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

export async function buildDayMatrix(opts: {
  routesKey: string | null;
  candidateAddress: string;
  service: string;
  baseCents: number;
  onsiteMinutes?: number;
}): Promise<DayQuote[]> {
  const { routesKey, candidateAddress, service, baseCents } = opts;
  const onsite =
    opts.onsiteMinutes ?? ONSITE_MINUTES[service] ?? 90;

  const client = await dataClient();
  const today = easternToday();
  const days = Array.from({ length: 32 }, (_, i) => addDays(today, i + 1))
    .filter(isWeekday)
    .slice(0, 22); // ~a month of business days

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

    const priceCents = tidyDollars(
      Math.max(baseCents * 0.85, baseCents * factor)
    );
    out.push({
      date,
      windows: ["MORNING", "AFTERNOON"],
      priceCents,
      factors,
    });
  }
  return out;
}
