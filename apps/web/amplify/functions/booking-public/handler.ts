import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { randomUUID } from "node:crypto";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import Stripe from "stripe";
import { dataClient } from "../shared/dataClient";
import { emailShell, notifyLeads, notifyOffice, sendEmail } from "../shared/email";
import { driveMinutesBetween, HQ_ADDRESS } from "../shared/driveTime";
import {
  zoneFromMinutes,
  money,
  ZONE_B,
  type Zone,
} from "../crm-pricing/rateCards";
import { cancelPlanBilling } from "../shared/subscription";
import {
  BOOKING_TERMS_TEXT,
  BOOKING_TERMS_VERSION,
  CANCEL_FULL_REFUND_DAYS,
} from "../shared/bookingTerms";
import { buildDayMatrix, type DayQuote } from "./availability";
import {
  enqueueRateResearch,
  getCachedRate,
  hoaBandFor,
  sqftBucket,
  type MarketRateService,
  type PlanCadence,
} from "../shared/marketRate";

/**
 * Public booking funnel API (Function URL, CORS-locked to the marketing
 * site). POST /quote prices every available day for the next month from
 * live schedule data; POST /book takes payment via Stripe; the Stripe
 * webhook finalizes the CRM records; POST /cancel enforces the refund
 * policy (>3 days = full refund, otherwise none).
 */

const ssm = new SSMClient();
const secretCache = new Map<string, string>();

async function getSecret(name: string): Promise<string | null> {
  const fromEnv = process.env[name];
  if (fromEnv && fromEnv !== "placeholder-set-me") return fromEnv;
  if (secretCache.has(name)) return secretCache.get(name)!;
  const appId = process.env.AMPLIFY_APP_ID ?? "d26qpsjewk0bee";
  for (const path of [
    `/amplify/${appId}/${process.env.AMPLIFY_BRANCH ?? "staging"}/${name}`,
    `/amplify/shared/${appId}/${name}`,
  ]) {
    try {
      const res = await ssm.send(
        new GetParameterCommand({ Name: path, WithDecryption: true })
      );
      const v = res.Parameter?.Value;
      if (v && v !== "placeholder-set-me") {
        secretCache.set(name, v);
        return v;
      }
    } catch {
      /* try next path */
    }
  }
  return null;
}

/**
 * A non-production branch must never move real money. The shared SSM
 * fallback holds the live key, so a missing branch secret used to silently
 * run this funnel in live mode — a staging checkout creating real
 * PaymentIntents. Refuse loudly instead: a 500 somebody sees beats a live
 * charge nobody meant.
 */
export function assertStripeKeyAllowed(
  key: string,
  branch: string | undefined
): void {
  if (branch !== "main" && /^[sr]k_live_/.test(key)) {
    throw new Error(
      `Refusing a live Stripe key on branch "${branch ?? "unknown"}" — set the branch's STRIPE_SECRET_KEY secret to a test key.`
    );
  }
}

let stripe: Stripe | null = null;
async function stripeClient(): Promise<Stripe> {
  if (stripe) return stripe;
  const key = await getSecret("STRIPE_SECRET_KEY");
  if (!key) throw new Error("Stripe is not configured");
  assertStripeKeyAllowed(key, process.env.AMPLIFY_BRANCH);
  stripe = new Stripe(key);
  return stripe;
}

const ALLOWED_ORIGINS = (process.env.BOOKING_CORS_ORIGINS ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

const originAllowed = (origin: string | undefined): boolean =>
  !origin || ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin);

function corsHeaders(origin: string | undefined): Record<string, string> {
  return {
    // Only ever echo an origin we actually trust.
    "Access-Control-Allow-Origin":
      origin && ALLOWED_ORIGINS.includes(origin)
        ? origin
        : (ALLOWED_ORIGINS[0] ?? "*"),
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
}

type QuoteInput = {
  propertyKind?: string;
  name?: string;
  email?: string;
  phone?: string;
  address?: { street?: string; city?: string; state?: string; zip?: string };
  units?: number;
  service?: string;
  sqft?: number;
  nestCount?: number;
  comments?: string;
  recurringPreference?: string | null;
  botToken?: string;
  /** First-touch ad attribution from the site — untrusted, sanitized below. */
  attribution?: unknown;
};

/** The only attribution keys the funnel stores (mirrors lead-intake). */
const ATTRIBUTION_KEYS = [
  "source",
  "medium",
  "campaign",
  "term",
  "content",
  "gclid",
  "referrer",
  "landingPage",
] as const;
type AttributionKey = (typeof ATTRIBUTION_KEYS)[number];
type Attribution = Partial<Record<AttributionKey, string>>;

const ATTRIBUTION_VALUE_MAX = 300;

/**
 * Attribution is nice-to-have telemetry from the browser — it must never fail
 * a quote. Keep only the known keys, coerce primitive values to strings
 * truncated at 300 chars, and drop everything else (arrays, objects, junk)
 * silently. Returns null when nothing usable survives.
 */
export function sanitizeAttribution(raw: unknown): Attribution | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const out: Attribution = {};
  for (const key of ATTRIBUTION_KEYS) {
    const value = (raw as Record<string, unknown>)[key];
    if (
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      continue;
    }
    const str = String(value).trim().slice(0, ATTRIBUTION_VALUE_MAX);
    if (str) out[key] = str;
  }
  return Object.keys(out).length ? out : null;
}

