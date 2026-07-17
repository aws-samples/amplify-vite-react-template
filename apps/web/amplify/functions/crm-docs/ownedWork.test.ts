import { beforeEach, describe, expect, it, vi } from "vitest";

let item: Record<string, unknown>;
const history: Record<string, unknown>[] = [];

const fakeDataClient = {
  models: {
    WorkItem: {
      get: async () => ({ data: item }),
      update: async (input: Record<string, unknown>) => {
        Object.assign(item, input);
        return { data: item };
      },
    },
    WorkEvent: {
      create: async (input: Record<string, unknown>) => {
        history.push(input);
        return { data: input };
      },
    },
  },
};

vi.mock("../shared/dataClient", () => ({ dataClient: async () => fakeDataClient }));
vi.mock("../shared/email", () => ({
  emailShell: (heading: string, body: string) => `${heading}\n${body}`,
  notifyOffice: async () => true,
  sendEmail: async () => true,
}));
vi.mock("../shared/stripeClient", () => ({ stripeClient: () => ({}) }));

const { updateOwnedWork } = await import("./handler");

beforeEach(() => {
  item = {
    id: "work-1",
    status: "OPEN",
    ownerSub: null,
    ownerEmail: "info@example.com",
  };
  history.length = 0;
});

describe("owned-work actions", () => {
  it("claims work to the signed-in actor and records the ownership event", async () => {
    await updateOwnedWork({
      workItemId: "work-1",
      action: "CLAIM",
      actorSub: "sub-1",
      actorEmail: "olga@example.com",
    });

    expect(item).toMatchObject({
      ownerSub: "sub-1",
      ownerEmail: "olga@example.com",
      status: "OPEN",
    });
    expect(history).toContainEqual(
      expect.objectContaining({
        workItemId: "work-1",
        eventType: "CLAIMED",
        actorSub: "sub-1",
      })
    );
  });

  it("requires a resolution note and permanently records the resolution", async () => {
    await expect(
      updateOwnedWork({
        workItemId: "work-1",
        action: "RESOLVE",
        actorSub: "sub-1",
        actorEmail: "olga@example.com",
        note: "   ",
      })
    ).rejects.toThrow(/how this was resolved/i);

    await updateOwnedWork({
      workItemId: "work-1",
      action: "RESOLVE",
      actorSub: "sub-1",
      actorEmail: "olga@example.com",
      note: "Called the customer and moved the visit to July 20.",
    });

    expect(item).toMatchObject({
      status: "RESOLVED",
      resolvedBySub: "sub-1",
      resolvedByEmail: "olga@example.com",
      resolutionNote: "Called the customer and moved the visit to July 20.",
    });
    expect(history).toContainEqual(
      expect.objectContaining({
        eventType: "RESOLVED",
        note: "Called the customer and moved the visit to July 20.",
      })
    );
  });
});
