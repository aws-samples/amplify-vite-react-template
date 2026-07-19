import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { CANCEL_FULL_REFUND_DAYS } from "./bookingTerms";
import { randomUUID } from "node:crypto";
import { dataClient } from "./dataClient";
import { casTakeover, casFencedDelete } from "./atomicLock";
import { isSeasonalPlanName, monthKeyOf, isServiceMonth, SEASONAL_SERVICE_MONTHS } from "./season";
import { ensureObligation } from "./obligations";
import { customerAccessGroups } from "./dynamicGroups";
import { emailShell, notifyLeads, sendEmail } from "./email";
import { provisionPortalLogin } from "./portalProvision";
import { renderAgreementPdf } from "./pdf";
import { stripeClient } from "./stripeClient";
import { openOwnedWork, resolveOwnedWork } from "./ownedWork";

const s3 = new S3Client();

// Derived from the single shared constant (R17) — the policy in the signed
// agreement must be the rule /cancel enforces, not a copy that can drift.
const CANCEL_POLICY_TEXT = `CANCELLATION POLICY. Cancel more than ${CANCEL_FULL_REFUND_DAYS} days before your appointment for a full refund. Cancellations ${CANCEL_FULL_REFUND_DAYS} days or less before the appointment are not refundable.`;

const WINDOW_LABEL: Record<string, string> = {
  MORNING: "morning (8am–12pm)",
  AFTERNOON: "afternoon (12pm–5pm)",
};

/**
 * Called by the Stripe webhook when a booking-funnel PaymentIntent
 * succeeds: creates the real CRM records (customer, scheduled job, plan if
 * recurring), turns the T&C acceptance into a signed agreement PDF, and
 * emails the confirmation. Idempotent via BookingRequest.status.
 */
export async function finalizeBooking(opts: {
  bookingRequestId: string;
  paymentIntentId: string;
  amountReceived: number;
  paymentMethodId?: string | null;
}): Promise<void> {
  const client = await dataClient();
  const { data: booking } = await client.models.BookingRequest.get({
    id: opts.bookingRequestId,
  });

  // A succeeded booking payment with no booking row behind it: the record was
  // deleted or the metadata points at a ghost. Money captured, nothing to
  // finalize — a durable Finance case, never a silent return.
  if (!booking) {
    console.warn(
      `finalizeBooking: no booking ${opts.bookingRequestId} for succeeded PaymentIntent ${opts.paymentIntentId}`
    );
    await openOwnedWork({
      kind: "PAID_NOT_FINALIZED",
      dedupeKey: `missing-booking:${opts.paymentIntentId}`,
      title: "Succeeded payment has no booking record",
      detail: `Stripe reported PaymentIntent ${opts.paymentIntentId} succeeded for $${((opts.amountReceived ?? 0) / 100).toFixed(2)}, but booking ${opts.bookingRequestId} does not exist. The money is captured with nothing to deliver.`,
      relatedId: opts.bookingRequestId,
      resolutionAction:
        "Find this PaymentIntent in Stripe. If it is a real customer payment, recreate the booking from the receipt and finalize it, or refund the charge and tell the customer.",
      ownerTeam: "FINANCE",
    });
    return;
  }

  // Already whole. A hard kill can land between the BOOKED write and the
  // customer/office sends, so a redelivery does not just return — it resumes the
  // durable communication outbox, sending only whichever message has no sent
  // marker yet, and clears any paid-not-finalized exception a failed attempt
  // left open.
  if (booking.status === "BOOKED") {
    await deliverBookingComms(booking as unknown as BookingRecord, null);
    await resolveOwnedWork({
      kind: "PAID_NOT_FINALIZED",
      dedupeKey: booking.id,
      note: "The booking is complete; a redelivery confirmed every record exists and delivered any outstanding confirmation.",
    });
    return;
  }

  // QUOTED (instant card) and PROCESSING (an async payment that has now cleared)
  // are the two states a success may finalize from. GL-06: a booking marked
  // PROCESSING by the payment_intent.processing webhook must still finalize when
  // the money lands — otherwise a cleared bank debit looks stuck-paid forever.
  // Any OTHER non-QUOTED/PROCESSING status is a paid booking that cannot enter
  // finalization: CANCELED/EXPIRED before it ever finalized (jobId is unset — a
  // booking that WAS finalized and later canceled is the refund flow's, not this
  // exception's), or a PENDING/CONTACT row that should never have a payment.
  // Either way the money succeeded, so it is a Finance case.
  if (booking.status !== "QUOTED" && booking.status !== "PROCESSING") {
    if (booking.jobId) return; // finalized earlier, then canceled — not stuck-paid
    console.warn(
      `finalizeBooking: booking ${booking.id} is ${booking.status}, not QUOTED, for succeeded PaymentIntent ${opts.paymentIntentId}`
    );
    await openOwnedWork({
      kind: "PAID_NOT_FINALIZED",
      dedupeKey: booking.id,
      title: `Paid booking is ${String(booking.status).toLowerCase()}, never finalized: ${booking.name ?? "customer"}`,
      detail: `A booking-funnel payment of $${((opts.amountReceived ?? 0) / 100).toFixed(2)} succeeded for ${booking.name ?? "this customer"} (${booking.email ?? "no email"}), but booking ${booking.id} is ${booking.status} and was never finalized. The money is in Stripe with no service commitment behind it.`,
      customerId: booking.customerId ?? undefined,
      relatedId: booking.id,
      sourceUrl: booking.customerId ? `/customers/${booking.customerId}` : undefined,
      resolutionAction:
        "Confirm the charge in Stripe. Either reinstate and finalize the booking, or refund the payment and tell the customer their booking did not go through.",
      ownerTeam: "FINANCE",
    });
    return;
  }

  // The record is mutable and /book can be retried, so trust the money, not
  // the record: only the PaymentIntent this booking currently points at, for
  // exactly the amount it says, may create records. Otherwise a stale
  // client_secret for a cheap day could buy the premium slot the record was
  // later repointed at.
  if (
    booking.stripePaymentIntentId &&
    opts.paymentIntentId !== booking.stripePaymentIntentId
  ) {
    // Refusing to finalize on the stale PI is correct — but the money on it was
    // still captured, and it does not match this booking's current PaymentIntent.
    // A re-book that repointed the booking and lost the race to cancel the old
    // PI lands here: captured money with no booking behind it. Surface it as a
    // durable finance exception (keyed on the stray PI so it never collides with
    // this booking's own PAID_NOT_FINALIZED item) instead of a lone console.warn.
    console.warn(
      `finalizeBooking: superseded PaymentIntent ${opts.paymentIntentId} for booking ${booking.id} — money captured on a PI the booking no longer points at`
    );
    await openOwnedWork({
      kind: "PAID_NOT_FINALIZED",
      dedupeKey: `stray-pi:${opts.paymentIntentId}`,
      title: `Stray captured payment not attached to a booking: ${booking.name ?? "customer"}`,
      detail: `Stripe captured $${((opts.amountReceived ?? 0) / 100).toFixed(2)} on PaymentIntent ${opts.paymentIntentId}, but booking ${booking.id} now points at a different PaymentIntent (${booking.stripePaymentIntentId}). The customer may have been charged twice, or paid on a PaymentIntent the booking abandoned. Verify in Stripe and refund the stray charge, or re-point and finalize the booking.`,
      customerId: booking.customerId ?? undefined,
      relatedId: booking.id,
      sourceUrl: booking.customerId ? `/customers/${booking.customerId}` : undefined,
      resolutionAction:
        "Open this customer and the PaymentIntent in Stripe. If the customer was double-charged, refund the stray charge. If this was their real payment, refund the duplicate and finish the booking.",
      ownerTeam: "FINANCE",
    });
    return;
  }
  if (opts.amountReceived !== booking.amountCents) {
    // Refusing to finalize on a mismatched amount is correct — creating the
    // records for a price the customer did not pay would be worse. But the money
    // still moved, so it cannot exit through a log line: open a Finance case
    // with both amounts so someone reconciles or refunds the difference.
    console.error(
      `finalizeBooking: amount mismatch for booking ${booking.id} — paid ${opts.amountReceived}, quoted ${booking.amountCents}`
    );
    await openOwnedWork({
      kind: "PAID_NOT_FINALIZED",
      dedupeKey: booking.id,
      title: `Paid amount does not match the quote: ${booking.name ?? "customer"}`,
      detail: `A booking-funnel payment succeeded for ${booking.name ?? "this customer"} (${booking.email ?? "no email"}) on PaymentIntent ${opts.paymentIntentId}, but Stripe captured $${((opts.amountReceived ?? 0) / 100).toFixed(2)} while the booking was quoted $${(((booking.amountCents ?? 0) as number) / 100).toFixed(2)}. Finalization was refused so no records were created at the wrong price.`,
      customerId: booking.customerId ?? undefined,
      relatedId: booking.id,
      sourceUrl: booking.customerId ? `/customers/${booking.customerId}` : undefined,
      resolutionAction:
        "Compare the Stripe charge to the quote. If the customer was undercharged, collect the difference before finalizing; if overcharged, refund the difference. Then re-point the amount and finalize, or refund in full.",
      ownerTeam: "FINANCE",
    });
    return;
  }

  // Atomic claim — `create` is conditional on the id not existing, so only
  // one concurrent webhook delivery proceeds. Released on failure so a
  // Stripe retry (or the office Retry button) can pick the work back up. The
  // steps inside are individually idempotent, so "pick it up" means resume the
  // same transaction, not start a second one.
  let claimHolder: string = randomUUID();
  const { data: claim } = await client.models.BookingFinalization.create({
    id: opts.bookingRequestId,
    note: `pi ${opts.paymentIntentId}`,
    holder: claimHolder,
    leaseUntil: new Date(Date.now() + ORPHAN_CLAIM_MS).toISOString(),
  });
  if (!claim) {
    // A claim already exists. Usually a live concurrent delivery — but a run
    // hard-killed (Lambda timeout/OOM) before its catch could delete the claim
    // leaves an ORPHAN. Without reclaiming it, this retry would return, the
    // handler would 200, Stripe would stop retrying, and the booking would wedge
    // at QUOTED with money captured and nothing in any queue. The webhook Lambda
    // times out at 30s, so a claim older than that cannot be a live holder.
    const reclaimed = await reclaimOrphanedClaim(opts.bookingRequestId);
    if (!reclaimed.won) return; // a genuinely live delivery owns it
    claimHolder = reclaimed.holder;
  }

  try {
    await finalizeClaimed(
      booking,
      opts.paymentIntentId,
      opts.paymentMethodId ?? null
    );
    // The booking is whole. If a prior attempt had opened the paid-not-finalized
    // exception, this success closes it — the queue must not keep showing a
    // problem the retry already solved.
    await resolveOwnedWork({
      kind: "PAID_NOT_FINALIZED",
      dedupeKey: booking.id,
      note: "The booking finalized on a later attempt — customer, job, agreement and invoice all exist.",
    });
  } catch (err) {
    // GL-05: money is in Stripe with no complete booking behind it. Before the
    // claim is released for retry, leave a durable, office-visible exception —
    // amount, customer, selected date, the failed step, and the one safe
    // recovery action — so the paid customer is never invisible to a log search.
    const step = err instanceof Error ? err.message : String(err);
    await openOwnedWork({
      kind: "PAID_NOT_FINALIZED",
      dedupeKey: booking.id,
      title: `Paid booking not finalized: ${booking.name ?? "customer"}`,
      detail: `A booking-funnel payment of $${(((booking.amountCents ?? 0) as number) / 100).toFixed(2)} succeeded for ${booking.name ?? "this customer"} (${booking.email ?? "no email"}), selected date ${booking.selectedDate ?? "unknown"}, but finalization could not complete: ${step}. The money is in Stripe; the CRM records are incomplete.`,
      customerId: booking.customerId ?? undefined,
      relatedId: booking.id,
      sourceUrl: booking.customerId ? `/customers/${booking.customerId}` : undefined,
      resolutionAction:
        "Use “Retry finalization” on this item — it re-confirms the Stripe payment and finishes the same booking. If it keeps failing, escalate to engineering, or refund the payment in Stripe and tell the customer.",
      ownerTeam: "FINANCE",
    });
    // Fenced release: a hung prior attempt waking up late can never delete the
    // claim out from under the newer holder.
    const released = await casFencedDelete(
      "BookingFinalization",
      opts.bookingRequestId,
      { field: "holder", nonce: claimHolder, allowMissingFence: true }
    );
    if (released === "UNSUPPORTED") {
      await client.models.BookingFinalization.delete({
        id: opts.bookingRequestId,
      });
    }
    throw err;
  }
}

