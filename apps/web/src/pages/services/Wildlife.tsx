import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import FAQ from "../../components/FAQ";
import Hero from "../../components/Hero";
import SEO, { buildBreadcrumbSchema, buildServiceSchema } from "../../components/SEO";
import { useTalkToExpert } from "../../components/TalkToExpertModal";

const FAMILIAR_ITEMS = [
  { emoji: "🦝", icon: "/images/badge-attic-squirrel.png",  text: "Something is definitely living in the attic." },
  { emoji: "🐿️", icon: "/images/badge-roof-movement.png",  text: "I keep hearing movement on the roof." },
  { emoji: "🦇", icon: "/images/badge-bats.png",            text: "I found bats where they shouldn't be." },
  { emoji: "🌙", icon: "/images/badge-night-noises.png",    text: "The noises only happen at night." },
  { emoji: "🏠", icon: "/images/badge-home-damage.png",     text: "I don't want wildlife damaging my home." },
  { emoji: "🙏", icon: "/images/badge-humane-removal.png",  text: "I want them removed safely and humanely." },
];

const HAPPENING_CARDS = [
  {
    tag: "The Shelter",
    title: "Wildlife Looks For Shelter",
    body: "Attics, chimneys, and crawl spaces provide warmth and protection.",
    cta: "Know the Price. Book in Minutes.",
  },
  {
    tag: "The Return",
    title: "Animals Usually Return",
    body: "Without exclusion work, new wildlife often finds the same entry points.",
    cta: "Ready to Get BuzzKilled?",
  },
  {
    tag: "The Solution",
    title: "Removal Is Only The Beginning",
    body: "Protecting your home means safely removing wildlife and preventing future access.",
    cta: "Let's Get Your Property BuzzKilled",
  },
];

const ATTRACT_REASONS = [
  { num: "01", label: "Warm Shelter",       title: "Homes Offer Protection From The Weather",         body: "Attics, crawl spaces, and wall voids provide temperature stability and protection that wildlife actively seeks out." },
  { num: "02", label: "Food Sources",       title: "Trash, Bird Feeders, And Pet Food Attract Wildlife", body: "Accessible food near or around your home creates a reason for wildlife to return repeatedly." },
  { num: "03", label: "Roof Access",        title: "Trees Create Natural Pathways",                   body: "Overhanging branches, trellises, and downspouts give squirrels, raccoons, and other animals easy access to your roofline." },
  { num: "04", label: "Quiet Spaces",       title: "Attics And Crawl Spaces Feel Safe",               body: "Undisturbed areas inside homes provide wildlife with the protection and privacy needed to nest and raise young." },
  { num: "05", label: "Open Entry Points",  title: "Wildlife Uses Existing Openings",                 body: "Animals take advantage of damaged soffits, vents, loose siding, and gaps around utility lines to enter your home." },
];