// AppSync AWSEmail/AWSPhone reject loosely-formatted values, and a paid
// booking must never fail to finalize on a format error — so validate hard
// at the quote step, where the customer can still fix it.
const EMAIL_RE =
  /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+$/;

/** E.164-ish normalization; null when the input can't be salvaged. */
function normalizePhone(raw: string | undefined): string | null {
  const digits = (raw ?? "").replace(/[^\d+]/g, "");
  if (!digits) return null;
  if (/^\d{10}$/.test(digits)) return `+1${digits}`;
  if (/^1\d{10}$/.test(digits)) return `+${digits}`;
  if (/^\+\d{10,15}$/.test(digits)) return digits;
  return null;
}

const SERVICES = new Set([
  "GENERAL_PEST",
  "WASP_NEST",
  "RODENT",
  "ROACH",
  "TERMITE",
  "WILDLIFE",
]);

const PROPERTY_KINDS = new Set(["RESIDENTIAL", "COMMUNITY", "COMMERCIAL"]);

/** Residential services priced from a sqft-banded sheet. */
const SQFT_SERVICES = new Set([
  "GENERAL_PEST",
  "RODENT",
  "ROACH",
  "TERMITE",
  "WILDLIFE",
]);

export const handler = async (
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> => {
  const origin = event.headers?.origin;
  const headers = corsHeaders(origin);
  const method = event.requestContext.http.method;
  if (method === "OPTIONS") return { statusCode: 204, headers, body: "" };
  // A browser always sends Origin on a cross-origin POST; refuse the ones we
  // don't publish from. (Not a security boundary on its own — the bot check
  // and throttle carry that — but it stops casual embedding.)
  if (!originAllowed(origin)) {
    return {
      statusCode: 403,
      headers,
      body: JSON.stringify({ error: "Forbidden origin" }),
    };
  }
  if (method !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "POST only" }) };
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(
      event.isBase64Encoded
        ? Buffer.from(event.body ?? "", "base64").toString("utf8")
        : (event.body ?? "{}")
    );
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  const path = event.requestContext.http.path.replace(/\/+$/, "");
  try {
    if (path.endsWith("/quote")) {
      return json(
        headers,
        await quote(body as QuoteInput, event.requestContext.http.sourceIp)
      );
    }
    if (path.endsWith("/book")) {
      return json(
        headers,
        await book(body, {
          sourceIp: event.requestContext.http.sourceIp,
          userAgent:
            event.headers?.["user-agent"] ??
            event.requestContext.http.userAgent,
        })
      );
    }
    if (path.endsWith("/cancel")) {
      return json(headers, await cancel(body));
    }
    return { statusCode: 404, headers, body: JSON.stringify({ error: "Not found" }) };
  } catch (err) {
    if (err instanceof HttpError) {
      return { statusCode: err.status, headers, body: JSON.stringify(err.payload) };
    }
    console.error("booking-public failure", err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Something went wrong on our side — please try again." }),
    };
  }
};

class HttpError extends Error {
  constructor(
    public status: number,
    public payload: Record<string, unknown>
  ) {
    super(JSON.stringify(payload));
  }
}

const json = (
  headers: Record<string, string>,
  payload: unknown
): APIGatewayProxyResultV2 => ({
  statusCode: 200,
  headers,
  body: JSON.stringify(payload),
});

// ---------------------------------------------------------------- /quote

/**
 * Layered abuse control for the unauthenticated endpoint: an optional bot
 * token (enforced as soon as TURNSTILE_SECRET is configured) and a
 * best-effort per-IP hourly cap. The live path is pure reads now — AI
 * research runs only inside the hourly pricing-refresh cron, behind its own
 * per-run/per-day caps — but the endpoint still spends real money per call
 * (Google Routes), so nothing billed runs until these pass.
 */
const QUOTES_PER_IP_PER_HOUR = 12;

async function verifyBotToken(token: string | undefined): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET;
  if (!secret) return true; // not configured yet — don't break the form
  if (!token) return false;
  try {
    const res = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret, response: token }),
      }
    );
    const json = (await res.json()) as { success?: boolean };
    return json.success === true;
  } catch {
    return false;
  }
}

/** Best-effort: read-then-write can lose a race, but it still stops a
 *  single source from looping the endpoint thousands of times. */
async function throttleOk(ip: string): Promise<boolean> {
  if (!ip) return true;
  const hour = new Date().toISOString().slice(0, 13);
  const id = `${ip}#${hour}`;
  const client = await dataClient();
  const { data: existing } = await client.models.QuoteThrottle.get({ id });
  if (!existing) {
    await client.models.QuoteThrottle.create({
      id,
      count: 1,
      windowStart: new Date().toISOString(),
    });
    return true;
  }
  if (existing.count >= QUOTES_PER_IP_PER_HOUR) return false;
  await client.models.QuoteThrottle.update({ id, count: existing.count + 1 });
  return true;
}

