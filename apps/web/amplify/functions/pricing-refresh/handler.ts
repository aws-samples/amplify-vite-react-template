import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { dataClient } from "../shared/dataClient";
import { emailShell, notifyOffice, sendEmail } from "../shared/email";
import { money } from "../crm-pricing/rateCards";
import {
  enqueueRateResearch,
  parseNotify,
  pickLiveRow,
  researchAndCacheRate,
  REFRESH_AFTER_MS,
  type MarketRateService,
} from "../shared/marketRate";

/**
 * The hourly AI pricing-refresh cron. Every run:
 *
 *   1. Seeds the RateCoverage work-list, idempotently.
 *   2. Drains due research under the caps below — DEMAND misses first
 *      (self-heal: a lead who hit a sheet-less combo is priced within the
 *      hour and emailed), then never-researched seeded combos, then sheets
 *      past their weekly refresh. Pinned rows never refresh.
 *   3. On the Monday 10:00 UTC run, emails the office the weekly report.
 *
 * Failures increment the combo's failCount and never crash the run.
 */

/**
 * Research caps — the cron's whole budget. These replaced the old
 * live-path NEW_RESEARCH_PER_DAY (25), which died with inline research.
 *
 * Economics: one research is one Opus call with up to 4 web searches,
 * roughly $0.20–0.40. RESEARCH_PER_DAY = 150 caps worst-case spend around
 * $50–60/day; the steady state is far lower — a few hundred covered combos
 * on a weekly cadence is ~45 researches/day. RESEARCH_PER_RUN = 20 keeps a
 * single hourly run inside the Lambda window (each research can take
 * 10–60s) while still letting a day's queue drain.
 */
export const RESEARCH_PER_RUN = 20;
export const RESEARCH_PER_DAY = 150;

/** lastSuccess older than this makes the weekly report's stale list —
 *  the age ceiling alert (three missed weekly refreshes). */
export const STALE_AFTER_DAYS = 21;
/** failCount at/above this makes the weekly report's failing list. */
export const FAILING_THRESHOLD = 2;

/** Stop STARTING research when the run is this old: the function times
 *  out at 900s and one research can hold the line for ~60s. */
const RUN_TIME_BUDGET_MS = 13 * 60_000;

/** The weekly report slot: Monday 10:00 UTC (the hourly cron fires on the
 *  hour, so exactly one run a week lands here). */
const WEEKLY_REPORT_UTC_DAY = 1;
const WEEKLY_REPORT_UTC_HOUR = 10;

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
 * (enqueueRateResearch upserts) and additive only — it never deactivates.
 *
 *   - SEED_TOWNS × every service kind × the common size bands.
 *   - SERVED: towns where actual customers live, towns and exact combos
 *     from booking requests, and combos already carrying a MarketRate row
 *     (so pre-existing sheets join the weekly refresh cycle).
 */
