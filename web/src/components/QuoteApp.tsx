import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  useContext,
  createContext,
  type ReactNode,
  type CSSProperties,
} from "react";
import { submitCrmLead, type CrmLeadInput } from "../lib/crmLead";
import { FORMSUBMIT_URL } from "../constants";

/* ──────────────────────────────────────────────────────────
   PALETTES — dark (night) + light (day)
   Auto-switched based on local time of day.
   ────────────────────────────────────────────────────────── */
type Palette = {
  bg: string;
  card: string;
  cardHover: string;
  border: string;
  borderActive: string;
  accent: string;
  accentHover: string;
  accentDim: string;
  accentGlow: string;
  text: string;
  textMuted: string;
  white: string;
  error: string;
  success: string;
};

const DARK: Palette = {
  bg: "#0b1220",
  card: "#131c2e",
  cardHover: "#182339",
  border: "#1f2a40",
  borderActive: "#4da6ff",
  accent: "#4da6ff",
  accentHover: "#79bbff",
  accentDim: "rgba(77,166,255,0.10)",
  accentGlow: "rgba(77,166,255,0.35)",
  text: "#e6edf3",
  textMuted: "#8b95a8",
  white: "#ffffff",
  error: "#f85149",
  success: "#3fb950",
};

const LIGHT: Palette = {
  bg: "#f6f8fc",
  card: "#ffffff",
  cardHover: "#f0f4fb",
  border: "#dfe5ef",
  borderActive: "#1f7ae0",
  accent: "#1f7ae0",
  accentHover: "#1668c4",
  accentDim: "rgba(31,122,224,0.08)",
  accentGlow: "rgba(31,122,224,0.22)",
  text: "#0f172a",
  textMuted: "#5b6776",
  white: "#ffffff",
  error: "#d92d20",
  success: "#16a34a",
};

/* Day = 6:00 → 17:59 local time. Night otherwise. */
function isDaytime(d = new Date()): boolean {
  const h = d.getHours();
  return h >= 6 && h < 18;
}

const ThemeContext = createContext<Palette>(DARK);
const useTheme = () => useContext(ThemeContext);

/* ──────────────────────────────────────────────────────────
   AGENT ROSTER — rotates per session
   ────────────────────────────────────────────────────────── */
type Agent = { name: string; photo: string };

const AGENTS: Agent[] = [
  { name: "Maya Chen",        photo: "/agents/1.jpg" },
  { name: "David Reyes",      photo: "/agents/2.jpg" },
  { name: "Sarah Kim",        photo: "/agents/3.jpg" },
  { name: "Michael O'Brien",  photo: "/agents/4.jpg" },
  { name: "Priya Patel",      photo: "/agents/5.jpg" },
  { name: "Marcus Johnson",   photo: "/agents/6.jpg" },
  { name: "Emma Hartley",     photo: "/agents/7.jpg" },
  { name: "James Walker",     photo: "/agents/8.jpg" },
];

function pickAgent(): Agent {
  return AGENTS[Math.floor(Math.random() * AGENTS.length)];
}

/* ──────────────────────────────────────────────────────────
   PERSISTENCE — survive refresh
   ────────────────────────────────────────────────────────── */
const STORAGE_KEY = "qf:state:v1";
const THEME_KEY = "qf:theme:v1";

type PersistedState = {
  stepIndex: number;
  data: FormData;
  role: string | null;
  agent: Agent;
  inputVal: string;
  multiVal: string[];
};

function loadState(): PersistedState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    if (
      typeof parsed.stepIndex !== "number" ||
      !parsed.data ||
      !parsed.agent
    ) {
      return null;
    }
    return {
      stepIndex: parsed.stepIndex,
      data: parsed.data as FormData,
      role: parsed.role ?? null,
      agent: parsed.agent as Agent,
      inputVal: typeof parsed.inputVal === "string" ? parsed.inputVal : "",
      multiVal: Array.isArray(parsed.multiVal) ? parsed.multiVal : [],
    };
  } catch {
    return null;
  }
}

function saveState(s: PersistedState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* quota exceeded or private mode — silently ignore */
  }
}

function clearState() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/* ──────────────────────────────────────────────────────────
   ICONS — inline SVGs (no deps)
   ────────────────────────────────────────────────────────── */
