/**
 * Landing Page 1: "Instant Quote Calculator"
 *
 * Conversion strategy: VALUE-FIRST / INSTANT GRATIFICATION
 * - Lead sees a price within 10 seconds of landing
 * - Interactive calculator creates investment (sunk-cost)
 * - Price reveal creates urgency to "lock it in"
 * - Minimal form after price is shown (progressive disclosure)
 */
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { submitLead } from "../../lib/leadIntake";
import SEO from "../../components/SEO";

const AGREEMENT_REDIRECT_DELAY = 4;

// Pricing logic mirrors handler.ts; tables are monthly billing rates.
const BASE: Record<string, number> = {
  "Association:Monthly": 110,
  "Association:Every 2 Months": 90,
  "Association:Every 3 Months": 70,
  "Residential:Monthly": 69,
  "Residential:Every 2 Months": 56,
  "Residential:Every 3 Months": 45,
};

const TIERS: Record<
  string,
  { threshold: number; tiers: { min: number; max: number; per: number; premium: number }[] }
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

function fmt(n: number) {
  return "$" + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

type Step = "calc" | "contact" | "done";

export default function LPQuote() {
  const [step, setStep] = useState<Step>("calc");
  const [type, setType] = useState<"Association" | "Residential">("Association");
  const [freq, setFreq] = useState("Monthly");
  const [cnt, setCnt] = useState("");
  const [price, setPrice] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
    company: "",
  });

  const cntNum = parseInt(cnt) || 0;
  const livePrice = cntNum > 0 ? calcPrice(type, freq, cntNum) : 0;

  // Auto-redirect to agreement signing page after submission
  useEffect(() => {
    if (step !== "done" || !agreementUrl) return;
    if (redirectCountdown <= 0) {
      window.location.href = agreementUrl;
      return;
    }
    const timer = setTimeout(() => {
      setRedirectCountdown((n) => n - 1);
    }, 1000);
    return () => clearTimeout(timer);
  }, [step, agreementUrl, redirectCountdown]);

  function handleCalc(e: FormEvent) {
    e.preventDefault();
    if (cntNum <= 0) return;
    setPrice(livePrice);
    setStep("contact");
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const result = await submitLead({
        propertyType: type,
        ...data,
        units: type === "Association" ? cnt : "",
        sqft: type === "Residential" ? cnt : "",
        freq,
      });
      if (result.ok) {
        const body = result.body as { agreementUrl?: string };
        if (body.agreementUrl) setAgreementUrl(body.agreementUrl);
        setStep("done");
      } else
        setError(
          "error" in result.body
            ? String(result.body.error)
            : "Something went wrong. Call 508-258-9294.",
        );
    } catch {
      setError("Network error. Please call 508-258-9294.");
    } finally {
      setSubmitting(false);
    }
  }

  const update =
    (k: keyof typeof data) => (e: React.ChangeEvent<HTMLInputElement>) =>
      setData({ ...data, [k]: e.target.value });

  return (
    <div className="bk-lp bk-lp--light">
      <SEO
        title="Get Your Instant Pest Control Quote"
        description="See your HOA or condo pest control price in seconds. No waiting, no sales calls — just your quote."
        noindex
      />

      <header className="bk-lp-header bk-lp-header--dark-on-light">
        <img src="/images/logo.png" alt="BuzzKill Pest Control" />
      </header>

      <main className="bk-lp-container">
        {step === "calc" && (
          <>
            <div style={{ textAlign: "center", marginBottom: 32 }}>
              <div className="bk-lp-eyebrow">Instant Quote</div>
              <h1 className="bk-lp-h1">See Your Price in Seconds</h1>
              <p
                className="bk-lp-lead"
                style={{ maxWidth: 460, margin: "0 auto" }}
              >
                No sales calls. No waiting. Just your customized pest control
                quote — instantly.
              </p>
            </div>

            <form
              onSubmit={handleCalc}
              className="bk-lp-card bk-lp-card--light"
            >
              <div className="bk-lp-field">
                <label className="bk-lp-field-label">Property type</label>
                <div
                  className="bk-segmented bk-segmented--full"
                  role="radiogroup"
                  aria-label="Property type"
                >
                  {(["Association", "Residential"] as const).map((opt) => (
                    <button
                      type="button"
                      key={opt}
                      className={`bk-seg ${type === opt ? "is-active" : ""}`}
                      aria-pressed={type === opt}
                      onClick={() => setType(opt)}
                    >
                      {opt === "Association" ? "HOA / Condo" : "Residential"}
                    </button>
                  ))}
                </div>
              </div>

              <div className="bk-lp-field">
                <label className="bk-lp-field-label" htmlFor="lp-cnt">
                  {type === "Association" ? "Number of units" : "Square footage"}
                </label>
                <input
                  id="lp-cnt"
                  type="number"
                  inputMode="numeric"
                  className="bk-lp-input bk-lp-input--light"
                  value={cnt}
                  onChange={(e) => setCnt(e.target.value)}
                  placeholder={type === "Association" ? "e.g. 48" : "e.g. 2400"}
                  required
                />
              </div>

              <div className="bk-lp-field">
                <label className="bk-lp-field-label" htmlFor="lp-freq">
                  Service frequency
                </label>
                <select
                  id="lp-freq"
                  className="bk-lp-input bk-lp-input--light"
                  value={freq}
                  onChange={(e) => setFreq(e.target.value)}
                >
                  <option>Monthly</option>
                  <option>Every 2 Months</option>
                  <option>Every 3 Months</option>
                </select>
              </div>

              {/* Live quote preview */}
              {livePrice > 0 && (
                <div
                  className="bk-lp-quote bk-lp-quote--card"
                  aria-live="polite"
                  style={{ marginTop: 16 }}
                >
                  <div className="bk-lp-quote-label">Estimated price</div>
                  <div className="bk-lp-quote-price">
                    {fmt(livePrice)}
                    <span className="bk-lp-quote-per">
                      / month <span className="bk-lp-quote-tax">+ tax</span>
                    </span>
                  </div>
                </div>
              )}

              <button
                type="submit"
                className="bk-btn bk-btn-primary bk-lp-cta"
                style={{ marginTop: 18 }}
              >
                {livePrice > 0 ? "Continue with this Quote →" : "Calculate My Quote"}
              </button>
            </form>

            <div className="bk-lp-trust">
              <div className="bk-lp-trust__item">
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                >
                  <path d="M20 6L9 17l-5-5" />
                </svg>
                Licensed &amp; Insured
              </div>
              <div className="bk-lp-trust__item">
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                >
                  <path d="M20 6L9 17l-5-5" />
                </svg>
                MA &bull; RI
              </div>
              <div className="bk-lp-trust__item">
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                >
                  <path d="M20 6L9 17l-5-5" />
                </svg>
                <a
                  href="tel:508-258-9294"
                  style={{ color: "inherit", textDecoration: "none" }}
                >
                  508-258-9294
                </a>
              </div>
            </div>
          </>
        )}

        {step === "contact" && (
          <>
            <div style={{ textAlign: "center", marginBottom: 28 }}>
              <div
                className="bk-lp-quote--card"
                style={{
                  padding: "16px 22px",
                  display: "inline-block",
                  marginBottom: 20,
                }}
              >
                <div className="bk-lp-quote-label">Your Quote</div>
                <div className="bk-lp-quote-price">
                  {fmt(price)}
                  <span className="bk-lp-quote-per">
                    / month <span className="bk-lp-quote-tax">+ tax</span>
                  </span>
                </div>
              </div>
              <h2 className="bk-lp-h2">Almost There</h2>
              <p className="bk-lp-lead">
                Enter your details and we&rsquo;ll send a formal quote with a
                service agreement within one business day.
              </p>
            </div>

            <form
              onSubmit={handleSubmit}
              className="bk-lp-card bk-lp-card--light"
            >
              {type === "Association" && (
                <div className="bk-lp-field">
                  <label className="bk-lp-field-label" htmlFor="lp-company">
                    Association name
                  </label>
                  <input
                    id="lp-company"
                    className="bk-lp-input bk-lp-input--light"
                    value={data.company}
                    onChange={update("company")}
                    placeholder="Brookfield Condo Trust"
                    autoComplete="organization"
                  />
                </div>
              )}
              <div className="bk-lp-row bk-lp-row--2">
                <div className="bk-lp-field" style={{ marginBottom: 0 }}>
                  <label className="bk-lp-field-label" htmlFor="lp-first">
                    First name *
                  </label>
                  <input
                    id="lp-first"
                    className="bk-lp-input bk-lp-input--light"
                    required
                    autoComplete="given-name"
                    value={data.first}
                    onChange={update("first")}
                  />
                </div>
                <div className="bk-lp-field" style={{ marginBottom: 0 }}>
                  <label className="bk-lp-field-label" htmlFor="lp-last">
                    Last name *
                  </label>
                  <input
                    id="lp-last"
                    className="bk-lp-input bk-lp-input--light"
                    required
                    autoComplete="family-name"
                    value={data.last}
                    onChange={update("last")}
                  />
                </div>
              </div>
              <div className="bk-lp-row bk-lp-row--2">
                <div className="bk-lp-field" style={{ marginBottom: 0 }}>
                  <label className="bk-lp-field-label" htmlFor="lp-email">
                    Email *
                  </label>
                  <input
                    id="lp-email"
                    className="bk-lp-input bk-lp-input--light"
                    required
                    type="email"
                    autoComplete="email"
                    value={data.email}
                    onChange={update("email")}
                  />
                </div>
                <div className="bk-lp-field" style={{ marginBottom: 0 }}>
                  <label className="bk-lp-field-label" htmlFor="lp-phone">
                    Phone *
                  </label>
                  <input
                    id="lp-phone"
                    className="bk-lp-input bk-lp-input--light"
                    required
                    type="tel"
                    autoComplete="tel"
                    value={data.phone}
                    onChange={update("phone")}
                  />
                </div>
              </div>
              <div className="bk-lp-field">
                <label className="bk-lp-field-label" htmlFor="lp-addr">
                  Service address *
                </label>
                <input
                  id="lp-addr"
                  className="bk-lp-input bk-lp-input--light"
                  required
                  autoComplete="street-address"
                  value={data.addr}
                  onChange={update("addr")}
                />
              </div>
              <div className="bk-lp-row bk-lp-row--3">
                <div className="bk-lp-field" style={{ marginBottom: 0 }}>
                  <label className="bk-lp-field-label" htmlFor="lp-city">
                    City *
                  </label>
                  <input
                    id="lp-city"
                    className="bk-lp-input bk-lp-input--light"
                    required
                    autoComplete="address-level2"
                    value={data.city}
                    onChange={update("city")}
                  />
                </div>
                <div className="bk-lp-field" style={{ marginBottom: 0 }}>
                  <label className="bk-lp-field-label" htmlFor="lp-state">
                    State *
                  </label>
                  <input
                    id="lp-state"
                    className="bk-lp-input bk-lp-input--light"
                    required
                    maxLength={2}
                    autoComplete="address-level1"
                    value={data.state}
                    onChange={(e) =>
                      setData({
                        ...data,
                        state: e.target.value.toUpperCase().slice(0, 2),
                      })
                    }
                  />
                </div>
                <div className="bk-lp-field" style={{ marginBottom: 0 }}>
                  <label className="bk-lp-field-label" htmlFor="lp-zip">
                    Zip *
                  </label>
                  <input
                    id="lp-zip"
                    className="bk-lp-input bk-lp-input--light"
                    required
                    inputMode="numeric"
                    autoComplete="postal-code"
                    value={data.zip}
                    onChange={update("zip")}
                  />
                </div>
              </div>

              {error && (
                <div className="bk-lp-error" role="alert">
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={submitting}
                aria-busy={submitting}
                className="bk-btn bk-btn-primary bk-lp-cta"
                style={{ marginTop: 6 }}
              >
                {submitting ? "Submitting…" : "Get My Formal Quote & Agreement"}
              </button>
            </form>

            <button
              type="button"
              className="bk-lp-textlink"
              onClick={() => setStep("calc")}
            >
              ← Recalculate
            </button>
          </>
        )}

        {step === "done" && (
          <div style={{ textAlign: "center", paddingTop: 24 }}>
            <div className="bk-lp-success-icon" aria-hidden="true">
              <svg
                width="32"
                height="32"
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
            <h2 className="bk-lp-h2">You&rsquo;re All Set!</h2>

            <div
              className="bk-lp-quote--card bk-lp-quote-card--center"
              style={{
                display: "inline-block",
                margin: "16px 0 24px",
                padding: "16px 24px",
              }}
            >
              <div className="bk-lp-quote-label">Your Estimated Quote</div>
              <div className="bk-lp-quote-price">
                {fmt(price)}
                <span className="bk-lp-quote-per">
                  / month <span className="bk-lp-quote-tax">+ tax</span>
                </span>
              </div>
            </div>

            {agreementUrl ? (
              <>
                <p
                  className="bk-lp-lead"
                  style={{ maxWidth: 460, margin: "0 auto 18px" }}
                >
                  Your service agreement is ready to sign.
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
                  className="bk-btn bk-btn-primary bk-lp-cta"
                  style={{ maxWidth: 360, margin: "0 auto" }}
                >
                  Review &amp; Sign Agreement Now &rarr;
                </a>
                <p
                  style={{
                    fontSize: 13,
                    color: "var(--fg3)",
                    marginTop: 18,
                    maxWidth: 420,
                    marginLeft: "auto",
                    marginRight: "auto",
                  }}
                >
                  A copy was also sent to <strong>{data.email}</strong>.
                  (Check your spam folder if you don&rsquo;t see it.)
                </p>
              </>
            ) : (
              <p
                className="bk-lp-lead"
                style={{ maxWidth: 420, margin: "0 auto 12px" }}
              >
                We&rsquo;ve sent a confirmation and quote to{" "}
                <strong>{data.email}</strong>. You&rsquo;ll receive a formal
                service agreement within one business day.
              </p>
            )}

            <p style={{ fontSize: 14, color: "var(--fg3)", marginTop: 16 }}>
              Questions? Call{" "}
              <a
                href="tel:508-258-9294"
                style={{ color: "var(--bk-green-deep)", fontWeight: 600 }}
              >
                508-258-9294
              </a>
            </p>

            <div className="bk-lp-trust">
              <div className="bk-lp-trust__item">
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                >
                  <path d="M20 6L9 17l-5-5" />
                </svg>
                Licensed &amp; Insured
              </div>
              <div className="bk-lp-trust__item">
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                >
                  <path d="M20 6L9 17l-5-5" />
                </svg>
                Reply within 1 business day
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
