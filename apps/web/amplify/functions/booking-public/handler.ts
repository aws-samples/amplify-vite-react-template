import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { randomUUID } from "node:crypto";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import Stripe from "stripe";
import { dataClient } from "../shared/dataClient";
import { emailShell, notifyOffice, sendEmail } from "../shared/email";
import { driveMinutesBetween, HQ_ADDRESS } from "../shared/driveTime";
import {
  priceResidential,
  priceSpecialty,
  zoneFromMinutes,
  money,
  ZONE_B,
  type Zone,
} from "../crm-pricing/rateCards";
import { cancelPlanBilling } from "../shared/subscription";
import { buildDayMatrix, type DayQuote } from "./availability";
import { marketRate, sqftBucket } from "./marketRate";

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

let stripe: Stripe | null = null;
async function stripeClient(): Promise<Stripe> {
  if (stripe) return stripe;
  const key = await getSecret("STRIPE_SECRET_KEY");
  if (!key) throw new Error("Stripe is not configured");
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
};

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
      return json(headers, await book(body));
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
 * token (enforced as soon as TURNSTILE_SECRET is configured), a best-effort
 * per-IP hourly cap, and a hard global ceiling on how many *new* AI market
 * researches can run per day. The endpoint spends real money per call
 * (Claude + web search + Google Routes), so nothing billed runs until these
 * pass.
 */
const QUOTES_PER_IP_PER_HOUR = 12;
const NEW_RESEARCH_PER_DAY = 25;

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