type IconProps = { size?: number; color?: string };
const Icon = {
  Board: ({ size = 32, color = "currentColor" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 21h18" />
      <path d="M5 21V7l7-4 7 4v14" />
      <path d="M9 21v-6h6v6" />
      <path d="M9 11h.01M12 11h.01M15 11h.01" />
    </svg>
  ),
  Manager: ({ size = 32, color = "currentColor" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18" />
      <path d="M8 14h2M14 14h2" />
    </svg>
  ),
  Owner: ({ size = 32, color = "currentColor" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 11l9-7 9 7" />
      <path d="M5 10v10h14V10" />
      <path d="M10 20v-6h4v6" />
    </svg>
  ),
  Condo: ({ size = 32, color = "currentColor" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="3" width="16" height="18" rx="1" />
      <path d="M8 7h.01M12 7h.01M16 7h.01M8 11h.01M12 11h.01M16 11h.01M8 15h.01M12 15h.01M16 15h.01" />
      <path d="M10 21v-3h4v3" />
    </svg>
  ),
  Townhouse: ({ size = 32, color = "currentColor" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 21V10l4-4 4 4v11" />
      <path d="M11 21V10l4-4 4 4v11" />
      <path d="M6 21v-5M14 21v-5" />
    </svg>
  ),
  Mixed: ({ size = 32, color = "currentColor" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="11" width="8" height="10" />
      <rect x="13" y="3" width="8" height="18" />
      <path d="M5 15h.01M5 18h.01M15 7h.01M15 11h.01M15 15h.01M19 7h.01M19 11h.01M19 15h.01" />
    </svg>
  ),
  Building: ({ size = 32, color = "currentColor" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="5" y="2" width="14" height="20" rx="1" />
      <path d="M9 6h.01M13 6h.01M9 10h.01M13 10h.01M9 14h.01M13 14h.01" />
      <path d="M10 22v-4h4v4" />
    </svg>
  ),
  Shield: ({ size = 32, color = "currentColor" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2l8 4v6c0 5-3.5 9.5-8 10-4.5-.5-8-5-8-10V6l8-4z" />
    </svg>
  ),
  Scale: ({ size = 32, color = "currentColor" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v18" />
      <path d="M5 7h14" />
      <path d="M5 7l-2 6a4 4 0 008 0L9 7" />
      <path d="M19 7l-2 6a4 4 0 008 0l-2-6" />
    </svg>
  ),
  Briefcase: ({ size = 32, color = "currentColor" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <path d="M9 7V5a2 2 0 012-2h2a2 2 0 012 2v2" />
      <path d="M3 13h18" />
    </svg>
  ),
  Umbrella: ({ size = 32, color = "currentColor" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2v2" />
      <path d="M2 12a10 10 0 0120 0H2z" />
      <path d="M12 12v7a3 3 0 01-6 0" />
    </svg>
  ),
  Lock: ({ size = 32, color = "currentColor" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 018 0v4" />
    </svg>
  ),
  Document: ({ size = 32, color = "currentColor" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
      <path d="M14 2v6h6" />
      <path d="M9 14h6M9 18h6" />
    </svg>
  ),
  Sparkle: ({ size = 32, color = "currentColor" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2z" />
    </svg>
  ),
  Check: ({ size = 18, color = "currentColor" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12l5 5 9-11" />
    </svg>
  ),
  ArrowLeft: ({ size = 18, color = "currentColor" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 12H5M12 5l-7 7 7 7" />
    </svg>
  ),
  ArrowRight: ({ size = 18, color = "currentColor" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12h14M12 5l7 7-7 7" />
    </svg>
  ),
  Yes: ({ size = 32, color = "currentColor" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="M8 12l3 3 5-6" />
    </svg>
  ),
  No: ({ size = 32, color = "currentColor" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="M9 9l6 6M15 9l-6 6" />
    </svg>
  ),
  Question: ({ size = 32, color = "currentColor" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="M9.5 9a2.5 2.5 0 015 0c0 1.5-2.5 2-2.5 4" />
      <path d="M12 17h.01" />
    </svg>
  ),
  Phone: ({ size = 18, color = "currentColor" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.13.96.37 1.9.72 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.91.35 1.85.59 2.81.72A2 2 0 0122 16.92z" />
    </svg>
  ),
  Restart: ({ size = 18, color = "currentColor" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v5h5" />
    </svg>
  ),
};

type IconKey = keyof typeof Icon;

/* ──────────────────────────────────────────────────────────
   STEP DEFINITIONS
   ────────────────────────────────────────────────────────── */
type Option = { value: string; label: string; icon?: IconKey; sub?: string };

type Step =
  | { type: "splash"; headline: string; sub: string }
  | { type: "select"; question: string; field?: string; options: Option[]; sub?: string }
  | {
      type: "text";
      question: string;
      placeholder: string;
      field: string;
      inputType?: string;
      optional?: boolean;
      sub?: string;
      validation?: "email" | "phone";
    }
  | { type: "multi"; question: string; sub?: string; field: string; options: Option[] }
  | { type: "submitted" };

/* ── Validators ── */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function validateText(
  raw: string,
  validation: "email" | "phone" | undefined,
  optional: boolean
): string | null {
  const v = raw.trim();
  if (!v) {
    return optional ? null : "Please enter a value to continue.";
  }
  if (validation === "email") {
    if (!EMAIL_RE.test(v)) return "Please enter a valid email address.";
  }
  if (validation === "phone") {
    const digits = v.replace(/\D/g, "");
    if (digits.length < 10) return "Please enter a valid phone number.";
  }
  return null;
}

const STEPS: Record<string, Step> = {
  welcome: {
    type: "splash",
    // headline is rendered dynamically in JSX so it can include the agent's name
    headline: "",
    sub: "Free, fast, and never any spam.",
  },
  role: {
    type: "select",
    question: "First — which best describes you?",
    field: "role",
    options: [
      { value: "board", label: "Board member or trustee", icon: "Board", sub: "I serve on the HOA board" },
      { value: "manager", label: "Property manager", icon: "Manager", sub: "I manage the property" },
      { value: "owner", label: "Unit owner (HO‑6)", icon: "Owner", sub: "I own a unit in the HOA" },
    ],
  },

  /* shared */
  assocName: {
    type: "text",
    question: "What's the name of your association?",
    placeholder: "e.g. Maple Ridge Condominium Trust",
    field: "associationName",
  },
  state: {
    type: "select",
    question: "Which state is the property in?",
    field: "state",
    options: [
      { value: "MA", label: "Massachusetts" },
      { value: "RI", label: "Rhode Island" },
      { value: "CT", label: "Connecticut" },
      { value: "NH", label: "New Hampshire" },
      { value: "OTHER", label: "Other" },
    ],
  },
  city: {
    type: "text",
    question: "City or town?",
    placeholder: "e.g. Marlborough",
    field: "city",
  },

  /* board / manager */
  unitCount: {
    type: "text",
    question: "How many units in the association?",
    placeholder: "e.g. 48",
    field: "unitCount",
    inputType: "number",
  },
  propertyType: {
    type: "select",
    question: "What type of property?",
    field: "propertyType",
    options: [
      { value: "condo", label: "Condominium", icon: "Condo" },
      { value: "townhouse", label: "Townhouse", icon: "Townhouse" },
      { value: "mixed", label: "Mixed use", icon: "Mixed" },
      { value: "other", label: "Other", icon: "Building" },
    ],
  },
  yearBuilt: {
    type: "text",
    question: "Approximate year built?",
    placeholder: "e.g. 1985",
    field: "yearBuilt",
    inputType: "number",
  },
  coverageNeeds: {
    type: "multi",
    question: "What coverage are you looking for?",
    sub: "Select all that apply.",
    field: "coverageNeeds",
    options: [
      { value: "master_property", label: "Master Property", icon: "Building" },
      { value: "general_liability", label: "General Liability", icon: "Shield" },
      { value: "dno", label: "Directors & Officers (D&O)", icon: "Briefcase" },
      { value: "umbrella", label: "Umbrella / Excess", icon: "Umbrella" },
      { value: "crime", label: "Crime / Fidelity", icon: "Lock" },
      { value: "ordinance", label: "Ordinance or Law", icon: "Scale" },
      { value: "not_sure", label: "Not sure — review everything", icon: "Sparkle" },
    ],
  },
  currentCarrier: {
    type: "text",
    question: "Who's your current carrier?",
    placeholder: "e.g. Amica, or 'not sure'",
    field: "currentCarrier",
    optional: true,
  },
  renewalDate: {
    type: "text",
    question: "When does your policy renew?",
    placeholder: "e.g. September 2026",
    field: "renewalDate",
    optional: true,
  },

  /* owner */
  masterDeductible: {
    type: "select",
    question: "Do you know your association's master policy deductible?",
    field: "masterDeductible",
    options: [
      { value: "yes_know", label: "Yes, I know it", icon: "Yes" },
      { value: "no", label: "No", icon: "No" },
      { value: "not_sure", label: "Not sure", icon: "Question" },
    ],
  },
  deductibleAmount: {
    type: "text",
    question: "What's the deductible amount?",
    placeholder: "e.g. $10,000",
    field: "deductibleAmount",
  },
  ho6Need: {
    type: "select",
    question: "What are you looking for?",
    field: "ho6Need",
    options: [
      { value: "new", label: "New HO‑6 policy", icon: "Document" },
      { value: "review", label: "Review my existing policy", icon: "Shield" },
      { value: "loss_assessment", label: "Loss assessment coverage", icon: "Scale" },
      { value: "not_sure", label: "Not sure — help me figure it out", icon: "Question" },
    ],
  },

  /* contact */
  contactName: {
    type: "text",
    question: "What's your name?",
    placeholder: "Full name",
    field: "contactName",
  },
  contactEmail: {
    type: "text",
    question: "Best email to reach you?",
    placeholder: "you@example.com",
    field: "contactEmail",
    inputType: "email",
    validation: "email",
  },
  contactPhone: {
    type: "text",
    question: "Phone number?",
    placeholder: "(508) 555-1234",
    field: "contactPhone",
    inputType: "tel",
    optional: true,
    validation: "phone",
  },

  submitted: { type: "submitted" },
};

const FLOW_BOARD = [
  "welcome", "role", "assocName", "state", "city",
  "unitCount", "propertyType", "yearBuilt", "coverageNeeds",
  "currentCarrier", "renewalDate",
  "contactName", "contactEmail", "contactPhone", "submitted",
];

const FLOW_OWNER = [
  "welcome", "role", "assocName", "state", "city",
  "masterDeductible", "ho6Need",
  "contactName", "contactEmail", "contactPhone", "submitted",
];

type FormData = Record<string, string | string[]>;

function getFlow(role: string | null, data: FormData): string[] {
  if (role === "owner") {
    const flow = [...FLOW_OWNER];
    if (data.masterDeductible === "yes_know") {
      const idx = flow.indexOf("masterDeductible");
      flow.splice(idx + 1, 0, "deductibleAmount");
    }
    return flow;
  }
  return FLOW_BOARD;
}

/* ──────────────────────────────────────────────────────────
   EMAIL SUBMISSION
   Uses FormSubmit (formsubmit.co) — no API key required.
   First send to a new address triggers a confirmation email.
   ────────────────────────────────────────────────────────── */

const ROLE_LABELS: Record<string, string> = {
  board: "Board Member / Trustee",
  manager: "Property Manager",
  owner: "Unit Owner (HO-6)",
};
const COVERAGE_LABELS: Record<string, string> = {
  master_property: "Master Property",
  general_liability: "General Liability",
  dno: "Directors & Officers (D&O)",
  umbrella: "Umbrella / Excess",
  crime: "Crime / Fidelity",
  ordinance: "Ordinance or Law",
  not_sure: "Not sure — review everything",
};
const PROPERTY_LABELS: Record<string, string> = {
  condo: "Condominium",
  townhouse: "Townhouse",
  mixed: "Mixed use",
  other: "Other",
};
const HO6_LABELS: Record<string, string> = {
  new: "New HO-6 policy",
  review: "Review existing policy",
  loss_assessment: "Loss assessment coverage",
  not_sure: "Not sure — needs guidance",
};
const DEDUCTIBLE_LABELS: Record<string, string> = {
  yes_know: "Yes, knows the amount",
  no: "No",
  not_sure: "Not sure",
};

/** Build a flat, label-friendly payload for FormSubmit. */
function buildSubmission(data: FormData, agentName: string) {
  const get = (k: string) => (typeof data[k] === "string" ? (data[k] as string) : "");
  const role = get("role");
  const name = get("contactName") || "Unknown";
  const association = get("associationName") || "—";

  const payload: Record<string, string> = {
    /* ── FormSubmit control fields ── */
    _subject: `🏢 New HOA Insurance Quote — ${name}${association !== "—" ? " · " + association : ""}`,
    _template: "table",
    _captcha: "false",
    _replyto: get("contactEmail") || "",

    /* ── Lead summary ── */
    "Submitted": new Date().toLocaleString("en-US", {
      dateStyle: "full",
      timeStyle: "short",
    }),
    "Assigned Agent": agentName,
    "Role": ROLE_LABELS[role] || role || "—",

    /* ── Contact ── */
    "Full Name": name,
    "Email": get("contactEmail") || "—",
    "Phone": get("contactPhone") || "—",

    /* ── Association ── */
    "Association": association,
    "City": get("city") || "—",
    "State": get("state") || "—",
  };

  if (role === "board" || role === "manager") {
    payload["Unit Count"] = get("unitCount") || "—";
    payload["Property Type"] = PROPERTY_LABELS[get("propertyType")] || get("propertyType") || "—";
    payload["Year Built"] = get("yearBuilt") || "—";

    const coverage = data.coverageNeeds;
    if (Array.isArray(coverage) && coverage.length) {
      payload["Coverage Needs"] = coverage
        .map((v) => COVERAGE_LABELS[v] || v)
        .join(", ");
    } else {
      payload["Coverage Needs"] = "—";
    }

    payload["Current Carrier"] = get("currentCarrier") || "—";
    payload["Renewal Date"] = get("renewalDate") || "—";
  }

  if (role === "owner") {
    payload["Knows Master Deductible"] =
      DEDUCTIBLE_LABELS[get("masterDeductible")] || get("masterDeductible") || "—";
    if (get("deductibleAmount")) {
      payload["Deductible Amount"] = get("deductibleAmount");
    }
    payload["What They Need"] = HO6_LABELS[get("ho6Need")] || get("ho6Need") || "—";
  }

  return payload;
}

/** Map the wizard's answers onto the CRM's web-lead shape. */
function buildCrmLead(data: FormData, agentName: string): CrmLeadInput {
  const get = (k: string) => (typeof data[k] === "string" ? (data[k] as string) : "");
  const role = get("role");
  const isOwner = role === "owner";
  const contactName = get("contactName");
  const association = get("associationName");
  const nameParts = contactName.split(/\s+/).filter(Boolean);
  const state = get("state");
  const coverage = data.coverageNeeds;

  const notes = [
    `Role: ${ROLE_LABELS[role] || role || "—"}`,
    `Assigned agent: ${agentName}`,
    isOwner && association ? `Association: ${association}` : undefined,
    !isOwner && get("unitCount") ? `Unit count: ${get("unitCount")}` : undefined,
    !isOwner && get("propertyType")
      ? `Property type: ${PROPERTY_LABELS[get("propertyType")] || get("propertyType")}`
      : undefined,
    !isOwner && get("yearBuilt") ? `Year built: ${get("yearBuilt")}` : undefined,
    !isOwner && Array.isArray(coverage) && coverage.length
      ? `Coverage needs: ${coverage.map((v) => COVERAGE_LABELS[v] || v).join(", ")}`
      : undefined,
    !isOwner && get("renewalDate") ? `Renewal date: ${get("renewalDate")}` : undefined,
    isOwner && get("masterDeductible")
      ? `Knows master deductible: ${DEDUCTIBLE_LABELS[get("masterDeductible")] || get("masterDeductible")}`
      : undefined,
    isOwner && get("deductibleAmount")
      ? `Master policy deductible: ${get("deductibleAmount")}`
      : undefined,
    isOwner && get("ho6Need")
      ? `What they need: ${HO6_LABELS[get("ho6Need")] || get("ho6Need")}`
      : undefined,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    type: isOwner ? "PERSONAL" : "ASSOCIATION",
    name: (isOwner ? contactName || association : association || contactName) || "Quote request",
    contactFirstName: nameParts[0] || undefined,
    contactLastName: nameParts.slice(1).join(" ") || undefined,
    contactEmail: get("contactEmail") || undefined,
    contactPhone: get("contactPhone") || undefined,
    city: get("city") || undefined,
    // "OTHER" is a flow branch, not a state — don't write it to the CRM.
    state: state && state !== "OTHER" ? state : undefined,
    currentCarrier: (!isOwner && get("currentCarrier")) || undefined,
    source: "website-quote",
    notes,
  };
}

async function sendQuoteEmail(data: FormData, agentName: string): Promise<void> {
  const payload = buildSubmission(data, agentName);
  const res = await fetch(FORMSUBMIT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`Mail relay returned ${res.status}`);
  }
  const json = (await res.json()) as { success?: string | boolean; message?: string };
  // FormSubmit returns success: "true" as a string in their JSON response
  const ok = json.success === true || json.success === "true";
  if (!ok) {
    throw new Error(json.message || "Mail relay rejected the submission");
  }
}

/* ──────────────────────────────────────────────────────────
   SHARED COMPONENTS
   ────────────────────────────────────────────────────────── */

function ProgressBar({ current, total }: { current: number; total: number }) {
  const pct = Math.max(0, Math.min(100, Math.round((current / total) * 100)));
  return (
    <div className="qf-progress">
      <div className="qf-progress-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

/* ── Typing animation ── */
function TypeWriter({ text, speed = 32, onDone }: { text: string; speed?: number; onDone?: () => void }) {
  const [displayed, setDisplayed] = useState("");
  const [done, setDone] = useState(false);

  useEffect(() => {
    setDisplayed("");
    setDone(false);
    let i = 0;
    const id = setInterval(() => {
      i++;
      setDisplayed(text.slice(0, i));
      if (i >= text.length) {
        clearInterval(id);
        setDone(true);
        onDone?.();
      }
    }, speed);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, speed]);

  return (
    <span>
      {displayed}
      {!done && <span className="qf-cursor">|</span>}
    </span>
  );
}

/* ── Progress ring around avatar ── */
function ProgressRing({ progress, size = 92, stroke = 3 }: { progress: number; size?: number; stroke?: number }) {
  const c = useTheme();
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - Math.min(1, Math.max(0, progress)));

  return (
    <svg
      className="qf-progress-ring"
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      style={{ position: "absolute", top: -4, left: -4 }}
    >
      {/* Track */}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={c.border}
        strokeWidth={stroke}
        opacity={0.4}
      />
      {/* Progress */}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={c.accent}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={dashOffset}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: "stroke-dashoffset 0.6s cubic-bezier(0.2,0.7,0.3,1)" }}
      />
    </svg>
  );
}

/* ── Confetti burst ── */
function Confetti({ active }: { active: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!active || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    const colors = ["#4da6ff", "#d1b378", "#3fb950", "#f85149", "#79bbff", "#e8d5a8", "#ff6eb4", "#ffd700"];
    const particles: {
      x: number; y: number; vx: number; vy: number;
      w: number; h: number; color: string; rotation: number; spin: number;
      gravity: number; opacity: number;
    }[] = [];

    for (let i = 0; i < 120; i++) {
      particles.push({
        x: canvas.width / 2 + (Math.random() - 0.5) * 200,
        y: canvas.height * 0.4,
        vx: (Math.random() - 0.5) * 16,
        vy: -Math.random() * 18 - 4,
        w: Math.random() * 8 + 4,
        h: Math.random() * 6 + 2,
        color: colors[Math.floor(Math.random() * colors.length)],
        rotation: Math.random() * 360,
        spin: (Math.random() - 0.5) * 12,
        gravity: 0.25 + Math.random() * 0.15,
        opacity: 1,
      });
    }

    let frame: number;
    let elapsed = 0;

    function draw() {
      ctx!.clearRect(0, 0, canvas.width, canvas.height);
      elapsed++;

      for (const p of particles) {
        p.vy += p.gravity;
        p.x += p.vx;
        p.y += p.vy;
        p.rotation += p.spin;
        p.vx *= 0.99;
        if (elapsed > 60) p.opacity = Math.max(0, p.opacity - 0.015);

        ctx!.save();
        ctx!.translate(p.x, p.y);
        ctx!.rotate((p.rotation * Math.PI) / 180);
        ctx!.globalAlpha = p.opacity;
        ctx!.fillStyle = p.color;
        ctx!.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx!.restore();
      }

      if (elapsed < 180 && particles.some((p) => p.opacity > 0)) {
        frame = requestAnimationFrame(draw);
      }
    }

    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [active]);

  if (!active) return null;

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        pointerEvents: "none",
      }}
    />
  );
}

/* ── Smart prefill from URL params ── */
const STATE_SLUGS: Record<string, string> = {
  massachusetts: "MA",
  "rhode-island": "RI",
  connecticut: "CT",
  "new-hampshire": "NH",
  "new-york": "NY",
  oklahoma: "OK",
};

function getPrefillFromUrl(): Partial<{ state: string }> {
  try {
    const params = new URLSearchParams(window.location.search);
    const stateParam = params.get("state");
    if (stateParam) {
      // Direct: ?state=MA
      return { state: stateParam.toUpperCase() };
    }
    // Check referrer for state slug: came from /hoa-insurance-massachusetts
    const ref = document.referrer || "";
    const match = ref.match(/hoa-insurance-([a-z-]+?)(?:\/|$)/);
    if (match) {
      const abbr = STATE_SLUGS[match[1]];
      if (abbr) return { state: abbr };
    }
  } catch {
    /* ignore */
  }
  return {};
}

/* Sun / moon indicator (also acts as a manual override toggle) */
function ThemeIndicator({ isDay, onToggle }: { isDay: boolean; onToggle: () => void }) {
  const c = useTheme();
  const [hov, setHov] = useState(false);
  return (
    <button
      type="button"
      onClick={onToggle}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      aria-label={isDay ? "Switch to night theme" : "Switch to day theme"}
      title={isDay ? "Day theme — click for night" : "Night theme — click for day"}
      className="qf-theme-toggle"
      style={{
        color: hov ? c.text : c.textMuted,
        background: hov ? (isDay ? "rgba(0,0,0,0.04)" : "rgba(255,255,255,0.06)") : "transparent",
      }}
    >
      {isDay ? (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
        </svg>
      ) : (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />
        </svg>
      )}
    </button>
  );
}

function SlideIn({ children, keyVal, direction }: { children: ReactNode; keyVal: string; direction: 1 | -1 }) {
  const [vis, setVis] = useState(false);
  useEffect(() => {
    setVis(false);
    const t = requestAnimationFrame(() => setVis(true));
    return () => cancelAnimationFrame(t);
  }, [keyVal]);
  const offset = direction === 1 ? 32 : -32;
  return (
    <div
      style={{
        opacity: vis ? 1 : 0,
        transform: vis ? "translate3d(0,0,0)" : `translate3d(${offset}px,0,0)`,
        transition: "opacity 0.42s cubic-bezier(.2,.7,.3,1), transform 0.5s cubic-bezier(.2,.7,.3,1)",
        willChange: "opacity, transform",
      }}
    >
      {children}
    </div>
  );
}

function CardOption({
  label,
  sub,
  iconKey,
  selected,
  onClick,
  showCheck,
}: {
  label: string;
  sub?: string;
  iconKey?: IconKey;
  selected: boolean;
  onClick: () => void;
  showCheck?: boolean;
}) {
  const c = useTheme();
  const [hov, setHov] = useState(false);
  const IconCmp = iconKey ? Icon[iconKey] : null;
  const active = selected;
  const isLight = c.bg === LIGHT.bg;
  const shadowBase = isLight ? "rgba(15,23,42,0.06)" : "rgba(0,0,0,0.25)";
  const shadowHover = isLight ? "rgba(15,23,42,0.12)" : "rgba(0,0,0,0.35)";
  const shadowActive = isLight ? "rgba(15,23,42,0.14)" : "rgba(0,0,0,0.4)";
  const borderHover = isLight ? "#c8d2e1" : "#2c3a55";
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      className="qf-card-option"
      style={{
        background: active ? c.accentDim : hov ? c.cardHover : c.card,
        border: `1.5px solid ${active ? c.borderActive : hov ? borderHover : c.border}`,
        boxShadow: active
          ? `0 0 0 4px ${c.accentGlow}, 0 8px 24px ${shadowActive}`
          : hov
            ? `0 6px 20px ${shadowHover}`
            : `0 2px 8px ${shadowBase}`,
        transform: hov && !active ? "translateY(-2px)" : "translateY(0)",
        color: c.text,
      }}
    >
      {IconCmp && (
        <span
          className="qf-card-icon"
          style={{
            background: active ? c.accent : c.accentDim,
            color: active ? c.white : c.accent,
            transition: "all 0.25s ease",
          }}
        >
          <IconCmp size={26} />
        </span>
      )}
      <span className="qf-card-text">
        <span className="qf-card-label">{label}</span>
        {sub && <span className="qf-card-sub" style={{ color: c.textMuted }}>{sub}</span>}
      </span>
      {showCheck && (
        <span
          className="qf-card-check"
          style={{
            background: active ? c.accent : "transparent",
            border: `2px solid ${active ? c.accent : c.border}`,
            color: active ? c.white : "transparent",
          }}
        >
          <Icon.Check size={14} />
        </span>
      )}
    </button>
  );
}

function TextField({
  placeholder,
  value,
  onChange,
  onSubmit,
  type = "text",
  autoFocus = true,
}: {
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  type?: string;
  autoFocus?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocus && ref.current) {
      const t = setTimeout(() => ref.current?.focus(), 250);
      return () => clearTimeout(t);
    }
  }, [autoFocus]);
  return (
    <input
      ref={ref}
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onSubmit();
        }
      }}
      placeholder={placeholder}
      className="qf-input"
      autoComplete="off"
    />
  );
}

function PrimaryButton({
  onClick,
  label = "Continue",
  disabled = false,
  loading = false,
}: {
  onClick: () => void;
  label?: string;
  disabled?: boolean;
  loading?: boolean;
}) {
  const c = useTheme();
  const [hov, setHov] = useState(false);
  const style: CSSProperties = {
    background: disabled ? c.border : hov ? c.accentHover : c.accent,
    color: disabled ? c.textMuted : c.white,
    boxShadow: disabled ? "none" : hov ? `0 14px 32px ${c.accentGlow}` : `0 8px 22px ${c.accentGlow}`,
    transform: hov && !disabled ? "translateY(-1px)" : "translateY(0)",
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.55 : 1,
  };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      className="qf-primary-btn"
      style={style}
    >
      <span>{loading ? "Sending…" : label}</span>
      {!loading && <Icon.ArrowRight size={18} />}
    </button>
  );
}

function BackButton({ onClick }: { onClick: () => void }) {
  const c = useTheme();
  const [hov, setHov] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      className="qf-back-btn"
      style={{ color: hov ? c.text : c.textMuted }}
    >
      <Icon.ArrowLeft size={16} />
      <span>Back</span>
    </button>
  );
}

function RestartButton({ onClick }: { onClick: () => void }) {
  const c = useTheme();
  const [hov, setHov] = useState(false);
  const isLight = c.bg === LIGHT.bg;
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      aria-label="Start over"
      title="Start over"
      className="qf-restart-btn"
      style={{
        color: hov ? c.text : c.textMuted,
        background: hov ? (isLight ? "rgba(15,23,42,0.05)" : "rgba(255,255,255,0.06)") : "transparent",
      }}
    >
      <Icon.Restart size={18} />
    </button>
  );
}

/* ── Friendly headshot header (Lemonade-style) ── */
function AgentHeader({
  agent,
  greeting,
  compact,
  progress,
  typeGreeting,
}: {
  agent: Agent;
  greeting?: string;
  compact?: boolean;
  progress?: number;
  typeGreeting?: boolean;
}) {
  const c = useTheme();
  const [imgFailed, setImgFailed] = useState(false);
  useEffect(() => setImgFailed(false), [agent.photo]);
  return (
    <div className={"qf-agent-header" + (compact ? " qf-agent-header--compact" : "")}>
      <div
        className="qf-agent-avatar"
        style={{
          background: c.accentDim,
          borderColor: c.border,
          position: "relative",
        }}
      >
        {progress !== undefined && <ProgressRing progress={progress} />}
        {!imgFailed ? (
          <img
            src={agent.photo}
            alt={agent.name}
            onError={() => setImgFailed(true)}
            draggable={false}
          />
        ) : (
          <FallbackAvatar accent={c.accent} />
        )}
      </div>
      {greeting && (
        <p className="qf-agent-greeting" style={{ color: c.textMuted }}>
          {typeGreeting ? <TypeWriter text={greeting} speed={28} /> : greeting}
        </p>
      )}
    </div>
  );
}

function FallbackAvatar({ accent }: { accent: string }) {
  return (
    <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <clipPath id="qf-avatar-clip">
          <circle cx="50" cy="50" r="50" />
        </clipPath>
      </defs>
      <g clipPath="url(#qf-avatar-clip)">
        <rect width="100" height="100" fill="#fde6d2" />
        <ellipse cx="50" cy="100" rx="42" ry="32" fill={accent} />
        <rect x="44" y="58" width="12" height="14" fill="#f4cba6" />
        <circle cx="50" cy="44" r="20" fill="#f4cba6" />
        <path d="M30 40 Q30 22 50 22 Q70 22 70 42 Q66 30 50 28 Q34 30 32 44 Z" fill="#5a3e2a" />
        <circle cx="43" cy="45" r="1.6" fill="#2a2a2a" />
        <circle cx="57" cy="45" r="1.6" fill="#2a2a2a" />
        <path d="M43 52 Q50 57 57 52" stroke="#2a2a2a" strokeWidth="1.6" fill="none" strokeLinecap="round" />
      </g>
    </svg>
  );
}

/* ──────────────────────────────────────────────────────────
   APP
   ────────────────────────────────────────────────────────── */
type ThemeMode = "auto" | "light" | "dark";

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
