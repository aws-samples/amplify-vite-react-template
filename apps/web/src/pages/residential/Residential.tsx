import { useState, useRef } from "react";
import { Link } from "react-router-dom";
import Hero from "../../components/Hero";
import FAQ from "../../components/FAQ";

const LIFESTYLE_CARDS = [
  {
    icon: "👨‍👩‍👧",
    title: "Families",
    body: "Helping create a comfortable home where your family can focus on living instead of worrying about pests.",
  },
  {
    icon: "🐾",
    title: "Pet Owners",
    body: "Thoughtfully applied treatments designed with the safety and comfort of your pets in mind.",
  },
  {
    icon: "🌿",
    title: "Outdoor Living",
    body: "Enjoy more time in your backyard with protection from mosquitoes, ticks, and stinging insects.",
  },
  {
    icon: "🛡️",
    title: "Year Round Protection",
    body: "Helping keep seasonal pests from becoming year round problems.",
  },
];

const SERVICE_CATEGORIES = [
  {
    label: "Inside Your Home",
    services: [
      { name: "Ants & Spiders", to: "/residential/general-pest" },
      { name: "Cockroaches", to: "/residential/cockroach" },
      { name: "Fleas & Silverfish", to: "/residential/flea-silverfish" },
    ],
  },
  {
    label: "Around Your Home",
    services: [
      { name: "Wasps, Hornets & Bees", to: "/residential/wasp-hornet-bee" },
      { name: "Mosquitoes", to: "/residential/mosquito-tick" },
      { name: "Ticks", to: "/residential/mosquito-tick/tick" },
    ],
  },
  {
    label: "Rodent Protection",
    services: [
      { name: "Mice & Rat Removal", to: "/residential/rodent-control" },
      { name: "Entry Point Sealing", to: "/residential/rodent-control/entry-sealing" },
      { name: "Attic Rodent Control", to: "/residential/rodent-control/attic" },
      { name: "Attic Restoration", to: "/residential/rodent-control/attic-restoration" },
    ],
  },
  {
    label: "Structural Protection",
    services: [
      { name: "Termite Inspection", to: "/residential/termite" },
      { name: "Wood Boring Insects", to: "/residential/termite/wood-boring" },
      { name: "Wildlife Removal", to: "/residential/wildlife" },
    ],
  },
];

const HOMEOWNER_QUOTES = [
  { emoji: "😤", text: "I've tried store sprays and they keep coming back." },
  { emoji: "🐾", text: "My dog keeps bringing fleas inside." },
  { emoji: "🦟", text: "We can't enjoy our backyard because of mosquitoes." },
  { emoji: "🐀", text: "I hear scratching in the attic every night." },
  { emoji: "🏠", text: "I'm worried termites have damaged my home." },
  { emoji: "😩", text: "I just want someone to take care of it." },
];


const PET_CARDS = [
  {
    icon: "🐶",
    title: "Dogs & Cats",
    body: "Helping keep curious noses and paws in mind during every service.",
  },
  {
    icon: "🌿",
    title: "Outdoor Spaces",
    body: "Enjoy your yard with greater confidence during mosquito and tick season.",
  },
  {
    icon: "💬",
    title: "Clear Guidance",
    body: "We'll explain any preparation or temporary precautions before every service.",
  },
];

const SEASONAL_TIPS = [
  {
    season: "Spring",
    tips: [
      "Inspect the exterior for new gaps that opened over winter.",
      "Check for ant trails and address moisture issues early.",
      "Schedule a termite inspection before the season peaks.",
      "Clear gutters and standing water before mosquito season begins.",
    ],
  },
  {
    season: "Summer",
    tips: [
      "Apply mosquito and tick treatments for peak outdoor season.",
      "Check eaves and rooflines for wasp and hornet nests.",
      "Keep outdoor food and drinks covered during gatherings.",
      "Trim vegetation near the foundation and exterior walls.",
    ],
  },
  {
    season: "Fall",
    tips: [
      "Seal entry points before rodents start seeking warmth indoors.",
      "Inspect the attic and crawl space for signs of rodent activity.",
      "Remove leaf piles and debris from around the home.",
      "Schedule preventative rodent service before temperatures drop.",
    ],
  },
  {
    season: "Winter",
    tips: [
      "Monitor for rodent activity inside the home and attic.",
      "Keep firewood stored away from the exterior.",
      "Inspect the basement and utility rooms for cockroach activity.",
      "Check crawl space insulation for signs of pest damage.",
    ],
  },
  {
    season: "Year Round",
    tips: [
      "Store food and pet food in sealed containers.",
      "Fix leaking pipes and reduce moisture under sinks.",
      "Keep clutter and storage organized in attics and basements.",
      "Schedule routine pest control to stay ahead of seasonal pressure.",
    ],
  },
];

