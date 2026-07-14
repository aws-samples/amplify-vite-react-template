import { useNavigate } from "react-router-dom";
import Hero from "../components/Hero";
import NumberedSteps from "../components/NumberedSteps";
import WhyUs from "../components/WhyUs";
import FAQ from "../components/FAQ";
import ContactForm from "../components/ContactForm";
import SEO, {
  ORG_SCHEMA,
  LOCAL_BUSINESS_SCHEMA,
  WEBSITE_SCHEMA,
  buildFAQSchema,
} from "../components/SEO";

const HOME_FAQS = [
  {
    q: "Do you only work with condos / HOAs?",
    a: "Our primary focus is condos and HOAs, because that’s where our model provides the most value.",
  },
  {
    q: "Is in‑unit service required?",
    a: "No. In‑unit service is optional and scheduled directly by the unit owner.",
  },
  {
    q: "Do you coordinate communication to owners?",
    a: "Yes—BuzzKill provides a scheduling / payment link and suggested announcement copy; your property manager can distribute it to owners.",
  },
];

export default function Home() {
  const navigate = useNavigate();
  const goToForm = () => {
    const el = document.getElementById("form");
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <>
      <SEO
        description="Professional pest control for condominiums, HOAs, and shared living communities across Massachusetts and Rhode Island. Common-area pest management and optional discounted in-unit service."
        jsonLd={[ORG_SCHEMA, LOCAL_BUSINESS_SCHEMA, WEBSITE_SCHEMA, buildFAQSchema(HOME_FAQS)]}
      />
      <Hero
        image="/images/hero-home-1.jpg"
        video="/images/hero-video.mp4"
        eyebrow="Massachusetts HOA & Condo Pest Control"
        headline={
          <>
            Safe for Families.
            <br />
            <em>Tough on Pests.</em>
          </>
        }
        sub={
          <>
            Built for condos.
            <br />
            Built for convenience.
            <br />
            Built for peace of mind.
          </>
        }
        body={
          "BuzzKill Pest Control provides professional pest control for condominiums, HOAs, and shared living communities across Massachusetts. We specialize in common-area pest management for boards and property managers\u2014then offer optional, discounted in\u2011unit service for owners when we\u2019re already onsite."
        }
        primaryCta={{ label: "Request HOA Proposal", onClick: goToForm }}
        secondaryCta={{ label: "Schedule In\u2011Unit Service", onClick: goToForm }}
      />

      {/* Smart Way intro */}
      <section className="bk-section bk-section-light">
        <div className="bk-container bk-narrow bk-center">
          <h2 className="bk-h2">
            Condo &amp; HOA Pest Control,
            <br />
            Done the Smart Way
          </h2>
          <p className="bk-body-lead">
            {"Most pest issues in condos don\u2019t respect unit boundaries. That\u2019s why we focus on building-wide prevention and consistent service\u2014not one\u2011off reactions."}
          </p>
          <div style={{ display: "flex", gap: 14, justifyContent: "center", flexWrap: "wrap", marginTop: 16 }}>
            <button type="button" className="bk-btn bk-btn-primary" onClick={goToForm}>
              {"Schedule In\u2011Unit Service"}
            </button>
          </div>
        </div>
      </section>

      {/* What we do best */}
      <section className="bk-section bk-section-cream">
        <div className="bk-container bk-narrow">
          <div className="bk-eyebrow">What we do best</div>
          <ul className="bk-bullets">
            <li>
              HOA common-area pest control (basements, utility rooms, trash
              areas, exterior perimeter, common hallways, shared spaces)
            </li>
            <li>{"Optional in\u2011unit service for owners"}</li>
            <li>Preventative programs designed for shared living</li>
            <li>Clear reporting for boards and property managers</li>
          </ul>
          <button
            type="button"
            className="bk-btn bk-btn-dark"
            onClick={() => navigate("/in-unit-services")}
          >
            {"Learn About In\u2011Unit Service"}
          </button>
        </div>
      </section>

      <NumberedSteps
        eyebrow="The Model"
        title={<>How Our Condo &amp; HOA Model Works</>}
        steps={[
          {
            title: "We service common areas (HOA contract)",
            body:
              "Your association receives consistent, scheduled pest control for common areas\u2014done professionally, with minimal disruption.",
          },
          {
            title: "Owners can add discounted in\u2011unit service",
            body:
              "About a week before our scheduled visit, owners can choose to schedule and pay online for in\u2011unit treatment during the same visit window.",
          },
          {
            title: "Everything is grouped onsite (efficient + affordable)",
            body:
              "Owners get convenience and lower pricing. The community benefits from a stronger, building-wide approach.",
          },
        ]}
      />

      <section className="bk-section bk-section-light bk-center">
        <div className="bk-container">
          <button
            type="button"
            className="bk-btn bk-btn-outline"
            onClick={() => navigate("/condo-services")}
          >
            {"See HOA / Common\u2011Area Services"}
          </button>
        </div>
      </section>

      <WhyUs
        title="Why HOAs and Property Managers Choose BuzzKill"
        items={[
          {
            title: "Condo-specific expertise",
            body:
              "We understand shared walls, common infrastructure spaces, and recurring patterns that drive pest pressure in multi-unit buildings.",
          },
          {
            title: "Safety-first mindset",
            body:
              "We prioritize methods and products appropriate for occupied spaces and follow all label and regulatory requirements. We\u2019ll always provide any applicable guidance for residents.",
          },
          {
            title: "Professional communication",
            body: "Clear scheduling, consistent service, and board-friendly documentation.",
          },
        ]}
      />

      <section className="bk-section bk-section-light bk-center">
        <div className="bk-container">
          <button
            type="button"
            className="bk-btn bk-btn-outline"
            onClick={() => navigate("/about")}
          >
            Learn More
          </button>
        </div>
      </section>

      <FAQ
        eyebrow="BuzzKill"
        title="FAQs"
        items={[
          {
            q: "Do you only work with condos / HOAs?",
            a: "Our primary focus is condos and HOAs, because that\u2019s where our model provides the most value.",
          },
          {
            q: "Is in\u2011unit service required?",
            a: "No. In\u2011unit service is optional and scheduled directly by the unit owner.",
          },
          {
            q: "Do you coordinate communication to owners?",
            a: "Yes\u2014BuzzKill provides a scheduling / payment link and suggested announcement copy; your property manager can distribute it to owners.",
          },
        ]}
      />

      {/* Two service tiles */}
      <section className="bk-section bk-section-cream">
        <div className="bk-container">
          <div className="bk-eyebrow bk-center">Services</div>
          <h2 className="bk-h2 bk-center">Two Programs, One Visit</h2>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
              gap: 32,
              marginTop: 48,
            }}
          >
            <div className="bk-step">
              <h3 className="bk-h3">HOA Common-Area Pest Control</h3>
              <p className="bk-p">
                Preventative service for HOA-owned areas and building exteriors.
              </p>
              <button
                type="button"
                className="bk-btn bk-btn-dark"
                onClick={() => navigate("/condo-services")}
              >
                Learn More
              </button>
            </div>
            <div className="bk-step">
              <h3 className="bk-h3">{"In\u2011Unit Pest Control for Owners"}</h3>
              <p className="bk-p">
                {"Optional, discounted in\u2011unit service timed with common-area service days."}
              </p>
              <button
                type="button"
                className="bk-btn bk-btn-outline"
                onClick={() => navigate("/in-unit-services")}
              >
                Learn More
              </button>
            </div>
          </div>
        </div>
      </section>

      <ContactForm />
    </>
  );
}
