import { SESClient, SendRawEmailCommand } from "@aws-sdk/client-ses";
import { dataClient } from "./dataClient";
import {
  openOwnedWork,
  type WorkOwnerTeam,
} from "./ownedWork";

const ses = new SESClient();

export type EmailAttachment = {
  filename: string;
  content: Uint8Array;
  contentType: string;
};

/** Minimal branded HTML shell shared by all CRM emails. */
export function emailShell(heading: string, bodyHtml: string): string {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f6f7f9;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#1a1a1a;">
  <div style="max-width:560px;margin:0 auto;padding:24px 16px;">
    <div style="font-size:18px;font-weight:700;margin-bottom:16px;">BuzzKill Pest Control</div>
    <div style="background:#ffffff;border:1px solid #e4e6ea;border-radius:12px;padding:24px;">
      <h1 style="font-size:20px;margin:0 0 12px;">${heading}</h1>
      ${bodyHtml}
    </div>
    <div style="font-size:12px;color:#888;margin-top:16px;">BuzzKill Pest Control &middot; pestbuzzkill.com</div>
  </div>
</body></html>`;
}

function buildMime(opts: {
  from: string;
  to: string;
  subject: string;
  html: string;
  attachments?: EmailAttachment[];
}): string {
  const boundary = `----=_crm_${Date.now().toString(36)}`;
  const lines: string[] = [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    `Subject: ${opts.subject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(opts.html, "utf8").toString("base64").replace(/(.{76})/g, "$1\n"),
    "",
  ];
  for (const att of opts.attachments ?? []) {
    lines.push(
      `--${boundary}`,
      `Content-Type: ${att.contentType}; name="${att.filename}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${att.filename}"`,
      "",
      Buffer.from(att.content).toString("base64").replace(/(.{76})/g, "$1\n"),
      ""
    );
  }
  lines.push(`--${boundary}--`, "");
  return lines.join("\r\n");
}

/**
 * Send an email via SES and record it in EmailLog. Returns whether the
 * send succeeded — callers decide if a failed email should fail the
 * operation (usually it should not).
 */
export async function sendEmail(opts: {
  to: string;
  subject: string;
  html: string;
  template: string;
  customerId?: string | null;
  relatedId?: string;
  attachments?: EmailAttachment[];
  ownerTeam?: WorkOwnerTeam;
}): Promise<boolean> {
  const from = process.env.SES_FROM_EMAIL ?? "info@pestbuzzkill.com";
  let error: string | undefined;
  try {
    await ses.send(
      new SendRawEmailCommand({
        RawMessage: {
          Data: Buffer.from(
            buildMime({
              from,
              to: opts.to,
              subject: opts.subject,
              html: opts.html,
              attachments: opts.attachments,
            })
          ),
        },
      })
    );
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    console.error("SES send failed", opts.template, error);
  }

  try {
    const client = await dataClient();
    await client.models.EmailLog.create({
      customerId: opts.customerId ?? undefined,
      toEmail: opts.to,
      subject: opts.subject,
      template: opts.template,
      status: error ? "FAILED" : "SENT",
      error,
      relatedId: opts.relatedId,
      sentAt: new Date().toISOString(),
    });
  } catch (logErr) {
    console.error("EmailLog write failed", logErr);
  }

  if (error) {
    await openOwnedWork({
      kind: "EMAIL_FAILURE",
      dedupeKey: `${opts.template}:${opts.relatedId ?? opts.to}:${opts.to}`,
      title: `Email failed: ${opts.subject}`,
      detail: `The ${opts.template} email to ${opts.to} failed: ${error}`,
      customerId: opts.customerId,
      relatedId: opts.relatedId ?? opts.to,
      sourceUrl: opts.customerId ? `/customers/${opts.customerId}` : "/more",
      resolutionAction:
        "Correct the address or delivery problem, resend the message, and record how delivery was confirmed.",
      ownerTeam: opts.ownerTeam ?? "OPS",
    });
  }

  return !error;
}

/**
 * Page the office about something that needs a human, and never throw doing it.
 *
 * This is for the cases where an operation cannot safely fail — a technician's
 * completed visit, a card that has already been charged — but something
 * downstream did not happen. Not throwing is right; telling nobody is not. The
 * send is recorded in EmailLog and any failed send becomes durable EMAIL_FAILURE
 * work with an owner, deadline, resolution action, escalation, and history.
 *
 * Deliberately not used for *email* failures: routing an alarm through the
 * subsystem it is reporting on is how alarms go unheard.
 *
 * R80 — routing partition: this is the *ops* inbox (SES_NOTIFY_EMAIL, info@).
 * Lead-pipeline alerts (a new website lead, a lead waiting on pricing, a paid
 * website booking, a pricing escalation) must use notifyLeads, not this — they
 * go to the sales inbox (SES_LEADS_EMAIL, sales@). Keep money/ops alarms here.
 */
