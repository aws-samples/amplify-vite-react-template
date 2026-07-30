import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { randomUUID } from "node:crypto";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import Stripe from "stripe";
import { dataClient } from "../shared/dataClient";
import { BOOKING_LINK_TOKEN_RE } from "../shared/bookingLink";
import { emailShell, notifyLeads, notifyOffice, sendEmail } from "../shared/email";
import { openOwnedWork, workItemId } from "../shared/ownedWork";
import { nextContactPhrase } from "../shared/businessHours";
import { oneBusinessDayDeadline } from "../shared/businessDays";
import { CALL_CONSENT_TEXT_VERSION } from "../shared/consentText";
import {
  driveMinutesFromNearestBase,
  driveMinutesFromPoint,
} from "../shared/driveTime";
import {
  zoneFromMinutes,
  money,
  priceMosquito,
  travelAdderCents,
  ZONE_C,
  type Zone,
} from "../crm-pricing/rateCards";
import { cancelPlanForCustomer } from "../shared/planCancellation";
import {
  computeVisitCancellationPolicy,
  easternEpochMs,
} from "../shared/cancellationPolicy";
import {
  activeTechBases,
  claimDaySlot,
  jobScheduleGuards,
  releaseJobCapacity,
} from "../shared/capacity";
import { casGuardedUpdate } from "../shared/atomicLock";
import { finalizeBooking } from "../shared/bookingFinalize";
import {
  ensureStripeCustomer,
  getDefaultPaymentMethod,
} from "../shared/subscription";
import {
  discountFor,
  normalizeCode,
  promoLabel,
  resolvePromo,
  STRIPE_MIN_CHARGE_CENTS,
} from "./promo";
import {
  acquirePaymentAttempt,
  PAYABLE_REUSE_STATUSES,
  persistCheckoutAttempt,
} from "../shared/bookingPayment";
import { releaseCapacityClaim } from "../shared/capacity";
import { releaseMonthForJob } from "../shared/obligations";
import {
  BOOKING_TERMS_TEXT,
  BOOKING_TERMS_VERSION,
  CANCEL_FULL_REFUND_DAYS,
  OFF_SEASON_MESSAGE,
} from "../shared/bookingTerms";
import { addDays, buildDayMatrix, type DayQuote } from "./availability";
import {
  enqueueRateResearch,
  areaKeyFor,
  getCachedRate,
  hoaBandFor,
  hoaOneTimePerUnitCents,
  rateKeyFor,
  sqftBucket,
  type MarketRateService,
  type PlanCadence,
} from "../shared/marketRate";
import { serviceLabelFor } from "../shared/serviceCatalog";
import {
  recordFunnelContactOutcome,
  recordWebsiteQuoteLead,
  recordWebsiteQuoteRequested,
} from "../shared/leadLifecycle";

/**
 * Public booking funnel API (Function URL, CORS-locked to the marketing
 * site). POST /quote prices every available day for the next month from
 * live schedule data; POST /book takes payment via Stripe; the Stripe
 * webhook finalizes the CRM records; POST /cancel enforces the refund
 * policy (>3 days = full refund, otherwise none).
 */

const ssm = new SSMClient();
const lambda = new LambdaClient();
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
  /** Condo/HOA only: this ask is for ONE unit, so quote it residentially. */
  inUnit?: boolean;
  name?: string;
  email?: string;
  phone?: string;
  /** The lead ticked "you may call/text me about my quote". */
  callConsent?: boolean;
  callConsentTextVersion?: string;
  /** GL-17: yard size for mosquito plans, in half-acres (1–8). */
  lotHalfAcres?: number;
  address?: { street?: string; city?: string; state?: string; zip?: string };
  units?: number;
  service?: string;
  sqft?: number;
  nestCount?: number;
  /** WILDLIFE: what needs removed (a WILDLIFE_REMOVAL_KINDS label) and how
   *  many — the count sets the price, like nestCount does for wasp. */
  removalKind?: string;
  removalCount?: number;
  comments?: string;
  recurringPreference?: string | null;
  botToken?: string;
  /** First-touch ad attribution from the site — untrusted, sanitized below. */
  attribution?: unknown;
  /** The booking link's lead identity (?lead=<token>) — untrusted, resolved
   *  server-side against Customer.bookingLinkToken and stored as
   *  leadCustomerId so finalization converts exactly that lead. */
  leadToken?: unknown;
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
  // GL-17: the CEO-approved seasonal plans, priced by the deterministic
  // mosquito rate card — never the AI researcher.
  "MOSQUITO",
  "MOSQUITO_TICK",
]);

/** GL-17: the funnel's seasonal plan products. */
const SEASONAL_SERVICES = new Set(["MOSQUITO", "MOSQUITO_TICK"]);

const PROPERTY_KINDS = new Set(["RESIDENTIAL", "COMMUNITY", "COMMERCIAL"]);

/** Residential services priced from a sqft-banded sheet. (WASP_NEST prices
 *  by nest count and WILDLIFE by animal count, so neither is here.) */
const SQFT_SERVICES = new Set([
  "GENERAL_PEST",
  "RODENT",
  "ROACH",
  "TERMITE",
]);

/**
 * A trusted internal invoke from crm-billing (portal add-service). QUOTE
 * prices a new service for an existing customer and stamps the booking to
 * them; BOOK charges their saved card for the quote they own and finalizes.
 * The customerId is always the one crm-billing verified against the caller's
 * Cognito identity — never anything a browser sent.
 */
type InternalOp =
  | { kind: "QUOTE"; customerId: string; input: QuoteInput; sourceIp?: string }
  | {
      kind: "BOOK";
      customerId: string;
      body: Record<string, unknown>;
      sourceIp?: string;
      userAgent?: string;
    };

type InternalResult =
  | { ok: true; data: unknown }
  | { ok: false; status: number; error: string };

async function handleInternalOp(op: InternalOp): Promise<InternalResult> {
  try {
    if (op.kind === "QUOTE") {
      const data = await quote(op.input, op.sourceIp ?? "internal", undefined, {
        customerId: op.customerId,
      });
      return { ok: true, data };
    }
    const data = await book(
      op.body,
      { sourceIp: op.sourceIp, userAgent: op.userAgent },
      { customerId: op.customerId }
    );
    return { ok: true, data };
  } catch (err) {
    if (err instanceof HttpError) {
      const payload = err.payload as { error?: string };
      return { ok: false, status: err.status, error: payload.error ?? "Request failed" };
    }
    console.error("booking-public internal op failed", err);
    return {
      ok: false,
      status: 500,
      error: "Something went wrong and nothing was charged. Please try again.",
    };
  }
}

