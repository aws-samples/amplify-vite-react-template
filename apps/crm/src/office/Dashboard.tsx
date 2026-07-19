import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  api,
  assignRecoveryOwner,
  listAll,
  listDisputes,
  listWorkItems,
  unwrap,
  type Customer,
  type Dispute,
  type Invoice,
  type Job,
  type ServicePlan,
  type WorkItem,
} from "../lib/api";
import { fmtDate, fmtDateTime, money, todayEastern } from "../lib/format";
import { revenueTotals } from "../lib/revenue";
import { plansWithoutNextVisit, unchargedOneTimeJobs } from "../lib/workQueues";
import {
  AGING_BUCKET_LABEL,
  AGING_BUCKETS,
  agingSummary,
  type AgingBucket,
} from "../lib/aging";
import {
  buildRecoveryQueue,
  daysUntilEvidenceDue,
  type RecoveryItem,
} from "../lib/recovery";
import { useRoles } from "../lib/auth";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNote,
  ListRow,
  Page,
  SegControl,
  Spinner,
  Stat,
  type BadgeTone,
} from "../ui/kit";

type Period = "MONTH" | "LAST_MONTH" | "ALL";

function inPeriod(iso: string | null | undefined, period: Period): boolean {
  if (period === "ALL") return true;
  if (!iso) return false;
  const now = new Date();
  const d = new Date(iso);
  const thisMonth = now.getFullYear() * 12 + now.getMonth();
  const invMonth = d.getFullYear() * 12 + d.getMonth();
  return period === "MONTH" ? invMonth === thisMonth : invMonth === thisMonth - 1;
}

