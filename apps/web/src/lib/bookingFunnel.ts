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
  RecurringOffer,
  ServiceCode,
} from "./bookingApi";
import { funnelCatalog } from "../../amplify/functions/shared/serviceCatalog";

// ── Service catalog ─────────────────────────────────────────────────

export type ServiceOption = {
  code: ServiceCode;
  label: string;
  needsSqft: boolean;
  needsNestCount: boolean;
  offersRecurring: boolean;
  /** Which cadences this service actually sells. A service may offer only some
   *  (rodent sells a quarterly program and nothing else), so the funnel must
   *  render THIS list rather than assume all three. */
  cadences: RecurringFrequency[];
  /** GL-17: Apr–Oct treatment plan billed monthly year-round. */
  seasonal: boolean;
};

// GL-01: the dropdown derives from the ONE versioned service catalog — the
// funnel can never offer a service the catalog cannot price, staff, and
// document. (serviceCatalog is a pure data module; nothing AWS ships here.)
export const SERVICE_OPTIONS: ServiceOption[] = funnelCatalog().map((e) => ({
  code: e.id as ServiceCode,
  label: e.funnelLabel ?? e.label,
  needsSqft: e.needsSqft,
  needsNestCount: e.needsNestCount,
  offersRecurring: e.offersRecurring,
  cadences: e.cadences as RecurringFrequency[],
  seasonal: e.seasonal,
}));

/** Sentinel for the freeform "tell us what you need" path. */
export const DESCRIBE_SERVICE = "__DESCRIBE__";

export function serviceOption(code: string): ServiceOption | undefined {
  return SERVICE_OPTIONS.find((s) => s.code === code);
}

/**
 * Which extra inputs a quote needs, by service AND property kind — the
 * property kind can override the service's own needs:
 *
 * - COMMUNITY: every service is a common-area plan quote priced per unit,
 *   so the unit count is required and sqft/nest count are not collected.
 * - COMMERCIAL: every service prices from the sqft-banded commercial rate
 *   sheet (one-time + plans, like residential general pest), so sqft is
 *   required and nest count is not collected.
 * - RESIDENTIAL: the service's own needs stand.
 */
export type QuoteFieldNeeds = {
  sqft: boolean;
  nestCount: boolean;
  units: boolean;
  /** WILDLIFE: what needs removed + how many (the count sets the price). */
  removalKind: boolean;
  removalCount: boolean;
  /** GL-17: mosquito plans price on yard size (half-acres). */
  lotHalfAcres: boolean;
};

const NO_NEEDS: QuoteFieldNeeds = {
  sqft: false,
  nestCount: false,
  units: false,
  removalKind: false,
  removalCount: false,
  lotHalfAcres: false,
};

export function quoteFieldNeeds(
  service: string,
  propertyKind: string,
  /** Condo/HOA only: one unit, treated on its own. It prices like a residential
   *  visit, so it collects the RESIDENTIAL inputs (sqft) — never the unit count,
   *  which only sets the price of a whole-property common-area program. */
  inUnit = false
): QuoteFieldNeeds {
  // "Tell us what you need": the description supplies the service AND the size,
  // so the structured size inputs are not collected — the server reads them out
  // of the text and validates the result exactly as if they had been typed.
  if (service === DESCRIBE_SERVICE) return NO_NEEDS;
  const svc = serviceOption(service);
  // GL-17: a seasonal plan prices on yard size alone at ANY property kind —
  // the community/commercial overrides don't apply.
  if (svc?.seasonal) {
    return { ...NO_NEEDS, lotHalfAcres: true };
  }
  // Nest removal (by nest count) and wildlife (by animal type + count) are
  // priced by the SERVICE at every property class — the community/commercial
  // sqft/units overrides below don't apply to them.
  if (service === "WASP_NEST") {
    return { ...NO_NEEDS, nestCount: true };
  }
  if (service === "WILDLIFE") {
    return { ...NO_NEEDS, removalKind: true, removalCount: true };
  }
  if (propertyKind === "COMMUNITY" && !inUnit) {
    return { ...NO_NEEDS, units: true };
  }
  if (propertyKind === "COMMUNITY" && inUnit) {
    // Quoted as residential: the service's own inputs stand.
    const svc2 = serviceOption(service);
    return {
      ...NO_NEEDS,
      sqft: svc2?.needsSqft ?? false,
      nestCount: svc2?.needsNestCount ?? false,
    };
  }
  if (propertyKind === "COMMERCIAL") {
    return { ...NO_NEEDS, sqft: true };
  }
  return {
    ...NO_NEEDS,
    sqft: svc?.needsSqft ?? false,
    nestCount: svc?.needsNestCount ?? false,
  };
}

