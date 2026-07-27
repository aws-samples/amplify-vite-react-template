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
  applyPromo,
  bookVisit,
  checkBookingStatus,
  isBookedResponse,
  type BookingStatusResponse,
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
  type FunnelSelection,
} from "../../lib/bookingFunnel";
import { trackFormSubmit, trackPurchase, trackAdsConversion, ADS_CONVERSIONS } from "../../lib/analytics";

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
  // Invoice-me (HOA/commercial only): "CARD" pays now; "INVOICE" books
  // card-less on net terms. Offered only when the quote is invoiceEligible.
  const [payMode, setPayMode] = useState<"CARD" | "INVOICE">("CARD");
  // Set once an invoice-me booking is placed so the finalizing/booked screens
  // say "invoice on its way" instead of "payment received / paid today".
  const [invoiced, setInvoiced] = useState(false);

  // A staff discount code the customer/CSR types at checkout. `promo` holds
  // the server-validated discount once applied; the total and the /book call
  // both use it, and /book re-validates it authoritatively.
  const [promoInput, setPromoInput] = useState("");
  const [promo, setPromo] = useState<{
    code: string;
    label: string;
    discountCents: number;
    amountCents: number;
  } | null>(null);
  const [promoBusy, setPromoBusy] = useState(false);
  const [promoError, setPromoError] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Terminal outcomes that end this checkout (day gone, already paid…). */
  const [fatal, setFatal] = useState<{ message: string; offerFreshQuote: boolean } | null>(null);

  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [chargedAmountCents, setChargedAmountCents] = useState<number | null>(null);
  // GL-05: the payment provider saying "succeeded" is NOT a booking. The page
  // shows a truthful "Payment received — finalizing" state and only says
  // "You're booked" once /booking-status confirms the complete commitment.
  const [finalizing, setFinalizing] = useState(false);
  const [booked, setBooked] = useState<BookingStatusResponse | null>(null);
  const [recoveryMsg, setRecoveryMsg] = useState<string | null>(null);
  const [statusToken, setStatusToken] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  // GL-06: once the pending bank debit's real scheduled commitment exists,
  // the server confirms it and this page shows "visit scheduled — payment
  // processing" with the expected settlement date.
  const [processingInfo, setProcessingInfo] =
    useState<BookingStatusResponse | null>(null);

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
  // GL-05: the durable identifiers — a reload or redirect lands back on the
  // same server-confirmed outcome instead of "nothing to check out yet".
  const urlBookingRef = useMemo(() => {
    const p = new URLSearchParams(window.location.search);
    const bookingId = p.get("booking");
    const t = p.get("t");
    return bookingId && t ? { bookingId, t } : null;
  }, []);

  /** Enter the truthful finalizing state and poll until the server confirms. */
  function enterFinalizing(bookingId: string, token: string) {
    window.history.replaceState(
      null,
      "",
      `/book?booking=${encodeURIComponent(bookingId)}&t=${encodeURIComponent(token)}`
    );
    setStatusToken(token);
    setFinalizing(true);
    void pollBookingStatus(bookingId, token);
  }

  /** GL-06: an async debit reported `processing` — the server is creating the
   *  real scheduled commitment. Show the truthful processing state and poll
   *  until the server confirms the visit is scheduled (or the debit already
   *  resolved). */
  function enterProcessing(bookingId: string, token: string) {
    window.history.replaceState(
      null,
      "",
      `/book?booking=${encodeURIComponent(bookingId)}&t=${encodeURIComponent(token)}`
    );
    setStatusToken(token);
    setProcessing(true);
    clearFunnelState(window.sessionStorage);
    void pollBookingStatus(bookingId, token, "processing");
  }

  async function pollBookingStatus(
    bookingId: string,
    token: string,
    mode: "finalize" | "processing" = "finalize"
  ) {
    let sawProcessing = mode === "processing";
    for (let attempt = 0; attempt < 24; attempt++) {
      const res = await checkBookingStatus({ bookingId, statusToken: token });
      if (res.ok) {
        const body = res.body;
        if (body.state === "BOOKED") {
          setBooked(body);
          setFinalizing(false);
          setProcessing(false);
          clearFunnelState(window.sessionStorage);
          return;
        }
        if (body.state === "PROCESSING_SCHEDULED") {
          // The pending debit's commitment exists — a terminal, truthful
          // screen: scheduled visit, payment pending, don't pay again.
          setProcessingInfo(body);
          setProcessing(true);
          setFinalizing(false);
          clearFunnelState(window.sessionStorage);
          return;
        }
        if (body.state === "PROCESSING") {
          // Still building the commitment — keep polling.
          sawProcessing = true;
          setProcessing(true);
          setFinalizing(false);
        }
        if (body.state === "RECOVERY") {
          setRecoveryMsg(
            body.message ??
              `Your payment went through and our team is completing your booking — you will not be charged twice. We'll confirm by email, or call ${OFFICE_PHONE}.`
          );
          setFinalizing(false);
          return;
        }
        if (body.state === "PAYMENT_FAILED") {
          setFinalizing(false);
          setProcessing(false);
          setError(
            body.reason ??
              "Your payment wasn't completed — no charge was made. You can try again."
          );
          return;
        }
        if (body.state === "CANCELED") {
          setFinalizing(false);
          setProcessing(false);
          setFatal({
            message: "This booking was canceled.",
            offerFreshQuote: true,
          });
          return;
        }
      }
      await new Promise((r) => setTimeout(r, 2500));
    }
    if (sawProcessing) {
      // GL-06: the processing screen is already truthful (visit scheduling in
      // motion, don't pay again, confirmation email coming) — leave it up.
      return;
    }
    // Poll budget exhausted: the money moved; the booking is being completed.
    // Owned, honest copy — never an invitation to pay again.
    setRecoveryMsg(
      `Your payment was received and your booking is being completed. You will not be charged twice — we'll email your confirmation shortly, or call ${OFFICE_PHONE}.`
    );
    setFinalizing(false);
  }

  useEffect(() => {
    // Durable resume: the URL identifies the booking, the server has the
    // truth. Works after reload, redirect, or a cleared session.
    if (urlBookingRef && !returnSecret) {
      setFinalizing(true);
      setStatusToken(urlBookingRef.t);
      void pollBookingStatus(urlBookingRef.bookingId, urlBookingRef.t);
      return;
    }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        // GL-05: provider success is not a booking — confirm with the server.
        const stored = loadFunnelState(window.sessionStorage);
        const bookingId = urlBookingRef?.bookingId ?? stored?.quote.bookingId;
        const token = urlBookingRef?.t ?? stored?.quote.statusToken;
        trackPurchase(bookingId ?? paymentIntent.id, paymentIntent.amount);
        trackAdsConversion(ADS_CONVERSIONS.BOOKING_CONFIRMED, {
          value: paymentIntent.amount / 100,
          currency: "USD",
          transaction_id: bookingId ?? paymentIntent.id,
        });
        if (bookingId && token) {
          enterFinalizing(bookingId, token);
        } else {
          setRecoveryMsg(
            `Your payment was received and your booking is being completed. We'll email your confirmation shortly, or call ${OFFICE_PHONE}.`
          );
        }
      } else if (paymentIntent.status === "processing") {
        setChargedAmountCents(paymentIntent.amount);
        // GL-06: the pending debit books the visit — confirm it server-side
        // and show the scheduled-with-payment-pending truth.
        const stored = loadFunnelState(window.sessionStorage);
        const bookingId = urlBookingRef?.bookingId ?? stored?.quote.bookingId;
        const token = urlBookingRef?.t ?? stored?.quote.statusToken;
        if (bookingId && token) {
          enterProcessing(bookingId, token);
        } else {
          setProcessing(true);
          clearFunnelState(window.sessionStorage);
        }
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

  const baseAmountCents =
    quote && selection ? amountDueCents(quote, selection) : null;
  // Post-charge the server-confirmed amount wins; pre-charge an applied code
  // discounts the base. /book re-applies the code, so the two always agree.
  const amountCents =
    chargedAmountCents ?? (promo ? promo.amountCents : baseAmountCents);

  async function applyPromoCode() {
    if (!quote || !selection || promoBusy) return;
    const code = promoInput.trim();
    if (!code) return;
    setPromoBusy(true);
    setPromoError(null);
    const result = await applyPromo({
      bookingId: quote.bookingId,
      code,
      date: selection.date,
      recurring: selection.recurring,
    });
    setPromoBusy(false);
    if (!result.ok) {
      setPromoError(
        result.body.error ?? "We couldn't check that code — please try again."
      );
      return;
    }
    if (!result.body.valid) {
      setPromo(null);
      setPromoError(result.body.message);
      return;
    }
    setPromo({
      code: result.body.code,
      label: result.body.label,
      discountCents: result.body.discountCents,
      amountCents: result.body.amountCents,
    });
    setPromoInput(result.body.code);
    setPromoError(null);
  }

  function removePromo() {
    setPromo(null);
    setPromoInput("");
    setPromoError(null);
  }

  async function startPayment() {
    if (!quote || !selection || !terms || !accepted || busy) return;
    setBusy(true);
    setError(null);
    setTermsChanged(null);

    const invoiceMe = payMode === "INVOICE" && Boolean(quote.invoiceEligible);
    const result = await bookVisit({
      bookingId: quote.bookingId,
      date: selection.date,
      recurring: selection.recurring,
      tcAccepted: true,
      tcVersion: terms.version,
      ...(invoiceMe ? { invoice: true } : {}),
      ...(promo ? { promoCode: promo.code } : {}),
    });
    setBusy(false);

    if (result.ok) {
      // Invoice-me finalizes server-side: the visit is already booked and an
      // OPEN invoice created — there's nothing to pay, so poll straight to the
      // confirmed state instead of mounting Stripe's PaymentElement.
      if (isBookedResponse(result.body)) {
        setChargedAmountCents(result.body.amountCents);
        setInvoiced(true);
        const token = result.body.statusToken ?? quote.statusToken;
        if (token) {
          enterFinalizing(quote.bookingId, token);
        } else {
          setRecoveryMsg(
            `Your visit is booked and an invoice is on its way. Questions? Call ${OFFICE_PHONE}.`
          );
        }
        return;
      }
      setClientSecret(result.body.clientSecret);
      setChargedAmountCents(result.body.amountCents);
      if (result.body.statusToken) setStatusToken(result.body.statusToken);
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
      // "Already paid" and "still processing" (GL-06) are the 409s that end well
      // — the customer has a payment done or in flight, so no fresh quote and no
      // invitation to pay again.
      const settledOrInFlight = /already paid|still processing/i.test(message);
      setFatal({ message, offerFreshQuote: !settledOrInFlight });
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

  // GL-05: "You're booked" renders ONLY from the server-confirmed state — the
  // complete commitment (customer, job, agreement, invoice, BOOKED) exists.
  if (booked) {
    return (
      <Shell>
        <div className="bk-confirm">
          <div className="bk-form-success-icon" aria-hidden="true">
            <CheckIcon />
          </div>
          <div className="bk-eyebrow">Confirmed</div>
          <h1 className="bk-h2">You&rsquo;re booked.</h1>
          <div className="bk-booking-price-card">
            <div className="bk-booking-price-card__label">Your visit</div>
            <div className="bk-booking-price-card__price">
              {booked.selectedDate ? formatDay(booked.selectedDate) : "Scheduled"}
            </div>
            {booked.amountCents != null ? (
              <div className="bk-booking-price-card__meta">
                {invoiced
                  ? `${money(booked.amountCents)} invoiced — due per your terms`
                  : `${money(booked.amountCents)} paid today`}
              </div>
            ) : null}
          </div>
          <p className="bk-body-lead">
            {invoiced
              ? "A confirmation email with your invoice is on its way"
              : "A confirmation email with your receipt is on its way"}
            {booked.email ? ` to ${booked.email}` : ""}.
          </p>
        </div>
      </Shell>
    );
  }

  // GL-05: the truthful in-between — payment received, commitment not yet
  // confirmed. Reload-safe (the URL carries the booking identifiers).
  if (finalizing) {
    return (
      <Shell>
        <div className="bk-confirm">
          <div className="bk-eyebrow">{invoiced ? "Almost done" : "Payment received"}</div>
          <h1 className="bk-h2">
            {invoiced ? "Booking your visit…" : "Finalizing your booking…"}
          </h1>
          <p className="bk-body-lead">
            {invoiced
              ? "We're scheduling your visit and preparing your invoice — this usually takes a few seconds. This page will update on its own."
              : "Your payment went through and we're completing your booking — this usually takes a few seconds. Don't pay again; this page will update on its own."}
          </p>
        </div>
      </Shell>
    );
  }

  // GL-05: finalization needs a human — the owned, honest recovery state. The
  // customer has ONE safe next step and is never invited to pay again.
  if (recoveryMsg) {
    return (
      <Shell>
        <div className="bk-confirm">
          <div className="bk-eyebrow">Payment received</div>
          <h1 className="bk-h2">We&rsquo;re completing your booking.</h1>
          <div className="bk-notice" role="status">
            {recoveryMsg}
          </div>
        </div>
      </Shell>
    );
  }

  if (processing) {
    const scheduled = processingInfo?.state === "PROCESSING_SCHEDULED";
    const dateShown = processingInfo?.selectedDate ?? selection?.date ?? null;
    return (
      <Shell>
        <div className="bk-confirm">
          <div className="bk-form-success-icon" aria-hidden="true">
            <CheckIcon />
          </div>
          {/* GL-06: a pending bank debit is a REAL scheduled visit with
              payment pending — say exactly that, never "paid" and never
              "no money moved". */}
          <div className="bk-eyebrow">Payment processing</div>
          <h1 className="bk-h2">
            {scheduled
              ? "Your visit is scheduled — payment processing."
              : "We're scheduling your visit."}
          </h1>
          {(processingInfo || (quote && selection)) && (
            <div className="bk-booking-price-card">
              <div className="bk-booking-price-card__label">Your visit</div>
              <div className="bk-booking-price-card__price">
                {dateShown ? formatDay(dateShown) : "Scheduling"}
              </div>
              <div className="bk-booking-price-card__meta">
                {quote?.service ?? "Pest control service"}
                {(processingInfo?.amountCents ?? amountCents) != null ? (
                  <>
                    {" "}
                    &bull; {money((processingInfo?.amountCents ?? amountCents)!)}{" "}
                    processing
                  </>
                ) : null}
              </div>
            </div>
          )}
          <p className="bk-body-lead">
            {scheduled ? (
              <>
                Your bank payment of{" "}
                {processingInfo?.amountCents != null
                  ? money(processingInfo.amountCents)
                  : "the quoted amount"}{" "}
                is processing — a bank debit can take a few business days
                {processingInfo?.expectedBy
                  ? ` (expected by ${processingInfo.expectedBy})`
                  : ""}
                . Your visit is scheduled and{" "}
                <strong>you don&rsquo;t need to do anything — please
                don&rsquo;t pay again</strong>. We&rsquo;ve emailed your
                scheduling confirmation, and we&rsquo;ll email again the moment
                the payment clears. If it doesn&rsquo;t go through, we&rsquo;ll
                tell you right away with what happens next.
              </>
            ) : (
              <>
                Your bank payment was submitted and is processing — a bank
                debit can take a few business days to settle. We&rsquo;re
                scheduling your visit right now and will email your
                confirmation within a few minutes.{" "}
                <strong>Please don&rsquo;t pay again.</strong> If the payment
                doesn&rsquo;t go through, we&rsquo;ll email you right away with
                what happens next.
              </>
            )}
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
          Start with an instant quote — pick your day there, then come back here
          to pay.
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
  const canInvoice = Boolean(quote.invoiceEligible);
  const invoiceMe = payMode === "INVOICE" && canInvoice;
  const payLabel = invoiceMe
    ? "Book & send my invoice"
    : amountCents != null
      ? `Pay ${money(amountCents)} and book`
      : "Pay and book";

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
          {selection.date ? (
            <li>
              <span className="bk-summary-key">Day</span>
              <span className="bk-summary-val">{formatDay(selection.date)}</span>
            </li>
          ) : (
            // GL-17 off-season enrollment: no first-visit day exists yet —
            // never invent one; the office confirms the real April date.
            <li>
              <span className="bk-summary-key">First treatment</span>
              <span className="bk-summary-val">
                April — we&rsquo;ll confirm the exact day with you
              </span>
            </li>
          )}
          {promo && baseAmountCents != null && (
            <>
              <li>
                <span className="bk-summary-key">Subtotal</span>
                <span className="bk-summary-val">{money(baseAmountCents)}</span>
              </li>
              <li>
                <span className="bk-summary-key">Discount</span>
                <span className="bk-summary-val">
                  {promo.label} &mdash; &minus;{money(promo.discountCents)}
                </span>
              </li>
            </>
          )}
          <li>
            <span className="bk-summary-key">Due today</span>
            <span className="bk-summary-val">
              {amountCents != null ? money(amountCents) : "—"}
              {/* Community/HOA + off-season plans: today = first month. */}
              {(quote.planOnly || quote.offSeason) &&
              selection.recurring &&
              amountCents != null
                ? " (your first month)"
                : null}
            </span>
          </li>
          {selection.recurring && offer && (
            <li>
              <span className="bk-summary-key">Then</span>
              <span className="bk-summary-val">
                {money(offer.monthlyCents)}/mo &mdash;{" "}
                {quote.offSeason
                  ? "billed monthly year-round; treatments run April through October"
                  : `${FREQUENCY_LABELS[offer.frequency]} plan, starts after your first completed visit`}
              </span>
            </li>
          )}
        </ul>

        {/* Staff discount code. Hidden once payment has started (a client
            secret exists) — the amount is locked to the created intent. */}
        {!clientSecret && (
          <div className="bk-promo">
            {promo ? (
              <div className="bk-promo-applied">
                <span>
                  Code <strong>{promo.code}</strong> applied.
                </span>
                <button
                  type="button"
                  className="bk-btn bk-btn-outline bk-btn-sm"
                  onClick={removePromo}
                >
                  Remove
                </button>
              </div>
            ) : (
              <div className="bk-field bk-full">
                <label htmlFor="bk-promo-code">Have a discount code?</label>
                <div className="bk-promo-row">
                  <input
                    id="bk-promo-code"
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    value={promoInput}
                    onChange={(e) =>
                      setPromoInput(e.target.value.toUpperCase())
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void applyPromoCode();
                      }
                    }}
                    placeholder="Enter code"
                    disabled={promoBusy}
                  />
                  <button
                    type="button"
                    className="bk-btn bk-btn-outline"
                    onClick={() => void applyPromoCode()}
                    disabled={promoBusy || !promoInput.trim()}
                  >
                    {promoBusy ? "Checking…" : "Apply"}
                  </button>
                </div>
                {promoError && (
                  <div className="bk-field-error" role="alert">
                    {promoError}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {canInvoice && !clientSecret && (
          <>
            <h3 className="bk-form-step__title">How would you like to pay?</h3>
            <div className="bk-choice-row">
              <button
                type="button"
                className={`bk-choice-card ${payMode === "CARD" ? "is-active" : ""}`}
                aria-pressed={payMode === "CARD"}
                onClick={() => setPayMode("CARD")}
              >
                <div className="bk-choice-card__title">Pay by card now</div>
                <div className="bk-choice-card__meta">
                  Secure checkout, booked instantly
                </div>
              </button>
              <button
                type="button"
                className={`bk-choice-card ${payMode === "INVOICE" ? "is-active" : ""}`}
                aria-pressed={payMode === "INVOICE"}
                onClick={() => setPayMode("INVOICE")}
              >
                <div className="bk-choice-card__title">Invoice me</div>
                <div className="bk-choice-card__meta">
                  Book now, pay by invoice (net 30) — HOA &amp; commercial only
                </div>
              </button>
            </div>
          </>
        )}

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
              &larr; Change day
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
              returnParams={
                quote && (statusToken ?? quote.statusToken)
                  ? {
                      bookingId: quote.bookingId,
                      t: (statusToken ?? quote.statusToken)!,
                    }
                  : null
              }
              onSucceeded={() => {
                const token = statusToken ?? quote?.statusToken;
                if (quote) trackPurchase(quote.bookingId, amountCents ?? 0);
                if (quote)
                  trackAdsConversion(ADS_CONVERSIONS.BOOKING_CONFIRMED, {
                    value: (amountCents ?? 0) / 100,
                    currency: "USD",
                    transaction_id: quote.bookingId,
                  });
                if (quote && token) {
                  enterFinalizing(quote.bookingId, token);
                } else {
                  setRecoveryMsg(
                    `Your payment was received and your booking is being completed. We'll email your confirmation shortly, or call ${OFFICE_PHONE}.`
                  );
                }
              }}
              onProcessing={() => {
                const token = statusToken ?? quote?.statusToken;
                if (quote && token) {
                  enterProcessing(quote.bookingId, token);
                } else {
                  setProcessing(true);
                  clearFunnelState(window.sessionStorage);
                }
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
  returnParams,
  onSucceeded,
  onProcessing,
}: {
  payLabel: string;
  /** GL-05: identifiers baked into the redirect return_url so a redirect
   *  payment method lands back on the durable, server-confirmed outcome. */
  returnParams: { bookingId: string; t: string } | null;
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
        confirmParams: {
          return_url: returnParams
            ? `${window.location.origin}/book?booking=${encodeURIComponent(returnParams.bookingId)}&t=${encodeURIComponent(returnParams.t)}`
            : `${window.location.origin}/book`,
        },
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
        "Your payment could not be started — that's a fault on our side, and your card was not charged. Please try again shortly, or call (508) 258-9294 to book by phone."
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
            "The payment form couldn't load — that's a fault on our side, not your card, and nothing was charged. Please try again shortly, or call (508) 258-9294 to book by phone."
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
