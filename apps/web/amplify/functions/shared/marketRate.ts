import Anthropic from "@anthropic-ai/sdk";
import { dataClient } from "./dataClient";
import { notifyOffice } from "./email";
import { money, oneTimeGrossProfitCents } from "../crm-pricing/rateCards";

/**
 * AI-researched market rates — the base-price engine for every service.
 *
 * One research call per (service, area, size band) returns a full rate
 * sheet — one-time price, recurring-plan cadences with monthly + initial
 * fees, the wasp extra-nest increment — cached on ONE MarketRate row with a
 * shelf life. Consistency rule: identical inputs → identical prices, so
 * research runs at most once per rate key and the office can edit or retire
 * any cached rate from the CRM (an office-edited row wins until it expires
 * or is retired; `priceCents` is the office-editable field, so it always
 * overrides the sheet's stored one-time price).
 *
 * Exactly two guardrails — deliberately no min/max clamps and no review
 * queue, and deliberately no upper bound:
 *
 *   1. Variable-cost floor. A researched one-time price never ships below
 *      the deterministic Zone-A variable cost from crm-pricing/rateCards
 *      (Zone A is the cheapest case, so it is the zone-independent lower
 *      bound; the day-pricing overlay re-floors at the caller's actual zone
 *      per R62). Components with no deterministic cost model — the plan
 *      cadences (rateCards' Step-5 cost constants cover one-time/specialty
 *      visits only) and the wasp extra-nest increment — carry NO floor;
 *      that fact is recorded on the rate row's basis rather than inventing
 *      economics.
 *
 *   2. Callback fallback. No research result — daily budget spent, key
 *      missing, junk or partial response, expired cache whose re-research
 *      fails — NEVER yields a made-up price: the engine returns null and
 *      the caller falls to its CONTACT path. An expired row is never
 *      served; it re-researches or refuses.
 *
 * When a NEW sheet is researched and cached (not on cache hits) the office
 * gets a short heads-up email pointing at the Market Rates screen. That is
 * visibility, not a gate — the quote proceeds immediately.
 */

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

/** Global ceiling on brand-new (uncached) AI research runs per day. */
export const NEW_RESEARCH_PER_DAY = 25;

export type MarketRateService =
  | "GENERAL_PEST"
  | "WASP_NEST"
  | "RODENT"
  | "ROACH";

export type PlanCadence = "MONTHLY" | "BIMONTHLY" | "QUARTERLY";
export const PLAN_CADENCES: PlanCadence[] = [
  "MONTHLY",
  "BIMONTHLY",
  "QUARTERLY",
];

export type PlanRate = { monthlyCents: number; initialFeeCents: number };

/** The full researched sheet stored on one MarketRate row (ratesJson). */
export type RateSheet = {
  /** One-time treatment (WASP_NEST: the visit including the first nest). */
  oneTimeCents: number;
  /** WASP_NEST: incremental price per additional nest on the same visit. */
  extraNestCents?: number;
  /** GENERAL_PEST: recurring plans, each billed as a flat monthly price. */
  plans?: Record<PlanCadence, PlanRate>;
};

export type MarketRateResult = {
  /** The one-time price — mirrors sheet.oneTimeCents (continuity field). */
  priceCents: number;
  sheet: RateSheet;
  basis: string;
  cached: boolean;
};

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
 * mapping the day-pricing overlay uses for R62).
 */
const COST_KIND: Record<MarketRateService, string> = {
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
  const floor = variableCostCents(COST_KIND[service]);
  let oneTimeCents = sheet.oneTimeCents;
  if (oneTimeCents < floor) {
    oneTimeCents = floor;
    notes.push(`one-time floored at Zone-A variable cost ${money(floor)}`);
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
  return { sheet: { ...sheet, oneTimeCents }, floorNotes: notes };
}

// -------------------------------------------------------------- the engine

/** Global ceiling on brand-new (uncached) AI research runs per day. */
async function researchBudgetLeft(): Promise<boolean> {
  const client = await dataClient();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data } = await client.models.MarketRate.list({
    filter: { researchedAt: { gt: since } },
    limit: NEW_RESEARCH_PER_DAY + 1,
  });
  return data.length < NEW_RESEARCH_PER_DAY;
}

function parseSheet(raw: unknown): RateSheet | null {
  if (raw == null) return null;
  try {
    const value = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (
      typeof value === "object" &&
      value !== null &&
      typeof (value as RateSheet).oneTimeCents === "number"
    ) {
      return value as RateSheet;
    }
  } catch {
    /* corrupt ratesJson — treat as sheet-less row */
  }
  return null;
}

