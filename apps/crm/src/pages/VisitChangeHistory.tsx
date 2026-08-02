import { useCallback, useEffect, useState } from "react";
import {
  listAll,
  listVisitChangeEvents,
  type VisitChangeEvent,
} from "../lib/api";
import { useRoles } from "../lib/auth";
import { fmtDateTime, money, todayUtc } from "../lib/format";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNote,
  Field,
  ListRow,
  Page,
  Spinner,
} from "../ui/kit";

/**
 * GL-07 R6 — the complete office cancel/reschedule history for Operations and
 * Finance: every visit change with actor, controlled reason, policy, money
 * disposition, prior/new schedule, delivery, and final outcome, searchable and
 * exportable. Reachable by office OR finance (a finance-only user must be able to
 * audit the money side). Read-only — the ledger is written only by the server.
 */

/** CUSTOMER_REQUEST → "Customer request". */
function reasonLabel(code: string): string {
  const s = code.replace(/_/g, " ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export default function VisitChangeHistory() {
  const roles = useRoles();
  const [events, setEvents] = useState<VisitChangeEvent[] | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      // Page the whole ledger, not just the first batch, so the export is complete.
      const all = await listAll((nextToken) =>
        listVisitChangeEvents({ limit: 500, nextToken })
      );
      all.sort((a, b) =>
        String(b.occurredAt ?? "").localeCompare(String(a.occurredAt ?? ""))
      );
      setEvents(all);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the history");
      setEvents([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!roles.office && !roles.finance) {
    return (
      <Page title="Visit changes" back="/more">
        <EmptyState
          title="Office or finance only"
          body="The cancel/reschedule history is for operations and finance."
        />
      </Page>
    );
  }

  const q = query.trim().toLowerCase();
  const filtered = (events ?? []).filter((e) =>
    !q
      ? true
      : [
          e.jobId,
          e.customerId,
          e.actorEmail,
          e.action,
          e.decision,
          e.reason,
          e.policyUsed,
          e.disposition,
          e.communicationResult,
          e.outcome,
          e.effects,
        ]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(q))
  );

  const exportCsv = () => {
    const cols: (keyof VisitChangeEvent)[] = [
      "occurredAt",
      "action",
      "decision",
      "jobId",
      "customerId",
      "actorEmail",
      "reason",
      "policyUsed",
      "amountCents",
      "disposition",
      "priorScheduledDate",
      "newScheduledDate",
      "communicationResult",
      "outcome",
      "effects",
    ];
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = [
      cols.join(","),
      ...filtered.map((e) => cols.map((c) => esc(e[c])).join(",")),
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `visit-change-history-${todayUtc()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Page title="Visit changes" back="/more">
      <ErrorNote error={error} />
      <Field label="Search">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="customer, job, actor, reason, disposition…"
        />
      </Field>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <span className="muted small">
          {events === null
            ? "Loading…"
            : `${filtered.length} record${filtered.length === 1 ? "" : "s"}`}
        </span>
        <Button small variant="ghost" disabled={!filtered.length} onClick={exportCsv}>
          Export CSV
        </Button>
      </div>
      {events === null ? (
        <Spinner label="Loading visit-change history…" />
      ) : filtered.length === 0 ? (
        <EmptyState
          title="No matching records"
          body="Cancellations and reschedules appear here as they happen."
        />
      ) : (
        <Card>
          {filtered.map((e) => {
            const parts = String(e.reason ?? "").split(" — ");
            const code = parts[0]?.trim();
            const note = parts.slice(1).join(" — ").trim();
            const money$ =
              e.disposition === "REFUND" && (e.amountCents ?? 0) > 0
                ? ` · refunded ${money(e.amountCents ?? 0)}`
                : e.disposition === "FEE_RETAINED" && (e.amountCents ?? 0) > 0
                  ? ` · fee kept ${money(e.amountCents ?? 0)}`
                  : "";
            return (
              <ListRow
                key={e.id}
                title={
                  <span>
                    {e.action === "CANCEL" ? "Canceled" : "Rescheduled"}{" "}
                    {e.priorScheduledDate || e.newScheduledDate ? (
                      <span className="muted small">
                        ({e.priorScheduledDate ?? "unscheduled"} →{" "}
                        {e.newScheduledDate ?? "canceled"})
                      </span>
                    ) : null}{" "}
                    {e.outcome && e.outcome !== "COMPLETE" ? (
                      <Badge tone="warn">{String(e.outcome).toLowerCase()}</Badge>
                    ) : null}
                  </span>
                }
                subtitle={
                  <span>
                    {code ? reasonLabel(code) : "—"}
                    {note ? ` · ${note}` : ""}
                    {money$}
                    {" · by "}
                    {e.actorEmail}
                    {e.effects ? (
                      <>
                        <br />
                        <span className="muted small">{e.effects}</span>
                      </>
                    ) : null}
                  </span>
                }
                meta={
                  <span className="muted small">
                    {e.occurredAt ? fmtDateTime(e.occurredAt) : ""}
                  </span>
                }
              />
            );
          })}
        </Card>
      )}
    </Page>
  );
}
