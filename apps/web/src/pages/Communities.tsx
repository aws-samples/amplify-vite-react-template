import { useState } from "react";
import { Link } from "react-router-dom";
import Hero from "../components/Hero";
import FAQ from "../components/FAQ";
import SEO, { buildServiceSchema, buildBreadcrumbSchema } from "../components/SEO";

const WHO_CARDS = [
  {
    img: "/images/who-property-managers.png",
    title: "Property Managers",
    body: "Helping reduce resident complaints through dependable service and clear communication.",
  },
  {
    img: "/images/who-hoa-board.png",
    title: "HOA Boards",
    body: "Helping protect shared investments while supporting a better resident experience.",
  },
  {
    img: "/images/who-unit-owners.png",
    title: "Unit Owners",
    body: "Professional pest control made simple whenever service is needed inside the home.",
  },
  {
    img: "/images/who-residents.png",
    title: "Residents",
    body: "Helping create cleaner, more comfortable places to live throughout the community.",
  },
];

const COMMUNITY_NODES = [
  "Common Areas",
  "Residents",
  "Property Managers",
  "Board Members",
];

const SERVICE_CARDS = [
  {
    img: "/images/common-area-protection.png",
    title: "Common Area Protection",
    body: "Protecting entrances, clubhouses, shared spaces, utility rooms, and more.",
    to: "/communities/common-areas",
  },
  {
    img: "/images/in-unit-service.png",
    title: "In Unit Service",
    body: "Convenient pest control for residents with professional scheduling and trusted service.",
    to: "/communities/in-unit",
  },
  {
    img: "/images/hoa-board-resources.png",
    title: "HOA & Board Resources",
    body: "Helpful guides and resources to support planning, communication, and prevention.",
    to: "/communities/hoa-resources",
  },
  {
    img: "/images/for-unit-owners.png",
    title: "For Unit Owners",
    body: "Programs designed to simplify pest management across your community.",
    to: "/communities/for-owners",
  },
];

const APPROACH_STEPS = [
  {
    label: "UNDERSTAND",
    title: "Every community is different.",
    body: "Every community has different buildings, layouts, and seasonal pest pressures. We start by learning yours.",
  },
  {
    label: "SOLVE",
    title: "Service built around your property.",
    body: "Services are planned around the needs of your property and the people who live and work there.",
  },
  {
    label: "PROTECT",
    title: "Ongoing support you can count on.",
    body: "Ongoing service helps reduce recurring pest issues while supporting a better community experience.",
  },
];

const WHY_CARDS = [
  {
    img: "/images/fewer-resident-complaints.png",
    title: "Fewer Resident Complaints",
    body: "Helping reduce recurring pest issues before they affect everyday living.",
  },
  {
    img: "/images/clear-communication.png",
    title: "Clear Communication",
    body: "Every visit ends with straightforward reporting and recommendations.",
  },
  {
    img: "/images/flexible-scheduling.png",
    title: "Flexible Scheduling",
    body: "Services planned around your community whenever possible.",
  },
  {
    img: "/images/local-experience.png",
    title: "Local Experience",
    body: "Proudly serving communities throughout Massachusetts and Rhode Island.",
  },
];

const PROCESS_STEPS = [
  { num: "01", title: "Tell us about your community.", body: "Share the details of your property and what you're looking for in a pest control partner." },
  { num: "02", title: "We'll learn what you need.", body: "We take the time to understand your buildings, layouts, and the unique pressures your community faces." },
  { num: "03", title: "Build the right protection plan.", body: "We put together a program built around your community's schedule, spaces, and residents." },
  { num: "04", title: "Help keep your community protected.", body: "Ongoing service with clear communication so pest management stays one less thing to worry about." },
];

