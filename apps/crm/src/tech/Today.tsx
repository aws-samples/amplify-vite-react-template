import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { technicianDay, type Job, type TechnicianDay } from "../lib/api";
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

/**
 * Technician day view: my route for the selected day, stop by stop.
 *
 * GL-13 row-scoping: this reads only through the server-scoped technicianDay
 * query. A technician is pinned to their own route server-side; the office may
 * pick another technician (the query returns the picker roster and honours the
 * technicianId). No raw model read happens here.
 */
export default function TechToday() {
  const navigate = useNavigate();
  const [date, setDate] = useState(todayEastern());
  // Office override; null means "the caller's own day" (a TECH is always self).
  const [pickedTechId, setPickedTechId] = useState<string | null>(null);
  const [day, setDay] = useState<TechnicianDay | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setDay(null);
    setError(null);
    try {
      setDay(await technicianDay(date, pickedTechId ?? undefined));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load route");
    }
  }, [date, pickedTechId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (day?.unlinked) {
    return (
      <Page title="My day">
        <EmptyState
          title="No technician profile linked"
          body="Ask the office to link your login to your technician record (More → Technicians)."
        />
      </Page>
    );
  }

  const customers = day?.customers ?? {};
  const jobs = day?.jobs ?? null;
  const addressFor = (j: Job) => {
    const c = customers[j.customerId];
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
        {day?.canPickTechnician && day.technicians.length > 1 ? (
          <div style={{ marginTop: 10 }}>
            <Field label="Technician">
              <select
                value={day.technicianId ?? ""}
                onChange={(e) => setPickedTechId(e.target.value)}
              >
                {day.technicians.map((t) => (
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
          title={day?.route ? "No stops on this route" : "No route for this day"}
          body="The office hasn't assigned any jobs to your route for this day."
        />
      ) : (
        <Card title={`${jobs.length} stop${jobs.length === 1 ? "" : "s"}`}>
          {jobs.map((j, i) => {
            const addr = addressFor(j);
            return (
              <ListRow
                key={j.id}
                title={`${i + 1}. ${customers[j.customerId]?.displayName ?? "…"}`}
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
