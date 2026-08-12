import { useEffect, useRef, useState } from "react";
import { CALL_CONSENT_TEXT_VERSION } from "../../../amplify/functions/shared/consentText";
import type { FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import SEO, { buildBreadcrumbSchema } from "../../components/SEO";
import BugZapper from "../../components/BugZapper";
import ContactMeForm from "../../components/ContactMeForm";
import FormContactFooter from "../../components/FormContactFooter";
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
  type QuoteDay,
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

/**
 * Which of the two doors the visitor is standing in. CONTACT is the default:
 * most people arriving on a pest-control site want a human, and the instant
 * quote asks for property details they may not have to hand. QUOTE is the
 * opt-in for someone who would rather price and book it themselves.
 */
type Mode = "CONTACT" | "QUOTE";

/** Each door has its own URL, so it can be linked, bookmarked, and measured. */
const MODE_PATH: Record<Mode, string> = {
  QUOTE: "/quote/instant",
  CONTACT: "/quote/contact-me",
};

/**
 * Bare `/quote` opens the contact door, the same default the tabs render.
 * Anything under /quote/ that isn't the instant slug reads as contact too, so
 * a typo lands on a working page instead of an empty one.
 */
function modeFromPath(pathname: string): Mode {
  return pathname === MODE_PATH.QUOTE ? "QUOTE" : "CONTACT";
}

type Fields = {
  name: string;
  email: string;
  phone: string;
  service: string;
  propertyKind: PropertyKind;
  /** Condo/HOA only: one unit on its own — quoted like a residential visit. */
  inUnit: boolean;
  /** "Tell us what you need" — freeform, read into the fields below. */
  describe: string;
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
  service: "GENERAL_PEST",
  propertyKind: "RESIDENTIAL",
  inUnit: false,
  describe: "",
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
  const { pathname } = useLocation();
  const [mode, setMode] = useState<Mode>(() => modeFromPath(pathname));
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
        // An office-sent link exists to price a known lead, so it opens on the
        // pricing door rather than the contact one.
        setMode("QUOTE");
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
      setMode("QUOTE");
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
      setMode("QUOTE");
      setWaitedMs(Math.max(0, Date.now() - savedPending.startedAt));
      return;
    }

    const stored = loadFunnelState(window.sessionStorage);
    if (!stored) return;
    setMode("QUOTE");
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

  // The tabs are links, so the door follows the URL: a click, the back button,
  // and a pasted /quote/instant all land the same way. Guarded against the
  // first run, because the mount effect above may have opened the pricing door
  // for a resumed quote or an office-sent link that bare /quote can't express.
  const lastPath = useRef(pathname);
  useEffect(() => {
    if (lastPath.current === pathname) return;
    lastPath.current = pathname;
    setMode(modeFromPath(pathname));
  }, [pathname]);

  const set = (k: keyof Fields) => (v: string) =>
    setFields((f) => ({ ...f, [k]: v }));

  const needs = quoteFieldNeeds(fields.service, fields.propertyKind, fields.inUnit);
  const isCommunity = fields.propertyKind === "COMMUNITY";
  // Wasp and wildlife are one-time visits priced by count at EVERY property
  // class — they carry no plan/cadence choice (the server never offers one).
  const isCountOneTime =
    fields.service === "WASP_NEST" || fields.service === "WILDLIFE";
  // GP-style plan preference: residential general pest and every commercial
  // service (commercial prices like general pest, one-time + plans).
  const isSeasonal = serviceOption(fields.service)?.seasonal === true;
  // Which cadences THIS quote may offer. A commercial quote prices off the
  // commercial sheet, which carries all three whatever the pest; a residential
  // quote sells exactly what the service's catalog entry says it sells (rodent
  // is a quarterly program only). Driving this from the catalog instead of a
  // hard-coded service list means adding a plan to a service is a catalog edit.
  // "Tell us what you need" is a different WAY to fill the same form, not a
  // different quote: the description is read into the same service/size fields
  // and priced by the same engine, so nothing downstream has to know about it.
  const describeMode = fields.service === "__DESCRIBE__";
  const planCadences: RecurringFrequency[] =
    fields.propertyKind === "COMMERCIAL"
      ? ["QUARTERLY", "BIMONTHLY", "MONTHLY"]
      : (serviceOption(fields.service)?.cadences ?? []);
  const offersPlanChoice =
    !isSeasonal &&
    !isCountOneTime &&
    fields.propertyKind !== "COMMUNITY" &&
    planCadences.length > 0;

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
      // GL-03: the request itself is the basis for replying, so a phone number
      // typed into this form is callable. The form shows no consent notice;
      // consentText.ts records that, and the version stamped here points at it.
      callConsent: true,
      callConsentTextVersion: CALL_CONSENT_TEXT_VERSION,
      service: fields.service as ServiceCode,
      describe: describeMode ? fields.describe.trim() || undefined : undefined,
      propertyKind: fields.propertyKind,
      // Only meaningful at a community; the server ignores it elsewhere.
      inUnit: fields.propertyKind === "COMMUNITY" ? fields.inUnit : undefined,
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
        trackFormSubmit("quote", "success", { decision: result.body.decision, booking_id: result.body.bookingId });
        // A CONTACT decision IS the lead — there's no price to pay, the office
        // follows up. This is the funnel's generate_lead.
        trackGenerateLead("quote_contact", result.body.bookingId);
      } else {
        // GL-06: a fresh submission can't reach a payment state, but a
        // replayed one can — show the durable truth.
        setBanner(result.body.message);
        clearPendingQuote(window.sessionStorage);
        window.scrollTo({ top: 0, behavior: "smooth" });
        // PROCESSING / BOOKED / PAYMENT_FAILED / ERROR — a replay, not a new
        // lead, so no generate_lead here. Report the real decision.
        trackFormSubmit("quote", "success", { decision: result.body.decision, booking_id: result.body.bookingId });
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
    // They were mid-quote, so "start over" means another quote, not the
    // contact form they never chose.
    setMode("QUOTE");
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
            <FormContactFooter lead="Prefer not to wait?" />
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
    // visit, and the plan's MONTHLY rate does not vary by day.
    const planOnly = Boolean(priced.planOnly && offer);
    const requestedPlan = hasRequestedPlan(priced);
    /**
     * What a tile shows: the amount due TODAY on the offer being sold.
     *
     * On a plan quote that is the first visit's fee, which the server prices
     * per day off route density — so a day where a technician is already
     * working nearby reads as real money saved, and the customer's choice
     * seeds the cluster every later visit in the plan inherits.
     *
     * On a one-time quote it is the day's price. A plan-only quote with no
     * per-day fee (an older stored quote) shows nothing rather than repeating
     * the flat plan total the card above already states.
     */
    const tilePrice = (
      d: QuoteDay
    ): { cents: number; note?: string } | null => {
      const planFee = d.planInitialFeeCents;
      if (planOnly || requestedPlan) {
        return planFee != null ? { cents: planFee, note: "first visit" } : null;
      }
      return { cents: d.priceCents };
    };
    /** The best first-visit fee anywhere on the board, for the "as low as"
     *  line shown before a day is chosen. Null when no day carries one. */
    const planFees = priced.days
      .map((d) => d.planInitialFeeCents)
      .filter((c): c is number => typeof c === "number");
    const lowestPlanFee = planFees.length > 0 ? Math.min(...planFees) : null;
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

            {/* Priced straight from what they typed, so the reading behind the
                price is stated plainly and is one click from being fixed. A
                misread is only catchable here, before they book. */}
            {priced.describedAs?.length ? (
              <div className="bk-described" style={{ marginBottom: 16 }}>
                <strong className="small">We read that as:</strong>
                <ul style={{ margin: "6px 0 8px", paddingLeft: 18 }}>
                  {priced.describedAs.map((a) => (
                    <li key={a} className="small">
                      {a}
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  className="bk-linklike"
                  onClick={() => {
                    setPriced(null);
                    setFields((f) => ({ ...f, service: "" }));
                  }}
                >
                  Not right? Pick your service instead
                </button>
              </div>
            ) : null}

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
                      {/* No day is chosen yet, so this states the list fee —
                          and, when some day beats it, says so rather than
                          being silently undercut by the tiles below. */}
                      {lowestPlanFee != null &&
                      lowestPlanFee < offer.initialFeeCents ? (
                        <>
                          Your first visit is {money(offer.initialFeeCents)}, and
                          as low as {money(lowestPlanFee)} on days we&rsquo;re
                          already working nearby. The subscription starts after
                          that visit is completed.
                        </>
                      ) : (
                        <>
                          {money(offer.initialFeeCents)} is due for your first
                          visit; the subscription starts after that visit is
                          completed.
                        </>
                      )}
                    </div>
                  </div>
                </>
              )}
              <h3 className="bk-form-step__title">
                {planOnly ? "1. Pick your first visit day" : "1. Pick your day"}
              </h3>
              <div className="bk-day-grid">
                {priced.days.map((d) => {
                  const tile = tilePrice(d);
                  return (
                  <button
                    key={d.date}
                    type="button"
                    className={`bk-day-card ${selDate === d.date ? "is-active" : ""}`}
                    aria-pressed={selDate === d.date}
                    onClick={() => setSelDate(d.date)}
                  >
                    <div className="bk-day-card__date">{formatDay(d.date)}</div>
                    {tile && (
                      <div className="bk-day-card__price">
                        {money(tile.cents)}
                        {/* The qualifier keeps a plan tile from reading as the
                            monthly rate — it is what is due at booking. */}
                        {tile.note && (
                          <span className="bk-day-card__price-note">
                            {tile.note}
                          </span>
                        )}
                      </div>
                    )}
                  </button>
                  );
                })}
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
                      {hoaMoneyLine(offer, selectedDay.planInitialFeeCents)} The
                      subscription starts after your first completed visit.
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
                            {/* The chosen day's fee — what /book will actually
                                charge. Showing the flat list fee here would
                                contradict the tile the customer just clicked. */}
                            {money(
                              selectedDay.planInitialFeeCents ??
                                offer.initialFeeCents
                            )}{" "}
                            today, then {money(offer.monthlyCents)}/mo
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
              <FormContactFooter className="bk-full" lead="Questions first?" />
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
          <div className="bk-eyebrow">
            {mode === "CONTACT" ? "Get in touch" : "Instant quote"}
          </div>
          <h1 className="bk-h2">
            {mode === "CONTACT"
              ? "Tell us what you need."
              : "Price it now, book it online."}
          </h1>
          <p className="bk-body-lead">
            {mode === "CONTACT"
              ? "Leave your details and a local BuzzKill expert follows up. Or price it yourself in a couple of minutes with an instant quote."
              : "Tell us what you're dealing with and where. Every service gets an exact price and open days immediately, whether it's your home, your community, or your business."}
          </p>

          <nav className="bk-mode-tabs" aria-label="How would you like to start?">
            <Link
              to={MODE_PATH.QUOTE}
              className={`bk-mode-tab bk-mode-tab--magic ${mode === "QUOTE" ? "is-active" : ""}`}
              // Named explicitly: the label sits in a span next to a decorative
              // icon, so this keeps the name off the icon's rendering.
              aria-label="Instant Quote"
              aria-current={mode === "QUOTE" ? "page" : undefined}
            >
              <SparkleIcon />
              <span>Instant Quote</span>
            </Link>
            <Link
              to={MODE_PATH.CONTACT}
              className={`bk-mode-tab ${mode === "CONTACT" ? "is-active" : ""}`}
              aria-current={mode === "CONTACT" ? "page" : undefined}
            >
              Contact Me
            </Link>
          </nav>

          {mode === "CONTACT" ? (
            <div className="bk-form-card">
              <ContactMeForm formId="quote-contact" />
            </div>
          ) : (
          <div className="bk-form-card">
            {leadPrefilled && (
              <div className="bk-notice" role="status">
                Contact and address details were loaded from the CRM. Confirm
                them, then choose the actual service and property details.
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
                            // The flag only exists at a community — drop it
                            // when leaving, so it can never silently ride along
                            // on a residential or commercial quote.
                            inUnit: kind === "COMMUNITY" ? f.inUnit : false,
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

                {/* Condo/HOA only: an ask for ONE unit is a single apartment
                    treated on its own, not a common-area program priced per
                    unit across the association — so it is quoted like a
                    residential visit. */}
                {fields.propertyKind === "COMMUNITY" ? (
                  <div className="bk-field bk-full">
                    <label>What are we treating?</label>
                    <div
                      className="bk-segmented bk-segmented--full"
                      role="radiogroup"
                      aria-label="What are we treating?"
                    >
                      {(
                        [
                          [false, "Common areas"],
                          [true, "One unit"],
                        ] as [boolean, string][]
                      ).map(([unit, label]) => (
                        <button
                          type="button"
                          key={label}
                          className={`bk-seg ${Boolean(fields.inUnit) === unit ? "is-active" : ""}`}
                          aria-pressed={Boolean(fields.inUnit) === unit}
                          onClick={() =>
                            setFields((f) => ({ ...f, inUnit: unit }))
                          }
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <p className="bk-field-hint">
                      One unit means we treat that apartment on its own, not the
                      common areas, so we price it like a single-home visit.
                    </p>
                  </div>
                ) : null}

                <div className="bk-field bk-full">
                  <label htmlFor="bq-service">Service</label>
                  <select
                    id="bq-service"
                    value={fields.service}
                    onChange={(e) => {
                      const next = e.target.value;
                      setFields((f) => {
                        // A cadence the NEW service doesn't sell must not
                        // survive the switch — it would quote a plan that has
                        // no price (e.g. Monthly carried onto rodent).
                        const allowed =
                          f.propertyKind === "COMMERCIAL"
                            ? (["QUARTERLY", "BIMONTHLY", "MONTHLY"] as RecurringFrequency[])
                            : (serviceOption(next)?.cadences ?? []);
                        return {
                          ...f,
                          service: next,
                          recurringPreference:
                            f.recurringPreference &&
                            allowed.includes(f.recurringPreference)
                              ? f.recurringPreference
                              : "",
                        };
                      });
                    }}
                  >
                    {SERVICE_OPTIONS.map((s) => (
                      <option key={s.code} value={s.code}>
                        {s.label}
                      </option>
                    ))}
                    <option value="__DESCRIBE__">
                      Not sure — tell us what you need
                    </option>
                  </select>
                  {fieldError("service")}
                  {describeMode ? (
                    <div style={{ marginTop: 10 }}>
                      <label htmlFor="bq-describe">
                        Tell us what you need
                      </label>
                      <textarea
                        id="bq-describe"
                        rows={4}
                        maxLength={1000}
                        value={fields.describe}
                        onChange={(e) => set("describe")(e.target.value)}
                        placeholder="e.g. Mice in the kitchen of my 2,000 sq ft house — I'd like ongoing service, not just one visit."
                      />
                      <p className="bk-hint" style={{ marginTop: 4 }}>
                        Include the pest, the property size, and whether you
                        want a one-time visit or ongoing service. We'll price it
                        the same way as the form.
                      </p>
                      {fieldError("describe")}
                    </div>
                  ) : null}
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
                      {planCadences.map((c) => (
                        <option key={c} value={c}>
                          {FREQUENCY_LABELS[c]} plan
                        </option>
                      ))}
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
                    <label htmlFor="bq-zip">Zip *</label>
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
                <FormContactFooter className="bk-full" />
              </div>
            </form>
          </div>
          )}
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

/**
 * The instant-quote tab's mark. Two stars of different weights read as "this
 * one does the work for you" without leaning on an emoji, which would inherit
 * the platform's own colour and break the button's gradient.
 */
function SparkleIcon() {
  return (
    <svg
      className="bk-mode-tab__sparkle"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 2.5l1.9 5.3a4 4 0 0 0 2.4 2.4l5.2 1.8-5.2 1.9a4 4 0 0 0-2.4 2.4L12 21.5l-1.9-5.2a4 4 0 0 0-2.4-2.4L2.5 12l5.2-1.8a4 4 0 0 0 2.4-2.4L12 2.5z" />
      <path
        d="M18.6 2.2l.7 1.9a1.6 1.6 0 0 0 .9.9l1.9.7-1.9.7a1.6 1.6 0 0 0-.9 1l-.7 1.8-.7-1.9a1.6 1.6 0 0 0-.9-.9l-1.9-.7 1.9-.7a1.6 1.6 0 0 0 .9-.9l.7-1.9z"
        opacity="0.85"
      />
    </svg>
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
