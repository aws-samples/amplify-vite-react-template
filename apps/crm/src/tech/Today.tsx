import { useState } from "react";
import { routingAddress, shortDisplayAddress } from "../lib/serviceAddress";
import { useNavigate } from "react-router-dom";
import { technicianDay, type Job, type TechnicianDay } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { clearAllDrafts } from "../lib/reportDraft";
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
 * A Google Maps turn-by-turn link for the whole day's stops IN ORDER. Origin is
 * omitted so Google starts from the device's live location (right for a tech
 * starting or resuming mid-route); the last stop is the destination and the
 * rest are waypoints. Null when there are no addresses to route.
 */
export function googleRouteUrl(orderedAddresses: string[]): string | null {
  const addrs = orderedAddresses.map((a) => a.trim()).filter(Boolean);
  if (addrs.length === 0) return null;
  const enc = encodeURIComponent;
  const destination = enc(addrs[addrs.length - 1]);
  const base = `https://www.google.com/maps/dir/?api=1&destination=${destination}&travelmode=driving`;
  if (addrs.length === 1) return base;
  // waypoints are the stops before the last, pipe-separated (encoded as %7C).
  const waypoints = addrs.slice(0, -1).map(enc).join("%7C");
  return `${base}&waypoints=${waypoints}`;
}

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
  const { data: day, error } = useAsync<TechnicianDay>(
    () => technicianDay(date, pickedTechId ?? undefined),
    [date, pickedTechId],
    "Could not load route"
  );

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

  // GL-13: the server says this login's field access has ended (deactivation /
  // offboarding). Purge every cached draft on the spot — the device keeps no
  // customer data past the end of access — and say so plainly.
  if (day?.accessEnded) {
    clearAllDrafts();
    return (
      <Page title="My day">
        <EmptyState
          title="Access has ended"
          body="This login no longer has field access. Talk to the office if you believe this is a mistake."
        />
      </Page>
    );
  }

  if (day?.licenseLapsed) {
    return (
      <Page title="My day">
        <EmptyState
          title="No current applicator licence on file"
          body="You can review your own completed work, but no route or new visits until the office records a current licence."
        />
      </Page>
    );
  }

  const customers = day?.customers ?? {};
  const jobs = day?.jobs ?? null;
  // NAVIGATION address — geocodable, so no unit (see lib/serviceAddress).
  const addressFor = (j: Job) => {
    const c = customers[j.customerId];
    return c ? routingAddress(c) : "";
  };
  // What the technician READS — includes the unit so they find the door.
  const shownAddressFor = (j: Job) => {
    const c = customers[j.customerId];
    return c ? shortDisplayAddress(c) : "";
  };
  // The whole day's route, in stop order, for one-tap Google Maps navigation.
  const routeUrl = googleRouteUrl((jobs ?? []).map(addressFor));

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
        <Card
          title={`${jobs.length} stop${jobs.length === 1 ? "" : "s"}`}
          actions={
            routeUrl ? (
              <a
                className="btn btn-ghost btn-small"
                href={routeUrl}
                target="_blank"
                rel="noreferrer"
              >
                🗺️ Route in Google Maps
              </a>
            ) : null
          }
        >
          {jobs.map((j, i) => {
            const addr = addressFor(j);      // geocodable, for the maps link
            const shownAddr = shownAddressFor(j); // read by the technician
            return (
              <ListRow
                key={j.id}
                title={`${i + 1}. ${customers[j.customerId]?.displayName ?? "…"}`}
                subtitle={
                  <>
                    {j.serviceType}
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
                          {shownAddr || addr}
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
