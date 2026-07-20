import { randomUUID } from "node:crypto";
import {
  casFencedUpdate,
  casGuardedAdd,
  casGuardedUpdate,
  casTakeover,
} from "./atomicLock";
import { dataClient } from "./dataClient";

/**
 * GL-16 — the pricing engine's concurrency and money controls.
 *
 * The July cost incident: the refresh cron fires every 5 minutes but a run
 * can hold the line for 13+, and nothing serialized the drains. Overlapping
 * invocations each selected the SAME head-of-queue combos (the attempt stamp
 * landed only after a 10–60s research finished), each paid for its own
 * provider call, and each emailed the office per rate. The "daily budget"
 * was a count of coverage rows with a recent lastAttemptAt — a combo
 * retried ten times counted once, failures whose bookkeeping write threw
 * counted zero, and concurrent runs each read the same stale number.
 *
 * The controls here make that impossible:
 *
 *  - ONE drain lease (PricingControl id "drain"): exactly one invocation
 *    researches at a time; the lease outlives the Lambda timeout, so a
 *    crashed run's successor takes over atomically and losers exit without
 *    spending anything.
 *  - ATOMIC daily budget (PricingControl id "day#YYYY-MM-DD"): every
 *    provider request RESERVES budget with a conditional increment BEFORE
 *    the call, so failures, retries, and timeouts all consume it, and no
 *    interleaving of invocations can exceed the shared caps.
 *  - Per-combo research lease on the RateCoverage row: even a stale-lease
 *    takeover mid-research cannot double-research the combo, and every
 *    notify-list mutation is fenced on the lease nonce.
 *
 * UNSUPPORTED (no CAS wiring) always refuses the spend: blocked research is
 * safe, an unbounded provider bill is not.
 */

export const PRICING_CONTROL_MODEL = "PricingControl";
export const DRAIN_ID = "pricing-drain";

/** Longer than the Lambda's 900s timeout: a crashed run's lease dies before
 *  the second cron after it, and no live run can lose its own lease. */
export const DRAIN_LEASE_MS = 16 * 60_000;

/** A row lease outlives one research (≤60s) plus its notify emails. */
export const ROW_LEASE_MS = 5 * 60_000;

export function dayKeyFor(now: Date): string {
  return `day#${now.toISOString().slice(0, 10)}`;
}

export function freshNonce(): string {
  return randomUUID();
}

/** Create-if-absent for a control row; loses races harmlessly. */
async function ensureControlRow(
  id: string,
  kind: "DRAIN" | "DAY"
): Promise<void> {
  try {
    const client = await dataClient();
    const { data } = await client.models.PricingControl.get({ id });
    if (data) return;
    await client.models.PricingControl.create({
      id,
      kind,
      attempts: 0,
      demandAttempts: 0,
      succeeded: 0,
      failed: 0,
    });
  } catch {
    /* a racer created it, or the model is absent (tests) — the guarded
       write that follows is the authority either way */
  }
}

/**
 * Take the single drain lease. Exactly one concurrent invocation wins; a
 * loser must exit without draining. UNSUPPORTED (no CAS wiring / the lock
 * layer misconfigured) THROWS: without it there is no single-winner
 * guarantee and no research may run — and the July staging defect proved
 * that reading an infrastructure failure as "lease held" silences the
 * worker forever. A loud run failure trips the Errors alarm instead.
 */
export async function acquireDrain(nonce: string): Promise<boolean> {
  await ensureControlRow(DRAIN_ID, "DRAIN");
  const res = await casTakeover(PRICING_CONTROL_MODEL, DRAIN_ID, {
    nonceField: "holderNonce",
    nonce,
    leaseField: "leaseUntil",
    leaseMs: DRAIN_LEASE_MS,
  });
  if (!res.ok && res.reason === "UNSUPPORTED") {
    throw new Error(
      "pricing drain: CAS lock layer unavailable — refusing to run (this is an infrastructure failure, not a held lease)"
    );
  }
  return res.ok;
}

