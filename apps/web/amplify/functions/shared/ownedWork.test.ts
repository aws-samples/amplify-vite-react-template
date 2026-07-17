import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown> & { id: string; status: string };
const rows: Row[] = [];
const events: Record<string, unknown>[] = [];

const fakeDataClient = {
  models: {
    WorkItem: {
      get: async ({ id }: { id: string }) => ({
        data: rows.find((row) => row.id === id) ?? null,
      }),
      create: async (input: Row) => {
        rows.push({ ...input });
        return { data: input };
      },
      update: async (input: Partial<Row> & { id: string }) => {
        const row = rows.find((candidate) => candidate.id === input.id);
        if (row) Object.assign(row, input);
        return { data: row ?? null };
      },
    },
    WorkEvent: {
      create: async (input: Record<string, unknown>) => {
        events.push({ ...input });
        return { data: input };
      },
    },
  },
};

vi.mock("./dataClient", () => ({ dataClient: async () => fakeDataClient }));

const { openOwnedWork, workItemId } = await import("./ownedWork");

const input = {
  kind: "CALLBACK_PROMISE" as const,
  dedupeKey: "booking-1",
  title: "Call Dana",
  detail: "A call was promised within an hour.",
  relatedId: "booking-1",
  sourceUrl: "/work",
  resolutionAction: "Call and record the outcome.",
  ownerTeam: "SALES" as const,
};

beforeEach(() => {
  rows.length = 0;
  events.length = 0;
  process.env.SES_LEADS_EMAIL = "sales@example.com";
});

describe("durable owned work", () => {
  it("creates one owned row with an SLA and an append-only opening event", async () => {
    const before = Date.now();
    const id = await openOwnedWork(input);

    expect(id).toBe(workItemId("CALLBACK_PROMISE", "booking-1"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "OPEN",
      ownerEmail: "sales@example.com",
      occurrenceCount: 1,
      resolutionAction: "Call and record the outcome.",
    });
    expect(new Date(String(rows[0].dueAt)).getTime()).toBeGreaterThanOrEqual(
      before + 59 * 60_000
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventType: "OPENED", workItemId: id });
  });

  it("collapses a retry into the same row but preserves it as a recurrence event", async () => {
    await openOwnedWork(input);
    Object.assign(rows[0], {
      ownerSub: "staff-1",
      ownerEmail: "olga@example.com",
      dueAt: "2026-07-17T20:00:00.000Z",
    });

    await openOwnedWork({ ...input, detail: "The callback request was received again." });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ownerSub: "staff-1",
      ownerEmail: "olga@example.com",
      dueAt: "2026-07-17T20:00:00.000Z",
      occurrenceCount: 2,
    });
    expect(events.map((event) => event.eventType)).toEqual([
      "OPENED",
      "REOCCURRED",
    ]);
  });

  it("reopens resolved work with a fresh owner/SLA cycle without deleting history", async () => {
    await openOwnedWork(input);
    Object.assign(rows[0], {
      status: "RESOLVED",
      ownerSub: "staff-1",
      ownerEmail: "olga@example.com",
      resolvedAt: "2026-07-17T18:00:00.000Z",
      resolutionNote: "Called once",
      escalatedAt: "2026-07-17T17:00:00.000Z",
    });

    await openOwnedWork(input);

    expect(rows[0]).toMatchObject({
      status: "OPEN",
      ownerSub: null,
      ownerEmail: "sales@example.com",
      resolvedAt: null,
      resolutionNote: null,
      escalatedAt: null,
      occurrenceCount: 2,
    });
    expect(events.map((event) => event.eventType)).toEqual([
      "OPENED",
      "REOPENED",
    ]);
  });
});
