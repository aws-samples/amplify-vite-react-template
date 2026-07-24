import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, unwrap, type Customer, type Job, type ServicePlan } from "../lib/api";
import { useRoles } from "../lib/auth";
import { fmtDate, todayEastern } from "../lib/format";
import { planCadence } from "../lib/planCadence";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNote,
  ListRow,
  Page,
  Spinner,
  StatusBadge,
} from "../ui/kit";
import CancelPlanSheet from "../components/CancelPlanSheet";
import { loadMyCustomers } from "./portalData";

export default function PortalHome() {
  const roles = useRoles();
  const navigate = useNavigate();
  const [customers, setCustomers] = useState<Customer[] | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [plans, setPlans] = useState<ServicePlan[]>([]);
  const [cancelPlanId, setCancelPlanId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadPlans = useCallback(async (mine: Customer[]) => {
    const planLists = await Promise.all(
      mine.map((c) =>
        api().models.ServicePlan.list({
          filter: { customerId: { eq: c.id } },
          limit: 50,
        })
      )
    );
    setPlans(planLists.flatMap((r) => unwrap(r)));
  }, []);

  useEffect(() => {
    if (roles.loading) return;
    (async () => {
      try {
        const mine = await loadMyCustomers(roles);
        setCustomers(mine);
        const jobLists = await Promise.all(
          mine.map((c) =>
            api().models.Job.list({
              filter: { customerId: { eq: c.id } },
              limit: 200,
            })
          )
        );
        setJobs(jobLists.flatMap((r) => unwrap(r)));
        await loadPlans(mine);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not load");
      }
    })();
  }, [roles, loadPlans]);

  if (!customers) {
    return (
      <Page title="My services">
        <ErrorNote error={error} />
        <Spinner />
      </Page>
    );
  }

  const today = todayEastern();
  const upcoming = jobs
    .filter((j) => j.status === "SCHEDULED" && (j.scheduledDate ?? "") >= today)
    .sort((a, b) => (a.scheduledDate ?? "").localeCompare(b.scheduledDate ?? ""));
  const past = jobs
    .filter((j) => j.status === "COMPLETED")
    .sort((a, b) => (b.scheduledDate ?? "").localeCompare(a.scheduledDate ?? ""));
  const activePlans = plans.filter((p) => p.status === "ACTIVE");
  const nameFor = (j: Job) =>
    customers.length > 1
      ? customers.find((c) => c.id === j.customerId)?.displayName
      : null;

  return (
    <Page title="My services">
      <ErrorNote error={error} />
      {customers.length === 0 ? (
        <EmptyState
          title="No account linked"
          body="Your login isn't linked to a customer account yet — give the BuzzKill office a call."
        />
      ) : (
        <>
          <Button block onClick={() => navigate("/portal/add-service")}>
            + Add a service
          </Button>
          {activePlans.length > 0 ? (
            <Card title="My plan">
              {activePlans.map((p) => (
                <ListRow
                  key={p.id}
                  title={p.planName}
                  subtitle={
                    <>
                      {planCadence(p.priceCents, p.serviceFrequency, p.seasonal)}
                      {p.cancellationPending ? (
                        <span className="nested-line">
                          Cancellation in progress — your plan stays active until
                          we finish it, so if a charge posts in the meantime we'll
                          refund it. We'll email your confirmation when it's done.
                        </span>
                      ) : null}
                    </>
                  }
                  meta={
                    <>
                      {p.cancellationPending ? (
                        <Badge tone="warn">canceling</Badge>
                      ) : (
                        <StatusBadge status={p.status} />
                      )}
                      {p.cancellationPending ? null : (
                        <Button
                          small
                          variant="subtle"
                          onClick={() => setCancelPlanId(p.id)}
                        >
                          Cancel plan
                        </Button>
                      )}
                    </>
                  }
                />
              ))}
            </Card>
          ) : null}

          <Card title="Upcoming visits">
            {upcoming.length === 0 ? (
              <p className="muted small">Nothing scheduled right now.</p>
            ) : (
              upcoming.map((j) => (
                <ListRow
                  key={j.id}
                  title={j.serviceType}
                  subtitle={nameFor(j) || undefined}
                  meta={<strong>{fmtDate(j.scheduledDate)}</strong>}
                />
              ))
            )}
          </Card>

          <Card title="Service history">
            {past.length === 0 ? (
              <p className="muted small">No completed services yet.</p>
            ) : (
              past.slice(0, 10).map((j) => (
                <ListRow
                  key={j.id}
                  title={j.serviceType}
                  subtitle={nameFor(j) ?? undefined}
                  meta={<span>{fmtDate(j.scheduledDate, true)}</span>}
                />
              ))
            )}
          </Card>
        </>
      )}

      {cancelPlanId ? (
        <CancelPlanSheet
          servicePlanId={cancelPlanId}
          open
          onClose={() => setCancelPlanId(null)}
          onCanceled={() => {
            if (customers) void loadPlans(customers);
          }}
        />
      ) : null}
    </Page>
  );
}
