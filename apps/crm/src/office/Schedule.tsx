import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  api,
  listAll,
  opResult,
  unwrap,
  type Customer,
  type Job,
  type Route,
  type Technician,
} from "../lib/api";
import {
  addDays,
  fmtDate,
  prettyWeekday,
  startOfWeek,
  todayEastern,
} from "../lib/format";
import { assignBlockedNote, unassignBlockedNote } from "../lib/unassignStop";
import { technicianComplianceIssue } from "./technicians";
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
  const navigate = useNavigate();
  const [weekStart, setWeekStart] = useState(() => startOfWeek(todayEastern()));
  const [selDate, setSelDate] = useState(todayEastern());
  const [techs, setTechs] = useState<Technician[] | null>(null);
  const [routes, setRoutes] = useState<Route[]>([]);
  const [weekJobs, setWeekJobs] = useState<Job[]>([]);
  const [poolJobs, setPoolJobs] = useState<Job[]>([]);
  const [customers, setCustomers] = useState<Map<string, Customer>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [assigning, setAssigning] = useState<Job | null>(null);
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
      // A no-access visit that has already been rebooked has handed its
      // scheduling need to the new linked stop, so it must stop offering
      // Rebook. The original is never mutated, so the only signal is a job
      // pointing back at it via rebookedFromJobId — collect those originals
      // and drop them from the pool (otherwise the same customer shows a
      // Rebook row for the original AND an Assign row for its rebooking).
      const rebookedOriginals = new Set<string>();
      for (const j of [...inWeek, ...unscheduled]) {
        if (j.rebookedFromJobId) rebookedOriginals.add(j.rebookedFromJobId);
      }
      // COMPLETED / IN_PROGRESS / CANCELED never belong in the pool. A
      // NO_ACCESS visit does, but only to be rebooked — the render offers
      // Rebook, not Assign — so it is let through the assign-blocked filter.
      // Dated-but-unrouted stops anywhere in the week join the always-present
      // UNSCHEDULED jobs; dedupe by id so a row can't appear twice.
      const pool = new Map<string, Job>();
      for (const j of inWeek) {
        if (
          !j.routeId &&
          !rebookedOriginals.has(j.id) &&
          (!assignBlockedNote(j.status) || j.status === "NO_ACCESS")
        ) {
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
  // The stop's customer name opens the office customer detail. It's a button,
  // not a row-level onClick, so it never fights the assign/reorder/unassign
  // controls sharing the row.
  const customerLink = (j: Job) => (
    <button
      type="button"
      className="name-link"
      onClick={() => navigate(`/customers/${j.customerId}`)}
    >
      {customerName(j)}
    </button>
  );
  const customerCity = (j: Job) => customers.get(j.customerId)?.serviceCity;

  // A stop's full mappable address, or null when the customer record has none.
  const stopAddress = (j: Job): string | null => {
    const c = customers.get(j.customerId);
    if (!c) return null;
    const parts = [c.serviceStreet, c.serviceCity, c.serviceState, c.serviceZip]
      .map((p) => p?.trim())
      .filter(Boolean);
    return parts.length ? parts.join(", ") : null;
  };

  // A technician's home base — where the optimized day starts and ends. Falls
  // back to HQ when a tech has no private base, mirroring the routing engine's
  // baseAddressOf (a tech needs ≥2 address parts to override HQ).
  const techBase = (tech: Technician): string => {
    const t = tech as {
      baseStreet?: string | null;
      baseCity?: string | null;
      baseState?: string | null;
      baseZip?: string | null;
    };
    const parts = [t.baseStreet, t.baseCity, t.baseState, t.baseZip]
      .map((p) => p?.trim())
      .filter(Boolean);
    return parts.length >= 2 ? parts.join(", ") : "81 Greenwich Rd, Ware, MA 01082";
  };

  // A Google Maps directions link for the day's route exactly as the optimizer
  // sequenced it: base → each stop in routeOrder → base. Maps preserves the
  // waypoint order we pass, so the office sees the real planned tour, not a
  // Maps re-optimization. Null when no stop has a mappable address.
  const mapsRouteUrl = (tech: Technician, jobs: Job[]): string | null => {
    const stops = jobs
      .map(stopAddress)
      .filter((a): a is string => a !== null);
    if (stops.length === 0) return null;
    const base = encodeURIComponent(techBase(tech));
    return (
      "https://www.google.com/maps/dir/?api=1" +
      `&origin=${base}` +
      `&destination=${base}` +
      "&travelmode=driving" +
      `&waypoints=${stops.map(encodeURIComponent).join("%7C")}`
    );
  };

  return (
    <Page title="Schedule">
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
                  title={customerLink(j)}
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
              body="Add your technicians under More → Staff to start building daily routes."
              action={
                <Button onClick={() => navigate("/staff")}>Manage staff</Button>
              }
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
              const mapUrl = dayJobs.length ? mapsRouteUrl(tech, dayJobs) : null;
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
                    <div className="tech-card-actions">
                      {tech.phone ? (
                        <span className="tech-contact">
                          <a
                            className="tech-contact-link"
                            href={`tel:${tech.phone}`}
                            aria-label={`Call ${tech.name}`}
                          >
                            Call
                          </a>
                          <a
                            className="tech-contact-link"
                            href={`sms:${tech.phone}`}
                            aria-label={`Text ${tech.name}`}
                          >
                            Text
                          </a>
                        </span>
                      ) : null}
                      {complianceIssue ? (
                        <Badge tone="warn">{complianceIssue}</Badge>
                      ) : (
                        <Badge tone="ok">license current</Badge>
                      )}
                    </div>
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
                            title={<span>{i + 1}. {customerLink(j)}</span>}
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
                    {mapUrl ? (
                      <a
                        className="muted small route-map-link"
                        href={mapUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ display: "inline-block", marginTop: 8 }}
                      >
                        View route in Google Maps ↗
                      </a>
                    ) : null}
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
    </Page>
  );
}

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
