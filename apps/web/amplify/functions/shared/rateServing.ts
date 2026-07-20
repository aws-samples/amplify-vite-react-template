/**
 * GL-16 — the ONE rule for which MarketRate row serves a rate key, shared as
 * a pure module so the engine (marketRate.ts), the pricing worker, and the
 * CRM Market Rates screen can never disagree about what is live — with or
 * without an active catalog rollback. No server imports here: the CRM
 * value-imports this file (like serviceCatalog.ts).
 *
 * The rule: a pinned row is the office's word and always wins; otherwise the
 * freshest research does. Expiry never disqualifies (serve-last-known-good).
 * With a rollback cutoff set, AI rows researched AFTER the cutoff are
 * excluded, so the whole catalog serves the prior coherent sheet in one
 * flip — pinned office rows still win, because an explicit office price is
 * never silently rolled back.
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
