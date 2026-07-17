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

/** The portal billing page a customer pays / updates their card on. */
export const portalBillingUrl = () =>
  `${process.env.CRM_APP_URL ?? "https://staging.d5ln2hbbp9s2j.amplifyapp.com"}/billing`;

const prettyDate = (isoDate: string) =>
  new Date(`${isoDate.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });

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

/**
 * Notice that a charge failed — the customer-facing half of dunning. States
 * the amount, the real decline reason, and a link to the portal billing page
 * to fix it. Returns false (never throws) when the customer has no email, so
 * the caller can page the office instead.
 */
export async function sendPaymentFailedNotice(opts: {
  customerId: string;
  amountCents: number;
  description?: string | null;
  reason: string;
  invoiceId?: string | null;
}): Promise<boolean> {
  try {
    const { email, greetingName } = await customerContact(opts.customerId);
    if (!email) return false;
    return await sendEmail({
      to: email,
      subject: `Payment failed: ${money(opts.amountCents)} — action needed`,
      template: "payment-failed",
      customerId: opts.customerId,
      relatedId: opts.invoiceId ?? undefined,
      html: emailShell(
        "We couldn't process your payment",
        `<p>Hi ${escapeHtml(greetingName)},</p>
         <p>We tried to charge <strong>${money(opts.amountCents)}</strong>${
           opts.description ? ` for ${escapeHtml(opts.description)}` : ""
         } but it didn't go through.</p>
         <p><strong>What happened:</strong> ${escapeHtml(opts.reason)}</p>
         <p>The quickest fix is to update your payment method and pay online:</p>
         <p style="margin:20px 0;"><a href="${portalBillingUrl()}" style="background:#176b2c;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600;">Update payment &amp; pay now</a></p>
         <p style="color:#666;font-size:13px;">We'll automatically try again over the next few days. Questions? Just reply to this email or give us a call.</p>`
      ),
    });
  } catch (err) {
    console.error("sendPaymentFailedNotice failed", opts.customerId, err);
    return false;
  }
}

/**
 * An open-invoice reminder — due soon (a few days before dueDate) or overdue
 * (past it), each with the pay link. The customer-facing half of AR follow-up.
 */
export async function sendInvoiceReminder(opts: {
  customerId: string;
  amountCents: number;
  description?: string | null;
  dueDate?: string | null;
  overdue: boolean;
  invoiceId?: string | null;
}): Promise<boolean> {
  try {
    const { email, greetingName } = await customerContact(opts.customerId);
    if (!email) return false;
    const due = opts.dueDate ? prettyDate(opts.dueDate) : null;
    const heading = opts.overdue ? "Your invoice is overdue" : "Invoice due soon";
    const line = opts.overdue
      ? `<p>Our records show <strong>${money(opts.amountCents)}</strong>${
          opts.description ? ` for ${escapeHtml(opts.description)}` : ""
        } is now overdue${due ? ` (it was due ${due})` : ""}.</p>`
      : `<p>This is a friendly reminder that <strong>${money(opts.amountCents)}</strong>${
          opts.description ? ` for ${escapeHtml(opts.description)}` : ""
        }${due ? ` is due on <strong>${due}</strong>` : " is coming due"}.</p>`;
    return await sendEmail({
      to: email,
      subject: opts.overdue
        ? `Overdue: ${money(opts.amountCents)} — BuzzKill Pest Control`
        : `Reminder: ${money(opts.amountCents)} due soon — BuzzKill Pest Control`,
      template: opts.overdue ? "invoice-overdue" : "invoice-due-soon",
      customerId: opts.customerId,
      relatedId: opts.invoiceId ?? undefined,
      html: emailShell(
        heading,
        `<p>Hi ${escapeHtml(greetingName)},</p>
         ${line}
         <p style="margin:20px 0;"><a href="${portalBillingUrl()}" style="background:#176b2c;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600;">Pay online</a></p>
         <p style="color:#666;font-size:13px;">Already paid? Thank you — please ignore this. Questions? Just reply to this email.</p>`
      ),
    });
  } catch (err) {
    console.error("sendInvoiceReminder failed", opts.customerId, err);
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
