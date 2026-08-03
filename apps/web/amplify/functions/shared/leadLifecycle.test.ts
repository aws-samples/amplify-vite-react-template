import { beforeEach, describe, expect, it, vi } from "vitest";
import { CALL_CONSENT_TEXT_VERSION } from "./consentText";

type Row = Record<string, unknown> & { id: string };
let customers: Map<string, Row>;
let activities: Record<string, unknown>[];
let activityRows: Map<string, Row>;
let createdSeq: number;
let failActivityCreate: boolean;
let customerUpdateCount: number;
let workItems: Map<string, Row>;
let plans: Map<string, Row>;

const { findLeadDuplicates } = vi.hoisted(() => ({
  findLeadDuplicates: vi.fn(async () => [] as unknown[]),
}));
const { openOwnedWork, openMissingContactWork, resolveOwnedWork } = vi.hoisted(
  () => ({
    openOwnedWork: vi.fn(async (input: Record<string, unknown>) => {
      const id = `${input.kind}:${input.dedupeKey}`;
      const row = {
        id,
        status: "OPEN",
        title: input.title,
        dueAt: input.dueAt,
      } as Row;
      workItems.set(id, row);
      return id;
    }),
    openMissingContactWork: vi.fn(async () => "work-2"),
    resolveOwnedWork: vi.fn(async () => true),
  })
);

const bookingRequests = new Map<string, Row>();

vi.mock("./dataClient", () => ({
  dataClient: async () => ({
    models: {
      Customer: {
        create: async (input: Record<string, unknown>) => {
          const id = String(input.id ?? `lead-${++createdSeq}`);
          const row = { ...input, id };
          customers.set(id, row);
          return { data: row };
        },
        update: async (patch: Row) => {
          customerUpdateCount++;
          const row = customers.get(patch.id) ?? { id: patch.id };
          Object.assign(row, patch);
          customers.set(patch.id, row);
          return { data: row };
        },
        get: async ({ id }: { id: string }) => ({ data: customers.get(id) ?? null, errors: [] }),
        listCustomerByStatusAndDisplayName: async ({
          status,
        }: {
          status: string;
        }) => ({
          data: [...customers.values()].filter((c) => c.status === status),
          nextToken: null,
        }),
      },
      BookingRequest: {
        get: async ({ id }: { id: string }) => ({
          data: bookingRequests.get(id) ?? null,
        }),
        delete: async ({ id }: { id: string }) => {
          const row = bookingRequests.get(id) ?? null;
          bookingRequests.delete(id);
          return { data: row };
        },
      },
      LeadActivity: {
        create: async (input: Record<string, unknown>) => {
          if (failActivityCreate) {
            failActivityCreate = false;
            return {
              data: null,
              errors: [{ message: "activity write failed" }],
            };
          }
          activities.push(input);
          const row = input as Row;
          activityRows.set(row.id, row);
          return { data: row };
        },
        get: async ({ id }: { id: string }) => ({ data: activityRows.get(id) ?? null, errors: [] }),
      },
      ServicePlan: {
        get: async ({ id }: { id: string }) => ({ data: plans.get(id) ?? null }),
        create: async (input: Row) => {
          plans.set(input.id, { ...input });
          return { data: { ...input }, errors: undefined };
        },
      },
      SuppressedEmail: { get: async () => ({ data: null, errors: [] }) },
      ConsentAudit: { create: async (input: Row) => ({ data: input }) },
      WorkItem: {
        get: async ({ id }: { id: string }) => ({ data: workItems.get(id) ?? null }),
        update: async (input: Row) => {
          const row = { ...(workItems.get(input.id) ?? { id: input.id }), ...input } as Row;
          workItems.set(input.id, row);
          return { data: row };
        },
      },
    },
  }),
}));

vi.mock("./leadIdentity", async (importActual) => {
  const actual = await importActual<typeof import("./leadIdentity")>();
  return { ...actual, findLeadDuplicates };
});

vi.mock("./ownedWork", () => ({
  openOwnedWork,
  openMissingContactWork,
  resolveOwnedWork,
  workItemId: (kind: string, key: string) => `${kind}:${key}`,
  defaultWorkOwner: () => "sales@example.com",
}));

