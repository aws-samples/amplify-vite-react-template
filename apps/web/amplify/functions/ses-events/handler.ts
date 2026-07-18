import type { SNSEvent } from "aws-lambda";
import { dataClient } from "../shared/dataClient";
import { openOwnedWork } from "../shared/ownedWork";

/**
 * GL-03 — turn an SES bounce/complaint/delivery notification into truthful
 * delivery state. SES (via a configuration set) publishes to an SNS topic this
 * function subscribes to. A permanent bounce or a complaint suppresses the
 * address and opens an owned EMAIL_FAILURE with an alternate-contact next step;
 * a delivery marks the log DELIVERED. Everything is best-effort per record so
 * one malformed notification never drops the rest of the batch.
 */

type SesRecipient = { emailAddress?: string; diagnosticCode?: string };

export type SesNotification = {
  /** Identity feedback uses notificationType; config-set events use eventType. */
  notificationType?: string;
  eventType?: string;
  mail?: {
    messageId?: string;
    destination?: string[];
    commonHeaders?: { subject?: string; to?: string[] };
  };
  bounce?: {
    bounceType?: string;
    bounceSubType?: string;
    bouncedRecipients?: SesRecipient[];
  };
  complaint?: {
    complainedRecipients?: SesRecipient[];
    complaintFeedbackType?: string;
  };
  delivery?: { recipients?: string[] };
};

async function markLogDelivery(
  messageId: string | undefined,
  deliveryStatus: "DELIVERED" | "BOUNCED" | "COMPLAINED",
  error?: string
): Promise<{ customerId?: string | null; template?: string | null } | null> {
  if (!messageId) return null;
  const client = await dataClient();
  if (!("EmailLog" in client.models)) return null;
  // The messageId secondary index turns this into a point query, not a scan —
  // delivery events fire for every send, so this must stay cheap.
  const { data: logs } = await client.models.EmailLog.listEmailLogByMessageId({
    messageId,
  });
  let meta: { customerId?: string | null; template?: string | null } | null = null;
  for (const log of logs ?? []) {
    meta = { customerId: log.customerId, template: log.template };
    await client.models.EmailLog.update({
      id: log.id,
      deliveryStatus,
      ...(error ? { error } : {}),
    });
  }
  return meta;
}

async function suppress(input: {
  email: string;
  reason: string;
  source: string;
  relatedId?: string;
}): Promise<void> {
  const client = await dataClient();
  if (!("SuppressedEmail" in client.models)) return;
  const email = input.email.trim().toLowerCase();
  if (!email) return;
  const { data: existing } = await client.models.SuppressedEmail.get({ email });
  if (existing) return; // already suppressed — keep the first reason/time
  await client.models.SuppressedEmail.create({
    email,
    reason: input.reason,
    source: input.source,
    relatedId: input.relatedId,
    suppressedAt: new Date().toISOString(),
  });
}

async function handleBadAddress(input: {
  email: string;
  kind: "BOUNCED" | "COMPLAINED";
  detail: string;
  messageId?: string;
  customerId?: string | null;
}): Promise<void> {
  const email = input.email.trim().toLowerCase();
  if (!email) return;
  const isComplaint = input.kind === "COMPLAINED";
  await suppress({
    email,
    reason: input.detail,
    source: input.kind,
    relatedId: input.customerId ?? undefined,
  });
  // Tie the exception to the customer when we know them; otherwise to the
  // address so repeated events for the same lead collapse into one case.
  await openOwnedWork({
    kind: "EMAIL_FAILURE",
    dedupeKey: `${input.kind.toLowerCase()}:${email}`,
    title: isComplaint
      ? `Email marked as spam by ${email}`
      : `Email to ${email} hard-bounced`,
    detail: isComplaint
      ? `${email} marked a BuzzKill email as spam, so we've stopped sending to it. ${input.detail}`
      : `A message the provider first accepted then permanently bounced from ${email}, so it never reached them and we've stopped sending to it. ${input.detail}`,
    customerId: input.customerId ?? undefined,
    relatedId: input.customerId ?? email,
    sourceUrl: input.customerId ? `/customers/${input.customerId}` : "/more",
    resolutionAction: isComplaint
      ? "Confirm whether the customer still wants email. Get a preferred channel, deliver anything they missed, and record how — the address stays suppressed until you lift it."
      : "Get a corrected email or another way to reach them, deliver the missed message, and record how. The bad address stays suppressed until you lift it.",
    ownerTeam: "OPS",
  });
}

/**
 * The testable core: process one parsed SES notification. Pure of any Lambda
 * plumbing so bounce/complaint/delivery handling is unit tested directly.
 */
export async function handleSesNotification(
  message: SesNotification
): Promise<void> {
  const type = (message.notificationType ?? message.eventType ?? "").toLowerCase();
  const messageId = message.mail?.messageId;

  if (type === "delivery") {
    await markLogDelivery(messageId, "DELIVERED");
    return;
  }

  if (type === "bounce") {
    const bounce = message.bounce;
    // Only permanent bounces are a dead address; transient bounces (a full
    // mailbox, a momentary defer) are retryable and must not suppress.
    if ((bounce?.bounceType ?? "").toLowerCase() !== "permanent") return;
    const detail = `Bounce: ${bounce?.bounceType ?? ""}/${bounce?.bounceSubType ?? ""}`.trim();
    const meta = await markLogDelivery(messageId, "BOUNCED", detail);
    for (const r of bounce?.bouncedRecipients ?? []) {
      if (!r.emailAddress) continue;
      await handleBadAddress({
        email: r.emailAddress,
        kind: "BOUNCED",
        detail: r.diagnosticCode ? `${detail}. ${r.diagnosticCode}` : detail,
        messageId,
        customerId: meta?.customerId,
      });
    }
    return;
  }

  if (type === "complaint") {
    const detail = `Complaint: ${message.complaint?.complaintFeedbackType ?? "spam"}`;
    const meta = await markLogDelivery(messageId, "COMPLAINED", detail);
    for (const r of message.complaint?.complainedRecipients ?? []) {
      if (!r.emailAddress) continue;
      await handleBadAddress({
        email: r.emailAddress,
        kind: "COMPLAINED",
        detail,
        messageId,
        customerId: meta?.customerId,
      });
    }
    return;
  }

  // Reject / Send / Open / Click and anything else carry no new truth we act on.
}

export const handler = async (event: SNSEvent): Promise<void> => {
  for (const record of event.Records) {
    let message: SesNotification;
    try {
      message = JSON.parse(record.Sns.Message) as SesNotification;
    } catch (err) {
      console.error("ses-events: could not parse SNS message", err);
      continue;
    }
    try {
      await handleSesNotification(message);
    } catch (err) {
      // One bad notification must not fail the batch (SNS would redeliver all).
      console.error("ses-events: failed to handle notification", err);
    }
  }
};
