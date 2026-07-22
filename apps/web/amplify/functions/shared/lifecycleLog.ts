import { dataClient } from "./dataClient";
import { LIFECYCLE_POLICY_VERSION } from "./lifecycleReasons";
import { openOwnedWork } from "./ownedWork";

/**
 * The customer lifecycle audit trail (GL-09).
 *
 * A deactivation or reactivation moves money, service, access and status all at
 * once, and leadership must be able to answer "who did this, when, why, and
 * what did it touch" without engineering pulling logs. That history lives in the
 * append-only CustomerLifecycleEvent model — one immutable row per transition,
 * browser-read-only for OWNER/OFFICE/FINANCE, written only here from a Lambda.
 *
 * The audit write is NOT swallowed (GL-09 R4). The transition's real effects
 * (subscriptions canceled, visits swept, portal login toggled, Customer.status
 * flipped) are already durably applied and idempotent by the time we get here,
 * so we do not throw and invite a re-run that double-applies. But a lost audit
 * row is a real gap in a record leadership relies on, so a write failure opens a
 * blocking LIFECYCLE_RECOVERY owned-work item instead of only logging: the
 * transition stands, and the missing history is now owned, visible, and owed a
 * fix — never silently gone. The return value tells the caller whether the row
 * landed so it can reflect the truth in its own result.
 */

export type LifecycleActor = {
  sub: string | null;
  email: string | null;
};

/** DEACTIVATE | REACTIVATE — the named lifecycle transitions this ledger records. */
export type LifecycleAction = "DEACTIVATE" | "REACTIVATE";

export async function recordCustomerLifecycleEvent(input: {
  customerId: string;
  action: LifecycleAction;
  actor: LifecycleActor | null | undefined;
  reason?: string | null;
  priorStatus?: string | null;
  newStatus?: string | null;
  /** Human-readable summary of the money/job/access effects. */
  effects?: string | null;
}): Promise<{ recorded: boolean }> {
  const occurredAt = new Date().toISOString();
  try {
    const client = await dataClient();
    const { data, errors } =
      await client.models.CustomerLifecycleEvent.create({
        customerId: input.customerId,
        action: input.action,
        actorSub: input.actor?.sub ?? undefined,
        // An actor is always expected on a staff-initiated transition; "system"
        // marks the rare path with no verified identity so the row is never blank.
        actorEmail: input.actor?.email ?? "system",
        reason: input.reason ?? undefined,
        priorStatus: input.priorStatus ?? undefined,
        newStatus: input.newStatus ?? undefined,
        effects: input.effects ?? undefined,
        // GL-09 fast-follow: durably record the policy version this action ran
        // under, sourced from the module constant in effect at write time — not
        // free text. Stamped here so every lifecycle write carries it and no
        // caller can forget or pass a stale value.
        policyVersion: LIFECYCLE_POLICY_VERSION,
        occurredAt,
      });
    if (!data) {
      throw new Error(
        errors?.map((e) => e.message).join("; ") || "no row returned"
      );
    }
    return { recorded: true };
  } catch (err) {
    console.error(
      `Failed to record customer lifecycle event (${input.action} on ${input.customerId}) — the transition itself was applied; the audit row was not`,
      err
    );
    // R4: a lost audit write is not swallowed. Open blocking owned recovery so
    // the history gap is visible and owed a fix. Its own failure is only logged
    // — we will not throw away an applied transition over the recovery ticket.
    try {
      await openOwnedWork({
        kind: "LIFECYCLE_RECOVERY",
        dedupeKey: `lifecycle-audit:${input.customerId}`,
        title: `Reconstruct a missing lifecycle audit record: ${input.customerId}`,
        detail: `A ${input.action} on customer ${input.customerId} was applied (${input.priorStatus ?? "?"} → ${input.newStatus ?? "?"}) by ${input.actor?.email ?? "system"} at ${occurredAt}, but the audit row failed to write, so this transition is missing from the leadership history.${input.reason ? ` Reason: ${input.reason}.` : ""}${input.effects ? ` Effects: ${input.effects}` : ""}`,
        customerId: input.customerId,
        relatedId: input.customerId,
        sourceUrl: `/customers/${input.customerId}`,
        resolutionAction:
          "Confirm the customer's access, billing, and status all agree with the intended transition, reconstruct the missing lifecycle audit entry, then close.",
        ownerTeam: "OPS",
      });
    } catch (workErr) {
      console.error(
        `Failed to open LIFECYCLE_RECOVERY work for the lost audit row on ${input.customerId}`,
        workErr
      );
    }
    return { recorded: false };
  }
}
