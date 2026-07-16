import type { Handler } from "aws-lambda";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { dataClient } from "../shared/dataClient";

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
  /** Form the lead came from, e.g. "contact" | "lp-call" | "lp-quote". */
  formId?: string;
  /** Explicit opt-in to be contacted. Absent means not granted. */
  consentToContact?: boolean;
  /** Exact consent wording shown, stored as evidence of what was agreed to. */
  consentText?: string;
  attribution?: Attribution;
};

const SES_FROM = () => process.env.SES_FROM_EMAIL ?? "info@pestbuzzkill.com";
const SES_NOTIFY = () =>
  process.env.SES_NOTIFY_EMAIL ?? "info@pestbuzzkill.com";

const ses = new SESClient({});

function jsonResponse(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST,OPTIONS",
    },
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
    add("Consent wording", input.consentText);
  } else {
    lines.push("Consent: NOT granted — do not call or text; reply by email only");
  }

  if (dropped.length) {
    lines.push(`Unparseable contact details as typed — ${dropped.join("; ")}`);
  }

  return lines.join("\n");
}

async function notifyOffice(subject: string, body: string): Promise<void> {
  try {
    await ses.send(
      new SendEmailCommand({
        Source: SES_FROM(),
        Destination: { ToAddresses: [SES_NOTIFY()] },
        Message: {
          Subject: { Data: subject },
          Body: { Text: { Data: body } },
        },
      })
    );
  } catch (err) {
    console.error("lead-intake: office notification failed", err);
  }
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
    status: "LEAD" as const,
    leadSource: sourceLabel(input),
    leadNotes: buildLeadNotes(input, dropped),
    contactConsent: input.consentToContact === true,
    contactConsentAt: input.consentToContact === true ? new Date().toISOString() : undefined,
  };

  let leadId: string | undefined;
  let writeError: string | undefined;
  try {
    const client = await dataClient();
    const { data, errors } = await client.models.Customer.create(record);
    if (errors?.length) {
      writeError = errors.map((e) => e.message).join("; ");
    } else {
      leadId = data?.id;
    }
  } catch (err) {
    writeError = err instanceof Error ? err.message : String(err);
  }

  if (!leadId) {
    // The CRM write is the only durable store. If it failed, the lead exists
    // nowhere — page a human with the raw payload and tell the caller the truth.
    console.error("lead-intake: CRM write failed", { writeError, record });
    await notifyOffice(
      "ACTION REQUIRED — website lead could not be saved",
      [
        "A lead was submitted on the website but could NOT be written to the CRM.",
        "Contact this person manually and add them by hand.",
        "",
        `Name:  ${record.displayName}`,
        `Email: ${record.email ?? input.email ?? "—"}`,
        `Phone: ${record.phone ?? input.phone ?? "—"}`,
        `Source: ${record.leadSource}`,
        "",
        record.leadNotes,
        "",
        `Error: ${writeError ?? "unknown"}`,
      ].join("\n")
    );
    return jsonResponse(502, {
      error:
        "We couldn't submit your request. Please call us at (401) 526-0323 and we'll take care of it.",
    });
  }

  await notifyOffice(
    `New website lead — ${record.displayName}`,
    [
      `Name:  ${record.displayName}`,
      `Email: ${record.email ?? "—"}`,
      `Phone: ${record.phone ?? "—"}`,
      `Source: ${record.leadSource}`,
      "",
      record.leadNotes,
      "",
      `Open in CRM: ${process.env.CRM_APP_URL ?? ""}/customers/${leadId}`,
    ].join("\n")
  );

  return jsonResponse(200, { ok: true, leadId });
};
