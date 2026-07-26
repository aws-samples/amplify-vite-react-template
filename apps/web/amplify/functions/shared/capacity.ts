import { dataClient } from "./dataClient";
import { casGuardedAdd, casGuardedUpdate , type LockCondition } from "./atomicLock";
import { onsiteMinutesFor } from "./dispatchReadiness";
import { driveMinutesBetween, HQ_ADDRESS } from "./driveTime";
import { licenseFactsFromRecords, licenseRecordsFor } from "./licenses";
import { openOwnedWork } from "./ownedWork";
import { routingAddress } from "./serviceAddress";

/**
 * GL-04 — the ONE capacity rule: PER-TECHNICIAN, PER-DAY minute feasibility,
 * shared by the funnel calendar, checkout, dispatch, and office reschedules.
 *
 *  - The working day is Monday–Friday, 8:00–5:00 Eastern (540 min). We
 *    schedule for the DAY, not a time-of-day window: each technician-day is
 *    its own ledger slot, and one technician's free time never hides
 *    another's overload.
 *  - A visit consumes its locked on-site minutes (residential 30;
 *    commercial/community 60) plus REAL Google Routes travel legs measured
 *    from the technician's private base (or that day's reasoned
 *    BASE_OVERRIDE, else HQ): base → first stop → successive stops → base.
 *    There is no default travel constant and no average-hop guess — a leg
 *    Routes cannot produce makes the slot infeasible (fail closed).
 *  - Weekends, company closures, per-day PTO, inactive status, and licence
 *    problems (including unreadable records — fail closed) remove the
 *    technician's slot entirely; zero eligible technicians sells zero.
 *  - Committed minutes live on ONE CapacityDay row per technician-day,
 *    maintained by ATOMIC guarded adds: taking minutes succeeds only while
 *    the fit condition (≤ the day's minutes) holds in the same write, so two
 *    concurrent purchases or office moves can never both take a slot's last
 *    minutes. Missing models or CAS wiring REFUSE (fail closed) — never
 *    permissive success.
 *  - A checkout attempt claims a SPECIFIC technician-day slot BEFORE the
 *    payment attempt (CapacityClaim carries the slot and the address so
 *    later routing sees the stop); success consumes it into the booked job
 *    (the job carries the stamped minutes), an accepted pending bank debit
 *    extends it, failure releases it, and the nightly rebuild re-derives
 *    every slot from its jobs with real Routes legs — a slot whose legs
 *    can't be verified sells nothing until they can.
 */

/** The working day is 8:00–5:00 Eastern — 540 sellable minutes per
 *  technician (travel + on-site). */
export const DAY_MINUTES = 540;

/** How long a card checkout may hold a claim before the sweep releases it. */
export const CHECKOUT_CLAIM_MS = 45 * 60_000;

/** How long an accepted pending bank debit keeps its claim while settling. */
export const PROCESSING_CLAIM_MS = 7 * 24 * 60 * 60_000;

/** The pseudo-technician slot that ACCOUNTS FOR pending-assignment (pool)
 *  visits on the Operations readout without blocking a real slot — a pool
 *  visit becomes a confirmed commitment only through the real assign claim. */
export const POOL_TECH = "POOL";

/** GL-07: one route is one technician-day of at most this many ASSIGNED
 *  stops — the coarse day ceiling alongside the per-day minutes ledger. */
export const STOPS_PER_TECH = 8;

/** GL-07: the id of a technician-day row on the DEDICATED TechDayStops
 *  ledger model — its own table, so CapacityDay slot/index readers can
 *  never see a stop row and the required-field create contract is honest. */
export function dayStopId(date: string, technicianId: string): string {
  return `${date}#${technicianId}`;
}

export function isWeekday(date: string): boolean {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  return dow >= 1 && dow <= 5;
}

export function slotId(date: string, technicianId: string): string {
  return `${date}#${technicianId}`;
}

/** The locked on-site duration for a visit (residential 30; commercial and
 *  community 60) — property class is the ONLY input. */
export function onsiteMinutes(propertyClass: string | null | undefined): number {
  return onsiteMinutesFor(propertyClass);
}

// ---------------------------------------------------------------------------
// Model availability — FAIL CLOSED
// ---------------------------------------------------------------------------

async function capacityModelsReady(): Promise<boolean> {
  const client = await dataClient();
  const m = client.models as Record<string, unknown>;
  return (
    "CapacityDay" in m &&
    "CapacityClaim" in m &&
    "TechDayStops" in m &&
    typeof (m.Technician as { list?: unknown } | undefined)?.list ===
      "function" &&
    typeof (m.Job as { listJobByScheduledDate?: unknown } | undefined)
      ?.listJobByScheduledDate === "function"
  );
}

export type ClaimOutcome =
  | { ok: true }
  | { ok: false; soldOut: boolean; unavailable?: boolean; message: string };

const UNAVAILABLE: ClaimOutcome = {
  ok: false,
  soldOut: false,
  unavailable: true,
  message:
    "The capacity ledger can't be verified right now — nothing was scheduled. Try again in a moment.",
};

// ---------------------------------------------------------------------------
// Eligibility: who works this date, and from which base
// ---------------------------------------------------------------------------

export type EligibleTech = {
  id: string;
  name: string;
  /** The private office-managed base (or the day's override, else HQ). */
  baseAddress: string;
};

export type DayEligibility = {
  /** Empty ⇒ the date sells nothing; `reasons` says exactly why. */
  techs: EligibleTech[];
  reasons: string[];
};

type TechRow = {
  id: string;
  name?: string | null;
  active?: boolean | null;
  licenseNumber?: string | null;
  licenseExpiresOn?: string | null;
  baseStreet?: string | null;
  baseCity?: string | null;
  baseState?: string | null;
  baseZip?: string | null;
};

function baseAddressOf(t: TechRow): string {
  const parts = [t.baseStreet, t.baseCity, t.baseState, t.baseZip]
    .map((p) => p?.trim())
    .filter(Boolean);
  return parts.length >= 2 ? parts.join(", ") : HQ_ADDRESS;
}

/** The technician's configured base, or null when it was never set. Unlike
 *  `baseAddressOf` this never falls back to a company HQ — there is no company
 *  HQ, so an unconfigured technician contributes no service area at all. */
function configuredBaseOf(t: TechRow): string | null {
  const parts = [t.baseStreet, t.baseCity, t.baseState, t.baseZip]
    .map((p) => p?.trim())
    .filter(Boolean);
  return parts.length >= 2 ? parts.join(", ") : null;
}

/**
 * Every active technician's home base, deduped — the origin set the service
 * area is measured from.
 *
 * BuzzKill has no central base: a technician starts and ends the day at their
 * own home, so a customer is "far" only if they are far from EVERY technician.
 * Quote-time zone used to measure from a hard-coded HQ instead, which priced
 * the travel adder off a point no truck departs from and refused addresses
 * that a technician actually lives minutes away from.
 *
 * Returns null when the roster can't be read or no technician has a base
 * configured. The caller must treat null as "unknown" and fall back to the
 * callback path — never as "out of area", which would silently refuse
 * customers on an infrastructure failure.
 */