/**
 * GL-05 recovery entry point: re-run finalization for a stuck paid booking. The
 * office invokes this from the PAID_NOT_FINALIZED queue item. It re-reads the
 * booking's PaymentIntent from Stripe to reconfirm the money moved and for how
 * much, then resumes the SAME finalization — idempotent, so it finishes the
 * original booking rather than duplicating it.
 */
export async function retryBookingFinalization(
  bookingRequestId: string
): Promise<{ status: string }> {
  const client = await dataClient();
  const { data: booking } = await client.models.BookingRequest.get({
    id: bookingRequestId,
  });
  if (!booking) throw new Error(`Booking ${bookingRequestId} not found`);
  if (booking.status === "BOOKED") {
    // Already whole. A prior success may have failed to close the exception
    // (best-effort resolve during a transient DynamoDB blip), so clear it here —
    // otherwise the item stays OPEN forever and the button appears to do nothing.
    await resolveOwnedWork({
      kind: "PAID_NOT_FINALIZED",
      dedupeKey: bookingRequestId,
      note: "Booking is already complete; the exception was cleared on retry.",
    });
    return { status: "ALREADY_BOOKED" };
  }
  if (!booking.stripePaymentIntentId) {
    throw new Error("This booking has no PaymentIntent — nothing was paid to finalize");
  }
  const pi = await stripeClient().paymentIntents.retrieve(
    booking.stripePaymentIntentId
  );
  if (pi.status !== "succeeded") {
    throw new Error(
      `The Stripe payment is ${pi.status}, not succeeded — do not finalize an unpaid booking`
    );
  }
  await finalizeBooking({
    bookingRequestId,
    paymentIntentId: pi.id,
    amountReceived: pi.amount_received,
    paymentMethodId:
      typeof pi.payment_method === "string"
        ? pi.payment_method
        : (pi.payment_method?.id ?? null),
  });
  // Confirm it actually finished. finalizeBooking is void and returns silently
  // if a live delivery holds the claim, so re-read and never report FINALIZED
  // on a booking that is still incomplete.
  const { data: after } = await client.models.BookingRequest.get({
    id: bookingRequestId,
  });
  if (after?.status !== "BOOKED") {
    throw new Error(
      "Finalization ran but the booking is still not complete — check the exception detail and try again, or escalate to engineering."
    );
  }
  return { status: "FINALIZED" };
}

/** Amplify stamps createdAt on every row; a claim older than this (2x the 30s
 *  webhook Lambda timeout) cannot belong to a still-running finalization. */
const ORPHAN_CLAIM_MS = 60_000;

/**
 * Distinguish a live claim holder from a dead one and, if dead, steal the claim
 * so this delivery can resume. Returns whether this caller now owns the claim.
 */
