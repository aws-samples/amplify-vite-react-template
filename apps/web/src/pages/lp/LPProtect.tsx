/**
 * Landing Page 2: "Protect Your Community"
 *
 * Conversion strategy: PROBLEM → PAIN → SOLUTION + SOCIAL PROOF + URGENCY
 * - Opens with the pain of uncontrolled pest issues in HOAs
 * - Shows consequences of inaction (complaints, health, property value)
 * - Social proof: number of communities served, trust signals
 * - Urgency: seasonal messaging, limited capacity
 * - Single CTA: Request a free assessment
 */
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { submitLead } from "../../lib/leadIntake";
import SEO from "../../components/SEO";

const AGREEMENT_REDIRECT_DELAY = 4;

const STATS = [
  {
    num: "67%",
    text: "of condo pest issues originate in shared spaces, not individual units",
  },
  {
    num: "3×",
    text: "more expensive to treat reactively than with a preventative program",
  },
  {
    num: "#1",
    text: "resident complaint category for HOA boards — ahead of parking and noise",
  },
];

const BENEFITS = [
  "Common areas, basements, exteriors — covered",
  "Optional discounted in-unit service for owners",
  "Board-friendly documentation and scheduling",
  "Licensed & insured in MA and RI",
];

function CheckIcon() {
  return (
    <svg
      width="20"
      height="20"
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
  );
}

