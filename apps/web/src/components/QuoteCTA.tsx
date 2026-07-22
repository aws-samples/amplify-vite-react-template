import { Link } from "react-router-dom";

/** Office line — the human path for anyone who'd rather not self-serve. */
const OFFICE_PHONE_DISPLAY = "(508) 258-9294";
const OFFICE_PHONE_HREF = "tel:+15082589294";

type QuoteCTAProps = {
  eyebrow?: string;
  title?: string;
  intro?: string;
};

/**
 * The site's single service-request entry point, replacing the old
 * multi-step lead form. The /quote funnel prices every service for every
 * property type on the spot and books online — homes, communities, and
 * commercial alike. Only the rare unpriceable case (unresolvable address,
 * fully booked month, research fallback) is captured for a specialist
 * call, so every prospect type still funnels through the same door.
 *
 * Keeps `id="form"` so the Footer's `/#form` link and every page's
 * scroll-to-form CTA still land here.
 */
export default function QuoteCTA({
  eyebrow = "Get Started",
  title = "See Your Price in Seconds",
  intro = "Tell us about your pest problem and get an instant quote — pick a day, book online, done.",
}: QuoteCTAProps) {
  return (
    <section className="bk-section bk-section-light" id="form">
      <div className="bk-container bk-narrow bk-center">
        <div className="bk-eyebrow">{eyebrow}</div>
        <h2 className="bk-h2">{title}</h2>
        <p className="bk-body-lead">{intro}</p>
        <p className="bk-p" style={{ maxWidth: 560, margin: "0 auto" }}>
          Termites, wildlife, condo &amp; HOA, or commercial? Same quote,
          same instant price, with a day picker for every open date.
        </p>
        <div
          style={{
            display: "flex",
            gap: 14,
            justifyContent: "center",
            flexWrap: "wrap",
            marginTop: 28,
          }}
        >
          <Link to="/quote" className="bk-btn bk-btn-primary" data-track-id="quote_cta_primary">
            Get My Instant Quote &rarr;
          </Link>
          <a href={OFFICE_PHONE_HREF} className="bk-btn bk-btn-outline" data-track-id="quote_cta_phone">
            Or call {OFFICE_PHONE_DISPLAY}
          </a>
        </div>

        {/* Trust bar */}
        <div className="bk-form-trust">
          {["Licensed & Insured", "MA • RI", "Price in seconds", "Book online"].map(
            (t, i) => (
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
            ),
          )}
        </div>
      </div>
    </section>
  );
}
