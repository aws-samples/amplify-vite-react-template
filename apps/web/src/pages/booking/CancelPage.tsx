import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import SEO from "../../components/SEO";
import {
  confirmCancel,
  previewCancel,
  type ApiErrorBody,
  type CancelPreview,
} from "../../lib/bookingApi";
import {
  formatDay,
  humanizeServiceEnum,
  money,
  windowLabel,
} from "../../lib/bookingFunnel";

/** The number customers should call when self-service can't help. */
const SUPPORT_PHONE = "(508) 258-9294";

type Phase =
  | { kind: "no-token" }
  | { kind: "loading" }
  | { kind: "preview"; preview: CancelPreview }
  | { kind: "not-found"; message: string }
  | { kind: "error"; message: string }
  /** Our-side failure: the server RECORDED the attempt — the refund window
   *  is preserved. Render its reassurance, never a generic error. */
  | { kind: "recorded-failure"; body: ApiErrorBody }
  | { kind: "done"; refunded: boolean };

/**
 * The emailed cancellation link lands here: /cancel?token=…
 * Preview first (no side effects), then an explicit confirm.
 */
export default function CancelPage() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const [phase, setPhase] = useState<Phase>(
    token ? { kind: "loading" } : { kind: "no-token" }
  );
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!token) return;
    let stale = false;
    void previewCancel(token).then((result) => {
      if (stale) return;
      if (result.ok) {
        setPhase({ kind: "preview", preview: result.body });
      } else if (result.status === 404) {
        setPhase({
          kind: "not-found",
          message: result.body.error ?? "Booking not found or already canceled.",
        });
      } else {
        setPhase({
          kind: "error",
          message:
            result.body.error ??
            `Something went wrong (status ${result.status}).`,
        });
      }
    });
    return () => {
      stale = true;
    };
  }, [token]);

  async function handleConfirm() {
    if (confirming) return;
    setConfirming(true);
    const result = await confirmCancel(token);
    setConfirming(false);
    if (result.ok) {
      setPhase({ kind: "done", refunded: result.body.refunded });
      return;
    }
    if (result.status === 503) {
      setPhase({ kind: "recorded-failure", body: result.body });
      return;
    }
    if (result.status === 404) {
      setPhase({
        kind: "not-found",
        message: result.body.error ?? "Booking not found or already canceled.",
      });
      return;
    }
    setPhase({
      kind: "error",
      message:
        result.body.error ?? `Something went wrong (status ${result.status}).`,
    });
  }

  return (
    <>
      <SEO title="Cancel Your Appointment" noindex />
      <section className="bk-section bk-section-light">
        <div className="bk-container bk-narrow">
          <div className="bk-eyebrow">Cancellation</div>

          {phase.kind === "no-token" && (
            <>
              <h1 className="bk-h2">We need your cancellation link.</h1>
              <p className="bk-body-lead">
                This page only works from the link in your booking confirmation
                email — it carries a code that identifies your appointment.
                Can&rsquo;t find the email? Call us at{" "}
                <strong>{SUPPORT_PHONE}</strong> and we&rsquo;ll cancel it for
                you.
              </p>
            </>
          )}

          {phase.kind === "loading" && (
            <h1 className="bk-h2">Looking up your booking&hellip;</h1>
          )}

          {phase.kind === "not-found" && (
            <>
              <h1 className="bk-h2">We couldn&rsquo;t find that booking.</h1>
              <div className="bk-notice" role="alert">
                {phase.message}
              </div>
              <p className="bk-p">
                If you think this is wrong, call us at{" "}
                <strong>{SUPPORT_PHONE}</strong>.
              </p>
            </>
          )}

          {phase.kind === "error" && (
            <>
              <h1 className="bk-h2">Something went wrong.</h1>
              <div className="bk-form-error" role="alert">
                {phase.message}
              </div>
              <p className="bk-p">
                You can also cancel by phone: <strong>{SUPPORT_PHONE}</strong>.
              </p>
            </>
          )}

          {phase.kind === "recorded-failure" && (
            <>
              <h1 className="bk-h2">That didn&rsquo;t go through — but you&rsquo;re covered.</h1>
              <div className="bk-form-error" role="alert">
                {phase.body.error ??
                  `We couldn't cancel your appointment just now — please call us at ${SUPPORT_PHONE}.`}
              </div>
              {phase.body.reassurance && (
                <div className="bk-notice">
                  {phase.body.reassurance}
                  {phase.body.cancellationRecordedOn && (
                    <>
                      {" "}
                      (Cancellation request recorded on{" "}
                      <strong>{phase.body.cancellationRecordedOn}</strong>.)
                    </>
                  )}
                </div>
              )}
            </>
          )}

          {phase.kind === "done" && (
            <div className="bk-confirm">
              <div className="bk-form-success-icon" aria-hidden="true">
                <CheckIcon />
              </div>
              <h1 className="bk-h2">Your appointment is canceled.</h1>
              <p className="bk-body-lead">
                {phase.refunded
                  ? "A full refund is on its way to your original payment method (3–5 business days). A confirmation email is on its way too."
                  : "Per the cancellation policy, this booking wasn't refundable. A confirmation email is on its way."}
              </p>
            </div>
          )}

          {phase.kind === "preview" && (
            <>
              <h1 className="bk-h2">Cancel this appointment?</h1>
              <div className="bk-form-card">
                <h3 className="bk-form-step__title">Your visit</h3>
                <ul className="bk-summary-list">
                  <li>
                    <span className="bk-summary-key">Service</span>
                    <span className="bk-summary-val">
                      {humanizeServiceEnum(phase.preview.booking.service)}
                    </span>
                  </li>
                  <li>
                    <span className="bk-summary-key">Day</span>
                    <span className="bk-summary-val">
                      {formatDay(phase.preview.booking.date)}
                    </span>
                  </li>
                  <li>
                    <span className="bk-summary-key">Arrival window</span>
                    <span className="bk-summary-val">
                      {windowLabel(phase.preview.booking.window)}
                    </span>
                  </li>
                  <li>
                    <span className="bk-summary-key">Paid</span>
                    <span className="bk-summary-val">
                      {money(phase.preview.booking.amountCents)}
                    </span>
                  </li>
                  <li>
                    <span className="bk-summary-key">If you cancel now</span>
                    <span className="bk-summary-val">
                      {phase.preview.refund.kind === "FULL"
                        ? `Full refund of ${money(phase.preview.refund.amountCents)}`
                        : "No refund"}
                    </span>
                  </li>
                </ul>
                <div className="bk-notice">{phase.preview.policy}</div>
                <div className="bk-form-step__actions">
                  <button
                    type="button"
                    className="bk-btn bk-btn-dark"
                    disabled={confirming}
                    aria-busy={confirming}
                    onClick={() => void handleConfirm()}
                  >
                    {confirming ? "Canceling…" : "Cancel my appointment"}
                  </button>
                </div>
                <p style={{ fontSize: 13, color: "var(--fg2)", marginTop: 12, lineHeight: 1.5 }}>
                  Changed your mind? Just close this page — your appointment
                  stays as scheduled.
                </p>
              </div>
            </>
          )}
        </div>
      </section>
    </>
  );
}

function CheckIcon() {
  return (
    <svg
      width="36"
      height="36"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}
