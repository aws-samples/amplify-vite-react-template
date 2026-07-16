import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import FAQ from "../components/FAQ";
import Hero from "../components/Hero";
import SEO, { buildBreadcrumbSchema, buildServiceSchema } from "../components/SEO";

const FAMILIAR_ITEMS = [
  { img: "/images/pm-01-complaints-piling.png",  text: "Resident complaints keep piling up." },
  { img: "/images/pm-02-pests-coming-back.png",  text: "The same pest problems keep coming back." },
  { img: "/images/pm-03-vendors-communicate.png", text: "I need vendors that actually communicate." },
  { img: "/images/pm-04-scheduling.png",         text: "Scheduling shouldn't become another task." },
  { img: "/images/pm-05-consistency.png",        text: "I want fewer surprises and more consistency." },
  { img: "/images/pm-06-partner-no-chase.png",   text: "I need a partner I don't have to chase." },
];

const VALUE_CARDS = [
  {
    title: "Fewer Resident Complaints",
    body: "Helping reduce recurring pest issues before they become recurring conversations.",
  },
  {
    title: "Clear Communication",
    body: "Straightforward updates after every scheduled service help keep everyone informed.",
  },
  {
    title: "Dependable Service",
    body: "A trusted local team that shows up ready to understand, solve, and protect.",
  },
  {
    title: "Community Focused",
    body: "Every recommendation is built around the needs of your property and the people who live there.",
  },
];

const METHOD_STEPS = [
  {
    method: "UNDERSTAND",
    num: "01",
    title: "Every Property Is Different.",
    body: "We learn how your community operates before recommending the right approach.",
  },
  {
    method: "SOLVE",
    num: "02",
    title: "Protection Where It Matters Most.",
    body: "From common areas to optional in unit service, every plan is built around your property's needs.",
  },
  {
    method: "PROTECT",
    num: "03",
    title: "Helping You Stay One Step Ahead.",
    body: "Consistent service and clear communication help support a better resident experience.",
  },
];

const WHY_CARDS = [
  { img: "/images/fewer-resident-complaints.png", title: "Fewer Resident Complaints", body: "Helping reduce recurring pest issues before they affect everyday living." },
  { img: "/images/clear-communication.png",       title: "Clear Communication",       body: "Every visit ends with straightforward reporting and recommendations." },
  { img: "/images/flexible-scheduling.png",       title: "Flexible Scheduling",       body: "Services planned around your community whenever possible." },
  { img: "/images/local-experience.png",          title: "Local Experience",          body: "Proudly serving communities throughout Massachusetts and Rhode Island." },
];

const PROCESS_STEPS = [
  { num: "01", title: "Tell us about your community.", body: "Share the details of your property and what you're looking for in a pest control partner." },
  { num: "02", title: "We'll learn what you need.", body: "We take the time to understand your buildings, layouts, and the unique pressures your community faces." },
  { num: "03", title: "Build the right protection plan.", body: "We put together a program built around your community's schedule, spaces, and residents." },
  { num: "04", title: "Help keep your community protected.", body: "Ongoing service with clear communication so pest management stays one less thing to worry about." },
];

const PREVENTION_TIPS = [
  "Encourage residents to report pest activity early.",
  "Monitor shared spaces throughout the year.",
  "Keep dumpster and utility areas maintained.",
  "Stay ahead with routine community protection.",
  "Build long term prevention into your maintenance plan.",
];

const RELATED_SERVICES = [
  { label: "Common Area Protection", to: "/communities/common-areas", desc: "Helping protect the spaces residents use every day." },
  { label: "In Unit Service",        to: "/communities/in-unit",      desc: "Professional support when residents need help inside their homes." },
  { label: "HOA & Board Resources",  to: "/communities/hoa-resources", desc: "Helping boards make confident community decisions." },
  { label: "Community Overview",     to: "/communities",              desc: "See how BuzzKill helps communities across Massachusetts and Rhode Island stay protected." },
];

const FAQS = [
  {
    q: "How can BuzzKill help reduce resident complaints?",
    a: "Proactive pest management and consistent communication help address concerns before they become recurring issues.",
  },
  {
    q: "Can service be customized for different communities?",
    a: "Yes. Every property is different, and service recommendations are built around your community's needs.",
  },
  {
    q: "Do you coordinate directly with property management?",
    a: "Yes. We work closely with property managers to help simplify scheduling, communication, and ongoing service.",
  },
  {
    q: "Can residents also receive in unit service?",
    a: "Yes. Optional in unit service may be available depending on your community's arrangement.",
  },
  {
    q: "Do you service communities throughout Massachusetts and Rhode Island?",
    a: "Yes. BuzzKill proudly serves communities across Massachusetts and Rhode Island.",
  },
  {
    q: "How do I request a proposal?",
    a: "Contact our team or request a community proposal online to get started.",
  },
];

