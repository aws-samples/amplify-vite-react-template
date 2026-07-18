import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  api,
  listAll,
  techGetCustomer,
  techListTechnicians,
  type Customer,
  type Job,
  type Route,
  type Technician,
} from "../lib/api";
import { useRoles } from "../lib/auth";
import { addDays, prettyWeekday, todayEastern } from "../lib/format";
import {
  Button,
  Card,
  EmptyState,
  ErrorNote,
  Field,
  ListRow,
  Page,
  Spinner,
  StatusBadge,
} from "../ui/kit";

/** Technician day view: my route for the selected day, stop by stop. */
export default function TechToday() {
  const roles = useRoles();
  const navigate = useNavigate();
  const [date, setDate] = useState(todayEastern());
  const [techs, setTechs] = useState<Technician[]>([]);
  const [techId, setTechId] = useState<string | null>(null);
  const [route, setRoute] = useState<Route | null>(null);
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [customers, setCustomers] = useState<Map<string, Customer>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [noTechRecord, setNoTechRecord] = useState(false);

  // Resolve which technician "me" is (office users can pick anyone).
  useEffect(() => {
    (async () => {
      try {
        // Paged to exhaustion: a one-page read past 200 technicians would
        // miss `mine` and tell a real tech their login isn't linked. GL-13:
        // techListTechnicians requests only the licence-free fields a TECH may
        // read — the office picker and "which tech am I" resolution need
        // nothing more, and a default (all-fields) read would fail on the
        // office-only licence fields for a technician token.
        const all = await techListTechnicians();
        setTechs(all.filter((t) => t.active));
        const mine = all.find((t) => t.userSub === roles.sub);
        if (mine) {
          setTechId(mine.id);
        } else if (roles.office && all.length) {
          setTechId(all[0].id);
        } else {
          setNoTechRecord(true);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not load");
      }
    })();
  }, [roles.sub, roles.office]);

  const load = useCallback(async () => {
    if (!techId) return;
    setJobs(null);
    setError(null);
    try {
      const routes = await listAll((t) =>
        api().models.Route.listRouteByTechnicianIdAndDate(
          { technicianId: techId, date: { eq: date } },
          { nextToken: t }
        )
      );
      const r = routes[0] ?? null;
      setRoute(r);
      if (!r) {
        setJobs([]);
        return;
      }
      // The routeId filter runs post-scan (no routeId index), so the 200-row
      // limit counts scanned jobs, not the truck's stops — page to exhaustion
      // or stops silently fall off the day list.
      const jobList = (
        await listAll((t) =>
          api().models.Job.list({
            filter: { routeId: { eq: r.id } },
            limit: 200,
            nextToken: t,
          })
        )
      ).sort((a, b) => (a.routeOrder ?? 0) - (b.routeOrder ?? 0));
      setJobs(jobList);
      const ids = [...new Set(jobList.map((j) => j.customerId))];
      const loaded = await Promise.all(ids.map((id) => techGetCustomer(id)));
      setCustomers(
        new Map(
          loaded
            .filter((c): c is Customer => Boolean(c))
            .map((c) => [c.id, c])
        )
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load route");
    }
  }, [techId, date]);

  useEffect(() => {
    void load();
  }, [load]);

  if (noTechRecord) {
    return (
      <Page title="My day">
        <EmptyState
          title={roles.office ? "No technicians yet" : "No technician profile linked"}
          body={
            roles.office
              ? "Add a technician from the Schedule screen — their day view will appear here."
              : "Ask the office to link your login to your technician record (More → Technicians)."
          }
        />
      </Page>
    );
  }

  const addressFor = (j: Job) => {
    const c = customers.get(j.customerId);
    return [c?.serviceStreet, c?.serviceCity].filter(Boolean).join(", ");
  };

  return (
    <Page title="My day">
      <Card>
        <div className="row-split">
          <Button small variant="ghost" onClick={() => setDate(addDays(date, -1))}>
            ‹
          </Button>
          <strong>{prettyWeekday(date)}</strong>
          <Button small variant="ghost" onClick={() => setDate(addDays(date, 1))}>
            ›
          </Button>
        </div>
        {roles.office && techs.length > 1 ? (
          <div style={{ marginTop: 10 }}>
            <Field label="Technician">
              <select value={techId ?? ""} onChange={(e) => setTechId(e.target.value)}>
                {techs.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        ) : null}
      </Card>

      <ErrorNote error={error} />
      {jobs === null ? (
        <Spinner />
      ) : jobs.length === 0 ? (
        <EmptyState
          title={route ? "No stops on this route" : "No route for this day"}
          body="The office hasn't assigned any jobs to your route for this day."
        />
      ) : (
        <Card title={`${jobs.length} stop${jobs.length === 1 ? "" : "s"}`}>
          {jobs.map((j, i) => {
            const addr = addressFor(j);
            return (
              <ListRow
                key={j.id}
                title={`${i + 1}. ${customers.get(j.customerId)?.displayName ?? "…"}`}
                subtitle={
                  <>
                    {j.serviceType}
                    {j.timeWindow ? ` · ${j.timeWindow}` : ""}
                    {addr ? (
                      <>
                        {" · "}
                        <a
                          href={`https://maps.apple.com/?daddr=${encodeURIComponent(addr)}`}
                          target="_blank"
                          rel="noreferrer"
                          style={{ color: "var(--brand)" }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          {addr}
                        </a>
                      </>
                    ) : null}
                  </>
                }
                meta={<StatusBadge status={j.status} />}
                onClick={() => navigate(`/tech/job/${j.id}`)}
              />
            );
          })}
        </Card>
      )}
    </Page>
  );
}
