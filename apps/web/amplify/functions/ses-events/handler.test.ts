import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GL-22 — mailbox delivery events are never lost quietly:
 *  - a failed write THROWS (redelivery/DLQ), never ack-and-forget;
 *  - a malformed message becomes owned work (it can never succeed on retry);
 *  - a duplicate/out-of-order delivery event can never move a bounced or
 *    complained message back to delivered (X3 terminal guard).
 */

type LogRow = Record<string, unknown> & { id: string; messageId: string };
const logs: LogRow[] = [];
let updateThrows = false;
vi.mock("../shared/dataClient", () => ({
  dataClient: async () => ({
    models: {
      EmailLog: {
        listEmailLogByMessageId: async ({ messageId }: { messageId: string }) => ({
          data: logs.filter((l) => l.messageId === messageId),
        }),
        update: async (patch: LogRow) => {
          if (updateThrows) throw new Error("dynamo down");
          const row = logs.find((l) => l.id === patch.id);
          if (row) Object.assign(row, patch);
          return { data: row ?? null };
        },
      },
      SuppressedEmail: {
        get: async () => ({ data: null }),
        create: async () => ({ data: {} }),
      },
    },
  }),
}));
const workOpened: Record<string, unknown>[] = [];
vi.mock("../shared/ownedWork", () => ({
  openOwnedWork: async (o: Record<string, unknown>) => {
    workOpened.push(o);
    return "w1";
  },
}));

const { handler } = await import("./handler");

const snsEvent = (message: unknown, raw?: string) =>
  ({
    Records: [
      {
        Sns: {
          MessageId: "sns-1",
          Message: raw ?? JSON.stringify(message),
        },
      },
    ],
  }) as never;

beforeEach(() => {
  logs.length = 0;
  updateThrows = false;
  workOpened.length = 0;
});

describe("ses-events durability (GL-22)", () => {
  it("a failed write THROWS so the event redelivers — never acknowledged unrecorded", async () => {
    logs.push({ id: "l1", messageId: "m1", deliveryStatus: "SENT" });
    updateThrows = true;

    await expect(
      handler(
        snsEvent({ notificationType: "delivery", mail: { messageId: "m1" } })
      )
    ).rejects.toThrow(/notification\(s\) failed/);
    expect(logs[0].deliveryStatus).toBe("SENT"); // unchanged, will retry
  });

  it("a malformed message becomes owned work instead of an infinite retry or a silent drop", async () => {
    await handler(snsEvent(null, "{not json"));

    expect(workOpened).toHaveLength(1);
    expect(workOpened[0]).toMatchObject({
      kind: "INFRA_ALERT",
      dedupeKey: "ses-malformed:sns-1",
    });
  });

  it("a late delivery event can never un-bounce a message (terminal guard)", async () => {
    logs.push({ id: "l1", messageId: "m1", deliveryStatus: "BOUNCED" });

    await handler(
      snsEvent({ notificationType: "delivery", mail: { messageId: "m1" } })
    );

    expect(logs[0].deliveryStatus).toBe("BOUNCED");
  });

  it("a delivery event upgrades a SENT message normally", async () => {
    logs.push({ id: "l1", messageId: "m1", deliveryStatus: "SENT" });

    await handler(
      snsEvent({ notificationType: "delivery", mail: { messageId: "m1" } })
    );

    expect(logs[0].deliveryStatus).toBe("DELIVERED");
  });
});
