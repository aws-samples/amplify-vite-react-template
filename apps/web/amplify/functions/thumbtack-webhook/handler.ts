import { createHash, timingSafeEqual } from "node:crypto";
import type { Handler } from "aws-lambda";
import { dataClient } from "../shared/dataClient";
import { appendLeadActivity, createLead } from "../shared/leadLifecycle";
import { notifyLeads } from "../shared/email";
import { autoQuoteLead, type AutoQuoteResult } from "./autoQuote";

/**
 * Thumbtack inbound receiver — leads, thread messages, lead-price updates and
 * reviews, on the Partner Platform's own route shapes so that turning on the
 * approved integration later is a credential change, not a rewrite.
 *
 *   POST /v1/lead         a new lead (Thumbtack calls this a Negotiation)
 *   POST /v1/message      a customer message on an existing lead thread
 *   PUT  /v1/lead/update  the lead's price/charge state changed after the fact
 *   POST /v1/review       a review was left, edited, or removed
 *
 * TRUST MODEL. The self-serve webhook offers only a static `Authorization`
 * header — there is no HMAC over the body, so a replayed or forged body is
 * indistinguishable from a real one once the secret leaks. Consequences that
 * are deliberate here:
 *   - the secret is compared in CONSTANT TIME, never with `===`;
 *   - nothing this file writes moves money or changes a price the customer has
 *     already been quoted;
 *   - `leadPrice` is recorded as REPORTED cost, never used to authorize a
 *     charge;
 *   - every write is idempotent on Thumbtack's own ids, so a duplicate or
 *     replayed delivery is a no-op rather than a second lead.
 *
 * Thumbtack retries on non-2xx. Anything we cannot make sense of is therefore
 * ACCEPTED (200) and paged to a human instead of rejected into a retry storm —
 * except an auth failure, which must stay 401.
 */

type TtCustomer = {
  customerID?: string;
  name?: string;
  /** Present "if we have it", and it is a Thumbtack PROXY number — callable
   *  only from phones registered to the pro account, and it can expire. */
  phone?: string;
};

type TtLocation = {
  address1?: string;
  address2?: string;
  city?: string;
  state?: string;
  zipCode?: string;
};

type TtDetail = { question?: string; answer?: string };

type TtRequest = {
  requestID?: string;
  category?: string;
  categoryID?: string;
  title?: string;
  description?: string;
  schedule?: string;
  travelPreferences?: string;
  location?: TtLocation;
  details?: TtDetail[];
};

type TtLead = {
  leadID?: string;
  createTimestamp?: string;
  request?: TtRequest;
  customer?: TtCustomer;
  business?: { businessID?: string; name?: string };
  leadType?: string;
  /** What Thumbtack charges US for this lead. Reported, never authoritative. */
  leadPrice?: string;
  chargeState?: string;
};

type TtMessage = {
  leadID?: string;
  customerID?: string;
  businessID?: string;
  message?: {
    messageID?: string;
    createTimestamp?: string;
    text?: string;
    attachments?: { url?: string; name?: string }[];
  };
};

type TtReview = {
  reviewEventType?: string;
  review?: {
    reviewID?: string;
    businessID?: string;
    rating?: number;
    verified?: boolean;
    text?: string;
    photos?: string[];
  };
};

const SYSTEM_ACTOR = { sub: null, email: null } as const;

const json = (statusCode: number, body: unknown) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/** Constant-time secret comparison. Hashing first makes the buffers equal
 *  length, so the compare itself cannot leak the secret's length. */
