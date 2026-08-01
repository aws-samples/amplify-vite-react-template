import { useState, useEffect, useCallback, useMemo } from "react";
import { submitCrmLead } from "../lib/crmLead";
import { DARK, LIGHT, ThemeContext, isDaytime, useTheme, type ThemeMode } from "./quote/theme";
import { Icon } from "./quote/icons";
import { STEPS, getFlow, validateText, type FormData } from "./quote/schema";
import {
  THEME_KEY,
  clearState,
  getPrefillFromUrl,
  loadState,
  pickAgent,
  saveState,
  type Agent,
} from "./quote/session";
import { buildCrmLead, sendQuoteEmail } from "./quote/submission";
import {
  AgentHeader,
  BackButton,
  CardOption,
  Confetti,
  PrimaryButton,
  ProgressBar,
  RestartButton,
  SlideIn,
  TextField,
  ThemeIndicator,
} from "./quote/ui";

/* ──────────────────────────────────────────────────────────
   APP
   ────────────────────────────────────────────────────────── */
export default function QuoteApp() {
  const [mode, setMode] = useState<ThemeMode>(() => {
    try {
      const v = localStorage.getItem(THEME_KEY);
      if (v === "light" || v === "dark" || v === "auto") return v;
    } catch {
      /* ignore */
    }
    return "auto";
  });
  const [autoIsDay, setAutoIsDay] = useState<boolean>(() => isDaytime());

  // Persist theme mode
  useEffect(() => {
    try {
      localStorage.setItem(THEME_KEY, mode);
    } catch {
      /* ignore */
    }
  }, [mode]);

  // Re-evaluate every minute so theme flips at the boundary even on a long session
  useEffect(() => {
    if (mode !== "auto") return;
    const t = setInterval(() => setAutoIsDay(isDaytime()), 60_000);
    return () => clearInterval(t);
  }, [mode]);

  const isDay = mode === "auto" ? autoIsDay : mode === "light";
  const palette = isDay ? LIGHT : DARK;

  // Reflect theme on <html> so global CSS can react
  useEffect(() => {
    document.documentElement.dataset.theme = isDay ? "light" : "dark";
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", palette.bg);
  }, [isDay, palette.bg]);

  function toggleTheme() {
    // auto → opposite manual → flip manual → back to auto when matching auto
    if (mode === "auto") {
      setMode(isDay ? "dark" : "light");
    } else if (mode === "light") {
      setMode("dark");
    } else {
      setMode("light");
    }
  }

  return (
    <ThemeContext.Provider value={palette}>
      <QuoteFlow isDay={isDay} onToggleTheme={toggleTheme} />
    </ThemeContext.Provider>
  );
}

