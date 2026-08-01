import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import type { Schema } from "../../data/resource";
import { listAllPages } from "../../../src/lib/pagination";

/**
 * Daily renewal-marketing sweep. See resource.ts for the why.
 *
 * Two passes, both idempotent so a re-run (or a retry) is harmless:
 *   1. RAISE    — one task per (expiring risk × appetite-matched carrier)
 *                 once today >= expiration − leadTime − 14.
 *   2. SETTLE   — close open tasks that a quote has since satisfied.
 */

const HEAD_START_DAYS = 14;
const DEFAULT_LEAD_TIME_DAYS = 30;

let dataClient: ReturnType<typeof generateClient<Schema>> | undefined;
async function getDataClient() {
  if (!dataClient) {
    const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(
      process.env as never
    );
    Amplify.configure(resourceConfig, libraryOptions);
    dataClient = generateClient<Schema>();
  }
  return dataClient;
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (day: string, n: number) => {
  const d = new Date(day + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return isoDay(d);
};

/** Ranges entered backwards would silently match nothing. */
const order = (a: number | null | undefined, b: number | null | undefined) =>
  a != null && b != null && a > b ? [b, a] : [a, b];

interface Risk {
  sourceType: "POLICY" | "LEAD";
  sourceId: string;
  accountId: string;
  accountName: string;
  expirationDate: string;
  lines: string[];
  policyId?: string;
}

export const handler = async () => {
  const client = await getDataClient();
  const today = isoDay(new Date());

  const [accounts, policies, carriers, guides, quotes, tasks] = await Promise.all([
    // `.list()` caps at 100 — every read here must cover the whole table.
    listAllPages((nextToken) => client.models.Account.list({ nextToken, limit: 200 })),
    listAllPages((nextToken) => client.models.Policy.list({ nextToken, limit: 200 })),
    listAllPages((nextToken) => client.models.Carrier.list({ nextToken, limit: 200 })),
    listAllPages((nextToken) =>
      client.models.AppetiteGuide.list({ nextToken, limit: 200 })
    ),
    listAllPages((nextToken) => client.models.Quote.list({ nextToken, limit: 200 })),
    listAllPages((nextToken) =>
      client.models.MarketingTask.list({ nextToken, limit: 200 })
    ),
  ]);

  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const appointed = carriers.filter((c) => c.appointed);

  // ── Build the list of expiring risks ────────────────────────────────
  const risks: Risk[] = [];

  // Clients renew off their bound policies. `currentPolicyExpiration` is a
  // lead-only field and is deliberately ignored once an account converts.
  for (const p of policies) {
    if (p.status !== "ACTIVE" || !p.expirationDate) continue;
    const acct = accountById.get(p.accountId);
    if (!acct || acct.stage !== "CLIENT") continue;
    risks.push({
      sourceType: "POLICY",
      sourceId: p.id,
      accountId: acct.id,
      accountName: acct.name,
      expirationDate: p.expirationDate,
      lines: (p.lines ?? []).filter((l): l is string => !!l),
      policyId: p.id,
    });
  }

  for (const a of accounts) {
    // Prospects have no bound policy, so their incumbent's expiration is the
    // only renewal date available.
    if (a.stage !== "LEAD" || !a.currentPolicyExpiration) continue;
    risks.push({
      sourceType: "LEAD",
      sourceId: a.id,
      accountId: a.id,
      accountName: a.name,
      expirationDate: a.currentPolicyExpiration,
      lines: [],
    });
  }

  /** Lead time: guide matching this risk → carrier's longest → default. */
  function leadTimeFor(carrierId: string, matchedGuideDays: number | null): number {
    if (matchedGuideDays != null) return matchedGuideDays;
    const days = guides
      .filter((g) => g.carrierId === carrierId && g.quoteSubmissionLeadTimeDays != null)
      .map((g) => g.quoteSubmissionLeadTimeDays as number);
    return days.length ? Math.max(...days) : DEFAULT_LEAD_TIME_DAYS;
  }

  /** Mirrors the Appetite Finder: state, TIV, construction year, lines. */
  function guideFits(
    guide: (typeof guides)[number],
    carrier: (typeof carriers)[number],
    risk: Risk
  ): boolean {
    const acct = accountById.get(risk.accountId);
    if (!acct) return false;

    const states = (guide.states?.filter(Boolean).length ? guide.states : carrier.states) ?? [];
    if (acct.state && states.filter(Boolean).length > 0 && !states.includes(acct.state))
      return false;

    const [loV, hiV] = order(guide.minValue, guide.maxValue);
    if (acct.totalInsuredValue != null) {
      if (loV != null && acct.totalInsuredValue < loV) return false;
      if (hiV != null && acct.totalInsuredValue > hiV) return false;
    }

    const [loY, hiY] = order(guide.minConstructionYear, guide.maxConstructionYear);
    if (acct.yearBuilt != null) {
      if (loY != null && acct.yearBuilt < loY) return false;
      if (hiY != null && acct.yearBuilt > hiY) return false;
    }

    // Lead-sourced risks have no lines yet — don't exclude on them.
    const written = (guide.linesWritten ?? []).filter(Boolean);
    if (risk.lines.length && written.length) {
      if (!risk.lines.some((l) => written.includes(l))) return false;
    }
    return true;
  }

  const existingKeys = new Set(tasks.map((t) => t.dedupeKey));
  /** A quote counts as "already marketed" from the trigger date onward. */
  const quotedSince = (accountId: string, carrierId: string, since: string) =>
    quotes.some(
      (q) =>
        q.accountId === accountId &&
        q.carrierId === carrierId &&
        (q.createdAt ?? "").slice(0, 10) >= since
    );

  // ── Pass 1: raise tasks ─────────────────────────────────────────────
  let created = 0;
  let skippedAlreadyQuoted = 0;

  for (const risk of risks) {
    // Once the term has lapsed there is nothing left to market.
    if (risk.expirationDate < today) continue;

    for (const carrier of appointed) {
      const carrierGuides = guides.filter((g) => g.carrierId === carrier.id);
      const matching = carrierGuides.filter((g) => guideFits(g, carrier, risk));
      // Appetite-matched only: a carrier with no matching guide is skipped.
      if (matching.length === 0) continue;

      const matchedDays = matching
        .map((g) => g.quoteSubmissionLeadTimeDays)
        .filter((d): d is number => d != null);
      const leadTime = leadTimeFor(
        carrier.id,
        matchedDays.length ? Math.max(...matchedDays) : null
      );

      const submitBy = addDays(risk.expirationDate, -leadTime);
      const triggerDate = addDays(submitBy, -HEAD_START_DAYS);
      if (today < triggerDate) continue; // window not open yet

      const dedupeKey = `${risk.sourceType}:${risk.sourceId}:${carrier.id}:${risk.expirationDate}`;
      if (existingKeys.has(dedupeKey)) continue;

      if (quotedSince(risk.accountId, carrier.id, triggerDate)) {
        skippedAlreadyQuoted++;
        existingKeys.add(dedupeKey);
        continue;
      }

      const { errors } = await client.models.MarketingTask.create({
        accountId: risk.accountId,
        carrierId: carrier.id,
        policyId: risk.policyId,
        sourceType: risk.sourceType,
        dedupeKey,
        accountName: risk.accountName,
        carrierName: carrier.name,
        lines: risk.lines,
        expirationDate: risk.expirationDate,
        leadTimeDays: leadTime,
        submitBy,
        triggerDate,
        status: "OPEN",
      });
      if (!errors?.length) {
        created++;
        existingKeys.add(dedupeKey);
      } else {
        console.error("MarketingTask create failed", dedupeKey, errors[0].message);
      }
    }
  }

  // ── Pass 2: settle tasks a quote has satisfied ──────────────────────
  let completed = 0;
  for (const t of tasks) {
    if (t.status !== "OPEN") continue;
    const since = t.triggerDate ?? t.createdAt?.slice(0, 10) ?? today;
    if (!quotedSince(t.accountId, t.carrierId, since)) continue;
    const { errors } = await client.models.MarketingTask.update({
      id: t.id,
      status: "COMPLETE",
      resolution: "QUOTED",
      completedAt: new Date().toISOString(),
      completedBy: "system (quote created)",
    });
    if (!errors?.length) completed++;
  }

  const summary = {
    risksReviewed: risks.length,
    appointedCarriers: appointed.length,
    tasksCreated: created,
    tasksAutoCompleted: completed,
    skippedAlreadyQuoted,
  };
  console.log("renewal-tasks sweep", JSON.stringify(summary));
  return summary;
};
