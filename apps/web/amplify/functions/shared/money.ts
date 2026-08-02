/**
 * The ONE way to render a cents amount as money.
 *
 * There were nine named formatters and 89 inline `$${(c / 100).toFixed(2)}`
 * sites, in five mutually incompatible styles. A single plan price rendered
 * four different ways depending on which surface the customer happened to be
 * looking at:
 *
 *     120000 →  "$1,200.00"   agreement PDF, cancellation copy, CRM
 *               "$1200.00"    receipt emails
 *               "$1200"       booking funnel, rate cards
 *               "$1,200"      the charge-ceiling refusal
 *
 * Note the third and fourth: dropping the separator, or dropping the cents,
 * are not cosmetic when the number is what someone is being asked to pay.
 * "$1200" beside a "$1,200.00" agreement invites a support call, and the
 * no-fraction style silently hid any remainder — `$50,000` for 5000050 cents.
 *
 * Canonical style is `Intl` currency: grouped thousands, always two decimals.
 * That is what the agreement, the CRM and the cancellation copy already
 * produced, i.e. the majority of money the customer sees in writing.
 *
 * Pure leaf: no imports, so Lambdas, the CRM and the public site all use it.
 */

/**
 * Constructed once at module load. `Intl.NumberFormat` is expensive to build
 * and this runs inside per-request Lambda code paths — the same reason
 * `dates.ts` and `businessHours.ts` hoist theirs. None of the nine formatters
 * this replaces did.
 */
const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

/** What an absent amount renders as. An em dash reads as "nothing here";
 *  `$0.00` would read as "free", which is a different and wrong claim. */
export const NO_AMOUNT = "—";

/**
 * Render whole cents as US currency: `120000` → `"$1,200.00"`.
 *
 * `null`/`undefined` render as {@link NO_AMOUNT} rather than throwing, because
 * most callers are building a string for a screen or an email where a missing
 * amount is a normal state. A non-finite number renders the same way: an
 * amount that arrived as `NaN` is a bug, and showing a dash beats showing
 * `"$NaN"` to a customer. Callers that must not proceed on a missing amount
 * should check the number, not the string — see `quoteSnapshot.ts`, which
 * refuses a half-written price before it ever reaches a formatter.
 */
export function formatMoney(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) {
    return NO_AMOUNT;
  }
  return USD.format(cents / 100);
}

/**
 * `formatMoney` with a `/mo` suffix — recurring plans are quoted per month
 * everywhere, and the suffix was previously appended by hand at each site.
 */
export function formatMonthly(cents: number | null | undefined): string {
  return `${formatMoney(cents)}/mo`;
}

/** As above, for the yearly roll-ups in the ops digests. */
export function formatYearly(cents: number | null | undefined): string {
  return `${formatMoney(cents)}/yr`;
}