function QuoteFlow({ isDay, onToggleTheme }: { isDay: boolean; onToggleTheme: () => void }) {
  const c = useTheme();
  // Hydrate from localStorage on first render
  const persisted = useMemo(() => loadState(), []);
  const prefill = useMemo(() => getPrefillFromUrl(), []);
  const [stepIndex, setStepIndex] = useState<number>(persisted?.stepIndex ?? 0);
  const [data, setData] = useState<FormData>(() => {
    const base = persisted?.data ?? {};
    // Apply URL prefill if no persisted data
    if (!persisted && prefill.state) {
      base.state = prefill.state;
    }
    return base;
  });
  const [role, setRole] = useState<string | null>(persisted?.role ?? null);
  const [inputVal, setInputVal] = useState<string>(persisted?.inputVal ?? "");
  const [multiVal, setMultiVal] = useState<string[]>(persisted?.multiVal ?? []);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [direction, setDirection] = useState<1 | -1>(1);
  const [agent, setAgent] = useState<Agent>(() => persisted?.agent ?? pickAgent());
  const [showConfetti, setShowConfetti] = useState(false);

  function handleRestart() {
    if (stepIndex === 0) return;
    const ok = window.confirm("Start over? Your answers will be cleared.");
    if (!ok) return;
    setDirection(-1);
    setStepIndex(0);
    setData({});
    setRole(null);
    setInputVal("");
    setMultiVal([]);
    setError("");
    setSubmitting(false);
    // Roll a new agent so the experience feels fresh
    let next = pickAgent();
    let tries = 0;
    while (next.name === agent.name && tries < 5) {
      next = pickAgent();
      tries++;
    }
    setAgent(next);
    clearState();
  }

  const flow = useMemo(() => getFlow(role, data), [role, data]);
  const stepKey = flow[stepIndex];
  const step = STEPS[stepKey];
  const totalSteps = flow.length - 1;

  // Persist on every meaningful change. Skip (and clear) once the user
  // reaches the submitted screen so a refresh sends them to the start.
  useEffect(() => {
    if (stepKey === "submitted") {
      clearState();
      return;
    }
    saveState({ stepIndex, data, role, agent, inputVal, multiVal });
  }, [stepKey, stepIndex, data, role, agent, inputVal, multiVal]);

  const resetInput = useCallback(() => {
    setInputVal("");
    setMultiVal([]);
    setError("");
  }, []);

  const goNext = useCallback(() => {
    setDirection(1);
    setStepIndex((i) => Math.min(i + 1, flow.length - 1));
    resetInput();
  }, [flow.length, resetInput]);

  const goBack = useCallback(() => {
    if (stepIndex > 0) {
      setDirection(-1);
      setStepIndex((i) => i - 1);
      resetInput();
    }
  }, [stepIndex, resetInput]);

  function handleSplash() {
    goNext();
  }

  function handleSelect(value: string) {
    if (stepKey === "role") {
      setRole(value);
      setData((d) => ({ ...d, role: value }));
    } else if (step.type === "select" && step.field) {
      setData((d) => ({ ...d, [step.field as string]: value }));
    }
    setTimeout(goNext, 220);
  }

  function handleTextSubmit() {
    if (step.type !== "text") return;
    const errMsg = validateText(inputVal, step.validation, !!step.optional);
    if (errMsg) {
      setError(errMsg);
      return;
    }
    const newData = { ...data, [step.field]: inputVal.trim() };
    setData(newData);
    if (flow[stepIndex + 1] === "submitted") {
      submitForm(newData);
    } else {
      goNext();
    }
  }

  function toggleMulti(value: string) {
    setMultiVal((prev) =>
      prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value]
    );
    setError("");
  }

  function handleMultiSubmit() {
    if (multiVal.length === 0) {
      setError("Select at least one option.");
      return;
    }
    if (step.type === "multi") {
      setData((d) => ({ ...d, [step.field]: multiVal }));
    }
    goNext();
  }

  async function submitForm(finalData: FormData) {
    setSubmitting(true);
    setError("");
    // CRM lead (fail-soft, runs alongside the notification email)
    void submitCrmLead(buildCrmLead(finalData, agent.name));
    try {
      await sendQuoteEmail(finalData, agent.name);
      setDirection(1);
      setStepIndex(flow.length - 1);
      resetInput();
      clearState();
      // Fire Google Ads conversion
      if (typeof window !== "undefined" && (window as any).gtag) {
        (window as any).gtag("event", "conversion", {
          send_to: "AW-18085022517/Csp3COKBgpscELWWzq9D",
          value: 1.0,
          currency: "USD",
        });
      }
      // Celebrate!
      setShowConfetti(true);
      setTimeout(() => setShowConfetti(false), 4000);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("Quote submission failed:", err);
      setError(
        "We couldn't send your request. Please try again, or call us at (508) 233-2261."
      );
    } finally {
      setSubmitting(false);
    }
  }

  /* keyboard: Enter on splash advances */
  useEffect(() => {
    if (step?.type !== "splash") return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Enter") handleSplash();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepKey]);

  // Splash renders the avatar inline (below the logo). Other question steps
  // get the avatar at the top of the stage. Submitted screen has neither.
  const showAgentHeader = step?.type !== "submitted" && step?.type !== "splash";
  const firstName = (data.contactName as string | undefined)?.split(" ")[0];
  const agentFirst = agent.name.split(" ")[0];
  const progress = totalSteps > 0 ? Math.min(stepIndex, totalSteps) / totalSteps : 0;
  const greeting = useMemo(() => {
    // Splash uses the headline itself for the agent's intro line
    if (stepKey === "welcome") return undefined;
    if (stepKey === "role") return "Let's get to know you.";
    if (stepKey === "assocName") return "Tell me about your association.";
    if (stepKey === "contactName") return "Just a few more questions.";
    if (firstName && stepKey === "contactEmail") return `Thanks, ${firstName}!`;
    if (firstName && stepKey === "contactPhone") return `Almost done, ${firstName}.`;
    return undefined;
  }, [stepKey, firstName]);

  return (
    <div className="qf-root">
      <Confetti active={showConfetti} />
      <ProgressBar current={Math.min(stepIndex, totalSteps)} total={totalSteps} />
      {stepIndex > 0 && step?.type !== "submitted" && <BackButton onClick={goBack} />}
      <div className="qf-top-right">
        {stepIndex > 0 && step?.type !== "submitted" && <RestartButton onClick={handleRestart} />}
        <ThemeIndicator isDay={isDay} onToggle={onToggleTheme} />
      </div>

      <div className="qf-stage">
        {showAgentHeader && (
          <AgentHeader
            agent={agent}
            greeting={greeting}
            progress={progress}
            typeGreeting
          />
        )}
        <SlideIn keyVal={stepKey} direction={direction}>
          {/* SPLASH */}
          {step?.type === "splash" && (
            <div className="qf-center">
              <div className="qf-splash-logo">
                <img src="/logo.png" alt="HOA Insurance Agency" draggable={false} />
              </div>
              <AgentHeader agent={agent} compact />
              <div className="qf-splash-message">
                <span>Hi, I'm {agentFirst} <span className="qf-emoji">👋</span></span>
                <span>I'll get you an awesome HOA insurance quote in minutes. Ready to go?</span>
              </div>
              <p className="qf-sub-small">{step.sub}</p>
              <PrimaryButton onClick={handleSplash} label="Get Started" />
            </div>
          )}

          {/* SELECT */}
          {step?.type === "select" && (
            <div>
              <h2 className="qf-question">{step.question}</h2>
              {step.sub && <p className="qf-sub-small">{step.sub}</p>}
              <div className="qf-options">
                {step.options.map((opt) => {
                  const selectedVal =
                    stepKey === "role" ? role : (step.field ? (data[step.field] as string) : undefined);
                  return (
                    <CardOption
                      key={opt.value}
                      label={opt.label}
                      sub={opt.sub}
                      iconKey={opt.icon}
                      selected={selectedVal === opt.value}
                      onClick={() => handleSelect(opt.value)}
                    />
                  );
                })}
              </div>
            </div>
          )}

          {/* TEXT */}
          {step?.type === "text" && (
            <div>
              <h2 className="qf-question">{step.question}</h2>
              {step.optional && (
                <p className="qf-sub-small">Optional — press Continue to skip</p>
              )}
              <div className="qf-text-wrap">
                <TextField
                  placeholder={step.placeholder}
                  value={inputVal}
                  onChange={(v) => {
                    setInputVal(v);
                    setError("");
                  }}
                  onSubmit={handleTextSubmit}
                  type={step.inputType || "text"}
                />
              </div>
              {error && <p className="qf-error">{error}</p>}
              <PrimaryButton
                onClick={handleTextSubmit}
                label={flow[stepIndex + 1] === "submitted" ? "Submit request" : "Continue"}
                disabled={submitting}
                loading={submitting}
              />
            </div>
          )}

          {/* MULTI */}
          {step?.type === "multi" && (
            <div>
              <h2 className="qf-question">{step.question}</h2>
              {step.sub && <p className="qf-sub-small">{step.sub}</p>}
              <div className="qf-options">
                {step.options.map((opt) => (
                  <CardOption
                    key={opt.value}
                    label={opt.label}
                    iconKey={opt.icon}
                    selected={multiVal.includes(opt.value)}
                    onClick={() => toggleMulti(opt.value)}
                    showCheck
                  />
                ))}
              </div>
              {error && <p className="qf-error">{error}</p>}
              <PrimaryButton onClick={handleMultiSubmit} />
            </div>
          )}

          {/* SUBMITTED */}
          {step?.type === "submitted" && (
            <div className="qf-center">
              <a
                href="/"
                target="_blank"
                rel="noopener noreferrer"
                className="qf-splash-logo qf-splash-logo--small qf-splash-logo--link"
                aria-label="Visit ProtectMyHOA.com"
              >
                <img src="/logo.png" alt="HOA Insurance Agency" draggable={false} />
              </a>
              <div className="qf-success-icon">
                <svg width="80" height="80" viewBox="0 0 80 80" fill="none">
                  <circle cx="40" cy="40" r="40" fill={c.accentDim} />
                  <circle cx="40" cy="40" r="30" fill={c.accent} />
                  <path
                    d="M26 40l10 10 18-22"
                    stroke={c.white}
                    strokeWidth="5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
              <h2 className="qf-headline">You're all set.</h2>
              <p className="qf-sub">
                We'll review your information and reach out within one business day.
              </p>
              <a href="tel:+15082332261" className="qf-phone-cta">
                <Icon.Phone size={16} />
                <span>Or call us — 508‑233‑2261</span>
              </a>
              <a href="/" className="qf-back-link">
                ← Back to ProtectMyHOA.com
              </a>
            </div>
          )}
        </SlideIn>
      </div>

      {step?.type !== "submitted" && (
        <p className="qf-footer">HOA Insurance Agency · Marlborough, MA</p>
      )}
    </div>
  );
}
