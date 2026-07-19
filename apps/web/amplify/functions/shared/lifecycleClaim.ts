import { dataClient } from "./dataClient";
import type { LifecycleAction } from "./lifecycleLog";

/**
 * GL-09 — the single-winner lock over a customer's lifecycle transitions.
 *
 * `create` on CustomerLifecycleClaim is conditional on the id (= customerId) not
 * already existing, so at most one deactivate/reactivate can be in flight for a
 * given customer at a time. A racing second request — a duplicate deactivate, or
 * a reactivate landing mid-deactivation — loses the create and is told to report
 * the current state rather than drive a second, interleaving transition that
 * could leave INACTIVE-with-live-portal or ACTIVE-with-dead-login (GL-09 R5).
 *
 * The winner deletes the claim on any terminal result (clean, partial, or a
 * handled failure) so the next legitimate transition can proceed. Mirrors the
 * PlanCancellationClaim pattern used for plan cancellation.
 */
/** How long one transition attempt may hold the per-customer claim. Generous
 *  versus the Lambda timeout; a crashed holder is reclaimable after this. */
const CLAIM_LEASE_MS = 5 * 60_000;

export async function acquireLifecycleClaim(
  customerId: string,
  action: LifecycleAction
): Promise<boolean> {
  const client = await dataClient();
  const attempt = async () => {
    const { data } = await client.models.CustomerLifecycleClaim.create({
      id: customerId,
      action,
      requestedAt: new Date().toISOString(),
      leaseUntil: new Date(Date.now() + CLAIM_LEASE_MS).toISOString(),
    });
    return Boolean(data);
  };
  // A conditional-create conflict (a claim already exists) returns data: null,
  // not a throw — exactly like PlanCancellationClaim. Any other failure also
  // returns null here, and treating that as "not acquired" is the safe default:
  // the caller reports in-flight instead of racing a transition.
  if (await attempt()) return true;
  // GL-09: a claim whose lease expired belongs to a crashed process — it may
  // no longer block this customer's transitions forever. Reclaim it (the
  // conditional re-create keeps exactly one winner).
  const { data: held } = await client.models.CustomerLifecycleClaim.get({
    id: customerId,
  });
  // Lease expiry: an explicit lease wins; a legacy row (pre-lease) expires
  // CLAIM_LEASE_MS after its requestedAt; an unreadable row is assumed LIVE —
  // the safe default is to report in-flight, never to race a winner.
  const expiresAt = held?.leaseUntil
    ? Date.parse(held.leaseUntil)
    : held?.requestedAt
      ? Date.parse(held.requestedAt) + CLAIM_LEASE_MS
      : Date.now() + CLAIM_LEASE_MS;
  if (expiresAt > Date.now()) {
    return false;
  }
  await client.models.CustomerLifecycleClaim.delete({ id: customerId }).catch(
    () => undefined
  );
  return attempt();
}

/** Release the lock. Idempotent and swallows its own failure — a lingering
 *  claim only delays the next transition; it never corrupts state. */
export async function releaseLifecycleClaim(customerId: string): Promise<void> {
  const client = await dataClient();
  await client.models.CustomerLifecycleClaim.delete({ id: customerId }).catch(
    () => undefined
  );
}
