import { randomUUID } from "node:crypto";
import { SESClient, SendRawEmailCommand } from "@aws-sdk/client-ses";
import { dataClient } from "./dataClient";
import { casGuardedUpdate } from "./atomicLock";
import {
  openOwnedWork,
  type WorkOwnerTeam,
} from "./ownedWork";

const ses = new SESClient();

/** The stored-body cap: big enough for every templated email, small enough
 *  for a DynamoDB row. Attachments are never stored (hasAttachments marks
 *  the rows a sweep must not blind-resend). */
const BODY_STORE_CAP = 120_000;

export type EmailAttachment = {
  filename: string;
  content: Uint8Array;
  contentType: string;
};

/**
 * The branded HTML shell shared by every CRM email — customer-facing mail and
 * internal ops/sales alerts alike. A dark masthead with the BuzzKill logo, a
 * green accent keyline, the heading + caller-supplied body, and a contact
 * footer with the tagline.
 *
 * Built as nested tables with inline styles for Outlook/Gmail/Apple Mail
 * compatibility. The logo is referenced by URL (not attached): an inline
 * attachment would flip every send's `hasAttachments` flag and make throttled
 * mail un-resendable. Image-blocking clients fall back to the alt text and the
 * text footer, so the branding still lands.
 *
 * The signature is unchanged — callers pass a heading and a body fragment.
 */
