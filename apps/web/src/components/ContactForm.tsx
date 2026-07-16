import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AddressAutocompleteInput } from "../lib/addressAutocomplete";
import type { FormEvent } from "react";
import { submitLead } from "../lib/leadIntake";

// Seconds to wait before auto-redirecting to the agreement signing page
const AGREEMENT_REDIRECT_DELAY = 4;

type PropertyType = "Association" | "Residential" | "Specialty";

type ContactFormProps = {
  eyebrow?: string;
  title?: string;
  intro?: string;
};

// Pricing logic mirrors the Lambda handler so we can show a live quote
const BASE: Record<string, number> = {
  "Association:Monthly": 110,
  "Association:Every 2 Months": 90,
  "Association:Every 3 Months": 70,
  "Association:One-time treatment": 312,
  "Residential:Monthly": 69,
  "Residential:Every 2 Months": 56,
  "Residential:Every 3 Months": 45,
  "Residential:One-time treatment": 300,
};

const TIERS: Record<
  string,
  {
    threshold: number;
    tiers: { min: number; max: number; per: number; premium: number }[];
  }
> = {
  "Association:Monthly": {
    threshold: 10,
    tiers: [
      { min: 11, max: 25, per: 15, premium: 55 },
      { min: 26, max: 50, per: 25, premium: 100 },
      { min: 51, max: 100, per: 50, premium: 140 },
      { min: 101, max: 0, per: 100, premium: 275 },
    ],
  },
  "Association:Every 2 Months": {
    threshold: 10,
    tiers: [
      { min: 11, max: 25, per: 15, premium: 40 },
      { min: 26, max: 50, per: 25, premium: 80 },
      { min: 51, max: 100, per: 50, premium: 115 },
      { min: 101, max: 0, per: 100, premium: 150 },
    ],
  },
  "Association:Every 3 Months": {
    threshold: 10,
    tiers: [
      { min: 11, max: 25, per: 15, premium: 35 },
      { min: 26, max: 50, per: 25, premium: 65 },
      { min: 51, max: 100, per: 50, premium: 90 },
      { min: 101, max: 0, per: 100, premium: 180 },
    ],
  },
  "Residential:Monthly": {
    threshold: 1000,
    tiers: [
      { min: 1001, max: 4000, per: 1000, premium: 15 },
      { min: 4001, max: 0, per: 1000, premium: 23 },
    ],
  },
  "Residential:Every 2 Months": {
    threshold: 1000,
    tiers: [
      { min: 1001, max: 4000, per: 1000, premium: 13 },
      { min: 4001, max: 0, per: 1000, premium: 19 },
    ],
  },
  "Residential:Every 3 Months": {
    threshold: 1000,
    tiers: [
      { min: 1001, max: 4000, per: 1000, premium: 10 },
      { min: 4001, max: 0, per: 1000, premium: 15 },
    ],
  },
  "Association:One-time treatment": {
    threshold: 10,
    tiers: [
      { min: 11, max: 25, per: 15, premium: 156 },
      { min: 26, max: 50, per: 25, premium: 288 },
      { min: 51, max: 100, per: 50, premium: 396 },
      { min: 101, max: 0, per: 100, premium: 792 },
    ],
  },
  "Residential:One-time treatment": {
    threshold: 2500,
    tiers: [{ min: 2501, max: 0, per: 1000, premium: 13 }],
  },
};

const SPECIALTY_SERVICES = [
  "Wasp Nest Removal",
  "Rodent Nest Removal",
  "Rodent Exclusion (Exterior Only)",
  "Termite Bait Stations",
  "Other Specialty Service",
];

const SPECIALTY_PRICES: Record<string, number | null> = {
  "Wasp Nest Removal": 299,
  "Rodent Nest Removal": 399,
  "Rodent Exclusion (Exterior Only)": 600,
  "Termite Bait Stations": null,
  "Other Specialty Service": null,
};

function calcPrice(type: string, freq: string, cnt: number): number {
  const key = `${type}:${freq}`;
  const base = BASE[key] ?? 0;
  const config = TIERS[key];
  if (!config || cnt <= config.threshold) return base;
  let prem = 0;
  for (const t of config.tiers) {
    if (cnt < t.min) break;
    const mx = t.max === 0 ? Infinity : t.max;
    const units = Math.min(cnt, mx) - t.min + 1;
    prem += Math.ceil(units / t.per) * t.premium;
  }
  return base + prem;
}

