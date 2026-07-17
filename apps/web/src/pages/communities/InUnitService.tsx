import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import FAQ from "../../components/FAQ";
import Hero from "../../components/Hero";
import SEO, { buildBreadcrumbSchema, buildServiceSchema } from "../../components/SEO";
import QuoteCard from "../../components/QuoteCard";

const FAMILIAR_ITEMS = [
  { img: "/images/01-reporting-pests.png",     text: "Residents keep reporting ants or roaches and nothing seems to fix it." },
  { img: "/images/02-repeated-treatment.png",  text: "The same unit needs repeated treatment and the problem always comes back." },
  { img: "/images/03-spreading-units.png",     text: "Complaints are starting to spread to neighboring units." },
  { img: "/images/04-scheduling.png",          text: "Scheduling service around residents is complicated." },
  { img: "/images/05-vacant-units.png",        text: "Vacant units are sitting unmonitored and becoming hidden pest sources." },
  { img: "/images/06-communication.png",       text: "Residents want to know what is being done and what to expect." },
];

const ROOT_CAUSES = [
  {
    num: "01",
    label: "Shared Walls",
    title: "Pests travel where residents cannot see them.",
    body: "Pests move through wall voids, plumbing lines, electrical openings, and utility spaces between neighboring units without any visible sign of activity.",
  },
  {
    num: "02",
    label: "Food Sources",
    title: "Everyday kitchen and bathroom conditions attract pests.",
    body: "Small crumbs, grease, and pet food provide enough resources to support growing pest populations inside residential units.",
  },
  {
    num: "03",
    label: "Moisture",
    title: "Moisture issues create ideal conditions for pests.",
    body: "Leaking pipes, bathrooms, kitchens, and utility rooms create warm, damp areas where many pests thrive and establish activity.",
  },
  {
    num: "04",
    label: "Vacant Units",
    title: "Empty units allow pest activity to go unnoticed.",
    body: "Vacant apartments often go uninspected for extended periods, allowing pests to establish activity that eventually spreads to occupied units.",
  },
  {
    num: "05",
    label: "Delayed Treatment",
    title: "Every day without treatment allows pests to spread further.",
    body: "Waiting to address reports gives pests more time to move between units and establish activity across a larger portion of the building.",
  },
];

const METHOD_STEPS = [
  {
    method: "UNDERSTAND",
    num: "01",
    title: "Inspect Every Concern",
    body: "Before any treatment, we identify where pests are active and how they are moving between units so we can address the problem at the source.",
  },
  {
    method: "SOLVE",
    num: "02",
    title: "Treat The Source",
    body: "Our licensed technicians target the problem inside each affected unit while respecting every resident's home and schedule.",
  },
  {
    method: "PROTECT",
    num: "03",
    title: "Help Prevent Future Activity",
    body: "We provide clear recommendations that reduce conditions attracting pests and help keep the community protected between visits.",
  },
];

const PROCESS_STEPS = [
  { num: "01", title: "Tell us about your community.", body: "Share the details of your property and what you're looking for in a pest control partner." },
  { num: "02", title: "We'll learn what you need.", body: "We take the time to understand your buildings, layouts, and the unique pressures your community faces." },
  { num: "03", title: "Build the right protection plan.", body: "We put together a program built around your community's schedule, spaces, and residents." },
  { num: "04", title: "Help keep your community protected.", body: "Ongoing service with clear communication so pest management stays one less thing to worry about." },
];

const WHY_CARDS = [
  { img: "/images/fewer-resident-complaints.png", title: "Fewer Resident Complaints", body: "Helping reduce recurring pest issues before they affect everyday living." },
  { img: "/images/clear-communication.png",       title: "Clear Communication",       body: "Every visit ends with straightforward reporting and recommendations." },
  { img: "/images/flexible-scheduling.png",       title: "Flexible Scheduling",       body: "Services planned around your community whenever possible." },
  { img: "/images/local-experience.png",          title: "Local Experience",          body: "Proudly serving communities throughout Massachusetts and Rhode Island." },
];

const PREVENTION_TIPS = [
  { title: "Report Pest Activity Early",     body: "The sooner a pest issue is reported, the easier it is to treat and the less likely it is to spread to neighboring units." },
  { title: "Keep Kitchens Clean",            body: "Wipe up crumbs, store food in sealed containers, and clean up spills to remove the food sources that attract common household pests." },
  { title: "Fix Plumbing Leaks Quickly",     body: "Leaking pipes and moisture under sinks create ideal conditions for pests. Prompt repairs help reduce harborage conditions inside units." },
  { title: "Seal Gaps Around Plumbing",      body: "Small openings around pipes, cables, and utility lines provide easy travel paths between units. Sealing these gaps reduces pest movement." },
  { title: "Inspect Vacant Units Regularly", body: "Unoccupied units can develop pest activity that goes unnoticed. Regular inspections help catch problems before they spread." },
];

