/**
 * Website → CRM lead intake.
 *
 * Posts the public `submitWebLead` mutation to the CRM's AppSync API
 * (API-key auth, create-lead-only surface). Runs alongside the FormSubmit
 * email dual-write and NEVER throws — a CRM hiccup must not break the
 * visitor-facing form.
 *
 * Configure per environment (Amplify env vars on the web app):
 *   PUBLIC_CRM_API_URL — the CRM AppSync GraphQL endpoint
 *   PUBLIC_CRM_API_KEY — its API key
 * Unset (e.g. local dev) → intake is skipped silently.
 */

import type { AccountType } from "../../../shared/accountType";

export interface CrmLeadInput {
  /** The CRM's `AccountType`. Named in `shared/` because it is the one schema
   *  enum both apps use, and `web` cannot import the CRM's Amplify schema. */
  type?: AccountType;
  name: string;
  contactFirstName?: string;
  contactLastName?: string;
  contactEmail?: string;
  contactPhone?: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  unitNumber?: string;
  currentCarrier?: string;
  buildiumId?: string;
  source?: string;
  notes?: string;
}

const MUTATION = `mutation SubmitWebLead(
  $type: String, $name: String!, $contactFirstName: String, $contactLastName: String,
  $contactEmail: String, $contactPhone: String, $address: String, $city: String,
  $state: String, $zip: String, $unitNumber: String, $currentCarrier: String,
  $buildiumId: String, $source: String, $notes: String
) {
  submitWebLead(
    type: $type, name: $name, contactFirstName: $contactFirstName,
    contactLastName: $contactLastName, contactEmail: $contactEmail,
    contactPhone: $contactPhone, address: $address, city: $city, state: $state,
    zip: $zip, unitNumber: $unitNumber, currentCarrier: $currentCarrier,
    buildiumId: $buildiumId, source: $source, notes: $notes
  )
}`;

export async function submitCrmLead(input: CrmLeadInput): Promise<void> {
  const url = import.meta.env.PUBLIC_CRM_API_URL;
  const key = import.meta.env.PUBLIC_CRM_API_KEY;
  if (!url || !key) return;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key },
      body: JSON.stringify({ query: MUTATION, variables: input }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (body.errors?.length) throw new Error(body.errors[0].message);
  } catch (err) {
    // Fail-soft by design; the FormSubmit email still captures the lead.
    console.warn("CRM lead intake failed", err);
  }
}
