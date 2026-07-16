import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import FAQ from "../../components/FAQ";
import Hero from "../../components/Hero";
import SEO from "../../components/SEO";
import QuoteCard from "../../components/QuoteCard";

const FAMILIAR_ITEMS = [
  { emoji: "📋", icon: "/images/icon-termite-know-whats-going-on.png", text: "I just got the inspection report and it confirmed termites. I do not know what the next steps are." },
  { emoji: "😰", icon: "/images/icon-termite-foundation.png",           text: "I found active mud tubes. I need treatment to start as soon as possible." },
  { emoji: "💰", icon: "/images/icon-termite-expensive-repairs.png",   text: "I am trying to understand the difference between treatment options before I commit." },
  { emoji: "🏠", icon: "/images/icon-termite-peace-of-mind.png",       text: "I am selling the house and need to get a treatment certificate before closing." },
  { emoji: "🐜", icon: "/images/icon-termite-catch-early.png",          text: "I had treatment done years ago but found activity again. I need to know if re-treatment is needed." },
  { emoji: "🤷", icon: "/images/icon-termite-wood-damage.png",          text: "I do not know how long the treatment will last or what kind of ongoing protection I need." },
];

const HAPPENING_CARDS = [
  {
    tag: "The Colony Problem",
    title: "Surface treatment does not reach the colony",
    body: "Subterranean termite colonies live underground and inside structural wood. Effective treatment must disrupt the colony at the source, not just eliminate the workers you can see.",
  },
  {
    tag: "The Spread Problem",
    title: "Untreated colonies continue to expand",
    body: "An active termite colony does not stop. Every day without treatment is additional feeding time. Addressing confirmed activity quickly limits the extent of structural damage.",
  },
  {
    tag: "The Recurrence Problem",
    title: "Treatment without monitoring leaves gaps",
    body: "Termites can reestablish from adjacent colonies or from areas not reached in the initial treatment. Ongoing monitoring after treatment is the only way to confirm lasting protection.",
  },
];

const ATTRACT_REASONS = [
  {
    num: "01",
    label: "Active Colony",
    title: "Confirmed activity requires immediate action",
    body: "Once an active colony is confirmed through inspection, treatment should begin promptly. Termites do not pause while decisions are made. Every week of delay corresponds to additional feeding.",
  },
  {
    num: "02",
    label: "Treatment Method",
    title: "The right method depends on species and structure",
    body: "Subterranean termites, drywood termites, and dampwood termites each require different treatment approaches. The species, colony size, and affected areas all inform the treatment plan.",
  },
  {
    num: "03",
    label: "Structural Access",
    title: "Treatment must reach where termites live",
    body: "Effective treatment requires access to the areas where the colony is active. This may include soil treatment around the foundation, targeted wood treatments, or bait systems depending on the situation.",
  },
  {
    num: "04",
    label: "Monitoring",
    title: "Post-treatment monitoring confirms success",
    body: "Termite populations can recover if treatment does not reach the full colony. Monitoring stations placed around the property after treatment track activity and flag any recurrence early.",
  },
  {
    num: "05",
    label: "Documentation",
    title: "Treatment records protect your investment",
    body: "A documented treatment record is valuable for real estate transactions and future inspections. We provide a certificate of treatment that verifies the work completed and the protection in place.",
  },
];

const PROTECT_STEPS = [
  {
    method: "UNDERSTAND",
    num: "01",
    title: "We find the root cause first",
    body: "Before any product is applied, we inspect your property. Entry points, nesting conditions, attractants. We build a clear picture of what is driving the problem before we treat it.",
  },
  {
    method: "SOLVE",
    num: "02",
    title: "Targeted treatment at the source",
    body: "We apply pet-safe treatments where pests live and travel, not just where they are visible. That means reaching the source rather than cleaning up what you see on the surface.",
  },
  {
    method: "PROTECT",
    num: "03",
    title: "Barriers that hold between visits",
    body: "After treatment, we address the conditions that invited them in. Entry points sealed, problem areas noted, and a plan in place so they cannot simply return the same way.",
  },
];

