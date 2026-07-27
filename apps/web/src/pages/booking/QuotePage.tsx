import { useEffect, useState } from "react";
import { CALL_CONSENT_TEXT, CALL_CONSENT_TEXT_VERSION } from "../../../amplify/functions/shared/consentText";
import type { FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import SEO, { buildBreadcrumbSchema } from "../../components/SEO";
import BugZapper from "../../components/BugZapper";
import { AddressAutocompleteInput } from "../../lib/addressAutocomplete";
import { WILDLIFE_REMOVAL_KINDS } from "../../../amplify/functions/shared/serviceCatalog";
import { trackFormSubmit, trackGenerateLead, trackAdsConversion, ADS_CONVERSIONS } from "../../lib/analytics";
import {
  checkQuoteStatus,
  getLeadPrefill,
  requestQuote,
  saveLeadToken,
  type ContactQuote,
  type PendingQuote,
  type PricedQuote,
  type PropertyKind,
  type QuoteRequest,
  type RecurringFrequency,
  type ServiceCode,
} from "../../lib/bookingApi";
import {
  FREQUENCY_LABELS,
  SERVICE_OPTIONS,
  serviceOption,
  clearFunnelState,
  defaultQuoteChoice,
  formatDay,
  hasRequestedPlan,
  hoaMoneyLine,
  isQuoteExpired,
  loadFunnelState,
  money,
  quoteFieldNeeds,
  saveFunnelState,
  validateQuoteForm,
} from "../../lib/bookingFunnel";

const OFFICE_PHONE = "508-258-9294";
const PENDING_QUOTE_KEY = "buzzkill.pendingQuote.v1";
const LONG_WAIT_MS = 90_000;

type PendingQuoteState = {
  quote: PendingQuote;
  startedAt: number;
};

function loadPendingQuote(storage: Storage): PendingQuoteState | null {
  try {
    const parsed = JSON.parse(storage.getItem(PENDING_QUOTE_KEY) ?? "null") as
      | PendingQuoteState
      | null;
    if (
      parsed?.quote?.decision === "PENDING" &&
      typeof parsed.quote.bookingId === "string" &&
      typeof parsed.quote.statusToken === "string" &&
      typeof parsed.startedAt === "number"
    ) {
      return parsed;
    }
  } catch {
    /* corrupt or storage-disabled — start clean */
  }
  return null;
}

function savePendingQuote(storage: Storage, pending: PendingQuoteState): void {
  try {
    storage.setItem(PENDING_QUOTE_KEY, JSON.stringify(pending));
  } catch {
    /* polling still works for this page load */
  }
}

function clearPendingQuote(storage: Storage): void {
  try {
    storage.removeItem(PENDING_QUOTE_KEY);
  } catch {
    /* no-op */
  }
}

type Fields = {
  name: string;
  email: string;
  phone: string;
  callConsent: boolean;
  service: string;
  propertyKind: PropertyKind;
  street: string;
  city: string;
  state: string;
  zip: string;
  sqft: string;
  nestCount: string;
  /** WILDLIFE: what needs removed + how many (the count sets the price). */
  removalKind: string;
  removalCount: string;
  units: string;
  /** GL-17: yard size for mosquito plans, in half-acres ("1".."8"). */
  lotHalfAcres: string;
  comments: string;
  /** "" = one-time visit only */
  recurringPreference: "" | RecurringFrequency;
};

const EMPTY_FIELDS: Fields = {
  name: "",
  email: "",
  phone: "",
  callConsent: false,
  service: "GENERAL_PEST",
  propertyKind: "RESIDENTIAL",
  street: "",
  city: "",
  state: "MA",
  zip: "",
  sqft: "",
  nestCount: "1",
  removalKind: "",
  removalCount: "1",
  units: "",
  lotHalfAcres: "1",
  comments: "",
  recurringPreference: "",
};

const onlyDigits = (s: string) => s.replace(/\D+/g, "");

/**
 * The instant-quote funnel entry: collects the same inputs the
 * `booking-public` /quote endpoint validates, then renders either the
 * priced day picker (→ /book) or the specialist-callback message.
 */
export default function QuotePage() {
  const navigate = useNavigate();
  const [fields, setFields] = useState<Fields>(EMPTY_FIELDS);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [leadPrefilled, setLeadPrefilled] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [priced, setPriced] = useState<PricedQuote | null>(null);
  const [contact, setContact] = useState<ContactQuote | null>(null);
  const [pending, setPending] = useState<PendingQuoteState | null>(null);
  const [pendingError, setPendingError] = useState<string | null>(null);
  const [waitedMs, setWaitedMs] = useState(0);

  // Day-picker selection
  const [selDate, setSelDate] = useState<string | null>(null);
  const [plan, setPlan] = useState<"ONE_TIME" | "PLAN">("ONE_TIME");

  // A refresh, an emailed resume link, or a round trip to /book must not lose
  // either the pending request or the finished quote.
  useEffect(() => {
    // An office-sent booking link carries the lead's CRM identity
    // (?lead=<token>) so the paid booking converts exactly that lead. Stash
    // it for the session and strip it from the address bar — like the resume
    // token below, capability tokens don't belong in history or referrers.
    const search = new URLSearchParams(window.location.search);
    const leadToken = search.get("lead");
    if (leadToken !== null) {
      if (leadToken && saveLeadToken(window.sessionStorage, leadToken)) {
        void getLeadPrefill(leadToken).then((result) => {
          if (!result.ok) return;
          const loaded = result.body;
          setFields((current) => ({
            ...current,
            name: current.name || loaded.name,
            email: current.email || loaded.email,
            phone: current.phone || loaded.phone,
            street: current.street || loaded.address.street,
            city: current.city || loaded.address.city,
            state:
              current.state === EMPTY_FIELDS.state
                ? loaded.address.state || current.state
                : current.state,
            zip: current.zip || loaded.address.zip,
            // Consent is never inferred from a CRM record. The person using
            // this form must make the checkbox decision in this interaction.
            callConsent: current.callConsent,
          }));
          setLeadPrefilled(true);
        });
      }
      search.delete("lead");
      const qs = search.toString();
      window.history.replaceState(
        {},
        "",
        `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`
      );
    }

    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const request = hash.get("request");
    const token = hash.get("token");
    if (request && token) {
      const resumed: PendingQuoteState = {
        quote: {
          bookingId: request,
          statusToken: token,
          decision: "PENDING",
          stage: "BUILDING_AVAILABILITY",
          message: "Your price is ready. We're loading the available appointment times.",
        },
        startedAt: Date.now(),
      };
      savePendingQuote(window.sessionStorage, resumed);
      setPending(resumed);
      // Capability tokens do not belong in browser history or referrers.
      window.history.replaceState(
        {},
        "",
        `${window.location.pathname}${window.location.search}`
      );
      return;
    }

    const savedPending = loadPendingQuote(window.sessionStorage);
    if (savedPending) {
      setPending(savedPending);
      setWaitedMs(Math.max(0, Date.now() - savedPending.startedAt));
      return;
    }

    const stored = loadFunnelState(window.sessionStorage);
    if (!stored) return;
    if (isQuoteExpired(stored.quote.expiresAt)) {
      clearFunnelState(window.sessionStorage);
      setNotice(
        "Your previous quote expired — prices are held for 24 hours. Fill the form in again for a fresh one."
      );
      return;
    }
    setPriced(stored.quote);
    if (stored.selection) {
      setSelDate(stored.selection.date);
      setPlan(stored.selection.recurring ? "PLAN" : "ONE_TIME");
    } else {
      setPlan(defaultQuoteChoice(stored.quote));
    }
  }, []);

  // Poll sequentially: a slow availability calculation must finish before a
  // second poll starts. Transient network/server failures keep the durable
  // request on screen and retry; an invalid/expired token stops cleanly.
  useEffect(() => {
    const bookingId = pending?.quote.bookingId;
    const statusToken = pending?.quote.statusToken;
    if (!bookingId || !statusToken) return;

    let stopped = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    const clock = window.setInterval(() => {
      setWaitedMs(Math.max(0, Date.now() - (pending?.startedAt ?? Date.now())));
    }, 1000);

    const poll = async () => {
      const result = await checkQuoteStatus({ bookingId, statusToken });
      if (stopped) return;

      if (result.ok) {
        setPendingError(null);
        if (result.body.decision === "PRICED") {
          clearPendingQuote(window.sessionStorage);
          setPending(null);
          acceptPricedQuote(result.body);
          return;
        }
        if (result.body.decision === "CONTACT") {
          clearPendingQuote(window.sessionStorage);
          setPending(null);
          setContact(result.body);
          window.scrollTo({ top: 0, behavior: "smooth" });
          return;
        }
        if (result.body.decision === "ERROR") {
          clearPendingQuote(window.sessionStorage);
          setPending(null);
          setBanner(result.body.message);
          window.scrollTo({ top: 0, behavior: "smooth" });
          return;
        }
        if (
          result.body.decision === "PROCESSING" ||
          result.body.decision === "BOOKED" ||
          result.body.decision === "PAYMENT_FAILED"
        ) {
          // GL-06: the booking already entered a payment state — show the
          // durable truth (don't pay again / confirmed / failed with a
          // rebook path) instead of a price board.
          clearPendingQuote(window.sessionStorage);
          setPending(null);
          setBanner(result.body.message);
          window.scrollTo({ top: 0, behavior: "smooth" });
          return;
        }
        setPending((current) =>
          current
            ? { ...current, quote: result.body as PendingQuote }
            : current
        );
      } else if ([400, 404, 409, 410].includes(result.status)) {
        clearPendingQuote(window.sessionStorage);
        setPending(null);
        setBanner(
          result.body.error ??
            "We couldn't reopen that quote request. Please submit a fresh one."
        );
        return;
      } else {
        setPendingError(
          "We lost the connection briefly, but your request is saved. Retrying automatically…"
        );
      }

      const elapsed = Date.now() - (pending?.startedAt ?? Date.now());
      pollTimer = setTimeout(poll, elapsed >= LONG_WAIT_MS ? 5000 : 3000);
    };

    pollTimer = setTimeout(poll, 750);
    return () => {
      stopped = true;
      window.clearInterval(clock);
      if (pollTimer) clearTimeout(pollTimer);
    };
    // Only a new request/token restarts the poller. Message/stage updates do
    // not create overlapping loops.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending?.quote.bookingId, pending?.quote.statusToken]);

  const set = (k: keyof Fields) => (v: string) =>
    setFields((f) => ({ ...f, [k]: v }));

  const needs = quoteFieldNeeds(fields.service, fields.propertyKind);
  const isCommunity = fields.propertyKind === "COMMUNITY";
  // Wasp and wildlife are one-time visits priced by count at EVERY property
  // class — they carry no plan/cadence choice (the server never offers one).
  const isCountOneTime =
    fields.service === "WASP_NEST" || fields.service === "WILDLIFE";
  // GP-style plan preference: residential general pest and every commercial
  // service (commercial prices like general pest, one-time + plans).
  const isSeasonal = serviceOption(fields.service)?.seasonal === true;
  const offersPlanChoice =
    !isSeasonal &&
    !isCountOneTime &&
    (fields.propertyKind === "COMMERCIAL" ||
      (fields.propertyKind === "RESIDENTIAL" && fields.service === "GENERAL_PEST"));

  function acceptPricedQuote(
    response: PricedQuote,
    planOnlyFallback = false
  ) {
    const quote = {
      ...response,
      planOnly: response.planOnly ?? planOnlyFallback,
    };
    setPriced(quote);
    setContact(null);
    setSelDate(null);
    setPlan(
      defaultQuoteChoice(quote) === "PLAN" || fields.recurringPreference
        ? "PLAN"
        : "ONE_TIME"
    );
    saveFunnelState(window.sessionStorage, { quote });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setBanner(null);
    setNotice(null);

    const errors = validateQuoteForm(fields);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    // Community quotes are always a plan: default the cadence to quarterly.
    const cadence = fields.recurringPreference || undefined;
    const payload: QuoteRequest = {
      name: fields.name.trim(),
      email: fields.email.trim(),
      phone: fields.phone.trim() || undefined,
      callConsent: fields.callConsent,
      callConsentTextVersion: CALL_CONSENT_TEXT_VERSION,
      service: fields.service as ServiceCode,
      propertyKind: fields.propertyKind,
      address: {
        street: fields.street.trim(),
        city: fields.city.trim(),
        state: fields.state.trim(),
        zip: fields.zip.trim() || undefined,
      },
      sqft: needs.sqft ? parseInt(fields.sqft, 10) : undefined,
      nestCount: needs.nestCount ? parseInt(fields.nestCount, 10) : undefined,
      removalKind: needs.removalKind ? fields.removalKind || undefined : undefined,
      removalCount: needs.removalCount
        ? parseInt(fields.removalCount, 10)
        : undefined,
      units: needs.units ? parseInt(fields.units, 10) : undefined,
      // GL-17: never silently default the yard size — an unparsable value
      // goes up as missing and the server's field error asks for it.
      lotHalfAcres: needs.lotHalfAcres
        ? parseInt(fields.lotHalfAcres, 10) || undefined
        : undefined,
      comments: fields.comments.trim() || undefined,
      // GL-17: seasonal plans bill monthly year-round — no cadence choice.
      recurringPreference: isSeasonal
        ? "MONTHLY"
        : isCommunity
          ? (cadence ?? "QUARTERLY")
          : offersPlanChoice
            ? cadence
            : undefined,
    };

    setSubmitting(true);
    const result = await requestQuote(payload);
    setSubmitting(false);

    if (result.ok) {
      // Google Ads "Quote Completed" — any successful quote submission counts.
      trackAdsConversion(ADS_CONVERSIONS.QUOTE_COMPLETED);
      if (result.body.decision === "PRICED") {
        acceptPricedQuote(result.body, isCommunity);
      } else if (result.body.decision === "PENDING") {
        const waiting = { quote: result.body, startedAt: Date.now() };
        clearFunnelState(window.sessionStorage);
        savePendingQuote(window.sessionStorage, waiting);
        setPending(waiting);
        setPendingError(null);
        setWaitedMs(0);
        window.scrollTo({ top: 0, behavior: "smooth" });
      } else if (result.body.decision === "CONTACT") {
        setContact(result.body);
        clearPendingQuote(window.sessionStorage);
        clearFunnelState(window.sessionStorage);
        window.scrollTo({ top: 0, behavior: "smooth" });
        trackFormSubmit("quote", "success", { decision: "PRICED", booking_id: result.body.bookingId });
      } else {
        // GL-06: a fresh submission can't reach a payment state, but a
        // replayed one can — show the durable truth.
        setBanner(result.body.message);
        clearPendingQuote(window.sessionStorage);
        window.scrollTo({ top: 0, behavior: "smooth" });
        trackFormSubmit("quote", "success", { decision: "CONTACT", booking_id: result.body.bookingId });
        trackGenerateLead("quote_contact", result.body.bookingId);
      }
      return;
    }

    // Server-side rejection: field errors when we have them, otherwise the
    // server's message verbatim — it's written for customers (429, bot check).
    if (result.body.errors && Object.keys(result.body.errors).length > 0) {
      setFieldErrors(result.body.errors);
      setBanner("A few details need another look — see the fields below.");
      trackFormSubmit("quote", "error", { errors: Object.keys(result.body.errors).join(",") });
    } else {
      setBanner(
        result.body.error ??
          `Something went wrong (status ${result.status}). Please try again or call ${OFFICE_PHONE}.`
      );
      trackFormSubmit("quote", "error", { error: result.body.error ?? `status_${result.status}` });
    }
  }

  function startOver() {
    clearFunnelState(window.sessionStorage);
    clearPendingQuote(window.sessionStorage);
    setPriced(null);
    setContact(null);
    setPending(null);
    setPendingError(null);
    setWaitedMs(0);
    setSelDate(null);
    setBanner(null);
    setNotice(null);
    setFieldErrors({});
  }

  function continueToCheckout() {
    if (!priced) return;
    // GL-17: an off-season enrollment has no day board — checkout is the
    // plan itself, date-less, billing starting today.
    const offSeasonCheckout = Boolean(priced.offSeason && priced.recurringOffer);
    if (!offSeasonCheckout && !selDate) return;
    if (isQuoteExpired(priced.expiresAt)) {
      startOver();
      setNotice(
        "This quote expired while you were choosing — prices are held for 24 hours. Fill the form in again for a fresh one."
      );
      return;
    }
    saveFunnelState(window.sessionStorage, {
      quote: priced,
      selection: offSeasonCheckout
        ? { date: null, recurring: true }
        : {
            date: selDate,
            // A plan-only (community) quote always checks out as the plan.
            recurring:
              (plan === "PLAN" || Boolean(priced.planOnly)) &&
              Boolean(priced.recurringOffer),
          },
    });
    navigate("/book");
  }

  const fieldError = (key: string) =>
    fieldErrors[key] ? (
      <div className="bk-field-error" role="alert">
        {fieldErrors[key]}
      </div>
    ) : null;

  // ── Submit in flight — the same loading screen, from second zero ──
  if (submitting) {
    return (
      <QuoteLoadingScreen
        eyebrow="Pricing your request"
        message="We're pricing your service and checking real availability. This usually takes just a few seconds."
        step={1}
      />
    );
  }

  // ── PENDING outcome — live async pricing + availability ──────────
  if (pending) {
    return (
      <QuoteLoadingScreen
        eyebrow="Your request is saved"
        message={pending.quote.message}
        step={pending.quote.stage === "BUILDING_AVAILABILITY" ? 3 : 2}
        pendingError={pendingError}
        longWait={waitedMs >= LONG_WAIT_MS}
        onChangeDetails={startOver}
      />
    );
  }

  // ── CONTACT outcome — the office really was emailed ───────────────
  if (contact) {
    return (
      <>
        <SEO title="Instant Quote" noindex />
        <section className="bk-section bk-section-light">
          <div className="bk-container bk-narrow bk-confirm">
            <div className="bk-form-success-icon" aria-hidden="true">
              <CheckIcon size={36} />
            </div>
            <div className="bk-eyebrow">Request received</div>
            <h1 className="bk-h2">We&rsquo;re on it.</h1>
            <p className="bk-body-lead">{contact.message}</p>
            <p className="bk-p">
              Prefer not to wait? Call us at <strong>{OFFICE_PHONE}</strong>.
            </p>
            <button type="button" className="bk-btn bk-btn-outline" onClick={startOver}>
              Start another quote
            </button>
          </div>
        </section>
      </>
    );
  }

  // ── PRICED outcome — day picker ───────────────────────────────────
  if (priced) {
    const selectedDay = priced.days.find((d) => d.date === selDate) ?? null;
    const offer = priced.recurringOffer;
    // Community/HOA: a plan-only quote — the day board picks the first
    // visit, the plan price itself does not vary by day.
    const planOnly = Boolean(priced.planOnly && offer);
    const requestedPlan = hasRequestedPlan(priced);
    const serviceChoices: ("ONE_TIME" | "PLAN")[] = requestedPlan
      ? ["PLAN", "ONE_TIME"]
      : ["ONE_TIME", "PLAN"];
    // GL-17: off-season seasonal enrollment — no day board at all; the
    // checkout is the plan, billing starts today, first treatment next
    // season (the office confirms the exact day).
    const offSeason = Boolean(priced.offSeason && offer);
    const expiresText = new Date(priced.expiresAt).toLocaleString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });

    return (
      <>
        <SEO title="Your Instant Quote" noindex />
        <section className="bk-section bk-section-light">
          <div className="bk-container bk-narrow">
            <div className="bk-eyebrow">Your instant quote</div>
            <h1 className="bk-h2">{priced.service}</h1>
            <p className="bk-body-lead">
              {offSeason
                ? "Enroll now — no date to pick today. This quote is held until "
                : planOnly
                  ? "Pick your first visit day. This quote is held until "
                  : "Pick a day. This quote is held until "}
              {expiresText}.
            </p>

            <div className="bk-form-card">
              {offSeason && offer && (
                <>
                  <h3 className="bk-form-step__title">Your seasonal plan</h3>
                  <div className="bk-booking-price-card">
                    <div className="bk-booking-price-card__label">
                      Monthly plan — billed year-round
                    </div>
                    <div className="bk-booking-price-card__price">
                      {money(offer.monthlyCents)}
                      <span className="bk-booking-price-card__per">/mo</span>
                    </div>
                    <div className="bk-booking-price-card__meta">
                      {priced.offSeasonMessage ??
                        "Mosquito season runs April–October. Enroll now and your plan starts today, billed monthly year-round, and we'll schedule your first treatment for April and confirm the exact day with you."}{" "}
                      {money(offer.initialFeeCents)} is due today (your first
                      month).
                    </div>
                  </div>
                </>
              )}
              {!offSeason && (
              <>
              {requestedPlan && offer && !planOnly && !selectedDay && (
                <>
                  <h3 className="bk-form-step__title">Your requested plan</h3>
                  <div className="bk-booking-price-card">
                    <div className="bk-booking-price-card__label">
                      {FREQUENCY_LABELS[offer.frequency]} plan
                    </div>
                    <div className="bk-booking-price-card__price">
                      {money(offer.monthlyCents)}
                      <span className="bk-booking-price-card__per">/mo</span>
                    </div>
                    <div className="bk-booking-price-card__meta">
                      {money(offer.initialFeeCents)} is due for your first visit;
                      the subscription starts after that visit is completed.
                    </div>
                  </div>
                </>
              )}
              <h3 className="bk-form-step__title">
                {planOnly ? "1. Pick your first visit day" : "1. Pick your day"}
              </h3>
              <div className="bk-day-grid">
                {priced.days.map((d) => (
                  <button
                    key={d.date}
                    type="button"
                    className={`bk-day-card ${selDate === d.date ? "is-active" : ""}`}
                    aria-pressed={selDate === d.date}
                    onClick={() => setSelDate(d.date)}
                  >
                    <div className="bk-day-card__date">{formatDay(d.date)}</div>
                    {!requestedPlan && (!planOnly || d.priceCents > 0) && (
                      <div className="bk-day-card__price">{money(d.priceCents)}</div>
                    )}
                  </button>
                ))}
              </div>

              {selectedDay && offer && planOnly && (
                <>
                  <h3 className="bk-form-step__title">2. Your plan</h3>
                  <div className="bk-booking-price-card">
                    <div className="bk-booking-price-card__label">
                      {FREQUENCY_LABELS[offer.frequency]} plan
                    </div>
                    <div className="bk-booking-price-card__price">
                      {money(offer.monthlyCents)}
                      <span className="bk-booking-price-card__per">/mo</span>
                    </div>
                    <div className="bk-booking-price-card__meta">
                      {hoaMoneyLine(offer)} The subscription starts after your
                      first completed visit.
                    </div>
                  </div>
                </>
              )}

              {selectedDay && offer && !planOnly && (
                <>
                  <h3 className="bk-form-step__title">
                    {requestedPlan
                      ? `2. Confirm your ${FREQUENCY_LABELS[offer.frequency].toLowerCase()} plan`
                      : "2. One-time or a plan?"}
                  </h3>
                  <div className="bk-choice-row">
                    {serviceChoices.map((choice) =>
                      choice === "PLAN" ? (
                        <button
                          key={choice}
                          type="button"
                          className={`bk-choice-card ${plan === "PLAN" ? "is-active" : ""}`}
                          aria-pressed={plan === "PLAN"}
                          onClick={() => setPlan("PLAN")}
                        >
                          <div className="bk-choice-card__title">
                            {money(offer.initialFeeCents)} today, then{" "}
                            {money(offer.monthlyCents)}/mo
                          </div>
                          <div className="bk-choice-card__meta">
                            {FREQUENCY_LABELS[offer.frequency]} plan — the monthly
                            subscription starts after your first completed visit
                          </div>
                        </button>
                      ) : (
                        <button
                          key={choice}
                          type="button"
                          className={`bk-choice-card ${plan === "ONE_TIME" ? "is-active" : ""}`}
                          aria-pressed={plan === "ONE_TIME"}
                          onClick={() => setPlan("ONE_TIME")}
                        >
                          <div className="bk-choice-card__title">
                            {money(selectedDay.priceCents)} today
                          </div>
                          <div className="bk-choice-card__meta">One-time treatment</div>
                        </button>
                      )
                    )}
                  </div>
                </>
              )}
              </>
              )}

              {notice && <div className="bk-notice">{notice}</div>}

              <div className="bk-form-step__actions">
                <button type="button" className="bk-btn bk-btn-outline" onClick={startOver}>
                  Start over
                </button>
                <button
                  type="button"
                  className="bk-btn bk-btn-primary"
                  disabled={offSeason ? false : !selDate}
                  onClick={continueToCheckout}
                >
                  Continue to booking &rarr;
                </button>
              </div>
            </div>
          </div>
        </section>
      </>
    );
  }

  // ── The quote form ────────────────────────────────────────────────
  return (
    <>
      <SEO
        title="Instant Pest Control Quote — Book Online"
        description="Get an instant price for pest control in Massachusetts and Rhode Island and book your visit online in minutes."
        jsonLd={buildBreadcrumbSchema([
          { name: "Home", url: "/" },
          { name: "Instant Quote", url: "/quote" },
        ])}
      />
      <section className="bk-section bk-section-light">
        <div className="bk-container bk-narrow">
          <div className="bk-eyebrow">Instant quote</div>
          <h1 className="bk-h2">Price it now, book it online.</h1>
          <p className="bk-body-lead">
            Tell us what you&rsquo;re dealing with and where. Every service
            gets an exact price and open days immediately, whether it&rsquo;s
            your home, your community, or your business.
          </p>

          <div className="bk-form-card">
            {leadPrefilled && (
              <div className="bk-notice" role="status">
                Contact and address details were loaded from the CRM. Confirm
                them, then choose the actual service and property details. Call
                consent remains unchecked unless the customer gives it now.
              </div>
            )}
            <form className="bk-form-wizard" onSubmit={handleSubmit} noValidate>
              <div className="bk-form-step">
                <h3 className="bk-form-step__title">What do you need?</h3>

                <div className="bk-field bk-full">
                  <label>Property type</label>
                  <div
                    className="bk-segmented bk-segmented--full"
                    role="radiogroup"
                    aria-label="Property type"
                  >
                    {(
                      [
                        ["RESIDENTIAL", "Residential"],
                        ["COMMUNITY", "Condo / HOA Community"],
                        ["COMMERCIAL", "Commercial"],
                      ] as [PropertyKind, string][]
                    ).map(([kind, label]) => (
                      <button
                        type="button"
                        key={kind}
                        className={`bk-seg ${fields.propertyKind === kind ? "is-active" : ""}`}
                        aria-pressed={fields.propertyKind === kind}
                        onClick={() =>
                          setFields((f) => ({
                            ...f,
                            propertyKind: kind,
                            // Community is plan-first: default to a Quarterly
                            // plan so the (newly priced) one-time visit is an
                            // explicit opt-in. Leaving it "" would silently
                            // default a common-area quote to one-time.
                            recurringPreference:
                              kind === "COMMUNITY" && f.recurringPreference === ""
                                ? "QUARTERLY"
                                : f.recurringPreference,
                          }))
                        }
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="bk-field bk-full">
                  <label htmlFor="bq-service">Service</label>
                  <select
                    id="bq-service"
                    value={fields.service}
                    onChange={(e) => set("service")(e.target.value)}
                  >
                    {SERVICE_OPTIONS.map((s) => (
                      <option key={s.code} value={s.code}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                  {fieldError("service")}
                </div>

                {needs.sqft && (
                  <div className="bk-field bk-full">
                    <label htmlFor="bq-sqft">Square footage *</label>
                    <input
                      id="bq-sqft"
                      type="text"
                      inputMode="numeric"
                      autoComplete="off"
                      value={fields.sqft}
                      onChange={(e) => set("sqft")(onlyDigits(e.target.value).slice(0, 5))}
                      placeholder="2400"
                    />
                    {fieldError("sqft")}
                  </div>
                )}

                {needs.nestCount && (
                  <div className="bk-field bk-full">
                    <label htmlFor="bq-nests">How many nests? *</label>
                    <input
                      id="bq-nests"
                      type="text"
                      inputMode="numeric"
                      autoComplete="off"
                      value={fields.nestCount}
                      onChange={(e) => set("nestCount")(onlyDigits(e.target.value).slice(0, 2))}
                      placeholder="1"
                    />
                    {fieldError("nestCount")}
                  </div>
                )}

                {needs.removalKind && (
                  <div className="bk-field bk-full">
                    <label htmlFor="bq-removal-kind">What needs removed? *</label>
                    <select
                      id="bq-removal-kind"
                      value={fields.removalKind}
                      onChange={(e) => set("removalKind")(e.target.value)}
                    >
                      <option value="" disabled>
                        Select what needs removed
                      </option>
                      {WILDLIFE_REMOVAL_KINDS.map((kind) => (
                        <option key={kind} value={kind}>
                          {kind}
                        </option>
                      ))}
                    </select>
                    {fieldError("removalKind")}
                  </div>
                )}

                {needs.removalCount && (
                  <div className="bk-field bk-full">
                    <label htmlFor="bq-removal-count">How many? *</label>
                    <input
                      id="bq-removal-count"
                      type="text"
                      inputMode="numeric"
                      autoComplete="off"
                      value={fields.removalCount}
                      onChange={(e) => set("removalCount")(onlyDigits(e.target.value).slice(0, 2))}
                      placeholder="1"
                    />
                    {fieldError("removalCount")}
                  </div>
                )}

                {needs.units && (
                  <div className="bk-field bk-full">
                    <label htmlFor="bq-units">How many units? *</label>
                    <input
                      id="bq-units"
                      type="text"
                      inputMode="numeric"
                      autoComplete="off"
                      value={fields.units}
                      onChange={(e) => set("units")(onlyDigits(e.target.value).slice(0, 5))}
                      placeholder="48"
                    />
                    {fieldError("units")}
                  </div>
                )}

                {needs.lotHalfAcres && (
                  <div className="bk-field bk-full">
                    <label htmlFor="bq-lot">Yard size *</label>
                    <select
                      id="bq-lot"
                      value={fields.lotHalfAcres}
                      onChange={(e) => set("lotHalfAcres")(e.target.value)}
                    >
                      <option value="1">Up to &frac12; acre</option>
                      <option value="2">Up to 1 acre</option>
                      <option value="3">Up to 1&frac12; acres</option>
                      <option value="4">Up to 2 acres</option>
                      <option value="6">Up to 3 acres</option>
                      <option value="8">Up to 4 acres</option>
                    </select>
                    <p className="bk-field-hint">
                      Treatments monthly April&ndash;October (7 per year), billed in
                      equal monthly installments year-round.
                    </p>
                    {fieldError("lotHalfAcres")}
                  </div>
                )}

                {isCommunity && !isSeasonal && !isCountOneTime && (
                  <div className="bk-field bk-full">
                    <label htmlFor="bq-cadence">How often should we visit?</label>
                    <select
                      id="bq-cadence"
                      value={fields.recurringPreference}
                      onChange={(e) => set("recurringPreference")(e.target.value)}
                    >
                      <option value="QUARTERLY">Quarterly visits</option>
                      <option value="BIMONTHLY">Every-2-months visits</option>
                      <option value="MONTHLY">Monthly visits</option>
                      <option value="">One-time visit only</option>
                    </select>
                  </div>
                )}

                {offersPlanChoice && (
                  <div className="bk-field bk-full">
                    <label htmlFor="bq-recurring">Ongoing protection?</label>
                    <select
                      id="bq-recurring"
                      value={fields.recurringPreference}
                      onChange={(e) => set("recurringPreference")(e.target.value)}
                    >
                      <option value="">One-time visit only</option>
                      <option value="QUARTERLY">Quarterly plan</option>
                      <option value="BIMONTHLY">Every-2-months plan</option>
                      <option value="MONTHLY">Monthly plan</option>
                    </select>
                  </div>
                )}

                <h3 className="bk-form-step__title">How can we reach you?</h3>

                <div className="bk-field bk-full">
                  <label htmlFor="bq-name">Full name *</label>
                  <input
                    id="bq-name"
                    value={fields.name}
                    onChange={(e) => set("name")(e.target.value)}
                    autoComplete="name"
                    required
                  />
                  {fieldError("name")}
                </div>

                <div className="bk-form-row">
                  <div className="bk-field">
                    <label htmlFor="bq-email">Email *</label>
                    <input
                      id="bq-email"
                      type="email"
                      value={fields.email}
                      onChange={(e) => set("email")(e.target.value)}
                      autoComplete="email"
                      placeholder="you@example.com"
                      required
                    />
                    {fieldError("email")}
                  </div>
                  <div className="bk-field">
                    <label htmlFor="bq-phone">Phone</label>
                    <input
                      id="bq-phone"
                      type="tel"
                      inputMode="tel"
                      value={fields.phone}
                      onChange={(e) => set("phone")(e.target.value)}
                      autoComplete="tel"
                      placeholder="(508) 555-0123"
                    />
                    {fieldError("phone")}
                  </div>
                </div>
                <label htmlFor="bq-call-consent" className="bk-consent">
                  <input
                    id="bq-call-consent"
                    type="checkbox"
                    checked={fields.callConsent}
                    onChange={(e) =>
                      setFields((f) => ({ ...f, callConsent: e.target.checked }))
                    }
                  />
                  <span>{CALL_CONSENT_TEXT}</span>
                </label>

                <h3 className="bk-form-step__title">Where is the property?</h3>

                <div className="bk-field bk-full">
                  <label htmlFor="bq-street">Street address *</label>
                  <AddressAutocompleteInput
                    id="bq-street"
                    value={fields.street}
                    onChangeText={(text) => set("street")(text)}
                    onResolved={(a) =>
                      setFields((f) => ({
                        ...f,
                        street: a.street,
                        city: a.city || f.city,
                        state: (a.state || f.state).toUpperCase().slice(0, 2),
                        zip: onlyDigits(a.zip || f.zip).slice(0, 5),
                      }))
                    }
                    autoComplete="street-address"
                    placeholder="123 Main Street"
                    required
                  />
                  {fieldError("address.street")}
                </div>

                <div className="bk-form-row bk-form-row--3">
                  <div className="bk-field">
                    <label htmlFor="bq-city">City *</label>
                    <input
                      id="bq-city"
                      value={fields.city}
                      onChange={(e) => set("city")(e.target.value)}
                      autoComplete="address-level2"
                      required
                    />
                    {fieldError("address.city")}
                  </div>
                  <div className="bk-field">
                    <label htmlFor="bq-state">State *</label>
                    <input
                      id="bq-state"
                      value={fields.state}
                      onChange={(e) =>
                        set("state")(e.target.value.toUpperCase().slice(0, 2))
                      }
                      autoComplete="address-level1"
                      placeholder="MA"
                      maxLength={2}
                      required
                    />
                    {fieldError("address.state")}
                  </div>
                  <div className="bk-field">
                    <label htmlFor="bq-zip">Zip</label>
                    <input
                      id="bq-zip"
                      type="text"
                      inputMode="numeric"
                      value={fields.zip}
                      onChange={(e) => set("zip")(onlyDigits(e.target.value).slice(0, 5))}
                      autoComplete="postal-code"
                      placeholder="01082"
                      maxLength={5}
                    />
                    {fieldError("address.zip")}
                  </div>
                </div>

                <div className="bk-field bk-full">
                  <label htmlFor="bq-comments">Anything we should know?</label>
                  <input
                    id="bq-comments"
                    value={fields.comments}
                    onChange={(e) => set("comments")(e.target.value.slice(0, 2000))}
                    placeholder="Gate code, pets, where you're seeing activity…"
                  />
                </div>

                {notice && <div className="bk-notice">{notice}</div>}
                {banner && (
                  <div className="bk-form-error" role="alert">
                    {banner}
                  </div>
                )}

                <div className="bk-form-step__actions">
                  <button
                    type="submit"
                    className="bk-btn bk-btn-primary"
                    disabled={submitting}
                    aria-busy={submitting}
                  >
                    {submitting ? "Pricing…" : "Get my instant price"}
                  </button>
                </div>
                <p className="bk-form-fineprint">
                  We only use these details to price and schedule your service.
                  In the rare case we can&rsquo;t price your address on the
                  spot, we&rsquo;ll follow up about this request, by phone if
                  you asked us to call, otherwise by email.
                </p>
              </div>
            </form>
          </div>
        </div>
      </section>
    </>
  );
}

/**
 * The one loading screen for the whole quote journey. Step 1 renders the
 * moment the form is submitted (the synchronous /quote call can take a few
 * seconds), steps 2 and 3 track the durable async request's stage. The
 * email-fallback hint and the change-details button only appear once the
 * request is saved server-side (step 2+), because before that there is
 * nothing durable to email a link to or reopen.
 */
function QuoteLoadingScreen({
  eyebrow,
  message,
  step,
  pendingError = null,
  longWait = false,
  onChangeDetails,
}: {
  eyebrow: string;
  message: string;
  step: 1 | 2 | 3;
  pendingError?: string | null;
  longWait?: boolean;
  onChangeDetails?: () => void;
}) {
  return (
    <>
      <SEO title="Preparing Your Instant Quote" noindex />
      <section className="bk-section bk-section-light">
        <div
          className="bk-container bk-narrow bk-confirm bk-quote-loading"
          role="status"
          aria-live="polite"
        >
          <div className="bk-quote-spinner" aria-hidden="true" />
          <div className="bk-eyebrow">{eyebrow}</div>
          <h1 className="bk-h2">We&rsquo;re building your exact quote.</h1>
          <p className="bk-body-lead">{message}</p>

          <ol className="bk-quote-progress" aria-label="Quote progress">
            <li className={step > 1 ? "is-done" : "is-active"}>
              <span aria-hidden="true">{step > 1 ? "✓" : "1"}</span>
              {step > 1
                ? "Property details checked"
                : "Checking your property details"}
            </li>
            <li className={step > 2 ? "is-done" : step === 2 ? "is-active" : ""}>
              <span aria-hidden="true">{step > 2 ? "✓" : "2"}</span>
              Exact service price
            </li>
            <li className={step === 3 ? "is-active" : ""}>
              <span aria-hidden="true">3</span>
              Available days
            </li>
          </ol>

          {pendingError && (
            <div className="bk-notice" role="alert">
              {pendingError}
            </div>
          )}

          {step > 1 && <BugZapper />}

          {step > 1 &&
            (longWait ? (
              <div className="bk-quote-loading__reassurance">
                <strong>You don&rsquo;t have to keep this page open.</strong>
                <p>
                  This is taking longer than usual. We&rsquo;ll email a secure
                  link to the finished quote automatically, and this page will
                  keep checking while you&rsquo;re here.
                </p>
              </div>
            ) : (
              <p className="bk-p bk-quote-loading__hint">
                Most quotes finish shortly. If you leave, we&rsquo;ll email a
                secure link as soon as it&rsquo;s ready.
              </p>
            ))}

          <p className="bk-p">
            Need help now? Call <strong>{OFFICE_PHONE}</strong>.
          </p>
          {onChangeDetails && (
            <button
              type="button"
              className="bk-btn bk-btn-outline"
              onClick={onChangeDetails}
            >
              Change my details
            </button>
          )}
        </div>
      </section>
    </>
  );
}

function CheckIcon({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
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
