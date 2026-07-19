import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { dataClient } from "../shared/dataClient";
import { emailShell, notifyOffice, sendEmail } from "../shared/email";
import { openOwnedWork } from "../shared/ownedWork";
import { money } from "../crm-pricing/rateCards";
import {
  acquireDrain,
  claimDailyDigest,
  dayKeyFor,
  freshNonce,
  leaseCoverageRow,
  recordOutcome,
  releaseDrain,
  reserveBudget,
  settleCoverageRow,
} from "../shared/pricingControl";
import {
  enqueueRateResearch,
  parseNotify,
  pickLiveRow,
  researchAndCacheRate,
  REFRESH_AFTER_MS,
  type MarketRateService,
} from "../shared/marketRate";

/**
 * The AI pricing-refresh worker. Every run:
 *
 *   0. Takes the SINGLE drain lease — exactly one invocation researches at
 *      a time. The cron fires every 5 minutes and a run can hold the line
 *      for 13; without the lease, overlapping invocations each selected the
 *      same head-of-queue combos and each paid for its own provider call
 *      (the July cost incident). A loser exits without spending anything.
 *   1. Seeds the RateCoverage work-list, idempotently (top of hour only).
 *   2. Drains due research — DEMAND misses first (self-heal: a lead who hit
 *      a sheet-less combo is priced within minutes and emailed), then
 *      never-researched seeded combos, then sheets past their weekly
 *      refresh. Pinned, fresh, exhausted, backing-off, and currently leased
 *      rows are never researched.
 *   3. Every provider request RESERVES atomic daily budget BEFORE the call,
 *      so failures, junk answers, and timeouts all consume it and no
 *      interleaving of invocations can exceed the shared caps.
 *   4. Failures back off exponentially; MAX_RESEARCH_ATTEMPTS straight
 *      failures parks the combo (EXHAUSTED) with an owned Office work item
 *      — one bad combo can never loop the queue.
 *   5. Office visibility is a consolidated DAILY digest (plus the Monday
 *      weekly report) — never one email per cached rate. Waiting-lead
 *      "your exact prices are ready" emails stay separate, claim-based,
 *      and idempotent.
 */

/**
 * Research caps — the engine's whole budget, enforced ATOMICALLY on the
 * day's PricingControl row (reserved before each provider call).
 *
 * Economics: one research is one Opus call with up to 4 web searches,
 * roughly $0.20–0.40. RESEARCH_PER_DAY = 150 caps worst-case spend around
 * $50–60/day; the steady state is far lower — a few hundred covered combos
 * on a weekly cadence is ~45 researches/day. RESEARCH_PER_RUN = 20 keeps a
 * single run inside the Lambda window (each research can take 10–60s).
 */
export const RESEARCH_PER_RUN = 20;
export const RESEARCH_PER_DAY = 150;
/** Live quote misses retain a small daily reserve even when background
 *  seeding/refresh has consumed the normal budget. The public endpoint is
 *  separately throttled, so this restores conversion without opening an
 *  unbounded research surface. */
export const DEMAND_RESEARCH_PER_DAY = 25;

/** Straight failures before a combo is parked as EXHAUSTED with an owned
 *  Office work item (retry / pin a manual price / retire — from the Market
 *  Rates screen). Never silently retried again. */
export const MAX_RESEARCH_ATTEMPTS = 5;
/** Bounded exponential backoff between failures: 30m, 1h, 2h, 4h (cap 8h). */
export const BACKOFF_BASE_MS = 30 * 60_000;
export const BACKOFF_MAX_MS = 8 * 60 * 60_000;

/** Rough all-in provider cost per research, for the leadership spend
 *  estimate (an estimate, clearly labeled as one — not billing truth). */
export const COST_PER_RESEARCH_USD = 0.35;

/** lastSuccess older than this makes the weekly report's stale list —
 *  the age ceiling alert (three missed weekly refreshes). */
export const STALE_AFTER_DAYS = 21;
/** failCount at/above this makes the weekly report's failing list. */
export const FAILING_THRESHOLD = 2;

/** Stop STARTING research when the run is this old: the function times
 *  out at 900s and one research can hold the line for ~60s. */
const RUN_TIME_BUDGET_MS = 13 * 60_000;

/** The weekly report slot: Monday 10:00 UTC. The cron fires every 5
 *  minutes, so the report (and seeding) are additionally gated to the top
 *  of the hour — see topOfHour in the handler — to fire exactly once. */
const WEEKLY_REPORT_UTC_DAY = 1;
const WEEKLY_REPORT_UTC_HOUR = 10;

/** The daily digest slot (~5pm Eastern): one consolidated email covering
 *  the day's research, spend estimate, and queue state. The once-only
 *  claim on the day row keeps the twelve runs in this hour to ONE email. */
export const DIGEST_UTC_HOUR = 21;

export function backoffMsFor(failCount: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, failCount - 1), BACKOFF_MAX_MS);
}

