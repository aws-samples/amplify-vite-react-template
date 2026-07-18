/**
 * GL-02 — the lead lifecycle operations, behind named mutations (raw
 * Customer.update is closed to the browser). The pipeline STAGE is derived
 * (leadStage.ts), so there is deliberately no "set stage" here: the only
 * hand-set states are the two terminal decisions (Lost, Do-not-contact). Every
 * other advance happens automatically as the lead is worked — a logged touch, a
 * booking link, a conversion.
 */

import { dataClient } from "./dataClient";
import {
  findLeadDuplicates,
  normalizeEmail,
  normalizePhone,
  type LeadCandidate,
} from "./leadIdentity";
import {
  openMissingContactWork,
  openOwnedWork,
  resolveOwnedWork,
} from "./ownedWork";

export type LeadActor = { sub: string | null; email: string | null };

/** Controlled reasons a lead may be marked Lost (Head of Sales to confirm). */
export const LEAD_LOST_REASONS = [
  "PRICE",
  "NO_RESPONSE",
  "WENT_COMPETITOR",
  "NOT_QUALIFIED",
  "OUT_OF_AREA",
  "DUPLICATE",
  "OTHER",
] as const;

export const LEAD_TOUCH_CHANNELS = ["CALL", "TEXT", "EMAIL", "BOOKING_LINK", "NOTE"] as const;
export const LEAD_TOUCH_OUTCOMES = [
  "REACHED",
  "LEFT_MESSAGE",
  "NO_ANSWER",
  "SENT",
  "FAILED",
  "NOTE",
] as const;

// A delivery that did not reach the customer is not a touch (GL-02 R6) and must
// not reset the follow-up clock or close the follow-up task.
const NON_TOUCH_OUTCOMES = new Set(["FAILED", "SUPPRESSED", "BOUNCED", "NOTE"]);

/**
 * Append an immutable LeadActivity. A real touch (anything that actually reached
 * or attempted to reach the customer) also bumps lastTouchedAt and resolves the
 * lead's open follow-up. Best-effort: never throws into the caller.
 */
export async function appendLeadActivity(input: {
  customerId: string;
  channel: string;
  direction?: string | null;
  outcome: string;
  note?: string | null;
  actor: LeadActor;
}): Promise<void> {
  try {
    const client = await dataClient();
    if (!("LeadActivity" in client.models)) return;
    const nowIso = new Date().toISOString();
    await client.models.LeadActivity.create({
      customerId: input.customerId,
      channel: input.channel,
      direction: input.direction ?? "OUTBOUND",
      actorSub: input.actor.sub ?? undefined,
      actorEmail: input.actor.email ?? "system@pestbuzzkill.com",
      outcome: input.outcome,
      note: input.note ?? undefined,
      occurredAt: nowIso,
    });
    const realTouch =
      input.channel !== "LIFECYCLE" && !NON_TOUCH_OUTCOMES.has(input.outcome);
    if (realTouch) {
      await client.models.Customer.update({
        id: input.customerId,
        lastTouchedAt: nowIso,
      });
      // The lead was genuinely worked — clear the follow-up task. A new one
      // reappears when the next cadence lapses (the sweep is self-healing).
      await resolveOwnedWork({
        kind: "LEAD_FOLLOWUP",
        dedupeKey: input.customerId,
        note: `Lead worked: ${input.channel.toLowerCase()} — ${input.outcome.toLowerCase()}.`,
      });
    }
  } catch (err) {
    console.error("appendLeadActivity failed", input.customerId, err);
  }
}

export type CreateLeadArgs = {
  displayName?: string | null;
  contactName?: string | null;
  email?: string | null;
  phone?: string | null;
  serviceStreet?: string | null;
  serviceCity?: string | null;
  serviceState?: string | null;
  serviceZip?: string | null;
  leadSource?: string | null;
  notes?: string | null;
  force?: boolean | null;
};

export type CreateLeadResult =
  | { decision: "DUPLICATE"; candidates: LeadCandidate[] }
  | { decision: "CREATED"; id: string };

/**
 * Create a lead through the dedup gate (R3). Normalizes and looks for existing
 * matches BEFORE creating; on a match (and not forced) it creates nothing and
 * returns the candidates so a human decides — never a silent merge. force:true
 * (Create-separate / Ask-manager) creates and opens DUPLICATE_LEAD so the
 * deliberate second record is audited. Incomplete contact data is accepted but
 * owned (R4).
 */
