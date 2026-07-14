#!/usr/bin/env npx tsx
/**
 * Sync Buildium associations + FieldRoutes frequencies → src/data/properties.json
 *
 * 1. Pulls all active associations from the Buildium API (name, address)
 * 2. For each, searches FieldRoutes for a matching customer by companyName
 * 3. If found, pulls the active subscription to get the service frequency
 * 4. Writes combined data to properties.json for the resident signup page
 *
 * Usage:
 *   npx tsx scripts/sync-buildium.ts
 *
 * Environment variables (or defaults below):
 *   BUILDIUM_BASE_URL, BUILDIUM_CLIENT_ID, BUILDIUM_CLIENT_SECRET
 *   FIELDROUTES_SUBDOMAIN, FIELDROUTES_KEY, FIELDROUTES_TOKEN
 */

// ── Config ───────────────────────────────────────────────────────────
const BUILDIUM_BASE_URL =
  process.env.BUILDIUM_BASE_URL || "https://api.buildium.com";
const BUILDIUM_CLIENT_ID =
  process.env.BUILDIUM_CLIENT_ID || "a32ffd58-8115-429e-a623-9a938b94a058";
const BUILDIUM_CLIENT_SECRET =
  process.env.BUILDIUM_CLIENT_SECRET ||
  "Ssh1fB+e1EYz8gLP/kIKKjHRedMkuf+KuCen6kZz2ZU=";

const FR_SUBDOMAIN = process.env.FIELDROUTES_SUBDOMAIN || "buzzkill";
const FR_KEY = process.env.FIELDROUTES_KEY || "";
const FR_TOKEN = process.env.FIELDROUTES_TOKEN || "";

import { writeFileSync, readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Types ────────────────────────────────────────────────────────────
type BuildiumAssociation = {
  Id: number;
  Name: string;
  IsActive: boolean;
  Address?: {
    AddressLine1?: string;
    AddressLine2?: string;
    City?: string;
    State?: string;
    PostalCode?: string;
  };
};

type PropertyEntry = {
  id: number;
  name: string;
  slug: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  frequency: string;
  frCustomerID?: number;
  frSubscriptionID?: number;
};

// ── Helpers ──────────────────────────────────────────────────────────
function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .trim();
}

function freqDaysToLabel(days: number): string {
  if (days === 30) return "Monthly";
  if (days === 60) return "Every 2 Months";
  if (days === 90) return "Every 3 Months";
  if (days > 0 && days <= 45) return "Monthly";
  if (days > 45 && days <= 75) return "Every 2 Months";
  if (days > 75) return "Every 3 Months";
  return "Monthly";
}

/** Rate-limited delay to stay within FieldRoutes API limits */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Buildium API ─────────────────────────────────────────────────────
async function fetchAssociations(): Promise<BuildiumAssociation[]> {
  const all: BuildiumAssociation[] = [];
  let offset = 0;
  const limit = 200;

  while (true) {
    const url = `${BUILDIUM_BASE_URL}/v1/associations?status=Active&limit=${limit}&offset=${offset}`;
    console.log(`[Buildium] ${url}`);

    const resp = await fetch(url, {
      headers: {
        "x-buildium-client-id": BUILDIUM_CLIENT_ID,
        "x-buildium-client-secret": BUILDIUM_CLIENT_SECRET,
        Accept: "application/json",
      },
    });

    if (!resp.ok) {
      throw new Error(
        `Buildium API error: ${resp.status} ${resp.statusText}`,
      );
    }

    const data = (await resp.json()) as BuildiumAssociation[];
    all.push(...data);

    if (data.length < limit) break;
    offset += limit;
  }

  return all;
}

// ── FieldRoutes API ──────────────────────────────────────────────────
async function frPost(
  endpoint: string,
  params: Record<string, string | number>,
): Promise<Record<string, unknown>> {
  const url = `https://${FR_SUBDOMAIN}.pestroutes.com/api/${endpoint}`;
  const body = new URLSearchParams({
    authenticationKey: FR_KEY,
    authenticationToken: FR_TOKEN,
    ...Object.fromEntries(
      Object.entries(params).map(([k, v]) => [k, String(v)]),
    ),
  });

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });

  return (await resp.json()) as Record<string, unknown>;
}

type FRSubscription = {
  subscriptionID: number;
  frequency: number;
  serviceID: number;
  active: number;
  activeText: string;
};

/**
 * Look up a property in FieldRoutes by company name.
 * Returns the frequency of the first active HOA subscription found.
 */
