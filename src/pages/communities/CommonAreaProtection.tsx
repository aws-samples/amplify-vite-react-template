import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import FAQ from "../../components/FAQ";
import Hero from "../../components/Hero";
import SEO, { buildBreadcrumbSchema, buildServiceSchema } from "../../components/SEO";
import QuoteCard from "../../components/QuoteCard";

const FAMILIAR_ITEMS = [
  { img: "/images/01-pests-near-dumpster.jpg",    text: "We keep getting complaints about pests near the mailboxes and dumpster area." },
  { img: "/images/02-lobby-hallway-pests.jpg",     text: "Ants and rodents keep showing up in the lobby and hallways." },
  { img: "/images/03-sprayed-comes-back.jpg",      text: "We spray every season but the problem comes right back." },
  { img: "/images/04-spreading-between-units.jpg", text: "One unit had an issue and now it seems like it is spreading." },
  { img: "/images/05-plan-for-board.jpg",          text: "We need a clear pest plan we can actually present to the board." },
  { img: "/images/06-contractor-to-trust.jpg",     text: "We are not sure which contractor to trust for a shared property this size." },
];

const ROOT_CAUSES = [
  {
    num: "01",
    label: "Food Sources",
    title: "Dumpster areas and shared dining zones attract pests fast.",
    body: "High-traffic waste areas, outdoor dining, and vending zones give pests a reliable food source just steps from your building's entry points.",
  },
  {
    num: "02",
    label: "Moisture",
    title: "Irrigation and drainage create pest-friendly conditions.",
    body: "Community irrigation systems, drainage areas, and wet landscaping provide the moisture pests need to survive, nest, and multiply near shared structures.",
  },
  {
    num: "03",
    label: "Landscaping",
    title: "Dense plantings near buildings give pests shelter.",
    body: "Overgrown mulch beds, thick shrubbery, and dense plantings close to the foundation provide ideal hiding and nesting spots that go undetected for months.",
  },
  {
    num: "04",
    label: "Shared Structures",
    title: "Connected units allow pests to move undetected.",
    body: "Shared walls, utility corridors, and common mechanical spaces give pests pathways to spread from one unit or area to the next without any visible sign.",
  },
  {
    num: "05",
    label: "Seasonal Changes",
    title: "Seasonal shifts push pests toward warmth indoors.",
    body: "As temperatures drop, pests actively seek warmth and moisture inside buildings. Community properties with multiple entry points are especially vulnerable during seasonal transitions.",
  },
];

