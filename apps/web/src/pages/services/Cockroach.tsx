import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import FAQ from "../../components/FAQ";
import Hero from "../../components/Hero";
import SEO, { buildBreadcrumbSchema, buildServiceSchema } from "../../components/SEO";
import QuoteCard from "../../components/QuoteCard";

const FAMILIAR_ITEMS = [
  { emoji: "🪳", icon: "/images/cock-sf-1.png", text: "I only saw one... but I know that probably isn't true." },
  { emoji: "🪳", icon: "/images/cock-sf-2.png", text: "They disappear before I can figure out where they're hiding." },
  { emoji: "🪳", icon: "/images/cock-sf-3.png", text: "Turning on the kitchen light has become a surprise I don't enjoy." },
  { emoji: "🪳", icon: "/images/cock-sf-4.png", text: "I've tried sprays, but they always seem to come back." },
  { emoji: "🪳", icon: "/images/cock-sf-5.png", text: "I'm worried they'll spread to other rooms." },
  { emoji: "🪳", icon: "/images/cock-sf-6.png", text: "I just want to stop thinking about cockroaches altogether." },
];

const HAPPENING_CARDS = [
  {
    tag: "The Hidden Colony",
    title: "The Cockroach You Saw Is Rarely Alone",
    body: "Cockroaches stay hidden close to food, moisture, and warmth. Seeing one during the day often means the hiding places are already crowded.",
    cta: "Know the Price. Book in Minutes.",
  },
  {
    tag: "The Survival Problem",
    title: "Store Sprays Rarely Reach the Source",
    body: "Most products only kill the cockroaches you see. Eggs and hidden nesting areas remain untouched, allowing the infestation to continue.",
    cta: "Ready to Get BuzzKilled?",
  },
  {
    tag: "The Prevention Problem",
    title: "Without Finding the Cause They Return",
    body: "Long term cockroach control comes from identifying moisture, food sources, and entry points, not repeated spraying.",
    cta: "Let's Get Your Property BuzzKilled",
  },
];

const ATTRACT_REASONS = [
  { num: "01", label: "Food Sources",      title: "Even Small Crumbs Keep Them Coming Back",  body: "Cockroaches only need tiny amounts of food left behind on counters, appliances, or floors to survive and reproduce." },
  { num: "02", label: "Moisture",          title: "Water Is Just As Important As Food",         body: "Leaky pipes, damp cabinets, and humid basements provide the moisture cockroaches need to thrive." },
  { num: "03", label: "Hidden Shelter",    title: "They Prefer Places You Rarely See",          body: "Behind appliances, inside walls, and beneath cabinets offer dark, protected hiding spots." },
  { num: "04", label: "Easy Entry",        title: "Small Gaps Become Big Opportunities",        body: "Cracks around doors, utility lines, and foundations allow cockroaches to move indoors." },
  { num: "05", label: "Nearby Activity",   title: "The Source May Be Close By",                 body: "Shared walls, neighboring properties, or outdoor populations can continually introduce new cockroaches." },
];

const PROTECT_STEPS = [
  {
    method: "UNDERSTAND",
    num: "01",
    title: "Hidden activity tells the story.",
    body: "We inspect the places cockroaches hide to understand what's supporting the infestation.",
  },
  {
    method: "SOLVE",
    num: "02",
    title: "We treat where it matters.",
    body: "Treatments focus on nesting areas, travel paths, and the source of the activity.",
  },
  {
    method: "PROTECT",
    num: "03",
    title: "Helping keep them from coming back.",
    body: "We reduce the conditions that allow cockroaches to return and help protect your home moving forward.",
  },
];

const BOOK_STEPS = [
  { num: "01", title: "Know the Price.", body: "Get your instant quote online in minutes. No callbacks. No waiting." },
  { num: "02", title: "Pick Your Time.", body: "Choose the day that works best for you. We'll take care of the rest." },
  { num: "03", title: "We'll Do the BuzzKilling.", body: "Your local BuzzKill technician arrives ready to Understand. Solve. Protect." },
  { num: "04", title: "Get Back to Living.", body: "Enjoy a home that's protected so pests stay out of your daily routine." },
];