export async function activeTechBases(): Promise<string[] | null> {
  if (!(await capacityModelsReady())) return null;
  const techs: TechRow[] = [];
  // The client is created INSIDE the try and never annotated: naming
  // `Awaited<ReturnType<typeof dataClient>>` trips TS2321 (excessive stack
  // depth) — `tsc -p amplify` already sits at the depth ceiling.
  try {
    const client = await dataClient();
    let token: string | null | undefined;
    do {
      const page = await client.models.Technician.list({
        limit: 200,
        nextToken: token,
      });
      techs.push(...((page.data ?? []) as TechRow[]));
      token = page.nextToken;
    } while (token);
  } catch (err) {
    console.error("activeTechBases: roster read failed", err);
    return null;
  }
  const bases = new Set<string>();
  for (const t of techs) {
    if (!t.active) continue;
    const base = configuredBaseOf(t);
    if (base) bases.add(base);
  }
  if (bases.size === 0) {
    console.error(
      "activeTechBases: no active technician has a base configured — service area is undeterminable"
    );
    return null;
  }
  return [...bases];
}

/**
 * Batch eligibility for a calendar window: ONE roster + licence read reused
 * for every date; closures/PTO/overrides read per date. Every read failure
 * fails CLOSED (the date sells nothing) — capacity is never sold blind.
 */
export async function dayEligibilityMap(
  dates: string[]
): Promise<Map<string, DayEligibility>> {
  const out = new Map<string, DayEligibility>();
  const closedAll = (why: string) => {
    for (const date of dates) out.set(date, { techs: [], reasons: [why] });
    return out;
  };
  if (!(await capacityModelsReady())) {
    return closedAll(
      "The capacity models are unavailable — selling capacity blind is not allowed."
    );
  }
  const client = await dataClient();

  const techs: TechRow[] = [];
  try {
    let token: string | null | undefined;
    do {
      const page = await client.models.Technician.list({
        limit: 200,
        nextToken: token,
      });
      techs.push(...((page.data ?? []) as TechRow[]));
      token = page.nextToken;
    } while (token);
  } catch (err) {
    console.error("dayEligibilityMap: roster read failed", err);
    return closedAll(
      "The technician roster could not be read — selling capacity blind is not allowed."
    );
  }
  const active = techs.filter((t) => t.active);
  const recordsByTech = new Map<
    string,
    Awaited<ReturnType<typeof licenseRecordsFor>>
  >();
  for (const t of active) {
    recordsByTech.set(t.id, await licenseRecordsFor(t.id));
  }

  for (const date of dates) {
    if (!isWeekday(date)) {
      out.set(date, {
        techs: [],
        reasons: ["Weekend — technicians work Monday–Friday."],
      });
      continue;
    }
    // Company closure: a READ FAILURE fails closed — "couldn't check" is not
    // "open for business".
    let closureReason: string | null = null;
    if ("CompanyClosure" in client.models) {
      try {
        const { data: closure } = await client.models.CompanyClosure.get({
          id: date,
        });
        closureReason = closure?.reason ?? null;
      } catch (err) {
        console.error("dayEligibilityMap: closure read failed", date, err);
        out.set(date, {
          techs: [],
          reasons: [
            "The closure calendar could not be read — selling capacity blind is not allowed.",
          ],
        });
        continue;
      }
    }
    if (closureReason) {
      out.set(date, {
        techs: [],
        reasons: [`Company closure: ${closureReason}.`],
      });
      continue;
    }
    const onPto = new Set<string>();
    const overrideByTech = new Map<string, string>();
    if ("TechnicianDayException" in client.models) {
      try {
        let token: string | null | undefined;
        do {
          const page =
            await client.models.TechnicianDayException.listTechnicianDayExceptionByDate(
              { date },
              { limit: 200, nextToken: token }
            );
          for (const ex of page.data ?? []) {
            if (ex.kind === "PTO") onPto.add(ex.technicianId);
            if (ex.kind === "BASE_OVERRIDE") {
              const parts = [
                ex.overrideStreet,
                ex.overrideCity,
                ex.overrideState,
                ex.overrideZip,
              ]
                .map((p) => p?.trim())
                .filter(Boolean);
              if (parts.length >= 2) {
                overrideByTech.set(ex.technicianId, parts.join(", "));
              }
            }
          }
          token = page.nextToken;
        } while (token);
      } catch (err) {
        console.error("dayEligibilityMap: exception read failed", date, err);
        out.set(date, {
          techs: [],
          reasons: [
            "The availability exceptions could not be read — selling capacity blind is not allowed.",
          ],
        });
        continue;
      }
    }
    const reasons: string[] = [];
    const eligible: EligibleTech[] = [];
    for (const t of active) {
      if (onPto.has(t.id)) {
        reasons.push(`${t.name ?? t.id} is on PTO.`);
        continue;
      }
      const records = recordsByTech.get(t.id) ?? null;
      if (records === null) {
        reasons.push(
          `${t.name ?? t.id}'s licence records could not be read (fail closed).`
        );
        continue;
      }
      if (!licenseFactsFromRecords(records, t, date).current) {
        reasons.push(`${t.name ?? t.id} has no current licence on ${date}.`);
        continue;
      }
      eligible.push({
        id: t.id,
        name: t.name ?? t.id,
        baseAddress: overrideByTech.get(t.id) ?? baseAddressOf(t),
      });
    }
    if (eligible.length === 0) {
      reasons.push("No eligible technician — the day sells nothing.");
    }
    out.set(date, { techs: eligible, reasons });
  }
  return out;
}

export async function dayEligibility(date: string): Promise<DayEligibility> {
  return (await dayEligibilityMap([date])).get(date)!;
}

/** The technician's base for a date (override-aware). Null = the technician
 *  is not eligible that day, or the facts could not be read (fail closed). */
export async function techBaseFor(
  technicianId: string,
  date: string
): Promise<string | null> {
  const day = await dayEligibility(date);
  return day.techs.find((t) => t.id === technicianId)?.baseAddress ?? null;
}

// ---------------------------------------------------------------------------
// Slot ledger reads
// ---------------------------------------------------------------------------

export type SlotState = {
  technicianId: string;
  committedMinutes: number;
  verified: boolean;
};

/** Every slot row for a date (absent row = empty, verified). */
export async function slotStates(
  date: string
): Promise<Map<string, SlotState>> {
  const out = new Map<string, SlotState>();
  const client = await dataClient();
  if (!("CapacityDay" in client.models)) return out;
  let token: string | null | undefined;
  do {
    const page = await client.models.CapacityDay.listCapacityDayByDate(
      { date },
      { limit: 200, nextToken: token }
    );
    for (const row of page.data ?? []) {
      if (!row.technicianId) continue;
      out.set(row.id, {
        technicianId: row.technicianId,
        committedMinutes: row.committedMinutes ?? 0,
        verified: row.verified !== false,
      });
    }
    token = page.nextToken;
  } while (token);
  return out;
}

