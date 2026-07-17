import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { CANCEL_FULL_REFUND_DAYS } from "./bookingTerms";
import { dataClient } from "./dataClient";
import { customerAccessGroups } from "./dynamicGroups";
import { emailShell, notifyOffice, sendEmail } from "./email";
import { renderAgreementPdf } from "./pdf";
import { stripeClient } from "./stripeClient";

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
  if (!booking || booking.status !== "QUOTED") return; // already finalized/canceled

  // The record is mutable and /book can be retried, so trust the money, not
  // the record: only the PaymentIntent this booking currently points at, for
  // exactly the amount it says, may create records. Otherwise a stale
  // client_secret for a cheap day could buy the premium slot the record was
  // later repointed at.
  if (
    booking.stripePaymentIntentId &&
    opts.paymentIntentId !== booking.stripePaymentIntentId
  ) {
    console.warn(
      `finalizeBooking: ignoring superseded PaymentIntent ${opts.paymentIntentId} for booking ${booking.id}`
    );
    return;
  }
  if (opts.amountReceived !== booking.amountCents) {
    console.error(
      `finalizeBooking: amount mismatch for booking ${booking.id} — paid ${opts.amountReceived}, quoted ${booking.amountCents}`
    );
    return;
  }

  // Atomic claim — `create` is conditional on the id not existing, so only
  // one concurrent webhook delivery proceeds. Released on failure so a
  // Stripe retry can pick the work back up.
  const { data: claim } = await client.models.BookingFinalization.create({
    id: opts.bookingRequestId,
    note: `pi ${opts.paymentIntentId}`,
  });
  if (!claim) return; // another delivery already owns this booking

  try {
    await finalizeClaimed(
      booking,
      opts.paymentIntentId,
      opts.paymentMethodId ?? null
    );
  } catch (err) {
    await client.models.BookingFinalization.delete({
      id: opts.bookingRequestId,
    });
    throw err;
  }
}

/** Only the fields finalization reads — the generated model type is too
 *  deep for the compiler to compare across this boundary. */
