import { dataClient } from "./dataClient";
import { POOL_TECH, recomputeSlotMinutes, techBaseFor } from "./capacity";
import { driveMatrixFrom } from "./driveTime";
import { routingAddress } from "./serviceAddress";

/**
 * Per-technician-day route optimization.
 *
 * A technician starts and ends the day at their private base (or that day's
 * BASE_OVERRIDE). Their scheduled stops can be visited in any order, and the
 * order changes the total drive time. `optimizeTechDay` re-sequences the day
 * into the shortest closed tour — base → stops → base — and writes the new
 * routeOrder on each stop, so the field app, the dispatch board, and the
 * nightly capacity rebuild all see the optimized route. It runs whenever a job
 * is scheduled onto (or removed from) a technician's day.
 *
 * It is BEST-EFFORT and FAIL-SAFE. A missing base, an unroutable leg, a stop
 * with no address, a day already in progress, or any thrown error leaves the
 * existing order untouched — it never rejects into the scheduling mutation
 * that called it, and it never invents an order it cannot measure.
 */

/** The most stops Held-Karp will solve exactly (2^n state). Comfortably above
 *  the GL-07 eight-stop day ceiling; a larger day is left as-is rather than
 *  risking an exponential solve. */
const MAX_EXACT_STOPS = 12;

type TechStop = { id: string; address: string; routeOrder: number };

export async function optimizeTechDay(opts: {
  technicianId: string | null | undefined;
  date: string | null | undefined;
  /** Routes key; falls back to the function's env var. No key ⇒ no-op (we
   *  never reorder on guessed travel). */
  routesKey?: string | null;
}): Promise<{ optimized: boolean; order?: string[] }> {
  try {
    const technicianId = opts.technicianId ?? "";
    const date = opts.date ?? "";
    if (!technicianId || technicianId === POOL_TECH || !date) {
      return { optimized: false };
    }
    const routesKey = opts.routesKey ?? process.env.GOOGLE_ROUTES_API_KEY ?? null;
    if (!routesKey) return { optimized: false };

    const client = await dataClient();
    if (
      !("Job" in client.models) ||
      typeof (
        client.models.Job as { listJobByScheduledDate?: unknown }
      ).listJobByScheduledDate !== "function"
    ) {
      return { optimized: false };
    }

    // The technician's active stops for the date, in current order.
    const stops: TechStop[] = [];
    let token: string | null | undefined;
    do {
      const page = await client.models.Job.listJobByScheduledDate(
        { scheduledDate: date },
        { limit: 200, nextToken: token }
      );
      for (const job of page.data ?? []) {
        if (job.technicianId !== technicianId) continue;
        if (job.status !== "SCHEDULED" && job.status !== "IN_PROGRESS") continue;
        // The tech is already driving a day in progress — re-sequencing it
        // would move a stop out from under them. Leave it exactly as routed.
        if (job.status === "IN_PROGRESS") return { optimized: false };
        const { data: customer } = await client.models.Customer.get({
          id: job.customerId,
        });
        // ROUTING address — the unit is deliberately excluded (serviceAddress.ts).
        const address = customer ? routingAddress(customer) : "";
        // A stop with no address cannot be routed — fail closed, don't guess.
        if (!address) return { optimized: false };
        stops.push({ id: job.id, address, routeOrder: job.routeOrder ?? 999 });
      }
      token = page.nextToken;
    } while (token);

    // Zero or one stop has nothing to sequence.
    if (stops.length <= 1) return { optimized: false };
    if (stops.length > MAX_EXACT_STOPS) return { optimized: false };

    const base = await techBaseFor(technicianId, date);
    if (!base) return { optimized: false };

    // Drive matrix over [base, ...stops]: one Routes matrix call per origin.
    const points = [base, ...stops.map((s) => s.address)];
    const n = points.length;
    const matrix: (number | null)[][] = [];
    for (let i = 0; i < n; i++) {
      const dests = points.filter((_, k) => k !== i);
      const legs = await driveMatrixFrom(routesKey, points[i], dests);
      const row: (number | null)[] = [];
      let di = 0;
      for (let k = 0; k < n; k++) row.push(k === i ? 0 : (legs[di++] ?? null));
      matrix.push(row);
    }

    const order = solveClosedTsp(matrix);
    if (!order) return { optimized: false }; // some leg unroutable → leave as-is

    // Write routeOrder 1..N in the optimized sequence, only where it changed.
    await Promise.all(
      order.map((stopIdx, seq) => {
        const stop = stops[stopIdx];
        if (stop.routeOrder === seq + 1) return undefined;
        return client.models.Job.update({
          id: stop.id,
          routeOrder: seq + 1,
        }).catch(() => undefined);
      })
    );
    return { optimized: true, order: order.map((i) => stops[i].id) };
  } catch {
    return { optimized: false };
  }
}

