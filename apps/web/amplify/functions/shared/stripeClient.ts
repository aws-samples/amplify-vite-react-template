import Stripe from "stripe";

/**
 * Lazy Stripe client so a missing secret fails the invocation that needs
 * it, not every cold start of the bundle.
 */
let stripe: Stripe | null = null;

export function stripeClient(): Stripe {
  if (!stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error("STRIPE_SECRET_KEY is not configured");
    stripe = new Stripe(key);
  }
  return stripe;
}

/** "Visa ••4242" / "Chase ••6789" style label for a payment method. */
export function paymentMethodLabel(pm: Stripe.PaymentMethod): {
  label: string;
  kind: "CARD" | "BANK";
} {
  if (pm.type === "us_bank_account" && pm.us_bank_account) {
    return {
      label: `${pm.us_bank_account.bank_name ?? "Bank"} ••${pm.us_bank_account.last4}`,
      kind: "BANK",
    };
  }
  if (pm.card) {
    const brand =
      pm.card.brand.charAt(0).toUpperCase() + pm.card.brand.slice(1);
    return { label: `${brand} ••${pm.card.last4}`, kind: "CARD" };
  }
  return { label: pm.type, kind: "CARD" };
}
