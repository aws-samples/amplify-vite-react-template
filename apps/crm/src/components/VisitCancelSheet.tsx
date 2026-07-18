import { useEffect, useState } from "react";
import {
  cancelVisit,
  opResult,
  previewVisitChange,
  type CancelDecision,
  type VisitCancelOutcome,
  type VisitChangePreview,
} from "../lib/api";
import { useRoles } from "../lib/auth";
import { money } from "../lib/format";
import { Button, ErrorNote, Field, Sheet, Spinner } from "../ui/kit";

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
  const roles = useRoles();
  const [preview, setPreview] = useState<VisitChangePreview | null>(null);
  const [decision, setDecision] = useState<CancelDecision>("CANCEL_REFUND");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<VisitCancelOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !jobId) return;
    setPreview(null);
    setDecision("CANCEL_REFUND");
    setReason("");
    setOutcome(null);
    setError(null);
    previewVisitChange({ jobId })
      .then((res) => {
        const data = opResult<VisitChangePreview>(res);
        if (!data) throw new Error("Could not load this visit");
        setPreview(data);
      })
      .catch((err) =>
        setError(err instanceof Error ? err.message : "Could not load this visit")
      );
  }, [open, jobId]);

  const confirm = async () => {
    if (!jobId) return;
    setBusy(true);
    setError(null);
    try {
      const res = opResult<VisitCancelOutcome>(
        await cancelVisit({ jobId, decision, reason: reason.trim() || undefined })
      );
      if (!res) throw new Error("The cancellation could not be completed");
      setOutcome(res);
      onDone();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "The cancellation could not be completed"
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="Cancel visit">
      <ErrorNote error={error} />

      {outcome ? (
        <div className="form-grid">
          <div
            className={outcome.outcome === "PARTIAL" ? "warn-note" : "success-note"}
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

          <Field label="Decision" hint="The amount is set by policy — you never type it.">
            <select
              value={decision}
              onChange={(e) => setDecision(e.target.value as CancelDecision)}
            >
              <option value="CANCEL_REFUND">
                Cancel and refund —{" "}
                {preview.decisions.cancelRefund.amountCents > 0
                  ? `refund ${money(preview.decisions.cancelRefund.amountCents)}`
                  : "no refund (late-cancel fee applies)"}
              </option>
              {preview.decisions.cancelCredit.available ? (
                <option value="CANCEL_CREDIT">
                  Cancel and keep {money(preview.decisions.cancelCredit.amountCents)} as
                  account credit
                </option>
              ) : null}
              {roles.owner ? (
                <option value="MANAGER_EXCEPTION">
                  Manager exception — waive fee, refund{" "}
                  {money(preview.decisions.managerException.amountCents)}
                </option>
              ) : null}
            </select>
          </Field>

          {decision === "MANAGER_EXCEPTION" ? (
            <p className="muted small">
              {preview.decisions.managerException.description}
            </p>
          ) : decision === "CANCEL_CREDIT" ? (
            <p className="muted small">{preview.decisions.cancelCredit.description}</p>
          ) : (
            <p className="muted small">{preview.decisions.cancelRefund.description}</p>
          )}

          <Field label="Reason" hint="Required — recorded on the visit's audit history.">
            <textarea
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why is this visit being canceled?"
            />
          </Field>

          <Button
            block
            variant="danger"
            loading={busy}
            disabled={busy || !reason.trim()}
            onClick={() => void confirm()}
          >
            Cancel this visit
          </Button>
          <Button block variant="subtle" disabled={busy} onClick={onClose}>
            Keep the visit
          </Button>
        </div>
      )}
    </Sheet>
  );
}
