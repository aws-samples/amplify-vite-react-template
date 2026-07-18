import { createHash } from "node:crypto";
import { dataClient } from "./dataClient";

export type WorkKind =
  | "NO_ACCESS"
  | "EMAIL_FAILURE"
  | "CALLBACK_PROMISE"
  | "DUPLICATE_LEAD"
  | "UNSTAFFED_VISIT"
  | "PAID_VISIT_CANCELLATION"
  | "PORTAL_FAILURE"
  | "PRICING_ESCALATION"
  | "MISSING_CONTACT"
  | "PAID_NOT_FINALIZED"
  | "LOCATION_REVIEW";

export type WorkOwnerTeam = "OPS" | "SALES" | "FINANCE";

export const WORK_SLA_MINUTES: Record<WorkKind, number> = {
  NO_ACCESS: 4 * 60,
  EMAIL_FAILURE: 2 * 60,
  CALLBACK_PROMISE: 60,
  DUPLICATE_LEAD: 24 * 60,
  UNSTAFFED_VISIT: 4 * 60,
  PAID_VISIT_CANCELLATION: 4 * 60,
  PORTAL_FAILURE: 4 * 60,
  PRICING_ESCALATION: 60,
  MISSING_CONTACT: 24 * 60,
  // Money is already in Stripe with no complete booking behind it — the
  // shortest clock in the system.
  PAID_NOT_FINALIZED: 30,
  // A finalized report whose GPS looked imprecise or far from the address. The
  // record already stands — this is an after-the-fact presence review, never a
  // block — so it carries a routine clock.
  LOCATION_REVIEW: 24 * 60,
};

export function defaultWorkOwner(team: WorkOwnerTeam): string {
  if (team === "SALES") {
    return (
      process.env.SES_LEADS_EMAIL ??
      process.env.SES_NOTIFY_EMAIL ??
      "sales@pestbuzzkill.com"
    );
  }
  return process.env.SES_NOTIFY_EMAIL ?? "info@pestbuzzkill.com";
}

export function dueAtFor(
  kind: WorkKind,
  now = new Date(),
  dueAt?: string
): string {
  return (
    dueAt ??
    new Date(now.getTime() + WORK_SLA_MINUTES[kind] * 60_000).toISOString()
  );
}

/** Dynamo ids stay short even when the source key is an email subject/error. */
export function workItemId(kind: WorkKind, dedupeKey: string): string {
  const digest = createHash("sha256").update(dedupeKey).digest("hex").slice(0, 24);
  return `work-${kind.toLowerCase()}-${digest}`;
}

type OpenOwnedWorkInput = {
  kind: WorkKind;
  dedupeKey: string;
  title: string;
  detail: string;
  relatedId: string;
  customerId?: string | null;
  sourceUrl?: string;
  resolutionAction: string;
  ownerTeam: WorkOwnerTeam;
  dueAt?: string;
};

/**
 * Open (or re-open) an owned exception without ever breaking the operation that
 * discovered it. A deterministic id collapses retries into one queue row;
 * every occurrence still gets its own WorkEvent.
 */
