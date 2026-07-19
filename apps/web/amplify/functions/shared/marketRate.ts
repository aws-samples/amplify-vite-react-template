import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import { dataClient } from "./dataClient";
import { money, oneTimeGrossProfitCents } from "../crm-pricing/rateCards";

/**
 * AI-researched market rates — the base-price engine for every service.
 *
 * One research call per (service, area, size band) returns a full rate
 * sheet — one-time price, recurring-plan cadences with monthly + initial
 * fees, the wasp extra-nest increment, HOA per-unit monthly rates by
 * unit-count band — cached on ONE MarketRate row. Consistency rule:
 * identical inputs → identical prices, and the office can edit or retire
 * any cached rate from the CRM. The office override surface is the FULL
 * sheet: the Market Rates screen edits ratesJson components and mirrors
 * `priceCents` to the sheet's one-time price on save. An office edit sets
 * `pinned`, and a pinned row is NEVER re-researched — the office's number
 * stands until the office un-pins or retires it.
 *
 * The live path is PURE READS. getCachedRate serves last-known-good and
 * never researches: an expired sheet still serves (a week-old price beats
 * a callback), so `expiresAt` means "due for refresh", never "refuse";
 * pinned rows serve forever until un-pinned; only a combo with NO sheet at
 * all returns null. On null the caller records the miss with
 * enqueueRateResearch (an idempotent RateCoverage upsert, optionally
 * carrying the waiting lead's email) and takes its honest fallback — the
 * hourly pricing-refresh cron researches the combo and emails the lead
 * when their exact prices are ready.
 *
 * Research (researchAndCacheRate) is exported ONLY as the cron's
 * machinery: no quote request ever waits 10–60s on an Anthropic call
 * anymore, and the research budget lives in the cron's caps
 * (RESEARCH_PER_RUN / RESEARCH_PER_DAY in pricing-refresh), which replaced
 * the old live-path NEW_RESEARCH_PER_DAY.
 *
 * Guardrails — deliberately no min/max clamps, no review queue, and
 * deliberately no upper bound:
 *
 *   1. Variable-cost floor. A researched one-time price never ships below
 *      the deterministic Zone-A variable cost from crm-pricing/rateCards
 *      (Zone A is the cheapest case, so it is the zone-independent lower
 *      bound; the day-pricing overlay re-floors at the caller's actual zone
 *      per R62). Components with no deterministic cost model — the plan
 *      cadences (rateCards' Step-5 cost constants cover one-time/specialty
 *      visits only), the wasp extra-nest increment, and the HOA per-unit
 *      rates — carry NO floor; that fact is recorded on the rate row's
 *      basis rather than inventing economics.
 *
 *   2. No invented prices. Junk or partial research NEVER yields a made-up
 *      number — every component parses or the whole result is discarded
 *      and the previous sheet keeps serving.
 *
 * When a NEW sheet is researched and cached the office gets a short
 * heads-up email pointing at the Market Rates screen. That is visibility,
 * not a gate — the sheet quotes immediately.
 */

/**
 * Refresh cadence: a sheet older than this is due for re-research by the
 * cron. Also what a fresh row's `expiresAt` is set to — the "due" date the
 * office sees, not a serve deadline.
 */
export const REFRESH_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * GL-16 — the designed pricing prompt is versioned business policy. Bump the
 * human-readable version on any deliberate prompt change; the hash is
 * computed from the actual spec content so an ad-hoc edit can never ship
 * unversioned (the recorded hash changes even when the label forgot to).
 */
export const PRICING_PROMPT_VERSION = "2026-07-19.1";
export const PRICING_MODEL = "claude-opus-4-8";

export type MarketRateService =
  | "GENERAL_PEST"
  | "WASP_NEST"
  | "RODENT"
  | "ROACH"
  | "TERMITE"
  | "WILDLIFE"
  | "COMMERCIAL"
  | "HOA";

export type PlanCadence = "MONTHLY" | "BIMONTHLY" | "QUARTERLY";
export const PLAN_CADENCES: PlanCadence[] = [
  "MONTHLY",
  "BIMONTHLY",
  "QUARTERLY",
];

export type PlanRate = { monthlyCents: number; initialFeeCents: number };

/**
 * HOA unit-count bands, mirroring the brackets the retired deterministic
 * association card used (≤10 base, 11–25, 26–50, 51–100, 101+).
 */
export type HoaBand =
  | "UNITS_1_10"
  | "UNITS_11_25"
  | "UNITS_26_50"
  | "UNITS_51_100"
  | "UNITS_101_PLUS";
