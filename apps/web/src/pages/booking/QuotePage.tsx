import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import SEO, { buildBreadcrumbSchema } from "../../components/SEO";
import { AddressAutocompleteInput } from "../../lib/addressAutocomplete";
import {
  requestQuote,
  type ContactQuote,
  type PricedQuote,
  type PropertyKind,
  type QuoteRequest,
  type RecurringFrequency,
  type ServiceCode,
  type WindowCode,
} from "../../lib/bookingApi";
import {
  FREQUENCY_LABELS,
  SERVICE_OPTIONS,
  clearFunnelState,
  formatDay,
  isQuoteExpired,
  loadFunnelState,
  money,
  saveFunnelState,
  serviceOption,
  validateQuoteForm,
  windowLabel,
} from "../../lib/bookingFunnel";

const OFFICE_PHONE = "508-258-9294";

type Fields = {
  name: string;
  email: string;
  phone: string;
  service: string;
  propertyKind: PropertyKind;
  street: string;
  city: string;
  state: string;
  zip: string;
  sqft: string;
  nestCount: string;
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
  street: "",
  city: "",
  state: "MA",
  zip: "",
  sqft: "",
  nestCount: "1",
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
  const [submitting, setSubmitting] = useState(false);
  const [priced, setPriced] = useState<PricedQuote | null>(null);
  const [contact, setContact] = useState<ContactQuote | null>(null);

  // Day-picker selection
  const [selDate, setSelDate] = useState<string | null>(null);
  const [selWindow, setSelWindow] = useState<WindowCode | null>(null);
  const [plan, setPlan] = useState<"ONE_TIME" | "PLAN">("ONE_TIME");

  // A refresh (or a round trip to /book) must not lose the quote.
  useEffect(() => {
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
      setSelWindow(stored.selection.window);
      setPlan(stored.selection.recurring ? "PLAN" : "ONE_TIME");
    }
  }, []);

  const set = (k: keyof Fields) => (v: string) =>
    setFields((f) => ({ ...f, [k]: v }));

  const svc = serviceOption(fields.service);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setBanner(null);
    setNotice(null);

    const errors = validateQuoteForm(fields);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    const payload: QuoteRequest = {
      name: fields.name.trim(),
      email: fields.email.trim(),
      phone: fields.phone.trim() || undefined,
      service: fields.service as ServiceCode,
      propertyKind: fields.propertyKind,
      address: {
        street: fields.street.trim(),
        city: fields.city.trim(),
        state: fields.state.trim(),
        zip: fields.zip.trim() || undefined,
      },
      sqft: svc?.needsSqft ? parseInt(fields.sqft, 10) : undefined,
      nestCount: svc?.needsNestCount ? parseInt(fields.nestCount, 10) : undefined,
      comments: fields.comments.trim() || undefined,
      recurringPreference:
        fields.service === "GENERAL_PEST" && fields.recurringPreference
          ? fields.recurringPreference
          : undefined,
    };

    setSubmitting(true);
    const result = await requestQuote(payload);
    setSubmitting(false);

    if (result.ok) {
      if (result.body.decision === "PRICED") {
        setPriced(result.body);
        setSelDate(null);
        setSelWindow(null);
        setPlan(fields.recurringPreference ? "PLAN" : "ONE_TIME");
        saveFunnelState(window.sessionStorage, { quote: result.body });
        window.scrollTo({ top: 0, behavior: "smooth" });
      } else {
        setContact(result.body);
        clearFunnelState(window.sessionStorage);
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
      return;
    }

    // Server-side rejection: field errors when we have them, otherwise the
    // server's message verbatim — it's written for customers (429, bot check).
    if (result.body.errors && Object.keys(result.body.errors).length > 0) {
      setFieldErrors(result.body.errors);
      setBanner("A few details need another look — see the fields below.");
    } else {
      setBanner(
        result.body.error ??
          `Something went wrong (status ${result.status}). Please try again or call ${OFFICE_PHONE}.`
      );
    }
  }

  function startOver() {
    clearFunnelState(window.sessionStorage);
    setPriced(null);
    setContact(null);
    setSelDate(null);
    setSelWindow(null);
    setBanner(null);
    setNotice(null);
    setFieldErrors({});
  }

  function continueToCheckout() {
    if (!priced || !selDate || !selWindow) return;
    if (isQuoteExpired(priced.expiresAt)) {
      startOver();
      setNotice(
        "This quote expired while you were choosing — prices are held for 24 hours. Fill the form in again for a fresh one."
      );
      return;
    }
    saveFunnelState(window.sessionStorage, {
      quote: priced,
      selection: {
        date: selDate,
        window: selWindow,
        recurring: plan === "PLAN" && Boolean(priced.recurringOffer),
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
              Pick a day and arrival window. This quote is held until{" "}
              {expiresText}.
            </p>

            <div className="bk-form-card">
              <h3 className="bk-form-step__title">1. Pick your day</h3>
              <div className="bk-day-grid">
                {priced.days.map((d) => (
                  <button
                    key={d.date}
                    type="button"
                    className={`bk-day-card ${selDate === d.date ? "is-active" : ""}`}
                    aria-pressed={selDate === d.date}
                    onClick={() => {
                      setSelDate(d.date);
                      setSelWindow(
                        d.windows.length === 1 ? (d.windows[0] as WindowCode) : null
                      );
                    }}
                  >
                    <div className="bk-day-card__date">{formatDay(d.date)}</div>
                    <div className="bk-day-card__price">{money(d.priceCents)}</div>
                  </button>
                ))}
              </div>

              {selectedDay && (
                <>
                  <h3 className="bk-form-step__title">2. Morning or afternoon?</h3>
                  <div className="bk-choice-row">
                    {selectedDay.windows.map((w) => (
                      <button
                        key={w}
                        type="button"
                        className={`bk-choice-card ${selWindow === w ? "is-active" : ""}`}
                        aria-pressed={selWindow === w}
                        onClick={() => setSelWindow(w as WindowCode)}
                      >
                        <div className="bk-choice-card__title">{windowLabel(w)}</div>
                      </button>
                    ))}
                  </div>
                </>
              )}

              {selectedDay && selWindow && offer && (
                <>
                  <h3 className="bk-form-step__title">3. One-time or a plan?</h3>
                  <div className="bk-choice-row">
                    <button
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
                    <button
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
                  </div>
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
                  disabled={!selDate || !selWindow}
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
            Tell us what you&rsquo;re dealing with and where. Most services get
            an exact price and open days immediately — the rest get a
            specialist call within the hour.
          </p>

          <div className="bk-form-card">
            <form className="bk-form-wizard" onSubmit={handleSubmit} noValidate>
              <div className="bk-form-step">
                <h3 className="bk-form-step__title">What do you need?</h3>

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
                        ["COMMUNITY", "Condo / HOA"],
                        ["COMMERCIAL", "Commercial"],
                      ] as [PropertyKind, string][]
                    ).map(([kind, label]) => (
                      <button
                        type="button"
                        key={kind}
                        className={`bk-seg ${fields.propertyKind === kind ? "is-active" : ""}`}
                        aria-pressed={fields.propertyKind === kind}
                        onClick={() => set("propertyKind")(kind)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                {svc?.needsSqft && (
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

                {svc?.needsNestCount && (
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

                {fields.service === "GENERAL_PEST" && (
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
                <p style={{ fontSize: 12, opacity: 0.7, marginTop: 10 }}>
                  We only use these details to price and schedule your service.
                  If your service needs a specialist, we&rsquo;ll call you about
                  this request.
                </p>
              </div>
            </form>
          </div>
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