async function quote(input: QuoteInput, sourceIp: string) {
  const errors: Record<string, string> = {};
  const name = (input.name ?? "").trim();
  const email = (input.email ?? "").trim().toLowerCase();
  const service = (input.service ?? "").toUpperCase();
  const propertyKind = (input.propertyKind ?? "RESIDENTIAL").toUpperCase();
  const addr = input.address ?? {};
  if (!name) errors.name = "Name is required";
  if (!EMAIL_RE.test(email)) errors.email = "A valid email is required";
  const phone = input.phone?.trim() ? normalizePhone(input.phone) : null;
  if (input.phone?.trim() && !phone) {
    errors.phone = "Enter a valid phone number, e.g. (413) 555-0123";
  }
  if (!SERVICES.has(service)) errors.service = "Unknown service";
  if (!PROPERTY_KINDS.has(propertyKind)) {
    errors.propertyKind = "Unknown property type";
  }
  if (!addr.street?.trim()) errors["address.street"] = "Street address is required";
  if (!addr.city?.trim()) errors["address.city"] = "City is required";
  if (!addr.state?.trim()) errors["address.state"] = "State is required";
  if (propertyKind === "COMMUNITY") {
    // A community asks for a common-area plan, priced per unit — the unit
    // count is the price input, so it is required.
    if (!input.units || input.units < 1) {
      errors.units = "How many units are in the community? The unit count sets the plan price.";
    }
  } else if (propertyKind === "COMMERCIAL") {
    // Commercial quotes price from a sqft-banded sheet, whatever the pest.
    if (!input.sqft || input.sqft < 100 || input.sqft > 50000) {
      errors.sqft = "Square footage is required for a commercial quote";
    }
  } else {
    if (SQFT_SERVICES.has(service)) {
      if (!input.sqft || input.sqft < 100 || input.sqft > 50000) {
        errors.sqft = "Square footage is required for this service";
      }
    }
    if (service === "WASP_NEST" && (!input.nestCount || input.nestCount < 1)) {
      errors.nestCount = "How many nests need removal?";
    }
  }
  if (Object.keys(errors).length) throw new HttpError(400, { errors });

  if (!(await verifyBotToken(input.botToken))) {
    throw new HttpError(400, {
      error: "We couldn't verify that request came from a browser — please reload and try again.",
    });
  }
  if (!(await throttleOk(sourceIp))) {
    throw new HttpError(429, {
      error: "That's a lot of quotes from one place — give it an hour, or call us at the office and we'll sort it out directly.",
    });
  }

  const client = await dataClient();
  const address = `${addr.street}, ${addr.city}, ${addr.state}${addr.zip ? ` ${addr.zip}` : ""}`;
  // First-touch ad attribution rides along on every booking this quote
  // creates, so finalization can derive the customer's lead source. Malformed
  // input sanitizes to null and the quote proceeds without it.
  const attribution = sanitizeAttribution(input.attribution);

  const makeBooking = async (fields: Record<string, unknown>) => {
    const { data: booking, errors: gqlErrors } =
      await client.models.BookingRequest.create({
        name,
        email,
        phone: phone ?? undefined,
        street: addr.street!.trim(),
        city: addr.city!.trim(),
        state: addr.state!.trim().toUpperCase(),
        zip: addr.zip?.trim() || undefined,
        propertyKind: propertyKind as "RESIDENTIAL" | "COMMUNITY" | "COMMERCIAL",
        service: service as
          | "GENERAL_PEST"
          | "WASP_NEST"
          | "RODENT"
          | "ROACH"
          | "TERMITE"
          | "WILDLIFE",
        units: input.units ?? undefined,
        sqft: input.sqft ?? undefined,
        nestCount: input.nestCount ?? undefined,
        comments: input.comments?.slice(0, 2000) || undefined,
        recurringPreference: input.recurringPreference ?? undefined,
        attribution: attribution ? JSON.stringify(attribution) : undefined,
        cancelToken: randomUUID(),
        ...fields,
      });
    if (!booking) {
      throw new Error(gqlErrors?.[0]?.message ?? "Could not store the request");
    }
    return booking;
  };

  const contact = async (
    message: string,
    extra: Record<string, unknown> = {},
    opsNote = ""
  ) => {
    const booking = await makeBooking({ status: "CONTACT", ...extra });
    await notifyLeads({
      subject: "Website lead needs a call",
      heading: "Website lead needs a call",
      template: "ops-booking-contact",
      relatedId: booking.id,
      bodyHtml: `<p><strong>${escapeHtml(name)}</strong> (${escapeHtml(email)}${input.phone ? `, ${escapeHtml(input.phone)}` : ""}) asked about <strong>${service.toLowerCase().replace("_", " ")}</strong> at ${escapeHtml(address)}.</p>
       ${input.comments ? `<p>Comments: ${escapeHtml(input.comments)}</p>` : ""}
       ${attribution?.source ? `<p>Lead source: utm:${escapeHtml(attribution.source)}${attribution.campaign ? ` · campaign:${escapeHtml(attribution.campaign)}` : ""}</p>` : ""}
       <p>Booking request ${booking.id} — call within the hour per the website promise.</p>
       ${opsNote}`,
    });
    return { bookingId: booking.id, decision: "CONTACT", message };
  };

  // Zone from live drive time.
  const routesKey = await getSecret("GOOGLE_ROUTES_API_KEY");
  const minutes = routesKey
    ? await driveMinutesBetween(routesKey, HQ_ADDRESS, address)
    : null;
  const zone: Zone = minutes == null ? "UNKNOWN" : zoneFromMinutes(minutes);
  if (zone === "OUT") {
    return contact(
      "You're a bit outside our standard service area — a specialist will call within the hour to see what we can do.",
      { zone, driveMinutes: minutes ?? undefined }
    );
  }
  if (zone === "UNKNOWN") {
    // R59: no zone, no price. A Routes outage or an expired key used to
    // silently reprice the whole funnel as Zone B; route the lead to the
    // callback path instead and tell the office why.
    return contact(
      "We just need to double-check your address against our service area — a specialist will call you within the hour with your exact price.",
      { zone },
      `<p style="color:#b91c1c;"><strong>Drive-time zone lookup failed for this address</strong>${
        routesKey
          ? " (the Routes API returned no route — possible outage or a bad address)"
          : " (GOOGLE_ROUTES_API_KEY is not configured)"
      }. Zone pricing is unavailable, so this quote fell back to a callback. If this keeps happening, check the Google Routes API key.</p>`
    );
  }
  const priceZone: Zone = zone;

  // AI base price. Every service prices from the cached market-rate sheet —
  // a PURE READ. The live path never researches: getCachedRate serves the
  // freshest usable row (a stale sheet still serves — staleness beats a
  // callback; pinned office rows serve forever), and only a combo with no
  // sheet at all comes back null. On null we queue the research on the
  // RateCoverage ledger — the hourly pricing-refresh cron picks DEMAND rows
  // up first and emails the lead their exact day-by-day prices — and the
  // lead gets the honest holding copy now. Never a made-up number. The
  // deterministic overlay stays on top of the AI base: the Zone B adders
  // here, then day pricing / capacity / the R62 cost floor below.
  const contactForPrice = async (
    engineService: MarketRateService,
    sqft?: number
  ) => {
    const booking = await makeBooking({ status: "CONTACT" });
    // Never throws (its own contract) — a lost miss record must never fail
    // the lead, and the cron's seeding pass rediscovers this combo from the
    // BookingRequest row anyway.
    await enqueueRateResearch({
      service: engineService,
      city: addr.city!,
      state: addr.state!,
      sqft,
      notifyEmail: email,
      bookingRequestId: booking.id,
    });
    await notifyLeads({
      subject: "Website lead waiting on AI pricing",
      heading: "Website lead waiting on AI pricing",
      template: "ops-booking-rate-queued",
      relatedId: booking.id,
      bodyHtml: `<p><strong>${escapeHtml(name)}</strong> (${escapeHtml(email)}${input.phone ? `, ${escapeHtml(input.phone)}` : ""}) asked about <strong>${service.toLowerCase().replace("_", " ")}</strong> at ${escapeHtml(address)}, and no cached rate exists for that combo yet.</p>
       ${input.comments ? `<p>Comments: ${escapeHtml(input.comments)}</p>` : ""}
       ${attribution?.source ? `<p>Lead source: utm:${escapeHtml(attribution.source)}${attribution.campaign ? ` · campaign:${escapeHtml(attribution.campaign)}` : ""}</p>` : ""}
       <p>The research is queued: the hourly pricing refresh prices it and emails them their exact day-by-day prices — the website promised their inbox within the hour. Nothing is blocked on you, but the lead is in the CRM if you want to call sooner.</p>
       <p>Booking request ${booking.id}.</p>`,
    });
    return {
      bookingId: booking.id,
      decision: "CONTACT",
      message:
        "We're pricing your area right now — your exact day-by-day prices will be in your inbox within the hour.",
    };
  };

  let baseCents: number | null = null;
  let serviceLabel = "";
  let recurringOffer: {
    frequency: string;
    monthlyCents: number;
    initialFeeCents: number;
  } | null = null;
  // Community common-area quotes are plan-only: the day board picks the
  // FIRST VISIT and the price does not vary by day; there is no one-time
  // offer, and /book always books the plan.
  let planOnly = false;

  const freq = (["MONTHLY", "BIMONTHLY", "QUARTERLY"].includes(
    input.recurringPreference ?? ""
  )
    ? input.recurringPreference
    : "QUARTERLY") as PlanCadence;

  if (propertyKind === "COMMUNITY") {
    // Any service asked at a community is a common-area plan quote from the
    // HOA per-unit sheet: per-unit monthly × units for the chosen cadence.
    const rate = await getCachedRate({
      service: "HOA",
      city: addr.city!,
      state: addr.state!,
    });
    const hoa = rate?.sheet.hoaPerUnitMonthly;
    if (!hoa) return contactForPrice("HOA");
    const units = input.units!;
    const perUnit = hoa[hoaBandFor(units)][freq];
    let monthly = perUnit * units;
    // R60: the same deterministic Zone B travel adder every plan carries.
    if (priceZone === "B") monthly += ZONE_B[freq];
    baseCents = monthly;
    planOnly = true;
    serviceLabel = `Community common-area pest control — ${units} units`;
    recurringOffer = {
      frequency: freq,
      monthlyCents: monthly,
      // Charged at booking: the first month's total. The subscription
      // starts after the first completed visit, like every other plan.
      initialFeeCents: monthly,
    };
  } else if (propertyKind === "COMMERCIAL") {
    // Commercial prices like residential general pest — one-time day-priced
    // plus a plan offer — but from the COMMERCIAL sheet for this sqft band.
    const rate = await getCachedRate({
      service: "COMMERCIAL",
      city: addr.city!,
      state: addr.state!,
      sqft: input.sqft!,
    });
    const plan = rate?.sheet.plans?.[freq];
    if (!rate || !plan) return contactForPrice("COMMERCIAL", input.sqft!);
    baseCents = rate.priceCents;
    serviceLabel = `Commercial pest control — up to ${sqftBucket(input.sqft!).toLocaleString()} sqft`;
    if (priceZone === "B") baseCents += ZONE_B.ONE_TIME_FLAT;
    recurringOffer = {
      frequency: freq,
      monthlyCents:
        plan.monthlyCents + (priceZone === "B" ? ZONE_B[freq] : 0),
      initialFeeCents:
        plan.initialFeeCents + (priceZone === "B" ? ZONE_B.ONE_TIME_FLAT : 0),
    };
  } else if (service === "GENERAL_PEST") {
    const rate = await getCachedRate({
      service: "GENERAL_PEST",
      city: addr.city!,
      state: addr.state!,
      sqft: input.sqft!,
    });
    const plan = rate?.sheet.plans?.[freq];
    if (!rate || !plan) return contactForPrice("GENERAL_PEST", input.sqft!);
    baseCents = rate.priceCents;
    serviceLabel = "General pest control — one-time treatment";
    // R60: the same deterministic Zone B travel adders the rate cards
    // carried — an 89-minute drive must not price like a 10-minute one.
    if (priceZone === "B") baseCents += ZONE_B.ONE_TIME_FLAT;
    recurringOffer = {
      frequency: freq,
      monthlyCents:
        plan.monthlyCents + (priceZone === "B" ? ZONE_B[freq] : 0),
      initialFeeCents:
        plan.initialFeeCents + (priceZone === "B" ? ZONE_B.ONE_TIME_FLAT : 0),
    };
  } else if (service === "WASP_NEST") {
    const rate = await getCachedRate({
      service: "WASP_NEST",
      city: addr.city!,
      state: addr.state!,
    });
    const extraNests = (input.nestCount ?? 1) - 1;
    // The sheet must actually price what was asked: a multi-nest job with
    // no extra-nest component on the sheet is an unpriceable request.
    if (!rate || (extraNests > 0 && rate.sheet.extraNestCents == null)) {
      return contactForPrice("WASP_NEST");
    }
    baseCents =
      rate.priceCents + extraNests * (rate.sheet.extraNestCents ?? 0);
    if (priceZone === "B") baseCents += ZONE_B.ONE_TIME_FLAT;
    serviceLabel = `Wasp / hornet nest removal${(input.nestCount ?? 1) > 1 ? ` — ${input.nestCount} nests` : ""}`;
  } else {
    // RODENT / ROACH / TERMITE / WILDLIFE — one-time treatments priced from
    // their sqft-banded sheets.
    const engineService = service as "RODENT" | "ROACH" | "TERMITE" | "WILDLIFE";
    const rate = await getCachedRate({
      service: engineService,
      city: addr.city!,
      state: addr.state!,
      sqft: input.sqft!,
    });
    if (!rate) return contactForPrice(engineService, input.sqft!);
    baseCents = rate.priceCents;
    if (priceZone === "B") baseCents += ZONE_B.ONE_TIME_FLAT;
    const sizeLabel = `up to ${sqftBucket(input.sqft!).toLocaleString()} sqft`;
    serviceLabel = {
      RODENT: `Rodent treatment — ${sizeLabel}`,
      ROACH: `Specialized roach treatment — ${sizeLabel}`,
      TERMITE: `Termite treatment — ${sizeLabel}`,
      WILDLIFE: `Wildlife exclusion and removal — ${sizeLabel}`,
    }[service]!;
  }

  // Day-priced availability from the live schedule.
  let days = await buildDayMatrix({
    routesKey,
    candidateAddress: address,
    service,
    baseCents: baseCents!,
    zone: priceZone,
  });
  if (days.length === 0) {
    return contact(
      "We're fully booked this month — a specialist will call within the hour to find you the first opening."
    );
  }
  if (planOnly) {
    // The day board only picks the first visit: availability and
    // feasibility per day are real, but the plan price never varies by day.
    days = days.map((d) => ({
      ...d,
      priceCents: baseCents!,
      factors: ["community plan, first month charged at booking, price fixed per day"],
    }));
  }

  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const booking = await makeBooking({
    status: "QUOTED",
    zone,
    driveMinutes: minutes ?? undefined,
    quoteJson: JSON.stringify({
      days,
      baseCents,
      serviceLabel,
      recurringOffer,
      planOnly: planOnly || undefined,
    }),
    monthlyCents: recurringOffer?.monthlyCents ?? undefined,
    expiresAt,
  });

  // Weekly pricing review sees the website channel too.
  await client.models.LeadPricingRun.create({
    source: "website",
    decision: "QUOTE",
    outcome: "PENDING",
    inputText: `[website ${service}] ${name}, ${address}${input.sqft ? `, ${input.sqft} sqft` : ""}${input.nestCount ? `, ${input.nestCount} nests` : ""}`,
    zone,
    driveMinutes: minutes ?? undefined,
    town: addr.city,
    state: addr.state?.toUpperCase(),
    service: serviceLabel,
    // A plan-only quote (community) has no one-time price — baseCents there
    // is the monthly total, already reported on monthlyPriceCents.
    oneTimePriceCents: planOnly ? undefined : baseCents,
    monthlyPriceCents: recurringOffer?.monthlyCents ?? undefined,
    initialFeeCents: recurringOffer?.initialFeeCents ?? undefined,
    priceBreakdown: JSON.stringify(
      days.slice(0, 5).map((d) => ({ label: d.date, cents: d.priceCents }))
    ),
    reason: `Website funnel quote — ${days.length} days offered`,
  });

  return {
    bookingId: booking.id,
    decision: "PRICED",
    service: serviceLabel,
    recurringOffer,
    // Plan-only quotes (community common-area) carry no one-time offer: the
    // day picks the first visit and the amount charged is the first month.
    planOnly: planOnly || undefined,
    days: days.map(({ factors: _f, ...d }) => d),
    expiresAt,
    // R17: the checkout must render exactly what /book will hold them to.
    terms: { version: BOOKING_TERMS_VERSION, text: BOOKING_TERMS_TEXT },
  };
}