export const HOA_BANDS: HoaBand[] = [
  "UNITS_1_10",
  "UNITS_11_25",
  "UNITS_26_50",
  "UNITS_51_100",
  "UNITS_101_PLUS",
];

export function hoaBandFor(units: number): HoaBand {
  if (units <= 10) return "UNITS_1_10";
  if (units <= 25) return "UNITS_11_25";
  if (units <= 50) return "UNITS_26_50";
  if (units <= 100) return "UNITS_51_100";
  return "UNITS_101_PLUS";
}

/** HOA: per-unit MONTHLY price in cents, by unit-count band and cadence. */
export type HoaPerUnitRates = Record<HoaBand, Record<PlanCadence, number>>;

/** The full researched sheet stored on one MarketRate row (ratesJson). */
export type RateSheet = {
  /** One-time treatment (WASP_NEST: the visit including the first nest).
   *  Absent on HOA sheets — common-area work has no one-time card. */
  oneTimeCents?: number;
  /** WASP_NEST: incremental price per additional nest on the same visit. */
  extraNestCents?: number;
  /** GENERAL_PEST: recurring plans, each billed as a flat monthly price. */
  plans?: Record<PlanCadence, PlanRate>;
  /** HOA: per-unit monthly rate by unit-count band and visit cadence. */
  hoaPerUnitMonthly?: HoaPerUnitRates;
};

export type MarketRateResult = {
  /** Mirrors sheet.oneTimeCents (continuity field). HOA sheets have no
   *  one-time, so the mirror is the smallest band's monthly per-unit rate. */
  priceCents: number;
  sheet: RateSheet;
  basis: string;
  cached: boolean;
};

/** What the row's required priceCents column mirrors for a given sheet. */
function mirrorCents(sheet: RateSheet): number {
  return (
    sheet.oneTimeCents ?? sheet.hoaPerUnitMonthly?.UNITS_1_10.MONTHLY ?? 0
  );
}

/** Round to a tidy $X9 ending like the rest of the rate card. */
function tidy(cents: number): number {
  const dollars = Math.round(cents / 100);
  return (Math.max(1, Math.round((dollars + 1) / 10)) * 10 - 1) * 100;
}

export function sqftBucket(sqft: number): number {
  return Math.max(500, Math.ceil(sqft / 500) * 500);
}

export function areaKeyFor(city: string, state: string): string {
  return `${city.trim().toLowerCase().replace(/\s+/g, "-")}-${state.trim().toLowerCase()}`;
}

// ---------------------------------------------------- variable-cost floor

/**
 * Funnel service → one-time cost kind in crm-pricing/rateCards (the same
 * mapping the day-pricing overlay uses for R62). HOA, TERMITE, WILDLIFE,
 * and COMMERCIAL have no entry: no deterministic cost model exists for that
 * work, so their rates carry no floor — recorded on the row's basis, not
 * invented.
 */
const COST_KIND: Partial<Record<MarketRateService, string>> = {
  GENERAL_PEST: "one_time_gpc",
  WASP_NEST: "wasp_nest",
  RODENT: "rodent_nest",
  // Same 90-minute onsite as rodent; gel bait + IGR + included follow-up
  // materials track the $55 rodent kit, not the $15 GPC kit.
  ROACH: "rodent_nest",
};

/** Deterministic Zone-A variable cost for a one-time job kind, in cents. */
function variableCostCents(kind: string): number {
  // gp(price=0) is exactly -cost.
  return -(oneTimeGrossProfitCents(kind, 0, "A") ?? 0);
}

function applyFloor(
  service: MarketRateService,
  sheet: RateSheet
): { sheet: RateSheet; floorNotes: string[] } {
  const notes: string[] = [];
  const costKind = COST_KIND[service];
  let oneTimeCents = sheet.oneTimeCents;
  if (costKind != null && oneTimeCents != null) {
    const floor = variableCostCents(costKind);
    if (oneTimeCents < floor) {
      oneTimeCents = floor;
      notes.push(`one-time floored at Zone-A variable cost ${money(floor)}`);
    }
  }
  if (costKind == null && oneTimeCents != null) {
    // TERMITE / WILDLIFE / COMMERCIAL: no deterministic cost model exists
    // for the work, so the researched price ships unfloored — recorded here
    // rather than inventing economics.
    notes.push(
      "one-time price carries no variable-cost floor (no cost model exists for this service)"
    );
  }
  if (sheet.plans) {
    notes.push(
      "plan prices carry no variable-cost floor (rateCards' cost model covers one-time/specialty visits only)"
    );
  }
  if (sheet.extraNestCents != null) {
    notes.push(
      "extra-nest price carries no variable-cost floor (no incremental cost model)"
    );
  }
  if (sheet.hoaPerUnitMonthly) {
    notes.push(
      "HOA per-unit rates carry no variable-cost floor (no cost model exists for common-area work)"
    );
  }
  return { sheet: { ...sheet, oneTimeCents }, floorNotes: notes };
}