async function reclaimOrphanedClaim(
  id: string
): Promise<{ won: true; holder: string } | { won: false }> {
  const client = await dataClient();
  const holder = randomUUID();
  const { data: held } = await client.models.BookingFinalization.get({ id });
  if (!held) {
    // Vanished between the failed create and this get (the holder finished and
    // deleted it, or another reclaim won) — try to take it.
    const { data } = await client.models.BookingFinalization.create({
      id,
      note: "reclaim",
      holder,
      leaseUntil: new Date(Date.now() + ORPHAN_CLAIM_MS).toISOString(),
    });
    return data ? { won: true, holder } : { won: false };
  }
  const createdMs = held.createdAt ? new Date(held.createdAt).getTime() : NaN;
  if (Number.isNaN(createdMs) || Date.now() - createdMs < ORPHAN_CLAIM_MS) {
    return { won: false }; // young claim — a live delivery still owns it
  }
  // Orphaned: the holder was killed before it could release. The steal is ONE
  // guarded update conditioned on "no live lease" — never delete-then-create,
  // which would let two reclaimers both believe they own the finalization and
  // both drive it. A legacy pre-lease row has no leaseUntil, which the guard
  // treats as not-live (the age check above already refused young rows).
  const takeover = await casTakeover("BookingFinalization", id, {
    nonceField: "holder",
    nonce: holder,
    leaseField: "leaseUntil",
    leaseMs: ORPHAN_CLAIM_MS,
  });
  if (takeover.ok) return { won: true, holder };
  if (takeover.reason === "LOST") return { won: false };
  // UNSUPPORTED (unit fakes / deploy straddling): takeover is impossible for
  // every racer, so the age check above is the only gate — matching the
  // pre-lease behavior where the conditional create was the serializer.
  await client.models.BookingFinalization.delete({ id });
  const { data } = await client.models.BookingFinalization.create({
    id,
    note: "reclaimed orphan",
    holder,
  });
  return data ? { won: true, holder } : { won: false };
}

/**
 * Create a record with a deterministic id, or return the one a prior attempt
 * already created. This is what makes finalization resumable: on a retry, the
 * conditional create fails because the id exists, and we read it back instead
 * of minting a duplicate customer/plan/job/agreement/invoice.
 */
// Loose (non-generic) on purpose: the generated Amplify create/get result types
// are near the compiler's instantiation-depth ceiling for this project, and a
// generic here tips it over. The callers only need the id back.
async function createOrGet(
  what: string,
  create: () => Promise<{
    data: { id?: string | null } | null;
    errors?: { message: string }[];
  }>,
  get: () => Promise<{ data: { id?: string | null } | null }>
): Promise<{ id?: string | null }> {
  const { data, errors } = await create();
  if (data) return data;
  const { data: existing } = await get();
  if (existing) return existing;
  throw new Error(
    `${what} could not be created or resolved: ${
      errors?.map((e) => e.message).join("; ") ?? "unknown error"
    }`
  );
}

/** Only the fields finalization reads — the generated model type is too
 *  deep for the compiler to compare across this boundary. */
type BookingRecord = {
  id: string;
  status?: string | null;
  name: string;
  email: string;
  phone?: string | null;
  street?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  quoteJson?: unknown;
  attribution?: unknown;
  selectedDate?: string | null;
  selectedWindow?: string | null;
  recurring?: boolean | null;
  amountCents?: number | null;
  cancelToken?: string | null;
  leadCustomerId?: string | null;
  stripeCustomerId?: string | null;
  stripePaymentIntentId?: string | null;
  // Progress checkpoints written as finalization proceeds, so a resumed run
  // reuses the records a prior attempt already created instead of re-deriving
  // (and possibly duplicating) them. customerId is the load-bearing one: a
  // customer's id is not derivable from the booking, so it must be recorded.
  customerId?: string | null;
  jobId?: string | null;
  servicePlanId?: string | null;
  agreementId?: string | null;
  // Durable communication-outbox markers (GL-05). A nonblank value means that
  // exact message has already gone out, so a resumed finalization never resends
  // it. Written only after a successful send.
  confirmationSentAt?: string | null;
  officeAlertSentAt?: string | null;
};

/** First-touch ad attribution as sanitized and stored at /quote. */
type Attribution = {
  source?: string;
  medium?: string;
  campaign?: string;
  term?: string;
  content?: string;
  gclid?: string;
  referrer?: string;
  landingPage?: string;
};

/** The stored field is a.json() written as a string at /quote; be tolerant of
 *  either shape and of junk — attribution must never break a finalization. */
function parseAttribution(raw: unknown): Attribution | null {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const out: Attribution = {};
  for (const key of [
    "source",
    "medium",
    "campaign",
    "term",
    "content",
    "gclid",
    "referrer",
    "landingPage",
  ] as const) {
    const v = (value as Record<string, unknown>)[key];
    if (typeof v === "string" && v.trim()) out[key] = v.trim();
  }
  return Object.keys(out).length ? out : null;
}

/**
 * The lead source the office sees on the customer — mirrors lead-intake's
 * sourceLabel: the channel, plus the utm source when the click carried one.
 */
function bookingSourceLabel(attribution: Attribution | null): string {
  const utm = attribution?.source?.trim();
  return utm ? `Website booking · utm:${utm}` : "Website booking";
}

/** Attribution lines for the customer's lead notes, in lead-intake's
 *  buildLeadNotes label style — only the fields actually present. */
function attributionNotes(attribution: Attribution | null): string | undefined {
  if (!attribution) return undefined;
  const lines: string[] = [];
  const add = (label: string, v: string | undefined) => {
    const t = (v ?? "").trim();
    if (t) lines.push(`${label}: ${t}`);
  };
  add("Campaign", attribution.campaign);
  add("Medium", attribution.medium);
  add("Term", attribution.term);
  add("Content", attribution.content);
  add("Google click id", attribution.gclid);
  add("Landing page", attribution.landingPage);
  add("Referrer", attribution.referrer);
  return lines.length ? lines.join("\n") : undefined;
}

/** Only the fields conversion touches on an existing customer. */
type ExistingCustomer = {
  id: string;
  status?: string | null;
  email?: string | null;
  contactName?: string | null;
  phone?: string | null;
  serviceStreet?: string | null;
  serviceCity?: string | null;
  serviceState?: string | null;
  serviceZip?: string | null;
  leadSource?: string | null;
  leadNotes?: string | null;
  stripeCustomerId?: string | null;
  convertedAt?: string | null;
  groupId?: string | null;
  portalUserSub?: string | null;
};

/**
 * The slice of the data client the conversion helpers touch, structurally.
 * The generated client type is too deep for the compiler to name across
 * this boundary (same reason BookingRecord exists) — call sites cast
 * through unknown.
 */
type FinalizeDataClient = {
  models: {
    Customer: {
      get: (args: { id: string }) => Promise<{
        data: ExistingCustomer | null;
      }>;
      list: (args: object) => Promise<{
        data: ExistingCustomer[];
        nextToken?: string | null;
      }>;
      update: (args: object) => Promise<{
        data: { id: string; groupId?: string | null } | null;
      }>;
    };
    LeadPricingRun: {
      list: (args: object) => Promise<{
        data: { id: string; outcome?: string | null }[];
        nextToken?: string | null;
      }>;
      update: (args: object) => Promise<unknown>;
    };
  };
};

/**
 * Every customer this booking's email could belong to. A lead the office
 * priced (Thumbtack paste, funnel CONTACT) and then sent to the funnel is
 * the same person who now paid — creating a second record would strand the
 * lead history on a row nobody looks at again. But email alone is a guess:
 * ONE match converts; more than one is ambiguity the caller must not
 * resolve by picking arbitrarily.
 *
 * Case-insensitive compare; Customer has no email index, so this is a
 * paginated list scan (fine at this scale — the office's whole book fits in
 * a few pages).
 */
async function findCustomersByEmail(
  client: FinalizeDataClient,
  email: string
): Promise<ExistingCustomer[]> {
  const target = email.trim().toLowerCase();
  if (!target) return [];
  const hits: ExistingCustomer[] = [];
  let nextToken: string | null | undefined;
  do {
    const page = await client.models.Customer.list({ nextToken, limit: 200 });
    hits.push(
      ...page.data.filter(
        (c) => (c.email ?? "").trim().toLowerCase() === target
      )
    );
    nextToken = page.nextToken;
  } while (nextToken);
  return hits;
}

