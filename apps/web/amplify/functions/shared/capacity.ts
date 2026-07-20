import { dataClient } from "./dataClient";
import { casGuardedAdd, casGuardedUpdate , type LockCondition } from "./atomicLock";
import { onsiteMinutesFor } from "./dispatchReadiness";
import { driveMinutesBetween, HQ_ADDRESS } from "./driveTime";
import { licenseFactsFromRecords, licenseRecordsFor } from "./licenses";
import { windowStartHour } from "./cancellationPolicy";

/**
 * GL-04 — the ONE capacity rule: PER-TECHNICIAN, PER-WINDOW minute
 * feasibility, shared by the funnel calendar, checkout, dispatch, and office
 * reschedules.
 *
 *  - The working day is Monday–Friday, 8:00–5:00 Eastern, split into the two
 *    sold windows: MORNING 8:00–12:00 (240 min) and AFTERNOON 12:00–5:00
 *    (300 min). Each technician-window is its own ledger slot — mornings can
 *    never borrow afternoon minutes, and one technician's free time never
 *    hides another's overload.
 *  - A visit consumes its locked on-site minutes (residential 30;
 *    commercial/community 60) plus REAL Google Routes travel legs measured
 *    from the technician's private base (or that day's reasoned
 *    BASE_OVERRIDE, else HQ): base → first stop → successive stops → base.
 *    There is no default travel constant and no average-hop guess — a leg
 *    Routes cannot produce makes the slot infeasible (fail closed).
 *  - Weekends, company closures, per-day PTO, inactive status, and licence
 *    problems (including unreadable records — fail closed) remove the
 *    technician's slots entirely; zero eligible technicians sells zero.
 *  - Committed minutes live on ONE CapacityDay row per slot, maintained by
 *    ATOMIC guarded adds: taking minutes succeeds only while the fit
 *    condition (≤ the window's minutes) holds in the same write, so two
 *    concurrent purchases or office moves can never both take a slot's last
 *    minutes. Missing models or CAS wiring REFUSE (fail closed) — never
 *    permissive success.
 *  - A checkout attempt claims a SPECIFIC technician-window slot BEFORE the
 *    payment attempt (CapacityClaim carries the slot and the address so
 *    later routing sees the stop); success consumes it into the booked job
 *    (the job carries the stamped minutes), an accepted pending bank debit
 *    extends it, failure releases it, and the nightly rebuild re-derives
 *    every slot from its jobs with real Routes legs — a slot whose legs
 *    can't be verified sells nothing until they can.
 */

export type CapacityWindow = "MORNING" | "AFTERNOON";
export const WINDOWS: readonly CapacityWindow[] = ["MORNING", "AFTERNOON"];

/** MORNING 8:00–12:00; AFTERNOON 12:00–17:00 (Eastern). */
export const WINDOW_MINUTES: Record<CapacityWindow, number> = {
  MORNING: 240,
  AFTERNOON: 300,
};

/** How long a card checkout may hold a claim before the sweep releases it. */
export const CHECKOUT_CLAIM_MS = 45 * 60_000;

/** How long an accepted pending bank debit keeps its claim while settling. */
export const PROCESSING_CLAIM_MS = 7 * 24 * 60 * 60_000;

/** The pseudo-technician slot that ACCOUNTS FOR pending-assignment (pool)
 *  visits on the Operations readout without blocking a real slot — a pool
 *  visit becomes a confirmed commitment only through the real assign claim. */
export const POOL_TECH = "POOL";

/** GL-07: one route is one technician-day of at most this many ASSIGNED
 *  stops — the coarse day ceiling alongside the per-window minutes ledger. */
export const STOPS_PER_TECH = 8;

/** GL-07: the per-technician-DAY assigned-stop ledger row. Deliberately
 *  carries NO `date` attribute, so the by-date index (slot readers, the
 *  availability matrix) never sees it — it exists only for the atomic
 *  stop-count invariant and the nightly rebuild. */
export function dayStopId(date: string, technicianId: string): string {
  return `stops#${date}#${technicianId}`;
}

