import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  api,
  listAll,
  type Customer,
  type Invoice,
  type Job,
  type ServicePlan,
} from "../lib/api";
import { fmtDate, money, todayEastern } from "../lib/format";
import { revenueTotals } from "../lib/revenue";
import { plansWithoutNextVisit, unchargedOneTimeJobs } from "../lib/workQueues";
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
  StatusBadge,
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
  const [period, setPeriod] = useState<Period>("MONTH");
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [plans, setPlans] = useState<ServicePlan[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [inv, cus, pl, jb] = await Promise.all([
        listAll((t) => api().models.Invoice.list({ limit: 1000, nextToken: t })),
        listAll((t) => api().models.Customer.list({ limit: 1000, nextToken: t })),
        listAll((t) => api().models.ServicePlan.list({ limit: 1000, nextToken: t })),
        listAll((t) => api().models.Job.list({ limit: 1000, nextToken: t })),
      ]);
      setInvoices(inv);
      setCustomers(cus);
      setPlans(pl);
      setJobs(jb);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load dashboard");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

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

  const outstanding = invoices
    .filter((i) => i.status === "OPEN" || i.status === "FAILED")
    .sort((a, b) => (a.issuedAt ?? "").localeCompare(b.issuedAt ?? ""));

  const today = todayEastern();
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

  return (
    <Page title="Dashboard">
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

      {outstanding.length > 0 ? (
        <Card title={`Outstanding invoices (${outstanding.length})`}>
          {outstanding.slice(0, 10).map((i) => (
            <ListRow
              key={i.id}
              title={customerById.get(i.customerId)?.displayName ?? "Unknown"}
              subtitle={`${i.description} · ${fmtDate(i.issuedAt, true)}`}
              meta={
                <>
                  <strong>{money(i.amountCents)}</strong>
                  <StatusBadge status={i.status} />
                </>
              }
              onClick={() => navigate(`/customers/${i.customerId}`)}
            />
          ))}
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

      {outstanding.length === 0 &&
      needsAttention.length === 0 &&
      notBilling.length === 0 &&
      uncharged.length === 0 &&
      noNextVisit.length === 0 ? (
        <EmptyState
          title="All caught up"
          body="No outstanding invoices, every completed job is charged, every serviced plan is billing, every active plan has a next visit, and every active customer has a plan or upcoming job."
        />
      ) : null}
    </Page>
  );
}
