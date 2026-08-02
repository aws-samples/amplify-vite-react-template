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
  liftEmailSuppression,
  recordNoticeAlternateDelivery,
} from "../lib/api";
import { useRoles } from "../lib/auth";
import { fmtDateTime, money, todayUtc } from "../lib/format";
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
  ListRow,
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

  // GL-18: hand a claimed case back to the shared queue (own claims; an owner
  // can release anyone's) — routine work never depends on one named person.
  const release = useCallback(
    async (item: WorkItem) => {
      setBusyId(item.id);
      setError(null);
      try {
        const result = opResult<{ workItemId: string }>(
          await updateOwnedWork({ workItemId: item.id, action: "RELEASE" })
        );
        if (!result) throw new Error("The work update did not complete");
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not release work");
      } finally {
        setBusyId(null);
      }
    },
    [load]
  );

  // GL-03: resend the EXACT stored message from its outbox row. The server
  // refuses unknown-outcome and attachment rows with the reason named.
  const resendExact = async (item: WorkItem) => {
    setBusyId(item.id);
    setError(null);
    try {
      const result = opResult(
        await (
          api().mutations as unknown as {
            resendEmailLog: (a: { emailLogId: string }) => Promise<{
              data: unknown;
              errors?: { message: string }[];
            }>;
          }
        ).resendEmailLog({ emailLogId: item.relatedId! })
      ) as { resent?: boolean } | null;
      if (!result?.resent) {
        throw new Error(
          "The resend did not go out — check the case detail and the email log."
        );
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not resend");
    } finally {
      setBusyId(null);
    }
  };

  // GL-18 R2: the bounded suppression release for a bounced/complained
  // address — required consent note; the server records the lift on the case.
  const liftSuppression = useCallback(
    async (item: WorkItem) => {
      const guess =
        item.relatedId && item.relatedId.includes("@") ? item.relatedId : "";
      const email = window.prompt(
        "Which suppressed address should be re-enabled?",
        guess
      );
      if (!email) return;
      const reason = window.prompt(
        "Controlled reason: CUSTOMER_RECONSENTED or ENTERED_IN_ERROR",
        "CUSTOMER_RECONSENTED"
      );
      if (reason !== "CUSTOMER_RECONSENTED" && reason !== "ENTERED_IN_ERROR") return;
      const evidence = window.prompt(
        "What retained evidence proves the address may be enabled? (required)"
      );
      if (!evidence) return;
      setBusyId(item.id);
      setError(null);
      try {
        const result = opResult<{ lifted: boolean; message: string }>(
          await liftEmailSuppression({ email, reasonCode: reason, evidence })
        );
        if (!result) throw new Error("The suppression lift did not complete");
        window.alert(result.message);
        await load();
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Could not lift the suppression"
        );
      } finally {
        setBusyId(null);
      }
    },
    [load]
  );

  // GL-08/GL-18: the office reached the customer by phone/in person — record
  // how, so the notice reads terminally delivered without a mailbox event.
  const recordAlternate = useCallback(
    async (item: WorkItem, template: string) => {
      const note = window.prompt(
        "How was the customer actually reached? (required — recorded on the notice)"
      );
      if (!note) return;
      setBusyId(item.id);
      setError(null);
      try {
        const result = opResult<{ recorded: boolean; message: string }>(
          await recordNoticeAlternateDelivery({
            relatedId: item.relatedId ?? "",
            template,
            note,
          })
        );
        if (!result) throw new Error("The alternate delivery did not record");
        window.alert(result.message);
        await load();
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Could not record the delivery"
        );
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
      <PaymentsInFlight />
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
                {item.status === "OPEN" && (mine || roles.owner) && item.ownerSub ? (
                  <Button
                    small
                    variant="ghost"
                    loading={busyId === item.id}
                    onClick={() => void release(item)}
                  >
                    Release to queue
                  </Button>
                ) : null}
                {item.status === "OPEN" &&
                (item.kind === "EMAIL_FAILURE" || item.kind === "MISSING_CONTACT") &&
                (roles.office || roles.finance) ? (
                  <Button
                    small
                    variant="subtle"
                    loading={busyId === item.id}
                    onClick={() => void liftSuppression(item)}
                  >
                    Lift email suppression…
                  </Button>
                ) : null}
                {/* GL-03: the routine exact resend — only for cases whose
                    related record IS an outbox row (el-…); the server refuses
                    rows it can't honestly reproduce. */}
                {item.status === "OPEN" &&
                item.kind === "EMAIL_FAILURE" &&
                item.relatedId?.startsWith("el-") &&
                (roles.office || roles.finance) ? (
                  <Button
                    small
                    variant="subtle"
                    loading={busyId === item.id}
                    onClick={() => void resendExact(item)}
                  >
                    Resend exact message
                  </Button>
                ) : null}
                {item.status === "OPEN" &&
                item.kind === "PLAN_CANCELLATION_RECOVERY" &&
                (roles.office || roles.finance) ? (
                  <Button
                    small
                    variant="subtle"
                    loading={busyId === item.id}
                    onClick={() => void recordAlternate(item, "plan-canceled")}
                  >
                    Record alternate delivery…
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
                // GL-18 R4: only a booking-shaped case gets Retry — an orphan
                // payment (pi_…) or a provider-outage sweep row has no booking
                // to retry, and offering the button would mislead.
                item.relatedId &&
                !item.relatedId.startsWith("pi_") &&
                item.relatedId !== "reconciliation" &&
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

/**
 * GL-06 — the plain-language view of every payment still in flight or
 * recently failed. A week-one office employee reads WHO, HOW MUCH, by WHAT
 * method, WHICH day, HOW LONG it has waited, what the provider last said,
 * whether the customer was told, and the one safe next action — with no
 * mental math and no way to bypass policy (collection and recovery happen
 * only through the owned cases below).
 */
type InFlightBooking = {
  id: string;
  status?: string | null;
  name?: string | null;
  email?: string | null;
  amountCents?: number | null;
  selectedDate?: string | null;
  jobId?: string | null;
  customerId?: string | null;
  processingStartedAt?: string | null;
  processingMethodLabel?: string | null;
  processingExpectedBy?: string | null;
  paymentFailedReason?: string | null;
  paymentFailedNoticeSentAt?: string | null;
  pendingConfirmationSentAt?: string | null;
  updatedAt?: string | null;
};

export function PaymentsInFlight() {
  const [rows, setRows] = useState<InFlightBooking[] | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const data = await listAll<InFlightBooking>((t) =>
          api().models.BookingRequest.list({
            filter: {
              or: [
                { status: { eq: "PROCESSING" } },
                { status: { eq: "PAYMENT_FAILED" } },
              ],
            },
            limit: 500,
            nextToken: t,
          } as Parameters<ReturnType<typeof api>["models"]["BookingRequest"]["list"]>[0]) as Promise<{
            data: InFlightBooking[];
            nextToken?: string | null;
            errors?: { message: string }[];
          }>
        );
        // Failed attempts age out of this operating view after two weeks —
        // their money consequences live on as owned cases either way.
        const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
        setRows(
          data
            .filter(
              (b) =>
                b.status === "PROCESSING" ||
                !b.updatedAt ||
                Date.parse(b.updatedAt) > cutoff
            )
            .sort((a, b) =>
              (a.processingStartedAt ?? a.updatedAt ?? "").localeCompare(
                b.processingStartedAt ?? b.updatedAt ?? ""
              )
            )
        );
      } catch {
        setRows([]);
      }
    })();
  }, []);

  if (!rows || rows.length === 0) return null;
  const today = todayUtc();
  const ageDays = (iso?: string | null) =>
    iso ? Math.floor((Date.now() - Date.parse(iso)) / (24 * 60 * 60 * 1000)) : null;

  return (
    <Card>
      <div className="row-split">
        <strong>Payments in flight ({rows.length})</strong>
        <Badge
          tone={
            rows.some(
              (b) =>
                b.status === "PROCESSING" &&
                b.processingExpectedBy &&
                b.processingExpectedBy < today
            )
              ? "warn"
              : "info"
          }
        >
          bank debits & failed payments
        </Badge>
      </div>
      {rows.map((b) => {
        const processing = b.status === "PROCESSING";
        const overdue =
          processing && b.processingExpectedBy && b.processingExpectedBy < today;
        const age = ageDays(b.processingStartedAt ?? b.updatedAt);
        const slot = b.selectedDate ?? "no date";
        const noticed = processing
          ? b.pendingConfirmationSentAt
            ? "customer confirmed (payment pending)"
            : "customer confirmation not sent yet"
          : b.paymentFailedNoticeSentAt
            ? "customer told of the failure"
            : "customer NOT yet told — the retry sweep will";
        const nextAction = processing
          ? overdue
            ? "Overdue with the bank — a Finance case is open; check the payment in Stripe."
            : "No action needed — the debit is clearing; the daily reconcile watches it."
          : b.jobId
            ? "See its owned case below — collection or rebooking runs from there."
            : "Nothing to recover — the customer can simply book again.";
        return (
          <ListRow
            key={b.id}
            title={`${b.name ?? b.email ?? b.id} — ${money(b.amountCents ?? 0)} ${processing ? `by ${b.processingMethodLabel ?? "bank"}` : "failed"}`}
            subtitle={
              `${processing ? `Processing${age != null ? ` ${age}d` : ""}, expected by ${b.processingExpectedBy ?? "—"}` : `Failed${b.paymentFailedReason ? `: ${b.paymentFailedReason}` : ""}`}` +
              ` · visit ${slot}${b.jobId ? " (scheduled)" : ""} · ${noticed} · ${nextAction}`
            }
            meta={
              <Badge tone={processing ? (overdue ? "warn" : "info") : "danger"}>
                {processing ? (overdue ? "overdue" : "processing") : "failed"}
              </Badge>
            }
          />
        );
      })}
    </Card>
  );
}
