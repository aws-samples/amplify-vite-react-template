import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import FAQ from "../../components/FAQ";
import Hero from "../../components/Hero";
import SEO, { buildBreadcrumbSchema, buildServiceSchema } from "../../components/SEO";

const FAMILIAR_ITEMS = [
  { img: "/images/hoa-01-complaints-increasing.png", text: "Resident complaints keep increasing." },
  { img: "/images/hoa-02-long-term-solution.png",    text: "We need a long term solution instead of temporary fixes." },
  { img: "/images/hoa-03-when-to-act.png",           text: "It's difficult knowing when to act." },
  { img: "/images/hoa-04-protect-investment.png",    text: "We want to protect our community investment." },
  { img: "/images/hoa-05-trusted-partner.png",       text: "We need a partner we can trust." },
  { img: "/images/hoa-06-one-less-thing.png",        text: "We want pest control to be one less thing to manage." },
];

const COMMUNITY_CARDS = [
  {
    title: "Your Residents",
    body: "A protected community starts with residents who feel comfortable where they live.",
  },
  {
    title: "Your Property",
    body: "Routine pest management helps support cleaner common areas and shared spaces.",
  },
  {
    title: "Your Investment",
    body: "Looking after your property today helps maintain the community for years to come.",
  },
  {
    title: "Your Partnership",
    body: "The right pest control partner should make decisions easier, not more complicated.",
  },
];

const METHOD_STEPS = [
  {
    method: "UNDERSTAND",
    num: "01",
    title: "Every Community Is Different.",
    body: "We take the time to understand how your property operates before recommending the right approach.",
  },
  {
    method: "SOLVE",
    num: "02",
    title: "Protection Built Around Your Community.",
    body: "From common areas to optional in unit services, every recommendation is based on your community's needs.",
  },
  {
    method: "PROTECT",
    num: "03",
    title: "Helping Communities Stay Ahead.",
    body: "Ongoing protection and dependable communication help support a better resident experience.",
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
  "Keep common areas clean and well maintained.",
  "Address moisture issues before they attract pests.",
  "Monitor seasonal pest activity.",
  "Stay consistent with preventative pest protection.",
];

const RELATED_SERVICES = [
  { label: "Common Area Protection", to: "/communities/common-areas", desc: "Helping protect the spaces everyone shares." },
  { label: "In Unit Service",        to: "/communities/in-unit",       desc: "Professional pest control when residents need help inside their homes." },
  { label: "Property Managers",      to: "/property-managers",         desc: "Protect More. Manage Less." },
  { label: "Community Overview",     to: "/communities",               desc: "See how BuzzKill helps communities across Massachusetts and Rhode Island." },
];

const FAQS = [
  {
    q: "Why should an HOA have a pest management plan?",
    a: "A proactive approach helps protect common areas, support residents, and reduce recurring pest concerns before they grow.",
  },
  {
    q: "Can BuzzKill work directly with our property manager?",
    a: "Yes. We work alongside property managers to help coordinate service and communication for the community.",
  },
  {
    q: "Can residents also receive service?",
    a: "Yes. Optional in unit service may be available depending on your community's arrangement.",
  },
  {
    q: "How do we know if our community needs service?",
    a: "Recurring resident reports, seasonal pest activity, or concerns in shared spaces are all good reasons to start the conversation.",
  },
  {
    q: "What information should the board have before requesting a proposal?",
    a: "Knowing your property layout, common concerns, and community goals helps us recommend the right next step.",
  },
  {
    q: "How do we get started?",
    a: "Request a community proposal and we'll help you understand the options for your property.",
  },
];

export default function HOAResources() {
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
        title="HOA & Board Resources — Community Pest Control MA & RI"
        description="Proactive pest protection for HOA boards and property managers across Massachusetts and Rhode Island. Better decisions. Stronger communities."
        jsonLd={[
          buildServiceSchema(
            "HOA & Board Pest Control Resources",
            "Proactive pest protection programs for HOA boards and property managers across Massachusetts and Rhode Island.",
            "/communities/hoa-resources",
          ),
          buildBreadcrumbSchema([
            { name: "Home",                  url: "/" },
            { name: "Communities",           url: "/communities" },
            { name: "HOA & Board Resources", url: "/communities/hoa-resources" },
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
        image="/images/hoa-hero.png"
        eyebrow="HOA & BOARD RESOURCES"
        headline="Better Decisions. Stronger Communities."
        sub="Protecting a community takes more than responding to pest problems. BuzzKill helps HOA boards make informed decisions with proactive pest protection, clear communication, and local expertise you can count on. Protection With Purpose."
        primaryCta={{ label: "Request Community Proposal", href: "/request-quote" }}
        secondaryCta={{ label: "Talk To A Community Specialist", href: "/contact" }}
        className="bk-hero--community"
      />

      {/* 2 — Sound Familiar */}
      <section className="bk-section bk-section-cream">
        <div className="bk-container">
          <p className="bk-eyebrow bk-center">Board Member Challenges</p>
          <h2 className="bk-h2 bk-center">Does This Sound Like Your Community?</h2>
          <p className="bk-body-lead bk-center">Every board wants the same thing. A community that's protected, well maintained, and enjoyable to live in.</p>

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
            <Link to="/request-quote" className="bk-btn bk-btn-primary">Let's Build A Better Plan</Link>
          </div>
        </div>
      </section>

      {/* 3 — Community First */}
      <section className="bk-section bk-section-dark">
        <div className="bk-container">
          <p className="bk-eyebrow bk-center" style={{ color: "var(--bk-green)" }}>Protecting What Matters</p>
          <h2 className="bk-h2 bk-on-dark bk-center">Every Decision Shapes Your Community</h2>
          <div className="bk-fou-who-grid">
            {COMMUNITY_CARDS.map((card, i) => (
              <div key={i} className="bk-fou-who-card">
                <h3 className="bk-fou-who-title">{card.title}</h3>
                <p className="bk-fou-who-body">{card.body}</p>
              </div>
            ))}
          </div>
          <div className="bk-center" style={{ marginTop: 40 }}>
            <Link to="/contact" className="bk-btn bk-btn-primary">Talk To A BuzzKill Specialist</Link>
          </div>
        </div>
      </section>

      {/* 4 — The BuzzKill Method */}
      <section className="bk-section bk-section-cream">
        <div className="bk-container">
          <p className="bk-eyebrow bk-center">Understand. Solve. Protect.</p>
          <h2 className="bk-h2 bk-center">A Smarter Way To Protect Your Community</h2>
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
          <h2 className="bk-h2">Small Steps Help Protect The Whole Community</h2>
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

      {/* 7 — Explore Community Services */}
      <section className="bk-section bk-section-dark">
        <div className="bk-container">
          <p className="bk-eyebrow bk-center" style={{ color: "var(--bk-green)" }}>More Community Solutions</p>
          <h2 className="bk-h2 bk-on-dark bk-center">Protection For Every Part Of Your Community</h2>
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
              <h2 className="bk-schedule-title">Strong Communities Start With Smart Protection.</h2>
              <p className="bk-schedule-sub">Whether you're planning ahead or responding to resident concerns, BuzzKill helps your board make confident decisions with protection built around your community.</p>
              <div className="bk-com-cta-row">
                <Link to="/request-quote" className="bk-btn bk-schedule-cta">
                  Request Community Proposal
                </Link>
                <Link to="/contact" className="bk-btn bk-btn-outline-light bk-com-talk-btn">
                  Talk To A Community Specialist
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