const BOOK_STEPS = [
  { num: "01", title: "Know the Price.", body: "Get your instant quote online in minutes. No callbacks. No waiting." },
  { num: "02", title: "Pick Your Time.", body: "Choose the day that works best for you. We'll take care of the rest." },
  { num: "03", title: "We'll Do the BuzzKilling.", body: "Your local BuzzKill technician arrives ready to Understand. Solve. Protect." },
  { num: "04", title: "Get Back to Living.", body: "Enjoy a home that's protected so pests stay out of your daily routine." },
];

const WHY_ITEMS = [
  {
    icon: "/images/why-protection.png",
    title: "Protection With Purpose",
    body: "Every treatment is tailored to your property and the pests you're facing.",
  },
  {
    icon: "/images/why-local-experts.png",
    title: "Local Experts. Local Pests.",
    body: "Licensed in Massachusetts and Rhode Island with solutions built for local pest activity.",
  },
  {
    icon: "/images/why-guarantee.png",
    title: "We Stand Behind Our Work",
    body: "If covered pests return during your service guarantee, so do we.",
  },
  {
    icon: "/images/why-communication.png",
    title: "Clear Communication. Every Visit.",
    body: "You'll always know what we found, what we treated, and what comes next.",
  },
];

const RESIDENTIAL_FAQS = [
  {
    q: "How often should residential pest control be scheduled?",
    a: "For most homes, recurring quarterly or seasonal service provides the most consistent protection. One-time treatments are available, but a routine program keeps pest pressure consistently low throughout the year.",
  },
  {
    q: "Are treatments safe for children and pets?",
    a: "Yes. Every BuzzKill treatment is thoughtfully applied with your family and pets in mind. Your technician will walk you through what to expect before every visit so there are no surprises.",
  },
  {
    q: "Can I get an Instant Quote online?",
    a: "Yes. Most residential services include an instant online quote so you can see pricing, choose your service, and schedule in just a few clicks.",
  },
  {
    q: "Do I need recurring pest control?",
    a: "Recurring service provides the best long-term protection because seasonal pest pressure changes throughout the year. However, one-time treatments are available for specific needs.",
  },
  {
    q: "Should I leave my home during treatment?",
    a: "It depends on the service. Your technician will provide clear guidance on any preparation needed and how soon you can return to normal activity after treatment.",
  },
  {
    q: "What happens after my first visit?",
    a: "After your first visit, your technician will explain what was found, what was treated, and what to expect next. You'll always leave with a clear picture of your home's protection.",
  },
];