/**
 * Convert the matched customer instead of duplicating them: status ACTIVE,
 * contact/address gaps filled from the booking (never overwriting what the
 * office already knows), the booking appended to the lead notes, and the
 * original leadSource preserved — the funnel label only lands when the
 * record never had a source.
 *
 * Throws on a failed write; the caller treats that as a match failure and
 * falls back to creating a fresh customer, because a paid finalization must
 * never be bricked by the merge.
 */
async function convertExistingCustomer(
  client: FinalizeDataClient,
  existing: ExistingCustomer,
  booking: BookingRecord,
  funnel: { leadSource: string; leadNotes?: string }
): Promise<{ id: string; groupId?: string | null }> {
  const fillIfMissing = (
    current: string | null | undefined,
    value: string | null | undefined
  ) => (!current?.trim() && value?.trim() ? value : undefined);

  const bookingLine = `Booked online via the website funnel (booking ${booking.id}).`;
  // A lead-identified booking may be paid with a different email (spouse,
  // work inbox, typo at checkout). The office record's email wins — this
  // function never writes email — but the difference is worth a written
  // trace, because it explains why the portal invite went where it did.
  const checkoutEmail = booking.email.trim().toLowerCase();
  const recordEmail = (existing.email ?? "").trim().toLowerCase();
  const emailMismatchLine =
    recordEmail && checkoutEmail && recordEmail !== checkoutEmail
      ? `Checkout email ${booking.email} differs from the email on this record (${existing.email}).`
      : undefined;
  const leadNotes = [
    existing.leadNotes,
    bookingLine,
    emailMismatchLine,
    funnel.leadNotes,
  ]
    .filter((v): v is string => Boolean(v?.trim()))
    .join("\n");

  const patch = {
    id: existing.id,
    status: "ACTIVE" as const,
    convertedAt: existing.convertedAt ?? new Date().toISOString(),
    leadNotes,
    leadSource: fillIfMissing(existing.leadSource, funnel.leadSource),
    contactName: fillIfMissing(existing.contactName, booking.name),
    phone: fillIfMissing(existing.phone, booking.phone),
    serviceStreet: fillIfMissing(existing.serviceStreet, booking.street),
    serviceCity: fillIfMissing(existing.serviceCity, booking.city),
    serviceState: fillIfMissing(existing.serviceState, booking.state),
    serviceZip: fillIfMissing(existing.serviceZip, booking.zip),
    stripeCustomerId: fillIfMissing(
      existing.stripeCustomerId,
      booking.stripeCustomerId
    ),
  };
  let { data: updated } = await client.models.Customer.update(patch);
  if (!updated && patch.phone) {
    // Same rule as the create path: a paid booking must never be bricked by
    // a phone-format rejection — retry the merge without it.
    ({ data: updated } = await client.models.Customer.update({
      ...patch,
      phone: undefined,
    }));
  }
  if (!updated) {
    throw new Error(
      `finalizeBooking: could not convert existing customer ${existing.id}`
    );
  }
  // GL-02: the lead is Won — close any open follow-up so it doesn't keep nagging
  // sales about a customer who already booked. Best-effort and idempotent.
  await resolveOwnedWork({
    kind: "LEAD_FOLLOWUP",
    dedupeKey: existing.id,
    note: "Lead converted to a customer on a paid booking.",
  });
  return { id: updated.id, groupId: updated.groupId };
}

/**
 * R73's auto-WON: the paid funnel booking is this lead's outcome, so every
 * PENDING pricing run linked to the customer flips to WON. Best-effort — a
 * reporting write must never break a paid finalization.
 */
async function markPricingRunsWon(
  client: FinalizeDataClient,
  customerId: string
): Promise<void> {
  try {
    let nextToken: string | null | undefined;
    do {
      const page = await client.models.LeadPricingRun.list({
        filter: { customerId: { eq: customerId } },
        nextToken,
        limit: 200,
      });
      for (const run of page.data) {
        if (run.outcome === "PENDING") {
          await client.models.LeadPricingRun.update({
            id: run.id,
            outcome: "WON",
          });
        }
      }
      nextToken = page.nextToken;
    } while (nextToken);
  } catch (err) {
    console.error(
      `finalizeBooking: could not flip pricing runs to WON for customer ${customerId}`,
      err
    );
  }
}

