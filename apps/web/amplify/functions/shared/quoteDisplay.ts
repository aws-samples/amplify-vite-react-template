/**
 * How a stored quote is DESCRIBED — the one place that turns the canonical
 * sold-service label into the label a human should read.
 *
 * `serviceLabel` in `quoteJson` is the canonical one-time label ("General pest
 * control — one-time treatment"), kept that way on purpose: it is what the sale
 * becomes if the customer drops the plan. It is not what anyone should be
 * SHOWN when they asked for, or bought, a plan.
 *
 * This used to live privately in booking-public/handler.ts, so only the public
 * funnel corrected the label. The CRM read `serviceLabel` raw and printed it
 * next to the plan's MONTHLY rate, producing rows like
 * "General pest control — one-time treatment — $72.00/mo" for a customer who
 * had paid $174 for a first visit. Label and price each came from a defensible
 * place and still contradicted each other, and neither was the amount due.
 *
 * Pure leaf: no imports, so both the Lambdas and the CRM can value-import it.
 */

export type QuoteFrequency = "MONTHLY" | "BIMONTHLY" | "QUARTERLY";

export function quoteFrequency(
  value: string | null | undefined
): QuoteFrequency | undefined {
  return value === "MONTHLY" || value === "BIMONTHLY" || value === "QUARTERLY"
    ? value
    : undefined;
}

/** The plan cadence the customer actually requested. Plan-only offers use
 *  their one available/selected cadence even if an older caller omitted the
 *  preference field. A normal quote with no recurring request stays one-time. */
export function requestedQuoteFrequency(
  requested: string | null | undefined,
  offer: { frequency: string } | null | undefined,
  planOnly = false
): QuoteFrequency | undefined {
  const normalized = quoteFrequency(requested);
  if (normalized && offer?.frequency === normalized) return normalized;
  return planOnly ? quoteFrequency(offer?.frequency) : undefined;
}

/** `serviceLabel` remains the canonical sold-service label used if the
 *  customer changes to one-time. Readers get a truthful display label for the
 *  option they requested instead of calling a monthly lead a "one-time
 *  treatment" before showing their plan price. */
export function quoteDisplayService(
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
