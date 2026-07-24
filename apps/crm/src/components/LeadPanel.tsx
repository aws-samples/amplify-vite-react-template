import { useCallback, useEffect, useState } from "react";
import {
  api,
  clientActionId,
  listLeadActivity,
  opResult,
  setLeadDisposition,
  LEAD_LOST_REASONS,
  type BookingRequest,
  type Customer,
  type LeadActivity,
} from "../lib/api";
import { useRoles } from "../lib/auth";
import { bookingFunnelUrl } from "../lib/bookingLink";
import { fmtDateTime, money } from "../lib/format";
import {
  deriveLeadStage,
  isLeadOverdue,
  leadNextActionAt,
  LEAD_STAGE_LABEL,
  LEAD_STAGE_TONE,
} from "../lib/leadStage";
import { Badge, Button, Card, ErrorNote, Field } from "../ui/kit";

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
  let parsed: {
    serviceLabel?: string;
    baseCents?: number;
    recurringOffer?: { monthlyCents?: number } | null;
    planOnly?: boolean;
  } = {};
  try {
    parsed = q.quoteJson ? JSON.parse(String(q.quoteJson)) : {};
  } catch {
    /* fall back to the row fields below */
  }
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
 * The lead record is an exception-safe inbox, not a second sales system.
 * Staff either continue through the canonical public quote funnel or record a
 * terminal lost/DNC fact. Quote submission, email delivery, conversion, and
 * next-action replacement are written by the system; employees never manage
 * pipeline stages.
 */
