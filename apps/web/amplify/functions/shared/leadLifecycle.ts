/** GL-02 failure-safe lead intake and mutation contract. */
import { createHash, randomUUID } from "node:crypto";
import { casGuardedUpdate } from "./atomicLock";
import { oneBusinessDayDueAt } from "./businessDays";
import { dataClient } from "./dataClient";
import {
  findLeadDuplicates,
  normalizeEmail,
  normalizeName,
  normalizePhone,
  normalizeZip,
  type LeadCandidate,
} from "./leadIdentity";
import {
  acquireLeadIntakeClaim,
  acquireLeadLifecycleClaim,
  releaseLeadIntakeClaim,
  releaseLeadLifecycleClaim,
} from "./leadClaim";
import {
  defaultWorkOwner,
  openMissingContactWork,
  openOwnedWork,
  resolveOwnedWork,
  workItemId,
} from "./ownedWork";
import { CALL_CONSENT_TEXT, CALL_CONSENT_TEXT_VERSION } from "./consentText";

export type LeadActor = {
  sub: string | null;
  email: string | null;
  isOwner?: boolean;
};

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
  "DELIVERED",
  "LEFT_MESSAGE",
  "NO_ANSWER",
  "SENT",
  "FAILED",
  "BOUNCED",
  "SUPPRESSED",
  "QUALIFIED",
  "UNQUALIFIED",
  "NOTE",
] as const;
export const SUPPRESSION_RELEASE_REASONS = ["CUSTOMER_RECONSENTED", "ENTERED_IN_ERROR"] as const;

const OUTCOMES_BY_CHANNEL: Record<string, readonly string[]> = {
  CALL: ["REACHED", "LEFT_MESSAGE", "NO_ANSWER", "FAILED"],
  TEXT: ["REACHED", "DELIVERED", "SENT", "FAILED", "BOUNCED", "SUPPRESSED"],
  EMAIL: ["REACHED", "DELIVERED", "SENT", "FAILED", "BOUNCED", "SUPPRESSED"],
  BOOKING_LINK: ["REACHED", "DELIVERED", "SENT", "FAILED", "BOUNCED", "SUPPRESSED"],
  NOTE: ["QUALIFIED", "UNQUALIFIED", "NOTE"],
};

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex").slice(0, 32);
const mutationKey = (prefix: string, supplied?: string | null) =>
  `${prefix}:${(supplied ?? "").trim() || randomUUID()}`;
const activityId = (customerId: string, mutationId: string) =>
  `leadact-${digest(`${customerId}:${mutationId}`)}`;

type ActivityInput = {
  customerId: string;
  channel: string;
  direction?: string | null;
  outcome: string;
  note?: string | null;
  actor: LeadActor;
  mutationId?: string;
};

/** Append-or-confirm one immutable activity. A retry with the same mutation id
 * adopts the original row; a mismatched replay is refused. */
export async function appendLeadActivity(input: ActivityInput) {
  const client = await dataClient();
  if (!("LeadActivity" in client.models)) throw new Error("Lead history is unavailable.");
  const mutationId = input.mutationId ?? randomUUID();
  const id = activityId(input.customerId, mutationId);
  const existing = await client.models.LeadActivity.get({ id });
  if (existing.errors?.length) throw new Error(existing.errors.map((e) => e.message).join("; "));
  if (existing.data) {
    if (
      existing.data.customerId !== input.customerId ||
      existing.data.channel !== input.channel ||
      existing.data.outcome !== input.outcome ||
      (existing.data.actorSub ?? null) !== (input.actor.sub ?? null) ||
      existing.data.actorEmail !== (input.actor.email ?? "system@pestbuzzkill.com")
    ) {
      throw new Error("That action key was already used for a different lead action.");
    }
    return existing.data;
  }
  const result = await client.models.LeadActivity.create({
    id,
    customerId: input.customerId,
    channel: input.channel,
    direction: input.direction ?? "OUTBOUND",
    actorSub: input.actor.sub ?? undefined,
    actorEmail: input.actor.email ?? "system@pestbuzzkill.com",
    outcome: input.outcome,
    note: input.note ?? undefined,
    occurredAt: new Date().toISOString(),
    mutationId,
  });
  if (!result.data) {
    const raced = await client.models.LeadActivity.get({ id });
    if (raced.data) return raced.data;
    throw new Error(result.errors?.map((e) => e.message).join("; ") || "Lead activity was not saved.");
  }
  return result.data;
}

