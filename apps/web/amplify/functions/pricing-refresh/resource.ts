import { defineFunction } from "@aws-amplify/backend";

/**
 * The AI pricing-refresh cron — the ONLY place market-rate research runs.
 *
 * GL-16: every invocation first takes the SINGLE drain lease (PricingControl
 * "pricing-drain"), so however the 5-minute cadence, long runs, and quote
 * wake-ups overlap, exactly one invocation researches at a time; and every
 * provider request reserves ATOMIC daily budget on the day row before the
 * call, so failures and timeouts consume it too and the shared caps cannot
 * be exceeded by any interleaving.
 *
 * Every 5 minutes: recovers durable work created only by a real website/CRM
 * quote miss or an explicit staff market-review request. It never scans
 * towns, customers, bookings, catalog gaps, or rate age to create research.
 * Quote misses are also woken immediately; the schedule is their recovery
 * path if that async invocation fails. Pinned, exhausted, backing-off, and
 * currently leased rows are skipped. The 21:00 UTC hour sends ONE
 * consolidated daily digest (spend, results, queue state) — never one
 * email per cached rate. On the Monday 10:00 UTC run it
 * emails the office the weekly report: price moves ranked by %,
 * floors that bound, failed requested combos, and the week's research
 * counts. Visibility, not a gate — nothing holds for
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
  schedule: "*/5 * * * ? *", // recovery drain; reports are time-gated
});