// ----------------------------------------------------------------- /book

async function book(
  body: Record<string, unknown>,
  req: { sourceIp?: string; userAgent?: string }
) {
  const bookingId = String(body.bookingId ?? "");
  const date = String(body.date ?? "");
  const window = String(body.window ?? "");
  if (!body.tcAccepted) {
    throw new HttpError(400, {
      error: "Please accept the terms & cancellation policy to book.",
    });
  }
  // R17: an acceptance is only worth recording if it names the terms it
  // accepted. Missing or stale version → the UI re-renders the fresh terms
  // and re-asks; no money moves against an unseen policy.
  const tcVersion = typeof body.tcVersion === "string" ? body.tcVersion : "";
  if (tcVersion !== BOOKING_TERMS_VERSION) {
    throw new HttpError(409, {
      error: "The booking terms were updated — please review them again.",
      terms: { version: BOOKING_TERMS_VERSION, text: BOOKING_TERMS_TEXT },
    });
  }
  const client = await dataClient();
  const { data: booking } = await client.models.BookingRequest.get({
    id: bookingId,
  });
  if (!booking || booking.status !== "QUOTED") {
    throw new HttpError(404, { error: "Quote not found — request a new one." });
  }
  if (booking.expiresAt && new Date(booking.expiresAt).getTime() < Date.now()) {
    throw new HttpError(410, { error: "This quote expired — request a fresh one." });
  }
  const stored = JSON.parse(String(booking.quoteJson ?? "{}")) as {
    days?: DayQuote[];
    serviceLabel?: string;
    recurringOffer?: { frequency: string; monthlyCents: number; initialFeeCents: number } | null;
    planOnly?: boolean;
  };
  // A plan-only quote (community common-area) has no one-time offer — the
  // booking is always the plan, whatever the client sent.
  const recurring = body.recurring === true || stored.planOnly === true;
  const day = stored.days?.find((d) => d.date === date);
  if (!day || !day.windows.includes(window)) {
    throw new HttpError(409, {
      error: "That day is no longer available — request a fresh quote.",
    });
  }
  if (recurring && !stored.recurringOffer) {
    throw new HttpError(400, { error: "No recurring plan was offered on this quote." });
  }

  // Server-side price: one-time pays the day price; recurring pays the
  // initial fee now and the subscription starts after the first visit.
  const amountCents = recurring
    ? stored.recurringOffer!.initialFeeCents
    : day.priceCents;

  const s = await stripeClient();

  // Repeat /book calls must never leave a second chargeable intent behind:
  // a paid one is terminal, an open one is reused or replaced.
  let existing: Stripe.PaymentIntent | null = null;
  if (booking.stripePaymentIntentId) {
    existing = await s.paymentIntents.retrieve(booking.stripePaymentIntentId);
    if (existing.status === "succeeded" || existing.status === "processing") {
      throw new HttpError(409, {
        error: "This booking is already paid — check your email for the confirmation.",
      });
    }
  }

  // R29: the stored quote is a snapshot up to 24 hours old — every holder of
  // a live quote could otherwise book the same last slot. Re-read the day and
  // re-run capacity/feasibility against the live schedule before taking
  // money. The PRICE is not re-run: the customer pays what they were quoted.
  const address = `${booking.street}, ${booking.city}, ${booking.state}${booking.zip ? ` ${booking.zip}` : ""}`;
  const liveDay = await buildDayMatrix({
    routesKey: await getSecret("GOOGLE_ROUTES_API_KEY"),
    candidateAddress: address,
    service: String(booking.service),
    baseCents: day.priceCents, // availability only — the quoted price stands
    zone:
      booking.zone === "A" || booking.zone === "B" ? booking.zone : undefined,
    onlyDate: date,
  });
  if (!liveDay.some((d) => d.date === date && d.windows.includes(window))) {
    // A stale open intent must not stay chargeable for a day we just said no to.
    if (existing) {
      try {
        await s.paymentIntents.cancel(existing.id);
      } catch {
        /* already canceled/expired — fine */
      }
    }
    throw new HttpError(409, {
      error: "That day is no longer available — request a fresh quote.",
    });
  }

  if (existing) {
    if (
      existing.amount === amountCents &&
      booking.selectedDate === date &&
      booking.selectedWindow === window &&
      existing.client_secret
    ) {
      return {
        clientSecret: existing.client_secret,
        amountCents,
        summary: summaryFor(stored, date, window, recurring),
      };
    }
    try {
      await s.paymentIntents.cancel(existing.id);
    } catch {
      /* already canceled/expired — fine */
    }
  }

  const customerId =
    booking.stripeCustomerId ??
    (
      await s.customers.create({
        email: booking.email,
        name: booking.name,
        phone: booking.phone ?? undefined,
        metadata: { bookingRequestId: booking.id },
      })
    ).id;
  const intent = await s.paymentIntents.create({
    amount: amountCents,
    currency: "usd",
    customer: customerId,
    setup_future_usage: "off_session",
    automatic_payment_methods: { enabled: true },
    description: `${stored.serviceLabel ?? "BuzzKill service"} — ${date} (${window.toLowerCase()})`,
    metadata: { bookingRequestId: booking.id },
  });

  await client.models.BookingRequest.update({
    id: booking.id,
    selectedDate: date,
    selectedWindow: window,
    recurring,
    amountCents,
    stripeCustomerId: customerId,
    stripePaymentIntentId: intent.id,
    // R17: the acceptance record. tcAcceptedAt is server time — a client
    // clock (or a client lie) never decides when the terms were accepted.
    tcVersion,
    tcAcceptedAt: new Date().toISOString(),
    tcIp: req.sourceIp || undefined,
    tcUserAgent: req.userAgent?.slice(0, 512) || undefined,
  });

  return {
    clientSecret: intent.client_secret,
    amountCents,
    summary: summaryFor(stored, date, window, recurring),
  };
}

