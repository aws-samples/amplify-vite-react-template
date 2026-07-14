/**
 * Landing Page 3: "Talk to a Specialist"
 *
 * Conversion strategy: MINIMAL FRICTION / PHONE-FIRST
 * - Hypothesis: HOA board members and PMs prefer talking to a person
 * - Primary CTA: Click-to-call (one tap on mobile)
 * - Secondary: ultra-short 3-field form (name, phone, address)
 * - No pricing, no complex forms — just get them on the phone
 * - Speed to lead: fastest path from ad click to conversation
 */
import { useState } from "react";
import type { FormEvent } from "react";
import { submitLead } from "../../lib/leadIntake";
import SEO from "../../components/SEO";

function PhoneIcon({ size = 24 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z" />
    </svg>
  );
}

function CheckIcon({ size = 14 }: { size?: number }) {
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
      aria-hidden="true"
    >
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

export default function LPCall() {
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    const [first, ...rest] = name.trim().split(" ");
    try {
      await submitLead({
        propertyType: "Association",
        first: first || name,
        last: rest.join(" ") || "",
        email: "",
        phone,
        addr: address,
        city: "",
        state: "",
        zip: "",
        sqft: "",
        units: "",
        freq: "Monthly",
        company: "",
      });
      setSubmitted(true);
    } catch {
      // Even on error, show success — we'll get the lead from CloudWatch
      setSubmitted(true);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="bk-lp bk-lp--dark">
      <SEO
        title="Talk to a Pest Control Specialist Now"
        description="Get expert advice on your HOA or condo pest situation. One call, one plan, done."
        noindex
      />

      <header className="bk-lp-header">
        <img src="/images/logo.png" alt="BuzzKill Pest Control" />
      </header>

      <main
        className="bk-lp-container bk-lp-container--narrow"
        style={{ textAlign: "center", padding: "32px 24px 64px" }}
      >
        {!submitted ? (
          <>
            <div className="bk-lp-eyebrow bk-lp-eyebrow--dark">
              HOA &amp; Condo Pest Control
            </div>

            <h1 className="bk-lp-h1 bk-lp-h1--xl">
              Let&rsquo;s Fix This.
              <br />
              <span style={{ color: "var(--bk-green)" }}>Call Now.</span>
            </h1>

            <p
              className="bk-lp-lead"
              style={{ margin: "0 0 32px", fontSize: 17 }}
            >
              Speak with a specialist who knows condo and HOA pest control.
              Get a plan for your community in minutes, not days.
            </p>

            {/* Primary CTA: Phone */}
            <a
              href="tel:508-258-9294"
              className="bk-btn bk-btn-primary bk-lp-cta bk-lp-cta--lg bk-lp-cta-row"
              style={{ marginBottom: 10 }}
            >
              <PhoneIcon size={22} />
              508-258-9294
            </a>

            <p
              style={{
                fontSize: 13,
                color: "rgba(255,255,255,0.5)",
                margin: "0 0 32px",
              }}
            >
              Mon–Fri 7am–6pm &bull; Free consultation
            </p>

            {/* OR divider */}
            <div className="bk-lp-divider">
              <span className="bk-lp-divider__line" aria-hidden="true" />
              <span className="bk-lp-divider__label">or</span>
              <span className="bk-lp-divider__line" aria-hidden="true" />
            </div>

            {/* Ultra-short callback form */}
            <div style={{ textAlign: "left" }}>
              <h2
                className="bk-lp-h2"
                style={{ textAlign: "center", fontSize: 22 }}
              >
                Request a Callback
              </h2>

              <form onSubmit={handleSubmit}>
                <div className="bk-lp-field">
                  <label className="bk-lp-field-label" htmlFor="lp-name">
                    Your name *
                  </label>
                  <input
                    id="lp-name"
                    className="bk-lp-input bk-lp-input--dark"
                    required
                    autoComplete="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </div>

                <div className="bk-lp-field">
                  <label className="bk-lp-field-label" htmlFor="lp-phone">
                    Phone number *
                  </label>
                  <input
                    id="lp-phone"
                    className="bk-lp-input bk-lp-input--dark"
                    required
                    type="tel"
                    autoComplete="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                  />
                </div>

                <div className="bk-lp-field">
                  <label className="bk-lp-field-label" htmlFor="lp-addr">
                    Property address{" "}
                    <span
                      style={{
                        color: "rgba(255,255,255,0.4)",
                        fontWeight: 400,
                      }}
                    >
                      (optional)
                    </span>
                  </label>
                  <input
                    id="lp-addr"
                    className="bk-lp-input bk-lp-input--dark"
                    autoComplete="street-address"
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                  />
                </div>

                <button
                  type="submit"
                  disabled={submitting}
                  aria-busy={submitting}
                  className="bk-btn bk-btn-primary bk-lp-cta"
                  style={{ marginTop: 4 }}
                >
                  {submitting ? "Sending…" : "Have Us Call You"}
                </button>
              </form>
            </div>

            {/* Trust bar */}
            <div className="bk-lp-trust">
              {["Licensed & Insured", "MA • RI", "HOA Specialists"].map(
                (t, i) => (
                  <div key={i} className="bk-lp-trust__item">
                    <CheckIcon />
                    {t}
                  </div>
                ),
              )}
            </div>
          </>
        ) : (
          <div style={{ paddingTop: 20 }}>
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
            <h2 className="bk-lp-h2">We&rsquo;ll Call You Shortly</h2>
            <p
              className="bk-lp-lead"
              style={{ marginBottom: 28, maxWidth: 420, margin: "0 auto 28px" }}
            >
              A BuzzKill specialist will reach out to{" "}
              <strong style={{ color: "#fff" }}>{phone}</strong> to discuss
              your community&rsquo;s needs.
            </p>
            <p
              style={{
                fontSize: 14,
                color: "rgba(255,255,255,0.5)",
                marginBottom: 12,
              }}
            >
              Can&rsquo;t wait? Call us now:
            </p>
            <a
              href="tel:508-258-9294"
              className="bk-btn bk-btn-primary bk-lp-cta-row"
              style={{
                display: "inline-flex",
                padding: "14px 32px",
                fontSize: 18,
              }}
            >
              <PhoneIcon size={20} />
              508-258-9294
            </a>
          </div>
        )}
      </main>
    </div>
  );
}
