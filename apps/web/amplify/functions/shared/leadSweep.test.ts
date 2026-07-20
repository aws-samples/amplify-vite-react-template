import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown> & { id: string };
const states = new Map<string, Row>();
const work = new Map<string, Row>();
const events: Row[] = [];
let leads: Row[] = [];
let failEventFor: string | null = null;
let scanFails = false;
const activeClaims = new Set<string>();

const { openOwnedWork } = vi.hoisted(() => ({
  openOwnedWork: vi.fn(async (input: Record<string, unknown>) => {
    const id = `${input.kind}:${input.dedupeKey}`;
    const prior = work.get(id);
    work.set(id, {
      id,
      status: "OPEN",
      dueAt: input.dueAt ?? prior?.dueAt ?? "2026-07-15T16:00:00Z",
      escalatedAt: prior?.escalatedAt ?? null,
      ownerSub: input.ownerSub ?? null,
      ownerEmail: input.ownerEmail ?? "sales@example.com",
    });
    return id;
  }),
}));

vi.mock("./ownedWork", () => ({
  openOwnedWork,
  workItemId: (kind: string, key: string) => `${kind}:${key}`,
  defaultWorkOwner: () => "sales@example.com",
}));

vi.mock("./businessDays", () => ({
  oneBusinessDayDueAt: async () => new Date("2026-07-17T16:00:00Z"),
}));

vi.mock("./leadClaim", () => ({
  acquireLeadLifecycleClaim: async (id: string) => {
    if (activeClaims.has(id)) return { won: false };
    activeClaims.add(id);
    return { won: true, holder: `holder-${id}` };
  },
  releaseLeadLifecycleClaim: async (id: string) => {
    activeClaims.delete(id);
  },
}));

vi.mock("./atomicLock", () => ({
  casGuardedUpdate: async (
    _model: string,
    id: string,
    sets: Record<string, unknown>
  ) => {
    const row = work.get(id);
    if (!row || row.status !== "OPEN" || row.escalatedAt) {
      return { ok: false, reason: "LOST" };
    }
    Object.assign(row, sets);
    return { ok: true, prior: {} };
  },
}));

vi.mock("./dataClient", () => ({
  dataClient: async () => ({
    models: {
      LeadSweepState: {
        get: async ({ id }: { id: string }) => ({ data: states.get(id) ?? null, errors: [] }),
        create: async (input: Row) => {
          states.set(input.id, { ...input });
          return { data: states.get(input.id) };
        },
        update: async (input: Row) => {
          const row = { ...(states.get(input.id) ?? { id: input.id }), ...input };
          states.set(input.id, row);
          return { data: row };
        },
      },
      Customer: {
        get: async ({ id }: { id: string }) => ({
          data: leads.find((row) => row.id === id) ?? null,
          errors: [],
        }),
        listCustomerByStatusAndDisplayName: async (
          _key: unknown,
          opts: { nextToken?: string | null }
        ) => {
          if (scanFails) {
            return { data: [], errors: [{ message: "lead page unavailable" }] };
          }
          const page = opts.nextToken ? leads.slice(1) : leads.slice(0, 1);
          return {
            data: page,
            nextToken: !opts.nextToken && leads.length > 1 ? "page-2" : null,
            errors: [],
          };
        },
      },
      WorkItem: {
        get: async ({ id }: { id: string }) => ({ data: work.get(id) ?? null, errors: [] }),
        update: async (input: Row) => {
          const row = { ...(work.get(input.id) ?? { id: input.id }), ...input };
          work.set(input.id, row);
          return { data: row };
        },
      },
      WorkEvent: {
        get: async ({ id }: { id: string }) => ({
          data: events.find((row) => row.id === id) ?? null,
          errors: [],
        }),
        create: async (input: Row) => {
          if (input.workItemId === failEventFor) return { data: null };
          if (events.some((row) => row.id === input.id)) return { data: null };
          events.push(input);
          return { data: input };
        },
      },
    },
  }),
}));

const { sweepLeads } = await import("./leadSweep");
const NOW = new Date("2026-07-16T16:00:00Z");

function lead(id: string): Row {
  return {
    id,
    status: "LEAD",
    displayName: id,
    nextAction: "Make first response",
    nextActionAt: "2026-07-15T16:00:00Z",
    leadOwnerTeam: "SALES",
    leadOwnerEmail: "sales@example.com",
  };
}

beforeEach(() => {
  states.clear();
  work.clear();
  events.length = 0;
  leads = [];
  failEventFor = null;
  scanFails = false;
  activeClaims.clear();
  openOwnedWork.mockClear();
});

describe("GL-02 lead sweep", () => {
  it("pages to completion, repairs missing work, and escalates at the real deadline", async () => {
    leads = [lead("lead-1"), lead("lead-2")];
    const result = await sweepLeads(NOW);

    expect(result).toEqual({ scanned: 2, failed: 0 });
    expect(work.get("LEAD_FOLLOWUP:lead-1")?.escalatedAt).toBe(NOW.toISOString());
    expect(work.get("LEAD_FOLLOWUP:lead-2")?.escalatedAt).toBe(NOW.toISOString());
    expect(states.get("lead-sweep")?.lastCompletedAt).toBe(NOW.toISOString());
  });

  it("isolates one failed lead, continues the page, and leaves a detectable partial run", async () => {
    leads = [lead("lead-bad"), lead("lead-good")];
    // Existing rows make both go straight to escalation; the first history
    // write fails while the second still completes.
    for (const row of leads) {
      work.set(`LEAD_FOLLOWUP:${row.id}`, {
        id: `LEAD_FOLLOWUP:${row.id}`,
        status: "OPEN",
        dueAt: row.nextActionAt,
        escalatedAt: null,
      });
    }
    failEventFor = "LEAD_FOLLOWUP:lead-bad";

    await expect(sweepLeads(NOW)).rejects.toThrow(/partial: 1 of 2/i);
    expect(work.get("LEAD_FOLLOWUP:lead-good")?.escalatedAt).toBe(NOW.toISOString());
    expect(openOwnedWork).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "LEAD_LIFECYCLE_RECOVERY",
        dedupeKey: "sweep:lead-bad",
      })
    );
    expect(states.get("lead-sweep")?.lastCompletedAt).toBeUndefined();
    expect(states.get("lead-sweep")?.failed).toBe(1);
  });

  it("turns a missed sweep heartbeat into deduplicated shared work", async () => {
    states.set("lead-sweep", {
      id: "lead-sweep",
      lastCompletedAt: "2026-07-16T14:00:00Z",
    });
    await sweepLeads(NOW);
    expect(openOwnedWork).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "INFRA_ALERT" })
    );
  });

  it("marks an incomplete scan partial and owns the collection-level failure", async () => {
    scanFails = true;
    await expect(sweepLeads(NOW)).rejects.toThrow(/lead page unavailable/i);
    expect(states.get("lead-sweep")?.failed).toBe(1);
    expect(openOwnedWork).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "INFRA_ALERT",
        title: expect.stringMatching(/complete lead queue/i),
      })
    );
  });

  it("overlapping sweeps converge on one escalation event", async () => {
    leads = [lead("lead-1")];
    work.set("LEAD_FOLLOWUP:lead-1", {
      id: "LEAD_FOLLOWUP:lead-1",
      status: "OPEN",
      title: "Make first response: lead-1",
      dueAt: leads[0].nextActionAt,
      escalatedAt: null,
    });

    await expect(Promise.all([sweepLeads(NOW), sweepLeads(NOW)])).resolves.toHaveLength(2);
    expect(events.filter((row) => row.eventType === "OVERDUE")).toHaveLength(1);
  });
});
