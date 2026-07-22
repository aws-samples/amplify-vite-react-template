/**
 * Staff-entered discount codes for the public funnel.
 *
 * A code is created and managed OWNER-only in the CRM (the `PromoCode` model);
 * the customer (or a CSR driving the booking) types it on checkout. This
 * module is the single source of truth for two decisions the funnel makes:
 *
 *   1. resolvePromo — is this code real, active, in-window, and not used up?
 *   2. discountFor  — how many cents does it take off a given amount?
 *
 * Both `/promo` (the pre-pay preview) and `/book` (the authoritative charge)
 * call these, so a previewed discount and the charged discount can never
 * disagree. The value is snapshotted onto the BookingRequest at /book, so
 * editing or retiring the code later never re-prices a booking that used it.
 */
/**
 * The PromoCode row shape this module reads, and the one client method it
 * calls, declared STRUCTURALLY rather than derived from the generated Schema
 * on purpose: `tsc -p amplify` sits at TS's instantiation-depth ceiling, and
 * naming the full data-client type (or indexing its model types) here tips it
 * over (TS2321). The real IAM data client is structurally compatible and
 * passes straight in. Keep these fields in sync with the PromoCode model in
 * data/resource.ts.
 */
export type PromoRow = {
  id: string;
  code?: string | null;
  description?: string | null;
  kind?: "PERCENT" | "FIXED" | null;
  percentOff?: number | null;
  amountOffCents?: number | null;
  active?: boolean | null;
  startsAt?: string | null;
  endsAt?: string | null;
  maxRedemptions?: number | null;
  timesRedeemed?: number | null;
};

type Client = {
  models: {
    PromoCode: {
      listPromoCodeByCode: (input: {
        code: string;
      }) => Promise<{ data: PromoRow[] | null }>;
    };
  };
};

/** Stripe rejects a live card charge under 50¢. A code that would drop a CARD
 *  total below this is refused at /book (bill by invoice or use a smaller
 *  code) rather than minting an unchargeable PaymentIntent. */
export const STRIPE_MIN_CHARGE_CENTS = 50;

/** Codes are stored and compared UPPERCASE, so "save20" and "SAVE20" match. */
export function normalizeCode(raw: unknown): string {
  return String(raw ?? "")
    .trim()
    .toUpperCase();
}

export type PromoResolution =
  | { ok: true; promo: PromoRow }
  | { ok: false; message: string };

/**
 * Look up a typed code and decide whether it may be applied right now. Every
 * failure returns a customer-facing message (the CSR reads it verbatim) — we
 * never reveal whether a code merely expired vs. never existed, both read as
 * "not a valid code", to avoid turning the field into a code-guessing oracle.
 */
export async function resolvePromo(
  client: Client,
  rawCode: unknown,
  nowMs: number
): Promise<PromoResolution> {
  const code = normalizeCode(rawCode);
  if (!code) return { ok: false, message: "Enter a discount code." };

  const { data: rows } = await client.models.PromoCode.listPromoCodeByCode({
    code,
  });
  const promo = rows?.[0];
  const notValid = {
    ok: false as const,
    message: "That discount code isn't valid.",
  };
  if (!promo || !promo.active) return notValid;

  if (promo.startsAt && nowMs < new Date(promo.startsAt).getTime()) {
    return notValid;
  }
  if (promo.endsAt && nowMs > new Date(promo.endsAt).getTime()) {
    return notValid;
  }
  if (
    typeof promo.maxRedemptions === "number" &&
    (promo.timesRedeemed ?? 0) >= promo.maxRedemptions
  ) {
    return { ok: false, message: "That discount code has been fully redeemed." };
  }
  if (discountFor(promo, 1_000_00) <= 0) {
    // A misconfigured code (no percent, no amount, or a zero value) must not
    // masquerade as "applied for $0 off" — treat it as not valid.
    return notValid;
  }
  return { ok: true, promo };
}

/**
 * The cents a code takes off a base amount, capped to the base (never
 * negative — a code that exceeds the price just zeroes it). Per the owner's
 * call, the code is NOT held above the variable-cost floor: staff own what
 * they hand out. The /book caller still refuses a below-Stripe-minimum CARD
 * charge, so "code wins" never produces an unchargeable intent.
 */
export function discountFor(
  promo: Pick<PromoRow, "kind" | "percentOff" | "amountOffCents">,
  baseCents: number
): number {
  if (baseCents <= 0) return 0;
  let raw = 0;
  if (promo.kind === "PERCENT") {
    const pct = promo.percentOff ?? 0;
    raw = Math.round((baseCents * pct) / 100);
  } else if (promo.kind === "FIXED") {
    raw = promo.amountOffCents ?? 0;
  }
  if (raw <= 0) return 0;
  return Math.min(raw, baseCents);
}

/** A short human label for the applied discount, e.g. "SAVE20 (20% off)". */
export function promoLabel(
  promo: Pick<PromoRow, "code" | "kind" | "percentOff" | "amountOffCents">
): string {
  const detail =
    promo.kind === "PERCENT"
      ? `${promo.percentOff ?? 0}% off`
      : `$${((promo.amountOffCents ?? 0) / 100).toFixed(2)} off`;
  return `${normalizeCode(promo.code)} (${detail})`;
}
