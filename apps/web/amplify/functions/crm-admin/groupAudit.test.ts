import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GL-11 reopened — group-membership changes are DURABLY audited: the
 * who/when/why record lands BEFORE the change, a failed audit write refuses
 * the change with nothing applied (log lines are not an audit), and the
 * "why" is mandatory.
 */

process.env.AMPLIFY_AUTH_USERPOOL_ID = "pool-1";

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
      async send(c: { __type: string }) {
        if (c.__type === "ListGroups") return { Groups: [] };
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
const auditEvents: Row[] = [];
let auditFails = false;
let customerPatches: Row[] = [];

const childCollection = () => ({
  list: async () => ({ data: [], nextToken: null }),
  update: async (p: Row) => ({ data: p }),
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
      create: async (input: Record<string, unknown>) => {
        if (auditFails) return { data: null, errors: [{ message: "refused" }] };
        auditEvents.push({ id: `ev-${auditEvents.length}`, ...input });
        return { data: auditEvents[auditEvents.length - 1] };
      },
    },
    ServicePlan: childCollection(),
    Job: childCollection(),
    Agreement: childCollection(),
    ServiceReport: childCollection(),
    Invoice: childCollection(),
  },
};

vi.mock("../shared/dataClient", () => ({ dataClient: async () => fakeDataClient }));
vi.mock("../shared/email", () => ({
  emailShell: (h: string, b: string) => `${h}${b}`,
  notifyOffice: async () => true,
  sendEmail: async () => true,
}));
vi.mock("../shared/ownedWork", () => ({
  openOwnedWork: async () => "w1",
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

beforeEach(() => {
  customers.clear();
  groups.clear();
  auditEvents.length = 0;
  auditFails = false;
  customerPatches = [];
  customers.set("c1", {
    id: "c1",
    displayName: "Maple Ridge HOA",
    groupId: null,
    email: "hoa@example.com",
  });
  groups.set("g1", { id: "g1", name: "Maple Ridge", accessGroups: ["grp-g1"] });
});

describe("setCustomerGroup — durable audit", () => {
  it("records who/when/why BEFORE applying, and applies the change", async () => {
    await call({ customerId: "c1", groupId: "g1", reason: "New property manager" });

    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      action: "GROUP_CHANGE",
      actorEmail: "jake@getgim.com",
      reason: "New property manager",
      effects: "group: none → g1",
    });
    expect(customers.get("c1")!.groupId).toBe("g1");
  });

  it("REFUSES the change when the audit write fails — nothing applied, no log-only evidence", async () => {
    auditFails = true;

    await expect(
      call({ customerId: "c1", groupId: "g1", reason: "New property manager" })
    ).rejects.toThrow(/NOT changed/);

    expect(customers.get("c1")!.groupId).toBeNull();
    expect(customerPatches).toHaveLength(0);
  });

  it("REFUSES a change without a reason — the why is retained, not optional", async () => {
    await expect(call({ customerId: "c1", groupId: "g1", reason: "  " })).rejects.toThrow(
      /reason is required/i
    );
    expect(auditEvents).toHaveLength(0);
    expect(customers.get("c1")!.groupId).toBeNull();
  });
});