// ---------------------------------------------------- the live path (reads)

function parseSheet(raw: unknown): RateSheet | null {
  if (raw == null) return null;
  try {
    const value = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (
      typeof value === "object" &&
      value !== null &&
      (typeof (value as RateSheet).oneTimeCents === "number" ||
        typeof (value as RateSheet).hoaPerUnitMonthly === "object")
    ) {
      return value as RateSheet;
    }
  } catch {
    /* corrupt ratesJson — treat as sheet-less row */
  }
  return null;
}

/** The combo key: identical for MarketRate.rateKey and RateCoverage.id. */
export function rateKeyFor(
  service: MarketRateService,
  areaKey: string,
  bucket: number | null
): string {
  return `${service}#${areaKey}${bucket ? `#${bucket}` : ""}`;
}

/**
 * Which row serves for a rate key: a pinned row is the office's word and
 * always wins; otherwise the freshest research does. Expiry does not
 * disqualify anything — serve-last-known-good. Shared with the cron so
 * "the row that serves" and "the row that refreshes" are the same row.
 *
 * GL-16 rollback: with a `cutoffIso` set (the catalog-rollback state), AI
 * rows researched AFTER the cutoff are excluded, so the whole catalog serves
 * the prior coherent sheet in one flip. Pinned office rows still win — an
 * explicit office price is never silently rolled back.
 */
export function pickLiveRow<
  T extends {
    active: boolean;
    pinned?: boolean | null;
    researchedAt?: string | null;
  },
>(rows: T[], cutoffIso?: string | null): T | null {
  const live = rows.filter((r) => r.active);
  const eligible = cutoffIso
    ? live.filter((r) => r.pinned || (r.researchedAt ?? "") <= cutoffIso)
    : live;
  return (
    eligible.find((r) => r.pinned) ??
    eligible.reduce<T | null>(
      (best, r) =>
        !best || (r.researchedAt ?? "") > (best.researchedAt ?? "") ? r : best,
      null
    )
  );
}

// ------------------------------------------------------- rollback state

export type PricingRollback = {
  cutoffIso: string;
  reason?: string | null;
  actor?: string | null;
  appliedAt?: string | null;
};

let rollbackMemo: { at: number; value: PricingRollback | null } | null = null;

/**
 * The live catalog-rollback state (PricingControl "catalog-rollback"),
 * memoized briefly per container — every quote read consults it. Null when
 * no rollback is active, and null on any read fault (serving the newest
 * sheet is the normal state; a rollback is an explicit operator action whose
 * screen confirms it took effect).
 */
export async function readPricingRollback(): Promise<PricingRollback | null> {
  if (rollbackMemo && Date.now() - rollbackMemo.at < 60_000) {
    return rollbackMemo.value;
  }
  let value: PricingRollback | null = null;
  try {
    const client = await dataClient();
    if ("PricingControl" in client.models) {
      const { data } = await client.models.PricingControl.get({
        id: "catalog-rollback",
      });
      if (data?.rollbackCutoff) {
        value = {
          cutoffIso: data.rollbackCutoff,
          reason: data.rollbackReason,
          actor: data.rollbackActor,
          appliedAt: data.rollbackAppliedAt,
        };
      }
    }
  } catch {
    value = null;
  }
  rollbackMemo = { at: Date.now(), value };
  return value;
}

/** Tests (and the rollback mutation itself) reset the memo so a state change
 *  is visible without waiting out the container cache. */
export function _resetRollbackMemoForTests(): void {
  rollbackMemo = null;
}

/**
 * The live path: return the freshest usable cached sheet, or null. NEVER
 * researches, never waits — an expired sheet still serves (it is merely
 * due for refresh), a pinned sheet serves forever, and only a combo with
 * no sheet at all returns null. Callers pair a null with
 * enqueueRateResearch + their honest fallback.
 */
