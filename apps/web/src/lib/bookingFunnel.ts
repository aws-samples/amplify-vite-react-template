/**
 * Pure logic for the instant-quote booking funnel — everything here is
 * side-effect free (storage is injected) so it can be unit-tested without
 * a DOM. The validation rules deliberately MIRROR the server's
 * (`booking-public/handler.ts` `quote()`): the client catches what it can
 * so the 400 `{errors}` path is rare, but the server stays the authority.
 */

import type {
  PricedQuote,
  RecurringFrequency,
  ServiceCode,
  WindowCode,
} from "./bookingApi";

// ── Service catalog ─────────────────────────────────────────────────

export type ServiceOption = {
  code: ServiceCode;
  label: string;
  needsSqft: boolean;
  needsNestCount: boolean;
  offersRecurring: boolean;
};

export const SERVICE_OPTIONS: ServiceOption[] = [
  { code: "GENERAL_PEST", label: "General pest control", needsSqft: true, needsNestCount: false, offersRecurring: true },
  { code: "WASP_NEST", label: "Wasp / hornet nest removal", needsSqft: false, needsNestCount: true, offersRecurring: false },
  { code: "RODENT", label: "Rodent treatment", needsSqft: true, needsNestCount: false, offersRecurring: false },
  { code: "ROACH", label: "Roach treatment", needsSqft: true, needsNestCount: false, offersRecurring: false },
  { code: "TERMITE", label: "Termite inspection & treatment", needsSqft: false, needsNestCount: false, offersRecurring: false },
  { code: "WILDLIFE", label: "Wildlife removal", needsSqft: false, needsNestCount: false, offersRecurring: false },
];

export function serviceOption(code: string): ServiceOption | undefined {
  return SERVICE_OPTIONS.find((s) => s.code === code);
}

export const FREQUENCY_LABELS: Record<RecurringFrequency, string> = {
  MONTHLY: "Monthly",
  BIMONTHLY: "Every 2 months",
  QUARTERLY: "Quarterly",
};

// ── Formatting ──────────────────────────────────────────────────────

/** Same shape as the server's `money()`: whole dollars stay whole. */
export function money(cents: number): string {
  const d = cents / 100;
  return Number.isInteger(d) ? `$${d}` : `$${d.toFixed(2)}`;
}

export function windowLabel(window: string): string {
  if (window === "MORNING") return "Morning";
  if (window === "AFTERNOON") return "Afternoon";
  return window;
}

/**
 * "2026-07-21" → "Tue, Jul 21". Parsed as LOCAL date parts — `new
 * Date("2026-07-21")` is UTC midnight and renders as the previous day in
 * every US timezone.
 */
export function formatDay(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) return isoDate;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/** "WASP_NEST" → "wasp nest" — for /cancel, where service is the raw enum. */
export function humanizeServiceEnum(service: string): string {
  const known = serviceOption(service);
  if (known) return known.label;
  return service.toLowerCase().replace(/_/g, " ");
}

// ── Client-side validation (mirrors booking-public/handler.ts) ──────

/** Same pattern the server enforces (AWSEmail compatibility). */
export const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+$/;

/** E.164-ish normalization; null when the input can't be salvaged. */
export function normalizePhone(raw: string | undefined): string | null {
  const digits = (raw ?? "").replace(/[^\d+]/g, "");
  if (!digits) return null;
  if (/^\d{10}$/.test(digits)) return `+1${digits}`;
  if (/^1\d{10}$/.test(digits)) return `+${digits}`;
  if (/^\+\d{10,15}$/.test(digits)) return digits;
  return null;
}

export const SQFT_MIN = 100;
export const SQFT_MAX = 50000;

export type QuoteFormFields = {
  name: string;
  email: string;
  phone: string;
  service: string;
  street: string;
  city: string;
  state: string;
  zip: string;
  sqft: string;
  nestCount: string;
};

/**
 * Field-keyed errors, using the SAME keys the server's 400 `{errors}`
 * payload uses (`address.street` etc.) so both render through one path.
 */
