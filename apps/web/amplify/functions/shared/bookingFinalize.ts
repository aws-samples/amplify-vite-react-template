import { randomUUID } from "node:crypto";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { dataClient } from "./dataClient";
import { customerAccessGroups } from "./dynamicGroups";
import { emailShell, sendEmail } from "./email";
import { renderAgreementPdf } from "./pdf";
import { stripeClient } from "./stripeClient";

const s3 = new S3Client();

const CANCEL_POLICY_TEXT =
  "CANCELLATION POLICY. Cancel more than 3 days before your appointment for a full refund. Cancellations 3 days or less before the appointment are not refundable.";

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
  selectedDate?: string | null;
  selectedWindow?: string | null;
  recurring?: boolean | null;
  amountCents?: number | null;
  cancelToken?: string | null;
  stripeCustomerId?: string | null;
  stripePaymentIntentId?: string | null;
};

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

  // 1. Customer (ACTIVE — they've paid). Contact details are validated at
  // /quote, but a paid booking must never be bricked by a format rejection:
  // retry without the optional phone rather than fail.
  let { data: customer } = await client.models.Customer.create({
    displayName: booking.name,
    contactName: booking.name,
    email: booking.email,
    phone: booking.phone ?? undefined,
    serviceStreet: booking.street ?? undefined,
    serviceCity: booking.city ?? undefined,
    serviceState: booking.state ?? undefined,
    serviceZip: booking.zip ?? undefined,
    status: "ACTIVE",
    leadSource: "Website booking",
    stripeCustomerId: booking.stripeCustomerId ?? undefined,
    convertedAt: new Date().toISOString(),
  });
  if (!customer && booking.phone) {
    ({ data: customer } = await client.models.Customer.create({
      displayName: booking.name,
      contactName: booking.name,
      email: booking.email,
      serviceStreet: booking.street ?? undefined,
      serviceCity: booking.city ?? undefined,
      serviceState: booking.state ?? undefined,
      serviceZip: booking.zip ?? undefined,
      status: "ACTIVE",
      leadSource: "Website booking",
      stripeCustomerId: booking.stripeCustomerId ?? undefined,
      convertedAt: new Date().toISOString(),
    }));
  }
  if (!customer) throw new Error("finalizeBooking: customer create failed");
  const accessGroups = customerAccessGroups(customer.id, customer.groupId);
  await client.models.Customer.update({ id: customer.id, accessGroups });

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
      console.error(
        `finalizeBooking: PAID invoice not recorded for booking ${booking.id} (${paymentIntentId}) — money collected, ledger row missing`,
        invoiceErrors
      );
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
    signToken: randomUUID(),
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
       <p style="color:#666;font-size:13px;">Need to cancel? Use this link: ${marketingUrl}/cancel?token=${booking.cancelToken} — more than 3 days out is a full refund; 3 days or less is non-refundable.</p>`
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
         <p>The job is on the Needs-scheduling board for route assignment.</p>`
      ),
    });
  }
}
