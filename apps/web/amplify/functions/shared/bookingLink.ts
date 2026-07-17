import { randomBytes } from "node:crypto";

/**
 * Booking-link lead identity.
 *
 * A booking link handed to a specific lead carries `?lead=<token>` so the
 * paid booking it produces converts exactly that CRM record. Matching by
 * email alone can convert the wrong duplicate, merge unrelated people who
 * share an inbox, or miss entirely when the checkout email differs — the
 * token makes conversion a fact instead of a guess.
 *
 * The token is a capability (it decides which record a payment converts and
 * where the portal grant lands), so it is unguessable and only ever resolved
 * server-side. It is NOT a secret worth rotating: it grants nothing to read.
 */

/** URL-safe and unguessable; short enough to survive email link wrapping. */
export function mintBookingLinkToken(): string {
  return randomBytes(24).toString("base64url");
}

/** Shape check before any lookup — reject junk without a table hit. */
export const BOOKING_LINK_TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

/** The funnel URL for a specific lead; the bare funnel when no token. */
export function bookingLinkUrl(
  funnelBase: string,
  token: string | null | undefined
): string {
  return token ? `${funnelBase}?lead=${token}` : funnelBase;
}

type CustomerSlice = {
  id: string;
  bookingLinkToken?: string | null;
};

/**
 * What ensureBookingLinkToken needs from the data client: just
 * `models.Customer.update`, whose result it only truthiness-checks. It is NOT
 * used as the parameter type below on purpose — see the `any` note there.
 */
export type BookingLinkDataClient = {
  models: {
    Customer: {
      update: (args: object) => Promise<{ data: unknown }>;
    };
  };
};

/**
 * The customer's booking-link token, minted on first use. Best-effort by
 * design: producing a link must never fail because a token could not be
 * written — a bare funnel URL still works, it just falls back to email
 * matching at finalization.
 */
// `client` is `any`, not BookingLinkDataClient, on purpose. Every caller passes
// the full Amplify V6Client (from dataClient()); structurally comparing that
// generated type against ANY concrete shape forces TypeScript to deep-
// instantiate it, which trips the instantiation-depth ceiling (TS2321) and
// cascades spurious "not assignable" errors across unrelated files on the
// smallest edit. BookingLinkDataClient above documents the real contract; this
// function only calls client.models.Customer.update.
export async function ensureBookingLinkToken(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  customer: CustomerSlice
): Promise<string | null> {
  if (customer.bookingLinkToken) return customer.bookingLinkToken;
  try {
    const token = mintBookingLinkToken();
    const { data } = await (client as BookingLinkDataClient).models.Customer.update({
      id: customer.id,
      bookingLinkToken: token,
    });
    return data ? token : null;
  } catch (err) {
    console.error(
      `ensureBookingLinkToken: could not mint for customer ${customer.id}`,
      err
    );
    return null;
  }
}
