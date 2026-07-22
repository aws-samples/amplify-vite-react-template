import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  _setLockStoreForTests,
  memoryLockStore,
} from "../shared/atomicLock";

/**
 * GL-11 reopened — group membership is a DURABLE, RESUMABLE, VERIFIED
 * command. The four surfaces (audit ledger, customer row, child access
 * groups, Cognito membership) cannot silently remain split: the audit lands
 * first and refuses everything on failure; each stage is fenced-recorded; a
 * crash leaves a resumable PARTIAL with owned work; COMPLETE requires the
 * verification pass to prove all four surfaces agree; and the why is
 * mandatory.
 */

process.env.AMPLIFY_AUTH_USERPOOL_ID = "pool-1";

let cognitoGroups: string[] = [];
let cognitoApplyFails = false;
vi.mock("@aws-sdk/client-cognito-identity-provider", () => {
  const cmd = (type: string) =>
    class {
      input: Record<string, unknown>;
      __type = type;
      constructor(input: Record<string, unknown>) {
        this.input = input;
      }
    };
  return {
    CognitoIdentityProviderClient: class {
      async send(c: { __type: string; input: Record<string, unknown> }) {
        if (c.__type === "ListGroups") {
          return { Groups: cognitoGroups.map((g) => ({ GroupName: g })) };
        }
        if (c.__type === "RemoveFromGroup") {
          if (cognitoApplyFails) throw new Error("cognito down");
          cognitoGroups = cognitoGroups.filter(
            (g) => g !== c.input.GroupName
          );
          return {};
        }
        if (c.__type === "AddToGroup") {
          if (cognitoApplyFails) throw new Error("cognito down");
          cognitoGroups.push(String(c.input.GroupName));
          return {};
        }
        return {};
      }
    },
    AdminAddUserToGroupCommand: cmd("AddToGroup"),
    AdminCreateUserCommand: cmd("CreateUser"),
    AdminDisableUserCommand: cmd("Disable"),
    AdminEnableUserCommand: cmd("Enable"),
    AdminGetUserCommand: cmd("GetUser"),
    AdminListGroupsForUserCommand: cmd("ListGroups"),
    AdminRemoveUserFromGroupCommand: cmd("RemoveFromGroup"),
    AdminSetUserPasswordCommand: cmd("SetPassword"),
    AdminUpdateUserAttributesCommand: cmd("UpdateAttrs"),
    AdminUserGlobalSignOutCommand: cmd("SignOut"),
    CreateGroupCommand: cmd("CreateGroup"),
    ListUsersInGroupCommand: cmd("ListUsersInGroup"),
  };
});

type Row = Record<string, unknown> & { id: string };
const customers = new Map<string, Row>();
const groups = new Map<string, Row>();
const commands = new Map<string, Row>();
const auditEvents: Row[] = [];
let auditFails = false;
let customerPatches: Row[] = [];
const childRows = new Map<string, Row[]>(); // modelName → rows

const childCollection = (name: string) => ({
  list: async () => ({ data: childRows.get(name) ?? [], nextToken: null }),
  update: async (p: Row) => {
    const row = (childRows.get(name) ?? []).find((r) => r.id === p.id);
    if (row) Object.assign(row, p);
    return { data: row ?? null };
  },
});

