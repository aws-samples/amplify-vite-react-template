import { beforeEach, describe, expect, it, vi } from "vitest";

type Log = Record<string, unknown> & { id: string; messageId?: string };

let emailLogs: Log[];
let suppressed: Record<string, Record<string, unknown>>;
const workCalls: Record<string, unknown>[] = [];

const fakeDataClient = {
  models: {
    EmailLog: {
      listEmailLogByMessageId: async ({ messageId }: { messageId: string }) => ({
        data: emailLogs.filter((l) => l.messageId === messageId),
      }),
      update: async (input: Log) => {
        const l = emailLogs.find((x) => x.id === input.id);
        if (l) Object.assign(l, input);
        return { data: l ?? null };
      },
    },
    SuppressedEmail: {
      get: async ({ email }: { email: string }) => ({
        data: suppressed[email] ?? null,
      }),
      create: async (input: Record<string, unknown>) => {
        suppressed[input.email as string] = input;
        return { data: input };
      },
    },
  },
};

vi.mock("../shared/dataClient", () => ({ dataClient: async () => fakeDataClient }));
vi.mock("../shared/ownedWork", () => ({
  openOwnedWork: async (input: Record<string, unknown>) => {
    workCalls.push(input);
    return "work-x";
  },
}));

const { handleSesNotification } = await import("./handler");

beforeEach(() => {
  emailLogs = [
    {
      id: "log-1",
      messageId: "m-1",
      customerId: "cus-1",
      template: "booking-confirm",
      deliveryStatus: "SENT",
    },
  ];
  suppressed = {};
  workCalls.length = 0;
});

describe("ses-events (GL-03)", () => {
  it("suppresses a permanently bounced address and opens owned work", async () => {
    await handleSesNotification({
      notificationType: "Bounce",
      mail: { messageId: "m-1", destination: ["dana@example.com"] },
      bounce: {
        bounceType: "Permanent",
        bounceSubType: "General",
        bouncedRecipients: [
          { emailAddress: "dana@example.com", diagnosticCode: "550 no such user" },
        ],
      },
    });

    expect(emailLogs[0].deliveryStatus).toBe("BOUNCED");
    expect(suppressed["dana@example.com"]).toBeTruthy();
    expect(workCalls).toHaveLength(1);
    expect(workCalls[0]).toMatchObject({
      kind: "EMAIL_FAILURE",
      customerId: "cus-1",
      dedupeKey: "bounced:dana@example.com",
    });
  });

  it("ignores a transient bounce — the address is not dead", async () => {
    await handleSesNotification({
      notificationType: "Bounce",
      mail: { messageId: "m-1" },
      bounce: {
        bounceType: "Transient",
        bouncedRecipients: [{ emailAddress: "dana@example.com" }],
      },
    });

    expect(emailLogs[0].deliveryStatus).toBe("SENT");
    expect(Object.keys(suppressed)).toHaveLength(0);
    expect(workCalls).toHaveLength(0);
  });

  it("suppresses and owns a spam complaint", async () => {
    await handleSesNotification({
      notificationType: "Complaint",
      mail: { messageId: "m-1" },
      complaint: {
        complainedRecipients: [{ emailAddress: "Dana@Example.com" }],
        complaintFeedbackType: "abuse",
      },
    });

    expect(emailLogs[0].deliveryStatus).toBe("COMPLAINED");
    // Address is normalized to lowercase for the suppression key.
    expect(suppressed["dana@example.com"]).toBeTruthy();
    expect(workCalls[0]).toMatchObject({ dedupeKey: "complained:dana@example.com" });
  });

  it("marks a delivery DELIVERED without suppressing or opening work", async () => {
    await handleSesNotification({
      eventType: "Delivery",
      mail: { messageId: "m-1" },
      delivery: { recipients: ["dana@example.com"] },
    });

    expect(emailLogs[0].deliveryStatus).toBe("DELIVERED");
    expect(Object.keys(suppressed)).toHaveLength(0);
    expect(workCalls).toHaveLength(0);
  });

  it("does not re-suppress an already-suppressed address", async () => {
    suppressed["dana@example.com"] = {
      email: "dana@example.com",
      reason: "earlier bounce",
    };
    await handleSesNotification({
      notificationType: "Bounce",
      mail: { messageId: "m-1" },
      bounce: {
        bounceType: "Permanent",
        bouncedRecipients: [{ emailAddress: "dana@example.com" }],
      },
    });
    // Kept the original suppression reason; still owns the recurrence as work.
    expect(suppressed["dana@example.com"].reason).toBe("earlier bounce");
    expect(workCalls).toHaveLength(1);
  });
});