vi.mock("./businessDays", () => ({
  oneBusinessDayDueAt: async () => new Date("2026-07-15T16:00:00Z"),
}));

vi.mock("./leadClaim", () => ({
  acquireLeadIntakeClaim: async () => ({ won: true, holder: "holder" }),
  releaseLeadIntakeClaim: async () => undefined,
  acquireLeadLifecycleClaim: async () => ({ won: true, holder: "holder" }),
  releaseLeadLifecycleClaim: async () => undefined,
}));

vi.mock("./atomicLock", () => ({
  casGuardedUpdate: async (model: string, id: string, sets: Record<string, unknown>) => {
    if (model === "Customer") Object.assign(customers.get(id)!, sets);
    return { ok: true, prior: {} };
  },
}));

const {
  createLead,
  logLeadTouch,
  setLeadDisposition,
  assignLeadOwner,
  recordFunnelContactOutcome,
  recordWebsiteQuoteRequested,
  recordWebsiteQuoteLead,
  reassignLeadsForSub,
} = await import("./leadLifecycle");

const actor = { sub: "sub-1", email: "olga@example.com" };

beforeEach(() => {
  customers = new Map();
  activities = [];
  activityRows = new Map();
  createdSeq = 0;
  failActivityCreate = false;
  customerUpdateCount = 0;
  workItems = new Map();
  plans = new Map();
  findLeadDuplicates.mockClear();
  findLeadDuplicates.mockResolvedValue([]);
  openOwnedWork.mockClear();
  openMissingContactWork.mockClear();
  resolveOwnedWork.mockClear();
});

describe("createLead — dedup gate (GL-02 R3)", () => {
  it("creates when there is no duplicate, owned by the creator", async () => {
    const res = await createLead(
      { displayName: "Dana", email: "dana@example.com" },
      actor
    );
    expect(res).toMatchObject({ decision: "CREATED" });
    if (res.decision !== "CREATED") throw new Error("unreachable");
    expect(customers.get(res.id)).toMatchObject({
      status: "LEAD",
      leadOwnerSub: "sub-1",
    });
  });

  it("returns candidates and creates NOTHING on a match (never a silent merge)", async () => {
    findLeadDuplicates.mockResolvedValue([
      { id: "c9", displayName: "Dana W", matchedOn: "email" },
    ]);
    const res = await createLead(
      { displayName: "Dana", email: "dana@example.com" },
      actor
    );
    expect(res.decision).toBe("DUPLICATE");
    expect(customers.size).toBe(0);
  });

  it("force creates a separate record and opens DUPLICATE_LEAD to audit it", async () => {
    findLeadDuplicates.mockResolvedValue([{ id: "c9", displayName: "Dana W" }]);
    const res = await createLead(
      { displayName: "Dana", email: "dana@example.com", force: true },
      actor
    );
    expect(res.decision).toBe("CREATED");
    expect(findLeadDuplicates).toHaveBeenCalled();
    expect(openOwnedWork).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "DUPLICATE_LEAD" })
    );
  });

  it("opens MISSING_CONTACT when there is no usable email or phone (R4)", async () => {
    const res = await createLead({ displayName: "No Contact" }, actor);
    expect(res.decision).toBe("CREATED");
    expect(openMissingContactWork).toHaveBeenCalledOnce();
  });

  it("a retry with the same intake id converges on one lead and one intake activity", async () => {
    const input = {
      displayName: "Retry Dana",
      email: "retry@example.com",
      idempotencyKey: "submission-1",
    };
    const first = await createLead(input, actor);
    const retry = await createLead(input, actor);
    expect(first).toEqual(retry);
    expect(customers.size).toBe(1);
    expect(activities.filter((row) => String(row.mutationId).includes("submission-1")))
      .toHaveLength(1);
  });

  it("duplicate lookup failure fails closed and creates no ordinary lead", async () => {
    findLeadDuplicates.mockRejectedValueOnce(new Error("duplicate page unreadable"));
    await expect(
      createLead({ displayName: "Dana", email: "dana@example.com" }, actor)
    ).rejects.toThrow(/duplicate page unreadable/i);
    expect(customers.size).toBe(0);
    expect(openOwnedWork).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "LEAD_LIFECYCLE_RECOVERY" })
    );
  });
});

