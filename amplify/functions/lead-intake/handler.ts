/**
 * Lead-intake Lambda — proxies the BuzzKill contact form to FieldRoutes.
 *
 * Two-step flow:
 *   1. POST /api/customer/create  → creates the customer record
 *   2. POST /api/subscription/create → creates a subscription on that
 *      customer with the correct service type, frequency, source, and
 *      convertToLead=1 so it shows up in the Leads pipeline.
 *
 * Frontend posts a JSON body like:
 *   {
 *     propertyType: "Association" | "Residential",
 *     first, last, email, phone,
 *     addr, city, state, zip,
 *     sqft, units, freq, company
 *   }
 */

type Handler = (
  event: APIGatewayLikeEvent,
) => Promise<APIGatewayLikeResponse>;

type APIGatewayLikeEvent = {
  httpMethod?: string;
  requestContext?: { http?: { method?: string } };
  body?: string | null;
  isBase64Encoded?: boolean;
  headers?: Record<string, string | undefined>;
};

type APIGatewayLikeResponse = {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
};

type LeadInput = {
  propertyType?: "Association" | "Residential" | "Specialty" | string;
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
};

const REQUIRED_FIELDS: (keyof LeadInput)[] = [
  "first",
  "last",
  "email",
  "phone",
  "addr",
  "city",
  "state",
  "zip",
];

// ── FieldRoutes tenant config ────────────────────────────────────────
// Source IDs (Admin → Preferences → Customer Sources)
const SOURCE_WEBSITE = 10001;

// Service-type IDs by property type × frequency
// (Admin → Preferences → Service Types — the row number is the ID)
const SERVICE_ID_MAP: Record<string, Record<string, number>> = {
  Association: {
    "One-time treatment": 8, // HOA - Single Visit (H1)
    Monthly: 5,              // HOA Monthly (HM)
    "Every 2 Months": 6,     // HOA Bi-Monthly (HB)
    "Every 3 Months": 7,     // HOA Quarterly (HQ)
  },
  Residential: {
    "One-time treatment": 12, // Residential - Single Visit (R1)
    Monthly: 9,               // Residential Monthly (RM)
    "Every 2 Months": 10,     // Residential Bi-Monthly (RB)
    "Every 3 Months": 11,     // Residential Quarterly (RQ)
  },
};

// Map form frequency labels → FieldRoutes `frequency` value.
// Per FieldRoutes docs: -1 = One-Time, 0 = "as needed", >0 = days
// between services (90 → quarterly, etc.). Previously we were sending
// 0 for one-time, which means "as needed" rather than single-visit;
// -1 is the correct code.
const FREQUENCY_DAYS: Record<string, number> = {
  "One-time treatment": -1,
  Monthly: 30,
  "Every 2 Months": 60,
  "Every 3 Months": 90,
};

// Map form frequency labels → FieldRoutes `billingFrequency` value.
// Per FieldRoutes docs: 0 / -1 = bill after each completed service
// (the API default we want to override for recurring plans). 30 =
// invoice generated every 30 days. We bill recurring plans monthly
// regardless of service cadence, matching the service type templates'
// "Billing Frequency: Monthly" config visible in the FR admin UI.
// One-time stays at 0 (one invoice when the single service completes).
const BILLING_FREQUENCY: Record<string, number> = {
  "One-time treatment": 0,
  Monthly: 30,
  "Every 2 Months": 30,
  "Every 3 Months": 30,
};

// Helper — true if `freq` represents a single-visit (non-recurring) plan.
function isOneTime(freq: string | undefined): boolean {
  return freq === "One-time treatment";
}

// ── Dynamic pricing ──────────────────────────────────────────────────
// Base prices (from Product Template for each service type)
const SPECIALTY_PRICE: Record<string, number> = {
  "Wasp Nest Removal": 299,
  "Rodent Nest Removal": 399,
  "Rodent Exclusion (Exterior Only)": 600,
  "Termite Bait Stations": 0,
  "Other Specialty Service": 0,
};

const BASE_PRICE: Record<string, number> = {
  "Association:Monthly": 110,
  "Association:Every 2 Months": 90,
  "Association:Every 3 Months": 70,
  "Association:One-time treatment": 312, // HOA - Single Visit Initial Quote
  "Residential:Monthly": 69,
  "Residential:Every 2 Months": 56,
  "Residential:Every 3 Months": 45,
  "Residential:One-time treatment": 300, // Residential - Single Visit Initial Quote
};

