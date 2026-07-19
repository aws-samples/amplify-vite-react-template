import { dataClient } from "./dataClient";
import { casGuardedAdd } from "./atomicLock";
import { onsiteMinutesFor } from "./dispatchReadiness";
import { licenseFactsFromRecords, licenseRecordsFor } from "./licenses";

/**
 * GL-04 — the ONE capacity rule, in minutes, shared by the funnel calendar,
 * checkout, the dispatch board, and office reschedules.
 *
 *  - A working day is Monday–Friday, 8:00–5:00 Eastern: 540 minutes per
 *    eligible technician. Weekends, company closures, PTO, inactive status,
 *    and a failed-or-missing current licence contribute NOTHING — zero
 *    eligible technicians means zero sellable minutes (no floor of one).
 *  - A visit consumes its locked on-site minutes (residential 30;
 *    commercial/community 60) plus its travel allowance — the persisted
 *    Google Routes drive minutes when the dispatch proof exists, else a
 *    conservative default.
 *  - The day's committed minutes live on ONE CapacityDay ledger row
 *    maintained by ATOMIC guarded increments: taking minutes succeeds only
 *    while the guarded add's fit condition holds, so two concurrent
 *    purchases (or two office moves) can never both take the last minutes.
 *  - A checkout attempt takes a durable CapacityClaim BEFORE the payment
 *    attempt; success consumes it into the booked job (the minutes ride the
 *    job from then on), an accepted pending bank debit EXTENDS it so the
 *    slot stays counted while the money settles, and failure/abandonment
 *    releases it. The reconcile sweep expires crashed checkouts and heals
 *    ledger drift from the ground truth.
 */

export const WORKDAY_MINUTES = 540;

/** The travel allowance when no Google Routes proof is on the visit yet. */
export const DEFAULT_TRAVEL_MINUTES = 30;

/** How long a card checkout may hold a claim before the sweep releases it. */
export const CHECKOUT_CLAIM_MS = 45 * 60_000;

/** How long an accepted pending bank debit keeps its claim while settling. */
export const PROCESSING_CLAIM_MS = 7 * 24 * 60 * 60_000;

/** House model-absence guard: a unit-test fake or a container straddling the
 *  schema deploy lacks the capacity models — enforcement is skipped there
 *  (permissive), exactly like every other model guard in this codebase. In
 *  production every model exists and the rule enforces. */
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

export function isWeekday(date: string): boolean {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  return dow >= 1 && dow <= 5;
}

/** The minutes one visit consumes: locked on-site duration + travel. */
export function visitMinutes(job: {
  propertyClass?: string | null;
  dispatchDriveMinutes?: number | null;
}): number {
  return (
    onsiteMinutesFor(job.propertyClass) +
    (job.dispatchDriveMinutes && job.dispatchDriveMinutes > 0
      ? Math.round(job.dispatchDriveMinutes)
      : DEFAULT_TRAVEL_MINUTES)
  );
}

export type DayCapacity = {
  capMinutes: number;
  eligibleTechs: number;
  /** Why the day sells what it sells — the Operations readout. */
  reasons: string[];
};

/**
 * Batch variant for a calendar window: ONE roster + licence-records read for
 * every date (the funnel calendar calls this for ~45 days). Same fail-closed
 * rules as the single-day form.
 */
