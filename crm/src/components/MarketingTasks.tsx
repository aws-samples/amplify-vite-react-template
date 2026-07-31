import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  client,
  daysUntilDate,
  fmtDate,
  listAllPages,
  type MarketingTask,
  type Quote,
} from "../lib/client";

/**
 * Renewal marketing tasks — "submit this expiring risk to this carrier".
 *
 * Raised by the nightly renewal-tasks sweep. Per the agency rule a task
 * closes exactly two ways: a quote exists for that carrier (detected, not
 * clicked), or someone marks the carrier out of appetite.
 */

export function taskUrgency(t: MarketingTask): {
  badge: string;
  label: string;
} {
  const days = daysUntilDate(t.submitBy);
  if (days == null) return { badge: "gray", label: "—" };
  if (days < 0) return { badge: "red", label: `${-days}d past submit-by` };
  if (days <= 7) return { badge: "red", label: `submit in ${days}d` };
  if (days <= 21) return { badge: "amber", label: `submit in ${days}d` };
  return { badge: "green", label: `submit in ${days}d` };
}

/**
 * Close any open task whose carrier already has a quote on this account.
 *
 * The nightly job does this too, but a quote created at 10am shouldn't leave
 * a stale task sitting there until tomorrow's run.
 */
export async function settleSatisfiedTasks(
  tasks: MarketingTask[],
  quotes: Quote[]
): Promise<MarketingTask[]> {
  const settled: MarketingTask[] = [];
  for (const t of tasks) {
    if (t.status !== "OPEN") continue;
    const since = t.triggerDate ?? t.createdAt?.slice(0, 10) ?? "";
    const hit = quotes.some(
      (q) =>
        q.carrierId === t.carrierId &&
        q.accountId === t.accountId &&
        (q.createdAt ?? "").slice(0, 10) >= since
    );
    if (!hit) continue;
    const { data } = await client.models.MarketingTask.update({
      id: t.id,
      status: "COMPLETE",
      resolution: "QUOTED",
      completedAt: new Date().toISOString(),
      completedBy: "system (quote created)",
    });
    if (data) settled.push(data);
  }
  return settled;
}

