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
  const toKey = opts.to.trim().toLowerCase();

  // GL-03: never send to an address a bounce or complaint already killed. The
  // send is recorded SUPPRESSED and handed to an owned exception, so a message
  // to a dead address is a visible task, not a silent no-op.
  const suppression = await suppressionStatus(toKey);
  if (suppression !== "CLEAR") {
    await recordEmailLog(opts, {
      status: "FAILED",
      deliveryStatus: "SUPPRESSED",
      error:
        suppression === "SUPPRESSED"
          ? "Address is suppressed after a previous bounce or complaint."
          : "Suppression status could not be read; non-essential outreach failed closed.",
    });
    await openEmailFailureWork(opts, {
      title: `Blocked email to a suppressed address: ${opts.to}`,
      detail: `The ${opts.template} email was NOT sent: ${opts.to} is ${suppression === "SUPPRESSED" ? "suppressed after a bounce or complaint" : "blocked because suppression status was unreadable"}. Nothing left our system.`,
      resolutionAction:
        "Get a working email or another way to reach them, deliver the message, and record how. Lift the suppression only if the address is confirmed good.",
    });
    return false;
  }

  // GL-02: a do-not-contact customer receives no NON-ESSENTIAL outreach (booking
  // links, reminders). Essential/transactional mail (receipts, failed-payment
  // notices, legal service reports) still sends — the split is a business
  // decision encoded in NON_ESSENTIAL_TEMPLATES. Recorded SUPPRESSED so it is a
  // visible fact, never counted as a touch.
  if (
    opts.customerId &&
    NON_ESSENTIAL_TEMPLATES.has(opts.template) &&
    (await doNotContactStatus(opts.customerId)) !== "CLEAR"
  ) {
    await recordEmailLog(opts, {
      status: "FAILED",
      deliveryStatus: "SUPPRESSED",
      error: "Customer is on do-not-contact; a non-essential email was skipped.",
    });
    return false;
  }

  const configurationSet = process.env.SES_CONFIGURATION_SET;
  let error: string | undefined;
  let transient = false;
  let messageId: string | undefined;
  try {
    const res = await ses.send(
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
        // Publishes bounce/complaint/delivery events to the SNS topic the
        // ses-events function listens on. Omitted (no events) if unconfigured.
        ...(configurationSet ? { ConfigurationSetName: configurationSet } : {}),
      })
    );
    messageId = res.MessageId;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    transient = isTransientSesError(err);
    console.error("SES send failed", opts.template, error);
  }

  // GL-03: three honest outcomes, not a boolean. SENT — the provider accepted
  // it. QUEUED — a transient throttle held it; it must be resent, not lost.
  // FAILED — a permanent synchronous failure.
  const deliveryStatus = !error ? "SENT" : transient ? "QUEUED" : "FAILED";
  await recordEmailLog(opts, {
    status: error ? "FAILED" : "SENT",
    deliveryStatus,
    error,
    messageId,
  });

  // A send that did not leave is owned work — nothing stays silently unsent.
  if (error) {
    await openEmailFailureWork(opts, {
      title: transient
        ? `Email held by a provider throttle: ${opts.subject}`
        : `Email failed: ${opts.subject}`,
      detail: transient
        ? `The ${opts.template} email to ${opts.to} was held by a temporary provider throttle and has NOT been delivered. It must be resent. ${error}`
        : `The ${opts.template} email to ${opts.to} failed: ${error}`,
      resolutionAction:
        "Correct the address or delivery problem, resend the message, and record how delivery was confirmed.",
    });
  }

  return !error;
}

// GL-02: templates that are marketing/nudges, not transactional or legal — the
// only mail withheld from a do-not-contact customer. Everything not listed here
// (receipts, failed-payment, cancellation, service reports) is essential and
// always sends. Head of Sales / Compliance confirm the split.
const NON_ESSENTIAL_TEMPLATES = new Set<string>([
  "booking-link",
  "portal-reminder",
  "upcoming-service",
]);

/** Whether this customer asked not to be contacted (GL-02 do-not-contact). */
async function doNotContactStatus(
  customerId: string
): Promise<"CLEAR" | "BLOCKED" | "UNREADABLE"> {
  try {
    const client = await dataClient();
    const { data, errors } = await client.models.Customer.get({ id: customerId });
    if (errors?.length || !data) return "UNREADABLE";
    return data.doNotContact ? "BLOCKED" : "CLEAR";
  } catch (err) {
    console.error("do-not-contact check failed", customerId, err);
    return "UNREADABLE";
  }
}

/** Whether a hard bounce or complaint has taken this address out of service. */
async function suppressionStatus(
  email: string
): Promise<"CLEAR" | "SUPPRESSED" | "UNREADABLE"> {
  if (!email) return "UNREADABLE";
  try {
    const client = await dataClient();
    if (!("SuppressedEmail" in client.models)) return "UNREADABLE";
    const { data, errors } = await client.models.SuppressedEmail.get({ email });
    if (errors?.length) return "UNREADABLE";
    return data ? "SUPPRESSED" : "CLEAR";
  } catch (err) {
    console.error("suppression check failed", email, err);
    return "UNREADABLE";
  }
}

/** SES SDK errors that mean "try again", not "this will never work". */
function isTransientSesError(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name ?? "";
  const message = err instanceof Error ? err.message : String(err);
  return /throttl|toomanyrequests|serviceunavailable|timeout|rate exceeded|\b(429|503)\b/i.test(
    `${name} ${message}`
  );
}

async function recordEmailLog(
  opts: { to: string; subject: string; template: string; customerId?: string | null; relatedId?: string },
  fields: {
    status: "SENT" | "FAILED";
    deliveryStatus: "SENT" | "QUEUED" | "FAILED" | "SUPPRESSED";
    error?: string;
    messageId?: string;
  }
): Promise<void> {
  try {
    const client = await dataClient();
    await client.models.EmailLog.create({
      customerId: opts.customerId ?? undefined,
      toEmail: opts.to,
      subject: opts.subject,
      template: opts.template,
      status: fields.status,
      deliveryStatus: fields.deliveryStatus,
      error: fields.error,
      messageId: fields.messageId,
      relatedId: opts.relatedId,
      sentAt: new Date().toISOString(),
    });
  } catch (logErr) {
    console.error("EmailLog write failed", logErr);
  }
}

async function openEmailFailureWork(
  opts: {
    to: string;
    template: string;
    customerId?: string | null;
    relatedId?: string;
    ownerTeam?: WorkOwnerTeam;
  },
  work: { title: string; detail: string; resolutionAction: string }
): Promise<void> {
  await openOwnedWork({
    kind: "EMAIL_FAILURE",
    dedupeKey: `${opts.template}:${opts.relatedId ?? opts.to}:${opts.to}`,
    title: work.title,
    detail: work.detail,
    customerId: opts.customerId,
    relatedId: opts.relatedId ?? opts.to,
    sourceUrl: opts.customerId ? `/customers/${opts.customerId}` : "/more",
    resolutionAction: work.resolutionAction,
    ownerTeam: opts.ownerTeam ?? "OPS",
  });
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