export async function dayCapacityMap(
  dates: string[]
): Promise<Map<string, DayCapacity>> {
  const out = new Map<string, DayCapacity>();
  const client = await dataClient();

  type TechRow = {
    id: string;
    name?: string | null;
    active?: boolean | null;
    licenseNumber?: string | null;
    licenseExpiresOn?: string | null;
  };
  let techs: TechRow[] = [];
  let rosterFailed = false;
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
    console.error("dayCapacityMap: roster read failed", err);
    rosterFailed = true;
  }
  const active = techs.filter((t) => t.active);
  const recordsByTech = new Map<string, Awaited<ReturnType<typeof licenseRecordsFor>>>();
  if (!rosterFailed) {
    for (const t of active) {
      recordsByTech.set(t.id, await licenseRecordsFor(t.id));
    }
  }

  for (const date of dates) {
    if (rosterFailed) {
      out.set(date, {
        capMinutes: 0,
        eligibleTechs: 0,
        reasons: ["The technician roster could not be read — selling capacity blind is not allowed."],
      });
      continue;
    }
    if (!isWeekday(date)) {
      out.set(date, {
        capMinutes: 0,
        eligibleTechs: 0,
        reasons: ["Weekend — technicians work Monday–Friday."],
      });
      continue;
    }
    if ("CompanyClosure" in client.models) {
      const { data: closure } = await client.models.CompanyClosure.get({
        id: date,
      }).catch(() => ({ data: null }));
      if (closure) {
        out.set(date, {
          capMinutes: 0,
          eligibleTechs: 0,
          reasons: [`Company closure: ${closure.reason}.`],
        });
        continue;
      }
    }
    const onPto = new Set<string>();
    let exceptionsFailed = false;
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
          }
          token = page.nextToken;
        } while (token);
      } catch (err) {
        console.error("dayCapacityMap: exception read failed", date, err);
        exceptionsFailed = true;
      }
    }
    if (exceptionsFailed) {
      out.set(date, {
        capMinutes: 0,
        eligibleTechs: 0,
        reasons: ["The availability exceptions could not be read — selling capacity blind is not allowed."],
      });
      continue;
    }
    const reasons: string[] = [];
    let eligible = 0;
    for (const t of active) {
      if (onPto.has(t.id)) {
        reasons.push(`${t.name ?? t.id} is on PTO.`);
        continue;
      }
      const records = recordsByTech.get(t.id) ?? null;
      if (records === null) {
        reasons.push(`${t.name ?? t.id}'s licence records could not be read (fail closed).`);
        continue;
      }
      if (!licenseFactsFromRecords(records, t, date).current) {
        reasons.push(`${t.name ?? t.id} has no current licence on ${date}.`);
        continue;
      }
      eligible++;
    }
    if (eligible === 0) reasons.push("No eligible technician — the day sells nothing.");
    out.set(date, {
      capMinutes: eligible * WORKDAY_MINUTES,
      eligibleTechs: eligible,
      reasons,
    });
  }
  return out;
}

/**
 * The day's sellable minutes from the live operating facts. Fail-closed
 * throughout: a licence-records read failure makes that technician
 * contribute nothing, and an unreadable roster sells nothing.
 */
export async function dayCapacityMinutes(date: string): Promise<DayCapacity> {
  if (!isWeekday(date)) {
    return { capMinutes: 0, eligibleTechs: 0, reasons: ["Weekend — technicians work Monday–Friday."] };
  }
  const client = await dataClient();
  if ("CompanyClosure" in client.models) {
    const { data: closure } = await client.models.CompanyClosure.get({
      id: date,
    }).catch(() => ({ data: null }));
    if (closure) {
      return {
        capMinutes: 0,
        eligibleTechs: 0,
        reasons: [`Company closure: ${closure.reason}.`],
      };
    }
  }
  const reasons: string[] = [];
  let techs: { id: string; name?: string | null; active?: boolean | null; licenseNumber?: string | null; licenseExpiresOn?: string | null }[] = [];
  try {
    let token: string | null | undefined;
    do {
      const page = await client.models.Technician.list({
        limit: 200,
        nextToken: token,
      });
      techs.push(...((page.data ?? []) as typeof techs));
      token = page.nextToken;
    } while (token);
  } catch (err) {
    console.error("dayCapacityMinutes: roster read failed", err);
    return {
      capMinutes: 0,
      eligibleTechs: 0,
      reasons: ["The technician roster could not be read — selling capacity blind is not allowed."],
    };
  }

  // PTO for the day (one paged read, applied to all technicians).
  const onPto = new Set<string>();
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
        }
        token = page.nextToken;
      } while (token);
    } catch (err) {
      console.error("dayCapacityMinutes: exception read failed", date, err);
      // Fail closed: unknown PTO state must not oversell — count nobody.
      return {
        capMinutes: 0,
        eligibleTechs: 0,
        reasons: ["The availability exceptions could not be read — selling capacity blind is not allowed."],
      };
    }
  }

  let eligible = 0;
  for (const t of techs) {
    if (!t.active) continue;
    if (onPto.has(t.id)) {
      reasons.push(`${t.name ?? t.id} is on PTO.`);
      continue;
    }
    const records = await licenseRecordsFor(t.id);
    if (records === null) {
      reasons.push(`${t.name ?? t.id}'s licence records could not be read (fail closed).`);
      continue;
    }
    if (!licenseFactsFromRecords(records, t, date).current) {
      reasons.push(`${t.name ?? t.id} has no current licence on ${date}.`);
      continue;
    }
    eligible++;
  }
  if (eligible === 0) {
    reasons.push("No eligible technician — the day sells nothing.");
  }
  return { capMinutes: eligible * WORKDAY_MINUTES, eligibleTechs: eligible, reasons };
}

/** The day's committed minutes from ground truth: every counted visit plus
 *  every live (unexpired) checkout claim. */
