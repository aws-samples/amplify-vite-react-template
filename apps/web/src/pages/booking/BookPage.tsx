import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { loadStripe } from "@stripe/stripe-js";
import type { Stripe } from "@stripe/stripe-js";
import {
  Elements,
  PaymentElement,
  useElements,
  useStripe,
} from "@stripe/react-stripe-js";
import SEO from "../../components/SEO";
import {
  bookVisit,
  type BookingTerms,
  type PricedQuote,
} from "../../lib/bookingApi";
import {
  FREQUENCY_LABELS,
  amountDueCents,
  clearFunnelState,
  formatDay,
  isQuoteExpired,
  loadFunnelState,
  money,
  saveFunnelState,
  windowLabel,
  type FunnelSelection,
} from "../../lib/bookingFunnel";
import { trackFormSubmit, trackPurchase } from "../../lib/analytics";

const publishableKey = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY as
  | string
  | undefined;

const OFFICE_PHONE = "508-258-9294";

/**
 * Checkout: order summary, the cancellation terms rendered VERBATIM above
 * the pay button (R17 — the accepted version is recorded server-side), then
 * Stripe's PaymentElement. Card data goes straight to Stripe; finalization
 * (CRM records + confirmation email) happens asynchronously via the Stripe
 * webhook, so success copy promises the email is "on its way", not instant.
 */
