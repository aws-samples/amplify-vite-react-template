import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { submitLead } from "../lib/leadIntakeApi";
import { trackFormSubmit, trackGenerateLead, trackAdsConversion, ADS_CONVERSIONS } from "../lib/analytics";
import FormContactFooter from "./FormContactFooter";
import { CALL_CONSENT_TEXT } from "../../amplify/functions/shared/consentText";

type Ctx = { open: () => void };
const TalkToExpertContext = createContext<Ctx | null>(null);

export function useTalkToExpert(): Ctx {
  const ctx = useContext(TalkToExpertContext);
  if (!ctx) throw new Error("useTalkToExpert must be used within TalkToExpertProvider");
  return ctx;
}

type Status = "idle" | "submitting" | "success" | "error";

export function TalkToExpertProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);

  const close = () => {
    setIsOpen(false);
    setStatus("idle");
    setErrorMsg(null);
    setName("");
    setPhone("");
    setEmail("");
  };

  const open = () => {
    setIsOpen(true);
    setStatus("idle");
    setErrorMsg(null);
  };

  useEffect(() => {
    if (!isOpen) return;
    firstFieldRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (status === "submitting") return;
    setErrorMsg(null);

    const trimmedName = name.trim();
    if (!trimmedName || (!phone.trim() && !email.trim())) {
      setErrorMsg("Please enter your name and a phone number or email so we can reach you.");
      return;
    }
    setStatus("submitting");
    const [first, ...rest] = trimmedName.split(/\s+/);
    const result = await submitLead({
      first,
      last: rest.join(" ") || undefined,
      phone: phone.trim() || undefined,
      email: email.trim() || undefined,
      formId: "talk-to-expert",
      // GL-03: the request itself is the basis for replying. consentText.ts
      // records that, since the form shows no consent notice.
      consentToContact: true,
      consentText: CALL_CONSENT_TEXT,
    });

    if (result.ok) {
      setStatus("success");
      trackFormSubmit("talk_to_expert", "success", { lead_id: result.leadId });
      trackGenerateLead("talk_to_expert", result.leadId);
      trackAdsConversion(ADS_CONVERSIONS.QUOTE_COMPLETED);
    } else {
      setStatus("error");
      setErrorMsg(result.error);
      trackFormSubmit("talk_to_expert", "error", { error: result.error });
    }
  }

  return (
    <TalkToExpertContext.Provider value={{ open }}>
      {children}
      {isOpen && (
        <div
          className="bk-modal-overlay"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) close();
          }}
        >
          <div
            className="bk-modal-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="talk-to-expert-title"
            ref={dialogRef}
          >
            <button type="button" className="bk-modal-close" aria-label="Close" onClick={close}>
              &times;
            </button>

            {status === "success" ? (
              <div className="bk-modal-success">
                <h2 id="talk-to-expert-title" className="bk-modal-title">We've got it!</h2>
                <p>A local pest control expert will reach out to you shortly.</p>
                <FormContactFooter lead="Need help right now?" />
                <button type="button" className="bk-btn bk-btn-primary" onClick={close}>
                  Close
                </button>
              </div>
            ) : (
              <form onSubmit={handleSubmit} noValidate>
                <h2 id="talk-to-expert-title" className="bk-modal-title">Talk to a Local Expert</h2>
                <p className="bk-modal-sub">
                  Tell us how to reach you and a BuzzKill expert will follow up.
                </p>

                <div className="bk-field bk-full">
                  <label htmlFor="tte-name">Full name *</label>
                  <input
                    id="tte-name"
                    ref={firstFieldRef}
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    autoComplete="name"
                  />
                </div>

                <div className="bk-field bk-full">
                  <label htmlFor="tte-phone">Phone</label>
                  <input
                    id="tte-phone"
                    type="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    autoComplete="tel"
                    placeholder="(508) 258-9294"
                  />
                </div>

                <div className="bk-field bk-full">
                  <label htmlFor="tte-email">Email</label>
                  <input
                    id="tte-email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete="email"
                  />
                </div>

                {errorMsg && (
                  <div className="bk-field-error" role="alert">
                    {errorMsg}
                  </div>
                )}

                <button type="submit" className="bk-btn bk-btn-primary bk-modal-submit" disabled={status === "submitting"} data-track-id="talk_to_expert_submit">
                  {status === "submitting" ? "Sending…" : "Request a Callback"}
                </button>

                <FormContactFooter />
              </form>
            )}
          </div>
        </div>
      )}
    </TalkToExpertContext.Provider>
  );
}
