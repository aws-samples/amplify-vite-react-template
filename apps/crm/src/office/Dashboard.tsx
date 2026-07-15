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
import {
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
  const sum = (list: Invoice[]) => list.reduce((s, i) => s + i.amountCents, 0);
  const billed = sum(inRange);
  const paid = sum(inRange.filter((i) => i.status === "PAID"));
  const open = sum(inRange.filter((i) => i.status === "OPEN"));
  const failed = sum(inRange.filter((i) => i.status === "FAILED"));

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

      {outstanding.length === 0 && needsAttention.length === 0 ? (
        <EmptyState
          title="All caught up"
          body="No outstanding invoices and every active customer has a plan or upcoming job."
        />
      ) : null}
    </Page>
  );
}
