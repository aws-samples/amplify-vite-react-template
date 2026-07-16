/**
 * Landing Page 3: "Talk to a Specialist"
 *
 * Conversion strategy: MINIMAL FRICTION / PHONE-FIRST
 * - Hypothesis: HOA board members and PMs prefer talking to a person
 * - Primary CTA: Click-to-call (one tap on mobile)
 * - Secondary: the instant-quote funnel — it captures HOA/commercial
 *   requests and a specialist calls back within the hour
 * - Speed to lead: fastest path from ad click to conversation
 */
import { Link } from "react-router-dom";
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

        {/* Secondary: instant-quote funnel */}
        <h2 className="bk-lp-h2" style={{ fontSize: 22 }}>
          Get an Instant Quote Online
        </h2>
        <p
          className="bk-lp-lead"
          style={{ maxWidth: 400, margin: "0 auto 20px", fontSize: 15 }}
        >
          Answer a few questions and see your price in seconds. Condo, HOA,
          or commercial? A specialist will call you within the hour.
        </p>
        <Link
          to="/quote"
          className="bk-btn bk-btn-outline-light bk-lp-cta"
          style={{ maxWidth: 340, margin: "0 auto", display: "block" }}
        >
          Start My Instant Quote &rarr;
        </Link>

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
      </main>
    </div>
  );
}