const COMMUNITY_SERVICES = [
  { label: "Communities Overview",   to: "/communities",              desc: "Full community pest protection programs for HOAs, condos, and more." },
  { label: "Common Area Protection", to: "/communities/common-areas", desc: "Protecting hallways, lobbies, clubhouses, and shared spaces." },
  { label: "HOA & Board Resources",  to: "/communities/hoa-resources",desc: "Guidance and tools for boards planning long-term pest programs." },
  { label: "For Unit Owners",        to: "/communities/for-owners",   desc: "Practical pest protection for individual homeowners within the community." },
];

const FAQS = [
  {
    q: "Do residents need to leave during treatment?",
    a: "Most services allow residents to remain in their homes. Your technician will explain any preparation needed before the visit.",
  },
  {
    q: "How are appointments scheduled?",
    a: "We coordinate directly with property management to make scheduling simple and consistent for all residents.",
  },
  {
    q: "Can you treat multiple units on the same visit?",
    a: "Yes. Treating nearby units together often improves long-term results and reduces the chance of pests moving between spaces.",
  },
  {
    q: "Do you provide service reports?",
    a: "Yes. Management receives clear documentation after every scheduled service so there is always a complete record on file.",
  },
  {
    q: "What pests do you treat inside apartments and condominiums?",
    a: "We treat common household pests including ants, cockroaches, spiders, rodents, wasps, and other covered pests depending on your service plan.",
  },
  {
    q: "What if pest activity returns between visits?",
    a: "If covered pests return during your service period, we return at no additional cost. Your community should never feel like it is on its own.",
  },
];

