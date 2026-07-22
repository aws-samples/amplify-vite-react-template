import { casGuardedUpdate } from "./atomicLock";
import { oneBusinessDayDueAt } from "./businessDays";
import { dataClient } from "./dataClient";
import {
  acquireLeadLifecycleClaim,
  releaseLeadLifecycleClaim,
} from "./leadClaim";
import { isLeadOpen } from "./leadStage";
import { defaultWorkOwner, openOwnedWork, workItemId } from "./ownedWork";

const MAX_HEALTHY_GAP_MS = 35 * 60_000;

/** Reconcile every open lead to exactly one visible Office obligation. Each
 * lead is isolated; a partial run is durably detectable and then throws so the
 * Lambda alarm also fires. */
export async function sweepLeads(now: Date = new Date()) {
  const client = await dataClient();
  const nowIso = now.toISOString();
  const recoveryDueAt = (await oneBusinessDayDueAt(now)).toISOString();
  const heartbeat = await client.models.LeadSweepState.get({ id: "lead-sweep" });
  if (heartbeat.errors?.length) throw new Error("Lead sweep heartbeat could not be read.");
  const lastComplete = heartbeat.data?.lastCompletedAt
    ? Date.parse(heartbeat.data.lastCompletedAt)
    : null;
  const lastStarted = heartbeat.data?.lastStartedAt
    ? Date.parse(heartbeat.data.lastStartedAt)
    : null;
  const incompleteStart =
    lastStarted && (!lastComplete || lastStarted > lastComplete)
      ? lastStarted
      : null;
  const healthReference = incompleteStart ?? lastComplete;
  if (healthReference && now.getTime() - healthReference > MAX_HEALTHY_GAP_MS) {
    const referenceIso = new Date(healthReference).toISOString();
    const missed = await openOwnedWork({
      kind: "INFRA_ALERT",
      dedupeKey: `lead-sweep-missed:${referenceIso}`,
      title: incompleteStart
        ? "Lead sweep did not finish"
        : "Lead sweep missed its expected interval",
      detail: incompleteStart
        ? `A lead sweep started at ${referenceIso} but never recorded complete; lead obligations may be only partially reconciled.`
        : `The last fully successful lead sweep completed at ${referenceIso}; lead obligations may not have escalated on time.`,
      relatedId: "lead-sweep",
      sourceUrl: "/work",
      resolutionAction:
        "Run the lead sweep once, confirm it completes with zero failed leads, and verify the next scheduled invocation.",
      ownerTeam: "SALES",
      dueAt: recoveryDueAt,
    });
    if (!missed) throw new Error("A missed lead sweep could not be placed in shared Office work.");
  }
  const started = heartbeat.data
    ? await client.models.LeadSweepState.update({ id: "lead-sweep", lastStartedAt: nowIso, failed: 0 })
    : await client.models.LeadSweepState.create({ id: "lead-sweep", lastStartedAt: nowIso, failed: 0 });
  if (!started.data) throw new Error("Lead sweep start could not be recorded.");

  let scanned = 0;
  let failed = 0;
  let token: string | null | undefined;
  try {
    do {
      const page = await client.models.Customer.listCustomerByStatusAndDisplayName(
        { status: "LEAD" },
        { limit: 200, nextToken: token }
      );
      if (page.errors?.length) throw new Error(page.errors.map((e) => e.message).join("; "));
      for (const listedLead of page.data ?? []) {
        scanned++;
        if (!isLeadOpen(listedLead)) continue;
        const mutationId = `sweep:${nowIso}`;
        const claim = await acquireLeadLifecycleClaim(listedLead.id, mutationId);
        // A staff action or another sweep owns this lead. Its winner must
        // reconcile the obligation; the next 15-minute sweep verifies it.
        if (!claim.won) continue;
        try {
          const current = await client.models.Customer.get({ id: listedLead.id });
          if (current.errors?.length || !current.data) {
            throw new Error("Lead could not be re-read under its lifecycle claim.");
          }
          const lead = current.data;
          if (!isLeadOpen(lead)) continue;
          if (!lead.nextAction || !lead.nextActionAt || lead.leadOwnerTeam !== "SALES") {
            throw new Error("Lead is missing its action, deadline, or staffed Sales-team owner.");
          }
          const itemId = workItemId("LEAD_FOLLOWUP", lead.id);
          let item = await client.models.WorkItem.get({ id: itemId });
          if (item.errors?.length) throw new Error(item.errors.map((e) => e.message).join("; "));
          if (!item.data || item.data.status !== "OPEN") {
            const opened = await openOwnedWork({
              kind: "LEAD_FOLLOWUP",
              dedupeKey: lead.id,
              title: `${lead.nextAction}: ${lead.displayName}`,
              detail: `Current action: ${lead.nextAction}. Due ${lead.nextActionAt}.`,
              customerId: lead.id,
              relatedId: lead.id,
              sourceUrl: `/customers/${lead.id}`,
              resolutionAction:
                "Open the lead and record the actual controlled outcome; the next obligation is replaced automatically.",
              ownerTeam: "SALES",
              ownerSub: lead.leadOwnerSub ?? undefined,
              ownerEmail: lead.leadOwnerEmail ?? defaultWorkOwner("SALES"),
              dueAt: lead.nextActionAt,
            });
            if (!opened) throw new Error("The lead follow-up could not be repaired.");
            item = await client.models.WorkItem.get({ id: itemId });
          }
          if (
            item.data?.status === "OPEN" &&
            (item.data.dueAt !== lead.nextActionAt ||
              item.data.title !== `${lead.nextAction}: ${lead.displayName}`)
          ) {
            const synced = await client.models.WorkItem.update({
              id: itemId,
              title: `${lead.nextAction}: ${lead.displayName}`,
              detail: `Current action: ${lead.nextAction}. Due ${lead.nextActionAt}.`,
              dueAt: lead.nextActionAt,
              escalatedAt: null,
            });
            if (!synced.data) throw new Error("Lead obligation could not be synchronized.");
            item = { data: synced.data };
          }
          if (
            now.getTime() >= Date.parse(lead.nextActionAt) &&
            item.data?.status === "OPEN" &&
            !item.data.escalatedAt
          ) {
            const eventId = `lead-overdue:${lead.id}:${lead.nextActionAt}`;
            const existingEvent = await client.models.WorkEvent.get({ id: eventId });
            if (existingEvent.errors?.length) throw new Error("Lead escalation history could not be read.");
            if (!existingEvent.data) {
              const event = await client.models.WorkEvent.create({
                id: eventId,
                workItemId: itemId,
                eventType: "OVERDUE",
                actorEmail: "system@pestbuzzkill.com",
                note: `The real lead deadline passed at ${lead.nextActionAt}; escalated to the shared Sales queue.`,
                occurredAt: nowIso,
              });
              if (!event.data) {
                const raced = await client.models.WorkEvent.get({ id: eventId });
                if (!raced.data) throw new Error("Lead escalation history could not be recorded.");
              }
            }
            const escalated = await casGuardedUpdate(
              "WorkItem",
              itemId,
              {
                escalatedAt: nowIso,
                ownerSub: null,
                ownerEmail: defaultWorkOwner("SALES"),
              },
              [
                { kind: "fieldEquals", field: "status", value: "OPEN" },
                { kind: "fieldEquals", field: "dueAt", value: lead.nextActionAt },
                { kind: "fieldMissingOrNull", field: "escalatedAt" },
              ]
            );
            if (!escalated.ok) {
              throw new Error("Lead obligation changed while escalation was being recorded.");
            }
            const verified = await client.models.WorkItem.get({ id: itemId });
            if (
              verified.data?.escalatedAt !== nowIso ||
              verified.data.ownerSub
            ) {
              throw new Error("Lead escalation could not be durably confirmed.");
            }
          }
        } catch (error) {
          failed++;
          const recovery = await openOwnedWork({
            kind: "LEAD_LIFECYCLE_RECOVERY",
            dedupeKey: `sweep:${listedLead.id}`,
            title: `Lead sweep could not verify ${listedLead.displayName}`,
            detail: error instanceof Error ? error.message : String(error),
            customerId: listedLead.id,
            relatedId: listedLead.id,
            sourceUrl: `/customers/${listedLead.id}`,
            resolutionAction:
              "Open the lead and run its one safe current action; confirm owner, action, due time, and shared follow-up all agree.",
            ownerTeam: "SALES",
            dueAt: recoveryDueAt,
          });
          if (!recovery) console.error("lead sweep recovery work also failed", listedLead.id);
        } finally {
          await releaseLeadLifecycleClaim(listedLead.id, claim.holder);
        }
      }
      token = page.nextToken;
    } while (token);
  } catch (scanError) {
    await client.models.LeadSweepState.update({ id: "lead-sweep", scanned, failed: Math.max(1, failed) });
    const owned = await openOwnedWork({
      kind: "INFRA_ALERT",
      dedupeKey: `lead-sweep-scan:${nowIso}`,
      title: "Lead sweep could not read the complete lead queue",
      detail: scanError instanceof Error ? scanError.message : String(scanError),
      relatedId: "lead-sweep",
      sourceUrl: "/work",
      resolutionAction:
        "Run the lead sweep again and confirm every page completes; do not treat the partial scan as an all-clear.",
      ownerTeam: "SALES",
      dueAt: recoveryDueAt,
    });
    if (!owned) throw new Error("Lead sweep scan failed and its shared recovery could not be recorded.");
    throw scanError;
  }

  if (failed) {
    await client.models.LeadSweepState.update({ id: "lead-sweep", scanned, failed });
    throw new Error(`Lead sweep partial: ${failed} of ${scanned} leads failed verification.`);
  }
  const complete = await client.models.LeadSweepState.update({
    id: "lead-sweep",
    lastCompletedAt: nowIso,
    scanned,
    failed: 0,
  });
  if (!complete.data) throw new Error("Lead sweep completion could not be recorded.");
  return { scanned, failed: 0 };
}
