import QuoteCTA from "../components/QuoteCTA";
import SEO from "../components/SEO";

export default function RIServiceArea() {
  return (
    <>
      <SEO description="BuzzKill Pest Control services across Rhode Island — residential, commercial, and HOA pest control." />
      <section style={{ padding: "80px 32px", maxWidth: 900, margin: "0 auto", textAlign: "center" }}>
        <p style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.2em", color: "var(--bk-green)", marginBottom: 12 }}>Service Area</p>
        <h1 style={{ fontSize: "clamp(2rem, 4vw, 3rem)", fontWeight: 700, marginBottom: 16 }}>Rhode Island Pest Control</h1>
        <p style={{ fontSize: "1.05rem", color: "#555", lineHeight: 1.7, maxWidth: 620, margin: "0 auto 40px" }}>
          BuzzKill provides licensed, pet-safe pest control across Rhode Island — serving residential homes, condominiums, HOA communities, and commercial properties.
        </p>
        <p style={{ color: "#999", fontSize: "0.9rem" }}>Detailed service information coming soon.</p>
      </section>
      <QuoteCTA />
    </>
  );
}