export async function getCachedRate(opts: {
  service: MarketRateService;
  city: string;
  state: string;
  sqft?: number;
}): Promise<MarketRateResult | null> {
  const { service, city, state, sqft } = opts;
  const areaKey = areaKeyFor(city, state);
  const bucket = sqft != null ? sqftBucket(sqft) : null;
  const rateKey = rateKeyFor(service, areaKey, bucket);

  const client = await dataClient();
  const { data: existing } =
    await client.models.MarketRate.listMarketRateByRateKey({ rateKey });
  // GL-16: an active rollback serves the prior coherent sheet everywhere.
  const rollback = await readPricingRollback();
  const live = pickLiveRow(existing, rollback?.cutoffIso ?? null);
  if (!live) return null;

  const stored = parseSheet(live.ratesJson);
  if (stored?.hoaPerUnitMonthly) {
    // HOA sheets have no one-time component; the office edits the
    // per-unit rates in ratesJson directly and priceCents is only the
    // model's required mirror column.
    return {
      priceCents: live.priceCents,
      sheet: stored,
      basis: live.basis ?? "",
      cached: true,
    };
  }
  // priceCents is mirrored to the sheet's one-time on office save, and it
  // wins over the stored one-time — that keeps rows edited before the
  // full-sheet override surface existed honest too.
  return {
    priceCents: live.priceCents,
    sheet: { ...(stored ?? {}), oneTimeCents: live.priceCents },
    basis: live.basis ?? "",
    cached: true,
  };
}

// ------------------------------------------------- demand-enqueue (misses)

export type RateNotifyEntry = {
  email: string;
  bookingRequestId?: string;
  /** Research finished, but the ready-email delivery still needs retrying. */
  ready?: boolean;
};

/** Waiting-lead entries kept per coverage row — enough for a small shop's
 *  hour of misses on one combo; anything past this still gets researched,
 *  the overflow lead just isn't individually emailed. */
export const NOTIFY_CAP = 5;

export function parseNotify(raw: unknown): RateNotifyEntry[] {
  if (raw == null) return [];
  try {
    const value = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (Array.isArray(value)) {
      return value.filter(
        (e): e is RateNotifyEntry =>
          typeof e === "object" && e !== null && typeof e.email === "string"
      );
    }
  } catch {
    /* corrupt notify — treat as empty */
  }
  return [];
}

/**
 * Record that somebody needed a combo we have no sheet for (or that
 * seeding wants one researched). Idempotent per combo: one RateCoverage
 * row keyed by the combo, upserted; a waiting lead's email is appended to
 * its notify list (deduped, capped at NOTIFY_CAP) so the cron can send
 * "your exact prices are ready" when the sheet lands. A live-path miss is
 * DEMAND and jumps the refresh queue — including promoting an existing
 * seeded row. Never throws: losing a miss record must never fail a quote.
 */
export async function enqueueRateResearch(opts: {
  service: MarketRateService;
  city: string;
  state: string;
  sqft?: number;
  notifyEmail?: string;
  bookingRequestId?: string;
  /** Coverage provenance; live-path misses are DEMAND (the default). */
  source?: "SEED" | "SERVED" | "DEMAND";
}): Promise<void> {
  try {
    const { service, city, state, sqft } = opts;
    const source = opts.source ?? "DEMAND";
    const areaKey = areaKeyFor(city, state);
    const band = sqft != null ? sqftBucket(sqft) : null;
    const id = rateKeyFor(service, areaKey, band);
    const entry: RateNotifyEntry | null = opts.notifyEmail
      ? {
          email: opts.notifyEmail.trim().toLowerCase(),
          ...(opts.bookingRequestId
            ? { bookingRequestId: opts.bookingRequestId }
            : {}),
        }
      : null;

    const client = await dataClient();
    let { data: existing } = await client.models.RateCoverage.get({ id });
    if (!existing) {
      const { data: createdRow, errors } =
        await client.models.RateCoverage.create({
          id,
          service,
          areaKey,
          city: city.trim(),
          state: state.trim().toUpperCase(),
          band,
          source,
          failCount: 0,
          active: true,
          notify: JSON.stringify(entry ? [entry] : []),
        });
      if (createdRow && !errors?.length) return;
      // Lost a create race — re-read and merge into the winner's row.
      existing = (await client.models.RateCoverage.get({ id })).data;
      if (!existing) return;
    }

    // GL-16: a retired coverage row is the office's decision and STAYS
    // retired — seeding and quote misses must not regenerate work the
    // office removed. (The office reactivates from the Market Rates
    // screen.) The lead already received the honest callback fallback.
    if (!existing.active) return;

    const patch: Record<string, unknown> = {};
    // A real customer miss promotes a seeded row so it jumps the refresh
    // queue (self-heal within the hour). Never demote the other way.
    if (source === "DEMAND" && existing.source !== "DEMAND") {
      patch.source = "DEMAND";
    }
    if (entry) {
      const list = parseNotify(existing.notify);
      const dup = list.some(
        (e) =>
          e.email === entry.email &&
          e.bookingRequestId === entry.bookingRequestId
      );
      if (!dup && list.length < NOTIFY_CAP) {
        patch.notify = JSON.stringify([...list, entry]);
      }
    }
    if (Object.keys(patch).length) {
      await client.models.RateCoverage.update({ id, ...patch });
    }
  } catch (err) {
    console.error("enqueueRateResearch failed", opts.service, opts.city, err);
  }
}

