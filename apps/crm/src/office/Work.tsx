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
  isVerifiable,
  SEVERITY_LABEL,
  SEVERITY_TONE,
  workPolicy,
} from "../lib/workPolicy";
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

function kindLabel(kind: string | null | undefined): string {
  return workPolicy(kind)?.label ?? kind ?? "Exception";
}

export default function WorkQueue() {
  const navigate = useNavigate();
  const roles = useRoles();
  const [tab, setTab] = useState<Tab>("OPEN");
  const [overridesOnly, setOverridesOnly] = useState(false);
  const [items, setItems] = useState<WorkItem[] | null>(null);
  const [events, setEvents] = useState<WorkEvent[]>([]);
  // The owner-only "manager override" sheet — a close with no verified outcome.
  const [override, setOverride] = useState<WorkItem | null>(null);
  const [reasonCode, setReasonCode] = useState("");
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
      .filter((item) =>
        tab === "RESOLVED" && overridesOnly ? item.resolvedManualOverride : true
      )
      .sort((a, b) =>
        tab === "OPEN"
          ? a.dueAt.localeCompare(b.dueAt)
          : (b.resolvedAt ?? "").localeCompare(a.resolvedAt ?? "")
      );
  }, [items, tab, overridesOnly]);

  const overrideCount = useMemo(
    () =>
      (items ?? []).filter(
        (i) => i.status === "RESOLVED" && i.resolvedManualOverride
      ).length,
    [items]
  );

  const closeOverride = useCallback(() => {
    setOverride(null);
    setReasonCode("");
    setNote("");
  }, []);

  const claim = useCallback(
    async (item: WorkItem) => {
      setBusyId(item.id);
      setError(null);
      try {
        const result = opResult<{ workItemId: string }>(
          await updateOwnedWork({ workItemId: item.id, action: "CLAIM" })
        );
        if (!result) throw new Error("The work update did not complete");
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not claim work");
      } finally {
        setBusyId(null);
      }
    },
    [load]
  );

  // A verified close: the server re-checks the real-world outcome (technician
  // assigned, money settled, contact on file) and refuses if it isn't true yet.
  const confirmVerified = useCallback(
    async (item: WorkItem, actionId: string, label: string) => {
      if (
        !window.confirm(
          `${label}? BuzzKill will re-check this is actually done before it closes.`
        )
      ) {
        return;
      }
      setBusyId(item.id);
      setError(null);
      try {
        const result = opResult<{ workItemId: string }>(
          await updateOwnedWork({
            workItemId: item.id,
            action: "RESOLVE",
            resolutionActionId: actionId,
          })
        );
        if (!result) throw new Error("The work update did not complete");
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not close this work");
      } finally {
        setBusyId(null);
      }
    },
    [load]
  );

  const saveOverride = useCallback(async () => {
    if (!override) return;
    setBusyId(override.id);
    setError(null);
    try {
      const result = opResult<{ workItemId: string }>(
        await updateOwnedWork({
          workItemId: override.id,
          action: "RESOLVE",
          reasonCode,
          note: note.trim(),
        })
      );
      if (!result) throw new Error("The override did not complete");
      closeOverride();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not record the override");
    } finally {
      setBusyId(null);
    }
  }, [override, reasonCode, note, closeOverride, load]);

  // Rebook a no-access visit. The server resolves the exception from the rebook
  // itself (the verified event) — no separate close is needed here.
  const rebookNoAccess = useCallback(
    async (item: WorkItem) => {
      if (
        !window.confirm(
          "Create a new linked visit and keep the no-access record untouched?"
        )
      ) {
        return;
      }
      setBusyId(item.id);
      setError(null);
      try {
        const rebooked = opResult<{ jobId: string }>(
          await api().mutations.rebookJob({ jobId: item.relatedId })
        );
        if (!rebooked?.jobId) throw new Error("The visit was not rebooked");
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
  // re-confirms the Stripe payment, resumes the SAME booking (idempotent), and
  // auto-resolves this exception on success.
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

  // GL-08: resume a stuck plan cancellation. Idempotent — re-runs the cancel,
  // refunds/visits included — and auto-resolves this case once fully settled.
  const resumeCancellation = useCallback(
    async (item: WorkItem) => {
      if (
        !window.confirm(
          "Resume this customer's plan cancellation? This re-runs the cancel and is safe to run more than once."
        )
      ) {
        return;
      }
      setBusyId(item.id);
      setError(null);
      try {
        const res = opResult<{ status: string }>(
          await api().mutations.resumePlanCancellation({
            servicePlanId: item.relatedId,
          })
        );
        if (!res) throw new Error("The resume did not run");
        await load();
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Could not resume the cancellation"
        );
      } finally {
        setBusyId(null);
      }
    },
    [load]
  );

  // GL-07: resume a stuck office visit cancel/reschedule. Idempotent — re-runs
  // the cancel from its last completed step and never re-refunds.
  const resumeVisitChangeItem = useCallback(
    async (item: WorkItem) => {
      if (
        !window.confirm(
          "Resume this visit change? This re-runs the cancel and is safe to run more than once."
        )
      ) {
        return;
      }
      setBusyId(item.id);
      setError(null);
      try {
        const res = opResult<{ outcome?: string }>(
          await api().mutations.resumeVisitChange({ jobId: item.relatedId })
        );
        if (!res) throw new Error("The resume did not run");
        await load();
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Could not resume the visit change"
        );
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
      {tab === "RESOLVED" ? (
        <label className="inline-check small" style={{ margin: "8px 0" }}>
          <input
            type="checkbox"
            checked={overridesOnly}
            onChange={(e) => setOverridesOnly(e.target.checked)}
          />{" "}
          Manager overrides only ({overrideCount})
        </label>
      ) : null}
      <ErrorNote error={error} />

      {shown.length === 0 ? (
        <EmptyState
          title={
            tab === "OPEN"
              ? "No exception work is open"
              : overridesOnly
                ? "No manager overrides recorded"
                : "No work has been resolved yet"
          }
          body={
            tab === "OPEN"
              ? "New exceptions appear here with a severity, owner, deadline, and how to close them."
              : "Resolved work remains here permanently with its full history."
          }
        />
      ) : (
        shown.map((item) => {
          const overdue = item.status === "OPEN" && item.dueAt < new Date().toISOString();
          const policy = workPolicy(item.kind);
          const history = events
            .filter((event) => event.workItemId === item.id)
            .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
          const mine = item.ownerSub === roles.sub;
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
              <p className="small" style={{ marginTop: 2, marginBottom: 8 }}>
                <Badge tone="info">{kindLabel(item.kind)}</Badge>{" "}
                {policy ? (
                  <Badge tone={SEVERITY_TONE[policy.severity]}>
                    {SEVERITY_LABEL[policy.severity]}
                  </Badge>
                ) : null}
              </p>
              {policy ? (
                <p className="small" style={{ marginTop: 0 }}>
                  <strong>Who it affects:</strong> {policy.customerImpact}
                </p>
              ) : null}
              <p className="muted small">{item.detail}</p>
              <p className="small" style={{ marginTop: 8 }}>
                Owner: <strong>{mine ? "you" : item.ownerEmail}</strong>
                {item.status === "OPEN" ? <> · Due {fmtDateTime(item.dueAt)}</> : null}
                {(item.occurrenceCount ?? 1) > 1 ? ` · ${item.occurrenceCount} occurrences` : ""}
              </p>
              <p className="small" style={{ marginTop: 8 }}>
                <strong>Resolution action:</strong> {item.resolutionAction}
              </p>
              {item.resolutionNote ? (
                <p className="success-note" style={{ marginTop: 10 }}>
                  {item.resolvedManualOverride ? "⚑ Manager override — " : "✓ "}
                  {item.resolutionNote}
                </p>
              ) : null}
              <div className="inline-actions" style={{ marginTop: 12 }}>
                {item.sourceUrl ? (
                  <Button small variant="subtle" onClick={() => navigate(item.sourceUrl!)}>
                    Open source
                  </Button>
                ) : null}
                {item.status === "OPEN" && !mine ? (
                  <Button
                    small
                    variant="ghost"
                    loading={busyId === item.id}
                    onClick={() => void claim(item)}
                  >
                    Assign to me
                  </Button>
                ) : null}

                {/* Verified closes — a dedicated action that does the work AND
                    resolves the exception, or an in-place check the server
                    re-confirms. Available to routine office/finance. */}
                {item.status === "OPEN" &&
                policy?.externalAction?.mutation === "rebookJob" ? (
                  <Button
                    small
                    variant="subtle"
                    loading={busyId === item.id}
                    onClick={() => void rebookNoAccess(item)}
                  >
                    {policy.externalAction.label}
                  </Button>
                ) : null}
                {item.status === "OPEN" &&
                policy?.externalAction?.mutation === "retryBookingFinalization" &&
                (roles.office || roles.finance) ? (
                  <Button
                    small
                    variant="subtle"
                    loading={busyId === item.id}
                    onClick={() => void retryFinalization(item)}
                  >
                    {policy.externalAction.label}
                  </Button>
                ) : null}
                {item.status === "OPEN" &&
                policy?.externalAction?.mutation === "resumePlanCancellation" &&
                (roles.office || roles.finance) ? (
                  <Button
                    small
                    variant="subtle"
                    loading={busyId === item.id}
                    onClick={() => void resumeCancellation(item)}
                  >
                    {policy.externalAction.label}
                  </Button>
                ) : null}
                {item.status === "OPEN" &&
                policy?.externalAction?.mutation === "resumeVisitChange" &&
                (roles.office || roles.finance) ? (
                  <Button
                    small
                    variant="subtle"
                    loading={busyId === item.id}
                    onClick={() => void resumeVisitChangeItem(item)}
                  >
                    {policy.externalAction.label}
                  </Button>
                ) : null}
                {item.status === "OPEN" &&
                  (roles.office || roles.finance) &&
                  policy?.verified.map((action) => (
                    <Button
                      key={action.id}
                      small
                      loading={busyId === item.id}
                      onClick={() => void confirmVerified(item, action.id, action.label)}
                    >
                      {action.label}
                    </Button>
                  ))}

                {/* Manager override — close with no verified outcome. Owner only,
                    controlled reason + evidence, reported separately (GL-18). */}
                {item.status === "OPEN" && roles.owner ? (
                  <Button
                    small
                    variant="danger"
                    onClick={() => {
                      setOverride(item);
                      setReasonCode("");
                      setNote("");
                    }}
                  >
                    Manager override
                  </Button>
                ) : null}
              </div>
              {item.status === "OPEN" &&
              !roles.owner &&
              policy &&
              !isVerifiable(item.kind) ? (
                <p className="muted small" style={{ marginTop: 8 }}>
                  This exception has no automatic check — a manager closes it once
                  the real-world outcome is done.
                </p>
              ) : null}
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

      <Sheet
        open={Boolean(override)}
        onClose={closeOverride}
        title="Manager override"
      >
        {override ? (
          <div className="form-grid">
            <p className="muted small">
              Close <strong>{override.title}</strong> without a verified outcome.
              This is a manager decision, recorded on its own for review. Prefer a
              verified action whenever one is available.
            </p>
            <Field label="Reason for this override">
              <select
                value={reasonCode}
                onChange={(event) => setReasonCode(event.target.value)}
              >
                <option value="">Choose a reason…</option>
                {workPolicy(override.kind)?.manualReasons.map((reason) => (
                  <option key={reason.code} value={reason.code}>
                    {reason.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Evidence — what confirms this is actually done?">
              <textarea
                rows={4}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="Called the customer, confirmed the refund posted, ref #…"
              />
            </Field>
            <Button
              block
              variant="danger"
              loading={busyId === override.id}
              disabled={!reasonCode || !note.trim()}
              onClick={() => void saveOverride()}
            >
              Record override & close
            </Button>
          </div>
        ) : null}
      </Sheet>
    </Page>
  );
}