async function finalizeClaimed(
  booking: BookingRecord,
  paymentIntentId: string,
  paymentMethodId: string | null
): Promise<void> {
  const client = await dataClient();

  // The card that paid for the booking must become the customer's invoice
  // default, or "Start billing" would later report no payment method for
  // exactly the customers who already paid us.
  if (paymentMethodId && booking.stripeCustomerId) {
    try {
      await stripeClient().customers.update(booking.stripeCustomerId, {
        invoice_settings: { default_payment_method: paymentMethodId },
      });
    } catch (err) {
      console.error("finalizeBooking: could not set default payment method", err);
    }
  }

  const stored = JSON.parse(String(booking.quoteJson ?? "{}")) as {
    serviceLabel?: string;
    recurringOffer?: {
      frequency: string;
      monthlyCents: number;
      initialFeeCents: number;
    } | null;
  };
  const serviceLabel = stored.serviceLabel ?? "Pest control service";
  const windowLabel =
    WINDOW_LABEL[booking.selectedWindow ?? ""] ??
    booking.selectedWindow?.toLowerCase() ??
    "";

  // 1. Customer (ACTIVE — they've paid). A lead already in the CRM with this
  // email (Thumbtack paste, funnel CONTACT) CONVERTS instead of duplicating:
  // the booking is that lead's win, and its pricing history should say so.
  // Matching is best-effort — any failure in it falls back to creating a
  // fresh customer (flagged in the office alert), because nothing about the
  // merge may brick a finalization the customer already paid for.
  //
  // Contact details are validated at /quote, but a paid booking must never
  // be bricked by a format rejection: retry without the optional phone
  // rather than fail.
  //
  // The lead source and notes carry the first-touch ad attribution captured
  // at /quote, so a website booking is trackable to its campaign just like a
  // lead-form lead was.
  const attribution = parseAttribution(booking.attribution);
  const leadSource = bookingSourceLabel(attribution);
  const leadNotes = attributionNotes(attribution);
  const matchClient = client as unknown as FinalizeDataClient;
  let customer: { id: string; groupId?: string | null } | null = null;
  let hadPortalLogin = false;
  let reactivatedWithPortal = false;
  let matchFallbackReason: string | null = null;
  // Resume: a prior attempt already resolved (and checkpointed) the customer.
  // Reuse exactly that record — re-running the email match could now find the
  // fresh customer the last attempt created and, if a same-email lead also
  // exists, mint a second one. Identity we already committed to beats matching.
  if (booking.customerId) {
    const { data } = await matchClient.models.Customer.get({
      id: booking.customerId,
    });
    if (data) {
      customer = { id: data.id, groupId: data.groupId };
      hadPortalLogin = Boolean(data.portalUserSub);
    }
  }
  if (!customer) try {
    // Resolution order — identity beats guessing:
    //  1. The booking link's lead reference (leadCustomerId, resolved from
    //     ?lead=<token> at /quote): convert exactly that record, even when
    //     the checkout email differs — that difference is precisely what
    //     email matching gets wrong.
    //  2. No reference → email match, but only when it is UNAMBIGUOUS
    //     (exactly one record). Several records sharing the email means
    //     duplicates or different people on one inbox; converting an
    //     arbitrary one corrupts a record. Create fresh and hand the merge
    //     to a human instead.
    let existing: ExistingCustomer | null = null;
    if (booking.leadCustomerId) {
      const { data } = await matchClient.models.Customer.get({
        id: booking.leadCustomerId,
      });
      existing = data;
      if (!existing) {
        matchFallbackReason = `the booking link's lead reference (${booking.leadCustomerId}) no longer resolves to a customer record`;
      }
    }
    if (!existing && !matchFallbackReason) {
      const matches = await findCustomersByEmail(matchClient, booking.email);
      if (matches.length === 1) {
        existing = matches[0];
      } else if (matches.length > 1) {
        matchFallbackReason = `${matches.length} customer records share the email ${booking.email} (${matches
          .map((m) => m.id)
          .join(", ")}) — a fresh record was created rather than converting an arbitrary one`;
      }
    }
    if (existing) {
      customer = await convertExistingCustomer(matchClient, existing, booking, {
        leadSource,
        leadNotes,
      });
      hadPortalLogin = Boolean(existing.portalUserSub);
      reactivatedWithPortal =
        hadPortalLogin && existing.status === "INACTIVE";
    }
  } catch (err) {
    matchFallbackReason = err instanceof Error ? err.message : String(err);
    console.error(
      "finalizeBooking: lead matching failed — falling back to a fresh customer",
      err
    );
  }
  if (!customer) {
    // The fresh customer gets a deterministic id derived from the booking, and
    // we look for it before creating. This closes the one window the checkpoint
    // can't: if a prior attempt created this customer and died before writing
    // BookingRequest.customerId, a retry would re-match by email — and if a
    // same-email lead also exists, the match is ambiguous and would mint a
    // SECOND fresh record. Keyed by the booking, the create is a no-op on retry.
    const freshId = `cust-${booking.id}`;
    const prior = await client.models.Customer.get({ id: freshId });
    if (prior.data) {
      customer = { id: prior.data.id, groupId: prior.data.groupId };
    } else {
      const base = {
        id: freshId,
        displayName: booking.name,
        contactName: booking.name,
        email: booking.email,
        serviceStreet: booking.street ?? undefined,
        serviceCity: booking.city ?? undefined,
        serviceState: booking.state ?? undefined,
        serviceZip: booking.zip ?? undefined,
        status: "ACTIVE" as const,
        leadSource,
        leadNotes,
        stripeCustomerId: booking.stripeCustomerId ?? undefined,
        convertedAt: new Date().toISOString(),
      };
      let { data: created } = await client.models.Customer.create({
        ...base,
        phone: booking.phone ?? undefined,
      });
      // A paid booking must never be bricked by a phone-format rejection: retry
      // without the optional phone rather than fail.
      if (!created && booking.phone) {
        ({ data: created } = await client.models.Customer.create(base));
      }
      if (!created) throw new Error("finalizeBooking: customer create failed");
      customer = { id: created.id, groupId: created.groupId };
    }
  }
  // Checkpoint the customer id the instant it exists. From here on, any failure
  // and retry resumes onto THIS customer — never a second one. Essential for the
  // convert path: without it, a retry whose email match has since become
  // ambiguous would create a fresh duplicate beside the already-converted lead.
  if (booking.customerId !== customer.id) {
    await client.models.BookingRequest.update({
      id: booking.id,
      customerId: customer.id,
    });
    booking.customerId = customer.id;
  }
  const accessGroups = customerAccessGroups(customer.id, customer.groupId);
  await client.models.Customer.update({ id: customer.id, accessGroups });

  // 1b. The portal login is part of conversion (R41). Every email this
  // customer will now receive — the receipt, the service report, payment
  // recovery — points at the portal, so the login must exist the moment the
  // customer does, not when someone remembers the invite button. A repeat
  // customer who already has one is left alone. Best-effort: a failed invite
  // must never brick a paid finalization — it lands in the owned-work queue
  // (PORTAL_FAILURE) and the manual Invite-to-portal button covers the gap.
  let portalInvited = false;
  if (!hadPortalLogin) {
    try {
      const portal = await provisionPortalLogin({
        customerId: customer.id,
        email: booking.email,
        name: booking.name,
      });
      portalInvited = portal.linkSent;
      if (!portal.linkSent) {
        // The login exists but the invite never went out — the customer
        // doesn't know the portal exists and can't sign in until they get a
        // link. The confirmation email makes no portal promise in this case.
        await openOwnedWork({
          kind: "PORTAL_FAILURE",
          dedupeKey: `booking-invite:${customer.id}`,
          title: `Portal invite email did not send: ${booking.name}`,
          detail: `The paid booking provisioned this customer's portal login, but the magic-link invite email failed to send. Their receipts and payment links point at a portal they have never been told about.`,
          customerId: customer.id,
          relatedId: booking.id,
          sourceUrl: `/customers/${customer.id}`,
          resolutionAction:
            "Open the customer and use “Invite to portal” to resend the sign-in link, then verify it arrived.",
          ownerTeam: "OPS",
        });
      }
    } catch (err) {
      console.error(
        `finalizeBooking: portal provisioning failed for customer ${customer.id}`,
        err
      );
      await openOwnedWork({
        kind: "PORTAL_FAILURE",
        dedupeKey: `booking-invite:${customer.id}`,
        title: `New customer has no portal login: ${booking.name}`,
        detail: `The paid booking converted this customer but their portal login could not be provisioned: ${err instanceof Error ? err.message : String(err)}. Their receipts and payment links point at a portal they cannot sign in to until it exists.`,
        customerId: customer.id,
        relatedId: booking.id,
        sourceUrl: `/customers/${customer.id}`,
        resolutionAction:
          "Open the customer and use “Invite to portal”, then verify they can sign in.",
        ownerTeam: "OPS",
      });
    }
  } else if (reactivatedWithPortal) {
    // Deactivation disables the portal login (revokePortalAccess), and
    // conversion does not re-enable it — restorePortalAccess pairs with the
    // office reactivate button, not the funnel. A re-booking INACTIVE
    // customer therefore arrives here with a login that exists but is likely
    // disabled, while their receipts and pay links assert the portal works.
    // Owned work, not silence.
    await openOwnedWork({
      kind: "PORTAL_FAILURE",
      dedupeKey: `booking-reactivation:${customer.id}`,
      title: `Re-booked customer's portal login may be disabled: ${booking.name}`,
      detail: `This customer was INACTIVE and re-booked through the funnel. Deactivation disables the portal login and booking conversion does not re-enable it, so their existing login may still be disabled while their receipts and payment links point at the portal.`,
      customerId: customer.id,
      relatedId: booking.id,
      sourceUrl: `/customers/${customer.id}`,
      resolutionAction:
        "Restore the customer's portal access (re-enable the login) and verify they can sign in.",
      ownerTeam: "OPS",
    });
  }

  if (matchFallbackReason) {
    await openOwnedWork({
      kind: "DUPLICATE_LEAD",
      dedupeKey: booking.id,
      title: `Check possible duplicate lead: ${booking.name}`,
      detail: `The paid booking created customer ${customer.id} after the existing-lead match failed for ${booking.email}: ${matchFallbackReason}`,
      customerId: customer.id,
      relatedId: booking.id,
      sourceUrl: `/customers/${customer.id}`,
      resolutionAction:
        "Search for the existing lead by email, merge or cross-reference the records, and preserve the original source and pricing history.",
      ownerTeam: "SALES",
    });
  }

  // R73: the booking is the outcome of this customer's pricing runs.
  await markPricingRunsWon(matchClient, customer.id);

  // 2. Plan (recurring) — billing starts after the first visit completes. A
  // deterministic id makes the create idempotent: a retry resumes onto the same
  // plan instead of standing up a second subscription for one booking.
  let plan: { id?: string | null } | null = null;
  if (booking.recurring && stored.recurringOffer) {
    const offer = stored.recurringOffer;
    const planId = `plan-${booking.id}`;
    plan = await createOrGet(
      "service plan",
      () =>
        client.models.ServicePlan.create({
          id: planId,
          customerId: customer.id,
          planName: serviceLabel.replace(/ — .*$/, "") + " plan",
          priceCents: offer.monthlyCents,
          serviceFrequency: offer.frequency as
            | "MONTHLY"
            | "BIMONTHLY"
            | "QUARTERLY",
          status: "ACTIVE",
          startDate: booking.selectedDate ?? undefined,
          // GL-17: seasonal facts are stamped at enrollment from the accepted
          // offer — mosquito / mosquito+tick bills monthly year-round and owes
          // one treatment per month April–October. Billing starts immediately
          // even off-season; the first in-season treatment satisfies its month.
          ...(isSeasonalPlanName(serviceLabel)
            ? { seasonal: true, serviceMonths: [...SEASONAL_SERVICE_MONTHS] }
            : {}),
          notes: "Booked online via the website funnel",
          accessGroups,
        }),
      () => client.models.ServicePlan.get({ id: planId })
    );
    // GL-17: an in-season enrollment's first visit is that calendar month's
    // treatment obligation (SCHEDULED now, SATISFIED when it completes). An
    // off-season enrollment creates no obligation — billing starts now, the
    // first obligation is next April, created when its visit is queued.
    if (isSeasonalPlanName(serviceLabel) && booking.selectedDate && plan?.id) {
      const monthKey = booking.selectedDate.slice(0, 7);
      if (isServiceMonth({ seasonal: true }, monthKey)) {
        await ensureObligation({
          servicePlanId: plan.id,
          customerId: customer.id,
          monthKey,
          status: "SCHEDULED",
          jobId: `job-${booking.id}`,
          accessGroups,
        });
      }
    }
  }
  const servicePlanId = plan?.id ?? undefined;

  // 3. The scheduled first job — already paid, deterministic id (idempotent
  // resume). paidAt/paidPaymentIntentId ride in the same create so "already
  // paid" is true the instant the job exists.
  const paidAtIso = new Date().toISOString();
  const jobId = `job-${booking.id}`;
  const job = await createOrGet(
    "job",
    () =>
      client.models.Job.create({
        id: jobId,
        customerId: customer.id,
        servicePlanId,
        type: booking.recurring ? "RECURRING" : "ONE_TIME",
        serviceType: serviceLabel,
        scheduledDate: booking.selectedDate ?? undefined,
        timeWindow: windowLabel,
        priceCents: booking.amountCents ?? undefined,
        status: "SCHEDULED",
        paidAt: booking.amountCents ? paidAtIso : undefined,
        paidPaymentIntentId: booking.amountCents ? paymentIntentId : undefined,
        notes: `Website booking ${booking.id}. Paid up front (${paymentIntentId}).`,
        accessGroups,
      }),
    () => client.models.Job.get({ id: jobId })
  );

  // 3b. The money moved at checkout, so the ledger records it here — a PAID
  // invoice, id derived from the booking. It is REQUIRED now: because every
  // record above is idempotent, a failed invoice write can throw and be retried
  // without duplicating anything, so a booking never reaches BOOKED with its
  // payment missing from the ledger. (It used to be best-effort precisely
  // because a throw would have duplicated the then-non-idempotent
  // customer/plan/job — that constraint is gone.)
  let invoice: { id?: string | null } | null = null;
  if (booking.amountCents) {
    const invoiceId = `booking-${booking.id}`;
    const amountCents = booking.amountCents;
    invoice = await createOrGet(
      "paid invoice",
      () =>
        client.models.Invoice.create({
          id: invoiceId,
          customerId: customer.id,
          jobId: job.id ?? undefined,
          servicePlanId,
          description: `${serviceLabel} — paid online at booking`,
          amountCents,
          status: "PAID",
          method: "CARD",
          stripePaymentIntentId: paymentIntentId,
          issuedAt: paidAtIso,
          paidAt: paidAtIso,
          accessGroups,
        }),
      () => client.models.Invoice.get({ id: invoiceId })
    );
  }

  // 4. T&C acceptance becomes the signed agreement + PDF on file.
  const signedAtIso = new Date().toISOString();
  const bodyText = [
    `SERVICE AGREEMENT. BuzzKill Pest Control will provide: ${serviceLabel} at ${[booking.street, booking.city, booking.state, booking.zip].filter(Boolean).join(", ")} on ${booking.selectedDate} (${windowLabel}).`,
    booking.recurring && stored.recurringOffer
      ? `RECURRING PLAN. After the initial visit, service continues ${stored.recurringOffer.frequency.toLowerCase()} at $${(stored.recurringOffer.monthlyCents / 100).toFixed(2)}/month, billed automatically. Cancel anytime.`
      : null,
    `PAYMENT. $${((booking.amountCents ?? 0) / 100).toFixed(2)} paid online at booking.`,
    CANCEL_POLICY_TEXT,
    "ACCEPTANCE. The customer accepted these terms and the cancellation policy via checkbox at online checkout; that acceptance is recorded as the electronic signature below.",
  ]
    .filter(Boolean)
    .join("\n\n");

  const pdf = await renderAgreementPdf({
    agreementId: booking.id,
    title: "BuzzKill Service Agreement — Online Booking",
    bodyText,
    customerName: booking.name,
    customerAddress: [booking.street, booking.city, booking.state, booking.zip]
      .filter(Boolean)
      .join(", "),
    signerName: booking.name,
    signerEmail: booking.email,
    signatureDataUrl: null,
    signedAtIso,
  });
  const bucket = process.env.DOCS_BUCKET;
  let pdfKey: string | undefined;
  if (bucket) {
    pdfKey = `agreements/${customer.id}/booking-${booking.id}.pdf`;
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: pdfKey,
        Body: pdf,
        ContentType: "application/pdf",
      })
    );
  }
  const agreementId = `agr-${booking.id}`;
  const agreement = await createOrGet(
    "agreement",
    () =>
      client.models.Agreement.create({
        id: agreementId,
        customerId: customer.id,
        title: "BuzzKill Service Agreement — Online Booking",
        bodyText,
        status: "SIGNED",
        signedAt: signedAtIso,
        signerName: booking.name,
        signerEmail: booking.email,
        sentAt: signedAtIso,
        pdfKey,
        accessGroups,
      }),
    () => client.models.Agreement.get({ id: agreementId })
  );

  // GL-05: the booking reaches BOOKED only when every required record exists.
  // Asserting here — rather than trusting the creates — means a silent null
  // return can never mark a paid booking complete with a missing job,
  // agreement, or ledger row. A thrown assertion opens the paid-not-finalized
  // exception and releases the claim for an idempotent retry.
  if (!job.id) throw new Error("job did not persist");
  if (!agreement.id) throw new Error("agreement did not persist");
  if (booking.amountCents && !invoice?.id) {
    throw new Error("paid invoice did not persist");
  }
  if (booking.recurring && stored.recurringOffer && !servicePlanId) {
    throw new Error("recurring plan did not persist");
  }

  // The BOOKED write is the commitment. Trust its result, not the fact that we
  // called update: if it did not persist, the child records exist but the
  // booking is still QUOTED, so we must NOT send a confirmation that claims
  // completion. Throwing here opens the paid-not-finalized exception and
  // releases the claim; the retry resumes idempotently onto the same records.
  const { data: booked } = await client.models.BookingRequest.update({
    id: booking.id,
    status: "BOOKED",
    customerId: customer.id,
    jobId: job.id,
    servicePlanId,
    agreementId: agreement.id,
  });
  if (!booked) throw new Error("booking did not transition to BOOKED");
  booking.status = "BOOKED";
  booking.customerId = customer.id;
  booking.jobId = job.id ?? booking.jobId;
  booking.agreementId = agreement.id ?? booking.agreementId;

  // 5. Communications happen only AFTER the commitment exists. Delivery is
  // idempotent and durably marked, so a hard kill between the BOOKED write and
  // either send is picked up on the next webhook delivery and only the unsent
  // message goes out. A send failure never un-books a whole booking — it lands
  // in the owned-work queue as a resend path.
  await deliverBookingComms(booking, {
    serviceLabel,
    windowLabel,
    recurringOffer: stored.recurringOffer ?? null,
    portalInvited,
    matchFallbackReason,
    pdf,
    pdfKey,
  });
}

