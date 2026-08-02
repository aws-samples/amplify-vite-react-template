import { useCallback, useEffect, useState } from "react";
import {
  api,
  clientActionId,
  listAll,
  setLeadDisposition,
  unwrap,
  type BookingRequest,
  type Customer,
} from "../lib/api";
import { bookingFunnelUrl } from "../lib/bookingLink";
import { fmtDateTime, money } from "../lib/format";
import { useAction } from "../lib/useAsync";
import { parseQuoteSnapshot } from "../../../web/amplify/functions/shared/quoteSnapshot";
import DocButton from "./DocButton";
import { Badge, Button, ErrorNote } from "../ui/kit";

/** The bits of a lead's last quote the panel shows: what, how much, and the
 *  bookable link. Reads the stored quoteJson; falls back to the row fields. */
function summarizeQuote(q: BookingRequest): {
  service: string;
  price: string | null;
  statusLabel: string;
  tone: "ok" | "info" | "warn" | "muted";
  bookLink: string | null;
} | null {
  const priced = ["QUOTED", "PROCESSING", "BOOKED"].includes(q.status ?? "");
  if (!priced) return null; // a CONTACT/callback carries no price to show
  // One shape, one parser — malformed JSON and a half-written offer both come
  // back absent, and the row fields below are the fallback either way.
  const parsed = parseQuoteSnapshot(q.quoteJson);
  const monthly = parsed.recurringOffer?.monthlyCents ?? q.monthlyCents ?? null;
  const price =
    monthly != null
      ? `${money(monthly)}/mo`
      : parsed.baseCents != null
        ? `${money(parsed.baseCents)}`
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
      ? `${bookingFunnelUrl()}#request=${encodeURIComponent(
          q.id
        )}&token=${encodeURIComponent(q.cancelToken)}`
      : null;
  return {
    service: parsed.serviceLabel || String(q.service ?? "Service"),
    price,
    statusLabel,
    tone,
    bookLink,
  };
}

/**
 * Every quote this customer was given — what, how much, when, and its PDF.
 *
 * Deliberately NOT part of the lead panel. It used to live there, which meant
 * the whole history vanished the moment a lead converted: the quotes still
 * existed, but the only screen that showed them was gated on status === LEAD.
 * "What did we quote this customer?" is a question you ask most often AFTER
 * they become a customer, so this renders for the whole life of the record.
 */
export default function QuoteHistory({
  customer,
  onChanged,
}: {
  customer: Customer;
  onChanged?: () => void;
}) {
  const [quotes, setQuotes] = useState<BookingRequest[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const loadQuotes = useCallback(async () => {
    try {
      const rows = await listAll((t) =>
        api().models.BookingRequest.listBookingRequestByLeadCustomerId(
          { leadCustomerId: customer.id },
          { nextToken: t }
        )
      );
      // Newest first. PENDING rows are skipped: their price never finished
      // computing, so there is nothing to show.
      setQuotes(
        rows
          .filter((b) => b.status && b.status !== "PENDING")
          .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))
      );
    } catch {
      setQuotes([]); // best-effort: a missing quote never blocks the record
    }
  }, [customer.id]);

  useEffect(() => {
    void loadQuotes();
  }, [loadQuotes]);

  /** Remove one quote. Booked/processing quotes are refused server-side —
   *  money is attached to those. */
  const removeQuote = useAction(async (q: BookingRequest) => {
    unwrap(
      await setLeadDisposition({
        customerId: customer.id,
        disposition: "DELETE_QUOTE",
        bookingRequestId: q.id,
        idempotencyKey: clientActionId(`quote-delete:${q.id}`),
      })
    );
    await loadQuotes();
    onChanged?.();
  }, "Could not remove that quote");

  // `busy` stays: the gate allows one delete at a time, but the row being
  // deleted still needs its own spinner (and it doubles as the copy flag).
  const deleteQuote = async (q: BookingRequest) => {
    if (
      !window.confirm(
        "Remove this quote from the customer's history? The booking link for it stops working."
      )
    )
      return;
    setBusy(`del:${q.id}`);
    try {
      await removeQuote.run(q);
    } finally {
      setBusy(null);
    }
  };

  const rows = quotes
    .map((row) => ({ row, q: summarizeQuote(row) }))
    .filter(
      (r): r is {
        row: BookingRequest;
        q: NonNullable<ReturnType<typeof summarizeQuote>>;
      } => Boolean(r.q)
    );
  if (rows.length === 0) return null;

  return (
    <div className="card">
      <ErrorNote error={removeQuote.error} />
  <div className="lead-quote">
    <strong className="small">
      {rows.length === 1 ? "Quote" : `Quotes (${rows.length})`}
    </strong>
    {rows.map(({ row, q }, i) => (
      <div
        key={row.id}
        style={
          i === 0
            ? { marginTop: 6 }
            : {
                marginTop: 10,
                paddingTop: 10,
                borderTop: "1px solid var(--line)",
              }
        }
      >
        <div className="row-split">
          <span className="muted small">
            {fmtDateTime(row.createdAt)}
          </span>
          <Badge tone={i === 0 ? q.tone : "muted"}>
            {/* Only the newest is still the live offer — an older
                one was replaced by the customer asking again, and
                saying "quoted — not booked yet" on all of them
                would read as several open offers. */}
            {i === 0 ? q.statusLabel : "superseded"}
          </Badge>
        </div>
        <p className="small" style={{ margin: "2px 0 0" }}>
          {q.service}
          {q.price ? (
            <>
              {" — "}
              <strong>{q.price}</strong>
            </>
          ) : null}
        </p>
        <div className="inline-actions" style={{ marginTop: 6 }}>
          {/* Rendered on demand from the stored quote, so every
              quote in the history can be reprinted exactly as the
              customer was given it. */}
          <DocButton
            docKey={`quotes/${customer.id}/${row.id}.pdf`}
            label="Quote PDF"
          />
          <Button
            small
            variant="ghost"
            loading={busy === `del:${row.id}`}
            onClick={() => void deleteQuote(row)}
          >
            Delete
          </Button>
        </div>
        {i === 0 && q.bookLink ? (
          <div style={{ marginTop: 8 }}>
            <Button
              small
              variant="subtle"
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(q.bookLink!)
                  .then(() => {
                    setBusy("copied");
                    setTimeout(() => setBusy(null), 1500);
                  });
              }}
            >
              {busy === "copied" ? "Copied!" : "Copy booking link"}
            </Button>
            <p className="muted small" style={{ marginTop: 6 }}>
              Reopens this exact quote for the customer to book and
              pay — no need to fill the form again.
            </p>
          </div>
        ) : null}
      </div>
      ))}
      </div>
    </div>
  );
}
