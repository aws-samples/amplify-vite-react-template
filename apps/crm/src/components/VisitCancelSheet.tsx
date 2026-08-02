import { useEffect, useState } from "react";
import {
  cancelVisit,
  opResult,
  previewVisitChange,
  VISIT_CANCEL_REASONS,
  type CancelDecision,
  type VisitCancelOutcome,
  type VisitChangePreview,
} from "../lib/api";
import { money } from "../lib/format";
import { useAction } from "../lib/useAsync";
import { Button, ErrorNote, Field, Sheet, Spinner } from "../ui/kit";

/** CUSTOMER_REQUEST → "Customer request". */
function reasonLabel(code: string): string {
  const s = code.replace(/_/g, " ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * GL-07 — one safe office cancel workflow for a single visit.
 *
 * Every consequence is computed server-side (previewVisitChange) and shown in
 * full before the employee commits: amount paid, the policy deadline and the
 * calculated refund/fee, what happens to the plan (nothing — a visit cancel
 * never cancels the plan), what happens to the route, and the notice the
 * customer will get. The employee picks a plain business decision and never
 * types an amount.
 *
 * A confirmed cancel that could not finish every consequence comes back as
 * PARTIAL — shown as a truthful "canceled, but…" with the owned follow-up,
 * never a false clean success.
 */
export default function VisitCancelSheet({
  jobId,
  open,
  onClose,
  onDone,
}: {
  jobId: string | null;
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [preview, setPreview] = useState<VisitChangePreview | null>(null);
  const [decision, setDecision] = useState<CancelDecision>("CANCEL_REFUND");
  const [reasonCode, setReasonCode] = useState<string>(VISIT_CANCEL_REASONS[0]);
  const [note, setNote] = useState("");
  const [outcome, setOutcome] = useState<VisitCancelOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The confirmed cancel carries the policy refund with it; a double-click must
  // not send a second cancel-and-refund for the same visit.
  const cancel = useAction(async () => {
    if (!jobId) return;
    const res = opResult<VisitCancelOutcome>(
      await cancelVisit({
        jobId,
        decision,
        reasonCode,
        note: note.trim() || undefined,
      })
    );
    if (!res) throw new Error("The cancellation could not be completed");
    setOutcome(res);
    onDone();
  }, "The cancellation could not be completed");

  const { clearError } = cancel;
  useEffect(() => {
    if (!open || !jobId) return;
    setPreview(null);
    setDecision("CANCEL_REFUND");
    setReasonCode(VISIT_CANCEL_REASONS[0]);
    setNote("");
    setOutcome(null);
    setError(null);
    clearError();
    previewVisitChange({ jobId })
      .then((res) => {
        const data = opResult<VisitChangePreview>(res);
        if (!data) throw new Error("Could not load this visit");
        setPreview(data);
      })
      .catch((err) =>
        setError(err instanceof Error ? err.message : "Could not load this visit")
      );
  }, [open, jobId, clearError]);

  return (
    <Sheet open={open} onClose={onClose} title="Cancel visit">
      <ErrorNote error={error ?? cancel.error} />

      {outcome ? (
        <div className="form-grid">
          <div
            className={outcome.outcome !== "COMPLETE" ? "warn-note" : "success-note"}
            role="status"
          >
            <p>{outcome.message}</p>
          </div>
          <Button block variant="subtle" onClick={onClose}>
            Done
          </Button>
        </div>
      ) : !preview ? (
        <Spinner label="Loading the visit…" />
      ) : preview.alreadyCanceled ? (
        <div className="form-grid">
          <p>This visit is already canceled — there's nothing more to do.</p>
          <Button block variant="subtle" onClick={onClose}>
            Close
          </Button>
        </div>
      ) : !preview.changeable ? (
        <div className="form-grid">
          <p>
            This visit is {preview.status.toLowerCase().replace(/_/g, " ")} and
            can't be canceled here — only a scheduled or unscheduled visit can.
          </p>
          <Button block variant="subtle" onClick={onClose}>
            Close
          </Button>
        </div>
      ) : (
        <div className="form-grid">
          <p>
            Canceling <strong>{preview.serviceType}</strong>
            {preview.scheduledDate ? ` on ${preview.scheduledDate}` : ""} for{" "}
            <strong>{preview.customerName}</strong>. Here's exactly what happens:
          </p>

          <ul className="cancel-consequences">
            <li>
              <strong>Paid:</strong>{" "}
              {preview.amountPaidCents > 0
                ? money(preview.amountPaidCents)
                : "nothing paid for this visit"}
              {preview.amountOpenCents > 0
                ? ` · ${money(preview.amountOpenCents)} open (will be voided)`
                : ""}
            </li>
            <li>
              <strong>Policy:</strong> {preview.policy.explanation}
            </li>
            <li>{preview.planConsequence}</li>
            <li>{preview.routeConsequence}</li>
            <li>{preview.noticePreview}</li>
          </ul>

          <Field
            label="Decision"
            hint="The amount is the server's 72-hour policy result — you never type it, and it cannot be overridden."
          >
            <select
              value={decision}
              onChange={(e) => setDecision(e.target.value as CancelDecision)}
            >
              <option value="CANCEL_REFUND">
                Cancel —{" "}
                {preview.decisions.cancelRefund.amountCents > 0
                  ? `refund ${money(preview.decisions.cancelRefund.amountCents)} in full`
                  : "no refund (within 72 hours of the visit)"}
              </option>
            </select>
          </Field>

          <p className="muted small">{preview.decisions.cancelRefund.description}</p>

          <Field
            label="Reason"
            hint="A controlled reason is recorded on the visit's audit history."
          >
            <select
              value={reasonCode}
              onChange={(e) => setReasonCode(e.target.value)}
            >
              {VISIT_CANCEL_REASONS.map((r) => (
                <option key={r} value={r}>
                  {reasonLabel(r)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Note" hint="Required when the reason is 'Other'.">
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Optional context"
            />
          </Field>

          <Button
            block
            variant="danger"
            loading={cancel.busy}
            disabled={cancel.busy || (reasonCode === "OTHER" && !note.trim())}
            onClick={() => void cancel.run()}
          >
            Cancel this visit
          </Button>
          <Button block variant="subtle" disabled={cancel.busy} onClick={onClose}>
            Keep the visit
          </Button>
        </div>
      )}
    </Sheet>
  );
}
