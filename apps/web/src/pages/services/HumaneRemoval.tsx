import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import FAQ from "../../components/FAQ";
import Hero from "../../components/Hero";
import SEO from "../../components/SEO";
import QuoteCard from "../../components/QuoteCard";

const FAMILIAR_ITEMS = [
  { emoji: "ðŸ¿", text: "I have a squirrel in the attic. I want it removed without hurting it." },
  { emoji: "ðŸ¦", text: "A raccoon has been getting into the trash for weeks. I need it gone but I don't want to harm it." },
  { emoji: "ðŸ¦‡", text: "I found bats in the attic and I know they're protected. I need a professional who knows the regulations." },
  { emoji: "ðŸ¤·", text: "I bought a live trap but I don't know what I'm supposed to do after I catch it." },
  { emoji: "ðŸ˜Ÿ", text: "The animal has what I think might be babies. I don't want to separate them or cause harm." },
  { emoji: "ðŸ ", text: "I need this handled quickly but also correctly. I don't want them back next week." },
];

const HAPPENING_CARDS = [
  {
    tag: "The Legal Problem",
    title: "Some wildlife species are protected by law",
    body: "Bats in particular are protected species in Massachusetts and Rhode Island. Removal must follow specific seasonal restrictions and licensing requirements. Unlicensed removal can result in fines.",
  },
  {
    tag: "The Return Problem",
    title: "Trapping without exclusion creates a vacancy",
    body: "Removing one animal without sealing the entry point leaves the access available to the next animal. True resolution requires both removal and exclusion work.",
  },
  {
    tag: "The Safety Problem",
    title: "Wildlife removal carries real health risks",
    body: "Raccoons, bats, and other wildlife can carry rabies and other pathogens. Handling should only be done by trained technicians with appropriate protective equipment.",
  },
];