export default function Residential() {
  const [activeSeason, setActiveSeason] = useState(0);
  const [activeCat, setActiveCat] = useState(0);
  const carouselRef = useRef<HTMLDivElement>(null);

  const scrollCarousel = (dir: "prev" | "next") => {
    const el = carouselRef.current;
    if (!el) return;
    const card = el.querySelector(".bk-familiar-bubble") as HTMLElement | null;
    const cardW = card ? card.offsetWidth + 16 : 280;
    el.scrollBy({ left: dir === "next" ? cardW : -cardW, behavior: "smooth" });
  };

  return (
    <>
      {/* 1 — Hero */}
      <Hero
        announceBanner
        image="/images/hero-home-2-main.png"
        eyebrow="Residential Pest Control"
        headline="Protect What Matters Most"
        sub="Safe for Families. Tough on Pests."
        body="Whether you're protecting your family, your pets, or the place you call home, BuzzKill delivers residential pest control built around your property, your lifestyle, and lasting peace of mind across Massachusetts and Rhode Island."
        primaryCta={{ label: "Get Instant Quote", href: "/quote" }}
        secondaryCta={{ label: "Explore Services", href: "#services" }}
        className="bk-hero--community"
      />

      {/* 2 — Every Home Has Its Own Story */}
      <section className="bk-res-story bk-section-cream">
        <div className="bk-container">
          <div className="bk-res-story-inner">
            <div className="bk-res-story-left">
              <p className="bk-eyebrow">Understanding Your Home First</p>
              <h2 className="bk-res-story-hed">No Two Homes Attract Pests the Same Way</h2>
            </div>
            <div className="bk-res-story-right">
              <p className="bk-res-story-p">A home near the woods has different pest challenges than one in the suburbs. Homes with children, pets, gardens, or finished basements all require different approaches.</p>
              <p className="bk-res-story-accent">That's why every BuzzKill visit begins with one thing:</p>
              <p className="bk-res-story-close">Understanding your home before recommending the right solution.</p>
            </div>
          </div>
        </div>
      </section>

      {/* 3 — Built Around The Way You Live */}
      <section className="bk-section bk-section-cream">
        <div className="bk-container">
          <p className="bk-eyebrow bk-center">Built For Your Life</p>
          <h2 className="bk-h2 bk-center">Protection That Fits Your Home and Lifestyle</h2>
          <p className="bk-body-lead bk-center" style={{ maxWidth: 620, margin: "0 auto 48px" }}>
            Whether you're raising young children, sharing your home with pets, working from home, or simply enjoying your backyard, pest control should fit around your life, not disrupt it.
          </p>
          <div className="bk-res-lifestyle-grid">
            {LIFESTYLE_CARDS.map((c, i) => (
              <div key={i} className="bk-res-lifestyle-card">
                <span className="bk-res-lifestyle-icon" aria-hidden="true">{c.icon}</span>
                <h3 className="bk-res-lifestyle-title">{c.title}</h3>
                <p className="bk-res-lifestyle-body">{c.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 4 — Residential Pest Solutions */}
      <section id="services" className="bk-section bk-section-dark">
        <div className="bk-container">
          <p className="bk-eyebrow bk-center" style={{ color: "var(--bk-green)" }}>What We Treat</p>
          <h2 className="bk-h2 bk-on-dark bk-center">Residential Pest Solutions</h2>
          <p className="bk-body-lead bk-on-dark bk-center" style={{ maxWidth: 560, margin: "0 auto 40px" }}>
            Every residential pest problem has a solution. Find yours below.
          </p>
          <div className="bk-res-sol-tabs">
            {SERVICE_CATEGORIES.map((cat, i) => (
              <button
                key={i}
                className={`bk-res-sol-tab${activeCat === i ? " is-active" : ""}`}
                onClick={() => setActiveCat(i)}
              >
                {cat.label}
              </button>
            ))}
          </div>
          <div className="bk-res-sol-panel">
            {SERVICE_CATEGORIES[activeCat].services.map((s, i) => (
              <Link key={i} to={s.to} className="bk-res-sol-link">
                <span>{s.name}</span>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12h14M12 5l7 7-7 7" />
                </svg>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* 5 — What Homeowners Tell Us */}
      <section className="bk-section bk-section-cream">
        <div className="bk-container">
          <p className="bk-eyebrow bk-center">Sound Familiar?</p>
          <h2 className="bk-h2 bk-center">What Homeowners Tell Us Every Week</h2>
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
              {HOMEOWNER_QUOTES.map((item, i) => (
                <div key={i} className="bk-familiar-bubble">
                  <span className="bk-familiar-emoji" aria-hidden="true">{item.emoji}</span>
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

      {/* 7 — The BuzzKill Method */}
      <section className="bk-section bk-section-cream">
        <div className="bk-container">
          <p className="bk-eyebrow bk-center">The BuzzKill Method</p>
          <h2 className="bk-h2 bk-center">How BuzzKill Protects Your Home</h2>
          <p className="bk-body-lead bk-center" style={{ maxWidth: 540, margin: "0 auto 48px" }}>
            Every successful visit follows the same three steps.
          </p>
          <div className="bk-method-track">
            {[
              {
                badge: "UNDERSTAND",
                num: "01",
                title: "We learn your home.",
                body: "We inspect entry points, nesting areas, moisture, and food sources so we solve the real problem, not just what you can see.",
              },
              {
                badge: "SOLVE",
                num: "02",
                title: "We treat the source.",
                body: "Targeted treatments address where pests live and travel, not simply the ones you happen to see.",
              },
              {
                badge: "PROTECT",
                num: "03",
                title: "We help keep them out.",
                body: "We reduce the conditions that attract pests and provide recommendations to help protect your property year round.",
              },
            ].map((s, i) => (
              <div key={i} className="bk-method-card">
                <div className="bk-method-badge">{s.badge}</div>
                <div className="bk-method-num">{s.num}</div>
                <h3 className="bk-method-title">{s.title}</h3>
                <p className="bk-method-body">{s.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 8 — What Happens When You Book */}
      <section className="bk-section bk-section-dark">
        <div className="bk-container">
          <p className="bk-eyebrow bk-center" style={{ color: "var(--bk-green)" }}>The Process</p>
          <h2 className="bk-h2 bk-on-dark bk-center">What Happens When You Book</h2>
          <p className="bk-body-lead bk-on-dark bk-center" style={{ maxWidth: 520, margin: "0 auto 48px" }}>
            Protection Starts in Just a Few Clicks.
          </p>
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
            <Link to="/quote" className="bk-btn bk-btn-primary">Get Instant Quote</Link>
          </div>
        </div>
      </section>

      {/* 9 — Why Homeowners Trust BuzzKill */}
      <section className="bk-section bk-section-cream">
        <div className="bk-container">
          <p className="bk-eyebrow bk-center">Why BuzzKill</p>
          <h2 className="bk-h2 bk-center">Why Homeowners Trust BuzzKill</h2>
          <p className="bk-body-lead bk-center" style={{ maxWidth: 580, margin: "0 auto 48px" }}>
            Protection With Purpose means every visit is built around your property, your family, and lasting peace of mind.
          </p>
          <div className="bk-choose-grid">
            {WHY_ITEMS.map((item, i) => (
              <div key={i} className="bk-choose-card">
                <span className="bk-choose-icon" aria-hidden="true">
                  <img src={item.icon} alt="" style={{ width: 48, height: 48, objectFit: "contain" }} />
                </span>
                <h3 className="bk-choose-title">{item.title}</h3>
                <p className="bk-choose-body">{item.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 10 — Protecting Families Starts With Protecting Pets */}
      <section className="bk-section bk-section-cream">
        <div className="bk-container">
          <p className="bk-eyebrow bk-center">Family First</p>
          <h2 className="bk-h2 bk-center">A Home Should Feel Safe for Everyone</h2>
          <p className="bk-body-lead bk-center" style={{ maxWidth: 600, margin: "0 auto 48px" }}>
            Your pets explore every corner of your home and yard. That's why every BuzzKill treatment is thoughtfully planned to protect the people and pets who matter most while targeting the pests that don't belong.
          </p>
          <div className="bk-res-pet-grid">
            {PET_CARDS.map((c, i) => (
              <div key={i} className="bk-res-pet-card bk-res-pet-card--light">
                <span className="bk-res-pet-icon" aria-hidden="true">{c.icon}</span>
                <h3 className="bk-res-pet-title bk-res-pet-title--light">{c.title}</h3>
                <p className="bk-res-pet-body bk-res-pet-body--light">{c.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 11 — Simple Ways To Help Prevent Pests */}
      <section className="bk-section bk-section-cream">
        <div className="bk-container">
          <p className="bk-eyebrow bk-center">Prevention</p>
          <h2 className="bk-h2 bk-center">Simple Ways To Help Prevent Pests</h2>
          <p className="bk-body-lead bk-center" style={{ maxWidth: 540, margin: "0 auto 40px" }}>
            Seasonal habits that help keep pests from finding their way in.
          </p>
          <div className="bk-res-seasonal-tabs">
            {SEASONAL_TIPS.map((s, i) => (
              <button
                key={i}
                className={`bk-res-seasonal-tab${activeSeason === i ? " is-active" : ""}`}
                onClick={() => setActiveSeason(i)}
              >
                {s.season}
              </button>
            ))}
          </div>
          <div className="bk-res-seasonal-panel">
            {SEASONAL_TIPS[activeSeason].tips.map((tip, i) => (
              <div key={i} className="bk-res-seasonal-tip">
                <div className="bk-res-tip-check" aria-hidden="true">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                </div>
                <p>{tip}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 12 — Explore Residential Services */}
      <section className="bk-section bk-section-dark">
        <div className="bk-container">
          <p className="bk-eyebrow bk-center" style={{ color: "var(--bk-green)" }}>Every Service</p>
          <h2 className="bk-h2 bk-on-dark bk-center">Explore Residential Services</h2>
          <p className="bk-body-lead bk-on-dark bk-center" style={{ maxWidth: 500, margin: "0 auto 48px" }}>
            Find the right protection for your home.
          </p>
          <div className="bk-res-hub-grid">
            {SERVICE_CATEGORIES.map((cat, ci) => (
              <div key={ci} className="bk-res-hub-group">
                <p className="bk-res-hub-cat">{cat.label}</p>
                {cat.services.map((s, si) => (
                  <Link key={si} to={s.to} className="bk-res-hub-link">
                    <span>{s.name}</span>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M5 12h14M12 5l7 7-7 7" />
                    </svg>
                  </Link>
                ))}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 13 — FAQ */}
      <FAQ
        eyebrow="Common Questions"
        title="Residential FAQ"
        items={RESIDENTIAL_FAQS}
      />

      {/* 14 — Final CTA */}
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
              <h2 className="bk-schedule-title">Let's Get Your Home BuzzKilled</h2>
              <p className="bk-schedule-sub">Safe for families. Tough on pests. Get your Instant Quote today and protect your home with BuzzKill.</p>
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