/**
 * Durable communication outbox for a finalized booking (GL-05). Sends the
 * customer confirmation and the sales alert, each gated on its own persisted
 * sent marker so nothing is delivered twice and a resumed finalization delivers
 * only what a prior attempt did not. Best-effort per message: a failed send is
 * owned work with a resend action, never a throw that would un-book the booking.
 *
 * `ctx` carries what only the finalizing pass knows (the rendered PDF, whether a
 * portal invite went out, whether lead-matching fell back). On the resume path
 * (`ctx === null`, invoked from a redelivery for an already-BOOKED booking) that
 * context is reconstructed from the persisted booking, and the agreement PDF is
 * re-fetched from S3 so a customer who was killed before their first send still
 * receives the agreement.
 */
/** GL-05 — how long one delivery attempt may hold a comms-send claim before a
 *  retry may reclaim it (the webhook Lambda timeout is 30s). */
const COMMS_CLAIM_STALE_MS = 90_000;

/**
 * GL-05 — claim one booking communication before the provider send.
 *  WON        — this caller sends.
 *  HELD       — another live delivery is sending right now; skip.
 *  RECLAIMED  — a prior attempt crashed in the ambiguous window; this caller
 *               must consult the EmailLog before re-sending.
 */
async function claimCommsSend(
  claimId: string
): Promise<{ state: "WON" | "HELD" | "RECLAIMED"; holder: string }> {
  const client = await dataClient();
  const holder = randomUUID();
  // A fake or a container straddling a schema deploy may lack the model; the
  // marker + EmailLog checks still bound the duplicate risk to the old level.
  if (!("BookingCommsSend" in client.models)) return { state: "WON", holder };
  const attempt = async () => {
    const { data } = await client.models.BookingCommsSend.create({
      id: claimId,
      requestedAt: new Date().toISOString(),
      holder,
      leaseUntil: new Date(Date.now() + COMMS_CLAIM_STALE_MS).toISOString(),
    });
    return Boolean(data);
  };
  if (await attempt()) return { state: "WON", holder };
  const { data: held } = await client.models.BookingCommsSend.get({
    id: claimId,
  });
  if (
    held?.requestedAt &&
    Date.now() - Date.parse(held.requestedAt) < COMMS_CLAIM_STALE_MS
  ) {
    return { state: "HELD", holder };
  }
  if (!held) {
    // Released between our create and get — one more conditional create.
    return (await attempt())
      ? { state: "RECLAIMED", holder }
      : { state: "HELD", holder };
  }
  // Stale: seize the claim with ONE guarded update — never delete-then-create,
  // which would let two reclaimers both "win" and both email the customer.
  const takeover = await casTakeover("BookingCommsSend", claimId, {
    nonceField: "holder",
    nonce: holder,
    leaseField: "leaseUntil",
    leaseMs: COMMS_CLAIM_STALE_MS,
  });
  if (takeover.ok) return { state: "RECLAIMED", holder };
  if (takeover.reason === "LOST") return { state: "HELD", holder };
  // UNSUPPORTED: takeover impossible for every racer; the requestedAt age gate
  // above plus the EmailLog adoption check bound the duplicate risk to the
  // pre-lease level.
  await client.models.BookingCommsSend.delete({ id: claimId }).catch(
    () => undefined
  );
  return (await attempt())
    ? { state: "RECLAIMED", holder }
    : { state: "HELD", holder };
}

