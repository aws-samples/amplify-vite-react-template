import type { IconKey } from "./icons";

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

export function validateText(
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

export const STEPS: Record<string, Step> = {
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

export type FormData = Record<string, string | string[]>;

export function getFlow(role: string | null, data: FormData): string[] {
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