const METHOD_STEPS = [
  {
    method: "UNDERSTAND",
    num: "01",
    title: "We map the full scope of the problem.",
    body: "Before any treatment, we inspect common areas, entry points, landscaping, waste zones, and shared structures to understand exactly where pressure is coming from.",
  },
  {
    method: "SOLVE",
    num: "02",
    title: "Targeted treatment where it matters most.",
    body: "We treat active problem areas across the property using methods designed for shared spaces, minimizing disruption to residents while addressing the source.",
  },
  {
    method: "PROTECT",
    num: "03",
    title: "Ongoing protection between visits.",
    body: "We identify conditions that invite pests back and provide clear prevention recommendations to help communities stay protected year-round.",
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
  { title: "Seal Building Entry Points",     body: "Work with your maintenance team to close gaps around doors, windows, utility lines, and foundation areas throughout all shared structures." },
  { title: "Manage Waste Areas Properly",    body: "Ensure dumpster enclosures are sealed, lids close fully, and the surrounding area is kept clean to reduce the food access that attracts pests." },
  { title: "Reduce Moisture Near Buildings", body: "Maintain proper drainage away from foundations, check irrigation systems for leaks, and address any pooling or moisture accumulation near common areas." },
  { title: "Maintain Landscaping Buffers",   body: "Keep mulch beds, shrubs, and dense plantings a safe distance from building exteriors to reduce nesting and harborage zones for pests." },
  { title: "Schedule Preventative Service",  body: "Reactive treatment addresses problems after they appear. Ongoing preventative service keeps pest pressure consistently low across the entire community." },
];

const COMMUNITY_SERVICES = [
  { label: "Communities Overview",         to: "/communities",                     desc: "Full community pest protection programs for HOAs, condos, and more." },
  { label: "Property Management Programs", to: "/communities/property-management", desc: "Reliable pest coverage built for multi-unit residential properties." },
  { label: "HOA Resources",                to: "/communities/hoa-resources",       desc: "Tools and information to help boards make informed pest decisions." },
  { label: "Residential Services",         to: "/residential",                     desc: "Protecting the homes inside the communities we serve." },
];

const FAQS = [
  {
    q: "Are pest treatments in common areas safe for residents and pets?",
    a: "Yes. Every treatment is applied with residents, children, and pets in mind. Our technicians will communicate clearly with property management about any preparation needed before or after each visit.",
  },
  {
    q: "How often should community common areas be treated?",
    a: "Most communities benefit from a recurring program that maintains consistent pressure throughout the year. Treatment frequency depends on property size, pest history, and seasonal conditions. We will recommend the right schedule for your community.",
  },
  {
    q: "Can BuzzKill handle large properties with multiple buildings?",
    a: "Yes. We work with communities of all sizes across Massachusetts and Rhode Island. Our approach is designed to scale to your property, covering all common areas, entry points, and shared structures.",
  },
  {
    q: "Do you work directly with HOA boards and property managers?",
    a: "Absolutely. We work with property managers, HOA boards, and community coordinators to build plans that fit your reporting requirements, board approval processes, and resident communication preferences.",
  },
  {
    q: "What happens if residents report pest activity between scheduled visits?",
    a: "If covered pests return during your service period, we return at no additional cost. Your community should never feel like it is on its own between visits.",
  },
  {
    q: "Do you offer service contracts or annual programs for communities?",
    a: "Yes. We offer ongoing service programs designed for community properties. Annual programs provide consistent protection, simplified billing, and priority scheduling throughout the year.",
  },
];

export default function CommonAreaProtection() {
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
        title="Common Area Pest Protection — MA & RI Communities"
        description="Professional pest control for community common areas across Massachusetts and Rhode Island. HOA boards, property managers, and condo associations trust BuzzKill."
        jsonLd={[
          buildServiceSchema(
            "Common Area Pest Protection",
            "Pest control services for community common areas, HOA properties, and shared spaces across Massachusetts and Rhode Island.",
            "/communities/common-areas",
          ),
          buildBreadcrumbSchema([
            { name: "Home",        url: "/" },
            { name: "Communities", url: "/communities" },
            { name: "Common Area Protection", url: "/communities/common-areas" },
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
        image="/images/common-area-hero.png"
        eyebrow="COMMON AREA PEST PROTECTION"
        headline="Protect the Spaces That Shape Every Resident's Experience"
        sub="Safe for Families. Tough on Pests."
        primaryCta={{ label: "Request Community Proposal", href: "/request-quote" }}
        secondaryCta={{ label: "Talk to Our Team", href: "tel:+15082589294" }}
        className="bk-hero--community"
      />

      {/* 2 — Sound Familiar? */}
      <section id="familiar" className="bk-section bk-section-cream">
        <div className="bk-container">
          <p className="bk-eyebrow bk-center">Sound Familiar?</p>
          <h2 className="bk-h2 bk-center">Does This Sound Familiar?</h2>
          <p className="bk-body-lead bk-center">These are the most common things property managers and board members tell us before they call.</p>

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
            <Link to="/request-quote" className="bk-btn bk-btn-primary">See How We Help Communities</Link>
          </div>
        </div>
      </section>

      {/* 3 — The Real Issue */}
      <section id="issue" className="bk-section bk-section-dark">
        <div className="bk-container bk-narrow">
          <p className="bk-eyebrow" style={{ color: "var(--bk-green)" }}>The Real Issue</p>
          <h2 className="bk-h2 bk-on-dark">Common Areas Are the First Point of Entry</h2>
          <p className="bk-issue-intro">Most community pest problems start in shared spaces before they ever reach a resident's unit. Lobbies, hallways, courtyards, and waste areas are the first places pests settle in and the last places they are noticed.</p>

          <div className="bk-com-issue-split">
            <div className="bk-com-issue-block">
              <div className="bk-com-issue-num">01</div>
              <h3 className="bk-com-issue-title">Shared Spaces Matter</h3>
              <p className="bk-com-issue-body">Common areas are high-traffic zones used by every resident every day. A pest problem in a shared hallway, lobby, or amenity space is a problem that affects the entire community, not just one unit. The standard for shared spaces must be higher.</p>
            </div>
            <div className="bk-com-issue-block">
              <div className="bk-com-issue-num">02</div>
              <h3 className="bk-com-issue-title">Prevention Makes the Difference</h3>
              <p className="bk-com-issue-body">Reactive treatment handles infestations after they are already visible. Prevention addresses the conditions that invite pests in the first place: the entry points, the food sources, the moisture, and the landscaping that make your property an easy target.</p>
            </div>
          </div>

          <div className="bk-center" style={{ marginTop: 40 }}>
            <Link to="/request-quote" className="bk-btn bk-btn-primary">Request Community Proposal</Link>
          </div>
        </div>
      </section>

      {/* 4 — Root Causes */}
      <section id="root-causes" className="bk-section bk-section-cream">
        <div className="bk-container">
          <div className="bk-attract-layout">

            <div className="bk-attract-main">
              <p className="bk-eyebrow">Why Pests Target Common Areas</p>
              <h2 className="bk-h2">What Makes Communities Vulnerable</h2>
              <p className="bk-attract-intro">
                Effective community pest control starts with understanding why pests choose your property. Shared spaces, high foot traffic, and common infrastructure create conditions that attract pests year-round if left unmanaged.
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
          <h2 className="bk-h2 bk-center">How BuzzKill Protects Your Community</h2>

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
            <Link to="/request-quote" className="bk-btn bk-btn-primary">See How We Protect Communities</Link>
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

      {/* 8 — Prevention */}
      <section id="prevention" className="bk-section bk-section-cream">
        <div className="bk-container bk-narrow">
          <p className="bk-eyebrow">Prevention</p>
          <h2 className="bk-h2">Keep Pests From Coming Back</h2>
          <p className="bk-body-lead">Professional treatment protects your community between visits. These habits help reduce pest activity and keep shared spaces cleaner year-round.</p>
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
          <p className="bk-body-lead bk-on-dark bk-center">Common area protection is one part of a complete community pest program. See what else BuzzKill offers for shared properties across Massachusetts and Rhode Island.</p>
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
              <p className="bk-schedule-eyebrow">Ready to Protect Your Community?</p>
              <h2 className="bk-schedule-title">Help Protect the Spaces Everyone Shares</h2>
              <p className="bk-schedule-sub">Safe for residents. Tough on pests. Let BuzzKill build a protection plan your entire community can count on.</p>
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap", justifyContent: "center" }}>
                <Link to="/request-quote" className="bk-btn bk-schedule-cta">
                  Request Community Proposal
                </Link>
                <a href="tel:+15082589294" className="bk-btn bk-schedule-cta bk-schedule-cta--outline">
                  Talk to Our Team
                </a>
              </div>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