export const FREQUENCY_LABELS: Record<RecurringFrequency, string> = {
  MONTHLY: "Monthly",
  BIMONTHLY: "Every 2 months",
  QUARTERLY: "Quarterly",
};

// ── Formatting ──────────────────────────────────────────────────────

/** The shared formatter — the funnel prints the same string the agreement
 *  PDF and the receipt email do. Imported as well as re-exported: this module
 *  formats prices itself, a few lines down. */
export { formatMoney as money } from "../../amplify/functions/shared/money";
import { formatMoney as money } from "../../amplify/functions/shared/money";

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

/**
 * The money line for a plan-only (community/HOA) quote, where the plan's
 * initial fee IS the first month's total. Rendered on the quote's plan
 * card; it must stay consistent with the checkout terms, which say
 * today's charge is the plan's initial fee and the subscription starts
 * after the first completed visit.
 */
export function hoaMoneyLine(offer: RecurringOffer): string {
  return `Your first month (${money(offer.initialFeeCents)}) is charged today to lock in your first visit, then ${money(offer.monthlyCents)}/mo.`;
}

/** True only when this quote carries the plan cadence the visitor explicitly
 *  requested. Kept pure so async/resumed quote presentation cannot fall back
 *  to a component's empty initial form state. */
export function hasRequestedPlan(quote: PricedQuote): boolean {
  return Boolean(
    quote.requestedFrequency &&
      quote.recurringOffer &&
      quote.recurringOffer.frequency === quote.requestedFrequency
  );
}

export function defaultQuoteChoice(quote: PricedQuote): "ONE_TIME" | "PLAN" {
  return quote.planOnly || hasRequestedPlan(quote) ? "PLAN" : "ONE_TIME";
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
  propertyKind: string;
  /** Condo/HOA only: this ask is for ONE unit, quoted like a residential visit. */
  inUnit?: boolean;
  /** Freeform "tell us what you need" text, when that path is chosen. */
  describe?: string;
  street: string;
  city: string;
  state: string;
  zip: string;
  sqft: string;
  nestCount: string;
  removalKind: string;
  removalCount: string;
  units: string;
};

/**
 * Field-keyed errors, using the SAME keys the server's 400 `{errors}`
 * payload uses (`address.street` etc.) so both render through one path.
 */
export function validateQuoteForm(f: QuoteFormFields): Record<string, string> {
  const errors: Record<string, string> = {};
  const svc = serviceOption(f.service);
  const needs = quoteFieldNeeds(f.service, f.propertyKind, f.inUnit);
  if (f.service === DESCRIBE_SERVICE && !(f.describe ?? "").trim()) {
    errors.describe = "Tell us what you need and we'll price it.";
  }
  if (!f.name.trim()) errors.name = "Name is required";
  if (!EMAIL_RE.test(f.email.trim().toLowerCase()))
    errors.email = "A valid email is required";
  if (f.phone.trim() && !normalizePhone(f.phone))
    errors.phone = "Enter a valid phone number, e.g. (413) 555-0123";
  if (!svc) errors.service = "Choose a service";
  if (!f.street.trim()) errors["address.street"] = "Street address is required";
  if (!f.city.trim()) errors["address.city"] = "City is required";
  if (!f.state.trim()) errors["address.state"] = "State is required";
  if (needs.sqft) {
    const sqft = parseInt(f.sqft, 10);
    if (!sqft || sqft < SQFT_MIN || sqft > SQFT_MAX) {
      errors.sqft = `Square footage between ${SQFT_MIN} and ${SQFT_MAX.toLocaleString()} is required for this service`;
    }
  }
  if (needs.nestCount) {
    const nests = parseInt(f.nestCount, 10);
    if (!nests || nests < 1) errors.nestCount = "How many nests need removal?";
  }
  if (needs.removalKind && !f.removalKind.trim()) {
    errors.removalKind = "What needs to be removed?";
  }
  if (needs.removalCount) {
    const count = parseInt(f.removalCount, 10);
    if (!count || count < 1) errors.removalCount = "How many animals need removal?";
  }
  if (needs.units) {
    const units = parseInt(f.units, 10);
    if (!units || units < 1) {
      errors.units =
        "How many units are in the community? The unit count sets the plan price.";
    }
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
// The PRICED quote plus the visitor's day/plan selection survive a refresh
// (and the Stripe redirect round-trip) via sessionStorage. The codec is
// defensive: anything that doesn't decode back to the expected shape is
// treated as absent, never thrown.

export type FunnelSelection = {
  /** null on a GL-17 off-season enrollment (no day board existed). */
  date: string | null;
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
      // Date-less selections are valid ONLY for an off-season enrollment —
      // anything else with a null day cannot price and is treated as absent.
      const dateOk =
        typeof sel.date === "string" ||
        (sel.date === null && q.offSeason === true);
      if (!dateOk || typeof sel.recurring !== "boolean") {
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
