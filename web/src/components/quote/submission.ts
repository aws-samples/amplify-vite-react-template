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
  master_property: "Commercial Property",
  general_liability: "General Liability",
  umbrella: "Umbrella / Excess Liability",
  dno: "Directors & Officers Liability",
  crime: "Crime / Fidelity",
  ordinance: "Ordinance or Law",
  other: "Other",
  not_sure: "Not sure — review everything",
};
const HO6_LABELS: Record<string, string> = {
  new: "New HO-6 policy",
  review: "Review existing policy",
  loss_assessment: "Loss assessment coverage",
  not_sure: "Not sure — needs guidance",
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
    "Property Address": get("propertyAddress") || "—",
    "City": get("city") || "—",
    "State": get("state") || "—",
  };

  if (role === "board" || role === "manager") {
    payload["Unit Count"] = get("unitCount") || "—";

    const coverage = data.coverageNeeds;
    if (Array.isArray(coverage) && coverage.length) {
      payload["Lines to Review"] = coverage
        .map((v) => COVERAGE_LABELS[v] || v)
        .join(", ");
    } else {
      payload["Lines to Review"] = "—";
    }

    payload["Current Carriers"] = get("currentCarrier") || "—";
    payload["Program Expiry"] = get("renewalDate") || "—";
  }

  if (role === "owner") {
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
    !isOwner && Array.isArray(coverage) && coverage.length
      ? `Lines to review: ${coverage.map((v) => COVERAGE_LABELS[v] || v).join(", ")}`
      : undefined,
    !isOwner && get("renewalDate") ? `Program expiry: ${get("renewalDate")}` : undefined,
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
    address: get("propertyAddress") || undefined,
    city: get("city") || undefined,
    // Every licensed state is now selectable, so "OTHER" no longer exists in the
    // options. The guard stays for leads persisted under the old schema.
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