// Dynamic pricing tiers (from Admin → Preferences → Service Types → Product Template)
type PricingTier = { min: number; max: number; per: number; premium: number };
type PricingConfig = { baseThreshold: number; tiers: PricingTier[] };

const PRICING: Record<string, PricingConfig> = {
  // HOA — Unit of Measure: CNT (Count), Start Dynamic After: 10
  "Association:Monthly": {
    baseThreshold: 10,
    tiers: [
      { min: 11, max: 25, per: 15, premium: 55 },
      { min: 26, max: 50, per: 25, premium: 100 },
      { min: 51, max: 100, per: 50, premium: 140 },
      { min: 101, max: 0, per: 100, premium: 275 },
    ],
  },
  "Association:Every 2 Months": {
    baseThreshold: 10,
    tiers: [
      { min: 11, max: 25, per: 15, premium: 40 },
      { min: 26, max: 50, per: 25, premium: 80 },
      { min: 51, max: 100, per: 50, premium: 115 },
      { min: 101, max: 0, per: 100, premium: 150 },
    ],
  },
  "Association:Every 3 Months": {
    baseThreshold: 10,
    tiers: [
      { min: 11, max: 25, per: 15, premium: 35 },
      { min: 26, max: 50, per: 25, premium: 65 },
      { min: 51, max: 100, per: 50, premium: 90 },
      { min: 101, max: 0, per: 100, premium: 180 },
    ],
  },
  // Residential — Unit of Measure: SF (Square Feet), Start Dynamic After: 1000
  "Residential:Monthly": {
    baseThreshold: 1000,
    tiers: [
      { min: 1001, max: 4000, per: 1000, premium: 15 },
      { min: 4001, max: 0, per: 1000, premium: 23 },
    ],
  },
  "Residential:Every 2 Months": {
    baseThreshold: 1000,
    tiers: [
      { min: 1001, max: 4000, per: 1000, premium: 13 },
      { min: 4001, max: 0, per: 1000, premium: 19 },
    ],
  },
  "Residential:Every 3 Months": {
    baseThreshold: 1000,
    tiers: [
      { min: 1001, max: 4000, per: 1000, premium: 10 },
      { min: 4001, max: 0, per: 1000, premium: 15 },
    ],
  },
  // HOA Single Visit (#8) — same tier shape as recurring HOA, larger premiums
  "Association:One-time treatment": {
    baseThreshold: 10,
    tiers: [
      { min: 11, max: 25, per: 15, premium: 156 },
      { min: 26, max: 50, per: 25, premium: 288 },
      { min: 51, max: 100, per: 50, premium: 396 },
      { min: 101, max: 0, per: 100, premium: 792 },
    ],
  },
  // Residential Single Visit (#12) — single open-ended tier from 2,501 sqft
  "Residential:One-time treatment": {
    baseThreshold: 2500,
    tiers: [{ min: 2501, max: 0, per: 1000, premium: 13 }],
  },
};

/**
 * Calculate the total service charge (base + dynamic premium) based on
 * CNT/SF and the pricing tiers from the service type template.
 *
 * FieldRoutes dynamic pricing:
 *   - At or below baseThreshold: base price only
 *   - Above baseThreshold: base price + tiered premiums for each step
 *     of `per` units within each tier bracket
 *
 * Returns the total charge (base + all applicable premiums).
 */
function calculateTotalCharge(
  propertyType: string,
  freq: string,
  cnt: number,
): number {
  const key = `${propertyType}:${freq}`;
  const base = BASE_PRICE[key] ?? 0;
  const config = PRICING[key];

  if (!config || cnt <= config.baseThreshold) return base;

  let totalPremium = 0;

  for (const tier of config.tiers) {
    if (cnt < tier.min) break;

    const tierMax = tier.max === 0 ? Infinity : tier.max;
    const unitsInTier = Math.min(cnt, tierMax) - tier.min + 1;
    const steps = Math.ceil(unitsInTier / tier.per);
    totalPremium += steps * tier.premium;
  }

  return base + totalPremium;
}

