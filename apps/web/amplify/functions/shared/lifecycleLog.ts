import { dataClient } from "./dataClient";

/**
 * The customer lifecycle audit trail (GL-09).
 *
 * A deactivation or reactivation moves money, service, access and status all at
 * once, and leadership must be able to answer "who did this, when, why, and
 * what did it touch" without engineering pulling logs. That history lives in the
 * append-only CustomerLifecycleEvent model — one immutable row per transition,
 * browser-read-only for OWNER/OFFICE/FINANCE, written only here from a Lambda.
 *
 * Best-effort on purpose: the transition's real effects (subscriptions canceled,
 * visits swept, portal login toggled, Customer.status flipped) are already
 * durably applied and idempotent by the time we get here. Failing the whole
 * operation because the audit row didn't write — and thereby inviting a re-run
 * that double-applies or double-logs — is worse than a loudly-logged miss. So a
 * write failure is surfaced to the function logs, not thrown.
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
}): Promise<void> {
  try {
    const client = await dataClient();
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
      occurredAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error(
      `Failed to record customer lifecycle event (${input.action} on ${input.customerId}) — the transition itself was applied; the audit row was not`,
      err
    );
  }
}