/** Marketing tasks for one account, shown under its quotes. */
export default function AccountMarketingTasks({
  accountId,
  completedByName,
}: {
  accountId: string;
  completedByName: string;
}) {
  const [tasks, setTasks] = useState<MarketingTask[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const settledOnce = useRef(false);

  async function load() {
    const [ts, qs] = await Promise.all([
      listAllPages((nextToken) =>
        client.models.MarketingTask.list({
          filter: { accountId: { eq: accountId } },
          limit: 500,
          nextToken,
        })
      ),
      listAllPages((nextToken) =>
        client.models.Quote.list({
          filter: { accountId: { eq: accountId } },
          limit: 500,
          nextToken,
        })
      ),
    ]);
    // list() yields a structurally looser type than the model type.
    let rows = ts as MarketingTask[];
    // Run the quote-satisfies-task check once per mount, not on every render.
    if (!settledOnce.current) {
      settledOnce.current = true;
      const settled = await settleSatisfiedTasks(rows, qs as Quote[]);
      if (settled.length) {
        const byId = new Map(settled.map((s) => [s.id, s]));
        rows = rows.map((t) => byId.get(t.id) ?? t);
      }
    }
    setTasks(rows);
    setLoaded(true);
  }

  useEffect(() => {
    settledOnce.current = false;
    load().catch(() => setLoaded(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);

  async function markOutOfAppetite(t: MarketingTask) {
    setBusyId(t.id);
    const { data } = await client.models.MarketingTask.update({
      id: t.id,
      status: "COMPLETE",
      resolution: "OUT_OF_APPETITE",
      completedAt: new Date().toISOString(),
      completedBy: completedByName,
    });
    if (data) setTasks((ts) => ts.map((x) => (x.id === t.id ? data : x)));
    setBusyId(null);
  }

  async function reopen(t: MarketingTask) {
    setBusyId(t.id);
    const { data } = await client.models.MarketingTask.update({
      id: t.id,
      status: "OPEN",
      resolution: null,
      completedAt: null,
      completedBy: null,
    });
    if (data) setTasks((ts) => ts.map((x) => (x.id === t.id ? data : x)));
    setBusyId(null);
  }

  const open = tasks.filter((t) => t.status === "OPEN");
  const done = tasks.filter((t) => t.status === "COMPLETE");

  if (!loaded) return null;
  if (tasks.length === 0) return null;

  return (
    <div className="card">
      <div className="toolbar" style={{ marginTop: 0, alignItems: "flex-start" }}>
        <div>
          <h2 style={{ margin: 0 }}>Marketing tasks</h2>
          <p className="muted small" style={{ margin: "4px 0 0" }}>
            Carriers to submit this renewal to. A task closes when a quote is
            created for that carrier, or when you mark it out of appetite.
          </p>
        </div>
        <div className="grow" />
        {done.length > 0 && (
          <button className="link" onClick={() => setShowDone((v) => !v)}>
            {showDone ? "Hide" : `Show ${done.length} completed`}
          </button>
        )}
      </div>

      {open.length === 0 ? (
        <p className="muted small">All marketing tasks are complete.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Carrier</th>
                <th>Lines</th>
                <th>Expires</th>
                <th>Submit by</th>
                <th>Urgency</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {open
                .slice()
                .sort((a, b) => (a.submitBy ?? "").localeCompare(b.submitBy ?? ""))
                .map((t) => {
                  const u = taskUrgency(t);
                  return (
                    <tr key={t.id}>
                      <td>
                        <strong>{t.carrierName ?? "—"}</strong>
                      </td>
                      <td className="small">
                        {(t.lines ?? []).filter(Boolean).join(", ") || "—"}
                      </td>
                      <td className="small">{fmtDate(t.expirationDate)}</td>
                      <td className="small">{fmtDate(t.submitBy)}</td>
                      <td>
                        <span className={`badge ${u.badge}`}>{u.label}</span>
                      </td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        <button
                          className="link"
                          disabled={busyId === t.id}
                          onClick={() => markOutOfAppetite(t)}
                        >
                          Out of appetite
                        </button>
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      )}

      {showDone && done.length > 0 && (
        <div className="table-wrap" style={{ marginTop: 10 }}>
          <table>
            <tbody>
              {done.map((t) => (
                <tr key={t.id}>
                  <td>{t.carrierName ?? "—"}</td>
                  <td>
                    <span
                      className={`badge ${
                        t.resolution === "QUOTED" ? "green" : "gray"
                      }`}
                    >
                      {t.resolution === "QUOTED" ? "Quoted" : "Out of appetite"}
                    </span>
                  </td>
                  <td className="small">
                    {t.completedAt ? fmtDate(t.completedAt.slice(0, 10)) : "—"}
                    {t.completedBy ? ` · ${t.completedBy}` : ""}
                  </td>
                  <td>
                    <button
                      className="link"
                      disabled={busyId === t.id}
                      onClick={() => reopen(t)}
                    >
                      Reopen
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Agency-wide open tasks — the dashboard tile drills through to this. */
export function AllMarketingTasks() {
  const [tasks, setTasks] = useState<MarketingTask[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    listAllPages((nextToken) =>
      client.models.MarketingTask.list({
        filter: { status: { eq: "OPEN" } },
        limit: 500,
        nextToken,
      })
    ).then((data) => {
      setTasks(data as MarketingTask[]);
      setLoaded(true);
    });
  }, []);

  const sorted = tasks
    .slice()
    .sort((a, b) => (a.submitBy ?? "").localeCompare(b.submitBy ?? ""));

  return (
    <>
      <h1>Marketing tasks</h1>
      <p className="sub">
        Open carrier submissions for expiring policies and lead renewals
      </p>

      <div className="card">
        {!loaded ? (
          <p className="muted small">Loading…</p>
        ) : sorted.length === 0 ? (
          <p className="muted small">
            No open marketing tasks. The nightly sweep raises them once a
            renewal enters its submission window.
          </p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Carrier</th>
                  <th>Lines</th>
                  <th>Expires</th>
                  <th>Submit by</th>
                  <th>Urgency</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((t) => {
                  const u = taskUrgency(t);
                  return (
                    <tr key={t.id}>
                      <td>
                        <Link to={`/accounts/${t.accountId}?tab=quotes`}>
                          {t.accountName ?? "(account)"}
                        </Link>
                      </td>
                      <td>{t.carrierName ?? "—"}</td>
                      <td className="small">
                        {(t.lines ?? []).filter(Boolean).join(", ") || "—"}
                      </td>
                      <td className="small">{fmtDate(t.expirationDate)}</td>
                      <td className="small">{fmtDate(t.submitBy)}</td>
                      <td>
                        <span className={`badge ${u.badge}`}>{u.label}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