describe("logLeadTouch (GL-02 R6)", () => {
  it("records an attempt without labeling the customer reached, then replaces the obligation", async () => {
    customers.set("l1", {
      id: "l1",
      status: "LEAD",
      displayName: "Dana",
      contactConsentChannels: ["CALL"],
    });
    await logLeadTouch(
      { customerId: "l1", channel: "CALL", outcome: "NO_ANSWER" },
      actor
    );
    expect(activities[0]).toMatchObject({
      channel: "CALL",
      outcome: "NO_ANSWER",
      actorEmail: "olga@example.com",
    });
    expect(customers.get("l1")?.lastAttemptedAt).toBeTruthy();
    expect(customers.get("l1")?.lastReachedAt).toBeUndefined();
    expect(openOwnedWork).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "LEAD_FOLLOWUP", dedupeKey: "l1" })
    );
  });

  it("rejects an unknown outcome", async () => {
    await expect(
      logLeadTouch({ customerId: "l1", channel: "CALL", outcome: "WHATEVER" }, actor)
    ).rejects.toThrow(/what actually happened/i);
  });

  it("does not advance lead state when the immutable activity write fails", async () => {
    customers.set("l1", {
      id: "l1",
      status: "LEAD",
      displayName: "Dana",
      contactConsentChannels: ["CALL"],
      nextAction: "Make the first contact attempt",
      nextActionAt: "2026-07-15T16:00:00Z",
    });
    failActivityCreate = true;

    await expect(
      logLeadTouch(
        { customerId: "l1", channel: "CALL", outcome: "NO_ANSWER" },
        actor
      )
    ).rejects.toThrow(/activity write failed/i);

    expect(customers.get("l1")).toMatchObject({
      nextAction: "Make the first contact attempt",
      nextActionAt: "2026-07-15T16:00:00Z",
    });
    expect(customers.get("l1")?.lastAttemptedAt).toBeUndefined();
    expect(openOwnedWork).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "LEAD_LIFECYCLE_RECOVERY" })
    );
  });

  it("a mutation retry adopts the already-confirmed state instead of moving its deadline", async () => {
    customers.set("l1", {
      id: "l1",
      status: "LEAD",
      displayName: "Dana",
      contactConsentChannels: ["CALL"],
    });
    const action = {
      customerId: "l1",
      channel: "CALL",
      outcome: "NO_ANSWER",
      idempotencyKey: "same-touch",
    };
    const first = await logLeadTouch(action, actor);
    const writesAfterFirst = customerUpdateCount;
    const retry = await logLeadTouch(action, actor);

    expect(retry).toEqual(first);
    expect(customerUpdateCount).toBe(writesAfterFirst);
    expect(activities).toHaveLength(1);
  });

  it("rejects channel/outcome combinations that would misstate the event", async () => {
    await expect(
      logLeadTouch(
        { customerId: "l1", channel: "CALL", outcome: "SENT" },
        actor
      )
    ).rejects.toThrow(/selected contact channel/i);
  });

  it("fails closed when call consent is absent", async () => {
    customers.set("l1", { id: "l1", status: "LEAD", displayName: "Dana" });
    await expect(
      logLeadTouch(
        { customerId: "l1", channel: "CALL", outcome: "NO_ANSWER" },
        actor
      )
    ).rejects.toThrow(/permission is not retained/i);
    expect(activities).toHaveLength(0);
  });
});

describe("recordWebsiteQuoteRequested", () => {
  it("automatically replaces the obligation without claiming customer contact", async () => {
    customers.set("l1", {
      id: "l1",
      status: "LEAD",
      displayName: "Dana",
      leadOwnerEmail: "sales@example.com",
      nextAction: "Make first response",
      nextActionAt: "2026-07-14T16:00:00Z",
    });

    await expect(
      recordWebsiteQuoteRequested({
        customerId: "l1",
        bookingRequestId: "booking-1",
      })
    ).resolves.toBe(true);

    expect(customers.get("l1")).toMatchObject({
      nextAction: "Complete the next follow-up",
      nextActionAt: "2026-07-15T16:00:00.000Z",
    });
    expect(customers.get("l1")?.lastReachedAt).toBeUndefined();
    expect(activities).toContainEqual(
      expect.objectContaining({
        channel: "NOTE",
        direction: "INBOUND",
        outcome: "NOTE",
        note: expect.stringContaining("booking-1"),
      })
    );
    expect(workItems.get("LEAD_FOLLOWUP:l1")).toMatchObject({
      status: "OPEN",
      dueAt: "2026-07-15T16:00:00.000Z",
    });
  });
});

