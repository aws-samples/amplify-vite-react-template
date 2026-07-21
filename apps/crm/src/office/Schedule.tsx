import { useCallback, useEffect, useState } from "react";
import {
  api,
  listAll,
  opResult,
  saveTechnicianLicense,
  setLicenseStatus,
  STAFF_OFFBOARD_REASONS,
  unwrap,
  type Customer,
  type Job,
  type Route,
  type Technician,
  type TechnicianLicenseRecord,
} from "../lib/api";
import { useRoles } from "../lib/auth";
import {
  addDays,
  fmtDate,
  prettyWeekday,
  startOfWeek,
  todayEastern,
} from "../lib/format";
import { assignBlockedNote, unassignBlockedNote } from "../lib/unassignStop";
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

function technicianComplianceIssue(
  technician: Technician,
  workDate: string
): string | null {
  if (!technician.licenseNumber?.trim()) return "license number missing";
  if (!technician.licenseExpiresOn) return "license expiration missing";
  if (technician.licenseExpiresOn < workDate) {
    return `license expired ${fmtDate(technician.licenseExpiresOn, true)}`;
  }
  return null;
}

const DOW_LABEL = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/**
 * The schedule: a list of technicians, each with their own week calendar.
 * Every tech card shows a Mon–Sun strip (stop count per day) over the
 * shared focused day, whose stops appear beneath the strip with the
 * routing controls. The "needs scheduling" pool assigns onto the focused
 * day, and the day's booking-availability / time-off controls collapse
 * below the list.
 */