async function openLeadRecovery(input: {
  dedupeKey: string;
  customerId?: string | null;
  title: string;
  detail: string;
}) {
  const dueAt = (await oneBusinessDayDueAt(new Date())).toISOString();
  return openOwnedWork({
    kind: "LEAD_LIFECYCLE_RECOVERY",
    dedupeKey: input.dedupeKey,
    title: input.title,
    detail: input.detail,
    customerId: input.customerId,
    relatedId: input.customerId ?? input.dedupeKey,
    sourceUrl: input.customerId ? `/customers/${input.customerId}` : "/work",
    resolutionAction:
      "Run the single safe action shown on the lead again. It is idempotent; then confirm the requested state, activity, owner, and next action all agree.",
    ownerTeam: "SALES",
    dueAt,
  });
}

async function ensureFollowup(input: {
  id: string;
  displayName: string;
  nextAction: string;
  dueAt: string;
  ownerSub?: string | null;
  ownerEmail?: string | null;
}) {
  const title = `${input.nextAction}: ${input.displayName}`;
  const detail = `Current action: ${input.nextAction}. Due ${input.dueAt}. Record the controlled outcome; an attempt is not a reached customer.`;
  const id = await openOwnedWork({
    kind: "LEAD_FOLLOWUP",
    dedupeKey: input.id,
    title,
    detail,
    customerId: input.id,
    relatedId: input.id,
    sourceUrl: `/customers/${input.id}`,
    resolutionAction:
      "Open the lead and record the one current action with its actual outcome. The system replaces the next obligation automatically.",
    ownerTeam: "SALES",
    ownerSub: input.ownerSub,
    ownerEmail: input.ownerEmail ?? undefined,
    dueAt: input.dueAt,
  });
  if (!id) throw new Error("The lead follow-up could not be placed in shared Office work.");
  // openOwnedWork intentionally preserves an already-open item's original SLA
  // for ordinary recurrences. A lead action is different: it REPLACES the
  // obligation, so its title/deadline/escalation must move together.
  const client = await dataClient();
  const synced = await client.models.WorkItem.update({
    id,
    title,
    detail,
    dueAt: input.dueAt,
    escalatedAt: null,
  });
  if (
    !synced.data ||
    synced.data.dueAt !== input.dueAt ||
    synced.data.title !== title
  ) {
    throw new Error("The current lead obligation could not be durably synchronized.");
  }
  return id;
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
  idempotencyKey?: string | null;
  contactConsentChannels?: string[] | null;
  contactConsentSource?: string | null;
  contactConsentText?: string | null;
  contactConsentPolicyVersion?: string | null;
};
export type CreateLeadResult =
  | { decision: "DUPLICATE"; candidates: LeadCandidate[] }
  | { decision: "CREATED"; id: string };

