import { Link } from "react-router-dom";

export default function QuoteCard() {
  return (
    <div className="bk-quote-card">

      <div className="bk-quote-card-pitch" style={{ paddingTop: 18, paddingBottom: 12 }}>
        <div style={{ textAlign: "center" }}>
          <p className="bk-quote-card-eyebrow bk-quote-card-eyebrow--flash">&#x26A1; Instant Pricing Available</p>
        </div>
        <h3 className="bk-quote-card-headline">
          <span className="bk-quote-headline-block">Know the Price.</span>
          <span className="bk-quote-headline-block">Book in Minutes.</span>
        </h3>
        <ul className="bk-quote-card-checklist">
          <li>No phone tag</li>
          <li>No waiting</li>
          <li>See your quote online</li>
          <li>Choose a plan, get on the schedule</li>
        </ul>
      </div>

      <div className="bk-quote-card-cta" style={{ paddingTop: 12, paddingBottom: 12 }}>
        <Link to="/quote" className="bk-btn bk-btn-primary bk-btn-full" data-track-id="quote_card_cta">
          Get Free Instant Quote
        </Link>
        <a href="tel:+15082589294" className="bk-quote-card-phone bk-quote-card-phone--flash" style={{ fontSize: 17 }} data-track-id="quote_card_phone">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M6.62 10.79a15.05 15.05 0 006.59 6.59l2.2-2.2a1 1 0 011.01-.24c1.12.37 2.33.57 3.58.57a1 1 0 011 1V20a1 1 0 01-1 1C10.74 21 3 13.26 3 4a1 1 0 011-1h3.5a1 1 0 011 1c0 1.25.2 2.45.57 3.57a1 1 0 01-.24 1.01l-2.21 2.21z"/>
          </svg>
          (508) 258-9294
        </a>
      </div>

      <div className="bk-quote-stamp-wrap" style={{ paddingBottom: 12 }}>
        <svg viewBox="0 0 104 104" width="104" height="104" aria-hidden="true" style={{ display: "block" }}>
          <circle cx="52" cy="52" r="50" fill="none" />
          <defs>
            <path id="qc-buzzkill-ring" d="M 52 9 A 43 43 0 1 1 51.999 9" />
          </defs>
          <text fontSize="7" fill="white" fillOpacity="0.7" fontFamily="'Copperplate Gothic', serif" letterSpacing="2" fontWeight="900">
            <textPath href="#qc-buzzkill-ring">
              BUZZKILL · BUZZKILL · BUZZKILL · BUZZKILL ·
            </textPath>
          </text>
          <text x="52" y="50" textAnchor="middle" dominantBaseline="middle" fontSize="26" fontFamily="'Alfa Slab One', serif" fill="#72E000">30</text>
          <text x="52" y="66" textAnchor="middle" fontSize="7" fontFamily="'Copperplate Gothic', serif" fill="rgba(255,255,255,0.82)" letterSpacing="1">DAY GUARANTEE</text>
        </svg>
      </div>

      <p className="bk-quote-card-corner-terms">Terms &amp; conditions apply</p>

    </div>
  );
}
