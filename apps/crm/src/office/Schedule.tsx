import { useCallback, useEffect, useState } from "react";
import {
  api,
  unwrap,
  type Customer,
  type Job,
  type Route,
  type Technician,
} from "../lib/api";
import { addDays, fmtDate, prettyWeekday, todayEastern } from "../lib/format";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNote,
  Field,
  ListRow,
  Page,
  Sheet,
  Spinner,
  StatusBadge,
} from "../ui/kit";

/**
 * Day board: one card per active technician (their route for the selected
 * day — created on demand, so every tech always has a daily route), plus
 * the "needs scheduling" pool of unassigned jobs.
 */
export default function Schedule() {
  const [date, setDate] = useState(todayEastern());
  const [techs, setTechs] = useState<Technician[] | null>(null);
  const [routes, setRoutes] = useState<Route[]>([]);
  const [dayJobs, setDayJobs] = useState<Job[]>([]);
  const [poolJobs, setPoolJobs] = useState<Job[]>([]);
  const [customers, setCustomers] = useState<Map<string, Customer>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [assigning, setAssigning] = useState<Job | null>(null);
  const [addingTech, setAddingTech] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [techList, routeList, jobsOnDate, unscheduled, customerList] =
        await Promise.all([
          api().models.Technician.list({ limit: 200 }),
          api().models.Route.listRouteByDate({ date }, { limit: 200 }),
          api().models.Job.listJobByScheduledDate(
            { scheduledDate: date },
            { limit: 500 }
          ),
          api().models.Job.list({
            filter: { status: { eq: "UNSCHEDULED" } },
            limit: 500,
          }),
          api().models.Customer.list({ limit: 1000 }),
        ]);
      setTechs(unwrap(techList).filter((t) => t.active));
      setRoutes(unwrap(routeList));
      const onDate = unwrap(jobsOnDate).filter((j) => j.status !== "CANCELED");
      setDayJobs(onDate);
      setPoolJobs([
        ...onDate.filter((j) => !j.routeId),
        ...unwrap(unscheduled).filter((j) => j.scheduledDate !== date),
      ]);
      setCustomers(new Map(unwrap(customerList).map((c) => [c.id, c])));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load schedule");
    }
  }, [date]);

  useEffect(() => {
    setTechs(null);
    void load();
  }, [load]);

  /** Every technician has a daily route by default — created on first use. */
  const ensureRoute = async (technicianId: string): Promise<Route> => {
    const existing = routes.find((r) => r.technicianId === technicianId);
    if (existing) return existing;
    const created = unwrap(
      await api().models.Route.create({
        technicianId,
        date,
        status: "PLANNED",
      })
    );
    if (!created) throw new Error("Could not create route");
    return created;
  };

  const assign = async (job: Job, technicianId: string) => {
    setBusy(job.id);
    setError(null);
    try {
      const route = await ensureRoute(technicianId);
      const order =
        Math.max(
          0,
          ...dayJobs
            .filter((j) => j.routeId === route.id)
            .map((j) => j.routeOrder ?? 0)
        ) + 1;
      unwrap(
        await api().models.Job.update({
          id: job.id,
          routeId: route.id,
          technicianId,
          routeOrder: order,
          scheduledDate: date,
          status: "SCHEDULED",
        })
      );
      setAssigning(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not assign job");
    } finally {
      setBusy(null);
    }
  };

  const unassign = async (job: Job) => {
    setBusy(job.id);
    try {
      unwrap(
        await api().models.Job.update({
          id: job.id,
          routeId: null,
          technicianId: null,
          routeOrder: null,
          status: "UNSCHEDULED",
        })
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not unassign");
    } finally {
      setBusy(null);
    }
  };

  const bump = async (job: Job, dir: -1 | 1, routeJobs: Job[]) => {
    const idx = routeJobs.findIndex((j) => j.id === job.id);
    const swap = routeJobs[idx + dir];
    if (!swap) return;
    setBusy(job.id);
    try {
      await Promise.all([
        api().models.Job.update({ id: job.id, routeOrder: swap.routeOrder ?? 0 }),
        api().models.Job.update({ id: swap.id, routeOrder: job.routeOrder ?? 0 }),
      ]);
      await load();
    } finally {
      setBusy(null);
    }
  };

  const customerName = (j: Job) =>
    customers.get(j.customerId)?.displayName ?? "…";
  const customerCity = (j: Job) => customers.get(j.customerId)?.serviceCity;

  return (
    <Page
      title="Schedule"
      actions={
        <Button small variant="ghost" onClick={() => setAddingTech(true)}>
          + Tech
        </Button>
      }
    >
      <Card>
        <div className="row-split">
          <Button small variant="ghost" onClick={() => setDate(addDays(date, -1))}>
            ‹ Prev
          </Button>
          <div style={{ textAlign: "center" }}>
            <strong>{prettyWeekday(date)}</strong>
            {date !== todayEastern() ? (
              <div>
                <Button small variant="subtle" onClick={() => setDate(todayEastern())}>
                  Jump to today
                </Button>
              </div>
            ) : null}
          </div>
          <Button small variant="ghost" onClick={() => setDate(addDays(date, 1))}>
            Next ›
          </Button>
        </div>
      </Card>

      <ErrorNote error={error} />
      {!techs ? (
        <Spinner />
      ) : (
        <>
          {poolJobs.length > 0 ? (
            <Card title={`Needs scheduling (${poolJobs.length})`}>
              {poolJobs.map((j) => (
                <ListRow
                  key={j.id}
                  title={customerName(j)}
                  subtitle={`${j.serviceType}${j.scheduledDate && j.scheduledDate !== date ? ` · wants ${fmtDate(j.scheduledDate)}` : ""}${customerCity(j) ? ` · ${customerCity(j)}` : ""}`}
                  meta={
                    <Button
                      small
                      variant="subtle"
                      loading={busy === j.id}
                      onClick={() => setAssigning(j)}
                    >
                      Assign
                    </Button>
                  }
                />
              ))}
            </Card>
          ) : null}

          {techs.length === 0 ? (
            <EmptyState
              title="No technicians yet"
              body="Add your technicians to start building daily routes."
              action={<Button onClick={() => setAddingTech(true)}>Add technician</Button>}
            />
          ) : (
            techs.map((tech) => {
              const route = routes.find((r) => r.technicianId === tech.id);
              const routeJobs = dayJobs
                .filter((j) => j.routeId && j.routeId === route?.id)
                .sort((a, b) => (a.routeOrder ?? 0) - (b.routeOrder ?? 0));
              return (
                <Card
                  key={tech.id}
                  title={`${tech.name} — ${routeJobs.length} stop${routeJobs.length === 1 ? "" : "s"}`}
                  actions={route ? <StatusBadge status={route.status} /> : <Badge tone="muted">empty route</Badge>}
                >
                  {routeJobs.length === 0 ? (
                    <p className="muted small">No stops on this day's route.</p>
                  ) : (
                    routeJobs.map((j, i) => (
                      <ListRow
                        key={j.id}
                        title={`${i + 1}. ${customerName(j)}`}
                        subtitle={`${j.serviceType}${j.timeWindow ? ` · ${j.timeWindow}` : ""}`}
                        meta={
                          <>
                            <StatusBadge status={j.status} />
                            <span style={{ display: "inline-flex", gap: 4 }}>
                              <Button small variant="ghost" disabled={i === 0 || busy === j.id} onClick={() => void bump(j, -1, routeJobs)}>
                                ↑
                              </Button>
                              <Button small variant="ghost" disabled={i === routeJobs.length - 1 || busy === j.id} onClick={() => void bump(j, 1, routeJobs)}>
                                ↓
                              </Button>
                              <Button small variant="ghost" loading={busy === j.id} onClick={() => void unassign(j)}>
                                ✕
                              </Button>
                            </span>
                          </>
                        }
                      />
                    ))
                  )}
                </Card>
              );
            })
          )}
        </>
      )}

      <Sheet
        open={assigning !== null}
        onClose={() => setAssigning(null)}
        title={`Assign — ${assigning ? customerName(assigning) : ""}`}
      >
        <p className="muted small">
          Assign to a technician's route for {prettyWeekday(date)}.
        </p>
        {(techs ?? []).map((t) => (
          <Button
            key={t.id}
            block
            variant="ghost"
            loading={busy === assigning?.id}
            onClick={() => assigning && void assign(assigning, t.id)}
          >
            {t.name}
          </Button>
        ))}
      </Sheet>

      <Sheet open={addingTech} onClose={() => setAddingTech(false)} title="New technician">
        <TechForm
          onDone={async () => {
            setAddingTech(false);
            await load();
          }}
        />
      </Sheet>
    </Page>
  );
}

function TechForm({ onDone }: { onDone: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [invite, setInvite] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="form-grid">
      <Field label="Name">
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Email" hint="Needed for their CRM login">
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </Field>
      <Field label="Phone">
        <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
      </Field>
      <label className="row-split" style={{ fontSize: 14 }}>
        <span>Email them a CRM login invite</span>
        <input
          type="checkbox"
          style={{ width: "auto" }}
          checked={invite}
          onChange={(e) => setInvite(e.target.checked)}
        />
      </label>
      <ErrorNote error={error} />
      <Button
        block
        loading={busy}
        onClick={() => {
          if (!name.trim()) {
            setError("Name is required");
            return;
          }
          if (invite && !email.trim()) {
            setError("Email is required to send a login invite");
            return;
          }
          setBusy(true);
          (async () => {
            const created = unwrap(
              await api().models.Technician.create({
                name: name.trim(),
                email: email.trim() || undefined,
                phone: phone.trim() || undefined,
                active: true,
              })
            );
            if (invite && created) {
              unwrap(
                await api().mutations.adminCreateUser({
                  email: email.trim(),
                  name: name.trim(),
                  roles: ["TECH"],
                  technicianId: created.id,
                })
              );
            }
            await onDone();
          })().catch((err) => {
            setError(err.message ?? "Could not add technician");
            setBusy(false);
          });
        }}
      >
        Add technician
      </Button>
    </div>
  );
}
