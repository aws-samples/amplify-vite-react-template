import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  api,
  listAll,
  listWorkItems,
  type Customer,
  type Job,
  type ServicePlan,
  type WorkItem,
} from "../lib/api";
import {
  deriveLeadStage,
  isLeadOverdue,
  LEAD_STAGE_LABEL,
  type LeadStage,
} from "../lib/leadStage";
import { money } from "../lib/format";
import {
  attemptVsReached,
  callbackStats,
  firstResponseStats,
  qualificationFunnel,
  type MetricActivity,
  type MetricCallback,
} from "../lib/commandMetrics";
import { PaymentsInFlight } from "./Work";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNote,
  ListRow,
  Page,
  Spinner,
} from "../ui/kit";

/**
 * GL-19 — the leadership command view: each morning, do customers, work,
 * and money agree — without asking engineering to query production.
 *
 * Every number here is either (a) the latest daily ReconRun summary written
 * by the reconcile pass (money / plans / state — the mismatches themselves
 * are owned WorkItems on the shared queue), (b) the payments-in-flight
 * truth shared with the office queue, or (c) computed live from the same
 * rows the operating screens use. Nothing waits for approval here —
 * visibility, with every problem already owned.
 */

type ReconRunRow = {
  id: string;
  kind: string;
  runDate: string;
  summary?: unknown;
  mismatches?: number | null;
  healthy?: boolean | null;
};

/** GL-19 — the codified launch pause/rollback thresholds. The CEO ratifies
 *  (or amends) these recorded defaults. The in-app pause switchboard was
 *  removed by owner decision (20 Jul 2026): pricing has its lever on
 *  Market Rates' catalog rollback; every other containment action runs
 *  through engineering per docs/incident-playbooks-2026-07.md. */
export const PAUSE_THRESHOLDS: { trigger: string; action: string }[] = [
  {
    trigger: "Any confirmed double charge",
    action: "Pause billing initiation; refund the duplicate; playbook 1.",
  },
  {
    trigger: "Any paid customer without a complete booking that a retry does not fix",
    action: "Pause new online bookings; playbook 2.",
  },
  {
    trigger: "Any unauthorized data access",
    action: "Revoke the implicated login immediately; playbook 3.",
  },
  {
    trigger: "Any unlicensed assignment that could dispatch today",
    action: "Pause new dispatch; pull the affected visits; playbook 4.",
  },
  {
    trigger: "Any unexplained money-reconciliation mismatch left after Finance review",
    action: "Pause billing initiation until the ledger is explained; playbook 1/5.",
  },
  {
    trigger: "A bad AI pricing run publishing wrong prices",
    action: "OWNER catalog rollback on Market Rates (research pauses automatically).",
  },
];

