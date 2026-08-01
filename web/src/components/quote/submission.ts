import type { CrmLeadInput } from "../../lib/crmLead";
import { FORMSUBMIT_URL } from "../../constants";
import type { FormData } from "./schema";

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
export function buildCrmLead(data: FormData, agentName: string): CrmLeadInput {
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

export async function sendQuoteEmail(data: FormData, agentName: string): Promise<void> {
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
