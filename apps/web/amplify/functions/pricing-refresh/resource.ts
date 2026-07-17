import { defineFunction } from "@aws-amplify/backend";

/**
 * The AI pricing-refresh cron — the ONLY place market-rate research runs.
 *
 * Hourly: seeds the RateCoverage work-list idempotently (curated core
 * towns, plus combos derived from existing rates, customer towns and
 * booking requests), then drains due work under RESEARCH_PER_RUN /
 * RESEARCH_PER_DAY caps — DEMAND misses first (a lead waiting on a combo
 * with no sheet is priced within the hour and emailed), then sheets past
 * their weekly refresh, skipping pinned rows. On the Monday 10:00 UTC run
 * it also emails the office the weekly report: price moves ranked by %,
 * floors that bound, failing combos, stale rows, coverage gaps, and the
 * week's research counts. Visibility, not a gate — nothing holds for
 * approval.
 *
 * ANTHROPIC_API_KEY is read from the env (baked at build) with an SSM
 * fallback, same as crm-pricing/booking-public (see backend.ts).
 *
 * 15-minute timeout: a run may hold the line through up to
 * RESEARCH_PER_RUN researches at 10–60s each; the handler also carries its
 * own time budget so it stops starting new research before the deadline.
 */
export const pricingRefresh = defineFunction({
  name: "pricing-refresh",
  entry: "./handler.ts",
  timeoutSeconds: 900,
  memoryMB: 512,
  schedule: "0 * * * ? *", // hourly, on the hour
});
