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
export async function acquireLifecycleClaim(
  customerId: string,
  action: LifecycleAction
): Promise<boolean> {
  const client = await dataClient();
  const { data } = await client.models.CustomerLifecycleClaim.create({
    id: customerId,
    action,
    requestedAt: new Date().toISOString(),
  });
  // A conditional-create conflict (a claim already exists) returns data: null,
  // not a throw — exactly like PlanCancellationClaim. Any other failure also
  // returns null here, and treating that as "not acquired" is the safe default:
  // the caller reports in-flight instead of racing a transition.
  return Boolean(data);
}

/** Release the lock. Idempotent and swallows its own failure — a lingering
 *  claim only delays the next transition; it never corrupts state. */
export async function releaseLifecycleClaim(customerId: string): Promise<void> {
  const client = await dataClient();
  await client.models.CustomerLifecycleClaim.delete({ id: customerId }).catch(
    () => undefined
  );
}
