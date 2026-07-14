/**
 * Resident In-Unit Signup Page
 *
 * URL: /schedule/:slug
 * Example: /schedule/river-village-condominium
 *
 * Pre-fills property name, address, city, state, zip from Buildium sync.
 * Resident only enters: unit number, name, phone, email.
 *
 * Designed for PM announcements — minimal friction, fast signup.
 */
import { useEffect, useState } from "react";
import { useParams, Navigate } from "react-router-dom";
import type { FormEvent } from "react";
import { submitLead } from "../lib/leadIntake";

const AGREEMENT_REDIRECT_DELAY = 4;
import SEO from "../components/SEO";
import properties from "../data/properties.json";

type Property = {
  id: number;
  name: string;
  slug: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  frequency?: string; // "Monthly" | "Every 2 Months" | "Every 3 Months"
};

const PROPERTY_MAP: Record<string, Property> = {};
for (const p of properties as Property[]) {
  PROPERTY_MAP[p.slug] = p;
}

export default function Schedule() {
  const { slug } = useParams<{ slug: string }>();
  const property = slug ? PROPERTY_MAP[slug] : undefined;

  const [unit, setUnit] = useState("");
  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agreementUrl, setAgreementUrl] = useState<string | null>(null);
  const [redirectCountdown, setRedirectCountdown] = useState<number>(
    AGREEMENT_REDIRECT_DELAY,
  );

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

  if (!property) return <Navigate to="/" replace />;

  // Resident in-unit service is always Quarterly by default.
  // (The HOA's common-area service may be on a different schedule —
  // that's tracked separately on the association's subscription.)
  const freq = "Every 3 Months";
  const freqLabel = "Quarterly";
  const fullAddr = `${property.address}${unit ? `, Unit ${unit}` : ""}`;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const result = await submitLead({
        propertyType: "Residential",
        first,
        last,
        email,
        phone,
        addr: fullAddr,
        city: property!.city,
        state: property!.state,
        zip: property!.zip,
        sqft: "",
        units: "",
        freq: freq,
        company: property!.name,
      });
      if (result.ok) {
        const body = result.body as { agreementUrl?: string };
        if (body.agreementUrl) setAgreementUrl(body.agreementUrl);
        setSubmitted(true);
      } else {
        setError(
          "error" in result.body
            ? String(result.body.error)
            : "Something went wrong. Please call 508-258-9294.",
        );
      }
    } catch {
      setError("Network error. Please call 508-258-9294.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ minHeight: "100vh", background: "var(--bk-cream)" }}>
      <SEO
        title={`Schedule In-Unit Service — ${property.name}`}
        description={`Sign up for discounted quarterly in-unit pest control at ${property.name} in ${property.city}, ${property.state}. BuzzKill is already servicing your community's common areas.`}
        noindex
      />

      {/* Header — logo + phone only */}
      <div
        style={{
          background: "var(--bk-black)",
          padding: "14px 24px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <img
          src="/images/logo.png"
          alt="BuzzKill Pest Control"
          style={{ height: 40 }}
        />
        <a
          href="tel:508-258-9294"
          style={{
            color: "var(--bk-green)",
            fontWeight: 700,
            fontSize: 14,
            textDecoration: "none",
          }}
        >
          508-258-9294
        </a>
      </div>

      <div style={{ maxWidth: 480, margin: "0 auto", padding: "36px 24px 80px" }}>
        {!submitted ? (
          <>
            {/* Property context */}
            <div style={{ textAlign: "center", marginBottom: 28 }}>
              <div
                style={{
                  display: "inline-block",
                  background: "var(--bk-green)",
                  color: "var(--bk-black)",
                  fontWeight: 700,
                  fontSize: 11,
                  textTransform: "uppercase",
                  letterSpacing: "0.1em",
                  padding: "5px 14px",
                  borderRadius: 20,
                  marginBottom: 16,
                }}
              >
                For {property.name} Residents
              </div>
              <h1
                style={{
                  fontFamily: "var(--font-heading)",
                  fontSize: "clamp(24px, 5vw, 34px)",
                  fontWeight: 700,
                  textTransform: "uppercase",
                  lineHeight: 1.1,
                  margin: "0 0 12px",
                  color: "var(--fg1)",
                }}
              >
                Sign Up for In-Unit<br />Pest Control
              </h1>
              <p
                style={{
                  fontSize: 15,
                  lineHeight: 1.6,
                  color: "var(--fg2)",
                  margin: 0,
                }}
              >
                BuzzKill is servicing your community&rsquo;s common areas soon.
                Get discounted in-unit treatment during the same visit.
              </p>
            </div>

            {/* Property card (pre-filled, read-only) */}
            <div
              style={{
                background: "var(--bk-white)",
                borderRadius: "var(--radius-lg)",
                padding: "16px 20px",
                border: "1px solid var(--border)",
                marginBottom: 20,
                display: "flex",
                alignItems: "center",
                gap: 12,
              }}
            >
              <div
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 8,
                  background: "var(--bk-green)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="var(--bk-black)"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
                  <polyline points="9 22 9 12 15 12 15 22" />
                </svg>
              </div>
              <div>
                <div
                  style={{
                    fontWeight: 700,
                    fontSize: 15,
                    color: "var(--fg1)",
                  }}
                >
                  {property.name}
                </div>
                <div style={{ fontSize: 13, color: "var(--fg2)" }}>
                  {property.address}, {property.city}, {property.state}{" "}
                  {property.zip}
                </div>
                <div style={{ fontSize: 12, color: "var(--bk-green-deep)", fontWeight: 600, marginTop: 2 }}>
                  {freqLabel} service
                </div>
              </div>
            </div>

            {/* The form — 5 fields total */}
            <form
              onSubmit={handleSubmit}
              style={{
                background: "var(--bk-white)",
                borderRadius: "var(--radius-lg)",
                padding: 24,
                border: "1px solid var(--border)",
              }}
            >
              <div style={{ marginBottom: 16 }}>
                <label
                  htmlFor="unit"
                  style={{
                    fontWeight: 600,
                    fontSize: 14,
                    display: "block",
                    marginBottom: 4,
                  }}
                >
                  Unit Number *
                </label>
                <input
                  id="unit"
                  required
                  value={unit}
                  onChange={(e) => setUnit(e.target.value)}
                  placeholder="e.g. 4B"
                  style={{
                    width: "100%",
                    padding: "12px 14px",
                    borderRadius: 6,
                    border: "1px solid var(--border)",
                    fontSize: 16,
                  }}
                />
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 12,
                  marginBottom: 16,
                }}
              >
                <div>
                  <label
                    htmlFor="first"
                    style={{
                      fontWeight: 600,
                      fontSize: 14,
                      display: "block",
                      marginBottom: 4,
                    }}
                  >
                    First Name *
                  </label>
                  <input
                    id="first"
                    required
                    value={first}
                    onChange={(e) => setFirst(e.target.value)}
                    style={{
                      width: "100%",
                      padding: "12px 14px",
                      borderRadius: 6,
                      border: "1px solid var(--border)",
                      fontSize: 16,
                    }}
                  />
                </div>
                <div>
                  <label
                    htmlFor="last"
                    style={{
                      fontWeight: 600,
                      fontSize: 14,
                      display: "block",
                      marginBottom: 4,
                    }}
                  >
                    Last Name *
                  </label>
                  <input
                    id="last"
                    required
                    value={last}
                    onChange={(e) => setLast(e.target.value)}
                    style={{
                      width: "100%",
                      padding: "12px 14px",
                      borderRadius: 6,
                      border: "1px solid var(--border)",
                      fontSize: 16,
                    }}
                  />
                </div>
              </div>

              <div style={{ marginBottom: 16 }}>
                <label
                  htmlFor="phone"
                  style={{
                    fontWeight: 600,
                    fontSize: 14,
                    display: "block",
                    marginBottom: 4,
                  }}
                >
                  Phone *
                </label>
                <input
                  id="phone"
                  required
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  style={{
                    width: "100%",
                    padding: "12px 14px",
                    borderRadius: 6,
                    border: "1px solid var(--border)",
                    fontSize: 16,
                  }}
                />
              </div>

              <div style={{ marginBottom: 20 }}>
                <label
                  htmlFor="email"
                  style={{
                    fontWeight: 600,
                    fontSize: 14,
                    display: "block",
                    marginBottom: 4,
                  }}
                >
                  Email *
                </label>
                <input
                  id="email"
                  required
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  style={{
                    width: "100%",
                    padding: "12px 14px",
                    borderRadius: 6,
                    border: "1px solid var(--border)",
                    fontSize: 16,
                  }}
                />
              </div>

              {error && (
                <div
                  style={{
                    background: "#FFF4F2",
                    border: "1px solid #E53935",
                    color: "#7A1A0F",
                    borderRadius: 6,
                    padding: "10px 14px",
                    fontSize: 14,
                    marginBottom: 16,
                  }}
                >
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={submitting}
                className="bk-btn bk-btn-primary"
                style={{ width: "100%", padding: "14px 24px", fontSize: 16 }}
              >
                {submitting
                  ? "Submitting..."
                  : "Sign Up for In-Unit Service"}
              </button>
            </form>

            {/* Payment timing notice */}
            <div
              style={{
                marginTop: 20,
                padding: "14px 18px",
                background: "rgba(126, 211, 33, 0.08)",
                border: "1px solid rgba(126, 211, 33, 0.3)",
                borderLeft: "4px solid var(--bk-green)",
                borderRadius: "0 8px 8px 0",
                display: "flex",
                alignItems: "flex-start",
                gap: 10,
              }}
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="var(--bk-green-deep)"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ flexShrink: 0, marginTop: 2 }}
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              <div style={{ fontSize: 13, color: "var(--fg1)", lineHeight: 1.55 }}>
                <strong>No payment required to sign up.</strong> Your invoice
                is generated <em>after</em> we complete your service — pay
                only once the work is done.
              </div>
            </div>

            {/* How it works */}
            <div
              style={{
                textAlign: "center",
                marginTop: 20,
                fontSize: 13,
                color: "var(--fg3)",
                lineHeight: 1.6,
              }}
            >
              <strong>How it works:</strong> We arrive during the scheduled
              common-area visit window and service your unit — no separate
              appointment needed. You&rsquo;ll receive a confirmation email
              with details.
            </div>

            <div
              style={{
                display: "flex",
                justifyContent: "center",
                gap: 24,
                flexWrap: "wrap",
                marginTop: 20,
              }}
            >
              {["Licensed & Insured", "Pay After Service", "Discounted Rate"].map(
                (t, i) => (
                  <div
                    key={i}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 5,
                      fontSize: 12,
                      color: "var(--fg3)",
                      fontWeight: 600,
                    }}
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="var(--bk-green-deep)"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                    >
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                    {t}
                  </div>
                ),
              )}
            </div>
          </>
        ) : (
          /* Success */
          <div style={{ textAlign: "center", paddingTop: 40 }}>
            <div
              style={{
                width: 64,
                height: 64,
                borderRadius: "50%",
                background: "var(--bk-green)",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                marginBottom: 20,
              }}
            >
              <svg
                width="32"
                height="32"
                viewBox="0 0 24 24"
                fill="none"
                stroke="var(--bk-black)"
                strokeWidth="3"
                strokeLinecap="round"
              >
                <path d="M20 6L9 17l-5-5" />
              </svg>
            </div>
            <h2
              style={{
                fontFamily: "var(--font-heading)",
                fontSize: 28,
                fontWeight: 700,
                textTransform: "uppercase",
                margin: "0 0 12px",
              }}
            >
              You&rsquo;re Signed Up!
            </h2>
            <p
              style={{
                fontSize: 16,
                color: "var(--fg2)",
                maxWidth: 420,
                margin: "0 auto 8px",
                lineHeight: 1.6,
              }}
            >
              We&rsquo;ll service{" "}
              <strong>
                Unit {unit} at {property.name}
              </strong>{" "}
              on a <strong>{freqLabel}</strong> schedule.
            </p>

            {agreementUrl ? (
              <>
                <p
                  style={{
                    fontSize: 15,
                    color: "var(--fg2)",
                    maxWidth: 420,
                    margin: "12px auto 18px",
                    lineHeight: 1.6,
                  }}
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
                  className="bk-btn bk-btn-primary"
                  style={{ display: "inline-block" }}
                >
                  Review &amp; Sign Agreement Now &rarr;
                </a>
                <p
                  style={{
                    fontSize: 13,
                    color: "var(--fg3)",
                    marginTop: 18,
                    maxWidth: 380,
                    marginLeft: "auto",
                    marginRight: "auto",
                    lineHeight: 1.55,
                  }}
                >
                  A copy was also sent to <strong>{email}</strong>. (Check your
                  spam folder if you don&rsquo;t see it.)
                </p>
              </>
            ) : (
              <p
                style={{
                  fontSize: 15,
                  color: "var(--fg2)",
                  maxWidth: 420,
                  margin: "0 auto",
                }}
              >
                A confirmation has been sent to <strong>{email}</strong>.
              </p>
            )}

            <p style={{ fontSize: 14, color: "var(--fg3)", marginTop: 24 }}>
              Questions? Call{" "}
              <a
                href="tel:508-258-9294"
                style={{ color: "var(--bk-green-deep)", fontWeight: 600 }}
              >
                508-258-9294
              </a>
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
