/**
 * GL-16 — the ONE rule for which MarketRate row serves a rate key, shared as
 * a pure module so the engine (marketRate.ts), the pricing worker, and the
 * CRM Market Rates screen can never disagree about what is live — with or
 * without an active catalog rollback. No server imports here: the CRM
 * value-imports this file (like serviceCatalog.ts).
 *
 * LIVE mode: a pinned row is the office's word and always wins; otherwise
 * the freshest research does. Expiry never disqualifies
 * (serve-last-known-good).
 *
 * ROLLBACK mode: the catalog serves an IMMUTABLE CatalogVersion — a
 * manifest naming the exact row id per rate key at the snapshot moment —
 * never a timestamp filter over mutable rows. Pinned office rows still win
 * (an explicit office price is never silently rolled back), and a row the
 * office RETIRED after the snapshot stays retired (an explicit office
 * retire is never silently un-done). A key the manifest doesn't name
 * serves nothing: it did not exist in that version.
 */
export function pickLiveRow<
  T extends {
    active: boolean;
    pinned?: boolean | null;
    researchedAt?: string | null;
  },
>(rows: T[]): T | null {
  const live = rows.filter((r) => r.active);
  return (
    live.find((r) => r.pinned) ??
    live.reduce<T | null>(
      (best, r) =>
        !best || (r.researchedAt ?? "") > (best.researchedAt ?? "") ? r : best,
      null
    )
  );
}

/** rateKey → serving MarketRate row id, as stored on a CatalogVersion. */
export type CatalogManifest = Record<string, string>;

/** The serving row under an optional rollback manifest. `manifest` null =
 *  LIVE mode. In rollback mode the manifest's named row serves (if still
 *  active); pinned rows win in both modes. */
export function pickServingRow<
  T extends {
    id: string;
    active: boolean;
    pinned?: boolean | null;
    researchedAt?: string | null;
  },
>(rows: T[], rateKey: string, manifest: CatalogManifest | null): T | null {
  if (!manifest) return pickLiveRow(rows);
  const live = rows.filter((r) => r.active);
  const pinned = live.find((r) => r.pinned);
  if (pinned) return pinned;
  const namedId = manifest[rateKey];
  if (!namedId) return null;
  return live.find((r) => r.id === namedId) ?? null;
}
