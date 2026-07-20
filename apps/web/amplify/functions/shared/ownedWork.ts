import { createHash } from "node:crypto";
import { dataClient } from "./dataClient";
import { casGuardedUpdate } from "./atomicLock";
import type { WorkKind } from "./workPolicy";

// WorkKind is owned by workPolicy.ts (the GL-18 registry) — re-exported here so
// the many producers that already import it from ownedWork keep compiling.
export type { WorkKind };

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
  // Access was revoked, but a downstream offboarding effect (future-job
  // reassignment or technician deactivation) did not complete. The person is
  // already locked out (fail-safe), so the clock is operational, not the
  // security-critical shortest one — the resume action is to re-run offboard.
  STAFF_OFFBOARD: 4 * 60,
  // A staff access change (demotion/offboard) whose access-removal step failed
  // partway, or whose audit record could not be written — a person may be left
  // enabled or ambiguously privileged, or a sensitive action left unproven. The
  // security-critical clock: shortest of the staff kinds.
  STAFF_SECURITY: 30,
  // GL-02: a lead's follow-up is surfaced by the daily sweep only once it is
  // already overdue, so the item itself carries a routine one-day clock to be
  // picked up. Business-tunable.
  LEAD_FOLLOWUP: 24 * 60,
  LEAD_LIFECYCLE_RECOVERY: 24 * 60,
  // GL-09: a customer deactivation/reactivation left access, billing, or the
  // audit record in a mixed state. Money/access is exposed, so a prompt clock.
  LIFECYCLE_RECOVERY: 60,
  // GL-08: a plan cancellation didn't fully finish, or a charge posted after the
  // customer cancelled. Billing may be live and money is owed back — a prompt,
  // money-critical clock (Finance-owned).
  PLAN_CANCELLATION_RECOVERY: 60,
  // GL-07: a visit cancel/reschedule didn't fully finish — a refund may be issued
  // while the visit stayed scheduled, or the audit didn't write. Money-critical.
  VISIT_CHANGE_RECOVERY: 60,
  // GL-13: a stop's route and its assigned technician disagree; the stop is
  // withheld from the field day until the office repairs it. Prompt — a
  // customer's visit is effectively unstaffed while it lasts.
  ROUTE_MISMATCH: 60,
  // GL-13: a former technician's unsent draft report needs an office
  // disposition after a reassignment/cancel. Routine review clock.
  STALE_DRAFT: 24 * 60,
  // GL-13: an office member used emergency field access with a reason —
  // reviewed on the routine clock.
  OFFICE_FIELD_REVIEW: 24 * 60,
  // GL-17: a licence is expiring or expired — advance renewal/reassignment
  // work so customers move before a doorstep failure.
  LICENSE_LAPSE: 24 * 60,
  // GL-12: honest field exits — the customer is waiting on the office's next
  // step, promised within one business day.
  SCOPE_MISMATCH: 4 * 60,
  PREP_MISSING: 4 * 60,
  // GL-12: tomorrow's visit is missing a dispatch fact — same-day fix.
  DISPATCH_NOT_READY: 4 * 60,
  // GL-17: the seasonal monthly-treatment ledger failed a write — routine
  // correction clock.
  OBLIGATION_RECOVERY: 24 * 60,
  // GL-16: a combo exhausted its research attempts — quotes for it fall to
  // the callback path until the office retries, pins, or retires it.
  PRICING_RESEARCH_EXHAUSTED: 24 * 60,
  // GL-16: the day's live rate changes get their recorded review within the
  // common one-business-day commitment — publication is never delayed.
  PRICING_CHANGE_REVIEW: 24 * 60,
  // GL-01: a request for work outside the catalog — the customer gets the
  // add/map/decline answer within the common one-business-day commitment.
  SERVICE_CATALOG_DECISION: 24 * 60,
  // GL-22: a background failure surfaced by an alarm — the same common
  // one-business-day owned response, escalated by the normal overdue sweep.
  INFRA_ALERT: 24 * 60,
  // GL-11: portal reschedule/help requests — the common one-business-day answer.
  CUSTOMER_REQUEST: 24 * 60,
  // GL-19: daily reconciliation mismatches — the common one-business-day
  // clock; Finance signs the money outcomes.
  MONEY_MISMATCH: 24 * 60,
  PLAN_MISMATCH: 24 * 60,
  STATE_MISMATCH: 24 * 60,
  // GL-06: work performed, bank debit failed after — collection is money-
  // critical but the customer was noticed; the common one-business-day clock.
  BALANCE_COLLECTION: 24 * 60,
  // GL-06: a pending debit past its expected settlement date — reconcile with
  // the provider within the common one-business-day commitment.
  PAYMENT_PROCESSING_OVERDUE: 24 * 60,
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
  // GL-02: route a fresh item to a specific owner (e.g. a lead's assigned
  // owner) instead of only the team inbox. Omitted by every other caller, so
  // this is backward compatible: without it the item lands on the team inbox
  // exactly as before.
  ownerSub?: string | null;
  ownerEmail?: string;
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
  const ownerEmail = input.ownerEmail ?? defaultWorkOwner(input.ownerTeam);
  const ownerSub = input.ownerSub ?? null;
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
        // A resolved item starts a fresh ownership/SLA cycle (with the caller's
        // routed owner, if any). An already-open item keeps its claimant.
        ownerSub: existing.status === "RESOLVED" ? ownerSub : existing.ownerSub,
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
        ownerSub: ownerSub ?? undefined,
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

