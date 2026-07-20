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
  type BudgetLane,
} from "../shared/pricingControl";
import {
  parseNotify,
  pickServingRow,
  readPricingRollback,
  writeCatalogSnapshot,
  type CatalogManifest,
  researchAndCacheRate,
  type MarketRateService,
} from "../shared/marketRate";

/**
 * The AI pricing-refresh worker. Every CRON run:
 *
 *   0. Takes the SINGLE drain lease — exactly one QUEUE SCAN runs at a
 *      time. The cron fires every 5 minutes and a run can hold the line
 *      for 13; without the lease, overlapping invocations each selected the
 *      same head-of-queue combos and each paid for its own provider call
 *      (the July cost incident). A loser exits without spending anything.
 *      A TARGETED wake-up ({rateKey, source}) never scans the queue, so it
 *      skips the drain lease entirely and researches its one row under the
 *      row's own CAS lease + the atomic budget — a lead waiting on the
 *      quote page no longer queues behind a 13-minute drain.
 *   1. Drains only durable quote-demand and explicit staff-review requests.
 *      Discovering a town, customer, booking, old rate, or missing neighboring
 *      service never creates work and never spends money.
 *   2. Every provider request RESERVES atomic daily budget BEFORE the call,
 *      so failures, junk answers, and timeouts all consume it and no
 *      interleaving of invocations can exceed the shared caps.
 *   3. Failures back off exponentially; MAX_RESEARCH_ATTEMPTS straight
 *      failures parks the combo (EXHAUSTED) with an owned Office work item
 *      — one bad combo can never loop the queue.
 *   4. Office visibility is a consolidated DAILY digest (plus the Monday
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
 * $50–60/day. RESEARCH_PER_RUN = 20 keeps a
 * single run inside the Lambda window (each research can take 10–60s).
 */
export const RESEARCH_PER_RUN = 20;
export const RESEARCH_PER_DAY = 150;
/** Live quote misses retain a small daily reserve even when staff-requested
 *  research has consumed the normal budget. The public endpoint is
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
/** DEMAND rows have a lead watching the quote page, so their ladder starts
 *  at one minute (1m, 2m, 4m, 8m …) — the 5-minute recovery cron is the
 *  practical floor on when a retry lands. Same exhaustion cap. */
export const DEMAND_BACKOFF_BASE_MS = 60_000;

/** Rough all-in provider cost per research, for the leadership spend
 *  estimate (an estimate, clearly labeled as one — not billing truth). */
export const COST_PER_RESEARCH_USD = 0.35;

/** failCount at/above this makes the weekly report's failing list. */
export const FAILING_THRESHOLD = 2;

/** Stop STARTING research when the run is this old: the function times
 *  out at 900s and one research can hold the line for ~60s. */
const RUN_TIME_BUDGET_MS = 13 * 60_000;

/** The weekly report slot: Monday 10:00 UTC. The cron fires every 5
 *  minutes, so the report is additionally gated to the top
 *  of the hour — see topOfHour in the handler — to fire exactly once. */
const WEEKLY_REPORT_UTC_DAY = 1;
const WEEKLY_REPORT_UTC_HOUR = 10;

/** The daily digest slot (~5pm Eastern): one consolidated email covering
 *  the day's research, spend estimate, and queue state. The once-only
 *  claim on the day row keeps the twelve runs in this hour to ONE email. */
export const DIGEST_UTC_HOUR = 21;

export function backoffMsFor(failCount: number, demand = false): number {
  const base = demand ? DEMAND_BACKOFF_BASE_MS : BACKOFF_BASE_MS;
  return Math.min(base * 2 ** Math.max(0, failCount - 1), BACKOFF_MAX_MS);
}

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
  researchRequestedAt?: string | null;
  researchRequestedBy?: string | null;
  researchRequestReason?: string | null;
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
  createdAt?: string | null;
  active: boolean;
  pinned?: boolean | null;
  prevPriceCents?: number | null;
  prevResearchedAt?: string | null;
  editedBy?: string | null;
  editReason?: string | null;
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

// ------------------------------------------------------- work selection

