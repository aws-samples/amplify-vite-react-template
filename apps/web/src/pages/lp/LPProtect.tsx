/**
 * Landing Page 2: "Protect Your Community"
 *
 * Conversion strategy: PROBLEM → PAIN → SOLUTION + SOCIAL PROOF + URGENCY
 * - Opens with the pain of uncontrolled pest issues in HOAs
 * - Shows consequences of inaction (complaints, health, property value)
 * - Social proof: number of communities served, trust signals
 * - Urgency: seasonal messaging, limited capacity
 * - Single CTA: the instant-quote funnel — community/HOA requests price
 *   instantly there as per-unit monthly plans and book online
 */
import { Link } from "react-router-dom";
import SEO from "../../components/SEO";

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

      {/* CTA — straight into the instant-quote funnel */}
      <section style={{ padding: "56px 24px 80px", flex: 1 }}>
        <div
          className="bk-lp-container bk-lp-container--narrow"
          style={{ padding: 0, textAlign: "center" }}
        >
          <h2 className="bk-lp-h2">Get Your Community a Plan</h2>
          <p className="bk-lp-lead" style={{ maxWidth: 440, margin: "0 auto" }}>
            Start with our instant quote — tell us about your community, see
            your per-month price in seconds, and lock in your first visit
            online. No obligation.
          </p>

          <Link
            to="/quote"
            className="bk-btn bk-btn-primary bk-lp-cta bk-lp-cta--lg"
            style={{ maxWidth: 380, margin: "28px auto 0", display: "block" }}
          >
            Get My Instant Quote &rarr;
          </Link>

          <p
            style={{
              fontSize: 14,
              color: "rgba(255,255,255,0.55)",
              marginTop: 18,
            }}
          >
            Prefer to talk now? Call{" "}
            <a
              href="tel:508-258-9294"
              style={{ color: "var(--bk-green)", fontWeight: 600 }}
            >
              508-258-9294
            </a>
          </p>

          <div className="bk-lp-trust">
            {["Priced online in seconds", "No obligation"].map(
              (t, i) => (
                <div key={i} className="bk-lp-trust__item">
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
              ),
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