/**
 * GL-18 / GL-14 — return every OPEN exception a departing person had claimed to
 * its team inbox, so no required action stays owned by someone who has been
 * offboarded. Called from the offboarding flow after access is revoked. It never
 * throws into the caller (the person is already locked out), but it now REPORTS
 * failures: `failed > 0` means some claim could not be moved, so the offboard
 * owns it and does not report COMPLETE (GL-14 R5). Each release appends an
 * immutable RELEASED event.
 */
export async function releaseOwnedWorkForSub(input: {
  sub: string;
  reason: string;
  actorEmail?: string | null;
}): Promise<{ released: number; failed: number }> {
  let released = 0;
  let failed = 0;
  if (!input.sub) return { released, failed };
  try {
    const client = await dataClient();
    if (!("WorkItem" in client.models) || !("WorkEvent" in client.models)) {
      return { released, failed };
    }
    let token: string | undefined;
    do {
      const page = await client.models.WorkItem.list({
        filter: {
          status: { eq: "OPEN" },
          ownerSub: { eq: input.sub },
        },
        limit: 200,
        nextToken: token,
      });
      for (const item of page.data ?? []) {
        // Per-item isolation (GL-14): one failed item may not abandon the rest
        // of the sweep — each is counted individually and stays resumable.
        try {
          // Re-read right before moving: a claim made after this sweep began
          // (a newer, active owner) stands — never overwritten back to the
          // team inbox.
          const { data: fresh } = await client.models.WorkItem.get({
            id: item.id,
          });
          if (!fresh || fresh.status !== "OPEN" || fresh.ownerSub !== input.sub) {
            continue;
          }
          const team = (fresh.ownerTeam as WorkOwnerTeam) ?? "OPS";
          // History BEFORE the ownership move, and CHECKED: if the move then
          // fails, a re-run still finds the item owned by the departing person
          // and repairs it. The reverse order loses the trail the moment
          // ownership moves.
          const { data: event } = await client.models.WorkEvent.create({
            workItemId: item.id,
            eventType: "RELEASED",
            actorEmail: input.actorEmail ?? "system@pestbuzzkill.com",
            note: `Returned to the ${team} team inbox — the previous owner was offboarded. ${input.reason}`,
            occurredAt: new Date().toISOString(),
          });
          if (!event) {
            failed++;
            continue;
          }
          // ONE guarded write conditioned on the departing person still being
          // the owner — a claim landing between the re-read and this move
          // stands; offboarding can never overwrite a newer claim (GL-18 R11).
          const moved = await casGuardedUpdate(
            "WorkItem",
            item.id,
            { ownerSub: null, ownerEmail: defaultWorkOwner(team) },
            [{ kind: "fieldEquals", field: "ownerSub", value: input.sub }]
          );
          if (!moved.ok && moved.reason === "UNSUPPORTED") {
            const { data: updated } = await client.models.WorkItem.update({
              id: item.id,
              ownerSub: null,
              ownerEmail: defaultWorkOwner(team),
            });
            if (!updated) {
              failed++;
              continue;
            }
          } else if (!moved.ok) {
            // A newer claim won — that owner keeps it; not a failure.
            continue;
          }
          released++;
        } catch (err) {
          console.error("releaseOwnedWorkForSub: item failed", item.id, err);
          failed++;
        }
      }
      token = page.nextToken ?? undefined;
    } while (token);
  } catch (err) {
    console.error("releaseOwnedWorkForSub failed", input.sub, err);
    failed++;
  }
  return { released, failed };
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
