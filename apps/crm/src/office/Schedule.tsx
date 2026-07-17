import { useCallback, useEffect, useState } from "react";
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
import { useRoles } from "../lib/auth";
import { addDays, fmtDate, prettyWeekday, todayEastern } from "../lib/format";
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
  const [editingTech, setEditingTech] = useState<Technician | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      // Every list is paged to exhaustion: a filtered scan counts the limit
      // against rows scanned, not rows matched, so a single page can silently
      // drop stops from the board and the pool past a few hundred jobs.
      const [techList, routeList, jobsOnDate, unscheduled, customerList] =
        await Promise.all([
          listAll((t) =>
            api().models.Technician.list({ limit: 200, nextToken: t })
          ),
          listAll((t) =>
            api().models.Route.listRouteByDate(
              { date },
              { limit: 200, nextToken: t }
            )
          ),
          listAll((t) =>
            api().models.Job.listJobByScheduledDate(
              { scheduledDate: date },
              { limit: 500, nextToken: t }
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
      setRoutes(routeList);
      const onDate = jobsOnDate.filter((j) => j.status !== "CANCELED");
      setDayJobs(onDate);
      setPoolJobs([
        // COMPLETED / IN_PROGRESS never belong in the pool: "needs scheduling"
        // must not offer an Assign that rewrites a status billing acted on.
        ...onDate.filter((j) => !j.routeId && !assignBlockedNote(j.status)),
        ...unscheduled.filter((j) => j.scheduledDate !== date),
      ]);
      setCustomers(new Map(customerList.map((c) => [c.id, c])));
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
    // Guarded like unassign: the board schedules, it never rewrites history.
    const blocked = assignBlockedNote(job.status);
    if (blocked) {
      setError(`Can't assign this stop: ${blocked}`);
      return;
    }
    if (
      job.status === "NO_ACCESS" &&
      !window.confirm(
        "This visit ended NO ACCESS. Assigning re-books it as a normal stop. Continue?"
      )
    )
      return;
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
      opResult(
        await api().mutations.updateJobSchedule({
          jobId: job.id,
          operation: "ASSIGN",
          routeId: route.id,
          technicianId,
          routeOrder: order,
          scheduledDate: date,
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
        <div className="week-strip">
          {Array.from({ length: 7 }, (_, i) => addDays(date, i - 3)).map((d) => (
            <button
              key={d}
              type="button"
              className={`week-chip${d === date ? " week-chip-active" : ""}${d === todayEastern() ? " week-chip-today" : ""}`}
              onClick={() => setDate(d)}
            >
              <span>{new Date(`${d}T12:00:00`).toLocaleDateString("en-US", { weekday: "short" })}</span>
              <strong>{Number(d.slice(8, 10))}</strong>
            </button>
          ))}
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
                    <>
                      {j.status === "NO_ACCESS" ? <StatusBadge status={j.status} /> : null}
                      <Button
                        small
                        variant="subtle"
                        loading={busy === j.id}
                        onClick={() => setAssigning(j)}
                      >
                        Assign
                      </Button>
                    </>
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
              const complianceIssue = technicianComplianceIssue(tech, date);
              const route = routes.find((r) => r.technicianId === tech.id);
              const routeJobs = dayJobs
                .filter((j) => j.routeId && j.routeId === route?.id)
                .sort((a, b) => (a.routeOrder ?? 0) - (b.routeOrder ?? 0));
              return (
                <Card
                  key={tech.id}
                  title={`${tech.name} — ${routeJobs.length} stop${routeJobs.length === 1 ? "" : "s"}`}
                  actions={
                    <>
                      {complianceIssue ? (
                        <Badge tone="warn">{complianceIssue}</Badge>
                      ) : (
                        <Badge tone="ok">license current</Badge>
                      )}
                      {route ? <StatusBadge status={route.status} /> : <Badge tone="muted">empty route</Badge>}
                      <Button small variant="ghost" onClick={() => setEditingTech(tech)}>
                        Edit
                      </Button>
                    </>
                  }
                >
                  {routeJobs.length === 0 ? (
                    <p className="muted small">No stops on this day's route.</p>
                  ) : (
                    routeJobs.map((j, i) => {
                      const blocked = unassignBlockedNote(j.status, tech.name);
                      return (
                        <ListRow
                          key={j.id}
                          title={`${i + 1}. ${customerName(j)}`}
                          subtitle={`${j.serviceType}${j.timeWindow ? ` · ${j.timeWindow}` : ""}`}
                          meta={
                            <>
                              <StatusBadge status={j.status} />
                              <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                                <Button small variant="ghost" disabled={i === 0 || busy === j.id} onClick={() => void bump(j, -1, routeJobs)}>
                                  ↑
                                </Button>
                                <Button small variant="ghost" disabled={i === routeJobs.length - 1 || busy === j.id} onClick={() => void bump(j, 1, routeJobs)}>
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
            disabled={technicianComplianceIssue(t, date) !== null}
            loading={busy === assigning?.id}
            onClick={() => assigning && void assign(assigning, t.id)}
          >
            {t.name}
            {technicianComplianceIssue(t, date)
              ? ` — ${technicianComplianceIssue(t, date)}`
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
  const [invite, setInvite] = useState(!existing);
  // A technician saved on an earlier attempt whose invite then failed — reused
  // on retry so every attempt doesn't leave another Technician record behind.
  const [createdTechId, setCreatedTechId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // adminCreateUser is OWNER-only server-side (deliberately — invites are what
  // keep the role split real). Offering the checkbox to office staff meant the
  // record saved, the invite errored, and the error taught them errors are normal.
  const sendInvite = !existing && roles.owner && invite;

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
      {existing ? (
        roles.owner ? (
          <Button
            block
            variant="danger"
            loading={busy}
            onClick={() => {
              // Offboarding kills a login and moves work — OWNER-only, and the
              // confirm says both consequences out loud before it runs.
              if (
                !window.confirm(
                  `Offboard ${existing.name}?\n\n• Their future assigned jobs go back to the scheduling pool for reassignment.\n• Their login is disabled and signed out immediately — they lose access to the customer book right now.\n\nTheir history stays.`
                )
              ) {
                return;
              }
              setBusy(true);
              (async () => {
                const res = opResult<{
                  jobsUnassigned: number;
                  loginDisabled: boolean;
                }>(
                  await api().mutations.deactivateTechnician({
                    technicianId: existing.id,
                  })
                );
                await onDone();
                const n = res?.jobsUnassigned ?? 0;
                if (n > 0) {
                  window.alert(
                    `${existing.name} offboarded. ${n} job${
                      n === 1 ? " is" : "s are"
                    } back in the scheduling pool and need${
                      n === 1 ? "s" : ""
                    } reassigning on the Schedule board.`
                  );
                }
              })().catch((err) => {
                setError(err.message ?? "Could not offboard technician");
                setBusy(false);
              });
            }}
          >
            Offboard technician
          </Button>
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