function secretOk(presented: string | undefined, expected: string): boolean {
  if (!presented) return false;
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Thumbtack's self-serve webhook sends the configured value verbatim; the
 *  Partner Platform sends `Bearer <token>`. Accept either shape. */
function presentedSecret(headers: Record<string, string | undefined>): string | undefined {
  const raw =
    headers["authorization"] ??
    headers["Authorization"] ??
    headers["x-thumbtack-signature"];
  if (!raw) return undefined;
  return raw.startsWith("Bearer ") ? raw.slice(7).trim() : raw.trim();
}

/**
 * Thumbtack sends a display name only ("Ajay Daptardar", sometimes "Matt M.").
 * We never invent a surname we were not given.
 */
function displayNameOf(customer: TtCustomer | undefined, leadID: string): string {
  const name = customer?.name?.trim();
  return name || `Thumbtack lead ${leadID.slice(-6)}`;
}

/**
 * `<platform>#<id>` — the join key for every later event on this thread, and
 * the evidence that a lead with no email/phone is still reachable. Thumbtack
 * ids are opaque strings, so they are used verbatim.
 */
export function externalRefFor(leadID: string): string {
  return `thumbtack#${leadID}`;
}

/** Human-readable transcript of the category questionnaire. These answers are
 *  most of what we need to price (property type, pest, square-footage band),
 *  so they are preserved verbatim rather than parsed lossily on the way in. */
function leadNotesFrom(lead: TtLead): string {
  const req = lead.request ?? {};
  const loc = req.location ?? {};
  const lines: string[] = [];
  if (req.category) lines.push(`Category: ${req.category}`);
  if (req.title) lines.push(`Title: ${req.title}`);
  if (req.description) lines.push(`Customer wrote: ${req.description}`);
  if (req.schedule) lines.push(`Requested timing: ${req.schedule}`);
  if (req.travelPreferences) lines.push(`Travel: ${req.travelPreferences}`);
  for (const d of req.details ?? []) {
    if (d.question && d.answer) lines.push(`${d.question}: ${d.answer}`);
  }
  if (!loc.address1 && (loc.city || loc.zipCode)) {
    // Thumbtack only collects a street address for Instant Book, so a Direct
    // Lead is priced from the town/ZIP centroid until the customer supplies
    // the street on the booking link. Say so instead of implying precision.
    lines.push(
      `NOTE: Thumbtack gave no street address — zone and price are from ${
        [loc.city, loc.state, loc.zipCode].filter(Boolean).join(" ")
      } and must be confirmed against the exact address.`
    );
  }
  if (lead.leadPrice) {
    lines.push(
      `Thumbtack lead fee (reported): ${lead.leadPrice}${
        lead.chargeState ? ` (${lead.chargeState})` : ""
      }`
    );
  }
  lines.push(`Thumbtack lead id: ${lead.leadID ?? "unknown"}`);
  return lines.join("\n");
}

/** Find the customer a Thumbtack thread belongs to. Name/email matching cannot
 *  do this — Thumbtack sends no email — so the externalRef index is the only
 *  reliable join. Null means we never saw the lead event (out-of-order or
 *  pre-integration thread). */
async function customerForLead(leadID: string): Promise<{ id: string; displayName?: string } | null> {
  const client = await dataClient();
  const anyModels = client.models as Record<string, unknown>;
  const model = anyModels.Customer as {
    listCustomerByExternalRef?: (args: {
      externalRef: string;
    }) => Promise<{ data?: { id: string; displayName?: string }[] }>;
  };
  if (typeof model?.listCustomerByExternalRef !== "function") return null;
  const page = await model.listCustomerByExternalRef({
    externalRef: externalRefFor(leadID),
  });
  return page.data?.[0] ?? null;
}

async function handleLead(lead: TtLead) {
  const leadID = lead.leadID?.trim();
  if (!leadID) return json(200, { ok: false, ignored: "no leadID" });

  const loc = lead.request?.location ?? {};
  const result = await createLead(
    {
      displayName: displayNameOf(lead.customer, leadID),
      phone: lead.customer?.phone ?? undefined,
      serviceStreet: loc.address1?.trim() || undefined,
      serviceUnit: loc.address2?.trim() || undefined,
      serviceCity: loc.city?.trim() || undefined,
      serviceState: loc.state?.trim() || undefined,
      serviceZip: loc.zipCode?.trim() || undefined,
      leadSource: `Thumbtack · ${lead.request?.category ?? "lead"}`,
      notes: leadNotesFrom(lead),
      externalRef: externalRefFor(leadID),
      // Retain the record and open the controlled duplicate decision rather
      // than letting a marketplace guess at whether two people are the same.
      force: true,
      // Thumbtack redelivers on any non-2xx, so the lead id IS the idempotency
      // key: a replay resolves to the same lead row instead of a second lead.
      idempotencyKey: `thumbtack:${leadID}`,
      // NO consent channels. A Thumbtack lead is permission to reply in the
      // thread, not to email or cold-call — and `createLead` rightly throws if
      // channels are claimed without retained evidence.
    },
    SYSTEM_ACTOR
  );

  if (result.decision !== "CREATED") {
    return json(200, { ok: true, duplicate: true });
  }

  await appendLeadActivity({
    customerId: result.id,
    channel: "THUMBTACK",
    direction: "INBOUND",
    outcome: "REACHED",
    note: lead.request?.description?.trim()
      ? `Thumbtack lead opened: ${lead.request.description.trim()}`
      : "Thumbtack lead opened.",
    actor: SYSTEM_ACTOR,
    mutationId: `tt-lead:${leadID}`,
  });

  // Price it immediately. A failure here must never lose the lead — it is
  // already saved above — so the quote is best-effort and its failure is
  // recorded on the thread rather than thrown.
  let quote: AutoQuoteResult | null = null;
  try {
    quote = await autoQuoteLead(
      {
        leadID,
        customerId: result.id,
        category: lead.request?.category ?? null,
        details: lead.request?.details ?? [],
        leadPrice: lead.leadPrice,
        street: loc.address1 ?? null,
        city: loc.city ?? null,
        state: loc.state ?? null,
        zip: loc.zipCode ?? null,
      },
      displayNameOf(lead.customer, leadID)
    );
  } catch (err) {
    console.error("thumbtack-webhook: auto-quote failed", { leadID, err });
  }

  if (quote) {
    await persistQuoteDraft(result.id, leadID, quote);
    await appendLeadActivity({
      customerId: result.id,
      channel: "THUMBTACK",
      direction: "OUTBOUND",
      outcome: quote.autoSend ? "SENT" : "NOTE",
      note: quote.autoSend
        ? `Auto-quote ready to send: ${quote.replyText}`
        : `Quote not auto-sent — ${quote.reason}`,
      actor: SYSTEM_ACTOR,
      mutationId: `tt-quote:${leadID}`,
    });
  }

  return json(200, {
    ok: true,
    leadId: result.id,
    decision: quote?.decision,
    autoSend: quote?.autoSend ?? false,
  });
}

/**
 * Record the draft on LeadPricingRun — the model that already exists for
 * exactly this (a priced lead plus the reply that would be sent), and which
 * the CRM can read. `outcome` carries the auto-send verdict so staff can see
 * at a glance which replies went out by themselves.
 *
 * Best-effort: the lead and its thread history are the durable record, and a
 * failed draft write must not cost us the lead.
 */
async function persistQuoteDraft(
  customerId: string,
  leadID: string,
  quote: AutoQuoteResult
): Promise<void> {
  try {
    const client = await dataClient();
    const models = client.models as Record<string, unknown>;
    const model = models.LeadPricingRun as {
      create?: (input: Record<string, unknown>) => Promise<unknown>;
    };
    if (typeof model?.create !== "function") return;
    await model.create({
      source: `thumbtack:${leadID}`,
      customerId,
      decision: quote.decision,
      outcome: quote.autoSend ? "AUTO_SENT" : "DRAFT",
      leadFeeCents: quote.leadFeeCents,
      zone: quote.zone,
      driveMinutes: quote.driveMinutes,
      oneTimePriceCents: quote.oneTimePriceCents,
      replyText: quote.replyText,
      reason: quote.reason,
      priceBreakdown: JSON.stringify({
        offeredDates: quote.offeredDates ?? [],
        bookingUrl: quote.bookingUrl ?? null,
      }),
    });
  } catch (err) {
    console.error("thumbtack-webhook: could not persist the quote draft", err);
  }
}

async function handleMessage(payload: TtMessage) {
  const leadID = payload.leadID?.trim();
  const messageID = payload.message?.messageID?.trim();
  const text = payload.message?.text?.trim();
  if (!leadID || !messageID) {
    return json(200, { ok: false, ignored: "no leadID/messageID" });
  }

  const customer = await customerForLead(leadID);
  if (!customer) {
    // Out-of-order or pre-integration thread. Losing a customer's message is
    // not acceptable, so page a human rather than dropping it silently.
    await notifyLeads({
      subject: "Thumbtack message for an unknown lead",
      heading: "A Thumbtack message arrived for a lead we have no record of",
      template: "ops-thumbtack-orphan-message",
      bodyHtml: `<p>Thumbtack lead <code>${escapeHtml(leadID)}</code> sent a message, but no CRM lead carries that reference. Answer it in the Thumbtack inbox.</p>
        <p style="white-space:pre-wrap;">${escapeHtml(text ?? "(no text)")}</p>`,
    });
    return json(200, { ok: true, orphan: true });
  }

  const attachments = payload.message?.attachments ?? [];
  await appendLeadActivity({
    customerId: customer.id,
    channel: "THUMBTACK",
    direction: "INBOUND",
    outcome: "REACHED",
    note: [text ?? "(no text)", attachments.length ? `[${attachments.length} attachment(s)]` : ""]
      .filter(Boolean)
      .join(" "),
    actor: SYSTEM_ACTOR,
    // Thumbtack's own message id makes a redelivery a no-op.
    mutationId: `tt-msg:${messageID}`,
  });

  return json(200, { ok: true, customerId: customer.id });
}

/**
 * `leadPrice`/`chargeState` are finalized after the lead is delivered, so this
 * is how the true cost of a lead arrives. Recorded on the thread as evidence —
 * it is what makes cost-per-booked-job answerable later — and never used to
 * authorize anything.
 */
async function handleLeadUpdate(lead: TtLead) {
  const leadID = lead.leadID?.trim();
  if (!leadID) return json(200, { ok: false, ignored: "no leadID" });

  const customer = await customerForLead(leadID);
  if (!customer) return json(200, { ok: true, orphan: true });

  await appendLeadActivity({
    customerId: customer.id,
    channel: "THUMBTACK",
    direction: "INBOUND",
    outcome: "NOTE",
    note: `Thumbtack lead fee updated: ${lead.leadPrice ?? "unknown"}${
      lead.chargeState ? ` (${lead.chargeState})` : ""
    }`,
    actor: SYSTEM_ACTOR,
    mutationId: `tt-fee:${leadID}:${lead.leadPrice ?? ""}:${lead.chargeState ?? ""}`,
  });

  return json(200, { ok: true });
}

async function handleReview(payload: TtReview) {
  const review = payload.review;
  if (!review?.reviewID) return json(200, { ok: false, ignored: "no reviewID" });

  await notifyLeads({
    subject: `Thumbtack review (${review.rating ?? "?"}★)${
      payload.reviewEventType ? ` — ${payload.reviewEventType}` : ""
    }`,
    heading: "New Thumbtack review",
    template: "ops-thumbtack-review",
    bodyHtml: `<p><strong>${review.rating ?? "?"}★</strong>${
      review.verified ? " (verified)" : ""
    }</p><p style="white-space:pre-wrap;">${escapeHtml(review.text ?? "")}</p>`,
  });

  return json(200, { ok: true });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export const handler: Handler = async (event) => {
  const method =
    event.httpMethod ?? event.requestContext?.http?.method ?? "POST";
  const path: string =
    event.rawPath ?? event.path ?? event.requestContext?.http?.path ?? "";

  if (method === "OPTIONS") return json(204, {});

  const expected = process.env.THUMBTACK_WEBHOOK_SECRET;
  if (!expected || expected === "placeholder-set-me") {
    // Refuse rather than accept unauthenticated writes into the lead pipeline.
    console.error("thumbtack-webhook: THUMBTACK_WEBHOOK_SECRET is not configured");
    return json(503, { error: "Receiver not configured" });
  }
  const headers = (event.headers ?? {}) as Record<string, string | undefined>;
  if (!secretOk(presentedSecret(headers), expected)) {
    return json(401, { error: "Unauthorized" });
  }

  let raw: string;
  try {
    raw = event.isBase64Encoded
      ? Buffer.from(event.body ?? "", "base64").toString("utf-8")
      : (event.body ?? "");
  } catch {
    return json(400, { error: "Invalid body encoding" });
  }

  let body: unknown;
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    return json(400, { error: "Body must be JSON" });
  }

  try {
    if (path.endsWith("/v1/lead/update")) return await handleLeadUpdate(body as TtLead);
    if (path.endsWith("/v1/lead")) return await handleLead(body as TtLead);
    if (path.endsWith("/v1/message")) return await handleMessage(body as TtMessage);
    if (path.endsWith("/v1/review")) return await handleReview(body as TtReview);
    return json(404, { error: "Unknown route" });
  } catch (err) {
    // Thumbtack retries on non-2xx. A deterministic bug would retry forever and
    // the customer would still be waiting, so take the delivery, page a human,
    // and keep the raw body — this email is the only copy.
    console.error("thumbtack-webhook: delivery failed", { path, err });
    await notifyLeads({
      subject: "ACTION REQUIRED — a Thumbtack delivery could not be processed",
      heading: "A Thumbtack webhook delivery failed",
      template: "ops-thumbtack-failed",
      bodyHtml: `<p>Thumbtack sent <code>${escapeHtml(path)}</code> and we could <strong>not</strong> process it. Check the Thumbtack inbox directly.</p>
        <p style="color:#666;font-size:13px;">Error: ${escapeHtml(
          err instanceof Error ? err.message : String(err)
        )}</p>
        <pre style="white-space:pre-wrap;font-size:12px;">${escapeHtml(raw.slice(0, 4000))}</pre>`,
    }).catch(() => undefined);
    return json(200, { ok: false, paged: true });
  }
};
