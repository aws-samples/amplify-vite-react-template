import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import FAQ from "../../components/FAQ";
import Hero from "../../components/Hero";
import SEO, { buildBreadcrumbSchema, buildServiceSchema } from "../../components/SEO";
import QuoteCard from "../../components/QuoteCard";
import { useTalkToExpert } from "../../components/TalkToExpertModal";

const FAMILIAR_ITEMS = [
  { emoji: "🐕", icon: "/images/icon-tick-walk-check.png",     text: "Every walk ends with another tick check." },
  { emoji: "🌲", icon: "/images/icon-tick-backyard-safer.png", text: "My backyard should feel safer." },
  { emoji: "👨‍👩‍👧", icon: "/images/icon-tick-kids-yard.png",  text: "The kids love the yard, but I worry about ticks." },
  { emoji: "🧦", icon: "/images/icon-tick-socks-shoes.png",    text: "We're constantly checking socks and shoes." },
  { emoji: "🌿", icon: "/images/icon-tick-tall-grass.png",     text: "Tall grass isn't the only place they're hiding." },
  { emoji: "😌", icon: "/images/icon-tick-prevent.png",        text: "I'd rather prevent ticks than deal with them later." },
];

const HAPPENING_CARDS = [
  {
    tag: "The Behavior",
    title: "Ticks Wait Instead Of Chase",
    body: "They attach from grass, shrubs, and ground cover as people and pets pass by.",
    cta: "Know the Price. Book in Minutes.",
  },
  {
    tag: "The Habitat",
    title: "Backyards Can Be Tick Habitat",
    body: "Property edges, wooded areas, and landscaping often create ideal hiding places.",
    cta: "Ready to Get BuzzKilled?",
  },
  {
    tag: "The Protection",
    title: "Protection Works Best Before Exposure",
    body: "Routine seasonal treatments help reduce tick populations before activity peaks.",
    cta: "Let's Get Your Property BuzzKilled",
  },
];

const ATTRACT_REASONS = [
  { num: "01", label: "Wooded Edges",       title: "Ticks Wait Where Wildlife Travels",                body: "The border between your lawn and wooded areas is one of the most common places ticks wait for a host." },
  { num: "02", label: "Tall Grass",         title: "More Than Just An Eyesore",                        body: "Unmowed grass provides the humid, shaded environment that ticks prefer to survive and find hosts." },
  { num: "03", label: "Ground Cover",       title: "Dense Plants Offer Protection",                    body: "Low growing plants, leaf litter, and mulch beds keep ticks close to the ground where they are most active." },
  { num: "04", label: "Wildlife Visitors",  title: "Animals Carry Ticks Onto Your Property",           body: "Deer, birds, and small mammals regularly bring ticks into residential yards throughout the season." },
  { num: "05", label: "Seasonal Activity",  title: "Ticks Remain Active Longer Than Many People Think", body: "Some tick species remain active in fall and even winter, making year round awareness important." },
];