// ── Email signature (HTML) ────────────────────────────────────────────
const EMAIL_SIGNATURE = `
<table cellpadding="0" cellspacing="0" border="0" style="font-family: Arial, Helvetica, sans-serif; color: #1A1A1A; font-size: 14px; line-height: 1.4; border-collapse: collapse;">
  <tr>
    <td valign="top" style="padding: 0 20px 0 0; border-right: 3px solid #7ED321;">
      <a href="https://pestbuzzkill.com/" style="text-decoration: none;">
        <img src="https://pestbuzzkill.com/images/logo.png" alt="BuzzKill Pest Control" width="184" height="84" style="display: block; border: 0;">
      </a>
    </td>
    <td valign="top" style="padding: 0 0 0 20px;">
      <div style="font-family: 'Arial Black', 'Helvetica Neue', Impact, sans-serif; font-weight: 900; font-size: 22px; letter-spacing: 0.02em; line-height: 1; color: #0A0A0A; text-transform: uppercase; margin: 0 0 4px;">
        BUZZKILL <span style="color: #7ED321;">PEST CONTROL</span>
      </div>
      <div style="font-family: Arial, Helvetica, sans-serif; font-style: italic; font-weight: 600; font-size: 12px; color: #5FA517; margin: 0 0 12px;">
        Safe for Families. Tough on Pests.
      </div>
      <table cellpadding="0" cellspacing="0" border="0" style="border-collapse: collapse; font-family: Arial, Helvetica, sans-serif; font-size: 13px; line-height: 1.5; color: #1A1A1A;">
        <tr>
          <td style="padding: 1px 8px 1px 0; color: #5FA517; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; font-size: 11px;">P</td>
          <td style="padding: 1px 0;"><a href="tel:+15082589294" style="color: #1A1A1A; text-decoration: none;">508-258-9294</a></td>
        </tr>
        <tr>
          <td style="padding: 1px 8px 1px 0; color: #5FA517; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; font-size: 11px;">E</td>
          <td style="padding: 1px 0;"><a href="mailto:info@PestBuzzKill.com" style="color: #1A1A1A; text-decoration: none;">info@PestBuzzKill.com</a></td>
        </tr>
        <tr>
          <td style="padding: 1px 8px 1px 0; color: #5FA517; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; font-size: 11px;">W</td>
          <td style="padding: 1px 0;"><a href="https://pestbuzzkill.com/" style="color: #1A1A1A; text-decoration: none;">PestBuzzKill.com</a></td>
        </tr>
        <tr>
          <td valign="top" style="padding: 1px 8px 1px 0; color: #5FA517; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; font-size: 11px;">A</td>
          <td style="padding: 1px 0;">420 Lakeside Ave, Suite 104<br>Marlborough, MA 01752</td>
        </tr>
      </table>
    </td>
  </tr>
</table>`;

// ── SES email helper ─────────────────────────────────────────────────
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";

const sesClient = new SESClient({});

async function sendEmail(
  from: string,
  to: string,
  subject: string,
  htmlBody: string,
): Promise<void> {
  await sesClient.send(
    new SendEmailCommand({
      Source: from,
      Destination: { ToAddresses: [to] },
      Message: {
        Subject: { Data: subject, Charset: "UTF-8" },
        Body: {
          Html: { Data: htmlBody, Charset: "UTF-8" },
        },
      },
    }),
  );
}

function formatCurrency(amount: number): string {
  return "$" + amount.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// ── Helpers ──────────────────────────────────────────────────────────

function jsonResponse(
  statusCode: number,
  body: unknown,
): APIGatewayLikeResponse {
  return {
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  };
}

function digitsOnly(s: string | undefined): string {
  return (s ?? "").replace(/\D+/g, "");
}

/** POST to a FieldRoutes endpoint and return parsed JSON. */
async function frPost(
  subdomain: string,
  key: string,
  token: string,
  endpoint: string,
  params: Record<string, string | number>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const url = `https://${subdomain}.pestroutes.com/api/${endpoint}`;
  const body = new URLSearchParams({
    authenticationKey: key,
    authenticationToken: token,
    ...Object.fromEntries(
      Object.entries(params).map(([k, v]) => [k, String(v)]),
    ),
  });

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });

  let parsed: Record<string, unknown>;
  const text = await resp.text();
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = { _raw: text.slice(0, 1000) };
  }

  return { status: resp.status, body: parsed };
}

// ── Field mapping ────────────────────────────────────────────────────

