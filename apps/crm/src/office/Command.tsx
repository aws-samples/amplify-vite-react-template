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
import { PaymentsInFlight } from "./Work";
import {
  Badge,
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
 *  (or amends) these recorded defaults; the levers live on the Dashboard's
 *  emergency controls and Market Rates' catalog rollback. */
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

export default function Command() {
  const navigate = useNavigate();
  const [runs, setRuns] = useState<ReconRunRow[] | null>(null);
  const [work, setWork] = useState<WorkItem[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [plans, setPlans] = useState<ServicePlan[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [rr, wi, cus, jb, pl] = await Promise.all([
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
      ]);
      setRuns(rr);
      setWork(wi);
      setCustomers(cus);
      setJobs(jb);
      setPlans(pl);
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
          The recorded launch defaults. Levers: Dashboard → Emergency controls
          (OWNER) and Market Rates → Catalog rollback (OWNER). Playbooks:
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