const BOOK_STEPS = [
  {
    num: "01",
    title: "Get your instant quote online",
    body: "Answer a few quick questions about your property. No phone call required. Pricing is ready in minutes.",
  },
  {
    num: "02",
    title: "Pick a time that works for you",
    body: "Schedule at your convenience. Evenings and weekends are available.",
  },
  {
    num: "03",
    title: "We arrive prepared",
    body: "Licensed technician, right products, clear plan. No guesswork on our end, no surprises on yours.",
  },
  {
    num: "04",
    title: "You enjoy your home again",
    body: "That is the whole point.",
  },
];

const WHY_ITEMS = [
  {
    icon: "ðŸ›¡",
    title: "Safe for Families. Tough on Pests.",
    body: "Every treatment is designed around the people and pets in your home, not a one-size-fits-all schedule.",
  },
  {
    icon: "ðŸ“",
    title: "Local and Licensed in MA and RI",
    body: "We know your region, your seasonal pest pressures, and the conditions that drive activity here.",
  },
  {
    icon: "âœ…",
    title: "30-Day Re-Treatment Guarantee",
    body: "If pests return within 30 days of your treatment, so do we, at no additional charge.",
  },
  {
    icon: "ðŸ’¬",
    title: "Clear Communication, Every Visit",
    body: "Your technician explains what they found, what they treated, and what to watch for. No mystery service.",
  },
];

const TIPS = [
  "Begin treatment as soon as activity is confirmed. Delay increases structural damage and colony size.",
  "Follow pre-treatment preparation instructions provided by your technician to ensure maximum product effectiveness.",
  "Keep monitoring stations accessible after treatment so post-treatment inspection can confirm colony elimination.",
  "Address conducive conditions identified during the inspection to reduce the risk of re-infestation.",
  "Schedule a follow-up inspection 12 months after treatment to verify that the colony has been fully eliminated.",
];

const RELATED_SERVICES = [
  { label: "Termite Inspection", to: "/services/termite", desc: "Confirm activity before treatment begins with a thorough inspection." },
  { label: "Wood Boring Insects", to: "/services/termite/wood-boring", desc: "Wood-destroying insects are often found alongside termite activity." },
  { label: "Rodent Control", to: "/services/rodent-control", desc: "Rodents can be found in the same moisture-damaged areas as termites." },
  { label: "Wildlife Removal", to: "/services/wildlife", desc: "Wildlife damage can expose wood to termite access." },
];

const FAQS = [
  {
    q: "What is the most effective termite treatment method?",
    a: "Liquid soil treatments and bait systems are both highly effective for subterranean termites. The best choice depends on the colony location, soil conditions, and the structure of the home. We recommend a method after inspecting the specific situation.",
  },
  {
    q: "How long does termite treatment last?",
    a: "Liquid soil treatments typically provide protection for five or more years when applied correctly. Bait systems require ongoing monitoring to remain effective. We will outline the expected protection timeline for whatever method is used.",
  },
  {
    q: "Will treatment cause damage to my home or landscaping?",
    a: "Modern treatment methods are designed to minimize disruption. Soil treatment does not require extensive excavation. We will walk you through exactly what to expect before work begins.",
  },
  {
    q: "Do I need to leave my home during treatment?",
    a: "Most termite treatments do not require vacating the home. Your technician will advise based on the specific products and application areas involved.",
  },
  {
    q: "How will I know the treatment worked?",
    a: "Follow-up monitoring and a scheduled re-inspection confirm colony elimination. Mud tube activity and wood damage progression stop when treatment is effective. We document findings at every follow-up visit.",
  },
];

