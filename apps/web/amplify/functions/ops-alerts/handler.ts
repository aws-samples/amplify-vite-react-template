import type { SNSEvent } from "aws-lambda";
import { notifyOffice } from "../shared/email";
import { openOwnedWork, resolveOwnedWork } from "../shared/ownedWork";

/**
 * GL-22 — CloudWatch alarm state changes become deduplicated, owned
 * shared-Office work. ALARM opens (or re-occurs) one INFRA_ALERT item per
 * alarm name; OK auto-resolves it with the recovery note. The item carries
 * the one common one-business-day response deadline and the queue's normal
 * claim/escalation behavior — no critical/high/routine classes, no
 * permanently named primary.
 */

type AlarmMessage = {
  AlarmName?: string;
  AlarmDescription?: string | null;
  NewStateValue?: string;
  NewStateReason?: string;
  StateChangeTime?: string;
  Region?: string;
};

export async function handleAlarm(message: AlarmMessage): Promise<void> {
  const name = message.AlarmName ?? "unknown-alarm";
  const state = (message.NewStateValue ?? "").toUpperCase();
  if (state === "OK") {
    await resolveOwnedWork({
      kind: "INFRA_ALERT",
      dedupeKey: `alarm:${name}`,
      note: `CloudWatch reports the alarm recovered: ${message.NewStateReason ?? "back to OK"}.`,
    });
    return;
  }
  if (state !== "ALARM") return; // INSUFFICIENT_DATA carries no action

  const detailLines = [
    message.AlarmDescription?.trim(),
    `CloudWatch reason: ${message.NewStateReason ?? "n/a"}`,
    `State change: ${message.StateChangeTime ?? "n/a"} (${message.Region ?? ""})`,
  ].filter(Boolean);
  await openOwnedWork({
    kind: "INFRA_ALERT",
    dedupeKey: `alarm:${name}`,
    title: `Infrastructure alert: ${name}`,
    detail: detailLines.join("\n"),
    relatedId: name,
    resolutionAction:
      "Open CloudWatch for this alarm, fix or escalate the underlying failure, and close only when the system fact is verified healthy.",
    ownerTeam: "OPS",
  });
  await notifyOffice({
    subject: `INFRA ALERT: ${name}`,
    heading: "A background system failure needs attention",
    template: "ops-infra-alert",
    relatedId: name,
    bodyHtml: `<p><strong>${name}</strong> is in ALARM.</p><p>${(message.AlarmDescription ?? "").trim() || "No description recorded."}</p><p style="color:#666;font-size:13px;">${message.NewStateReason ?? ""}</p><p>An owned work item is on the shared queue with the one-business-day clock.</p>`,
  }).catch(() => undefined);
}

export const handler = async (event: SNSEvent): Promise<void> => {
  const failures: unknown[] = [];
  for (const record of event.Records) {
    try {
      await handleAlarm(JSON.parse(record.Sns.Message) as AlarmMessage);
    } catch (err) {
      console.error("ops-alerts: failed to process alarm", err);
      failures.push(err);
    }
  }
  // A failed alert-processing run must not be silently acknowledged — throw
  // so the delivery retries and, if it keeps failing, dead-letters visibly.
  if (failures.length) {
    throw new Error(`ops-alerts: ${failures.length} alarm record(s) failed`);
  }
};
