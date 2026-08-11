import type { IconKey } from "./icons";
import { states as ALL_STATES } from "../../data/states";

/* ──────────────────────────────────────────────────────────
   STEP DEFINITIONS

   Five questions, both paths. The count is stated on the splash, so the flows
   must stay at five — naming the length is the main lever on completion, and a
   promise of five followed by seven is worse than never promising.

   Detail that used to occupy its own screen is grouped onto the screen it
   belongs with:
     · unit count sits with the association it describes  (Q2)
     · property address sits with state and city          (Q3)
     · carriers and expiry sit with the lines to review   (Q4)
     · name, email and phone are one screen               (Q5)
   That is what `group` exists for.
   ────────────────────────────────────────────────────────── */
type Option = { value: string; label: string; icon?: IconKey; sub?: string };

/** One input inside a `group` step. */
export type GroupField = {
  kind: "text" | "select" | "multi";
  field: string;
  label: string;
  placeholder?: string;
  options?: Option[];
  optional?: boolean;
  inputType?: string;
  validation?: "email" | "phone";
  /** Render at half width so two can share a row. */
  half?: boolean;
};

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
  | { type: "group"; question: string; sub?: string; fields: GroupField[] }
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

/**
 * Every state we are licensed in, derived from states.ts rather than hand-listed.
 *
 * This used to carry only six states. Once states.ts grew to all fifty plus DC,
 * a visitor arriving from (say) the Texas page had no Texas to choose, was forced
 * onto "OTHER", and `buildCrmLead` drops "OTHER" — so the lead reached the CRM
 * with no state at all. Reading the list from the data file means the two cannot
 * drift apart again.
 */
const STATE_OPTIONS: Option[] = [...ALL_STATES]
  .sort((a, b) => a.name.localeCompare(b.name))
  .map((s) => ({ value: s.abbr, label: s.name }));

export const STEPS: Record<string, Step> = {
  welcome: {
    type: "splash",
    // headline is rendered dynamically in JSX so it can include the agent's name
    headline: "",
    sub: "Five questions. No cost, no obligation.",
  },

  /* ── Q1 · Who's asking ── */
  role: {
    type: "select",
    question: "Who are we speaking with?",
    field: "role",
    options: [
      { value: "board", label: "Board member or trustee", icon: "Board", sub: "I serve on the HOA board" },
      { value: "manager", label: "Property manager", icon: "Manager", sub: "I manage the property" },
      { value: "owner", label: "Unit owner", icon: "Owner", sub: "I own a unit in the association" },
    ],
  },

  /* ── Q2 · Which association ── */
  assocBoard: {
    type: "group",
    question: "What's the association called?",
    sub: "Full legal name if you have it — the name on the policy.",
    fields: [
      {
        kind: "text",
        field: "associationName",
        label: "Association name",
        placeholder: "e.g. Maple Ridge Condominium Trust",
      },
      {
        kind: "text",
        field: "unitCount",
        label: "How many units?",
        placeholder: "e.g. 48",
        inputType: "number",
        half: true,
      },
    ],
  },
  assocOwner: {
    type: "text",
    question: "What's the association called?",
    placeholder: "e.g. Maple Ridge Condominium Trust",
    field: "associationName",
    sub: "Full legal name if you have it — the name on the policy.",
  },

  /* ── Q3 · Where ── */
  where: {
    type: "group",
    question: "Where is the property?",
    fields: [
      {
        kind: "select",
        field: "state",
        label: "State",
        placeholder: "Select a state",
        options: STATE_OPTIONS,
        half: true,
      },
      { kind: "text", field: "city", label: "City or town", placeholder: "e.g. Marlborough", half: true },
      {
        kind: "text",
        field: "propertyAddress",
        label: "Primary property address",
        placeholder: "Street address",
        optional: true,
      },
    ],
  },

  /* ── Q4 · What to review (board / manager) ── */
  reviewBoard: {
    type: "group",
    question: "What should we review?",
    sub: "Select the lines that apply. The rest is optional and speeds things up.",
    fields: [
      {
        kind: "multi",
        field: "coverageNeeds",
        label: "Lines of coverage",
        options: [
          { value: "master_property", label: "Commercial Property", icon: "Building" },
          { value: "general_liability", label: "General Liability", icon: "Shield" },
          { value: "umbrella", label: "Umbrella / Excess Liability", icon: "Umbrella" },
          { value: "dno", label: "Directors & Officers Liability", icon: "Briefcase" },
          { value: "crime", label: "Crime / Fidelity", icon: "Lock" },
          { value: "ordinance", label: "Ordinance or Law", icon: "Scale" },
          { value: "other", label: "Other", icon: "Question" },
          { value: "not_sure", label: "Not sure — review everything", icon: "Sparkle" },
        ],
      },
      {
        kind: "text",
        field: "currentCarrier",
        label: "Current carriers",
        placeholder: "Carrier per line, if you know them",
        optional: true,
      },
      {
        kind: "text",
        field: "renewalDate",
        label: "Program expiry date",
        placeholder: "e.g. 1 September 2026",
        optional: true,
        half: true,
      },
    ],
  },

  /* ── Q4 · What you need (unit owner) ── */
  needOwner: {
    type: "select",
    question: "What do you need?",
    field: "ho6Need",
    options: [
      { value: "new", label: "A new HO-6 policy", icon: "Document" },
      { value: "review", label: "A review of the one I have", icon: "Shield" },
      { value: "loss_assessment", label: "Loss assessment coverage", icon: "Scale" },
      { value: "not_sure", label: "Not sure — help me work it out", icon: "Question" },
    ],
  },

  /* ── Q5 · Where to send it ── */
  contact: {
    type: "group",
    question: "Where should we send the review?",
    fields: [
      { kind: "text", field: "contactName", label: "Name", placeholder: "Full name" },
      {
        kind: "text",
        field: "contactEmail",
        label: "Email",
        placeholder: "you@example.com",
        inputType: "email",
        validation: "email",
        half: true,
      },
      {
        kind: "text",
        field: "contactPhone",
        label: "Phone",
        placeholder: "(508) 555-1234",
        inputType: "tel",
        optional: true,
        validation: "phone",
        half: true,
      },
    ],
  },

  submitted: { type: "submitted" },
};

const FLOW_BOARD = [
  "welcome",
  "role", // Q1
  "assocBoard", // Q2
  "where", // Q3
  "reviewBoard", // Q4
  "contact", // Q5
  "submitted",
];

const FLOW_OWNER = [
  "welcome",
  "role", // Q1
  "assocOwner", // Q2
  "where", // Q3
  "needOwner", // Q4
  "contact", // Q5
  "submitted",
];

export type FormData = Record<string, string | string[]>;

export function getFlow(role: string | null): string[] {
  return role === "owner" ? FLOW_OWNER : FLOW_BOARD;
}