const PROTECT_STEPS = [
  {
    method: "UNDERSTAND",
    num: "01",
    title: "We inspect tick habitat.",
    body: "We identify the areas where ticks are most likely to live around your property.",
  },
  {
    method: "SOLVE",
    num: "02",
    title: "We treat targeted areas.",
    body: "Applications focus on landscaping, wooded edges, and other high-risk locations.",
  },
  {
    method: "PROTECT",
    num: "03",
    title: "Confidence with every step.",
    body: "Seasonal treatments help reduce tick activity where your family and pets spend time.",
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
  { title: "Keep Grass Short",             body: "Mow regularly throughout the season." },
  { title: "Trim Wooded Edges",            body: "Reduce dense vegetation around your yard." },
  { title: "Remove Leaf Litter",           body: "Ticks thrive in damp organic debris." },
  { title: "Create Separation",            body: "Keep play areas away from wooded sections when possible." },
  { title: "Stay Protected All Season",    body: "Routine treatments help reduce tick activity during peak months." },
];

const RELATED_SERVICES = [
  { label: "Rodent Control", to: "/services/rodent-control", desc: "They don't wait. Neither should you." },
  { label: "Cockroach Control", to: "/services/cockroach", desc: "If you see one, there's usually more nearby." },
  { label: "Mosquito & Tick Control", to: "/services/mosquito-tick", desc: "Take your yard back this season." },
  { label: "Wasp & Hornet Control", to: "/services/wasp-hornet-bee", desc: "Enjoy your backyard, not their nest." },
];

const FAQS = [
  {
    q: "Where do ticks usually hide?",
    a: "Ticks prefer shaded landscaping, tall grass, and wooded edges.",
  },
  {
    q: "How often should yards be treated?",
    a: "Seasonal applications provide the best protection.",
  },
  {
    q: "Can treatment help protect pets?",
    a: "Yes. Reducing tick activity helps create a safer outdoor environment.",
  },
  {
    q: "Will one treatment last all season?",
    a: "Multiple treatments are recommended throughout peak tick season.",
  },
  {
    q: "Should I mow before treatment?",
    a: "Keeping grass maintained helps improve treatment effectiveness.",
  },
  {
    q: "How do I schedule?",
    a: "Use the Instant Quote tool to choose your appointment.",
  },
];

export default function TickProgram() {
  const { open: openTalkToExpert } = useTalkToExpert();
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
        title="Tick Control Program — MA & RI"
        description="Professional tick control for Massachusetts and Rhode Island yards. Our seasonal program reduces tick activity to help protect your family, pets, and outdoor spaces. Get an instant quote."
        jsonLd={[
          buildServiceSchema(
            "Tick Control Program",
            "Professional seasonal tick control for Massachusetts and Rhode Island properties, reducing tick activity to help protect families, pets, and outdoor spaces.",
            "/services/mosquito-tick/tick",
          ),
          buildBreadcrumbSchema([
            { name: "Home", url: "/" },
            { name: "Mosquito & Tick", url: "/services/mosquito-tick" },
            { name: "Tick Program", url: "/services/mosquito-tick/tick" },
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
        image="/images/tick-hero.png"
        eyebrow="Tick Control Program"
        headline="Protect Your Yard From Ticks Before They Find You"
        sub="BuzzKill reduces tick activity around your property to help protect your family, pets, and outdoor spaces throughout the season."
        primaryCta={{ label: "Get Instant Quote", href: "/quote" }}
        secondaryCta={{ label: "Talk to a Local Expert", onClick: openTalkToExpert }}
        className="bk-hero--community"
      />

      {/* 2. Does This Sound Familiar? */}
      <section id="familiar" className="bk-section bk-section-cream">
        <div className="bk-container">
          <p className="bk-eyebrow bk-center">Sound Familiar?</p>
          <h2 className="bk-h2 bk-center">Does This Sound Familiar?</h2>
          <p className="bk-body-lead bk-center">You are not alone. These are some of the most common things homeowners tell us before they call.</p>
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
                  {item.icon ? <img src={item.icon} alt="" className="bk-familiar-icon" /> : <span className="bk-familiar-emoji" aria-hidden="true">{item.emoji}</span>}
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
          <p className="bk-issue-intro">Ticks don't stay where you can see them. Understanding where they wait on your property is the first step toward reducing their activity all season, not just reacting after a bite.</p>

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

      {/* 4. Why Ticks Stay In Your Yard */}
      <section id="attracts" className="bk-section bk-section-cream">
        <div className="bk-container">
          <div className="bk-attract-layout">

            {/* Left: accordion */}
            <div className="bk-attract-main">
              <p className="bk-eyebrow">Root Causes</p>
              <h2 className="bk-h2">Why Ticks Stay In Your Yard</h2>
              <p className="bk-attract-intro">
                Ticks don't wander far from where they wait. Understanding where they hide on your property helps us target treatment where it matters most.
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
          <p className="bk-body-lead bk-center">Ticks shouldn't decide how you enjoy your yard. We target the places they hide and help create a safer outdoor environment.</p>
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
          <h2 className="bk-h2">Keep Ticks Out of Your Yard</h2>
          <p className="bk-body-lead">A well maintained yard helps reduce places where ticks thrive.</p>
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
          <h2 className="bk-h2 bk-center">Your Pest Problem Might Not Stop at Ticks</h2>
          <p className="bk-body-lead bk-center">Ticks are often just the beginning. Explore the other pest control services BuzzKill provides across Massachusetts &amp; Rhode Island.</p>
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