export default function Dashboard() {
  const navigate = useNavigate();
  const roles = useRoles();
  const [period, setPeriod] = useState<Period>("MONTH");
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [plans, setPlans] = useState<ServicePlan[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [disputes, setDisputes] = useState<Dispute[]>([]);
  const [ownedWork, setOwnedWork] = useState<WorkItem[]>([]);
  const [assigningId, setAssigningId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [inv, cus, pl, jb, dp, work] = await Promise.all([
        listAll((t) => api().models.Invoice.list({ limit: 1000, nextToken: t })),
        listAll((t) => api().models.Customer.list({ limit: 1000, nextToken: t })),
        listAll((t) => api().models.ServicePlan.list({ limit: 1000, nextToken: t })),
        listAll((t) => api().models.Job.list({ limit: 1000, nextToken: t })),
        listAll((t) => listDisputes({ limit: 1000, nextToken: t })),
        listAll((t) => listWorkItems({ limit: 1000, nextToken: t })),
      ]);
      setInvoices(inv);
      setCustomers(cus);
      setPlans(pl);
      setJobs(jb);
      setDisputes(dp);
      setOwnedWork(work);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load dashboard");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Claim a recovery item ("Assign to me") — the server stamps the owner from
  // the caller's identity, so after it lands a reload shows this user's email.
  const assign = useCallback(
    async (kind: "INVOICE" | "DISPUTE", id: string) => {
      setAssigningId(id);
      setError(null);
      try {
        await assignRecoveryOwner({ kind, id });
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not assign owner");
      } finally {
        setAssigningId(null);
      }
    },
    [load]
  );

  if (!invoices) {
    return (
      <Page title="Dashboard">
        <ErrorNote error={error} />
        {error ? (
          <Button
            variant="subtle"
            onClick={() => {
              setError(null);
              void load();
            }}
          >
            Retry
          </Button>
        ) : (
          <Spinner />
        )}
      </Page>
    );
  }

  const inRange = invoices.filter(
    (i) => i.status !== "VOID" && i.status !== "DRAFT" && inPeriod(i.issuedAt, period)
  );
  // Refund-aware; see lib/revenue.ts, which is where the rules are tested.
  const {
    billedCents: billed,
    paidCents: paid,
    openCents: open,
    failedCents: failed,
    refundedCents: refunded,
  } = revenueTotals(inRange);

  const today = todayEastern();

  // Money-out recovery. Aging buckets the outstanding receivable (OPEN/FAILED)
  // by how overdue it is; the recovery queue is every overdue/failed invoice
  // and open dispute, most-urgent first, each with its SLA and owner. Both use
  // the shared helpers whose bucket boundaries match the backend's
  // shared/recovery.ts to the day.
  const aging = agingSummary(invoices, today);
  const recoveryQueue = buildRecoveryQueue(invoices, disputes, today);
  const openDisputes = disputes.filter(
    (d) => d.status === "NEEDS_RESPONSE" || d.status === "UNDER_REVIEW"
  );
  const activePlanCustomers = new Set(
    plans.filter((p) => p.status === "ACTIVE").map((p) => p.customerId)
  );
  const upcomingJobCustomers = new Set(
    jobs
      .filter(
        (j) =>
          (j.status === "SCHEDULED" && (j.scheduledDate ?? "") >= today) ||
          j.status === "UNSCHEDULED"
      )
      .map((j) => j.customerId)
  );
  const needsAttention = customers.filter(
    (c) =>
      c.status === "ACTIVE" &&
      !activePlanCustomers.has(c.id) &&
      !upcomingJobCustomers.has(c.id)
  );

  // Plans whose first visit is done but which never started billing. Billing
  // starts automatically on completion now, so anything landing here failed —
  // usually no card on file. Each row is roughly $1,188/yr walking out.
  //
  // A plan with no completed visit yet is deliberately excluded: it is not
  // supposed to be billing, and listing it would bury the real ones.
  const servicedPlanIds = new Set(
    jobs
      .filter((j) => j.status === "COMPLETED" && j.servicePlanId)
      .map((j) => j.servicePlanId as string)
  );
  const notBilling = plans.filter(
    (p) =>
      p.status === "ACTIVE" &&
      !p.stripeSubscriptionId &&
      servicedPlanIds.has(p.id)
  );

  // Completed one-time jobs nobody has charged. Completion only auto-starts
  // billing for recurring plans; a one-time job's money moves when somebody
  // presses Charge, and until this list existed no worklist fed that button.
  const uncharged = unchargedOneTimeJobs(jobs, invoices);

  // The service direction of "not billing": plans still charging the customer
  // with no visit on the calendar. NO_ACCESS deliberately parks a plan here.
  const noNextVisit = plansWithoutNextVisit(plans, jobs, today);

  const openLeads = customers.filter((c) => c.status === "LEAD");
  const customerById = new Map(customers.map((c) => [c.id, c]));
  const openOwnedWork = ownedWork
    .filter((item) => item.status === "OPEN")
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt));

  return (
    <Page title="Dashboard">
      <EmergencyControls />
      <SegControl
        options={[
          { value: "MONTH" as Period, label: "This month" },
          { value: "LAST_MONTH" as Period, label: "Last month" },
          { value: "ALL" as Period, label: "All time" },
        ]}
        value={period}
        onChange={setPeriod}
      />
      <ErrorNote error={error} />

      <div className="stat-grid">
        <Stat label="Billed" value={money(billed)} />
        <Stat label="Paid" value={money(paid)} tone="ok" />
        <Stat label="Unpaid" value={money(open)} tone="warn" />
        <Stat label="Failed" value={money(failed)} tone={failed ? "danger" : undefined} />
      </div>

      <Card
        title={`Exception work queue (${openOwnedWork.length})`}
        actions={
          <Button small variant="subtle" onClick={() => navigate("/work")}>
            Open queue
          </Button>
        }
      >
        {openOwnedWork.length === 0 ? (
          <p className="muted small">No owned exception work is open.</p>
        ) : (
          <>
            <p className="muted small" style={{ marginBottom: 6 }}>
              Every exception has an owner, deadline, resolution action, overdue escalation,
              and permanent history. Email alerts do not clear this queue.
            </p>
            {openOwnedWork.slice(0, 5).map((item) => {
              const overdue = item.dueAt < new Date().toISOString();
              return (
                <ListRow
                  key={item.id}
                  title={item.title}
                  subtitle={`Owner: ${item.ownerSub === roles.sub ? "you" : item.ownerEmail} · due ${fmtDateTime(item.dueAt)}`}
                  meta={<Badge tone={overdue ? "danger" : "warn"}>{overdue ? "overdue" : "open"}</Badge>}
                  onClick={() => navigate("/work")}
                />
              );
            })}
          </>
        )}
      </Card>

      {refunded > 0 ? (
        // Netted out of Billed and Paid above, but shown rather than silently
        // subtracted — the numbers should be explainable, not just correct.
        <div className="stat-grid">
          <Stat label="Refunded" value={money(refunded)} tone="warn" />
        </div>
      ) : null}

      <div className="stat-grid">
        <Stat label="Open leads" value={openLeads.length} />
        <Stat
          label="Active customers"
          value={customers.filter((c) => c.status === "ACTIVE").length}
        />
      </div>

      {aging.count > 0 ? (
        <Card title={`Accounts receivable — ${money(aging.totalCents)} outstanding`}>
          <p className="muted small" style={{ marginBottom: 6 }}>
            {aging.count} unpaid invoice{aging.count === 1 ? "" : "s"}, by how far
            past due. Money in the older buckets is the money most likely to
            never arrive.
          </p>
          <div className="stat-grid">
            {AGING_BUCKETS.map((b) => (
              <Stat
                key={b}
                label={`${AGING_BUCKET_LABEL[b]}${
                  aging.buckets[b].count ? ` · ${aging.buckets[b].count}` : ""
                }`}
                value={money(aging.buckets[b].totalCents)}
                tone={
                  aging.buckets[b].totalCents > 0 && b !== "current"
                    ? bucketTone(b)
                    : undefined
                }
              />
            ))}
          </div>
        </Card>
      ) : null}

      {recoveryQueue.length > 0 ? (
        <Card title={`Recovery queue (${recoveryQueue.length})`}>
          <p className="muted small" style={{ marginBottom: 6 }}>
            Every overdue invoice, failed charge in dunning, and open dispute —
            most urgent first. Assign each to one owner so no item is everyone's
            job and therefore no one's.
          </p>
          {recoveryQueue.slice(0, 15).map((item) => (
            <ListRow
              key={`${item.refType}-${item.id}`}
              title={customerById.get(item.customerId)?.displayName ?? "Unknown"}
              subtitle={
                <>
                  {`${RECOVERY_KIND_LABEL[item.kind]} · ${item.slaLabel}`}
                  <span className="nested-line">
                    {ownerText(item.ownerSub, item.ownerEmail, roles.sub)}
                  </span>
                </>
              }
              meta={
                <>
                  <strong>{money(item.amountCents)}</strong>
                  <Badge tone={item.urgent ? "danger" : "warn"}>
                    {RECOVERY_KIND_TAG[item.kind]}
                  </Badge>
                  <AssignButton
                    kind={item.refType === "dispute" ? "DISPUTE" : "INVOICE"}
                    id={item.id}
                    ownerSub={item.ownerSub}
                    mySub={roles.sub}
                    busy={assigningId === item.id}
                    onAssign={assign}
                  />
                </>
              }
              onClick={() => navigate(`/customers/${item.customerId}`)}
            />
          ))}
        </Card>
      ) : null}

      {openDisputes.length > 0 ? (
        <Card title={`Card disputes (${openDisputes.length})`}>
          <p className="muted small" style={{ marginBottom: 6 }}>
            Chargebacks with an evidence deadline. Miss the deadline and the
            dispute is lost by default — respond in Stripe, then assign an owner
            here so someone is on the hook for it.
          </p>
          {openDisputes.map((d) => {
            const days = daysUntilEvidenceDue(d, today);
            const urgent = days === null || days <= 3;
            const cust = d.customerId
              ? customerById.get(d.customerId)
              : undefined;
            return (
              <ListRow
                key={d.id}
                title={cust?.displayName ?? "Unknown customer"}
                subtitle={
                  <>
                    {`${d.reason ?? "Disputed charge"} · ${deadlineText(days)}`}
                    <span className="nested-line">
                      {ownerText(d.ownerSub, d.ownerEmail, roles.sub)}
                    </span>
                  </>
                }
                meta={
                  <>
                    <strong>{money(d.amountCents)}</strong>
                    <Badge tone={urgent ? "danger" : "warn"}>
                      {(d.status ?? "").replace(/_/g, " ").toLowerCase() ||
                        "dispute"}
                    </Badge>
                    <a
                      href={`https://dashboard.stripe.com/disputes/${d.stripeDisputeId}`}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      style={{ color: "var(--brand)" }}
                    >
                      Stripe
                    </a>
                    <AssignButton
                      kind="DISPUTE"
                      id={d.id}
                      ownerSub={d.ownerSub ?? null}
                      mySub={roles.sub}
                      busy={assigningId === d.id}
                      onAssign={assign}
                    />
                  </>
                }
                onClick={
                  d.customerId
                    ? () => navigate(`/customers/${d.customerId}`)
                    : undefined
                }
              />
            );
          })}
        </Card>
      ) : null}

      {uncharged.length > 0 ? (
        <Card title={`Completed but never charged (${uncharged.length})`}>
          <p className="muted small" style={{ marginBottom: 6 }}>
            One-time jobs where the work is done and no charge or invoice
            exists. Nobody pays for these unless someone acts — open the
            customer and use <strong>Charge</strong> on the job.
          </p>
          {uncharged.slice(0, 10).map((j) => (
            <ListRow
              key={j.id}
              title={customerById.get(j.customerId)?.displayName ?? "Unknown"}
              subtitle={`${j.serviceType} · completed ${fmtDate(j.completedAt ?? j.scheduledDate, true)}`}
              meta={
                <>
                  <strong>{money(j.priceCents)}</strong>
                  <Badge tone="danger">never charged</Badge>
                </>
              }
              onClick={() => navigate(`/customers/${j.customerId}`)}
            />
          ))}
        </Card>
      ) : null}

      {notBilling.length > 0 ? (
        <Card title={`Serviced but not billing (${notBilling.length})`}>
          <p className="muted small" style={{ marginBottom: 6 }}>
            These plans have had their first visit but no subscription is
            running — usually no payment method on file. Every one of these is
            money not being collected.
          </p>
          {notBilling.slice(0, 10).map((p) => (
            <ListRow
              key={p.id}
              title={customerById.get(p.customerId)?.displayName ?? "Unknown"}
              subtitle={`${p.planName} · ${money(p.priceCents)}/mo`}
              meta={<Badge tone="danger">not billing</Badge>}
              onClick={() => navigate(`/customers/${p.customerId}`)}
            />
          ))}
        </Card>
      ) : null}

      {noNextVisit.length > 0 ? (
        <Card title={`Active plans with no next visit (${noNextVisit.length})`}>
          <p className="muted small" style={{ marginBottom: 6 }}>
            These plans are live — any with a subscription are still charging
            the customer — and no visit is scheduled or queued. A no-access
            exit or a canceled visit leaves a plan like this. Book the next
            visit from the customer page.
          </p>
          {noNextVisit.slice(0, 10).map((p) => (
            <ListRow
              key={p.id}
              title={customerById.get(p.customerId)?.displayName ?? "Unknown"}
              subtitle={`${p.planName} · ${money(p.priceCents)}/mo`}
              meta={<Badge tone="danger">no next visit</Badge>}
              onClick={() => navigate(`/customers/${p.customerId}`)}
            />
          ))}
        </Card>
      ) : null}

      {needsAttention.length > 0 ? (
        <Card title="Needs attention">
          <p className="muted small" style={{ marginBottom: 6 }}>
            Active customers with no service plan and no upcoming job.
          </p>
          {needsAttention.slice(0, 10).map((c) => (
            <ListRow
              key={c.id}
              title={c.displayName}
              subtitle={c.serviceCity ?? undefined}
              onClick={() => navigate(`/customers/${c.id}`)}
            />
          ))}
        </Card>
      ) : null}

      {aging.count === 0 &&
      openOwnedWork.length === 0 &&
      recoveryQueue.length === 0 &&
      openDisputes.length === 0 &&
      needsAttention.length === 0 &&
      notBilling.length === 0 &&
      uncharged.length === 0 &&
      noNextVisit.length === 0 ? (
        <EmptyState
          title="All caught up"
          body="Nothing outstanding to recover, no open disputes, every completed job is charged, every serviced plan is billing, every active plan has a next visit, and every active customer has a plan or upcoming job."
        />
      ) : null}
    </Page>
  );
}

