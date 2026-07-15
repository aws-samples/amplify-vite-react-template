import Anthropic from "@anthropic-ai/sdk";
import { dataClient } from "../shared/dataClient";

/**
 * AI-researched market rates for services without fixed rate cards
 * (rodent treatment by sqft, specialized roach treatment by sqft, wasp
 * additional nests). Consistency rule: identical inputs → identical
 * prices, so research runs at most once per (service, area, size bucket)
 * and the result is cached in the MarketRate model with a shelf life.
 * The office can edit or deactivate any cached rate from the CRM.
 */

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

/** Hard sanity clamps so a bad research result can never ship a wild price. */
const CLAMPS: Record<string, { min: number; max: number }> = {
  RODENT: { min: 19900, max: 250000 },
  ROACH: { min: 19900, max: 250000 },
  WASP_EXTRA_NEST: { min: 5000, max: 30000 },
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

export type MarketRateResult = {
  priceCents: number;
  basis: string;
  cached: boolean;
};

export async function marketRate(opts: {
  anthropicKey: string;
  service: "RODENT" | "ROACH" | "WASP_EXTRA_NEST";
  city: string;
  state: string;
  sqft?: number;
}): Promise<MarketRateResult | null> {
  const { anthropicKey, service, city, state, sqft } = opts;
  const areaKey = areaKeyFor(city, state);
  const bucket = sqft != null ? sqftBucket(sqft) : null;
  const rateKey = `${service}#${areaKey}${bucket ? `#${bucket}` : ""}`;

  const client = await dataClient();
  const { data: existing } = await client.models.MarketRate.listMarketRateByRateKey(
    { rateKey }
  );
  const live = existing.find(
    (r) =>
      r.active &&
      (!r.expiresAt || new Date(r.expiresAt).getTime() > Date.now())
  );
  if (live) {
    return { priceCents: live.priceCents, basis: live.basis ?? "", cached: true };
  }

  const researched = await research(anthropicKey, service, city, state, bucket);
  if (!researched) return null;

  const clamp = CLAMPS[service];
  const priceCents = tidy(
    Math.min(clamp.max, Math.max(clamp.min, researched.priceCents))
  );

  await client.models.MarketRate.create({
    rateKey,
    service,
    areaKey,
    priceCents,
    basis: researched.basis.slice(0, 800),
    sources: researched.sources.slice(0, 1000),
    researchedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + NINETY_DAYS_MS).toISOString(),
    active: true,
  });
  return { priceCents, basis: researched.basis, cached: false };
}

const SERVICE_DESCRIPTIONS: Record<string, (bucket: number | null) => string> = {
  RODENT: (b) =>
    `full interior+exterior rodent (mice/rats) treatment with trapping and exclusion check for a ~${b ?? 2000} sqft single-family home`,
  ROACH: (b) =>
    `specialized German cockroach treatment (gel bait + IGR, follow-up included) for a ~${b ?? 2000} sqft single-family home`,
  WASP_EXTRA_NEST: () =>
    `removing ONE ADDITIONAL wasp/hornet nest during the same visit (the first nest is already billed separately) — the incremental per-extra-nest price`,
};

async function research(
  apiKey: string,
  service: string,
  city: string,
  state: string,
  bucket: number | null
): Promise<{ priceCents: number; basis: string; sources: string } | null> {
  const anthropic = new Anthropic({ apiKey, timeout: 55_000, maxRetries: 0 });
  try {
    // Pass 1: web research with the search tool.
    const researchMsg = await anthropic.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 2000,
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 4 }],
      messages: [
        {
          role: "user",
          content: `What do pest-control companies near ${city}, ${state} charge for: ${SERVICE_DESCRIPTIONS[service](bucket)}? Research current local/regional pricing (2025-2026). End with one line exactly like: TYPICAL_PRICE_USD: <number> — a single competitive price a quality local operator would quote, not a range.`,
        },
      ],
    });
    const text = researchMsg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    const match = text.match(/TYPICAL_PRICE_USD:\s*\$?([\d,]+(?:\.\d{1,2})?)/i);
    if (!match) return null;
    const dollars = parseFloat(match[1].replace(/,/g, ""));
    if (!Number.isFinite(dollars) || dollars <= 0) return null;
    const basisLine =
      text
        .split("\n")
        .filter((l) => l.trim() && !l.includes("TYPICAL_PRICE_USD"))
        .slice(-3)
        .join(" ")
        .slice(0, 800) || "AI market research";
    return {
      priceCents: Math.round(dollars * 100),
      basis: basisLine,
      sources: text.slice(0, 1000),
    };
  } catch {
    return null;
  }
}