describe("recordFunnelContactOutcome", () => {
  it("stamps the manual-follow-up reason on the lead as an audit note", async () => {
    customers.set("l2", {
      id: "l2",
      status: "LEAD",
      displayName: "Casey",
      leadOwnerEmail: "sales@example.com",
      nextAction: "Make first response",
      nextActionAt: "2026-07-14T16:00:00Z",
    });

    await expect(
      recordFunnelContactOutcome({
        customerId: "l2",
        bookingRequestId: "booking-2",
        reason: "Outside the standard service area: ~95 min from base.",
      })
    ).resolves.toBe(true);

    expect(activities).toContainEqual(
      expect.objectContaining({
        channel: "NOTE",
        outcome: "NOTE",
        note: expect.stringContaining("Outside the standard service area"),
      })
    );
    // Never claims the customer was reached — it's a system note, not contact.
    expect(customers.get("l2")?.lastReachedAt).toBeUndefined();
  });
});

describe("recordWebsiteQuoteLead", () => {
  it("captures the visitor as a LEAD and returns its id, retaining email and call permission", async () => {
    const id = await recordWebsiteQuoteLead({
      name: "Pat Visitor",
      email: "pat@example.com",
      phone: "+14135550123",
      street: "1 Elm St",
      city: "Springfield",
      state: "MA",
      zip: "01103",
      callConsent: true,
      leadSource: "Website · quote",
      notes: "Service requested: Rodent Control",
    });

    expect(id).not.toBeNull();
    expect(customers.get(id as string)).toMatchObject({
      status: "LEAD",
      email: "pat@example.com",
      leadSource: "Website · quote",
      contactConsent: true,
      contactConsentChannels: ["EMAIL", "CALL"],
      contactConsentSource: "website-quote",
      // The live wording's version, not a frozen string: bumping the copy
      // must not fail this test, only changing which version gets stamped.
      contactConsentPolicyVersion: CALL_CONSENT_TEXT_VERSION,
    });
  });

  it("retains email only, with the email-response policy version, when call consent is absent", async () => {
    const id = await recordWebsiteQuoteLead({
      name: "Sam Visitor",
      email: "sam@example.com",
      callConsent: false,
      leadSource: "Website · quote",
    });

    expect(customers.get(id as string)).toMatchObject({
      contactConsent: false,
      contactConsentChannels: ["EMAIL"],
      contactConsentPolicyVersion: "website-email-response-2026-07-20.1",
    });
  });

  it("returns null instead of throwing when lead creation fails, so the quote is never withheld", async () => {
    findLeadDuplicates.mockRejectedValueOnce(new Error("duplicate page unreadable"));

    const id = await recordWebsiteQuoteLead({
      name: "Unlucky Visitor",
      email: "unlucky@example.com",
      callConsent: false,
      leadSource: "Website · quote",
    });

    expect(id).toBeNull();
    expect(customers.size).toBe(0);
  });
});

