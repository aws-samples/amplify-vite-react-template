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
): Promise<{
  customerId?: string | null;
  template?: string | null;
  relatedId?: string | null;
} | null> {
  if (!messageId) return null;
  const client = await dataClient();
  if (!("EmailLog" in client.models)) return null;
  // The messageId secondary index turns this into a point query, not a scan —
  // delivery events fire for every send, so this must stay cheap.
  const { data: logs } = await client.models.EmailLog.listEmailLogByMessageId({
    messageId,
  });
  let meta: {
    customerId?: string | null;
    template?: string | null;
    relatedId?: string | null;
  } | null = null;
  for (const log of logs ?? []) {
    meta = {
      customerId: log.customerId,
      template: log.template,
      relatedId: log.relatedId,
    };
    // Terminal-state guard: a duplicate or out-of-order delivery event must
    // never move a bounced/complained message back to delivered.
    if (
      deliveryStatus === "DELIVERED" &&
      (log.deliveryStatus === "BOUNCED" || log.deliveryStatus === "COMPLAINED")
    ) {
      continue;
    }
    await client.models.EmailLog.update({
      id: log.id,
      deliveryStatus,
      ...(error ? { error } : {}),
    });
  }
  return meta;
}

/**
 * GL-15 / X3 — the later mailbox outcome corrects the BUSINESS record that
 * originated the message, not only the general email log. For a service report
 * or amendment: a delivery event upgrades ACCEPTED → DELIVERED; a bounce or
 * complaint marks the legal record BOUNCED/COMPLAINED and REOPENS the delivery
 * obligation as owned work — the report screen stops claiming the customer
 * received it. Terminal-guarded: a late delivery event cannot un-bounce.
 */
async function correctOriginRecord(
  meta: { template?: string | null; relatedId?: string | null; customerId?: string | null } | null,
  outcome: "DELIVERED" | "BOUNCED" | "COMPLAINED",
  detail: string
): Promise<void> {
  if (!meta?.relatedId || !meta.template) return;
  const client = await dataClient();
  const isReport = meta.template === "service-report";
  const isAmendment = meta.template === "service-report-amendment";
  if (!isReport && !isAmendment) return;
  try {
    // Branched (not a model-union) — naming the two model client types in one
    // expression trips tsc's inference-depth ceiling.
    let current: string | null = null;
    let exists = false;
    if (isReport) {
      const { data } = await client.models.ServiceReport.get({
        id: meta.relatedId,
      });
      exists = Boolean(data);
      current = data?.deliveryStatus ?? null;
    } else {
      const { data } = await client.models.ServiceReportAmendment.get({
        id: meta.relatedId,
      });
      exists = Boolean(data);
      current = data?.deliveryStatus ?? null;
    }
    if (!exists) return;
    // Never regress a terminal bad outcome to delivered, and never overwrite an
    // office-recorded alternate delivery.
    if (
      current === "ALTERNATE_DELIVERED" ||
      (outcome === "DELIVERED" &&
        (current === "BOUNCED" || current === "COMPLAINED"))
    ) {
      return;
    }
    if (isReport) {
      await client.models.ServiceReport.update({
        id: meta.relatedId,
        deliveryStatus: outcome,
      });
    } else {
      await client.models.ServiceReportAmendment.update({
        id: meta.relatedId,
        deliveryStatus: outcome,
      });
    }
    if (outcome !== "DELIVERED") {
      await openOwnedWork({
        kind: "EMAIL_FAILURE",
        dedupeKey: isReport
          ? `service-report-delivery:${meta.relatedId}`
          : `report-amendment-delivery:${meta.relatedId}`,
        title: isReport
          ? "A customer's service report bounced — the legal record is undelivered"
          : "A report amendment bounced — the correction is undelivered",
        detail: `${detail} The record's delivery state has been corrected; the customer does NOT have their copy.`,
        customerId: meta.customerId ?? undefined,
        relatedId: meta.relatedId,
        sourceUrl: meta.customerId ? `/customers/${meta.customerId}` : "/work",
        resolutionAction:
          "Correct the address and re-send the exact document, or deliver it by an approved alternate method and record how.",
        ownerTeam: "OPS",
      });
    }
  } catch (err) {
    console.error("correctOriginRecord failed", meta.relatedId, err);
  }
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
    const meta = await markLogDelivery(messageId, "DELIVERED");
    await correctOriginRecord(meta, "DELIVERED", "The mailbox provider confirmed delivery.");
    return;
  }

  if (type === "bounce") {
    const bounce = message.bounce;
    // Only permanent bounces are a dead address; transient bounces (a full
    // mailbox, a momentary defer) are retryable and must not suppress.
    if ((bounce?.bounceType ?? "").toLowerCase() !== "permanent") return;
    const detail = `Bounce: ${bounce?.bounceType ?? ""}/${bounce?.bounceSubType ?? ""}`.trim();
    const meta = await markLogDelivery(messageId, "BOUNCED", detail);
    await correctOriginRecord(meta, "BOUNCED", detail);
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
    await correctOriginRecord(meta, "COMPLAINED", detail);
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
