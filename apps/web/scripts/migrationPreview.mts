/**
 * FieldRoutes migration — dry-run preview (accuracy gate #1).
 *
 * Reads a FieldRoutes "Customer Report" CSV, runs the same adapter the real
 * import uses (shared/fieldRoutesImport), and renders a review report: dollar
 * reconciliation against the source, rows that need a human decision before
 * import, and the full plan / one-time / skipped breakdown. WRITES NOTHING to
 * the CRM — it only produces an HTML file to eyeball and sign off on.
 *
 *   npx tsx scripts/migrationPreview.mts "<path to CSV>" [out.html]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parse } from "csv-parse/sync";
import {
  adaptFieldRoutesRows,
  type FieldRoutesRow,
} from "../amplify/functions/shared/fieldRoutesImport.ts";

const csvPath = process.argv[2];
const outPath = process.argv[3] ?? "migration-preview.html";
if (!csvPath) {
  console.error("usage: tsx scripts/migrationPreview.mts <csv> [out.html]");
  process.exit(1);
}

const rows = parse(readFileSync(csvPath), {
  columns: true,
  bom: true,
  skip_empty_lines: true,
}) as FieldRoutesRow[];

const { agreements, oneTimeVisits, skipped } = adaptFieldRoutesRows(rows);

const money = (s: string) => {
  const n = Number((s ?? "").replace(/[$,]/g, "").trim());
  return Number.isFinite(n) ? n : 0;
};
const fmt = (cents: number) =>
  `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ---- Reconciliation: imported price total vs the source's active recurring total.
const RECURRING = new Set([
  "Every 30 Days",
  "Every 60 Days",
  "Every 90 Days",
  "Every 180 Days",
]);
let sourceActiveMonthlyCents = 0;
for (const r of rows) {
  if (
    r["Subscription Status"].trim() === "Active" &&
    RECURRING.has(r["Recurring Frequency"].trim())
  ) {
    sourceActiveMonthlyCents += Math.round((money(r["Subscription Contract Value"]) / 12) * 100);
  }
}
const importedMonthlyCents = agreements.reduce((s, a) => s + a.priceCents, 0);
const reconGapCents = sourceActiveMonthlyCents - importedMonthlyCents;

// ---- Flags: rows that need a human decision BEFORE they become live customers.
type Flag = "TEST_OR_STAFF" | "INVALID_EMAIL" | "SHARED_INBOX" | "NO_EMAIL" | "NO_PHONE";
const STAFF_DOMAINS = ["getgim.com", "pestbuzzkill.com", "duckit.ai"];
function flagsFor(a: (typeof agreements)[number], displayName: string): Flag[] {
  const f: Flag[] = [];
  const email = (a.email ?? "").trim().toLowerCase();
  const domain = email.split("@")[1] ?? "";
  if (
    /greasley/i.test(displayName) ||
    STAFF_DOMAINS.includes(domain)
  )
    f.push("TEST_OR_STAFF");
  if (!email) f.push("NO_EMAIL");
  else if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    /\.(con|cmo|ocm|xom|vom|coom)$/i.test(email)
  )
    f.push("INVALID_EMAIL");
  else if (email === "contact@getgim.com") f.push("SHARED_INBOX");
  if (!(a.phone ?? "").trim()) f.push("NO_PHONE");
  return f;
}
const flagged = agreements
  .map((a) => ({ a, flags: flagsFor(a, a.displayName) }))
  .filter((x) => x.flags.some((fl) => fl !== "NO_PHONE")); // phone-only isn't blocking

const skipByReason: Record<string, number> = {};
for (const s of skipped) skipByReason[s.reason] = (skipByReason[s.reason] ?? 0) + 1;

// ---- Group rollup: how many plans land under each client group.
const groupCounts: Record<string, number> = {};
let ungrouped = 0;
for (const a of agreements) {
  if (a.group) groupCounts[a.group.name] = (groupCounts[a.group.name] ?? 0) + 1;
  else ungrouped++;
}
const groupSummary =
  Object.entries(groupCounts)
    .map(([n, c]) => `${n} (${c})`)
    .join(", ") + (ungrouped ? `, ${ungrouped} standalone` : "");

// ---------------------------------------------------------------- render
const esc = (s: string) =>
  (s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
const badge = (t: string, kind = "") => `<span class="badge ${kind}">${esc(t)}</span>`;

const card = (label: string, value: string, sub = "") =>
  `<div class="card"><div class="v">${value}</div><div class="l">${label}</div>${sub ? `<div class="s">${sub}</div>` : ""}</div>`;

const planRows = agreements
  .map((a) => {
    const fl = flagsFor(a, a.displayName).filter((x) => x !== "NO_PHONE");
    return `<tr>
      <td>${esc(a.externalSubscriptionId)}</td>
      <td>${esc(a.displayName)}</td>
      <td>${a.propertyClass === "COMMUNITY" ? badge("HOA", "hoa") : badge("Residential")}</td>
      <td>${a.group ? badge(a.group.name, "hoa") : "—"}</td>
      <td class="num">${fmt(a.priceCents)}</td>
      <td>${esc(a.serviceFrequency)}</td>
      <td class="num">${a.salesTaxPercent ?? 0}%</td>
      <td>${esc(a.serviceState ?? "")}</td>
      <td>${esc(a.email ?? "—")}</td>
      <td>${fl.map((x) => badge(x.replace(/_/g, " ").toLowerCase(), "warn")).join(" ")}</td>
    </tr>`;
  })
  .join("");

const oneTimeRows = oneTimeVisits
  .map((v) => `<tr><td>${esc(v.externalCustomerId)}</td><td>${esc(v.label)}</td></tr>`)
  .join("");

const skippedRows = skipped
  .map(
    (s) =>
      `<tr><td>${esc(s.externalCustomerId)}</td><td>${esc(s.label)}</td><td>${badge(s.reason.replace(/_/g, " ").toLowerCase())}</td></tr>`
  )
  .join("");

const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>FieldRoutes migration preview</title>
<style>
  :root { color-scheme: light dark; --bg:#fff; --fg:#0a0a0a; --mut:#666; --line:#e6e6e6; --card:#f7f7f4; --green:#5a9e2f; --warn:#b8860b; --warnbg:#fff6e0; }
  @media (prefers-color-scheme: dark){ :root{ --bg:#0f0f0f; --fg:#f2f2f2; --mut:#9a9a9a; --line:#262626; --card:#171717; --green:#8fd15a; --warn:#e0b44a; --warnbg:#2a2200; } }
  *{box-sizing:border-box} body{font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:var(--bg);color:var(--fg);padding:32px}
  h1{font-size:22px;margin:0 0 4px} .sub{color:var(--mut);margin:0 0 24px}
  .cards{display:flex;flex-wrap:wrap;gap:12px;margin-bottom:8px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 18px;min-width:150px}
  .card .v{font-size:24px;font-weight:700} .card .l{color:var(--mut);font-size:12px;text-transform:uppercase;letter-spacing:.04em} .card .s{color:var(--mut);font-size:12px;margin-top:2px}
  .recon{border:1px solid var(--line);border-radius:10px;padding:16px 18px;margin:20px 0}
  .recon.ok{border-color:var(--green)} .recon.gap{border-color:var(--warn);background:var(--warnbg)}
  h2{font-size:15px;text-transform:uppercase;letter-spacing:.05em;color:var(--mut);margin:32px 0 10px;border-bottom:1px solid var(--line);padding-bottom:6px}
  table{border-collapse:collapse;width:100%;font-size:13px} th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line);vertical-align:top}
  th{color:var(--mut);font-weight:600;position:sticky;top:0;background:var(--bg)} td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
  .wrap{overflow-x:auto;border:1px solid var(--line);border-radius:10px}
  .badge{display:inline-block;font-size:11px;padding:1px 7px;border-radius:999px;background:var(--card);border:1px solid var(--line);white-space:nowrap}
  .badge.hoa{border-color:var(--green);color:var(--green)} .badge.warn{background:var(--warnbg);border-color:var(--warn);color:var(--warn)}
</style></head><body>
<h1>FieldRoutes → BuzzKill migration preview</h1>
<p class="sub">Dry run of <code>${esc(csvPath.split("/").pop() ?? csvPath)}</code> · ${rows.length} source rows · nothing written</p>

<div class="cards">
  ${card("Plans to import", String(agreements.length))}
  ${card("One-time visits", String(oneTimeVisits.length), "not subscriptions")}
  ${card("Skipped", String(skipped.length), Object.entries(skipByReason).map(([k, v]) => `${v} ${k.toLowerCase().replace(/_/g, " ")}`).join(", "))}
  ${card("Client groups", String(Object.keys(groupCounts).length), groupSummary)}
</div>

<div class="recon ${reconGapCents === 0 ? "ok" : "gap"}">
  <strong>Price reconciliation.</strong> Imported monthly (pre-tax) total <b>${fmt(importedMonthlyCents)}</b>
  vs. source active-recurring total <b>${fmt(sourceActiveMonthlyCents)}</b>.
  ${
    reconGapCents === 0
      ? "Exact match — every active recurring dollar is accounted for."
      : `Gap of <b>${fmt(Math.abs(reconGapCents))}/mo</b> — expected: the ${skipByReason["UNSUPPORTED_CADENCE"] ?? 0} unsupported-cadence and ${skipByReason["NO_PRICE"] ?? 0} zero-price row(s) are intentionally not imported. Confirm the gap equals those rows.`
  }
</div>

<h2>Needs a decision before import (${flagged.length})</h2>
<div class="wrap"><table>
  <tr><th>Sub ID</th><th>Name</th><th>Email</th><th>Flags</th></tr>
  ${flagged.map(({ a, flags }) => `<tr><td>${esc(a.externalSubscriptionId)}</td><td>${esc(a.displayName)}</td><td>${esc(a.email ?? "—")}</td><td>${flags.filter((x) => x !== "NO_PHONE").map((x) => badge(x.replace(/_/g, " ").toLowerCase(), "warn")).join(" ")}</td></tr>`).join("")}
</table></div>

<h2>Plans to import (${agreements.length})</h2>
<div class="wrap"><table>
  <tr><th>Sub ID</th><th>Name</th><th>Class</th><th>Group</th><th class="num">Monthly</th><th>Cadence</th><th class="num">Tax</th><th>State</th><th>Email</th><th>Flags</th></tr>
  ${planRows}
</table></div>

<h2>One-time visits — separate importer (${oneTimeVisits.length})</h2>
<div class="wrap"><table><tr><th>Cust ID</th><th>Name</th></tr>${oneTimeRows}</table></div>

<h2>Skipped (${skipped.length})</h2>
<div class="wrap"><table><tr><th>Cust ID</th><th>Name</th><th>Reason</th></tr>${skippedRows}</table></div>
</body></html>`;

writeFileSync(outPath, html);
// The machine payload for the importAgreements mutation — same reconciled run,
// so what you review is exactly what imports.
const jsonPath = outPath.replace(/\.html?$/i, "") + ".agreements.json";
writeFileSync(jsonPath, JSON.stringify(agreements, null, 2));
console.log(`plans=${agreements.length} oneTime=${oneTimeVisits.length} skipped=${skipped.length} flagged=${flagged.length}`);
console.log(`wrote ${jsonPath}`);
console.log(`recon: imported ${fmt(importedMonthlyCents)}/mo vs source ${fmt(sourceActiveMonthlyCents)}/mo (gap ${fmt(reconGapCents)})`);
console.log(`wrote ${outPath}`);
