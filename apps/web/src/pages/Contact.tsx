import { useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import SEO, { buildBreadcrumbSchema } from "../components/SEO";
import { submitLead } from "../lib/leadIntakeApi";
import { trackFormSubmit, trackGenerateLead, trackAdsConversion, ADS_CONVERSIONS } from "../lib/analytics";

const OFFICE_PHONE = "508-258-9294";
const OFFICE_TEL = `tel:+1${OFFICE_PHONE.replace(/\D/g, "")}`;
const CONSENT_TEXT = "I agree BuzzKill may contact me about my inquiry.";

type Status = "idle" | "submitting" | "success" | "error";

export default function Contact() {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [propertyType, setPropertyType] = useState("Residential");
  const [reason, setReason] = useState("General question");
  const [message, setMessage] = useState("");
  const [consent, setConsent] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (status === "submitting") return;
    setErrorMsg(null);

    const trimmedName = name.trim();
    if (!trimmedName || (!phone.trim() && !email.trim())) {
      setErrorMsg("Please enter your name and a phone number or email so we can reach you.");
      return;
    }
    if (!consent) {
      setErrorMsg("Please check the box so we know it's okay to contact you.");
      return;
    }

    setStatus("submitting");
    const [first, ...rest] = trimmedName.split(/\s+/);
    const result = await submitLead({
      first,
      last: rest.join(" ") || undefined,
      phone: phone.trim() || undefined,
      email: email.trim() || undefined,
      propertyType: propertyType as "Residential" | "Association" | "Specialty",
      reason,
      message: message.trim() || undefined,
      formId: "contact",
      consentToContact: true,
      consentText: CONSENT_TEXT,
    });

    if (result.ok) {
      setStatus("success");
      trackFormSubmit("contact", "success", { lead_id: result.leadId });
      trackGenerateLead("contact", result.leadId);
      trackAdsConversion(ADS_CONVERSIONS.QUOTE_COMPLETED);
    } else {
      setStatus("error");
      setErrorMsg(result.error);
      trackFormSubmit("contact", "error", { error: result.error });
    }
  }

  return (
    <>
      <SEO
        title="Contact Us"
        description="Questions or ready to get started? Reach the BuzzKill team — local, licensed, and easy to reach across Massachusetts and Rhode Island."
        jsonLd={buildBreadcrumbSchema([
          { name: "Home", url: "/" },
          { name: "Contact", url: "/contact" },
        ])}
      />

      <section className="bk-section bk-section-cream bk-contact-hero">
        <div className="bk-container bk-contact-layout">
          <div className="bk-contact-visual">
            <img
              src="/images/contact-hero.png"
              alt=""
              aria-hidden="true"
              className="bk-contact-photo"
            />
          </div>

          <div className="bk-contact-form-col">
            <p className="bk-eyebrow">Get In Touch</p>
            <h1 className="bk-h1-lower">Let&rsquo;s Talk About Your Property</h1>
            <p className="bk-body-lead">
              Questions, quotes, or just not sure where to start? Tell us a bit about
              what&rsquo;s going on and a local BuzzKill expert will follow up.
            </p>

            {status === "success" ? (
              <div className="bk-contact-success">
                <h2>We&rsquo;ve got it!</h2>
                <p>Someone from our team will reach out to you shortly.</p>
                <p className="bk-modal-fallback">
                  Need help right now? Call <a href={OFFICE_TEL}>{OFFICE_PHONE}</a>.
                </p>
              </div>
            ) : (
              <form onSubmit={handleSubmit} noValidate className="bk-form-step bk-contact-form">
                <div className="bk-field bk-full">
                  <label htmlFor="ct-name">Full name *</label>
                  <input
                    id="ct-name"
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    autoComplete="name"
                  />
                </div>

                <div className="bk-field">
                  <label htmlFor="ct-phone">Phone</label>
                  <input
                    id="ct-phone"
                    type="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    autoComplete="tel"
                    placeholder="(508) 258-9294"
                  />
                </div>

                <div className="bk-field">
                  <label htmlFor="ct-email">Email</label>
                  <input
                    id="ct-email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete="email"
                  />
                </div>

                <div className="bk-field">
                  <label htmlFor="ct-property">Property type</label>
                  <select
                    id="ct-property"
                    value={propertyType}
                    onChange={(e) => setPropertyType(e.target.value)}
                  >
                    <option value="Residential">Residential</option>
                    <option value="Association">HOA / Condo community</option>
                    <option value="Specialty">Commercial / Other</option>
                  </select>
                </div>

                <div className="bk-field">
                  <label htmlFor="ct-reason">How can we help?</label>
                  <select id="ct-reason" value={reason} onChange={(e) => setReason(e.target.value)}>
                    <option>General question</option>
                    <option>Get a quote</option>
                    <option>Existing customer support</option>
                    <option>Billing question</option>
                    <option>Other</option>
                  </select>
                </div>

                <div className="bk-field bk-full">
                  <label htmlFor="ct-message">Tell us more</label>
                  <textarea
                    id="ct-message"
                    rows={4}
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                  />
                </div>

                <label className="bk-modal-consent bk-full">
                  <input
                    type="checkbox"
                    checked={consent}
                    onChange={(e) => setConsent(e.target.checked)}
                  />
                  <span>{CONSENT_TEXT}</span>
                </label>

                {errorMsg && (
                  <div className="bk-field-error bk-full" role="alert">
                    {errorMsg}
                  </div>
                )}

                <button
                  type="submit"
                  className="bk-btn bk-btn-primary bk-contact-submit bk-full"
                  disabled={status === "submitting"}
                  data-track-id="contact_form_submit"
                >
                  {status === "submitting" ? "Sending…" : "Send Message"}
                </button>

                <p className="bk-modal-fallback bk-full">
                  Or call us now at <a href={OFFICE_TEL}>{OFFICE_PHONE}</a>
                </p>
              </form>
            )}
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
              <h2 className="bk-schedule-title">Get an Instant Quote</h2>
              <p className="bk-schedule-sub">Skip the wait — price your service online in minutes.</p>
              <Link to="/quote" className="bk-btn bk-schedule-cta">
                Get an Instant Quote
              </Link>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
