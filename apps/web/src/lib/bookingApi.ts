/**
 * Typed client for the public booking funnel API (`booking-public` Function
 * URL). Mirrors `leadIntake.ts`:
 *
 * Order of URL resolution:
 *   1. `VITE_BOOKING_API_URL` env var (set in `.env.local` or Amplify Hosting)
 *   2. `amplify_outputs.json` — `backend.addOutput({ custom: { bookingApiUrl } })`
 *
 * Every caller returns a discriminated result and NEVER throws on an HTTP
 * error — the server's `error` / `errors` payloads are written for customers
 * and must be surfaced verbatim, so they ride along on the `ok: false` arm.
 */

import { readAttribution, type Attribution } from "./leadIntake";

let cached: string | null | undefined;

export async function getBookingApiUrl(): Promise<string | undefined> {
  if (cached !== undefined) return cached ?? undefined;

  const envUrl = import.meta.env.VITE_BOOKING_API_URL as string | undefined;
  if (typeof envUrl === "string" && envUrl.length > 0) {
    cached = envUrl;
    return envUrl;
  }

  // `import.meta.glob` is the only build-safe way to optionally include
  // a generated file. If `amplify_outputs.json` doesn't exist yet (fresh
  // clone, no sandbox run), the glob returns an empty object and we
  // fall through to undefined.
  const candidates = import.meta.glob<{
    custom?: { bookingApiUrl?: string };
  }>("/amplify_outputs.json", { import: "default" });
  const loader = candidates["/amplify_outputs.json"];
  if (loader) {
    try {
      const outputs = await loader();
      const url = outputs.custom?.bookingApiUrl;
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

// ── Wire types ───────────────────────────────────────────────────────

export type ServiceCode =
  | "GENERAL_PEST"
  | "WASP_NEST"
  | "RODENT"
  | "ROACH"
  | "TERMITE"
  | "WILDLIFE";

export type PropertyKind = "RESIDENTIAL" | "COMMUNITY" | "COMMERCIAL";
export type RecurringFrequency = "MONTHLY" | "BIMONTHLY" | "QUARTERLY";
export type WindowCode = "MORNING" | "AFTERNOON";

export type QuoteRequest = {
  name: string;
  email: string;
  phone?: string;
  /** The lead agreed to be called/texted about the quote (gates the call
   *  fallback — without it, a review quote promises an email, not a call). */
  callConsent?: boolean;
  /** GL-03: which consent wording they agreed to (shared/consentText.ts). */
  callConsentTextVersion?: string;
  /** GL-17: yard size for mosquito plans, in half-acres (1–8). */
  lotHalfAcres?: number;
  service: ServiceCode;
  propertyKind?: PropertyKind;
  address: { street: string; city: string; state: string; zip?: string };
  sqft?: number;
  nestCount?: number;
  /** Unit count — required when propertyKind is COMMUNITY (per-unit plan). */
  units?: number;
  comments?: string;
  recurringPreference?: RecurringFrequency;
  botToken?: string;
  /**
   * First-touch ad attribution (see `lib/leadIntake.ts`). Optional — the
   * server never fails a quote over it; it just rides along so the
   * customer created at booking keeps their lead source.
   */
  attribution?: Attribution;
  /**
   * The lead identity carried by an office-sent booking link (?lead=<token>
   * on the funnel URL). Optional and best-effort like attribution — the
   * server resolves it silently so the paid booking converts exactly the
   * CRM lead the link was sent to, instead of guessing by email.
   */
  leadToken?: string;
};

export type QuoteDay = {
  date: string; // YYYY-MM-DD
  windows: WindowCode[];
  priceCents: number;
};

export type RecurringOffer = {
  frequency: RecurringFrequency;
  monthlyCents: number;
  initialFeeCents: number;
};

export type BookingTerms = { version: string; text: string };

export type PricedQuote = {
  bookingId: string;
  decision: "PRICED";
  service: string; // human label, e.g. "Wasp / hornet nest removal"
  recurringOffer: RecurringOffer | null;
  days: QuoteDay[];
  expiresAt: string;
  /** R17 — the checkout terms this quote was issued under. */
  terms?: BookingTerms;
  /**
   * Community/HOA quotes are plan-only: there is no one-time option, the
   * day board picks the FIRST visit, and today's charge is the plan's
   * initial fee (the first month's total). The client also stamps this
   * flag from the submitted property kind, so a server that omits it
   * still renders correctly.
   */
  planOnly?: boolean;
  /** GL-05: the customer token /booking-status authenticates with. */
  statusToken?: string;
};

export type ContactQuote = {
  bookingId: string;
  decision: "CONTACT";
  message: string;
};

export type PendingQuote = {
  bookingId: string;
  /** Opaque capability used only to poll this saved request. */
  statusToken: string;
  decision: "PENDING";
  stage: "RESEARCHING" | "BUILDING_AVAILABILITY";
  message: string;
};

/** GL-06 — a resumed quote whose booking already entered a payment state.
 *  The message is the durable truth (don't pay again / already booked /
 *  failed with a rebook path); the page shows it instead of a price board. */
export type PaymentStateQuote = {
  bookingId: string;
  decision: "PROCESSING" | "BOOKED" | "PAYMENT_FAILED";
  message: string;
  selectedDate?: string | null;
  selectedWindow?: string | null;
  amountCents?: number | null;
  reason?: string | null;
};

export type QuoteResponse =
  | PricedQuote
  | PendingQuote
  | ContactQuote
  | PaymentStateQuote;

export type BookRequest = {
  bookingId: string;
  date: string;
  window: WindowCode;
  recurring: boolean;
  tcAccepted: true;
  /** R17 — the exact terms version rendered above the pay button. */
  tcVersion: string;
};

export type BookResponse = {
  clientSecret: string;
  amountCents: number;
  summary: string;
  statusToken?: string;
};

export type CancelPreview = {
  booking: {
    service: string; // enum, e.g. "WASP_NEST"
    date: string;
    window: string;
    amountCents: number;
  };
  refund: { kind: "FULL" | "NONE"; amountCents: number };
  policy: string;
};

export type CancelConfirmed = { canceled: true; refunded: boolean };

/**
 * Every non-2xx (and network / config failure, as status 0) lands here.
 * The server writes `error` / `errors` for customers — render them verbatim.
 */
export type ApiErrorBody = {
  error?: string;
  errors?: Record<string, string>;
  /** 409 terms-changed: the current terms ride along so the UI can re-ask. */
  terms?: BookingTerms;
  /** /cancel 503: our-side failure, refund window preserved. */
  cancellationRecordedOn?: string;
  reassurance?: string;
};

export type ApiFailure = { ok: false; status: number; body: ApiErrorBody };
export type ApiResult<T> = { ok: true; status: number; body: T } | ApiFailure;

// ── Transport ────────────────────────────────────────────────────────

async function post<T>(path: string, payload: unknown): Promise<ApiResult<T>> {
  const base = await getBookingApiUrl();
  if (!base) {
    return {
      ok: false,
      status: 0,
      body: {
        error:
          "Online booking isn't configured on this deployment. Run `npx ampx sandbox` or set VITE_BOOKING_API_URL.",
      },
    };
  }

  let resp: Response;
  try {
    resp = await fetch(`${base.replace(/\/+$/, "")}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    return {
      ok: false,
      status: 0,
      body: {
        error:
          "We couldn't reach the booking service — check your connection and try again.",
      },
    };
  }

  let body: unknown;
  try {
    body = await resp.json();
  } catch {
    body = { error: `Server returned a non-JSON response (status ${resp.status})` };
  }

  if (resp.ok) {
    return { ok: true, status: resp.status, body: body as T };
  }
  return { ok: false, status: resp.status, body: (body ?? {}) as ApiErrorBody };
}

// ── Lead identity from the booking link ──────────────────────────────

const LEAD_TOKEN_KEY = "buzzkill.bookingLeadToken.v1";
const LEAD_TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;
/** Matches quote validity: a lead identity older than the longest-lived
 *  quote is more likely a stale office tab (a CSR who opened one lead's
 *  link, then reused the tab for a different caller) than the same person
 *  still shopping — and a stale identity converts the wrong record. */
const LEAD_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Stash the ?lead=<token> a booking link carried, for the session. Like the
 * quote-resume token, it is capability-shaped and gets stripped from the
 * address bar by the caller after capture. Storage-disabled browsers just
 * fall back to email matching at finalization.
 */
export function saveLeadToken(storage: Storage, token: string): boolean {
  if (!LEAD_TOKEN_RE.test(token)) return false;
  try {
    storage.setItem(
      LEAD_TOKEN_KEY,
      JSON.stringify({ token, at: Date.now() })
    );
    return true;
  } catch {
    return false;
  }
}

export function readLeadToken(
  storage: Storage | undefined = typeof window === "undefined"
    ? undefined
    : window.sessionStorage
): string | null {
  try {
    const raw = storage?.getItem(LEAD_TOKEN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { token?: unknown; at?: unknown };
    const token = typeof parsed.token === "string" ? parsed.token : null;
    const at = typeof parsed.at === "number" ? parsed.at : 0;
    if (!token || !LEAD_TOKEN_RE.test(token) || Date.now() - at > LEAD_TOKEN_TTL_MS) {
      storage?.removeItem(LEAD_TOKEN_KEY);
      return null;
    }
    return token;
  } catch {
    return null;
  }
}

// ── Callers ──────────────────────────────────────────────────────────

export function requestQuote(input: QuoteRequest): Promise<ApiResult<QuoteResponse>> {
  // First-touch attribution and the booking link's lead identity ride along
  // when the session has them, so the customer created at booking keeps
  // their lead source and the booking converts the exact CRM lead the link
  // was sent to. Both omitted entirely when absent (direct visits,
  // storage-disabled browsers).
  const attribution = readAttribution();
  const leadToken = readLeadToken();
  return post<QuoteResponse>("/quote", {
    ...input,
    ...(attribution ? { attribution } : {}),
    ...(leadToken ? { leadToken } : {}),
  });
}

/** Poll a previously accepted cold-cache quote without resubmitting PII. */
export function checkQuoteStatus(input: {
  bookingId: string;
  statusToken: string;
}): Promise<ApiResult<QuoteResponse>> {
  return post<QuoteResponse>("/quote-status", input);
}

export function bookVisit(input: BookRequest): Promise<ApiResult<BookResponse>> {
  return post<BookResponse>("/book", input);
}

/** Preview what canceling would do — no side effects. */
export function previewCancel(token: string): Promise<ApiResult<CancelPreview>> {
  return post<CancelPreview>("/cancel", { token });
}

/** Actually cancel (refund per policy). */
export function confirmCancel(token: string): Promise<ApiResult<CancelConfirmed>> {
  return post<CancelConfirmed>("/cancel", { token, confirm: true });
}


/** GL-05/GL-06 — the server-confirmed post-payment state. PROCESSING_SCHEDULED
 *  means the pending bank debit already created the real scheduled visit; the
 *  customer must not pay again and needs no further action. */
export type BookingStatusResponse = {
  bookingId: string;
  state:
    | "BOOKED"
    | "FINALIZING"
    | "RECOVERY"
    | "PAYMENT_FAILED"
    | "CANCELED"
    | "PROCESSING"
    | "PROCESSING_SCHEDULED";
  selectedDate?: string | null;
  selectedWindow?: string | null;
  amountCents?: number | null;
  email?: string | null;
  recurring?: boolean;
  message?: string;
  reason?: string;
  methodLabel?: string | null;
  expectedBy?: string | null;
};

export function checkBookingStatus(input: {
  bookingId: string;
  statusToken: string;
}): Promise<ApiResult<BookingStatusResponse>> {
  return post<BookingStatusResponse>("/booking-status", input);
}
