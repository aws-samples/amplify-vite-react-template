import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GL-11 reopened — atomic request ownership, the repair half: an OPEN portal
 * request or a REQUESTED guarantee callback whose owned queue item never
 * landed (crash between "row saved" and "queue item opened", no customer
 * retry) is re-entered into the shared Office queue by the daily sweep —
 * without spamming items that are already open and being worked.
 */

type Row = Record<string, unknown> & { id: string };

let portalRows: Row[] = [];
let callbackRows: Row[] = [];
const workItems = new Map<string, Row>();

const fakeDataClient = {
  models: {
    PortalRequest: {
      list: async () => ({ data: portalRows, nextToken: null }),
    },
    CallbackRequest: {
      list: async () => ({ data: callbackRows, nextToken: null }),
    },
    WorkItem: {
      get: async ({ id }: { id: string }) => ({
        data: workItems.get(id) ?? null,
      }),
    },
  },
};

vi.mock("../shared/dataClient", () => ({ dataClient: async () => fakeDataClient }));
vi.mock("../shared/email", () => ({
  emailShell: (h: string, b: string) => `${h}${b}`,
  notifyOffice: async () => true,
  sendEmail: async () => true,
}));

const opened: { kind: string; dedupeKey: string }[] = [];
vi.mock("../shared/ownedWork", () => ({
  workItemId: (kind: string, dedupeKey: string) => `work#${kind}#${dedupeKey}`,
  openOwnedWork: async (o: { kind: string; dedupeKey: string }) => {
    opened.push(o);
    return "work-1";
  },
  resolveOwnedWork: async () => true,
  openMissingContactWork: async () => null,
  defaultWorkOwner: () => "info@pestbuzzkill.com",
}));

const { reconcileRequestOwnership } = await import("./handler");

beforeEach(() => {
  portalRows = [];
  callbackRows = [];
  workItems.clear();
  opened.length = 0;
});

describe("reconcileRequestOwnership", () => {
  it("re-enters an OPEN portal request whose queue item never landed", async () => {
    portalRows = [
      { id: "pr-1", status: "OPEN", kind: "HELP", customerId: "c1", message: "hi" },
    ];

    const res = await reconcileRequestOwnership();

    expect(res.portalRepaired).toBe(1);
    expect(opened[0]).toMatchObject({ kind: "CUSTOMER_REQUEST", dedupeKey: "pr-1" });
  });

  it("re-enters a REQUESTED callback whose queue item never landed", async () => {
    callbackRows = [
      { id: "cb-j1", status: "REQUESTED", customerId: "c1", promisedBy: "2026-07-24" },
    ];

    const res = await reconcileRequestOwnership();

    expect(res.callbacksRepaired).toBe(1);
    expect(opened[0]).toMatchObject({ kind: "CALLBACK_PROMISE", dedupeKey: "cb-j1" });
  });

  it("skips requests whose item is already OPEN — no daily spam on working items", async () => {
    portalRows = [{ id: "pr-1", status: "OPEN", customerId: "c1" }];
    callbackRows = [{ id: "cb-j1", status: "REQUESTED", customerId: "c1" }];
    workItems.set("work#CUSTOMER_REQUEST#pr-1", { id: "x", status: "OPEN" });
    workItems.set("work#CALLBACK_PROMISE#cb-j1", { id: "y", status: "OPEN" });

    const res = await reconcileRequestOwnership();

    expect(res.portalRepaired).toBe(0);
    expect(res.callbacksRepaired).toBe(0);
    expect(opened).toHaveLength(0);
  });

  it("reopens when the item was RESOLVED but the request row is still live", async () => {
    portalRows = [{ id: "pr-1", status: "OPEN", customerId: "c1" }];
    workItems.set("work#CUSTOMER_REQUEST#pr-1", { id: "x", status: "RESOLVED" });

    const res = await reconcileRequestOwnership();

    expect(res.portalRepaired).toBe(1);
  });

  it("ignores answered/scheduled/terminal rows", async () => {
    portalRows = [
      { id: "pr-2", status: "ANSWERED", customerId: "c1" },
    ];
    callbackRows = [
      { id: "cb-2", status: "SCHEDULED", customerId: "c1" },
      { id: "cb-3", status: "GUARANTEE_ENDED", customerId: "c1" },
    ];

    const res = await reconcileRequestOwnership();

    expect(res.portalRepaired).toBe(0);
    expect(res.callbacksRepaired).toBe(0);
  });
});