const ATTRACT_REASONS = [
  {
    num: "01",
    label: "Structural Access",
    title: "An opening in the home is an invitation",
    body: "Wildlife does not distinguish between outdoor and indoor space the same way humans do. An accessible attic, crawl space, or wall void is simply a suitable shelter. Access is the primary factor.",
  },
  {
    num: "02",
    label: "Nesting Season",
    title: "Spring and fall are peak entry periods",
    body: "Animals searching for denning sites in spring and fall are especially motivated to enter structures. A gap that was ignored all summer may become an active entry point when nesting pressure peaks.",
  },
  {
    num: "03",
    label: "Young Animals",
    title: "Mothers with young are the most persistent",
    body: "A mother animal that has established a nest with young inside will return repeatedly even after being removed. Young animals must be located and addressed as part of any removal program.",
  },
  {
    num: "04",
    label: "Repeat Attractants",
    title: "Food sources bring wildlife back",
    body: "If the food source that initially attracted the animal is not addressed, a new animal will be attracted to the same property shortly after the first is removed.",
  },
  {
    num: "05",
    label: "Territorial Behavior",
    title: "Scent marking draws other animals to the same location",
    body: "Animals mark territory. After removal, scent left behind can attract other animals of the same species. Exclusion and odor remediation reduce this secondary attraction.",
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
  "Do not attempt to handle wildlife yourself, especially bats or raccoons, without professional guidance.",
  "If young animals are suspected, wait for professional assessment before any removal attempt.",
  "Secure all food sources before and after removal to remove the attractant that brought the animal to the property.",
  "Allow your technician to complete the full exclusion program before considering the job complete.",
  "Follow up with attic restoration after removal to address contamination and remove scent that could attract new animals.",
];

const RELATED_SERVICES = [
  {
    label: "Wildlife Removal Overview",
    to: "/services/wildlife",
    desc: "Complete wildlife management for squirrels, raccoons, bats, and more.",
  },
  {
    label: "Wildlife Attic Restoration",
    to: "/services/rodent-control/attic-restoration",
    desc: "After humane removal, we restore the attic to a clean and safe condition.",
  },
  {
    label: "Rodent Control",
    to: "/services/rodent-control",
    desc: "Wildlife and rodents often share entry points and structural areas.",
  },
  {
    label: "Entry Point Sealing",
    to: "/services/rodent-control/entry-sealing",
    desc: "Exclusion sealing is the step that prevents recurrence after removal.",
  },
];

const FAQS = [
  {
    q: "Are bats really protected in Massachusetts?",
    a: "Yes. Little brown bats and several other bat species are protected under state and federal regulations. Removal must be done outside specific seasonal windows and by licensed professionals. We are fully licensed for bat exclusion in MA and RI.",
  },
  {
    q: "What happens to the animal after it is removed?",
    a: "Most wildlife is relocated to appropriate habitat away from the property. Relocation follows state guidelines for the specific species involved.",
  },
  {
    q: "What if there are young animals in the attic?",
    a: "We assess for young animals before beginning removal. If young are present, we modify the approach to ensure they are not separated from the mother or left behind.",
  },
  {
    q: "How do you find where the animal is getting in?",
    a: "Our technicians conduct a systematic exterior inspection looking for gaps at the roofline, soffit, foundation, and utility areas. Evidence of wildlife travel, fur, scratch marks, and droppings, helps identify active entry points.",
  },
  {
    q: "Is your wildlife removal service licensed?",
    a: "Yes. BuzzKill technicians hold the appropriate state wildlife control licenses for Massachusetts and Rhode Island. All work is performed in compliance with state regulations.",
  },
];

export default function HumaneRemoval() {
  const [showBackToTop, setShowBackToTop] = useState<boolean>(false);
  const [activeAccordion, setActiveAccordion] = useState<number | null>(null);
  const [activeHappening, setActiveHappening] = useState<number>(0);
  const carouselRef = useRef<HTMLDivElement>(null);

  function scrollCarousel(dir: "left" | "right") {
    if (!carouselRef.current) return;
    const amount = 280;
    carouselRef.current.scrollBy({
      left: dir === "left" ? -amount : amount,
      behavior: "smooth",
    });
  }

  useEffect(() => {
    function handleScroll() {
      const scrollTop = window.scrollY;
      setShowBackToTop(scrollTop > 600);
    }

    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  return (
    <>
      <SEO
        title="Humane Wildlife Removal Services — MA & RI"
        description="Licensed humane wildlife removal and exclusion for Massachusetts and Rhode Island homes. Safe for animals, effective for homeowners."
      />

      {/* Back to top */}
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
        image="/images/humane-removal-hero.png"
        eyebrow="Humane Removal"
        headline="Humane Wildlife Removal & Exclusion"
        sub="Safe and humane removal for squirrels, raccoons, bats, and more. Licensed wildlife technicians serving Massachusetts and Rhode Island."
        className="bk-hero--community"
      />

      {/* Familiar carousel section */}
      <section id="familiar" className="bk-familiar-section">
        <div className="bk-familiar-inner">
          <h2 className="bk-section-title">Sound Familiar?</h2>
          <p className="bk-section-intro">
            These are the situations we hear about every day from homeowners across Massachusetts and Rhode Island.
          </p>
          <div className="bk-carousel-wrapper">
            <button
              className="bk-carousel-arrow bk-carousel-arrow--left"
              onClick={() => scrollCarousel("left")}
              aria-label="Scroll left"
            >
              ‹
            </button>
            <div className="bk-carousel" ref={carouselRef}>
              {FAMILIAR_ITEMS.map((item, i) => (
                <div key={i} className="bk-familiar-card">
                  <span className="bk-familiar-emoji">{item.emoji}</span>
                  <p className="bk-familiar-text">{item.text}</p>
                </div>
              ))}
            </div>
            <button
              className="bk-carousel-arrow bk-carousel-arrow--right"
              onClick={() => scrollCarousel("right")}
              aria-label="Scroll right"
            >
              ›
            </button>
          </div>
        </div>
      </section>

      {/* Issue selector section (dark) */}
      <section id="happening" className="bk-happening-section bk-section--dark">
        <div className="bk-happening-inner">
          <h2 className="bk-section-title">What's Really Happening</h2>
          <p className="bk-section-intro">
            Understanding the issue makes the solution clear.
          </p>
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
          <div className="bk-happening-card">
            <h3 className="bk-happening-card-title">
              {HAPPENING_CARDS[activeHappening].title}
            </h3>
            <p className="bk-happening-card-body">
              {HAPPENING_CARDS[activeHappening].body}
            </p>
          </div>
        </div>
      </section>

      {/* Accordion + quote card section (cream) */}
      <section id="attracts" className="bk-attract-section bk-section--cream">
        <div className="bk-attract-inner">
          <div className="bk-attract-main">
            <h2 className="bk-section-title">
              Why Humane Removal Requires More Than a Trap
            </h2>
            <p className="bk-section-intro">
              Removing an animal humanely means doing it safely, legally, and in a way that prevents the same situation from happening again.
            </p>
            <div className="bk-accordion">
              {ATTRACT_REASONS.map((item, i) => (
                <div
                  key={i}
                  className={`bk-accordion-item${activeAccordion === i ? " bk-accordion-item--open" : ""}`}
                >
                  <button
                    className="bk-accordion-trigger"
                    onClick={() =>
                      setActiveAccordion(activeAccordion === i ? null : i)
                    }
                    aria-expanded={activeAccordion === i}
                  >
                    <span className="bk-accordion-num">{item.num}</span>
                    <span className="bk-accordion-label">{item.label}</span>
                    <span className="bk-accordion-title">{item.title}</span>
                    <span className="bk-accordion-chevron">
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

      {/* Method track (cream) */}
      <section id="protects" className="bk-protects-section bk-section--cream">
        <div className="bk-protects-inner">
          <h2 className="bk-section-title">How We Help</h2>
          <p className="bk-section-intro">
            Our approach addresses the root cause, not just the symptom.
          </p>
          <div className="bk-protect-track">
            {PROTECT_STEPS.map((step, i) => (
              <div key={i} className="bk-protect-step">
                <div className="bk-protect-method">{step.method}</div>
                <div className="bk-protect-num">{step.num}</div>
                <h3 className="bk-protect-title">{step.title}</h3>
                <p className="bk-protect-body">{step.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Book track (dark) */}
      <section id="book" className="bk-book-section bk-section--dark">
        <div className="bk-book-inner">
          <h2 className="bk-section-title">How Booking Works</h2>
          <p className="bk-section-intro">
            Simple steps from first contact to a pest-free home.
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
            <Link to="/quote" className="bk-btn bk-btn-primary">
              Get an Instant Quote
            </Link>
            <a href="tel:+15082589294" className="bk-btn bk-btn-secondary">
              Call (508) 258-9294
            </a>
          </div>
        </div>
      </section>

      {/* Why us (cream) */}
      <section id="why-us" className="bk-why-section bk-section--cream">
        <div className="bk-why-inner">
          <h2 className="bk-section-title">Why BuzzKill</h2>
          <p className="bk-section-intro">
            BuzzKill Pest Control serves Massachusetts and Rhode Island with licensed, family-safe pest and wildlife solutions.
          </p>
          <div className="bk-why-grid">
            {WHY_ITEMS.map((item, i) => (
              <div key={i} className="bk-why-card">
                <span className="bk-why-icon">{item.icon}</span>
                <h3 className="bk-why-title">{item.title}</h3>
                <p className="bk-why-body">{item.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Prevention (cream) */}
      <section id="prevention" className="bk-prevention-section bk-section--cream">
        <div className="bk-prevention-inner">
          <h2 className="bk-section-title">Prevention Tips</h2>
          <p className="bk-section-intro">
            Steps you can take to reduce the likelihood of a repeat wildlife issue.
          </p>
          <ul className="bk-tips-list">
            {TIPS.map((tip, i) => (
              <li key={i} className="bk-tip-item">
                <span className="bk-tip-marker">âœ“</span>
                <span className="bk-tip-text">{tip}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* Related (cream) */}
      <section id="related" className="bk-related-section bk-section--cream">
        <div className="bk-related-inner">
          <h2 className="bk-section-title">More Services</h2>
          <p className="bk-section-intro">
            Humane removal works best as part of a complete wildlife management program that includes exclusion and restoration.
          </p>
          <div className="bk-related-grid">
            {RELATED_SERVICES.map((svc, i) => (
              <Link key={i} to={svc.to} className="bk-related-card">
                <span className="bk-related-label">{svc.label}</span>
                <p className="bk-related-desc">{svc.desc}</p>
                <span className="bk-related-arrow">â†’</span>
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

      {/* Schedule CTA card */}
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
              <Link to="/quote" className="bk-btn bk-schedule-cta">
                Get an Instant Quote
              </Link>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