export default function BookPage() {
  const navigate = useNavigate();

  const [quote, setQuote] = useState<PricedQuote | null>(null);
  const [selection, setSelection] = useState<FunnelSelection | null>(null);
  const [missing, setMissing] = useState(false);
  const [expired, setExpired] = useState(false);

  const [accepted, setAccepted] = useState(false);
  const [terms, setTerms] = useState<BookingTerms | null>(null);
  const [termsChanged, setTermsChanged] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Terminal outcomes that end this checkout (day gone, already paid…). */
  const [fatal, setFatal] = useState<{ message: string; offerFreshQuote: boolean } | null>(null);

  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [chargedAmountCents, setChargedAmountCents] = useState<number | null>(null);
  const [succeeded, setSucceeded] = useState(false);
  const [processing, setProcessing] = useState(false);

  const stripePromise = useMemo(
    () => (publishableKey ? loadStripe(publishableKey) : null),
    []
  );

  // Returning from a redirect payment method (e.g. Cash App, bank redirects):
  // Stripe appends payment_intent_client_secret to our return_url.
  const returnSecret = useMemo(
    () =>
      new URLSearchParams(window.location.search).get(
        "payment_intent_client_secret"
      ),
    []
  );

  useEffect(() => {
    const stored = loadFunnelState(window.sessionStorage);
    if (!stored || !stored.selection) {
      if (!returnSecret) setMissing(true);
    } else if (isQuoteExpired(stored.quote.expiresAt) && !returnSecret) {
      setExpired(true);
    } else {
      setQuote(stored.quote);
      setSelection(stored.selection);
      setTerms(stored.quote.terms ?? null);
    }
  }, [returnSecret]);

  // Resolve the outcome after a redirect round trip.
  useEffect(() => {
    if (!returnSecret || !stripePromise) return;
    let stale = false;
    void stripePromise.then(async (stripe: Stripe | null) => {
      if (!stripe || stale) return;
      const { paymentIntent, error: piError } =
        await stripe.retrievePaymentIntent(returnSecret);
      if (stale) return;
      if (piError || !paymentIntent) {
        setError(
          piError?.message ??
            `We couldn't confirm your payment status — call ${OFFICE_PHONE} before paying again.`
        );
        return;
      }
      if (paymentIntent.status === "succeeded") {
        setChargedAmountCents(paymentIntent.amount);
        setSucceeded(true);
        clearFunnelState(window.sessionStorage);
        trackPurchase(paymentIntent.id, paymentIntent.amount);
      } else if (paymentIntent.status === "processing") {
        setChargedAmountCents(paymentIntent.amount);
        setProcessing(true);
        clearFunnelState(window.sessionStorage);
      } else {
        setError(
          "Your payment wasn't completed — no charge was made. You can try again below."
        );
      }
    });
    return () => {
      stale = true;
    };
  }, [returnSecret, stripePromise]);

  const amountCents =
    chargedAmountCents ??
    (quote && selection ? amountDueCents(quote, selection) : null);

  async function startPayment() {
    if (!quote || !selection || !terms || !accepted || busy) return;
    setBusy(true);
    setError(null);
    setTermsChanged(null);

    const result = await bookVisit({
      bookingId: quote.bookingId,
      date: selection.date,
      window: selection.window,
      recurring: selection.recurring,
      tcAccepted: true,
      tcVersion: terms.version,
    });
    setBusy(false);

    if (result.ok) {
      setClientSecret(result.body.clientSecret);
      setChargedAmountCents(result.body.amountCents);
      trackFormSubmit("book", "success", { booking_id: quote.bookingId });
      return;
    }

    // 409 terms-changed: the server sends the CURRENT terms along — render
    // them and ask again. Nothing was charged.
    if (result.status === 409 && result.body.terms) {
      const nextTerms = result.body.terms;
      setTerms(nextTerms);
      setAccepted(false);
      setTermsChanged(
        result.body.error ?? "The booking terms were updated — please review them again."
      );
      const updatedQuote = { ...quote, terms: nextTerms };
      setQuote(updatedQuote);
      saveFunnelState(window.sessionStorage, { quote: updatedQuote, selection });
      return;
    }

    const message =
      result.body.error ??
      `Something went wrong (status ${result.status}). Please try again or call ${OFFICE_PHONE}.`;

    if (result.status === 409 || result.status === 410 || result.status === 404) {
      // Day gone / quote expired / quote not found → back to a fresh quote.
      // "Already paid" is the one 409 that ends well — no fresh quote needed.
      const alreadyPaid = /already paid/i.test(message);
      setFatal({ message, offerFreshQuote: !alreadyPaid });
      trackFormSubmit("book", "error", { error: message, status: result.status });
      return;
    }
    setError(message);
    trackFormSubmit("book", "error", { error: message, status: result.status });
  }

  function freshQuote() {
    clearFunnelState(window.sessionStorage);
    navigate("/quote");
  }

  // ── Terminal / empty states ───────────────────────────────────────

  if (succeeded || processing) {
    return (
      <Shell>
        <div className="bk-confirm">
          <div className="bk-form-success-icon" aria-hidden="true">
            <CheckIcon />
          </div>
          <div className="bk-eyebrow">{processing ? "Payment processing" : "Confirmed"}</div>
          <h1 className="bk-h2">You&rsquo;re booked.</h1>
          {quote && selection && (
            <div className="bk-quote-card">
              <div className="bk-quote-card__label">Your visit</div>
              <div className="bk-quote-card__price">
                {formatDay(selection.date)}
                <span className="bk-quote-card__per">
                  {" "}
                  &bull; {windowLabel(selection.window)}
                </span>
              </div>
              <div className="bk-quote-card__meta">
                {quote.service}
                {amountCents != null ? <> &bull; {money(amountCents)} paid today</> : null}
              </div>
            </div>
          )}
          <p className="bk-body-lead">
            {processing
              ? "Your payment is processing — once it completes, a confirmation email with your receipt and cancellation link is on its way."
              : "A confirmation email with your receipt and cancellation link is on its way."}
          </p>
        </div>
      </Shell>
    );
  }

  if (fatal) {
    return (
      <Shell>
        <div className="bk-eyebrow">Booking</div>
        <h1 className="bk-h2">One moment&hellip;</h1>
        <div className="bk-notice" role="alert">
          {fatal.message}
        </div>
        {fatal.offerFreshQuote && (
          <button type="button" className="bk-btn bk-btn-primary" onClick={freshQuote}>
            Get a fresh quote
          </button>
        )}
      </Shell>
    );
  }

  if (missing && !returnSecret) {
    return (
      <Shell>
        <div className="bk-eyebrow">Booking</div>
        <h1 className="bk-h2">Nothing to check out yet.</h1>
        <p className="bk-body-lead">
          Start with an instant quote — pick your day and time there, then come
          back here to pay.
        </p>
        <Link to="/quote" className="bk-btn bk-btn-primary">
          Get an instant quote
        </Link>
      </Shell>
    );
  }

  if (expired) {
    return (
      <Shell>
        <div className="bk-eyebrow">Booking</div>
        <h1 className="bk-h2">That quote expired.</h1>
        <p className="bk-body-lead">
          Quotes are held for 24 hours. Prices and availability may have moved
          — it takes a minute to get a fresh one.
        </p>
        <button type="button" className="bk-btn bk-btn-primary" onClick={freshQuote}>
          Get a fresh quote
        </button>
      </Shell>
    );
  }

  if (returnSecret && !quote) {
    // Redirect round trip landed without stored state; the payment-status
    // effect above will render success or an error.
    return (
      <Shell>
        <div className="bk-eyebrow">Booking</div>
        <h1 className="bk-h2">Checking your payment&hellip;</h1>
        {error && (
          <div className="bk-form-error" role="alert">
            {error}
          </div>
        )}
      </Shell>
    );
  }

  if (!quote || !selection) return <Shell />;

  if (!publishableKey) {
    // Honest config-missing state (mirrors the CRM's CollectPaymentSheet):
    // don't create a PaymentIntent we can never confirm.
    return (
      <Shell>
        <div className="bk-eyebrow">Booking</div>
        <h1 className="bk-h2">Online payment isn&rsquo;t available right now.</h1>
        <div className="bk-form-error" role="alert">
          Stripe publishable key is not configured (VITE_STRIPE_PUBLISHABLE_KEY),
          so this deployment can&rsquo;t take card payments. Call {OFFICE_PHONE}{" "}
          and we&rsquo;ll book you directly.
        </div>
      </Shell>
    );
  }

  // ── Checkout ──────────────────────────────────────────────────────

  const offer = quote.recurringOffer;
  const payLabel =
    amountCents != null ? `Pay ${money(amountCents)} and book` : "Pay and book";

  return (
    <Shell>
      <div className="bk-eyebrow">Booking</div>
      <h1 className="bk-h2">Confirm and pay.</h1>

      <div className="bk-form-card">
        <h3 className="bk-form-step__title">Your order</h3>
        <ul className="bk-summary-list">
          <li>
            <span className="bk-summary-key">Service</span>
            <span className="bk-summary-val">{quote.service}</span>
          </li>
          <li>
            <span className="bk-summary-key">Day</span>
            <span className="bk-summary-val">{formatDay(selection.date)}</span>
          </li>
          <li>
            <span className="bk-summary-key">Arrival window</span>
            <span className="bk-summary-val">{windowLabel(selection.window)}</span>
          </li>
          <li>
            <span className="bk-summary-key">Due today</span>
            <span className="bk-summary-val">
              {amountCents != null ? money(amountCents) : "—"}
            </span>
          </li>
          {selection.recurring && offer && (
            <li>
              <span className="bk-summary-key">Then</span>
              <span className="bk-summary-val">
                {money(offer.monthlyCents)}/mo &mdash;{" "}
                {FREQUENCY_LABELS[offer.frequency]} plan, starts after your
                first completed visit
              </span>
            </li>
          )}
        </ul>

        <h3 className="bk-form-step__title">Booking &amp; cancellation terms</h3>
        {terms ? (
          <>
            {termsChanged && (
              <div className="bk-notice" role="alert">
                {termsChanged}
              </div>
            )}
            <div className="bk-terms-box" tabIndex={0}>
              {terms.text}
            </div>
            <label className="bk-check-row">
              <input
                type="checkbox"
                checked={accepted}
                disabled={Boolean(clientSecret)}
                onChange={(e) => setAccepted(e.target.checked)}
              />
              <span>I have read and accept the booking &amp; cancellation terms.</span>
            </label>
          </>
        ) : (
          <div className="bk-form-error" role="alert">
            This quote is missing its booking terms — request a fresh quote and
            we&rsquo;ll show them before you pay.
          </div>
        )}

        {error && (
          <div className="bk-form-error" role="alert">
            {error}
          </div>
        )}

        {!clientSecret ? (
          <div className="bk-form-step__actions">
            <button
              type="button"
              className="bk-btn bk-btn-outline"
              onClick={() => navigate("/quote")}
            >
              &larr; Change day or time
            </button>
            <button
              type="button"
              className="bk-btn bk-btn-primary"
              disabled={!accepted || !terms || busy}
              aria-busy={busy}
              onClick={() => void startPayment()}
            >
              {busy ? "Connecting…" : payLabel}
            </button>
          </div>
        ) : stripePromise ? (
          <Elements
            stripe={stripePromise}
            options={{
              clientSecret,
              appearance: { variables: { colorPrimary: "#5FA517" } },
            }}
          >
            <PaymentForm
              payLabel={payLabel}
              onSucceeded={() => {
                setSucceeded(true);
                clearFunnelState(window.sessionStorage);
                trackPurchase(quote.bookingId, amountCents ?? 0);
              }}
              onProcessing={() => {
                setProcessing(true);
                clearFunnelState(window.sessionStorage);
              }}
            />
          </Elements>
        ) : null}
      </div>

      <p style={{ fontSize: 13, color: "var(--fg2)", marginTop: 16, lineHeight: 1.55 }}>
        Payment is handled by Stripe — BuzzKill never sees your card number.
      </p>
    </Shell>
  );
}