export default function Schedule() {
  const [weekStart, setWeekStart] = useState(() => startOfWeek(todayEastern()));
  const [selDate, setSelDate] = useState(todayEastern());
  const [techs, setTechs] = useState<Technician[] | null>(null);
  const [routes, setRoutes] = useState<Route[]>([]);
  const [weekJobs, setWeekJobs] = useState<Job[]>([]);
  const [poolJobs, setPoolJobs] = useState<Job[]>([]);
  const [customers, setCustomers] = useState<Map<string, Customer>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [assigning, setAssigning] = useState<Job | null>(null);
  const [addingTech, setAddingTech] = useState(false);
  const [editingTech, setEditingTech] = useState<Technician | null>(null);
  const [showCapacity, setShowCapacity] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const weekDays = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const thisWeekStart = startOfWeek(todayEastern());

  const load = useCallback(async () => {
    setError(null);
    const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
    try {
      // Every list is paged to exhaustion: a filtered scan counts the limit
      // against rows scanned, not rows matched, so a single page can silently
      // drop stops from the board and the pool past a few hundred jobs. The
      // week's jobs and routes are each loaded per day (there is no by-week
      // index), so switching the focused day inside the week never refetches.
      const [techList, routesByDay, jobsByDay, unscheduled, customerList] =
        await Promise.all([
          listAll((t) =>
            api().models.Technician.list({ limit: 200, nextToken: t })
          ),
          Promise.all(
            days.map((d) =>
              listAll((t) =>
                api().models.Route.listRouteByDate(
                  { date: d },
                  { limit: 200, nextToken: t }
                )
              )
            )
          ),
          Promise.all(
            days.map((d) =>
              listAll((t) =>
                api().models.Job.listJobByScheduledDate(
                  { scheduledDate: d },
                  { limit: 500, nextToken: t }
                )
              )
            )
          ),
          listAll((t) =>
            api().models.Job.list({
              filter: { status: { eq: "UNSCHEDULED" } },
              limit: 500,
              nextToken: t,
            })
          ),
          listAll((t) =>
            api().models.Customer.list({ limit: 1000, nextToken: t })
          ),
        ]);
      setTechs(techList.filter((t) => t.active));
      setRoutes(routesByDay.flat());
      const inWeek = jobsByDay.flat().filter((j) => j.status !== "CANCELED");
      setWeekJobs(inWeek);
      // COMPLETED / IN_PROGRESS / CANCELED never belong in the pool. A
      // NO_ACCESS visit does, but only to be rebooked — the render offers
      // Rebook, not Assign — so it is let through the assign-blocked filter.
      // Dated-but-unrouted stops anywhere in the week join the always-present
      // UNSCHEDULED jobs; dedupe by id so a row can't appear twice.
      const pool = new Map<string, Job>();
      for (const j of inWeek) {
        if (!j.routeId && (!assignBlockedNote(j.status) || j.status === "NO_ACCESS")) {
          pool.set(j.id, j);
        }
      }
      for (const j of unscheduled) pool.set(j.id, j);
      setPoolJobs([...pool.values()]);
      setCustomers(new Map(customerList.map((c) => [c.id, c])));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load schedule");
    }
  }, [weekStart]);

  useEffect(() => {
    setTechs(null);
    void load();
  }, [load]);

  /** Every technician has a daily route by default — created on first use. */
  const ensureRoute = async (
    technicianId: string,
    day: string
  ): Promise<Route> => {
    const existing = routes.find(
      (r) => r.technicianId === technicianId && r.date === day
    );
    if (existing) return existing;
    const created = unwrap(
      await api().models.Route.create({
        technicianId,
        date: day,
        status: "PLANNED",
      })
    );
    if (!created) throw new Error("Could not create route");
    return created;
  };

  const assign = async (job: Job, technicianId: string) => {
    // Guarded like unassign: the board schedules, it never rewrites history.
    // Terminal visits (completed / canceled / no-access) are blocked here —
    // a no-access visit is rebooked as a new linked stop, never reassigned.
    const blocked = assignBlockedNote(job.status);
    if (blocked) {
      setError(`Can't assign this stop: ${blocked}`);
      return;
    }
    setBusy(job.id);
    setError(null);
    try {
      // Pool assignment lands on the focused day.
      const route = await ensureRoute(technicianId, selDate);
      const order =
        Math.max(
          0,
          ...weekJobs
            .filter((j) => j.routeId === route.id)
            .map((j) => j.routeOrder ?? 0)
        ) + 1;
      opResult(
        await api().mutations.updateJobSchedule({
          jobId: job.id,
          operation: "ASSIGN",
          routeId: route.id,
          technicianId,
          routeOrder: order,
          scheduledDate: selDate,
          // The board is the routing surface — its controlled reason IS routing.
          reasonCode: "ROUTING",
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

  // Rebook a no-access visit as a NEW linked stop. The terminal visit — its
  // reason, time, note, and door photo — stays untouched; the server creates
  // a fresh UNSCHEDULED job pointing back at it.
  const rebook = async (job: Job) => {
    if (
      !window.confirm(
        `Rebook ${customerName(job)}'s no-access visit as a new stop to schedule? The no-access record (reason, note, photo) stays on file untouched.`
      )
    )
      return;
    setBusy(job.id);
    setError(null);
    try {
      opResult(await api().mutations.rebookJob({ jobId: job.id }));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not rebook");
    } finally {
      setBusy(null);
    }
  };

  const unassign = async (job: Job) => {
    // The board schedules; it never rewrites history. Guarded here as well as
    // at render, so nothing can flip a COMPLETED or IN_PROGRESS stop — status
    // is what billing, the recurring engine, and the pesticide record key off.
    const techName =
      techs?.find((t) => t.id === job.technicianId)?.name ?? "the technician";
    const blocked = unassignBlockedNote(job.status, techName);
    if (blocked) {
      setError(`Can't unassign this stop: ${blocked}`);
      return;
    }
    setBusy(job.id);
    try {
      opResult(
        await api().mutations.updateJobSchedule({
          jobId: job.id,
          operation: "UNASSIGN",
          reasonCode: "ROUTING",
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
      opResult(
        await api().mutations.updateJobSchedule({
          jobId: job.id,
          operation: "REORDER",
          routeOrder: swap.routeOrder ?? 0,
          otherJobId: swap.id,
          otherRouteOrder: job.routeOrder ?? 0,
        })
      );
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
        <div className="row-split sched-weeknav">
          <Button
            small
            variant="ghost"
            onClick={() => {
              setWeekStart(addDays(weekStart, -7));
              setSelDate(addDays(selDate, -7));
            }}
          >
            ‹ Prev week
          </Button>
          <div className="sched-weeknav-range">
            <strong>
              {fmtDate(weekStart)} – {fmtDate(addDays(weekStart, 6))}
            </strong>
            <span>Showing {prettyWeekday(selDate)}</span>
            {weekStart !== thisWeekStart ? (
              <div>
                <Button
                  small
                  variant="subtle"
                  onClick={() => {
                    setWeekStart(thisWeekStart);
                    setSelDate(todayEastern());
                  }}
                >
                  Jump to this week
                </Button>
              </div>
            ) : null}
          </div>
          <Button
            small
            variant="ghost"
            onClick={() => {
              setWeekStart(addDays(weekStart, 7));
              setSelDate(addDays(selDate, 7));
            }}
          >
            Next week ›
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
              <p className="muted small" style={{ marginTop: 0 }}>
                Assigning adds the stop to {prettyWeekday(selDate)} — pick a
                different day on any technician below to change that.
              </p>
              {poolJobs.map((j) => (
                <ListRow
                  key={j.id}
                  title={customerName(j)}
                  subtitle={`${j.serviceType}${j.scheduledDate && j.scheduledDate !== selDate ? ` · wants ${fmtDate(j.scheduledDate)}` : ""}${customerCity(j) ? ` · ${customerCity(j)}` : ""}${!j.paidAt && j.paymentPendingIntentId ? " · payment pending (bank)" : ""}`}
                  meta={
                    j.status === "NO_ACCESS" ? (
                      <>
                        <StatusBadge status={j.status} />
                        <Button
                          small
                          variant="subtle"
                          loading={busy === j.id}
                          onClick={() => void rebook(j)}
                        >
                          Rebook
                        </Button>
                      </>
                    ) : (
                      <Button
                        small
                        variant="subtle"
                        loading={busy === j.id}
                        onClick={() => setAssigning(j)}
                      >
                        Assign
                      </Button>
                    )
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
              // One glance at the week comes straight from the jobs — a stop's
              // technicianId + scheduledDate is its assignment, no per-day
              // route lookup needed for the counts.
              const techJobs = weekJobs.filter(
                (j) => j.routeId && j.technicianId === tech.id
              );
              const dayJobs = techJobs
                .filter((j) => j.scheduledDate === selDate)
                .sort((a, b) => (a.routeOrder ?? 0) - (b.routeOrder ?? 0));
              const complianceIssue = technicianComplianceIssue(tech, selDate);
              const route = routes.find(
                (r) => r.technicianId === tech.id && r.date === selDate
              );
              const weekTotal = techJobs.length;
              return (
                <Card
                  key={tech.id}
                  title={`${tech.name} — ${weekTotal} stop${weekTotal === 1 ? "" : "s"} this week`}
                  actions={
                    <>
                      {complianceIssue ? (
                        <Badge tone="warn">{complianceIssue}</Badge>
                      ) : (
                        <Badge tone="ok">license current</Badge>
                      )}
                      <Button small variant="ghost" onClick={() => setEditingTech(tech)}>
                        Edit
                      </Button>
                    </>
                  }
                >
                  <div className="tech-week" role="group" aria-label={`${tech.name} week`}>
                    {weekDays.map((d, i) => {
                      const count = techJobs.filter(
                        (j) => j.scheduledDate === d
                      ).length;
                      const isActive = d === selDate;
                      const isToday = d === todayEastern();
                      return (
                        <button
                          key={d}
                          type="button"
                          aria-pressed={isActive}
                          className={`tech-day${count ? " has-stops" : ""}${isActive ? " is-active" : ""}${isToday ? " is-today" : ""}`}
                          onClick={() => setSelDate(d)}
                        >
                          <span className="tech-day-dow">{DOW_LABEL[i]}</span>
                          <span className="tech-day-num">{Number(d.slice(8, 10))}</span>
                          <span className="tech-day-count">
                            {count ? `${count} stop${count === 1 ? "" : "s"}` : "—"}
                          </span>
                        </button>
                      );
                    })}
                  </div>

                  <div className="tech-day-detail">
                    <div className="row-split tech-day-detail-head">
                      <strong>{prettyWeekday(selDate)}</strong>
                      {route ? (
                        <StatusBadge status={route.status} />
                      ) : (
                        <Badge tone="muted">no route yet</Badge>
                      )}
                    </div>
                    {dayJobs.length === 0 ? (
                      <p className="muted small">No stops on this day.</p>
                    ) : (
                      dayJobs.map((j, i) => {
                        const blocked = unassignBlockedNote(j.status, tech.name);
                        return (
                          <ListRow
                            key={j.id}
                            title={`${i + 1}. ${customerName(j)}`}
                            subtitle={`${j.serviceType}${!j.paidAt && j.paymentPendingIntentId ? " · payment pending (bank)" : ""}`}
                            meta={
                              <>
                                <StatusBadge status={j.status} />
                                <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                                  <Button small variant="ghost" disabled={i === 0 || busy === j.id} onClick={() => void bump(j, -1, dayJobs)}>
                                    ↑
                                  </Button>
                                  <Button small variant="ghost" disabled={i === dayJobs.length - 1 || busy === j.id} onClick={() => void bump(j, 1, dayJobs)}>
                                    ↓
                                  </Button>
                                  {/* ✕ is a scheduling move, not an eraser: a
                                      completed or in-progress stop gets the
                                      honest words instead of a status flip. */}
                                  {blocked ? (
                                    <span className="muted small">{blocked}</span>
                                  ) : (
                                    <Button small variant="ghost" loading={busy === j.id} onClick={() => void unassign(j)}>
                                      ✕
                                    </Button>
                                  )}
                                </span>
                              </>
                            }
                          />
                        );
                      })
                    )}
                  </div>
                </Card>
              );
            })
          )}

          <Card className="sched-capacity">
            <button
              type="button"
              className="sched-capacity-toggle row-split"
              aria-expanded={showCapacity}
              onClick={() => setShowCapacity((v) => !v)}
            >
              <strong>Booking availability & time off</strong>
              <span aria-hidden="true">{showCapacity ? "▲" : "▼"}</span>
            </button>
            {showCapacity ? (
              <AvailabilityPanel date={selDate} techs={techs ?? []} />
            ) : (
              <p className="muted small" style={{ margin: "8px 0 0" }}>
                Capacity for {prettyWeekday(selDate)}, company closures, and
                technician PTO. Open to review or edit.
              </p>
            )}
          </Card>
        </>
      )}

      <Sheet
        open={assigning !== null}
        onClose={() => setAssigning(null)}
        title={`Assign — ${assigning ? customerName(assigning) : ""}`}
      >
        <p className="muted small">
          Assign to a technician's route for {prettyWeekday(selDate)}.
        </p>
        {(techs ?? []).map((t) => (
          <Button
            key={t.id}
            block
            variant="ghost"
            disabled={technicianComplianceIssue(t, selDate) !== null}
            loading={busy === assigning?.id}
            onClick={() => assigning && void assign(assigning, t.id)}
          >
            {t.name}
            {technicianComplianceIssue(t, selDate)
              ? ` — ${technicianComplianceIssue(t, selDate)}`
              : ""}
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

      <Sheet
        open={editingTech !== null}
        onClose={() => setEditingTech(null)}
        title="Edit technician"
      >
        {editingTech ? (
          <TechForm
            existing={editingTech}
            onDone={async () => {
              setEditingTech(null);
              await load();
            }}
          />
        ) : null}
      </Sheet>
    </Page>
  );
}

/**
 * GL-17 — a technician's one-to-many licence records: full history always
 * visible, office adds renewals with evidence, and only an owner (the
 * Compliance seat) flips a record's status. The single legacy licence fields
 * remain the fallback until a technician has records.
 */
/**
 * GL-04 — the day's capacity truth and its levers: WHY the selected date is
 * (or isn't) sellable, the company closure for the day, and per-technician
 * PTO — maintained here by the office, enforced everywhere by the one shared
 * minute rule.
 */
function AvailabilityPanel({
  date,
  techs,
}: {
  date: string;
  techs: Technician[];
}) {
  // We schedule for the DAY: one 540-minute bucket per technician.
  type DayFacts = {
    eligibleTechs: number;
    technicians: {
      technicianId: string;
      technicianName: string;
      committedMinutes: number;
      dayMinutes: number;
      verified: boolean;
    }[];
    poolMinutes: number;
    liveCheckoutClaims: number;
    sellable: boolean;
    reasons: string[];
  };
  type ExceptionRow = {
    id: string;
    technicianId: string;
    date: string;
    kind: string;
    reason: string;
  };
  const [facts, setFacts] = useState<DayFacts | null>(null);
  const [exceptions, setExceptions] = useState<ExceptionRow[]>([]);
  const [closureReason, setClosureReason] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ptoTech, setPtoTech] = useState("");
  const [ptoReason, setPtoReason] = useState("");
  const [newClosure, setNewClosure] = useState("");
  const [showClosureForm, setShowClosureForm] = useState(false);
  const [showPtoForm, setShowPtoForm] = useState(false);

  const models = api().models as unknown as {
    TechnicianDayException: {
      listTechnicianDayExceptionByDate: (
        input: { date: string },
        opts?: { limit?: number }
      ) => Promise<{ data: ExceptionRow[] }>;
      create: (input: Record<string, unknown>) => Promise<{ data: unknown }>;
      delete: (input: { id: string }) => Promise<{ data: unknown }>;
    };
    CompanyClosure: {
      get: (input: { id: string }) => Promise<{ data: { reason?: string } | null }>;
      create: (input: Record<string, unknown>) => Promise<{ data: unknown }>;
      delete: (input: { id: string }) => Promise<{ data: unknown }>;
    };
  };

  const refresh = useCallback(async () => {
    setErr(null);
    try {
      const [factsRes, exRes, closureRes] = await Promise.all([
        (api().queries as unknown as {
          capacityDayFacts: (input: { date: string }) => Promise<{ data: unknown }>;
        }).capacityDayFacts({ date }),
        models.TechnicianDayException.listTechnicianDayExceptionByDate(
          { date },
          { limit: 200 }
        ),
        models.CompanyClosure.get({ id: date }),
      ]);
      const parsed =
        typeof factsRes.data === "string"
          ? (JSON.parse(factsRes.data) as DayFacts)
          : (factsRes.data as DayFacts);
      setFacts(parsed);
      setExceptions(exRes.data ?? []);
      setClosureReason(closureRes.data?.reason ?? null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not read the day's capacity");
    }
  }, [date]);

  useEffect(() => {
    // Never leave the prior day's facts or a half-entered exception on screen
    // after the office changes dates.
    setFacts(null);
    setExceptions([]);
    setClosureReason(null);
    setNewClosure("");
    setPtoTech("");
    setPtoReason("");
    setShowClosureForm(false);
    setShowPtoForm(false);
    void refresh();
  }, [refresh]);

  const act = async (
    fn: () => Promise<unknown>,
    onSaved?: () => void
  ) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      await refresh();
      onSaved?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "The change did not save");
    } finally {
      setBusy(false);
    }
  };

  const pto = exceptions.filter((e) => e.kind === "PTO");
  const readableDate = prettyWeekday(date);

  // Scheduling is day-level: one 540-minute working day per technician.
  const dayTechs = facts?.technicians ?? [];
  const dayPoolMinutes = facts?.poolMinutes ?? 0;

  return (
    <>
      <Card
        title={`Booking availability · ${readableDate}`}
        actions={
          err ? (
            <Badge tone="danger">Unavailable</Badge>
          ) : facts ? (
            <Badge tone={facts.sellable ? "ok" : "danger"}>
              {facts.sellable ? "Open for booking" : "Not bookable"}
            </Badge>
          ) : (
            <Badge tone="muted">Checking…</Badge>
          )
        }
        className="availability-card"
      >
        <ErrorNote error={err} />
        {facts ? (
          <>
            <div className="availability-summary" aria-label="Day capacity summary">
              <div>
                <span>Available technicians</span>
                <strong>{facts.eligibleTechs}</strong>
              </div>
              <div>
                <span>Customers checking out now</span>
                <strong>{facts.liveCheckoutClaims}</strong>
              </div>
            </div>

            <div className="availability-day-capacity">
              {dayTechs.length === 0 ? (
                <p className="availability-empty">No eligible technician.</p>
              ) : (
                <div className="availability-tech-list">
                  {dayTechs.map((t) => (
                    <div className="availability-tech" key={t.technicianId}>
                      <div>
                        <strong>{t.technicianName}</strong>
                        <span>
                          {t.committedMinutes} of {t.dayMinutes} minutes scheduled
                        </span>
                      </div>
                      {!t.verified ? (
                        <Badge tone="warn">Not verified</Badge>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}

              {dayPoolMinutes ? (
                <p className="availability-pool">
                  {dayPoolMinutes} minutes still awaiting technician assignment
                </p>
              ) : null}
            </div>

            {facts.reasons.length ? (
              <div className="availability-reasons">
                <strong>What is limiting availability</strong>
                <ul>
                  {facts.reasons.map((reason, index) => (
                    <li key={index}>{reason}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        ) : err ? null : (
          <div className="availability-loading" role="status">
            <span className="btn-spinner" />
            Checking routes, PTO, and remaining capacity…
          </div>
        )}
      </Card>

      <Card title="Time off & closures" className="availability-controls-card">
        <p className="availability-controls-intro">
          Manage exceptions for {readableDate}. These changes immediately affect
          what the office and online checkout can schedule.
        </p>

        {err || !facts ? (
          <div className="availability-controls-unavailable">
            <div>
              <strong>Schedule controls are temporarily unavailable</strong>
              <span>Reload the day before recording a closure or PTO.</span>
            </div>
            <Button small variant="ghost" loading={busy} onClick={() => void refresh()}>
              Try again
            </Button>
          </div>
        ) : (
          <div className="availability-control-list">
            <section className="availability-control-section">
              <div className="availability-control-heading">
                <div>
                  <strong>Company schedule</strong>
                  <span>Controls availability for every technician.</span>
                </div>
                {!closureReason && !showClosureForm ? (
                  <Button
                    small
                    variant="danger"
                    disabled={busy}
                    onClick={() => setShowClosureForm(true)}
                  >
                    Close this day
                  </Button>
                ) : null}
              </div>

              {closureReason ? (
                <div className="availability-closure-active">
                  <div>
                    <Badge tone="danger">Company closed</Badge>
                    <strong>{closureReason}</strong>
                  </div>
                  <Button
                    small
                    variant="ghost"
                    loading={busy}
                    onClick={() =>
                      void act(() => models.CompanyClosure.delete({ id: date }))
                    }
                  >
                    Reopen this day
                  </Button>
                </div>
              ) : showClosureForm ? (
                <div className="availability-action-form availability-action-form-danger">
                  <Field
                    label="Reason for closing"
                    hint="Required. This prevents new bookings for the entire company."
                  >
                    <input
                      autoFocus
                      placeholder="Example: Company holiday"
                      value={newClosure}
                      onChange={(e) => setNewClosure(e.target.value)}
                    />
                  </Field>
                  <div className="availability-form-actions">
                    <Button
                      small
                      variant="ghost"
                      disabled={busy}
                      onClick={() => {
                        setNewClosure("");
                        setShowClosureForm(false);
                      }}
                    >
                      Cancel
                    </Button>
                    <Button
                      small
                      variant="danger"
                      loading={busy}
                      disabled={!newClosure.trim()}
                      onClick={() =>
                        void act(
                          () =>
                            models.CompanyClosure.create({
                              id: date,
                              date,
                              reason: newClosure.trim(),
                            }),
                          () => {
                            setNewClosure("");
                            setShowClosureForm(false);
                          }
                        )
                      }
                    >
                      Confirm company closure
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="availability-open-state">
                  <Badge tone="ok">Open</Badge>
                  <span>No company closure is recorded.</span>
                </div>
              )}
            </section>

            <section className="availability-control-section">
              <div className="availability-control-heading">
                <div>
                  <strong>Technician PTO</strong>
                  <span>Removes only the selected technician from capacity.</span>
                </div>
                {!showPtoForm ? (
                  <Button
                    small
                    variant="ghost"
                    disabled={busy || techs.length === 0}
                    onClick={() => setShowPtoForm(true)}
                  >
                    + Add PTO
                  </Button>
                ) : null}
              </div>

              {pto.length ? (
                <div className="availability-pto-list">
                  {pto.map((exception) => (
                    <div className="availability-pto-row" key={exception.id}>
                      <div>
                        <strong>
                          {techs.find((t) => t.id === exception.technicianId)?.name ??
                            exception.technicianId}
                        </strong>
                        <span>{exception.reason}</span>
                      </div>
                      <Button
                        small
                        variant="danger"
                        loading={busy}
                        onClick={() =>
                          void act(() =>
                            models.TechnicianDayException.delete({
                              id: exception.id,
                            })
                          )
                        }
                      >
                        Remove
                      </Button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="availability-empty">No technician PTO recorded.</p>
              )}

              {showPtoForm ? (
                <div className="availability-action-form">
                  <div className="availability-pto-fields">
                    <Field label="Technician">
                      <select
                        autoFocus
                        value={ptoTech}
                        onChange={(e) => setPtoTech(e.target.value)}
                      >
                        <option value="">Select a technician</option>
                        {techs.map((tech) => (
                          <option key={tech.id} value={tech.id}>
                            {tech.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Reason">
                      <input
                        placeholder="Example: Vacation"
                        value={ptoReason}
                        onChange={(e) => setPtoReason(e.target.value)}
                      />
                    </Field>
                  </div>
                  <div className="availability-form-actions">
                    <Button
                      small
                      variant="ghost"
                      disabled={busy}
                      onClick={() => {
                        setPtoTech("");
                        setPtoReason("");
                        setShowPtoForm(false);
                      }}
                    >
                      Cancel
                    </Button>
                    <Button
                      small
                      loading={busy}
                      disabled={!ptoTech || !ptoReason.trim()}
                      onClick={() =>
                        void act(
                          () =>
                            models.TechnicianDayException.create({
                              technicianId: ptoTech,
                              date,
                              kind: "PTO",
                              reason: ptoReason.trim(),
                            }),
                          () => {
                            setPtoTech("");
                            setPtoReason("");
                            setShowPtoForm(false);
                          }
                        )
                      }
                    >
                      Save PTO
                    </Button>
                  </div>
                </div>
              ) : null}
            </section>
          </div>
        )}
      </Card>
    </>
  );
}

function LicenseRecords({ technicianId }: { technicianId: string }) {
  const roles = useRoles();
  const [records, setRecords] = useState<TechnicianLicenseRecord[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [number, setNumber] = useState("");
  const [licenseType, setLicenseType] = useState("");
  const [issuer, setIssuer] = useState("");
  const [expiresOn, setExpiresOn] = useState("");
  const [evidenceNote, setEvidenceNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await (
        api().models as unknown as {
          TechnicianLicense: {
            listTechnicianLicenseByTechnicianId: (
              q: { technicianId: string },
              o: { limit: number }
            ) => Promise<{ data: TechnicianLicenseRecord[] }>;
          };
        }
      ).TechnicianLicense.listTechnicianLicenseByTechnicianId(
        { technicianId },
        { limit: 100 }
      );
      setRecords(res.data ?? []);
    } catch {
      setRecords([]);
    }
  }, [technicianId]);

  useEffect(() => {
    void load();
  }, [load]);

  const addRecord = async () => {
    if (!number.trim()) {
      setError("The licence number is required");
      return;
    }
    setBusy("add");
    setError(null);
    try {
      const res = await saveTechnicianLicense({
        technicianId,
        number: number.trim(),
        licenseType: licenseType.trim() || undefined,
        issuer: issuer.trim() || undefined,
        expiresOn: expiresOn || undefined,
        evidenceNote: evidenceNote.trim() || undefined,
      });
      if (res.errors?.length) throw new Error(res.errors[0].message);
      setNumber("");
      setLicenseType("");
      setIssuer("");
      setExpiresOn("");
      setEvidenceNote("");
      setAdding(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the licence");
    } finally {
      setBusy(null);
    }
  };

  const changeStatus = async (rec: TechnicianLicenseRecord, status: string) => {
    const reason = window.prompt(
      `Set licence ${rec.number} to ${status.toLowerCase()} — why? (recorded)`
    );
    if (!reason?.trim()) return;
    setBusy(rec.id);
    setError(null);
    try {
      const res = await setLicenseStatus({
        licenseId: rec.id,
        status,
        reason: reason.trim(),
      });
      if (res.errors?.length) throw new Error(res.errors[0].message);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change the status");
    } finally {
      setBusy(null);
    }
  };

  const statusTone = (s: string): "ok" | "warn" | "danger" | "muted" =>
    s === "CURRENT" ? "ok" : s === "PENDING" ? "warn" : "danger";

  return (
    <Field
      group
      label="Licence records"
      hint="Full history stays visible. New records start pending until an owner marks them current — that is what makes the technician dispatchable."
    >
      {records === null ? (
        <Spinner />
      ) : records.length === 0 ? (
        <p className="muted small" style={{ margin: 0 }}>
          No licence records yet — the single licence fields above still apply
          until the first record is added.
        </p>
      ) : (
        records.map((r) => (
          <ListRow
            key={r.id}
            title={`${r.number}${r.licenseType ? ` · ${r.licenseType}` : ""}`}
            subtitle={[
              r.issuer,
              r.expiresOn ? `expires ${r.expiresOn}` : null,
              r.evidenceNote ? `evidence: ${r.evidenceNote}` : null,
              r.statusSetBy
                ? `status by ${r.statusSetBy}`
                : null,
            ]
              .filter(Boolean)
              .join(" · ")}
            meta={
              <>
                <Badge tone={statusTone(r.status)}>{r.status.toLowerCase()}</Badge>
                {roles.owner && r.status !== "CURRENT" ? (
                  <Button
                    small
                    variant="ghost"
                    loading={busy === r.id}
                    onClick={() => void changeStatus(r, "CURRENT")}
                  >
                    Mark current
                  </Button>
                ) : null}
                {roles.owner && r.status === "CURRENT" ? (
                  <Button
                    small
                    variant="ghost"
                    loading={busy === r.id}
                    onClick={() => void changeStatus(r, "REVOKED")}
                  >
                    Revoke
                  </Button>
                ) : null}
              </>
            }
          />
        ))
      )}
      {!adding ? (
        <Button small variant="ghost" onClick={() => setAdding(true)}>
          + Add licence / renewal
        </Button>
      ) : (
        <>
          <div className="form-row-2">
            <input
              value={number}
              onChange={(e) => setNumber(e.target.value)}
              placeholder="Licence number"
            />
            <input
              value={licenseType}
              onChange={(e) => setLicenseType(e.target.value)}
              placeholder="Type (e.g. applicator)"
            />
          </div>
          <div className="form-row-2">
            <input
              value={issuer}
              onChange={(e) => setIssuer(e.target.value)}
              placeholder="Issuer (MA / RI)"
            />
            <input
              type="date"
              value={expiresOn}
              onChange={(e) => setExpiresOn(e.target.value)}
            />
          </div>
          <input
            value={evidenceNote}
            onChange={(e) => setEvidenceNote(e.target.value)}
            placeholder="Evidence (document ref, where it's filed)"
          />
          <Button small loading={busy === "add"} onClick={() => void addRecord()}>
            Save licence record
          </Button>
        </>
      )}
      <ErrorNote error={error} />
    </Field>
  );
}

function TechForm({
  existing,
  onDone,
}: {
  existing?: Technician | null;
  onDone: () => Promise<void>;
}) {
  const roles = useRoles();
  const [name, setName] = useState(existing?.name ?? "");
  const [email, setEmail] = useState(existing?.email ?? "");
  const [phone, setPhone] = useState(existing?.phone ?? "");
  const [licenseNumber, setLicenseNumber] = useState(
    existing?.licenseNumber ?? ""
  );
  const [licenseExpiresOn, setLicenseExpiresOn] = useState(
    existing?.licenseExpiresOn ?? ""
  );
  // GL-04: the technician's PRIVATE travel base (office-only; the field app
  // never sees it). Empty = routes from HQ.
  const [baseStreet, setBaseStreet] = useState(
    (existing as { baseStreet?: string | null } | null | undefined)?.baseStreet ?? ""
  );
  const [baseCity, setBaseCity] = useState(
    (existing as { baseCity?: string | null } | null | undefined)?.baseCity ?? ""
  );
  const [baseState, setBaseState] = useState(
    (existing as { baseState?: string | null } | null | undefined)?.baseState ?? ""
  );
  const [baseZip, setBaseZip] = useState(
    (existing as { baseZip?: string | null } | null | undefined)?.baseZip ?? ""
  );
  const [invite, setInvite] = useState(!existing);
  // A technician saved on an earlier attempt whose invite then failed — reused
  // on retry so every attempt doesn't leave another Technician record behind.
  const [createdTechId, setCreatedTechId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // GL-14: the Schedule entrance to offboarding carries the same controlled
  // reason and stable idempotency key the Staff entrance does, and shows the
  // PERSISTED outcome — never an assumed success.
  const [offboardOpen, setOffboardOpen] = useState(false);
  const [offboardReason, setOffboardReason] = useState<string>(
    STAFF_OFFBOARD_REASONS[0]
  );
  const [offboardNote, setOffboardNote] = useState("");
  const [offboardKey, setOffboardKey] = useState<string>(() =>
    globalThis.crypto?.randomUUID?.() ?? `k-${Date.now()}`
  );
  const [offboardOutcome, setOffboardOutcome] = useState<{
    outcome?: string;
    effects?: string | null;
    nextStep?: string | null;
    inProgress?: boolean;
  } | null>(null);
  // adminCreateUser is OWNER-only server-side (deliberately — invites are what
  // keep the role split real). Offering the checkbox to office staff meant the
  // record saved, the invite errored, and the error taught them errors are normal.
  const sendInvite = !existing && roles.owner && invite;

  const runOffboard = async () => {
    if (!existing) return;
    if (offboardReason === "OTHER" && !offboardNote.trim()) {
      setError("Choosing 'Other' needs a short note saying why.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api().mutations.deactivateTechnician({
        technicianId: existing.id,
        reasonCode: offboardReason,
        note: offboardNote.trim() || undefined,
        idempotencyKey: offboardKey,
      });
      if (res.errors?.length) throw new Error(res.errors[0].message);
      const data = opResult<{
        outcome?: string;
        effects?: string | null;
        nextStep?: string | null;
        inProgress?: boolean;
        jobsUnassigned?: number;
      }>(res);
      if (data && (data.inProgress || data.outcome !== "COMPLETE")) {
        // The persisted partial/in-progress outcome, with its one next step —
        // the same key resumes it.
        setOffboardOutcome(data);
        setBusy(false);
        return;
      }
      await onDone();
      const n = data?.jobsUnassigned ?? 0;
      window.alert(
        `${existing.name} offboarded.${
          n > 0
            ? ` ${n} job${n === 1 ? " is" : "s are"} back in the scheduling pool and need${n === 1 ? "s" : ""} reassigning on the Schedule board.`
            : ""
        }`
      );
    } catch (err) {
      // A refusal changed nothing; a fresh key lets a corrected request start
      // clean.
      setOffboardKey(globalThis.crypto?.randomUUID?.() ?? `k-${Date.now()}`);
      setError(err instanceof Error ? err.message : "Could not offboard technician");
      setBusy(false);
    }
  };

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
      <div className="form-row-2">
        <Field
          label="Applicator license #"
          hint="Required before this technician can be active or assigned"
        >
          <input
            value={licenseNumber}
            onChange={(e) => setLicenseNumber(e.target.value)}
            placeholder="MA-12345"
          />
        </Field>
        <Field label="License expires">
          <input
            type="date"
            value={licenseExpiresOn}
            onChange={(e) => setLicenseExpiresOn(e.target.value)}
          />
        </Field>
      </div>
      <Field
        label="Travel base (private)"
        hint="Where their day starts and ends — drives capacity and routing. Office-only; blank = HQ."
      >
        <div className="form-row-2">
          <input
            placeholder="Street"
            value={baseStreet}
            onChange={(e) => setBaseStreet(e.target.value)}
          />
          <input
            placeholder="City"
            value={baseCity}
            onChange={(e) => setBaseCity(e.target.value)}
          />
        </div>
        <div className="form-row-2">
          <input
            placeholder="State (MA/RI)"
            value={baseState}
            onChange={(e) => setBaseState(e.target.value)}
          />
          <input
            placeholder="ZIP"
            value={baseZip}
            onChange={(e) => setBaseZip(e.target.value)}
          />
        </div>
      </Field>
      {!existing ? (
        roles.owner ? (
          <label className="row-split" style={{ fontSize: 14 }}>
            <span>Email them a CRM login invite</span>
            <input
              type="checkbox"
              style={{ width: "auto" }}
              checked={invite}
              onChange={(e) => setInvite(e.target.checked)}
            />
          </label>
        ) : (
          <p className="muted small" style={{ margin: 0 }}>
            Ask the owner to send their CRM login invite — staff invites are
            owner-only.
          </p>
        )
      ) : null}
      <ErrorNote error={error} />
      <Button
        block
        loading={busy}
        onClick={() => {
          if (!name.trim()) {
            setError("Name is required");
            return;
          }
          if (sendInvite && !email.trim()) {
            setError("Email is required to send a login invite");
            return;
          }
          if (!licenseNumber.trim() || !licenseExpiresOn) {
            setError(
              "Applicator license number and expiration date are required before activation"
            );
            return;
          }
          setBusy(true);
          (async () => {
            if (existing) {
              opResult(
                await api().mutations.saveTechnician({
                  technicianId: existing.id,
                  name: name.trim(),
                  email: email.trim() || undefined,
                  phone: phone.trim() || undefined,
                  active: true,
                  licenseNumber: licenseNumber.trim(),
                  licenseExpiresOn,
                  baseStreet: baseStreet.trim() || undefined,
                  baseCity: baseCity.trim() || undefined,
                  baseState: baseState.trim() || undefined,
                  baseZip: baseZip.trim() || undefined,
                })
              );
              await onDone();
              return;
            }
            // Retry after a failed invite updates the already-saved record
            // instead of creating a duplicate technician per attempt.
            let technicianId = createdTechId;
            if (technicianId) {
              opResult(
                await api().mutations.saveTechnician({
                  technicianId,
                  name: name.trim(),
                  email: email.trim() || undefined,
                  phone: phone.trim() || undefined,
                  active: true,
                  licenseNumber: licenseNumber.trim(),
                  licenseExpiresOn,
                  baseStreet: baseStreet.trim() || undefined,
                  baseCity: baseCity.trim() || undefined,
                  baseState: baseState.trim() || undefined,
                  baseZip: baseZip.trim() || undefined,
                })
              );
            } else {
              const saved = opResult<{ technicianId?: string }>(
                await api().mutations.saveTechnician({
                  name: name.trim(),
                  email: email.trim() || undefined,
                  phone: phone.trim() || undefined,
                  active: true,
                  licenseNumber: licenseNumber.trim(),
                  licenseExpiresOn,
                  baseStreet: baseStreet.trim() || undefined,
                  baseCity: baseCity.trim() || undefined,
                  baseState: baseState.trim() || undefined,
                  baseZip: baseZip.trim() || undefined,
                })
              );
              technicianId = saved?.technicianId ?? null;
              if (!technicianId) throw new Error("Could not save technician");
              setCreatedTechId(technicianId);
            }
            if (sendInvite && technicianId) {
              try {
                unwrap(
                  await api().mutations.adminCreateUser({
                    email: email.trim(),
                    name: name.trim(),
                    roles: ["TECH"],
                    technicianId,
                  })
                );
              } catch (err) {
                // The technician exists; only the login invite failed. Say
                // exactly that, so retrying (which reuses the record) is the
                // obvious move.
                throw new Error(
                  `Technician saved, but the login invite failed: ${err instanceof Error ? err.message : String(err)}`
                );
              }
            }
            await onDone();
          })().catch((err) => {
            setError(err.message ?? "Could not save technician");
            setBusy(false);
          });
        }}
      >
        {existing ? "Save technician" : "Add technician"}
      </Button>
      {existing ? <LicenseRecords technicianId={existing.id} /> : null}
      {existing ? (
        roles.owner ? (
          offboardOutcome ? (
            <Card>
              <p style={{ margin: 0 }}>
                <Badge tone="warn">
                  {offboardOutcome.inProgress
                    ? "already in progress"
                    : "did not fully finish"}
                </Badge>
              </p>
              <p className="small" style={{ marginTop: 8 }}>
                {offboardOutcome.effects ??
                  "The offboarding did not fully finish."}
              </p>
              {offboardOutcome.nextStep ? (
                <p className="small" style={{ marginTop: 4 }}>
                  {offboardOutcome.nextStep}
                </p>
              ) : null}
              {!offboardOutcome.inProgress ? (
                <Button block loading={busy} onClick={() => void runOffboard()}>
                  Resume offboarding
                </Button>
              ) : null}
            </Card>
          ) : !offboardOpen ? (
            <Button block variant="ghost" onClick={() => setOffboardOpen(true)}>
              Offboard {existing.name}
            </Button>
          ) : (
            <div className="form-grid">
              <p className="muted small" style={{ margin: 0 }}>
                Their future assigned jobs go back to the scheduling pool, and
                their login (if any) is disabled and signed out immediately.
                Their history stays.
              </p>
              <Field
                label="Reason for offboarding"
                hint="A controlled reason is recorded in the staff-access ledger with your name and the time."
              >
                <select
                  value={offboardReason}
                  onChange={(e) => setOffboardReason(e.target.value)}
                >
                  {STAFF_OFFBOARD_REASONS.map((r) => (
                    <option key={r} value={r}>
                      {r.replace(/_/g, " ").toLowerCase()}
                    </option>
                  ))}
                </select>
              </Field>
              {offboardReason === "OTHER" ? (
                <Field label="Note" hint="Required when the reason is 'Other'.">
                  <input
                    value={offboardNote}
                    onChange={(e) => setOffboardNote(e.target.value)}
                    placeholder="Say why in a few words"
                  />
                </Field>
              ) : null}
              <Button
                block
                variant="danger"
                loading={busy}
                onClick={() => void runOffboard()}
              >
                Yes, offboard now
              </Button>
              <Button
                block
                variant="ghost"
                onClick={() => setOffboardOpen(false)}
              >
                Cancel
              </Button>
            </div>
          )
        ) : (
          <p className="muted small" style={{ margin: 0 }}>
            Ask the owner to offboard this technician — it disables their login,
            so it is owner-only.
          </p>
        )
      ) : null}
    </div>
  );
}