export async function committedMinutesOn(
  date: string
): Promise<{ minutes: number; jobs: number; claims: number }> {
  const client = await dataClient();
  let minutes = 0;
  let jobs = 0;
  let claims = 0;
  let token: string | null | undefined;
  do {
    const page = await client.models.Job.listJobByScheduledDate(
      { scheduledDate: date },
      { limit: 200, nextToken: token }
    );
    for (const job of page.data ?? []) {
      if (
        job.status === "SCHEDULED" ||
        job.status === "IN_PROGRESS" ||
        job.status === "UNSCHEDULED"
      ) {
        minutes += visitMinutes(job);
        jobs++;
      }
    }
    token = page.nextToken;
  } while (token);
  if ("CapacityClaim" in client.models) {
    const nowIso = new Date().toISOString();
    let claimToken: string | null | undefined;
    do {
      const page = await client.models.CapacityClaim.listCapacityClaimByDate(
        { date },
        { limit: 200, nextToken: claimToken }
      );
      for (const claim of page.data ?? []) {
        if (String(claim.expiresAt) > nowIso) {
          minutes += claim.minutes ?? 0;
          claims++;
        }
      }
      claimToken = page.nextToken;
    } while (claimToken);
  }
  return { minutes, jobs, claims };
}

async function ensureCapacityDay(date: string): Promise<void> {
  const client = await dataClient();
  if (!("CapacityDay" in client.models)) return;
  await client.models.CapacityDay.create({
    id: date,
    date,
    committedMinutes: 0,
  }).catch(() => undefined);
}

export type ClaimOutcome =
  | { ok: true }
  | { ok: false; soldOut: true; message: string }
  | { ok: false; soldOut: false; message: string };

async function guardedAdd(
  date: string,
  delta: number,
  fitUnder?: number
): Promise<"OK" | "LOST" | "UNSUPPORTED"> {
  const res = await casGuardedAdd(
    "CapacityDay",
    date,
    { committedMinutes: delta },
    fitUnder != null
      ? [
          {
            kind: "fieldAtMostOrMissing",
            field: "committedMinutes",
            value: fitUnder,
          },
        ]
      : delta < 0
        ? [{ kind: "fieldAtLeast", field: "committedMinutes", value: -delta }]
        : []
  );
  if (res.ok) return "OK";
  return res.reason;
}

/** Take minutes for a SCHEDULED commitment (an office assign/reschedule or a
 *  finalized booking without a prior claim). Refuses when the day can't fit. */
export async function reserveScheduledMinutes(
  date: string,
  minutes: number
): Promise<ClaimOutcome> {
  if (!(await capacityModelsReady())) return { ok: true };
  const cap = await dayCapacityMinutes(date);
  if (cap.capMinutes <= 0) {
    return {
      ok: false,
      soldOut: true,
      message: cap.reasons[0] ?? "This day has no capacity.",
    };
  }
  await ensureCapacityDay(date);
  const res = await guardedAdd(date, minutes, cap.capMinutes - minutes);
  if (res === "OK") return { ok: true };
  if (res === "LOST") {
    return {
      ok: false,
      soldOut: true,
      message: "That day is now fully booked — pick another day.",
    };
  }
  // UNSUPPORTED (unit fakes / straddling): the read-then-check fallback —
  // the legacy level of protection.
  const committed = await committedMinutesOn(date);
  if (committed.minutes + minutes > cap.capMinutes) {
    return {
      ok: false,
      soldOut: true,
      message: "That day is fully booked — pick another day.",
    };
  }
  return { ok: true };
}

/** Count minutes for a SYSTEM-created commitment that is never refused (the
 *  recurring engine's auto-queued next visit): an unconditional guarded add —
 *  overbooking here surfaces on the Operations readout, not as a lost visit. */
export async function noteScheduledMinutes(
  date: string,
  minutes: number
): Promise<void> {
  if (!(await capacityModelsReady())) return;
  await ensureCapacityDay(date);
  const res = await guardedAdd(date, minutes);
  if (res === "UNSUPPORTED") {
    const client = await dataClient();
    if (!("CapacityDay" in client.models)) return;
    const { data: day } = await client.models.CapacityDay.get({ id: date });
    await client.models.CapacityDay.update({
      id: date,
      committedMinutes: (day?.committedMinutes ?? 0) + minutes,
    }).catch(() => undefined);
  }
}

/** Give minutes back (a canceled/moved-off visit or a released claim). */
export async function releaseScheduledMinutes(
  date: string,
  minutes: number
): Promise<void> {
  if (!(await capacityModelsReady())) return;
  await ensureCapacityDay(date);
  const res = await guardedAdd(date, -minutes);
  if (res === "UNSUPPORTED") {
    // Fallback: best-effort AppSync decrement (reconcile heals drift).
    const client = await dataClient();
    if (!("CapacityDay" in client.models)) return;
    const { data: day } = await client.models.CapacityDay.get({ id: date });
    if (day) {
      await client.models.CapacityDay.update({
        id: date,
        committedMinutes: Math.max(0, (day.committedMinutes ?? 0) - minutes),
      }).catch(() => undefined);
    }
  }
}

