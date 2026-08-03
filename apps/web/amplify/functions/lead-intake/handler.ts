import type { Handler } from "aws-lambda";
import { notifyLeads } from "../shared/email";
import { createLead } from "../shared/leadLifecycle";
import {
  CALL_CONSENT_TEXT,
  CALL_CONSENT_TEXT_VERSION,
} from "../shared/consentText";

/**
 * Lead intake for every public form on the marketing site.
 *
 * Contract: a lead is durably stored in the CRM (Customer, status LEAD) or the
 * caller is told it failed. There is no third outcome. This endpoint does not
 * price, quote, or contract — pricing lives behind the CRM rate card where a
 * human applies it, so the website can never undercut or auto-contract.
 */

type Attribution = {
  source?: string;
  medium?: string;
  campaign?: string;
  term?: string;
  content?: string;
  gclid?: string;
  referrer?: string;
  landingPage?: string;
};

type LeadInput = {
  /** Stable browser submission identity; retries reuse it. */
  idempotencyKey?: string;
  propertyType?: "Association" | "Residential" | "Specialty";
  first?: string;
  last?: string;
  email?: string;
  phone?: string;
  addr?: string;
  city?: string;
  state?: string;
  zip?: string;
  sqft?: string;
  units?: string;
  freq?: string;
  company?: string;
  specialtyService?: string;
  specialtyPropertyType?: string;
  /** Free-text reason picked on the contact form, e.g. "Get a quote". */
  reason?: string;
  /** Free-text message from the contact form. */
  message?: string;
  /** Form the lead came from, e.g. "contact" | "lp-call" | "lp-quote". */
  formId?: string;
  /** Explicit opt-in to be contacted. Absent means not granted. */
  consentToContact?: boolean;
  /** Exact consent wording shown, stored as evidence of what was agreed to. */
  consentText?: string;
  attribution?: Attribution;
};

const SUPPORT_PHONE = "(508) 258-9294";

/**
 * No CORS headers here. The Function URL carries its own CORS config (see
 * `backend.ts`), and Lambda appends those headers to whatever we return —
 * so emitting our own produced two `Access-Control-Allow-Origin` values on
 * every response. Browsers reject that, which surfaced as "couldn't reach
 * the server" on a lead that had in fact been saved and emailed.
 */