const RESOURCE_CARDS = [
  { img: "/images/seasonal-pest-guide.png", title: "Seasonal Pest Guide", body: "Know what to expect throughout the year and how to prepare your community." },
  { img: "/images/community-prevention-tips.png", title: "Community Prevention Tips", body: "Practical steps that help reduce pest pressure in shared spaces and around the property." },
  { img: "/images/preparing-residents.png", title: "Preparing Residents For Service", body: "Simple guidance for communicating upcoming service to your community." },
  { img: "/images/faq.png", title: "Frequently Asked Questions", body: "Common questions boards and property managers ask before getting started." },
];

const COMMUNITY_FAQS = [
  {
    q: "Do you service condominiums and homeowner associations?",
    a: "Yes. BuzzKill works with condominiums, HOAs, and residential communities throughout Massachusetts and Rhode Island. We provide service for both common areas and individual units depending on the needs of your community.",
  },
  {
    q: "Can residents schedule in unit service?",
    a: "Yes. Residents can schedule in unit pest control directly. We coordinate to make the process simple for both the resident and the property management team.",
  },
  {
    q: "How are common areas serviced?",
    a: "Common area service covers entrances, hallways, utility rooms, clubhouses, and other shared spaces. We work with your schedule to minimize disruption to daily operations and residents.",
  },
  {
    q: "Can service be customized for our community?",
    a: "Absolutely. Every community program is built around your specific property, pest pressures, and operational needs. We don't use a one-size-fits-all approach.",
  },
  {
    q: "Do you provide service throughout Massachusetts and Rhode Island?",
    a: "Yes. BuzzKill is licensed and provides pest control service to communities across Massachusetts and Rhode Island.",
  },
  {
    q: "How do we request a proposal?",
    a: "You can request a community proposal directly through our website. We'll follow up to learn more about your community and put together the right program for your property.",
  },
];