export async function createLead(args: CreateLeadArgs, actor: LeadActor): Promise<CreateLeadResult> {
  const displayName = (args.displayName ?? "").trim();
  if (!displayName) throw new Error("A name is required to create a lead.");
  const email = normalizeEmail(args.email);
  const phone = normalizePhone(args.phone);
  const channels = [...new Set(args.contactConsentChannels ?? [])];
  if (channels.some((channel) => !["EMAIL", "CALL"].includes(channel))) {
    throw new Error("Only retained email or call permission can enable outreach; text is not approved.");
  }
  if (
    channels.length &&
    (!(args.contactConsentSource ?? "").trim() ||
      !(args.contactConsentText ?? "").trim() ||
      !(args.contactConsentPolicyVersion ?? "").trim())
  ) {
    throw new Error("Retained consent requires its source, evidence, and policy version.");
  }
  const callerKey = (args.idempotencyKey ?? "").trim();
  const identityKey = [email, phone, normalizeName(displayName), normalizeZip(args.serviceZip)]
    .filter(Boolean)
    .join("|");
  const intakeKey = callerKey || identityKey;
  if (!intakeKey) throw new Error("An intake id is required when the lead has no usable identity.");
  const leadId = `lead-${digest(intakeKey)}`;
  const claim = await acquireLeadIntakeClaim(identityKey || intakeKey);
  if (!claim.won) throw new Error("This lead intake is already being checked. Retry the same submission.");
  let createdId: string | null = null;
  try {
    const client = await dataClient();
    const prior = await client.models.Customer.get({ id: leadId });
    const candidates = await findLeadDuplicates({
      email,
      phone,
      name: displayName,
      zip: args.serviceZip,
      excludeId: leadId,
    });
    if (!prior.data && candidates.length && !args.force) {
      return { decision: "DUPLICATE", candidates };
    }
    const now = new Date();
    const proposedDueAt = (await oneBusinessDayDueAt(now)).toISOString();
    const proposedNextAction = candidates.length
      ? "Resolve duplicate identity decision"
      : email || phone
        ? "Make first response"
        : "Obtain a usable contact method";
    let lead = prior.data;
    if (!lead) {
      const result = await client.models.Customer.create({
        id: leadId,
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
        leadOwnerSub: actor.sub ?? undefined,
        leadOwnerEmail: actor.email ?? defaultWorkOwner("SALES"),
        leadOwnerTeam: "SALES",
        nextAction: proposedNextAction,
        nextActionAt: proposedDueAt,
        contactConsent: channels.includes("CALL"),
        contactConsentAt: channels.length ? now.toISOString() : undefined,
        contactConsentChannels: channels,
        contactConsentSource: args.contactConsentSource?.trim() || undefined,
        contactConsentText: args.contactConsentText?.trim() || undefined,
        contactConsentPolicyVersion: args.contactConsentPolicyVersion?.trim() || undefined,
      });
      lead = result.data;
      if (!lead) throw new Error(result.errors?.map((e) => e.message).join("; ") || "Could not create the lead.");
    }
    const nextAction = lead.nextAction ?? proposedNextAction;
    const dueAt = lead.nextActionAt ?? proposedDueAt;
    createdId = lead.id;
    await appendLeadActivity({
      customerId: lead.id,
      channel: "LIFECYCLE",
      outcome: "NOTE",
      note: `Lead intake accepted from ${args.leadSource?.trim() || "staff/API"}.`,
      actor,
      mutationId: `intake:${intakeKey}`,
    });
    if (!email && !phone) {
      const missing = await openMissingContactWork({
        customerId: lead.id,
        displayName,
        context: "A lead was created with no usable email or phone.",
      });
      if (!missing) throw new Error("The missing-contact decision could not be owned.");
    }
    if (candidates.length) {
      const dupe = await openOwnedWork({
        kind: "DUPLICATE_LEAD",
        dedupeKey: lead.id,
        title: `Resolve possible duplicate: ${displayName}`,
        detail: `This intake matches ${candidates.map((c) => `${c.displayName} (${c.matchedOn})`).join(", ")}. It was kept separate; decide whether the people are distinct before outreach.`,
        customerId: lead.id,
        relatedId: lead.id,
        sourceUrl: `/customers/${lead.id}`,
        resolutionAction:
          "Compare the controlled match reasons. Confirm separate people or retain one record and cross-reference the decision.",
        ownerTeam: "SALES",
        dueAt,
      });
      if (!dupe) throw new Error("The duplicate identity decision could not be owned.");
    }
    await ensureFollowup({
      id: lead.id,
      displayName,
      nextAction,
      dueAt,
      ownerSub: lead.leadOwnerSub,
      ownerEmail: lead.leadOwnerEmail,
    });
    const verified = await client.models.Customer.get({ id: lead.id });
    if (
      !verified.data ||
      verified.data.status !== "LEAD" ||
      verified.data.leadOwnerTeam !== "SALES" ||
      verified.data.nextAction !== nextAction ||
      verified.data.nextActionAt !== dueAt ||
      !verified.data.leadOwnerEmail
    ) {
      throw new Error("The lead intake could not be verified end to end.");
    }
    const verifiedWork = await client.models.WorkItem.get({
      id: workItemId("LEAD_FOLLOWUP", lead.id),
    });
    if (
      verifiedWork.data?.status !== "OPEN" ||
      verifiedWork.data.dueAt !== dueAt
    ) {
      throw new Error("The lead's current Office obligation could not be confirmed.");
    }
    await resolveOwnedWork({
      kind: "LEAD_LIFECYCLE_RECOVERY",
      dedupeKey: `intake:${intakeKey}`,
      note: "The idempotent intake was re-run and every required fact was verified.",
    });
    return { decision: "CREATED", id: lead.id };
  } catch (error) {
    await openLeadRecovery({
      dedupeKey: `intake:${intakeKey}`,
      customerId: createdId,
      title: `Lead intake needs recovery: ${displayName}`,
      detail: `The intake did not verify every required record: ${error instanceof Error ? error.message : String(error)}`,
    });
    throw error;
  } finally {
    await releaseLeadIntakeClaim(identityKey || intakeKey, claim.holder);
  }
}