/**
 * Core service-area towns around Ware MA, seeded every run so the funnel's
 * likely asks are researched before anyone asks. A short starter list —
 * Jake curates it (add or remove towns freely; seeding is idempotent, and
 * a removed town's existing coverage rows simply stop being re-ensured).
 */
export const SEED_TOWNS: { city: string; state: string }[] = [
  { city: "Ware", state: "MA" },
  { city: "Palmer", state: "MA" },
  { city: "Belchertown", state: "MA" },
  { city: "Warren", state: "MA" },
  { city: "West Brookfield", state: "MA" },
  { city: "North Brookfield", state: "MA" },
  { city: "Hardwick", state: "MA" },
  { city: "Monson", state: "MA" },
  { city: "Wilbraham", state: "MA" },
  { city: "Ludlow", state: "MA" },
];

/** Common size bands seeded per town (sqft-bucket ceilings — most funnel
 *  asks land in one of these; odd sizes arrive as DEMAND rows). */
export const SEED_SQFT_BUCKETS = [1500, 2000, 2500];

/** Engine service kinds by whether their rate key carries a sqft band. */
const BANDED_SERVICES: MarketRateService[] = [
  "GENERAL_PEST",
  "RODENT",
  "ROACH",
  "TERMITE",
  "WILDLIFE",
  "COMMERCIAL",
];
const UNBANDED_SERVICES: MarketRateService[] = ["WASP_NEST", "HOA"];

// ------------------------------------------------------------- api key

const ssm = new SSMClient();
const secretCache = new Map<string, string>();

/** Env-baked key with SSM fallback — same lookup as booking-public. */
async function getSecret(name: string): Promise<string | null> {
  const fromEnv = process.env[name];
  if (fromEnv && fromEnv !== "placeholder-set-me") return fromEnv;
  if (secretCache.has(name)) return secretCache.get(name)!;
  const appId = process.env.AMPLIFY_APP_ID ?? "d26qpsjewk0bee";
  for (const path of [
    `/amplify/${appId}/${process.env.AMPLIFY_BRANCH ?? "staging"}/${name}`,
    `/amplify/shared/${appId}/${name}`,
  ]) {
    try {
      const res = await ssm.send(
        new GetParameterCommand({ Name: path, WithDecryption: true })
      );
      const v = res.Parameter?.Value;
      if (v && v !== "placeholder-set-me") {
        secretCache.set(name, v);
        return v;
      }
    } catch {
      /* try next path */
    }
  }
  return null;
}

// ------------------------------------------------------------ row shapes

type CoverageRow = {
  id: string;
  service: string;
  areaKey: string;
  city: string;
  state: string;
  band?: number | null;
  source: string;
  lastAttemptAt?: string | null;
  lastSuccessAt?: string | null;
  failCount?: number | null;
  active: boolean;
  leaseUntil?: string | null;
  leaseNonce?: string | null;
  nextEligibleAt?: string | null;
  exhaustedAt?: string | null;
  notify?: unknown;
};

type RateRow = {
  id: string;
  rateKey: string;
  service: string;
  areaKey: string;
  priceCents: number;
  basis?: string | null;
  researchedAt?: string | null;
  active: boolean;
  pinned?: boolean | null;
  prevPriceCents?: number | null;
  prevResearchedAt?: string | null;
};

type Lister = {
  list(opts: {
    nextToken?: string | null;
    limit?: number;
  }): Promise<{ data: unknown[]; nextToken?: string | null }>;
};

