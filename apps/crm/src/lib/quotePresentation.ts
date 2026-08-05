/**
 * How the office reads a quote off a customer record: what was sold, what the
 * money actually is, and whether it is still bookable.
 *
 * This lived inside QuoteHistory.tsx and got both halves wrong at once. It
 * printed the stored `serviceLabel` — the canonical ONE-TIME name, kept that
 * way on purpose so the sale can fall back to it — next to the plan's MONTHLY
 * rate. Real rows read "General pest control — one-time treatment — $72.00/mo"
 * for a customer who had paid $174 for a first visit: the label said one-time,
 * the price said monthly, and neither number was what changed hands. A CSR
 * quoting from that screen quotes wrong.
 *
 * Pure, and in `src/lib`, so the rule is testable without a DOM or Amplify.
 */
import {
  quoteDisplayService,
  quoteFrequency,
  requestedQuoteFrequency,
} from "../../../web/amplify/functions/shared/quoteDisplay";
import { parseQuoteSnapshot } from "../../../web/amplify/functions/shared/quoteSnapshot";
import { money } from "./format";

/** Only the row fields this summary reads — structural, so it is satisfied by
 *  a `BookingRequest` without importing the Amplify client. */
export type QuoteRow = {
  id: string;
  status?: string | null;
  quoteJson?: unknown;
  service?: string | null;
  recurring?: boolean | null;
  recurringPreference?: string | null;
  /** What /book actually charged. The only settled number on the row. */
  amountCents?: number | null;
  monthlyCents?: number | null;
  cancelToken?: string | null;
};

export type QuoteSummary = {
  service: string;
  /** The headline: money that changed hands, or is due today. */
  price: string | null;
  /** The tail — a plan's ongoing rate. Separate because the honest answer for
   *  a plan is TWO numbers, and collapsing them to one was the bug. */
  priceNote: string | null;
  statusLabel: string;
  tone: "ok" | "info" | "warn" | "muted";
  bookLink: string | null;
};

export function summarizeQuote(
  q: QuoteRow,
  funnelUrl: string
): QuoteSummary | null {
  const priced = ["QUOTED", "PROCESSING", "BOOKED"].includes(q.status ?? "");
  if (!priced) return null; // a CONTACT/callback carries no price to show
  // One shape, one parser — malformed JSON and a half-written offer both come
  // back absent, and the row fields below are the fallback either way.
  const parsed = parseQuoteSnapshot(q.quoteJson);
  const offer = parsed.recurringOffer;
  const monthly = offer?.monthlyCents ?? q.monthlyCents ?? null;

  // Which cadence to DESCRIBE this quote as. Once booked, what they actually
  // bought settles it (`recurring`); before that, what they asked for does.
  const frequency = q.recurring
    ? quoteFrequency(offer?.frequency)
    : requestedQuoteFrequency(
        q.recurringPreference,
        offer,
        Boolean(parsed.planOnly)
      );
  const isPlan = Boolean(frequency);

  // Settled money wins: `amountCents` is what /book charged. Only an unbooked
  // quote falls back to the offer's first-visit fee, then the one-time base.
  const settled = q.status === "BOOKED" || q.status === "PROCESSING";
  const dueCents = settled
    ? (q.amountCents ?? null)
    : isPlan
      ? (offer?.initialFeeCents ?? null)
      : (parsed.baseCents ?? null);
  const dueLabel = settled
    ? q.status === "BOOKED"
      ? "paid"
      : "processing"
    : isPlan
      ? "first visit"
      : "one-time";
  const price = dueCents != null ? `${money(dueCents)} ${dueLabel}` : null;
  // The recurring tail only reads correctly once a today-amount is stated; on
  // its own it is exactly the bare "/mo" that made the old row misread.
  const priceNote =
    isPlan && monthly != null
      ? price
        ? `then ${money(monthly)}/mo`
        : `${money(monthly)}/mo`
      : null;

  const statusLabel =
    q.status === "BOOKED"
      ? "booked & paid"
      : q.status === "PROCESSING"
        ? "payment processing"
        : "quoted — not booked yet";
  const tone =
    q.status === "BOOKED" ? "ok" : q.status === "PROCESSING" ? "info" : "warn";
  // Only a QUOTED request is still bookable via the resume link; the fragment
  // (#request=…&token=…) is what the funnel reads to reopen the priced quote.
  const bookLink =
    q.status === "QUOTED" && q.cancelToken
      ? `${funnelUrl}#request=${encodeURIComponent(
          q.id
        )}&token=${encodeURIComponent(q.cancelToken)}`
      : null;

  return {
    // The stored label is the canonical ONE-TIME name. Describing a plan lead
    // with it is what made this row contradict its own price — the funnel has
    // always corrected it on the way out, and now both surfaces share that one
    // correction instead of only the customer seeing the truthful name.
    service: quoteDisplayService(
      parsed.serviceLabel || String(q.service ?? "Service"),
      frequency
    ),
    price,
    priceNote,
    statusLabel,
    tone,
    bookLink,
  };
}