const WHY_ITEMS = [
  { icon: "/images/why-protection.png",    title: "Protection With Purpose",       body: "Every treatment is tailored to your property and the pests you're facing." },
  { icon: "/images/why-local-experts.png", title: "Local Experts. Local Pests.",   body: "Licensed in Massachusetts and Rhode Island with solutions built for local pest activity." },
  { icon: "/images/why-guarantee.png",     title: "We Stand Behind Our Work",      body: "If covered pests return during your service guarantee, so do we." },
  { icon: "/images/why-communication.png", title: "Clear Communication. Every Visit.", body: "You'll always know what we found, what we treated, and what comes next." },
];

const TIPS = [
  { title: "Keep Kitchens Clean",          body: "Clean crumbs, spills, and grease from counters, appliances, and floors." },
  { title: "Store Food Properly",          body: "Keep pantry items and pet food in sealed containers." },
  { title: "Fix Moisture Problems",        body: "Repair leaking pipes and remove standing water under sinks and appliances." },
  { title: "Reduce Clutter",               body: "Limit cardboard, paper, and storage piles where cockroaches can hide." },
  { title: "Schedule Preventative Service", body: "Routine treatments help keep cockroach populations under control year round." },
];

const RELATED_SERVICES = [
  { label: "Rodent Control", to: "/services/rodent-control", desc: "They don't wait. Neither should you." },
  { label: "Cockroach Control", to: "/services/cockroach", desc: "If you see one, there's usually more nearby." },
  { label: "Mosquito & Tick Control", to: "/services/mosquito-tick", desc: "Take your yard back this season." },
  { label: "Wasp & Hornet Control", to: "/services/wasp-hornet-bee", desc: "Enjoy your backyard, not their nest." },
];

const FAQS = [
  {
    q: "How do I know if I have cockroaches?",
    a: "Cockroaches are often active at night. Droppings, egg cases, and unpleasant odors are common signs.",
  },
  {
    q: "Why do cockroaches keep coming back?",
    a: "They hide in areas that are difficult to reach. Treating only the visible insects rarely solves the problem.",
  },
  {
    q: "Is cockroach treatment safe around my family?",
    a: "Yes. We use treatments designed with your family and pets in mind when applied as directed.",
  },
  {
    q: "How long does cockroach treatment take?",
    a: "Most services take about an hour depending on the size of your property.",
  },
  {
    q: "Will I need more than one treatment?",
    a: "Some infestations require follow up visits to fully eliminate the population.",
  },
  {
    q: "Can I book online?",
    a: "Yes. You can receive an Instant Quote and schedule your service online.",
  },
];