export default function Communities() {
  const [activeStep, setActiveStep] = useState(0);
  const [activeWho, setActiveWho] = useState(0);
  const prevWho = () => setActiveWho(i => (i - 1 + WHO_CARDS.length) % WHO_CARDS.length);
  const nextWho = () => setActiveWho(i => (i + 1) % WHO_CARDS.length);

  return (
    <>
      <SEO
        title="Community Pest Control for HOAs & Condos — MA & RI"
        description="Proactive pest control for condominiums, HOAs, and shared communities across Massachusetts and Rhode Island. Common-area programs with board-friendly reporting and optional in-unit service."
        jsonLd={[
          buildServiceSchema(
            "Community & HOA Pest Control",
            "Proactive pest control for condominiums, HOAs, and shared communities across Massachusetts and Rhode Island. Common-area programs with board-friendly reporting.",
            "/communities",
          ),
          buildBreadcrumbSchema([
            { name: "Home", url: "/" },
            { name: "Communities", url: "/communities" },
          ]),
        ]}
      />
      {/* 1 — Hero */}
      <Hero
        announceBanner
        image="/images/communities-hero.png"
        eyebrow="Community Pest Protection"
        headline="Protecting Communities Starts With The Right Partner"
        sub="Proactive pest control, clear communication, and dependable service across Massachusetts and Rhode Island."
        primaryCta={{ label: "Request Community Proposal", href: "/quote" }}
        secondaryCta={{ label: "Explore Community Services", href: "#community-services" }}
        className="bk-hero--community"
      />

      {/* 2 — Every Community Has Different Needs */}
      <section className="bk-section bk-com-section bk-section-cream">
        <div className="bk-container">
          <div className="bk-com-story-wrap">
            <div className="bk-com-story-text">
              <p className="bk-eyebrow">Built For Community Living</p>
              <h2 className="bk-h2">One Community. Different Needs. One Trusted Partner.</h2>
              <p className="bk-com-story-body">
                Every community operates differently. Some need common area protection. Others need convenient in unit service for residents. Some need both.
              </p>
              <p className="bk-com-story-close">
                That's why BuzzKill works alongside boards and property managers to build a pest control program that fits the way your community operates.
              </p>
              <div style={{ marginTop: 28 }}>
                <Link to="#community-services" className="bk-btn bk-btn-primary">Find the Right Solution</Link>
              </div>
            </div>
            <div className="bk-com-story-visual">
              <div className="bk-com-nodes">
                {COMMUNITY_NODES.map((n, i) => (
                  <div key={i} className={`bk-com-node bk-com-node--${i}`}>
                    <span>{n}</span>
                  </div>
                ))}
                <div className="bk-com-nodes-center">
                  <img src="/images/buzzkill-logo-badge.png" alt="BuzzKill" className="bk-com-nodes-logo" />
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 3 — Who We Help */}
      <section className="bk-section bk-com-section bk-section-cream">
        <div className="bk-container">
          <p className="bk-eyebrow bk-center">Who We Support</p>
          <h2 className="bk-h2 bk-center">Built Around Everyone Who Calls Your Community Home</h2>
          <div className="bk-center" style={{ marginBottom: 32 }}>
            <Link to="#community-services" className="bk-btn bk-btn-primary">Explore Community Programs</Link>
          </div>
          <div className="bk-com-who-carousel">
            <button className="bk-com-who-arrow" onClick={prevWho} aria-label="Previous">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M15 18l-6-6 6-6" />
              </svg>
            </button>
            <div className="bk-com-who-stage">
              {WHO_CARDS.map((c, i) => (
                <div
                  key={i}
                  className={`bk-com-who-slide${activeWho === i ? " is-active" : ""}`}
                  aria-hidden={activeWho !== i}
                >
                  <div className="bk-com-who-block">
                    <img src={c.img} alt={c.title} className="bk-com-who-img" />
                    <div className="bk-com-who-text">
                      <h3 className="bk-com-who-title">{c.title}</h3>
                      <p className="bk-com-who-body">{c.body}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <button className="bk-com-who-arrow" onClick={nextWho} aria-label="Next">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M9 18l6-6-6-6" />
              </svg>
            </button>
          </div>
          <div className="bk-com-who-dots">
            {WHO_CARDS.map((_, i) => (
              <button
                key={i}
                className={`bk-com-who-dot${activeWho === i ? " is-active" : ""}`}
                onClick={() => setActiveWho(i)}
                aria-label={WHO_CARDS[i].title}
              />
            ))}
          </div>
          <div className="bk-com-who-labels">
            {WHO_CARDS.map((c, i) => (
              <button
                key={i}
                className={`bk-com-who-label${activeWho === i ? " is-active" : ""}`}
                onClick={() => setActiveWho(i)}
              >
                {c.title}
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* 4 — Community Services */}
      <section id="community-services" className="bk-section bk-com-section bk-section-cream">
        <div className="bk-container">
          <p className="bk-eyebrow bk-center">Community Solutions</p>
          <h2 className="bk-h2 bk-center">Protection Where Your Community Needs It Most</h2>
          <div className="bk-center" style={{ marginBottom: 36 }}>
            <Link to="/quote" className="bk-btn bk-btn-primary">Request Community Proposal</Link>
          </div>
          <div className="bk-com-services-grid">
            {SERVICE_CARDS.map((s, i) => (
              <Link key={i} to={s.to} className="bk-com-service-card">
                <img src={s.img} alt={s.title} className="bk-com-card-img" />
                <h3 className="bk-com-service-title">{s.title}</h3>
                <p className="bk-com-service-body">{s.body}</p>
                <span className="bk-com-service-cta">
                  Learn More
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M5 12h14M12 5l7 7-7 7" />
                  </svg>
                </span>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* 5 — The BuzzKill Community Approach */}
      <section className="bk-section bk-com-section bk-section-dark">
        <div className="bk-container">
          <p className="bk-eyebrow bk-center" style={{ color: "var(--bk-green)" }}>Protection With Purpose</p>
          <h2 className="bk-h2 bk-on-dark bk-center">A Better Way To Manage Pest Control</h2>
          <p className="bk-body-lead bk-on-dark bk-center" style={{ maxWidth: 580, margin: "0 auto 24px" }}>
            Instead of waiting for complaints, BuzzKill focuses on helping communities stay ahead of pest problems through proactive service, dependable communication, and long term planning.
          </p>
          <div className="bk-center" style={{ marginBottom: 32 }}>
            <Link to="/quote" className="bk-btn bk-btn-primary">See How We Protect Communities</Link>
          </div>
          <div className="bk-com-approach-tabs">
            {APPROACH_STEPS.map((s, i) => (
              <button
                key={i}
                className={`bk-com-approach-tab${activeStep === i ? " is-active" : ""}`}
                onClick={() => setActiveStep(i)}
              >
                {s.label}
              </button>
            ))}
          </div>
          <div className="bk-com-approach-panel">
            <h3 className="bk-com-approach-title">{APPROACH_STEPS[activeStep].title}</h3>
            <p className="bk-com-approach-body">{APPROACH_STEPS[activeStep].body}</p>
          </div>
          <div className="bk-com-approach-track">
            {APPROACH_STEPS.map((s, i) => (
              <div
                key={i}
                className={`bk-com-approach-step${activeStep === i ? " is-active" : ""}`}
                onClick={() => setActiveStep(i)}
              >
                <div className="bk-com-approach-step-label">{s.label}</div>
                <div className="bk-com-approach-step-title">{s.title}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 6 — Why Communities Choose BuzzKill */}
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

      {/* 7 — What Happens Next */}
      <section className="bk-section bk-com-section bk-section-dark">
        <div className="bk-container">
          <p className="bk-eyebrow bk-center" style={{ color: "var(--bk-green)" }}>The Process</p>
          <h2 className="bk-h2 bk-on-dark bk-center">Getting Started Is Simple</h2>
          <div className="bk-center" style={{ marginBottom: 36 }}>
            <Link to="/quote" className="bk-btn bk-btn-primary">Request Community Proposal</Link>
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

      {/* 8 — Community Resources */}
      <section className="bk-section bk-com-section bk-section-cream">
        <div className="bk-container">
          <p className="bk-eyebrow bk-center">Resources</p>
          <h2 className="bk-h2 bk-center">Helpful Information For Boards &amp; Property Managers</h2>
          <p className="bk-body-lead bk-center" style={{ maxWidth: 540, margin: "0 auto 24px" }}>
            Tools and guidance to help your community stay prepared, communicate effectively, and reduce pest pressure year round.
          </p>
          <div className="bk-center" style={{ marginBottom: 40 }}>
            <Link to="/communities/hoa-resources" className="bk-btn bk-btn-primary">Explore Resources</Link>
          </div>
          <div className="bk-com-resources-grid">
            {RESOURCE_CARDS.map((r, i) => (
              <div key={i} className="bk-com-resource-card">
                <img src={r.img} alt={r.title} className="bk-com-card-img" />
                <h3 className="bk-com-resource-title">{r.title}</h3>
                <p className="bk-com-resource-body">{r.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 9 — FAQ */}
      <FAQ
        eyebrow="Common Questions"
        title="Community FAQ"
        items={COMMUNITY_FAQS}
      />
      <div className="bk-center" style={{ paddingBottom: 64 }}>
        <Link to="/contact" className="bk-btn bk-btn-primary">Still Have Questions? Let's Talk</Link>
      </div>

      {/* 10 — Final CTA */}
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
              <p className="bk-schedule-eyebrow">Ready to Get BuzzKilled?</p>
              <h2 className="bk-schedule-title">Protect Your Community With Confidence</h2>
              <p className="bk-schedule-sub">From common areas to individual homes, BuzzKill helps communities stay protected with dependable service, clear communication, and solutions built around the way your property operates.</p>
              <div className="bk-com-cta-row">
                <Link to="/quote" className="bk-btn bk-schedule-cta">
                  Request Community Proposal
                </Link>
                <Link to="/contact" className="bk-btn bk-btn-outline-light bk-com-talk-btn">
                  Talk to Our Team
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