/** Older receivable is louder: the money least likely to ever arrive. */
function bucketTone(b: AgingBucket): BadgeTone {
  switch (b) {
    case "61-90":
    case "90+":
      return "danger";
    case "31-60":
    case "1-30":
      return "warn";
    default:
      return "info";
  }
}

const RECOVERY_KIND_LABEL: Record<RecoveryItem["kind"], string> = {
  OVERDUE: "Overdue invoice",
  FAILED: "Failed payment",
  DISPUTE: "Card dispute",
};

const RECOVERY_KIND_TAG: Record<RecoveryItem["kind"], string> = {
  OVERDUE: "overdue",
  FAILED: "failed",
  DISPUTE: "dispute",
};

/** How the owner of a recovery item reads: you, a teammate, or nobody yet. */
function ownerText(
  ownerSub: string | null | undefined,
  ownerEmail: string | null | undefined,
  mySub: string
): string {
  if (ownerSub && ownerSub === mySub) return "Owner: you";
  if (ownerEmail) return `Owner: ${ownerEmail}`;
  return "Unassigned";
}

/** A dispute deadline said in days, urgent when the clock is nearly out. */
function deadlineText(days: number | null): string {
  if (days === null) return "deadline unknown — respond ASAP";
  if (days < 0) return `${-days} day${days === -1 ? "" : "s"} past deadline`;
  if (days === 0) return "evidence due today";
  return `${days} day${days === 1 ? "" : "s"} to respond`;
}

