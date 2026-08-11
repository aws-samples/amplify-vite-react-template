import { useState, type FormEvent } from "react";
import { FORMSUBMIT_URL, PHONE, PHONE_HREF, EMAIL, EMAIL_HREF, ADDRESS_LINE1, ADDRESS_LINE2 } from "../constants";
import { submitCrmLead } from "../lib/crmLead";
import "./ContactForm.css";

/* Pre-filled claim notice. The body prompts for the four things always asked
   first, so the reply is not a request for basics. Encoded so newlines survive. */
const CLAIM_HREF =
  `mailto:${EMAIL}` +
  `?subject=${encodeURIComponent("Claim notification")}` +
  `&body=${encodeURIComponent(
    [
      "Association name:",
      "Property address:",
      "Date of loss:",
      "What happened:",
      "",
      "Best number to reach you:",
    ].join("\n")
  )}`;

export function ContactForm({
  /**
   * Show the claims + urgent block under the address. Opt-in: this component
   * also renders on about-us, what-we-do, why-choose-us and every state and city
   * page, and a claim notice belongs on the contact page rather than on all of
   * them. Pass it anywhere else that should offer the same route.
   */
  showClaims = false,
}: {
  showClaims?: boolean;
} = {}) {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!firstName.trim() || !lastName.trim() || !email.trim() || !message.trim()) return;
    setStatus("sending");
    void submitCrmLead({
      type: "ASSOCIATION",
      name: `${firstName.trim()} ${lastName.trim()}`,
      contactFirstName: firstName.trim(),
      contactLastName: lastName.trim(),
      contactEmail: email.trim(),
      source: "website-contact",
      notes: message.trim(),
    });
    try {
      const res = await fetch(FORMSUBMIT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          _subject: `Website Contact — ${firstName.trim()} ${lastName.trim()}`,
          _template: "table",
          _captcha: "false",
          _replyto: email.trim(),
          "First Name": firstName.trim(),
          "Last Name": lastName.trim(),
          Email: email.trim(),
          Message: message.trim(),
        }),
      });
      if (!res.ok) throw new Error("failed");
      setStatus("sent");
      setFirstName("");
      setLastName("");
      setEmail("");
      setMessage("");
    } catch {
      setStatus("error");
    }
  }

  return (
    <section className="section contact-section" id="contact">
      <div className="container contact-grid">
        <div className="contact-info">
          <h3 className="contact-heading">Contact Us Today</h3>
          <div className="contact-details">
            <div className="contact-item">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.13.96.37 1.9.72 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.91.35 1.85.59 2.81.72A2 2 0 0122 16.92z"/></svg>
              <a href={PHONE_HREF}>{PHONE}</a>
            </div>
            <div className="contact-item">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><path d="M22 6l-10 7L2 6"/></svg>
              <a href={EMAIL_HREF}>{EMAIL}</a>
            </div>
            <div className="contact-item">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>
              <span>{ADDRESS_LINE1}<br />{ADDRESS_LINE2}</span>
            </div>
          </div>

          {showClaims && (
            <div className="contact-claims">
              <h4 className="contact-claims__title">Claims and urgent matters</h4>
              <div className="contact-claims__actions">
                <a href={CLAIM_HREF} className="btn btn-gold contact-claims__btn">
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="2.5" y="4.5" width="19" height="15" rx="2" />
                    <path d="M3 6.5l9 6.5 9-6.5" />
                  </svg>
                  Report a claim by email
                </a>
                <a href={PHONE_HREF} className="contact-claims__phone">
                  <span className="contact-claims__phone-label">Urgent</span>
                  <span className="contact-claims__phone-num">{PHONE}</span>
                </a>
              </div>
              <p className="contact-claims__note">
                Notifying us does not replace any notice your policy requires you to give the
                carrier. If a deadline is close, call rather than email.
              </p>
            </div>
          )}
        </div>

        <form className="contact-form" onSubmit={handleSubmit}>
          {status === "sent" ? (
            <div className="contact-success">
              <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
                <circle cx="24" cy="24" r="24" fill="var(--color-sky)" />
                <path d="M16 24l6 6 10-12" stroke="var(--color-blue)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <h3>Thank you!</h3>
              <p>We'll be in touch soon.</p>
            </div>
          ) : (
            <>
              <div className="contact-name-row">
                <input
                  type="text"
                  placeholder="First Name"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  required
                  className="contact-input"
                />
                <input
                  type="text"
                  placeholder="Last Name"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  required
                  className="contact-input"
                />
              </div>
              <input
                type="email"
                placeholder="Email address"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="contact-input"
              />
              <textarea
                placeholder="How can we help?"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                required
                rows={5}
                className="contact-input contact-textarea"
              />
              {status === "error" && (
                <p className="contact-error">
                  Something went wrong. Please try again or call us at {PHONE}.
                </p>
              )}
              <button
                type="submit"
                className="btn btn-primary contact-submit"
                disabled={status === "sending"}
              >
                {status === "sending" ? "Sending..." : "Submit"}
              </button>
            </>
          )}
        </form>
      </div>
    </section>
  );
}
