import { useEffect, useState } from "react";
import {
  cancelPlanByCustomer,
  opResult,
  previewPlanCancellation,
  type CustomerCancelOutcome,
  type PlanCancellationPreview,
} from "../lib/api";
import { fmtDate } from "../lib/format";
import { Button, ErrorNote, Field, Sheet, Spinner } from "../ui/kit";

/**
 * GL-08 — customer self-service plan cancellation.
 *
 * The consequences are computed server-side (previewPlanCancellation) and shown
 * in full before the customer commits: effective date, the money outcome, which
 * queued visits stop, whether a paid visit remains, and the coverage that ends.
 *
 * The cancel is never gated: the reason is optional and the "pause instead"
 * save offer is a single, dismissible note that cannot obscure or delay the
 * Cancel button. A confirmed cancel that Stripe could not complete comes back
 * as PENDING — shown as a truthful in-progress state, never a false success.
 */
export default function CancelPlanSheet({
  servicePlanId,
  open,
  onClose,
  onCanceled,
}: {
  servicePlanId: string;
  open: boolean;
  onClose: () => void;
  onCanceled: () => void;
}) {
  const [preview, setPreview] = useState<PlanCancellationPreview | null>(null);
  const [reason, setReason] = useState("");
  const [saveOfferDismissed, setSaveOfferDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<CustomerCancelOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setPreview(null);
    setReason("");
    setSaveOfferDismissed(false);
    setOutcome(null);
    setError(null);
    previewPlanCancellation({ servicePlanId })
      .then((res) => {
        const data = opResult<PlanCancellationPreview>(res);
        if (!data) throw new Error("Could not load your plan details");
        setPreview(data);
      })
      .catch((err) =>
        setError(err instanceof Error ? err.message : "Could not load plan")
      );
  }, [open, servicePlanId]);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = opResult<CustomerCancelOutcome>(
        await cancelPlanByCustomer({
          servicePlanId,
          reason: reason.trim() || undefined,
        })
      );
      if (!res) throw new Error("Cancellation could not be completed");
      setOutcome(res);
      // A real cancel (or already-canceled) should refresh the plan list behind
      // the sheet. A PENDING result also changed server state (pending flag), so
      // refresh either way; the sheet stays open showing the outcome.
      onCanceled();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Cancellation could not be completed"
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="Cancel plan">
      <ErrorNote error={error} />

      {outcome ? (
        <div className="form-grid">
          <div
            className={outcome.status === "PENDING" ? "warn-note" : "success-note"}
            role="status"
          >
            <p>{outcome.message}</p>
          </div>
          <Button block variant="subtle" onClick={onClose}>
            Done
          </Button>
        </div>
      ) : !preview ? (
        <Spinner label="Loading your plan…" />
      ) : preview.alreadyResolved ? (
        <div className="form-grid">
          <p>This plan is already canceled — there's nothing more to do.</p>
          <Button block variant="subtle" onClick={onClose}>
            Close
          </Button>
        </div>
      ) : (
        <div className="form-grid">
          <p>
            You're canceling <strong>{preview.planName}</strong>. Here's exactly
            what happens if you confirm:
          </p>

          <ul className="cancel-consequences">
            <li>
              <strong>Takes effect {fmtDate(preview.effectiveDate, true)}</strong>{" "}
              — billing and visits stop right away.
            </li>
            <li>{preview.finalCharge.description}</li>
            <li>{preview.refundOutcome.description}</li>
            <li>
              {preview.visitsStopping === 0
                ? "No upcoming visits are waiting to be scheduled."
                : `${preview.visitsStopping} upcoming visit${
                    preview.visitsStopping === 1 ? "" : "s"
                  } will be taken off the schedule.`}
            </li>
            {preview.paidVisitRemains ? (
              <li>
                A visit you already paid for stays on our books — we'll contact
                you to keep it or refund it, your choice. You won't lose it.
              </li>
            ) : null}
            <li>{preview.coverageEnding}</li>
          </ul>

          {preview.saveOfferAvailable && !saveOfferDismissed ? (
            <div className="info-note" role="note">
              <p>
                Prefer to take a break instead of canceling? Give the office a
                call and we can pause your plan — no charges while it's paused.
              </p>
              <Button
                small
                variant="ghost"
                onClick={() => setSaveOfferDismissed(true)}
              >
                No thanks, continue canceling
              </Button>
            </div>
          ) : null}

          <Field
            label="Reason for canceling (optional)"
            hint="This is optional and won't hold anything up — it just helps us improve."
          >
            <textarea
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Anything you'd like us to know?"
            />
          </Field>

          <Button
            block
            variant="danger"
            loading={busy}
            disabled={busy}
            onClick={() => void confirm()}
          >
            Cancel my plan
          </Button>
          <Button block variant="subtle" disabled={busy} onClick={onClose}>
            Keep my plan
          </Button>
        </div>
      )}
    </Sheet>
  );
}
