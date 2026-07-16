import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import Hero from "../components/Hero";
import SEO, { buildBreadcrumbSchema } from "../components/SEO";
import { CITIES } from "../data/cities";

const STATE_ORDER = ["Massachusetts", "Rhode Island"] as const;

const STATE_META: Record<string, { anchor: string; svgLabel: string }> = {
  Massachusetts: { anchor: "massachusetts", svgLabel: "Massachusetts" },
  "Rhode Island": { anchor: "rhode-island", svgLabel: "Rhode Island" },
};

export default function ServiceAreas() {
  const [query, setQuery] = useState("");

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    return STATE_ORDER.map((state) => {
      const cities = CITIES.filter((c) => c.state === state).filter((c) =>
        q ? c.city.toLowerCase().includes(q) : true,
      );
      return { state, cities };
    });
  }, [query]);

  const totalShown = groups.reduce((sum, g) => sum + g.cities.length, 0);
  const totalTowns = CITIES.length;

  return (
    <>
      <SEO
        title="Service Areas | Pest Control Across Massachusetts & Rhode Island"
        description="BuzzKill Pest Control proudly serves homes, HOAs, and businesses across Massachusetts and Rhode Island. Find your town and get an instant quote."
        jsonLd={buildBreadcrumbSchema([
          { name: "Home", url: "/" },
          { name: "Service Areas", url: "/service-areas" },
        ])}
      />

      <Hero
        image="/images/service-areas-hero.png"
        eyebrow="Where We Protect"
        headline={<>Proudly Serving Massachusetts &amp; Rhode Island</>}
        subtitle={<>From Marlborough to the coast, BuzzKill brings safe, thoughtful pest control to homes, HOAs, and businesses across both states.</>}
        primaryCta={{ label: "Get an Instant Quote", href: "/request-quote" }}
        secondaryCta={{ label: "Find Your Town", href: "#directory" }}
      />

      {/* Map overview */}
      <section className="bk-locations-section">
        <div className="bk-locations-inner">
          <div className="bk-locations-header">
            <p className="bk-locations-eyebrow">Service Areas</p>
            <h2 className="bk-locations-title">Two States. One Standard of Care.</h2>
            <span className="bk-locations-badge">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 1L15.09 7.26L22 8.27L17 13.14L18.18 20.02L12 16.77L5.82 20.02L7 13.14L2 8.27L8.91 7.26L12 1Z"/></svg>
              Licensed &amp; Insured
            </span>
          </div>
          <div className="bk-locations-grid">

            {/* Massachusetts */}
            <a href="#massachusetts" className="bk-location-card">
              <div className="bk-location-shape-wrap">
                <svg viewBox="0 0 540 280" className="bk-state-svg" aria-label="Massachusetts" role="img">
                  <defs>
                    <clipPath id="areas-ma-clip">
                      <path d="M 3,24 L 140,25 L 303,19 L 363,10 L 401,3 L 403,22 L 414,38 L 428,38 L 422,50 L 390,68 L 371,87 Q 389,104 413,114 Q 421,140 426,154 L 433,189 L 418,186 L 404,204 L 385,206 L 376,216 L 361,222 L 351,249 L 256,143 L 114,141 L 69,138 L 3,138 Z" />
                      <path d="M 433,193 Q 431,219 482,210 L 534,201 L 531,171 L 523,156 L 517,146 Q 500,133 490,136 Q 510,132 517,137 L 526,181 Q 511,202 500,194 Q 479,197 453,189 L 435,191 Z" />
                    </clipPath>
                  </defs>
                  <path d="M 3,24 L 140,25 L 303,19 L 363,10 L 401,3 L 403,22 L 414,38 L 428,38 L 422,50 L 390,68 L 371,87 Q 389,104 413,114 Q 421,140 426,154 L 433,189 L 418,186 L 404,204 L 385,206 L 376,216 L 361,222 L 351,249 L 256,143 L 114,141 L 69,138 L 3,138 Z" />
                  <path d="M 433,193 Q 431,219 482,210 L 534,201 L 531,171 L 523,156 L 517,146 Q 500,133 490,136 Q 510,132 517,137 L 526,181 Q 511,202 500,194 Q 479,197 453,189 L 435,191 Z" />
                  <ellipse cx="434" cy="253" rx="28" ry="11" />
                  <ellipse cx="511" cy="268" rx="21" ry="6" />
                  <g clipPath="url(#areas-ma-clip)" stroke="rgba(255,255,255,0.32)" strokeWidth="0.75" fill="none" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M 76,26 C 74,62 77,98 75,138" />
                    <path d="M 113,25 C 112,62 114,98 112,138" />
                    <path d="M 149,25 C 148,60 150,100 148,140" />
                    <path d="M 178,25 C 177,60 179,100 177,140" />
                    <path d="M 214,25 C 213,60 215,100 213,140" />
                    <path d="M 250,25 C 248,65 252,103 250,143" />
                    <path d="M 76,52 C 97,51 122,52 149,52" />
                    <path d="M 76,100 C 97,99 122,100 149,100" />
                    <path d="M 149,68 C 165,67 192,68 214,68" />
                    <path d="M 250,50 C 308,49 360,52 421,51" />
                    <path d="M 250,72 C 304,72 350,75 391,88" />
                    <path d="M 250,97 C 309,98 350,104 390,115" />
                    <path d="M 250,128 C 308,129 350,134 376,156" />
                    <path d="M 298,25 C 297,50 299,97 298,128" />
                    <path d="M 353,128 C 358,156 361,177 383,192" />
                    <path d="M 456,193 L 454,210" />
                    <path d="M 476,199 L 475,211" />
                    <path d="M 496,197 L 495,209" />
                    <path d="M 516,193 L 517,205" />
                  </g>
                </svg>
              </div>
              <div className="bk-location-label">
                <span className="bk-location-name">Massachusetts</span>
                <span className="bk-location-cta">{groups[0].cities.length} Towns ↓</span>
              </div>
            </a>

            {/* Rhode Island */}
            <a href="#rhode-island" className="bk-location-card">
              <div className="bk-location-shape-wrap">
                <svg viewBox="0 0 135 175" className="bk-state-svg" aria-label="Rhode Island" role="img">
                  <defs>
                    <clipPath id="areas-ri-clip">
                      <path clipRule="evenodd" d="M 16,7 L 127,11 L 117,79 L 117,114 Q 100,117 89,114 L 71,120 Q 55,130 45,130 L 15,143 L 4,128 L 7,95 L 10,63 L 13,32 L 16,7 Z M 80,45 L 86,51 Q 100,74 89,114 L 71,120 Q 71,93 78,64 L 76,45 Z" />
                    </clipPath>
                  </defs>
                  <path fillRule="evenodd" d="M 16,7 L 127,11 L 117,79 L 117,114 Q 100,117 89,114 L 71,120 Q 55,130 45,130 L 15,143 L 4,128 L 7,95 L 10,63 L 13,32 L 16,7 Z M 80,45 L 86,51 Q 100,74 89,114 L 71,120 Q 71,93 78,64 L 76,45 Z" />
                  <ellipse cx="53" cy="168" rx="7" ry="5" />
                  <g clipPath="url(#areas-ri-clip)" stroke="rgba(255,255,255,0.38)" strokeWidth="0.7" fill="none" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M 7,18 C 18,17 30,18 65,17" />
                    <path d="M 32,7 L 31,18 L 33,50 L 30,65" />
                    <path d="M 37,7 C 36,22 38,48 36,90" />
                    <path d="M 65,7 C 64,17 66,28 63,52" />
                    <path d="M 75,7 L 75,34 C 76,40 75,46 76,46" />
                    <path d="M 37,34 C 48,33 57,34 65,33" />
                    <path d="M 50,34 C 49,52 51,72 49,90" />
                    <path d="M 59,34 C 60,44 58,54 59,65" />
                    <path d="M 50,55 C 57,54 66,55 76,54" />
                    <path d="M 50,65 C 58,64 67,65 77,63" />
                    <path d="M 36,70 C 49,69 63,70 72,69" />
                    <path d="M 36,70 C 36,82 37,90 36,90" />
                    <path d="M 50,70 C 50,82 50,90 50,90" />
                    <path d="M 8,90 C 26,89 48,90 70,90" />
                    <path d="M 35,90 L 34,115 L 34,143" />
                    <path d="M 50,90 C 50,103 51,115 50,115" />
                    <path d="M 8,115 C 26,114 46,115 65,113" />
                    <path d="M 53,115 L 54,143" />
                    <path d="M 103,11 C 101,25 100,38 101,52" />
                    <path d="M 87,7 L 86,34 C 87,40 86,46 87,52" />
                    <path d="M 75,34 C 80,33 87,34 103,33" />
                  </g>
                </svg>
              </div>
              <div className="bk-location-label">
                <span className="bk-location-name">Rhode Island</span>
                <span className="bk-location-cta">{groups[1].cities.length} Towns ↓</span>
              </div>
            </a>

          </div>
        </div>
      </section>

      {/* City directory */}
      <section id="directory" className="bk-areas-directory">
        <div className="bk-areas-directory-inner">
          <div className="bk-areas-directory-header">
            <p className="bk-locations-eyebrow">Full Coverage List</p>
            <h2 className="bk-h2">Find Your Town</h2>
            <p className="bk-body-lead">
              BuzzKill serves {totalTowns}+ towns across Massachusetts and Rhode Island. Search below or browse by state, then tap your town for local details.
            </p>
            <div className="bk-areas-search-wrap">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" className="bk-areas-search-icon">
                <circle cx="11" cy="11" r="7" />
                <path d="M21 21l-4.35-4.35" strokeLinecap="round" />
              </svg>
              <input
                type="search"
                className="bk-areas-search"
                placeholder="Search your town (e.g. Newton, Providence)"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Search service area towns"
              />
            </div>
          </div>

          {totalShown === 0 && (
            <p className="bk-areas-empty">
              We couldn't find a match for "{query}" — but we may still service your area.{" "}
              <Link to="/request-quote">Request a quote</Link> and we'll confirm.
            </p>
          )}

          {groups.map(({ state, cities }) =>
            cities.length === 0 ? null : (
              <div key={state} id={STATE_META[state].anchor} className="bk-areas-group">
                <div className="bk-areas-group-header">
                  <h3 className="bk-areas-group-title">{state}</h3>
                  <span className="bk-areas-group-count">{cities.length} towns</span>
                </div>
                <div className="bk-areas-city-grid">
                  {cities.map((c) => (
                    <Link key={c.slug} to={`/pest-control/${c.slug}`} className="bk-areas-city">
                      {c.city}
                      {c.hq && <span className="bk-areas-hq-badge">HQ</span>}
                    </Link>
                  ))}
                </div>
              </div>
            ),
          )}
        </div>
      </section>

      {/* Schedule Inspection CTA */}
      <section className="bk-schedule-section">
        <div className="bk-schedule-inner">
          <div className="bk-schedule-card">
            <div className="bk-schedule-brand">
              <div className="bk-schedule-logo-badge">
                <Link to="/"><img src="/images/logo.png" alt="BuzzKill Pest Control" /></Link>
              </div>
              <p className="bk-schedule-tagline">Licensed &amp; Insured</p>
            </div>
            <div className="bk-schedule-content">
              <p className="bk-schedule-eyebrow">Don't See Your Town?</p>
              <h2 className="bk-schedule-title">We're Probably Already Nearby</h2>
              <p className="bk-schedule-sub">We're always expanding across Massachusetts &amp; Rhode Island. Reach out and we'll confirm coverage for your property.</p>
              <Link to="/request-quote" className="bk-btn bk-schedule-cta">
                Get an Instant Quote
              </Link>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