// Pricing tables are monthly billing rates for both Association and
// Residential. The calc result is displayed as-is with a "/month" label.
//
// These are an INDICATIVE on-page estimate only — they are a hand-copied third
// copy of the numbers in crm-pricing/rateCards.ts and have drifted from them
// before. The binding price comes from the CRM rate card, applied by a human.
// Do not reintroduce a pricing path that quotes or contracts from this table.

function fmt(n: number): string {
  return "$" + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Stored verbatim on the lead as evidence of what the customer agreed to. */
export const CONTACT_CONSENT_TEXT =
  "By submitting this form, you agree that BuzzKill may contact you by phone, text or email about your pest control enquiry. Message and data rates may apply.";

// ── Input sanitizers ───────────────────────────────────────────────
// These run on every onChange so the input value can never contain
// anything other than what we accept. Pasted strings are also filtered.

function onlyDigits(s: string): string {
  return s.replace(/\D+/g, "");
}

/** Format a phone-number input as `(XXX) XXX-XXXX` while the user types. */
function formatPhoneAsTyped(raw: string): string {
  const d = onlyDigits(raw).slice(0, 10);
  if (!d) return "";
  if (d.length <= 3) return `(${d}`;
  if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6, 10)}`;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isValidEmail = (s: string) => EMAIL_RE.test(s.trim());
const isCompletePhone = (s: string) => onlyDigits(s).length === 10;
const isCompleteZip = (s: string) => onlyDigits(s).length === 5;

const STEPS = [
  { num: 1, label: "Property" },
  { num: 2, label: "Contact" },
  { num: 3, label: "Address" },
];

export default function ContactForm({
  eyebrow = "Get Started",
  title = "Request a Free Quote",
  intro = "Tell us about your property and we'll send a custom quote within one business day.",
}: ContactFormProps) {
  const [step, setStep] = useState(1);
  const [type, setType] = useState<PropertyType>("Association");
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [quote, setQuote] = useState<{
    amount: number;
    frequency: string;
  } | null>(null);
  const [agreementUrl, setAgreementUrl] = useState<string | null>(null);
  const [redirectCountdown, setRedirectCountdown] = useState<number>(
    AGREEMENT_REDIRECT_DELAY,
  );
  const [data, setData] = useState({
    first: "",
    last: "",
    email: "",
    phone: "",
    addr: "",
    city: "",
    state: "MA",
    zip: "",
    units: "",
    sqft: "",
    freq: "Monthly",
    company: "",
    specialtyService: "",
    specialtyPropertyType: "",
  });

  const update =
    (k: keyof typeof data) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      setData({ ...data, [k]: e.target.value });
    };

  // Auto-redirect to agreement signing page after submission.
  // Email may go to spam, so we proactively send the user to the link.
  useEffect(() => {
    if (!submitted || !agreementUrl) return;
    if (redirectCountdown <= 0) {
      window.location.href = agreementUrl;
      return;
    }
    const timer = setTimeout(() => {
      setRedirectCountdown((n) => n - 1);
    }, 1000);
    return () => clearTimeout(timer);
  }, [submitted, agreementUrl, redirectCountdown]);

  // Live monthly price preview from current form state
  const cntNum = parseInt(type === "Association" ? data.units : data.sqft) || 0;
  const livePrice = cntNum > 0 && type !== "Specialty" ? calcPrice(type, data.freq, cntNum) : 0;
  const specialtyPrice = type === "Specialty" && data.specialtyService
    ? SPECIALTY_PRICES[data.specialtyService]
    : undefined;

  function nextStep() {
    setStep((s) => Math.min(s + 1, 3));
  }

  function prevStep() {
    setStep((s) => Math.max(s - 1, 1));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;

    // Client-side validation — covers the cases the digit-only filters
    // can't catch on their own (e.g. user typed 4 of 5 zip digits).
    const validationErrors: string[] = [];
    if (!data.first.trim() || !data.last.trim())
      validationErrors.push("first and last name");
    if (!isValidEmail(data.email))
      validationErrors.push("a valid email address");
    if (!isCompletePhone(data.phone))
      validationErrors.push("a 10-digit phone number");
    if (!data.addr.trim()) validationErrors.push("a service address");
    if (!data.city.trim()) validationErrors.push("a city");
    if (data.state.trim().length !== 2)
      validationErrors.push("a 2-letter state code");
    if (!isCompleteZip(data.zip))
      validationErrors.push("a 5-digit zip code");
    if (type === "Association" && !data.units)
      validationErrors.push("the number of units");
    if (type === "Residential" && !data.sqft)
      validationErrors.push("square footage");
    if (type === "Specialty" && !data.specialtyPropertyType)
      validationErrors.push("a location type");
    if (type === "Specialty" && !data.specialtyService)
      validationErrors.push("a specialty service");
    if (validationErrors.length > 0) {
      setErrorMsg(`Please enter ${validationErrors.join(", ")}.`);
      return;
    }

    setSubmitting(true);
    setErrorMsg(null);
    try {
      const result = await submitLead({
        propertyType: type,
        ...data,
        formId: "contact",
        consentToContact: true,
        consentText: CONTACT_CONSENT_TEXT,
      });
      if (result.ok) {
        const body = result.body as {
          monthlyCharge?: number;
          frequency?: string;
          agreementUrl?: string;
        };
        if (body.monthlyCharge) {
          setQuote({
            amount: body.monthlyCharge,
            frequency: body.frequency ?? data.freq,
          });
        }
        if (body.agreementUrl) {
          setAgreementUrl(body.agreementUrl);
        }
        setSubmitted(true);
      } else {
        const msg =
          ("error" in result.body && result.body.error) ||
          `Something went wrong (status ${result.status}). Please try again or call 508-258-9294.`;
        setErrorMsg(String(msg));
      }
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : "Network error. Please try again or call 508-258-9294.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  // ── Success state ──────────────────────────────────────────────────
  if (submitted) {
    const fmtPrice = quote ? fmt(quote.amount) : null;

    return (
      <section className="bk-section bk-section-light" id="form">
        <div className="bk-container bk-narrow bk-confirm">
          <div className="bk-form-success-icon" aria-hidden="true">
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
          </div>
          <div className="bk-eyebrow">Confirmation</div>
          <h2 className="bk-h2">Request received.</h2>

          {fmtPrice && (
            <div className="bk-quote-card">
              <div className="bk-quote-card__label">Your Estimated Quote</div>
              <div className="bk-quote-card__price">
                {fmtPrice}
                <span className="bk-quote-card__per">
                  {quote?.frequency === "One-time treatment"
                    ? " one-time + tax"
                    : " / month + tax"}
                </span>
              </div>
              <div className="bk-quote-card__meta">
                {type === "Association" ? "Association / HOA" : "Residential"}{" "}
                &bull;{" "}
                {quote?.frequency === "One-time treatment"
                  ? "One-time treatment"
                  : `${quote?.frequency} service`}
              </div>
            </div>
          )}

          {agreementUrl ? (
            <>
              <p className="bk-body-lead">
                Thanks{data.first ? `, ${data.first}` : ""}! Your service
                agreement is ready to sign.
                {redirectCountdown > 0 && (
                  <>
                    {" "}
                    Redirecting you in{" "}
                    <strong>{redirectCountdown}</strong> second
                    {redirectCountdown === 1 ? "" : "s"}…
                  </>
                )}
              </p>
              <a
                href={agreementUrl}
                className="bk-btn bk-btn-primary"
                style={{ marginRight: 12 }}
              >
                Review &amp; Sign Agreement Now &rarr;
              </a>
              <p
                style={{
                  fontSize: 13,
                  color: "var(--fg2)",
                  marginTop: 18,
                  lineHeight: 1.55,
                }}
              >
                A copy was also sent to{" "}
                <strong>{data.email || "your email"}</strong>. (Check your spam
                folder if you don&rsquo;t see it.)
              </p>
            </>
          ) : (
            <>
              <p className="bk-body-lead">
                Thanks{data.first ? `, ${data.first}` : ""}! A confirmation and
                agreement have been sent to{" "}
                <strong>{data.email || "your email"}</strong>. Sign the
                agreement to schedule your first appointment.
              </p>
              <button
                type="button"
                className="bk-btn bk-btn-outline"
                onClick={() => {
                  setSubmitted(false);
                  setQuote(null);
                  setAgreementUrl(null);
                  setRedirectCountdown(AGREEMENT_REDIRECT_DELAY);
                  setStep(1);
                }}
              >
                Submit Another
              </button>
            </>
          )}
        </div>
      </section>
    );
  }

  // ── Form ──────────────────────────────────────────────────────────
  return (
    <section className="bk-section bk-section-light" id="form">
      <div className="bk-container bk-narrow">
        <div className="bk-eyebrow">{eyebrow}</div>
        <h2 className="bk-h2">{title}</h2>
        <p className="bk-body-lead">{intro}</p>

        <Link to="/quote" className="bk-instant-quote-banner">
          <strong>Want a price right now?</strong> Get an instant quote and
          book online &rarr;
        </Link>

        <div className="bk-form-card">
          {/* Step indicator */}
          <div className="bk-stepper" role="progressbar" aria-valuenow={step} aria-valuemin={1} aria-valuemax={3}>
            {STEPS.map((s, i) => (
              <div
                key={s.num}
                className={`bk-stepper__step ${
                  step === s.num ? "is-active" : ""
                } ${step > s.num ? "is-done" : ""}`}
              >
                <div className="bk-stepper__num">
                  {step > s.num ? (
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="3"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                  ) : (
                    s.num
                  )}
                </div>
                <div className="bk-stepper__label">{s.label}</div>
                {i < STEPS.length - 1 && (
                  <div className="bk-stepper__line" aria-hidden="true" />
                )}
              </div>
            ))}
          </div>

          <form className="bk-form-wizard" onSubmit={handleSubmit}>
            {/* ── STEP 1: Property ─────────────────────────────── */}
            {step === 1 && (
              <div className="bk-form-step">
                <h3 className="bk-form-step__title">Tell us about your property</h3>

                <div className="bk-field bk-full">
                  <label>Property type</label>
                  <div
                    className="bk-segmented bk-segmented--full"
                    role="radiogroup"
                    aria-label="Property type"
                  >
                    {(["Association", "Residential", "Specialty"] as PropertyType[]).map(
                      (opt) => (
                        <button
                          type="button"
                          key={opt}
                          className={`bk-seg ${type === opt ? "is-active" : ""}`}
                          aria-pressed={type === opt}
                          onClick={() => setType(opt)}
                        >
                          {opt === "Association" ? "Association / HOA" : opt === "Specialty" ? "Specialty Services" : opt}
                        </button>
                      ),
                    )}
                  </div>
                </div>

                {type === "Association" ? (
                  <>
                    <div className="bk-field bk-full">
                      <label htmlFor="company">Association name</label>
                      <input
                        id="company"
                        value={data.company}
                        onChange={update("company")}
                        placeholder="Brookfield Condominium Trust"
                      />
                    </div>
                    <div className="bk-field bk-full">
                      <label htmlFor="units">Number of units</label>
                      <input
                        id="units"
                        type="text"
                        inputMode="numeric"
                        autoComplete="off"
                        value={data.units}
                        onChange={(e) =>
                          setData({
                            ...data,
                            units: onlyDigits(e.target.value),
                          })
                        }
                        onPaste={(e) => {
                          e.preventDefault();
                          const pasted = e.clipboardData.getData("text");
                          setData({
                            ...data,
                            units: onlyDigits(pasted),
                          });
                        }}
                        placeholder="48"
                      />
                    </div>
                  </>
                ) : type === "Residential" ? (
                  <div className="bk-field bk-full">
                    <label htmlFor="sqft">Square footage</label>
                    <input
                      id="sqft"
                      type="text"
                      inputMode="numeric"
                      autoComplete="off"
                      value={data.sqft}
                      onChange={(e) =>
                        setData({ ...data, sqft: onlyDigits(e.target.value) })
                      }
                      onPaste={(e) => {
                        e.preventDefault();
                        const pasted = e.clipboardData.getData("text");
                        setData({ ...data, sqft: onlyDigits(pasted) });
                      }}
                      placeholder="2400"
                    />
                  </div>
                ) : null}

                {type !== "Specialty" && (
                  <div className="bk-field bk-full">
                    <label htmlFor="freq">Service frequency</label>
                    <select id="freq" value={data.freq} onChange={update("freq")}>
                      <option>Monthly</option>
                      <option>Every 2 Months</option>
                      <option>Every 3 Months</option>
                      <option>One-time treatment</option>
                    </select>
                  </div>
                )}

                {type === "Specialty" && (
                  <>
                    <div className="bk-field bk-full">
                      <label htmlFor="specialtyPropertyType">Location type</label>
                      <select
                        id="specialtyPropertyType"
                        value={data.specialtyPropertyType}
                        onChange={update("specialtyPropertyType")}
                      >
                        <option value="">— Choose location type —</option>
                        <option value="Association">Association / HOA</option>
                        <option value="Residential">Residential</option>
                      </select>
                    </div>

                    <div className="bk-field bk-full">
                      <label htmlFor="specialtyService">Select service</label>
                      <select
                        id="specialtyService"
                        value={data.specialtyService}
                        onChange={update("specialtyService")}
                      >
                        <option value="">— Choose a service —</option>
                        {SPECIALTY_SERVICES.map((s) => (
                          <option key={s} value={s}>{s}</option>
                        ))}
                      </select>
                    </div>
                  </>
                )}

                {/* Live quote preview — standard types */}
                {livePrice > 0 && type !== "Specialty" && (
                  <div className="bk-quote-preview" aria-live="polite">
                    <div className="bk-quote-preview__label">Estimated price</div>
                    <div className="bk-quote-preview__price">
                      {fmt(livePrice)}
                      <span className="bk-quote-preview__per">
                        {data.freq === "One-time treatment"
                          ? " one-time + tax"
                          : " / month + tax"}
                      </span>
                    </div>
                  </div>
                )}

                {/* Specialty price preview */}
                {type === "Specialty" && data.specialtyService && (
                  <div className="bk-quote-preview" aria-live="polite">
                    {data.specialtyService === "Termite Bait Stations" ? (
                      <>
                        <div className="bk-quote-preview__label">Next step</div>
                        <div style={{ fontFamily: "var(--font-body)", fontWeight: 700, fontSize: 15, lineHeight: 1.5 }}>
                          Termite bait station pricing is based on your property's square footage and site conditions. Click Continue to request a professional inspection and receive a custom quote.
                        </div>
                      </>
                    ) : specialtyPrice !== null && specialtyPrice !== undefined ? (
                      <>
                        <div className="bk-quote-preview__label">Estimated price</div>
                        <div className="bk-quote-preview__price">
                          {fmt(specialtyPrice)}
                          <span className="bk-quote-preview__per"> one-time + tax</span>
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="bk-quote-preview__label">Next step</div>
                        <div style={{ fontFamily: "var(--font-body)", fontWeight: 700, fontSize: 15, lineHeight: 1.5 }}>
                          Pricing for this service varies based on your specific needs. Click Continue and one of our specialists will follow up with a tailored quote.
                        </div>
                      </>
                    )}
                  </div>
                )}

                <div className="bk-form-step__actions">
                  <button
                    type="button"
                    className="bk-btn bk-btn-primary"
                    onClick={nextStep}
                    disabled={
                      type === "Association" ? !data.units :
                      type === "Residential" ? !data.sqft :
                      !data.specialtyPropertyType || !data.specialtyService
                    }
                  >
                    Continue &rarr;
                  </button>
                </div>
              </div>
            )}

            {/* ── STEP 2: Contact ──────────────────────────────── */}
            {step === 2 && (
              <div className="bk-form-step">
                <h3 className="bk-form-step__title">How can we reach you?</h3>

                <div className="bk-form-row">
                  <div className="bk-field">
                    <label htmlFor="first">First name *</label>
                    <input
                      id="first"
                      value={data.first}
                      onChange={update("first")}
                      autoComplete="given-name"
                      required
                    />
                  </div>
                  <div className="bk-field">
                    <label htmlFor="last">Last name *</label>
                    <input
                      id="last"
                      value={data.last}
                      onChange={update("last")}
                      autoComplete="family-name"
                      required
                    />
                  </div>
                </div>

                <div className="bk-field bk-full">
                  <label htmlFor="email">Email *</label>
                  <input
                    id="email"
                    type="email"
                    value={data.email}
                    onChange={update("email")}
                    autoComplete="email"
                    placeholder="you@example.com"
                    required
                  />
                </div>

                <div className="bk-field bk-full">
                  <label htmlFor="phone">Phone *</label>
                  <input
                    id="phone"
                    type="tel"
                    inputMode="tel"
                    value={data.phone}
                    onChange={(e) =>
                      setData({
                        ...data,
                        phone: formatPhoneAsTyped(e.target.value),
                      })
                    }
                    onPaste={(e) => {
                      e.preventDefault();
                      const pasted = e.clipboardData.getData("text");
                      setData({
                        ...data,
                        phone: formatPhoneAsTyped(pasted),
                      });
                    }}
                    autoComplete="tel"
                    placeholder="(508) 555-0123"
                    maxLength={14}
                    required
                  />
                </div>

                <div className="bk-form-step__actions">
                  <button
                    type="button"
                    className="bk-btn bk-btn-outline"
                    onClick={prevStep}
                  >
                    &larr; Back
                  </button>
                  <button
                    type="button"
                    className="bk-btn bk-btn-primary"
                    onClick={nextStep}
                    disabled={
                      !data.first.trim() ||
                      !data.last.trim() ||
                      !isValidEmail(data.email) ||
                      !isCompletePhone(data.phone)
                    }
                  >
                    Continue &rarr;
                  </button>
                </div>
              </div>
            )}

            {/* ── STEP 3: Address ──────────────────────────────── */}
            {step === 3 && (
              <div className="bk-form-step">
                <h3 className="bk-form-step__title">Where is the property?</h3>

                <div className="bk-field bk-full">
                  <label htmlFor="addr">Service address *</label>
                  <AddressAutocompleteInput
                    id="addr"
                    value={data.addr}
                    onChangeText={(text) => setData({ ...data, addr: text })}
                    onResolved={(a) =>
                      setData({
                        ...data,
                        addr: a.street,
                        city: a.city || data.city,
                        state: (a.state || data.state).toUpperCase().slice(0, 2),
                        zip: onlyDigits(a.zip || data.zip).slice(0, 5),
                      })
                    }
                    autoComplete="street-address"
                    placeholder="123 Main Street"
                    required
                  />
                </div>

                <div className="bk-form-row bk-form-row--3">
                  <div className="bk-field">
                    <label htmlFor="city">City *</label>
                    <input
                      id="city"
                      value={data.city}
                      onChange={update("city")}
                      autoComplete="address-level2"
                      required
                    />
                  </div>
                  <div className="bk-field">
                    <label htmlFor="state">State *</label>
                    <input
                      id="state"
                      value={data.state}
                      onChange={(e) =>
                        setData({
                          ...data,
                          state: e.target.value.toUpperCase().slice(0, 2),
                        })
                      }
                      autoComplete="address-level1"
                      placeholder="MA"
                      maxLength={2}
                      required
                    />
                  </div>
                  <div className="bk-field">
                    <label htmlFor="zip">Zip *</label>
                    <input
                      id="zip"
                      type="text"
                      inputMode="numeric"
                      value={data.zip}
                      onChange={(e) =>
                        setData({
                          ...data,
                          zip: onlyDigits(e.target.value).slice(0, 5),
                        })
                      }
                      onPaste={(e) => {
                        e.preventDefault();
                        const pasted = e.clipboardData.getData("text");
                        setData({
                          ...data,
                          zip: onlyDigits(pasted).slice(0, 5),
                        });
                      }}
                      autoComplete="postal-code"
                      placeholder="01752"
                      maxLength={5}
                      pattern="\d{5}"
                      required
                    />
                  </div>
                </div>

                {/* Recap card */}
                {livePrice > 0 && (
                  <div className="bk-quote-preview">
                    <div className="bk-quote-preview__label">
                      Your Estimated Quote
                    </div>
                    <div className="bk-quote-preview__price">
                      {fmt(livePrice)}
                      <span className="bk-quote-preview__per">
                        {data.freq === "One-time treatment"
                          ? " one-time + tax"
                          : " / month + tax"}
                      </span>
                    </div>
                    <div className="bk-quote-preview__meta">
                      {type === "Association"
                        ? "Association / HOA"
                        : "Residential"}{" "}
                      &bull;{" "}
                      {data.freq === "One-time treatment"
                        ? "One-time treatment"
                        : `${data.freq} service`}
                    </div>
                  </div>
                )}

                {errorMsg && (
                  <div className="bk-form-error" role="alert">
                    {errorMsg}
                  </div>
                )}

                <div className="bk-form-step__actions">
                  <button
                    type="button"
                    className="bk-btn bk-btn-outline"
                    onClick={prevStep}
                  >
                    &larr; Back
                  </button>
                  <button
                    type="submit"
                    className="bk-btn bk-btn-primary"
                    disabled={submitting}
                    aria-busy={submitting}
                  >
                    {submitting ? "Submitting…" : "Get My Quote"}
                  </button>
                </div>
                <p style={{ fontSize: 12, opacity: 0.7, marginTop: 10 }}>
                  {CONTACT_CONSENT_TEXT}
                </p>
              </div>
            )}
          </form>
        </div>

        {/* Trust bar */}
        <div className="bk-form-trust">
          {[
            "Licensed & Insured",
            "MA • RI",
            "No Obligation",
            "Reply within 1 business day",
          ].map((t, i) => (
            <div key={i} className="bk-form-trust__item">
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="M20 6L9 17l-5-5" />
              </svg>
              {t}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