/** The live (serving) MarketRate row per rate key. `manifest` is the active
 *  rollback version's manifest: with it set, this map matches what quoting
 *  actually serves — a row the version doesn't name is NOT live, so
 *  notify-retries, queue depth, and reports can never describe a sheet
 *  customers can't see. */
function liveRowsByKey(
  rates: RateRow[],
  manifest?: CatalogManifest | null
): Map<string, RateRow> {
  const byKey = new Map<string, RateRow[]>();
  for (const r of rates) {
    const list = byKey.get(r.rateKey) ?? [];
    list.push(r);
    byKey.set(r.rateKey, list);
  }
  const live = new Map<string, RateRow>();
  for (const [key, rows] of byKey) {
    const row = pickServingRow(rows, key, manifest ?? null);
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

function hasResearchRequest(c: CoverageRow): boolean {
  return Boolean(c.researchRequestedAt) ||
    (c.source === "DEMAND" && !c.lastSuccessAt);
}

function demandNeedsResearch(
  coverage: CoverageRow,
  live: Map<string, RateRow>
): boolean {
  const serving = live.get(coverage.id);
  if (!serving) return true;
  return (
    coverage.researchRequestReason === "INCOMPLETE_RATE_SHEET" &&
    !serving.pinned
  );
}

/**
 * What this run researches, in priority order:
 *   (a) Persisted DEMAND requests with no sheet — a real lead is waiting.
 *   (b) Persisted MANUAL requests — one rate explicitly selected by staff.
 *
 * Legacy SEED/SERVED gaps and age alone are deliberately inert.
 */
function selectWork(
  coverage: CoverageRow[],
  live: Map<string, RateRow>,
  now: number
): CoverageRow[] {
  const eligible = coverage.filter((c) => researchable(c, now));
  const byAttempt = (a: CoverageRow, b: CoverageRow) =>
    (a.lastAttemptAt ?? "").localeCompare(b.lastAttemptAt ?? "");
  // Deployment compatibility: a pre-change, never-successful DEMAND row
  // still represents a real waiting quote without the new request stamp.
  const requested = eligible.filter(hasResearchRequest);
  const demand = requested
    .filter((c) => c.source === "DEMAND" && demandNeedsResearch(c, live))
    .sort(byAttempt);
  const manual = requested
    .filter((c) => c.source === "MANUAL" && !live.get(c.id)?.pinned)
    .sort(byAttempt);
  return [...demand, ...manual];
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
  const rollback = await readPricingRollback();

  const cachedToday = rates
    .filter(
      (r) =>
        r.active &&
        ((r.researchedAt ?? "").startsWith(day) ||
          // Office pins carry no researchedAt of their own — their creation
          // time is the change time.
          (Boolean(r.pinned) && (r.createdAt ?? "").startsWith(day)))
    )
    .sort((a, b) => (a.rateKey < b.rateKey ? -1 : 1));

  // GL-16: every live change (AI or office pin) enters the shared queue for
  // its one-business-day review — visibility with a recorded reviewer, never
  // a publication gate. One deduplicated item per day carries them all.
  if (cachedToday.length > 0) {
    await openOwnedWork({
      kind: "PRICING_CHANGE_REVIEW",
      dedupeKey: `pricing-changes:${day}`,
      title: `Review today's ${cachedToday.length} live rate change${cachedToday.length === 1 ? "" : "s"}`,
      detail: `These sheets went live today (already quoting — review, don't approve):\n${cachedToday
        .slice(0, 30)
        .map(
          (r) =>
            `- ${rateLabel(r)}: ${
              r.prevPriceCents != null && r.prevPriceCents !== r.priceCents
                ? `${money(r.prevPriceCents)} → ${money(r.priceCents)}`
                : `${money(r.priceCents)}${r.prevPriceCents != null ? " (unchanged)" : " (new)"}`
            }${r.pinned ? ` — office pin${r.editedBy ? ` by ${r.editedBy}` : ""}${r.editReason ? ` (${r.editReason})` : ""}` : ""}`
        )
        .join("\n")}${cachedToday.length > 30 ? `\n…and ${cachedToday.length - 30} more (see Market Rates).` : ""}\nAnything that looks wrong: edit it on Market Rates (pins the row) or use the OWNER catalog rollback.`,
      relatedId: `pricing-changes:${day}`,
      sourceUrl: "/market-rates",
      resolutionAction:
        "Open Market Rates, scan today's changes, correct anything wrong, then confirm the review.",
      ownerTeam: "OPS",
    });
  }
  const activeCov = coverage.filter((c) => c.active && hasResearchRequest(c));
  // Rollback-aware: the digest's queue depth and live view describe what is
  // actually serving, not sheets a rollback has taken out of service.
  const live = liveRowsByKey(rates, rollback?.manifest ?? null);
  const queueDepth = selectWork(coverage, live, nowMs).length;
  const exhausted = activeCov.filter((c) => c.exhaustedAt);
  const backingOff = activeCov
    .filter(
      (c) => !c.exhaustedAt && c.nextEligibleAt && Date.parse(c.nextEligibleAt) > nowMs
    )
    .sort((a, b) => (a.nextEligibleAt ?? "").localeCompare(b.nextEligibleAt ?? ""));
  const spendEstimate = (counters.attempts * COST_PER_RESEARCH_USD).toFixed(2);

  const bodyHtml = `<p>Today's AI pricing run, consolidated. Every sheet below is <strong>already live and quoting</strong> — this is visibility, not an approval queue. Override any line on <a href="${process.env.CRM_APP_URL ?? ""}/market-rates">Market Rates</a>; an edit pins the row.</p>
    ${
      rollback
        ? `<p style="background:#fef3c7;border-radius:8px;padding:10px;"><strong>Catalog rolled back</strong> to version ${esc(rollback.versionId)} by ${esc(rollback.actor ?? "OWNER")} (${esc(rollback.reason ?? "no reason recorded")}). Quotes serve exactly that version's rows, research is paused, and clearing the rollback resumes both.</p>`
        : ""
    }
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
          `${esc(covLabel(c))}: ${c.failCount ?? 0} straight failures — automated quoting shows a retry error until fresh research succeeds or the rate is corrected`
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
    <p style="margin:0;">${counters.attempts} research attempts (${counters.succeeded} succeeded, ${counters.failed} failed, ${counters.demandAttempts} for waiting leads) · estimated spend ~$${spendEstimate} · daily cap ${RESEARCH_PER_DAY} · ${queueDepth} requested combo${queueDepth === 1 ? "" : "s"} still queued.</p>`;

  return notifyOffice({
    subject: `AI pricing daily digest — ${cachedToday.length} sheet${cachedToday.length === 1 ? "" : "s"} cached, ~$${spendEstimate} spent`,
    heading: "AI pricing — daily digest",
    template: "ops-pricing-daily-digest",
    bodyHtml,
  });
}

/**
 * The Monday email: everything requested research did and could not do.
 * Visibility, not a gate — every sheet listed is already live and
 * quoting; nothing here waits for approval (Jake's standing rule: no
 * review gates, no clamps). The office overrides any line it dislikes on
 * the Market Rates screen, which pins the row against AI replacement.
 */
async function sendWeeklyReport(): Promise<boolean> {
  const client = await dataClient();
  const coverage = await listAll<CoverageRow>(client.models.RateCoverage);
  const rates = await listAll<RateRow>(client.models.MarketRate);
  const now = Date.now();
  const weekAgo = now - 7 * DAY_MS;
  const activeCov = coverage.filter((c) => c.active);
  const requested = activeCov.filter(hasResearchRequest);
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
  const failing = requested.filter(
    (c) => !c.exhaustedAt && (c.failCount ?? 0) >= FAILING_THRESHOLD
  );
  const exhausted = requested.filter((c) => c.exhaustedAt);
  const gaps = requested.filter((c) => !c.lastSuccessAt);
  // Counts are per-combo latest stamps, so a combo attempted twice in the
  // week counts once — close enough for a trend line. (Exact daily counts
  // live on the PricingControl day rows and the daily digest.)
  const attempts7d = requested.filter(
    (c) => c.lastAttemptAt && Date.parse(c.lastAttemptAt) > weekAgo
  ).length;
  const successes7d = requested.filter(
    (c) => c.lastSuccessAt && Date.parse(c.lastSuccessAt) > weekAgo
  ).length;

  const ageDays = (iso: string) => Math.floor((now - Date.parse(iso)) / DAY_MS);
  // Honest under a rollback: "already live and quoting" is not true of
  // post-cutoff sheets while the catalog is rolled back.
  const rollback = await readPricingRollback();

  const bodyHtml = `${
    rollback
      ? `<p style="background:#fef3c7;border-radius:8px;padding:10px;"><strong>Catalog rolled back</strong> to version ${esc(rollback.versionId)} — only that version's rows are serving, and research is paused until the rollback clears.</p>`
      : ""
  }<p>The weekly look at demand-triggered and staff-requested AI research. Every sheet below is <strong>already live and quoting</strong> — this is visibility, not an approval queue. The system does not seed towns or refresh rates merely because they age. To overrule any number, edit it on <a href="${process.env.CRM_APP_URL ?? ""}/market-rates">Market Rates</a>; an edit pins the row.</p>
    ${section(
      `Price moves this week (${moves.length})`,
      moves.map(
        ({ r, pct }) =>
          `${esc(rateLabel(r))}: ${money(r.prevPriceCents!)} → <strong>${money(r.priceCents)}</strong> (${pct > 0 ? "+" : ""}${pct.toFixed(1)}%)`
      ),
      "No requested research changed a price."
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
          `${esc(covLabel(c))}: ${c.failCount} straight failures${c.lastSuccessAt ? ` — last good sheet ${ageDays(c.lastSuccessAt)}d ago still serving` : " — never priced, automated quoting will show a retry error if attempts exhaust"}`
      ),
      `Nothing has failed ${FAILING_THRESHOLD}+ times.`
    )}
    ${section(
      `Requested prices still missing (${gaps.length})`,
      gaps.map(
        (c) =>
          `${esc(covLabel(c))} (${c.source.toLowerCase()}${(c.failCount ?? 0) > 0 ? `, ${c.failCount} failed tries` : ""})`
      ),
      "Every requested combo has a sheet."
    )}
    <h2 style="font-size:15px;margin:20px 0 6px;">This week's research</h2>
    <p style="margin:0;">${successes7d} requested combos succeeded of ${attempts7d} attempted · ${requested.length} still requested or in recovery · daily cap ${RESEARCH_PER_DAY}.</p>`;

  return notifyOffice({
    subject: `AI pricing weekly report — ${moves.length} price move${moves.length === 1 ? "" : "s"}, ${gaps.length} request${gaps.length === 1 ? "" : "s"} missing`,
    heading: "AI pricing — weekly report",
    template: "ops-pricing-weekly-report",
    bodyHtml,
  });
}

// ---------------------------------------------------------- failure path

/** Settle failed research on the leased row: bounded exponential backoff
 *  (the short DEMAND ladder when a lead is waiting), and at
 *  MAX_RESEARCH_ATTEMPTS straight failures the combo is EXHAUSTED — parked
 *  out of the queue with a deduplicated, owned Office work item. `failures`
 *  is how many provider attempts this run failed (a demand in-run retry
 *  counts both — each reserved and consumed its own budget). */
async function settleResearchFailure(
  cov: CoverageRow,
  nonce: string,
  nowIso: string,
  failures = 1
): Promise<void> {
  const fails = (cov.failCount ?? 0) + Math.max(1, failures);
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
            Date.parse(nowIso) + backoffMsFor(fails, cov.source === "DEMAND")
          ).toISOString(),
        }),
  });
  if (exhausted) {
    await openOwnedWork({
      kind: "PRICING_RESEARCH_EXHAUSTED",
      dedupeKey: cov.id,
      title: `AI pricing gave up on ${covLabel(cov)}`,
      detail: `Research failed ${fails} times in a row for ${covLabel(cov)}. Automated quotes for this service + area now show an explicit retry error (never an invented price or sales escalation). From Market Rates: retry the research, correct and pin the sheet, or retire the combo.`,
      relatedId: cov.id,
      resolutionAction:
        "Open Market Rates → research queue: retry, pin a manual price, or retire the combo.",
      ownerTeam: "OPS",
    });
  }
}

// ---------------------------------------------------- one leased research

const BUDGET_CAPS = {
  perDay: RESEARCH_PER_DAY,
  demandPerDay: DEMAND_RESEARCH_PER_DAY,
};

/**
 * Research ONE coverage row the caller already holds the lease on, end to
 * end: atomic budget reservation before every provider call, the fast
 * DEMAND profile for waiting-lead rows (DEEP for staff reviews), success
 * emails claimed under the lease, and demand-aware backoff on failure.
 * A DEMAND row gets ONE immediate in-run retry on a failed attempt — a
 * lead is polling the quote page, so a transient junk answer must not cost
 * a cron-cycle wait. The retry reserves its own budget, both failures
 * count toward exhaustion, and it is skipped when this failure would
 * exhaust the combo anyway or the run is out of time. Two DEMAND calls
 * (120s ceiling each) still fit the 5-minute row lease. Settles the lease
 * on every path.
 */
async function researchLeasedRow(opts: {
  cov: CoverageRow;
  nonce: string;
  anthropicKey: string;
  lane: BudgetLane;
  deadlineMs: number;
}): Promise<{
  attempted: number;
  succeeded: number;
  failed: number;
  budgetExhausted: boolean;
  notified: number;
}> {
  const { cov, nonce, anthropicKey, lane } = opts;
  const demand = cov.source === "DEMAND";
  let attempted = 0;
  let failed = 0;
  let notified = 0;
  const maxAttempts =
    demand && (cov.failCount ?? 0) + 1 < MAX_RESEARCH_ATTEMPTS ? 2 : 1;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0 && Date.now() > opts.deadlineMs) break;
    const reserved = await reserveBudget(new Date(), lane, BUDGET_CAPS);
    if (!reserved) {
      // Nothing was spent on THIS attempt; settle whatever already failed.
      if (failed > 0) {
        await settleResearchFailure(
          cov,
          nonce,
          new Date().toISOString(),
          failed
        ).catch(() => undefined);
      } else {
        await settleCoverageRow(cov.id, nonce, { leaseUntil: null });
      }
      return { attempted, succeeded: 0, failed, budgetExhausted: true, notified };
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
        // The drain nonce is the run identity every row this run caches
        // records for the audit.
        runId: nonce,
        profile: demand ? "DEMAND" : "DEEP",
      });
      if (res) {
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
          researchRequestedAt: null,
          leaseUntil: null,
        });
        return {
          attempted,
          succeeded: 1,
          failed,
          budgetExhausted: false,
          notified,
        };
      }
      failed++;
      await recordOutcome(new Date(), false);
    } catch (err) {
      // One bad attempt never takes down the run — but it was reserved,
      // its failure is counted, and its backoff is recorded below.
      failed++;
      console.error("pricing-refresh: research failed", cov.id, err);
      await recordOutcome(new Date(), false).catch(() => undefined);
    }
  }
  await settleResearchFailure(
    cov,
    nonce,
    new Date().toISOString(),
    failed
  ).catch(() => undefined);
  return { attempted, succeeded: 0, failed, budgetExhausted: false, notified };
}

// --------------------------------------------------------------- handler

type PricingRefreshEvent = {
  /** Internal on-demand wake-up from a quote miss or explicit staff review. */
  rateKey?: string;
  source?: "quote" | "manual";
};

type RunSummary = {
  skipped: string | undefined;
  targetedRateKey: string | null;
  seeded: number;
  queued: number;
  attempted: number;
  succeeded: number;
  failed: number;
  budgetExhausted: boolean;
  rolledBack: boolean;
  notified: number;
  digested: boolean;
  reported: boolean;
};

const emptySummary = (targetedRateKey: string | null): RunSummary => ({
  skipped: undefined,
  targetedRateKey,
  seeded: 0,
  queued: 0,
  attempted: 0,
  succeeded: 0,
  failed: 0,
  budgetExhausted: false,
  rolledBack: false,
  notified: 0,
  digested: false,
  reported: false,
});

/**
 * A targeted wake-up: one quote miss (or one staff review) for one rate
 * key, invoked async by the quoting paths the moment they enqueue the
 * demand. It never scans the queue, so it does NOT take the global drain
 * lease — the row's own CAS lease prevents double-research (including
 * against a cron drain mid-run) and the atomic budget bounds spend exactly
 * as on the cron path. This is what gets a waiting lead researched ~1s
 * after the miss instead of behind a 13-minute drain + 5-minute cron.
 */
async function runTargetedWakeup(
  rateKey: string,
  source: "quote" | "manual",
  startedAt: number
): Promise<RunSummary> {
  const summary = emptySummary(rateKey);
  const done = () => {
    console.log("pricing-refresh:", JSON.stringify(summary));
    return summary;
  };

  const client = await dataClient();
  // While the catalog is rolled back, research publication pauses.
  const rollback = await readPricingRollback();
  if (rollback) {
    summary.rolledBack = true;
    summary.skipped = "rollback-active";
    return done();
  }

  // Same eligibility rules as the cron's targeted selection: a quote
  // wake-up researches only a persisted cold-cache miss; a manual wake-up
  // may replace a live unpinned sheet only when staff stamped that exact
  // coverage row. Nothing else can become targeted work.
  const { data: covData } = await client.models.RateCoverage.get({
    id: rateKey,
  });
  const cov = (covData ?? null) as CoverageRow | null;
  const { data: keyRows } =
    await client.models.MarketRate.listMarketRateByRateKey({ rateKey });
  const serving = pickServingRow(
    (keyRows ?? []) as RateRow[],
    rateKey,
    null
  ) as RateRow | null;
  const live = new Map<string, RateRow>();
  if (serving) live.set(rateKey, serving);
  const eligible =
    cov &&
    researchable(cov, startedAt) &&
    Boolean(cov.researchRequestedAt) &&
    ((source === "quote" &&
      cov.source === "DEMAND" &&
      demandNeedsResearch(cov, live)) ||
      (source === "manual" && cov.source === "MANUAL" && !serving?.pinned));
  if (!cov || !eligible) {
    summary.skipped = "not-eligible";
    return done();
  }
  summary.queued = 1;

  const anthropicKey = await getSecret("ANTHROPIC_API_KEY");
  if (!anthropicKey) {
    console.error(
      "pricing-refresh: no ANTHROPIC_API_KEY — targeted wake-up holds",
      rateKey
    );
    summary.skipped = "no-api-key";
    return done();
  }

  const nonce = freshNonce();
  if (!(await leaseCoverageRow(rateKey, nonce, new Date()))) {
    // Another worker (a cron drain or overlapping wake-up) holds this exact
    // row — it owns the research; exit without spending anything.
    summary.skipped = "row-lease-held";
    return done();
  }
  const out = await researchLeasedRow({
    cov,
    nonce,
    anthropicKey,
    lane: source === "quote" ? "DEMAND" : "GENERAL",
    deadlineMs: startedAt + RUN_TIME_BUDGET_MS,
  });
  summary.attempted = out.attempted;
  summary.succeeded = out.succeeded;
  summary.failed = out.failed;
  summary.budgetExhausted = out.budgetExhausted;
  summary.notified = out.notified;
  // GL-16: every run that PUBLISHED rates snapshots the new complete
  // serving catalog as an immutable version — the unit a rollback restores.
  if (out.succeeded > 0) {
    await writeCatalogSnapshot("RUN", openOwnedWork);
  }
  return done();
}

export const handler = async (event: PricingRefreshEvent = {}) => {
  const startedAt = Date.now();
  const now = new Date();
  const targetedSource =
    (event.source === "quote" || event.source === "manual") &&
    typeof event.rateKey === "string"
      ? event.source
      : null;
  if (targetedSource) {
    return runTargetedWakeup(event.rateKey!, targetedSource, startedAt);
  }
  const targetedRateKey = null;
  // The cron is only a recovery drain for persisted demand/manual requests.
  // The top-of-hour check exists solely to send the once-weekly report.
  const topOfHour = now.getUTCMinutes() < 5;

  // GL-16: ONE drain at a time. The loser exits before selecting or spending
  // anything — an overlapping invocation (5-min cron + a 13-min run, or a
  // burst of quote wake-ups) can never double-research the queue. A crashed
  // holder's lease expires before the second cron after it, and the takeover
  // is a single atomic conditional write.
  const nonce = freshNonce();
  if (!(await acquireDrain(nonce))) {
    const summary = {
      ...emptySummary(targetedRateKey),
      skipped: "drain-lease-held" as string | undefined,
    };
    console.log("pricing-refresh:", JSON.stringify(summary));
    return summary;
  }
  try {
    const seeded = 0; // retained in the operational summary for compatibility
    const client = await dataClient();
    const coverage = await listAll<CoverageRow>(client.models.RateCoverage);
    // GL-16 rollback: read the rollback state FIRST — the live map must
    // match what quoting serves. During a rollback, a combo whose only
    // sheet is post-cutoff is NOT ready: emailing "your exact prices are
    // ready" for a sheet the funnel refuses is a demonstrable mixed
    // catalog (the lead clicks through to no price at all).
    const rollback = await readPricingRollback();
    const live = liveRowsByKey(
      await listAll<RateRow>(client.models.MarketRate),
      rollback?.manifest ?? null
    );
    let notified = 0;

    // GL-16: a rollback can only point at versions that EXIST. Bootstrap:
    // the first run with live rates and no CatalogVersion writes one, so
    // the owner is never a bad batch away from having nothing to restore.
    if (!rollback && live.size > 0) {
      try {
        const versionModels = client.models as unknown as {
          CatalogVersion?: {
            list: (a: { limit: number }) => Promise<{ data: { id: string }[] }>;
          };
        };
        const any = versionModels.CatalogVersion
          ? await versionModels.CatalogVersion.list({ limit: 1 })
          : null;
        if (any && (any.data ?? []).length === 0) {
          await writeCatalogSnapshot("BOOTSTRAP", openOwnedWork);
        }
      } catch (err) {
        console.error("pricing-refresh: bootstrap snapshot check failed", err);
      }
    }

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

    // While the catalog is rolled back, research PUBLICATION also pauses —
    // a refresh from the same suspect prompt would immediately supersede
    // the restored sheet. The work-list, leases, and notify retries keep
    // running; research resumes the moment the rollback is cleared.
    const queue = rollback ? [] : selectWork(coverage, live, startedAt);

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
      const deadlineMs = startedAt + RUN_TIME_BUDGET_MS;
      for (const cov of queue) {
        if (attempted >= RESEARCH_PER_RUN) break;
        if (Date.now() > deadlineMs) break;
        // Lease first (free), budget second (money): a row someone else
        // holds is skipped without consuming anything. The recovery drain
        // spends the GENERAL budget — the DEMAND reserve belongs to live
        // targeted wake-ups.
        if (!(await leaseCoverageRow(cov.id, nonce, new Date()))) continue;
        const out = await researchLeasedRow({
          cov,
          nonce,
          anthropicKey,
          lane: "GENERAL",
          deadlineMs,
        });
        attempted += out.attempted;
        succeeded += out.succeeded;
        failed += out.failed;
        notified += out.notified;
        if (out.budgetExhausted) {
          budgetExhausted = true;
          break;
        }
      }
    }

    // GL-16: every run that PUBLISHED rates snapshots the new complete
    // serving catalog as an immutable version — the unit a rollback
    // restores. (Office pins don't need snapshots: pinned rows win in
    // every mode, and a retire stays retired in every mode.)
    if (succeeded > 0) {
      await writeCatalogSnapshot("RUN", openOwnedWork);
    }

    // The consolidated daily digest — once, however many runs share the hour.
    let digested = false;
    if (now.getUTCHours() === DIGEST_UTC_HOUR) {
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
      rolledBack: Boolean(rollback),
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
