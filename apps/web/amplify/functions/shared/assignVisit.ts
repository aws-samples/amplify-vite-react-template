import { dataClient } from "./dataClient";
import { casGuardedUpdate } from "./atomicLock";
import { forEachPage } from "./pagination";
import {
  bestSlotFor,
  dayEligibility,
  makeLegResolver,
  releaseSlot,
  reserveSlot,
  slotStates,
  stopsBySlotOn,
  type DayEligibility,
} from "./capacity";
import { resequenceAndRebuildDay } from "./routeOptimizer";

/** Add days to a YYYY-MM-DD date, returning YYYY-MM-DD (UTC-noon anchored). */
function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function isWeekday(isoDate: string): boolean {
  const dow = new Date(`${isoDate}T12:00:00Z`).getUTCDay();
  return dow >= 1 && dow <= 5;
}

/**
 * Find the best day for ONE technician to take a new stop, within a window of
 * weekdays starting at `fromDate`. "Best" is the day that adds the LEAST
 * marginal travel to that tech's existing route (they are already near the
 * address) while keeping the day under the eight-stop / minutes ceilings — the
 * very feasibility `bestSlotFor` scores for the funnel, but pinned to one tech
 * across a span of days instead of one day across all techs.
 *
 * Returns null when the tech is full / off / unroutable on every candidate day
 * (the caller then leaves the visit in the office pool) or when facts can't be
 * verified. Best-effort and fail-closed: capacity is never sold on guessed
 * travel, so a missing Routes key or a read failure yields null, never a blind
 * assignment.
 */
export async function pickTechDayNear(opts: {
  technicianId: string;
  candidateAddress: string;
  /** First weekday to consider — the plan's target due date. */
  fromDate: string;
  /** How many calendar days forward to scan for fitting weekdays. */
  windowDays: number;
  /** Locked on-site minutes for the visit's property class. */
  onsite: number;
  routesKey: string | null;
}): Promise<{ date: string; minutes: number } | null> {
  const { technicianId, candidateAddress, onsite } = opts;
  if (!candidateAddress || !opts.routesKey) return null;
  const legMinutes = makeLegResolver(opts.routesKey);
  let best: { date: string; minutes: number } | null = null;
  for (let i = 0; i <= opts.windowDays; i++) {
    const date = addDays(opts.fromDate, i);
    if (!isWeekday(date)) continue;
    let eligibility: DayEligibility;
    try {
      eligibility = await dayEligibility(date);
    } catch {
      continue; // a day whose roster can't be read sells nothing here
    }
    // Pin the feasibility scan to the one technician we mean to keep — an
    // eligibility list of just this tech makes bestSlotFor answer "can THIS
    // tech take it, and how cheaply" instead of picking any tech.
    const mine = eligibility.techs.filter((t) => t.id === technicianId);
    if (mine.length === 0) continue; // tech off / unlicensed / closed that day
    const slots = await slotStates(date);
    const stops = await stopsBySlotOn(date);
    const feas = await bestSlotFor({
      date,
      onsite,
      eligibility: { techs: mine, reasons: eligibility.reasons },
      slots,
      stopsBySlot: stops,
      legMinutes,
      candidateAddress,
    });
    if (!feas) continue;
    // Cheapest marginal travel wins; a strict-improvement replace keeps the
    // EARLIEST day on ties, so the visit stays as close to its cadence date as
    // the route allows.
    if (!best || feas.claimMinutes < best.minutes) {
      best = { date, minutes: feas.claimMinutes };
    }
  }
  return best;
}

/** Find-or-create the technician's route for a date and the next append order
 *  on it. Returns null when the route can neither be read nor created — the
 *  caller then leaves the visit as an unassigned hold. Mirrors the funnel's
 *  private `ensureRouteAndOrder` (kept local so this path never pulls the heavy
 *  booking-finalize module into its bundle). */
