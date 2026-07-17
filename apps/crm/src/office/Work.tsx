import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  api,
  listAll,
  listWorkEvents,
  listWorkItems,
  opResult,
  updateOwnedWork,
  type WorkEvent,
  type WorkItem,
} from "../lib/api";
import { useRoles } from "../lib/auth";
import { fmtDateTime } from "../lib/format";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNote,
  Field,
  Page,
  SegControl,
  Sheet,
  Spinner,
} from "../ui/kit";

type Tab = "OPEN" | "RESOLVED";

const KIND_LABEL: Record<string, string> = {
  NO_ACCESS: "No access",
  EMAIL_FAILURE: "Failed email",
  CALLBACK_PROMISE: "Callback",
  DUPLICATE_LEAD: "Duplicate lead",
  UNSTAFFED_VISIT: "Unstaffed visit",
  PAID_VISIT_CANCELLATION: "Paid cancellation",
  PORTAL_FAILURE: "Portal failure",
  PRICING_ESCALATION: "Pricing",
  MISSING_CONTACT: "Missing contact",
  PAID_NOT_FINALIZED: "Paid, not finalized",
};

export default function WorkQueue() {
  const navigate = useNavigate();
  const roles = useRoles();
  const [tab, setTab] = useState<Tab>("OPEN");
  const [items, setItems] = useState<WorkItem[] | null>(null);
  const [events, setEvents] = useState<WorkEvent[]>([]);
  const [selected, setSelected] = useState<WorkItem | null>(null);
  const [note, setNote] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [work, history] = await Promise.all([
        listAll((t) => listWorkItems({ limit: 1000, nextToken: t })),
        listAll((t) => listWorkEvents({ limit: 1000, nextToken: t })),
      ]);
      setItems(work);
      setEvents(history);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load work queue");
      setItems([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const shown = useMemo(() => {
    return (items ?? [])
      .filter((item) => item.status === tab)
      .sort((a, b) =>
        tab === "OPEN"
          ? a.dueAt.localeCompare(b.dueAt)
          : (b.resolvedAt ?? "").localeCompare(a.resolvedAt ?? "")
      );
  }, [items, tab]);

  const act = useCallback(
    async (item: WorkItem, action: "CLAIM" | "RESOLVE", resolutionNote?: string) => {
      setBusyId(item.id);
      setError(null);
      try {
        const result = opResult<{ workItemId: string; status: string }>(
          await updateOwnedWork({
            workItemId: item.id,
            action,
            note: resolutionNote,
          })
        );
        if (!result) throw new Error("The work update did not complete");
        setSelected(null);
        setNote("");
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not update work");
      } finally {
        setBusyId(null);
      }
    },
    [load]
  );

  const rebookNoAccess = useCallback(
    async (item: WorkItem) => {
      if (!window.confirm("Create a new linked visit and keep the no-access record untouched?")) {
        return;
      }
      setBusyId(item.id);
      setError(null);
      try {
        const rebooked = opResult<{ jobId: string }>(
          await api().mutations.rebookJob({ jobId: item.relatedId })
        );
        if (!rebooked?.jobId) throw new Error("The visit was not rebooked");
        const resolved = opResult<{ workItemId: string }>(
          await updateOwnedWork({
            workItemId: item.id,
            action: "RESOLVE",
            note: `Rebooked as linked visit ${rebooked.jobId}; the original no-access record remains unchanged.`,
          })
        );
        if (!resolved) throw new Error("The visit was rebooked, but the work item did not close");
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not rebook the visit");
      } finally {
        setBusyId(null);
      }
    },
    [load]
  );

  // GL-05: finish a paid booking whose finalization got stuck. The mutation
  // re-confirms the Stripe payment and resumes the SAME booking (idempotent),
  // then auto-resolves this exception on success.
  const retryFinalization = useCallback(
    async (item: WorkItem) => {
      if (
        !window.confirm(
          "Re-confirm the Stripe payment and finish this booking? This is safe to run more than once."
        )
      ) {
        return;
      }
      setBusyId(item.id);
      setError(null);
      try {
        const res = opResult<{ status: string }>(
          await api().mutations.retryBookingFinalization({
            bookingRequestId: item.relatedId,
          })
        );
        if (!res) throw new Error("The retry did not run");
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not finish the booking");
      } finally {
        setBusyId(null);
      }
    },
    [load]
  );

  if (!items) {
    return (
      <Page title="Owned work" back={roles.office ? "/dashboard" : "/more"}>
        <ErrorNote error={error} />
        <Spinner />
      </Page>
    );
  }

  return (
    <Page title="Owned work" back={roles.office ? "/dashboard" : "/more"}>
      <SegControl
        options={[
          { value: "OPEN" as Tab, label: `Open (${items.filter((i) => i.status === "OPEN").length})` },
          { value: "RESOLVED" as Tab, label: "Resolved history" },
        ]}
        value={tab}
        onChange={setTab}
      />
      <ErrorNote error={error} />

      {shown.length === 0 ? (
        <EmptyState
          title={tab === "OPEN" ? "No exception work is open" : "No work has been resolved yet"}
          body={
            tab === "OPEN"
              ? "New exceptions appear here with an owner, deadline, and resolution action."
              : "Resolved work remains here permanently with its full history."
          }
        />
      ) : (
        shown.map((item) => {
          const overdue = item.status === "OPEN" && item.dueAt < new Date().toISOString();
          const history = events
            .filter((event) => event.workItemId === item.id)
            .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
          return (
            <Card
              key={item.id}
              title={item.title}
              actions={
                <Badge tone={item.status === "RESOLVED" ? "ok" : overdue ? "danger" : "warn"}>
                  {item.status === "RESOLVED" ? "resolved" : overdue ? "overdue" : "open"}
                </Badge>
              }
            >
              <p className="muted small">{item.detail}</p>
              <p className="small" style={{ marginTop: 8 }}>
                <Badge tone="info">{KIND_LABEL[item.kind ?? ""] ?? item.kind}</Badge>{" "}
                Owner: <strong>{item.ownerSub === roles.sub ? "you" : item.ownerEmail}</strong>
                {item.status === "OPEN" ? <> · Due {fmtDateTime(item.dueAt)}</> : null}
                {(item.occurrenceCount ?? 1) > 1 ? ` · ${item.occurrenceCount} occurrences` : ""}
              </p>
              <p className="small" style={{ marginTop: 8 }}>
                <strong>Resolution action:</strong> {item.resolutionAction}
              </p>
              {item.resolutionNote ? (
                <p className="success-note" style={{ marginTop: 10 }}>
                  ✓ {item.resolutionNote}
                </p>
              ) : null}
              <div className="inline-actions" style={{ marginTop: 12 }}>
                {item.sourceUrl ? (
                  <Button small variant="subtle" onClick={() => navigate(item.sourceUrl!)}>
                    Open source
                  </Button>
                ) : null}
                {item.status === "OPEN" && item.ownerSub !== roles.sub ? (
                  <Button
                    small
                    variant="ghost"
                    loading={busyId === item.id}
                    onClick={() => void act(item, "CLAIM")}
                  >
                    Assign to me
                  </Button>
                ) : null}
                {item.status === "OPEN" && item.kind === "NO_ACCESS" ? (
                  <Button
                    small
                    variant="subtle"
                    loading={busyId === item.id}
                    onClick={() => void rebookNoAccess(item)}
                  >
                    Rebook visit
                  </Button>
                ) : null}
                {item.status === "OPEN" &&
                item.kind === "PAID_NOT_FINALIZED" &&
                (roles.office || roles.finance) ? (
                  <Button
                    small
                    variant="subtle"
                    loading={busyId === item.id}
                    onClick={() => void retryFinalization(item)}
                  >
                    Retry finalization
                  </Button>
                ) : null}
                {item.status === "OPEN" ? (
                  <Button small onClick={() => setSelected(item)}>
                    Resolve
                  </Button>
                ) : null}
              </div>
              <details style={{ marginTop: 12 }}>
                <summary className="small">Permanent history ({history.length})</summary>
                {history.map((event) => (
                  <p className="muted small" key={event.id} style={{ marginTop: 6 }}>
                    {fmtDateTime(event.occurredAt)} · {event.eventType?.toLowerCase().replace(/_/g, " ")} · {event.actorEmail}
                    <span className="nested-line">{event.note}</span>
                  </p>
                ))}
              </details>
            </Card>
          );
        })
      )}

      <Sheet open={Boolean(selected)} onClose={() => setSelected(null)} title="Resolve owned work">
        {selected ? (
          <div className="form-grid">
            <p className="muted small">{selected.resolutionAction}</p>
            <Field label="What permanently resolved this?">
              <textarea
                rows={4}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="Called customer, moved visit to July 20, and confirmed by phone…"
              />
            </Field>
            <Button
              block
              loading={busyId === selected.id}
              disabled={!note.trim()}
              onClick={() => void act(selected, "RESOLVE", note.trim())}
            >
              Save resolution
            </Button>
          </div>
        ) : null}
      </Sheet>
    </Page>
  );
}