export function validateQuoteForm(f: QuoteFormFields): Record<string, string> {
  const errors: Record<string, string> = {};
  const svc = serviceOption(f.service);
  if (!f.name.trim()) errors.name = "Name is required";
  if (!EMAIL_RE.test(f.email.trim().toLowerCase()))
    errors.email = "A valid email is required";
  if (f.phone.trim() && !normalizePhone(f.phone))
    errors.phone = "Enter a valid phone number, e.g. (413) 555-0123";
  if (!svc) errors.service = "Choose a service";
  if (!f.street.trim()) errors["address.street"] = "Street address is required";
  if (!f.city.trim()) errors["address.city"] = "City is required";
  if (!f.state.trim()) errors["address.state"] = "State is required";
  if (svc?.needsSqft) {
    const sqft = parseInt(f.sqft, 10);
    if (!sqft || sqft < SQFT_MIN || sqft > SQFT_MAX) {
      errors.sqft = `Square footage between ${SQFT_MIN} and ${SQFT_MAX.toLocaleString()} is required for this service`;
    }
  }
  if (svc?.needsNestCount) {
    const nests = parseInt(f.nestCount, 10);
    if (!nests || nests < 1) errors.nestCount = "How many nests need removal?";
  }
  return errors;
}

// ── Quote expiry ────────────────────────────────────────────────────

export function isQuoteExpired(expiresAt: string, now: number = Date.now()): boolean {
  const t = Date.parse(expiresAt);
  return Number.isFinite(t) ? t < now : true;
}

// ── sessionStorage codec ────────────────────────────────────────────
//
// The PRICED quote plus the visitor's day/window/plan selection survive a
// refresh (and the Stripe redirect round-trip) via sessionStorage. The codec
// is defensive: anything that doesn't decode back to the expected shape is
// treated as absent, never thrown.

export type FunnelSelection = {
  date: string;
  window: WindowCode;
  recurring: boolean;
};

export type FunnelState = {
  quote: PricedQuote;
  selection?: FunnelSelection;
};

export const FUNNEL_STORAGE_KEY = "bk_booking_funnel";

/** Minimal Storage surface so tests can inject a plain object. */
export type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export function encodeFunnelState(state: FunnelState): string {
  return JSON.stringify(state);
}

export function decodeFunnelState(raw: string | null): FunnelState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as FunnelState;
    const q = parsed?.quote;
    if (
      !q ||
      q.decision !== "PRICED" ||
      typeof q.bookingId !== "string" ||
      typeof q.expiresAt !== "string" ||
      !Array.isArray(q.days)
    ) {
      return null;
    }
    const sel = parsed.selection;
    if (sel) {
      if (
        typeof sel.date !== "string" ||
        (sel.window !== "MORNING" && sel.window !== "AFTERNOON") ||
        typeof sel.recurring !== "boolean"
      ) {
        return { quote: q };
      }
    }
    return parsed;
  } catch {
    return null;
  }
}

export function saveFunnelState(storage: StorageLike, state: FunnelState): void {
  try {
    storage.setItem(FUNNEL_STORAGE_KEY, encodeFunnelState(state));
  } catch {
    // Private-mode / storage-disabled browsers can still book in one sitting.
  }
}

export function loadFunnelState(storage: StorageLike): FunnelState | null {
  try {
    return decodeFunnelState(storage.getItem(FUNNEL_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function clearFunnelState(storage: StorageLike): void {
  try {
    storage.removeItem(FUNNEL_STORAGE_KEY);
  } catch {
    // nothing to clear
  }
}

// ── Amount due ──────────────────────────────────────────────────────

/**
 * What the customer pays TODAY for a given selection — the same rule the
 * server applies in `/book`: recurring pays the plan's initial fee, one-time
 * pays the selected day's price.
 */
export function amountDueCents(
  quote: PricedQuote,
  selection: FunnelSelection
): number | null {
  if (selection.recurring) {
    return quote.recurringOffer?.initialFeeCents ?? null;
  }
  const day = quote.days.find((d) => d.date === selection.date);
  return day ? day.priceCents : null;
}
