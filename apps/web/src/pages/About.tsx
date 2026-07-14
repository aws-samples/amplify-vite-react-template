import { useNavigate } from "react-router-dom";
import ContactForm from "../components/ContactForm";
import SEO, { buildBreadcrumbSchema } from "../components/SEO";

export default function About() {
  const navigate = useNavigate();
  const goToForm = () => {
    const el = document.getElementById("form");
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <>
      <SEO
        title="About BuzzKill Pest Control"
        description="BuzzKill Pest Control specializes in condo and HOA pest management across Massachusetts and Rhode Island. Building-wide prevention, professional communication, and owner convenience."
        jsonLd={buildBreadcrumbSchema([
          { name: "Home", url: "/" },
          { name: "About", url: "/about" },
        ])}
      />
      <section className="bk-section bk-section-light">
        <div className="bk-container bk-narrow">
          <div className="bk-eyebrow">About BuzzKill</div>
          <h1 className="bk-h1-lower">About</h1>
          <p className="bk-body-lead">
            BuzzKill Pest Control was built to solve a common problem in shared
            living communities: pest issues that keep coming back because common
            areas and units are treated separately&mdash;or not treated
            consistently.
          </p>
          <p className="bk-p">
            We specialize in condo and HOA pest management with a model designed
            for building-wide prevention, professional communication, and owner
            convenience.
          </p>
          <div style={{ display: "flex", gap: 14, marginTop: 32, flexWrap: "wrap" }}>
            <button
              type="button"
              className="bk-btn bk-btn-primary"
              onClick={() => navigate("/condo-services")}
            >
              Condo Services
            </button>
            <button
              type="button"
              className="bk-btn bk-btn-outline"
              onClick={() => navigate("/in-unit-services")}
            >
              {"In\u2011Unit Services"}
            </button>
          </div>
        </div>
      </section>

      {/* Our Mission */}
      <section className="bk-section bk-section-cream">
        <div className="bk-container bk-narrow">
          <div className="bk-eyebrow">Our Mission</div>
          <h2 className="bk-h2">To Deliver Pest Control That Is:</h2>
          <ul className="bk-bullets">
            <li>Safe for families</li>
            <li>Tough on pests</li>
            <li>Designed for condos and HOAs</li>
            <li>Easy to schedule and manage</li>
          </ul>
        </div>
      </section>

      {/* What Makes BuzzKill Different */}
      <section className="bk-section bk-section-light">
        <div className="bk-container">
          <h2 className="bk-h2 bk-center">What Makes BuzzKill Different</h2>
          <div className="bk-why-grid" style={{ marginTop: 48 }}>
            <div className="bk-why-item">
              <h3 className="bk-h4">Condo-first expertise</h3>
              <p className="bk-p">
                We focus on the areas where pests travel and hide in multi-unit
                buildings&mdash;shared spaces, utility areas, basements, and
                perimeter pressure zones.
              </p>
            </div>
            <div className="bk-why-item">
              <h3 className="bk-h4">Prevention over panic</h3>
              <p className="bk-p">
                Our programs are built around reducing pest pressure long-term,
                not just responding to complaints.
              </p>
            </div>
            <div className="bk-why-item">
              <h3 className="bk-h4">Simple coordination for owners</h3>
              <p className="bk-p">
                {"When we\u2019re already onsite for HOA service, owners can schedule discounted in\u2011unit service online\u2014without burdening the HOA or property manager with payments or manual scheduling."}
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Safety and Professional Standards */}
      <section className="bk-section bk-section-cream">
        <div className="bk-container bk-narrow">
          <div className="bk-eyebrow">Safety</div>
          <h2 className="bk-h2">Safety and Professional Standards</h2>
          <p className="bk-body-lead">
            BuzzKill follows all applicable Massachusetts requirements and label
            directions for products used. We prioritize methods appropriate for
            occupied homes and shared communities and provide guidance as needed
            for residents.
          </p>
        </div>
      </section>

      {/* Want to Work With BuzzKill? */}
      <section className="bk-section bk-section-dark">
        <div className="bk-container bk-narrow bk-center">
          <h2 className="bk-h2 bk-on-dark">Want to Work With BuzzKill?</h2>
          <p className="bk-body-lead bk-on-dark-soft">
            {"If you\u2019re an HOA board member or property manager, we\u2019ll build a clean service plan for your community. If you\u2019re a condo owner, you can schedule in\u2011unit service when available."}
          </p>
          <div style={{ display: "flex", gap: 14, justifyContent: "center", flexWrap: "wrap", marginTop: 24 }}>
            <button type="button" className="bk-btn bk-btn-primary" onClick={goToForm}>
              Contact / Request Proposal
            </button>
          </div>
        </div>
      </section>

      <ContactForm />
    </>
  );
}