export async function assertLeadOutreachAllowed(customer: Record<string, unknown>, channel: string) {
  if (channel === "NOTE") return;
  if (customer.doNotContact) throw new Error("Do-not-contact blocks this outreach.");
  if (["CALL", "TEXT", "EMAIL", "BOOKING_LINK"].includes(channel)) {
    const allowed = Array.isArray(customer.contactConsentChannels)
      ? customer.contactConsentChannels
      : [];
    const permission = channel === "BOOKING_LINK" ? "EMAIL" : channel;
    if (!allowed.includes(permission)) {
      const label = permission === "CALL" ? "Call" : permission === "TEXT" ? "Text" : "Email";
      throw new Error(`${label} permission is not retained for this lead.`);
    }
  }
  if ((channel === "EMAIL" || channel === "BOOKING_LINK") && customer.email) {
    const client = await dataClient();
    if (!("SuppressedEmail" in client.models)) throw new Error("Suppression status is unreadable; outreach is blocked.");
    const result = await client.models.SuppressedEmail.get({ email: String(customer.email).toLowerCase() });
    if (result.errors?.length) throw new Error("Suppression status is unreadable; outreach is blocked.");
    if (result.data) throw new Error("This email is suppressed; outreach is blocked.");
  }
}

export async function logLeadTouch(
  args: {
    customerId: string;
    channel: string;
    direction?: string | null;
    outcome: string;
    note?: string | null;
    idempotencyKey?: string;
  },
  actor: LeadActor
): Promise<{ ok: true; nextAction: string; nextActionAt: string }> {
  // The stable identity is the token's `sub`; `email` is not carried by the
  // Cognito access token Amplify sends (only the id token has it), so it may be
  // null for a UUID-username login (e.g. the hand-provisioned owner). The body
  // already falls back on a missing email — leadOwnerEmail defaults to the sales
  // work owner and activity rows to a system actor — so `sub` is all this guard
  // needs. (createLead never guarded email at all, for the same reason.)
  if (!actor.sub) throw new Error("A staffed Office actor is required.");
  if (!(LEAD_TOUCH_CHANNELS as readonly string[]).includes(args.channel)) throw new Error("Unknown contact channel.");
  if (!(LEAD_TOUCH_OUTCOMES as readonly string[]).includes(args.outcome)) throw new Error("Pick what actually happened on this touch.");
  if (!OUTCOMES_BY_CHANNEL[args.channel]?.includes(args.outcome)) {
    throw new Error("That outcome does not describe the selected contact channel.");
  }
  const mutationId = mutationKey("touch", args.idempotencyKey);
  const claim = await acquireLeadLifecycleClaim(args.customerId, mutationId);
  if (!claim.won) throw new Error("Another lead action is in progress. Retry this same action.");
  try {
    const client = await dataClient();
    const read = await client.models.Customer.get({ id: args.customerId });
    if (read.errors?.length || !read.data) throw new Error("The lead could not be read; outreach is blocked.");
    if (read.data.status !== "LEAD") throw new Error("Only an open lead can be worked here.");
    if (read.data.leadMutationId === mutationId) {
      await appendLeadActivity({ ...args, actor, mutationId });
      if (!read.data.nextAction || !read.data.nextActionAt || !read.data.leadOwnerEmail) {
        throw new Error("The prior lead action is incomplete; recovery is required.");
      }
      await ensureFollowup({
        id: args.customerId,
        displayName: read.data.displayName,
        nextAction: read.data.nextAction,
        dueAt: read.data.nextActionAt,
        ownerSub: read.data.leadOwnerSub,
        ownerEmail: read.data.leadOwnerEmail,
      });
      await resolveOwnedWork({
        kind: "LEAD_LIFECYCLE_RECOVERY",
        dedupeKey: mutationId,
        note: "Idempotent lead action re-confirmed.",
      });
      return {
        ok: true,
        nextAction: read.data.nextAction,
        nextActionAt: read.data.nextActionAt,
      };
    }
    await assertLeadOutreachAllowed(read.data as unknown as Record<string, unknown>, args.channel);
    await appendLeadActivity({ ...args, actor, mutationId });
    const now = new Date();
    const dueAt = (await oneBusinessDayDueAt(now)).toISOString();
    const attempted = !["NOTE", "QUALIFIED", "UNQUALIFIED"].includes(args.outcome);
    const reached = ["REACHED", "DELIVERED"].includes(args.outcome);
    const nextAction = args.outcome === "QUALIFIED"
      ? "Deliver the lead-specific booking link"
      : args.outcome === "UNQUALIFIED"
        ? "Choose the controlled lost outcome"
        : "Complete the next follow-up";
    const updated = await client.models.Customer.update({
      id: args.customerId,
      ...(attempted ? { lastAttemptedAt: now.toISOString(), lastTouchedAt: now.toISOString() } : {}),
      ...(reached ? { lastReachedAt: now.toISOString() } : {}),
      ...(args.outcome === "QUALIFIED" || args.outcome === "UNQUALIFIED"
        ? { qualificationStatus: args.outcome }
        : {}),
      ...(args.channel === "BOOKING_LINK" && args.outcome === "DELIVERED"
        ? { bookingLinkDeliveredAt: now.toISOString() }
        : {}),
      nextAction,
      nextActionAt: dueAt,
      leadOwnerTeam: "SALES",
      leadOwnerEmail: read.data.leadOwnerEmail ?? defaultWorkOwner("SALES"),
      leadMutationId: mutationId,
    });
    if (!updated.data) throw new Error("The requested lead state was not saved.");
    await ensureFollowup({
      id: args.customerId,
      displayName: updated.data.displayName,
      nextAction,
      dueAt,
      ownerSub: updated.data.leadOwnerSub,
      ownerEmail: updated.data.leadOwnerEmail,
    });
    const verify = await client.models.Customer.get({ id: args.customerId });
    if (
      !verify.data ||
      verify.data.nextAction !== nextAction ||
      verify.data.nextActionAt !== dueAt ||
      verify.data.leadOwnerTeam !== "SALES" ||
      !verify.data.leadOwnerEmail ||
      verify.data.leadMutationId !== mutationId
    ) {
      throw new Error("The lead action could not be durably confirmed.");
    }
    await resolveOwnedWork({ kind: "LEAD_LIFECYCLE_RECOVERY", dedupeKey: mutationId, note: "Lead action verified." });
    return { ok: true, nextAction, nextActionAt: dueAt };
  } catch (error) {
    await openLeadRecovery({
      dedupeKey: mutationId,
      customerId: args.customerId,
      title: "Lead action needs recovery",
      detail: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    await releaseLeadLifecycleClaim(args.customerId, claim.holder);
  }
}

/**
 * The public funnel, not a CSR, advances an identified lead after the quote
 * form is actually submitted. This deliberately records a NOTE rather than a
 * reached customer: staff may be filling the form on the lead's behalf. The
 * existing lifecycle contract supplies the immutable activity, one-business-
 * day next action, synchronized shared work, idempotency, and recovery.
 *
 * A lifecycle fault must not strand a customer after their BookingRequest was
 * saved, so logLeadTouch's recovery item is authoritative and this wrapper
 * returns false instead of turning a valid quote into a retry/duplicate loop.
 */
export async function recordWebsiteQuoteRequested(input: {
  customerId: string;
  bookingRequestId: string;
}): Promise<boolean> {
  try {
    await logLeadTouch(
      {
        customerId: input.customerId,
        channel: "NOTE",
        direction: "INBOUND",
        outcome: "NOTE",
        note: `Public quote form submitted (booking request ${input.bookingRequestId}).`,
        idempotencyKey: `website-quote:${input.bookingRequestId}`,
      },
      { sub: "booking-public", email: "system@pestbuzzkill.com" }
    );
    return true;
  } catch (error) {
    console.error(
      "recordWebsiteQuoteRequested: lifecycle recovery owns the saved quote",
      input.bookingRequestId,
      error
    );
    return false;
  }
}

/**
 * A public quote is a lead the moment it is requested. When a visitor reaches
 * the funnel without an office booking link (no pre-resolved leadCustomerId),
 * this durably captures them as a CRM lead — a priced quote they never book is
 * still someone the office should chase. It returns the lead id so the caller
 * can stamp it onto the BookingRequest; a later paid finalization then converts
 * this exact record instead of minting a second customer.
 *
 * Consent mirrors lead-intake: the funnel always holds a valid email, so email
 * response is retained; a call is retained only when the visitor ticked the
 * GL-03 call-consent box. The server-owned wording is authoritative — a caller
 * never supplies the evidence text that later authorizes outreach.
 *
 * A lead-creation fault must never withhold the quote (the durable
 * BookingRequest still holds the contact for a hand recovery, and createLead's
 * own recovery item owns the miss), so this swallows failure and returns null.
 */
export async function recordWebsiteQuoteLead(input: {
  name: string;
  email: string;
  phone?: string | null;
  street?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  callConsent: boolean;
  leadSource: string;
  notes?: string | null;
}): Promise<string | null> {
  try {
    const result = await createLead(
      {
        displayName: input.name,
        email: input.email,
        phone: input.phone ?? undefined,
        serviceStreet: input.street ?? undefined,
        serviceCity: input.city ?? undefined,
        serviceState: input.state ?? undefined,
        serviceZip: input.zip ?? undefined,
        leadSource: input.leadSource,
        notes: input.notes ?? undefined,
        // The visitor never merges records on the Office's behalf: keep the
        // submission and let the controlled duplicate decision resolve identity.
        force: true,
        contactConsentChannels: [
          "EMAIL",
          ...(input.callConsent ? ["CALL"] : []),
        ],
        contactConsentSource: "website-quote",
        contactConsentText: input.callConsent
          ? CALL_CONSENT_TEXT
          : "Customer supplied an email address in a direct quote request and requested an email response; no call or text permission was granted.",
        contactConsentPolicyVersion: input.callConsent
          ? CALL_CONSENT_TEXT_VERSION
          : "website-email-response-2026-07-20.1",
      },
      { sub: null, email: null }
    );
    return result.decision === "CREATED" ? result.id : null;
  } catch (error) {
    console.error(
      "recordWebsiteQuoteLead: createLead's recovery owns the miss",
      error
    );
    return null;
  }
}

async function followupIsClosed(customerId: string): Promise<boolean> {
  const client = await dataClient();
  if (!("WorkItem" in client.models)) return false;
  const { data } = await client.models.WorkItem.get({ id: workItemId("LEAD_FOLLOWUP", customerId) });
  return !data || data.status === "RESOLVED";
}

export async function setLeadDisposition(
  args: {
    customerId: string;
    disposition: string;
    reasonCode?: string | null;
    note?: string | null;
    idempotencyKey?: string;
  },
  actor: LeadActor
): Promise<{ ok: true; disposition: string }> {
  // `sub` is the stable identity; email may be absent (see logLeadTouch). Each
  // disposition path already tolerates a null email: doNotContactBy falls back
  // to the sub, the DNC-clear audit to "unknown owner", and activity rows to a
  // system actor.
  if (!actor.sub) throw new Error("A staffed Office actor is required.");
  const mutationId = mutationKey("disposition", args.idempotencyKey);
  const claim = await acquireLeadLifecycleClaim(args.customerId, mutationId);
  if (!claim.won) throw new Error("Another lead action is in progress. Retry this same action.");
  try {
    const client = await dataClient();
    const prior = await client.models.Customer.get({ id: args.customerId });
    if (!prior.data || prior.data.status !== "LEAD") throw new Error("Open lead not found.");
    const nowIso = new Date().toISOString();
    let patch: Record<string, unknown>;
    let activityNote: string;
    if (args.disposition === "LOST") {
      const reason = (args.reasonCode ?? "").trim();
      if (!(LEAD_LOST_REASONS as readonly string[]).includes(reason)) throw new Error("Choose a controlled reason for marking this lead lost.");
      patch = { lostReason: reason, lostAt: nowIso, nextAction: null, nextActionAt: null };
      activityNote = `Marked LOST (${reason})${args.note ? `: ${args.note}` : ""}.`;
    } else if (args.disposition === "DNC") {
      patch = {
        doNotContact: true,
        doNotContactAt: nowIso,
        doNotContactBy: actor.email ?? actor.sub ?? "unknown staff",
        nextAction: null,
        nextActionAt: null,
      };
      activityNote = `Set DO-NOT-CONTACT${args.note ? `: ${args.note}` : ""}.`;
    } else if (args.disposition === "CLEAR") {
      if (prior.data.doNotContact) {
        if (!actor.isOwner) throw new Error("Owner role required to clear do-not-contact.");
        if (!(SUPPRESSION_RELEASE_REASONS as readonly string[]).includes((args.reasonCode ?? "").trim())) {
          throw new Error("Choose the controlled suppression-release reason.");
        }
        if (!(args.note ?? "").trim()) throw new Error("Retained evidence is required to clear do-not-contact.");
        const audit = await client.models.ConsentAudit.create({
          id: `consent-${digest(mutationId)}`,
          subjectKey: args.customerId,
          action: "DNC_CLEARED",
          channel: "ALL_NONESSENTIAL",
          reasonCode: args.reasonCode!.trim(),
          evidence: args.note!.trim(),
          actorSub: actor.sub ?? undefined,
          actorEmail: actor.email ?? "unknown owner",
          occurredAt: nowIso,
        });
        if (!audit.data) throw new Error("The suppression-release audit could not be saved; nothing was cleared.");
      }
      const dueAt = (await oneBusinessDayDueAt(new Date())).toISOString();
      patch = {
        lostReason: null,
        lostAt: null,
        doNotContact: false,
        doNotContactAt: null,
        doNotContactBy: null,
        nextAction: "Make first response",
        nextActionAt: dueAt,
      };
      activityNote = `Reopened with ${args.reasonCode ?? "lost decision cleared"}${args.note ? `: ${args.note}` : ""}.`;
    } else throw new Error("Unknown lead disposition — use LOST, DNC, or CLEAR.");

    await appendLeadActivity({
      customerId: args.customerId,
      channel: "LIFECYCLE",
      outcome: "NOTE",
      note: activityNote,
      actor,
      mutationId,
    });
    const alreadyApplied = prior.data.leadMutationId === mutationId;
    const updated = alreadyApplied
      ? { data: prior.data }
      : await client.models.Customer.update({
          id: args.customerId,
          ...patch,
          leadOwnerTeam: "SALES",
          leadOwnerEmail: prior.data.leadOwnerEmail ?? defaultWorkOwner("SALES"),
          leadMutationId: mutationId,
        });
    if (!updated.data) throw new Error("The requested disposition was not saved.");
    if (args.disposition === "CLEAR") {
      await ensureFollowup({
        id: args.customerId,
        displayName: updated.data.displayName,
        nextAction: String(updated.data.nextAction),
        dueAt: String(updated.data.nextActionAt),
        ownerSub: updated.data.leadOwnerSub,
        ownerEmail: updated.data.leadOwnerEmail,
      });
    } else {
      await resolveOwnedWork({ kind: "LEAD_FOLLOWUP", dedupeKey: args.customerId, note: `Lead disposition: ${args.disposition}.` });
      if (!(await followupIsClosed(args.customerId))) throw new Error("The prior follow-up is still open.");
    }
    const verify = await client.models.Customer.get({ id: args.customerId });
    const stateVerified =
      verify.data?.leadOwnerTeam === "SALES" &&
      Boolean(verify.data.leadOwnerEmail) &&
      verify.data.leadMutationId === mutationId &&
      (args.disposition === "LOST"
        ? verify.data.lostReason === args.reasonCode
        : args.disposition === "DNC"
          ? verify.data.doNotContact === true
          : verify.data.doNotContact !== true && !verify.data.lostReason);
    if (!stateVerified) throw new Error("The requested disposition could not be confirmed.");
    await resolveOwnedWork({ kind: "LEAD_LIFECYCLE_RECOVERY", dedupeKey: mutationId, note: "Lead disposition verified." });
    return { ok: true, disposition: args.disposition };
  } catch (error) {
    await openLeadRecovery({ dedupeKey: mutationId, customerId: args.customerId, title: "Lead disposition needs recovery", detail: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    await releaseLeadLifecycleClaim(args.customerId, claim.holder);
  }
}

export async function assignLeadOwner(
  args: { customerId: string; toSub?: string | null; toEmail?: string | null; idempotencyKey?: string },
  actor: LeadActor
): Promise<{ ok: true; ownerEmail: string | null }> {
  if (!actor.sub || !actor.email) throw new Error("A staffed Office identity is required.");
  if ((args.toSub && args.toSub !== actor.sub) || (args.toEmail && args.toEmail !== actor.email)) {
    throw new Error("Use Assign to me. Named reassignment must use the staffed roster handoff.");
  }
  const mutationId = mutationKey("owner", args.idempotencyKey);
  const claim = await acquireLeadLifecycleClaim(args.customerId, mutationId);
  if (!claim.won) throw new Error("Another lead action is in progress. Retry this same action.");
  try {
    const client = await dataClient();
    const prior = await client.models.Customer.get({ id: args.customerId });
    if (!prior.data || prior.data.status !== "LEAD") throw new Error("Open lead not found.");
    await appendLeadActivity({ customerId: args.customerId, channel: "LIFECYCLE", outcome: "NOTE", note: `Assigned to ${actor.email}.`, actor, mutationId });
    const alreadyApplied = prior.data.leadMutationId === mutationId;
    const updated = alreadyApplied
      ? { data: prior.data }
      : await client.models.Customer.update({
          id: args.customerId,
          leadOwnerSub: actor.sub,
          leadOwnerEmail: actor.email,
          leadOwnerTeam: "SALES",
          leadMutationId: mutationId,
        });
    if (!updated.data) throw new Error("Ownership was not saved.");
    const followupId = workItemId("LEAD_FOLLOWUP", args.customerId);
    const currentWork = await client.models.WorkItem.get({ id: followupId });
    if (!alreadyApplied && currentWork.data?.status === "OPEN") {
      const ownerCondition = prior.data.leadOwnerSub
        ? [{ kind: "fieldEquals" as const, field: "ownerSub", value: prior.data.leadOwnerSub }]
        : [{ kind: "fieldMissingOrNull" as const, field: "ownerSub" }];
      const moved = await casGuardedUpdate(
        "WorkItem",
        followupId,
        { ownerSub: actor.sub, ownerEmail: actor.email },
        ownerCondition
      );
      if (!moved.ok) {
        throw new Error("The follow-up was claimed after assignment began; no newer owner was overwritten.");
      }
    }
    if (updated.data.nextAction && updated.data.nextActionAt) {
      await ensureFollowup({ id: args.customerId, displayName: updated.data.displayName, nextAction: updated.data.nextAction, dueAt: updated.data.nextActionAt, ownerSub: actor.sub, ownerEmail: actor.email });
    }
    const verify = await client.models.Customer.get({ id: args.customerId });
    if (
      verify.data?.leadOwnerSub !== actor.sub ||
      verify.data.leadMutationId !== mutationId
    ) throw new Error("Ownership could not be confirmed.");
    const verifyWork = await client.models.WorkItem.get({ id: followupId });
    if (verifyWork.data?.status === "OPEN" && verifyWork.data.ownerSub !== actor.sub) {
      throw new Error("The lead and its current follow-up do not have the same owner.");
    }
    return { ok: true, ownerEmail: actor.email };
  } catch (error) {
    await openLeadRecovery({ dedupeKey: mutationId, customerId: args.customerId, title: "Lead ownership needs recovery", detail: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    await releaseLeadLifecycleClaim(args.customerId, claim.holder);
  }
}

export async function reassignLeadsForSub(input: { sub: string; actorEmail?: string | null }): Promise<{ reassigned: number; failed: number }> {
  let reassigned = 0;
  let failed = 0;
  if (!input.sub) return { reassigned, failed };
  const client = await dataClient();
  let token: string | null | undefined;
  do {
    const page = await client.models.Customer.listCustomerByStatusAndDisplayName(
      { status: "LEAD" },
      { limit: 200, nextToken: token }
    );
    if (page.errors?.length) throw new Error(page.errors.map((e) => e.message).join("; "));
    for (const lead of page.data ?? []) {
      if (lead.leadOwnerSub !== input.sub) continue;
      const mutationId = `offboard:${input.sub}:${lead.id}`;
      const claim = await acquireLeadLifecycleClaim(lead.id, mutationId);
      if (!claim.won) { failed++; continue; }
      try {
        await appendLeadActivity({
          customerId: lead.id,
          channel: "LIFECYCLE",
          outcome: "NOTE",
          note: "Lead owner was offboarded — current lead and follow-up returned together to Sales.",
          actor: { sub: null, email: input.actorEmail ?? "system@pestbuzzkill.com" },
          mutationId,
        });
        const moved = await casGuardedUpdate(
          "Customer",
          lead.id,
          { leadOwnerSub: null, leadOwnerEmail: defaultWorkOwner("SALES"), leadOwnerTeam: "SALES" },
          [{ kind: "fieldEquals", field: "leadOwnerSub", value: input.sub }]
        );
        if (!moved.ok) throw new Error("The owner changed after handoff began; no assignment was overwritten.");
        const followupId = workItemId("LEAD_FOLLOWUP", lead.id);
        const work = await client.models.WorkItem.get({ id: followupId });
        if (work.data?.status === "OPEN" && work.data.ownerSub === input.sub) {
          const transferred = await casGuardedUpdate(
            "WorkItem",
            followupId,
            { ownerSub: null, ownerEmail: defaultWorkOwner("SALES") },
            [{ kind: "fieldEquals", field: "ownerSub", value: input.sub }]
          );
          if (!transferred.ok) throw new Error("The follow-up owner changed during handoff; verify the staffed destination.");
        }
        const verify = await client.models.Customer.get({ id: lead.id });
        if (verify.data?.leadOwnerSub) throw new Error("The Sales-team handoff could not be confirmed.");
        reassigned++;
      } catch (error) {
        failed++;
        await openLeadRecovery({ dedupeKey: mutationId, customerId: lead.id, title: `Lead handoff needs recovery: ${lead.displayName}`, detail: error instanceof Error ? error.message : String(error) });
      } finally {
        await releaseLeadLifecycleClaim(lead.id, claim.holder);
      }
    }
    token = page.nextToken;
  } while (token);
  return { reassigned, failed };
}
