import { useState } from "react";
import { FORMSUBMIT_URL, fireConversion } from "../constants";
import { submitCrmLead } from "../lib/crmLead";
import "./AssociationLeadForm.css";

interface Property {
  id: number;
  name: string;
  slug: string;
  address: string;
  city: string;
  state: string;
  zip: string;
}

interface Props {
  property: Property;
}

export function AssociationLeadForm({ property }: Props) {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [unitNumber, setUnitNumber] = useState("");
  const [currentCarrier, setCurrentCarrier] = useState("");
  const [notes, setNotes] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  const fullAddress = [property.address, property.city, property.state, property.zip]
    .filter(Boolean)
    .join(", ");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!firstName.trim() || !lastName.trim() || !email.trim()) {
      setError("Please fill out the required fields.");
      return;
    }
    setSending(true);
    setError("");
    // CRM lead (fail-soft, runs alongside the notification email)
    void submitCrmLead({
      type: "PERSONAL",
      name: `${firstName.trim()} ${lastName.trim()}`,
      contactFirstName: firstName.trim(),
      contactLastName: lastName.trim(),
      contactEmail: email.trim(),
      contactPhone: phone.trim() || undefined,
      address: property.address,
      city: property.city,
      state: property.state,
      zip: property.zip,
      unitNumber: unitNumber.trim() || undefined,
      currentCarrier: currentCarrier.trim() || undefined,
      buildiumId: String(property.id),
      source: `website-ho6:${property.slug}`,
      notes: [`Association: ${property.name}`, notes.trim()].filter(Boolean).join("\n"),
    });
    try {
      const res = await fetch(FORMSUBMIT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          _subject: `🏠 HO-6 Quote — ${firstName.trim()} ${lastName.trim()}${unitNumber.trim() ? ` (Unit ${unitNumber.trim()})` : ""} — ${property.name}`,
          _template: "table",
          _captcha: "false",
          _replyto: email.trim(),
          "Building / Association": property.name,
          "Buildium ID": String(property.id),
          "Building Address": fullAddress || "—",
          "First Name": firstName.trim(),
          "Last Name": lastName.trim(),
          Email: email.trim(),
          Phone: phone.trim() || "—",
          "Unit Number": unitNumber.trim() || "—",
          "Current HO-6 Carrier": currentCarrier.trim() || "—",
          Notes: notes.trim() || "—",
          "Lead Type": "HO-6 Unit Owner",
          Source: `Association Page (HO-6) — ${property.slug}`,
        }),
      });
      if (!res.ok) throw new Error("fail");
      fireConversion();
      setSent(true);
    } catch {
      setError("Something went wrong. Please try again or call 508-233-2261.");
    } finally {
      setSending(false);
    }
  }

  if (sent) {
    return (
      <div className="alf-success">
        <div className="alf-success-icon">
          <svg width="64" height="64" viewBox="0 0 64 64" fill="none">
            <circle cx="32" cy="32" r="32" fill="#e5c16a20" />
            <circle cx="32" cy="32" r="24" fill="#e5c16a" />
            <path d="M20 32l8 8 16-18" stroke="#fff" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <h2 className="alf-success-title">Thanks, {firstName || "we got it"}!</h2>
        <p className="alf-success-text">
          We've received your HO-6 quote request for your unit at <strong>{property.name}</strong>. We'll coordinate with your association's master policy and reach out within one business day with a personalized quote.
        </p>
        <a href="tel:+15082332261" className="alf-phone-link">
          Have questions? Call us — 508-233-2261
        </a>
        <a href="/" className="alf-back-link">Visit ProtectMyHOA.com</a>
      </div>
    );
  }

  return (
    <div className="alf-container">
      <div className="alf-form-side">
        <p className="alf-eyebrow">HO-6 Condo Insurance for Unit Owners</p>
        <h1 className="alf-headline">Protect your unit at {property.name}</h1>
        <p className="alf-sub">
          Your association's master policy doesn't cover everything. Personal property, interior improvements, your share of deductibles, special assessments — that's on you. We'll set you up with HO-6 coverage that's <strong>coordinated with your building's master policy</strong>, so there are no surprises after a loss.
        </p>

        <div className="alf-property-card">
          <div className="alf-property-pin">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/>
              <circle cx="12" cy="10" r="3"/>
            </svg>
          </div>
          <div className="alf-property-text">
            <span className="alf-property-label">Your building</span>
            <strong>{property.name}</strong>
            {fullAddress && <span>{fullAddress}</span>}
          </div>
        </div>

        <form className="alf-form" onSubmit={handleSubmit}>
          <div className="alf-row">
            <div className="alf-field">
              <label htmlFor="alf-first">First Name *</label>
              <input id="alf-first" type="text" value={firstName} onChange={(e) => setFirstName(e.target.value)} required />
            </div>
            <div className="alf-field">
              <label htmlFor="alf-last">Last Name *</label>
              <input id="alf-last" type="text" value={lastName} onChange={(e) => setLastName(e.target.value)} required />
            </div>
          </div>

          <div className="alf-row">
            <div className="alf-field">
              <label htmlFor="alf-email">Email *</label>
              <input id="alf-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </div>
            <div className="alf-field">
              <label htmlFor="alf-phone">Phone</label>
              <input id="alf-phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </div>
          </div>

          <div className="alf-row">
            <div className="alf-field">
              <label htmlFor="alf-unit">Your Unit Number</label>
              <input id="alf-unit" type="text" value={unitNumber} onChange={(e) => setUnitNumber(e.target.value)} placeholder="e.g. 4B, 12, Unit 305" />
            </div>
            <div className="alf-field">
              <label htmlFor="alf-carrier">Current HO-6 Carrier</label>
              <input id="alf-carrier" type="text" value={currentCarrier} onChange={(e) => setCurrentCarrier(e.target.value)} placeholder="e.g. Amica, MAPFRE, or 'none'" />
            </div>
          </div>

          <div className="alf-field alf-field--full">
            <label htmlFor="alf-notes">Anything else we should know? (optional)</label>
            <textarea
              id="alf-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="Renewal date, recent renovations, specific concerns..."
            />
          </div>

          {error && <p className="alf-error">{error}</p>}

          <button type="submit" className="alf-submit" disabled={sending}>
            {sending ? "Sending..." : "Get My HO-6 Quote"}
            {!sending && (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12h14M12 5l7 7-7 7"/>
              </svg>
            )}
          </button>

          <p className="alf-disclaimer">Free. No obligation. We'll respond within 1 business day.</p>
        </form>
      </div>

      <div className="alf-trust-side">
        <div className="alf-logo-wrap">
          <img src="/logo.png" alt="HOA Insurance Agency" className="alf-logo" />
        </div>

        <div className="alf-what-you-get">
          <h3>Why HO-6 matters:</h3>
          <ul>
            <li>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="12" r="10"/><path d="M8 12l3 3 5-6"/></svg>
              Covers personal property the master policy excludes
            </li>
            <li>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="12" r="10"/><path d="M8 12l3 3 5-6"/></svg>
              Loss assessment coverage for your share of association claims
            </li>
            <li>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="12" r="10"/><path d="M8 12l3 3 5-6"/></svg>
              Protects interior improvements and upgrades you've made
            </li>
            <li>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="12" r="10"/><path d="M8 12l3 3 5-6"/></svg>
              Personal liability coverage for incidents in your unit
            </li>
          </ul>
        </div>

        <div className="alf-signals">
          <div className="alf-signal">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2l8 4v6c0 5-3.5 9.5-8 10-4.5-.5-8-5-8-10V6l8-4z"/></svg>
            <span>We know your building — quotes coordinated with the master policy</span>
          </div>
          <div className="alf-signal">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2l8 4v6c0 5-3.5 9.5-8 10-4.5-.5-8-5-8-10V6l8-4z"/></svg>
            <span>Independent brokerage — we shop the market for you</span>
          </div>
          <div className="alf-signal">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2l8 4v6c0 5-3.5 9.5-8 10-4.5-.5-8-5-8-10V6l8-4z"/></svg>
            <span>Based in Marlborough, MA — real people, fast response</span>
          </div>
        </div>

        <div className="alf-contact-alt">
          <p>Prefer to talk?</p>
          <a href="tel:+15082332261">508-233-2261</a>
          <a href="mailto:insurance@ProtectMyHOA.com">insurance@ProtectMyHOA.com</a>
        </div>
      </div>
    </div>
  );
}
