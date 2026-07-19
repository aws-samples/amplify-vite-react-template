import { beforeEach, describe, expect, it, vi } from "vitest";

type Log = Record<string, unknown> & { id: string; messageId?: string };

let emailLogs: Log[];
let suppressed: Record<string, Record<string, unknown>>;
let serviceReports: Record<string, Record<string, unknown>>;
let reportAmendments: Record<string, Record<string, unknown>>;
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
    ServiceReport: {
      get: async ({ id }: { id: string }) => ({
        data: serviceReports[id] ?? null,
      }),
      update: async (input: Record<string, unknown>) => {
        const r = serviceReports[input.id as string];
        if (r) Object.assign(r, input);
        return { data: r ?? null };
      },
    },
    ServiceReportAmendment: {
      get: async ({ id }: { id: string }) => ({
        data: reportAmendments[id] ?? null,
      }),
      update: async (input: Record<string, unknown>) => {
        const a = reportAmendments[input.id as string];
        if (a) Object.assign(a, input);
        return { data: a ?? null };
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
  serviceReports = {};
  reportAmendments = {};
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


describe("GL-15 — the later outcome corrects the legal record", () => {
  beforeEach(() => {
    emailLogs = [
      {
        id: "log-r",
        messageId: "m-r",
        customerId: "cus-1",
        template: "service-report",
        relatedId: "rep-1",
        deliveryStatus: "SENT",
      },
    ];
    serviceReports["rep-1"] = { id: "rep-1", deliveryStatus: "ACCEPTED" };
  });

  it("upgrades the report to DELIVERED on the mailbox delivery event", async () => {
    await handleSesNotification({
      notificationType: "Delivery",
      mail: { messageId: "m-r" },
      delivery: { recipients: ["dana@example.com"] },
    });
    expect(serviceReports["rep-1"].deliveryStatus).toBe("DELIVERED");
    expect(workCalls).toHaveLength(0);
  });

  it("a bounce corrects the report and REOPENS the delivery obligation as owned work", async () => {
    await handleSesNotification({
      notificationType: "Bounce",
      mail: { messageId: "m-r", destination: ["dana@example.com"] },
      bounce: {
        bounceType: "Permanent",
        bounceSubType: "General",
        bouncedRecipients: [{ emailAddress: "dana@example.com" }],
      },
    });
    expect(serviceReports["rep-1"].deliveryStatus).toBe("BOUNCED");
    // Both the report-scoped case and the address-scoped case are opened.
    const reportCase = workCalls.find(
      (w) => w.dedupeKey === "service-report-delivery:rep-1"
    );
    expect(reportCase).toBeTruthy();
  });

  it("a late delivery event cannot un-bounce the record (terminal guard)", async () => {
    serviceReports["rep-1"].deliveryStatus = "BOUNCED";
    emailLogs[0].deliveryStatus = "BOUNCED";
    await handleSesNotification({
      notificationType: "Delivery",
      mail: { messageId: "m-r" },
      delivery: { recipients: ["dana@example.com"] },
    });
    expect(serviceReports["rep-1"].deliveryStatus).toBe("BOUNCED");
    expect(emailLogs[0].deliveryStatus).toBe("BOUNCED");
  });

  it("never overwrites an office-recorded alternate delivery", async () => {
    serviceReports["rep-1"].deliveryStatus = "ALTERNATE_DELIVERED";
    await handleSesNotification({
      notificationType: "Delivery",
      mail: { messageId: "m-r" },
      delivery: { recipients: ["dana@example.com"] },
    });
    expect(serviceReports["rep-1"].deliveryStatus).toBe("ALTERNATE_DELIVERED");
  });

  it("corrects an amendment record the same way", async () => {
    emailLogs.push({
      id: "log-a",
      messageId: "m-a",
      customerId: "cus-1",
      template: "service-report-amendment",
      relatedId: "amd-1",
      deliveryStatus: "SENT",
    });
    reportAmendments["amd-1"] = { id: "amd-1", deliveryStatus: "ACCEPTED" };
    await handleSesNotification({
      notificationType: "Bounce",
      mail: { messageId: "m-a", destination: ["dana@example.com"] },
      bounce: {
        bounceType: "Permanent",
        bounceSubType: "General",
        bouncedRecipients: [{ emailAddress: "dana@example.com" }],
      },
    });
    expect(reportAmendments["amd-1"].deliveryStatus).toBe("BOUNCED");
  });
});