function summaryFor(
  stored: {
    serviceLabel?: string;
    recurringOffer?: { frequency: string; monthlyCents: number } | null;
  },
  date: string,
  window: string,
  recurring: boolean
): string {
  return `${stored.serviceLabel ?? "Service visit"} — ${date}, ${window.toLowerCase()}${
    recurring && stored.recurringOffer
      ? ` · then ${money(stored.recurringOffer.monthlyCents)}/mo ${stored.recurringOffer.frequency.toLowerCase()} plan`
      : ""
  }`;
}

// --------------------------------------------------------------- /cancel

// CANCEL_FULL_REFUND_DAYS lives in ../shared/bookingTerms — the single
// source shared with the checkout terms and the finalize email (R17).
const SUPPORT_PHONE = "(401) 526-0323";

async function cancel(body: Record<string, unknown>) {
  const token = String(body.token ?? "");
  if (!token) throw new HttpError(400, { error: "Missing token" });
  const client = await dataClient();
  const { data: matches } =
    await client.models.BookingRequest.listBookingRequestByCancelToken({
      cancelToken: token,
    });
  const booking = matches[0];
  if (!booking || booking.status !== "BOOKED") {
    throw new HttpError(404, { error: "Booking not found or already canceled." });
  }

  // Whole calendar days in the shop's timezone — "more than 3 days before"
  // must hold all day, not from an arbitrary clock instant.
  const todayEt = new Date().toLocaleDateString("en-CA", {
    timeZone: "America/New_York",
  });
  // Judged from the customer's FIRST cancellation attempt. If an earlier
  // attempt failed on our side, they keep the refund they were entitled to
  // then — our outage is not their forfeit.
  const judgedOn = booking.cancelRequestedOn ?? todayEt;
  const daysOut = Math.round(
    (Date.parse(`${booking.selectedDate}T00:00:00Z`) -
      Date.parse(`${judgedOn}T00:00:00Z`)) /
      86_400_000
  );
  const refundable = daysOut > CANCEL_FULL_REFUND_DAYS;

  if (body.confirm !== true) {
    return {
      booking: {
        service: booking.service,
        date: booking.selectedDate,
        window: booking.selectedWindow,
        amountCents: booking.amountCents,
      },
      refund: refundable
        ? { kind: "FULL", amountCents: booking.amountCents }
        : { kind: "NONE", amountCents: 0 },
      policy: `More than ${CANCEL_FULL_REFUND_DAYS} days before the visit = full refund; ${CANCEL_FULL_REFUND_DAYS} days or less = no refund.`,
    };
  }

  // Stamp the attempt before anything that can fail. This is what makes a
  // retry safe for the customer: if Stripe is down today and they succeed
  // tomorrow, `judgedOn` above still reads today and they keep their refund.
  //
  // The write is guarded because it is the thing that protects the refund, and
  // an unguarded failure here would fall through to the generic "please try
  // again" — no date recorded, nobody told, and the day-three retry silently
  // loses the refund this whole mechanism exists to preserve. Amplify resolves
  // errors rather than throwing them, so both shapes have to be handled.
  const requestedOn = booking.cancelRequestedOn ?? todayEt;
  let datePersisted = Boolean(booking.cancelRequestedOn);
  if (!datePersisted) {
    try {
      const { data, errors } = await client.models.BookingRequest.update({
        id: booking.id,
        cancelRequestedOn: todayEt,
      });
      datePersisted = Boolean(data) && !errors?.length;
      if (!datePersisted) {
        console.error(
          `cancel: could not record cancelRequestedOn for booking ${booking.id}`,
          errors
        );
      }
    } catch (err) {
      console.error(
        `cancel: could not record cancelRequestedOn for booking ${booking.id}`,
        err
      );
    }
  }
  // Deliberately not fatal. Today's refund decision was already made from
  // `judgedOn` above, so a customer whose cancellation succeeds is unaffected —
  // the date only matters to a later retry. If the cancellation below also
  // fails, its alert carries the date and says it was not saved.

  try {
    // Stop the recurring billing BEFORE anything else and before we tell the
    // customer they are cancelled. Marking the plan CANCELED while its Stripe
    // subscription keeps charging is an unauthorized recurring charge, and the
    // customer has no way to see it — their visits simply stopped.
    if (booking.servicePlanId) {
      await cancelPlanBilling(await stripeClient(), booking.servicePlanId);
    }
    if (refundable && booking.stripePaymentIntentId) {
      const s = await stripeClient();
      // Keyed on the booking so a retry after a partial failure refunds once.
      await s.refunds.create(
        { payment_intent: booking.stripePaymentIntentId },
        { idempotencyKey: `booking-refund-${booking.id}` }
      );
    }
  } catch (err) {
    // The billing is still live and the appointment still stands. Say so —
    // "please try again" is false when the outage is ours, and retrying into a
    // Stripe outage just burns the customer's refund window.
    console.error(`cancel failed for booking ${booking.id}`, err);
    await notifyOffice({
      subject: `ACTION REQUIRED — customer could not cancel: ${booking.name}`,
      heading: "A customer tried to cancel and it failed",
      template: "ops-cancel-failed",
      customerId: booking.customerId ?? undefined,
      relatedId: booking.id,
      bodyHtml: `<p><strong>${escapeHtml(booking.name)}</strong> tried to cancel their ${escapeHtml(String(booking.selectedDate))} visit and it failed. Their plan may still be billing and the appointment is still on the schedule.</p>
       <p><strong>Cancel it by hand and honour the cancellation as of ${escapeHtml(requestedOn)}</strong> — that is the date they first asked${refundable ? `, and it entitles them to a full refund of ${money(booking.amountCents ?? 0)}` : ""}.</p>
       ${
         datePersisted
           ? ""
           : `<p style="color:#b91c1c;"><strong>That date is not saved on the booking</strong> — this email is the only record of it. If they retry after ${escapeHtml(requestedOn)} the system will judge their refund by the later date, so handle it from here.</p>`
       }
       <p style="color:#666;font-size:13px;">Booking: ${escapeHtml(booking.id)}<br/>Error: ${escapeHtml(err instanceof Error ? err.message : String(err))}</p>`,
    });
    throw new HttpError(503, {
      error: `We couldn't cancel your appointment just now — that's a fault on our side, not a problem with your booking. Please call us at ${SUPPORT_PHONE} and we'll sort it out.`,
      cancellationRecordedOn: requestedOn,
      reassurance: `We've recorded that you asked to cancel on ${requestedOn}${refundable ? ", so your full refund still applies even though this didn't go through" : ""}.`,
    });
  }

  if (booking.jobId) {
    await client.models.Job.update({
      id: booking.jobId,
      status: "CANCELED",
      routeId: null,
      routeOrder: null,
    });
  }
  await client.models.BookingRequest.update({
    id: booking.id,
    status: "CANCELED",
  });
  await sendEmail({
    to: booking.email,
    subject: "Your BuzzKill appointment is canceled",
    template: "booking-canceled",
    customerId: booking.customerId ?? undefined,
    relatedId: booking.id,
    html: emailShell(
      "Appointment canceled",
      `<p>Hi ${booking.name},</p>
       <p>Your ${String(booking.service).toLowerCase().replace("_", " ")} visit on <strong>${booking.selectedDate}</strong> is canceled.</p>
       <p>${refundable ? `A full refund of ${money(booking.amountCents ?? 0)} is on its way to your original payment method (3–5 business days).` : `Per the cancellation policy (${CANCEL_FULL_REFUND_DAYS} days or less before the visit), this booking isn't refundable.`}</p>`
    ),
  });
  await notifyOffice({
    subject: "Website booking canceled",
    heading: "Website booking canceled",
    template: "ops-booking-canceled",
    customerId: booking.customerId ?? undefined,
    relatedId: booking.id,
    bodyHtml: `<p><strong>${escapeHtml(booking.name)}</strong> canceled their ${escapeHtml(String(booking.selectedDate))} ${String(booking.service).toLowerCase()} visit. ${refundable ? `Full refund of ${money(booking.amountCents ?? 0)} issued.` : "No refund per policy."}</p>`,
  });
  return { canceled: true, refunded: refundable };
}

// ---------------------------------------------------------------- utils

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
