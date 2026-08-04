import { dataClient } from "../shared/dataClient";
import {
  bestSlotFor,
  dayEligibilityMap,
  makeLegResolver,
  slotStates,
  slotId,
  stopsBySlotOn,
  DAY_MINUTES,
  type SlotFeasibility,
} from "../shared/capacity";
import { oneTimeGrossProfitCents, type Zone } from "../crm-pricing/rateCards";
import { todayEastern } from "../shared/dates";

/**
 * Schedule-aware availability + day pricing for the booking funnel.
 *
 * A day is offered when adding the stop keeps every constraint intact
 * (Mon–Fri, stop capacity, rough route-minutes feasibility), and its price
 * is the deterministic rate-card base times transparent modifiers:
 *
 *   route density   −10/20/35%  a stop already within 25/15/5 drive-min that day
 *   quiet day       −5%   day under half capacity
 *   nearly full     +10%  day at ≥85% capacity
 *   planner         −5%   three or more weeks out
 *   floor           never below 60% of base, and never below variable cost
 *
 * Identical inputs (same schedule state) → identical prices, always.
 */

export type DayQuote = {
  date: string;
  /** GL-04: the feasibility behind the offered day — which technician's slot
   *  absorbs the stop and for how many minutes (on-site + real Routes legs).
   *  Checkout claims exactly this. */
  slot?: SlotFeasibility;
  priceCents: number;
  /**
   * The PLAN's first-visit fee for this day, when a recurring offer was made.
   * The monthly rate never moves — a durable discount off a transient route
   * snapshot would outlive the density that justified it — but the first visit
   * is one dated piece of work, so the day's route factor applies to it exactly
   * as it does to a one-time price.
   *
   * This is the highest-leverage place to put the discount: `pickTechDayNear`
   * schedules every LATER visit onto the same technician's least-marginal-travel
   * day near the address, so steering the first visit onto a dense day seeds the
   * cluster the whole plan inherits.
   *
   * Discount-only — never above the plan's list fee (see below).
   */
  planInitialFeeCents?: number;
  factors: string[]; // audit trail persisted with the quote
};

