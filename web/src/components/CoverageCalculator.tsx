import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { QUOTE_URL, FORMSUBMIT_URL, fireConversion } from "../constants";
import { submitCrmLead } from "../lib/crmLead";
import "./CoverageCalculator.css";

/* ── Types ── */
type Priority = "essential" | "recommended" | "consider";
type CalcStep = "address" | "units" | "results";

interface CoverageResult {
  name: string;
  icon: string;
  priority: Priority;
  reason: string;
}

/* ── Google Places autocomplete loader ── */
const GOOGLE_API_KEY = import.meta.env.PUBLIC_GOOGLE_PLACES_KEY || "";

function loadGooglePlaces(): Promise<void> {
  return new Promise((resolve, reject) => {
    // No key configured — don't inject a script that can only fail with
    // NoApiKeys/InvalidKey. The manual fallback below carries the flow.
    if (!GOOGLE_API_KEY) {
      reject(new Error("No Google Places key configured"));
      return;
    }
    if (window.google?.maps?.places) {
      resolve();
      return;
    }
    const existing = document.querySelector(`script[src*="maps.googleapis.com"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve());
      return;
    }
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_API_KEY}&libraries=places`;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load Google Maps"));
    document.head.appendChild(script);
  });
}

/* ── State mapping ── */
const STATE_ABBR_TO_NAME: Record<string, string> = {
  MA: "Massachusetts", RI: "Rhode Island", NH: "New Hampshire",
  CT: "Connecticut", NY: "New York", OK: "Oklahoma",
};

const SUPPORTED_STATES = new Set(Object.keys(STATE_ABBR_TO_NAME));

function extractStateFromPlace(place: google.maps.places.PlaceResult): string | null {
  if (!place.address_components) return null;
  for (const comp of place.address_components) {
    if (comp.types.includes("administrative_area_level_1")) {
      const abbr = comp.short_name?.toUpperCase();
      if (abbr && SUPPORTED_STATES.has(abbr)) return abbr;
    }
  }
  return null;
}

/* ── Coverage logic ── */
function getCoverages(state: string, units: number): CoverageResult[] {
  const results: CoverageResult[] = [];

  results.push({ name: "Master Property", icon: "building", priority: "essential", reason: "Protects buildings and common areas at replacement cost." });
  results.push({ name: "General Liability", icon: "shield", priority: "essential", reason: "Covers slip & fall, premises liability, and defense costs." });
  results.push({ name: "Directors & Officers", icon: "briefcase", priority: "essential", reason: "Protects board members from governance and decision disputes." });

  if (units >= 20) {
    results.push({ name: "Umbrella / Excess", icon: "umbrella", priority: "essential", reason: `With ${units} units, higher liability limits are critical.` });
    results.push({ name: "Crime / Fidelity", icon: "lock", priority: "essential", reason: "Larger budgets mean higher theft and fraud exposure." });
  } else if (units >= 10) {
    results.push({ name: "Umbrella / Excess", icon: "umbrella", priority: "recommended", reason: "Extended liability limits provide an important safety net." });
    results.push({ name: "Crime / Fidelity", icon: "lock", priority: "recommended", reason: "Protects association funds from employee theft and fraud." });
  } else {
    results.push({ name: "Umbrella / Excess", icon: "umbrella", priority: "consider", reason: "Extra liability protection, especially for common areas." });
    results.push({ name: "Crime / Fidelity", icon: "lock", priority: "consider", reason: "Consider if the association handles significant funds." });
  }

  if (["MA", "CT", "NH", "NY"].includes(state)) {
    results.push({ name: "Ordinance or Law", icon: "scale", priority: "essential", reason: state === "NY" ? "NYC Local Law 11 and strict codes require this." : "Strict building codes increase rebuild costs significantly." });
  } else {
    results.push({ name: "Ordinance or Law", icon: "scale", priority: "recommended", reason: state === "OK" ? "Storm rebuilds must meet current codes — costs can spike." : "Coastal codes can increase reconstruction costs." });
  }

  results.push({ name: "HO-6 Program", icon: "home", priority: units >= 10 ? "recommended" : "consider", reason: "Coordinated unit owner coverage reduces claims conflicts." });

  return results;
}

function getRiskCallouts(state: string, units: number): string[] {
  const c: string[] = [];
  if (state === "MA") c.push("Water damage and freeze claims are the #1 cause of loss for MA associations. Per-unit water deductibles are increasingly common.");
  if (state === "CT") c.push("Water damage is the leading claim type for Connecticut condominiums. Aging buildings need accurate valuation.");
  if (state === "NH") c.push("Ice dams and freeze damage drive significant claims in NH. Building valuation must account for current construction costs.");
  if (state === "OK") c.push("Hail and wind are the leading claim drivers in Oklahoma. Adequate replacement cost coverage is critical.");
  if (state === "NY" && units >= 50) c.push("NYC high-rise associations face significantly higher replacement cost valuations and FISP facade inspection requirements.");
  if (state === "NY" && units < 50) c.push("New York's regulatory environment demands comprehensive D&O and proper building valuation.");
  if (state === "RI") c.push("Coastal properties may require separate wind/flood coverage. Loss assessment exposure is growing for RI unit owners.");
  if (units >= 30) c.push(`With ${units} units, your association should strongly consider umbrella coverage of $5M or more.`);
  return c.slice(0, 3);
}

/* ── Icons ── */
const ICONS: Record<string, JSX.Element> = {
  building: <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="3" width="16" height="18" rx="1"/><path d="M8 7h.01M12 7h.01M16 7h.01M8 11h.01M12 11h.01M16 11h.01M8 15h.01M12 15h.01M16 15h.01"/><path d="M10 21v-3h4v3"/></svg>,
  shield: <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2l8 4v6c0 5-3.5 9.5-8 10-4.5-.5-8-5-8-10V6l8-4z"/></svg>,
  briefcase: <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a2 2 0 012-2h2a2 2 0 012 2v2"/><path d="M3 13h18"/></svg>,
  umbrella: <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2v2"/><path d="M2 12a10 10 0 0120 0H2z"/><path d="M12 12v7a3 3 0 01-6 0"/></svg>,
  lock: <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 018 0v4"/></svg>,
  scale: <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v18"/><path d="M5 7h14"/><path d="M5 7l-2 6a4 4 0 008 0L9 7"/><path d="M19 7l-2 6a4 4 0 008 0l-2-6"/></svg>,
  home: <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/></svg>,
};

const PRIORITY_LABELS: Record<Priority, string> = {
  essential: "Essential",
  recommended: "Recommended",
  consider: "Consider",
};

/* ── Component ── */
export function CoverageCalculator() {
  const [step, setStep] = useState<CalcStep>("address");
  const [address, setAddress] = useState("");
  const [stateAbbr, setStateAbbr] = useState("");
  const [stateName, setStateName] = useState("");
  const [unitInput, setUnitInput] = useState("");
  const [email, setEmail] = useState("");
  const [emailSent, setEmailSent] = useState(false);
  const [emailError, setEmailError] = useState("");
  const [sending, setSending] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  // Places is an enhancement, not a requirement: if it never resolves a
  // state (no key, blocked script, offline, ad-blocker), the visitor picks
  // one manually rather than being dead-ended on step 1.
  const [needsManualState, setNeedsManualState] = useState(false);
  const [manualState, setManualState] = useState("");
  const addressRef = useRef<HTMLInputElement>(null);
  const autocompleteRef = useRef<google.maps.places.Autocomplete | null>(null);

  const units = parseInt(unitInput, 10) || 0;

  const coverages = useMemo(
    () => (step === "results" && stateAbbr && units > 0 ? getCoverages(stateAbbr, units) : []),
    [step, stateAbbr, units]
  );

  const callouts = useMemo(
    () => (step === "results" && stateAbbr && units > 0 ? getRiskCallouts(stateAbbr, units) : []),
    [step, stateAbbr, units]
  );

  // Init Google Places
  const initAutocomplete = useCallback(() => {
    if (!addressRef.current || autocompleteRef.current) return;
    try {
      const ac = new google.maps.places.Autocomplete(addressRef.current, {
        types: ["address"],
        componentRestrictions: { country: "us" },
        fields: ["address_components", "formatted_address"],
      });
      ac.addListener("place_changed", () => {
        const place = ac.getPlace();
        if (!place.formatted_address) return;
        setAddress(place.formatted_address);
        const st = extractStateFromPlace(place);
        if (st) {
          setStateAbbr(st);
          setStateName(STATE_ABBR_TO_NAME[st] || st);
          setUnsupported(false);
          setStep("units");
        } else {
          setUnsupported(true);
          setStateAbbr("");
          setStateName("");
        }
      });
      autocompleteRef.current = ac;
    } catch {
      /* Google Maps not loaded */
    }
  }, []);

  useEffect(() => {
    loadGooglePlaces().then(initAutocomplete).catch(() => {});
  }, [initAutocomplete]);

  // Also try to init when the input renders
  useEffect(() => {
    if (addressRef.current && window.google?.maps?.places && !autocompleteRef.current) {
      initAutocomplete();
    }
  });

  /**
   * Manual path forward. Uses the state Places already resolved when it's
   * available; otherwise reveals a state picker (the coverage logic is
   * state-driven, so it's the one field we genuinely can't infer).
   */
  function handleAddressContinue(e: React.FormEvent) {
    e.preventDefault();
    if (!address.trim()) return;
    const st = stateAbbr || manualState;
    if (!st) {
      setNeedsManualState(true);
      return;
    }
    setStateAbbr(st);
    setStateName(STATE_ABBR_TO_NAME[st] || st);
    setUnsupported(false);
    setStep("units");
  }

  function handleUnitSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (units > 0) setStep("results");
  }

  async function handleEmailSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || sending) return;
    setSending(true);
    setEmailError("");
    void submitCrmLead({
      type: "ASSOCIATION",
      name: address || email.trim(),
      contactEmail: email.trim(),
      address: address || undefined,
      state: stateAbbr || undefined,
      source: "website-coverage-calculator",
      notes: [
        units ? `Unit count: ${units}` : undefined,
        coverages.length
          ? `Coverages shown: ${coverages.map((c) => c.name).join(", ")}`
          : undefined,
      ]
        .filter(Boolean)
        .join("\n") || undefined,
    });
    try {
      const res = await fetch(FORMSUBMIT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          _subject: `Coverage Calculator Lead — ${address}`,
          _template: "table",
          _captcha: "false",
          _replyto: email.trim(),
          Email: email.trim(),
          Address: address,
          State: `${stateName} (${stateAbbr})`,
          "Unit Count": String(units),
          "Coverages Shown": coverages.map((c) => `${c.name} (${c.priority})`).join(", "),
          Source: "Coverage Calculator",
        }),
      });
      if (!res.ok) throw new Error("fail");
      fireConversion();
      setEmailSent(true);
    } catch {
      setEmailError("Something went wrong. Please try again or call 508-233-2261.");
    } finally {
      setSending(false);
    }
  }

  function handleReset() {
    setStep("address");
    setAddress("");
    setStateAbbr("");
    setStateName("");
    setUnitInput("");
    setEmail("");
    setEmailSent(false);
    setEmailError("");
    setUnsupported(false);
    setNeedsManualState(false);
    setManualState("");
    autocompleteRef.current = null;
    setTimeout(() => initAutocomplete(), 100);
  }

  const quoteHref = `${QUOTE_URL}?state=${stateAbbr}`;

  return (
    <section className="section calc-section" id="calculator">
      <div className="container">
        <div className="calc-header">
          <span className="calc-badge">Interactive Tool</span>
          <h2 className="section-title">What Coverage Does Your Association Need?</h2>
          <p className="section-subtitle">
            Enter your property address to get a personalized coverage recommendation.
          </p>
        </div>

        {/* Step 1: Address */}
        {step === "address" && (
          <div className="calc-step calc-step--address">
            <form className="calc-address-wrap" onSubmit={handleAddressContinue}>
              <div className="calc-field calc-field--large">
                <label htmlFor="calc-address">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>
                  Property Address
                </label>
                <input
                  ref={addressRef}
                  id="calc-address"
                  type="text"
                  placeholder="Start typing your association's address..."
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  autoComplete="off"
                />
              </div>

              {needsManualState && !stateAbbr && (
                <div className="calc-field calc-field--state">
                  <label htmlFor="calc-state">Which state is it in?</label>
                  <select
                    id="calc-state"
                    value={manualState}
                    onChange={(e) => setManualState(e.target.value)}
                    autoFocus
                  >
                    <option value="">Select a state…</option>
                    {Object.entries(STATE_ABBR_TO_NAME)
                      .sort((a, b) => a[1].localeCompare(b[1]))
                      .map(([abbr, name]) => (
                        <option key={abbr} value={abbr}>
                          {name}
                        </option>
                      ))}
                  </select>
                </div>
              )}

              {address.trim().length >= 4 && (
                <button type="submit" className="btn btn-primary calc-btn">
                  Continue
                </button>
              )}

              {unsupported && (
                <p className="calc-unsupported">
                  We currently serve associations in MA, RI, NH, CT, NY, and OK. Select a property in one of these states.
                </p>
              )}
            </form>
          </div>
        )}

        {/* Step 2: Units */}
        {step === "units" && (
          <div className="calc-step calc-step--units">
            <div className="calc-address-display">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>
              <span>{address}</span>
              <button type="button" className="calc-change" onClick={handleReset}>Change</button>
            </div>
            <form onSubmit={handleUnitSubmit} className="calc-units-form">
              <div className="calc-field">
                <label htmlFor="calc-units">How many units in your association?</label>
                <input
                  id="calc-units"
                  type="number"
                  min="1"
                  max="9999"
                  placeholder="e.g. 48"
                  value={unitInput}
                  onChange={(e) => setUnitInput(e.target.value)}
                  autoFocus
                />
              </div>
              <button type="submit" className="btn btn-primary calc-btn" disabled={units <= 0}>
                See My Coverage
              </button>
            </form>
          </div>
        )}

        {/* Step 3: Results + email capture */}
        {step === "results" && (
          <div className="calc-results calc-results--visible">
            <div className="calc-address-display">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>
              <span>{address} &middot; {units} units</span>
              <button type="button" className="calc-change" onClick={handleReset}>Start over</button>
            </div>

            {/* Email gate — show before full results */}
            {!emailSent ? (
              <div className="calc-email-gate">
                <div className="calc-email-preview">
                  <h3>Your {stateName} coverage recommendation is ready</h3>
                  <p>We found <strong>{coverages.filter((c) => c.priority === "essential").length} essential</strong> and <strong>{coverages.filter((c) => c.priority === "recommended").length} recommended</strong> coverages for your {units}-unit association. Enter your email to see the full breakdown.</p>
                  <div className="calc-preview-pills">
                    {coverages.slice(0, 4).map((cov) => (
                      <span key={cov.name} className={`calc-pill calc-pill--${cov.priority}`}>
                        {cov.name}
                      </span>
                    ))}
                    <span className="calc-pill calc-pill--more">+{coverages.length - 4} more</span>
                  </div>
                </div>
                <form onSubmit={handleEmailSubmit} className="calc-email-form">
                  <input
                    type="email"
                    placeholder="Your email address"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    className="calc-email-input"
                    autoFocus
                  />
                  <button type="submit" className="btn btn-gold calc-email-btn" disabled={sending}>
                    {sending ? "Sending..." : "Show My Results"}
                  </button>
                  {emailError && <p className="calc-unsupported">{emailError}</p>}
                  <p className="calc-email-note">We'll send a copy to your inbox. No spam, ever.</p>
                </form>
              </div>
            ) : (
              <>
                <div className="calc-results-header">
                  <h3>Recommended for your <strong>{units}-unit</strong> {stateName} association</h3>
                </div>

                <div className="calc-grid">
                  {coverages.map((cov, i) => (
                    <div
                      key={cov.name}
                      className={`calc-card calc-card--${cov.priority}`}
                      style={{ animationDelay: `${i * 0.07}s` }}
                    >
                      <div className="calc-card-top">
                        <span className="calc-card-icon">{ICONS[cov.icon]}</span>
                        <span className={`calc-priority calc-priority--${cov.priority}`}>
                          {PRIORITY_LABELS[cov.priority]}
                        </span>
                      </div>
                      <h4 className="calc-card-name">{cov.name}</h4>
                      <p className="calc-card-reason">{cov.reason}</p>
                    </div>
                  ))}
                </div>

                {callouts.length > 0 && (
                  <div className="calc-callouts">
                    {callouts.map((text, i) => (
                      <div key={i} className="calc-callout">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>
                        </svg>
                        <p>{text}</p>
                      </div>
                    ))}
                  </div>
                )}

                <div className="calc-cta">
                  <a href={quoteHref} className="btn btn-gold calc-cta-btn">
                    Get a Custom Quote for Your Association
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M5 12h14M12 5l7 7-7 7"/>
                    </svg>
                  </a>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