// --------------------------------------- research + cache (cron machinery)

export type RefreshResult = {
  priceCents: number;
  sheet: RateSheet;
  basis: string;
  /** The Zone-A variable-cost floor raised the researched one-time price. */
  floorApplied: boolean;
  /** The superseded sheet's mirror price/time — null on first research. */
  prevPriceCents: number | null;
  prevResearchedAt: string | null;
};

/**
 * Research one combo and cache the sheet — the pricing-refresh cron's
 * machinery, and nothing else's: no live request path reaches this
 * anymore. Refuses over a pinned combo (the office's word stands). On
 * success where a previous sheet existed, the new row carries
 * prevPriceCents/prevResearchedAt for the weekly report's price-move
 * ranking, and the superseded rows are retired so exactly one live row
 * serves per combo. The office's new-rate heads-up email still goes out on
 * every fresh sheet — visibility, not a gate.
 */
export async function researchAndCacheRate(opts: {
  anthropicKey: string | null;
  service: MarketRateService;
  city: string;
  state: string;
  sqft?: number;
  /** GL-16: the drain run's identity, recorded on the row for the audit. */
  runId?: string;
}): Promise<RefreshResult | null> {
  const { anthropicKey, service, city, state, sqft } = opts;
  if (!anthropicKey) return null;
  const areaKey = areaKeyFor(city, state);
  const bucket = sqft != null ? sqftBucket(sqft) : null;
  const rateKey = rateKeyFor(service, areaKey, bucket);

  const client = await dataClient();
  const { data: existing } =
    await client.models.MarketRate.listMarketRateByRateKey({ rateKey });
  const prev = pickLiveRow(existing);
  // The cron skips pinned combos before selection; this refusal is defense
  // in depth so nothing can ever research over an office edit.
  if (prev?.pinned) return null;

  const researched = await research(anthropicKey, service, city, state, bucket);
  if (!researched) return null;

  const { sheet, floorNotes } = applyFloor(service, researched.sheet);
  const basis = [researched.basis, ...floorNotes].join(" · ").slice(0, 800);
  const priceCents = mirrorCents(sheet);
  const prevPriceCents = prev?.priceCents ?? null;
  const prevResearchedAt = prev?.researchedAt ?? null;

  await client.models.MarketRate.create({
    rateKey,
    service,
    areaKey,
    priceCents,
    ratesJson: JSON.stringify(sheet),
    basis,
    sources: researched.sources.slice(0, 1000),
    researchedAt: new Date().toISOString(),
    // "Due for refresh", not a serve deadline: getCachedRate serves past
    // this — it is the weekly cadence made visible on the row.
    expiresAt: new Date(Date.now() + REFRESH_AFTER_MS).toISOString(),
    active: true,
    // Fresh research is never pinned — only an office edit pins a row.
    pinned: false,
    prevPriceCents: prevPriceCents ?? undefined,
    prevResearchedAt: prevResearchedAt ?? undefined,
    // GL-16 audit: exactly which versioned prompt/model produced this row
    // from which normalized inputs, the raw structured result, and the run
    // that paid for it — the live price is explainable and reproducible.
    promptVersion: PRICING_PROMPT_VERSION,
    promptHash: pricingPromptHash(),
    model: PRICING_MODEL,
    inputsJson: JSON.stringify({
      service,
      city: city.trim(),
      state: state.trim().toUpperCase(),
      sqftBucket: bucket,
    }),
    rawResult: researched.rawText.slice(0, 8000),
    runId: opts.runId ?? undefined,
  });

  // Retire the superseded rows so one live row serves per combo. Pinned
  // rows are untouched (unreachable here — a pinned combo refused above).
  for (const row of existing) {
    if (row.active && !row.pinned) {
      await client.models.MarketRate.update({ id: row.id, active: false });
    }
  }

  // Visibility rides the daily digest (GL-16: one consolidated email per
  // day, never one per rate) — the sheet quotes immediately either way.
  return {
    priceCents,
    sheet,
    basis,
    floorApplied: floorNotes.some((n) => n.startsWith("one-time floored")),
    prevPriceCents,
    prevResearchedAt,
  };
}