function PaymentForm({
  payLabel,
  onSucceeded,
  onProcessing,
}: {
  payLabel: string;
  onSucceeded: () => void;
  onProcessing: () => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [busy, setBusy] = useState(false);
  // useElements() returns an object even when the inner PaymentElement
  // failed to load (e.g. the key can't read the intent) — the button must
  // arm on the element's own ready signal, or "Pay" fires confirmPayment at
  // a form that isn't there.
  const [payReady, setPayReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!stripe || !elements || !payReady) return;
    setBusy(true);
    setError(null);
    try {
      // return_url brings redirect payment methods back to /book, where the
      // payment_intent_client_secret query param resolves the outcome.
      const result = await stripe.confirmPayment({
        elements,
        confirmParams: { return_url: `${window.location.origin}/book` },
        redirect: "if_required",
      });
      if (result.error) {
        // Stripe's message is customer-facing (declines, expired cards…).
        setError(result.error.message ?? "Your payment could not be completed.");
        trackFormSubmit("book_payment", "error", { error: result.error.code ?? result.error.message });
        return;
      }
      if (result.paymentIntent?.status === "succeeded") {
        onSucceeded();
      } else if (result.paymentIntent?.status === "processing") {
        onProcessing();
      } else {
        setError("Your payment wasn't completed — no charge was made. Please try again.");
      }
    } catch (err) {
      // confirmPayment throws (rather than returning an error) on
      // integration faults; those are ours, not the customer's card.
      console.error("confirmPayment threw", err);
      setError(
        "Your payment could not be started — that's a fault on our side, and your card was not charged. Please try again shortly, or call (401) 526-0323 to book by phone."
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PaymentElement
        onReady={() => setPayReady(true)}
        onLoadError={(ev) => {
          console.error("PaymentElement failed to load", ev.error);
          setLoadError(
            "The payment form couldn't load — that's a fault on our side, not your card, and nothing was charged. Please try again shortly, or call (401) 526-0323 to book by phone."
          );
        }}
      />
      {loadError && (
        <div className="bk-form-error" role="alert" style={{ marginTop: 12 }}>
          {loadError}
        </div>
      )}
      {error && (
        <div className="bk-form-error" role="alert" style={{ marginTop: 12 }}>
          {error}
        </div>
      )}
      <div className="bk-form-step__actions">
        <button
          type="button"
          className="bk-btn bk-btn-primary"
          disabled={!stripe || !elements || !payReady || busy}
          aria-busy={busy}
          onClick={() => void submit()}
        >
          {busy ? "Paying…" : payLabel}
        </button>
      </div>
    </div>
  );
}

function Shell({ children }: { children?: React.ReactNode }) {
  return (
    <>
      <SEO title="Book Your Visit" noindex />
      <section className="bk-section bk-section-light">
        <div className="bk-container bk-narrow">{children}</div>
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