async function seedCoverage(): Promise<number> {
  const client = await dataClient();
  let ensured = 0;

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

  for (const combo of exact) {
    await enqueueRateResearch({ ...combo, source: "SERVED" });
    ensured++;
  }
  for (const { city, state, source } of towns.values()) {
    for (const service of BANDED_SERVICES) {
      for (const sqft of SEED_SQFT_BUCKETS) {
        await enqueueRateResearch({ service, city, state, sqft, source });
        ensured++;
      }
    }
    for (const service of UNBANDED_SERVICES) {
      await enqueueRateResearch({ service, city, state, source });
      ensured++;
    }
  }
  return ensured;
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

/**
 * What this run researches, in priority order:
 *   (a) DEMAND combos with no sheet — a lead is waiting; self-heal ≤1h.
 *   (b) other combos with no sheet (seed/served gaps), never-attempted
 *       first so a failing combo cannot starve fresh ones.
 *   (c) sheets past the weekly refresh, oldest first — skipping pinned.
 */
function selectWork(
  coverage: CoverageRow[],
  live: Map<string, RateRow>,
  now: number
): CoverageRow[] {
  const active = coverage.filter((c) => c.active);
  const noSheet = active.filter((c) => !live.has(c.id));
  const byAttempt = (a: CoverageRow, b: CoverageRow) =>
    (a.lastAttemptAt ?? "").localeCompare(b.lastAttemptAt ?? "");
  const demand = noSheet.filter((c) => c.source === "DEMAND").sort(byAttempt);
  const gaps = noSheet.filter((c) => c.source !== "DEMAND").sort(byAttempt);
  const cutoff = now - REFRESH_AFTER_MS;
  const due = active
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
 */
async function sendRateReadyEmails(cov: CoverageRow): Promise<number> {
  const entries = parseNotify(cov.notify);
  if (!entries.length) return 0;
  const quoteUrl = `${process.env.MARKETING_URL ?? "https://www.pestbuzzkill.com"}/quote`;
  let sent = 0;
  for (const entry of entries) {
    const ok = await sendEmail({
      to: entry.email,
      subject: "Your exact prices are ready — pick your day",
      template: "booking-rate-ready",
      relatedId: entry.bookingRequestId,
      html: emailShell(
        "Your exact prices are ready",
        `<p>When you asked for a quote, we were still researching pricing for your area — that's done now.</p>
         <p>Run your quote again and every available day will show its exact price. Pick the day that works and book online in about a minute.</p>
         <p style="margin:20px 0;"><a href="${quoteUrl}" style="background:#72E000;color:#0A0A0A;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:700;">See my day-by-day prices</a></p>
         <p style="color:#666;font-size:13px;">Prefer to talk it through? Just reply to this email.</p>`
      ),
    });
    if (ok) sent++;
  }
  return sent;
}

// -------------------------------------------------------- weekly report

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
    (c) => (c.failCount ?? 0) >= FAILING_THRESHOLD
  );
  const stale = activeCov.filter(
    (c) => c.lastSuccessAt && Date.parse(c.lastSuccessAt) < staleCutoff
  );
  const gaps = activeCov.filter((c) => !c.lastSuccessAt);
  // Counts are per-combo latest stamps, so a combo attempted twice in the
  // week counts once — close enough for a trend line.
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

// --------------------------------------------------------------- handler

export const handler = async () => {
  const startedAt = Date.now();

  let seeded = 0;
  try {
    seeded = await seedCoverage();
  } catch (err) {
    // Seeding trouble must not stop the drain — demand rows still self-heal.
    console.error("pricing-refresh: seeding failed", err);
  }

  const client = await dataClient();
  const coverage = await listAll<CoverageRow>(client.models.RateCoverage);
  const live = liveRowsByKey(await listAll<RateRow>(client.models.MarketRate));
  const queue = selectWork(coverage, live, startedAt);

  // The day's budget: attempts across the last 24h (per-combo latest
  // stamps — a combo retried twice in a day counts once, so this can
  // slightly undercount; RESEARCH_PER_RUN bounds the drift).
  const attemptsToday = coverage.filter(
    (c) => c.lastAttemptAt && Date.parse(c.lastAttemptAt) > startedAt - DAY_MS
  ).length;
  const budget = Math.max(
    0,
    Math.min(RESEARCH_PER_RUN, RESEARCH_PER_DAY - attemptsToday)
  );

  const anthropicKey =
    budget > 0 && queue.length > 0 ? await getSecret("ANTHROPIC_API_KEY") : null;

  let attempted = 0;
  let succeeded = 0;
  let failed = 0;
  let notified = 0;
  if (anthropicKey) {
    for (const cov of queue) {
      if (attempted >= budget) break;
      if (Date.now() - startedAt > RUN_TIME_BUDGET_MS) break;
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
          // Waiting leads first, then clear the list — a clear that fails
          // can re-send next success, which beats a lead never told.
          notified += await sendRateReadyEmails(cov);
          await client.models.RateCoverage.update({
            id: cov.id,
            lastAttemptAt: nowIso,
            lastSuccessAt: nowIso,
            failCount: 0,
            notify: JSON.stringify([]),
          });
        } else {
          failed++;
          await client.models.RateCoverage.update({
            id: cov.id,
            lastAttemptAt: nowIso,
            failCount: (cov.failCount ?? 0) + 1,
          });
        }
      } catch (err) {
        // One bad combo never takes down the run.
        failed++;
        console.error("pricing-refresh: research failed", cov.id, err);
        try {
          await client.models.RateCoverage.update({
            id: cov.id,
            lastAttemptAt: nowIso,
            failCount: (cov.failCount ?? 0) + 1,
          });
        } catch {
          /* even the bookkeeping write may fail; the run goes on */
        }
      }
    }
  } else if (queue.length > 0 && budget > 0) {
    console.error(
      "pricing-refresh: no ANTHROPIC_API_KEY — queue holds", queue.length
    );
  }

  const now = new Date();
  let reported = false;
  if (
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
    seeded,
    queued: queue.length,
    budget,
    attempted,
    succeeded,
    failed,
    notified,
    reported,
  };
  console.log("pricing-refresh:", JSON.stringify(summary));
  return summary;
};