export default function LeadPanel({
  customer,
  onChanged,
}: {
  customer: Customer;
  onChanged: () => void | Promise<void>;
}) {
  const roles = useRoles();
  const [activity, setActivity] = useState<LeadActivity[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preparedUrl, setPreparedUrl] = useState<string | null>(null);
  const [lostReason, setLostReason] = useState("");
  const [timelineError, setTimelineError] = useState<string | null>(null);
  const [activityQuery, setActivityQuery] = useState("");
  const [activityPage, setActivityPage] = useState(0);
  const [clearReason, setClearReason] = useState("CUSTOMER_RECONSENTED");
  const [clearEvidence, setClearEvidence] = useState("");
  const [quote, setQuote] = useState<BookingRequest | null>(null);
  const [convName, setConvName] = useState("");
  const [convPrice, setConvPrice] = useState("");
  const [convFreq, setConvFreq] = useState<
    "MONTHLY" | "BIMONTHLY" | "QUARTERLY" | "SEMIANNUAL"
  >("MONTHLY");

  const loadActivity = useCallback(async () => {
    try {
      setTimelineError(null);
      const res = await listLeadActivity(customer.id);
      setActivity(
        (res.data ?? []).sort((a, b) =>
          (b.occurredAt ?? "").localeCompare(a.occurredAt ?? "")
        )
      );
    } catch (err) {
      setActivity(null);
      setTimelineError(
        err instanceof Error ? err.message : "Lead history could not be read"
      );
    }
  }, [customer.id]);

  // What this lead was last quoted — so the office sees the service + price on
  // the record and can re-offer the bookable link, without re-running the form.
  const loadQuote = useCallback(async () => {
    try {
      const res = await api().models.BookingRequest.listBookingRequestByLeadCustomerId(
        { leadCustomerId: customer.id }
      );
      // The newest quote that actually produced (or became) a booking — skip a
      // PENDING row whose price never finished computing.
      const priced = (res.data ?? [])
        .filter((b) => b.status && b.status !== "PENDING")
        .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
      setQuote(priced[0] ?? null);
    } catch {
      setQuote(null); // best-effort: a missing quote never blocks the panel
    }
  }, [customer.id]);

  useEffect(() => {
    void loadActivity();
    void loadQuote();
  }, [loadActivity, loadQuote]);

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await onChanged();
      await loadActivity();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That action did not complete");
      throw err;
    } finally {
      setBusy(null);
    }
  };

  const openQuote = async () => {
    // Open synchronously so browser popup protection does not turn a
    // successful token mint into a button that appears to do nothing.
    const quoteTab = window.open("about:blank", "buzzkill-lead-quote");
    if (quoteTab) quoteTab.opener = null;
    try {
      await act("quote", async () => {
        const prepared = opResult<{ url: string }>(
          await api().mutations.prepareLeadQuote({ customerId: customer.id })
        );
        if (!prepared?.url) throw new Error("The quote form link was not returned.");
        setPreparedUrl(prepared.url);
        if (quoteTab) quoteTab.location.replace(prepared.url);
      });
    } catch {
      quoteTab?.close();
    }
  };

  const due = leadNextActionAt(customer);
  const terminal = Boolean(customer.doNotContact || customer.lostReason);
  const canEmail =
    Boolean(customer.email) &&
    !customer.doNotContact &&
    (customer.contactConsentChannels ?? []).includes("EMAIL");

  return (
    <Card
      title="Handle this inquiry"
      actions={
        <span className="inline-actions">
          {/* The derived pipeline stage — computed from facts, never stored,
              so it always matches the Lead inbox badge. */}
          <Badge tone={LEAD_STAGE_TONE[deriveLeadStage(customer)]}>
            {LEAD_STAGE_LABEL[deriveLeadStage(customer)]}
          </Badge>
          {terminal ? (
            <Badge tone="muted">closed</Badge>
          ) : isLeadOverdue(customer) ? (
            <Badge tone="danger">overdue</Badge>
          ) : (
            <Badge tone="info">open</Badge>
          )}
        </span>
      }
    >
      <ErrorNote error={error} />

      {!terminal ? (
        <>
          <p className="small" style={{ marginTop: 0 }}>
            <strong>{customer.nextAction || "Handle this inquiry now"}</strong>
            {" · "}Due {due ? fmtDateTime(due.toISOString()) : "now"}
          </p>
          <p className="muted small">
            Confirm the email, phone, and MA/RI service address on this record.
            Then use the same website form every customer uses. Contact and
            address fields will be filled in; you choose the actual service,
            property type, and size from what the lead told you.
          </p>
          <Button block loading={busy === "quote"} onClick={() => void openQuote()}>
            Open prefilled website quote
          </Button>
          {preparedUrl ? (
            <p className="muted small" style={{ marginTop: 8 }}>
              If the quote tab did not open, {" "}
              <a href={preparedUrl} target="_blank" rel="noreferrer">
                open it here
              </a>
              .
            </p>
          ) : null}

          {(() => {
            const q = quote && summarizeQuote(quote);
            if (!q) return null;
            return (
              <div className="lead-quote" style={{ marginTop: 12 }}>
                <div className="row-split">
                  <strong className="small">Last quote</strong>
                  <Badge tone={q.tone}>{q.statusLabel}</Badge>
                </div>
                <p className="small" style={{ margin: "4px 0 0" }}>
                  {q.service}
                  {q.price ? (
                    <>
                      {" — "}
                      <strong>{q.price}</strong>
                    </>
                  ) : null}
                </p>
                {q.bookLink ? (
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
                      Reopens this exact quote for the customer to book and pay —
                      no need to fill the form again.
                    </p>
                  </div>
                ) : null}
              </div>
            );
          })()}

          <div className="inline-actions" style={{ marginTop: 10 }}>
            <Button
              small
              variant="subtle"
              loading={busy === "bookinglink"}
              disabled={!canEmail}
              onClick={() =>
                void act("bookinglink", async () => {
                  const sent = opResult<{ sent: boolean }>(
                    await api().mutations.sendCustomerEmail({
                      customerId: customer.id,
                      kind: "booking-link",
                      idempotencyKey: clientActionId("booking-link"),
                    })
                  );
                  if (!sent?.sent) throw new Error("The booking link was not sent.");
                }).catch(() => undefined)
              }
            >
              Email the customer their link
            </Button>
          </div>
          {!canEmail ? (
            <p className="muted small" style={{ marginTop: 6 }}>
              Emailing is unavailable until this lead has an email address and
              retained email permission. Staff can still complete the form
              during an inbound conversation.
            </p>
          ) : null}

          <details style={{ marginTop: 16 }}>
            <summary className="small">Add a plan &amp; convert to client</summary>
            <div className="form-grid" style={{ marginTop: 10 }}>
              <p className="muted small" style={{ margin: 0 }}>
                Records a plan you've agreed offline and turns this lead into a
                client. The plan is active but not billing yet — collect a card
                or bank on the customer page, then start billing.
              </p>
              <Field label="Plan name">
                <input
                  value={convName}
                  onChange={(e) => setConvName(e.target.value)}
                  placeholder="Quarterly general pest"
                />
              </Field>
              <div className="form-row-2">
                <Field label="Price (per bill)">
                  <input
                    inputMode="decimal"
                    value={convPrice}
                    onChange={(e) => setConvPrice(e.target.value)}
                    placeholder="149.00"
                  />
                </Field>
                <Field label="Billing frequency">
                  <select
                    value={convFreq}
                    onChange={(e) =>
                      setConvFreq(
                        e.target.value as
                          | "MONTHLY"
                          | "BIMONTHLY"
                          | "QUARTERLY"
                          | "SEMIANNUAL"
                      )
                    }
                  >
                    <option value="MONTHLY">Monthly</option>
                    <option value="BIMONTHLY">Every 2 months</option>
                    <option value="QUARTERLY">Quarterly</option>
                    <option value="SEMIANNUAL">Twice a year</option>
                  </select>
                </Field>
              </div>
              <div className="inline-actions">
                <Button
                  small
                  loading={busy === "convert"}
                  disabled={
                    !convName.trim() || !(Number(convPrice) > 0)
                  }
                  onClick={() =>
                    void act("convert", async () => {
                      const priceCents = Math.round(Number(convPrice) * 100);
                      const result = opResult(
                        await setLeadDisposition({
                          customerId: customer.id,
                          disposition: "CONVERT",
                          planName: convName.trim(),
                          priceCents,
                          serviceFrequency: convFreq,
                          idempotencyKey: clientActionId("convert"),
                        })
                      );
                      if (!result) throw new Error("The conversion did not complete.");
                      setConvName("");
                      setConvPrice("");
                    })
                  }
                >
                  Add plan &amp; convert
                </Button>
              </div>
            </div>
          </details>

          <details style={{ marginTop: 16 }}>
            <summary className="small">Close without a booking</summary>
            <div className="form-grid" style={{ marginTop: 10 }}>
              <Field label="Why was the inquiry closed?">
                <select
                  value={lostReason}
                  onChange={(event) => setLostReason(event.target.value)}
                >
                  <option value="">Choose a reason…</option>
                  {LEAD_LOST_REASONS.map((reason) => (
                    <option key={reason.code} value={reason.code}>
                      {reason.label}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="inline-actions">
                <Button
                  small
                  variant="subtle"
                  disabled={!lostReason}
                  loading={busy === "lost"}
                  onClick={() =>
                    void act("lost", async () => {
                      const result = opResult(
                        await setLeadDisposition({
                          customerId: customer.id,
                          disposition: "LOST",
                          reasonCode: lostReason,
                          idempotencyKey: clientActionId("lost"),
                        })
                      );
                      if (!result) throw new Error("The inquiry was not closed.");
                    }).catch(() => undefined)
                  }
                >
                  Close inquiry
                </Button>
                <Button
                  small
                  variant="danger"
                  loading={busy === "dnc"}
                  onClick={() =>
                    void act("dnc", async () => {
                      const result = opResult(
                        await setLeadDisposition({
                          customerId: customer.id,
                          disposition: "DNC",
                          idempotencyKey: clientActionId("dnc"),
                        })
                      );
                      if (!result) throw new Error("Do-not-contact was not saved.");
                    }).catch(() => undefined)
                  }
                >
                  Do not contact
                </Button>
              </div>
            </div>
          </details>
        </>
      ) : customer.doNotContact ? (
        <div className="warn-note">
          <strong>Do not contact.</strong> Non-essential outreach is suppressed.
          {roles.owner ? (
            <div className="form-grid" style={{ marginTop: 10 }}>
              <Field label="Controlled release reason">
                <select
                  value={clearReason}
                  onChange={(event) => setClearReason(event.target.value)}
                >
                  <option value="CUSTOMER_RECONSENTED">Customer re-consented</option>
                  <option value="ENTERED_IN_ERROR">Entered in error</option>
                </select>
              </Field>
              <Field label="Evidence (required)">
                <textarea
                  value={clearEvidence}
                  onChange={(event) => setClearEvidence(event.target.value)}
                />
              </Field>
              <Button
                small
                variant="ghost"
                disabled={!clearEvidence.trim()}
                loading={busy === "clear"}
                onClick={() =>
                  void act("clear", async () => {
                    const result = opResult(
                      await setLeadDisposition({
                        customerId: customer.id,
                        disposition: "CLEAR",
                        reasonCode: clearReason,
                        note: clearEvidence.trim(),
                        idempotencyKey: clientActionId("clear-dnc"),
                      })
                    );
                    if (!result) throw new Error("The suppression was not cleared.");
                  }).catch(() => undefined)
                }
              >
                Reopen inquiry
              </Button>
            </div>
          ) : (
            <span className="nested-line">
              Only an owner can clear suppression with a reason and evidence.
            </span>
          )}
        </div>
      ) : (
        <p className="muted small" style={{ marginTop: 0 }}>
          Closed: {customer.lostReason}. {" "}
          <Button
            small
            variant="ghost"
            loading={busy === "clear"}
            onClick={() =>
              void act("clear", async () => {
                const result = opResult(
                  await setLeadDisposition({
                    customerId: customer.id,
                    disposition: "CLEAR",
                    idempotencyKey: clientActionId("reopen-lost"),
                  })
                );
                if (!result) throw new Error("The inquiry was not reopened.");
              }).catch(() => undefined)
            }
          >
            Reopen inquiry
          </Button>
        </p>
      )}

      <details style={{ marginTop: 16 }}>
        <summary className="small">Audit history ({activity?.length ?? 0})</summary>
        <ErrorNote error={timelineError} />
        {activity ? (
          <div className="inline-actions" style={{ marginTop: 8 }}>
            <input
              placeholder="Search history…"
              value={activityQuery}
              onChange={(event) => {
                setActivityQuery(event.target.value);
                setActivityPage(0);
              }}
            />
            <Button
              small
              variant="subtle"
              onClick={() => {
                const rows = activity.map((item) => [
                  item.occurredAt,
                  item.channel,
                  item.outcome,
                  item.actorEmail,
                  item.note,
                ]);
                const csv = [
                  ["occurredAt", "channel", "outcome", "actor", "note"],
                  ...rows,
                ]
                  .map((row) =>
                    row
                      .map(
                        (cell) =>
                          `"${String(cell ?? "").replace(/"/g, '""')}"`
                      )
                      .join(",")
                  )
                  .join("\n");
                const url = URL.createObjectURL(
                  new Blob([csv], { type: "text/csv" })
                );
                const link = document.createElement("a");
                link.href = url;
                link.download = `lead-${customer.id}-timeline.csv`;
                link.click();
                URL.revokeObjectURL(url);
              }}
            >
              Export CSV
            </Button>
          </div>
        ) : null}
        {(activity ?? [])
          .filter(
            (item) =>
              !activityQuery.trim() ||
              JSON.stringify(item)
                .toLowerCase()
                .includes(activityQuery.trim().toLowerCase())
          )
          .slice(activityPage * 50, activityPage * 50 + 50)
          .map((item) => (
            <p className="muted small" key={item.id} style={{ marginTop: 6 }}>
              {fmtDateTime(item.occurredAt)} · {item.channel?.toLowerCase()} · {" "}
              {item.outcome?.toLowerCase()} · {item.actorEmail}
              {item.note ? <span className="nested-line">{item.note}</span> : null}
            </p>
          ))}
        {activity && activity.length > 50 ? (
          <div className="inline-actions">
            <Button
              small
              variant="ghost"
              disabled={activityPage === 0}
              onClick={() => setActivityPage((page) => page - 1)}
            >
              Previous
            </Button>
            <span className="small muted">Page {activityPage + 1}</span>
            <Button
              small
              variant="ghost"
              disabled={(activityPage + 1) * 50 >= activity.length}
              onClick={() => setActivityPage((page) => page + 1)}
            >
              Next
            </Button>
          </div>
        ) : null}
      </details>
    </Card>
  );
}