// ---------------------------------------------------------------- research

type ResearchSpec = {
  ask: (city: string, state: string, bucket: number | null) => string;
  /** Every label must parse from the response, or the whole result is junk. */
  lines: string[];
  assemble: (cents: Record<string, number>) => RateSheet;
  /** HOA per-unit rates are small dollar amounts — $X9 tidying would
   *  distort them (tidy($4) is $9), so per-unit specs keep exact cents. */
  tidyLines?: boolean;
};

const LINE_INSTRUCTION =
  "Research current local/regional pricing (2025-2026). End your answer with EXACTLY these lines, each a single competitive number a quality local operator would quote (a number, not a range):";

const RESEARCH_SPECS: Record<MarketRateService, ResearchSpec> = {
  GENERAL_PEST: {
    ask: (city, state, bucket) =>
      `What do pest-control companies near ${city}, ${state} charge for general pest control (ants, spiders, common crawling/stinging insects) on a ~${bucket ?? 2000} sqft single-family home? Price ALL of: (1) a one-time interior+exterior general pest treatment; (2) a recurring plan with monthly visits; (3) a recurring plan with visits every two months; (4) a recurring plan with quarterly visits. Recurring plans are billed as a flat monthly subscription price regardless of visit cadence, and each plan starts with a one-time initial/startup fee for the first intensive visit. ${LINE_INSTRUCTION}
ONE_TIME_USD: <number>
MONTHLY_PLAN_PER_MONTH_USD: <number>
MONTHLY_PLAN_INITIAL_FEE_USD: <number>
BIMONTHLY_PLAN_PER_MONTH_USD: <number>
BIMONTHLY_PLAN_INITIAL_FEE_USD: <number>
QUARTERLY_PLAN_PER_MONTH_USD: <number>
QUARTERLY_PLAN_INITIAL_FEE_USD: <number>`,
    lines: [
      "ONE_TIME_USD",
      "MONTHLY_PLAN_PER_MONTH_USD",
      "MONTHLY_PLAN_INITIAL_FEE_USD",
      "BIMONTHLY_PLAN_PER_MONTH_USD",
      "BIMONTHLY_PLAN_INITIAL_FEE_USD",
      "QUARTERLY_PLAN_PER_MONTH_USD",
      "QUARTERLY_PLAN_INITIAL_FEE_USD",
    ],
    assemble: (c) => ({
      oneTimeCents: c.ONE_TIME_USD,
      plans: {
        MONTHLY: {
          monthlyCents: c.MONTHLY_PLAN_PER_MONTH_USD,
          initialFeeCents: c.MONTHLY_PLAN_INITIAL_FEE_USD,
        },
        BIMONTHLY: {
          monthlyCents: c.BIMONTHLY_PLAN_PER_MONTH_USD,
          initialFeeCents: c.BIMONTHLY_PLAN_INITIAL_FEE_USD,
        },
        QUARTERLY: {
          monthlyCents: c.QUARTERLY_PLAN_PER_MONTH_USD,
          initialFeeCents: c.QUARTERLY_PLAN_INITIAL_FEE_USD,
        },
      },
    }),
  },
  WASP_NEST: {
    ask: (city, state) =>
      `What do pest-control companies near ${city}, ${state} charge for wasp/hornet nest removal at a residential property? Price BOTH: (1) the visit including removal of the FIRST nest; (2) the incremental price for EACH ADDITIONAL nest removed during the same visit (the first nest is already billed, so this is the per-extra-nest increment only). ${LINE_INSTRUCTION}
FIRST_NEST_USD: <number>
EXTRA_NEST_USD: <number>`,
    lines: ["FIRST_NEST_USD", "EXTRA_NEST_USD"],
    assemble: (c) => ({
      oneTimeCents: c.FIRST_NEST_USD,
      extraNestCents: c.EXTRA_NEST_USD,
    }),
  },
  RODENT: {
    ask: (city, state, bucket) =>
      `What do pest-control companies near ${city}, ${state} charge for a full interior+exterior rodent (mice/rats) treatment with trapping and exclusion check for a ~${bucket ?? 2000} sqft single-family home? ${LINE_INSTRUCTION}
ONE_TIME_USD: <number>`,
    lines: ["ONE_TIME_USD"],
    assemble: (c) => ({ oneTimeCents: c.ONE_TIME_USD }),
  },
  ROACH: {
    ask: (city, state, bucket) =>
      `What do pest-control companies near ${city}, ${state} charge for a specialized German cockroach treatment (gel bait + IGR, follow-up included) for a ~${bucket ?? 2000} sqft single-family home? ${LINE_INSTRUCTION}
ONE_TIME_USD: <number>`,
    lines: ["ONE_TIME_USD"],
    assemble: (c) => ({ oneTimeCents: c.ONE_TIME_USD }),
  },
  TERMITE: {
    ask: (city, state, bucket) =>
      `What do pest-control companies near ${city}, ${state} charge for a one-time termite treatment of a ~${bucket ?? 2000} sqft single-family home (liquid soil-applied barrier or comparable localized treatment, as quality local operators actually quote it)? Give the realistic local going rate for the full treatment — not an inspection fee, not a per-linear-foot component. ${LINE_INSTRUCTION}
ONE_TIME_USD: <number>`,
    lines: ["ONE_TIME_USD"],
    assemble: (c) => ({ oneTimeCents: c.ONE_TIME_USD }),
  },
  WILDLIFE: {
    ask: (city, state, bucket) =>
      `What do pest and wildlife companies near ${city}, ${state} charge for a one-time wildlife exclusion and removal visit at a ~${bucket ?? 2000} sqft single-family home (squirrels, raccoons, bats, or similar — getting the animals out and sealing the entry points)? Give the realistic local going rate for the complete visit including the exclusion work, not an inspection-only fee. ${LINE_INSTRUCTION}
ONE_TIME_USD: <number>`,
    lines: ["ONE_TIME_USD"],
    assemble: (c) => ({ oneTimeCents: c.ONE_TIME_USD }),
  },
  COMMERCIAL: {
    ask: (city, state, bucket) =>
      `What do pest-control companies near ${city}, ${state} charge a commercial property (office, retail, warehouse, or similar non-food business) of ~${bucket ?? 2000} sqft for pest control? Price ALL of: (1) a one-time interior+exterior commercial pest treatment; (2) a recurring service plan with monthly visits; (3) a recurring plan with visits every two months; (4) a recurring plan with quarterly visits. Recurring plans are billed as a flat monthly subscription price regardless of visit cadence, and each plan starts with a one-time initial/startup fee for the first intensive visit. ${LINE_INSTRUCTION}
ONE_TIME_USD: <number>
MONTHLY_PLAN_PER_MONTH_USD: <number>
MONTHLY_PLAN_INITIAL_FEE_USD: <number>
BIMONTHLY_PLAN_PER_MONTH_USD: <number>
BIMONTHLY_PLAN_INITIAL_FEE_USD: <number>
QUARTERLY_PLAN_PER_MONTH_USD: <number>
QUARTERLY_PLAN_INITIAL_FEE_USD: <number>`,
    lines: [
      "ONE_TIME_USD",
      "MONTHLY_PLAN_PER_MONTH_USD",
      "MONTHLY_PLAN_INITIAL_FEE_USD",
      "BIMONTHLY_PLAN_PER_MONTH_USD",
      "BIMONTHLY_PLAN_INITIAL_FEE_USD",
      "QUARTERLY_PLAN_PER_MONTH_USD",
      "QUARTERLY_PLAN_INITIAL_FEE_USD",
    ],
    assemble: (c) => ({
      oneTimeCents: c.ONE_TIME_USD,
      plans: {
        MONTHLY: {
          monthlyCents: c.MONTHLY_PLAN_PER_MONTH_USD,
          initialFeeCents: c.MONTHLY_PLAN_INITIAL_FEE_USD,
        },
        BIMONTHLY: {
          monthlyCents: c.BIMONTHLY_PLAN_PER_MONTH_USD,
          initialFeeCents: c.BIMONTHLY_PLAN_INITIAL_FEE_USD,
        },
        QUARTERLY: {
          monthlyCents: c.QUARTERLY_PLAN_PER_MONTH_USD,
          initialFeeCents: c.QUARTERLY_PLAN_INITIAL_FEE_USD,
        },
      },
    }),
  },
  HOA: {
    ask: (city, state) =>
      `What do pest-control companies near ${city}, ${state} charge HOAs and condo associations for recurring COMMON-AREA pest control (building exteriors, clubhouses, mail areas, dumpster pads — not inside individual units)? These contracts bill a flat monthly subscription price regardless of visit cadence; express each answer as the PER-UNIT monthly rate (the flat monthly contract price divided by the community's unit count). Larger communities pay less per unit. Price every combination of community size band and visit cadence (monthly, every-two-months, quarterly visits). ${LINE_INSTRUCTION}
${HOA_BANDS.flatMap((band) =>
  PLAN_CADENCES.map((cadence) => `${band}_${cadence}_PER_UNIT_USD: <number>`)
).join("\n")}`,
    lines: HOA_BANDS.flatMap((band) =>
      PLAN_CADENCES.map((cadence) => `${band}_${cadence}_PER_UNIT_USD`)
    ),
    assemble: (c) => ({
      hoaPerUnitMonthly: Object.fromEntries(
        HOA_BANDS.map((band) => [
          band,
          Object.fromEntries(
            PLAN_CADENCES.map((cadence) => [
              cadence,
              c[`${band}_${cadence}_PER_UNIT_USD`],
            ])
          ),
        ])
      ) as HoaPerUnitRates,
    }),
    tidyLines: false,
  },
};

