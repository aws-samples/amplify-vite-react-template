import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import Hero from "../components/Hero";
import FAQ from "../components/FAQ";
import SEO, {
  ORG_SCHEMA,
  LOCAL_BUSINESS_SCHEMA,
  WEBSITE_SCHEMA,
  buildFAQSchema,
} from "../components/SEO";

const PESTS = [
  { name: "Ants",            img: "/images/pest-ants.png",        description: "One trail today can become tomorrow's colony.",                                          cta: "Protect My Home"         },
  { name: "Spiders",         img: "/images/pest-spiders.png",     description: "They're not paying rent. Let's keep them outside.",                                      cta: "Keep Them Out"           },
  { name: "Cockroaches",     img: "/images/pest-cockroaches.png", description: "Out of sight doesn't always mean out of your home.",                                      cta: "Take Action"             },
  { name: "Fleas",           img: "/images/pest-fleas.png",       description: "Keep the scratching for belly rubs, not flea bites.",                                     cta: "Protect My Family"       },
  { name: "Silverfish",      img: "/images/pest-silverfish.png",  description: "Hidden doesn't mean harmless.",                                                           cta: "Protect My Home"         },
  { name: "Wasps & Hornets", img: "/images/pest-wasp-bees.png",  description: "Your backyard should feel welcoming, for people, not wasps.",                             cta: "Remove the Nest"         },
  { name: "Mice & Rats",     img: "/images/pest-mice-rats.png",   description: "One squeak is all it takes to know it's time to act.",                                    cta: "Keep Rodents Out"        },
  { name: "Mosquitoes",      img: "/images/pest-mosquitoes.png",  description: "More fresh air. Fewer bites.",                                                            cta: "Enjoy Your Yard Again"   },
  { name: "Ticks",           img: "/images/pest-ticks.png",       description: "Protect every adventure, one yard at a time.",                                            cta: "Protect My Yard"         },
  { name: "Wildlife",        img: "/images/pest-wildlife.png",    description: "Let's keep wildlife where it belongs, in the wild.",                                      cta: "Protect My Property"     },
];

const HOME_FAQS = [
  {
    q: "How do I know which pest control service I need?",
    a: "You don’t have to figure it out on your own. Whether you’re dealing with ants, rodents, termites, mosquitoes, or something you can’t identify, BuzzKill will help match your property with the right pest control service. Most services can be quoted instantly online, so you can get started without waiting for a call.",
  },
  {
    q: "Are your pest control treatments safe for children and pets?",
    a: "Yes. Safe for Families. Tough on Pests. is more than our tagline, it’s how we approach every service. Our treatments are thoughtfully applied with your family, pets, and everyday life in mind while effectively targeting the pests you’re trying to eliminate.",
  },
  {
    q: "Can I get an instant quote online?",
    a: "Absolutely. Most of our residential pest control services include an instant online quote, allowing you to see pricing, choose a plan, and schedule your service in just a few clicks. A few specialized services may require additional information before pricing can be provided.",
  },
  {
    q: "Will one treatment solve the problem permanently?",
    a: "Every pest problem is different. Some issues can be resolved with a single visit, while others benefit from ongoing pest management to help prevent pests from returning. We identify what’s attracting pests, treat the problem at its source, and recommend the best plan to help keep your property protected.",
  },
];

