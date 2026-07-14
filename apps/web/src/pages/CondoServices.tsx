import { useNavigate } from "react-router-dom";
import FAQ from "../components/FAQ";
import ContactForm from "../components/ContactForm";
import SEO, { buildServiceSchema, buildBreadcrumbSchema, buildFAQSchema } from "../components/SEO";

const CONDO_FAQS = [
  { q: "Do you require owner participation?", a: "No. Owner participation is optional. The HOA contract remains separate from any owner in‑unit service." },
  { q: "Can you service multiple buildings within a community?", a: "Yes. We can set up one program that covers all buildings and common areas, with clear scheduling." },
  { q: "Do you provide reports or notes after service?", a: "Yes—service notes are provided in a format that works for property management and board records." },
];

export default function CondoServices() {
  const navigate = useNavigate();
  const goToForm = () => {
    const el = document.getElementById("form");
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <>
      <SEO
        title="HOA & Condo Common-Area Pest Control"
        description="Reliable common-area pest control for condominiums, HOAs, and multi-unit communities in Massachusetts and Rhode Island. Preventative programs with board-friendly documentation."
        jsonLd={[
          buildServiceSchema(
            "HOA & Condo Common-Area Pest Control",
            "Preventative pest control for HOA-owned areas, building exteriors, basements, utility rooms, and shared spaces in multi-unit residential communities.",
            "/condo-services",
          ),
          buildBreadcrumbSchema([
            { name: "Home", url: "/" },
            { name: "Condo Services", url: "/condo-services" },
          ]),
          buildFAQSchema(CONDO_FAQS),
        ]}
      />
      {/* Hero */}
      <section className="bk-section bk-section-light">
        <div className="bk-container bk-narrow">
          <div className="bk-eyebrow">For HOA Boards &amp; Property Managers</div>
          <h1 className="bk-h1-lower">Condo Services</h1>
          <h2 className="bk-h2" style={{ marginTop: 24 }}>
            HOA &amp; Condo Common-Area Pest Control
          </h2>
          <p className="bk-body-lead">
            BuzzKill provides reliable common-area pest control for
            condominiums, HOAs, and multi-unit residential communities. Our
            programs are designed to reduce pest pressure at the building
            level&mdash;so issues don&rsquo;t keep cycling back from shared
            spaces.
          </p>
          <div style={{ display: "flex", gap: 14, marginTop: 24, flexWrap: "wrap" }}>
            <button type="button" className="bk-btn bk-btn-primary" onClick={goToForm}>
              Request HOA Proposal
            </button>
          </div>
        </div>
      </section>

      {/* What Common-Area Pest Control Covers */}
      <section className="bk-section bk-section-cream">
        <div className="bk-container bk-narrow">
          <div className="bk-eyebrow">What&rsquo;s Covered</div>
          <h2 className="bk-h2">What Common-Area Pest Control Covers</h2>
          <p className="bk-body-lead">
            Every community is different, but common-area service often
            includes:
          </p>
          <ul className="bk-bullets">
            <li>Building exterior perimeter monitoring and treatment as needed</li>
            <li>Basements and foundation areas</li>
            <li>Trash and recycling rooms, compactors, dumpsters (as applicable)</li>
            <li>Mechanical / utility rooms and chase areas where pests travel</li>
            <li>Hallways / common corridors (as appropriate)</li>
            <li>Entry points and pest pressure zones identified during inspection</li>
          </ul>
          <p className="bk-p">
            {"We\u2019ll tailor scope to your building layout and association needs."}
          </p>
          <div style={{ marginTop: 24 }}>
            <button
              type="button"
              className="bk-btn bk-btn-outline"
              onClick={() => navigate("/in-unit-services")}
            >
              {"Learn About In\u2011Unit Service"}
            </button>
          </div>
        </div>
      </section>

      {/* A Preventative Program Built for Shared Living */}
      <section className="bk-section bk-section-light">
        <div className="bk-container">
          <h2 className="bk-h2 bk-center">A Preventative Program Built for Shared Living</h2>
          <p className="bk-body-lead bk-center" style={{ maxWidth: 760, margin: "0 auto 28px" }}>
            Condo pest control requires a different mindset than single-family
            homes. Our approach emphasizes:
          </p>
          <div className="bk-why-grid" style={{ marginTop: 48 }}>
            <div className="bk-why-item">
              <h3 className="bk-h4">Consistent scheduling</h3>
              <p className="bk-p">
                {"Monthly, bi\u2011monthly, or quarterly service plans to maintain control and reduce recurring issues."}
              </p>
            </div>
            <div className="bk-why-item">
              <h3 className="bk-h4">Monitoring and documentation</h3>
              <p className="bk-p">
                We track pest activity patterns and provide board-friendly notes
                that help you make informed decisions.
              </p>
            </div>
            <div className="bk-why-item">
              <h3 className="bk-h4">Practical recommendations</h3>
              <p className="bk-p">
                {"We\u2019ll flag conditions that attract pests (trash handling, clutter in storage areas, entry points, moisture issues) and recommend improvements that help reduce pressure over time."}
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* How it works — owner add-on flow */}
      <section className="bk-section bk-section-cream">
        <div className="bk-container bk-narrow">
          <div className="bk-eyebrow">How it works</div>
          <h2 className="bk-h2">Owner Add-On, Done Cleanly</h2>
          <ul className="bk-bullets">
            <li>
              Prior to the common-area visit, BuzzKill provides a
              property-specific scheduling + payment link
            </li>
            <li>The property manager can send it as an announcement to owners</li>
            <li>Owners who want service schedule and pay online</li>
            <li>{"In\u2011unit appointments are grouped onsite during the scheduled visit window"}</li>
          </ul>
          <p className="bk-body-lead" style={{ marginTop: 16 }}>
            This improves building-wide results while offering owners
            convenience and a discount.
          </p>
        </div>
      </section>

      {/* What Boards and Property Managers Get */}
      <section className="bk-section bk-section-dark">
        <div className="bk-container bk-narrow">
          <div className="bk-eyebrow" style={{ color: "var(--bk-green)" }}>For Boards &amp; PMs</div>
          <h2 className="bk-h2 bk-on-dark">What Boards and Property Managers Get</h2>
          <ul className="bk-bullets">
            <li>Predictable common-area service schedule</li>
            <li>Clear communication and professional onsite presence</li>
            <li>Documentation suitable for HOA records</li>
            <li>A simple owner upsell option (without the HOA handling payments)</li>
            <li>An approach aligned with resident comfort and safety</li>
          </ul>
        </div>
      </section>

      <FAQ
        eyebrow="HOA / Common-Area"
        title="FAQs"
        items={[
          {
            q: "Do you require owner participation?",
            a: "No. Owner participation is optional. The HOA contract remains separate from any owner in\u2011unit service.",
          },
          {
            q: "Can you service multiple buildings within a community?",
            a: "Yes. We can set up one program that covers all buildings and common areas, with clear scheduling.",
          },
          {
            q: "Do you provide reports or notes after service?",
            a: "Yes\u2014service notes are provided in a format that works for property management and board records.",
          },
        ]}
      />

      <ContactForm />
    </>
  );
}