/**
 * GL-04 R1 — the checkout claim: durable, atomic, and exactly one per
 * booking attempt. Taken BEFORE the payment attempt so "your slot is held"
 * is a fact. Idempotent per claimKey (a retry of the same booking adopts its
 * live claim).
 */
export async function claimCapacity(input: {
  claimKey: string;
  date: string;
  minutes: number;
  holdMs?: number;
  holdReason?: string;
}): Promise<ClaimOutcome> {
  if (!(await capacityModelsReady())) return { ok: true };
  const client = await dataClient();
  const expiresAt = new Date(
    Date.now() + (input.holdMs ?? CHECKOUT_CLAIM_MS)
  ).toISOString();
  const { data: created } = await client.models.CapacityClaim.create({
    id: input.claimKey,
    date: input.date,
    minutes: input.minutes,
    expiresAt,
    holdReason: input.holdReason,
  });
  if (!created) {
    const { data: existing } = await client.models.CapacityClaim.get({
      id: input.claimKey,
    });
    if (existing && String(existing.expiresAt) > new Date().toISOString()) {
      // The same attempt retrying — its claim is live; extend the hold.
      await client.models.CapacityClaim.update({
        id: input.claimKey,
        expiresAt,
      }).catch(() => undefined);
      return { ok: true };
    }
    // An expired leftover from a dead attempt with the same key: release it
    // first (gives its minutes back), then take fresh.
    if (existing) await releaseCapacityClaim(input.claimKey);
    const { data: retried } = await client.models.CapacityClaim.create({
      id: input.claimKey,
      date: input.date,
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
  // The claim row exists; now take the minutes atomically. Losing the fit
  // check deletes the row — the claim never lies about holding capacity.
  const taken = await reserveScheduledMinutes(input.date, input.minutes);
  if (!taken.ok) {
    await client.models.CapacityClaim.delete({ id: input.claimKey }).catch(
      () => undefined
    );
    return taken;
  }
  return { ok: true };
}

/** Extend a live claim (an accepted pending bank debit keeps its slot while
 *  the money settles). */
export async function extendCapacityClaim(
  claimKey: string,
  holdMs: number
): Promise<void> {
  const client = await dataClient();
  if (!("CapacityClaim" in client.models)) return;
  await client.models.CapacityClaim.update({
    id: claimKey,
    expiresAt: new Date(Date.now() + holdMs).toISOString(),
  }).catch(() => undefined);
}

/** Release a claim: the attempt failed or was abandoned — the minutes go
 *  back. Idempotent (a second release finds no row and does nothing). */
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
  await releaseScheduledMinutes(String(claim.date), claim.minutes ?? 0);
}

/** Consume a claim into a booked visit: the row goes away WITHOUT giving the
 *  minutes back — the scheduled job carries them from now on. */
export async function consumeCapacityClaim(claimKey: string): Promise<void> {
  const client = await dataClient();
  if (!("CapacityClaim" in client.models)) return;
  await client.models.CapacityClaim.delete({ id: claimKey }).catch(
    () => undefined
  );
}

/**
 * Heal one day's ledger from ground truth (jobs + live claims) and expire
 * dead claims. The counter is an optimization for atomicity; the truth stays
 * the schedule — this keeps them agreeing without manual repair.
 */
export async function reconcileCapacityDay(
  date: string
): Promise<{ committedMinutes: number; expiredClaims: number }> {
  if (!(await capacityModelsReady())) {
    return { committedMinutes: 0, expiredClaims: 0 };
  }
  const client = await dataClient();
  let expiredClaims = 0;
  if ("CapacityClaim" in client.models) {
    const nowIso = new Date().toISOString();
    let token: string | null | undefined;
    do {
      const page = await client.models.CapacityClaim.listCapacityClaimByDate(
        { date },
        { limit: 200, nextToken: token }
      );
      for (const claim of page.data ?? []) {
        if (String(claim.expiresAt) <= nowIso) {
          // Expired checkout: release (idempotent) — gives minutes back too.
          await releaseCapacityClaim(claim.id);
          expiredClaims++;
        }
      }
      token = page.nextToken;
    } while (token);
  }
  const committed = await committedMinutesOn(date);
  if ("CapacityDay" in client.models) {
    await ensureCapacityDay(date);
    await client.models.CapacityDay.update({
      id: date,
      committedMinutes: committed.minutes,
      reconciledAt: new Date().toISOString(),
    }).catch(() => undefined);
  }
  return { committedMinutes: committed.minutes, expiredClaims };
}
