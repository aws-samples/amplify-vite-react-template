import { useParams, Navigate, useNavigate } from "react-router-dom";
import { CITY_BY_SLUG } from "../data/cities";
import FAQ from "../components/FAQ";
import ContactForm from "../components/ContactForm";
import SEO, { buildCitySchema, buildBreadcrumbSchema, buildFAQSchema } from "../components/SEO";

export default function CityPage() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const city = slug ? CITY_BY_SLUG[slug] : undefined;

  if (!city) return <Navigate to="/" replace />;

  const { city: name, state, stateAbbr } = city;
  const fullLocation = `${name}, ${stateAbbr}`;

  const goToForm = () => {
    const el = document.getElementById("form");
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const cityFaqs = [
    { q: `Do you service condos and HOAs in ${name}?`, a: `Yes! BuzzKill provides professional pest control for condominiums, HOAs, and multi-unit communities throughout ${name}, ${stateAbbr} and surrounding areas.` },
    { q: "Is in-unit service required?", a: `No. In-unit service is optional and scheduled directly by ${name} unit owners. The HOA contract covers common areas only.` },
    { q: `How do I get a quote for my ${name} property?`, a: "Fill out the form below with your property details and we'll provide a quote within one business day. Or call us at 508-258-9294." },
  ];

  return (
    <>
      <SEO
        title={`${name} Pest Control | HOA & Condo Service in ${stateAbbr}`}
        description={`Professional HOA and condo pest control in ${name}, ${stateAbbr}. Common-area pest management for boards and property managers, with optional discounted in-unit service for ${name} condo owners.`}
        jsonLd={[
          buildCitySchema(name, stateAbbr, state, city.slug),
          buildBreadcrumbSchema([
            { name: "Home", url: "/" },
            { name: "Pest Control", url: "/" },
            { name: `${name}, ${stateAbbr}`, url: `/pest-control/${city.slug}` },
          ]),
          buildFAQSchema(cityFaqs),
        ]}
      />
      {/* Hero */}
      <section className="bk-section bk-section-light">
        <div className="bk-container bk-narrow">
          <div className="bk-eyebrow">Pest Control in {fullLocation}</div>
          <h1 className="bk-h1-lower">
            {name} Pest Control
          </h1>
          <p className="bk-body-lead">
            BuzzKill Pest Control provides professional pest management for
            condominiums, HOAs, and shared living communities in{" "}
            <strong>{fullLocation}</strong>. We specialize in common-area pest
            control for boards and property managers, with optional discounted
            in-unit service for owners.
          </p>
          <div style={{ display: "flex", gap: 14, marginTop: 24, flexWrap: "wrap" }}>
            <button type="button" className="bk-btn bk-btn-primary" onClick={goToForm}>
              Request a Free Quote
            </button>
            <button
              type="button"
              className="bk-btn bk-btn-outline"
              onClick={() => navigate("/condo-services")}
            >
              HOA Services
            </button>
          </div>
        </div>
      </section>

      {/* Why BuzzKill in this city */}
      <section className="bk-section bk-section-cream">
        <div className="bk-container bk-narrow">
          <div className="bk-eyebrow">Why BuzzKill</div>
          <h2 className="bk-h2">
            Condo &amp; HOA Pest Control in {name}
          </h2>
          <p className="bk-body-lead">
            Most pest issues in {name} condos and HOAs don't respect unit
            boundaries. That's why we focus on building-wide prevention and
            consistent service—not one-off reactions. Our {state}-licensed
            technicians understand the pest pressures unique to the{" "}
            {stateAbbr === "MA"
              ? "Greater Boston and MetroWest"
              : "Rhode Island"}{" "}
            area.
          </p>
        </div>
      </section>

      {/* Services */}
      <section className="bk-section bk-section-light">
        <div className="bk-container">
          <h2 className="bk-h2 bk-center">
            Our Services in {fullLocation}
          </h2>
          <div className="bk-why-grid" style={{ marginTop: 48 }}>
            <div className="bk-why-item">
              <h3 className="bk-h4">HOA Common-Area Pest Control</h3>
              <p className="bk-p">
                Scheduled service for basements, utility rooms, trash areas,
                hallways, exterior perimeters, and shared spaces in {name}{" "}
                condominiums.
              </p>
            </div>
            <div className="bk-why-item">
              <h3 className="bk-h4">{"In‑Unit Service for Owners"}</h3>
              <p className="bk-p">
                Optional, discounted pest control for individual units—scheduled
                and paid online when BuzzKill is already onsite in your {name}{" "}
                community.
              </p>
            </div>
            <div className="bk-why-item">
              <h3 className="bk-h4">Preventative Programs</h3>
              <p className="bk-p">
                Monthly, bi-monthly, or quarterly service plans designed to
                reduce recurring pest pressure across your entire {name}{" "}
                property.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="bk-section bk-section-dark">
        <div className="bk-container bk-narrow">
          <div className="bk-eyebrow" style={{ color: "var(--bk-green)" }}>How It Works</div>
          <h2 className="bk-h2 bk-on-dark">
            Simple, Efficient Pest Control for {name} Communities
          </h2>
          <ul className="bk-bullets">
            <li>
              Your {name} association receives consistent, scheduled pest
              control for common areas—done professionally, with minimal
              disruption.
            </li>
            <li>
              About a week before our visit, {name} unit owners can schedule and
              pay online for discounted in-unit treatment.
            </li>
            <li>
              Everything is grouped onsite—owners get convenience and lower
              pricing, and the community benefits from a building-wide approach.
            </li>
          </ul>
        </div>
      </section>

      {/* Why choose us */}
      <section className="bk-section bk-section-cream">
        <div className="bk-container">
          <h2 className="bk-h2 bk-center">
            Why {name} Property Managers Choose BuzzKill
          </h2>
          <div className="bk-why-grid" style={{ marginTop: 48 }}>
            <div className="bk-why-item">
              <h3 className="bk-h4">Condo-Specific Expertise</h3>
              <p className="bk-p">
                We understand shared walls, common infrastructure, and the
                recurring pest patterns in {name} multi-unit buildings.
              </p>
            </div>
            <div className="bk-why-item">
              <h3 className="bk-h4">Safety-First Approach</h3>
              <p className="bk-p">
                Methods and products appropriate for occupied {name} homes.
                We follow all label directions and {state} regulatory
                requirements.
              </p>
            </div>
            <div className="bk-why-item">
              <h3 className="bk-h4">Professional Communication</h3>
              <p className="bk-p">
                Clear scheduling, consistent service, and board-friendly
                documentation for your {name} HOA records.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <FAQ
        eyebrow={fullLocation}
        title="FAQs"
        items={[
          {
            q: `Do you service condos and HOAs in ${name}?`,
            a: `Yes! BuzzKill provides professional pest control for condominiums, HOAs, and multi-unit communities throughout ${name}, ${stateAbbr} and surrounding areas.`,
          },
          {
            q: "Is in-unit service required?",
            a: `No. In-unit service is optional and scheduled directly by ${name} unit owners. The HOA contract covers common areas only.`,
          },
          {
            q: `How do I get a quote for my ${name} property?`,
            a: "Fill out the form below with your property details and we'll provide a quote within one business day. Or call us at 508-258-9294.",
          },
        ]}
      />

      {/* Contact form */}
      <ContactForm
        eyebrow={`Pest Control in ${fullLocation}`}
        title={`Get a Free Quote for ${name}`}
        intro={`Tell us about your ${name} property and we'll provide a custom pest control quote within one business day.`}
      />
    </>
  );
}