async function ensureRouteAndOrder(
  technicianId: string,
  date: string
): Promise<{ routeId: string; routeOrder: number } | null> {
  const client = await dataClient();
  if (!("Route" in client.models)) return null;
  const routeModel = (
    client.models as unknown as {
      Route: {
        listRouteByTechnicianIdAndDate: (
          input: { technicianId: string; date: string },
          opts?: { limit?: number }
        ) => Promise<{ data: { id: string }[] }>;
        create: (input: {
          technicianId: string;
          date: string;
          status: string;
        }) => Promise<{ data: { id: string } | null }>;
      };
    }
  ).Route;
  let routeId: string | null = null;
  try {
    // limit 1 is deliberate: one route per tech-day by design. Duplicate routes are a known separate defect; the read-side union lives in technicianReads.
    const { data: routes } = await routeModel.listRouteByTechnicianIdAndDate(
      { technicianId, date },
      { limit: 1 }
    );
    routeId = routes?.[0]?.id ?? null;
  } catch {
    /* fall through to create */
  }
  if (!routeId) {
    const { data: created } = await routeModel
      .create({ technicianId, date, status: "PLANNED" })
      .catch(() => ({ data: null }));
    routeId = created?.id ?? null;
  }
  if (!routeId) return null;
  // Append after the route's last stop. There is no by-route Job index, so
  // scan the date and take the max order already on this route.
  let maxOrder = 0;
  await forEachPage(
    (nextToken) =>
      client.models.Job.listJobByScheduledDate(
        { scheduledDate: date },
        { limit: 200, nextToken }
      ),
    (items) => {
      for (const j of items) {
        if (j.routeId === routeId && typeof j.routeOrder === "number") {
          maxOrder = Math.max(maxOrder, j.routeOrder);
        }
      }
    },
    { pageErrors: "ignore" }
  );
  return { routeId, routeOrder: maxOrder + 1 };
}

/**
 * Move an existing UNSCHEDULED pool visit onto a technician's day as a real
 * SCHEDULED stop: take the day's stop + minutes atomically, then stamp the
 * assignment onto the job under a CAS guard so a concurrent office assignment
 * always wins over this automatic one. Re-sequences the tech's day afterwards.
 *
 * Best-effort — returns false (never throws) when the route/stop can't be
 * taken or the guarded stamp loses, and gives back anything it reserved so the
 * capacity ledger never leaks. On false the caller keeps the visit in the pool.
 */
export async function assignVisitToTech(opts: {
  jobId: string;
  date: string;
  technicianId: string;
  minutes: number;
}): Promise<boolean> {
  const { jobId, date, technicianId, minutes } = opts;
  try {
    const route = await ensureRouteAndOrder(technicianId, date);
    if (!route) return false;
    const stop = await reserveSlot(date, technicianId, minutes, { stops: 1 });
    if (!stop.ok) return false;
    // GUARDED: the stamp lands only while the visit is still the untouched
    // auto-queued pool hold (no technician, still UNSCHEDULED). If the office
    // grabbed it first, we LOSE and hand back the minutes + stop just taken.
    const stamped = await casGuardedUpdate(
      "Job",
      jobId,
      {
        scheduledDate: date,
        technicianId,
        routeId: route.routeId,
        routeOrder: route.routeOrder,
        status: "SCHEDULED",
        capacityMinutes: minutes,
        // Assigned for real now — the hold rides on technicianId.
        capacityTechnicianId: null,
      },
      [
        { kind: "fieldMissingOrNull", field: "technicianId" },
        { kind: "fieldEquals", field: "status", value: "UNSCHEDULED" },
      ]
    ).catch(() => ({ ok: false as const }));
    if (!stamped.ok) {
      await releaseSlot(date, technicianId, minutes, { stops: 1 }).catch(
        () => undefined
      );
      return false;
    }
    // Scheduled onto a real technician's day — re-sequence their route into the
    // shortest base → stops → base tour and rebuild the day's capacity ledger
    // from that tour. Best-effort; a Routes hiccup leaves the appended order and
    // the prior ledger untouched.
    await resequenceAndRebuildDay({ technicianId, date });
    return true;
  } catch (err) {
    console.error("assignVisitToTech failed (non-fatal)", err);
    return false;
  }
}