export default function PropertyManagers() {
  const [showBackToTop, setShowBackToTop] = useState(false);
  const [activeFamiliar, setActiveFamiliar] = useState(0);
  const prevFamiliar = () => setActiveFamiliar(i => (i - 1 + FAMILIAR_ITEMS.length) % FAMILIAR_ITEMS.length);
  const nextFamiliar = () => setActiveFamiliar(i => (i + 1) % FAMILIAR_ITEMS.length);

  useEffect(() => {
    const onScroll = () => setShowBackToTop(window.scrollY > 700);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <>
      <SEO
        title="Pest Control for Property Managers — MA & RI Communities"
        description="BuzzKill partners with property managers across Massachusetts and Rhode Island to reduce resident complaints, protect shared spaces, and keep communities running smoothly."
        jsonLd={[
          buildServiceSchema(
            "Pest Control for Property Managers",
            "Proactive pest control programs for property managers across Massachusetts and Rhode Island. Dependable service, clear communication, and community-focused protection.",
            "/property-managers",
          ),
          buildBreadcrumbSchema([
            { name: "Home",              url: "/" },
            { name: "Property Managers", url: "/property-managers" },
          ]),
        ]}
      />

      {/* Back to top */}
      <button
        className={`bk-back-to-top${showBackToTop ? " is-visible" : ""}`}
        onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
        aria-label="Back to top"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 15l-6-6-6 6" />
        </svg>
      </button>

      {/* 1 — Hero */}
      <Hero
        image="/images/pm-hero.png"
        eyebrow="PROPERTY MANAGER PEST CONTROL"
        headline="Protect More. Manage Less."
        sub="Managing a community is challenging enough. Pest control shouldn't add to the workload. BuzzKill partners with property managers across Massachusetts and Rhode Island to help reduce resident complaints, protect shared spaces, and keep communities running smoothly through dependable service and clear communication."
        primaryCta={{ label: "Request Community Proposal", href: "/request-quote" }}
        secondaryCta={{ label: "Talk To Our Team", href: "/contact" }}
        className="bk-hero--community"
      />

      {/* 2 — Sound Familiar */}
      <section className="bk-section bk-section-cream">
        <div className="bk-container">
          <p className="bk-eyebrow bk-center">Everyday Challenges</p>
          <h2 className="bk-h2 bk-center">Does This Sound Like Your Day?</h2>

          <div className="bk-com-who-carousel">
            <button className="bk-com-who-arrow" onClick={prevFamiliar} aria-label="Previous">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M15 18l-6-6 6-6" />
              </svg>
            </button>
            <div className="bk-com-who-stage">
              {FAMILIAR_ITEMS.map((item, i) => (
                <div
                  key={i}
                  className={`bk-com-who-slide${activeFamiliar === i ? " is-active" : ""}`}
                  aria-hidden={activeFamiliar !== i}
                >
                  <div className="bk-com-who-block">
                    <img src={item.img} alt="" className="bk-com-who-img" />
                    <div className="bk-com-who-text">
                      <p className="bk-com-who-body">&ldquo;{item.text}&rdquo;</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <button className="bk-com-who-arrow" onClick={nextFamiliar} aria-label="Next">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M9 18l6-6-6-6" />
              </svg>
            </button>
          </div>

          <div className="bk-com-who-dots">
            {FAMILIAR_ITEMS.map((_, i) => (
              <button
                key={i}
                className={`bk-com-who-dot${activeFamiliar === i ? " is-active" : ""}`}
                onClick={() => setActiveFamiliar(i)}
                aria-label={`Go to item ${i + 1}`}
              />
            ))}
          </div>

          <div className="bk-center" style={{ marginTop: 36 }}>
            <Link to="/request-quote" className="bk-btn bk-btn-primary">Let's Make Pest Control Easier</Link>
          </div>
        </div>
      </section>

      {/* 3 — Your Community Deserves Better */}
      <section className="bk-section bk-section-dark">
        <div className="bk-container">
          <p className="bk-eyebrow bk-center" style={{ color: "var(--bk-green)" }}>Protection With Purpose</p>
          <h2 className="bk-h2 bk-on-dark bk-center">Less Time Managing Pest Problems. More Time Managing Your Community.</h2>
          <div className="bk-fou-who-grid">
            {VALUE_CARDS.map((card, i) => (
              <div key={i} className="bk-fou-who-card">
                <h3 className="bk-fou-who-title">{card.title}</h3>
                <p className="bk-fou-who-body">{card.body}</p>
              </div>
            ))}
          </div>
          <div className="bk-center" style={{ marginTop: 40 }}>
            <Link to="/request-quote" className="bk-btn bk-btn-primary">See The BuzzKill Difference</Link>
          </div>
        </div>
      </section>

      {/* 4 — The BuzzKill Method */}
      <section className="bk-section bk-section-cream">
        <div className="bk-container">
          <p className="bk-eyebrow bk-center">Understand. Solve. Protect.</p>
          <h2 className="bk-h2 bk-center">Built Around The Way Communities Operate</h2>
          <div className="bk-method-track">
            {METHOD_STEPS.map((s, i) => (
              <div key={i} className="bk-method-card">
                <div className="bk-method-badge">{s.method}</div>
                <div className="bk-method-num">{s.num}</div>
                <h3 className="bk-method-title">{s.title}</h3>
                <p className="bk-method-body">{s.body}</p>
              </div>
            ))}
          </div>
          <div className="bk-center" style={{ marginTop: 40 }}>
            <Link to="/request-quote" className="bk-btn bk-btn-primary">Request Community Proposal</Link>
          </div>
        </div>
      </section>

      {/* 5 — Why Communities Choose BuzzKill */}
      <section className="bk-section bk-com-section bk-section-cream">
        <div className="bk-container">
          <p className="bk-eyebrow bk-center">Why BuzzKill</p>
          <h2 className="bk-h2 bk-center">Helping Communities Run More Smoothly</h2>
          <div className="bk-center" style={{ marginBottom: 36 }}>
            <Link to="/contact" className="bk-btn bk-btn-primary">Let's Talk About Your Community</Link>
          </div>
          <div className="bk-choose-grid">
            {WHY_CARDS.map((c, i) => (
              <div key={i} className="bk-choose-card">
                <img src={c.img} alt={c.title} className="bk-com-card-img" />
                <h3 className="bk-choose-title">{c.title}</h3>
                <p className="bk-choose-body">{c.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 6 — The Process */}
      <section className="bk-section bk-com-section bk-section-dark">
        <div className="bk-container">
          <p className="bk-eyebrow bk-center" style={{ color: "var(--bk-green)" }}>The Process</p>
          <h2 className="bk-h2 bk-on-dark bk-center">Getting Started Is Simple</h2>
          <div className="bk-center" style={{ marginBottom: 36 }}>
            <Link to="/request-quote" className="bk-btn bk-btn-primary">Request Community Proposal</Link>
          </div>
          <div className="bk-book-track">
            {PROCESS_STEPS.map((s, i) => (
              <div key={i} className="bk-book-step">
                <div className="bk-book-num">{s.num}</div>
                <div className="bk-book-content">
                  <h3 className="bk-book-title">{s.title}</h3>
                  <p className="bk-book-body">{s.body}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 6 — Prevention Tips */}
      <section className="bk-section bk-section-cream">
        <div className="bk-container bk-narrow">
          <p className="bk-eyebrow">Stay One Step Ahead</p>
          <h2 className="bk-h2">Small Steps. Better Communities.</h2>
          <div className="bk-tips-list">
            {PREVENTION_TIPS.map((tip, i) => (
              <div key={i} className="bk-tip-item">
                <div className="bk-tip-check" aria-hidden="true">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                </div>
                <div>
                  <p className="bk-tip-title">{tip}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 7 — More Community Solutions */}
      <section className="bk-section bk-section-dark">
        <div className="bk-container">
          <p className="bk-eyebrow bk-center" style={{ color: "var(--bk-green)" }}>Explore More</p>
          <h2 className="bk-h2 bk-on-dark bk-center">Every Community Is Different. So Is Every Solution.</h2>
          <div className="bk-related-grid">
            {RELATED_SERVICES.map((svc, i) => (
              <Link key={i} to={svc.to} className="bk-related-card">
                <h3 className="bk-related-title">{svc.label}</h3>
                <p className="bk-related-desc">{svc.desc}</p>
                <span className="bk-related-arrow" aria-hidden="true">&#x2192;</span>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* 8 — FAQ */}
      <div>
        <FAQ
          eyebrow="Before You Reach Out"
          title="Frequently Asked Questions"
          items={FAQS}
        />
      </div>

      {/* Final CTA */}
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
              <p className="bk-schedule-eyebrow">Ready To Get BuzzKilled?</p>
              <h2 className="bk-schedule-title">Let's Make Pest Control One Less Thing To Manage.</h2>
              <p className="bk-schedule-sub">When pest control is proactive, dependable, and built around your community, everyone benefits. BuzzKill helps you protect more while managing less.</p>
              <div className="bk-com-cta-row">
                <Link to="/request-quote" className="bk-btn bk-schedule-cta">
                  Request Community Proposal
                </Link>
                <Link to="/contact" className="bk-btn bk-btn-outline-light bk-com-talk-btn">
                  Talk To Our Team
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