function parseUsdLine(text: string, label: string): number | null {
  // Anchored to the start of a line: MONTHLY_* is a substring of
  // BIMONTHLY_*, so an unanchored match would let a response missing its
  // MONTHLY lines silently price the monthly plan at bimonthly rates.
  const match = text.match(
    new RegExp(`^\\s*${label}:\\s*\\$?([\\d,]+(?:\\.\\d{1,2})?)`, "im")
  );
  if (!match) return null;
  const dollars = parseFloat(match[1].replace(/,/g, ""));
  if (!Number.isFinite(dollars) || dollars <= 0) return null;
  return Math.round(dollars * 100);
}

/**
 * GL-16 — the content hash of the designed prompt policy: every spec's ask
 * template and required label set, plus the shared line instruction and
 * model. Recorded on every row; a prompt edit changes it even when the
 * version label was forgotten.
 */
let promptHashMemo: string | null = null;
export function pricingPromptHash(): string {
  if (!promptHashMemo) {
    const material = JSON.stringify([
      PRICING_MODEL,
      LINE_INSTRUCTION,
      Object.entries(RESEARCH_SPECS).map(([kind, spec]) => [
        kind,
        spec.lines,
        spec.tidyLines ?? true,
        spec.ask("{city}", "{state}", 2000),
      ]),
    ]);
    promptHashMemo = createHash("sha256").update(material).digest("hex").slice(0, 16);
  }
  return promptHashMemo;
}