export function emailShell(heading: string, bodyHtml: string): string {
  const site = (process.env.MARKETING_URL ?? "https://www.pestbuzzkill.com").replace(
    /\/+$/,
    ""
  );
  const logo = `${site}/images/logo.png`;
  const linkGreen = "#5a8a2c"; // readable brand green for text links on white
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light">
<title>${heading}</title>
</head>
<body style="margin:0;padding:0;background:#eceee9;-webkit-font-smoothing:antialiased;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${heading}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#eceee9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <tr>
      <td align="center" style="padding:28px 12px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 6px rgba(11,13,12,0.10);">
          <tr>
            <td align="center" style="background:#0b0d0c;padding:26px 24px;">
              <img src="${logo}" width="230" alt="BuzzKill Pest Control" style="display:block;width:230px;max-width:72%;height:auto;border:0;outline:none;text-decoration:none;">
            </td>
          </tr>
          <tr>
            <td style="height:4px;line-height:4px;font-size:0;background:#7ac142;">&nbsp;</td>
          </tr>
          <tr>
            <td style="padding:30px 34px 26px;color:#1f221e;font-size:15px;line-height:1.6;">
              <h1 style="margin:0 0 16px;font-size:22px;line-height:1.25;color:#0b0d0c;font-weight:800;letter-spacing:-0.01em;">${heading}</h1>
              ${bodyHtml}
            </td>
          </tr>
          <tr>
            <td style="border-top:1px solid #e6e8e3;background:#f6f7f4;padding:22px 34px;color:#6a6f66;font-size:12px;line-height:1.7;">
              <div style="font-weight:700;color:#3a3d37;font-size:13px;">BuzzKill Pest Control</div>
              420 Lakeside Ave, Suite 104, Marlborough, MA 01752<br>
              <a href="tel:+15082589294" style="color:${linkGreen};text-decoration:none;font-weight:600;">(508) 258-9294</a>
              &nbsp;&middot;&nbsp;
              <a href="${site}" style="color:${linkGreen};text-decoration:none;font-weight:600;">pestbuzzkill.com</a>
              &nbsp;&middot;&nbsp;
              <a href="mailto:info@pestbuzzkill.com" style="color:${linkGreen};text-decoration:none;font-weight:600;">info@pestbuzzkill.com</a>
            </td>
          </tr>
        </table>
        <div style="color:#9aa093;font-size:11px;font-style:italic;margin-top:14px;letter-spacing:0.02em;">Safe for Families. Tough on Pests.</div>
      </td>
    </tr>
  </table>
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

  // GL-03 OUTBOX: the attempt row is written BEFORE the provider call — a
  // send whose record cannot be written is REFUSED, so provider acceptance
  // can never become untracked. The row carries the exact rendered body so
  // a throttled attempt can be re-sent verbatim later.
  const outboxId = `el-${randomUUID()}`;
  try {
    const client = await dataClient();
    const { data: preRow } = await client.models.EmailLog.create({
      id: outboxId,
      customerId: opts.customerId ?? undefined,
      toEmail: opts.to,
      subject: opts.subject,
      template: opts.template,
      status: "PENDING",
      deliveryStatus: "SENDING",
      relatedId: opts.relatedId,
      sentAt: new Date().toISOString(),
      bodyHtml:
        opts.html.length <= BODY_STORE_CAP ? opts.html : undefined,
      hasAttachments: Boolean(opts.attachments?.length),
    });
    if (!preRow) throw new Error("outbox row create returned no data");
  } catch (outboxErr) {
    console.error("sendEmail: outbox pre-create failed — send refused", outboxErr);
    await openEmailFailureWork(opts, {
      title: `Email refused — its record could not be written: ${opts.subject}`,
      detail: `The ${opts.template} email to ${opts.to} was NOT sent: the outbox record could not be written first, and an unrecorded send is not allowed. Nothing left our system.`,
      resolutionAction:
        "Check the EmailLog store, then resend the message and verify it was recorded.",
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
  // it. QUEUED — a transient throttle held it; the daily sweep RE-SENDS it
  // from the stored body. FAILED — a permanent synchronous failure. The
  // outcome lands on the SAME outbox row; if that settle fails after the
  // provider accepted, the row stays SENDING (unknown outcome) and the sweep
  // escalates it — it never quietly becomes a double-send or a lost record.
  const deliveryStatus = !error ? "SENT" : transient ? "QUEUED" : "FAILED";
  try {
    const client = await dataClient();
    const { data: settled } = await client.models.EmailLog.update({
      id: outboxId,
      status: error ? "FAILED" : "SENT",
      deliveryStatus,
      error,
      messageId,
      sentAt: new Date().toISOString(),
    });
    if (!settled) throw new Error("outbox settle returned no data");
  } catch (settleErr) {
    console.error("sendEmail: outbox settle failed", outboxId, settleErr);
    await openEmailFailureWork(opts, {
      title: `An email's outcome could not be recorded: ${opts.subject}`,
      detail: `The ${opts.template} email to ${opts.to} ${messageId ? `WAS accepted by the provider (message ${messageId})` : `resolved (${deliveryStatus})`}, but its outbox row ${outboxId} could not be updated and still reads SENDING. Do NOT blind-resend — verify with the provider first.`,
      resolutionAction:
        "Verify with the provider/customer whether the message arrived, correct the EmailLog row, and only then resend if it truly never left.",
    });
  }

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

/**
 * GL-03 — QUEUED means RETRIED: re-send one throttled outbox row from its
 * stored body, exactly once across concurrent sweepers (a guarded claim on
 * the row). Returns what happened so the sweep can count and escalate.
 * Rows with attachments are never blind-resent (the attachment bytes are
 * not stored) — the caller escalates those to owned work.
 */
export async function resendQueuedEmail(row: {
  id: string;
  toEmail: string;
  subject: string;
  template: string;
  customerId?: string | null;
  relatedId?: string | null;
  bodyHtml?: string | null;
  hasAttachments?: boolean | null;
}): Promise<"RESENT" | "STILL_QUEUED" | "UNRESENDABLE" | "LOST"> {
  if (row.hasAttachments || !row.bodyHtml) return "UNRESENDABLE";
  // Exactly one sweeper owns the retry: QUEUED → SENDING, guarded.
  const claim = await casGuardedUpdate(
    "EmailLog",
    row.id,
    { deliveryStatus: "SENDING" },
    [{ kind: "fieldEquals", field: "deliveryStatus", value: "QUEUED" }]
  );
  if (!claim.ok) return "LOST";
  const ok = await sendEmail({
    to: row.toEmail,
    subject: row.subject,
    template: row.template,
    customerId: row.customerId ?? undefined,
    relatedId: row.relatedId ?? undefined,
    html: row.bodyHtml,
  });
  try {
    const client = await dataClient();
    if (ok) {
      // The fresh attempt row carries the live outcome; this row is history.
      await client.models.EmailLog.update({
        id: row.id,
        deliveryStatus: "RESENT",
      });
      return "RESENT";
    }
    // Give the claim back so a later sweep (or a recovered throttle) retries.
    await client.models.EmailLog.update({
      id: row.id,
      deliveryStatus: "QUEUED",
    });
    return "STILL_QUEUED";
  } catch (err) {
    console.error("resendQueuedEmail: settle failed", row.id, err);
    return ok ? "RESENT" : "STILL_QUEUED";
  }
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
/**
 * Owner decision (2026-07-23): staging must never page the real office/sales
 * inboxes — its test data generates a constant stream of ops noise into the
 * same info@ the production alerts land in. backend.ts sets OPS_EMAIL_MUTED on
 * every mail-sending function for non-main branches. Returning true (not
 * false) is deliberate: a muted alert is handled, not failed, so callers never
 * open EMAIL_FAILURE work for it. Customer-facing sends are unaffected — this
 * gate covers only the internal pager helpers.
 */
function opsEmailsMuted(): boolean {
  return Boolean(process.env.OPS_EMAIL_MUTED);
}

export async function notifyOffice(opts: {
  subject: string;
  heading: string;
  bodyHtml: string;
  template: string;
  customerId?: string | null;
  relatedId?: string;
}): Promise<boolean> {
  if (opsEmailsMuted()) {
    console.log("notifyOffice muted (non-production branch):", opts.subject);
    return true;
  }
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
  if (opsEmailsMuted()) {
    console.log("notifyLeads muted (non-production branch):", opts.subject);
    return true;
  }
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
