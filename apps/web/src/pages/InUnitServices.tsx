import FAQ from "../components/FAQ";
import ContactForm from "../components/ContactForm";
import SEO, { buildServiceSchema, buildBreadcrumbSchema, buildFAQSchema } from "../components/SEO";

const INUNIT_FAQS = [
  { q: "Do I need in‑unit service if the HOA treats common areas?", a: "Not always. But in‑unit service can help if you’re actively seeing pest activity, or if your building has recurring pressure." },
  { q: "How much does it cost?", a: "Pricing varies by service type and issue. When available, HOA-onsite pricing will be clearly shown during booking." },
  { q: "Is it safe for kids and pets?", a: "We prioritize methods suitable for occupied homes and apply all products according to label and regulations. You’ll receive any guidance needed for your specific service." },
];

export default function InUnitServices() {
  const goToForm = () => {
    const el = document.getElementById("form");
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <>
      <SEO
        title="In-Unit Pest Control for Condo Owners"
        description="Optional, discounted in-unit pest control timed with your HOA's common-area service days. Schedule and pay online for convenient, grouped appointments in Massachusetts and Rhode Island."
        jsonLd={[
          buildServiceSchema(
            "In-Unit Pest Control for Condo Owners",
            "Optional, discounted in-unit pest control for condo owners, timed with HOA common-area service visits for convenience and savings.",
            "/in-unit-services",
          ),
          buildBreadcrumbSchema([
            { name: "Home", url: "/" },
            { name: "In-Unit Services", url: "/in-unit-services" },
          ]),
          buildFAQSchema(INUNIT_FAQS),
        ]}
      />
      {/* Hero */}
      <section className="bk-section bk-section-light">
        <div className="bk-container bk-narrow">
          <div className="bk-eyebrow">For Unit Owners</div>
          <h1 className="bk-h1-lower">In-Unit Services</h1>
          <p className="bk-body-lead">
            {"If BuzzKill is already scheduled to service your community\u2019s common areas, you may be able to book discounted in\u2011unit pest control during the same visit window."}
          </p>
          <h2 className="bk-h3" style={{ marginTop: 24 }}>
            {"It\u2019s simple:"}
          </h2>
          <ul className="bk-bullets">
            <li>Schedule online</li>
            <li>Pay online</li>
            <li>We arrive during the scheduled window and complete the service efficiently.</li>
          </ul>
          <div style={{ display: "flex", gap: 14, marginTop: 24, flexWrap: "wrap" }}>
            <button type="button" className="bk-btn bk-btn-primary" onClick={goToForm}>
              {"Schedule In\u2011Unit Service"}
            </button>
          </div>
        </div>
      </section>

      {/* What In-Unit Service Typically Includes */}
      <section className="bk-section bk-section-cream">
        <div className="bk-container bk-narrow">
          <div className="bk-eyebrow">What&rsquo;s Included</div>
          <h2 className="bk-h2">{"What In\u2011Unit Service Typically Includes"}</h2>
          <p className="bk-body-lead">
            {"In\u2011unit service is customized to the issue and unit layout, but commonly includes:"}
          </p>
          <ul className="bk-bullets">
            <li>Inspection of key pest activity areas (kitchen, bath, entry points)</li>
            <li>Targeted treatment where appropriate</li>
            <li>Guidance on prevention and best practices</li>
            <li>Follow-up recommendations if needed</li>
          </ul>
          <p className="bk-p">
            We prioritize methods that are appropriate for occupied homes and
            follow all label directions and any applicable re-entry guidance.
          </p>
        </div>
      </section>

      {/* Preparing for Your Appointment */}
      <section className="bk-section bk-section-light">
        <div className="bk-container bk-narrow">
          <div className="bk-eyebrow">Get Ready</div>
          <h2 className="bk-h2">Preparing for Your Appointment</h2>
          <p className="bk-body-lead">To make service quick and effective:</p>
          <ul className="bk-bullets">
            <li>Ensure access to kitchen / bath areas</li>
            <li>Move small items away from baseboards if possible</li>
            <li>Keep pets secured during the visit</li>
            <li>Follow any instructions included in your confirmation email</li>
          </ul>
        </div>
      </section>

      {/* Why Schedule During the HOA Service Window? */}
      <section className="bk-section bk-section-dark">
        <div className="bk-container">
          <h2 className="bk-h2 bk-center bk-on-dark">
            Why Schedule During the HOA Service Window?
          </h2>
          <div className="bk-why-grid" style={{ marginTop: 48 }}>
            <div className="bk-why-item">
              <h3 className="bk-h4 bk-on-dark">Discounted and efficient</h3>
              <p className="bk-p bk-on-dark-soft">
                {"Because we\u2019re already onsite for common-area service, we can group in\u2011unit appointments\u2014saving time and reducing cost."}
              </p>
            </div>
            <div className="bk-why-item">
              <h3 className="bk-h4 bk-on-dark">Better building-wide results</h3>
              <p className="bk-p bk-on-dark-soft">
                When both common areas and select units are treated, the
                community often experiences improved overall control.
              </p>
            </div>
            <div className="bk-why-item">
              <h3 className="bk-h4 bk-on-dark">Convenient scheduling</h3>
              <p className="bk-p bk-on-dark-soft">
                {"No waiting weeks for a separate visit\u2014book your spot while BuzzKill is already scheduled."}
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* How Scheduling Works */}
      <section className="bk-section bk-section-cream">
        <div className="bk-container bk-narrow">
          <div className="bk-eyebrow">Step-by-Step</div>
          <h2 className="bk-h2">How Scheduling Works</h2>
          <ul className="bk-bullets">
            <li>Choose your property and unit</li>
            <li>Select a time window</li>
            <li>Pay online</li>
            <li>Receive confirmation</li>
            <li>BuzzKill completes service onsite during the scheduled window</li>
          </ul>
        </div>
      </section>

      <FAQ
        eyebrow="in-unit"
        title="FAQs"
        items={[
          {
            q: "Do I need in\u2011unit service if the HOA treats common areas?",
            a: "Not always. But in\u2011unit service can help if you\u2019re actively seeing pest activity, or if your building has recurring pressure.",
          },
          {
            q: "How much does it cost?",
            a: "Pricing varies by service type and issue. When available, HOA-onsite pricing will be clearly shown during booking.",
          },
          {
            q: "Is it safe for kids and pets?",
            a: "We prioritize methods suitable for occupied homes and apply all products according to label and regulations. You\u2019ll receive any guidance needed for your specific service.",
          },
        ]}
      />

      <ContactForm />
    </>
  );
}