function parseSummary(raw: unknown): Record<string, unknown> {
  try {
    const v = typeof raw === "string" ? JSON.parse(raw) : raw;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const num = (v: unknown): number => (typeof v === "number" ? v : 0);

export type LifecycleEventRow = {
  id: string;
  customerId: string;
  action: string;
  reason?: string | null;
  actorEmail: string;
  actorSub?: string | null;
  priorStatus?: string | null;
  newStatus?: string | null;
  effects?: string | null;
  policyVersion?: string | null;
  occurredAt: string;
};

/** GL-09: the shop's business timezone. From/To are BUSINESS dates — what
 *  the office means by "July 10" — so each boundary is that calendar day in
 *  Eastern time (DST included), converted to a UTC instant before comparing
 *  against the stored UTC occurredAt. */
const BUSINESS_TZ = "America/New_York";

/** The zone's UTC offset (ms, positive = behind UTC) at a UTC instant. */
function businessTzOffsetMs(utcMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: BUSINESS_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(utcMs));
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  const wallAsUtc = Date.parse(
    `${p.year}-${p.month}-${p.day}T${p.hour === "24" ? "00" : p.hour}:${p.minute}:${p.second}Z`
  );
  return utcMs - wallAsUtc;
}

/** The UTC instant of Eastern midnight starting the given business date.
 *  Two-pass: guess with the offset at UTC midnight, then re-derive at the
 *  guessed instant so a DST transition on the boundary resolves correctly. */
export function businessDateStartUtcMs(date: string): number {
  const guess = Date.parse(`${date}T00:00:00Z`);
  const adjusted = guess + businessTzOffsetMs(guess);
  return guess + businessTzOffsetMs(adjusted);
}

/** The exclusive end of the business date: Eastern midnight of the NEXT day
 *  (a DST day is honestly 23 or 25 hours long — never a fixed 24h add). */
export function businessDateEndUtcMs(date: string): number {
  const nextDay = new Date(Date.parse(`${date}T00:00:00Z`) + 24 * 3600 * 1000)
    .toISOString()
    .slice(0, 10);
  return businessDateStartUtcMs(nextDay);
}

/** GL-09: neutralize spreadsheet formula injection. If the first meaningful
 *  character (after leading spaces/double-quotes) is =, +, -, @, TAB, or CR,
 *  the field opens with an apostrophe — spreadsheets then render the
 *  original text instead of executing it, and nothing is removed. */
function neutralizeFormula(str: string): string {
  let i = 0;
  while (i < str.length && (str[i] === " " || str[i] === '"')) i++;
  const c = str[i];
  return c !== undefined && "=+-@\t\r".includes(c) ? `'${str}` : str;
}

/** Pure CSV assembly for the export — exported for tests. Filters to the
 *  inclusive Eastern business-date range, sorts oldest-first, neutralizes
 *  formula injection, and escapes RFC-4180 style. */
export function buildLifecycleCsv(
  rows: LifecycleEventRow[],
  customers: { id: string; displayName?: string | null }[],
  from: string,
  to: string
): { csv: string; count: number } {
  const fromMs = from ? businessDateStartUtcMs(from) : null;
  const toMs = to ? businessDateEndUtcMs(to) : null;
  const matching = rows
    .filter((r) => {
      if (fromMs == null && toMs == null) return true;
      const t = Date.parse(r.occurredAt);
      return (
        Number.isFinite(t) &&
        (fromMs == null || t >= fromMs) &&
        (toMs == null || t < toMs)
      );
    })
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  const nameOf = new Map(customers.map((c) => [c.id, c.displayName ?? ""]));
  const esc = (v: unknown) => {
    const str = v == null ? "" : neutralizeFormula(String(v));
    return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  const header = [
    "occurredAt",
    "customerId",
    "customerName",
    "action",
    "reason",
    "actorEmail",
    "actorSub",
    "priorStatus",
    "newStatus",
    "result",
    "policyVersion",
  ];
  const lines = [header.join(",")];
  for (const r of matching) {
    lines.push(
      [
        r.occurredAt,
        r.customerId,
        nameOf.get(r.customerId) ?? "",
        r.action,
        r.reason,
        r.actorEmail,
        r.actorSub,
        r.priorStatus,
        r.newStatus,
        r.effects,
        r.policyVersion,
      ]
        .map(esc)
        .join(",")
    );
  }
  return { csv: lines.join("\r\n"), count: matching.length };
}

/**
 * GL-09 — leadership's COMPLETE lifecycle-history export. Every matching
 * event is read to pagination exhaustion before a single byte downloads; a
 * read failure aborts with the error named and produces NOTHING — a partial
 * export is never silently handed over as the record.
 */
function LifecycleExport({ customers }: { customers: Customer[] }) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);

  const exportCsv = async () => {
    setBusy(true);
    setError(null);
    setSummary(null);
    try {
      const models = api().models as unknown as {
        CustomerLifecycleEvent: {
          list: (a: { limit?: number; nextToken?: string }) => Promise<{
            data: LifecycleEventRow[];
            nextToken?: string | null;
            errors?: { message: string }[];
          }>;
        };
      };
      // listAll throws on ANY page error — completeness or nothing.
      const rows = await listAll<LifecycleEventRow>((t) =>
        models.CustomerLifecycleEvent.list({ limit: 1000, nextToken: t })
      );
      const { csv, count } = buildLifecycleCsv(rows, customers, from, to);
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `lifecycle-history-${from || "all"}-to-${to || "now"}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
      setSummary(
        `Exported ${count} event${count === 1 ? "" : "s"} — complete (every page read${from || to ? ", filtered to the chosen dates" : ""}).`
      );
    } catch (err) {
      setError(
        `Export FAILED — nothing was downloaded (a partial export is never produced): ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <div className="row-split">
        <strong>Lifecycle history export</strong>
      </div>
      <p className="muted small" style={{ margin: "6px 0 0" }}>
        Every deactivation, reactivation, and group change — customer, action,
        reason, actor, timestamp, result, and the policy version it ran under.
      </p>
      <div className="form-row-2" style={{ marginTop: 8 }}>
        <label className="small">
          From (Eastern){" "}
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label className="small">
          To (Eastern){" "}
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
      </div>
      <Button small loading={busy} onClick={() => void exportCsv()}>
        Export CSV (complete history)
      </Button>
      {summary ? (
        <p className="small" style={{ margin: "6px 0 0" }}>{summary}</p>
      ) : null}
      <ErrorNote error={error} />
    </Card>
  );
}

export default function Command() {
  const navigate = useNavigate();
  const [runs, setRuns] = useState<ReconRunRow[] | null>(null);
  const [work, setWork] = useState<WorkItem[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [plans, setPlans] = useState<ServicePlan[]>([]);
  const [activities, setActivities] = useState<MetricActivity[]>([]);
  const [callbacks, setCallbacks] = useState<MetricCallback[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [rr, wi, cus, jb, pl, acts, cbs] = await Promise.all([
        listAll<ReconRunRow>((t) =>
          (api().models as unknown as {
            ReconRun: {
              list: (a: { limit?: number; nextToken?: string }) => Promise<{
                data: ReconRunRow[];
                nextToken?: string | null;
                errors?: { message: string }[];
              }>;
            };
          }).ReconRun.list({ limit: 500, nextToken: t })
        ),
        listAll((t) => listWorkItems({ limit: 1000, nextToken: t })),
        listAll((t) => api().models.Customer.list({ limit: 1000, nextToken: t })),
        listAll((t) => api().models.Job.list({ limit: 1000, nextToken: t })),
        listAll((t) =>
          api().models.ServicePlan.list({ limit: 1000, nextToken: t })
        ),
        // GL-19: the lifecycle-derived measures read DURABLE rows — every
        // page or nothing; a failure lands in the shared error banner and
        // no partial number is ever shown as a complete metric.
        listAll<MetricActivity>((t) =>
          (api().models as unknown as {
            LeadActivity: {
              list: (a: { limit?: number; nextToken?: string }) => Promise<{
                data: MetricActivity[];
                nextToken?: string | null;
                errors?: { message: string }[];
              }>;
            };
          }).LeadActivity.list({ limit: 1000, nextToken: t })
        ),
        listAll<MetricCallback>((t) =>
          (api().models as unknown as {
            CallbackRequest: {
              list: (a: { limit?: number; nextToken?: string }) => Promise<{
                data: MetricCallback[];
                nextToken?: string | null;
                errors?: { message: string }[];
              }>;
            };
          }).CallbackRequest.list({ limit: 1000, nextToken: t })
        ),
      ]);
      setRuns(rr);
      setWork(wi);
      setCustomers(cus);
      setJobs(jb);
      setPlans(pl);
      setActivities(acts);
      setCallbacks(cbs);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not load the command view"
      );
      setRuns([]);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (runs === null) {
    return (
      <Page title="Command" back="/more">
        <ErrorNote error={error} />
        <Spinner />
      </Page>
    );
  }

  const latest = (kind: string): ReconRunRow | null =>
    runs
      .filter((r) => r.kind === kind)
      .sort((a, b) => b.runDate.localeCompare(a.runDate))[0] ?? null;
  const openByKind = (kind: string) =>
    work.filter((w) => w.kind === kind && w.status === "OPEN");

  const moneyRun = latest("MONEY");
  const planRun = latest("PLANS");
  const stateRun = latest("STATE");
  const money$ = parseSummary(moneyRun?.summary);
  const planS = parseSummary(planRun?.summary);
  const stateS = parseSummary(stateRun?.summary);

  const reconCard = (
    title: string,
    run: ReconRunRow | null,
    lines: string[],
    kinds: string[]
  ) => {
    const openItems = kinds.flatMap((k) => openByKind(k));
    return (
      <Card>
        <div className="row-split">
          <strong>{title}</strong>
          {run ? (
            <Badge tone={run.healthy && openItems.length === 0 ? "ok" : "warn"}>
              {run.healthy && openItems.length === 0
                ? `clean · ${run.runDate}`
                : `${openItems.length || run.mismatches || 0} open · ${run.runDate}`}
            </Badge>
          ) : (
            <Badge tone="warn">no run yet</Badge>
          )}
        </div>
        {run ? (
          <p className="small" style={{ margin: "6px 0 0" }}>
            {lines.join(" · ")}
          </p>
        ) : (
          <p className="muted small" style={{ margin: "6px 0 0" }}>
            The daily reconcile has not written a run yet — it runs every
            morning with the daily operations pass.
          </p>
        )}
        {openItems.slice(0, 6).map((w) => (
          <ListRow
            key={w.id}
            title={w.title}
            subtitle={`Due ${w.dueAt?.slice(0, 10) ?? ""} · ${w.ownerEmail ?? "shared queue"}`}
            meta={<Badge tone="warn">open</Badge>}
            onClick={() => navigate("/work")}
          />
        ))}
      </Card>
    );
  };

  // ---- Sales command ------------------------------------------------------
  const openLeadCount = customers.filter((c) => c.status === "LEAD").length;
  const stageCounts = new Map<LeadStage, number>();
  let overdue = 0;
  const byOwner = new Map<string, number>();
  for (const c of customers) {
    const stage = deriveLeadStage(c);
    stageCounts.set(stage, (stageCounts.get(stage) ?? 0) + 1);
    if (c.status === "LEAD" && isLeadOverdue(c)) overdue++;
    if (c.status === "LEAD") {
      const owner =
        (c as { leadOwnerEmail?: string | null }).leadOwnerEmail ??
        "shared queue";
      byOwner.set(owner, (byOwner.get(owner) ?? 0) + 1);
    }
  }
  const touched = customers.filter(
    (c) => c.status === "LEAD" && (c as { lastTouchedAt?: string | null }).lastTouchedAt
  );
  const untouched = customers.filter(
    (c) => c.status === "LEAD" && !(c as { lastTouchedAt?: string | null }).lastTouchedAt
  );
  const lostReasons = new Map<string, number>();
  for (const c of customers) {
    const reason = (c as { lostReason?: string | null }).lostReason;
    if (reason) lostReasons.set(reason, (lostReasons.get(reason) ?? 0) + 1);
  }
  const dupItems = openByKind("DUPLICATE_LEAD");
  const contactItems = openByKind("MISSING_CONTACT");

  // ---- Service quality ----------------------------------------------------
  const monthAgo = new Date(Date.now() - 30 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const recent = jobs.filter((j) => (j.scheduledDate ?? "") >= monthAgo);
  const completed30 = recent.filter((j) => j.status === "COMPLETED").length;
  const noAccess30 = recent.filter((j) => j.status === "NO_ACCESS").length;
  const canceled30 = recent.filter((j) => j.status === "CANCELED").length;
  const callbackItems = openByKind("CALLBACK_PROMISE");
  const techCounts = new Map<string, number>();
  for (const j of recent) {
    if (j.status !== "COMPLETED") continue;
    const t = (j as { technicianId?: string | null }).technicianId ?? "unassigned";
    techCounts.set(t, (techCounts.get(t) ?? 0) + 1);
  }
  const activePlans = plans.filter((p) => p.status === "ACTIVE").length;

  return (
    <Page title="Command" back="/more">
      <ErrorNote error={error} />

      {reconCard(
        "Money — provider vs ledger",
        moneyRun,
        [
          `Provider paid ${money(num(money$.providerPaidCents))}`,
          `refunds ${money(num(money$.providerRefundCents))}`,
          `net cash ${money(num(money$.netCashCents))}`,
          `CRM paid ${money(num(money$.crmPaidCents))}`,
          `${num(money$.windowDays) || 45}-day window`,
        ],
        ["MONEY_MISMATCH", "PAID_NOT_FINALIZED"]
      )}

      <PaymentsInFlight />

      {reconCard(
        "Plans — provider subscriptions vs CRM",
        planRun,
        [
          `${num(planS.canceledStillBilling)} canceled-still-billing`,
          `${num(planS.activeProviderCanceled)} active-but-provider-canceled`,
          `${num(planS.providerOnlySubscriptions)} provider-only`,
          `${num(planS.delinquentStillScheduled)} delinquent-still-scheduled`,
          `${activePlans} active plans`,
        ],
        ["PLAN_MISMATCH", "PLAN_CANCELLATION_RECOVERY"]
      )}

      {reconCard(
        "State — lifecycle, visits, and money agree",
        stateRun,
        [
          `${num(stateS.inactiveWithWork)} deactivated-with-live-work`,
          `${num(stateS.canceledVisitOpenMoney)} canceled-visit-open-money`,
        ],
        ["STATE_MISMATCH", "LIFECYCLE_RECOVERY", "VISIT_CHANGE_RECOVERY"]
      )}

      <LifecycleExport customers={customers} />

      {(() => {
        // GL-19: true lifecycle-derived measures over a NAMED 30-day window
        // with explicit denominators — from durable activity timestamps and
        // fact fields, never stage totals or open work-item counts.
        const since = Date.now() - 30 * 24 * 60 * 60_000;
        const fr = firstResponseStats(customers, activities, since);
        const ar = attemptVsReached(customers, since);
        const funnel = qualificationFunnel(customers, since);
        const cb = callbackStats(callbacks, jobs, since);
        const min = (m: number | null) =>
          m == null ? "—" : m >= 120 ? `${Math.round(m / 60)}h` : `${m}m`;
        return (
          <Card>
            <div className="row-split">
              <strong>Response &amp; funnel — last 30 days</strong>
              <Badge tone={fr.notYetResponded ? "warn" : "ok"}>
                {fr.notYetResponded
                  ? `${fr.notYetResponded} unanswered`
                  : "all answered"}
              </Badge>
            </div>
            <p className="small" style={{ margin: "6px 0 0" }}>
              First attempted contact (creation → first real call/text/email/
              booking-link attempt, median): <strong>{min(fr.medianMinutes)}</strong>{" "}
              · worst {min(fr.worstMinutes)} · {fr.responded} of {fr.leadsCreated}{" "}
              leads created were attempted — intake and notes never count
            </p>
            <p className="small" style={{ margin: "4px 0 0" }}>
              Attempt → reached: <strong>{ar.reached}</strong> of {ar.attempted}{" "}
              attempted{ar.reachedPct != null ? ` (${ar.reachedPct}%)` : ""} — an
              attempt is not a conversation
            </p>
            <p className="muted small" style={{ margin: "4px 0 0" }}>
              Funnel (leads created in window): {funnel.created} created →{" "}
              {funnel.attempted} attempted → {funnel.reached} reached →{" "}
              {funnel.qualified} qualified ({funnel.unqualified} unqualified) →{" "}
              {funnel.bookingSent} booking sent → {funnel.won} won ·{" "}
              {funnel.lost} lost
            </p>
            <p className="muted small" style={{ margin: "4px 0 0" }}>
              Guarantee callbacks: {cb.callbacksOnCohort} on the{" "}
              {cb.completedVisits} visits completed this window
              {cb.callbackPct != null ? ` (${cb.callbackPct}%)` : ""} — linked by
              original appointment, so unrelated callbacks never inflate it ·{" "}
              {cb.repeatCallbackCustomers} of {cb.callbackCustomers} callback
              customers repeated{cb.repeatPct != null ? ` (${cb.repeatPct}%)` : ""}
            </p>
          </Card>
        );
      })()}

      <Card>
        <div className="row-split">
          <strong>Sales command</strong>
          <Badge tone={overdue ? "warn" : "ok"}>
            {overdue ? `${overdue} overdue` : "on pace"}
          </Badge>
        </div>
        <p className="small" style={{ margin: "6px 0 0" }}>
          {(["NEW", "CONTACTED", "BOOKING_SENT"] as LeadStage[])
            .map((s) => `${stageCounts.get(s) ?? 0} ${LEAD_STAGE_LABEL[s].toLowerCase()}`)
            .join(" · ")}{" "}
          · {stageCounts.get("WON") ?? 0} won · {stageCounts.get("LOST") ?? 0} lost
          · {untouched.length} never touched / {touched.length} touched
        </p>
        <p className="muted small" style={{ margin: "4px 0 0" }}>
          Open-lead load:{" "}
          {[...byOwner.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([o, n]) => `${o.split("@")[0]}: ${n}`)
            .join(" · ") || "none"}
          {lostReasons.size
            ? ` · Lost: ${[...lostReasons.entries()].map(([r, n]) => `${r.toLowerCase()} ${n}`).join(", ")}`
            : ""}
          {dupItems.length ? ` · ${dupItems.length} duplicate decisions open` : ""}
          {contactItems.length ? ` · ${contactItems.length} contact fixes open` : ""}
        </p>
        <p className="muted small" style={{ margin: "4px 0 0" }}>
          Every lead carries the one-business-day response rule; the Sales
          board is the working list — {openLeadCount} open leads.
        </p>
      </Card>

      <Card>
        <div className="row-split">
          <strong>Service quality — last 30 days</strong>
          <Badge tone={noAccess30 > completed30 / 10 ? "warn" : "ok"}>
            {completed30} completed
          </Badge>
        </div>
        <p className="small" style={{ margin: "6px 0 0" }}>
          {completed30} completed · {noAccess30} no-access · {canceled30}{" "}
          canceled · {callbackItems.length} open callback promises
        </p>
        <p className="muted small" style={{ margin: "4px 0 0" }}>
          Completions by technician:{" "}
          {[...techCounts.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([t, n]) => `${t}: ${n}`)
            .join(" · ") || "none yet"}
        </p>
      </Card>

      <Card>
        <div className="row-split">
          <strong>Pause / rollback thresholds</strong>
          <Badge tone="info">CEO ratifies</Badge>
        </div>
        <p className="muted small" style={{ margin: "6px 0 0" }}>
          The recorded launch defaults. Lever: Market Rates → Catalog rollback
          (OWNER). Other containment runs through engineering — playbooks:
          docs/incident-playbooks-2026-07.md.
        </p>
        {PAUSE_THRESHOLDS.map((t, i) => (
          <ListRow key={i} title={t.trigger} subtitle={t.action} />
        ))}
      </Card>

      {work.length === 0 && customers.length === 0 ? (
        <EmptyState
          title="Nothing to command yet"
          body="Once the daily reconcile runs and real operations begin, this page answers 'do customers, work, and money agree?' each morning."
        />
      ) : null}
    </Page>
  );
}
