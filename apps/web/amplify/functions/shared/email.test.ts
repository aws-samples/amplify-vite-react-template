import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R80 — the lead/ops inbox partition lives in this module.
 *
 * notifyLeads is notifyOffice's twin in every respect except routing: it sends
 * to SES_LEADS_EMAIL (sales@) so lead-pipeline alerts land where sales sees
 * them, not buried in the ops inbox. Two things must hold:
 *   - a lead alert reaches a human even if the deploy forgot SES_LEADS_EMAIL —
 *     it falls back to SES_NOTIFY_EMAIL and says so loudly; and
 *   - ops/money alarms (notifyOffice) still go to SES_NOTIFY_EMAIL — the
 *     reroute must not have dragged the ops traffic along with it.
 */

const { sesSend } = vi.hoisted(() => ({
  sesSend: vi.fn(async () => ({})),
}));

vi.mock("@aws-sdk/client-ses", () => ({
  SESClient: class {
    send = sesSend;
  },
  SendRawEmailCommand: class {
    constructor(public input: { RawMessage: { Data: Uint8Array } }) {}
  },
}));

const emailLogs: Record<string, unknown>[] = [];
const workRows: (Record<string, unknown> & { id: string })[] = [];
const workHistory: Record<string, unknown>[] = [];
vi.mock("./dataClient", () => ({
  dataClient: async () => ({
    models: {
      EmailLog: {
        create: async (input: Record<string, unknown>) => {
          emailLogs.push(input);
          return { data: input };
        },
      },
      WorkItem: {
        get: async ({ id }: { id: string }) => ({
          data: workRows.find((row) => row.id === id) ?? null,
        }),
        create: async (input: Record<string, unknown> & { id: string }) => {
          workRows.push(input);
          return { data: input };
        },
        update: async (input: Record<string, unknown> & { id: string }) => {
          const row = workRows.find((candidate) => candidate.id === input.id);
          if (row) Object.assign(row, input);
          return { data: row ?? null };
        },
      },
      WorkEvent: {
        create: async (input: Record<string, unknown>) => {
          workHistory.push(input);
          return { data: input };
        },
      },
    },
  }),
}));

const { notifyLeads, notifyOffice } = await import("./email");

/** The `To:` header of the most recent raw SES send. */
const lastTo = (): string | undefined => {
  const call = sesSend.mock.calls.at(-1) as unknown[] | undefined;
  if (!call) return undefined;
  const input = (call[0] as { input: { RawMessage: { Data: Uint8Array } } })
    .input;
  const raw = Buffer.from(input.RawMessage.Data).toString("utf8");
  return /^To:\s*(.+?)\s*$/m.exec(raw)?.[1];
};

const alert = {
  subject: "New website lead — Dana Whitlock",
  heading: "New website lead",
  bodyHtml: "<p>Dana wants rodent control.</p>",
  template: "ops-new-lead",
};

beforeEach(() => {
  sesSend.mockClear();
  emailLogs.length = 0;
  workRows.length = 0;
  workHistory.length = 0;
  delete process.env.SES_LEADS_EMAIL;
  delete process.env.SES_NOTIFY_EMAIL;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("notifyLeads routes lead alerts to the sales inbox (R80)", () => {
  it("sends to SES_LEADS_EMAIL when it is configured", async () => {
    process.env.SES_LEADS_EMAIL = "sales@pestbuzzkill.com";
    process.env.SES_NOTIFY_EMAIL = "info@pestbuzzkill.com";

    const ok = await notifyLeads(alert);

    expect(ok).toBe(true);
    expect(sesSend).toHaveBeenCalledOnce();
    expect(lastTo()).toBe("sales@pestbuzzkill.com");
    // Still logged in EmailLog like any other send.
    expect(emailLogs).toHaveLength(1);
    expect(emailLogs[0]).toMatchObject({
      toEmail: "sales@pestbuzzkill.com",
      template: "ops-new-lead",
    });
  });

  it("falls back to the ops inbox and logs LOUDLY when SES_LEADS_EMAIL is unset", async () => {
    // A misconfigured deploy must not silently drop a lead alert on the floor.
    process.env.SES_NOTIFY_EMAIL = "info@pestbuzzkill.com";
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    const ok = await notifyLeads(alert);

    expect(ok).toBe(true);
    expect(lastTo()).toBe("info@pestbuzzkill.com");
    expect(err).toHaveBeenCalled();
    const loud = err.mock.calls.some((c) =>
      String(c[0]).includes(
        "SES_LEADS_EMAIL not configured — lead alert fell back to the ops inbox"
      )
    );
    expect(loud).toBe(true);
  });

  it("tells nobody-was-told when neither inbox is configured", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    const ok = await notifyLeads(alert);

    expect(ok).toBe(false);
    expect(sesSend).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalled();
  });
});

describe("notifyOffice still routes ops alarms to the ops inbox (R80 anti-regression)", () => {
  it("an ops template goes to SES_NOTIFY_EMAIL, never the leads inbox", async () => {
    // Even with a leads inbox configured, ops alarms must not be rerouted.
    process.env.SES_LEADS_EMAIL = "sales@pestbuzzkill.com";
    process.env.SES_NOTIFY_EMAIL = "info@pestbuzzkill.com";

    const ok = await notifyOffice({
      subject: "ACTION REQUIRED — a subscription died at Stripe",
      heading: "A recurring customer canceled",
      bodyHtml: "<p>$45.00/mo lost.</p>",
      template: "ops-subscription-died",
    });

    expect(ok).toBe(true);
    expect(lastTo()).toBe("info@pestbuzzkill.com");
    expect(emailLogs[0]).toMatchObject({
      toEmail: "info@pestbuzzkill.com",
      template: "ops-subscription-died",
    });
  });

  it("turns a failed send into durable owned work instead of only an email log", async () => {
    process.env.SES_NOTIFY_EMAIL = "info@pestbuzzkill.com";
    sesSend.mockRejectedValueOnce(new Error("SES rejected the message"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const ok = await notifyOffice({
      subject: "Visit needs attention",
      heading: "Visit needs attention",
      bodyHtml: "<p>Act now.</p>",
      template: "ops-visit",
      relatedId: "job-1",
    });

    expect(ok).toBe(false);
    expect(emailLogs[0]).toMatchObject({ status: "FAILED" });
    expect(workRows[0]).toMatchObject({
      kind: "EMAIL_FAILURE",
      status: "OPEN",
      relatedId: "job-1",
      ownerEmail: "info@pestbuzzkill.com",
    });
    expect(workHistory[0]).toMatchObject({ eventType: "OPENED" });
  });
});