function buildCustomerPayload(input: LeadInput): Record<string, string> {
  const isAssociation =
    input.propertyType === "Association" ||
    (input.propertyType === "Specialty" && input.specialtyPropertyType === "Association");
  const out: Record<string, string> = {
    fname: (input.first ?? "").trim(),
    lname: (input.last ?? "").trim(),
    email: (input.email ?? "").trim(),
    phone1: digitsOnly(input.phone),
    address: (input.addr ?? "").trim(),
    city: (input.city ?? "").trim(),
    state: (input.state ?? "").trim().toUpperCase().slice(0, 2),
    zip: digitsOnly(input.zip).slice(0, 5),
  };

  if (isAssociation) {
    out.commercialAccount = "1";
    if (input.company?.trim()) {
      out.companyName = input.company.trim();
    }
  }

  // Context notes for the front office
  const noteParts: string[] = [];
  if (input.sqft) noteParts.push(`Square footage: ${input.sqft}`);
  if (input.units) noteParts.push(`Unit count: ${input.units}`);
  if (input.freq) noteParts.push(`Requested frequency: ${input.freq}`);
  if (input.propertyType === "Specialty") {
    noteParts.push(`Property type: Specialty Services`);
    if (input.specialtyPropertyType) noteParts.push(`Location type: ${input.specialtyPropertyType}`);
    if (input.specialtyService) noteParts.push(`Specialty service: ${input.specialtyService}`);
  } else {
    noteParts.push(
      `Property type: ${isAssociation ? "Association / HOA" : "Residential"}`,
    );
  }
  if (noteParts.length > 0) {
    out.specialScheduling = noteParts.join(" | ");
  }

  return out;
}

function buildSubscriptionPayload(
  input: LeadInput,
  customerID: number,
): Record<string, string | number> {
  const isSpecialty = input.propertyType === "Specialty";
  const isAssociation = isSpecialty
    ? input.specialtyPropertyType === "Association"
    : input.propertyType === "Association";
  const freq = isSpecialty ? "One-time treatment" : (input.freq ?? "Monthly");
  const propType = isAssociation ? "Association" : "Residential";

  const typeMap = SERVICE_ID_MAP[propType] ?? {};
  const serviceID = typeMap[freq] ?? typeMap["Monthly"] ?? 5;
  const frequencyDays = FREQUENCY_DAYS[freq] ?? 30;
  const billingFrequencyDays = BILLING_FREQUENCY[freq] ?? 30;

  // For specialty services, use the fixed specialty price.
  // For standard types, calculate from the dynamic pricing tables.
  const cnt = Number(digitsOnly(isAssociation ? input.units : input.sqft));
  const monthlyRate = isSpecialty
    ? (SPECIALTY_PRICE[input.specialtyService ?? ""] ?? 0)
    : cnt > 0 ? calculateTotalCharge(propType, freq, cnt) : 0;

  const out: Record<string, string | number> = {
    customerID,
    serviceID,
    active: 1,
    frequency: frequencyDays,
    billingFrequency: billingFrequencyDays,
    sourceID: SOURCE_WEBSITE,
    convertToLead: 1,
  };

  if (monthlyRate > 0) {
    out.serviceCharge = monthlyRate;
    out.initialCharge = monthlyRate;
  }

  return out;
}

// ── Handler ──────────────────────────────────────────────────────────

