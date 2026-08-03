import { useState } from "react";
import type { FormEvent } from "react";
import { CALL_CONSENT_TEXT } from "../../amplify/functions/shared/consentText";
import { submitLead } from "../lib/leadIntakeApi";
import {
  trackFormSubmit,
  trackGenerateLead,
  trackAdsConversion,
  ADS_CONVERSIONS,
} from "../lib/analytics";
import FormContactFooter from "./FormContactFooter";
import { OFFICE_PHONE_PRETTY } from "../lib/contactInfo";

type Status = "idle" | "submitting" | "success" | "error";

/**
 * The no-pricing path: a name, one way to reach them, and whatever they want
 * to say. It writes a CRM lead and emails the sales inbox through the same
 * `lead-intake` endpoint every other public form uses, so a request made here
 * lands exactly where a contact-page request lands.
 *
 * Deliberately short. This form exists for the visitor who does not want to
 * describe their property to a pricing engine, so asking for the property
 * details anyway would defeat it.
 */
export default function ContactMeForm({ formId }: { formId: string }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [comment, setComment] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (status === "submitting") return;
    setErrorMsg(null);

    const trimmedName = name.trim();
    const trimmedEmail = email.trim();
    const trimmedPhone = phone.trim();

    // Name, plus at least one channel. The server enforces the same rule; this
    // is the same check said sooner, next to the field it is about.
    const errors: Record<string, string> = {};
    if (!trimmedName) errors.name = "Please tell us your name.";
    if (!trimmedEmail && !trimmedPhone) {
      errors.reach = "Add an email address or a phone number so we can reply.";
    }
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setStatus("submitting");
    const [first, ...rest] = trimmedName.split(/\s+/);
    const result = await submitLead({
      first,
      last: rest.join(" ") || undefined,
      email: trimmedEmail || undefined,
      phone: trimmedPhone || undefined,
      reason: "Contact me",
      message: comment.trim() || undefined,
      formId,
      // GL-03: the request itself is the basis for replying. consentText.ts
      // records that, since the form shows no consent notice.
      consentToContact: true,
      consentText: CALL_CONSENT_TEXT,
    });

    if (result.ok) {
      setStatus("success");
      trackFormSubmit(formId, "success", { lead_id: result.leadId });
      trackGenerateLead(formId, result.leadId);
      trackAdsConversion(ADS_CONVERSIONS.QUOTE_COMPLETED);
    } else {
      setStatus("error");
      setErrorMsg(result.error);
      trackFormSubmit(formId, "error", { error: result.error });
    }
  }

  if (status === "success") {
    return (
      <div className="bk-contact-success">
        <h2>We&rsquo;ve got it!</h2>
        <p>
          Your request is with our team and a local BuzzKill expert will follow
          up shortly.
        </p>
        <FormContactFooter lead="Need help right now?" />
      </div>
    );
  }

  return (
    <form className="bk-form-step" onSubmit={handleSubmit} noValidate>
      <h3 className="bk-form-step__title">How can we reach you?</h3>

      <div className="bk-field bk-full">
        <label htmlFor="cm-name">Full name *</label>
        <input
          id="cm-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="name"
        />
        {fieldErrors.name && (
          <div className="bk-field-error" role="alert">
            {fieldErrors.name}
          </div>
        )}
      </div>

      <div className="bk-form-row">
        <div className="bk-field">
          <label htmlFor="cm-email">Email</label>
          <input
            id="cm-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            placeholder="you@example.com"
          />
        </div>
        <div className="bk-field">
          <label htmlFor="cm-phone">Phone</label>
          <input
            id="cm-phone"
            type="tel"
            inputMode="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            autoComplete="tel"
            placeholder={OFFICE_PHONE_PRETTY}
          />
        </div>
      </div>
      {fieldErrors.reach && (
        <div className="bk-field-error bk-full" role="alert">
          {fieldErrors.reach}
        </div>
      )}

      <div className="bk-field bk-full">
        <label htmlFor="cm-comment">Comment</label>
        <textarea
          id="cm-comment"
          rows={4}
          value={comment}
          onChange={(e) => setComment(e.target.value.slice(0, 2000))}
          placeholder="What's going on, and where? Optional, but it helps us come prepared."
        />
      </div>

      {errorMsg && (
        <div className="bk-form-error bk-full" role="alert">
          {errorMsg}
        </div>
      )}

      <div className="bk-form-step__actions">
        <button
          type="submit"
          className="bk-btn bk-btn-primary"
          disabled={status === "submitting"}
          aria-busy={status === "submitting"}
          data-track-id="contact_me_submit"
        >
          {status === "submitting" ? "Sending…" : "Send my request"}
        </button>
      </div>

      <FormContactFooter />
    </form>
  );
}