const fakeDataClient = {
  models: {
    Customer: {
      get: async ({ id }: { id: string }) => ({ data: customers.get(id) ?? null }),
      update: async (patch: Row) => {
        customerPatches.push(patch);
        customers.set(patch.id, { ...customers.get(patch.id)!, ...patch });
        return { data: customers.get(patch.id) };
      },
    },
    CustomerGroup: {
      get: async ({ id }: { id: string }) => ({ data: groups.get(id) ?? null }),
      update: async (p: Row) => ({ data: p }),
    },
    CustomerLifecycleEvent: {
      get: async ({ id }: { id: string }) => ({
        data: auditEvents.find((e) => e.id === id) ?? null,
      }),
      create: async (input: Record<string, unknown> & { id?: string }) => {
        if (auditFails) return { data: null, errors: [{ message: "refused" }] };
        const id = input.id ?? `ev-${auditEvents.length}`;
        if (auditEvents.some((e) => e.id === id)) {
          throw new Error("conditional check failed: id exists");
        }
        auditEvents.push({ ...input, id });
        return { data: auditEvents[auditEvents.length - 1] };
      },
    },
    GroupChangeCommand: {
      get: async ({ id }: { id: string }) => ({ data: commands.get(id) ?? null }),
      create: async (input: Row) => {
        if (commands.has(input.id)) return { data: null };
        commands.set(input.id, { ...input });
        return { data: commands.get(input.id) };
      },
      list: async () => ({ data: [...commands.values()], nextToken: null }),
      listGroupChangeCommandByCustomerIdAndRequestedAt: async ({
        customerId,
      }: {
        customerId: string;
      }) => ({
        data: [...commands.values()].filter((c) => c.customerId === customerId),
        nextToken: null,
      }),
    },
    ServicePlan: childCollection("ServicePlan"),
    Job: childCollection("Job"),
    Agreement: childCollection("Agreement"),
    ServiceReport: childCollection("ServiceReport"),
    Invoice: childCollection("Invoice"),
  },
};

vi.mock("../shared/dataClient", () => ({ dataClient: async () => fakeDataClient }));
vi.mock("../shared/email", () => ({
  emailShell: (h: string, b: string) => `${h}${b}`,
  notifyOffice: async () => true,
  sendEmail: async () => true,
}));
const workOpened: Record<string, unknown>[] = [];
vi.mock("../shared/ownedWork", () => ({
  openOwnedWork: async (o: Record<string, unknown>) => {
    workOpened.push(o);
    return "w1";
  },
  openMissingContactWork: async () => null,
}));

const { handler } = await import("./handler");

const call = (args: Record<string, unknown>) =>
  (handler as unknown as (e: unknown) => Promise<unknown>)({
    info: { fieldName: "setCustomerGroup" },
    arguments: args,
    identity: {
      sub: "own-1",
      groups: ["OWNER"],
      claims: { email: "jake@getgim.com" },
    },
  });

const resume = (commandId: string) =>
  (handler as unknown as (e: unknown) => Promise<unknown>)({
    info: { fieldName: "resumeGroupChange" },
    arguments: { commandId },
    identity: null,
    source: "daily-reminders-resumer",
  });

beforeEach(() => {
  customers.clear();
  groups.clear();
  commands.clear();
  auditEvents.length = 0;
  auditFails = false;
  customerPatches = [];
  workOpened.length = 0;
  cognitoGroups = [];
  cognitoApplyFails = false;
  childRows.clear();
  childRows.set("Invoice", [
    { id: "inv-1", customerId: "c1", accessGroups: ["cus-c1"] },
  ]);
  customers.set("c1", {
    id: "c1",
    displayName: "Maple Ridge HOA",
    groupId: null,
    email: "hoa@example.com",
    portalUserSub: "sub-1",
  });
  groups.set("g1", { id: "g1", name: "Maple Ridge", accessGroups: ["grp-g1"] });
  _setLockStoreForTests(
    memoryLockStore({
      GroupChangeCommand: commands,
    })
  );
});