export default function Cockroach() {
  const [showBackToTop, setShowBackToTop]     = useState(false);
  const [activeAccordion, setActiveAccordion] = useState<string | null>("01");
  const [activeHappening, setActiveHappening] = useState(0);
  const carouselRef = useRef<HTMLDivElement>(null);

  const scrollCarousel = (dir: "prev" | "next") => {
    const el = carouselRef.current;
    if (!el) return;
    const card = el.querySelector(".bk-familiar-bubble") as HTMLElement | null;
    const cardW = card ? card.offsetWidth + 20 : 300;
    el.scrollBy({ left: dir === "next" ? cardW : -cardW, behavior: "smooth" });
  };

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
        title="Ant Control & Removal Services — MA & RI"
        description="Professional ant and spider control for homes across Massachusetts and Rhode Island. Pet-safe, licensed technicians, lasting results. Get an instant quote."
        jsonLd={[
          buildServiceSchema(
            "Ant Control & Removal Services",
            "Professional ant and spider pest control for Massachusetts and Rhode Island homes. Pet-safe treatments, licensed technicians.",
            "/services/general-pest",
          ),
          buildBreadcrumbSchema([
            { name: "Home", url: "/" },
            { name: "Services", url: "/services/general-pest" },
            { name: "Ant Control", url: "/services/general-pest" },
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

      {/* 1. Hero */}
      <Hero
        image="/images/cockroach-hero.png"
        eyebrow="Cockroach Control Services"
        headline="Found a Cockroach? There Are Usually More Nearby."
        sub="BuzzKill helps homeowners across Massachusetts &amp; Rhode Island eliminate cockroaches at the source, not just the ones you see. We Understand. Solve. Protect. so your home stays protected long after treatment."
        primaryCta={{ label: "Get Instant Quote", href: "/quote" }}
        secondaryCta={{ label: "Talk to a Local Expert", href: "tel:+15082589294" }}
        className="bk-hero--community"
      />

      {/* 2. Does This Sound Familiar? */}
      <section id="familiar" className="bk-section bk-section-cream">
        <div className="bk-container">
          <p className="bk-eyebrow bk-center">Sound Familiar?</p>
          <h2 className="bk-h2 bk-center">Does This Sound Familiar?</h2>
          <p className="bk-body-lead bk-center">If you've been thinking any of these lately, you're not alone.</p>
          <div className="bk-carousel-wrap">
            <button
              className="bk-carousel-btn"
              onClick={() => scrollCarousel("prev")}
              aria-label="Previous"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M15 18l-6-6 6-6" />
              </svg>
            </button>

            <div className="bk-familiar-carousel" ref={carouselRef}>
              {FAMILIAR_ITEMS.map((item, i) => (
                <div key={i} className="bk-familiar-bubble">
                  <span className="bk-familiar-emoji" aria-hidden="true">
                    {item.icon ? <img src={item.icon} alt="" /> : item.emoji}
                  </span>
                  <p className="bk-familiar-bubble-text">&ldquo;{item.text}&rdquo;</p>
                </div>
              ))}
            </div>

            <button
              className="bk-carousel-btn"
              onClick={() => scrollCarousel("next")}
              aria-label="Next"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M9 18l6-6-6-6" />
              </svg>
            </button>
          </div>
          <div className="bk-center" style={{ marginTop: 40 }}>
            <Link to="/quote" className="bk-btn bk-btn-primary">Get Instant Quote</Link>
          </div>
        </div>
      </section>

      {/* 3. Here's What's Really Happening */}
      <section id="happening" className="bk-section bk-section-dark">
        <div className="bk-container bk-narrow">
          <p className="bk-eyebrow" style={{ color: "var(--bk-green)" }}>The Real Issue</p>
          <h2 className="bk-h2 bk-on-dark">Here's What's Really Happening</h2>
          <p className="bk-issue-intro">Most ant and spider problems don't start where you can see them. Understanding what's attracting pests to your home is the first step toward long-term ant control and spider control, not just temporary relief.</p>

          <div className="bk-issue-selector">
            {HAPPENING_CARDS.map((card, i) => (
              <button
                key={i}
                className={`bk-issue-btn${activeHappening === i ? " is-active" : ""}`}
                onClick={() => setActiveHappening(i)}
              >
                <span className="bk-issue-num">0{i + 1}</span>
                <span className="bk-issue-label">{card.tag}</span>
              </button>
            ))}
          </div>

          <div className="bk-issue-content" key={activeHappening}>
            <h3 className="bk-issue-title">{HAPPENING_CARDS[activeHappening].title}</h3>
            <p className="bk-issue-body">{HAPPENING_CARDS[activeHappening].body}</p>
            <Link to="/quote" className="bk-btn bk-btn-primary" style={{ marginTop: 28, display: "inline-block" }}>
              {HAPPENING_CARDS[activeHappening].cta}
            </Link>
          </div>
        </div>
      </section>

      {/* 4. Why Your Property Attracts Ants */}
      <section id="attracts" className="bk-section bk-section-cream">
        <div className="bk-container">
          <div className="bk-attract-layout">

            {/* Left: accordion */}
            <div className="bk-attract-main">
              <p className="bk-eyebrow">Root Causes</p>
              <h2 className="bk-h2">Why Cockroaches Keep Coming Back</h2>
              <p className="bk-attract-intro">
                Cockroaches don't appear by accident. They follow food, moisture, warmth, and shelter. Understanding why they're there is the first step toward lasting protection.
              </p>
              <div className="bk-accordion">
                {ATTRACT_REASONS.map((r) => {
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

            {/* Right: quote card */}
            <aside className="bk-attract-sidebar">
              <QuoteCard />
            </aside>

          </div>
        </div>
      </section>

      {/* 5. How BuzzKill Protects Your Property */}
      <section id="protects" className="bk-section bk-section-cream">
        <div className="bk-container">
          <p className="bk-eyebrow bk-center">The BuzzKill Method</p>
          <h2 className="bk-h2 bk-center">How BuzzKill Protects Your Property</h2>
          <p className="bk-body-lead bk-center">Cockroach problems don't start overnight. Understanding what's attracting them is the first step toward lasting protection.</p>
          <div className="bk-method-track">
            {PROTECT_STEPS.map((s, i) => (
              <div key={i} className="bk-method-card">
                <div className="bk-method-badge">{s.method}</div>
                <div className="bk-method-num">{s.num}</div>
                <h3 className="bk-method-title">{s.title}</h3>
                <p className="bk-method-body">{s.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 6. What Happens When You Book */}
      <section id="book" className="bk-section bk-section-dark">
        <div className="bk-container">
          <p className="bk-eyebrow bk-center" style={{ color: "var(--bk-green)" }}>The Process</p>
          <h2 className="bk-h2 bk-on-dark bk-center">What Happens When You Book</h2>
          <p className="bk-body-lead bk-on-dark bk-center">Protection Starts in Just a Few Clicks.</p>
          <div className="bk-book-track">
            {BOOK_STEPS.map((s, i) => (
              <div key={i} className="bk-book-step">
                <div className="bk-book-num">{s.num}</div>
                <div className="bk-book-content">
                  <h3 className="bk-book-title">{s.title}</h3>
                  <p className="bk-book-body">{s.body}</p>
                </div>
              </div>
            ))}
          </div>
          <div className="bk-center" style={{ marginTop: 48 }}>
            <p className="bk-book-cta-label">Ready to Get BuzzKilled?</p>
            <Link to="/quote" className="bk-btn bk-btn-primary">Get Instant Quote</Link>
          </div>
        </div>
      </section>

      {/* 7. Why Homeowners Choose BuzzKill */}
      <section id="why-us" className="bk-section bk-section-cream">
        <div className="bk-container">
          <p className="bk-eyebrow bk-center">Why BuzzKill</p>
          <h2 className="bk-h2 bk-center">Why Homeowners Trust BuzzKill</h2>
          <p className="bk-body-lead bk-center">Protection With Purpose means every visit is built around your property, your family, and lasting peace of mind.</p>
          <div className="bk-choose-grid">
            {WHY_ITEMS.map((item, i) => (
              <div key={i} className="bk-choose-card">
                <span className="bk-choose-icon" aria-hidden="true"><img src={item.icon} alt="" style={{ width: 48, height: 48, objectFit: "contain" }} /></span>
                <h3 className="bk-choose-title">{item.title}</h3>
                <p className="bk-choose-body">{item.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 8. How to Stay One Step Ahead */}
      <section id="prevention" className="bk-section bk-section-cream">
        <div className="bk-container bk-narrow">
          <p className="bk-eyebrow">Prevention</p>
          <h2 className="bk-h2">Keep Cockroaches From Coming Back</h2>
          <p className="bk-body-lead">Cockroaches look for food, moisture, and shelter. A few simple habits can help keep them from making themselves at home.</p>
          <div className="bk-tips-list">
            {TIPS.map((tip, i) => (
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

      {/* 9. Related Pest Services */}
      <section id="related" className="bk-section bk-section-cream">
        <div className="bk-container">
          <p className="bk-eyebrow bk-center">More Protection</p>
          <h2 className="bk-h2 bk-center">Your Pest Problem Might Not Stop With Ants</h2>
          <p className="bk-body-lead bk-center">Ants and spiders are often just the beginning. Explore the other pest control services BuzzKill provides across Massachusetts &amp; Rhode Island.</p>
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

      {/* 10. FAQ */}
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
              <h2 className="bk-schedule-title">Let's Get Your Property BuzzKilled</h2>
              <p className="bk-schedule-sub">Safe for families. Tough on pests. Get your Instant Quote today and protect your property with BuzzKill.</p>
              <Link to="/quote" className="bk-btn bk-schedule-cta">
                Get My Instant Quote
              </Link>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
