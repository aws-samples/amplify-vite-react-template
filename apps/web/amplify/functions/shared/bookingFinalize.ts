import { randomUUID } from "node:crypto";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { dataClient } from "./dataClient";
import { customerAccessGroups } from "./dynamicGroups";
import { emailShell, sendEmail } from "./email";
import { renderAgreementPdf } from "./pdf";

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
}): Promise<void> {
  const client = await dataClient();
  const { data: booking } = await client.models.BookingRequest.get({
    id: opts.bookingRequestId,
  });
  if (!booking || booking.status !== "QUOTED") return; // already finalized/canceled

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

  // 1. Customer (ACTIVE — they've paid).
  const { data: customer } = await client.models.Customer.create({
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

  // 3. The scheduled first job — already paid.
  const { data: job } = await client.models.Job.create({
    customerId: customer.id,
    servicePlanId,
    type: booking.recurring ? "RECURRING" : "ONE_TIME",
    serviceType: serviceLabel,
    scheduledDate: booking.selectedDate ?? undefined,
    timeWindow: windowLabel,
    priceCents: booking.amountCents ?? undefined,
    status: "SCHEDULED",
    notes: `Website booking ${booking.id}. Paid up front (${opts.paymentIntentId}).`,
    accessGroups,
  });

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
