import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Suppressing an owned-work kind is a QUEUE-NOISE decision. It must never
 * change whether the operation that discovered the exception succeeds.
 *
 * It did once: openOwnedWork returned null for a suppressed kind, callers that
 * refuse to publish without their case read that as "the write failed", and
 * every reschedule onto a day with no technician was blocked in production —
 * UNSTAFFED_VISIT is exactly such a caller AND is suppressed.
 */

const reads: string[] = [];
const fakeDataClient = {
  models: {
    WorkItem: {
      get: async ({ id }: { id: string }) => {
        reads.push(id);
        return { data: null };
      },
      create: async (input: Record<string, unknown>) => {
        reads.push(`create:${String(input.id)}`);
        return { data: input };
      },
      update: async (input: Record<string, unknown>) => ({ data: input }),
    },
    WorkEvent: {
      create: async (input: Record<string, unknown>) => ({ data: input }),
    },
  },
};

vi.mock("./dataClient", () => ({ dataClient: async () => fakeDataClient }));

const { openOwnedWork, WORK_SUPPRESSED } = await import("./ownedWork");

const caseInput = (kind: string) =>
  ({
    kind,
    dedupeKey: "k1",
    title: "t",
    detail: "d",
    relatedId: "r1",
    resolutionAction: "fix it",
    ownerTeam: "OPS",
  }) as unknown as Parameters<typeof openOwnedWork>[0];

beforeEach(() => {
  reads.length = 0;
});

describe("openOwnedWork — suppression is a successful no-op, not a failure", () => {
  it("returns a TRUTHY result for a suppressed kind, so gated callers proceed", async () => {
    // This is the exact shape of the caller that broke: visitChange refuses to
    // publish an unstaffed visit when its case "could not be written".
    const staffingCase = await openOwnedWork(caseInput("UNSTAFFED_VISIT"));

    expect(staffingCase).toBe(WORK_SUPPRESSED);
    expect(Boolean(staffingCase)).toBe(true);
    // The guard that blocked production must not fire.
    expect(() => {
      if (!staffingCase) throw new Error("blocked");
    }).not.toThrow();
  });

  it("still writes NOTHING for a suppressed kind — the queue stays quiet", async () => {
    await openOwnedWork(caseInput("UNSTAFFED_VISIT"));
    expect(reads).toHaveLength(0);
  });

  it("every suppressed kind behaves the same way", async () => {
    for (const kind of [
      "DISPATCH_NOT_READY",
      "LICENSE_LAPSE",
      "UNSTAFFED_VISIT",
      "PAYMENT_PROCESSING_OVERDUE",
    ]) {
      expect(await openOwnedWork(caseInput(kind)), kind).toBe(WORK_SUPPRESSED);
    }
    expect(reads).toHaveLength(0);
  });

  it("a NON-suppressed kind still really opens a case", async () => {
    const id = await openOwnedWork(caseInput("PAID_NOT_FINALIZED"));
    expect(id).toBeTruthy();
    expect(id).not.toBe(WORK_SUPPRESSED);
    expect(reads.some((r) => r.startsWith("create:"))).toBe(true);
  });
});
