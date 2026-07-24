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
 * stands until the office un-pins it and explicitly requests new research.
 *
 * The live path is PURE READS. getCachedRate serves last-known-good and
 * never researches: an expired sheet still serves (a week-old price beats
 * a callback), so `expiresAt` is historical metadata, never "refuse";
 * pinned rows serve forever until un-pinned; only a combo with NO sheet at
 * all returns null. On null the caller records the real quote demand with
 * enqueueRateResearch (an idempotent RateCoverage upsert, optionally
 * carrying the waiting lead's email) and returns a resumable research state. The
 * pricing worker researches only that requested combo and emails the lead
 * when their exact prices are ready. There is no speculative town seeding
 * and age alone never triggers research.
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
 * Historical review marker retained on stored rows. It is not an automatic
 * refresh trigger: a sheet keeps serving until a real quote needs a missing
 * sheet, staff explicitly requests research, edits/pins it, or retires it.
 */
export const REFRESH_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * GL-16 — the designed pricing prompt is versioned business policy. Bump the
 * human-readable version on any deliberate prompt change; the hash is
 * computed from the actual spec content so an ad-hoc edit can never ship
 * unversioned (the recorded hash changes even when the label forgot to).
 */
export const PRICING_PROMPT_VERSION = "2026-07-20.1";
export const PRICING_MODEL = "claude-opus-4-8";
export const DEMAND_PRICING_MODEL = "claude-sonnet-5";

/**
 * How a research call runs. DEEP is the staff-requested review pass: Opus,
 * the full four searches, and the 4-minute ceiling. DEMAND is the live
 * quote-miss pass — a lead is sitting on the quote page polling every few
 * seconds, so it runs on Sonnet with fewer searches and a 2-minute ceiling
 * (typically 20–60s). Both ceilings stay under the 5-minute coverage-row
 * lease, DEMAND with enough headroom for the worker's one in-run retry.
 */
export type ResearchProfile = "DEEP" | "DEMAND";
export const RESEARCH_PROFILES: Record<
  ResearchProfile,
  { model: string; maxSearches: number; timeoutMs: number }
> = {
  DEEP: { model: PRICING_MODEL, maxSearches: 4, timeoutMs: 240_000 },
  DEMAND: { model: DEMAND_PRICING_MODEL, maxSearches: 3, timeoutMs: 120_000 },
};

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

/**
 * PLACEHOLDER, confirm with Jake before go-live (same status as the ZONE_C
 * amounts): the multiplier that turns a per-unit HOA plan rate into a
 * per-unit ONE-TIME common-area visit. The researched HOA sheet is
 * subscription-only — common-area work has no one-time card — so a single
 * visit is DERIVED, not researched. Rationale for the starting figure: a
 * quarterly-plan community pays the per-unit QUARTERLY monthly rate every
 * month for one visit a quarter, so a single visit is worth roughly three
 * months of it (×3), plus a premium because a one-off carries no plan
 * commitment (×~1.17). This is the ONLY knob — change it here.
 */
export const HOA_ONE_TIME_MULTIPLIER = 3.5;

/**
 * A one-time (single) HOA common-area visit, per unit, in cents. Always
 * derived from the per-unit QUARTERLY rate (the entry service level), so the
 * one-time price is independent of whichever plan cadence the customer was
 * considering. Multiply by the unit count for the community's total.
 */
export function hoaOneTimePerUnitCents(
  rates: HoaPerUnitRates,
  units: number
): number {
  return Math.round(rates[hoaBandFor(units)].QUARTERLY * HOA_ONE_TIME_MULTIPLIER);
}

/** The full researched sheet stored on one MarketRate row (ratesJson). */
export type RateSheet = {
  /** One-time treatment (WASP_NEST: the visit including the first nest).
   *  Absent on HOA sheets — common-area work has no one-time card. */
  oneTimeCents?: number;
  /** WASP_NEST: incremental price per additional nest on the same visit. */
  extraNestCents?: number;
  /** WILDLIFE: incremental price per additional animal removed on the same
   *  visit (the base oneTimeCents covers the visit plus the first animal). */
  extraAnimalCents?: number;
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
  /** True when an office-authored row is intentionally protected from AI. */
  pinned?: boolean;
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
  if (sheet.extraAnimalCents != null) {
    notes.push(
      "extra-animal price carries no variable-cost floor (no incremental cost model)"
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

// Which row serves for a rate key — ONE rule shared with the pricing worker
// AND the CRM Market Rates screen (pure module, value-importable by the CRM
// like serviceCatalog.ts). Re-exported so existing engine imports hold.
import {
  pickLiveRow,
  pickServingRow,
  type CatalogManifest,
} from "./rateServing";
export { pickLiveRow, pickServingRow };
export type { CatalogManifest };

// ------------------------------------------------------- rollback state

export type PricingRollback = {
  /** The immutable CatalogVersion whose complete manifest serves. */
  versionId: string;
  /** rateKey → serving MarketRate row id, from that version. */
  manifest: CatalogManifest;
  reason?: string | null;
  actor?: string | null;
  appliedAt?: string | null;
};

let rollbackMemo: { at: number; value: PricingRollback | null } | null = null;

/**
 * The live catalog-rollback state (PricingControl "catalog-rollback" →
 * CatalogVersion manifest), memoized briefly per container — every quote
 * read consults it. Null when no rollback is active, and null on a CONTROL
 * read fault (serving the newest sheet is the normal state; a rollback is
 * an explicit operator action whose screen confirms it took effect). If the
 * control row names a version whose MANIFEST cannot be read, the rollback
 * stays ACTIVE with an empty manifest — only pinned rows serve — because
 * quietly serving the exact sheet the owner rolled back is the one wrong
 * answer.
 */
export async function readPricingRollback(): Promise<PricingRollback | null> {
  // 5s, not 60s: the gate requires the quote funnel and CRM to read a
  // rollback (or its clearing) IMMEDIATELY — a minute of stale containers
  // serving the wrong sheet is a demonstrable mixed catalog.
  if (rollbackMemo && Date.now() - rollbackMemo.at < 5_000) {
    return rollbackMemo.value;
  }
  let value: PricingRollback | null = null;
  try {
    const client = await dataClient();
    if ("PricingControl" in client.models) {
      const { data } = await client.models.PricingControl.get({
        id: "catalog-rollback",
      });
      if (data?.rollbackVersionId) {
        let manifest: CatalogManifest = {};
        try {
          const models = client.models as unknown as {
            CatalogVersion?: {
              get: (a: { id: string }) => Promise<{
                data: { manifestJson?: string | null } | null;
              }>;
            };
          };
          const version = models.CatalogVersion
            ? (await models.CatalogVersion.get({ id: data.rollbackVersionId }))
                .data
            : null;
          const parsed = version?.manifestJson
            ? (JSON.parse(version.manifestJson) as CatalogManifest)
            : null;
          if (parsed && typeof parsed === "object") manifest = parsed;
          else {
            console.error(
              "readPricingRollback: version manifest unreadable — serving pinned rows only",
              data.rollbackVersionId
            );
          }
        } catch (err) {
          console.error(
            "readPricingRollback: version manifest unreadable — serving pinned rows only",
            data.rollbackVersionId,
            err
          );
        }
        value = {
          versionId: data.rollbackVersionId,
          manifest,
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

// ------------------------------------------------- catalog version snapshots

/**
 * Write an immutable CatalogVersion: the complete manifest of which row
 * serves each rate key RIGHT NOW (live rule — pinned wins, else freshest).
 * The worker calls this after every run that published rates, and once at
 * bootstrap when no version exists, so a rollback always has a complete
 * prior version to point at. Failure never blocks quoting or publication,
 * but it is never silent: it opens deduplicated owned work, because a day
 * without snapshots is a day the owner cannot roll back to.
 */
export async function writeCatalogSnapshot(
  trigger: "RUN" | "BOOTSTRAP",
  openWork?: (input: {
    kind: "INFRA_ALERT";
    dedupeKey: string;
    title: string;
    detail: string;
    relatedId: string;
    resolutionAction: string;
    ownerTeam: "OPS";
  }) => Promise<string | null>
): Promise<string | null> {
  try {
    const client = await dataClient();
    const models = client.models as unknown as {
      CatalogVersion?: {
        create: (input: Record<string, unknown>) => Promise<{
          data: { id: string } | null;
        }>;
      };
    };
    if (!models.CatalogVersion) return null;
    const rows: {
      id: string;
      rateKey: string;
      active: boolean;
      pinned?: boolean | null;
      researchedAt?: string | null;
    }[] = [];
    let token: string | null | undefined;
    do {
      const page = (await (
        client.models.MarketRate.list as (a: object) => Promise<{
          data: typeof rows;
          nextToken?: string | null;
        }>
      )({ limit: 500, nextToken: token })) as {
        data: typeof rows;
        nextToken?: string | null;
      };
      rows.push(...(page.data ?? []));
      token = page.nextToken;
    } while (token);
    const byKey = new Map<string, typeof rows>();
    for (const r of rows) {
      const list = byKey.get(r.rateKey) ?? [];
      list.push(r);
      byKey.set(r.rateKey, list);
    }
    const manifest: CatalogManifest = {};
    for (const [key, keyRows] of byKey) {
      const serving = pickLiveRow(keyRows);
      if (serving) manifest[key] = serving.id;
    }
    const id = `cv-${new Date().toISOString()}`;
    const { data } = await models.CatalogVersion.create({
      id,
      manifestJson: JSON.stringify(manifest),
      keyCount: Object.keys(manifest).length,
      trigger,
    });
    return data?.id ?? null;
  } catch (err) {
    console.error("writeCatalogSnapshot failed", err);
    await openWork?.({
      kind: "INFRA_ALERT",
      dedupeKey: `catalog-snapshot:${new Date().toISOString().slice(0, 10)}`,
      relatedId: "catalog-snapshot",
      title: "Catalog snapshot failed — rollback coverage is aging",
      detail:
        "The pricing worker could not write today's CatalogVersion snapshot. Until one succeeds, an OWNER rollback can only reach OLDER versions of the catalog.",
      resolutionAction:
        "Check the pricing-refresh logs for the snapshot error; a later run that snapshots successfully resolves this.",
      ownerTeam: "OPS",
    })?.catch(() => null);
    return null;
  }
}

/** Tests (and the rollback mutation itself) reset the memo so a state change
 *  is visible without waiting out the container cache. */
export function _resetRollbackMemoForTests(): void {
  rollbackMemo = null;
}

/**
 * The live path: return the freshest usable cached sheet, or null. NEVER
 * researches, never waits — an expired sheet still serves (age is historical
 * metadata only), a pinned sheet serves forever, and only a combo with
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
  // GL-16: an active rollback serves the named immutable version everywhere.
  const rollback = await readPricingRollback();
  const live = pickServingRow(existing, rateKey, rollback?.manifest ?? null);
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
      pinned: Boolean(live.pinned),
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
    pinned: Boolean(live.pinned),
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
 * Record that somebody needed an exact combo we have no sheet for.
 * Idempotent per combo: one RateCoverage
 * row keyed by the combo, upserted; a waiting lead's email is appended to
 * its notify list (deduped, capped at NOTIFY_CAP) so the recovery worker can send
 * "your exact prices are ready" when the sheet lands. A live-path miss is
 * DEMAND and jumps the research queue. The boolean return is the durable
 * enqueue acknowledgement: callers must not claim that research is queued
 * unless it is true.
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
  /** Human-readable origin for the durable demand audit. */
  requestedBy?: "PUBLIC_QUOTE" | "CRM_LEAD";
  /** Whether the exact sheet is absent or present but lacks a required part. */
  requestReason?: "MISSING_RATE_SHEET" | "INCOMPLETE_RATE_SHEET";
}): Promise<boolean> {
  try {
    const { service, city, state, sqft } = opts;
    const source = opts.source ?? "DEMAND";
    const areaKey = areaKeyFor(city, state);
    const band = sqft != null ? sqftBucket(sqft) : null;
    const id = rateKeyFor(service, areaKey, band);
    const requestedAt = new Date().toISOString();
    const requestReason = opts.requestReason ?? "MISSING_RATE_SHEET";
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
          ...(source === "DEMAND"
            ? {
                researchRequestedAt: requestedAt,
                researchRequestedBy: opts.requestedBy ?? "QUOTE_DEMAND",
                researchRequestReason: requestReason,
              }
            : {}),
          failCount: 0,
          active: true,
          notify: JSON.stringify(entry ? [entry] : []),
        });
      if (createdRow && !errors?.length) return true;
      // Lost a create race — re-read and merge into the winner's row.
      existing = (await client.models.RateCoverage.get({ id })).data;
      if (!existing) return false;
    }

    // GL-16: a retired coverage row is the office's decision and STAYS
    // retired. The caller receives false and must report an explicit error
    // instead of claiming that research was queued.
    if (!existing.active) return false;

    const patch: Record<string, unknown> = {};
    // A real customer miss promotes any legacy row to DEMAND. Never demote
    // a demand request the other way.
    if (source === "DEMAND") {
      patch.source = "DEMAND";
      patch.researchRequestedAt = requestedAt;
      patch.researchRequestedBy = opts.requestedBy ?? "QUOTE_DEMAND";
      patch.researchRequestReason = requestReason;
      // A genuinely new lead asking for this exact price is the retry. It
      // re-arms a previously exhausted combo once; UI status polling never
      // calls enqueue again, so polling cannot burn through the backoff.
      if (existing.exhaustedAt) {
        patch.exhaustedAt = null;
        patch.nextEligibleAt = null;
        patch.failCount = 0;
      }
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
      const { data, errors } = await client.models.RateCoverage.update({
        id,
        ...patch,
      });
      return Boolean(data) && !errors?.length;
    }
    return true;
  } catch (err) {
    console.error("enqueueRateResearch failed", opts.service, opts.city, err);
    return false;
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
  /** DEMAND = the fast live-quote pass; DEEP (default) = the review pass. */
  profile?: ResearchProfile;
}): Promise<RefreshResult | null> {
  const { anthropicKey, service, city, state, sqft } = opts;
  const profile = opts.profile ?? "DEEP";
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

  const researched = await research(
    anthropicKey,
    service,
    city,
    state,
    bucket,
    profile
  );
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
    model: RESEARCH_PROFILES[profile].model,
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
    ask: (city, state) =>
      `What do pest and wildlife companies near ${city}, ${state} charge for wildlife exclusion and removal (squirrels, raccoons, bats, birds, or similar — getting the animals out and sealing the entry points)? Price BOTH: (1) the complete visit including removal of the FIRST animal and the exclusion work; (2) the incremental price for EACH ADDITIONAL animal removed during the same visit. Give the realistic local going rate for the complete visit, not an inspection-only fee. ${LINE_INSTRUCTION}
FIRST_ANIMAL_USD: <number>
EXTRA_ANIMAL_USD: <number>`,
    lines: ["FIRST_ANIMAL_USD", "EXTRA_ANIMAL_USD"],
    assemble: (c) => ({
      oneTimeCents: c.FIRST_ANIMAL_USD,
      extraAnimalCents: c.EXTRA_ANIMAL_USD,
    }),
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
      DEMAND_PRICING_MODEL,
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
  bucket: number | null,
  profile: ResearchProfile = "DEEP"
): Promise<{
  sheet: RateSheet;
  basis: string;
  sources: string;
  rawText: string;
} | null> {
  const spec = RESEARCH_SPECS[service];
  const cfg = RESEARCH_PROFILES[profile];
  // Minutes, not 55s: a research message runs multiple web searches and the
  // 55s budget timed out EVERY deployed attempt (staging, 20 Jul) while
  // still consuming daily budget. Each profile's cap stays under the
  // 5-minute coverage-row lease so a stale-lease takeover can never overlap
  // a live research (DEMAND at 120s leaves room for the worker's one in-run
  // retry), and the run's own 13-minute budget bounds how many long calls
  // one drain attempts.
  const anthropic = new Anthropic({
    apiKey,
    timeout: cfg.timeoutMs,
    maxRetries: 0,
  });
  try {
    const researchMsg = await anthropic.messages.create({
      model: cfg.model,
      max_tokens: 3000,
      tools: [
        {
          type: "web_search_20260209",
          name: "web_search",
          max_uses: cfg.maxSearches,
        },
      ],
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
