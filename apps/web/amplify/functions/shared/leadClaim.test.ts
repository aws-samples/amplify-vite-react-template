import { beforeEach, describe, expect, it, vi } from "vitest";

const intakeClaims = new Map<string, Record<string, unknown>>();
const lifecycleClaims = new Map<string, Record<string, unknown>>();

function model(rows: Map<string, Record<string, unknown>>) {
  return {
    create: async (input: Record<string, unknown>) => {
      const id = String(input.id);
      if (rows.has(id)) return { data: null };
      rows.set(id, { ...input });
      return { data: rows.get(id) };
    },
    get: async ({ id }: { id: string }) => ({ data: rows.get(id) ?? null }),
    delete: async ({ id }: { id: string }) => ({ data: rows.delete(id) }),
  };
}

vi.mock("./dataClient", () => ({
  dataClient: async () => ({
    models: {
      LeadIntakeClaim: model(intakeClaims),
      LeadLifecycleClaim: model(lifecycleClaims),
    },
  }),
}));

vi.mock("./atomicLock", () => ({
  casTakeover: async () => ({ ok: false, reason: "LOST" }),
  casFencedDelete: async () => "UNSUPPORTED",
}));

const {
  acquireLeadIntakeClaim,
  acquireLeadLifecycleClaim,
  releaseLeadIntakeClaim,
} = await import("./leadClaim");

beforeEach(() => {
  intakeClaims.clear();
  lifecycleClaims.clear();
});

describe("GL-02 concurrency claims", () => {
  it("two concurrent submissions for one normalized identity have one winner", async () => {
    const [a, b] = await Promise.all([
      acquireLeadIntakeClaim("dana@example.com"),
      acquireLeadIntakeClaim("dana@example.com"),
    ]);
    expect([a.won, b.won].filter(Boolean)).toHaveLength(1);
  });

  it("serializes different mutations on the same lead", async () => {
    const first = await acquireLeadLifecycleClaim("lead-1", "touch-1");
    const second = await acquireLeadLifecycleClaim("lead-1", "lost-1");
    expect(first.won).toBe(true);
    expect(second.won).toBe(false);
  });

  it("a released intake can be retried safely", async () => {
    const first = await acquireLeadIntakeClaim("dana@example.com");
    if (!first.won) throw new Error("expected winner");
    await releaseLeadIntakeClaim("dana@example.com", first.holder);
    await expect(acquireLeadIntakeClaim("dana@example.com"))
      .resolves.toMatchObject({ won: true });
  });
});
