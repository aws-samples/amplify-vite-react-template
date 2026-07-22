import { beforeEach, describe, expect, it, vi } from "vitest";

const rows: Record<string, unknown>[] = [];
const history: Record<string, unknown>[] = [];
const sendEmail = vi.fn(async (_input?: unknown) => true);

const fakeDataClient = {
  models: {
    WorkItem: {
      listWorkItemByStatusAndDueAt: async () => ({ data: rows, nextToken: null }),
      update: async (input: Record<string, unknown>) => {
        const row = rows.find((candidate) => candidate.id === input.id);
        if (row) Object.assign(row, input);
        return { data: row ?? null };
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
  sendEmail: (input: unknown) => sendEmail(input),
}));

const { escalateOverdueOwnedWork } = await import("./handler");

beforeEach(() => {
  rows.length = 0;
  history.length = 0;
  sendEmail.mockClear();
  sendEmail.mockResolvedValue(true);
  process.env.SES_NOTIFY_EMAIL = "manager@example.com";
});

describe("owned-work overdue escalation", () => {
  it("notifies management, stamps the row, and appends permanent history", async () => {
    rows.push({
      id: "work-1",
      status: "OPEN",
      title: "Call customer",
      detail: "Callback was promised.",
      ownerEmail: "sales@example.com",
      ownerTeam: "SALES",
      dueAt: "2020-01-01T00:00:00.000Z",
      escalatedAt: null,
      customerId: "c1",
    });

    await expect(escalateOverdueOwnedWork()).resolves.toEqual({
      overdueWorkEscalated: 1,
    });
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "manager@example.com",
        template: "owned-work-overdue",
        relatedId: "work-1",
      })
    );
    expect(rows[0].escalatedAt).toEqual(expect.any(String));
    expect(history).toContainEqual(
      expect.objectContaining({
        workItemId: "work-1",
        eventType: "OVERDUE",
      })
    );
  });

  it("does not escalate a future or already-escalated item twice", async () => {
    rows.push(
      {
        id: "future",
        status: "OPEN",
        title: "Future",
        detail: "Not due",
        ownerEmail: "sales@example.com",
        ownerTeam: "SALES",
        dueAt: "2999-01-01T00:00:00.000Z",
        escalatedAt: null,
      },
      {
        id: "done",
        status: "OPEN",
        title: "Already escalated",
        detail: "Done",
        ownerEmail: "ops@example.com",
        ownerTeam: "OPS",
        dueAt: "2020-01-01T00:00:00.000Z",
        escalatedAt: "2020-01-02T00:00:00.000Z",
      }
    );

    await expect(escalateOverdueOwnedWork()).resolves.toEqual({
      overdueWorkEscalated: 0,
    });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(history).toHaveLength(0);
  });
});