export const handler = async (
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> => {
  // ── Trusted internal invoke (portal add-service) ──────────────────────
  // crm-billing verifies the Cognito identity and owns-the-customer check,
  // then invokes THIS Lambda directly (IAM InvokeCommand) to run a quote or a
  // saved-card booking for that customer. The public Function URL can never
  // reach this branch: it is entered ONLY when there is no requestContext.http
  // (a direct invoke never has it; a Function URL request always does), so a
  // forged `internalOp` in a public POST body falls straight through to the
  // normal, unauthenticated funnel path. The response is returned raw (not
  // API-Gateway-wrapped) because the caller reads the invoke payload.
  const internalOp = (event as unknown as { internalOp?: InternalOp }).internalOp;
  if (!event.requestContext?.http && internalOp) {
    return (await handleInternalOp(internalOp)) as unknown as APIGatewayProxyResultV2;
  }

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
    if (path.endsWith("/lead-prefill")) {
      return json(headers, await leadPrefill(body));
    }
    if (path.endsWith("/quote-status")) {
      return json(
        headers,
        await quoteStatus(body, event.requestContext.http.sourceIp)
      );
    }
    if (path.endsWith("/promo")) {
      return json(headers, await promoPreview(body));
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
    if (path.endsWith("/booking-status")) {
      return json(headers, await bookingStatus(body));
    }
    if (path.endsWith("/cancel")) {
      return json(headers, await cancel(body));
    }
    if (path.endsWith("/track")) {
      return json(headers, await trackStatus(body));
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

type StoredQuoteBooking = {
  id: string;
  status?: string | null;
  cancelToken?: string | null;
  quoteJson?: unknown;
  expiresAt?: string | null;
  propertyKind?: string | null;
  service?: string | null;
  name: string;
  email: string;
  phone?: string | null;
  street?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  units?: number | null;
  sqft?: number | null;
  nestCount?: number | null;
  comments?: string | null;
  recurringPreference?: string | null;
  attribution?: unknown;
  zone?: string | null;
  driveMinutes?: number | null;
};

function parseStoredQuote(raw: unknown): {
  days?: DayQuote[];
  serviceLabel?: string;
  recurringOffer?: {
    frequency: string;
    monthlyCents: number;
    initialFeeCents: number;
  } | null;
  planOnly?: boolean;
  offSeason?: boolean;
  contactMessage?: string;
} {
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Invoicing (net-terms "Invoice me" at checkout) is offered ONLY to
 * HOA/condo communities and commercial properties — never residential.
 * Derived from the property kind recorded on the booking, so the client
 * can never flip a residential quote into an invoiceable one by editing
 * the request; /book re-derives it from the same stored field.
 */
export function invoiceEligibleFor(
  propertyKind: string | null | undefined
): boolean {
  const kind = (propertyKind ?? "RESIDENTIAL").toUpperCase();
  return kind === "COMMUNITY" || kind === "COMMERCIAL";
}

type QuoteFrequency = "MONTHLY" | "BIMONTHLY" | "QUARTERLY";

function quoteFrequency(value: string | null | undefined): QuoteFrequency | undefined {
  return value === "MONTHLY" || value === "BIMONTHLY" || value === "QUARTERLY"
    ? value
    : undefined;
}

/** The plan cadence the customer actually requested. Plan-only offers use
 *  their one available/selected cadence even if an older caller omitted the
 *  preference field. A normal quote with no recurring request stays one-time. */
function requestedQuoteFrequency(
  requested: string | null | undefined,
  offer: { frequency: string } | null | undefined,
  planOnly = false
): QuoteFrequency | undefined {
  const normalized = quoteFrequency(requested);
  if (normalized && offer?.frequency === normalized) return normalized;
  return planOnly ? quoteFrequency(offer?.frequency) : undefined;
}

/** `serviceLabel` remains the canonical sold-service label used if the
 *  customer changes to one-time. The public response gets a truthful display
 *  label for the option they requested instead of calling a monthly lead a
 *  "one-time treatment" before showing their plan price. */
function quoteDisplayService(
  serviceLabel: string,
  requestedFrequency: QuoteFrequency | undefined
): string {
  if (!requestedFrequency || /\bplan\b/i.test(serviceLabel)) return serviceLabel;
  const base = serviceLabel.replace(/\s+—\s+one-time treatment$/i, "");
  const cadence =
    requestedFrequency === "MONTHLY"
      ? "Monthly"
      : requestedFrequency === "BIMONTHLY"
        ? "Every-2-months"
        : "Quarterly";
  return `${base} — ${cadence} plan`;
}

/** Rehydrate the exact stored day board without recalculating its price. */
function pricedResponse(booking: StoredQuoteBooking) {
  const stored = parseStoredQuote(booking.quoteJson);
  if (
    !stored.serviceLabel ||
    (!stored.days?.length && !stored.offSeason) ||
    !booking.expiresAt
  ) {
    throw new HttpError(409, {
      error: "This quote is incomplete — we're fixing it and will email you when it is ready.",
    });
  }
  const requestedFrequency = requestedQuoteFrequency(
    booking.recurringPreference,
    stored.recurringOffer,
    Boolean(stored.planOnly)
  );
  return {
    bookingId: booking.id,
    decision: "PRICED" as const,
    service: quoteDisplayService(stored.serviceLabel, requestedFrequency),
    recurringOffer: stored.recurringOffer ?? null,
    requestedFrequency,
    planOnly: stored.planOnly || undefined,
    // Community/commercial checkouts may choose "Invoice me" (net terms)
    // instead of paying by card — derived from the stored property kind.
    invoiceEligible: invoiceEligibleFor(booking.propertyKind) || undefined,
    // GL-17: an off-season seasonal enrollment has NO first-visit day board —
    // billing starts now and April's exact day is confirmed by the office,
    // never invented here.
    offSeason: stored.offSeason || undefined,
    offSeasonMessage: stored.offSeason ? OFF_SEASON_MESSAGE : undefined,
    days: (stored.days ?? []).map(({ date, priceCents }) => ({
      date,
      priceCents,
    })),
    expiresAt: booking.expiresAt,
    terms: { version: BOOKING_TERMS_VERSION, text: BOOKING_TERMS_TEXT },
    // GL-05: the same customer token quoteStatus uses — the funnel carries it
    // to /booking-status so the post-payment outcome is server-confirmed and
    // durable across reloads/redirects.
    statusToken: booking.cancelToken ?? undefined,
  };
}

/**
 * Secure polling endpoint for the loading screen and the emailed resume link.
 * The token is the booking's existing high-entropy customer token; the
 * response never exposes the lead's contact details.
 */
/**
 * GL-05 — the truthful post-payment state, read (never assumed) by the funnel.
 * Authenticated like quoteStatus: bookingId + the cancel token. Pure read.
 * States:
 *   BOOKED     — the complete commitment exists (date/amount returned
 *                for the durable confirmation card).
 *   FINALIZING — payment reported succeeded/processing; the server has not yet
 *                confirmed the complete commitment.
 *   RECOVERY   — an owned PAID_NOT_FINALIZED case exists: the customer sees
 *                the safe next step and is never invited to pay again.
 *   PAYMENT_FAILED / CANCELED — their terminal truths.
 */
/**
 * "On My Way" public tracking. The opaque token from the customer's email
 * resolves to exactly one job; the response carries only what the live map
 * needs (the tech's current point, an ETA, their first name) and only while the
 * visit is genuinely en route. Pure status decision split out for testing.
 */
type TrackJobFields = {
  enRouteAt?: string | null;
  status: string;
  trackEndsAt?: string | null;
};
export function decideTrackStatus(
  job: TrackJobFields | null,
  nowIso: string
): "UNKNOWN" | "ARRIVED" | "ENDED" | "EN_ROUTE" {
  if (!job || !job.enRouteAt) return "UNKNOWN";
  // Any status past SCHEDULED means the tech arrived (IN_PROGRESS) or the visit
  // ended (completed / no-access / canceled) — either way, stop sharing.
  if (job.status !== "SCHEDULED") return "ARRIVED";
  if (job.trackEndsAt && job.trackEndsAt <= nowIso) return "ENDED";
  return "EN_ROUTE";
}

async function trackStatus(body: Record<string, unknown>) {
  const token =
    typeof body.token === "string" ? body.token.trim() : "";
  if (!token) return { status: "UNKNOWN" as const };
  const client = await dataClient();
  const { data } = await client.models.Job.listJobByTrackToken({
    trackToken: token,
  });
  const job = data?.[0] ?? null;
  const nowIso = new Date().toISOString();
  const status = decideTrackStatus(job, nowIso);
  if (!job || status !== "EN_ROUTE") return { status };

  const { data: customer } = await client.models.Customer.get({
    id: job.customerId,
  });
  const address = [
    customer?.serviceStreet,
    customer?.serviceCity,
    customer?.serviceState,
    customer?.serviceZip,
  ]
    .filter(Boolean)
    .join(", ");
  let techFirstName: string | null = null;
  if (job.technicianId) {
    const t = await client.models.Technician.get({ id: job.technicianId });
    techFirstName = t.data?.name?.trim().split(/\s+/)[0] ?? null;
  }
  let etaMinutes: number | null = null;
  if (job.trackLat != null && job.trackLng != null && address) {
    const key = await getSecret("GOOGLE_ROUTES_API_KEY");
    if (key) {
      etaMinutes = await driveMinutesFromPoint(
        key,
        { lat: job.trackLat, lng: job.trackLng },
        address
      );
    }
  }
  return {
    status: "EN_ROUTE" as const,
    lat: job.trackLat ?? null,
    lng: job.trackLng ?? null,
    updatedAt: job.trackAt ?? null,
    etaMinutes,
    techFirstName,
  };
}

async function bookingStatus(body: Record<string, unknown>) {
  const bookingId = String(body.bookingId ?? "");
  const statusToken = String(body.statusToken ?? "");
  if (!bookingId || !statusToken) {
    throw new HttpError(400, { error: "Missing booking token." });
  }
  const client = await dataClient();
  const { data: booking } = await client.models.BookingRequest.get({
    id: bookingId,
  });
  if (!booking || booking.cancelToken !== statusToken) {
    throw new HttpError(404, { error: "Booking not found." });
  }

  if (booking.status === "BOOKED") {
    return {
      bookingId,
      state: "BOOKED" as const,
      selectedDate: booking.selectedDate ?? null,
      amountCents: booking.amountCents ?? null,
      email: booking.email ?? null,
      recurring: Boolean(booking.recurring),
    };
  }
  if (booking.status === "CANCELED" || booking.status === "EXPIRED") {
    return { bookingId, state: "CANCELED" as const };
  }
  // GL-06: a pending bank debit that already created its commitment is a
  // scheduled visit with payment pending — a durable, truthful terminal
  // screen (the customer is told not to pay again and what happens next).
  if (booking.status === "PROCESSING") {
    return {
      bookingId,
      state: booking.jobId
        ? ("PROCESSING_SCHEDULED" as const)
        : ("PROCESSING" as const),
      selectedDate: booking.selectedDate ?? null,
      amountCents: booking.amountCents ?? null,
      methodLabel:
        (booking as { processingMethodLabel?: string | null })
          .processingMethodLabel ?? null,
      expectedBy:
        (booking as { processingExpectedBy?: string | null })
          .processingExpectedBy ?? null,
      email: booking.email ?? null,
    };
  }
  // PROCESSING already returned above, so any remaining failure reason means
  // the attempt genuinely failed (or its reset didn't finish) — say so.
  if (booking.paymentFailedReason) {
    return {
      bookingId,
      state: "PAYMENT_FAILED" as const,
      reason: booking.paymentFailedReason,
    };
  }

  // An owned recovery case for this booking means finalization needs a human —
  // tell the customer the safe truth instead of spinning forever.
  try {
    if ("WorkItem" in client.models) {
      const { data: item } = await client.models.WorkItem.get({
        id: workItemId("PAID_NOT_FINALIZED", bookingId),
      });
      if (item && item.status === "OPEN") {
        return {
          bookingId,
          state: "RECOVERY" as const,
          message:
            "Your payment went through and your booking is being completed by our team. You will not be charged twice — we'll confirm by email shortly. Questions? Reply to any BuzzKill email or call the office.",
        };
      }
    }
  } catch (err) {
    console.error("bookingStatus: recovery check failed", bookingId, err);
  }

  return { bookingId, state: "FINALIZING" as const };
}

async function quoteStatus(
  body: Record<string, unknown>,
  sourceIp: string
) {
  const bookingId = String(body.bookingId ?? "");
  const statusToken = String(body.statusToken ?? "");
  if (!bookingId || !statusToken) {
    throw new HttpError(400, { error: "Missing quote request token." });
  }

  const client = await dataClient();
  const { data: booking } = await client.models.BookingRequest.get({
    id: bookingId,
  });
  if (!booking || booking.cancelToken !== statusToken) {
    throw new HttpError(404, { error: "Quote request not found." });
  }

  if (booking.status === "QUOTED") return pricedResponse(booking);
  if (booking.status === "CONTACT") {
    return {
      bookingId: booking.id,
      decision: "CONTACT" as const,
      message:
        parseStoredQuote(booking.quoteJson).contactMessage ??
        "A specialist is reviewing your request and will contact you shortly.",
    };
  }
  // GL-06: a returning customer's poll retrieves the durable payment state —
  // never a dead-end error that invites a second payment.
  if (booking.status === "PROCESSING") {
    return {
      bookingId: booking.id,
      decision: "PROCESSING" as const,
      selectedDate: booking.selectedDate ?? null,
      amountCents: booking.amountCents ?? null,
      message: booking.jobId
        ? `Your payment is still processing and your visit${booking.selectedDate ? ` on ${booking.selectedDate}` : ""} is scheduled — please don't pay again. We'll email you the moment it clears.`
        : "Your payment is still processing — please don't pay again. We'll email your confirmation as soon as it clears.",
    };
  }
  if (booking.status === "BOOKED") {
    return {
      bookingId: booking.id,
      decision: "BOOKED" as const,
      selectedDate: booking.selectedDate ?? null,
      message:
        "This booking is paid and confirmed — the details are in your confirmation email.",
    };
  }
  if (booking.status === "PAYMENT_FAILED") {
    return {
      bookingId: booking.id,
      decision: "PAYMENT_FAILED" as const,
      reason: booking.paymentFailedReason ?? null,
      message:
        "Your payment didn't go through, so the booking was not completed. You can request a fresh quote and try again, or reply to our email and we'll help.",
    };
  }
  if (booking.status !== "PENDING") {
    throw new HttpError(409, {
      error: "This quote request is no longer awaiting pricing.",
    });
  }

  return quote(
    {
      propertyKind: booking.propertyKind ?? undefined,
      name: booking.name,
      email: booking.email,
      phone: booking.phone ?? undefined,
      address: {
        street: booking.street ?? undefined,
        city: booking.city ?? undefined,
        state: booking.state ?? undefined,
        zip: booking.zip ?? undefined,
      },
      units: booking.units ?? undefined,
      service: booking.service ?? undefined,
      sqft: booking.sqft ?? undefined,
      nestCount: booking.nestCount ?? undefined,
      removalKind: booking.removalKind ?? undefined,
      removalCount: booking.removalCount ?? undefined,
      comments: booking.comments ?? undefined,
      recurringPreference: booking.recurringPreference ?? undefined,
      attribution: booking.attribution,
    },
    sourceIp,
    { bookingId, statusToken }
  );
}

// ---------------------------------------------------------------- /quote

/**
 * Layered abuse control for the unauthenticated endpoint: an optional bot
 * token (enforced as soon as TURNSTILE_SECRET is configured) and a
 * best-effort per-IP hourly cap. The live path is pure reads now — AI
 * research runs only inside the demand worker, behind its own
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

type ResumeQuote = { bookingId: string; statusToken: string };

/**
 * Wake the pricing worker for this exact cold-cache miss. Invocation is
 * asynchronous: /quote returns the durable PENDING request immediately and
 * the browser polls /quote-status. The five-minute schedule is still the
 * recovery path if this best-effort wake-up fails.
 */
async function triggerPricingRefresh(rateKey: string): Promise<void> {
  const functionName = process.env.PRICING_REFRESH_FUNCTION_NAME;
  if (!functionName) {
    console.error(
      "quote pending: PRICING_REFRESH_FUNCTION_NAME is not configured; scheduled recovery will pick it up",
      rateKey
    );
    return;
  }
  try {
    await lambda.send(
      new InvokeCommand({
        FunctionName: functionName,
        InvocationType: "Event",
        Payload: Buffer.from(JSON.stringify({ rateKey, source: "quote" })),
      })
    );
  } catch (err) {
    console.error(
      "quote pending: immediate pricing wake-up failed; scheduled recovery will pick it up",
      rateKey,
      err
    );
  }
}

/**
 * The customer id a booking link's ?lead=<token> names, or null. Untrusted
 * input: shape-checked before any table hit, resolved via the
 * bookingLinkToken index, refused when it somehow matches more than one
 * record, and never allowed to fail the quote — lead identity is an
 * upgrade over email matching, not a gate.
 */
async function resolveLeadToken(
  // `client` is `any` on purpose: the generated result type of the index query
  // below is deep enough that instantiating it trips TypeScript's depth ceiling
  // (TS2321) on unrelated edits. The result is cast to the shallow shape this
  // function actually reads. See the same note in shared/bookingLink.ts.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  raw: unknown
): Promise<string | null> {
  if (typeof raw !== "string" || !BOOKING_LINK_TOKEN_RE.test(raw)) return null;
  try {
    const { data } = (await client.models.Customer.listCustomerByBookingLinkToken(
      { bookingLinkToken: raw },
      { limit: 2 }
    )) as {
      data: { id: string; bookingLinkTokenExpiresAt?: string | null }[];
    };
    const lead = data.length === 1 ? data[0] : null;
    return lead?.bookingLinkTokenExpiresAt &&
      Date.parse(lead.bookingLinkTokenExpiresAt) > Date.now()
      ? lead.id
      : null;
  } catch (err) {
    console.error("resolveLeadToken: lookup failed — quoting without identity", err);
    return null;
  }
}

/**
 * Staff-assisted quoting uses the same public funnel as a customer. The
 * unguessable lead token is the only lookup key and this endpoint returns the
 * smallest useful subset of the CRM record: contact and service address. It
 * never returns notes, source, consent, lifecycle, pricing, or customer data.
 */
async function leadPrefill(body: Record<string, unknown>) {
  const token = body.leadToken;
  if (typeof token !== "string" || !BOOKING_LINK_TOKEN_RE.test(token)) {
    throw new HttpError(404, { error: "Lead details are unavailable." });
  }
  const client = await dataClient();
  const { data } = await client.models.Customer.listCustomerByBookingLinkToken(
    { bookingLinkToken: token },
    { limit: 2 }
  );
  const lead = data.length === 1 ? data[0] : null;
  if (
    !lead ||
    lead.status !== "LEAD" ||
    !lead.bookingLinkTokenExpiresAt ||
    Date.parse(lead.bookingLinkTokenExpiresAt) <= Date.now() ||
    lead.doNotContact === true ||
    Boolean(lead.lostReason)
  ) {
    throw new HttpError(404, { error: "Lead details are unavailable." });
  }
  return {
    name: lead.contactName?.trim() || lead.displayName,
    email: lead.email ?? "",
    phone: lead.phone ?? "",
    address: {
      street: lead.serviceStreet ?? "",
      city: lead.serviceCity ?? "",
      state: lead.serviceState ?? "",
      zip: lead.serviceZip ?? "",
    },
  };
}

/** The lead's origin, in the same "Website · …" shape lead-intake stores. */
function quoteLeadSource(attribution: Attribution | null): string {
  const utm = attribution?.source?.trim();
  return ["Website", "quote", utm ? `utm:${utm}` : undefined]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Everything the visitor told the funnel that has no first-class Customer
 * column, kept verbatim for the office, mirroring lead-intake's note block.
 */
function quoteLeadNotes(
  input: QuoteInput,
  service: string,
  propertyKind: string,
  attribution: Attribution | null
): string {
  const lines: string[] = [];
  const add = (label: string, v: unknown) => {
    const t = String(v ?? "").trim();
    if (t) lines.push(`${label}: ${t}`);
  };
  add("Service requested", service);
  add("Property type", propertyKind);
  // Say it plainly: the price on this lead came off the residential sheet, not
  // the per-unit common-area sheet, and staff must not "correct" it.
  if (input.inUnit && propertyKind === "COMMUNITY") {
    add("In-unit service", "Yes — quoted as a residential visit, not common area");
  }
  add("Square footage", input.sqft);
  add("Units", input.units);
  add("Nests", input.nestCount);
  add("Wildlife — what needs removed", input.removalKind);
  add("Wildlife — how many", input.removalCount);
  add("Yard size (½ acres)", input.lotHalfAcres);
  add("Recurring preference", input.recurringPreference);
  add("Comments", input.comments?.slice(0, 2000));
  if (attribution) {
    add("Campaign", attribution.campaign);
    add("Medium", attribution.medium);
    add("Term", attribution.term);
    add("Content", attribution.content);
    add("Google click id", attribution.gclid);
    add("Landing page", attribution.landingPage);
    add("Referrer", attribution.referrer);
  }
  lines.push(
    input.callConsent === true
      ? "Consent: call permission granted for this quote; email always permitted"
      : "Consent: email response only — no call or text permission granted"
  );
  return lines.join("\n");
}

async function quote(
  input: QuoteInput,
  sourceIp: string,
  resume?: ResumeQuote,
  // Trusted internal invoke (portal add-service): the quote is bound directly
  // to this existing customer, so finalization attaches the new visit/plan to
  // them and no new website lead is minted.
  trusted?: { customerId: string }
) {
  const errors: Record<string, string> = {};
  const name = (input.name ?? "").trim();
  const email = (input.email ?? "").trim().toLowerCase();
  const service = (input.service ?? "").toUpperCase();
  const propertyKind = (input.propertyKind ?? "RESIDENTIAL").toUpperCase();
  // An IN-UNIT request at a condo/HOA is one apartment treated on its own — not
  // a common-area program priced per unit across the whole association — so it
  // is quoted exactly like a residential visit: sqft in, residential sheet out,
  // one residential on-site duration.
  //
  // Only the PRICING VIEW changes. The stored propertyKind stays COMMUNITY, so
  // the property is still known to be an association for routing, reporting and
  // invoice eligibility (the HOA is still the payer). The flag is meaningless
  // anywhere else, so it is only honoured at a community.
  const inUnit = propertyKind === "COMMUNITY" && input.inUnit === true;
  const pricingKind = inUnit ? "RESIDENTIAL" : propertyKind;
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
  if (SEASONAL_SERVICES.has(service)) {
    // GL-17: mosquito plans price on yard size alone (half-acres), at any
    // property kind — no sqft, nest, or unit inputs.
  } else if (service === "WASP_NEST") {
    // Nest removal prices by the number of nests at every property class —
    // the service sets the price, so no sqft/units is collected.
    if (!input.nestCount || input.nestCount < 1) {
      errors.nestCount = "How many nests need removal?";
    }
  } else if (service === "WILDLIFE") {
    // Wildlife prices by what needs removed and how many, at every property
    // class — the animal count sets the price, so no sqft/units is collected.
    if (!input.removalKind || !input.removalKind.trim()) {
      errors.removalKind = "What needs to be removed?";
    }
    if (!input.removalCount || input.removalCount < 1) {
      errors.removalCount = "How many animals need removal?";
    }
  } else if (pricingKind === "COMMUNITY") {
    // A community asks for a common-area plan, priced per unit — the unit
    // count is the price input, so it is required.
    if (!input.units || input.units < 1) {
      errors.units = "How many units are in the community? The unit count sets the plan price.";
    }
  } else if (pricingKind === "COMMERCIAL") {
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
  }
  if (SEASONAL_SERVICES.has(service)) {
    // GL-17: the yard size IS the price input — an omitted value is never
    // silently priced as half an acre.
    if (input.lotHalfAcres == null) {
      errors.lotHalfAcres = "Yard size is required for mosquito plans";
    } else if (input.lotHalfAcres < 1 || input.lotHalfAcres > 8) {
      errors.lotHalfAcres = "Yard size must be between ½ acre and 4 acres";
    }
  }
  if (Object.keys(errors).length) throw new HttpError(400, { errors });

  // The original public submission carries the bot check and spend throttle.
  // A token-authenticated status poll resumes the already-accepted request;
  // charging every poll against the IP cap would lock a real lead out before
  // their rate finishes.
  if (!resume) {
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
  }

  const client = await dataClient();
  let resumedBooking: StoredQuoteBooking | null = null;
  if (resume) {
    const { data: existing } = await client.models.BookingRequest.get({
      id: resume.bookingId,
    });
    if (!existing || existing.cancelToken !== resume.statusToken) {
      throw new HttpError(404, { error: "Quote request not found." });
    }
    if (existing.status === "QUOTED") {
      return pricedResponse(existing);
    }
    if (existing.status !== "PENDING") {
      throw new HttpError(409, {
        error: "This quote request is no longer waiting for pricing.",
      });
    }
    resumedBooking = existing;
  }
  const address = `${addr.street}, ${addr.city}, ${addr.state}${addr.zip ? ` ${addr.zip}` : ""}`;
  // First-touch ad attribution rides along on every booking this quote
  // creates, so finalization can derive the customer's lead source. Malformed
  // input sanitizes to null and the quote proceeds without it.
  const attribution = sanitizeAttribution(input.attribution);
  // The booking link's lead identity, resolved to a customer id server-side.
  // Untrusted input: shape-checked, looked up by index, silently dropped when
  // it doesn't resolve — a stale or mangled token must never block a quote,
  // and the response never confirms whether it matched anything.
  let leadCustomerId =
    trusted?.customerId ?? (await resolveLeadToken(client, input.leadToken));

  // A quote is a lead the moment it's requested. A visitor who arrived without
  // an office booking link has no CRM record yet, so durably capture them now —
  // the office should chase a priced quote nobody booked. The new lead id rides
  // onto the BookingRequest below (base.leadCustomerId), so a later paid
  // finalization converts this exact record. Only the original submission mints
  // a lead; a token-authenticated status poll (resume) reuses the one already
  // stamped on the pending request. Failure returns null and never withholds
  // the quote.
  if (!leadCustomerId && !resume) {
    leadCustomerId = await recordWebsiteQuoteLead({
      name,
      email,
      phone,
      street: addr.street ?? null,
      city: addr.city ?? null,
      state: addr.state ?? null,
      zip: addr.zip ?? null,
      callConsent: input.callConsent === true,
      leadSource: quoteLeadSource(attribution),
      notes: quoteLeadNotes(input, service, propertyKind, attribution),
    });
  }

  const makeBooking = async (fields: Record<string, unknown>) => {
    const base = {
        name,
        email,
        phone: phone ?? undefined,
        street: addr.street!.trim(),
        city: addr.city!.trim(),
        state: addr.state!.trim().toUpperCase(),
        zip: addr.zip?.trim() || undefined,
        propertyKind: propertyKind as "RESIDENTIAL" | "COMMUNITY" | "COMMERCIAL",
        inUnit: inUnit || undefined,
        service: service as
          | "GENERAL_PEST"
          | "WASP_NEST"
          | "RODENT"
          | "ROACH"
          | "TERMITE"
          | "WILDLIFE"
          | "MOSQUITO"
          | "MOSQUITO_TICK",
        units: input.units ?? undefined,
        lotHalfAcres: SEASONAL_SERVICES.has(service)
          ? Math.ceil(input.lotHalfAcres!)
          : undefined,
        sqft: input.sqft ?? undefined,
        nestCount: input.nestCount ?? undefined,
        removalKind: input.removalKind?.trim() || undefined,
        removalCount: input.removalCount ?? undefined,
        comments: input.comments?.slice(0, 2000) || undefined,
        recurringPreference: input.recurringPreference ?? undefined,
        attribution: attribution ? JSON.stringify(attribution) : undefined,
        leadCustomerId: leadCustomerId ?? undefined,
        ...fields,
    };
    const { data: booking, errors: gqlErrors } = resume
      ? await client.models.BookingRequest.update({
          id: resume.bookingId,
          ...base,
        })
      : await client.models.BookingRequest.create({
          ...base,
          cancelToken: randomUUID(),
        });
    if (!booking) {
      throw new Error(gqlErrors?.[0]?.message ?? "Could not store the request");
    }
    // The quote form submission — whether it advances an office-link lead or
    // the one this request just created — logs its pipeline touch only after
    // the durable request exists; lifecycle recovery owns a partial failure
    // without withholding the quote.
    if (!resume && leadCustomerId) {
      await recordWebsiteQuoteRequested({
        customerId: leadCustomerId,
        bookingRequestId: booking.id,
      });
    }
    return booking;
  };

  // GL-03: a review fallback must promise a channel it can actually keep. A call
  // is promised only when the lead gave a valid phone AND consent to be called;
  // otherwise the promise is an email (the funnel always has a valid email). The
  // timing is the ONE approved commitment — one business day — from every
  // entrance, with the concrete day named.
  const canCall = Boolean(phone) && input.callConsent === true;
  const contact = async (
    situation: string,
    goal = "",
    extra: Record<string, unknown> = {},
    opsNote = "",
    existingBookingId?: string,
    // A staff-facing, plain-English reason this couldn't auto-quote and book.
    // Lands on the callback work item, the sales email, AND the lead's own
    // audit — so whoever picks it up knows why without re-deriving it. Falls
    // back to the customer-facing situation when a caller doesn't pass one.
    staffReason = ""
  ) => {
    const reason = staffReason || situation;
    const now = new Date();
    const timing = nextContactPhrase(now);
    const goalClause = goal ? ` ${goal}` : "";
    const promise = canCall
      ? `a specialist will call you ${timing}${goalClause}`
      : `we'll email you at ${email} ${timing}${goalClause}`;
    const message = `${situation}, so ${promise}.`;
    const channelWord = canCall ? "call" : "email";

    const contactFields = {
      status: "CONTACT",
      callConsent: input.callConsent === true,
      callConsentTextVersion:
        input.callConsent === true
          ? (input.callConsentTextVersion?.slice(0, 40) ??
            CALL_CONSENT_TEXT_VERSION)
          : undefined,
      quoteJson: JSON.stringify({ contactMessage: message }),
      ...extra,
    } as const;
    const booking = existingBookingId
      ? (
          await client.models.BookingRequest.update({
            id: existingBookingId,
            ...contactFields,
          })
        ).data
      : await makeBooking(contactFields);
    if (!booking) {
      throw new HttpError(503, {
        error:
          "We saved your request, but couldn't confirm its follow-up status. Please try again in a moment or call the office.",
      });
    }
    const opened = await openOwnedWork({
      kind: "CALLBACK_PROMISE",
      dedupeKey: booking.id,
      title: `Website ${channelWord} promised: ${name}`,
      detail: `${name} was promised a ${channelWord} ${timing} about ${service.toLowerCase().replace("_", " ")} at ${address}. Why manual: ${reason} ${opsNote.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()}`.trim(),
      relatedId: booking.id,
      sourceUrl: "/work",
      // Closure-aware: a holiday between now and the deadline pushes it out.
      dueAt: (await oneBusinessDayDeadline(now)).toISOString(),
      resolutionAction: canCall
        ? "Call the lead by the promised time, record the outcome, and send the correct booking or referral next step."
        : "Email the lead their options by the promised time, record the outcome, and send the correct booking or referral next step.",
      ownerTeam: "SALES",
    });
    if (!opened) {
      // GL-03: the promise may not be RETURNED unless someone owns keeping
      // it. The CONTACT row stays (the daily sweep rebuilds its owned action
      // with the deadline anchored to THIS moment), but the customer hears
      // the truth instead of a promise nobody is holding yet.
      throw new HttpError(503, {
        error:
          "We saved your request, but our follow-up queue didn't confirm it. Please try again in a moment — or call the office and we'll take it from there.",
      });
    }
    await notifyLeads({
      subject: `Website lead needs ${canCall ? "a call" : "an email"}`,
      heading: `Website lead needs ${canCall ? "a call" : "an email"}`,
      template: "ops-booking-contact",
      relatedId: booking.id,
      bodyHtml: `<p><strong>${escapeHtml(name)}</strong> (${escapeHtml(email)}${input.phone ? `, ${escapeHtml(input.phone)}` : ""}) asked about <strong>${service.toLowerCase().replace("_", " ")}</strong> at ${escapeHtml(address)}.</p>
       <p><strong>Why this couldn't auto-quote:</strong> ${escapeHtml(reason)}</p>
       <p>Promised to be reached by <strong>${escapeHtml(channelWord)}</strong> ${escapeHtml(timing)}.${canCall ? "" : " No phone/consent on file, so this is an email follow-up."}</p>
       ${input.comments ? `<p>Comments: ${escapeHtml(input.comments)}</p>` : ""}
       ${attribution?.source ? `<p>Lead source: utm:${escapeHtml(attribution.source)}${attribution.campaign ? ` · campaign:${escapeHtml(attribution.campaign)}` : ""}</p>` : ""}
       <p>Booking request ${booking.id}.</p>
       ${opsNote}`,
    });
    // Stamp the reason on the lead record itself — the office opens the lead
    // before the work queue, and a generic "complete the next follow-up" with
    // no reason is exactly the gap this closes. Best-effort; the promise is
    // already durably owned above.
    if (leadCustomerId) {
      await recordFunnelContactOutcome({
        customerId: leadCustomerId,
        bookingRequestId: booking.id,
        reason,
      });
    }
    return { bookingId: booking.id, decision: "CONTACT", message };
  };

  // Zone from live drive time.
  const routesKey = await getSecret("GOOGLE_ROUTES_API_KEY");
  const storedZone = resumedBooking?.zone;
  const hasStoredZone = ["A", "B", "C", "OUT", "UNKNOWN"].includes(
    storedZone ?? ""
  );
  // The office issued this quote (the lead-specific "Open prefilled website
  // quote" link carries a lead token). Only then may a far, out-of-area address
  // be priced — with the fixed Zone C travel add-on — instead of bouncing to a
  // callback. A public visitor never gets here for OUT.
  const officeQuote = Boolean(input.leadToken);
  // Zone is measured from the CLOSEST technician's home base, not a fixed HQ.
  // There is no company HQ: every technician starts and ends the day at their
  // own home, so a customer is only genuinely out of area when they are far
  // from every base. Measuring from one hard-coded point priced the travel
  // adder off a location no truck departs from, and bounced addresses that a
  // technician lives minutes away from. A null roster read means "unknown",
  // which falls through to the callback path below — never a refusal.
  const techBases = hasStoredZone || !routesKey ? null : await activeTechBases();
  const minutes = hasStoredZone
    ? (resumedBooking?.driveMinutes ?? null)
    : routesKey && techBases
      ? await driveMinutesFromNearestBase(routesKey, techBases, address)
      : null;
  const zone: Zone = hasStoredZone
    ? (storedZone as Zone)
    : minutes == null
      ? "UNKNOWN"
      : zoneFromMinutes(minutes);
  if (zone === "OUT" && !officeQuote) {
    return contact(
      "You're a bit outside our standard service area",
      "to see what we can do",
      { zone, driveMinutes: minutes ?? undefined },
      "",
      undefined,
      `Outside the standard service area: Google Routes put this address at ${
        minutes != null ? `~${minutes} min` : "over 90 min"
      } from the CLOSEST technician's home base${
        techBases ? ` (${techBases.length} base${techBases.length === 1 ? "" : "s"} checked)` : ""
      }, past our 90-minute limit (Zone A ≤50 min, Zone B ≤90 min). If you want to service it, open "Quote this lead" — a prefilled quote applies the Zone C far-travel add-on (${money(
        ZONE_C.ONE_TIME_FLAT
      )} one-time / ${money(
        ZONE_C.MONTHLY
      )} per month) and sends them a bookable link. Otherwise refer it out or decline.`
    );
  }
  if (zone === "UNKNOWN") {
    // R59: no zone, no price. A Routes outage or an expired key used to
    // silently reprice the whole funnel as Zone B; route the lead to the
    // callback path instead and tell the office why. Zone now also depends on
    // the technician roster, so an unreadable roster or a roster with no base
    // configured gets its OWN diagnosis — otherwise a misconfigured base would
    // masquerade as a Routes outage and every quote would quietly become a
    // callback with nobody knowing which knob to turn.
    const cause = !routesKey
      ? "the Routes API key isn't configured"
      : !techBases
        ? "no active technician has a home base configured (or the roster could not be read), so there is no origin to measure the service area from"
        : "Routes API returned no route from any technician base — outage or an address that won't geocode";
    return contact(
      "We just need to double-check your address against our service area",
      "with your exact price",
      { zone },
      `<p style="color:#b91c1c;"><strong>Drive-time zone lookup failed for this address</strong> (${cause}). Zone pricing is unavailable, so this quote fell back to a callback. ${
        routesKey && !techBases
          ? "Set each active technician's base under Technicians in the CRM."
          : "If this keeps happening, check the Google Routes API key."
      }</p>`,
      undefined,
      `Drive-time zone lookup failed (${cause}), so the funnel couldn't determine a price. ${
        routesKey && !techBases
          ? "Fix this in Technicians — every active technician needs a home base; it is the origin the whole service area is measured from."
          : "Verify the address, then quote by hand or on the office board."
      }`
    );
  }
  // An office-issued OUT quote prices as Zone C (fixed far-travel add-on); the
  // public OUT path already returned a callback above, so this only promotes
  // office quotes.
  const priceZone: Zone = zone === "OUT" ? "C" : zone;

  // AI base price. Every service prices from the cached market-rate sheet —
  // a PURE READ. The live path never researches: getCachedRate serves the
  // freshest usable row (a stale sheet still serves — staleness beats a
  // callback; pinned office rows serve forever), and only a combo without a
  // usable requested price comes back null. On null we queue the research on
  // the RateCoverage ledger, wake the refresh worker immediately, and retain
  // the five-minute schedule as recovery. The worker emails the lead a secure
  // resume link when the price is ready. Never a made-up number. The
  // deterministic overlay stays on top of the AI base: the Zone B adders
  // here, then day pricing / capacity / the R62 cost floor below.
  const contactForPrice = async (
    engineService: MarketRateService,
    sqft?: number,
    requestReason: "MISSING_RATE_SHEET" | "INCOMPLETE_RATE_SHEET" =
      "MISSING_RATE_SHEET",
    pinned = false
  ) => {
    const booking =
      resume && resumedBooking
        ? resumedBooking
        : await makeBooking({
            status: "PENDING",
            zone: priceZone,
            driveMinutes: minutes ?? undefined,
          });
    const rateKey = rateKeyFor(
      engineService,
      areaKeyFor(addr.city!, addr.state!),
      sqft != null ? sqftBucket(sqft) : null
    );
    if (pinned) {
      return {
        bookingId: booking.id,
        decision: "ERROR",
        message:
          "We couldn't complete this exact price automatically. Please start a fresh quote in a moment.",
      };
    }
    // A status poll is read-only while the durable worker owns the request.
    // Re-enqueueing here used to reset exhausted demand and could turn one
    // browser left open into an unbounded stream of paid AI retries.
    if (resume) {
      const { data: coverage } = await client.models.RateCoverage.get({
        id: rateKey,
      });
      if (coverage?.exhaustedAt) {
        return {
          bookingId: booking.id,
          decision: "ERROR",
          message:
            "AI couldn't complete a reliable exact price after several attempts. Please start a fresh quote to try again.",
        };
      }
      return {
        bookingId: booking.id,
        statusToken: booking.cancelToken,
        decision: "PENDING",
        stage: "RESEARCHING",
        message:
          "We're building your exact price and checking available appointment times now.",
      };
    }
    const queued = await enqueueRateResearch({
      service: engineService,
      city: addr.city!,
      state: addr.state!,
      sqft,
      notifyEmail: email,
      bookingRequestId: booking.id,
      requestedBy: "PUBLIC_QUOTE",
      requestReason,
    });
    if (!queued) {
      return {
        bookingId: booking.id,
        decision: "ERROR",
        message:
          "We couldn't start the automated price research safely. Please submit a fresh quote in a moment.",
      };
    }
    // Wake the worker immediately. No sales escalation is created: the AI
    // owns this ordinary pricing state and the customer gets the secure ready
    // email if they leave the live screen.
    await triggerPricingRefresh(rateKey);
    return {
      bookingId: booking.id,
      statusToken: booking.cancelToken,
      decision: "PENDING",
      stage: "RESEARCHING",
      message:
        "We're building your exact price and checking available appointment times now.",
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

  if (SEASONAL_SERVICES.has(service)) {
    // GL-17: the seasonal mosquito plans — DETERMINISTIC rate card, never
    // the AI researcher. Plan-only: billed monthly year-round, one treatment
    // per April–October month; the day board picks the FIRST treatment and
    // the price never varies by day. Zone B travel is priced inside the card.
    const halfAcres = Math.ceil(input.lotHalfAcres!); // validated required
    const card = priceMosquito({
      tick: service === "MOSQUITO_TICK",
      halfAcres,
      zone: priceZone,
    });
    const monthly = card.monthlyCents!;
    baseCents = monthly;
    planOnly = true;
    serviceLabel = `${serviceLabelFor(service as "MOSQUITO" | "MOSQUITO_TICK")}${
      halfAcres > 1 ? ` — up to ${halfAcres / 2} acre${halfAcres > 2 ? "s" : ""}` : ""
    }`;
    recurringOffer = {
      // Locked rule: mosquito plans bill MONTHLY year-round — the cadence
      // preference does not apply here.
      frequency: "MONTHLY",
      monthlyCents: monthly,
      // Charged at booking: the first month's total, like every plan the
      // funnel sells. Billing then continues monthly year-round.
      initialFeeCents: monthly,
    };
  } else if (service === "WASP_NEST") {
    // Nest removal prices by nest count at EVERY property class — a one-time
    // visit from the WASP sheet (base + per-extra-nest), never per unit/sqft.
    const rate = await getCachedRate({
      service: "WASP_NEST",
      city: addr.city!,
      state: addr.state!,
    });
    const extraNests = (input.nestCount ?? 1) - 1;
    // The sheet must actually price what was asked: a multi-nest job with
    // no extra-nest component on the sheet is an unpriceable request.
    if (!rate || (extraNests > 0 && rate.sheet.extraNestCents == null)) {
      return contactForPrice(
        "WASP_NEST",
        undefined,
        rate ? "INCOMPLETE_RATE_SHEET" : "MISSING_RATE_SHEET",
        Boolean(rate?.pinned)
      );
    }
    baseCents =
      rate.priceCents + extraNests * (rate.sheet.extraNestCents ?? 0);
    baseCents += travelAdderCents(priceZone, "ONE_TIME_FLAT");
    serviceLabel = serviceLabelFor("WASP_NEST", {
      nestCount: input.nestCount ?? 1,
    });
  } else if (service === "WILDLIFE") {
    // Wildlife prices by animal count at EVERY property class — a one-time
    // exclusion/removal visit from the WILDLIFE sheet (base + per-extra-
    // animal), never per unit/sqft. The animal type rides along on the label.
    const rate = await getCachedRate({
      service: "WILDLIFE",
      city: addr.city!,
      state: addr.state!,
    });
    const count = input.removalCount ?? 1;
    const extraAnimals = count - 1;
    // A multi-animal job with no extra-animal component on the sheet is an
    // unpriceable request — send it to the honest research/contact path.
    if (!rate || (extraAnimals > 0 && rate.sheet.extraAnimalCents == null)) {
      return contactForPrice(
        "WILDLIFE",
        undefined,
        rate ? "INCOMPLETE_RATE_SHEET" : "MISSING_RATE_SHEET",
        Boolean(rate?.pinned)
      );
    }
    baseCents =
      rate.priceCents + extraAnimals * (rate.sheet.extraAnimalCents ?? 0);
    baseCents += travelAdderCents(priceZone, "ONE_TIME_FLAT");
    serviceLabel = serviceLabelFor("WILDLIFE", {
      removalKind: input.removalKind,
      removalCount: count,
    });
  } else if (pricingKind === "COMMUNITY") {
    // A common-area quote at a community: the HOA per-unit sheet prices the
    // recurring plan (per-unit monthly × units for the chosen cadence), and a
    // one-time visit is DERIVED from the same sheet (hoaOneTimePerUnitCents).
    // The community may now book EITHER — the funnel offers one-time + plan
    // exactly like residential general pest and commercial.
    const rate = await getCachedRate({
      service: "HOA",
      city: addr.city!,
      state: addr.state!,
    });
    const hoa = rate?.sheet.hoaPerUnitMonthly;
    if (!hoa)
      return contactForPrice(
        "HOA",
        undefined,
        rate ? "INCOMPLETE_RATE_SHEET" : "MISSING_RATE_SHEET",
        Boolean(rate?.pinned)
      );
    const units = input.units!;
    const perUnit = hoa[hoaBandFor(units)][freq];
    let monthly = perUnit * units;
    // R60: the same deterministic Zone B travel adder every plan carries.
    monthly += travelAdderCents(priceZone, freq);
    serviceLabel = serviceLabelFor("HOA_COMMON_AREA", { units });
    recurringOffer = {
      frequency: freq,
      monthlyCents: monthly,
      // Charged at booking: the first month's total. The subscription
      // starts after the first completed visit, like every other plan.
      initialFeeCents: monthly,
    };
    // The one-time common-area visit: per-unit one-time × units, plus the same
    // one-time travel flat every other one-time price carries. planOnly stays
    // false — the customer chooses one-time or the plan, and the day board
    // shows the one-time price per day like every non-plan-only quote.
    baseCents =
      hoaOneTimePerUnitCents(hoa, units) * units +
      travelAdderCents(priceZone, "ONE_TIME_FLAT");
  } else if (pricingKind === "COMMERCIAL") {
    // Commercial prices like residential general pest — one-time day-priced
    // plus a plan offer — but from the COMMERCIAL sheet for this sqft band.
    const rate = await getCachedRate({
      service: "COMMERCIAL",
      city: addr.city!,
      state: addr.state!,
      sqft: input.sqft!,
    });
    const plan = rate?.sheet.plans?.[freq];
    if (!rate || !plan)
      return contactForPrice(
        "COMMERCIAL",
        input.sqft!,
        rate ? "INCOMPLETE_RATE_SHEET" : "MISSING_RATE_SHEET",
        Boolean(rate?.pinned)
      );
    baseCents = rate.priceCents;
    serviceLabel = serviceLabelFor("COMMERCIAL_PEST", {
      sqftBucket: sqftBucket(input.sqft!),
    });
    baseCents += travelAdderCents(priceZone, "ONE_TIME_FLAT");
    recurringOffer = {
      frequency: freq,
      monthlyCents:
        plan.monthlyCents + travelAdderCents(priceZone, freq),
      initialFeeCents:
        plan.initialFeeCents + travelAdderCents(priceZone, "ONE_TIME_FLAT"),
    };
  } else if (service === "GENERAL_PEST") {
    const rate = await getCachedRate({
      service: "GENERAL_PEST",
      city: addr.city!,
      state: addr.state!,
      sqft: input.sqft!,
    });
    const plan = rate?.sheet.plans?.[freq];
    if (!rate || !plan)
      return contactForPrice(
        "GENERAL_PEST",
        input.sqft!,
        rate ? "INCOMPLETE_RATE_SHEET" : "MISSING_RATE_SHEET",
        Boolean(rate?.pinned)
      );
    baseCents = rate.priceCents;
    serviceLabel = serviceLabelFor("GENERAL_PEST");
    // R60: the same deterministic Zone B travel adders the rate cards
    // carried — an 89-minute drive must not price like a 10-minute one.
    baseCents += travelAdderCents(priceZone, "ONE_TIME_FLAT");
    recurringOffer = {
      frequency: freq,
      monthlyCents:
        plan.monthlyCents + travelAdderCents(priceZone, freq),
      initialFeeCents:
        plan.initialFeeCents + travelAdderCents(priceZone, "ONE_TIME_FLAT"),
    };
  } else {
    // RODENT / ROACH / TERMITE — one-time treatments priced from their
    // sqft-banded sheets. (WASP_NEST and WILDLIFE are priced above, by count.)
    const engineService = service as "RODENT" | "ROACH" | "TERMITE";
    const rate = await getCachedRate({
      service: engineService,
      city: addr.city!,
      state: addr.state!,
      sqft: input.sqft!,
    });
    if (!rate) return contactForPrice(engineService, input.sqft!);
    baseCents = rate.priceCents;
    baseCents += travelAdderCents(priceZone, "ONE_TIME_FLAT");
    // GL-01: the label is the catalog's, not a local map.
    serviceLabel = serviceLabelFor(engineService, {
      sqftBucket: sqftBucket(input.sqft!),
    });
    // Rodent also sells an ongoing quarterly program. It is OPTIONAL here on
    // purpose: unlike general pest, a missing plan must not refuse the quote —
    // the one-time treatment is still a complete, sellable answer, and rodent
    // sheets cached before the program was priced simply carry no plan. Roach
    // and termite price no plan at all, so they never reach this.
    const rodentPlan =
      engineService === "RODENT" ? rate.sheet.plans?.[freq] : undefined;
    if (rodentPlan) {
      recurringOffer = {
        frequency: freq,
        monthlyCents: rodentPlan.monthlyCents + travelAdderCents(priceZone, freq),
        initialFeeCents:
          rodentPlan.initialFeeCents +
          travelAdderCents(priceZone, "ONE_TIME_FLAT"),
      };
    }
  }

  // Day-priced availability from the live schedule. The on-site duration is
  // the LOCKED property-class rule: commercial/community 60, residential 30.
  let days = await buildDayMatrix({
    routesKey,
    candidateAddress: address,
    service,
    baseCents: baseCents!,
    zone: priceZone,
    onsiteMinutes:
      pricingKind === "COMMERCIAL" || pricingKind === "COMMUNITY" ? 60 : 30,
  });
  // GL-17: a seasonal plan's FIRST TREATMENT is only sold onto an
  // April–October date — the same rule the office paths hard-refuse. Late
  // in the season the board simply shrinks to the remaining in-season days;
  // a fully off-season ask stays a REAL date-less sale (offSeason below):
  // billing begins now, first treatment next April, office confirms the day.
  let offSeason = false;
  if (SEASONAL_SERVICES.has(service)) {
    days = days.filter((d) => {
      const month = Number(d.date.slice(5, 7));
      return month >= 4 && month <= 10;
    });
    // GL-17 locked rule: an off-season enrollment is a REAL sale — billing
    // begins immediately and the first treatment lands next April. But
    // "off-season" is a CALENDAR fact: it is claimed only when NO day in
    // the quote horizon falls in April–October, independent of capacity.
    // A fully-booked (or capacity-starved) in-season week stays the honest
    // "fully booked" contact path below — never a false "come back in
    // April" while the season is running.
    const todayEt = new Date().toLocaleDateString("en-CA", {
      timeZone: "America/New_York",
    });
    const horizonHasSeasonDay = Array.from({ length: 32 }, (_, i) =>
      addDays(todayEt, i + 1)
    ).some((d) => {
      const month = Number(d.slice(5, 7));
      return month >= 4 && month <= 10;
    });
    offSeason = !horizonHasSeasonDay;
    if (offSeason) days = [];
  }
  if (days.length === 0 && !offSeason) {
    return contact(
      "We're fully booked this month",
      "to find you the first opening",
      {},
      "",
      undefined,
      `No bookable day this month for ${service.toLowerCase().replace("_", " ")} at this address (every day was full or infeasible on the board). Offer the first opening next month, or fit them in manually.`
    );
  }
  if (planOnly) {
    // The day board only picks the first visit: availability and
    // feasibility per day are real, but the plan price never varies by day.
    days = days.map((d) => ({
      ...d,
      priceCents: baseCents!,
      factors: [
        SEASONAL_SERVICES.has(service)
          ? "seasonal plan (Apr–Oct treatments, billed monthly year-round), first month charged at booking, price fixed per day"
          : "community plan, first month charged at booking, price fixed per day",
      ],
    }));
  }

  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const booking = await makeBooking({
    status: "QUOTED",
    // Persist the zone it was PRICED at (an office OUT quote priced as Zone C),
    // so the booking-status re-check reprices with the same travel add-on.
    zone: priceZone,
    driveMinutes: minutes ?? undefined,
    quoteJson: JSON.stringify({
      days,
      baseCents,
      serviceLabel,
      recurringOffer,
      planOnly: planOnly || undefined,
      offSeason: offSeason || undefined,
    }),
    monthlyCents: recurringOffer?.monthlyCents ?? undefined,
    expiresAt,
  });
  const requestedFrequency = requestedQuoteFrequency(
    input.recurringPreference,
    recurringOffer,
    planOnly
  );

  // Weekly pricing review sees the website channel too.
  await client.models.LeadPricingRun.create({
    source: "website",
    decision: "QUOTE",
    outcome: "PENDING",
    inputText: `[website ${service}] ${name}, ${address}${input.sqft ? `, ${input.sqft} sqft` : ""}${input.nestCount ? `, ${input.nestCount} nests` : ""}${input.removalKind ? `, remove ${input.removalCount ?? 1} ${input.removalKind}` : ""}`,
    zone: priceZone,
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
    service: quoteDisplayService(serviceLabel, requestedFrequency),
    recurringOffer,
    requestedFrequency,
    // Plan-only quotes (community common-area) carry no one-time offer: the
    // day picks the first visit and the amount charged is the first month.
    planOnly: planOnly || undefined,
    // Community/commercial checkouts may choose "Invoice me" (net terms).
    invoiceEligible: invoiceEligibleFor(propertyKind) || undefined,
    // GL-17: an off-season enrollment ships an EMPTY day board plus the
    // truthful explanation — checkout is the plan itself, date-less.
    offSeason: offSeason || undefined,
    offSeasonMessage: offSeason ? OFF_SEASON_MESSAGE : undefined,
    days: days.map(({ date, priceCents }) => ({
      date,
      priceCents,
    })),
    expiresAt,
    // R17: the checkout must render exactly what /book will hold them to.
    terms: { version: BOOKING_TERMS_VERSION, text: BOOKING_TERMS_TEXT },
  };
}

// ----------------------------------------------------------------- /book

/** GL-17: prove a PaymentIntent TERMINAL (canceled) — cancel then verify,
 *  falling back to a re-read. False means the intent may still be able to
 *  charge; no replacement may be created while that is true. */
async function proveIntentTerminal(
  s: Stripe,
  intentId: string
): Promise<boolean> {
  try {
    if ((await s.paymentIntents.cancel(intentId)).status === "canceled") {
      return true;
    }
  } catch {
    /* verified by the re-read below */
  }
  try {
    return (await s.paymentIntents.retrieve(intentId)).status === "canceled";
  } catch {
    return false;
  }
}

/** GL-17: a chargeable intent exists that the booking record does not
 *  reference and could not be closed — CONFIRMED, deduplicated Finance
 *  recovery. Never silently ignored: a failed open is logged CRITICAL (the
 *  reconcile/stray-payment sweeps remain the money backstop). */
async function ownOrphanedIntent(
  booking: { id: string; name?: string | null },
  intentId: string,
  amountCents: number
): Promise<void> {
  let opened: string | null = null;
  try {
    opened = await openOwnedWork({
      kind: "PAYMENT_INTENT_ORPHAN",
      dedupeKey: `booking-payment-orphan:${booking.id}`,
      title: `A checkout's payment intent is unrecorded: ${booking.name ?? booking.id}`,
      detail: `Stripe PaymentIntent ${intentId} ($${(amountCents / 100).toFixed(2)}) exists for booking ${booking.id}, but the booking record could not be updated to reference it AND the intent could not be canceled. If the customer completes this payment, finalization will refuse it as superseded — verify the intent in Stripe, cancel or refund it, and reconcile the booking.`,
      relatedId: booking.id,
      sourceUrl: `/work`,
      resolutionAction:
        "Open the PaymentIntent in Stripe. If unpaid, cancel it. If paid, refund or manually finalize against this booking, then confirm the booking record references the right intent.",
      ownerTeam: "FINANCE",
    });
  } catch (err) {
    console.error("ownOrphanedIntent: openOwnedWork threw", booking.id, intentId, err);
  }
  if (!opened) {
    console.error(
      `CRITICAL: PAYMENT_INTENT_ORPHAN work for booking ${booking.id} / intent ${intentId} could not be opened — the unreferenced chargeable intent is covered only by the reconcile and stray-payment sweeps until a human intervenes.`
    );
  }
}

/** The booking row's CURRENT authoritative intent reference. */
async function currentIntentId(
  client: { models: Record<string, unknown> },
  bookingId: string
): Promise<string | null> {
  try {
    const { data } = await (
      client.models.BookingRequest as {
        get: (i: { id: string }) => Promise<{
          data: { stripePaymentIntentId?: string | null } | null;
        }>;
      }
    ).get({ id: bookingId });
    return data?.stripePaymentIntentId ?? null;
  } catch {
    return null;
  }
}

/** GL-17: after a LOST/UNSUPPORTED fenced write, settle the fate of the
 *  intent THIS attempt minted: if a concurrent attempt persisted the very
 *  same (idempotency-converged) intent, it is authoritative — leave it.
 *  Otherwise it is unreferenced and chargeable — prove it terminal or open
 *  confirmed Finance recovery. */
async function settleUnpersistedIntent(
  client: { models: Record<string, unknown> },
  s: Stripe,
  booking: { id: string; name?: string | null },
  intentId: string,
  amountCents: number
): Promise<void> {
  const authoritative = await currentIntentId(client, booking.id);
  if (authoritative === intentId) return; // converged — another attempt owns it
  if (!(await proveIntentTerminal(s, intentId))) {
    await ownOrphanedIntent(booking, intentId, amountCents);
  }
}

/** GL-17: the truthful refusal after a LOST fenced checkout write — re-read
 *  the booking's durable lifecycle and answer with what is actually true.
 *  Never returns a client secret. */
async function truthfulCheckoutRefusal(
  client: { models: Record<string, unknown> },
  bookingId: string
): Promise<HttpError> {
  let status: string | undefined;
  try {
    const { data } = await (
      client.models.BookingRequest as {
        get: (i: { id: string }) => Promise<{
          data: { status?: string | null } | null;
        }>;
      }
    ).get({ id: bookingId });
    status = data?.status ?? undefined;
  } catch {
    /* fall through to the generic refusal */
  }
  if (status === "BOOKED") {
    return new HttpError(409, {
      error:
        "This booking is already paid — check your email for the confirmation.",
    });
  }
  if (status === "PROCESSING") {
    return new HttpError(409, {
      error:
        "Your payment is still processing — please don't pay again. We'll email your confirmation as soon as it clears, or let you know if it doesn't go through.",
    });
  }
  if (status === "CANCELED") {
    return new HttpError(410, {
      error: "This booking was canceled — request a fresh quote.",
    });
  }
  if (status === "EXPIRED") {
    return new HttpError(410, {
      error: "This quote expired — request a fresh one.",
    });
  }
  return new HttpError(409, {
    error:
      "Another checkout attempt for this booking finished first — refresh and try again.",
  });
}

/** GL-17: mint (or converge on) THIS attempt's PaymentIntent with the
 *  generation-chained deterministic idempotency key. A replayed dead
 *  (canceled) generation advances the chain; a replayed succeeded/processing
 *  intent is answered truthfully by throwing. */
async function createConvergentIntent(
  s: Stripe,
  opts: {
    bookingId: string;
    customerId: string;
    amountCents: number;
    description: string;
    generation: string;
  }
): Promise<Stripe.PaymentIntent> {
  let generation = opts.generation;
  for (let hop = 0; hop < 3; hop++) {
    const created = await s.paymentIntents.create(
      {
        amount: opts.amountCents,
        currency: "usd",
        customer: opts.customerId,
        setup_future_usage: "off_session",
        automatic_payment_methods: { enabled: true },
        description: opts.description,
        metadata: { bookingRequestId: opts.bookingId },
      },
      { idempotencyKey: `bk-intent-${opts.bookingId}-${generation}` }
    );
    if (created.status === "succeeded") {
      throw new HttpError(409, {
        error:
          "This booking is already paid — check your email for the confirmation.",
      });
    }
    if (created.status === "processing") {
      throw new HttpError(409, {
        error:
          "Your payment is still processing — please don't pay again. We'll email your confirmation as soon as it clears, or let you know if it doesn't go through.",
      });
    }
    if (created.status === "canceled") {
      generation = created.id;
      continue;
    }
    if (!created.client_secret) break;
    return created;
  }
  throw new HttpError(503, {
    error:
      "We couldn't prepare your checkout — nothing was charged. Please try again in a moment.",
  });
}

/**
 * GL-17 — check out an OFF-SEASON seasonal-plan enrollment: the customer
 * pays the first month now (billing starts immediately, as advertised), no
 * first-visit day exists yet, and no capacity is claimed — finalization
 * creates the April-targeted visit, its treatment obligation, and the owned
 * office action that confirms the real date with the customer.
 *
 * This path sits behind the SAME failure-safe payment contract as the rest
 * of booking — never a weaker seasonal one:
 *  - a durable single-winner attempt claim (acquirePaymentAttempt) so
 *    parallel double-clicks cannot both mint provider objects;
 *  - deterministic Stripe idempotency keys (customer keyed by booking;
 *    intent keyed by booking + prior-intent GENERATION) so even overlapping
 *    or replayed creates converge on ONE customer and ONE intent;
 *  - an explicit payable-reuse allowlist — canceled/succeeded/processing
 *    intents are answered truthfully, never handed back as chargeable;
 *  - a stale intent is PROVEN terminal before any replacement can charge;
 *  - the booking's intent reference and terms acceptance are durably
 *    CONFIRMED before the client secret leaves the server; a persistence
 *    failure after provider creation cancels the intent safely or opens
 *    deduplicated owned Finance recovery — never a blind second intent.
 * Webhook finalization then converges on the one recorded intent (its
 * superseded-intent guard already refuses everything else).
 */
async function offSeasonEnrollmentAttempt(opts: {
  booking: {
    id: string;
    email: string;
    name: string;
    phone?: string | null;
    cancelToken?: string | null;
    stripeCustomerId?: string | null;
    stripePaymentIntentId?: string | null;
  };
  stored: {
    serviceLabel?: string;
    recurringOffer: { frequency: string; monthlyCents: number; initialFeeCents: number };
  };
  req: { sourceIp?: string; userAgent?: string };
  tcVersion: string;
  client: { models: Record<string, unknown> };
  /** The exact attempt-lease value book() acquired — the persistence fence. */
  holderUntil: string;
  /** First-month charge with any staff discount code already applied. */
  amountCents: number;
  /** The applied-code snapshot to persist on the BookingRequest. */
  promoSets: { promoCode: string | null; promoDiscountCents: number | null };
}) {
  const { booking, stored, req, tcVersion, client, holderUntil, amountCents, promoSets } =
    opts;
  const s = await stripeClient();
  const summary = `${stored.serviceLabel ?? "Seasonal plan"} — billing starts today; first treatment scheduled for April (we'll confirm the exact day).`;

  /** The enrollment facts + THIS attempt's intent reference, landed through
   *  the ONE fenced write (attempt holder + payable state + expected prior
   *  intent) — a concurrent webhook's PROCESSING/BOOKED, a cancellation, or
   *  a newer attempt's intent is never regressed to QUOTED. */
  const persistEnrollment = async (
    intentId: string,
    customerId?: string
  ): Promise<"OK" | "LOST" | "UNSUPPORTED"> => {
    const write = () =>
      persistCheckoutAttempt({
        bookingId: booking.id,
        holderUntil,
        priorIntentId: booking.stripePaymentIntentId ?? null,
        sets: {
          status: "QUOTED",
          selectedDate: null,
          capacityTechnicianId: null,
          capacityMinutes: null,
          recurring: true,
          amountCents,
          ...promoSets,
          ...(customerId ? { stripeCustomerId: customerId } : {}),
          stripePaymentIntentId: intentId,
          paymentFailedReason: null,
          paymentFailedNoticeSentAt: null,
          tcVersion,
          tcAcceptedAt: new Date().toISOString(),
          tcIp: req.sourceIp || null,
          tcUserAgent: req.userAgent?.slice(0, 512) || null,
        },
      });
    const first = await write();
    if (first.ok) return "OK";
    if (first.reason === "UNSUPPORTED") {
      const retry = await write();
      return retry.ok ? "OK" : retry.reason;
    }
    return "LOST";
  };

  // 1. Prior-intent triage against the EXPLICIT allowlist.
  const priorId = booking.stripePaymentIntentId ?? null;
  if (priorId) {
    const existing = await s.paymentIntents.retrieve(priorId);
    if (existing.status === "succeeded") {
      throw new HttpError(409, {
        error:
          "This enrollment is already paid — check your email for the confirmation.",
      });
    }
    if (existing.status === "processing") {
      throw new HttpError(409, {
        error:
          "Your payment is still processing — please don't pay again. We'll email your confirmation as soon as it clears, or let you know if it doesn't go through.",
      });
    }
    if (
      PAYABLE_REUSE_STATUSES.has(existing.status) &&
      existing.amount === amountCents &&
      existing.client_secret
    ) {
      // Reusable — but the acceptance record must be durably confirmed
      // before this attempt's secret leaves the server.
      const persisted = await persistEnrollment(existing.id);
      if (persisted === "LOST") {
        throw await truthfulCheckoutRefusal(client, booking.id);
      }
      if (persisted !== "OK") {
        throw new HttpError(503, {
          error:
            "We couldn't record your acceptance — nothing was charged. Please try again in a moment.",
        });
      }
      return {
        clientSecret: existing.client_secret,
        amountCents,
        statusToken: booking.cancelToken ?? undefined,
        summary,
      };
    }
    // Not reusable: PROVE it terminal before any replacement can charge —
    // an async intent that later settles must be impossible here.
    if (
      existing.status !== "canceled" &&
      !(await proveIntentTerminal(s, existing.id))
    ) {
      throw new HttpError(503, {
        error:
          "We couldn't safely close your previous payment attempt — nothing was charged. Please try again in a moment.",
      });
    }
  }

  // 2. ONE customer, ONE intent — deterministic idempotency keys. The
  // intent key is chained on the prior GENERATION (the last recorded intent
  // id, or "first"), so overlapping attempts converge on the same object
  // and a replayed dead generation is detected and advanced, never charged.
  const customerId =
    booking.stripeCustomerId ??
    (
      await s.customers.create(
        {
          email: booking.email,
          name: booking.name,
          phone: booking.phone ?? undefined,
          metadata: { bookingRequestId: booking.id },
        },
        { idempotencyKey: `bk-cust-${booking.id}` }
      )
    ).id;
  const intent = await createConvergentIntent(s, {
    bookingId: booking.id,
    customerId,
    amountCents,
    description: `${stored.serviceLabel ?? "Seasonal plan"} — off-season enrollment (first treatment next April)`,
    generation: priorId ?? "first",
  });

  // 3. DURABLE FENCED persistence BEFORE the secret. A lost fence means the
  // lifecycle moved (webhook, newer attempt) — close OUR unreferenced intent
  // and answer truthfully; an unsupported write closes the intent or opens
  // confirmed Finance recovery. No path returns a secret unconfirmed.
  const persisted = await persistEnrollment(intent.id, customerId);
  if (persisted !== "OK") {
    await settleUnpersistedIntent(client, s, booking, intent.id, amountCents);
    if (persisted === "LOST") {
      throw await truthfulCheckoutRefusal(client, booking.id);
    }
    throw new HttpError(503, {
      error:
        "We couldn't save your checkout — nothing was charged. Please try again in a moment.",
    });
  }
  return {
    clientSecret: intent.client_secret,
    amountCents,
    statusToken: booking.cancelToken ?? undefined,
    summary,
  };
}

/**
 * Preview a staff discount code against a quote WITHOUT booking — the client
 * shows the discounted total before the customer pays. /book re-validates and
 * applies the SAME decision authoritatively; this endpoint mutates nothing.
 */
async function promoPreview(body: Record<string, unknown>) {
  const client = await dataClient();
  const bookingId = String(body.bookingId ?? "");
  const { data: booking } = await client.models.BookingRequest.get({
    id: bookingId,
  });
  if (!booking) {
    throw new HttpError(404, { error: "Quote not found — request a new one." });
  }
  const stored = JSON.parse(String(booking.quoteJson ?? "{}")) as {
    days?: DayQuote[];
    recurringOffer?: { initialFeeCents: number } | null;
    planOnly?: boolean;
    offSeason?: boolean;
  };
  // Mirror /book's base-amount rule: recurring/plan/off-season discount off the
  // first-month fee, a one-time booking off the chosen day's price.
  const recurring = body.recurring === true || stored.planOnly === true;
  const offSeason = stored.offSeason === true;
  const date = String(body.date ?? "");
  const day = offSeason ? null : stored.days?.find((d) => d.date === date);
  const baseCents =
    recurring || offSeason
      ? stored.recurringOffer?.initialFeeCents ?? 0
      : day?.priceCents ?? 0;
  if (baseCents <= 0) {
    throw new HttpError(409, {
      error: "That day is no longer available — request a fresh quote.",
    });
  }
  const resolved = await resolvePromo(client, body.code, Date.now());
  if (!resolved.ok) {
    return { valid: false as const, message: resolved.message };
  }
  const discountCents = discountFor(resolved.promo, baseCents);
  if (discountCents <= 0) {
    return {
      valid: false as const,
      message: "That code doesn't apply to this booking.",
    };
  }
  return {
    valid: true as const,
    code: normalizeCode(resolved.promo.code),
    label: promoLabel(resolved.promo),
    discountCents,
    amountCents: baseCents - discountCents,
  };
}

async function book(
  body: Record<string, unknown>,
  req: { sourceIp?: string; userAgent?: string },
  // Present ONLY on a trusted internal invoke (crm-billing → this Lambda, IAM
  // InvokeCommand) for a logged-in customer adding a service from the portal.
  // The public Function URL can never set this: the internal path is entered
  // solely on an event with no requestContext.http (see the handler entry),
  // and the ownership of the quote is re-checked here against leadCustomerId.
  // When set, the visit is charged to the customer's SAVED card off-session
  // and finalized synchronously instead of returning a client secret.
  trusted?: { customerId: string }
) {
  const bookingId = String(body.bookingId ?? "");
  const date = String(body.date ?? "");
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
  if (!booking) {
    throw new HttpError(404, { error: "Quote not found — request a new one." });
  }
  const bookingRow = booking;
  // A trusted saved-card booking may finalize ONLY the quote it owns: the
  // internal quote stamped the customer's id as leadCustomerId, so a mismatch
  // (or a public quote with no lead) is refused before any money moves. This
  // is the second gate behind crm-billing's own assertCanActForCustomer — the
  // customer id here already came from a verified Cognito identity.
  if (trusted && booking.leadCustomerId !== trusted.customerId) {
    throw new HttpError(403, {
      error: "This quote isn't on your account — start a new one from your portal.",
    });
  }
  if (booking.status === "BOOKED") {
    throw new HttpError(409, {
      error:
        "This booking is already paid — check your email for the confirmation.",
    });
  }
  if (booking.status === "PROCESSING") {
    throw new HttpError(409, {
      error: booking.jobId
        ? "Your payment is still processing and your visit is scheduled — please don't pay again. We'll email you the moment it clears, or right away if it doesn't go through."
        : "Your payment is still processing — please don't pay again. We'll email your confirmation as soon as it clears, or let you know if it doesn't go through.",
    });
  }
  if (booking.status === "PAYMENT_FAILED") {
    // A pre-service failure canceled the pending visit — the customer may
    // simply pay again (the flow below re-checks capacity and issues a fresh
    // intent). A POST-service failure is an outstanding balance, not a new
    // booking: paying "again" here would buy a second visit.
    if (booking.jobId) {
      const { data: failedJob } = await client.models.Job.get({
        id: booking.jobId,
      });
      if (
        failedJob &&
        (failedJob.status === "COMPLETED" || failedJob.status === "IN_PROGRESS")
      ) {
        throw new HttpError(409, {
          error:
            "Your visit was completed but the payment didn't go through, so the amount is an outstanding balance. Reply to our email or call the office to settle it — please don't book a new visit to pay it.",
        });
      }
    }
  } else if (booking.status !== "QUOTED") {
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
    offSeason?: boolean;
  };
  // Invoice-me (net terms): allowed ONLY for HOA/community + commercial, and
  // re-checked SERVER-SIDE from the booking's stored property kind — a client
  // that flips `invoice:true` on a residential quote is refused here.
  const invoiceMode = body.invoice === true;
  if (invoiceMode && !invoiceEligibleFor(booking.propertyKind)) {
    throw new HttpError(400, {
      error:
        "Invoicing isn't available for this property type — please pay by card to book.",
    });
  }
  // A plan-only quote (community common-area) has no one-time offer — the
  // booking is always the plan, whatever the client sent.
  const recurring = body.recurring === true || stored.planOnly === true;
  // GL-17: an off-season seasonal enrollment books the PLAN with no first-
  // visit day — no date, no capacity claim; the first treatment is scheduled
  // by the office next April (finalize owns that action).
  const offSeason = stored.offSeason === true;
  const day = offSeason ? null : stored.days?.find((d) => d.date === date);
  if (!offSeason && !day) {
    throw new HttpError(409, {
      error: "That day is no longer available — request a fresh quote.",
    });
  }
  if (recurring && !stored.recurringOffer) {
    throw new HttpError(400, { error: "No recurring plan was offered on this quote." });
  }
  if (offSeason && !stored.recurringOffer) {
    // An off-season enrollment IS the plan — a quote stored without its
    // recurring offer cannot price the first month and must not 500.
    throw new HttpError(400, {
      error: "No recurring plan was offered on this quote.",
    });
  }

  // A staff-entered discount code (optional). Resolve it ONCE here so every
  // /book branch — dated card, invoice, off-season — discounts from the same
  // decision, and a bad code is refused before any provider object exists. The
  // code was validated identically at /promo; /book is the authority.
  const resolved = normalizeCode(body.promoCode)
    ? await resolvePromo(client, body.promoCode, Date.now())
    : null;
  if (resolved && !resolved.ok) {
    throw new HttpError(400, { error: resolved.message });
  }
  const promo = resolved?.ok ? resolved.promo : null;
  if (promo && booking.promoCode !== normalizeCode(promo.code)) {
    // Best-effort "first N" tally: counted when the code is first applied at
    // checkout, not when payment clears — so an abandoned checkout still
    // consumes one. That undercounts issuance rather than overselling a capped
    // code (the safe direction). Not money-atomic; maxRedemptions is a
    // marketing guardrail, not a financial guarantee. A tally failure never
    // blocks the booking.
    await client.models.PromoCode.update({
      id: promo.id,
      timesRedeemed: (promo.timesRedeemed ?? 0) + 1,
    }).catch(() => undefined);
  }
  // Apply the resolved code (if any) to a branch's base charge. A card charge
  // a code would push below Stripe's floor is refused honestly here, so "the
  // code wins" never yields an unchargeable intent. Returns the fields to
  // snapshot on the BookingRequest alongside the amount.
  function pricedWithPromo(
    baseCents: number,
    opts?: { card?: boolean }
  ): {
    amountCents: number;
    promoSets: { promoCode: string | null; promoDiscountCents: number | null };
  } {
    const discount = promo ? discountFor(promo, baseCents) : 0;
    const amountCents = baseCents - discount;
    if (opts?.card && discount > 0 && amountCents < STRIPE_MIN_CHARGE_CENTS) {
      throw new HttpError(400, {
        error:
          amountCents <= 0
            ? "That code makes this booking free — bill it by invoice instead of charging a card."
            : `That code drops the total below the ${money(STRIPE_MIN_CHARGE_CENTS)} card minimum — use a smaller code or bill by invoice.`,
      });
    }
    return {
      amountCents,
      promoSets: promo
        ? { promoCode: normalizeCode(promo.code), promoDiscountCents: discount }
        : { promoCode: null, promoDiscountCents: null },
    };
  }

  // GL-17: EVERY /book branch — dated, plan-only, and off-season — runs
  // behind ONE durable single-winner attempt boundary. Parallel requests
  // (double-clicks, two tabs, different selections) get exactly one live
  // attempt; the loser is refused honestly before any provider object or
  // capacity/selection mutation exists. Fenced persistence (the attempt
  // holder below) keeps even a lease-expiry overlap convergent.
  const attempt = await acquirePaymentAttempt(bookingId);
  if (!attempt.ok) {
    throw new HttpError(attempt.unavailable ? 503 : 409, {
      error: attempt.unavailable
        ? "Checkout can't be verified right now — nothing was charged. Try again in a moment."
        : "Your checkout is already being prepared (another click or tab got there first) — give it a few seconds and try again.",
    });
  }
  const holderUntil = attempt.holderUntil;
  try {
    if (trusted) {
      // A portal add-on always pays by the customer's saved card on a real
      // day. Net-terms invoicing and date-less off-season enrollment are
      // office-assisted paths, not self-serve — refuse them here rather than
      // silently downgrading the customer's choice.
      if (invoiceMode || offSeason) {
        throw new HttpError(400, {
          error:
            "This service needs a quick call to set up — the office will reach out. Nothing was charged.",
        });
      }
      return await bookDatedAttempt(trusted);
    }
    if (invoiceMode) {
      return await bookInvoiceAttempt();
    }
    if (offSeason) {
      // The off-season enrollment charges the first month by card — apply the
      // code to that charge here (same card floor as every other checkout).
      const { amountCents: offSeasonAmountCents, promoSets: offSeasonPromoSets } =
        pricedWithPromo(stored.recurringOffer!.initialFeeCents, { card: true });
      return await offSeasonEnrollmentAttempt({
        booking,
        stored: stored as {
          serviceLabel?: string;
          recurringOffer: { frequency: string; monthlyCents: number; initialFeeCents: number };
        },
        req,
        tcVersion,
        client,
        holderUntil,
        amountCents: offSeasonAmountCents,
        promoSets: offSeasonPromoSets,
      });
    }
    return await bookDatedAttempt();
  } finally {
    await attempt.release();
  }

  // Invoice-me (HOA/community + commercial): book card-less on net terms.
  // Same attempt boundary and live capacity claim as a card checkout, but
  // no PaymentIntent — the visit is scheduled and an OPEN net-terms invoice
  // is created for the customer to pay later. Finalizes synchronously (no
  // webhook), so the response is a booked confirmation, not a client secret.
  async function bookInvoiceAttempt() {
    const booking = bookingRow;
    // A staff discount code comes off the invoiced amount too (no Stripe
    // minimum applies — nothing is charged to a card).
    const { amountCents, promoSets } = pricedWithPromo(
      recurring || offSeason
        ? stored.recurringOffer!.initialFeeCents
        : day!.priceCents
    );
    // Default net-30 terms; the due date is stamped on the OPEN invoice and
    // drives AR aging / dunning exactly like any other net-terms bill.
    const due = new Date();
    due.setUTCDate(due.getUTCDate() + 30);
    const invoiceTerms = { terms: "NET_30", dueDate: due.toISOString().slice(0, 10) };

    // A dated invoice booking claims its slot against the LIVE schedule (R29
    // / GL-04), exactly like a card checkout; a date-less off-season
    // enrollment claims nothing (finalize targets the first in-season visit).
    let claimedSlot: { technicianId: string; claimMinutes: number } | null = null;
    if (!offSeason) {
      const addr = `${booking.street}, ${booking.city}, ${booking.state}${booking.zip ? ` ${booking.zip}` : ""}`;
      const liveDay = await buildDayMatrix({
        routesKey: await getSecret("GOOGLE_ROUTES_API_KEY"),
        candidateAddress: addr,
        service: String(booking.service),
        baseCents: day!.priceCents,
        zone:
          booking.zone === "A" ||
          booking.zone === "B" ||
          booking.zone === "C"
            ? booking.zone
            : undefined,
        onlyDate: date,
        onsiteMinutes:
          booking.propertyKind === "COMMERCIAL" ||
          booking.propertyKind === "COMMUNITY"
            ? 60
            : 30,
      });
      const slot = liveDay.find((d) => d.date === date)?.slot;
      if (!slot) {
        throw new HttpError(409, {
          error: "That day just sold out — pick another from a fresh quote.",
        });
      }
      const claim = await claimDaySlot({
        claimKey: booking.id,
        date,
        technicianId: slot.technicianId,
        minutes: slot.claimMinutes,
        address: addr,
        holdReason: `invoice checkout for ${booking.email}`,
      });
      if (!claim.ok) {
        throw new HttpError(409, {
          error: claim.soldOut
            ? "That day just sold out — pick another from a fresh quote."
            : claim.message,
        });
      }
      claimedSlot = { technicianId: slot.technicianId, claimMinutes: slot.claimMinutes };
    }

    // Persist the selection, amount, terms acceptance, and capacity facts
    // through the ONE fenced write — no Stripe objects. A lost fence answers
    // truthfully; an unsupported write releases the claim so nothing leaks.
    const persisted = await persistCheckoutAttempt({
      bookingId: booking.id,
      holderUntil,
      priorIntentId: booking.stripePaymentIntentId ?? null,
      sets: {
        status: "QUOTED",
        selectedDate: offSeason ? null : date,
        capacityTechnicianId: claimedSlot?.technicianId ?? null,
        capacityMinutes: claimedSlot?.claimMinutes ?? null,
        recurring,
        amountCents,
        ...promoSets,
        paymentFailedReason: null,
        paymentFailedNoticeSentAt: null,
        tcVersion,
        tcAcceptedAt: new Date().toISOString(),
        tcIp: req.sourceIp || null,
        tcUserAgent: req.userAgent?.slice(0, 512) || null,
      },
    });
    if (!persisted.ok) {
      if (!offSeason) await releaseCapacityClaim(booking.id).catch(() => undefined);
      if (persisted.reason === "LOST") {
        throw await truthfulCheckoutRefusal(client, booking.id);
      }
      throw new HttpError(503, {
        error:
          "We couldn't save your booking — nothing was charged. Please try again in a moment.",
      });
    }

    // Card-less finalize: OPEN net-terms invoice, scheduled unpaid visit,
    // signed agreement, BOOKED — the same complete commitment a paid booking
    // makes. finalizeBooking re-reads the persisted facts; it is idempotent
    // via the booking status, so a double-submit converges on one commitment.
    await finalizeBooking({
      bookingRequestId: booking.id,
      paymentIntentId: `invoice-${booking.id}`,
      amountReceived: amountCents,
      invoice: invoiceTerms,
    });

    return {
      booked: true as const,
      amountCents,
      statusToken: booking.cancelToken ?? undefined,
      summary: summaryFor(stored, offSeason ? "" : date, recurring),
    };
  }

  // The dated (and plan-only) checkout, INSIDE the attempt boundary — a
  // closure so it shares every validated fact above. `trusted` is set only on
  // the portal saved-card path (charge the card on file, finalize inline).
  async function bookDatedAttempt(trusted?: { customerId: string }) {
  // TS narrowing doesn't cross the closure boundary; the null check above
  // already threw. Shadow with the proven-non-null row.
  const booking = bookingRow;
  // Server-side price: one-time pays the day price; recurring pays the
  // initial fee now and the subscription starts after the first visit. A
  // staff discount code (if any) comes off this card charge.
  const { amountCents, promoSets } = pricedWithPromo(
    recurring ? stored.recurringOffer!.initialFeeCents : day!.priceCents,
    { card: true }
  );

  const s = await stripeClient();

  // Repeat /book calls must never leave a second chargeable intent behind:
  // a paid one is terminal, an open one is reused or replaced.
  let existing: Stripe.PaymentIntent | null = null;
  if (booking.stripePaymentIntentId) {
    existing = await s.paymentIntents.retrieve(booking.stripePaymentIntentId);
    // GL-06: a succeeded payment is booked; a still-processing one is NOT paid
    // yet and no confirmation has been sent — say so honestly and do not invite
    // a second payment.
    if (existing.status === "succeeded") {
      throw new HttpError(409, {
        error: "This booking is already paid — check your email for the confirmation.",
      });
    }
    if (existing.status === "processing") {
      throw new HttpError(409, {
        error:
          "Your payment is still processing — please don't pay again. We'll email your confirmation as soon as it clears, or let you know if it doesn't go through.",
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
    baseCents: day!.priceCents, // availability only — the quoted price stands
    zone:
      booking.zone === "A" || booking.zone === "B" ? booking.zone : undefined,
    onlyDate: date,
    // The LOCKED property-class on-site rule — the re-check must count a
    // commercial/community stop at 60 minutes, same as the quote did.
    onsiteMinutes:
      booking.propertyKind === "COMMERCIAL" ||
      booking.propertyKind === "COMMUNITY"
        ? 60
        : 30,
  });
  if (!liveDay.some((d) => d.date === date)) {
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
      // GL-17: the SAME explicit payable-reuse allowlist as every other
      // checkout path — a canceled (or otherwise non-payable) intent is
      // never handed back as a fresh chargeable secret.
      PAYABLE_REUSE_STATUSES.has(existing.status) &&
      existing.amount === amountCents &&
      booking.selectedDate === date &&
      existing.client_secret
    ) {
      // GL-04: the cached intent is returned ONLY with a live hold behind
      // it. claimDaySlot extends a live same-slot claim and re-reserves
      // after an expiry sweep; a slot that meanwhile sold out refuses the
      // retry instead of handing back a chargeable secret that holds nothing.
      const liveDayQuote0 = liveDay.find((d) => d.date === date);
      const slot0 = liveDayQuote0?.slot;
      if (!slot0) {
        try {
          await s.paymentIntents.cancel(existing.id);
        } catch {
          /* already canceled/expired — fine */
        }
        throw new HttpError(409, {
          error: "That day just sold out — pick another from a fresh quote.",
        });
      }
      const reclaimed = await claimDaySlot({
        claimKey: booking.id,
        date,
        technicianId: slot0.technicianId,
        minutes: slot0.claimMinutes,
        holdReason: `checkout for ${booking.email}`,
      });
      if (!reclaimed.ok) {
        try {
          await s.paymentIntents.cancel(existing.id);
        } catch {
          /* already canceled/expired — fine */
        }
        throw new HttpError(409, {
          error: reclaimed.soldOut
            ? "That day just sold out — pick another from a fresh quote."
            : reclaimed.message,
        });
      }
      // GL-17: the reuse facts land through the SAME fenced write as a
      // fresh attempt — attempt holder, payable state, expected intent. A
      // concurrent webhook's PROCESSING/BOOKED is never regressed, and the
      // secret is returned only on CONFIRMED persistence.
      const reusePersisted = await persistCheckoutAttempt({
        bookingId: booking.id,
        holderUntil,
        priorIntentId: existing.id,
        sets: {
          // Restate the reused intent's authority in the same fenced write
          // that lands the selection/terms — confirmed persistence covers
          // ALL the facts the secret is returned against.
          stripePaymentIntentId: existing.id,
          capacityTechnicianId: slot0.technicianId,
          capacityMinutes: slot0.claimMinutes,
          selectedDate: date,
          recurring,
          amountCents,
          ...promoSets,
          // GL-06: a retried attempt (after a pre-service failure) re-arms
          // the state machine — the reused intent's webhooks only apply to
          // QUOTED/PROCESSING, and a fresh failure must notice again.
          status: "QUOTED",
          paymentFailedReason: null,
          paymentFailedNoticeSentAt: null,
          tcVersion,
          tcAcceptedAt: new Date().toISOString(),
          tcIp: req.sourceIp || null,
          tcUserAgent: req.userAgent?.slice(0, 512) || null,
        },
      });
      if (!reusePersisted.ok) {
        if (reusePersisted.reason === "LOST") {
          throw await truthfulCheckoutRefusal(client, booking.id);
        }
        throw new HttpError(503, {
          error:
            "We couldn't record your booking details — nothing was charged. Please try again in a moment.",
        });
      }
      return {
        clientSecret: existing.client_secret,
        amountCents,
        statusToken: booking.cancelToken ?? undefined,
        summary: summaryFor(stored, date, recurring),
      };
    }
    // GL-17: PROVE the prior intent terminal before any replacement can
    // become chargeable — an unproven cancellation blocks the attempt.
    if (
      existing.status !== "canceled" &&
      !(await proveIntentTerminal(s, existing.id))
    ) {
      throw new HttpError(503, {
        error:
          "We couldn't safely close your previous payment attempt — nothing was charged. Please try again in a moment.",
      });
    }
  }

  // GL-04 R1: atomically CLAIM the chosen technician-WINDOW slot for THIS
  // payment attempt BEFORE any chargeable intent exists. The slot and its
  // minutes (locked on-site + real Routes legs) come from the SAME
  // feasibility the live re-check just computed; exactly one of two
  // concurrent checkouts for a slot's last minutes wins, and the loser is
  // told before their card is ever chargeable. The claim is durable —
  // success consumes it into the booked job, a pending bank debit extends
  // it, and failure/abandonment releases it (the sweep owns crashed
  // checkouts).
  const liveDayQuote = liveDay.find((d) => d.date === date);
  const slot = liveDayQuote?.slot;
  if (!slot) {
    if (existing) {
      try {
        await s.paymentIntents.cancel(existing.id);
      } catch {
        /* already canceled/expired — fine */
      }
    }
    throw new HttpError(409, {
      error: "That day just sold out — pick another from a fresh quote.",
    });
  }
  const candidateAddress = [
    booking.street,
    booking.city,
    booking.state,
    booking.zip,
  ]
    .filter(Boolean)
    .join(", ");
  const capacityClaim = await claimDaySlot({
    claimKey: booking.id,
    date,
    technicianId: slot.technicianId,
    minutes: slot.claimMinutes,
    address: candidateAddress,
    holdReason: `checkout for ${booking.email}`,
  });
  if (!capacityClaim.ok) {
    if (existing) {
      try {
        await s.paymentIntents.cancel(existing.id);
      } catch {
        /* already canceled/expired — fine */
      }
    }
    throw new HttpError(409, {
      error: capacityClaim.soldOut
        ? "That day just sold out — pick another from a fresh quote."
        : capacityClaim.message,
    });
  }

  // ── Portal saved-card path ────────────────────────────────────────
  // A logged-in customer adding a service: charge the card on file
  // off-session and finalize synchronously (like the invoice path, but with
  // a real charge instead of net terms). The capacity slot above is already
  // claimed for this attempt; on any failure below it is released so nothing
  // leaks. Reuses the exact off-session pattern crm-billing's chargeOneTimeJob
  // uses, and hands finalizeBooking a real succeeded PaymentIntent.
  if (trusted) {
    const { stripeCustomerId } = await ensureStripeCustomer(s, trusted.customerId);
    const pm = await getDefaultPaymentMethod(s, stripeCustomerId);
    if (!pm) {
      await releaseCapacityClaim(booking.id).catch(() => undefined);
      throw new HttpError(402, {
        error:
          "There's no saved payment method on your account — add a card in Billing, then add this service. Nothing was charged.",
      });
    }
    let intent: Stripe.PaymentIntent;
    try {
      intent = await s.paymentIntents.create(
        {
          amount: amountCents,
          currency: "usd",
          customer: stripeCustomerId,
          payment_method: pm.id,
          off_session: true,
          confirm: true,
          description: `${stored.serviceLabel ?? "BuzzKill service"} — ${date}`,
          metadata: { bookingRequestId: booking.id },
        },
        // Deterministic per attempt generation: a double-submit under the lease
        // replays the one intent instead of charging the card twice.
        { idempotencyKey: `bk-saved-${booking.id}-${booking.stripePaymentIntentId ?? "first"}` }
      );
    } catch (err) {
      // An off-session decline throws with the failed PaymentIntent attached.
      // Give the slot back and tell the customer honestly — no visit is booked.
      await releaseCapacityClaim(booking.id).catch(() => undefined);
      const declineMsg =
        err && typeof err === "object" && "code" in err && err.code === "authentication_required"
          ? "Your card needs verification with your bank before we can charge it — pay this one from Billing, or use a different card. Nothing was charged."
          : "Your saved card was declined, so nothing was charged. Update your card in Billing and try again.";
      throw new HttpError(402, { error: declineMsg });
    }
    if (intent.status !== "succeeded" && intent.status !== "processing") {
      // requires_action / requires_payment_method with no throw — treat as an
      // un-completable off-session charge. Cancel it so nothing stays payable.
      try {
        await s.paymentIntents.cancel(intent.id);
      } catch {
        /* already canceled/expired — fine */
      }
      await releaseCapacityClaim(booking.id).catch(() => undefined);
      throw new HttpError(402, {
        error:
          "We couldn't complete the charge on your saved card, so nothing was charged. Update your card in Billing and try again.",
      });
    }
    const persisted = await persistCheckoutAttempt({
      bookingId: booking.id,
      holderUntil,
      priorIntentId: booking.stripePaymentIntentId ?? null,
      sets: {
        status: "QUOTED",
        selectedDate: date,
        capacityTechnicianId: slot.technicianId,
        capacityMinutes: slot.claimMinutes,
        recurring,
        amountCents,
        ...promoSets,
        stripeCustomerId,
        stripePaymentIntentId: intent.id,
        paymentFailedReason: null,
        paymentFailedNoticeSentAt: null,
        tcVersion,
        tcAcceptedAt: new Date().toISOString(),
        tcIp: req.sourceIp || null,
        tcUserAgent: req.userAgent?.slice(0, 512) || null,
      },
    });
    if (!persisted.ok) {
      // Money captured but the attempt couldn't be recorded: refund/close the
      // intent and give the slot back, exactly like the client-card path.
      await settleUnpersistedIntent(
        client as unknown as { models: Record<string, unknown> },
        s,
        booking,
        intent.id,
        amountCents
      );
      if (persisted.reason === "LOST") {
        throw await truthfulCheckoutRefusal(client, booking.id);
      }
      await releaseCapacityClaim(booking.id).catch(() => undefined);
      throw new HttpError(503, {
        error:
          "We couldn't save your booking after charging — we've reversed the charge. Please try again in a moment.",
      });
    }
    // Synchronous finalize: a succeeded charge books now; a processing bank
    // debit commits under finalize's GL-06 pending contract.
    await finalizeBooking(
      intent.status === "processing"
        ? {
            bookingRequestId: booking.id,
            paymentIntentId: intent.id,
            amountReceived: amountCents,
            paymentMethodId: pm.id,
            pending: { methodLabel: pm.type === "us_bank_account" ? "bank account" : "card" },
          }
        : {
            bookingRequestId: booking.id,
            paymentIntentId: intent.id,
            amountReceived: intent.amount_received ?? amountCents,
            paymentMethodId: pm.id,
          }
    );
    return {
      booked: true as const,
      processing: intent.status === "processing" ? (true as const) : undefined,
      amountCents,
      statusToken: booking.cancelToken ?? undefined,
      summary: summaryFor(stored, date, recurring),
    };
  }

  const customerId =
    booking.stripeCustomerId ??
    (
      await s.customers.create(
        {
          email: booking.email,
          name: booking.name,
          phone: booking.phone ?? undefined,
          metadata: { bookingRequestId: booking.id },
        },
        // GL-17: deterministic — overlapping attempts converge on ONE
        // provider customer.
        { idempotencyKey: `bk-cust-${booking.id}` }
      )
    ).id;
  // GL-17: generation-chained deterministic key — same prior attempt ⇒
  // same key ⇒ ONE intent even for overlapping creates; a replayed dead
  // generation advances instead of charging.
  const intent = await createConvergentIntent(s, {
    bookingId: booking.id,
    customerId,
    amountCents,
    description: `${stored.serviceLabel ?? "BuzzKill service"} — ${date}`,
    generation: booking.stripePaymentIntentId ?? "first",
  });

  // GL-17: the selection, amount, terms, capacity facts, and THIS intent's
  // authority land through the ONE fenced write — and the secret is
  // returned only on CONFIRMED persistence. A lost fence closes OUR
  // unreferenced intent and answers truthfully; an unsupported write
  // additionally releases the capacity claim (full compensation) or opens
  // confirmed Finance recovery.
  const persisted = await persistCheckoutAttempt({
    bookingId: booking.id,
    holderUntil,
    priorIntentId: booking.stripePaymentIntentId ?? null,
    sets: {
      // GL-06: a fresh payable intent resets the booking to QUOTED, clearing
      // any prior PAYMENT_FAILED so a retried attempt finalizes cleanly.
      status: "QUOTED",
      selectedDate: date,
      // GL-04: the checkout claim's slot facts survive the claim row — if
      // the hold expires before the payment lands, finalize re-reserves
      // from THESE instead of booking a visit that holds nothing.
      capacityTechnicianId: slot.technicianId,
      capacityMinutes: slot.claimMinutes,
      recurring,
      amountCents,
      ...promoSets,
      stripeCustomerId: customerId,
      stripePaymentIntentId: intent.id,
      // A new attempt clears the prior failure's reason and notice marker.
      paymentFailedReason: null,
      paymentFailedNoticeSentAt: null,
      // R17: the acceptance record. tcAcceptedAt is server time — a client
      // clock (or a client lie) never decides when the terms were accepted.
      tcVersion,
      tcAcceptedAt: new Date().toISOString(),
      tcIp: req.sourceIp || null,
      tcUserAgent: req.userAgent?.slice(0, 512) || null,
    },
  });
  if (!persisted.ok) {
    await settleUnpersistedIntent(
      client as unknown as { models: Record<string, unknown> },
      s,
      booking,
      intent.id,
      amountCents
    );
    if (persisted.reason === "LOST") {
      // The lifecycle moved (webhook, newer attempt) — its owner keeps its
      // capacity; only OUR (non-authoritative) intent needed closing.
      throw await truthfulCheckoutRefusal(client, booking.id);
    }
    // UNSUPPORTED: nothing durable recorded this attempt — give the claimed
    // slot back too, so a failed checkout leaks neither money nor capacity.
    await releaseCapacityClaim(booking.id).catch(() => undefined);
    throw new HttpError(503, {
      error:
        "We couldn't save your checkout — nothing was charged. Please try again in a moment.",
    });
  }

  return {
    clientSecret: intent.client_secret,
    amountCents,
    statusToken: booking.cancelToken ?? undefined,
    summary: summaryFor(stored, date, recurring),
  };
  }
}

function summaryFor(
  stored: {
    serviceLabel?: string;
    recurringOffer?: { frequency: string; monthlyCents: number } | null;
  },
  date: string,
  recurring: boolean
): string {
  return `${stored.serviceLabel ?? "Service visit"} — ${date}${
    recurring && stored.recurringOffer
      ? ` · then ${money(stored.recurringOffer.monthlyCents)}/mo ${stored.recurringOffer.frequency.toLowerCase()} plan`
      : ""
  }`;
}

// --------------------------------------------------------------- /cancel

// CANCEL_FULL_REFUND_DAYS lives in ../shared/bookingTerms — the single
// source shared with the checkout terms and the finalize email (R17).
const SUPPORT_PHONE = "(508) 258-9294";

async function cancel(body: Record<string, unknown>) {
  const token = String(body.token ?? "");
  if (!token) throw new HttpError(400, { error: "Missing token" });
  const client = await dataClient();
  const { data: matches } =
    await client.models.BookingRequest.listBookingRequestByCancelToken({
      cancelToken: token,
    });
  const booking = matches[0];
  // GL-06: a pending bank debit's commitment is cancelable exactly like a
  // paid one (its confirmation email carries this very link). The refund
  // rule is unchanged; only its mechanics differ — see pendingDebit below.
  const pendingDebit = booking?.status === "PROCESSING" && Boolean(booking.jobId);
  if (!booking || !(booking.status === "BOOKED" || pendingDebit)) {
    throw new HttpError(404, { error: "Booking not found or already canceled." });
  }

  // The shop-timezone calendar date, kept for the office alerts and the
  // reassurance copy (the customer reads a date, not a timestamp).
  const todayEt = new Date().toLocaleDateString("en-CA", {
    timeZone: "America/New_York",
  });
  // GL-08: the refund decision is HOUR-EXACT against the visit's Eastern
  // scheduled start (the shared cancellation policy, same maths the office and
  // plan cancel paths use). It is judged from the customer's FIRST cancellation
  // attempt: prefer the persisted instant; otherwise the earliest moment of the
  // persisted calendar date (customer-favorable — never later than the true
  // first attempt, so our outage can never move them across the 72-hour line);
  // and for a brand-new first attempt, now.
  const nowMs = Date.now();
  const judgedMs = booking.cancelRequestedAt
    ? Date.parse(booking.cancelRequestedAt)
    : booking.cancelRequestedOn
      ? easternEpochMs(booking.cancelRequestedOn, 0)
      : nowMs;
  // The instant the refund is judged from, and — on the first attempt — the
  // instant persisted so every later retry judges from exactly this moment.
  const safeJudgedMs = Number.isFinite(judgedMs) ? judgedMs : nowMs;
  const policy = computeVisitCancellationPolicy({
    scheduledDate: booking.selectedDate ?? null,
    amountPaidCents: booking.amountCents ?? 0,
    today: todayEt,
    nowMs: safeJudgedMs,
  });
  const refundable = policy.withinFreeWindow;

  if (body.confirm !== true) {
    return {
      booking: {
        service: booking.service,
        date: booking.selectedDate,
        amountCents: booking.amountCents,
      },
      refund: refundable
        ? { kind: "FULL", amountCents: booking.amountCents }
        : { kind: "NONE", amountCents: 0 },
      policy: `More than ${CANCEL_FULL_REFUND_DAYS} days before the visit = full refund; ${CANCEL_FULL_REFUND_DAYS} days or less = no refund.${
        pendingDebit
          ? refundable
            ? " Your bank payment is still processing — the refund completes to your bank account once it clears."
            : " Your bank payment is still processing and will complete; per the policy it is not refundable at this notice."
          : ""
      }`,
    };
  }

  // Stamp the attempt before anything that can fail. This is what makes a
  // retry safe for the customer: if Stripe is down today and they succeed
  // tomorrow, the persisted instant still reads NOW and they keep the refund
  // the hour-exact rule gave them at this moment.
  //
  // The write is guarded because it is the thing that protects the refund, and
  // an unguarded failure here would fall through to the generic "please try
  // again" — no instant recorded, nobody told, and the day-three retry silently
  // loses the refund this whole mechanism exists to preserve. Amplify resolves
  // errors rather than throwing them, so both shapes have to be handled.
  const requestedOn = booking.cancelRequestedOn ?? todayEt;
  // The authoritative anchor is the instant; a legacy row carrying only the
  // date is topped up with the customer-favorable derived instant (safeJudgedMs)
  // so it never re-dates later to the row's disadvantage.
  let datePersisted = Boolean(booking.cancelRequestedAt);
  if (!datePersisted) {
    try {
      const { data, errors } = await client.models.BookingRequest.update({
        id: booking.id,
        cancelRequestedOn: booking.cancelRequestedOn ?? todayEt,
        cancelRequestedAt: new Date(safeJudgedMs).toISOString(),
      });
      datePersisted = Boolean(data) && !errors?.length;
      if (!datePersisted) {
        console.error(
          `cancel: could not record cancelRequestedAt for booking ${booking.id}`,
          errors
        );
      }
    } catch (err) {
      console.error(
        `cancel: could not record cancelRequestedAt for booking ${booking.id}`,
        err
      );
    }
  }
  // Deliberately not fatal. This attempt's refund decision was already made
  // from the instant above, so a customer whose cancellation succeeds is
  // unaffected — the anchor only matters to a later retry. If the cancellation
  // below also fails, its alert carries the date and says it was not saved.

  // The visit's REAL state gates everything money-shaped: a completed
  // (billed, legally reported) or underway visit is never cancelable from
  // the emailed link, and that refusal comes BEFORE the plan cancel and the
  // refund. It also comes AFTER the attempt date was stamped — a refusal or
  // read fault today must not cost the customer the refund their FIRST
  // attempt was entitled to when they retry.
  if (booking.jobId) {
    const { data: gateJob, errors: gateErrors } = await client.models.Job.get({
      id: booking.jobId,
    });
    if (gateErrors?.length) {
      // FAIL CLOSED before any money moves: an unverifiable visit state must
      // not be refunded on hope. When the attempt-date stamp ALSO failed,
      // the date must survive somewhere a human can honor it — the office
      // alert carries it, and the customer is never told it was saved when
      // it wasn't.
      if (!datePersisted) {
        await notifyOffice({
          subject: `Cancellation attempt date NOT saved: booking ${booking.id}`,
          heading: "A cancel attempt failed with its date unrecorded",
          template: "ops-cancel-date-unsaved",
          customerId: booking.customerId ?? undefined,
          relatedId: booking.id,
          bodyHtml: `<p>The customer tried to cancel booking ${booking.id} on ${requestedOn} and our side failed twice: the visit state couldn't be read AND the attempt date couldn't be stamped. If they retry after ${requestedOn}, judge their refund from ${requestedOn}${refundable ? " — they were inside the full-refund window" : ""}.</p>`,
        }).catch(() => undefined);
      }
      throw new HttpError(503, {
        error: `We couldn't check your visit just now — nothing was changed. Please try again in a moment, or call us at ${SUPPORT_PHONE}.`,
        cancellationRecordedOn: requestedOn,
        reassurance: datePersisted
          ? `We've recorded that you asked to cancel on ${requestedOn}${refundable ? ", so your full refund still applies even though this didn't go through" : ""}.`
          : `Your cancellation request counts from ${requestedOn}${refundable ? " and your full refund still applies" : ""} — we've alerted our office so it isn't lost, but please mention this date if you call.`,
      });
    }
    if (
      gateJob &&
      gateJob.status !== "SCHEDULED" &&
      gateJob.status !== "UNSCHEDULED" &&
      gateJob.status !== "CANCELED"
    ) {
      throw new HttpError(409, {
        error:
          gateJob.status === "IN_PROGRESS"
            ? `Your technician is already on this visit — call us at ${SUPPORT_PHONE} and we'll help right away.`
            : `This visit has already taken place, so it can't be canceled online — if something's wrong, call us at ${SUPPORT_PHONE}.`,
      });
    }
  }

  try {
    // Stop the recurring billing BEFORE anything else and before we tell the
    // customer they are cancelled. GL-08: this goes through the SAME durable
    // cancellation command as the portal — single-winner claim, exclusive
    // lease, phase tracking, settlement, and recovery — never a bare engine
    // call that could race a portal cancel/resume of the same plan. A PENDING
    // outcome means the command owns it and will finish; the customer's visit
    // cancel below still proceeds.
    if (booking.servicePlanId) {
      await cancelPlanForCustomer(
        await stripeClient(),
        booking.servicePlanId,
        { reason: "Canceled from the booking cancellation link" }
      );
    }
    if (refundable && booking.stripePaymentIntentId) {
      const s = await stripeClient();
      // Keyed on the booking so a retry after a partial failure refunds once.
      // GL-06: for a still-processing bank debit Stripe queues the refund and
      // executes it after settlement — refund-to-original-method either way.
      // If the debit later FAILS, Stripe cancels the queued refund itself
      // (nothing to give back), and the failure webhook finds the booking
      // already CANCELED and changes nothing.
      await s.refunds.create(
        { payment_intent: booking.stripePaymentIntentId },
        { idempotencyKey: `booking-refund-${booking.id}` }
      );
    }
    if (pendingDebit && refundable) {
      // The pending ledger row nets to zero (debit + queued refund) — VOID it
      // conditionally so it never lingers as owed.
      await casGuardedUpdate(
        "Invoice",
        `booking-${booking.id}`,
        { status: "VOID", pendingDebitIntentId: null },
        [{ kind: "fieldEquals", field: "status", value: "OPEN" }]
      );
    }
    // A NON-refundable pending cancel keeps its OPEN invoice: the debit will
    // settle and finalizeBooking's canceled-booking gate applies it exactly
    // once — the nonrefundable amount is genuinely owed.
  } catch (err) {
    // The billing is still live and the appointment still stands. Say so —
    // "please try again" is false when the outage is ours, and retrying into a
    // Stripe outage just burns the customer's refund window.
    console.error(`cancel failed for booking ${booking.id}`, err);
    await openOwnedWork({
      kind: "PAID_VISIT_CANCELLATION",
      dedupeKey: `failed-cancel:${booking.id}`,
      title: `Finish paid cancellation: ${booking.name}`,
      detail: `${booking.name} asked to cancel the ${String(booking.selectedDate)} paid visit on ${requestedOn}, but billing/refund cancellation failed: ${err instanceof Error ? err.message : String(err)}.${refundable ? ` Honor the full ${money(booking.amountCents ?? 0)} refund.` : ""}`,
      customerId: booking.customerId,
      relatedId: booking.id,
      sourceUrl: booking.customerId ? `/customers/${booking.customerId}` : "/schedule",
      resolutionAction:
        "Stop any live billing, cancel the visit, issue the refund owed as of the original request date, and confirm completion to the customer.",
      ownerTeam: "FINANCE",
    });
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
           : `<p style="color:#b91c1c;"><strong>That date is not saved on the booking</strong> — it is preserved on the owned cancellation work item as well as this alert. If they retry after ${escapeHtml(requestedOn)} the system will judge their refund by the later date, so handle it from the work queue.</p>`
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
    // A funnel cancel is a CANCEL publisher like every other: guarded on the
    // snapshot it read, clearing the capacity stamps in the same write, then
    // giving the held slot (or pool) minutes and the seasonal month back
    // from the pre-update row. One re-read retry absorbs a concurrent office
    // move; a second loss falls to the owned cancellation work the caller
    // already records.
    let jobCancelSettled = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      const { data: cancelJob, errors: cancelJobErrors } =
        await client.models.Job.get({ id: booking.jobId });
      if (cancelJobErrors?.length) {
        // A failed READ is not a missing job — retry once; a second failure
        // falls through to the owned-recovery case below rather than telling
        // a canceled story over a live visit.
        continue;
      }
      if (!cancelJob || cancelJob.status === "CANCELED") {
        jobCancelSettled = true;
        break;
      }
      // The visit started or finished BETWEEN the up-front gate and here —
      // the money already moved, so this is a Finance conflict to OWN, never
      // a thrown error that would wedge the booking BOOKED with a refund
      // out and nobody told. The terminal record stands untouched.
      if (cancelJob.status !== "SCHEDULED" && cancelJob.status !== "UNSCHEDULED") {
        const conflictCase = await openOwnedWork({
          kind: "VISIT_CHANGE_RECOVERY",
          dedupeKey: `completed-after-cancel:${booking.jobId}`,
          title: `A customer's cancel crossed the visit being performed: ${booking.name ?? booking.email ?? booking.id}`,
          detail: `While booking ${booking.id}'s cancellation was processing${refundable ? " (full refund issued)" : ""}, visit ${booking.jobId} went ${cancelJob.status}. The visit record stands. Reconcile the money: a refund may have been issued for work that was performed.`,
          customerId: booking.customerId ?? undefined,
          relatedId: booking.jobId,
          sourceUrl: booking.customerId
            ? `/customers/${booking.customerId}`
            : `/schedule`,
          resolutionAction:
            "Compare the refund against the visit's recorded outcome and settle the invoice one way — then close this.",
          ownerTeam: "FINANCE",
        }).catch(() => null);
        if (!conflictCase) {
          // No durable case: page the office urgently — a refund issued for
          // performed work must never disappear into a console log.
          await notifyOffice({
            subject: `URGENT — refund may conflict with a performed visit: booking ${booking.id}`,
            heading: "A cancellation's refund crossed the visit being performed",
            template: "ops-funnel-cancel-conflict",
            customerId: booking.customerId ?? undefined,
            relatedId: booking.jobId,
            bodyHtml: `<p>Booking ${booking.id}'s cancellation${refundable ? " issued a full refund" : ""} while visit ${booking.jobId} went ${cancelJob.status}, and the Finance case could not be written. Reconcile the money now.</p>`,
          }).catch(() => undefined);
        }
        jobCancelSettled = true;
        break;
      }
      const published = await casGuardedUpdate(
        "Job",
        booking.jobId,
        {
          status: "CANCELED",
          routeId: null,
          routeOrder: null,
          technicianId: null,
          capacityMinutes: null,
          capacityTechnicianId: null,
        },
        jobScheduleGuards(cancelJob)
      );
      if (!published.ok) {
        if (published.reason === "UNSUPPORTED") break;
        continue; // lost to a concurrent move — re-read and retry once
      }
      await releaseJobCapacity(cancelJob);
      if (cancelJob.servicePlanId && cancelJob.scheduledDate) {
        await releaseMonthForJob({
          servicePlanId: cancelJob.servicePlanId,
          monthKey: cancelJob.scheduledDate.slice(0, 7),
          jobId: cancelJob.id,
          note: "Visit canceled by the customer — the month is owed again.",
        }).catch(() => undefined);
      }
      jobCancelSettled = true;
      break;
    }
    if (!jobCancelSettled) {
      // The money already moved and the customer's cancellation is accepted —
      // but the visit row could not be flipped. That schedule cleanup is now
      // OWNED work; a case that can't be written pages the office urgently so
      // a live visit never hides behind a "canceled" story.
      const caseId = await openOwnedWork({
        kind: "VISIT_CHANGE_RECOVERY",
        dedupeKey: `visit-change:${booking.jobId}`,
        title: `Finish canceling a customer-canceled visit: ${booking.name ?? booking.email ?? booking.id}`,
        detail: `The customer canceled booking ${booking.id} from their emailed link${refundable ? " and the full refund was issued" : ""}, but visit ${booking.jobId} could not be flipped to CANCELED (concurrent schedule change or lock-store fault). Cancel the visit from the customer screen — it must not dispatch.`,
        customerId: booking.customerId ?? undefined,
        relatedId: booking.jobId,
        sourceUrl: booking.customerId ? `/customers/${booking.customerId}` : `/schedule`,
        resolutionAction:
          "Cancel this visit from the CRM (the customer's refund decision is already applied), then close this.",
        ownerTeam: "OPS",
      }).catch(() => null);
      if (!caseId) {
        await notifyOffice({
          subject: `URGENT — customer-canceled visit still live: booking ${booking.id}`,
          heading: "A canceled booking's visit could not be taken off the schedule",
          template: "ops-funnel-cancel-unfinished",
          customerId: booking.customerId ?? undefined,
          relatedId: booking.jobId,
          bodyHtml: `<p>The customer canceled booking ${booking.id}${refundable ? " with a full refund issued" : ""}, but job ${booking.jobId} is still live and the recovery case could not be written. Cancel the visit now.</p>`,
        }).catch(() => undefined);
      }
    }
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