function jsonResponse(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function digitsOnly(s: string | undefined): string {
  return (s ?? "").replace(/\D/g, "");
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Customer.email/.phone are format-validated by AppSync, so a malformed value
 * would reject the whole record. Normalize to what the schema accepts and keep
 * anything unusable in the notes instead of dropping the lead on the floor.
 */
function normalizeEmail(raw: string | undefined): string | undefined {
  const v = (raw ?? "").trim();
  return v && EMAIL_RE.test(v) ? v : undefined;
}

function normalizePhone(raw: string | undefined): string | undefined {
  const d = digitsOnly(raw);
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return undefined;
}

function buildDisplayName(input: LeadInput): string | undefined {
  const person = [input.first?.trim(), input.last?.trim()]
    .filter(Boolean)
    .join(" ")
    .trim();
  const company = input.company?.trim();
  if (input.propertyType === "Association" && company) {
    return person ? `${company} (${person})` : company;
  }
  return person || company || undefined;
}

function sourceLabel(input: LeadInput): string {
  const form = input.formId?.trim();
  const utm = input.attribution?.source?.trim();
  const parts = ["Website", form || undefined, utm ? `utm:${utm}` : undefined];
  return parts.filter(Boolean).join(" · ");
}

/** Everything the customer told us that has no first-class column, kept verbatim. */
function buildLeadNotes(input: LeadInput, dropped: string[]): string {
  const lines: string[] = [];
  const add = (label: string, v: string | undefined) => {
    const t = (v ?? "").trim();
    if (t) lines.push(`${label}: ${t}`);
  };

  add("Property type", input.propertyType);
  add("Requested frequency", input.freq);
  add("Company", input.company);
  add("Units", input.units);
  add("Square footage", input.sqft);
  add("Specialty service", input.specialtyService);
  add("Specialty property type", input.specialtyPropertyType);
  add("Reason for contact", input.reason);
  if (input.message?.trim()) lines.push(`Message: ${input.message.trim()}`);

  const a = input.attribution;
  if (a) {
    add("Campaign", a.campaign);
    add("Medium", a.medium);
    add("Term", a.term);
    add("Content", a.content);
    add("Google click id", a.gclid);
    add("Landing page", a.landingPage);
    add("Referrer", a.referrer);
  }

  if (input.consentToContact) {
    add("Consent", `granted at ${new Date().toISOString()}`);
    // The server-owned GL-03 wording is authoritative. Do not trust a caller
    // to supply the evidence text that will later authorize outreach.
    add("Consent wording", CALL_CONSENT_TEXT);
  } else {
    lines.push("Consent: NOT granted — do not call or text; reply by email only");
  }

  if (dropped.length) {
    lines.push(`Unparseable contact details as typed — ${dropped.join("; ")}`);
  }

  return lines.join("\n");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** The four things the office needs to act on a lead, in a fixed order. */
function contactRows(c: {
  name: string;
  email?: string | null;
  phone?: string | null;
  source?: string | null;
}): string {
  const row = (label: string, value: string | null | undefined) =>
    `<tr><td style="padding:2px 12px 2px 0;color:#666;">${label}</td><td style="padding:2px 0;"><strong>${escapeHtml(value || "—")}</strong></td></tr>`;
  return `<table style="border-collapse:collapse;margin:12px 0;">
      ${row("Name", c.name)}
      ${row("Email", c.email)}
      ${row("Phone", c.phone)}
      ${row("Source", c.source)}
    </table>`;
}

export const handler: Handler = async (event) => {
  const method =
    event.httpMethod ?? event.requestContext?.http?.method ?? "POST";

  if (method === "OPTIONS") return jsonResponse(204, {});
  if (method !== "POST") return jsonResponse(405, { error: "Method not allowed" });

  let raw: string;
  try {
    raw = event.isBase64Encoded
      ? Buffer.from(event.body ?? "", "base64").toString("utf-8")
      : event.body ?? "";
  } catch {
    return jsonResponse(400, { error: "Invalid body encoding" });
  }

  let input: LeadInput;
  try {
    input = JSON.parse(raw || "{}") as LeadInput;
  } catch {
    return jsonResponse(400, { error: "Body must be JSON" });
  }

  // A lead is actionable with a name and one way to reach them. Everything else
  // is sales context the office can chase. Demanding more only loses leads.
  const displayName = buildDisplayName(input);
  const email = normalizeEmail(input.email);
  const phone = normalizePhone(input.phone);

  const missing: string[] = [];
  if (!displayName) missing.push("name");
  if (!email && !phone) missing.push("email or phone");
  if (missing.length) {
    return jsonResponse(422, {
      error: "We need a name and either an email address or a phone number.",
      missing,
    });
  }

  const dropped: string[] = [];
  if (input.email?.trim() && !email) dropped.push(`email as typed "${input.email.trim()}"`);
  if (input.phone?.trim() && !phone) dropped.push(`phone as typed "${input.phone.trim()}"`);

  const record = {
    displayName: displayName as string,
    contactName: [input.first?.trim(), input.last?.trim()].filter(Boolean).join(" ") || undefined,
    email,
    phone,
    serviceStreet: input.addr?.trim() || undefined,
    serviceCity: input.city?.trim() || undefined,
    serviceState: input.state?.trim() || undefined,
    serviceZip: input.zip?.trim() || undefined,
    leadSource: sourceLabel(input),
    leadNotes: buildLeadNotes(input, dropped),
  };

  let leadId: string | undefined;
  let writeError: string | undefined;
  try {
    const result = await createLead(
      {
        displayName: record.displayName,
        contactName: record.contactName,
        email: record.email,
        phone: record.phone,
        serviceStreet: record.serviceStreet,
        serviceCity: record.serviceCity,
        serviceState: record.serviceState,
        serviceZip: record.serviceZip,
        leadSource: record.leadSource,
        notes: record.leadNotes,
        // Public intake always retains the submission as a separate record and
        // opens the controlled duplicate decision. The visitor never chooses a
        // merge on behalf of the Office.
        force: true,
        idempotencyKey: input.idempotencyKey,
        contactConsentChannels: [
          ...(record.email ? ["EMAIL"] : []),
          ...(input.consentToContact ? ["CALL"] : []),
        ],
        contactConsentSource: input.formId ?? "website",
        contactConsentText: input.consentToContact
          ? CALL_CONSENT_TEXT
          : "Customer supplied an email address in a direct service inquiry and requested an email response; no call or text permission was granted.",
        contactConsentPolicyVersion: input.consentToContact
          ? CALL_CONSENT_TEXT_VERSION
          : "website-email-response-2026-07-20.1",
      },
      { sub: null, email: null }
    );
    if (result.decision === "CREATED") leadId = result.id;
    else writeError = "The duplicate identity decision did not finish.";
  } catch (err) {
    writeError = err instanceof Error ? err.message : String(err);
  }

  if (!leadId) {
    // The CRM write is the only durable store. If it failed, the lead exists
    // nowhere — page a human with the raw payload and tell the caller the truth.
    console.error("lead-intake: CRM write failed", { writeError, record });
    await notifyLeads({
      subject: `ACTION REQUIRED — website lead could not be saved: ${record.displayName}`,
      heading: "A website lead was not saved",
      template: "ops-lead-write-failed",
      bodyHtml: `<p>Someone submitted the website form and we could <strong>not</strong> write them to the CRM. This lead exists nowhere else — this email is the only copy.</p>
         <p><strong>Contact them and add them by hand.</strong></p>
         ${contactRows({
           name: record.displayName,
           email: record.email ?? input.email,
           phone: record.phone ?? input.phone,
           source: record.leadSource,
         })}
         <p style="white-space:pre-wrap;">${escapeHtml(record.leadNotes)}</p>
         <p style="color:#666;font-size:13px;">Error: ${escapeHtml(writeError ?? "unknown")}</p>`,
    });
    return jsonResponse(502, {
      error: `We couldn't submit your request. Please call us at ${SUPPORT_PHONE} and we'll take care of it.`,
    });
  }

  await notifyLeads({
    subject: `New website lead — ${record.displayName}`,
    heading: "New website lead",
    template: "ops-new-lead",
    customerId: leadId,
    bodyHtml: `${contactRows({
      name: record.displayName,
      email: record.email,
      phone: record.phone,
      source: record.leadSource,
    })}
       <p style="white-space:pre-wrap;">${escapeHtml(record.leadNotes)}</p>
       <p style="margin:20px 0;"><a href="${process.env.CRM_APP_URL ?? ""}/customers/${leadId}" style="background:#176b2c;color:#fff;padding:11px 20px;border-radius:8px;text-decoration:none;font-weight:600;">Open in the CRM</a></p>`,
  });

  return jsonResponse(200, { ok: true, leadId });
};
