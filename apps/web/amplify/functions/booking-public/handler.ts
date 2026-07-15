import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { randomUUID } from "node:crypto";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import Stripe from "stripe";
import { dataClient } from "../shared/dataClient";
import { emailShell, sendEmail } from "../shared/email";
import { driveMinutesBetween, HQ_ADDRESS } from "../shared/driveTime";
import {
  priceResidential,
  priceSpecialty,
  zoneFromMinutes,
  money,
  type Zone,
} from "../crm-pricing/rateCards";
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

function corsHeaders(origin: string | undefined): Record<string, string> {
  const allowed =
    origin && (ALLOWED_ORIGINS.includes(origin) || ALLOWED_ORIGINS.length === 0)
      ? origin
      : (ALLOWED_ORIGINS[0] ?? "*");
  return {
    "Access-Control-Allow-Origin": allowed,
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
};

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
      return json(headers, await quote(body as QuoteInput));
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

async function quote(input: QuoteInput) {
  const errors: Record<string, string> = {};
  const name = (input.name ?? "").trim();
  const email = (input.email ?? "").trim().toLowerCase();
  const service = (input.service ?? "").toUpperCase();
  const propertyKind = (input.propertyKind ?? "RESIDENTIAL").toUpperCase();
  const addr = input.address ?? {};
  if (!name) errors.name = "Name is required";
  if (!/^\S+@\S+\.\S+$/.test(email)) errors.email = "A valid email is required";
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

  const client = await dataClient();
  const address = `${addr.street}, ${addr.city}, ${addr.state}${addr.zip ? ` ${addr.zip}` : ""}`;

  const makeBooking = async (fields: Record<string, unknown>) => {
    const { data: booking, errors: gqlErrors } =
      await client.models.BookingRequest.create({
        name,
        email,
        phone: input.phone?.trim() || undefined,
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

  const contact = async (message: string, extra: Record<string, unknown> = {}) => {
    const booking = await makeBooking({ status: "CONTACT", ...extra });
    await notifyOffice(
      "Website lead needs a call",
      `<p><strong>${name}</strong> (${email}${input.phone ? `, ${input.phone}` : ""}) asked about <strong>${service.toLowerCase().replace("_", " ")}</strong> at ${address}.</p>
       ${input.comments ? `<p>Comments: ${escapeHtml(input.comments)}</p>` : ""}
       <p>Booking request ${booking.id} — call within the hour per the website promise.</p>`
    );
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
  const priceZone: Zone = zone === "UNKNOWN" ? "B" : zone; // price safe, never block

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
      const anthropicKey = await getSecret("ANTHROPIC_API_KEY");
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
    const anthropicKey = await getSecret("ANTHROPIC_API_KEY");
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
  const customer = await s.customers.create({
    email: booking.email,
    name: booking.name,
    phone: booking.phone ?? undefined,
    metadata: { bookingRequestId: booking.id },
  });
  const intent = await s.paymentIntents.create({
    amount: amountCents,
    currency: "usd",
    customer: customer.id,
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
    stripeCustomerId: customer.id,
    stripePaymentIntentId: intent.id,
  });

  return {
    clientSecret: intent.client_secret,
    amountCents,
    summary: `${stored.serviceLabel ?? "Service visit"} — ${date}, ${window.toLowerCase()}${
      recurring
        ? ` · then ${money(stored.recurringOffer!.monthlyCents)}/mo ${stored.recurringOffer!.frequency.toLowerCase()} plan`
        : ""
    }`,
  };
}

// --------------------------------------------------------------- /cancel

const CANCEL_FULL_REFUND_DAYS = 3;

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

  const visitMs = new Date(`${booking.selectedDate}T12:00:00`).getTime();
  const daysOut = Math.floor((visitMs - Date.now()) / 86_400_000);
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

  if (refundable && booking.stripePaymentIntentId) {
    const s = await stripeClient();
    await s.refunds.create({ payment_intent: booking.stripePaymentIntentId });
  }
  if (booking.jobId) {
    await client.models.Job.update({
      id: booking.jobId,
      status: "CANCELED",
      routeId: null,
      routeOrder: null,
    });
  }
  if (booking.servicePlanId) {
    await client.models.ServicePlan.update({
      id: booking.servicePlanId,
      status: "CANCELED",
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
  await notifyOffice(
    "Website booking canceled",
    `<p><strong>${booking.name}</strong> canceled their ${booking.selectedDate} ${String(booking.service).toLowerCase()} visit. ${refundable ? "Full refund issued." : "No refund per policy."}</p>`
  );
  return { canceled: true, refunded: refundable };
}

// ---------------------------------------------------------------- utils

async function notifyOffice(subject: string, html: string) {
  const office = process.env.SES_NOTIFY_EMAIL;
  if (!office) return;
  await sendEmail({
    to: office,
    subject,
    template: "office-booking-alert",
    relatedId: "booking-funnel",
    html: emailShell(subject, html),
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
