import { useState, useEffect, useCallback, useMemo } from "react";
import { fireConversion, PHONE, PHONE_HREF } from "../constants";
import { submitCrmLead } from "../lib/crmLead";
import { DARK, LIGHT, ThemeContext, isDaytime, useTheme, type ThemeMode } from "./quote/theme";
import { Icon } from "./quote/icons";
import { STEPS, getFlow, validateText, type FormData, type GroupField } from "./quote/schema";
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
  BrandMark,
  CardOption,
  Confetti,
  PrimaryButton,
  ProgressBar,
  RestartButton,
  SelectField,
  SlideIn,
  StepIndicator,
  SupportChip,
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
    // Defaults to the brand light theme rather than "auto". Auto meant anyone
    // arriving after 18:00 got a dark form, which is off-brand and not what a
    // first-time visitor should see. The toggle still offers dark.
    return "light";
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
  /* Per-field state for `group` steps, plus per-field errors so the message sits
     under the field that is wrong rather than at the bottom of the screen. */
  const [groupVal, setGroupVal] = useState<Record<string, string | string[]>>({});
  const [groupErr, setGroupErr] = useState<Record<string, string>>({});
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

  const flow = useMemo(() => getFlow(role), [role]);
  const stepKey = flow[stepIndex];
  const step = STEPS[stepKey];
  const totalSteps = flow.length - 1;

  /* Seed a group screen from answers already given, so going Back shows what was
     typed instead of empty fields. `data` survives a refresh; the in-progress
     group does not, which is why this reads from data rather than the reverse. */
  useEffect(() => {
    if (step?.type !== "group") return;
    const seed: Record<string, string | string[]> = {};
    for (const f of step.fields) {
      const v = data[f.field];
      if (Array.isArray(v)) seed[f.field] = v;
      else if (typeof v === "string" && v) seed[f.field] = v;
    }
    setGroupVal(seed);
    setGroupErr({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepKey]);

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
    setGroupVal({});
    setGroupErr({});
    setError("");
  }, []);

  const goNext = useCallback(() => {
    setDirection(1);
    setStepIndex((i) => Math.min(i + 1, flow.length - 1));
    resetInput();
  }, [flow.length, resetInput]);

  /**
   * Leave the wizard from the landing screen.
   *
   * /quote is reached from a CTA, so history.back() returns the visitor to the
   * page they came from. Opened directly — a pasted link, a new tab — there is
   * nothing to go back to, so it falls through to the homepage.
   */
  const handleExit = useCallback(() => {
    if (typeof window === "undefined") return;
    if (window.history.length > 1) window.history.back();
    else window.location.href = "/";
  }, []);

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

  /* ── group steps ── */
  function setGroupField(f: GroupField, value: string | string[]) {
    setGroupVal((g) => ({ ...g, [f.field]: value }));
    setGroupErr((e) => ({ ...e, [f.field]: "" }));
    setError("");
  }

  function toggleGroupMulti(f: GroupField, value: string) {
    const cur = Array.isArray(groupVal[f.field]) ? (groupVal[f.field] as string[]) : [];
    setGroupField(f, cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value]);
  }

  function handleGroupSubmit() {
    if (step.type !== "group") return;
    const errs: Record<string, string> = {};
    const collected: FormData = {};

    for (const f of step.fields) {
      const raw = groupVal[f.field];
      if (f.kind === "multi") {
        const arr = Array.isArray(raw) ? raw : [];
        if (!arr.length && !f.optional) errs[f.field] = "Select at least one option.";
        else if (arr.length) collected[f.field] = arr;
        continue;
      }
      const v = typeof raw === "string" ? raw : "";
      if (f.kind === "select") {
        if (!v && !f.optional) errs[f.field] = "Please choose an option.";
        else if (v) collected[f.field] = v;
        continue;
      }
      const msg = validateText(v, f.validation, !!f.optional);
      if (msg) errs[f.field] = msg;
      else if (v.trim()) collected[f.field] = v.trim();
    }

    if (Object.keys(errs).length) {
      setGroupErr(errs);
      return;
    }

    const newData = { ...data, ...collected };
    setData(newData);
    if (flow[stepIndex + 1] === "submitted") submitForm(newData);
    else goNext();
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
      fireConversion();
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

  /* Question numbering excludes the splash and the confirmation, so "Step 3 of 5"
     counts the five the splash promised rather than the seven entries in `flow`. */
  const questionCount = flow.length - 2;
  const questionNumber =
    step?.type === "splash" || step?.type === "submitted" ? 0 : stepIndex;
  const greeting = useMemo(() => {
    // Splash uses the headline itself for the agent's intro line
    if (stepKey === "welcome") return undefined;
    if (stepKey === "role") return "Let's get to know you.";
    if (stepKey === "assocBoard" || stepKey === "assocOwner") return "Tell me about your association.";
    if (stepKey === "where") return "Where are we looking?";
    if (stepKey === "reviewBoard") return "What should we put in front of the markets?";
    if (stepKey === "needOwner") return "What are you after?";
    if (stepKey === "contact") return "Last one.";
    return undefined;
  }, [stepKey]);

  return (
    <div className="qf-root">
      <Confetti active={showConfetti} />
      <ProgressBar current={Math.min(stepIndex, totalSteps)} total={totalSteps} />

      {/* Fixed bar on every screen: back on the left, wordmark centred, controls
          right. Back is rendered as a disabled placeholder on the splash rather
          than removed, so the bar does not reflow between steps. */}
      <header className="qf-bar">
        <div className="qf-bar-left">
          {/* Back appears on the landing screen only, and it leaves the wizard
              rather than stepping within it. Once the flow starts there is no
              back control — see handleExit for why the splash keeps one. */}
          {step?.type === "splash" ? (
            <BackButton onClick={handleExit} label="Back to site" />
          ) : (
            <span className="qf-bar-spacer" aria-hidden="true" />
          )}
        </div>
        {/* The splash and confirmation render their own full-size logo, so the bar
            skips it there rather than showing the mark twice. */}
        {step?.type !== "splash" && step?.type !== "submitted" ? (
          <BrandMark small />
        ) : (
          <span className="qf-bar-spacer" aria-hidden="true" />
        )}
        <div className="qf-bar-right">
          {stepIndex > 0 && step?.type !== "submitted" && <RestartButton onClick={handleRestart} />}
          <ThemeIndicator isDay={isDay} onToggle={onToggleTheme} />
        </div>
      </header>

      {/* Question steps only: the splash has not started and the confirmation is
          past the end, so a step count on either would be misleading. */}
      {questionNumber > 0 && (
        <StepIndicator current={questionNumber} total={questionCount} />
      )}

      <SupportChip phone={PHONE} href={PHONE_HREF} />

      <div className="qf-stage">
        {/* No `progress` prop: the ring around the avatar is gone in favour of the
            single linear bar at the top of the screen. Two competing progress
            indicators read as two different measurements. */}
        {showAgentHeader && (
          <AgentHeader agent={agent} greeting={greeting} typeGreeting />
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
                <span>Tell me about your association and I'll get the review started.</span>
              </div>
              {/* Stating the length is the strongest lever on completion. */}
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

          {/* GROUP — several related fields on one screen */}
          {step?.type === "group" && (
            <div>
              <h2 className="qf-question">{step.question}</h2>
              {step.sub && <p className="qf-sub-small">{step.sub}</p>}
              <div className="qf-group">
                {step.fields.map((f) => (
                  <div
                    key={f.field}
                    className={"qf-group-field" + (f.half ? " qf-group-field--half" : "")}
                  >
                    <label className="qf-label" htmlFor={`qf-${f.field}`}>
                      {f.label}
                      {f.optional && <span className="qf-optional"> · optional</span>}
                    </label>

                    {f.kind === "select" && (
                      <SelectField
                        value={(groupVal[f.field] as string) || ""}
                        onChange={(v) => setGroupField(f, v)}
                        options={f.options ?? []}
                        placeholder={f.placeholder}
                      />
                    )}

                    {f.kind === "text" && (
                      <input
                        id={`qf-${f.field}`}
                        className="qf-input"
                        type={f.inputType || "text"}
                        value={(groupVal[f.field] as string) || ""}
                        placeholder={f.placeholder}
                        autoComplete="off"
                        onChange={(e) => setGroupField(f, e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            handleGroupSubmit();
                          }
                        }}
                      />
                    )}

                    {f.kind === "multi" && (
                      <div className="qf-options qf-options--compact">
                        {(f.options ?? []).map((opt) => (
                          <CardOption
                            key={opt.value}
                            label={opt.label}
                            iconKey={opt.icon}
                            selected={
                              Array.isArray(groupVal[f.field]) &&
                              (groupVal[f.field] as string[]).includes(opt.value)
                            }
                            onClick={() => toggleGroupMulti(f, opt.value)}
                            showCheck
                          />
                        ))}
                      </div>
                    )}

                    {groupErr[f.field] && <p className="qf-error">{groupErr[f.field]}</p>}
                  </div>
                ))}
              </div>
              {error && <p className="qf-error">{error}</p>}
              <PrimaryButton
                onClick={handleGroupSubmit}
                label={flow[stepIndex + 1] === "submitted" ? "Send my request" : "Continue"}
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
              <h2 className="qf-headline">Thank you. We have it.</h2>
              <p className="qf-sub">
                A member of our team will be in touch within one business day. We may ask for
                your current declarations page — that is usually all we need to start.
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