export default function TermiteTreatment() {
  const [showBackToTop, setShowBackToTop] = useState<boolean>(false);
  const [activeAccordion, setActiveAccordion] = useState<number | null>(null);
  const [activeHappening, setActiveHappening] = useState<number>(0);
  const carouselRef = useRef<HTMLDivElement>(null);

  function scrollCarousel(direction: "left" | "right") {
    if (!carouselRef.current) return;
    const scrollAmount = 280;
    carouselRef.current.scrollBy({
      left: direction === "left" ? -scrollAmount : scrollAmount,
      behavior: "smooth",
    });
  }

  useEffect(() => {
    function handleScroll() {
      const scrollTop = window.scrollY;
      setShowBackToTop(scrollTop > 400);
    }

    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  return (
    <>
      <SEO
        title="Termite Treatment Plans â€” MA & RI"
        description="Professional termite treatment and colony elimination for Massachusetts and Rhode Island homes. Licensed, targeted, lasting structural protection."
      />

      {/* Back to Top */}
      {showBackToTop && (
        <button
          className="bk-back-to-top"
          onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
          aria-label="Back to top"
        >
          â†‘
        </button>
      )}

      {/* Hero */}
      <Hero
        image="/images/termite-hero.png"
        eyebrow="Termite Treatment"
        headline="Termite Treatment & Colony Elimination"
        sub="Targeted termite treatment plans for Massachusetts and Rhode Island homeowners. Eliminate the colony and protect the structure."
        className="bk-hero--community"
      />

      {/* Sound Familiar â€” Carousel */}
      <section id="familiar" className="bk-familiar-section">
        <div className="bk-familiar-inner">
          <h2 className="bk-section-title">Sound Familiar?</h2>
          <p className="bk-section-intro">
            If any of these match what you are dealing with, you are in the right place.
          </p>
          <div className="bk-carousel-wrapper">
            <button
              className="bk-carousel-arrow bk-carousel-arrow--left"
              onClick={() => scrollCarousel("left")}
              aria-label="Scroll left"
            >
              â€¹
            </button>
            <div className="bk-familiar-carousel" ref={carouselRef}>
              {FAMILIAR_ITEMS.map((item, i) => (
                <div key={i} className="bk-familiar-card">
                  {item.icon ? <img src={item.icon} alt="" className="bk-familiar-icon" /> : <span className="bk-familiar-emoji" aria-hidden="true">{item.emoji}</span>}
                  <p className="bk-familiar-text">{item.text}</p>
                </div>
              ))}
            </div>
            <button
              className="bk-carousel-arrow bk-carousel-arrow--right"
              onClick={() => scrollCarousel("right")}
              aria-label="Scroll right"
            >
              â€º
            </button>
          </div>
        </div>
      </section>

      {/* What's Happening â€” Dark */}
      <section id="happening" className="bk-happening-section bk-section--dark">
        <div className="bk-happening-inner">
          <h2 className="bk-section-title">What Is Actually Happening</h2>
          <p className="bk-section-intro">
            Understanding the problem is the first step toward fixing it.
          </p>
          <div className="bk-happening-selector">
            <div className="bk-happening-tabs">
              {HAPPENING_CARDS.map((card, i) => (
                <button
                  key={i}
                  className={`bk-happening-tab${activeHappening === i ? " bk-happening-tab--active" : ""}`}
                  onClick={() => setActiveHappening(i)}
                >
                  {card.tag}
                </button>
              ))}
            </div>
            <div className="bk-happening-panel">
              <h3 className="bk-happening-title">{HAPPENING_CARDS[activeHappening].title}</h3>
              <p className="bk-happening-body">{HAPPENING_CARDS[activeHappening].body}</p>
            </div>
          </div>
        </div>
      </section>

      {/* Root Causes Accordion + Quote Card â€” Cream */}
      <section id="attracts" className="bk-attract-section bk-section--cream">
        <div className="bk-attract-inner">
          <div className="bk-attract-main">
            <h2 className="bk-section-title">Why Termite Treatment Requires a Targeted Plan</h2>
            <p className="bk-section-intro">
              Termite colonies are not addressed by a single application. Effective treatment requires understanding the colony, the species, and the structure.
            </p>
            <div className="bk-accordion">
              {ATTRACT_REASONS.map((item, i) => (
                <div
                  key={i}
                  className={`bk-accordion-item${activeAccordion === i ? " bk-accordion-item--open" : ""}`}
                >
                  <button
                    className="bk-accordion-trigger"
                    onClick={() => setActiveAccordion(activeAccordion === i ? null : i)}
                    aria-expanded={activeAccordion === i}
                  >
                    <span className="bk-accordion-num">{item.num}</span>
                    <span className="bk-accordion-label">{item.label}</span>
                    <span className="bk-accordion-title">{item.title}</span>
                    <span className="bk-accordion-chevron" aria-hidden="true">
                      {activeAccordion === i ? "âˆ’" : "+"}
                    </span>
                  </button>
                  {activeAccordion === i && (
                    <div className="bk-accordion-body">
                      <p>{item.body}</p>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          <aside className="bk-attract-sidebar">
            <QuoteCard />
          </aside>
        </div>
      </section>

      {/* How We Help â€” Method Track â€” Cream */}
      <section id="protects" className="bk-protects-section bk-section--cream">
        <div className="bk-protects-inner">
          <h2 className="bk-section-title">How We Treat Termite Problems</h2>
          <p className="bk-section-intro">
            Every treatment follows the same three-step approach, adapted to your specific situation.
          </p>
          <div className="bk-method-track">
            {PROTECT_STEPS.map((step, i) => (
              <div key={i} className="bk-method-step">
                <div className="bk-method-badge">{step.method}</div>
                <div className="bk-method-num">{step.num}</div>
                <h3 className="bk-method-title">{step.title}</h3>
                <p className="bk-method-body">{step.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Book Track â€” Dark */}
      <section id="book" className="bk-book-section bk-section--dark">
        <div className="bk-book-inner">
          <h2 className="bk-section-title">How Booking Works</h2>
          <p className="bk-section-intro">
            Four steps from your first question to a treated home.
          </p>
          <div className="bk-book-track">
            {BOOK_STEPS.map((step, i) => (
              <div key={i} className="bk-book-step">
                <div className="bk-book-num">{step.num}</div>
                <h3 className="bk-book-title">{step.title}</h3>
                <p className="bk-book-body">{step.body}</p>
              </div>
            ))}
          </div>
          <div className="bk-book-cta">
            <Link to="/request-quote" className="bk-btn bk-btn-primary">
              Get Your Instant Quote
            </Link>
            <a href="tel:+15082589294" className="bk-btn bk-btn-secondary">
              Call (508) 258-9294
            </a>
          </div>
        </div>
      </section>

      {/* Why BuzzKill â€” Cream */}
      <section id="why-us" className="bk-why-section bk-section--cream">
        <div className="bk-why-inner">
          <h2 className="bk-section-title">Why BuzzKill Pest Control</h2>
          <p className="bk-section-intro">
            Local, licensed, and built around the families we serve in Massachusetts and Rhode Island.
          </p>
          <div className="bk-why-grid">
            {WHY_ITEMS.map((item, i) => (
              <div key={i} className="bk-why-card">
                <span className="bk-why-icon" aria-hidden="true">{item.icon}</span>
                <h3 className="bk-why-title">{item.title}</h3>
                <p className="bk-why-body">{item.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Prevention Tips â€” Cream */}
      <section id="prevention" className="bk-prevention-section bk-section--cream">
        <div className="bk-prevention-inner">
          <h2 className="bk-section-title">Termite Prevention Tips</h2>
          <p className="bk-section-intro">
            Steps you can take to reduce risk and support lasting protection after treatment.
          </p>
          <ul className="bk-tips-list">
            {TIPS.map((tip, i) => (
              <li key={i} className="bk-tip-item">
                <span className="bk-tip-num" aria-hidden="true">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className="bk-tip-text">{tip}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* Related Services â€” Cream */}
      <section id="related" className="bk-related-section bk-section--cream">
        <div className="bk-related-inner">
          <h2 className="bk-section-title">More Services</h2>
          <p className="bk-section-intro">
            Termite treatment is most effective as part of a complete inspection and monitoring program.
          </p>
          <div className="bk-related-grid">
            {RELATED_SERVICES.map((svc, i) => (
              <Link key={i} to={svc.to} className="bk-related-card">
                <span className="bk-related-label">{svc.label}</span>
                <span className="bk-related-desc">{svc.desc}</span>
                <span className="bk-related-arrow" aria-hidden="true">â†’</span>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section id="faq" className="bk-faq-section">
        <div className="bk-faq-inner">
          <h2 className="bk-section-title">Frequently Asked Questions</h2>
          <FAQ items={FAQS} />
        </div>
      </section>

      {/* Schedule CTA */}
      <section className="bk-schedule-section">
        <div className="bk-schedule-inner">
          <div className="bk-schedule-card">
            <div className="bk-schedule-brand">
              <div className="bk-schedule-logo-badge">
                <Link to="/">
                  <img src="/images/logo.png" alt="BuzzKill Pest Control" />
                </Link>
              </div>
              <p className="bk-schedule-tagline">Licensed &amp; Insured</p>
            </div>
            <div className="bk-schedule-content">
              <p className="bk-schedule-eyebrow">Ready to Get Started?</p>
              <h2 className="bk-schedule-title">Get Started Today</h2>
              <p className="bk-schedule-sub">
                Appointments that work around your schedule, not ours. Available across Massachusetts &amp; Rhode Island.
              </p>
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