export function isWeekday(date: string): boolean {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  return dow >= 1 && dow <= 5;
}

/** Which sold window a visit's time-window string belongs to. */
export function windowOfTimeWindow(
  timeWindow: string | null | undefined
): CapacityWindow {
  const normalized = (timeWindow ?? "").trim().toUpperCase();
  if (normalized.startsWith("MORNING")) return "MORNING";
  if (normalized.startsWith("AFTERNOON")) return "AFTERNOON";
  return windowStartHour(timeWindow) < 12 ? "MORNING" : "AFTERNOON";
}

export function slotId(
  date: string,
  window: CapacityWindow,
  technicianId: string
): string {
  return `${date}#${window}#${technicianId}`;
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
  window: CapacityWindow;
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
      if (!row.window || !row.technicianId) continue;
      out.set(row.id, {
        technicianId: row.technicianId,
        window: row.window as CapacityWindow,
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
    window: CapacityWindow;
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
    window: CapacityWindow;
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
        window: (claim.window as CapacityWindow) ?? "MORNING",
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
  window: CapacityWindow,
  technicianId: string
): Promise<void> {
  const client = await dataClient();
  if (!("CapacityDay" in client.models)) return;
  await client.models.CapacityDay.create({
    id: slotId(date, window, technicianId),
    date,
    window,
    technicianId,
    committedMinutes: 0,
    verified: true,
  }).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Atomic slot writes — FAIL CLOSED on UNSUPPORTED
// ---------------------------------------------------------------------------

/**
 * Atomically take `minutes` on one technician-window slot: ONE guarded add
 * conditioned on the result fitting the window. Exactly one of two
 * concurrent takers of the last minutes wins. Missing models or CAS wiring
 * REFUSE — an unverifiable ledger schedules nothing.
 */
export async function reserveSlot(
  date: string,
  window: CapacityWindow,
  technicianId: string,
  minutes: number,
  opts?: {
    /** GL-07: reserve this many ASSIGNED stops on the technician's DAY in
     *  the same claim (0 for checkout holds and window shifts). Each
     *  ceiling is one guarded conditional write; a minutes refusal after a
     *  won stop compensates the stop, so a failed claim never leaks. */
    stops?: number;
  }
): Promise<ClaimOutcome> {
  if (!(await capacityModelsReady())) return UNAVAILABLE;
  const stops = opts?.stops ?? 0;
  if (stops > 0) {
    const stopRowId = dayStopId(date, technicianId);
    await ensureDayStopRow(date, technicianId);
    const stopRes = await casGuardedAdd(
      "CapacityDay",
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
  await ensureSlot(date, window, technicianId);
  const id = slotId(date, window, technicianId);
  const res = await casGuardedAdd(
    "CapacityDay",
    id,
    { committedMinutes: minutes },
    [
      {
        kind: "fieldAtMostOrMissing",
        field: "committedMinutes",
        value: WINDOW_MINUTES[window] - minutes,
      },
    ]
  );
  if (res.ok) return { ok: true };
  if (stops > 0) {
    // The minutes ceiling refused after the stop was won — give the stop
    // back so a failed claim leaks nothing.
    await casGuardedAdd(
      "CapacityDay",
      dayStopId(date, technicianId),
      { committedStops: -stops },
      [{ kind: "fieldAtLeast", field: "committedStops", value: stops }]
    ).catch(() => undefined);
  }
  if (res.reason === "UNSUPPORTED") return UNAVAILABLE;
  return {
    ok: false,
    soldOut: true,
    message: `That ${window.toLowerCase()} is now fully booked — pick another window or day.`,
  };
}

async function ensureDayStopRow(
  date: string,
  technicianId: string
): Promise<void> {
  const client = await dataClient();
  if (!("CapacityDay" in client.models)) return;
  await client.models.CapacityDay.create({
    id: dayStopId(date, technicianId),
    // No `date` attribute on purpose — see dayStopId.
    technicianId,
    committedStops: 0,
    verified: true,
  } as never).catch(() => undefined);
}

/** Give slot minutes back (a canceled/moved-off visit or a released claim).
 *  Guarded to never go negative; UNSUPPORTED leaves the minutes held (the
 *  safe direction — the nightly rebuild reclaims them from ground truth). */
export async function releaseSlot(
  date: string,
  window: CapacityWindow,
  technicianId: string,
  minutes: number,
  opts?: { stops?: number }
): Promise<void> {
  const client = await dataClient();
  if (!("CapacityDay" in client.models)) return;
  await casGuardedAdd(
    "CapacityDay",
    slotId(date, window, technicianId),
    { committedMinutes: -minutes },
    [{ kind: "fieldAtLeast", field: "committedMinutes", value: minutes }]
  );
  const stops = opts?.stops ?? 0;
  if (stops > 0) {
    // Independently guarded so drift in one counter can never leak the
    // other; the nightly rebuild converges both from ground truth.
    await casGuardedAdd(
      "CapacityDay",
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
  window: CapacityWindow,
  minutes: number
): Promise<void> {
  if (!(await capacityModelsReady())) return;
  await ensureSlot(date, window, POOL_TECH);
  await casGuardedAdd(
    "CapacityDay",
    slotId(date, window, POOL_TECH),
    { committedMinutes: minutes },
    []
  );
}

export async function releasePoolMinutes(
  date: string,
  window: CapacityWindow,
  minutes: number
): Promise<void> {
  await releaseSlot(date, window, POOL_TECH, minutes);
}

// ---------------------------------------------------------------------------
// Checkout claims — atomic, slot-bound, durable
// ---------------------------------------------------------------------------

export async function claimWindowSlot(input: {
  claimKey: string;
  date: string;
  window: CapacityWindow;
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
    window: input.window,
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
        existing.window === input.window &&
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
        input.window,
        input.technicianId,
        input.minutes
      );
      if (!takenNew.ok) return takenNew;
      const { data: moved } = await client.models.CapacityClaim.update({
        id: input.claimKey,
        date: input.date,
        window: input.window,
        technicianId: input.technicianId,
        minutes: input.minutes,
        address: input.address ?? undefined,
        expiresAt,
        holdReason: input.holdReason,
      }).catch(() => ({ data: null }));
      if (!moved) {
        await releaseSlot(
          input.date,
          input.window,
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
        (existing.window as CapacityWindow) ?? "MORNING",
        existing.technicianId ?? POOL_TECH,
        existing.minutes ?? 0
      ).catch(() => undefined);
      return { ok: true };
    }
    if (existing) await releaseCapacityClaim(input.claimKey);
    const { data: retried } = await client.models.CapacityClaim.create({
      id: input.claimKey,
      date: input.date,
      window: input.window,
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
    input.window,
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
    (claim.window as CapacityWindow) ?? "MORNING",
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
  capacityWindow?: string | null;
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
    pin("capacityWindow", job.capacityWindow ?? null),
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
  capacityWindow?: string | null;
  capacityMinutes?: number | null;
  technicianId?: string | null;
  capacityTechnicianId?: string | null;
}): {
  date: string;
  window: CapacityWindow;
  minutes: number;
  technicianId: string | null;
} | null {
  if (!job.scheduledDate) return null;
  if (job.capacityMinutes == null || !job.capacityWindow) return null;
  return {
    date: job.scheduledDate,
    window: job.capacityWindow as CapacityWindow,
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
  capacityWindow?: string | null;
  capacityMinutes?: number | null;
  technicianId?: string | null;
  capacityTechnicianId?: string | null;
}): Promise<void> {
  const facts = jobCapacityFacts(job);
  if (!facts || facts.minutes <= 0) return;
  if (facts.technicianId && facts.technicianId !== POOL_TECH) {
    await releaseSlot(
      facts.date,
      facts.window,
      facts.technicianId,
      facts.minutes,
      // GL-07: an ASSIGNED visit (technicianId, not a checkout hold) held
      // one stop on the technician's day — it comes back with the minutes.
      { stops: job.technicianId && job.technicianId !== POOL_TECH ? 1 : 0 }
    ).catch(() => undefined);
  } else {
    await releasePoolMinutes(facts.date, facts.window, facts.minutes).catch(
      () => undefined
    );
  }
}

/** Consume a claim into a booked visit: the row goes away WITHOUT giving the
 *  minutes back — the scheduled job carries them from now on. Returns the
 *  claim's slot facts so the job can be stamped with them. */
export async function consumeCapacityClaim(claimKey: string): Promise<{
  window: CapacityWindow;
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
    window: (claim.window as CapacityWindow) ?? "MORNING",
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
};

/**
 * Which technician-window slot (if any) can absorb the candidate stop.
 *
 * Marginal travel is measured with REAL Routes legs, no defaults:
 *  - an EMPTY slot pays base → candidate + candidate → base;
 *  - a slot with stops pays a nearest-stop insertion (2 × the Routes leg
 *    between the candidate and its nearest existing stop in that slot).
 * A leg Routes cannot produce makes that slot infeasible — fail closed. The
 * caller supplies the leg resolver (a memoized wrapper over Routes) so a
 * calendar of days shares its Routes calls.
 */
export async function bestSlotFor(opts: {
  date: string;
  window: CapacityWindow;
  onsite: number;
  eligibility: DayEligibility;
  slots: Map<string, SlotState>;
  /** slotId → the stop addresses already occupying that tech-window. */
  stopsBySlot: Map<string, string[]>;
  /** Routes minutes between two addresses; null = unroutable (fail closed). */
  legMinutes: (from: string, to: string) => Promise<number | null>;
  candidateAddress: string;
}): Promise<SlotFeasibility | null> {
  const { date, window, onsite } = opts;
  let best: SlotFeasibility | null = null;
  for (const tech of opts.eligibility.techs) {
    const id = slotId(date, window, tech.id);
    const state = opts.slots.get(id);
    if (state && !state.verified) continue; // fail closed until Routes verifies
    const committed = state?.committedMinutes ?? 0;
    const stops = opts.stopsBySlot.get(id) ?? [];
    let marginalTravel: number | null = null;
    if (stops.length === 0) {
      const out = await opts.legMinutes(tech.baseAddress, opts.candidateAddress);
      const back = await opts.legMinutes(opts.candidateAddress, tech.baseAddress);
      if (out != null && back != null) marginalTravel = out + back;
    } else {
      let nearest: number | null = null;
      for (const stop of stops) {
        const leg = await opts.legMinutes(opts.candidateAddress, stop);
        if (leg != null && (nearest === null || leg < nearest)) nearest = leg;
      }
      if (nearest != null) marginalTravel = nearest * 2;
    }
    if (marginalTravel == null) continue; // no Routes answer → not sellable here
    const claimMinutes = onsite + marginalTravel;
    if (committed + claimMinutes > WINDOW_MINUTES[window]) continue;
    if (!best || claimMinutes < best.claimMinutes) {
      best = { technicianId: tech.id, claimMinutes };
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

/** The stops currently occupying each technician-window slot on a date —
 *  scheduled jobs (by their stamped or parsed window) plus live claims. */
export async function stopsBySlotOn(
  date: string
): Promise<Map<string, string[]>> {
  const client = await dataClient();
  const out = new Map<string, string[]>();
  const push = (key: string, address: string | null) => {
    if (!address) return;
    const list = out.get(key) ?? [];
    list.push(address);
    out.set(key, list);
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
      const window =
        (job.capacityWindow as CapacityWindow | null) ??
        windowOfTimeWindow(job.timeWindow);
      const { data: customer } = await client.models.Customer.get({
        id: job.customerId,
      });
      const address = customer
        ? [
            customer.serviceStreet,
            customer.serviceCity,
            customer.serviceState,
            customer.serviceZip,
          ]
            .filter(Boolean)
            .join(", ")
        : null;
      push(slotId(date, window, stopTechId), address);
    }
    token = page.nextToken;
  } while (token);
  for (const claim of await liveClaimsOn(date)) {
    if (claim.technicianId === POOL_TECH) continue;
    push(slotId(date, claim.window, claim.technicianId), claim.address);
  }
  return out;
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
      const window =
        (job.capacityWindow as CapacityWindow | null) ??
        windowOfTimeWindow(job.timeWindow);
      // A paid funnel booking holds a SPECIFIC technician's window before any
      // office assignment exists — the rebuild must keep that hold, not
      // reclassify it to the non-blocking pool.
      const techId = pendingAssignment
        ? POOL_TECH
        : (job.technicianId ??
          (job as { capacityTechnicianId?: string | null })
            .capacityTechnicianId ??
          POOL_TECH);
      const key = slotId(date, window, techId);
      const { data: customer } = await client.models.Customer.get({
        id: job.customerId,
      });
      const address = customer
        ? [
            customer.serviceStreet,
            customer.serviceCity,
            customer.serviceState,
            customer.serviceZip,
          ]
            .filter(Boolean)
            .join(", ")
        : null;
      const list = jobsBySlot.get(key) ?? [];
      list.push({
        id: job.id,
        routeOrder: job.routeOrder ?? 999,
        address,
        onsite: onsiteMinutes(job.propertyClass),
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
    const key = slotId(date, claim.window, claim.technicianId);
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
    const [, window, techId] = id.split("#") as [string, CapacityWindow, string];
    const stops = (jobsBySlot.get(id) ?? []).sort(
      (a, b) => a.routeOrder - b.routeOrder
    );
    let minutes = 0;
    let verified = true;
    if (techId === POOL_TECH) {
      // Pool accounting: on-site only (no route exists yet).
      minutes = stops.reduce((sum, s) => sum + s.onsite, 0);
    } else if (stops.length > 0) {
      const base =
        eligibility.techs.find((t) => t.id === techId)?.baseAddress ?? null;
      if (!base) {
        // The technician isn't eligible for this date (or the facts could not
        // be read) yet holds stops — flagged unverified; the day-before
        // dispatch sweep owns the human fix.
        verified = false;
      } else {
        let prev = base;
        for (const stop of stops) {
          if (!stop.address) {
            verified = false;
            break;
          }
          const leg = await legMinutes(prev, stop.address);
          if (leg == null) {
            verified = false;
            break;
          }
          minutes += leg + stop.onsite;
          prev = stop.address;
        }
        if (verified) {
          const home = await legMinutes(prev, base);
          if (home == null) verified = false;
          else minutes += home;
        }
      }
    }
    minutes += claimMinutesBySlot.get(id) ?? 0;
    await ensureSlot(date, window, techId);
    const sets = {
      committedMinutes: verified ? minutes : WINDOW_MINUTES[window] ?? 300,
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
    let token2: string | null | undefined;
    do {
      const page = await (
        client.models.CapacityDay.list as (a: object) => Promise<{
          data: { id: string; technicianId?: string | null }[];
          nextToken?: string | null;
        }>
      )({ limit: 500, nextToken: token2 });
      for (const row of page.data ?? []) {
        if (row.id.startsWith(`stops#${date}#`) && row.technicianId) {
          stopRowTechs.add(row.technicianId);
        }
      }
      token2 = page.nextToken;
    } while (token2);
  }
  for (const techId of stopRowTechs) {
    const trueStops = assignedStopsByTechFinal.get(techId) ?? 0;
    const id = dayStopId(date, techId);
    await ensureDayStopRow(date, techId);
    const sets = {
      committedStops: trueStops,
      reconciledAt: new Date().toISOString(),
    };
    const written = await casGuardedUpdate("CapacityDay", id, sets, []);
    if (!written.ok && written.reason === "UNSUPPORTED") {
      await client.models.CapacityDay.update({ id, ...sets }).catch(
        () => undefined
      );
    }
  }
  return { slots, expiredClaims, unverified };
}