type BookingRecord = {
  id: string;
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
  stripeCustomerId?: string | null;
  stripePaymentIntentId?: string | null;
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
 * The customer this booking's email already belongs to, if any. A lead the
 * office priced (Thumbtack paste, funnel CONTACT) and then sent to the funnel
 * is the same person who now paid — creating a second record would strand
 * the lead history on a row nobody looks at again.
 *
 * Case-insensitive compare; Customer has no email index, so this is a
 * paginated list scan (fine at this scale — the office's whole book fits in
 * a few pages).
 */
async function findCustomerByEmail(
  client: FinalizeDataClient,
  email: string
): Promise<ExistingCustomer | null> {
  const target = email.trim().toLowerCase();
  if (!target) return null;
  let nextToken: string | null | undefined;
  do {
    const page = await client.models.Customer.list({ nextToken, limit: 200 });
    const hit = page.data.find(
      (c) => (c.email ?? "").trim().toLowerCase() === target
    );
    if (hit) return hit;
    nextToken = page.nextToken;
  } while (nextToken);
  return null;
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
  const leadNotes = [existing.leadNotes, bookingLine, funnel.leadNotes]
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
  let matchFallbackReason: string | null = null;
  try {
    const existing = await findCustomerByEmail(matchClient, booking.email);
    if (existing) {
      customer = await convertExistingCustomer(matchClient, existing, booking, {
        leadSource,
        leadNotes,
      });
    }
  } catch (err) {
    matchFallbackReason = err instanceof Error ? err.message : String(err);
    console.error(
      "finalizeBooking: lead matching failed — falling back to a fresh customer",
      err
    );
  }
  if (!customer) {
    let { data: created } = await client.models.Customer.create({
      displayName: booking.name,
      contactName: booking.name,
      email: booking.email,
      phone: booking.phone ?? undefined,
      serviceStreet: booking.street ?? undefined,
      serviceCity: booking.city ?? undefined,
      serviceState: booking.state ?? undefined,
      serviceZip: booking.zip ?? undefined,
      status: "ACTIVE",
      leadSource,
      leadNotes,
      stripeCustomerId: booking.stripeCustomerId ?? undefined,
      convertedAt: new Date().toISOString(),
    });
    if (!created && booking.phone) {
      ({ data: created } = await client.models.Customer.create({
        displayName: booking.name,
        contactName: booking.name,
        email: booking.email,
        serviceStreet: booking.street ?? undefined,
        serviceCity: booking.city ?? undefined,
        serviceState: booking.state ?? undefined,
        serviceZip: booking.zip ?? undefined,
        status: "ACTIVE",
        leadSource,
        leadNotes,
        stripeCustomerId: booking.stripeCustomerId ?? undefined,
        convertedAt: new Date().toISOString(),
      }));
    }
    if (!created) throw new Error("finalizeBooking: customer create failed");
    customer = { id: created.id, groupId: created.groupId };
  }
  const accessGroups = customerAccessGroups(customer.id, customer.groupId);
  await client.models.Customer.update({ id: customer.id, accessGroups });

  // R73: the booking is the outcome of this customer's pricing runs.
  await markPricingRunsWon(matchClient, customer.id);

  // 2. Plan (recurring) — billing starts after the first visit completes.
  let servicePlanId: string | undefined;
  if (booking.recurring && stored.recurringOffer) {
    const { data: plan } = await client.models.ServicePlan.create({
      customerId: customer.id,
      planName: serviceLabel.replace(/ — .*$/, "") + " plan",
      priceCents: stored.recurringOffer.monthlyCents,
      serviceFrequency: stored.recurringOffer.frequency as
        | "MONTHLY"
        | "BIMONTHLY"
        | "QUARTERLY",
      status: "ACTIVE",
      startDate: booking.selectedDate ?? undefined,
      notes: "Booked online via the website funnel",
      accessGroups,
    });
    servicePlanId = plan?.id;
  }

  // 3. The scheduled first job — already paid. paidAt/paidPaymentIntentId ride
  // in this same create so that "this job is already paid" is true the instant
  // the job exists, and stays true even if the Invoice write below fails.
  const paidAtIso = new Date().toISOString();
  const { data: job } = await client.models.Job.create({
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
  });

  // 3b. The money already moved at checkout, so the ledger records it here.
  // Without this row every dollar the funnel takes is invisible to the
  // Dashboard and cannot be reconciled against Stripe.
  //
  // The id is derived from the booking so this is idempotent: if anything
  // downstream throws, the webhook retries and this create is a no-op rather
  // than a second invoice for the same money.
  //
  // Deliberately does not throw. The finalization claim is released on any
  // error (see finalizeBooking), and none of the creates above are idempotent —
  // so throwing here would have Stripe retry and duplicate the customer, plan
  // and job. Job.paidAt (set atomically above) is what actually prevents the
  // double charge; this row is the ledger. A missing one under-reports revenue
  // and is recoverable by hand; a duplicate customer is not.
  if (job?.id && booking.amountCents) {
    const { data: paidInvoice, errors: invoiceErrors } =
      await client.models.Invoice.create({
        id: `booking-${booking.id}`,
        customerId: customer.id,
        jobId: job.id,
        servicePlanId,
        description: `${serviceLabel} — paid online at booking`,
        amountCents: booking.amountCents,
        status: "PAID",
        method: "CARD",
        stripePaymentIntentId: paymentIntentId,
        issuedAt: paidAtIso,
        paidAt: paidAtIso,
        accessGroups,
      });
    if (!paidInvoice) {
      const detail =
        invoiceErrors?.map((e) => e.message).join("; ") ?? "unknown error";
      console.error(
        `finalizeBooking: PAID invoice not recorded for booking ${booking.id} (${paymentIntentId}) — money collected, ledger row missing`,
        invoiceErrors
      );
      // Not throwing is deliberate (see above). Not telling anyone is not: this
      // customer's money exists only in Stripe, and no screen in the CRM will
      // ever show it. Somebody has to key it in by hand.
      await notifyOffice({
        subject: `ACTION REQUIRED — payment taken but not recorded: ${booking.name}`,
        heading: "A paid booking is missing from the ledger",
        template: "ops-invoice-write-failed",
        customerId: customer.id,
        relatedId: booking.id,
        bodyHtml: `<p><strong>${booking.name}</strong> paid <strong>$${(booking.amountCents / 100).toFixed(2)}</strong> for ${serviceLabel} and the charge succeeded, but the invoice could not be written to the CRM.</p>
           <p>The booking, customer and job all exist — only the invoice is missing, so this customer's payment will not appear in the Dashboard or reconcile against Stripe until someone records it.</p>
           <p><strong>Record an invoice against this customer by hand for $${(booking.amountCents / 100).toFixed(2)}, marked paid.</strong> Do not charge the card again — it has already been charged.</p>
           <p style="color:#666;font-size:13px;">Stripe payment: ${paymentIntentId}<br/>Booking: ${booking.id}<br/>Error: ${detail}</p>`,
      });
    }
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
  const { data: agreement } = await client.models.Agreement.create({
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
  });

  await client.models.BookingRequest.update({
    id: booking.id,
    status: "BOOKED",
    customerId: customer.id,
    jobId: job?.id,
    servicePlanId,
    agreementId: agreement?.id,
  });

  // 5. Confirmation email with the agreement attached + cancel link.
  const marketingUrl = process.env.MARKETING_URL ?? "https://www.pestbuzzkill.com";
  await sendEmail({
    to: booking.email,
    subject: `You're booked: ${booking.selectedDate} — BuzzKill Pest Control`,
    template: "booking-confirmation",
    customerId: customer.id,
    relatedId: booking.id,
    attachments: pdfKey
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
         booking.recurring && stored.recurringOffer
           ? `, and your ${stored.recurringOffer.frequency.toLowerCase()} plan ($${(stored.recurringOffer.monthlyCents / 100).toFixed(2)}/mo) starts after this first visit`
           : ""
       }. Your service agreement is attached.</p>
       <p>We'll remind you 7 days and 1 day before the visit.</p>
       <p style="color:#666;font-size:13px;">Need to cancel? Use this link: ${marketingUrl}/cancel?token=${booking.cancelToken} — more than ${CANCEL_FULL_REFUND_DAYS} days out is a full refund; ${CANCEL_FULL_REFUND_DAYS} days or less is non-refundable.</p>`
    ),
  });

  const office = process.env.SES_NOTIFY_EMAIL;
  if (office) {
    await sendEmail({
      to: office,
      subject: `Website booking: ${booking.name} — ${booking.selectedDate}`,
      template: "office-booking-alert",
      customerId: customer.id,
      relatedId: booking.id,
      html: emailShell(
        "New paid website booking",
        `<p><strong>${booking.name}</strong> booked <strong>${serviceLabel}</strong> for ${booking.selectedDate} (${windowLabel}) at ${[booking.street, booking.city].filter(Boolean).join(", ")} — $${((booking.amountCents ?? 0) / 100).toFixed(2)} paid.${booking.recurring ? " Recurring plan starts after the first visit." : ""}</p>
         <p>The job is on the Needs-scheduling board for route assignment.</p>${
           matchFallbackReason
             ? `<p><strong>Heads up:</strong> matching this booking to an existing CRM lead failed, so a fresh customer record was created instead. If a lead with the email ${booking.email} already exists, merge the two by hand.</p>
         <p style="color:#666;font-size:13px;">Reason: ${matchFallbackReason}</p>`
             : ""
         }`
      ),
    });
  }
}
