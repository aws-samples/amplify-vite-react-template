import { randomUUID } from "node:crypto";
import { dataClient } from "./dataClient";
import { casTakeover, casFencedDelete } from "./atomicLock";
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
 * A claim whose lease expired belongs to a crashed process and is seized with
 * ONE atomic conditional update (never delete-then-create, which would let two
 * reclaimers both believe they won). The winner's release is FENCED on its
 * holder nonce, so an expired worker waking up late can never delete a newer
 * holder's lock.
 */
/** How long one transition attempt may hold the per-customer claim. Generous
 *  versus the Lambda timeout; a crashed holder is reclaimable after this. */
const CLAIM_LEASE_MS = 5 * 60_000;

export type LifecycleClaimHandle = { won: true; holder: string } | { won: false };

export async function acquireLifecycleClaim(
  customerId: string,
  action: LifecycleAction
): Promise<LifecycleClaimHandle> {
  const client = await dataClient();
  const holder = randomUUID();
  const attempt = async () => {
    const { data } = await client.models.CustomerLifecycleClaim.create({
      id: customerId,
      action,
      requestedAt: new Date().toISOString(),
      leaseUntil: new Date(Date.now() + CLAIM_LEASE_MS).toISOString(),
      holder,
    });
    return Boolean(data);
  };
  // A conditional-create conflict (a claim already exists) returns data: null,
  // not a throw — exactly like PlanCancellationClaim. Any other failure also
  // returns null here, and treating that as "not acquired" is the safe default:
  // the caller reports in-flight instead of racing a transition.
  if (await attempt()) return { won: true, holder };
  const { data: held } = await client.models.CustomerLifecycleClaim.get({
    id: customerId,
  });
  if (!held) {
    // Released between our create and get — one more conditional create.
    return (await attempt()) ? { won: true, holder } : { won: false };
  }
  // Lease expiry: an explicit lease wins; a legacy row (pre-lease) expires
  // CLAIM_LEASE_MS after its requestedAt; an unreadable row is assumed LIVE —
  // the safe default is to report in-flight, never to race a winner.
  const expiresAt = held.leaseUntil
    ? Date.parse(held.leaseUntil)
    : held.requestedAt
      ? Date.parse(held.requestedAt) + CLAIM_LEASE_MS
      : Date.now() + CLAIM_LEASE_MS;
  if (expiresAt > Date.now()) {
    return { won: false };
  }
  // GL-09: a claim whose lease expired belongs to a crashed process — it may
  // no longer block this customer's transitions forever. Seize it with ONE
  // guarded update; exactly one concurrent reclaimer's condition passes.
  const takeover = await casTakeover("CustomerLifecycleClaim", customerId, {
    nonceField: "holder",
    nonce: holder,
    leaseField: "leaseUntil",
    leaseMs: CLAIM_LEASE_MS,
    extraSets: { action, requestedAt: new Date().toISOString() },
  });
  return takeover.ok ? { won: true, holder } : { won: false };
}

/** Release the lock — fenced on the holder nonce, so a worker whose lease was
 *  taken over can never release the new holder's lock. Idempotent and swallows
 *  its own failure: a lingering claim only delays the next transition until
 *  the lease expires; it never corrupts state. */
export async function releaseLifecycleClaim(
  customerId: string,
  holder: string
): Promise<void> {
  const released = await casFencedDelete("CustomerLifecycleClaim", customerId, {
    field: "holder",
    nonce: holder,
    allowMissingFence: true,
  });
  if (released !== "UNSUPPORTED") return;
  // No CAS wiring: takeover is disabled there, so this holder is the only one.
  const client = await dataClient();
  await client.models.CustomerLifecycleClaim.delete({ id: customerId }).catch(
    () => undefined
  );
}