async function lookupFrequency(
  companyName: string,
): Promise<{
  frequency: string;
  customerID?: number;
  subscriptionID?: number;
} | null> {
  if (!FR_KEY || !FR_TOKEN) return null;

  // Step 1: Search customer by companyName
  const custResult = await frPost("customer/search", {
    companyName,
    includeData: 1,
  });

  const customerIDs = custResult.customerIDs as number[] | undefined;
  if (!customerIDs || customerIDs.length === 0) return null;

  // Step 2: Search subscriptions for the first matched customer
  // Look for active subscriptions (active=1) or leads (active=-3)
  const subResult = await frPost("subscription/search", {
    customerIDs: customerIDs[0],
    includeData: 1,
  });

  const subs = (subResult.subscriptions ?? []) as FRSubscription[];
  if (subs.length === 0) return null;

  // Prefer active subscriptions over leads
  const activeSub =
    subs.find((s) => s.active === 1) ?? subs.find((s) => s.active === -3);
  if (!activeSub) return null;

  return {
    frequency: freqDaysToLabel(activeSub.frequency),
    customerID: customerIDs[0],
    subscriptionID: activeSub.subscriptionID,
  };
}

// ── Main ─────────────────────────────────────────────────────────────
async function main() {
  console.log("=== BuzzKill Property Sync ===\n");

  // Load existing data for frequency overrides/fallbacks
  const outPath = resolve(__dirname, "../src/data/properties.json");
  let existing: Record<string, PropertyEntry> = {};
  if (existsSync(outPath)) {
    try {
      const raw = JSON.parse(readFileSync(outPath, "utf-8")) as PropertyEntry[];
      for (const p of raw) {
        existing[p.slug] = p;
      }
    } catch {
      // ignore parse errors
    }
  }

  // Step 1: Buildium
  console.log("── Pulling from Buildium ──");
  const associations = await fetchAssociations();
  console.log(`Found ${associations.length} active associations\n`);

  const properties: PropertyEntry[] = associations
    .filter((a) => a.IsActive && a.Name)
    .map((a) => ({
      id: a.Id,
      name: a.Name,
      slug: toSlug(a.Name),
      address: [a.Address?.AddressLine1, a.Address?.AddressLine2]
        .filter(Boolean)
        .join(", "),
      city: a.Address?.City ?? "",
      state: a.Address?.State ?? "",
      zip: a.Address?.PostalCode ?? "",
      frequency: "Monthly", // default, will be overridden by FieldRoutes
    }));

  // Dedupe slugs
  const slugCounts: Record<string, number> = {};
  for (const p of properties) {
    slugCounts[p.slug] = (slugCounts[p.slug] ?? 0) + 1;
  }
  for (const p of properties) {
    if (slugCounts[p.slug] > 1) {
      p.slug = `${p.slug}-${p.id}`;
    }
  }

  // Step 2: Enrich with FieldRoutes frequency
  if (FR_KEY && FR_TOKEN) {
    console.log("── Enriching with FieldRoutes frequencies ──");
    let matched = 0;
    let unmatched = 0;

    for (const p of properties) {
      try {
        const result = await lookupFrequency(p.name);
        if (result) {
          p.frequency = result.frequency;
          p.frCustomerID = result.customerID;
          p.frSubscriptionID = result.subscriptionID;
          matched++;
          console.log(
            `  ✓ ${p.name} → ${result.frequency} (customer ${result.customerID})`,
          );
        } else {
          // Fall back to existing data if available
          const prev = existing[p.slug];
          if (prev?.frequency) {
            p.frequency = prev.frequency;
            console.log(
              `  ~ ${p.name} → ${prev.frequency} (from previous sync)`,
            );
          } else {
            unmatched++;
            console.log(`  ✗ ${p.name} → Monthly (default, no FR match)`);
          }
        }
        // Rate limit: FieldRoutes allows 20 read requests/minute
        // Each property = 2 reads (customer/search + subscription/search)
        // Pace at ~5 properties per minute = 10 reads/minute (safe margin)
        await sleep(12000 / properties.length); // Spread evenly
      } catch (err) {
        const prev = existing[p.slug];
        if (prev?.frequency) {
          p.frequency = prev.frequency;
        }
        console.error(`  ! ${p.name} → error: ${(err as Error).message}`);
      }
    }

    console.log(
      `\nFieldRoutes: ${matched} matched, ${unmatched} unmatched (defaulted)\n`,
    );
  } else {
    console.log(
      "── Skipping FieldRoutes (no credentials) — using defaults ──\n",
    );
    // Carry forward existing frequencies
    for (const p of properties) {
      const prev = existing[p.slug];
      if (prev?.frequency) {
        p.frequency = prev.frequency;
      }
    }
  }

  // Write output
  writeFileSync(outPath, JSON.stringify(properties, null, 2) + "\n");

  console.log(`Wrote ${properties.length} properties to ${outPath}`);
  console.log("\nSample entries:");
  properties.slice(0, 10).forEach((p) => {
    console.log(
      `  ${p.slug} → ${p.name} (${p.city}, ${p.state}) [${p.frequency}]`,
    );
  });
}

main().catch((err) => {
  console.error("Sync failed:", err);
  process.exit(1);
});