/** Live (unexpired) claims for a date, with their slot bindings. */
export async function liveClaimsOn(date: string): Promise<
  {
    id: string;
    technicianId: string;
    minutes: number;
    address: string | null;
  }[]
> {
  const client = await dataClient();
  if (!("CapacityClaim" in client.models)) return [];
  const nowIso = new Date().toISOString();
  const out: {
    id: string;
    technicianId: string;
    minutes: number;
    address: string | null;
  }[] = [];
  let token: string | null | undefined;
  do {
    const page = await client.models.CapacityClaim.listCapacityClaimByDate(
      { date },
      { limit: 200, nextToken: token }
    );
    for (const claim of page.data ?? []) {
      if (String(claim.expiresAt) <= nowIso) continue;
      out.push({
        id: claim.id,
        technicianId: claim.technicianId ?? POOL_TECH,
        minutes: claim.minutes ?? 0,
        address: claim.address ?? null,
      });
    }
    token = page.nextToken;
  } while (token);
  return out;
}

async function ensureSlot(
  date: string,
  technicianId: string
): Promise<void> {
  const client = await dataClient();
  if (!("CapacityDay" in client.models)) return;
  await client.models.CapacityDay.create({
    id: slotId(date, technicianId),
    date,
    technicianId,
    committedMinutes: 0,
    verified: true,
  }).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Atomic slot writes — FAIL CLOSED on UNSUPPORTED
// ---------------------------------------------------------------------------

/**
 * Atomically take `minutes` on one technician-day slot: ONE guarded add
 * conditioned on the result fitting the day. Exactly one of two concurrent
 * takers of the last minutes wins. Missing models or CAS wiring REFUSE — an
 * unverifiable ledger schedules nothing.
 */
export async function reserveSlot(
  date: string,
  technicianId: string,
  minutes: number,
  opts?: {
    /** GL-07: reserve this many ASSIGNED stops on the technician's DAY in
     *  the same claim (0 for checkout holds). Each ceiling is one guarded
     *  conditional write; a minutes refusal after a won stop compensates the
     *  stop, so a failed claim never leaks. */
    stops?: number;
  }
): Promise<ClaimOutcome> {
  if (!(await capacityModelsReady())) return UNAVAILABLE;
  const stops = opts?.stops ?? 0;
  if (stops > 0) {
    const stopRowId = dayStopId(date, technicianId);
    // The guarded add REQUIRES the row to exist (the CAS layer conditions on
    // attribute_exists) — a row that could not be created or read back is an
    // honest refusal, never a silent "day full".
    if (!(await ensureDayStopRow(date, technicianId))) return UNAVAILABLE;
    const stopRes = await casGuardedAdd(
      "TechDayStops",
      stopRowId,
      { committedStops: stops },
      [
        {
          kind: "fieldAtMostOrMissing",
          field: "committedStops",
          value: STOPS_PER_TECH - stops,
        },
      ]
    );
    if (!stopRes.ok) {
      if (stopRes.reason === "UNSUPPORTED") return UNAVAILABLE;
      return {
        ok: false,
        soldOut: true,
        message: `That technician's day is full (${STOPS_PER_TECH} stops). Pick another day or technician.`,
      };
    }
  }
  await ensureSlot(date, technicianId);
  const id = slotId(date, technicianId);
  const res = await casGuardedAdd(
    "CapacityDay",
    id,
    { committedMinutes: minutes },
    [
      {
        kind: "fieldAtMostOrMissing",
        field: "committedMinutes",
        value: DAY_MINUTES - minutes,
      },
    ]
  );
  if (res.ok) return { ok: true };
  if (stops > 0) {
    // The minutes ceiling refused after the stop was won — give the stop
    // back so a failed claim leaks nothing.
    await casGuardedAdd(
      "TechDayStops",
      dayStopId(date, technicianId),
      { committedStops: -stops },
      [{ kind: "fieldAtLeast", field: "committedStops", value: stops }]
    ).catch(() => undefined);
  }
  if (res.reason === "UNSUPPORTED") return UNAVAILABLE;
  // A day the nightly rebuild could not measure is pinned at the full window on
  // purpose (fail closed) — so it refuses with the SAME shape as a genuinely
  // full day. Saying "fully booked" there is a lie that sends the office
  // hunting for space on a day that may be nearly empty; the real fix is one
  // unroutable address. Read the row only on this refusal path and say so.
  const slot = (await slotStates(date)).get(slotId(date, technicianId));
  if (slot && !slot.verified) {
    return {
      ok: false,
      soldOut: false,
      message:
        "That technician's day can't be routed — one of its stops has an address we can't find, so the day is held until it's fixed. See the exceptions queue, or pick another day.",
    };
  }
  return {
    ok: false,
    soldOut: true,
    message: `That day is now fully booked — pick another day.`,
  };
}

/** Create the technician-day stop row if absent — with EVERY required field
 *  of the real AppSync contract. Returns false only when the row neither got
 *  created nor already exists; callers must refuse honestly, not proceed. */
async function ensureDayStopRow(
  date: string,
  technicianId: string
): Promise<boolean> {
  const client = await dataClient();
  const m = client.models as unknown as Record<
    string,
    {
      create: (input: Record<string, unknown>) => Promise<{
        data: unknown;
        errors?: { message: string }[];
      }>;
      get: (input: { id: string }) => Promise<{ data: unknown }>;
    }
  >;
  if (!("TechDayStops" in m)) return false;
  const id = dayStopId(date, technicianId);
  let createErrors: { message: string }[] | undefined;
  try {
    const res = await m.TechDayStops.create({
      id,
      date,
      technicianId,
      committedStops: 0,
    });
    if (res.data) return true;
    createErrors = res.errors;
  } catch (err) {
    createErrors = [{ message: err instanceof Error ? err.message : String(err) }];
  }
  // A conditional-create conflict (the row already exists) is success; any
  // other failure is surfaced — never swallowed into a phantom "day full".
  try {
    const { data: existing } = await m.TechDayStops.get({ id });
    if (existing) return true;
  } catch {
    // fall through to the honest failure below
  }
  console.error(
    `ensureDayStopRow: stop-ledger row ${id} could not be created or read back`,
    createErrors ?? []
  );
  return false;
}

/** Give slot minutes back (a canceled/moved-off visit or a released claim).
 *  Guarded to never go negative; UNSUPPORTED leaves the minutes held (the
 *  safe direction — the nightly rebuild reclaims them from ground truth). */
export async function releaseSlot(
  date: string,
  technicianId: string,
  minutes: number,
  opts?: { stops?: number }
): Promise<void> {
  const client = await dataClient();
  if (!("CapacityDay" in client.models)) return;
  await casGuardedAdd(
    "CapacityDay",
    slotId(date, technicianId),
    { committedMinutes: -minutes },
    [{ kind: "fieldAtLeast", field: "committedMinutes", value: minutes }]
  );
  const stops = opts?.stops ?? 0;
  if (stops > 0) {
    // Independently guarded so drift in one counter can never leak the
    // other; the nightly rebuild converges both from ground truth.
    await casGuardedAdd(
      "TechDayStops",
      dayStopId(date, technicianId),
      { committedStops: -stops },
      [{ kind: "fieldAtLeast", field: "committedStops", value: stops }]
    ).catch(() => undefined);
  }
}

/** Account for a pending-assignment (pool) visit on the readout. Never
 *  refused and never blocking — a pool visit only becomes a commitment
 *  through the real assign claim. */
export async function notePoolMinutes(
  date: string,
  minutes: number
): Promise<void> {
  if (!(await capacityModelsReady())) return;
  await ensureSlot(date, POOL_TECH);
  await casGuardedAdd(
    "CapacityDay",
    slotId(date, POOL_TECH),
    { committedMinutes: minutes },
    []
  );
}

export async function releasePoolMinutes(
  date: string,
  minutes: number
): Promise<void> {
  await releaseSlot(date, POOL_TECH, minutes);
}

// ---------------------------------------------------------------------------
// Checkout claims — atomic, slot-bound, durable
// ---------------------------------------------------------------------------

export async function claimDaySlot(input: {
  claimKey: string;
  date: string;
  technicianId: string;
  minutes: number;
  address?: string | null;
  holdMs?: number;
  holdReason?: string;
}): Promise<ClaimOutcome> {
  if (!(await capacityModelsReady())) return UNAVAILABLE;
  const client = await dataClient();
  const expiresAt = new Date(
    Date.now() + (input.holdMs ?? CHECKOUT_CLAIM_MS)
  ).toISOString();
  const { data: created } = await client.models.CapacityClaim.create({
    id: input.claimKey,
    date: input.date,
    technicianId: input.technicianId,
    address: input.address ?? undefined,
    minutes: input.minutes,
    expiresAt,
    holdReason: input.holdReason,
  });
  if (!created) {
    const { data: existing } = await client.models.CapacityClaim.get({
      id: input.claimKey,
    });
    if (existing && String(existing.expiresAt) > new Date().toISOString()) {
      const sameSlot =
        existing.date === input.date &&
        existing.technicianId === input.technicianId &&
        (existing.minutes ?? 0) === input.minutes;
      if (sameSlot) {
        // The same attempt retrying — its claim is live; extend the hold.
        await client.models.CapacityClaim.update({
          id: input.claimKey,
          expiresAt,
        }).catch(() => undefined);
        return { ok: true };
      }
      // The SAME attempt changed its selection. The old short-circuit said
      // "ok" while reserving NOTHING on the new slot — an oversell. Order:
      // reserve the new slot, move the row, then give the old slot back; a
      // crash between steps leaves only an over-hold that expiry and the
      // nightly rebuild release.
      const takenNew = await reserveSlot(
        input.date,
        input.technicianId,
        input.minutes
      );
      if (!takenNew.ok) return takenNew;
      const { data: moved } = await client.models.CapacityClaim.update({
        id: input.claimKey,
        date: input.date,
        technicianId: input.technicianId,
        minutes: input.minutes,
        address: input.address ?? undefined,
        expiresAt,
        holdReason: input.holdReason,
      }).catch(() => ({ data: null }));
      if (!moved) {
        await releaseSlot(
          input.date,
          input.technicianId,
          input.minutes
        ).catch(() => undefined);
        return {
          ok: false,
          soldOut: false,
          message: "The slot hold could not be moved — try again.",
        };
      }
      await releaseSlot(
        String(existing.date),
        existing.technicianId ?? POOL_TECH,
        existing.minutes ?? 0
      ).catch(() => undefined);
      return { ok: true };
    }
    if (existing) await releaseCapacityClaim(input.claimKey);
    const { data: retried } = await client.models.CapacityClaim.create({
      id: input.claimKey,
      date: input.date,
      technicianId: input.technicianId,
      address: input.address ?? undefined,
      minutes: input.minutes,
      expiresAt,
      holdReason: input.holdReason,
    });
    if (!retried) {
      return {
        ok: false,
        soldOut: false,
        message: "The slot hold could not be recorded — try again.",
      };
    }
  }
  // The claim row exists; now take the slot minutes atomically. Losing the
  // fit deletes the row — the claim never lies about holding capacity.
  const taken = await reserveSlot(
    input.date,
    input.technicianId,
    input.minutes
  );
  if (!taken.ok) {
    await client.models.CapacityClaim.delete({ id: input.claimKey }).catch(
      () => undefined
    );
    return taken;
  }
  return { ok: true };
}

/** Extend a live claim (an accepted pending bank debit keeps its slot while
 *  the money settles). Returns false when there was no row to extend — the
 *  hold expired and was swept; the caller must RE-CLAIM, not assume. */
export async function extendCapacityClaim(
  claimKey: string,
  holdMs: number
): Promise<boolean> {
  const client = await dataClient();
  if (!("CapacityClaim" in client.models)) return false;
  const { data } = await client.models.CapacityClaim.update({
    id: claimKey,
    expiresAt: new Date(Date.now() + holdMs).toISOString(),
  }).catch(() => ({ data: null }));
  return Boolean(data);
}

/** Release a claim: the attempt failed or was abandoned — the slot minutes
 *  go back. Idempotent (a second release finds no row and does nothing). */
export async function releaseCapacityClaim(claimKey: string): Promise<void> {
  const client = await dataClient();
  if (!("CapacityClaim" in client.models)) return;
  const { data: claim } = await client.models.CapacityClaim.get({
    id: claimKey,
  });
  if (!claim) return;
  const { data: deleted } = await client.models.CapacityClaim.delete({
    id: claimKey,
  });
  if (!deleted) return; // someone else released/consumed it first
  await releaseSlot(
    String(claim.date),
    claim.technicianId ?? POOL_TECH,
    claim.minutes ?? 0
  );
}

/**
 * The optimistic-concurrency conditions for PUBLISHING a job's schedule
 * state. Every mutation that publishes schedule state (assign, reschedule,
 * unassign, cancel, the plan/deactivation sweeps) reads the job, decides,
 * and then writes THROUGH these guards pinned to the snapshot it read: the
 * date, the status, and the capacity attribution its releases will use.
 * Any concurrent publisher changes at least one pinned field, so exactly
 * one of two racing mutations lands — the loser refuses, re-reads, and
 * re-decides. This is what makes ledger releases exactly-once and makes
 * resurrecting a concurrently-canceled visit impossible.
 */
export function jobScheduleGuards(job: {
  scheduledDate?: string | null;
  status?: string | null;
  technicianId?: string | null;
  capacityMinutes?: number | null;
  capacityTechnicianId?: string | null;
}): LockCondition[] {
  const pin = (
    field: string,
    value: string | number | null | undefined
  ): LockCondition =>
    value === null || value === undefined
      ? { kind: "fieldMissingOrNull", field }
      : { kind: "fieldEquals", field, value };
  return [
    pin("scheduledDate", job.scheduledDate ?? null),
    pin("status", job.status ?? null),
    pin("technicianId", job.technicianId ?? null),
    pin("capacityMinutes", job.capacityMinutes ?? null),
    pin(
      "capacityTechnicianId",
      (job as { capacityTechnicianId?: string | null }).capacityTechnicianId ??
        null
    ),
  ];
}

/** The slot a job's minutes are HELD on — strictly from its stamps. A job
 *  without stamps holds nothing (its creation path never reserved), so there
 *  is nothing to release; that strictness is what makes every release
 *  idempotent: the cancel write clears the stamps in the same update, and a
 *  re-drive finds nothing left to give back. */
export function jobCapacityFacts(job: {
  scheduledDate?: string | null;
  capacityMinutes?: number | null;
  technicianId?: string | null;
  capacityTechnicianId?: string | null;
}): {
  date: string;
  minutes: number;
  technicianId: string | null;
} | null {
  if (!job.scheduledDate) return null;
  if (job.capacityMinutes == null) return null;
  return {
    date: job.scheduledDate,
    minutes: job.capacityMinutes,
    technicianId: job.technicianId ?? job.capacityTechnicianId ?? null,
  };
}

/** Give a job's held slot (or pool) minutes back — the ONE release path every
 *  cancel/unassign/sweep uses. Callers must clear the job's capacity stamps
 *  in the same write that ends the hold, so a resumed drive cannot release
 *  twice. */
export async function releaseJobCapacity(job: {
  scheduledDate?: string | null;
  capacityMinutes?: number | null;
  technicianId?: string | null;
  capacityTechnicianId?: string | null;
}): Promise<void> {
  const facts = jobCapacityFacts(job);
  if (!facts || facts.minutes <= 0) return;
  if (facts.technicianId && facts.technicianId !== POOL_TECH) {
    await releaseSlot(
      facts.date,
      facts.technicianId,
      facts.minutes,
      // GL-07: an ASSIGNED visit (technicianId, not a checkout hold) held
      // one stop on the technician's day — it comes back with the minutes.
      { stops: job.technicianId && job.technicianId !== POOL_TECH ? 1 : 0 }
    ).catch(() => undefined);
  } else {
    await releasePoolMinutes(facts.date, facts.minutes).catch(
      () => undefined
    );
  }
}

/** Consume a claim into a booked visit: the row goes away WITHOUT giving the
 *  minutes back — the scheduled job carries them from now on. Returns the
 *  claim's slot facts so the job can be stamped with them. */
export async function consumeCapacityClaim(claimKey: string): Promise<{
  technicianId: string;
  minutes: number;
} | null> {
  const client = await dataClient();
  if (!("CapacityClaim" in client.models)) return null;
  const { data: claim } = await client.models.CapacityClaim.get({
    id: claimKey,
  });
  if (!claim) return null;
  await client.models.CapacityClaim.delete({ id: claimKey }).catch(
    () => undefined
  );
  return {
    technicianId: claim.technicianId ?? POOL_TECH,
    minutes: claim.minutes ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Per-slot feasibility with REAL Routes legs
// ---------------------------------------------------------------------------

export type SlotFeasibility = {
  technicianId: string;
  /** on-site + the marginal Routes legs this stop adds to the slot's route. */
  claimMinutes: number;
  /** Routes minutes to the nearest existing stop in THIS tech's route that
   *  day, or null when the tech's day is empty (no route to be near). Drives
   *  the route-density discount, so the credit reflects the tech we book. */
  nearestStopMinutes: number | null;
};

/**
 * Which technician-day slot (if any) can absorb the candidate stop.
 *
 * Marginal travel is measured with REAL Routes legs, no defaults:
 *  - an EMPTY slot pays base → candidate + candidate → base;
 *  - a slot with stops pays a nearest-stop insertion (2 × the Routes leg
 *    between the candidate and its nearest existing stop that day).
 * A leg Routes cannot produce makes that slot infeasible — fail closed. The
 * caller supplies the leg resolver (a memoized wrapper over Routes) so a
 * calendar of days shares its Routes calls.
 */
/**
 * The TRUE extra drive time one more stop adds to a technician-day.
 *
 * The day is a closed tour base → stops → base. Inserting a candidate into the
 * cheapest seam (a,b) costs leg(a,cand) + leg(cand,b) − leg(a,b); the minimum
 * over every seam is what the day actually pays. An EMPTY day has the single
 * seam (base, base), which correctly degenerates to a plain out-and-back.
 *
 * This exists because the office assign path used to charge
 * `driveMinutes × 2` — a full base round trip PER STOP. On a day that already
 * drives to a cluster that double-counts the long haul: a second Ashland stop
 * from a Ware base was billed ~170 travel minutes instead of the ~10 it really
 * adds, so a day with room refused new work as "fully booked". Every path that
 * claims capacity must price a stop the same way the ledger will measure it.
 *
 * Null = no routable seam; the caller must fail closed, never guess.
 */
export async function marginalTravelMinutes(opts: {
  baseAddress: string;
  /** The day's existing stop addresses, in route order. */
  stops: string[];
  candidateAddress: string;
  legMinutes: (from: string, to: string) => Promise<number | null>;
}): Promise<number | null> {
  const route = [opts.baseAddress, ...opts.stops, opts.baseAddress];
  let best: number | null = null;
  for (let i = 0; i < route.length - 1; i++) {
    const a = route[i];
    const b = route[i + 1];
    const toCand = await opts.legMinutes(a, opts.candidateAddress);
    const fromCand = await opts.legMinutes(opts.candidateAddress, b);
    if (toCand == null || fromCand == null) continue; // this seam unroutable
    const baseLeg = a === b ? 0 : await opts.legMinutes(a, b);
    if (baseLeg == null) continue;
    const delta = Math.max(0, toCand + fromCand - baseLeg);
    if (best === null || delta < best) best = delta;
  }
  return best;
}

export async function bestSlotFor(opts: {
  date: string;
  onsite: number;
  eligibility: DayEligibility;
  slots: Map<string, SlotState>;
  /** slotId → the stop addresses already occupying that tech-day. */
  stopsBySlot: Map<string, string[]>;
  /** Routes minutes between two addresses; null = unroutable (fail closed). */
  legMinutes: (from: string, to: string) => Promise<number | null>;
  candidateAddress: string;
}): Promise<SlotFeasibility | null> {
  const { date, onsite } = opts;
  let best: SlotFeasibility | null = null;
  for (const tech of opts.eligibility.techs) {
    const id = slotId(date, tech.id);
    const state = opts.slots.get(id);
    if (state && !state.verified) continue; // fail closed until Routes verifies
    const committed = state?.committedMinutes ?? 0;
    const stops = opts.stopsBySlot.get(id) ?? [];
    // GL-07: a tech already at the day's stop ceiling is not sellable — the
    // booking would auto-assign onto a full route. Never offer a full tech.
    if (stops.length >= STOPS_PER_TECH) continue;
    // Nearest existing stop — the caller's route-density signal (informational).
    let nearestStop: number | null = null;
    for (const stop of stops) {
      const leg = await opts.legMinutes(opts.candidateAddress, stop);
      if (leg != null && (nearestStop === null || leg < nearestStop))
        nearestStop = leg;
    }
    // TRUE marginal travel: the cheapest place to splice the candidate into the
    // tech's closed tour base → stops → base. For each adjacent pair (a,b) in
    // that tour, inserting costs leg(a,cand) + leg(cand,b) − leg(a,b); take the
    // minimum. An empty day is the single pair (base, base) — a plain
    // out-and-back. This is the delta the ledger will commit, so there is no
    // per-stop round-trip double-count.
    const marginalTravel = await marginalTravelMinutes({
      baseAddress: tech.baseAddress,
      stops,
      candidateAddress: opts.candidateAddress,
      legMinutes: opts.legMinutes,
    });
    if (marginalTravel == null) continue; // no routable seam → not sellable here
    const claimMinutes = onsite + marginalTravel;
    if (committed + claimMinutes > DAY_MINUTES) continue;
    if (!best || claimMinutes < best.claimMinutes) {
      best = { technicianId: tech.id, claimMinutes, nearestStopMinutes: nearestStop };
    }
  }
  return best;
}

/** A memoizing Routes leg resolver. Null key ⇒ every leg is null (fail
 *  closed everywhere it is consulted). */
export function makeLegResolver(
  routesKey: string | null
): (from: string, to: string) => Promise<number | null> {
  const memo = new Map<string, number | null>();
  return async (from: string, to: string) => {
    if (!routesKey) return null;
    const key = `${from}→${to}`;
    if (memo.has(key)) return memo.get(key)!;
    const minutes = await driveMinutesBetween(routesKey, from, to);
    memo.set(key, minutes);
    return minutes;
  };
}

/** The stops currently occupying each technician-day slot on a date —
 *  scheduled jobs plus live claims. */
export async function stopsBySlotOn(
  date: string
): Promise<Map<string, string[]>> {
  const client = await dataClient();
  const ordered = new Map<string, { address: string; routeOrder: number }[]>();
  const push = (key: string, address: string | null, routeOrder: number) => {
    if (!address) return;
    const list = ordered.get(key) ?? [];
    list.push({ address, routeOrder });
    ordered.set(key, list);
  };
  let token: string | null | undefined;
  do {
    const page = await client.models.Job.listJobByScheduledDate(
      { scheduledDate: date },
      { limit: 200, nextToken: token }
    );
    for (const job of page.data ?? []) {
      if (job.status !== "SCHEDULED" && job.status !== "IN_PROGRESS") continue;
      const stopTechId =
        job.technicianId ??
        (job as { capacityTechnicianId?: string | null })
          .capacityTechnicianId ??
        null;
      if (!stopTechId) continue;
      const { data: customer } = await client.models.Customer.get({
        id: job.customerId,
      });
      // ROUTING address — the unit is deliberately excluded (serviceAddress.ts).
      const address = customer ? routingAddress(customer) || null : null;
      push(slotId(date, stopTechId), address, job.routeOrder ?? 999);
    }
    token = page.nextToken;
  } while (token);
  for (const claim of await liveClaimsOn(date)) {
    if (claim.technicianId === POOL_TECH) continue;
    push(slotId(date, claim.technicianId), claim.address, 1_000_000);
  }
  // Emit each slot's stops in route order so a marginal-insertion fit test
  // (bestSlotFor) splices against the real tour, not an arbitrary read order.
  const out = new Map<string, string[]>();
  for (const [key, list] of ordered) {
    list.sort((a, b) => a.routeOrder - b.routeOrder);
    out.set(
      key,
      list.map((s) => s.address)
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tour-based day accounting — travel measured ONCE per day, not per stop
// ---------------------------------------------------------------------------

export type TourStop = {
  address: string | null;
  onsite: number;
  /** Optional label (the customer's name) so an unroutable stop can be NAMED
   *  in the exception the office has to act on, not just located. */
  label?: string | null;
};

/**
 * The day's committed minutes split into its two real components:
 *  - travel: the CLOSED tour base → stops (in the given order) → base, each
 *    leg measured once. A far base is charged a SINGLE out-and-back for the
 *    whole cluster, never a round trip per stop.
 *  - treatment: the sum of on-site minutes across the stops.
 *
 * `stops` must already be in route order. A base that can't be resolved, a stop
 * with no address, or any unroutable leg fails CLOSED (verified:false) — a day
 * is never sold on travel we could not measure. Treatment is on-site time, so
 * it is always known and returned even when the travel legs cannot be verified.
 */
export async function closedTourMinutes(
  base: string | null,
  stops: TourStop[],
  legMinutes: (from: string, to: string) => Promise<number | null>
): Promise<{
  travel: number;
  treatment: number;
  verified: boolean;
  /** When unverified: the stop that broke the tour, so the office is told WHICH
   *  address to fix instead of just "that day is now fully booked". Absent when
   *  the base itself is the missing fact. */
  blockedBy?: { address: string | null; label?: string | null };
}> {
  const treatment = stops.reduce((sum, s) => sum + s.onsite, 0);
  if (stops.length === 0) return { travel: 0, treatment, verified: true };
  if (!base) return { travel: 0, treatment, verified: false };
  let travel = 0;
  let prev = base;
  for (const stop of stops) {
    // A stop with no address, or one Routes cannot resolve, is the reason the
    // whole day becomes unsellable — name it.
    if (!stop.address) {
      return {
        travel: 0,
        treatment,
        verified: false,
        blockedBy: { address: null, label: stop.label ?? null },
      };
    }
    const leg = await legMinutes(prev, stop.address);
    if (leg == null) {
      return {
        travel: 0,
        treatment,
        verified: false,
        blockedBy: { address: stop.address, label: stop.label ?? null },
      };
    }
    travel += leg;
    prev = stop.address;
  }
  const home = await legMinutes(prev, base);
  if (home == null) {
    return {
      travel: 0,
      treatment,
      verified: false,
      blockedBy: { address: prev, label: stops[stops.length - 1]?.label ?? null },
    };
  }
  travel += home;
  return { travel, treatment, verified: true };
}

/**
 * Rebuild ONE technician-day's committed minutes from ground truth, right after
 * a scheduling mutation — the SAME tour math the nightly reconcile uses, but on
 * a single slot so the ledger reflects the real optimized tour immediately
 * rather than drifting on per-stop marginal estimates until the nightly rebuild
 * corrects it. Call it after `optimizeTechDay` (which sets the route order the
 * tour is measured along).
 *
 * Reads the tech's SCHEDULED/IN_PROGRESS stops (in route order), their base, and
 * any live checkout claims, then writes travelMinutes / treatmentMinutes /
 * committedMinutes / verified. Best-effort and non-fatal: it never throws into
 * the mutation that called it, and an unverifiable tour fails closed (holds the
 * full window) exactly like the nightly rebuild.
 */
export async function recomputeSlotMinutes(
  date: string,
  technicianId: string,
  routesKey?: string | null
): Promise<void> {
  try {
    if (!technicianId || technicianId === POOL_TECH) return;
    const client = await dataClient();
    if (!("CapacityDay" in client.models)) return;
    if (
      typeof (client.models.Job as { listJobByScheduledDate?: unknown })
        .listJobByScheduledDate !== "function"
    )
      return;
    const key = routesKey ?? process.env.GOOGLE_ROUTES_API_KEY ?? null;
    // No Routes key ⇒ a tour cannot be measured. Leave the ledger exactly as
    // the reservation set it rather than stomping the day to a false "fully
    // booked" on every mutation. Production always has a key; this is the
    // local-dev / no-key path (mirrors ALLOW_UNVERIFIED_ROUTES elsewhere).
    if (!key) return;
    const legMinutes = makeLegResolver(key);

    // This tech's counted stops for the date, in route order.
    const stops: (TourStop & { routeOrder: number })[] = [];
    let token: string | null | undefined;
    do {
      const page = await client.models.Job.listJobByScheduledDate(
        { scheduledDate: date },
        { limit: 200, nextToken: token }
      );
      for (const job of page.data ?? []) {
        if (job.technicianId !== technicianId) continue;
        if (job.status !== "SCHEDULED" && job.status !== "IN_PROGRESS") continue;
        const { data: customer } = await client.models.Customer.get({
          id: job.customerId,
        });
        // ROUTING address — the unit is deliberately excluded.
        const address = customer ? routingAddress(customer) : "";
        stops.push({
          address: address || null,
          onsite: onsiteMinutes(job.propertyClass),
          routeOrder: job.routeOrder ?? 999,
        });
      }
      token = page.nextToken;
    } while (token);
    stops.sort((a, b) => a.routeOrder - b.routeOrder);

    const base = await techBaseFor(technicianId, date);
    const tour = await closedTourMinutes(base, stops, legMinutes);

    // Live checkout holds on this exact slot ride on top of the tour.
    const claimMinutes = (await liveClaimsOn(date))
      .filter((c) => c.technicianId === technicianId)
      .reduce((sum, c) => sum + c.minutes, 0);

    // Only OVERWRITE the ledger when the tour was actually measured. An
    // unverifiable tour (a transient Routes failure, a missing leg) leaves the
    // reservation's value in place rather than stomping a good day to a false
    // "fully booked" on this one mutation — the nightly reconcile stays the
    // fail-closed authority that holds an unverifiable day.
    if (!tour.verified) return;
    const id = slotId(date, technicianId);
    await ensureSlot(date, technicianId);
    const sets = {
      committedMinutes: tour.travel + tour.treatment + claimMinutes,
      travelMinutes: tour.travel,
      treatmentMinutes: tour.treatment,
      verified: true,
      reconciledAt: new Date().toISOString(),
    };
    const written = await casGuardedUpdate("CapacityDay", id, sets, []);
    if (!written.ok && written.reason === "UNSUPPORTED") {
      await client.models.CapacityDay.update({ id, ...sets }).catch(
        () => undefined
      );
    }
  } catch (err) {
    console.error("recomputeSlotMinutes failed (non-fatal)", err);
  }
}

// ---------------------------------------------------------------------------
// Nightly rebuild: slots re-derived from ground truth with real Routes legs
// ---------------------------------------------------------------------------

/**
 * Re-derive one date's slot ledgers from its jobs (in route order) and live
 * claims, expiring dead checkout claims. Travel is re-measured as base →
 * first stop → successive stops → base with real Routes calls; a slot whose
 * legs cannot all be verified is marked verified:false and holds the FULL
 * window (sells nothing) until a later rebuild succeeds — drift and blind
 * spots both fail closed.
 */
export async function reconcileCapacityDay(
  date: string,
  routesKey: string | null
): Promise<{ slots: number; expiredClaims: number; unverified: number }> {
  if (!(await capacityModelsReady())) {
    return { slots: 0, expiredClaims: 0, unverified: 0 };
  }
  const client = await dataClient();
  let expiredClaims = 0;
  {
    const nowIso = new Date().toISOString();
    let token: string | null | undefined;
    do {
      const page = await client.models.CapacityClaim.listCapacityClaimByDate(
        { date },
        { limit: 200, nextToken: token }
      );
      for (const claim of page.data ?? []) {
        if (String(claim.expiresAt) <= nowIso) {
          await releaseCapacityClaim(claim.id);
          expiredClaims++;
        }
      }
      token = page.nextToken;
    } while (token);
  }

  const eligibility = await dayEligibility(date);
  const legMinutes = makeLegResolver(routesKey);

  // Group the day's counted jobs by slot, in route order.
  type StopJob = {
    id: string;
    routeOrder: number;
    address: string | null;
    onsite: number;
    /** Carried so an unroutable stop can be named (and linked) in the exception
     *  the office has to act on. */
    label: string | null;
    customerId: string;
  };
  const jobsBySlot = new Map<string, StopJob[]>();
  const assignedStopsByTech = new Map<string, number>();
  let token: string | null | undefined;
  do {
    const page = await client.models.Job.listJobByScheduledDate(
      { scheduledDate: date },
      { limit: 200, nextToken: token }
    );
    for (const job of page.data ?? []) {
      // Pending-assignment visits (UNSCHEDULED with a target date — office
      // moves, auto-queued recurrences) stay on the POOL readout; the rebuild
      // must not wipe what the pool notes recorded.
      const pendingAssignment =
        job.status === "UNSCHEDULED" && Boolean(job.scheduledDate);
      if (
        job.status !== "SCHEDULED" &&
        job.status !== "IN_PROGRESS" &&
        !pendingAssignment
      )
        continue;
      // A paid funnel booking holds a SPECIFIC technician's day before any
      // office assignment exists — the rebuild must keep that hold, not
      // reclassify it to the non-blocking pool.
      const techId = pendingAssignment
        ? POOL_TECH
        : (job.technicianId ??
          (job as { capacityTechnicianId?: string | null })
            .capacityTechnicianId ??
          POOL_TECH);
      const key = slotId(date, techId);
      const { data: customer } = await client.models.Customer.get({
        id: job.customerId,
      });
      // ROUTING address — the unit is deliberately excluded.
      const address = customer ? routingAddress(customer) || null : null;
      const list = jobsBySlot.get(key) ?? [];
      list.push({
        id: job.id,
        routeOrder: job.routeOrder ?? 999,
        address,
        onsite: onsiteMinutes(job.propertyClass),
        label: customer?.displayName ?? null,
        customerId: job.customerId,
      });
      jobsBySlot.set(key, list);
      // GL-07: ground truth for the assigned-stop day ledger — a stop is
      // ASSIGNED only when the job carries a real technicianId (checkout
      // holds and pending-assignment pool visits are not stops).
      if (!pendingAssignment && job.technicianId && job.technicianId !== POOL_TECH) {
        assignedStopsByTech.set(
          job.technicianId,
          (assignedStopsByTech.get(job.technicianId) ?? 0) + 1
        );
      }
    }
    token = page.nextToken;
  } while (token);

  const assignedStopsByTechFinal = assignedStopsByTech;
  const liveClaims = await liveClaimsOn(date);
  const claimMinutesBySlot = new Map<string, number>();
  for (const claim of liveClaims) {
    const key = slotId(date, claim.technicianId);
    claimMinutesBySlot.set(
      key,
      (claimMinutesBySlot.get(key) ?? 0) + claim.minutes
    );
  }

  // Every slot that has (or had) content gets rebuilt.
  const allSlotIds = new Set<string>([
    ...jobsBySlot.keys(),
    ...claimMinutesBySlot.keys(),
    ...(await slotStates(date)).keys(),
  ]);
  let slots = 0;
  let unverified = 0;
  for (const id of allSlotIds) {
    const [, techId] = id.split("#") as [string, string];
    const stops = (jobsBySlot.get(id) ?? []).sort(
      (a, b) => a.routeOrder - b.routeOrder
    );
    const claimMinutes = claimMinutesBySlot.get(id) ?? 0;
    let travelMinutes = 0;
    let treatmentMinutes = 0;
    let verified = true;
    if (techId === POOL_TECH) {
      // Pool accounting: on-site only (no route exists yet, so no travel).
      treatmentMinutes = stops.reduce((sum, s) => sum + s.onsite, 0);
    } else {
      // The one closed tour base → stops → base, measured ONCE. A missing base
      // (tech not eligible that day) or any unroutable leg fails closed — the
      // day-before dispatch sweep owns the human fix.
      const base =
        eligibility.techs.find((t) => t.id === techId)?.baseAddress ?? null;
      const tour = await closedTourMinutes(base, stops, legMinutes);
      travelMinutes = tour.travel;
      treatmentMinutes = tour.treatment;
      verified = tour.verified;
      // An unmeasurable day is pinned to the full window below, so from the
      // office's side it is indistinguishable from a full one — it just stops
      // taking bookings. Name the stop that broke it, or the silence costs a
      // technician's entire day of capacity until someone goes looking.
      if (!verified && tour.blockedBy && stops.length > 0) {
        const who = tour.blockedBy.label ?? "A stop";
        const where = tour.blockedBy.address ?? "(no address on file)";
        await openOwnedWork({
          kind: "ADDRESS_UNROUTABLE",
          // One case per technician-day: the office fixes the address once, and
          // a retry of the same broken day re-announces rather than piling up.
          dedupeKey: `unroutable:${date}:${techId}`,
          title: `Can't route ${who} — ${date} is held`,
          detail: `${who} (${where}) could not be resolved by Google Routes, so this technician's whole day for ${date} cannot be measured. The day is held at full capacity and will refuse new stops until the address is corrected — it is NOT actually full. Fix the service address on the customer, then the nightly rebuild (or the next scheduling change) frees the day.`,
          customerId: stops.find((s) => s.label === tour.blockedBy?.label)?.customerId,
          relatedId: `${date}#${techId}`,
          sourceUrl: `/schedule`,
          resolutionAction:
            "Correct the customer's service address so it resolves in Google Maps, or mark the property outside the service area.",
          ownerTeam: "OPS",
        }).catch(() => undefined);
      }
    }
    const minutes = travelMinutes + treatmentMinutes + claimMinutes;
    await ensureSlot(date, techId);
    const sets = {
      committedMinutes: verified ? minutes : DAY_MINUTES,
      travelMinutes: verified ? travelMinutes : null,
      treatmentMinutes,
      verified,
      reconciledAt: new Date().toISOString(),
    };
    const written = await casGuardedUpdate("CapacityDay", id, sets, []);
    if (!written.ok && written.reason === "UNSUPPORTED") {
      await client.models.CapacityDay.update({ id, ...sets }).catch(
        () => undefined
      );
    }
    slots++;
    if (!verified) unverified++;
  }
  // GL-07: rebuild every technician's assigned-stop day ledger from ground
  // truth — drifted counters (a crashed compensation, a legacy row)
  // converge here every night. Techs with a stale row but no stops today
  // are reset to zero.
  const stopRowTechs = new Set<string>(assignedStopsByTechFinal.keys());
  {
    const stopModel = (client.models as unknown as Record<string, unknown>)
      .TechDayStops as
      | {
          listTechDayStopsByDate?: (a: object) => Promise<{
            data: { date?: string | null; technicianId?: string | null }[];
            nextToken?: string | null;
          }>;
          list: (a: object) => Promise<{
            data: { date?: string | null; technicianId?: string | null }[];
            nextToken?: string | null;
          }>;
        }
      | undefined;
    if (stopModel) {
      let token2: string | null | undefined;
      do {
        const page = stopModel.listTechDayStopsByDate
          ? await stopModel.listTechDayStopsByDate({
              date,
              limit: 500,
              nextToken: token2,
            })
          : await stopModel.list({ limit: 500, nextToken: token2 });
        for (const row of page.data ?? []) {
          if (
            row.technicianId &&
            (stopModel.listTechDayStopsByDate || row.date === date)
          ) {
            stopRowTechs.add(row.technicianId);
          }
        }
        token2 = page.nextToken;
      } while (token2);
    }
  }
  for (const techId of stopRowTechs) {
    const trueStops = assignedStopsByTechFinal.get(techId) ?? 0;
    const id = dayStopId(date, techId);
    // A MISSING row is created (all required fields) and a DRIFTED one is
    // overwritten with ground truth; a row that cannot be created is an
    // honest error in the reconcile log, not a silent skip.
    if (!(await ensureDayStopRow(date, techId))) continue;
    const sets = {
      committedStops: trueStops,
      reconciledAt: new Date().toISOString(),
    };
    const written = await casGuardedUpdate("TechDayStops", id, sets, []);
    if (!written.ok && written.reason === "UNSUPPORTED") {
      await (
        client.models as unknown as Record<
          string,
          { update: (i: Record<string, unknown>) => Promise<unknown> }
        >
      ).TechDayStops.update({ id, ...sets }).catch(() => undefined);
    }
  }
  return { slots, expiredClaims, unverified };
}