export async function openOwnedWork(
  input: OpenOwnedWorkInput
): Promise<string | null> {
  const id = workItemId(input.kind, input.dedupeKey);
  const now = new Date();
  const nowIso = now.toISOString();
  const ownerEmail = defaultWorkOwner(input.ownerTeam);
  try {
    const client = await dataClient();
    // Some unit-test fakes (and a Lambda container briefly straddling a schema
    // deployment) may not have the new model yet. Exception capture must never
    // turn the source operation into a failure.
    if (!("WorkItem" in client.models) || !("WorkEvent" in client.models)) {
      return null;
    }
    const existingResult = await client.models.WorkItem.get({ id });
    if (existingResult.errors?.length) {
      throw new Error(existingResult.errors.map((error) => error.message).join("; "));
    }
    const existing = existingResult.data;
    let eventType: "OPENED" | "REOCCURRED" | "REOPENED" = "OPENED";
    let eventNote = input.detail;

    if (existing) {
      eventType = existing.status === "RESOLVED" ? "REOPENED" : "REOCCURRED";
      eventNote =
        eventType === "REOPENED"
          ? `The exception happened again after resolution. ${input.detail}`
          : `The exception happened again. ${input.detail}`;
      const updated = await client.models.WorkItem.update({
        id,
        status: "OPEN",
        title: input.title,
        detail: input.detail,
        customerId: input.customerId ?? undefined,
        relatedId: input.relatedId,
        sourceUrl: input.sourceUrl,
        resolutionAction: input.resolutionAction,
        ownerTeam: input.ownerTeam,
        // A resolved item starts a fresh ownership/SLA cycle. An already-open
        // item keeps its claimant and original deadline.
        ownerSub: existing.status === "RESOLVED" ? null : existing.ownerSub,
        ownerEmail:
          existing.status === "RESOLVED" ? ownerEmail : existing.ownerEmail,
        dueAt:
          existing.status === "RESOLVED"
            ? dueAtFor(input.kind, now, input.dueAt)
            : existing.dueAt,
        lastOccurredAt: nowIso,
        occurrenceCount: (existing.occurrenceCount ?? 1) + 1,
        escalatedAt: existing.status === "RESOLVED" ? null : existing.escalatedAt,
        resolvedAt: null,
        resolvedBySub: null,
        resolvedByEmail: null,
        resolutionNote: null,
      });
      if (!updated.data) {
        throw new Error(
          updated.errors?.map((error) => error.message).join("; ") ||
            "Could not update owned work"
        );
      }
    } else {
      const { data: created } = await client.models.WorkItem.create({
        id,
        kind: input.kind,
        status: "OPEN",
        title: input.title,
        detail: input.detail,
        customerId: input.customerId ?? undefined,
        relatedId: input.relatedId,
        sourceUrl: input.sourceUrl,
        resolutionAction: input.resolutionAction,
        ownerTeam: input.ownerTeam,
        ownerEmail,
        dueAt: dueAtFor(input.kind, now, input.dueAt),
        lastOccurredAt: nowIso,
        occurrenceCount: 1,
      });
      if (!created) {
        // A concurrent retry may have won the deterministic create. The next
        // invocation will record the recurrence; never fail the source flow.
        console.error("openOwnedWork: deterministic create returned no row", id);
        return null;
      }
    }

    const history = await client.models.WorkEvent.create({
      workItemId: id,
      eventType,
      actorEmail: "system@pestbuzzkill.com",
      note: eventNote,
      occurredAt: nowIso,
    });
    if (!history.data) {
      throw new Error(
        history.errors?.map((error) => error.message).join("; ") ||
          "Could not append owned-work history"
      );
    }
    return id;
  } catch (err) {
    console.error("openOwnedWork failed", input.kind, input.relatedId, err);
    return null;
  }
}

/**
 * Resolve an owned exception that a later success has made moot — e.g. a
 * booking finalization that failed, opened PAID_NOT_FINALIZED, and then
 * completed on a retry. Best-effort and idempotent: a missing or
 * already-resolved item is a no-op, and it never throws into the caller. A
 * system resolution still records a WorkEvent so the queue history is honest.
 */
export async function resolveOwnedWork(input: {
  kind: WorkKind;
  dedupeKey: string;
  note: string;
}): Promise<boolean> {
  const id = workItemId(input.kind, input.dedupeKey);
  const nowIso = new Date().toISOString();
  try {
    const client = await dataClient();
    if (!("WorkItem" in client.models) || !("WorkEvent" in client.models)) {
      return false;
    }
    const { data: existing } = await client.models.WorkItem.get({ id });
    if (!existing || existing.status === "RESOLVED") return false;
    const { data: updated } = await client.models.WorkItem.update({
      id,
      status: "RESOLVED",
      resolvedAt: nowIso,
      resolvedByEmail: "system@pestbuzzkill.com",
      resolutionNote: input.note,
    });
    if (!updated) return false;
    await client.models.WorkEvent.create({
      workItemId: id,
      eventType: "RESOLVED",
      actorEmail: "system@pestbuzzkill.com",
      note: input.note,
      occurredAt: nowIso,
    });
    return true;
  } catch (err) {
    console.error("resolveOwnedWork failed", input.kind, input.dedupeKey, err);
    return false;
  }
}

export async function openMissingContactWork(input: {
  customerId: string;
  displayName: string;
  context: string;
}): Promise<string | null> {
  return openOwnedWork({
    kind: "MISSING_CONTACT",
    dedupeKey: input.customerId,
    title: `Customer has no usable email: ${input.displayName}`,
    detail: `${input.context} The customer record has no email address, so the promised notice could not be delivered.`,
    customerId: input.customerId,
    relatedId: input.customerId,
    sourceUrl: `/customers/${input.customerId}`,
    resolutionAction:
      "Add and verify an email address, deliver the missed notice, then record how the customer was reached.",
    ownerTeam: "OPS",
  });
}