export async function createLead(
  args: CreateLeadArgs,
  actor: LeadActor
): Promise<CreateLeadResult> {
  const displayName = (args.displayName ?? "").trim();
  if (!displayName) throw new Error("A name is required to create a lead.");
  const email = normalizeEmail(args.email);
  const phone = normalizePhone(args.phone);

  if (!args.force) {
    const candidates = await findLeadDuplicates({
      email: args.email,
      phone: args.phone,
      name: displayName,
      zip: args.serviceZip,
    });
    if (candidates.length > 0) return { decision: "DUPLICATE", candidates };
  }

  const client = await dataClient();
  const { data: created, errors } = await client.models.Customer.create({
    displayName,
    contactName: args.contactName?.trim() || undefined,
    email,
    phone,
    serviceStreet: args.serviceStreet?.trim() || undefined,
    serviceCity: args.serviceCity?.trim() || undefined,
    serviceState: args.serviceState?.trim() || undefined,
    serviceZip: args.serviceZip?.trim() || undefined,
    leadSource: args.leadSource?.trim() || undefined,
    leadNotes: args.notes?.trim() || undefined,
    status: "LEAD",
    // The office member adding a lead by hand owns it — they are working it now.
    leadOwnerSub: actor.sub ?? undefined,
    leadOwnerEmail: actor.email ?? undefined,
  });
  if (!created) {
    throw new Error(
      errors?.map((e) => e.message).join("; ") || "Could not create the lead"
    );
  }

  // R4: no way to reach them is accepted but owned, never a silent gap.
  if (!email && !phone) {
    await openMissingContactWork({
      customerId: created.id,
      displayName,
      context: "A lead was created with no usable email or phone.",
    });
  }
  // A deliberately-separate record (Create-separate / Ask-manager) is audited so
  // a human confirms the two are really different people.
  if (args.force) {
    await openOwnedWork({
      kind: "DUPLICATE_LEAD",
      dedupeKey: created.id,
      title: `Possible duplicate lead created: ${displayName}`,
      detail: `A lead for ${displayName} was created as a separate record despite a possible match. Confirm they are distinct people, or merge/keep per policy.`,
      customerId: created.id,
      relatedId: created.id,
      sourceUrl: `/customers/${created.id}`,
      resolutionAction:
        "Compare this lead to the possible duplicate. If they are the same person, keep one record and note the decision; if distinct, confirm and close.",
      ownerTeam: "SALES",
    });
  }
  return { decision: "CREATED", id: created.id };
}

export async function logLeadTouch(
  args: {
    customerId: string;
    channel: string;
    direction?: string | null;
    outcome: string;
    note?: string | null;
    nextAction?: string | null;
    nextActionAt?: string | null;
  },
  actor: LeadActor
): Promise<{ ok: true }> {
  if (!(LEAD_TOUCH_CHANNELS as readonly string[]).includes(args.channel)) {
    throw new Error("Unknown contact channel.");
  }
  if (!(LEAD_TOUCH_OUTCOMES as readonly string[]).includes(args.outcome)) {
    throw new Error("Pick what actually happened on this touch.");
  }
  await appendLeadActivity({
    customerId: args.customerId,
    channel: args.channel,
    direction: args.direction ?? "OUTBOUND",
    outcome: args.outcome,
    note: args.note,
    actor,
  });
  // An explicit next step the office committed to overrides the derived due.
  if (args.nextAction || args.nextActionAt) {
    const client = await dataClient();
    await client.models.Customer.update({
      id: args.customerId,
      nextAction: args.nextAction ?? undefined,
      nextActionAt: args.nextActionAt ?? undefined,
    });
  }
  return { ok: true };
}

export async function setLeadDisposition(
  args: {
    customerId: string;
    disposition: string;
    reasonCode?: string | null;
    note?: string | null;
  },
  actor: LeadActor
): Promise<{ ok: true; disposition: string }> {
  const client = await dataClient();
  const nowIso = new Date().toISOString();
  const actorLabel = actor.email ?? actor.sub ?? "unknown staff";

  if (args.disposition === "LOST") {
    const reason = (args.reasonCode ?? "").trim();
    if (!(LEAD_LOST_REASONS as readonly string[]).includes(reason)) {
      throw new Error("Choose a controlled reason for marking this lead lost.");
    }
    await client.models.Customer.update({
      id: args.customerId,
      lostReason: reason,
      lostAt: nowIso,
    });
    await appendLeadActivity({
      customerId: args.customerId,
      channel: "LIFECYCLE",
      outcome: "NOTE",
      note: `Marked LOST (${reason})${args.note ? `: ${args.note}` : ""}.`,
      actor,
    });
  } else if (args.disposition === "DNC") {
    await client.models.Customer.update({
      id: args.customerId,
      doNotContact: true,
      doNotContactAt: nowIso,
      doNotContactBy: actorLabel,
    });
    await appendLeadActivity({
      customerId: args.customerId,
      channel: "LIFECYCLE",
      outcome: "NOTE",
      note: `Set DO-NOT-CONTACT by ${actorLabel}${args.note ? `: ${args.note}` : ""}.`,
      actor,
    });
  } else if (args.disposition === "CLEAR") {
    await client.models.Customer.update({
      id: args.customerId,
      lostReason: null,
      lostAt: null,
      doNotContact: false,
      doNotContactAt: null,
      doNotContactBy: null,
    });
    await appendLeadActivity({
      customerId: args.customerId,
      channel: "LIFECYCLE",
      outcome: "NOTE",
      note: `Reopened the lead (cleared lost / do-not-contact).`,
      actor,
    });
  } else {
    throw new Error("Unknown lead disposition — use LOST, DNC, or CLEAR.");
  }

  // A terminal decision (or a reopen) ends the current follow-up obligation.
  await resolveOwnedWork({
    kind: "LEAD_FOLLOWUP",
    dedupeKey: args.customerId,
    note: `Lead disposition set to ${args.disposition}.`,
  });
  return { ok: true, disposition: args.disposition };
}

export async function assignLeadOwner(
  args: { customerId: string; toSub?: string | null; toEmail?: string | null },
  actor: LeadActor
): Promise<{ ok: true; ownerEmail: string | null }> {
  // "Assign to me" (no target) stamps the caller; a reassign passes a target.
  const ownerSub = args.toSub ?? actor.sub;
  const ownerEmail = args.toEmail ?? actor.email;
  const client = await dataClient();
  await client.models.Customer.update({
    id: args.customerId,
    leadOwnerSub: ownerSub ?? undefined,
    leadOwnerEmail: ownerEmail ?? undefined,
  });
  return { ok: true, ownerEmail: ownerEmail ?? null };
}