async function listAll<T>(model: Lister): Promise<T[]> {
  const out: unknown[] = [];
  let nextToken: string | null | undefined;
  do {
    const page = await model.list({ nextToken, limit: 200 });
    out.push(...page.data);
    nextToken = page.nextToken;
  } while (nextToken);
  return out as T[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

// -------------------------------------------------------------- seeding

/** "west-brookfield-ma" → { city: "west brookfield", state: "MA" } — good
 *  enough for a research prompt, and it round-trips through areaKeyFor. */
function townFromAreaKey(
  areaKey: string
): { city: string; state: string } | null {
  const i = areaKey.lastIndexOf("-");
  if (i <= 0) return null;
  return {
    city: areaKey.slice(0, i).replace(/-/g, " "),
    state: areaKey.slice(i + 1).toUpperCase(),
  };
}

/**
 * Ensure coverage exists for everything we should keep priced. Idempotent
 * (enqueueRateResearch upserts, deduped within the run) and additive only —
 * it never deactivates, and it can never resurrect a combo the office
 * retired or re-arm one that exhausted its attempts (enqueue refuses both).
 *
 *   - SEED_TOWNS × every service kind × the common size bands.
 *   - SERVED: towns where actual customers live, towns and exact combos
 *     from booking requests, and combos already carrying a MarketRate row
 *     (so pre-existing sheets join the weekly refresh cycle).
 */
async function seedCoverage(): Promise<number> {
  const client = await dataClient();

  // Towns to cross with the full service × band grid.
  const towns = new Map<
    string,
    { city: string; state: string; source: "SEED" | "SERVED" }
  >();
  const addTown = (
    city: string | null | undefined,
    state: string | null | undefined,
    source: "SEED" | "SERVED"
  ) => {
    if (!city?.trim() || !state?.trim()) return;
    const key = `${city.trim().toLowerCase()}|${state.trim().toLowerCase()}`;
    // SEED (the curated list) wins over a derived SERVED duplicate.
    if (!towns.has(key) || source === "SEED") {
      towns.set(key, { city: city.trim(), state: state.trim(), source });
    }
  };
  for (const t of SEED_TOWNS) addTown(t.city, t.state, "SEED");

  const customers = await listAll<{
    serviceCity?: string | null;
    serviceState?: string | null;
  }>(client.models.Customer);
  for (const c of customers) addTown(c.serviceCity, c.serviceState, "SERVED");

  // Booking requests contribute their town AND their exact asked combo.
  const bookings = await listAll<{
    propertyKind?: string | null;
    service?: string | null;
    city?: string | null;
    state?: string | null;
    sqft?: number | null;
  }>(client.models.BookingRequest);
  const exact: {
    service: MarketRateService;
    city: string;
    state: string;
    sqft?: number;
  }[] = [];
  for (const b of bookings) {
    if (!b.city?.trim() || !b.state?.trim()) continue;
    addTown(b.city, b.state, "SERVED");
    const city = b.city.trim();
    const state = b.state.trim();
    if (b.propertyKind === "COMMUNITY") {
      exact.push({ service: "HOA", city, state });
    } else if (b.propertyKind === "COMMERCIAL") {
      if (b.sqft) exact.push({ service: "COMMERCIAL", city, state, sqft: b.sqft });
    } else if (b.service === "WASP_NEST") {
      exact.push({ service: "WASP_NEST", city, state });
    } else if (b.service && b.sqft) {
      exact.push({
        service: b.service as MarketRateService,
        city,
        state,
        sqft: b.sqft,
      });
    }
  }

  // Combos that already have a sheet join the refresh cycle.
  const rates = await listAll<RateRow>(client.models.MarketRate);
  for (const r of rates) {
    const town = townFromAreaKey(r.areaKey);
    if (!town) continue;
    const parts = r.rateKey.split("#");
    const band = parts.length > 2 ? Number(parts[2]) : undefined;
    exact.push({
      service: r.service as MarketRateService,
      city: town.city,
      state: town.state,
      ...(band && Number.isFinite(band) ? { sqft: band } : {}),
    });
  }

  // One upsert per distinct combo, however many sources produced it — the
  // work-list can never multiply the same work within a run.
  const ensured = new Set<string>();
  for (const combo of exact) {
    const key = `${combo.service}|${combo.city.toLowerCase()}|${combo.state.toLowerCase()}|${combo.sqft ?? ""}`;
    if (ensured.has(key)) continue;
    ensured.add(key);
    await enqueueRateResearch({ ...combo, source: "SERVED" });
  }
  for (const { city, state, source } of towns.values()) {
    for (const service of BANDED_SERVICES) {
      for (const sqft of SEED_SQFT_BUCKETS) {
        const key = `${service}|${city.toLowerCase()}|${state.toLowerCase()}|${sqft}`;
        if (ensured.has(key)) continue;
        ensured.add(key);
        await enqueueRateResearch({ service, city, state, sqft, source });
      }
    }
    for (const service of UNBANDED_SERVICES) {
      const key = `${service}|${city.toLowerCase()}|${state.toLowerCase()}|`;
      if (ensured.has(key)) continue;
      ensured.add(key);
      await enqueueRateResearch({ service, city, state, source });
    }
  }
  return ensured.size;
}

// ------------------------------------------------------- work selection

/** The live (serving) MarketRate row per rate key. */
function liveRowsByKey(rates: RateRow[]): Map<string, RateRow> {
  const byKey = new Map<string, RateRow[]>();
  for (const r of rates) {
    const list = byKey.get(r.rateKey) ?? [];
    list.push(r);
    byKey.set(r.rateKey, list);
  }
  const live = new Map<string, RateRow>();
  for (const [key, rows] of byKey) {
    const row = pickLiveRow(rows);
    if (row) live.set(key, row);
  }
  return live;
}

/** GL-16: a row the engine may spend money on right now. Exhausted rows,
 *  rows inside their failure backoff, and rows another worker holds a live
 *  research lease on are NEVER selected. */
function researchable(c: CoverageRow, now: number): boolean {
  if (!c.active) return false;
  if (c.exhaustedAt) return false;
  if (c.nextEligibleAt && Date.parse(c.nextEligibleAt) > now) return false;
  if (c.leaseUntil && Date.parse(c.leaseUntil) > now) return false;
  return true;
}

/**
 * What this run researches, in priority order:
 *   (a) DEMAND combos with no sheet — a lead is waiting; self-heal ≤5min.
 *   (b) other combos with no sheet (seed/served gaps), never-attempted
 *       first so a failing combo cannot starve fresh ones.
 *   (c) sheets past the weekly refresh, oldest first — skipping pinned.
 */
function selectWork(
  coverage: CoverageRow[],
  live: Map<string, RateRow>,
  now: number
): CoverageRow[] {
  const eligible = coverage.filter((c) => researchable(c, now));
  const noSheet = eligible.filter((c) => !live.has(c.id));
  const byAttempt = (a: CoverageRow, b: CoverageRow) =>
    (a.lastAttemptAt ?? "").localeCompare(b.lastAttemptAt ?? "");
  const demand = noSheet.filter((c) => c.source === "DEMAND").sort(byAttempt);
  const gaps = noSheet.filter((c) => c.source !== "DEMAND").sort(byAttempt);
  const cutoff = now - REFRESH_AFTER_MS;
  const due = eligible
    .filter((c) => {
      const row = live.get(c.id);
      if (!row || row.pinned) return false;
      return (row.researchedAt ? Date.parse(row.researchedAt) : 0) < cutoff;
    })
    .sort((a, b) =>
      (live.get(a.id)?.researchedAt ?? "").localeCompare(
        live.get(b.id)?.researchedAt ?? ""
      )
    );
  return [...demand, ...gaps, ...due];
}

// ------------------------------------------------------ self-heal email

/**
 * "Your exact prices are ready" — sent to each lead who hit this combo
 * before its sheet existed. Honest copy: their quote fell to the callback
 * path, and now the day-by-day prices genuinely exist.
 *
 * GL-16 idempotency: each entry is CLAIMED out of the row's notify list
 * with a lease-fenced conditional write BEFORE its email is sent, so a
 * replayed run, an overlapping invocation, or a stale-lease takeover can
 * never email the same lead twice. A failed send re-appends the entry with
 * `ready: true` so the retry loop (not another research) delivers it. The
 * caller must hold the row's research lease under `nonce`.
 */
async function deliverRateReadyEmails(
  covId: string,
  nonce: string,
  mode: "UNREADY_ONLY" | "READY_ONLY"
): Promise<{ sent: number }> {
  const quoteBase = `${process.env.MARKETING_URL ?? "https://www.pestbuzzkill.com"}/quote`;
  const client = await dataClient();
  let sent = 0;
  for (;;) {
    const { data: fresh } = await client.models.RateCoverage.get({ id: covId });
    if (!fresh) return { sent };
    const entries = parseNotify(fresh.notify);
    const entry = entries.find((e) =>
      mode === "READY_ONLY" ? e.ready === true : e.ready !== true
    );
    if (!entry) return { sent };
    const rest = entries.filter((e) => e !== entry);
    const claimed = await settleCoverageRow(covId, nonce, {
      notify: JSON.stringify(rest),
    });
    if (!claimed) {
      // Lost the lease (or no CAS wiring): stop — the current lease holder
      // or a later run owns delivery. Never send unclaimed.
      return { sent };
    }
    let quoteUrl = quoteBase;
    if (entry.bookingRequestId) {
      try {
        const { data: booking } = await client.models.BookingRequest.get({
          id: entry.bookingRequestId,
        });
        if (booking?.cancelToken) {
          // The fragment is not sent in HTTP requests or referrer headers. The
          // quote page consumes it, clears it from the address bar, and polls
          // the token-authenticated status endpoint.
          quoteUrl = `${quoteBase}#request=${encodeURIComponent(entry.bookingRequestId)}&token=${encodeURIComponent(booking.cancelToken)}`;
        }
      } catch (err) {
        console.error(
          "pricing-refresh: could not build secure quote resume link",
          entry.bookingRequestId,
          err
        );
      }
    }
    const ok = await sendEmail({
      to: entry.email,
      subject: "Your exact prices are ready — pick your day",
      template: "booking-rate-ready",
      relatedId: entry.bookingRequestId,
      html: emailShell(
        "Your exact prices are ready",
        `<p>When you asked for a quote, we were still researching pricing for your area — that's done now.</p>
         <p>Open your saved request to see the exact price and every available day. Pick the day that works and book online in about a minute.</p>
         <p style="margin:20px 0;"><a href="${quoteUrl}" style="background:#72E000;color:#0A0A0A;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:700;">Open my exact quote</a></p>
         <p style="color:#666;font-size:13px;">Prefer to talk it through? Just reply to this email.</p>`
      ),
    });
    if (ok) {
      sent++;
      continue;
    }
    // Transient delivery failure: put the claim back as a ready-retry so a
    // later run re-sends WITHOUT paying to research the rate again.
    const { data: after } = await client.models.RateCoverage.get({ id: covId });
    const current = after ? parseNotify(after.notify) : [];
    const restored = await settleCoverageRow(covId, nonce, {
      notify: JSON.stringify([...current, { ...entry, ready: true }]),
    });
    if (!restored) {
      console.error(
        "pricing-refresh: lost a rate-ready retry entry after send failure",
        covId,
        entry.email
      );
      return { sent };
    }
  }
}

// -------------------------------------------------------- office reports

const covLabel = (c: { service: string; areaKey: string; band?: number | null }) =>
  `${c.service} · ${c.areaKey}${c.band ? ` · up to ${c.band.toLocaleString()} sqft` : ""}`;

const rateLabel = (r: RateRow) => {
  const parts = r.rateKey.split("#");
  const band = parts.length > 2 ? Number(parts[2]) : null;
  return `${r.service} · ${r.areaKey}${band ? ` · up to ${band.toLocaleString()} sqft` : ""}`;
};

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function section(title: string, items: string[], emptyLine: string): string {
  return `<h2 style="font-size:15px;margin:20px 0 6px;">${title}</h2>${
    items.length
      ? `<ul style="margin:0;">${items.map((i) => `<li>${i}</li>`).join("")}</ul>`
      : `<p style="color:#666;font-size:13px;margin:0;">${emptyLine}</p>`
  }`;
}

type DayCounters = {
  attempts: number;
  demandAttempts: number;
  succeeded: number;
  failed: number;
};

async function readDayCounters(now: Date): Promise<DayCounters> {
  try {
    const client = await dataClient();
    const { data } = await client.models.PricingControl.get({
      id: dayKeyFor(now),
    });
    return {
      attempts: data?.attempts ?? 0,
      demandAttempts: data?.demandAttempts ?? 0,
      succeeded: data?.succeeded ?? 0,
      failed: data?.failed ?? 0,
    };
  } catch {
    return { attempts: 0, demandAttempts: 0, succeeded: 0, failed: 0 };
  }
}

/**
 * The DAILY digest — GL-16's consolidated replacement for the retired
 * one-email-per-cached-rate notification. One email covering the day:
 * every sheet cached (with the price move), attempts/successes/failures,
 * the atomic budget position and spend estimate, queue depth, exhausted
 * combos, and the next retry. Visibility, not a gate.
 */
async function sendDailyDigest(now: Date): Promise<boolean> {
  const client = await dataClient();
  const coverage = await listAll<CoverageRow>(client.models.RateCoverage);
  const rates = await listAll<RateRow>(client.models.MarketRate);
  const counters = await readDayCounters(now);
  const day = now.toISOString().slice(0, 10);
  const nowMs = now.getTime();

  const cachedToday = rates
    .filter((r) => r.active && (r.researchedAt ?? "").startsWith(day))
    .sort((a, b) => (a.rateKey < b.rateKey ? -1 : 1));
  const activeCov = coverage.filter((c) => c.active);
  const live = liveRowsByKey(rates);
  const queueDepth = selectWork(coverage, live, nowMs).length;
  const exhausted = activeCov.filter((c) => c.exhaustedAt);
  const backingOff = activeCov
    .filter(
      (c) => !c.exhaustedAt && c.nextEligibleAt && Date.parse(c.nextEligibleAt) > nowMs
    )
    .sort((a, b) => (a.nextEligibleAt ?? "").localeCompare(b.nextEligibleAt ?? ""));
  const spendEstimate = (counters.attempts * COST_PER_RESEARCH_USD).toFixed(2);

  const bodyHtml = `<p>Today's AI pricing run, consolidated. Every sheet below is <strong>already live and quoting</strong> — this is visibility, not an approval queue. Override any line on <a href="${process.env.CRM_APP_URL ?? ""}/market-rates">Market Rates</a>; an edit pins the row.</p>
    ${section(
      `Rates cached today (${cachedToday.length})`,
      cachedToday.map(
        (r) =>
          `${esc(rateLabel(r))}: ${
            r.prevPriceCents != null && r.prevPriceCents !== r.priceCents
              ? `${money(r.prevPriceCents)} → <strong>${money(r.priceCents)}</strong>`
              : `<strong>${money(r.priceCents)}</strong>${r.prevPriceCents != null ? " (unchanged)" : " (new)"}`
          }`
      ),
      "No new sheets were cached today."
    )}
    ${section(
      `Combos exhausted — parked with an owned Office item (${exhausted.length})`,
      exhausted.map(
        (c) =>
          `${esc(covLabel(c))}: ${c.failCount ?? 0} straight failures — quotes fall back to a callback until it's retried, pinned, or retired`
      ),
      "No combo has exhausted its research attempts."
    )}
    ${section(
      `Backing off after a failure (${backingOff.length})`,
      backingOff
        .slice(0, 10)
        .map(
          (c) =>
            `${esc(covLabel(c))}: ${c.failCount ?? 0} failure${(c.failCount ?? 0) === 1 ? "" : "s"}, next retry ${esc(c.nextEligibleAt ?? "")}`
        ),
      "Nothing is waiting out a failure backoff."
    )}
    <h2 style="font-size:15px;margin:20px 0 6px;">Today's budget & queue</h2>
    <p style="margin:0;">${counters.attempts} research attempts (${counters.succeeded} succeeded, ${counters.failed} failed, ${counters.demandAttempts} for waiting leads) · estimated spend ~$${spendEstimate} · daily cap ${RESEARCH_PER_DAY} · queue depth ${queueDepth} · ${activeCov.length} combos covered.</p>`;

  return notifyOffice({
    subject: `AI pricing daily digest — ${cachedToday.length} sheet${cachedToday.length === 1 ? "" : "s"} cached, ~$${spendEstimate} spent`,
    heading: "AI pricing — daily digest",
    template: "ops-pricing-daily-digest",
    bodyHtml,
  });
}

/**
 * The Monday email: everything the refresh did and everything it cannot
 * do. Visibility, not a gate — every sheet listed is already live and
 * quoting; nothing here waits for approval (Jake's standing rule: no
 * review gates, no clamps). The office overrides any line it dislikes on
 * the Market Rates screen, which pins the row out of future refreshes.
 */
async function sendWeeklyReport(): Promise<boolean> {
  const client = await dataClient();
  const coverage = await listAll<CoverageRow>(client.models.RateCoverage);
  const rates = await listAll<RateRow>(client.models.MarketRate);
  const now = Date.now();
  const weekAgo = now - 7 * DAY_MS;
  const staleCutoff = now - STALE_AFTER_DAYS * DAY_MS;

  const activeCov = coverage.filter((c) => c.active);
  const fresh = rates.filter(
    (r) => r.active && r.researchedAt && Date.parse(r.researchedAt) > weekAgo
  );

  const moves = fresh
    .filter(
      (r) =>
        r.prevPriceCents != null &&
        r.prevPriceCents > 0 &&
        r.prevPriceCents !== r.priceCents
    )
    .map((r) => ({
      r,
      pct: ((r.priceCents - r.prevPriceCents!) / r.prevPriceCents!) * 100,
    }))
    .sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));
  const floored = fresh.filter((r) =>
    (r.basis ?? "").includes("floored at Zone-A variable cost")
  );
  const failing = activeCov.filter(
    (c) => !c.exhaustedAt && (c.failCount ?? 0) >= FAILING_THRESHOLD
  );
  const exhausted = activeCov.filter((c) => c.exhaustedAt);
  const stale = activeCov.filter(
    (c) => c.lastSuccessAt && Date.parse(c.lastSuccessAt) < staleCutoff
  );
  const gaps = activeCov.filter((c) => !c.lastSuccessAt);
  // Counts are per-combo latest stamps, so a combo attempted twice in the
  // week counts once — close enough for a trend line. (Exact daily counts
  // live on the PricingControl day rows and the daily digest.)
  const attempts7d = activeCov.filter(
    (c) => c.lastAttemptAt && Date.parse(c.lastAttemptAt) > weekAgo
  ).length;
  const successes7d = activeCov.filter(
    (c) => c.lastSuccessAt && Date.parse(c.lastSuccessAt) > weekAgo
  ).length;

  const ageDays = (iso: string) => Math.floor((now - Date.parse(iso)) / DAY_MS);

  const bodyHtml = `<p>The weekly look at what the AI pricer did. Every sheet below is <strong>already live and quoting</strong> — this is visibility, not an approval queue. To overrule any number, edit it on <a href="${process.env.CRM_APP_URL ?? ""}/market-rates">Market Rates</a>; an edit pins the row and the refresh never touches it again.</p>
    ${section(
      `Price moves this week (${moves.length})`,
      moves.map(
        ({ r, pct }) =>
          `${esc(rateLabel(r))}: ${money(r.prevPriceCents!)} → <strong>${money(r.priceCents)}</strong> (${pct > 0 ? "+" : ""}${pct.toFixed(1)}%)`
      ),
      "No refreshed sheet changed price."
    )}
    ${section(
      `Floors that bound (${floored.length})`,
      floored.map(
        (r) =>
          `${esc(rateLabel(r))}: research came in below variable cost — shipped at the Zone-A floor, ${money(r.priceCents)}`
      ),
      "No researched price needed flooring."
    )}
    ${section(
      `Combos exhausted — parked with an owned Office item (${exhausted.length})`,
      exhausted.map(
        (c) =>
          `${esc(covLabel(c))}: ${c.failCount ?? 0} straight failures — retry, pin a price, or retire it from Market Rates`
      ),
      "No combo has exhausted its research attempts."
    )}
    ${section(
      `Combos failing research (${failing.length})`,
      failing.map(
        (c) =>
          `${esc(covLabel(c))}: ${c.failCount} straight failures${c.lastSuccessAt ? ` — last good sheet ${ageDays(c.lastSuccessAt)}d ago still serving` : " — never priced, still falling to callback"}`
      ),
      `Nothing has failed ${FAILING_THRESHOLD}+ times.`
    )}
    ${section(
      `Stale sheets — no successful refresh in ${STALE_AFTER_DAYS}+ days (${stale.length})`,
      stale.map(
        (c) => `${esc(covLabel(c))}: last success ${ageDays(c.lastSuccessAt!)}d ago`
      ),
      "Every covered combo refreshed recently."
    )}
    ${section(
      `Coverage gaps — never successfully priced (${gaps.length})`,
      gaps.map(
        (c) =>
          `${esc(covLabel(c))} (${c.source.toLowerCase()}${(c.failCount ?? 0) > 0 ? `, ${c.failCount} failed tries` : ""})`
      ),
      "Every covered combo has a sheet."
    )}
    <h2 style="font-size:15px;margin:20px 0 6px;">This week's research</h2>
    <p style="margin:0;">${successes7d} combos refreshed successfully of ${attempts7d} attempted · ${activeCov.length} combos covered · daily cap ${RESEARCH_PER_DAY}.</p>`;

  return notifyOffice({
    subject: `AI pricing weekly report — ${moves.length} price move${moves.length === 1 ? "" : "s"}, ${gaps.length} gap${gaps.length === 1 ? "" : "s"}`,
    heading: "AI pricing — weekly report",
    template: "ops-pricing-weekly-report",
    bodyHtml,
  });
}

// ---------------------------------------------------------- failure path

/** Settle a failed research on the leased row: bounded exponential backoff,
 *  and at MAX_RESEARCH_ATTEMPTS straight failures the combo is EXHAUSTED —
 *  parked out of the queue with a deduplicated, owned Office work item. */
async function settleResearchFailure(
  cov: CoverageRow,
  nonce: string,
  nowIso: string
): Promise<void> {
  const fails = (cov.failCount ?? 0) + 1;
  const exhausted = fails >= MAX_RESEARCH_ATTEMPTS;
  await settleCoverageRow(cov.id, nonce, {
    lastAttemptAt: nowIso,
    failCount: fails,
    leaseUntil: null,
    ...(exhausted
      ? { exhaustedAt: nowIso, nextEligibleAt: null }
      : {
          exhaustedAt: null,
          nextEligibleAt: new Date(
            Date.parse(nowIso) + backoffMsFor(fails)
          ).toISOString(),
        }),
  });
  if (exhausted) {
    await openOwnedWork({
      kind: "PRICING_RESEARCH_EXHAUSTED",
      dedupeKey: cov.id,
      title: `AI pricing gave up on ${covLabel(cov)}`,
      detail: `Research failed ${fails} times in a row for ${covLabel(cov)}. Quotes for this service + area fall back to the callback path (never an invented price) until it is handled. From Market Rates: retry the research, set a price by hand (pins the row), or retire the combo.`,
      relatedId: cov.id,
      resolutionAction:
        "Open Market Rates → research queue: retry, pin a manual price, or retire the combo.",
      ownerTeam: "OPS",
    });
  }
}

// --------------------------------------------------------------- handler

type PricingRefreshEvent = {
  /** Internal on-demand wake-up from booking-public. */
  rateKey?: string;
  source?: "quote";
};

export const handler = async (event: PricingRefreshEvent = {}) => {
  const startedAt = Date.now();
  const now = new Date();
  const targetedRateKey =
    event.source === "quote" && typeof event.rateKey === "string"
      ? event.rateKey
      : null;
  // The cron fires every 5 minutes for fast demand self-heal, but seeding
  // (a full re-scan of rates/customers/bookings) and the weekly report only
  // belong once an hour: the first run of the hour owns them. Off the hour,
  // the run is a pure drain over the already-seeded work-list.
  const topOfHour = !targetedRateKey && now.getUTCMinutes() < 5;

  // GL-16: ONE drain at a time. The loser exits before selecting or spending
  // anything — an overlapping invocation (5-min cron + a 13-min run, or a
  // burst of quote wake-ups) can never double-research the queue. A crashed
  // holder's lease expires before the second cron after it, and the takeover
  // is a single atomic conditional write.
  const nonce = freshNonce();
  if (!(await acquireDrain(nonce))) {
    const summary = {
      skipped: "drain-lease-held" as string | undefined,
      targetedRateKey,
      seeded: 0,
      queued: 0,
      attempted: 0,
      succeeded: 0,
      failed: 0,
      budgetExhausted: false,
      notified: 0,
      digested: false,
      reported: false,
    };
    console.log("pricing-refresh:", JSON.stringify(summary));
    return summary;
  }
  try {
    let seeded = 0;
    if (topOfHour) {
      try {
        seeded = await seedCoverage();
      } catch (err) {
        // Seeding trouble must not stop the drain — demand rows still self-heal.
        console.error("pricing-refresh: seeding failed", err);
      }
    }

    const client = await dataClient();
    const coverage = await listAll<CoverageRow>(client.models.RateCoverage);
    const live = liveRowsByKey(await listAll<RateRow>(client.models.MarketRate));
    let notified = 0;

    // Email delivery has its own retry lifecycle. A rate can be fresh while a
    // transient SES failure still leaves waiting leads on the coverage row;
    // retry those notifications without paying to research the rate again.
    // Each retry runs under the row's lease so replays cannot double-send.
    for (const cov of coverage) {
      if (
        !live.has(cov.id) ||
        !parseNotify(cov.notify).some((entry) => entry.ready === true)
      ) {
        continue;
      }
      if (!(await leaseCoverageRow(cov.id, nonce, new Date()))) continue;
      const delivery = await deliverRateReadyEmails(cov.id, nonce, "READY_ONLY");
      notified += delivery.sent;
      await settleCoverageRow(cov.id, nonce, { leaseUntil: null });
    }

    // A targeted wake-up researches ONLY its miss — and only when the combo
    // genuinely has no live sheet (fresh, pinned, exhausted, leased, and
    // backing-off rows are never re-researched by a wake-up either).
    const targetedRow = targetedRateKey
      ? (coverage.find((row) => row.id === targetedRateKey) ?? null)
      : null;
    const queue = targetedRateKey
      ? targetedRow &&
        !live.has(targetedRateKey) &&
        researchable(targetedRow, startedAt)
        ? [targetedRow]
        : []
      : selectWork(coverage, live, startedAt);

    let attempted = 0;
    let succeeded = 0;
    let failed = 0;
    let budgetExhausted = false;
    const anthropicKey =
      queue.length > 0 ? await getSecret("ANTHROPIC_API_KEY") : null;
    if (queue.length > 0 && !anthropicKey) {
      console.error(
        "pricing-refresh: no ANTHROPIC_API_KEY — queue holds",
        queue.length
      );
    }
    if (anthropicKey) {
      for (const cov of queue) {
        if (attempted >= RESEARCH_PER_RUN) break;
        if (Date.now() - startedAt > RUN_TIME_BUDGET_MS) break;
        const leaseNow = new Date();
        // Lease first (free), budget second (money): a row someone else
        // holds is skipped without consuming anything.
        if (!(await leaseCoverageRow(cov.id, nonce, leaseNow))) continue;
        // Reserve ATOMIC daily budget BEFORE the provider call — successes,
        // junk answers, thrown errors, and timeouts all consume it, and
        // overlapping invocations can never jointly exceed the caps.
        const reserved = await reserveBudget(
          leaseNow,
          targetedRateKey ? "DEMAND" : "GENERAL",
          { perDay: RESEARCH_PER_DAY, demandPerDay: DEMAND_RESEARCH_PER_DAY }
        );
        if (!reserved) {
          budgetExhausted = true;
          await settleCoverageRow(cov.id, nonce, { leaseUntil: null });
          break;
        }
        attempted++;
        const nowIso = new Date().toISOString();
        try {
          const res = await researchAndCacheRate({
            anthropicKey,
            service: cov.service as MarketRateService,
            city: cov.city,
            state: cov.state,
            sqft: cov.band ?? undefined,
          });
          if (res) {
            succeeded++;
            await recordOutcome(new Date(), true);
            // Waiting leads are claimed-then-emailed under the row lease —
            // exactly once per lead, with failed sends kept for retry.
            const delivery = await deliverRateReadyEmails(
              cov.id,
              nonce,
              "UNREADY_ONLY"
            );
            notified += delivery.sent;
            await settleCoverageRow(cov.id, nonce, {
              lastAttemptAt: nowIso,
              lastSuccessAt: nowIso,
              failCount: 0,
              nextEligibleAt: null,
              exhaustedAt: null,
              leaseUntil: null,
            });
          } else {
            failed++;
            await recordOutcome(new Date(), false);
            await settleResearchFailure(cov, nonce, nowIso);
          }
        } catch (err) {
          // One bad combo never takes down the run — but its attempt was
          // reserved, its failure is counted, and its backoff is recorded.
          failed++;
          console.error("pricing-refresh: research failed", cov.id, err);
          await recordOutcome(new Date(), false).catch(() => undefined);
          await settleResearchFailure(cov, nonce, nowIso).catch(() => undefined);
        }
      }
    }

    // The consolidated daily digest — once, however many runs share the hour.
    let digested = false;
    if (!targetedRateKey && now.getUTCHours() === DIGEST_UTC_HOUR) {
      try {
        if (await claimDailyDigest(now)) {
          digested = await sendDailyDigest(now);
        }
      } catch (err) {
        console.error("pricing-refresh: daily digest failed", err);
      }
    }

    let reported = false;
    if (
      topOfHour &&
      now.getUTCDay() === WEEKLY_REPORT_UTC_DAY &&
      now.getUTCHours() === WEEKLY_REPORT_UTC_HOUR
    ) {
      try {
        reported = await sendWeeklyReport();
      } catch (err) {
        console.error("pricing-refresh: weekly report failed", err);
      }
    }

    const summary = {
      skipped: undefined as string | undefined,
      targetedRateKey,
      seeded,
      queued: queue.length,
      attempted,
      succeeded,
      failed,
      budgetExhausted,
      notified,
      digested,
      reported,
    };
    console.log("pricing-refresh:", JSON.stringify(summary));
    return summary;
  } finally {
    await releaseDrain(nonce);
  }
};
