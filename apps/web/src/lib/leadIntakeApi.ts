/**
 * Typed client for the public lead-intake endpoint (`lead-intake` Function
 * URL). Mirrors `bookingApi.ts`'s URL resolution:
 *
 * Order of URL resolution:
 *   1. `VITE_LEAD_INTAKE_URL` env var (set in `.env.local` or Amplify Hosting)
 *   2. `amplify_outputs.json` — `backend.addOutput({ custom: { leadIntakeUrl } })`
 *
 * Never throws on an HTTP error — the server's `error` message is written
 * for customers and must be surfaced verbatim, so it rides along on the
 * `ok: false` arm.
 */

import { readAttribution, type Attribution } from "./leadIntake";

let cached: string | null | undefined;

export async function getLeadIntakeUrl(): Promise<string | undefined> {
  if (cached !== undefined) return cached ?? undefined;

  const envUrl = import.meta.env.VITE_LEAD_INTAKE_URL as string | undefined;
  if (typeof envUrl === "string" && envUrl.length > 0) {
    cached = envUrl;
    return envUrl;
  }

  const candidates = import.meta.glob<{ custom?: { leadIntakeUrl?: string } }>(
    "/amplify_outputs.json",
    { import: "default" },
  );
  const loader = candidates["/amplify_outputs.json"];
  if (loader) {
    try {
      const outputs = await loader();
      const url = outputs.custom?.leadIntakeUrl;
      if (typeof url === "string" && url.length > 0) {
        cached = url;
        return url;
      }
    } catch {
      // ignore — fall through to undefined
    }
  }

  cached = null;
  return undefined;
}

export type LeadRequest = {
  first: string;
  last?: string;
  email?: string;
  phone?: string;
  propertyType?: "Residential" | "Association" | "Specialty";
  reason?: string;
  message?: string;
  formId: string;
  consentToContact?: boolean;
  consentText?: string;
  attribution?: Attribution;
};

export type LeadResult =
  | { ok: true; leadId?: string }
  | { ok: false; error: string };

export async function submitLead(input: LeadRequest): Promise<LeadResult> {
  const base = await getLeadIntakeUrl();
  if (!base) {
    return {
      ok: false,
      error:
        "Online requests aren't configured on this deployment. Run `npx ampx sandbox` or set VITE_LEAD_INTAKE_URL.",
    };
  }

  const attribution = readAttribution();
  const payload = attribution ? { ...input, attribution } : input;

  let resp: Response;
  try {
    resp = await fetch(base.replace(/\/+$/, ""), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    return {
      ok: false,
      error: "We couldn't reach the server — check your connection and try again.",
    };
  }

  let body: { error?: string; leadId?: string } = {};
  try {
    body = await resp.json();
  } catch {
    // non-JSON body — fall through to the generic message below
  }

  if (resp.ok) return { ok: true, leadId: body.leadId };
  return { ok: false, error: body.error ?? `Request failed (status ${resp.status})` };
}
