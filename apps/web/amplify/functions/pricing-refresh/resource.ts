import { defineFunction } from "@aws-amplify/backend";

/**
 * The AI pricing-refresh cron — the ONLY place market-rate research runs.
 *
 * Every 5 minutes: drains due work under RESEARCH_PER_RUN /
 * RESEARCH_PER_DAY caps — DEMAND misses first (a lead waiting on a combo
 * with no sheet is priced within minutes and emailed), then sheets past
 * their weekly refresh, skipping pinned rows. So a cold miss self-heals in
 * minutes, not up to an hour. Seeding the RateCoverage work-list (curated
 * core towns, plus combos derived from existing rates, customer towns and
 * booking requests) and the weekly report both run only at the top of the
 * hour — background grid maintenance needs no 5-minute cadence, and the
 * report must fire once, not twelve times. On the Monday 10:00 UTC run it
 * emails the office the weekly report: price moves ranked by %,
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
  schedule: "*/5 * * * ? *", // every 5 minutes; seeds + reports at :00
});