/**
 * Re-sequence a technician's day into the shortest closed tour AND rebuild that
 * day's capacity ledger from the new order — the two always belong together.
 * Optimizing the route sets the sequence the ledger measures travel along, so
 * after this returns the stored travelMinutes/treatmentMinutes reflect the real
 * optimized tour (one base out-and-back for the whole cluster) instead of
 * drifting on the per-stop marginal estimates the atomic reservation adds.
 *
 * Call this everywhere a scheduling mutation lands a stop on (or lifts one off)
 * a technician's day. Both steps are best-effort and non-fatal — the ledger
 * recompute runs even when optimizeTechDay early-returns (a day left with ≤1
 * stop still needs its minutes dropped).
 */
export async function resequenceAndRebuildDay(opts: {
  technicianId: string | null | undefined;
  date: string | null | undefined;
  routesKey?: string | null;
}): Promise<void> {
  await optimizeTechDay(opts).catch(() => undefined);
  await recomputeSlotMinutes(
    opts.date ?? "",
    opts.technicianId ?? "",
    opts.routesKey
  ).catch(() => undefined);
}

/**
 * Exact shortest closed tour that starts and ends at index 0 (the base) and
 * visits every other index once — Held-Karp DP over stop subsets. Returns the
 * visiting order as STOP indices into the caller's stop array (matrix index −1),
 * or null when no fully-routable tour exists.
 */
export function solveClosedTsp(matrix: (number | null)[][]): number[] | null {
  const n = matrix.length; // base at 0, stops at 1..n-1
  const m = n - 1;
  if (m <= 0) return [];
  if (m === 1) return [0];
  const cost = (i: number, j: number): number => matrix[i]?.[j] ?? Infinity;

  const full = (1 << m) - 1;
  const dp: number[][] = Array.from({ length: 1 << m }, () =>
    new Array(m).fill(Infinity)
  );
  const parent: number[][] = Array.from({ length: 1 << m }, () =>
    new Array(m).fill(-1)
  );
  // Seed: base → each stop as the first visit.
  for (let b = 0; b < m; b++) dp[1 << b][b] = cost(0, b + 1);

  for (let mask = 1; mask <= full; mask++) {
    for (let last = 0; last < m; last++) {
      if (!(mask & (1 << last))) continue;
      const cur = dp[mask][last];
      if (!Number.isFinite(cur)) continue;
      for (let nxt = 0; nxt < m; nxt++) {
        if (mask & (1 << nxt)) continue;
        const nmask = mask | (1 << nxt);
        const cand = cur + cost(last + 1, nxt + 1);
        if (cand < dp[nmask][nxt]) {
          dp[nmask][nxt] = cand;
          parent[nmask][nxt] = last;
        }
      }
    }
  }

  // Close the tour back to base and pick the cheapest ending stop.
  let best = Infinity;
  let bestLast = -1;
  for (let last = 0; last < m; last++) {
    const c = dp[full][last] + cost(last + 1, 0);
    if (c < best) {
      best = c;
      bestLast = last;
    }
  }
  if (!Number.isFinite(best) || bestLast < 0) return null;

  const order: number[] = [];
  let mask = full;
  let last = bestLast;
  while (last !== -1) {
    order.push(last);
    const prev = parent[mask][last];
    mask ^= 1 << last;
    last = prev;
  }
  order.reverse();
  return order;
}
