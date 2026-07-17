import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import FAQ from "../../components/FAQ";
import Hero from "../../components/Hero";
import SEO, { buildBreadcrumbSchema, buildServiceSchema } from "../../components/SEO";

const FAMILIAR_ITEMS = [
  { emoji: "🐜", text: "I keep seeing the same pests no matter what I try." },
  { emoji: "🤔", text: "I'm not sure if this is my responsibility or the HOA's." },
  { emoji: "🏘️", text: "My neighbor has pests too. Could they be connected?" },
  { emoji: "😟", text: "I don't want the problem getting worse." },
  { emoji: "🛡️", text: "I need something safe around my family and pets." },
  { emoji: "✅", text: "I just want it fixed the right way." },
];

const WHO_CARDS = [
  {
    title: "Common Areas",
    body: "Your community may already protect shared spaces through scheduled pest management.",
  },
  {
    title: "Your Unit",
    body: "Inside your home, professional treatment helps stop pests before they become bigger problems.",
  },
  {
    title: "Shared Pest Activity",
    body: "Pests don't recognize property lines. Treating problems early helps protect everyone.",
  },
  {
    title: "Not Sure?",
    body: "We'll help you understand the next best step before you book.",
  },
];

const METHOD_STEPS = [
  {
    method: "UNDERSTAND",
    num: "01",
    title: "Every Home Has A Story.",
    body: "We find out why pests are there before deciding how to remove them.",
  },
  {
    method: "SOLVE",
    num: "02",
    title: "Treat The Problem. Not Just The Pest.",
    body: "We target the source so you're not dealing with the same issue again next month.",
  },
  {
    method: "PROTECT",
    num: "03",
    title: "Stay One Step Ahead.",
    body: "Simple recommendations help keep your home protected between visits.",
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
  "Store food in sealed containers.",
  "Fix leaks before pests find them.",
  "Seal gaps around windows and doors.",
  "Report activity early.",
  "Schedule protection before pests settle in.",
];

const RELATED_SERVICES = [
  { label: "Common Area Protection", to: "/communities/common-areas",  desc: "Keeping entrances, hallways, clubhouses, and shared spaces protected." },
  { label: "HOA & Board Resources",  to: "/communities/hoa-resources", desc: "Helping boards make informed pest management decisions." },
  { label: "Property Managers",      to: "/property-managers",         desc: "Protect more. Manage less." },
  { label: "Community Protection",   to: "/communities",               desc: "See how BuzzKill helps communities across Massachusetts and Rhode Island stay protected." },
];

const FAQS = [
  {
    q: "Does my HOA cover pest control inside my home?",
    a: "Every community is different. Your HOA or property manager can explain what's included, and we'll help with the rest.",
  },
  {
    q: "Can BuzzKill treat only my unit?",
    a: "Yes. If in unit service is available for your community, we'll schedule a visit that works for you.",
  },
  {
    q: "Are treatments safe for children and pets?",
    a: "Absolutely. Safe for Families. Tough on Pests. Every treatment is applied with your home and family in mind.",
  },
  {
    q: "My neighbor has pests too. Should I be concerned?",
    a: "Some pests travel between homes. Solving the problem early helps protect your home and the community around it.",
  },
  {
    q: "I already tried store bought products. Now what?",
    a: "Many products only treat what you can see. We focus on understanding why pests are there and solving the problem at the source.",
  },
  {
    q: "How do I get started?",
    a: "Know the Price. Book in Minutes. Request your instant quote online and let BuzzKill handle the rest.",
  },
];

export default function ForUnitOwners() {
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
        title="Pest Control For Unit Owners — MA & RI Condos & HOAs"
        description="Professional pest control for unit owners across Massachusetts and Rhode Island. Know the price. Book in minutes. Safe for families. Tough on pests."
        jsonLd={[
          buildServiceSchema(
            "Pest Control for Unit Owners",
            "Professional pest control for individual unit owners in condominiums and HOA communities across Massachusetts and Rhode Island.",
            "/communities/for-owners",
          ),
          buildBreadcrumbSchema([
            { name: "Home",            url: "/" },
            { name: "Communities",     url: "/communities" },
            { name: "For Unit Owners", url: "/communities/for-owners" },
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
        image="/images/communities-hero.png"
        eyebrow="FOR UNIT OWNERS"
        headline="Pest Problems In Your Home? Let's Get It BuzzKilled."
        sub="Whether it's ants in the kitchen, mice in the attic, or wasps on the patio, you shouldn't have to guess what to do next. BuzzKill helps homeowners across Massachusetts and Rhode Island understand the problem, solve it at the source, and protect what matters most. Safe for Families. Tough on Pests."
        primaryCta={{ label: "Get Instant Quote", href: "/quote" }}
        secondaryCta={{ label: "Talk To A Local Expert", href: "tel:+15082589294" }}
        className="bk-hero--community"
      />

      {/* 2 — Sound Familiar */}
      <section className="bk-section bk-section-cream">
        <div className="bk-container">
          <p className="bk-eyebrow bk-center">Everyday Pest Problems</p>
          <h2 className="bk-h2 bk-center">Does This Sound Like Your Home?</h2>
          <p className="bk-body-lead bk-center">If you've said any of these, you're in the right place.</p>

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
                    <div className="bk-com-who-emoji-circle" aria-hidden="true">{item.emoji}</div>
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
            <Link to="/quote" className="bk-btn bk-btn-primary">Know The Price. Book In Minutes.</Link>
          </div>
        </div>
      </section>

      {/* 3 — Who Takes Care of What? */}
      <section className="bk-section bk-section-dark">
        <div className="bk-container">
          <p className="bk-eyebrow bk-center" style={{ color: "var(--bk-green)" }}>Community Living</p>
          <h2 className="bk-h2 bk-on-dark bk-center">Protecting Your Home Starts With Knowing Where The Problem Begins.</h2>
          <div className="bk-fou-who-grid">
            {WHO_CARDS.map((card, i) => (
              <div key={i} className="bk-fou-who-card">
                <h3 className="bk-fou-who-title">{card.title}</h3>
                <p className="bk-fou-who-body">{card.body}</p>
              </div>
            ))}
          </div>
          <div className="bk-center" style={{ marginTop: 40 }}>
            <Link to="/contact" className="bk-btn bk-btn-primary">Talk To A BuzzKill Expert</Link>
          </div>
        </div>
      </section>

      {/* 4 — The BuzzKill Method */}
      <section className="bk-section bk-section-cream">
        <div className="bk-container">
          <p className="bk-eyebrow bk-center">Understand. Solve. Protect.</p>
          <h2 className="bk-h2 bk-center">The BuzzKill Difference</h2>
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
            <Link to="/quote" className="bk-btn bk-btn-primary">Ready To Get BuzzKilled?</Link>
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
            <Link to="/quote" className="bk-btn bk-btn-primary">Get Instant Quote</Link>
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

      {/* 6 — Prevention */}
      <section className="bk-section bk-section-cream">
        <div className="bk-container bk-narrow">
          <p className="bk-eyebrow">Stay One Step Ahead</p>
          <h2 className="bk-h2">Small Habits. Big Protection.</h2>
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

      {/* 7 — Explore More Community Services */}
      <section className="bk-section bk-section-dark">
        <div className="bk-container">
          <p className="bk-eyebrow bk-center" style={{ color: "var(--bk-green)" }}>Community Services</p>
          <h2 className="bk-h2 bk-on-dark bk-center">Your Home Is Part Of Something Bigger</h2>
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
          eyebrow="Before You Book"
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
              <h2 className="bk-schedule-title">Your Home Should Feel Comfortable. Not Shared With Pests.</h2>
              <p className="bk-schedule-sub">From one unexpected ant trail to recurring pest problems, BuzzKill helps you understand the issue, solve it at the source, and keep your home protected.</p>
              <div className="bk-com-cta-row">
                <Link to="/quote" className="bk-btn bk-schedule-cta">
                  Get Instant Quote
                </Link>
                <a href="tel:+15082589294" className="bk-btn bk-btn-outline-light bk-com-talk-btn">
                  Talk To A Local Expert
                </a>
              </div>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