/** Fenced release — an expired sender waking up late can never delete a newer
 *  sender's outbox claim. */
async function releaseCommsSend(claimId: string, holder: string): Promise<void> {
  const released = await casFencedDelete("BookingCommsSend", claimId, {
    field: "holder",
    nonce: holder,
    allowMissingFence: true,
  });
  if (released !== "UNSUPPORTED") return;
  const client = await dataClient();
  if (!("BookingCommsSend" in client.models)) return;
  await client.models.BookingCommsSend.delete({ id: claimId }).catch(
    () => undefined
  );
}

/** GL-05 — did a prior attempt's send actually leave (provider accepted)?
 *  The EmailLog is the outbox truth for the ambiguous crash window. */
async function priorAcceptedBookingSend(
  bookingId: string,
  template: string
): Promise<boolean> {
  try {
    const client = await dataClient();
    if (!("EmailLog" in client.models)) return false;
    const { data } = await client.models.EmailLog.listEmailLogByRelatedId(
      { relatedId: bookingId },
      { limit: 50 }
    );
    return (data ?? []).some(
      (l) =>
        l.template === template &&
        (l.deliveryStatus === "SENT" || l.deliveryStatus === "DELIVERED")
    );
  } catch (err) {
    console.error("priorAcceptedBookingSend failed", bookingId, err);
    // Unknown ≠ safe to resend — treat as sent and let the owned marker work
    // sort it out rather than double-emailing a customer.
    return true;
  }
}