export const handler: Handler = async (event) => {
  const method =
    event.httpMethod ?? event.requestContext?.http?.method ?? "POST";

  if (method !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  // Parse body
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

  // Validate
  const missing = REQUIRED_FIELDS.filter((k) => !(input[k] ?? "").trim());
  if (missing.length > 0) {
    return jsonResponse(422, { error: "Missing required fields", missing });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((input.email ?? "").trim())) {
    return jsonResponse(422, { error: "Invalid email" });
  }
  if (digitsOnly(input.phone).length < 7) {
    return jsonResponse(422, { error: "Invalid phone" });
  }

  // Credentials
  const subdomain = process.env.FIELDROUTES_SUBDOMAIN ?? "buzzkill";
  const key = process.env.FIELDROUTES_KEY ?? "";
  const token = process.env.FIELDROUTES_TOKEN ?? "";
  const dryRun = process.env.LEAD_INTAKE_DRY_RUN === "1";

  const isPlaceholder = (s: string) =>
    s.includes("<value will be resolved during runtime>");
  const unresolved: string[] = [];
  if (!key || isPlaceholder(key)) unresolved.push("FIELDROUTES_KEY");
  if (!token || isPlaceholder(token)) unresolved.push("FIELDROUTES_TOKEN");
  if (!subdomain || isPlaceholder(subdomain))
    unresolved.push("FIELDROUTES_SUBDOMAIN");
  if (unresolved.length > 0) {
    console.error("FieldRoutes credentials missing or unresolved", {
      unresolved,
    });
    return jsonResponse(500, {
      error:
        "Server misconfigured: required secrets are not set for this branch.",
      unresolved,
      hint: "Set them in Amplify Console → App settings → Secrets, scoped to this branch, then redeploy.",
    });
  }

  const customerPayload = buildCustomerPayload(input);

  if (dryRun) {
    const subPayload = buildSubscriptionPayload(input, 0);
    console.log("[dry-run] customer payload:", customerPayload);
    console.log("[dry-run] subscription payload:", subPayload);
    return jsonResponse(200, {
      ok: true,
      dryRun: true,
      customerPayload,
      subscriptionPayload: subPayload,
    });
  }

  // ── Step 1: Create customer ──────────────────────────────────────
  let customerResult: { status: number; body: Record<string, unknown> };
  try {
    customerResult = await frPost(
      subdomain,
      key,
      token,
      "customer/create",
      customerPayload,
    );
  } catch (err) {
    const e = err as { name?: string; message?: string; cause?: unknown };
    const cause = e?.cause as { code?: string; message?: string } | undefined;
    console.error("customer/create fetch failed", {
      name: e?.name,
      message: e?.message,
      causeCode: cause?.code,
    });
    return jsonResponse(502, {
      error: "Upstream request failed (customer/create)",
      detail: e?.message ?? String(err),
    });
  }

  console.log("customer/create response", customerResult);

  if (
    customerResult.status < 200 ||
    customerResult.status >= 300 ||
    customerResult.body.success === false
  ) {
    return jsonResponse(502, {
      error: "FieldRoutes rejected customer/create",
      upstreamStatus: customerResult.status,
      upstreamBody: customerResult.body,
    });
  }

  const customerID = Number(customerResult.body.result);
  if (!customerID || isNaN(customerID)) {
    console.error("customer/create returned no customerID", customerResult.body);
    return jsonResponse(502, {
      error: "customer/create succeeded but returned no customer ID",
      upstreamBody: customerResult.body,
    });
  }

  // ── Step 2: Create subscription (as lead) ────────────────────────
  const subPayload = buildSubscriptionPayload(input, customerID);

  let subResult: { status: number; body: Record<string, unknown> };
  try {
    subResult = await frPost(
      subdomain,
      key,
      token,
      "subscription/create",
      subPayload,
    );
  } catch (err) {
    const e = err as { name?: string; message?: string };
    console.error("subscription/create fetch failed", {
      name: e?.name,
      message: e?.message,
    });
    // Customer was created — report partial success
    return jsonResponse(200, {
      ok: true,
      customerID,
      warning: "Customer created but subscription/create failed",
      subscriptionError: e?.message ?? String(err),
    });
  }

  console.log("subscription/create response", subResult);

  if (
    subResult.status < 200 ||
    subResult.status >= 300 ||
    subResult.body.success === false
  ) {
    // Customer was created — report partial success
    return jsonResponse(200, {
      ok: true,
      customerID,
      warning: "Customer created but subscription was rejected",
      upstreamBody: subResult.body,
    });
  }

  const subscriptionID = Number(subResult.body.result);

  // ── Step 3: Set quantity via subscription/createInitialAddOn ──────
  // The base service charge is created automatically by FieldRoutes
  // from the service type template. To set the CNT (quantity) column,
  // we add an initial addon with the unit count / sqft as quantity.
  // This requires a productID — we use serviceID as the product
  // reference since they map to the same service type.
  const isAssociation = input.propertyType === "Association";
  const cnt = input.propertyType === "Specialty"
    ? 0
    : Number(digitsOnly(isAssociation ? input.units : input.sqft));
  let ticketWarning: string | undefined;

  if (subscriptionID && cnt > 0) {
    try {
      const addonResult = await frPost(subdomain, key, token, "subscription/createInitialAddOn", {
        subscriptionID,
        productID: 0,
        amount: 0,
        quantity: cnt,
        taxable: 0,
        description: isAssociation ? "Units" : "Square Footage",
      });
      console.log("subscription/createInitialAddOn response", addonResult);

      if (addonResult.body.success === false) {
        ticketWarning = `createInitialAddOn rejected: ${JSON.stringify(addonResult.body)}`;
        console.warn(ticketWarning);
      }
    } catch (err) {
      const e = err as { message?: string };
      ticketWarning = `createInitialAddOn failed: ${e?.message ?? String(err)}`;
      console.error(ticketWarning);
    }
  }

  // ── Step 4: Create contract (no FieldRoutes email — we send our own) ─
  // contract/create generates the agreement. emailCustomer=0 suppresses
  // the FieldRoutes email so we control the messaging via SES instead.
  // The signing URL comes back in the `result` field.
  let contractWarning: string | undefined;
  let agreementUrl: string | undefined;

  // Zero-price specialty services (Termite Bait Stations, Other Specialty Service)
  // require a manual quote — skip auto-contract generation entirely.
  const skipContract = isSpecialty && !hasKnownPrice;

  if (subscriptionID && !skipContract) {
    try {
      const contractResult = await frPost(subdomain, key, token, "contract/create", {
        subscriptionID,
        emailCustomer: 0,
        notifyCustomerOnSignedAgreement: 1,
      });
      console.log("contract/create response", contractResult);

      if (contractResult.body.success === false) {
        contractWarning = `contract/create rejected: ${JSON.stringify(contractResult.body)}`;
        console.warn(contractWarning);
      } else {
        // result is the signing URL, e.g. https://buzzkill.pestportals.com/loginagree/...
        const resultVal = String(contractResult.body.result ?? "");
        if (resultVal.startsWith("http")) {
          agreementUrl = resultVal;
        }
      }
    } catch (err) {
      const e = err as { message?: string };
      contractWarning = `contract/create failed: ${e?.message ?? String(err)}`;
      console.error(contractWarning);
    }
  }

  // ── Step 5: Send notification + quote emails ─────────────────────
  const fromEmail = process.env.SES_FROM_EMAIL ?? "info@pestbuzzkill.com";
  const notifyEmail = process.env.SES_NOTIFY_EMAIL ?? "info@pestbuzzkill.com";
  const isSpecialty = input.propertyType === "Specialty";
  const isAssoc = isSpecialty
    ? input.specialtyPropertyType === "Association"
    : input.propertyType === "Association";
  const propLabel = isSpecialty ? "Specialty Services" : isAssoc ? "Association / HOA" : "Residential";
  const cntValue = isSpecialty ? 0 : Number(digitsOnly(isAssoc ? input.units : input.sqft));
  const propType = isAssoc ? "Association" : "Residential";
  const freqLabel = isSpecialty ? "One-time treatment" : (input.freq ?? "Monthly");

  // For recurring plans, this is the monthly billing rate. For one-time
  // treatments, this is the total flat charge for the single visit.
  // The display copy forks on `oneTime` to render the suffix correctly
  // ("/month + tax" vs "one-time + tax").
  const oneTime = isSpecialty || isOneTime(freqLabel);
  const monthlyCharge = isSpecialty
    ? (SPECIALTY_PRICE[input.specialtyService ?? ""] ?? 0)
    : calculateTotalCharge(propType, freqLabel, cntValue);
  const hasKnownPrice = monthlyCharge > 0;
  const chargeFormatted = hasKnownPrice ? formatCurrency(monthlyCharge) : "Custom Quote";
  const chargeSuffix = hasKnownPrice ? (oneTime ? " one-time + tax" : " / month + tax") : "";

  // 5a: Internal notification to BuzzKill team
  try {
    const notifyHtml = `
      <div style="font-family: Arial, sans-serif; font-size: 14px; color: #1A1A1A; line-height: 1.6;">
        <h2 style="color: #0A0A0A; margin: 0 0 16px;">New Lead Submitted</h2>
        <table cellpadding="6" cellspacing="0" border="0" style="border-collapse: collapse; font-size: 14px;">
          <tr><td style="font-weight: 700; color: #5FA517; padding-right: 16px;">Name</td><td>${(input.first ?? "").trim()} ${(input.last ?? "").trim()}</td></tr>
          <tr><td style="font-weight: 700; color: #5FA517; padding-right: 16px;">Email</td><td><a href="mailto:${(input.email ?? "").trim()}">${(input.email ?? "").trim()}</a></td></tr>
          <tr><td style="font-weight: 700; color: #5FA517; padding-right: 16px;">Phone</td><td><a href="tel:${digitsOnly(input.phone)}">${(input.phone ?? "").trim()}</a></td></tr>
          <tr><td style="font-weight: 700; color: #5FA517; padding-right: 16px;">Address</td><td>${(input.addr ?? "").trim()}, ${(input.city ?? "").trim()}, ${(input.state ?? "").trim().toUpperCase()} ${digitsOnly(input.zip).slice(0, 5)}</td></tr>
          <tr><td style="font-weight: 700; color: #5FA517; padding-right: 16px;">Type</td><td>${propLabel}</td></tr>
          ${isAssoc && input.company?.trim() ? `<tr><td style="font-weight: 700; color: #5FA517; padding-right: 16px;">Company</td><td>${input.company.trim()}</td></tr>` : ""}
          ${isSpecialty
            ? `<tr><td style="font-weight: 700; color: #5FA517; padding-right: 16px;">Location Type</td><td>${input.specialtyPropertyType || "—"}</td></tr>
               <tr><td style="font-weight: 700; color: #5FA517; padding-right: 16px;">Service</td><td>${input.specialtyService || "—"}</td></tr>`
            : isAssoc
              ? `<tr><td style="font-weight: 700; color: #5FA517; padding-right: 16px;">Units</td><td>${input.units || "—"}</td></tr>`
              : `<tr><td style="font-weight: 700; color: #5FA517; padding-right: 16px;">Sq Ft</td><td>${input.sqft || "—"}</td></tr>`
          }
          <tr><td style="font-weight: 700; color: #5FA517; padding-right: 16px;">Frequency</td><td>${freqLabel}</td></tr>
          <tr><td style="font-weight: 700; color: #5FA517; padding-right: 16px;">Quoted Price</td><td style="font-weight: 700; font-size: 16px;">${chargeFormatted}${chargeSuffix}</td></tr>
          <tr><td style="font-weight: 700; color: #5FA517; padding-right: 16px;">Customer ID</td><td>${customerID}</td></tr>
          <tr><td style="font-weight: 700; color: #5FA517; padding-right: 16px;">Subscription ID</td><td>${subscriptionID || "—"}</td></tr>
        </table>
      </div>`;
    await sendEmail(
      fromEmail,
      notifyEmail,
      isSpecialty
        ? `New Specialty Lead: ${(input.first ?? "").trim()} ${(input.last ?? "").trim()} — ${input.specialtyService || "Specialty Service"}`
        : `New Lead${oneTime ? " (One-Time)" : ""}: ${(input.first ?? "").trim()} ${(input.last ?? "").trim()} — ${propLabel} ${freqLabel}`,
      notifyHtml,
    );
    console.log("Notification email sent to", notifyEmail);
  } catch (err) {
    console.error("Failed to send notification email", (err as Error).message);
  }

  // 5b: Customer quote email (includes agreement signing link if available)
  try {
    const firstName = (input.first ?? "").trim();

    const agreementBlock = agreementUrl
      ? `
        <div style="text-align: center; margin: 28px 0;">
          <a href="${agreementUrl}" target="_blank" rel="noopener noreferrer" style="display: inline-block; background: #7ED321; color: #0A0A0A; font-weight: 800; font-size: 16px; text-decoration: none; padding: 16px 36px; border-radius: 8px; letter-spacing: 0.02em; text-transform: uppercase;">
            Review &amp; Sign Agreement
          </a>
          <div style="font-size: 12px; color: #9A9A9A; margin-top: 10px;">Secure link — opens your service agreement for review and e-signature</div>
        </div>

        <p><strong>Once you've signed:</strong></p>
        <ol style="padding-left: 20px; color: #4A4A4A;">
          <li style="margin-bottom: 8px;">We'll confirm receipt and <strong>schedule your first appointment</strong></li>
          <li style="margin-bottom: 8px;">You'll receive an appointment confirmation with date, time, and technician details</li>
        </ol>`
      : `
        <p><strong>What happens next:</strong></p>
        <ol style="padding-left: 20px; color: #4A4A4A;">
          <li style="margin-bottom: 8px;">We'll review your information and follow up within <strong>one business day</strong></li>
          <li style="margin-bottom: 8px;">You'll receive a <strong>formal service agreement</strong> to review and sign</li>
          <li style="margin-bottom: 8px;">Once signed, we'll <strong>schedule your first appointment</strong></li>
        </ol>`;

    const priceSuffixHtml = !hasKnownPrice
      ? ""
      : oneTime
        ? ` one-time <span style="font-size: 13px; color: #9A9A9A;">+ tax</span>`
        : ` / month <span style="font-size: 13px; color: #9A9A9A;">+ tax</span>`;
    const metaLabel = isSpecialty
      ? (input.specialtyService || "Specialty Service")
      : oneTime ? "One-time treatment" : `${freqLabel} service`;
    const quoteCard = `
        <div style="background: #F7F7F4; border-left: 4px solid #7ED321; padding: 20px 24px; margin: 24px 0; border-radius: 0 8px 8px 0;">
          <div style="font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; color: #5FA517; font-weight: 700; margin-bottom: 8px;">Your Quick Quote</div>
          <div style="font-size: 28px; font-weight: 800; color: #0A0A0A; margin-bottom: 4px;">${chargeFormatted}<span style="font-size: 15px; font-weight: 400; color: #6E6E6E;">${priceSuffixHtml}</span></div>
          <div style="font-size: 14px; color: #4A4A4A;">${propLabel} &bull; ${metaLabel}${!isSpecialty && isAssoc && input.units ? ` &bull; ${input.units} units` : ""}${!isSpecialty && !isAssoc && input.sqft ? ` &bull; ${input.sqft} sq ft` : ""}</div>
          ${!hasKnownPrice ? `<div style="font-size: 13px; color: #6E6E6E; margin-top: 8px;">A specialist will follow up with a tailored quote for your property.</div>` : ""}
        </div>`;

    const customerHtml = `
      <div style="font-family: Arial, sans-serif; font-size: 15px; color: #1A1A1A; line-height: 1.7; max-width: 600px;">
        <p>Hi ${firstName},</p>

        <p>Thank you for reaching out to <strong>BuzzKill Pest Control</strong>! We appreciate your interest in professional pest management for your ${isAssoc ? "community" : "home"}.</p>

        ${skipContract ? `
        <div style="background: #F7F7F4; border-left: 4px solid #7ED321; padding: 20px 24px; margin: 24px 0; border-radius: 0 8px 8px 0;">
          <div style="font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; color: #5FA517; font-weight: 700; margin-bottom: 8px;">Next Steps</div>
          <div style="font-size: 15px; color: #1A1A1A; line-height: 1.6;">We've received your request for <strong>${input.specialtyService}</strong>. Because pricing for this service depends on your specific property, one of our specialists will reach out within one business day with a custom quote.</div>
        </div>` : `${quoteCard}

        ${agreementBlock}`}

        <p>If you have any questions, don't hesitate to call us at <a href="tel:+15082589294" style="color: #5FA517; font-weight: 600;">508-258-9294</a> or reply to this email.</p>

        <p>We look forward to working with you!</p>

        <br>
        ${EMAIL_SIGNATURE}
      </div>`;
    await sendEmail(
      fromEmail,
      (input.email ?? "").trim(),
      isSpecialty
        ? (hasKnownPrice
            ? `Your BuzzKill ${input.specialtyService} Quote — ${chargeFormatted}`
            : `Your BuzzKill ${input.specialtyService} Request — A Specialist Will Follow Up`)
        : oneTime
          ? `Your BuzzKill One-Time Service Quote — ${chargeFormatted}`
          : `Your BuzzKill Pest Control Quote — ${chargeFormatted}/month`,
      customerHtml,
    );
    console.log("Customer quote email sent to", (input.email ?? "").trim());
  } catch (err) {
    console.error("Failed to send customer email", (err as Error).message);
  }

  return jsonResponse(200, {
    ok: true,
    customerID,
    subscriptionID: subscriptionID || undefined,
    agreementUrl,
    monthlyCharge,
    frequency: freqLabel,
    ...(ticketWarning ? { ticketWarning } : {}),
    ...(contractWarning ? { contractWarning } : {}),
  });
};