export default function Home() {
  const navigate = useNavigate();
  const [activePest, setActivePest] = useState(PESTS[0].name);
  const goToForm = () => navigate("/quote");

  return (
    <>
      <SEO
        description="Professional pest control for condominiums, HOAs, and shared living communities across Massachusetts and Rhode Island. Common-area pest management and optional discounted in-unit service."
        jsonLd={[ORG_SCHEMA, LOCAL_BUSINESS_SCHEMA, WEBSITE_SCHEMA, buildFAQSchema(HOME_FAQS)]}
      />
      <Hero
        announceBanner
        image="/images/hero-home-2-main.png"
        eyebrow="Your Local Pest Control & Property Protection Company"
        headline={
          <>
            Safe for Families.
            <br />
            <em>Tough on Pests.</em>
          </>
        }
        subtitle={<>Residential, Commercial, HOA &amp; Condominium Pest Control Protecting Properties Across Massachusetts &amp; Rhode Island</>}
        primaryCta={{ label: "Get an Instant Quote", onClick: goToForm }}
        secondaryCta={{ label: "Find Your Service", onClick: goToForm }}
      />

      {/* Protection section */}
      <section className="bk-protect-section">
        <div className="bk-protect-inner">
          <div className="bk-protect-header">
            <p className="bk-protect-eyebrow">Why BuzzKill</p>
            <h2 className="bk-protect-title">
              More Than Pest Control. Property Protection You Can Trust.
            </h2>
            <p className="bk-protect-subtitle">
              Safe for families. Mindful of pets. Trusted to protect homes and communities across Massachusetts &amp; Rhode Island.
            </p>
          </div>

          <div className="bk-protect-grid">
            <div className="bk-protect-card">
              <img src="/images/icon-family.png" alt="" className="bk-protect-icon-img" aria-hidden="true" />
              <h3 className="bk-protect-card-title">Safe for Families</h3>
              <p className="bk-protect-card-body">Targeted treatments designed with your household in mind.</p>
            </div>
            <div className="bk-protect-card">
              <img src="/images/icon-pets.png" alt="" className="bk-protect-icon-img" aria-hidden="true" />
              <h3 className="bk-protect-card-title">Thoughtfully Applied Around Pets</h3>
              <p className="bk-protect-card-body">Every service is performed with care and clear guidance.</p>
            </div>
            <div className="bk-protect-card">
              <img src="/images/icon-property.png" alt="" className="bk-protect-icon-img" aria-hidden="true" />
              <h3 className="bk-protect-card-title">Built Around Your Property</h3>
              <p className="bk-protect-card-body">We solve the conditions attracting pests, not just the pests you see.</p>
            </div>
            <div className="bk-protect-card">
              <img src="/images/icon-future.png" alt="" className="bk-protect-icon-img" aria-hidden="true" />
              <h3 className="bk-protect-card-title">Long-Term Protection</h3>
              <p className="bk-protect-card-body">Helping reduce future pest problems through proactive solutions.</p>
            </div>
          </div>

          <div className="bk-protect-cta">
            <button type="button" className="bk-btn bk-btn-primary" onClick={goToForm}>
              See the BuzzKill Approach
            </button>
          </div>
        </div>
      </section>

      {/* Pests Moved In section */}
      <section className="bk-section bk-section-cream">
        <div className="bk-container bk-narrow bk-center">
          <h2 className="bk-h2">
            Pests Moved In? We Buzz Them Out.
          </h2>
          <p className="bk-body-lead">
            Your home is for making memories, not sharing it with unwanted pests. BuzzKill helps protect your family, pets, and property with thoughtful, professional pest control designed around your home, not a one-size-fits-all treatment.
          </p>
          <div style={{ display: "flex", gap: 14, justifyContent: "center", flexWrap: "wrap", marginTop: 16 }}>
            <button type="button" className="bk-btn bk-btn-primary" onClick={goToForm}>
              Get an Instant Quote
            </button>
          </div>
        </div>
      </section>

      {/* Who We Protect section */}
      <section className="bk-services-stagger">
        <div className="bk-services-stagger-inner">

          <div className="bk-stagger-section-header">
            <p className="bk-stagger-section-eyebrow">Who We Protect</p>
            <h2 className="bk-stagger-section-title">Pest Protection Designed Around Your Property</h2>
            <p className="bk-stagger-section-sub">Whether you're protecting your home or managing an entire community, BuzzKill delivers thoughtful, professional pest control tailored to the way you live, work, and manage your property.</p>
          </div>

          <div className="bk-stagger-tile">
            <div className="bk-stagger-img">
              <div className="bk-stagger-img-photo">
                <img src="/images/service1.webp" alt="Residential neighborhood protected by pet-safe pest control services in Massachusetts and Rhode Island" />
              </div>
              <img src="/images/shield.png" alt="" className="bk-stagger-badge" aria-hidden="true" />
            </div>
            <div className="bk-stagger-content">
              <p className="bk-stagger-eyebrow">For Homeowners</p>
              <h3 className="bk-stagger-title">Residential Pest Control</h3>
              <p className="bk-stagger-body">Protect your home with pest control designed around your family, your pets, and your peace of mind. From ants and spiders to rodents and termites, BuzzKill helps keep your home protected year-round.</p>
              <button type="button" className="bk-btn bk-btn-primary" onClick={goToForm}>
                Get Residential Quote
              </button>
            </div>
          </div>

          <div className="bk-stagger-tile bk-stagger-tile--reverse">
            <div className="bk-stagger-img">
              <div className="bk-stagger-img-photo">
                <img src="/images/service2.webp" alt="Pet-friendly condominium community protected by Buzzkill pest control services" />
              </div>
              <img src="/images/shield.png" alt="" className="bk-stagger-badge" aria-hidden="true" />
            </div>
            <div className="bk-stagger-content">
              <p className="bk-stagger-eyebrow">For Communities</p>
              <h3 className="bk-stagger-title">HOA &amp; Condominium Pest Management</h3>
              <p className="bk-stagger-body">Protect shared spaces, simplify community pest management, and support happier residents with proactive service, detailed reporting, and optional in-unit protection.</p>
              <button type="button" className="bk-btn bk-btn-primary" onClick={goToForm}>
                Request Community Proposal
              </button>
            </div>
          </div>

        </div>
      </section>

      {/* Common Pests section */}
      <section className="bk-pests-section">
        <div className="bk-pests-inner">
          <h2 className="bk-pests-title">Here are some of the most common pests we protect against</h2>
          <div className="bk-pests-tabs" role="tablist" aria-label="Common pests">
            {PESTS.map(pest => (
              <button
                key={pest.name}
                role="tab"
                aria-selected={activePest === pest.name}
                className={`bk-pest-tab${activePest === pest.name ? " is-active" : ""}`}
                onClick={() => setActivePest(pest.name)}
              >
                <span className="bk-pest-icon"><img src={pest.img} alt={pest.name} /></span>
                <span className="bk-pest-label">{pest.name}</span>
              </button>
            ))}
          </div>
          {PESTS.filter(p => p.name === activePest).map(pest => (
            <div key={pest.name} className="bk-pest-content" role="tabpanel">
              <h3 className="bk-pest-content-name">{pest.name}</h3>
              <p className="bk-pest-content-desc">{pest.description}</p>
              <button type="button" className="bk-btn bk-btn-primary" onClick={goToForm}>
                {pest.cta}
              </button>
            </div>
          ))}
        </div>
      </section>



      {/* Protection With Purpose section */}
      <section className="bk-why-section">
        <div className="bk-why-inner">
          <div className="bk-why-header">
            <h2 className="bk-why-title">Protection With Purpose</h2>
            <p className="bk-why-subtitle">Every property deserves a thoughtful approach. At BuzzKill, we start by understanding your situation, solve the problem at its source, and help protect what matters most.</p>
          </div>
          <div className="bk-why-grid">
            <div className="bk-why-card">
              <img src="/images/icon-families-pets.png" alt="" className="bk-why-icon" aria-hidden="true" />
              <h3 className="bk-why-card-title">Safe for Families. Tough on Pests.</h3>
              <p className="bk-why-card-body">Thoughtfully applied pest control designed around your family, pets, and everyday life.</p>
            </div>
            <div className="bk-why-card">
              <img src="/images/icon-customized-solutions.png" alt="" className="bk-why-icon" aria-hidden="true" />
              <h3 className="bk-why-card-title">Understand. Solve. Protect.</h3>
              <p className="bk-why-card-body">Every treatment plan is built around your property, not a one-size-fits-all service.</p>
            </div>
            <div className="bk-why-card">
              <img src="/images/icon-reliable-trust.png" alt="" className="bk-why-icon" aria-hidden="true" />
              <h3 className="bk-why-card-title">Experience the BuzzKill Difference</h3>
              <p className="bk-why-card-body">Reliable technicians, clear communication, and professional service from your first visit to ongoing protection.</p>
            </div>
          </div>
        </div>
      </section>

      {/* CTA Banner */}
      <section className="bk-cta-banner">
        <div className="bk-cta-banner-inner">
          <p className="bk-cta-banner-text">
            Serving MA &amp; RI — speak with a local pest control expert at{" "}
            <a href="tel:+15082589294" className="bk-cta-banner-phone">508-258-9294</a>
          </p>
          <span className="bk-cta-banner-or">or</span>
          <Link to="/quote" className="bk-cta-banner-btn">Get Instant Quote</Link>
        </div>
      </section>

      {/* Service Areas */}
      <section className="bk-locations-section">
        <div className="bk-locations-inner">
          <div className="bk-locations-header">
            <p className="bk-locations-eyebrow">Service Areas</p>
            <h2 className="bk-locations-title">Protecting Massachusetts &amp; Rhode Island</h2>
            <span className="bk-locations-badge">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 1L15.09 7.26L22 8.27L17 13.14L18.18 20.02L12 16.77L5.82 20.02L7 13.14L2 8.27L8.91 7.26L12 1Z"/></svg>
              Licensed &amp; Insured
            </span>
          </div>
          <div className="bk-locations-grid">

            {/* Massachusetts */}
            <Link to="/locations/massachusetts" className="bk-location-card">
              <div className="bk-location-shape-wrap">
                <svg viewBox="0 0 540 280" className="bk-state-svg" aria-label="Massachusetts" role="img">
                  <defs>
                    <clipPath id="ma-clip">
                      <path d="M 3,24 L 140,25 L 303,19 L 363,10 L 401,3 L 403,22 L 414,38 L 428,38 L 422,50 L 390,68 L 371,87 Q 389,104 413,114 Q 421,140 426,154 L 433,189 L 418,186 L 404,204 L 385,206 L 376,216 L 361,222 L 351,249 L 256,143 L 114,141 L 69,138 L 3,138 Z" />
                      <path d="M 433,193 Q 431,219 482,210 L 534,201 L 531,171 L 523,156 L 517,146 Q 500,133 490,136 Q 510,132 517,137 L 526,181 Q 511,202 500,194 Q 479,197 453,189 L 435,191 Z" />
                    </clipPath>
                  </defs>
                  <path d="M 3,24 L 140,25 L 303,19 L 363,10 L 401,3 L 403,22 L 414,38 L 428,38 L 422,50 L 390,68 L 371,87 Q 389,104 413,114 Q 421,140 426,154 L 433,189 L 418,186 L 404,204 L 385,206 L 376,216 L 361,222 L 351,249 L 256,143 L 114,141 L 69,138 L 3,138 Z" />
                  <path d="M 433,193 Q 431,219 482,210 L 534,201 L 531,171 L 523,156 L 517,146 Q 500,133 490,136 Q 510,132 517,137 L 526,181 Q 511,202 500,194 Q 479,197 453,189 L 435,191 Z" />
                  <ellipse cx="434" cy="253" rx="28" ry="11" />
                  <ellipse cx="511" cy="268" rx="21" ry="6" />
                  <g clipPath="url(#ma-clip)" stroke="rgba(255,255,255,0.32)" strokeWidth="0.75" fill="none" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M 76,26 C 74,62 77,98 75,138" />
                    <path d="M 113,25 C 112,62 114,98 112,138" />
                    <path d="M 149,25 C 148,60 150,100 148,140" />
                    <path d="M 178,25 C 177,60 179,100 177,140" />
                    <path d="M 214,25 C 213,60 215,100 213,140" />
                    <path d="M 250,25 C 248,65 252,103 250,143" />
                    <path d="M 76,52 C 97,51 122,52 149,52" />
                    <path d="M 76,100 C 97,99 122,100 149,100" />
                    <path d="M 149,68 C 165,67 192,68 214,68" />
                    <path d="M 250,50 C 308,49 360,52 421,51" />
                    <path d="M 250,72 C 304,72 350,75 391,88" />
                    <path d="M 250,97 C 309,98 350,104 390,115" />
                    <path d="M 250,128 C 308,129 350,134 376,156" />
                    <path d="M 298,25 C 297,50 299,97 298,128" />
                    <path d="M 353,128 C 358,156 361,177 383,192" />
                    <path d="M 456,193 L 454,210" />
                    <path d="M 476,199 L 475,211" />
                    <path d="M 496,197 L 495,209" />
                    <path d="M 516,193 L 517,205" />
                  </g>
                </svg>
              </div>
              <div className="bk-location-label">
                <span className="bk-location-name">Massachusetts</span>
                <span className="bk-location-cta">View Services →</span>
              </div>
            </Link>

            {/* Rhode Island */}
            <Link to="/locations/rhode-island" className="bk-location-card">
              <div className="bk-location-shape-wrap">
                <svg viewBox="0 0 135 175" className="bk-state-svg" aria-label="Rhode Island" role="img">
                  <defs>
                    <clipPath id="ri-clip">
                      <path clipRule="evenodd" d="M 16,7 L 127,11 L 117,79 L 117,114 Q 100,117 89,114 L 71,120 Q 55,130 45,130 L 15,143 L 4,128 L 7,95 L 10,63 L 13,32 L 16,7 Z M 80,45 L 86,51 Q 100,74 89,114 L 71,120 Q 71,93 78,64 L 76,45 Z" />
                    </clipPath>
                  </defs>
                  <path fillRule="evenodd" d="M 16,7 L 127,11 L 117,79 L 117,114 Q 100,117 89,114 L 71,120 Q 55,130 45,130 L 15,143 L 4,128 L 7,95 L 10,63 L 13,32 L 16,7 Z M 80,45 L 86,51 Q 100,74 89,114 L 71,120 Q 71,93 78,64 L 76,45 Z" />
                  <ellipse cx="53" cy="168" rx="7" ry="5" />
                  <g clipPath="url(#ri-clip)" stroke="rgba(255,255,255,0.38)" strokeWidth="0.7" fill="none" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M 7,18 C 18,17 30,18 65,17" />
                    <path d="M 32,7 L 31,18 L 33,50 L 30,65" />
                    <path d="M 37,7 C 36,22 38,48 36,90" />
                    <path d="M 65,7 C 64,17 66,28 63,52" />
                    <path d="M 75,7 L 75,34 C 76,40 75,46 76,46" />
                    <path d="M 37,34 C 48,33 57,34 65,33" />
                    <path d="M 50,34 C 49,52 51,72 49,90" />
                    <path d="M 59,34 C 60,44 58,54 59,65" />
                    <path d="M 50,55 C 57,54 66,55 76,54" />
                    <path d="M 50,65 C 58,64 67,65 77,63" />
                    <path d="M 36,70 C 49,69 63,70 72,69" />
                    <path d="M 36,70 C 36,82 37,90 36,90" />
                    <path d="M 50,70 C 50,82 50,90 50,90" />
                    <path d="M 8,90 C 26,89 48,90 70,90" />
                    <path d="M 35,90 L 34,115 L 34,143" />
                    <path d="M 50,90 C 50,103 51,115 50,115" />
                    <path d="M 8,115 C 26,114 46,115 65,113" />
                    <path d="M 53,115 L 54,143" />
                    <path d="M 103,11 C 101,25 100,38 101,52" />
                    <path d="M 87,7 L 86,34 C 87,40 86,46 87,52" />
                    <path d="M 75,34 C 80,33 87,34 103,33" />
                  </g>
                </svg>
              </div>
              <div className="bk-location-label">
                <span className="bk-location-name">Rhode Island</span>
                <span className="bk-location-cta">View Services →</span>
              </div>
            </Link>

          </div>
        </div>
      </section>

      {/* Schedule Inspection CTA */}
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
              <p className="bk-schedule-eyebrow">Ready to Get Started?</p>
              <h2 className="bk-schedule-title">Get Started Today</h2>
              <p className="bk-schedule-sub">Appointments that work around your schedule — not ours. Available across Massachusetts &amp; Rhode Island.</p>
              <button type="button" className="bk-btn bk-schedule-cta" onClick={goToForm}>
                Get an Instant Quote
              </button>
            </div>
          </div>
        </div>
      </section>
      <FAQ
        eyebrow="Common Questions"
        title="Pest Control FAQs"
        items={HOME_FAQS}
      />

    </>
  );
}
