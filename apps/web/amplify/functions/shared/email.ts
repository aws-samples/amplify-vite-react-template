import { SESClient, SendRawEmailCommand } from "@aws-sdk/client-ses";
import { dataClient } from "./dataClient";

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

  return !error;
}

/**
 * Page the office about something that needs a human, and never throw doing it.
 *
 * This is for the cases where an operation cannot safely fail — a technician's
 * completed visit, a card that has already been charged — but something
 * downstream did not happen. Not throwing is right; telling nobody is not. The
 * send is recorded in EmailLog like any other, so a failed alert is at least
 * visible in More → Email log rather than being lost entirely.
 *
 * Deliberately not used for *email* failures: routing an alarm through the
 * subsystem it is reporting on is how alarms go unheard.
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
