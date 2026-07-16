import ContactForm from "../components/ContactForm";
import SEO from "../components/SEO";

export default function RequestQuote() {
  return (
    <>
      <SEO
        title="Request a Free Quote | BuzzKill Pest Control"
        description="Request a free pest control quote from BuzzKill. Serving condos, HOAs, and residential properties across Massachusetts and Rhode Island."
      />
      <section style={{ padding: "80px 32px", maxWidth: 900, margin: "0 auto", textAlign: "center" }}>
        <p style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.2em", color: "var(--bk-green)", marginBottom: 12 }}>Get Started</p>
        <h1 style={{ fontSize: "clamp(2rem, 4vw, 3rem)", fontWeight: 700, marginBottom: 16 }}>Request a Free Quote</h1>
        <p style={{ fontSize: "1.05rem", color: "#555", lineHeight: 1.7, maxWidth: 620, margin: "0 auto 40px" }}>
          Tell us about your property and we'll get back to you with a tailored pest control plan. No commitment required.
        </p>
      </section>
      <ContactForm />
    </>
  );
}