export async function notifyOffice(opts: {
  subject: string;
  heading: string;
  bodyHtml: string;
  template: string;
  customerId?: string | null;
  relatedId?: string;
}): Promise<boolean> {
  const office = process.env.SES_NOTIFY_EMAIL;
  if (!office) {
    console.error(
      "notifyOffice: SES_NOTIFY_EMAIL is not configured — nobody was told",
      opts.subject
    );
    await openOwnedWork({
      kind: "EMAIL_FAILURE",
      dedupeKey: `office-unconfigured:${opts.template}:${opts.relatedId ?? opts.subject}`,
      title: `Office alert could not be sent: ${opts.subject}`,
      detail: "SES_NOTIFY_EMAIL is not configured, so the office alert had no destination.",
      customerId: opts.customerId,
      relatedId: opts.relatedId ?? opts.subject,
      sourceUrl: opts.customerId ? `/customers/${opts.customerId}` : "/more",
      resolutionAction:
        "Configure the office notification address, deliver the missed alert, and verify the next send.",
      ownerTeam: "OPS",
    });
    return false;
  }
  try {
    return await sendEmail({
      to: office,
      subject: opts.subject,
      template: opts.template,
      customerId: opts.customerId,
      relatedId: opts.relatedId,
      html: emailShell(opts.heading, opts.bodyHtml),
    });
  } catch (err) {
    console.error("notifyOffice failed", opts.subject, err);
    return false;
  }
}

/**
 * Page the *sales* inbox about a lead that needs a human, and never throw doing
 * it. Identical in shape and behavior to notifyOffice — the send is recorded in
 * EmailLog, the copy is wrapped in emailShell — but it routes to SES_LEADS_EMAIL
 * (sales@) instead of the ops inbox. R80: lead-pipeline alerts go to sales so
 * they never get lost in the ops noise.
 *
 * Safety: a lead alert must reach a human even if the deploy forgot to set
 * SES_LEADS_EMAIL. If it is unset we fall back to SES_NOTIFY_EMAIL and log
 * loudly — the alert still lands, just in the wrong inbox, and the log says so.
 * In deployed envs backend.ts sets SES_LEADS_EMAIL on every lead-sending
 * function, so the fallback never fires.
 */
export async function notifyLeads(opts: {
  subject: string;
  heading: string;
  bodyHtml: string;
  template: string;
  customerId?: string | null;
  relatedId?: string;
}): Promise<boolean> {
  let leads = process.env.SES_LEADS_EMAIL;
  if (!leads) {
    leads = process.env.SES_NOTIFY_EMAIL;
    console.error(
      "SES_LEADS_EMAIL not configured — lead alert fell back to the ops inbox",
      opts.subject
    );
  }
  if (!leads) {
    console.error(
      "notifyLeads: neither SES_LEADS_EMAIL nor SES_NOTIFY_EMAIL is configured — nobody was told",
      opts.subject
    );
    await openOwnedWork({
      kind: "EMAIL_FAILURE",
      dedupeKey: `sales-unconfigured:${opts.template}:${opts.relatedId ?? opts.subject}`,
      title: `Sales alert could not be sent: ${opts.subject}`,
      detail:
        "Neither SES_LEADS_EMAIL nor SES_NOTIFY_EMAIL is configured, so the sales alert had no destination.",
      customerId: opts.customerId,
      relatedId: opts.relatedId ?? opts.subject,
      sourceUrl: opts.customerId ? `/customers/${opts.customerId}` : "/more",
      resolutionAction:
        "Configure the sales notification address, deliver the missed alert, and verify the next send.",
      ownerTeam: "SALES",
    });
    return false;
  }
  try {
    return await sendEmail({
      to: leads,
      subject: opts.subject,
      template: opts.template,
      customerId: opts.customerId,
      relatedId: opts.relatedId,
      ownerTeam: "SALES",
      html: emailShell(opts.heading, opts.bodyHtml),
    });
  } catch (err) {
    console.error("notifyLeads failed", opts.subject, err);
    return false;
  }
}