export default function InUnitService() {
  const [showBackToTop, setShowBackToTop]     = useState(false);
  const [activeAccordion, setActiveAccordion] = useState<string | null>("01");
  const [activeFamiliar, setActiveFamiliar]   = useState(0);
  const prevFamiliar = () => setActiveFamiliar(i => (i - 1 + FAMILIAR_ITEMS.length) % FAMILIAR_ITEMS.length);
  const nextFamiliar = () => setActiveFamiliar(i => (i + 1) % FAMILIAR_ITEMS.length);

  useEffect(() => {
    const onScroll = () => {
      setShowBackToTop(window.scrollY > 700);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <>
      <SEO
        title="In Unit Pest Control Services — MA & RI Communities"
        description="Professional in unit pest control for apartments, condominiums, and HOA communities across Massachusetts and Rhode Island. Coordinated with management. Respectful of every resident."
        jsonLd={[
          buildServiceSchema(
            "In Unit Pest Control Services",
            "Professional in unit pest control for apartments, condominiums, and HOA communities across Massachusetts and Rhode Island.",
            "/communities/in-unit",
          ),
          buildBreadcrumbSchema([
            { name: "Home",        url: "/" },
            { name: "Communities", url: "/communities" },
            { name: "In Unit Service", url: "/communities/in-unit" },
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
        image="/images/in-unit-hero.png"
        eyebrow="IN UNIT PEST CONTROL"
        headline="Pest Problems Start Inside. So Does The Solution."
        sub="BuzzKill provides professional in unit pest control for apartments, condominiums, and HOA communities across Massachusetts and Rhode Island. We coordinate with management, respect every resident's home, and help keep your community protected."
        primaryCta={{ label: "Request Community Proposal", href: "/quote" }}
        secondaryCta={{ label: "Talk To A Community Specialist", href: "tel:+15082589294" }}
        className="bk-hero--community"
      />

      {/* 2 — Sound Familiar? */}
      <section id="familiar" className="bk-section bk-section-cream">
        <div className="bk-container">
          <p className="bk-eyebrow bk-center">Sound Familiar?</p>
          <h2 className="bk-h2 bk-center">Does This Sound Familiar?</h2>
          <p className="bk-body-lead bk-center">These are the most common things property managers and community coordinators tell us before they call.</p>

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

          <div className="bk-center" style={{ marginTop: 32 }}>
            <Link to="/quote" className="bk-btn bk-btn-primary">Protect Every Unit</Link>
          </div>
        </div>
      </section>

      {/* 3 — The Real Issue */}
      <section id="issue" className="bk-section bk-section-dark">
        <div className="bk-container bk-narrow">
          <p className="bk-eyebrow" style={{ color: "var(--bk-green)" }}>The Real Issue</p>
          <h2 className="bk-h2 bk-on-dark">A Pest Problem In One Unit Rarely Stays There</h2>
          <p className="bk-issue-intro">In shared buildings, pests do not respect walls. What starts in one apartment can spread quietly through shared infrastructure before management ever receives the first complaint.</p>

          <div className="bk-com-issue-split">
            <div className="bk-com-issue-block">
              <div className="bk-com-issue-num">01</div>
              <h3 className="bk-com-issue-title">Pests Move Through Buildings</h3>
              <p className="bk-com-issue-body">Wall voids, plumbing corridors, and shared mechanical spaces provide hidden pathways that allow pests to move between units without any visible sign. A problem that appears to be isolated often has a broader source that treating one unit alone will not resolve.</p>
            </div>
            <div className="bk-com-issue-block">
              <div className="bk-com-issue-num">02</div>
              <h3 className="bk-com-issue-title">Surface Treatment Is Not Enough</h3>
              <p className="bk-com-issue-body">Store-bought products and reactive sprays address what is visible. They rarely reach the source of activity or the pathways pests use to travel. Professional in unit treatment identifies where activity originates so the problem can be addressed thoroughly, not just managed temporarily.</p>
            </div>
          </div>

          <div className="bk-center" style={{ marginTop: 40 }}>
            <Link to="/quote" className="bk-btn bk-btn-primary">Stop Problems Before They Spread</Link>
          </div>
        </div>
      </section>

      {/* 4 — Root Causes */}
      <section id="root-causes" className="bk-section bk-section-cream">
        <div className="bk-container">
          <div className="bk-attract-layout">

            <div className="bk-attract-main">
              <p className="bk-eyebrow">Why Pests Spread Between Units</p>
              <h2 className="bk-h2">What Makes In Unit Activity Hard to Control</h2>
              <p className="bk-attract-intro">
                Pests travel where people cannot see. Understanding how they move helps prevent larger community issues before they reach the point of multiple complaints.
              </p>
              <div className="bk-accordion">
                {ROOT_CAUSES.map((r) => {
                  const isOpen = activeAccordion === r.num;
                  return (
                    <div key={r.num} className={`bk-accordion-item${isOpen ? " is-open" : ""}`}>
                      <button
                        className="bk-accordion-header"
                        onClick={() => setActiveAccordion(isOpen ? null : r.num)}
                        aria-expanded={isOpen}
                      >
                        <span className="bk-accordion-num">{r.num}</span>
                        <span className="bk-accordion-label">{r.label}</span>
                        <span className="bk-accordion-chevron" aria-hidden="true">
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M6 9l6 6 6-6" />
                          </svg>
                        </span>
                      </button>
                      <div className="bk-accordion-body">
                        <div className="bk-accordion-body-inner">
                          <h3 className="bk-accordion-title">{r.title}</h3>
                          <p className="bk-accordion-text">{r.body}</p>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <aside className="bk-attract-sidebar">
              <QuoteCard />
            </aside>

          </div>
        </div>
      </section>

      {/* 5 — BuzzKill Method */}
      <section id="method" className="bk-section bk-section-cream">
        <div className="bk-container">
          <p className="bk-eyebrow bk-center">The BuzzKill Method</p>
          <h2 className="bk-h2 bk-center">Community Focused. Resident Friendly.</h2>

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
            <Link to="/quote" className="bk-btn bk-btn-primary">Schedule In Unit Service</Link>
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

      {/* 7 — The Process */}
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

      {/* 8 — Prevention */}
      <section id="prevention" className="bk-section bk-section-cream">
        <div className="bk-container bk-narrow">
          <p className="bk-eyebrow">Prevention</p>
          <h2 className="bk-h2">Help Reduce Pest Activity Between Visits</h2>
          <p className="bk-body-lead">Small habits across the community help prevent larger pest problems and extend the protection between scheduled service visits.</p>
          <div className="bk-tips-list">
            {PREVENTION_TIPS.map((tip, i) => (
              <div key={i} className="bk-tip-item">
                <div className="bk-tip-check" aria-hidden="true">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                </div>
                <div>
                  <p className="bk-tip-title">{tip.title}</p>
                  <p>{tip.body}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 9 — Explore More Community Services */}
      <section id="services" className="bk-section bk-section-dark">
        <div className="bk-container">
          <p className="bk-eyebrow bk-center" style={{ color: "var(--bk-green)" }}>More Protection</p>
          <h2 className="bk-h2 bk-on-dark bk-center">Explore More Community Services</h2>
          <p className="bk-body-lead bk-on-dark bk-center">In unit service is one part of a complete community pest program. See what else BuzzKill offers for shared properties.</p>
          <div className="bk-related-grid">
            {COMMUNITY_SERVICES.map((svc, i) => (
              <Link key={i} to={svc.to} className="bk-related-card">
                <h3 className="bk-related-title">{svc.label}</h3>
                <p className="bk-related-desc">{svc.desc}</p>
                <span className="bk-related-arrow" aria-hidden="true">&#x2192;</span>
              </Link>
            ))}
          </div>
          <div className="bk-center" style={{ marginTop: 40 }}>
            <Link to="/communities" className="bk-btn bk-btn-primary">Explore Community Services</Link>
          </div>
        </div>
      </section>

      {/* 10 — FAQ */}
      <div id="faq">
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
              <p className="bk-schedule-eyebrow">Ready to Get BuzzKilled?</p>
              <h2 className="bk-schedule-title">Protect Your Community With Confidence</h2>
              <p className="bk-schedule-sub">From individual units to shared spaces, BuzzKill helps communities stay protected with dependable service, clear communication, and solutions built around the way your property operates.</p>
              <div className="bk-com-cta-row">
                <Link to="/quote" className="bk-btn bk-schedule-cta">
                  Request Community Proposal
                </Link>
                <Link to="/contact" className="bk-btn bk-btn-outline-light bk-com-talk-btn">
                  Talk To A Specialist
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