describe("setCustomerGroup — the durable verified command", () => {
  it("runs audit → customer → children → Cognito → VERIFY and settles COMPLETE", async () => {
    const res = (await call({
      customerId: "c1",
      groupId: "g1",
      reason: "New property manager",
    })) as Record<string, unknown>;

    expect(res.verified).toBe(true);
    // Audit landed with who/when/why.
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      action: "GROUP_CHANGE",
      reason: "New property manager",
      effects: "group: none → g1",
    });
    // Customer row + children + Cognito all converged.
    expect(customers.get("c1")!.groupId).toBe("g1");
    expect(childRows.get("Invoice")![0].accessGroups).toEqual([
      "cus-c1",
      "grp-g1",
    ]);
    expect(cognitoGroups).toEqual(["grp-g1"]);
    // The command is settled COMPLETE with a verification stamp.
    const cmd = [...commands.values()][0];
    expect(cmd.stage).toBe("COMPLETE");
    expect(cmd.verifiedAt).toBeTruthy();
  });

  it("REFUSES the change when the audit write fails — nothing applied", async () => {
    auditFails = true;

    await expect(
      call({ customerId: "c1", groupId: "g1", reason: "New manager" })
    ).rejects.toThrow(/NOT changed/);

    expect(customers.get("c1")!.groupId).toBeNull();
    expect(customerPatches).toHaveLength(0);
    const cmd = [...commands.values()][0];
    expect(cmd.stage).toBe("FAILED");
  });

  it("records a system reason when none is given — the change is never left unexplained", async () => {
    const res = (await call({ customerId: "c1", groupId: "g1", reason: " " })) as Record<
      string,
      unknown
    >;

    expect(res.verified).toBe(true);
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      action: "GROUP_CHANGE",
      reason: "Group membership updated via CRM.",
    });
    expect(customers.get("c1")!.groupId).toBe("g1");
  });

  it("a Cognito fault settles PARTIAL with owned work — never a silent split", async () => {
    cognitoGroups = ["grp-old"];
    cognitoApplyFails = true;

    await expect(
      call({ customerId: "c1", groupId: "g1", reason: "New manager" })
    ).rejects.toThrow(/PARTIALLY applied/);

    const cmd = [...commands.values()][0];
    expect(cmd.stage).toBe("PARTIAL");
    expect(String(cmd.lastError)).toContain("Cognito");
    expect(
      workOpened.some((w) => w.kind === "STATE_MISMATCH")
    ).toBe(true);
    // The DB surfaces did change (stages before the fault) — the command
    // remembers exactly how far it got.
    expect(customers.get("c1")!.groupId).toBe("g1");
  });

  it("resume re-drives a PARTIAL to a VERIFIED completion", async () => {
    cognitoGroups = ["grp-old"];
    cognitoApplyFails = true;
    await expect(
      call({ customerId: "c1", groupId: "g1", reason: "New manager" })
    ).rejects.toThrow(/PARTIALLY applied/);
    const cmdId = [...commands.keys()][0];

    cognitoApplyFails = false;
    const res = (await resume(cmdId)) as Record<string, unknown>;

    expect(res.stage).toBe("COMPLETE");
    expect(cognitoGroups).toEqual(["grp-g1"]);
    expect(commands.get(cmdId)!.verifiedAt).toBeTruthy();
  });

  it("a DIFFERENT target is refused while a change is mid-flight", async () => {
    cognitoApplyFails = true;
    await expect(
      call({ customerId: "c1", groupId: "g1", reason: "First change" })
    ).rejects.toThrow(/PARTIALLY applied/);
    groups.set("g2", { id: "g2", name: "Other", accessGroups: ["grp-g2"] });

    await expect(
      call({ customerId: "c1", groupId: "g2", reason: "Second change" })
    ).rejects.toThrow(/mid-flight/);
  });

  it("verification catches a surface that silently disagrees — PARTIAL, not COMPLETE", async () => {
    // A child updater that lies: reports success but never applies.
    const invoices = childRows.get("Invoice")!;
    (fakeDataClient.models.Invoice as { update: unknown }).update = async (
      p: Row
    ) => ({ data: p }); // no-op — the row keeps its stale access groups

    await expect(
      call({ customerId: "c1", groupId: "g1", reason: "New manager" })
    ).rejects.toThrow(/PARTIALLY applied/);

    const cmd = [...commands.values()][0];
    expect(cmd.stage).toBe("PARTIAL");
    expect(String(cmd.lastError)).toContain("stale access groups");
    expect(invoices[0].accessGroups).toEqual(["cus-c1"]);
  });
});