export default function LPProtect() {
  const [submitted, setSubmitted] = useState(false);
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
    units: "",
  });

  const update =
    (k: keyof typeof data) => (e: React.ChangeEvent<HTMLInputElement>) =>
      setData({ ...data, [k]: e.target.value });

  // Auto-redirect to agreement signing page after submission
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

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const result = await submitLead({
        propertyType: "Association",
        ...data,
        sqft: "",
        freq: "Monthly",
      });
      if (result.ok) {
        const body = result.body as { agreementUrl?: string };
        if (body.agreementUrl) setAgreementUrl(body.agreementUrl);
        setSubmitted(true);
      } else
        setError(
          "error" in result.body
            ? String(result.body.error)
            : "Something went wrong. Please call 508-258-9294.",
        );
    } catch {
      setError("Network error. Please call 508-258-9294.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="bk-lp bk-lp--dark">
      <SEO
        title="Stop Pest Complaints Before They Escalate"
        description="Professional HOA and condo pest control that protects your community, your residents, and your property value. Free assessment."
        noindex
      />

      <header className="bk-lp-header bk-lp-header--bordered">
        <img src="/images/logo.png" alt="BuzzKill Pest Control" />
      </header>

      {/* Hero — problem statement */}
      <section
        className="bk-lp-section bk-lp-section--hero"
        style={{ textAlign: "center" }}
      >
        <div
          className="bk-lp-section__inner"
          style={{ maxWidth: 720, margin: "0 auto" }}
        >
          <div className="bk-lp-eyebrow bk-lp-eyebrow--dark">
            For HOA Boards &amp; Property Managers
          </div>
          <h1 className="bk-lp-h1 bk-lp-h1--xl">
            Pest Complaints Don&rsquo;t Solve Themselves
          </h1>
          <p
            className="bk-lp-lead"
            style={{ maxWidth: 560, margin: "0 auto", fontSize: 18 }}
          >
            When pests show up in one unit, they&rsquo;re already in the walls.
            One-off treatments don&rsquo;t fix building-wide problems.{" "}
            <strong style={{ color: "#fff" }}>
              Your community needs a plan.
            </strong>
          </p>
        </div>
      </section>

      {/* Pain point stats */}
      <section
        style={{
          padding: "0 24px 48px",
          maxWidth: 800,
          margin: "0 auto",
          width: "100%",
        }}
      >
        <div className="bk-lp-stats">
          {STATS.map((s, i) => (
            <div key={i} className="bk-lp-stat">
              <div className="bk-lp-stat__num">{s.num}</div>
              <p className="bk-lp-stat__text">{s.text}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Solution + benefits */}
      <section className="bk-lp-section bk-lp-section--inner-dark">
        <div className="bk-lp-section__inner" style={{ maxWidth: 640 }}>
          <h2 className="bk-lp-h2">
            Building-Wide Protection.
            <br />
            <span style={{ color: "var(--bk-green)" }}>
              Not Band-Aid Treatments.
            </span>
          </h2>
          <ul className="bk-lp-bullets" style={{ marginTop: 28 }}>
            {BENEFITS.map((t, i) => (
              <li key={i} className="bk-lp-bullets__item">
                <CheckIcon />
                <span>{t}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* Urgency banner */}
      <div className="bk-lp-urgency">
        Peak pest season is here. We&rsquo;re booking new communities now for
        spring/summer coverage.
      </div>

      {/* Form or success */}
      <section
        style={{ padding: "56px 24px 80px", flex: 1 }}
      >
        <div
          className="bk-lp-container bk-lp-container--narrow"
          style={{ padding: 0 }}
        >
          {submitted ? (
            <div style={{ textAlign: "center", padding: "20px 0" }}>
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
              <h2 className="bk-lp-h2">
                {agreementUrl ? "You're All Set!" : "We'll Be in Touch"}
              </h2>
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
                      color: "rgba(255,255,255,0.5)",
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
                  style={{ maxWidth: 420, margin: "0 auto" }}
                >
                  A BuzzKill specialist will contact you within one business
                  day to discuss your community&rsquo;s needs and schedule a
                  free assessment.
                </p>
              )}
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
                  Reply within 1 business day
                </div>
              </div>
            </div>
          ) : (
            <>
              <div style={{ textAlign: "center", marginBottom: 24 }}>
                <h2 className="bk-lp-h2">Request a Free Assessment</h2>
                <p className="bk-lp-lead">
                  We&rsquo;ll evaluate your property and build a custom plan.
                  No obligation.
                </p>
              </div>

              <form
                onSubmit={handleSubmit}
                className="bk-lp-card bk-lp-card--dark"
              >
                <div className="bk-lp-field">
                  <label className="bk-lp-field-label" htmlFor="lp-company">
                    Association / Property name *
                  </label>
                  <input
                    id="lp-company"
                    className="bk-lp-input bk-lp-input--dark"
                    required
                    autoComplete="organization"
                    value={data.company}
                    onChange={update("company")}
                  />
                </div>

                <div className="bk-lp-row bk-lp-row--2">
                  <div className="bk-lp-field" style={{ marginBottom: 0 }}>
                    <label className="bk-lp-field-label" htmlFor="lp-first">
                      First name *
                    </label>
                    <input
                      id="lp-first"
                      className="bk-lp-input bk-lp-input--dark"
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
                      className="bk-lp-input bk-lp-input--dark"
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
                      className="bk-lp-input bk-lp-input--dark"
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
                      className="bk-lp-input bk-lp-input--dark"
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
                    Property address *
                  </label>
                  <input
                    id="lp-addr"
                    className="bk-lp-input bk-lp-input--dark"
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
                      className="bk-lp-input bk-lp-input--dark"
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
                      className="bk-lp-input bk-lp-input--dark"
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
                      className="bk-lp-input bk-lp-input--dark"
                      required
                      inputMode="numeric"
                      autoComplete="postal-code"
                      value={data.zip}
                      onChange={update("zip")}
                    />
                  </div>
                </div>

                <div className="bk-lp-field">
                  <label className="bk-lp-field-label" htmlFor="lp-units">
                    Approx. unit count
                  </label>
                  <input
                    id="lp-units"
                    className="bk-lp-input bk-lp-input--dark"
                    inputMode="numeric"
                    placeholder="e.g. 48"
                    value={data.units}
                    onChange={update("units")}
                  />
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
                >
                  {submitting ? "Submitting…" : "Get My Free Assessment"}
                </button>

                <p
                  style={{
                    textAlign: "center",
                    fontSize: 12,
                    color: "rgba(255,255,255,0.4)",
                    marginTop: 14,
                    marginBottom: 0,
                  }}
                >
                  No obligation. No pressure. Just a plan that works.
                </p>
              </form>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