/**
 * "Assign to me" for a recovery item — or a static "you" badge when the caller
 * already owns it. stopPropagation so claiming an item never also opens the
 * customer under it.
 */
function AssignButton({
  kind,
  id,
  ownerSub,
  mySub,
  busy,
  onAssign,
}: {
  kind: "INVOICE" | "DISPUTE";
  id: string;
  ownerSub: string | null;
  mySub: string;
  busy: boolean;
  onAssign: (kind: "INVOICE" | "DISPUTE", id: string) => Promise<void>;
}) {
  if (ownerSub && ownerSub === mySub) {
    return <Badge tone="ok">you</Badge>;
  }
  return (
    <Button
      small
      variant="subtle"
      loading={busy}
      onClick={(e) => {
        e.stopPropagation();
        void onAssign(kind, id);
      }}
    >
      {ownerSub ? "Take over" : "Assign to me"}
    </Button>
  );
}

/**
 * GL-22 — the emergency pause switchboard. Every office user SEES an active
 * pause (a banner-style card, always at the top); only an OWNER can flip
 * the switches, and every change requires a reason and is announced to the
 * office. The playbooks in docs/incident-playbooks name when to pull each.
 */
function EmergencyControls() {
  const roles = useRoles();
  const [pause, setPause] = useState<{
    bookingPaused?: boolean | null;
    dispatchPaused?: boolean | null;
    billingPaused?: boolean | null;
    reason?: string | null;
    actorEmail?: string | null;
  } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { data } = await api().models.OpsControl.get({ id: "pause" });
      setPause(data ?? {});
    } catch {
      setPause({});
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const anyPaused = Boolean(
    pause?.bookingPaused || pause?.dispatchPaused || pause?.billingPaused
  );
  // Hidden entirely for non-owners while everything runs; a pause is
  // impossible to miss for everyone.
  if (!pause || (!anyPaused && !roles.owner)) return null;

  const flip = async (
    key: "bookingPaused" | "dispatchPaused" | "billingPaused",
    next: boolean
  ) => {
    const reason = window.prompt(
      next
        ? "Why is this being paused? (required — announced to the office)"
        : "Why is it safe to resume? (required — announced to the office)"
    );
    if (!reason?.trim()) return;
    setBusy(key);
    setError(null);
    try {
      unwrap(
        await api().mutations.setOpsPause({ [key]: next, reason: reason.trim() })
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change the pause");
    } finally {
      setBusy(null);
    }
  };

  const rows: {
    key: "bookingPaused" | "dispatchPaused" | "billingPaused";
    label: string;
    effect: string;
  }[] = [
    {
      key: "bookingPaused",
      label: "New online bookings",
      effect: "The website funnel refuses new quotes and payments",
    },
    {
      key: "dispatchPaused",
      label: "New dispatch",
      effect: "No new visit can be scheduled or assigned",
    },
    {
      key: "billingPaused",
      label: "Billing initiation",
      effect: "No new charge, retry, or subscription start (refunds still work)",
    },
  ];

  return (
    <Card>
      <div className="row-split">
        <strong>Emergency controls</strong>
        <Badge tone={anyPaused ? "danger" : "ok"}>
          {anyPaused ? "SOMETHING IS PAUSED" : "all running"}
        </Badge>
      </div>
      {anyPaused && pause.reason ? (
        <p className="small" style={{ margin: "6px 0 0" }}>
          {pause.actorEmail ?? "An owner"}: {pause.reason}
        </p>
      ) : null}
      <ErrorNote error={error} />
      {rows.map((r) => {
        const paused = Boolean(pause[r.key]);
        return (
          <ListRow
            key={r.key}
            title={r.label}
            subtitle={r.effect}
            meta={
              <>
                <Badge tone={paused ? "danger" : "ok"}>
                  {paused ? "PAUSED" : "running"}
                </Badge>
                {roles.owner ? (
                  <Button
                    small
                    variant={paused ? "primary" : "danger"}
                    loading={busy === r.key}
                    onClick={() => void flip(r.key, !paused)}
                  >
                    {paused ? "Resume" : "Pause"}
                  </Button>
                ) : null}
              </>
            }
          />
        );
      })}
    </Card>
  );
}