/** Global ceiling on brand-new (uncached) AI research runs per day. */
async function researchBudgetLeft(): Promise<boolean> {
  const client = await dataClient();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data } = await client.models.MarketRate.list({
    filter: { researchedAt: { gt: since } },
    limit: NEW_RESEARCH_PER_DAY + 1,
  });
  return data.length < NEW_RESEARCH_PER_DAY;
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
  if (!addr.street?.trim()) errors["address.street"] = "Street address is required";
  if (!addr.city?.trim()) errors["address.city"] = "City is required";
  if (!addr.state?.trim()) errors["address.state"] = "State is required";
  if (service === "GENERAL_PEST" || service === "RODENT" || service === "ROACH") {
    if (!input.sqft || input.sqft < 100 || input.sqft > 50000) {
      errors.sqft = "Square footage is required for this service";
    }
  }
  if (service === "WASP_NEST" && (!input.nestCount || input.nestCount < 1)) {
    errors.nestCount = "How many nests need removal?";
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
    await notifyOffice({
      subject: "Website lead needs a call",
      heading: "Website lead needs a call",
      template: "ops-booking-contact",
      relatedId: booking.id,
      bodyHtml: `<p><strong>${escapeHtml(name)}</strong> (${escapeHtml(email)}${input.phone ? `, ${escapeHtml(input.phone)}` : ""}) asked about <strong>${service.toLowerCase().replace("_", " ")}</strong> at ${escapeHtml(address)}.</p>
       ${input.comments ? `<p>Comments: ${escapeHtml(input.comments)}</p>` : ""}
       <p>Booking request ${booking.id} — call within the hour per the website promise.</p>
       ${opsNote}`,
    });
    return { bookingId: booking.id, decision: "CONTACT", message };
  };

  // Specialist-call paths: no instant price.
  if (service === "TERMITE" || service === "WILDLIFE") {
    return contact(
      "Thanks — a BuzzKill specialist will call you within the hour to talk through it and give you an exact price."
    );
  }
  if (propertyKind !== "RESIDENTIAL") {
    return contact(
      "Community and commercial properties get a custom walkthrough quote — a specialist will call you within the hour."
    );
  }

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

  // Deterministic base price.
  let baseCents: number | null = null;
  let serviceLabel = "";
  let recurringOffer: {
    frequency: string;
    monthlyCents: number;
    initialFeeCents: number;
  } | null = null;

  if (service === "GENERAL_PEST") {
    const oneTime = priceResidential({
      frequency: "ONE_TIME",
      sqft: input.sqft!,
      zone: priceZone,
    });
    baseCents = oneTime.oneTimeCents!;
    serviceLabel = "General pest control — one-time treatment";
    const freq = (["MONTHLY", "BIMONTHLY", "QUARTERLY"].includes(
      input.recurringPreference ?? ""
    )
      ? input.recurringPreference
      : "QUARTERLY") as "MONTHLY" | "BIMONTHLY" | "QUARTERLY";
    const plan = priceResidential({
      frequency: freq,
      sqft: input.sqft!,
      zone: priceZone,
    });
    recurringOffer = {
      frequency: freq,
      monthlyCents: plan.monthlyCents!,
      initialFeeCents: plan.initialFeeCents!,
    };
  } else if (service === "WASP_NEST") {
    const first = priceSpecialty("wasp_nest", priceZone)!;
    baseCents = first.oneTimeCents!;
    const extraNests = (input.nestCount ?? 1) - 1;
    if (extraNests > 0) {
      const anthropicKey = (await researchBudgetLeft())
        ? await getSecret("ANTHROPIC_API_KEY")
        : null;
      const extra = anthropicKey
        ? await marketRate({
            anthropicKey,
            service: "WASP_EXTRA_NEST",
            city: addr.city!,
            state: addr.state!,
          })
        : null;
      if (!extra) {
        return contact(
          "Multiple nests get a custom quote — a specialist will call you within the hour."
        );
      }
      baseCents += extra.priceCents * extraNests;
    }
    serviceLabel = `Wasp / hornet nest removal${(input.nestCount ?? 1) > 1 ? ` — ${input.nestCount} nests` : ""}`;
  } else {
    // RODENT / ROACH — AI-researched market rate for this area + size.
    const anthropicKey = (await researchBudgetLeft())
      ? await getSecret("ANTHROPIC_API_KEY")
      : null;
    const rate = anthropicKey
      ? await marketRate({
          anthropicKey,
          service: service as "RODENT" | "ROACH",
          city: addr.city!,
          state: addr.state!,
          sqft: input.sqft!,
        })
      : null;
    if (!rate) {
      return contact(
        "This one takes a quick look at local specifics — a specialist will call you within the hour with an exact price."
      );
    }
    baseCents = rate.priceCents;
    if (priceZone === "B") {
      // R60: market-rate services carry the same one-time Zone B travel
      // adder as the carded services — an 89-minute drive must not price
      // like a 10-minute one.
      baseCents += ZONE_B.ONE_TIME_FLAT;
    }
    serviceLabel =
      service === "RODENT"
        ? `Rodent treatment — up to ${sqftBucket(input.sqft!).toLocaleString()} sqft`
        : `Specialized roach treatment — up to ${sqftBucket(input.sqft!).toLocaleString()} sqft`;
  }

  // Day-priced availability from the live schedule.
  const days = await buildDayMatrix({
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

  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const booking = await makeBooking({
    status: "QUOTED",
    zone,
    driveMinutes: minutes ?? undefined,
    quoteJson: JSON.stringify({ days, baseCents, serviceLabel, recurringOffer }),
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
    oneTimePriceCents: baseCents,
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
    days: days.map(({ factors: _f, ...d }) => d),
    expiresAt,
  };
}

// ----------------------------------------------------------------- /book

async function book(body: Record<string, unknown>) {
  const bookingId = String(body.bookingId ?? "");
  const date = String(body.date ?? "");
  const window = String(body.window ?? "");
  const recurring = body.recurring === true;
  if (!body.tcAccepted) {
    throw new HttpError(400, {
      error: "Please accept the terms & cancellation policy to book.",
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
  };
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

const CANCEL_FULL_REFUND_DAYS = 3;
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
       <p>${refundable ? `A full refund of ${money(booking.amountCents ?? 0)} is on its way to your original payment method (3–5 business days).` : "Per the cancellation policy (3 days or less before the visit), this booking isn't refundable."}</p>`
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
