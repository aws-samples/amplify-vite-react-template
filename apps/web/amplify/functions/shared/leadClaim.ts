import { createHash, randomUUID } from "node:crypto";
import { dataClient } from "./dataClient";
import { casFencedDelete, casTakeover } from "./atomicLock";

const LEASE_MS = 60_000;
type ClaimModel = "LeadIntakeClaim" | "LeadLifecycleClaim";
export type LeadClaim = { won: true; holder: string } | { won: false };

function claimId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 48);
}

async function acquire(
  modelName: ClaimModel,
  rawId: string,
  mutationId?: string
): Promise<LeadClaim> {
  const client = await dataClient();
  const models = client.models as unknown as Record<string, {
    create(input: Record<string, unknown>): Promise<{ data?: Record<string, unknown> | null }>;
    get(input: { id: string }): Promise<{ data?: Record<string, unknown> | null }>;
  }>;
  const model = models[modelName];
  if (!model) throw new Error("Lead safety controls are unavailable.");
  const id = claimId(rawId);
  const holder = randomUUID();
  const now = Date.now();
  const create = async () => {
    const { data } = await model.create({
      id,
      ...(mutationId ? { mutationId } : {}),
      requestedAt: new Date(now).toISOString(),
      leaseUntil: new Date(now + LEASE_MS).toISOString(),
      holder,
    });
    return Boolean(data);
  };
  if (await create()) return { won: true, holder };
  const { data: existing } = await model.get({ id });
  if (!existing) return (await create()) ? { won: true, holder } : { won: false };
  const leaseUntil = typeof existing.leaseUntil === "string"
    ? Date.parse(existing.leaseUntil)
    : Number.POSITIVE_INFINITY;
  if (leaseUntil > now) return { won: false };
  const takeover = await casTakeover(modelName, id, {
    nonceField: "holder",
    nonce: holder,
    leaseField: "leaseUntil",
    leaseMs: LEASE_MS,
    extraSets: {
      requestedAt: new Date(now).toISOString(),
      ...(mutationId ? { mutationId } : {}),
    },
  });
  return takeover.ok ? { won: true, holder } : { won: false };
}

async function release(model: ClaimModel, rawId: string, holder: string) {
  const id = claimId(rawId);
  const released = await casFencedDelete(model, id, {
    field: "holder",
    nonce: holder,
  });
  if (released !== "UNSUPPORTED") return;
  // With no CAS wiring stale takeover is refused, so the conditional-create
  // winner is the only holder and may use the generated delete in test/dev.
  const client = await dataClient();
  const models = client.models as unknown as Record<string, {
    delete(input: { id: string }): Promise<unknown>;
  }>;
  await models[model]?.delete({ id }).catch(() => undefined);
}

export const acquireLeadIntakeClaim = (identityKey: string) =>
  acquire("LeadIntakeClaim", identityKey);
export const releaseLeadIntakeClaim = (identityKey: string, holder: string) =>
  release("LeadIntakeClaim", identityKey, holder);
export const acquireLeadLifecycleClaim = (customerId: string, mutationId: string) =>
  acquire("LeadLifecycleClaim", customerId, mutationId);
export const releaseLeadLifecycleClaim = (customerId: string, holder: string) =>
  release("LeadLifecycleClaim", customerId, holder);
