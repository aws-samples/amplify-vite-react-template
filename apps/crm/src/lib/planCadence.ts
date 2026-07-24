import { money } from "./format";

/**
 * How a plan bills, said in words.
 *
 * "$45/mo · service quarterly" is true and nearly everyone misreads it. A
 * business reviewer read it as $45 charged four times a year, called the
 * difference systematic overcharging, and asked for a fix that would have cut
 * quarterly revenue by two thirds. A CSR reading the same row cannot tell how
 * often the card is charged either.
 *
 * Plans are priced per month whatever the visit cadence (rateCards returns
 * `monthlyCents`), so the two halves have to be spelled out separately: what is
 * charged, how often, and — distinctly — how often somebody turns up.
 */

const VISIT_INTERVAL: Record<string, string> = {
  MONTHLY: "technician visits every month",
  BIMONTHLY: "technician visits every 2 months",
  QUARTERLY: "technician visits every 3 months",
  SEMIANNUAL: "technician visits twice a year",
};

/** e.g. "$45.00 per month · technician visits every 3 months". A seasonal plan
 *  (GL-17) says the approved promise: billed monthly year-round, treatments
 *  monthly April–October — off-season it is healthy, not broken. */
export function planCadence(
  priceCents: number | null | undefined,
  frequency: string | null | undefined,
  seasonal?: boolean | null
): string {
  const price =
    priceCents != null ? `${money(priceCents)} per month` : "AI-priced";
  if (seasonal) {
    return `${price} year-round · treatments monthly April–October`;
  }
  const visits = VISIT_INTERVAL[frequency ?? ""] ?? null;
  return visits ? `${price} · ${visits}` : price;
}

/** The billing half on its own, for confirmations. */
export function billingCadence(priceCents: number | null | undefined): string {
  return priceCents != null
    ? `${money(priceCents)} charged every month`
    : "priced per month";
}
