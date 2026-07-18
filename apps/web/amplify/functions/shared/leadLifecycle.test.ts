import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown> & { id: string };
let customers: Map<string, Row>;
let activities: Record<string, unknown>[];
let createdSeq: number;

const { findLeadDuplicates } = vi.hoisted(() => ({
  findLeadDuplicates: vi.fn(async () => [] as unknown[]),
}));
const { openOwnedWork, openMissingContactWork, resolveOwnedWork } = vi.hoisted(
  () => ({
    openOwnedWork: vi.fn(async () => "work-1"),
    openMissingContactWork: vi.fn(async () => "work-2"),
    resolveOwnedWork: vi.fn(async () => true),
  })
);

vi.mock("./dataClient", () => ({
  dataClient: async () => ({
    models: {
      Customer: {
        create: async (input: Record<string, unknown>) => {
          const id = `lead-${++createdSeq}`;
          const row = { ...input, id };
          customers.set(id, row);
          return { data: row };
        },
        update: async (patch: Row) => {
          const row = customers.get(patch.id) ?? { id: patch.id };
          Object.assign(row, patch);
          customers.set(patch.id, row);
          return { data: row };
        },
        get: async ({ id }: { id: string }) => ({ data: customers.get(id) ?? null }),
        listCustomerByStatusAndDisplayName: async ({
          status,
        }: {
          status: string;
        }) => ({
          data: [...customers.values()].filter((c) => c.status === status),
          nextToken: null,
        }),
      },
      LeadActivity: {
        create: async (input: Record<string, unknown>) => {
          activities.push(input);
          return { data: input };
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
}));

const {
  createLead,
  logLeadTouch,
  setLeadDisposition,
  assignLeadOwner,
  reassignLeadsForSub,
} = await import("./leadLifecycle");

const actor = { sub: "sub-1", email: "olga@example.com" };

beforeEach(() => {
  customers = new Map();
  activities = [];
  createdSeq = 0;
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
    expect(findLeadDuplicates).not.toHaveBeenCalled(); // force skips the lookup
    expect(openOwnedWork).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "DUPLICATE_LEAD" })
    );
  });

  it("opens MISSING_CONTACT when there is no usable email or phone (R4)", async () => {
    const res = await createLead({ displayName: "No Contact" }, actor);
    expect(res.decision).toBe("CREATED");
    expect(openMissingContactWork).toHaveBeenCalledOnce();
  });
});

describe("logLeadTouch (GL-02 R6)", () => {
  it("records the touch, bumps lastTouchedAt, and clears the follow-up", async () => {
    customers.set("l1", { id: "l1", status: "LEAD" });
    await logLeadTouch(
      { customerId: "l1", channel: "CALL", outcome: "NO_ANSWER" },
      actor
    );
    expect(activities[0]).toMatchObject({
      channel: "CALL",
      outcome: "NO_ANSWER",
      actorEmail: "olga@example.com",
    });
    expect(customers.get("l1")?.lastTouchedAt).toBeTruthy();
    expect(resolveOwnedWork).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "LEAD_FOLLOWUP", dedupeKey: "l1" })
    );
  });

  it("rejects an unknown outcome", async () => {
    await expect(
      logLeadTouch({ customerId: "l1", channel: "CALL", outcome: "WHATEVER" }, actor)
    ).rejects.toThrow(/what actually happened/i);
  });
});

describe("setLeadDisposition (GL-02 R5)", () => {
  it("marks lost only with a controlled reason, and closes the follow-up", async () => {
    customers.set("l1", { id: "l1", status: "LEAD" });
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

  it("do-not-contact records who decided", async () => {
    customers.set("l1", { id: "l1", status: "LEAD" });
    await setLeadDisposition({ customerId: "l1", disposition: "DNC" }, actor);
    expect(customers.get("l1")).toMatchObject({
      doNotContact: true,
      doNotContactBy: "olga@example.com",
    });
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
    expect(customers.get("l1")).toMatchObject({ leadOwnerSub: null, leadOwnerEmail: null });
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