async function research(
  apiKey: string,
  service: MarketRateService,
  city: string,
  state: string,
  bucket: number | null
): Promise<{
  sheet: RateSheet;
  basis: string;
  sources: string;
  rawText: string;
} | null> {
  const spec = RESEARCH_SPECS[service];
  const anthropic = new Anthropic({ apiKey, timeout: 55_000, maxRetries: 0 });
  try {
    const researchMsg = await anthropic.messages.create({
      model: PRICING_MODEL,
      max_tokens: 3000,
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 4 }],
      messages: [{ role: "user", content: spec.ask(city, state, bucket) }],
    });
    const text = researchMsg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    // Every component or nothing: a partial answer is a junk answer.
    const cents: Record<string, number> = {};
    for (const label of spec.lines) {
      const parsed = parseUsdLine(text, label);
      if (parsed == null) return null;
      cents[label] = spec.tidyLines === false ? parsed : tidy(parsed);
    }
    const basisLine =
      text
        .split("\n")
        .filter((l) => l.trim() && !/_USD:/i.test(l))
        .slice(-3)
        .join(" ")
        .slice(0, 800) || "AI market research";
    return {
      sheet: spec.assemble(cents),
      basis: basisLine,
      sources: text.slice(0, 1000),
      rawText: text,
    };
  } catch (err) {
    // Authentication, credits, model access and request-shape failures used
    // to collapse into the same silent null as an unusable research answer.
    // Keep the lead pending, but preserve the provider's actionable error in
    // CloudWatch so operations can fix the dependency instead of guessing.
    console.error(
      "market-rate research request failed",
      service,
      areaKeyFor(city, state),
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}