/** Release the drain lease (fenced — a stale holder cannot release its
 *  successor's lease). Failure is harmless: the lease expires on its own. */
export async function releaseDrain(nonce: string): Promise<void> {
  await casFencedUpdate(
    PRICING_CONTROL_MODEL,
    DRAIN_ID,
    { field: "holderNonce", nonce },
    { leaseUntil: null }
  ).catch(() => undefined);
}

export type BudgetLane = "GENERAL" | "DEMAND";

/**
 * Reserve one research from the day's shared budget — BEFORE the provider
 * call, so every attempt (success, failure, timeout) consumes it. GENERAL
 * reservations respect the overall daily cap; DEMAND reservations (a lead
 * is waiting) respect their own reserve cap and also count in the total.
 * Atomic: overlapping invocations can never jointly exceed a cap.
 */
export async function reserveBudget(
  now: Date,
  lane: BudgetLane,
  caps: { perDay: number; demandPerDay: number }
): Promise<boolean> {
  const id = dayKeyFor(now);
  await ensureControlRow(id, "DAY");
  const res =
    lane === "DEMAND"
      ? await casGuardedAdd(
          PRICING_CONTROL_MODEL,
          id,
          { attempts: 1, demandAttempts: 1 },
          [
            {
              kind: "fieldAtMostOrMissing",
              field: "demandAttempts",
              value: caps.demandPerDay - 1,
            },
          ]
        )
      : await casGuardedAdd(PRICING_CONTROL_MODEL, id, { attempts: 1 }, [
          {
            kind: "fieldAtMostOrMissing",
            field: "attempts",
            value: caps.perDay - 1,
          },
        ]);
  if (!res.ok && res.reason === "UNSUPPORTED") {
    throw new Error(
      "pricing budget: CAS lock layer unavailable — refusing all research spend (infrastructure failure, not budget exhaustion)"
    );
  }
  return res.ok;
}

/** Tally a reserved attempt's outcome on the day row (visibility counters —
 *  budget was already consumed at reservation). */
export async function recordOutcome(now: Date, ok: boolean): Promise<void> {
  const id = dayKeyFor(now);
  await ensureControlRow(id, "DAY");
  await casGuardedAdd(
    PRICING_CONTROL_MODEL,
    id,
    ok ? { succeeded: 1 } : { failed: 1 },
    []
  ).catch(() => undefined);
}

/** The once-only claim on the day's digest email — atomic across overlaps. */
export async function claimDailyDigest(now: Date): Promise<boolean> {
  const id = dayKeyFor(now);
  await ensureControlRow(id, "DAY");
  const res = await casGuardedUpdate(
    PRICING_CONTROL_MODEL,
    id,
    { digestSentAt: now.toISOString() },
    [{ kind: "fieldMissingOrNull", field: "digestSentAt" }]
  );
  return res.ok;
}

/**
 * Lease one coverage row for research/delivery. Refuses while any live
 * lease exists — a stale drain takeover cannot re-research a combo the
 * expired worker is still mid-flight on. UNSUPPORTED refuses the lease
 * (and therefore the spend).
 */
export async function leaseCoverageRow(
  id: string,
  nonce: string,
  now: Date
): Promise<boolean> {
  const res = await casGuardedUpdate(
    "RateCoverage",
    id,
    {
      leaseNonce: nonce,
      leaseUntil: new Date(now.getTime() + ROW_LEASE_MS).toISOString(),
    },
    [{ kind: "notLiveLease", field: "leaseUntil", nowIso: now.toISOString() }]
  );
  return res.ok;
}

/** A settle/progress write on a leased coverage row, fenced on the lease
 *  nonce: a worker that lost its lease cannot overwrite its successor. */
export async function settleCoverageRow(
  id: string,
  nonce: string,
  sets: Record<string, string | number | boolean | null>
): Promise<boolean> {
  const res = await casFencedUpdate(
    "RateCoverage",
    id,
    { field: "leaseNonce", nonce },
    sets
  );
  return res.ok;
}
