import { dataClient } from "./dataClient";
import { emailShell, notifyOffice, sendEmail } from "./email";

/**
 * Customer notices for money movement — the receipt after a charge, the notice
 * after a refund.
 *
 * The booking funnel already proves the pattern (payment confirmation with the
 * amount; cancellation email with the refund amount and timing). These are the
 * same notices for the CRM and subscription paths, which used to move money in
 * silence: a charge the customer cannot recognize is a dispute.
 *
 * Neither function ever throws. The money has already moved by the time these
 * run, and a receipt that could not be sent must not fail the charge behind
 * it. A customer with no email on file goes to the office signal path instead
 * — a charge that nobody was told about is something somebody should know.
 */

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function customerContact(customerId: string): Promise<{
  email: string | null;
  greetingName: string;
  displayName: string;
}> {
  const client = await dataClient();
  const { data: customer } = await client.models.Customer.get({
    id: customerId,
  });
  return {
    email: customer?.email ?? null,
    greetingName: customer?.contactName ?? customer?.displayName ?? "there",
    displayName: customer?.displayName ?? customerId,
  };
}

/** Receipt for money taken: one-time job, manual charge, monthly settlement. */
export async function sendChargeReceipt(opts: {
  customerId: string;
  amountCents: number;
  description: string;
  invoiceId?: string | null;
}): Promise<boolean> {
  try {
    const { email, greetingName, displayName } = await customerContact(
      opts.customerId
    );
    if (!email) {
      await notifyOffice({
        subject: `Receipt not sent — no email on file: ${displayName}`,
        heading: "A charge went out with no receipt",
        template: "ops-receipt-no-email",
        customerId: opts.customerId,
        relatedId: opts.invoiceId ?? undefined,
        bodyHtml: `<p><strong>${escapeHtml(displayName)}</strong> was charged <strong>${money(opts.amountCents)}</strong> for ${escapeHtml(opts.description)}, but there is no email address on their record, so no receipt went out.</p>
           <p>A charge the customer can't recognize becomes a dispute. Get an email address onto their customer record — and if they call asking about the charge, this is the one.</p>`,
      });
      return false;
    }
    return await sendEmail({
      to: email,
      subject: `Receipt: ${money(opts.amountCents)} — BuzzKill Pest Control`,
      template: "payment-receipt",
      customerId: opts.customerId,
      relatedId: opts.invoiceId ?? undefined,
      html: emailShell(
        "Payment received",
        `<p>Hi ${escapeHtml(greetingName)},</p>
         <p><strong>${escapeHtml(opts.description)}</strong><br/>
         Charged to your payment method on file: <strong>${money(opts.amountCents)}</strong></p>
         <p style="color:#666;font-size:13px;">Questions about this charge? Just reply to this email or give us a call.</p>`
      ),
    });
  } catch (err) {
    console.error("sendChargeReceipt failed", opts.customerId, err);
    return false;
  }
}

/** Notice for money going back — a CRM refund or one issued in Stripe. */
export async function sendRefundNotice(opts: {
  customerId: string;
  amountCents: number;
  description?: string | null;
  invoiceId?: string | null;
  /** False when the money went back outside Stripe — cash or cheque in hand. */
  sentToStripe: boolean;
}): Promise<boolean> {
  const about = opts.description ?? "your recent payment";
  try {
    const { email, greetingName, displayName } = await customerContact(
      opts.customerId
    );
    if (!email) {
      await notifyOffice({
        subject: `Refund notice not sent — no email on file: ${displayName}`,
        heading: "A refund went out with no notice",
        template: "ops-refund-no-email",
        customerId: opts.customerId,
        relatedId: opts.invoiceId ?? undefined,
        bodyHtml: `<p><strong>${escapeHtml(displayName)}</strong> was refunded <strong>${money(opts.amountCents)}</strong> for ${escapeHtml(about)}, but there is no email address on their record, so they were not told.</p>
           <p>Get an email address onto their customer record, or let them know another way.</p>`,
      });
      return false;
    }
    return await sendEmail({
      to: email,
      subject: `Refund issued: ${money(opts.amountCents)} — BuzzKill Pest Control`,
      template: "refund-notice",
      customerId: opts.customerId,
      relatedId: opts.invoiceId ?? undefined,
      html: emailShell(
        "Refund issued",
        `<p>Hi ${escapeHtml(greetingName)},</p>
         <p>A refund of <strong>${money(opts.amountCents)}</strong> for ${escapeHtml(about)} ${
           opts.sentToStripe
             ? "is on its way back to your original payment method — cards usually see it in 3–5 business days; bank payments can take a little longer."
             : "has been issued."
         }</p>
         <p style="color:#666;font-size:13px;">Questions about this refund? Just reply to this email or give us a call.</p>`
      ),
    });
  } catch (err) {
    console.error("sendRefundNotice failed", opts.customerId, err);
    return false;
  }
}
