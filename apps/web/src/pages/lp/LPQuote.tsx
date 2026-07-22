/**
 * Landing Page 1: "Instant Quote"
 *
 * Conversion strategy: VALUE-FIRST / INSTANT GRATIFICATION
 * - One promise, one CTA: a real, bookable price in seconds
 * - The old on-page calculator is gone — the /quote funnel returns live
 *   priced days and takes payment, so ad traffic goes straight there
 * - Every service and property type prices instantly; only the rare
 *   unpriceable case is captured for a specialist follow-up, by phone if the
 *   lead consented to a call and left a number, otherwise by email (GL-03)
 */
import { Link } from "react-router-dom";
import SEO from "../../components/SEO";

function CheckIcon() {
  return (
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
  );
}

export default function LPQuote() {
  return (
    <div className="bk-lp bk-lp--light">
      <SEO
        title="Get Your Instant Pest Control Quote"
        description="See your pest control price in seconds. No waiting, no sales calls — just your quote, bookable online."
        noindex
      />

      <header className="bk-lp-header bk-lp-header--dark-on-light">
        <img src="/images/logo.png" alt="BuzzKill Pest Control" />
      </header>

      <main className="bk-lp-container" style={{ textAlign: "center" }}>
        <div className="bk-lp-eyebrow">Instant Quote</div>
        <h1 className="bk-lp-h1">See Your Price in Seconds</h1>
        <p className="bk-lp-lead" style={{ maxWidth: 460, margin: "0 auto" }}>
          No sales calls. No waiting. Answer a few quick questions, see your
          customized price, and book your visit online — all in one sitting.
        </p>

        <Link
          to="/quote"
          className="bk-btn bk-btn-primary bk-lp-cta bk-lp-cta--lg"
          style={{ maxWidth: 380, margin: "28px auto 0", display: "block" }}
        >
          See My Price Now &rarr;
        </Link>

        <p
          style={{
            fontSize: 14,
            color: "var(--fg2)",
            maxWidth: 440,
            margin: "18px auto 0",
            lineHeight: 1.55,
          }}
        >
          Termites, wildlife, condo / HOA, or a commercial property? Same
          form, same instant price, and you pick your day online.
        </p>

        <div className="bk-lp-trust">
          <div className="bk-lp-trust__item">
            <CheckIcon />
            Licensed &amp; Insured
          </div>
          <div className="bk-lp-trust__item">
            <CheckIcon />
            MA &bull; RI
          </div>
          <div className="bk-lp-trust__item">
            <CheckIcon />
            <a
              href="tel:508-258-9294"
              style={{ color: "inherit", textDecoration: "none" }}
            >
              508-258-9294
            </a>
          </div>
        </div>
      </main>
    </div>
  );
}