describe("setLeadDisposition (GL-02 R5)", () => {
  it("marks lost only with a controlled reason, and closes the follow-up", async () => {
    customers.set("l1", { id: "l1", status: "LEAD", displayName: "Dana" });
    await expect(
      setLeadDisposition({ customerId: "l1", disposition: "LOST" }, actor)
    ).rejects.toThrow(/controlled reason/i);

    await setLeadDisposition(
      { customerId: "l1", disposition: "LOST", reasonCode: "PRICE" },
      actor
    );
    expect(customers.get("l1")).toMatchObject({ lostReason: "PRICE" });
    expect(resolveOwnedWork).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "LEAD_FOLLOWUP" })
    );
  });

  it("CONVERT adds an active-not-billing plan and turns the lead into a client", async () => {
    customers.set("l1", { id: "l1", status: "LEAD", displayName: "Dana" });
    await setLeadDisposition(
      {
        customerId: "l1",
        disposition: "CONVERT",
        planName: "Quarterly general pest",
        priceCents: 14900,
        serviceFrequency: "QUARTERLY",
        idempotencyKey: "conv-1",
      },
      actor
    );
    // The lead is now an active client.
    expect(customers.get("l1")).toMatchObject({
      status: "ACTIVE",
      nextAction: null,
    });
    // A plan exists — priced, active, but NOT billing (no stripeSubscriptionId).
    const plan = [...plans.values()][0];
    expect(plan).toMatchObject({
      customerId: "l1",
      planName: "Quarterly general pest",
      priceCents: 14900,
      serviceFrequency: "QUARTERLY",
      status: "ACTIVE",
    });
    expect(plan.stripeSubscriptionId).toBeUndefined();
    expect(resolveOwnedWork).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "LEAD_FOLLOWUP" })
    );
  });

  it("CONVERT rejects a bad price or frequency before touching the record", async () => {
    customers.set("l1", { id: "l1", status: "LEAD", displayName: "Dana" });
    await expect(
      setLeadDisposition(
        {
          customerId: "l1",
          disposition: "CONVERT",
          planName: "Plan",
          priceCents: 0,
          serviceFrequency: "QUARTERLY",
          idempotencyKey: "conv-bad",
        },
        actor
      )
    ).rejects.toThrow(/valid plan price/i);
    expect(customers.get("l1")).toMatchObject({ status: "LEAD" });
    expect(plans.size).toBe(0);
  });

  it("do-not-contact records who decided", async () => {
    customers.set("l1", { id: "l1", status: "LEAD", displayName: "Dana" });
    await setLeadDisposition({ customerId: "l1", disposition: "DNC" }, actor);
    expect(customers.get("l1")).toMatchObject({
      doNotContact: true,
      doNotContactBy: "olga@example.com",
    });
  });

  it("works for an actor without an email, recording the sub as who decided", async () => {
    // The Cognito access token Amplify signs AppSync with carries no `email`
    // claim, so a UUID-username login (e.g. the hand-provisioned owner) reaches
    // here with sub only. Closing must not be blocked; who-decided falls back
    // to the sub rather than "A staffed Office actor is required."
    const emaillessActor = { sub: "owner-uuid", email: null };
    customers.set("l1", { id: "l1", status: "LEAD", displayName: "Dana" });
    await setLeadDisposition(
      { customerId: "l1", disposition: "LOST", reasonCode: "NO_RESPONSE" },
      emaillessActor
    );
    expect(customers.get("l1")).toMatchObject({ lostReason: "NO_RESPONSE" });

    customers.set("l2", { id: "l2", status: "LEAD", displayName: "Ravi" });
    await setLeadDisposition(
      { customerId: "l2", disposition: "DNC" },
      emaillessActor
    );
    expect(customers.get("l2")).toMatchObject({
      doNotContact: true,
      doNotContactBy: "owner-uuid",
    });
  });

  it("still requires a sub", async () => {
    customers.set("l1", { id: "l1", status: "LEAD", displayName: "Dana" });
    await expect(
      setLeadDisposition(
        { customerId: "l1", disposition: "LOST", reasonCode: "PRICE" },
        { sub: null, email: null }
      )
    ).rejects.toThrow(/staffed Office actor/i);
  });

  it("only an owner can clear DNC, with controlled evidence", async () => {
    customers.set("l1", {
      id: "l1",
      status: "LEAD",
      displayName: "Dana",
      doNotContact: true,
    });
    await expect(
      setLeadDisposition(
        {
          customerId: "l1",
          disposition: "CLEAR",
          reasonCode: "CUSTOMER_RECONSENTED",
          note: "Recorded inbound call on 2026-07-19",
        },
        actor
      )
    ).rejects.toThrow(/owner role required/i);
    expect(customers.get("l1")?.doNotContact).toBe(true);
  });
});

