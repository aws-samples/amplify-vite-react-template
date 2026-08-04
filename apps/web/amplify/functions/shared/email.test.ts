import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _setLockStoreForTests, memoryLockStore } from "./atomicLock";

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
let emailLogCreateFails = false;
let emailLogUpdateFails = false;
const workRows: (Record<string, unknown> & { id: string })[] = [];
const workHistory: Record<string, unknown>[] = [];
const suppressedRows: Record<string, Record<string, unknown>> = {};
let suppressionReadFails = false;
vi.mock("./dataClient", () => ({
  dataClient: async () => ({
    models: {
      EmailLog: {
        create: async (input: Record<string, unknown>) => {
          if (emailLogCreateFails) {
            return { data: null, errors: [{ message: "refused" }] };
          }
          emailLogs.push(input);
          return { data: input };
        },
        // GL-03 outbox: the attempt row is settled in place after the
        // provider call — tests read the final state off the same row.
        update: async (patch: Record<string, unknown> & { id?: string }) => {
          if (emailLogUpdateFails) return { data: null };
          const row = emailLogs.find((r) => r.id === patch.id);
          if (!row) return { data: null };
          for (const [k, v] of Object.entries(patch)) {
            if (v !== undefined) row[k] = v;
          }
          return { data: { ...row } };
        },
      },
      SuppressedEmail: {
        get: async ({ email }: { email: string }) => {
          if (suppressionReadFails) throw new Error("suppression table unavailable");
          return { data: suppressedRows[email] ?? null };
        },
        create: async (input: Record<string, unknown>) => {
          suppressedRows[input.email as string] = input;
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

const {
  notifyLeads,
  notifyOffice,
  routeAwayFromProductionInboxes,
  sendEmail,
} = await import("./email");

/** The most recent SES command input (RawMessage + any ConfigurationSetName). */
const lastCommandInput = (): Record<string, unknown> | undefined => {
  const call = sesSend.mock.calls.at(-1) as unknown[] | undefined;
  return call ? (call[0] as { input: Record<string, unknown> }).input : undefined;
};

/** The `To:` header of the most recent raw SES send. */
const lastTo = (): string | undefined => {
  const input = lastCommandInput();
  if (!input) return undefined;
  const raw = Buffer.from(
    (input.RawMessage as { Data: Uint8Array }).Data
  ).toString("utf8");
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
  sesSend.mockResolvedValue({ MessageId: "ses-default" });
  emailLogs.length = 0;
  emailLogCreateFails = false;
  emailLogUpdateFails = false;
  workRows.length = 0;
  workHistory.length = 0;
  for (const k of Object.keys(suppressedRows)) delete suppressedRows[k];
  suppressionReadFails = false;
  delete process.env.SES_LEADS_EMAIL;
  delete process.env.SES_NOTIFY_EMAIL;
  delete process.env.SES_CONFIGURATION_SET;
  // Most of this file asserts PRODUCTION routing (R80's ops/sales partition),
  // so declare production. Without the flag every send to info@ / sales@ is
  // rewritten to the owner's staging aliases — which is the point of the
  // "staging can never reach a production inbox" block at the bottom.
  process.env.PRODUCTION_EMAIL = "1";
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

describe("GL-03 delivery pipeline", () => {
  beforeEach(() => {
    process.env.SES_FROM_EMAIL = "info@pestbuzzkill.com";
    process.env.SES_NOTIFY_EMAIL = "info@pestbuzzkill.com";
  });

  it("records the SES message id and marks the send SENT", async () => {
    sesSend.mockResolvedValueOnce({ MessageId: "ses-123" });

    const ok = await sendEmail({
      to: "dana@example.com",
      subject: "Your receipt",
      html: "<p>hi</p>",
      template: "receipt",
    });

    expect(ok).toBe(true);
    expect(emailLogs[0]).toMatchObject({
      messageId: "ses-123",
      deliveryStatus: "SENT",
      status: "SENT",
    });
  });

  it("fails closed and creates owned work when suppression status is unreadable", async () => {
    suppressionReadFails = true;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const ok = await sendEmail({
      to: "dana@example.com",
      subject: "Booking link",
      html: "<p>book</p>",
      template: "booking-link",
      customerId: "lead-1",
    });
    expect(ok).toBe(false);
    expect(sesSend).not.toHaveBeenCalled();
    expect(emailLogs[0]).toMatchObject({ deliveryStatus: "SUPPRESSED" });
    expect(workRows[0]).toMatchObject({ kind: "EMAIL_FAILURE" });
  });

  it("stamps the configuration set so bounce/complaint events flow", async () => {
    process.env.SES_CONFIGURATION_SET = "buzzkill-email-staging";

    await sendEmail({
      to: "dana@example.com",
      subject: "s",
      html: "<p>x</p>",
      template: "t",
    });

    expect(lastCommandInput()?.ConfigurationSetName).toBe("buzzkill-email-staging");
  });

  it("refuses to send to a suppressed address and owns the miss", async () => {
    suppressedRows["dana@example.com"] = {
      email: "dana@example.com",
      reason: "prior hard bounce",
    };
    vi.spyOn(console, "error").mockImplementation(() => {});

    const ok = await sendEmail({
      to: "dana@example.com",
      subject: "Your receipt",
      html: "<p>hi</p>",
      template: "receipt",
      customerId: "cus-1",
    });

    expect(ok).toBe(false);
    expect(sesSend).not.toHaveBeenCalled();
    expect(emailLogs[0]).toMatchObject({
      deliveryStatus: "SUPPRESSED",
      status: "FAILED",
    });
    expect(workRows[0]).toMatchObject({ kind: "EMAIL_FAILURE" });
  });

  it("marks a transient throttle QUEUED, never a silent drop", async () => {
    const err = new Error("Maximum sending rate exceeded");
    err.name = "Throttling";
    sesSend.mockRejectedValueOnce(err);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const ok = await sendEmail({
      to: "dana@example.com",
      subject: "s",
      html: "<p>x</p>",
      template: "t",
    });

    expect(ok).toBe(false);
    expect(emailLogs[0]).toMatchObject({
      deliveryStatus: "QUEUED",
      status: "FAILED",
    });
    expect(workRows[0]).toMatchObject({ kind: "EMAIL_FAILURE" });
  });
});

describe("GL-03 — the outbox: provider acceptance can never become untracked", () => {
  it("REFUSES the send when the outbox row cannot be written first", async () => {
    emailLogCreateFails = true;
    vi.spyOn(console, "error").mockImplementation(() => {});

    const ok = await sendEmail({
      to: "dana@example.com",
      subject: "s",
      html: "<p>x</p>",
      template: "t",
    });

    expect(ok).toBe(false);
    expect(sesSend).not.toHaveBeenCalled(); // nothing left the system
    expect(workRows[0]).toMatchObject({ kind: "EMAIL_FAILURE" });
    expect(String(workRows[0].title)).toContain("record could not be written");
  });

  it("writes the attempt BEFORE the provider call and settles it SENT in place", async () => {
    sesSend.mockResolvedValueOnce({ MessageId: "ses-outbox-1" });

    const ok = await sendEmail({
      to: "dana@example.com",
      subject: "s",
      html: "<p>exact body</p>",
      template: "t",
    });

    expect(ok).toBe(true);
    expect(emailLogs).toHaveLength(1); // ONE row: pre-created, then settled
    expect(emailLogs[0]).toMatchObject({
      status: "SENT",
      deliveryStatus: "SENT",
      messageId: "ses-outbox-1",
      bodyHtml: "<p>exact body</p>", // stored for exact resend
    });
  });

  it("a settle failure after provider accept is owned work that forbids blind resends", async () => {
    sesSend.mockResolvedValueOnce({ MessageId: "ses-outbox-2" });
    emailLogUpdateFails = true;
    vi.spyOn(console, "error").mockImplementation(() => {});

    await sendEmail({
      to: "dana@example.com",
      subject: "s",
      html: "<p>x</p>",
      template: "t",
    });

    // The row still reads SENDING — the unknown outcome is visible…
    expect(emailLogs[0]).toMatchObject({ deliveryStatus: "SENDING" });
    // …and the owned item says exactly what NOT to do.
    const item = workRows.find((w) =>
      String(w.title).includes("outcome could not be recorded")
    )!;
    expect(item).toBeTruthy();
    expect(String(item.detail)).toContain("Do NOT blind-resend");
  });

  it("resendQueuedEmail re-sends a throttled row exactly once and settles it RESENT", async () => {
    const { resendQueuedEmail } = await import("./email");
    emailLogs.push({
      id: "el-q1",
      toEmail: "dana@example.com",
      subject: "held",
      template: "t",
      deliveryStatus: "QUEUED",
      bodyHtml: "<p>the exact original body</p>",
    });
    _setLockStoreForTests(
      memoryLockStore({
        EmailLog: new Map(
          emailLogs.map((r) => [String(r.id), r as Record<string, unknown>])
        ),
      })
    );
    sesSend.mockResolvedValueOnce({ MessageId: "ses-resend-1" });

    const outcome = await resendQueuedEmail(emailLogs[0] as never);

    expect(outcome).toBe("RESENT");
    // A FRESH attempt row carries the resend; the original settles RESENT.
    expect(emailLogs.some((r) => r.messageId === "ses-resend-1")).toBe(true);
    expect(emailLogs[0].deliveryStatus).toBe("RESENT");
    _setLockStoreForTests(null);
  });

  it("resendQueuedEmail refuses attachment rows — no blind reconstruction", async () => {
    const { resendQueuedEmail } = await import("./email");
    const outcome = await resendQueuedEmail({
      id: "el-att",
      toEmail: "d@x.com",
      subject: "s",
      template: "t",
      bodyHtml: "<p>x</p>",
      hasAttachments: true,
    });
    expect(outcome).toBe("UNRESENDABLE");
    expect(sesSend).not.toHaveBeenCalled();
  });
});

describe("staging can never reach a production inbox", () => {
  beforeEach(() => {
    // Not production: the flag is the explicit opt-in, and its absence is
    // what every non-main branch looks like.
    delete process.env.PRODUCTION_EMAIL;
  });

  it("rewrites the ops and sales inboxes to the owner's staging aliases", () => {
    expect(routeAwayFromProductionInboxes("info@pestbuzzkill.com")).toBe(
      "jake+staginginfo@pestbuzzkill.com"
    );
    expect(routeAwayFromProductionInboxes("sales@pestbuzzkill.com")).toBe(
      "jake+stagingsales@pestbuzzkill.com"
    );
    // Case and surrounding whitespace must not smuggle an address past the
    // guard, and neither may a "Name <addr>" header form.
    expect(routeAwayFromProductionInboxes("  Sales@PestBuzzKill.com ")).toBe(
      "jake+stagingsales@pestbuzzkill.com"
    );
    expect(
      routeAwayFromProductionInboxes("BuzzKill Office <info@pestbuzzkill.com>")
    ).toBe("jake+staginginfo@pestbuzzkill.com");
  });

  it("leaves customers and the staging aliases themselves alone", () => {
    expect(routeAwayFromProductionInboxes("dana@example.com")).toBe(
      "dana@example.com"
    );
    // No second hop, and no match on a lookalike that merely contains "info".
    expect(
      routeAwayFromProductionInboxes("jake+staginginfo@pestbuzzkill.com")
    ).toBe("jake+staginginfo@pestbuzzkill.com");
    expect(routeAwayFromProductionInboxes("info@example.com")).toBe(
      "info@example.com"
    );
  });

  it("keeps production addressing untouched when the flag is set", () => {
    process.env.PRODUCTION_EMAIL = "1";
    expect(routeAwayFromProductionInboxes("info@pestbuzzkill.com")).toBe(
      "info@pestbuzzkill.com"
    );
    expect(routeAwayFromProductionInboxes("sales@pestbuzzkill.com")).toBe(
      "sales@pestbuzzkill.com"
    );
  });

  it("redirects an ops alarm end to end, and logs where it ACTUALLY went", async () => {
    // The env still names the production inbox — this is the case where a
    // deploy, a fallback in ownedWork, or a direct caller supplies info@ and
    // only the send boundary stands between staging and the real office.
    process.env.SES_NOTIFY_EMAIL = "info@pestbuzzkill.com";

    const ok = await notifyOffice({
      subject: "Card declined",
      heading: "Card declined",
      bodyHtml: "<p>x</p>",
      template: "ops-payment-failed",
    });

    expect(ok).toBe(true);
    expect(lastTo()).toBe("jake+staginginfo@pestbuzzkill.com");
    // An EmailLog that says info@ while SES was handed something else would
    // make the audit trail lie about who was contacted.
    expect(emailLogs[0]).toMatchObject({
      toEmail: "jake+staginginfo@pestbuzzkill.com",
    });
  });

  it("redirects a sales alert end to end", async () => {
    process.env.SES_LEADS_EMAIL = "sales@pestbuzzkill.com";

    const ok = await notifyLeads(alert);

    expect(ok).toBe(true);
    expect(lastTo()).toBe("jake+stagingsales@pestbuzzkill.com");
  });

  it("still sends customer mail to the customer", async () => {
    // The rule is about the two internal inboxes only — a staging test
    // booking must still be able to email the address that made it.
    const ok = await sendEmail({
      to: "dana@example.com",
      subject: "Your booking",
      html: "<p>Confirmed</p>",
      template: "booking-confirmation",
    });

    expect(ok).toBe(true);
    expect(lastTo()).toBe("dana@example.com");
  });
});