const PROTECT_STEPS = [
  {
    method: "UNDERSTAND",
    num: "01",
    title: "We understand the activity.",
    body: "We inspect entry points, nesting areas, and signs of wildlife around your property.",
  },
  {
    method: "SOLVE",
    num: "02",
    title: "Safe, humane removal.",
    body: "Our approach focuses on resolving wildlife problems responsibly while protecting your home.",
  },
  {
    method: "PROTECT",
    num: "03",
    title: "Helping keep wildlife outside.",
    body: "We identify opportunities to reduce future access and better protect your property.",
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
  { title: "Inspect Your Roof",            body: "Check vents, soffits, and rooflines for openings." },
  { title: "Trim Tree Branches",           body: "Reduce easy access to your home." },
  { title: "Secure Garbage",              body: "Keep lids tightly closed to avoid attracting wildlife." },
  { title: "Repair Exterior Damage",       body: "Fix loose siding, vents, and damaged roofing promptly." },
  { title: "Schedule Routine Inspections", body: "Professional inspections help identify wildlife entry points before they become a problem." },
];

const RELATED_SERVICES = [
  { label: "Rodent Control", to: "/services/rodent-control", desc: "They don't wait. Neither should you." },
  { label: "Cockroach Control", to: "/services/cockroach", desc: "If you see one, there's usually more nearby." },
  { label: "Mosquito & Tick Control", to: "/services/mosquito-tick", desc: "Take your yard back this season." },
  { label: "Wasp & Hornet Control", to: "/services/wasp-hornet-bee", desc: "Enjoy your backyard, not their nest." },
];

const FAQS = [
  {
    q: "How do wild animals get into homes?",
    a: "They often enter through roof openings, vents, soffits, and damaged exterior areas.",
  },
  {
    q: "Will the animals be removed safely?",
    a: "Yes. Our approach focuses on safe and responsible wildlife removal.",
  },
  {
    q: "Can wildlife return after removal?",
    a: "If entry points remain open they can. We help identify areas that need attention.",
  },
  {
    q: "What signs should I look for?",
    a: "Scratching sounds, droppings, nesting materials, and unusual odors are common indicators.",
  },
  {
    q: "Do I need an inspection first?",
    a: "Yes. An inspection helps determine the best removal plan.",
  },
  {
    q: "Can you remove bats from my home?",
    a: "Bat work is exclusion-based, not trapping or removal. Massachusetts and Rhode Island law protects bats, and exclusion work is restricted during maternity season, typically May through August. We inspect and advise on the right approach for your situation.",
  },
  {
    q: "How do I book service?",
    a: "Get an Instant Quote online or contact the BuzzKill team to schedule your inspection.",
  },
];

export default function Wildlife() {
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
      const scrollY = window.scrollY;
      setShowBackToTop(scrollY > 700);
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <>
      <SEO
        title="Wildlife Removal Services — Squirrel, Raccoon & Bat | MA & RI"
        description="BuzzKill provides safe, responsible wildlife removal for homes across Massachusetts and Rhode Island. Squirrel, raccoon, and bat exclusion by licensed technicians. Get an instant quote."
        jsonLd={[
          buildServiceSchema(
            "Wildlife Removal Services",
            "Safe and responsible wildlife removal for Massachusetts and Rhode Island homes. Squirrel, raccoon, and bat exclusion by licensed technicians.",
            "/services/wildlife",
          ),
          buildBreadcrumbSchema([
            { name: "Home", url: "/" },
            { name: "Services", url: "/services/wildlife" },
            { name: "Wildlife Removal", url: "/services/wildlife" },
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
        image="/images/wildlife-hero.png"
        eyebrow="Wildlife Removal Services"
        headline="Wildlife Belongs Outside, Not in Your Home"
        sub="BuzzKill provides humane wildlife removal and helps prevent animals from returning, so your home stays protected throughout Massachusetts &amp; Rhode Island."
        primaryCta={{ label: "Get Instant Quote", href: "/quote" }}
        secondaryCta={{ label: "Talk to a Local Expert", onClick: openTalkToExpert }}
        className="bk-hero--community bk-hero--wildlife"
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
          <p className="bk-issue-intro">Most wildlife intrusions don't start where you notice them. Understanding what draws animals to your home is the first step toward long-term protection, not just a one-time removal.</p>

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

      {/* 4. Why Wildlife Chooses Your Home */}
      <section id="attracts" className="bk-section bk-section-cream">
        <div className="bk-container">
          <div className="bk-attract-layout">

            {/* Left: accordion */}
            <div className="bk-attract-main">
              <p className="bk-eyebrow">Root Causes</p>
              <h2 className="bk-h2">Why Wildlife Chooses Your Home</h2>
              <p className="bk-attract-intro">
                Wildlife doesn't choose your home by accident. They follow accessible shelter, food, and entry points. Understanding what draws them in helps us protect your home from future intrusions.
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
              <div className="bk-quote-card">

                <div className="bk-quote-card-pitch" style={{ paddingTop: 18, paddingBottom: 12 }}>
                  <div style={{ textAlign: "center" }}>
                    <p className="bk-quote-card-eyebrow bk-quote-card-eyebrow--flash">&#x26A1; Instant Pricing Available</p>
                  </div>
                  <h3 className="bk-quote-card-headline">
                    <span className="bk-quote-headline-block">Know the Price.</span>
                    <span className="bk-quote-headline-block">Book in Minutes.</span>
                  </h3>
                  <ul className="bk-quote-card-checklist">
                    <li>No phone tag</li>
                    <li>No waiting</li>
                    <li>See your quote online</li>
                    <li>Choose a plan, get on the schedule</li>
                  </ul>
                </div>

                <div className="bk-quote-card-cta" style={{ paddingTop: 12, paddingBottom: 12 }}>
                  <Link to="/quote" className="bk-btn bk-btn-primary bk-btn-full">
                    Get Free Instant Quote
                  </Link>
                  <a href="tel:+15082589294" className="bk-quote-card-phone bk-quote-card-phone--flash" style={{ fontSize: 17 }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                      <path d="M6.62 10.79a15.05 15.05 0 006.59 6.59l2.2-2.2a1 1 0 011.01-.24c1.12.37 2.33.57 3.58.57a1 1 0 011 1V20a1 1 0 01-1 1C10.74 21 3 13.26 3 4a1 1 0 011-1h3.5a1 1 0 011 1c0 1.25.2 2.45.57 3.57a1 1 0 01-.24 1.01l-2.21 2.21z"/>
                    </svg>
                    (508) 258-9294
                  </a>
                </div>

                <div className="bk-quote-stamp-wrap" style={{ paddingBottom: 12 }}>
                  <svg viewBox="0 0 104 104" width="104" height="104" aria-hidden="true" style={{ display: "block" }}>
                    {/* Transparent background — dark card shows through */}
                    <circle cx="52" cy="52" r="50" fill="none" />
                    {/* Circular text path — BUZZKILL forms the border */}
                    <defs>
                      <path id="buzzkill-ring" d="M 52 9 A 43 43 0 1 1 51.999 9" />
                    </defs>
                    <text fontSize="7" fill="white" fillOpacity="0.7" fontFamily="'Copperplate Gothic', serif" letterSpacing="2" fontWeight="900">
                      <textPath href="#buzzkill-ring">
                        BUZZKILL · BUZZKILL · BUZZKILL · BUZZKILL ·
                      </textPath>
                    </text>
                    {/* Center number */}
                    <text x="52" y="50" textAnchor="middle" dominantBaseline="middle" fontSize="26" fontFamily="'Alfa Slab One', serif" fill="#72E000">30</text>
                    {/* Center label */}
                    <text x="52" y="66" textAnchor="middle" fontSize="7" fontFamily="'Copperplate Gothic', serif" fill="rgba(255,255,255,0.82)" letterSpacing="1">DAY GUARANTEE</text>
                  </svg>
                </div>

                <p className="bk-quote-card-corner-terms">Terms &amp; conditions apply</p>

              </div>
            </aside>

          </div>
        </div>
      </section>

      {/* 5. How BuzzKill Protects Your Property */}
      <section id="protects" className="bk-section bk-section-cream">
        <div className="bk-container">
          <p className="bk-eyebrow bk-center">The BuzzKill Method</p>
          <h2 className="bk-h2 bk-center">How BuzzKill Protects Your Property</h2>
          <p className="bk-body-lead bk-center">Wildlife belongs in nature, not inside your home. We remove unwanted animals safely while helping prevent them from returning.</p>
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
          <h2 className="bk-h2">Help Keep Wildlife Outside</h2>
          <p className="bk-body-lead">Wildlife looks for warmth, shelter, and easy access. A few preventative steps can make a big difference.</p>
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
          <h2 className="bk-h2 bk-center">Your Pest Problem Might Not Stop With Wildlife</h2>
          <p className="bk-body-lead bk-center">Wildlife activity often coincides with other pest issues. Explore the other pest control services BuzzKill provides across Massachusetts &amp; Rhode Island.</p>
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