export function addDays(iso: string, n: number): string {
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
  /** The recurring offer's list first-visit fee, when a plan was offered. Given
   *  it, each day also carries its own discounted `planInitialFeeCents`. */
  planInitialFeeCents?: number;
  onsiteMinutes?: number;
  /** Restrict to a single day — the /book live re-check (R29). */
  onlyDate?: string;
}): Promise<DayQuote[]> {
  const { routesKey, candidateAddress, service, baseCents, zone } = opts;

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
  const today = todayEastern();
  const days = Array.from({ length: 32 }, (_, i) => addDays(today, i + 1))
    .filter(isWeekday)
    .slice(0, 22) // ~a month of business days
    // onlyDate applies after the window slice: a date the quote could never
    // have offered must not become bookable through the re-check.
    .filter((d) => !opts.onlyDate || d === opts.onlyDate);

  // GL-04: the locked on-site durations by PROPERTY CLASS — residential 30,
  // commercial/community 60. The class lives on propertyKind, never on the
  // pest-service enum, so callers MUST derive and pass it; the bare fallback
  // is the residential floor.
  const onsite = opts.onsiteMinutes ?? 30;

  // GL-04: per-day eligibility (weekday, closures, PTO, licences, roster —
  // every read failure sells zero) with each technician's PRIVATE base (or
  // that day's override). One roster/licence read for the whole window.
  const eligibilityByDate = await dayEligibilityMap(days);

  // ONE memoized Routes resolver for the whole calendar: base ↔ candidate
  // legs are computed once per technician, candidate → stop legs once per
  // unique stop address. No key ⇒ every leg is null ⇒ zero sellable days
  // (fail closed — capacity is never sold on guessed travel).
  const legMinutes = makeLegResolver(routesKey);

  // One day's price depends only on that day's own capacity and stops — days
  // never read each other. Built serially, a ~22-day board was 22 round-trip
  // chains end to end and took 21-32s, the single largest component of a
  // quote once AI research was fixed. Waves of DAY_CONCURRENCY keep the read
  // burst bounded while collapsing the wall clock to roughly the slowest day
  // per wave. Order is preserved: waves run in sequence and Promise.all
  // resolves in input order, so the board still reads soonest-first.
  //
  // This is only safe because legMinutes memoizes the in-flight promise
  // rather than the resolved value (see makeLegResolver). With a value-memo,
  // concurrent days all miss on the same leg and each pay for its own billed
  // Routes call — the latency win would come straight out of the Routes bill.
  const DAY_CONCURRENCY = 6;

  const quoteForDay = async (date: string): Promise<DayQuote | null> => {
    const eligibility = eligibilityByDate.get(date) ?? {
      techs: [],
      reasons: ["Unknown date."],
    };
    if (eligibility.techs.length === 0) return null;

    const [slots, stops] = await Promise.all([
      slotStates(date),
      stopsBySlotOn(date),
    ]);

    // Day feasibility: the day offers only if some technician's slot can
    // absorb this stop's on-site + real marginal Routes legs.
    const slot = await bestSlotFor({
      date,
      onsite,
      eligibility,
      slots,
      stopsBySlot: stops,
      legMinutes,
      candidateAddress,
    });
    if (!slot) return null;

    // Pricing modifiers, from the day's real load and proximity.
    let stopCount = 0;
    let committed = 0;
    let capacity = 0;
    for (const t of eligibility.techs) {
      capacity += DAY_MINUTES;
      const state = slots.get(slotId(date, t.id));
      committed += state?.committedMinutes ?? 0;
      stopCount += (stops.get(slotId(date, t.id)) ?? []).length;
    }
    // Route density reflects the tech we will actually book (bestSlotFor's
    // choice): the nearest existing stop in THAT tech's route, so the discount
    // and the auto-assignment always name the same technician.
    const nearest = slot.nearestStopMinutes;

    let factor = 1;
    const factors: string[] = [];
    if (nearest != null && nearest <= 25) {
      // Graduated by real proximity: a stop on the adjacent parcel is nearly
      // free travel and earns far more than one 25 minutes away. If we're
      // already going to be right there, we want to fill the slot, not tax it.
      const pct = nearest <= 5 ? 0.35 : nearest <= 15 ? 0.2 : 0.1;
      factor -= pct;
      factors.push(
        `route-density −${Math.round(pct * 100)}% (stop ${nearest} min away)`
      );
    }
    const load = capacity > 0 ? committed / capacity : 1;
    void stopCount;
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
    if (daysOut >= 21) {
      factor -= 0.05;
      factors.push("planner −5%");
    }

    // Policy floor lets the deepest configured discount land (−35% next-door,
    // plus a −5% quiet/planner stack); real margin is protected by the R62
    // variable-cost floor below.
    let floored = Math.max(baseCents * 0.6, baseCents * factor);
    if (costCents != null && costCents > floored) {
      floored = costCents;
      factors.push("floored at variable cost");
    }
    const priceCents = tidyDollars(floored);

    // The plan's first visit, priced on the same day factor.
    //
    // DISCOUNT-ONLY, deliberately: the plan card states one list fee ("$149 is
    // due for your first visit"), so a nearly-full day that RAISES a one-time
    // price must not make a tile contradict the offer above it. The factor can
    // only ever pull this number down.
    //
    // Floors: never under 60% of the list fee, and never under the visit's
    // variable cost — borrowed from the one-time cost model because the first
    // plan visit is the same physical work (same on-site minutes, same drive).
    // The discount-only cap runs LAST, so a plan whose fee is DELIBERATELY
    // under cost (a loss-leader first visit) is held at list rather than marked
    // up by a floor that exists to stop discounts going too deep.
    //
    // Services with no cost model — community/HOA above all — get the 60%
    // policy floor ALONE. That is the same R62 gap the one-time path documents;
    // it bounds the give, but it does not prove margin.
    let planInitialFeeCents: number | undefined;
    const listFee = opts.planInitialFeeCents;
    if (listFee != null && listFee > 0) {
      // Each rule applies EXACTLY once, in order, so no two of them can quietly
      // enforce the same bound and mask a regression in the other.
      let fee = listFee * factor; // 1. the day's own factor
      fee = Math.max(fee, listFee * 0.6); // 2. policy floor
      if (costCents != null) fee = Math.max(fee, costCents); // 3. cost floor
      // 4. Discount-only, and the LAST word — which is also what stops the cost
      //    floor above from marking up a deliberate loss-leader first visit.
      planInitialFeeCents = Math.min(tidyDollars(fee), listFee);
      if (planInitialFeeCents < listFee) {
        factors.push(
          `plan first visit ${Math.round((1 - planInitialFeeCents / listFee) * 100)}% off list`
        );
      }
    }

    return {
      date,
      slot,
      priceCents,
      ...(planInitialFeeCents != null ? { planInitialFeeCents } : {}),
      factors,
    };
  };

  const out: DayQuote[] = [];
  for (let i = 0; i < days.length; i += DAY_CONCURRENCY) {
    const wave = await Promise.all(
      days.slice(i, i + DAY_CONCURRENCY).map(quoteForDay)
    );
    for (const day of wave) {
      if (day) out.push(day);
    }
  }
  return out;
}
