import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, listAll, type Customer, type Job, type ServicePlan } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useRoles } from "../lib/auth";
import { fmtDate, todayEastern } from "../lib/format";
import { planCadence } from "../lib/planCadence";
import {
  Badge,
  Button,
  Card,
  CollapsibleCard,
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
  const [cancelPlanId, setCancelPlanId] = useState<string | null>(null);

  const { data: mine, error: mineError } = useAsync<{
    customers: Customer[];
    jobs: Job[];
  } | null>(
    async () => {
      // Roles are still resolving — resolving to null keeps the spinner up,
      // exactly as the old effect's early return did.
      if (roles.loading) return null;
      const customers = await loadMyCustomers(roles);
      const jobLists = await Promise.all(
        customers.map((c) =>
          listAll((t) =>
            api().models.Job.list({
              filter: { customerId: { eq: c.id } },
              limit: 200,
              nextToken: t,
            })
          )
        )
      );
      return { customers, jobs: jobLists.flat() };
    },
    [roles],
    "Could not load"
  );
  const customers = mine?.customers ?? null;
  const jobs = mine?.jobs ?? [];

  // Plans load on their own so a plan cancellation can refresh JUST the plans,
  // the way the old loadPlans callback did.
  const {
    data: planRows,
    error: plansError,
    reload: reloadPlans,
  } = useAsync<ServicePlan[]>(
    async () => {
      if (!customers) return [];
      const planLists = await Promise.all(
        customers.map((c) =>
          listAll((t) =>
            api().models.ServicePlan.list({
              filter: { customerId: { eq: c.id } },
              limit: 50,
              nextToken: t,
            })
          )
        )
      );
      return planLists.flat();
    },
    [customers],
    "Could not load"
  );
  const plans = planRows ?? [];
  const error = mineError ?? plansError;

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
  // A management-company login sees several properties in one list, so every
  // row has to say which property it belongs to. A single-property login has no
  // ambiguity, so the label is omitted there.
  const nameOf = (customerId?: string | null) =>
    customers.length > 1
      ? (customers.find((c) => c.id === customerId)?.displayName ?? null)
      : null;
  const nameFor = (j: Job) => nameOf(j.customerId);

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
            <CollapsibleCard
              title={activePlans.length === 1 ? "My plan" : "My plans"}
              count={activePlans.length}
              summary="Your active service plans. Open to review or cancel."
            >
              {activePlans.map((p) => {
                const propertyName = nameOf(p.customerId);
                return (
                <ListRow
                  key={p.id}
                  title={propertyName ? `${propertyName} — ${p.planName}` : p.planName}
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
                );
              })}
            </CollapsibleCard>
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

          <CollapsibleCard
            title="Service history"
            count={past.length}
            summary={
              past.length === 0
                ? "No completed services yet."
                : "Your completed visits. Open to review."
            }
          >
            {past.slice(0, 10).map((j) => (
              <ListRow
                key={j.id}
                title={j.serviceType}
                subtitle={nameFor(j) ?? undefined}
                meta={<span>{fmtDate(j.scheduledDate, true)}</span>}
              />
            ))}
          </CollapsibleCard>
        </>
      )}

      {cancelPlanId ? (
        <CancelPlanSheet
          servicePlanId={cancelPlanId}
          open
          onClose={() => setCancelPlanId(null)}
          onCanceled={() => reloadPlans()}
        />
      ) : null}
    </Page>
  );
}