describe("assignLeadOwner", () => {
  it("'assign to me' stamps the caller's own identity", async () => {
    customers.set("l1", { id: "l1", status: "LEAD" });
    await assignLeadOwner({ customerId: "l1" }, actor);
    expect(customers.get("l1")).toMatchObject({
      leadOwnerSub: "sub-1",
      leadOwnerEmail: "olga@example.com",
    });
  });
});

describe("reassignLeadsForSub (GL-14 R6)", () => {
  it("returns a departing person's open leads to the team, leaving others alone", async () => {
    customers.set("l1", { id: "l1", status: "LEAD", displayName: "A", leadOwnerSub: "leaver" });
    customers.set("l2", { id: "l2", status: "LEAD", displayName: "B", leadOwnerSub: "someone-else" });
    customers.set("l3", { id: "l3", status: "ACTIVE", displayName: "C", leadOwnerSub: "leaver" });

    const res = await reassignLeadsForSub({ sub: "leaver", actorEmail: "owner@example.com" });

    expect(res).toMatchObject({ reassigned: 1, failed: 0 });
    // The leaver's open lead is unassigned (→ Sales team queue).
    expect(customers.get("l1")).toMatchObject({ leadOwnerSub: null, leadOwnerEmail: "sales@example.com" });
    // A peer's lead and a converted (ACTIVE) record are untouched.
    expect(customers.get("l2")).toMatchObject({ leadOwnerSub: "someone-else" });
    expect(customers.get("l3")).toMatchObject({ leadOwnerSub: "leaver" });
    // The handover is recorded in the activity ledger.
    expect(activities.some((a) => String(a.note).includes("offboarded"))).toBe(true);
  });

  it("is a no-op with no sub", async () => {
    await expect(reassignLeadsForSub({ sub: "" })).resolves.toMatchObject({
      reassigned: 0,
      failed: 0,
    });
  });
});

describe("DELETE_QUOTE — a quote money is attached to is not deletable", () => {
  const actor = { sub: "u1", email: "office@pestbuzzkill.com" };
  const seed = (status: string) => {
    customers.set("c1", { id: "c1", status: "LEAD", displayName: "Dana" });
    bookingRequests.set("q1", {
      id: "q1",
      leadCustomerId: "c1",
      status,
      service: "RODENT",
    });
  };

  it("removes an unbooked quote and leaves a note saying so", async () => {
    seed("QUOTED");
    const before = activities.length;

    await setLeadDisposition(
      {
        customerId: "c1",
        disposition: "DELETE_QUOTE",
        bookingRequestId: "q1",
        idempotencyKey: "k1",
      },
      actor
    );

    expect(bookingRequests.has("q1")).toBe(false);
    // The quote itself is gone, so the note is the only remaining trace.
    expect(activities.length).toBeGreaterThan(before);
  });

  it("REFUSES a booked quote — real money and a job sit behind it", async () => {
    seed("BOOKED");
    await expect(
      setLeadDisposition(
        {
          customerId: "c1",
          disposition: "DELETE_QUOTE",
          bookingRequestId: "q1",
          idempotencyKey: "k2",
        },
        actor
      )
    ).rejects.toThrow(/booked and paid/i);
    expect(bookingRequests.has("q1")).toBe(true);
  });

  it("REFUSES while a payment is still clearing", async () => {
    seed("PROCESSING");
    await expect(
      setLeadDisposition(
        { customerId: "c1", disposition: "DELETE_QUOTE", bookingRequestId: "q1", idempotencyKey: "k3" },
        actor
      )
    ).rejects.toThrow(/still clearing/i);
    expect(bookingRequests.has("q1")).toBe(true);
  });

  it("REFUSES a quote belonging to a different customer", async () => {
    seed("QUOTED");
    bookingRequests.set("q1", { id: "q1", leadCustomerId: "someone-else", status: "QUOTED" });
    await expect(
      setLeadDisposition(
        { customerId: "c1", disposition: "DELETE_QUOTE", bookingRequestId: "q1", idempotencyKey: "k4" },
        actor
      )
    ).rejects.toThrow(/different customer/i);
    expect(bookingRequests.has("q1")).toBe(true);
  });
});