async function deliverBookingComms(
  booking: BookingRecord,
  ctx: {
    serviceLabel: string;
    windowLabel: string;
    recurringOffer: { frequency: string; monthlyCents: number } | null;
    portalInvited: boolean;
    matchFallbackReason: string | null;
    pdf: Uint8Array;
    pdfKey: string | undefined;
  } | null
): Promise<void> {
  // Nothing left to do — both messages already went out. Cheap fast-path for
  // the common redelivery of a fully-finalized booking.
  if (booking.confirmationSentAt && booking.officeAlertSentAt) return;

  const marketingUrl = process.env.MARKETING_URL ?? "https://www.pestbuzzkill.com";
  const customerId = booking.customerId ?? undefined;

  let serviceLabel: string;
  let windowLabel: string;
  let recurringOffer: { frequency: string; monthlyCents: number } | null;
  let portalInvited: boolean;
  let matchFallbackReason: string | null;
  let pdf: Uint8Array | null;
  let pdfKey: string | undefined;
  if (ctx) {
    ({ serviceLabel, windowLabel, recurringOffer, portalInvited, matchFallbackReason, pdf, pdfKey } = ctx);
  } else {
    // Resume path: rebuild from the persisted booking. A redelivery cannot know
    // whether the invite went out or whether matching fell back, so it makes no
    // portal promise and adds no fallback note — both concerns already have
    // their own durable owned-work items from the original pass.
    const stored = JSON.parse(String(booking.quoteJson ?? "{}")) as {
      serviceLabel?: string;
      recurringOffer?: { frequency: string; monthlyCents: number } | null;
    };
    serviceLabel = stored.serviceLabel ?? "Pest control service";
    windowLabel =
      WINDOW_LABEL[booking.selectedWindow ?? ""] ??
      booking.selectedWindow?.toLowerCase() ??
      "";
    recurringOffer = booking.recurring ? stored.recurringOffer ?? null : null;
    portalInvited = false;
    matchFallbackReason = null;
    pdfKey =
      process.env.DOCS_BUCKET && booking.customerId
        ? `agreements/${booking.customerId}/booking-${booking.id}.pdf`
        : undefined;
    pdf = await loadAgreementPdf(pdfKey);
  }

  if (!booking.confirmationSentAt) {
    // GL-05: the outbox claim closes the accepted-but-marker-not-stored
    // window. HELD means another live delivery is mid-send — skip, never race
    // a second email. A RECLAIMED stale claim consults the EmailLog first and
    // adopts a proven send instead of duplicating.
    const claimId = `confirm:${booking.id}`;
    const claim = await claimCommsSend(claimId);
    if (claim.state === "HELD") return;
    if (
      claim.state === "RECLAIMED" &&
      (await priorAcceptedBookingSend(booking.id, "booking-confirmation"))
    ) {
      await stampCommsMarker(booking, "confirmationSentAt");
      await releaseCommsSend(claimId, claim.holder);
    } else {
    let sent = false;
    try {
      sent = await sendEmail({
        to: booking.email,
        subject: `You're booked: ${booking.selectedDate} — BuzzKill Pest Control`,
        template: "booking-confirmation",
        customerId,
        relatedId: booking.id,
        attachments:
          pdfKey && pdf
            ? [
                {
                  filename: "BuzzKill-Service-Agreement.pdf",
                  content: pdf,
                  contentType: "application/pdf",
                },
              ]
            : undefined,
        html: emailShell(
          "Your visit is booked",
          `<p>Hi ${booking.name},</p>
       <p><strong>${serviceLabel}</strong><br/>
       ${booking.selectedDate} · ${windowLabel}<br/>
       ${[booking.street, booking.city, booking.state].filter(Boolean).join(", ")}</p>
       <p>Payment of <strong>$${((booking.amountCents ?? 0) / 100).toFixed(2)}</strong> is confirmed${
         booking.recurring && recurringOffer
           ? `, and your ${recurringOffer.frequency.toLowerCase()} plan ($${(recurringOffer.monthlyCents / 100).toFixed(2)}/mo) starts after this first visit`
           : ""
       }.${pdfKey && pdf ? " Your service agreement is attached." : ""}</p>
       <p>We'll remind you 7 days and 1 day before the visit.</p>${
         portalInvited
           ? `
       <p>Your customer portal sign-in link is on its way in a separate email — your visits, service reports, and receipts live there.</p>`
           : ""
       }
       <p style="color:#666;font-size:13px;">Need to cancel? Use this link: ${marketingUrl}/cancel?token=${booking.cancelToken} — more than ${CANCEL_FULL_REFUND_DAYS} days out is a full refund; ${CANCEL_FULL_REFUND_DAYS} days or less is non-refundable.</p>`
        ),
      });
    } catch (err) {
      console.error("finalizeBooking: confirmation send threw", err);
    }
    if (sent) {
      await stampCommsMarker(booking, "confirmationSentAt");
    } else {
      // sendEmail already opened a generic EMAIL_FAILURE; add the booking-shaped
      // one with the resend action, and leave the marker unset so the next
      // delivery retries.
      await openOwnedWork({
        kind: "EMAIL_FAILURE",
        dedupeKey: `booking-confirmation:${booking.id}`,
        title: `Booking confirmation didn't send: ${booking.name}`,
        detail: `The booking is finalized, but the confirmation email to ${booking.email} did not send. It will be retried on the next webhook delivery.`,
        customerId,
        relatedId: booking.id,
        sourceUrl: customerId ? `/customers/${customerId}` : undefined,
        resolutionAction:
          "Resend the booking confirmation (with the agreement) to the customer, then verify it arrived.",
        ownerTeam: "OPS",
      });
    }
    await releaseCommsSend(claimId, claim.holder);
    }
  }

  // R80: a paid website booking is a lead landing — route it to sales@.
  if (!booking.officeAlertSentAt) {
    let sent = false;
    try {
      sent = await notifyLeads({
        subject: `Website booking: ${booking.name} — ${booking.selectedDate}`,
        template: "office-booking-alert",
        heading: "New paid website booking",
        customerId,
        relatedId: booking.id,
        bodyHtml: `<p><strong>${booking.name}</strong> booked <strong>${serviceLabel}</strong> for ${booking.selectedDate} (${windowLabel}) at ${[booking.street, booking.city].filter(Boolean).join(", ")} — $${((booking.amountCents ?? 0) / 100).toFixed(2)} paid.${booking.recurring ? " Recurring plan starts after the first visit." : ""}</p>
         <p>The job is on the Needs-scheduling board for route assignment.</p>${
           matchFallbackReason
             ? `<p><strong>Heads up:</strong> matching this booking to an existing CRM lead failed, so a fresh customer record was created instead. If a lead with the email ${booking.email} already exists, merge the two by hand.</p>
         <p style="color:#666;font-size:13px;">Reason: ${matchFallbackReason}</p>`
             : ""
         }`,
      });
    } catch (err) {
      console.error("finalizeBooking: sales alert send threw", err);
    }
    if (sent) {
      await stampCommsMarker(booking, "officeAlertSentAt");
    } else {
      await openOwnedWork({
        kind: "EMAIL_FAILURE",
        dedupeKey: `booking-sales-alert:${booking.id}`,
        title: `Website-booking sales alert didn't send: ${booking.name}`,
        detail: `The booking is finalized, but the sales@ new-booking alert did not send. The job is on the Needs-scheduling board; the alert will be retried on the next webhook delivery.`,
        customerId,
        relatedId: booking.id,
        sourceUrl: customerId ? `/customers/${customerId}` : undefined,
        resolutionAction:
          "Let sales know a new website booking landed and needs route assignment.",
        ownerTeam: "SALES",
      });
    }
  }
}

/** Persist an outbox marker the instant its send succeeds, and mirror it onto
 *  the in-memory booking so a later marker write in the same pass sees it.
 *  Concrete per-field patches (not a computed key) keep the generated update
 *  input type shallow — this model file already sits at the compiler's
 *  instantiation-depth ceiling. */
async function stampCommsMarker(
  booking: BookingRecord,
  field: "confirmationSentAt" | "officeAlertSentAt"
): Promise<void> {
  const nowIso = new Date().toISOString();
  booking[field] = nowIso;
  const write = async (): Promise<boolean> => {
    const client = await dataClient();
    const { data } = await client.models.BookingRequest.update(
      field === "confirmationSentAt"
        ? {
            id: booking.id,
            confirmationSentAt: nowIso,
            // Provider ACCEPTANCE — ses-events upgrades to DELIVERED or
            // corrects to BOUNCED/COMPLAINED (never presented as delivery).
            confirmationDeliveryStatus: "SENT",
          }
        : { id: booking.id, officeAlertSentAt: nowIso }
    );
    return Boolean(data);
  };
  let recorded = false;
  try {
    recorded = await write();
    if (!recorded) recorded = await write(); // one retry before owning it
  } catch (err) {
    console.error(`finalizeBooking: could not stamp ${field} for ${booking.id}`, err);
    try {
      recorded = await write();
    } catch {
      recorded = false;
    }
  }
  if (!recorded) {
    // GL-05: "sent but not recorded" is VISIBLE owned work, never a log line —
    // the outbox claim prevents the duplicate; this owns the inconsistency.
    await openOwnedWork({
      kind: "EMAIL_FAILURE",
      dedupeKey: `booking-marker:${booking.id}:${field}`,
      title: `A booking message was sent but not recorded: ${booking.name}`,
      detail: `The ${field === "confirmationSentAt" ? "customer confirmation" : "sales alert"} for booking ${booking.id} WAS accepted by the provider, but the sent-marker could not be stored. Do not blind-resend — verify the email log, then set the marker.`,
      customerId: booking.customerId ?? undefined,
      relatedId: booking.id,
      sourceUrl: booking.customerId ? `/customers/${booking.customerId}` : undefined,
      resolutionAction:
        "Check the email log for this booking. If the send is there, record the marker (re-run finalization adopts it); only resend if nothing was accepted.",
      ownerTeam: "OPS",
    });
  }
}

/** Best-effort re-fetch of the stored agreement PDF for a resumed confirmation
 *  send. A missing object just means the confirmation goes out without the
 *  attachment (the agreement also lives in the customer portal). */
async function loadAgreementPdf(pdfKey?: string): Promise<Uint8Array | null> {
  const bucket = process.env.DOCS_BUCKET;
  if (!bucket || !pdfKey) return null;
  try {
    const res = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: pdfKey })
    );
    const bytes = await res.Body?.transformToByteArray();
    return bytes ?? null;
  } catch (err) {
    console.error(`finalizeBooking: could not load agreement PDF ${pdfKey}`, err);
    return null;
  }
}