export async function marketRate(opts: {
  anthropicKey: string | null;
  service: MarketRateService;
  city: string;
  state: string;
  sqft?: number;
}): Promise<MarketRateResult | null> {
  const { anthropicKey, service, city, state, sqft } = opts;
  const areaKey = areaKeyFor(city, state);
  const bucket = sqft != null ? sqftBucket(sqft) : null;
  const rateKey = `${service}#${areaKey}${bucket ? `#${bucket}` : ""}`;

  const client = await dataClient();
  const { data: existing } =
    await client.models.MarketRate.listMarketRateByRateKey({ rateKey });
  const live = existing.find(
    (r) =>
      r.active &&
      (!r.expiresAt || new Date(r.expiresAt).getTime() > Date.now())
  );
  if (live) {
    // priceCents is what the office edits, so it wins over the sheet's
    // stored one-time price — that is the override contract.
    const stored = parseSheet(live.ratesJson);
    const sheet: RateSheet = {
      ...(stored ?? {}),
      oneTimeCents: live.priceCents,
    };
    return {
      priceCents: live.priceCents,
      sheet,
      basis: live.basis ?? "",
      cached: true,
    };
  }

  // Cache miss, expired, or retired: research or refuse — never serve a
  // stale price, never invent one.
  if (!anthropicKey) return null;
  if (!(await researchBudgetLeft())) return null;

  const researched = await research(anthropicKey, service, city, state, bucket);
  if (!researched) return null;

  const { sheet, floorNotes } = applyFloor(service, researched.sheet);
  const basis = [researched.basis, ...floorNotes].join(" · ").slice(0, 800);

  await client.models.MarketRate.create({
    rateKey,
    service,
    areaKey,
    priceCents: sheet.oneTimeCents,
    ratesJson: JSON.stringify(sheet),
    basis,
    sources: researched.sources.slice(0, 1000),
    researchedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + NINETY_DAYS_MS).toISOString(),
    active: true,
  });

  // Visibility, not a gate: the office hears about every new sheet and can
  // override it, but the quote proceeds immediately.
  await notifyNewRate({ service, areaKey, bucket, sheet, floorNotes });

  return { priceCents: sheet.oneTimeCents, sheet, basis, cached: false };
}

// ---------------------------------------------------------------- research

type ResearchSpec = {
  ask: (city: string, state: string, bucket: number | null) => string;
  /** Every label must parse from the response, or the whole result is junk. */
  lines: string[];
  assemble: (cents: Record<string, number>) => RateSheet;
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

async function research(
  apiKey: string,
  service: MarketRateService,
  city: string,
  state: string,
  bucket: number | null
): Promise<{ sheet: RateSheet; basis: string; sources: string } | null> {
  const spec = RESEARCH_SPECS[service];
  const anthropic = new Anthropic({ apiKey, timeout: 55_000, maxRetries: 0 });
  try {
    const researchMsg = await anthropic.messages.create({
      model: "claude-opus-4-8",
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
      cents[label] = tidy(parsed);
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
    };
  } catch {
    return null;
  }
}

// -------------------------------------------------------------- visibility

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function notifyNewRate(opts: {
  service: MarketRateService;
  areaKey: string;
  bucket: number | null;
  sheet: RateSheet;
  floorNotes: string[];
}): Promise<void> {
  const { service, areaKey, bucket, sheet, floorNotes } = opts;
  const rows: string[] = [`One-time: <strong>${money(sheet.oneTimeCents)}</strong>`];
  if (sheet.extraNestCents != null) {
    rows.push(`Each extra nest: <strong>${money(sheet.extraNestCents)}</strong>`);
  }
  if (sheet.plans) {
    for (const cadence of PLAN_CADENCES) {
      const plan = sheet.plans[cadence];
      rows.push(
        `${cadence.toLowerCase()} plan: <strong>${money(plan.monthlyCents)}/mo</strong> + ${money(plan.initialFeeCents)} initial`
      );
    }
  }
  const scope = `${service} · ${areaKey}${bucket ? ` · up to ${bucket.toLocaleString()} sqft` : ""}`;
  const crmUrl = process.env.CRM_APP_URL ?? "";
  await notifyOffice({
    subject: `New AI rate cached — ${scope}`,
    heading: "New AI market rate cached",
    template: "ops-market-rate-cached",
    bodyHtml: `<p>The pricing engine researched and cached a new market rate for <strong>${escapeHtml(scope)}</strong>. It is already quoting from this sheet — nothing is blocked on you.</p>
     <ul>${rows.map((r) => `<li>${r}</li>`).join("")}</ul>
     ${floorNotes.length ? `<p style="color:#666;font-size:13px;">${floorNotes.map(escapeHtml).join("<br/>")}</p>` : ""}
     <p><a href="${crmUrl}/market-rates">Open Market Rates</a> to review or override it.</p>`,
  });
}
