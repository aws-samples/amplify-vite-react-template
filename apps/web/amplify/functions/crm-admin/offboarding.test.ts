import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Offboarding's security guarantees, on the Cognito + data side.
 *
 * The bar these hold: a deactivated portal customer and an offboarded
 * technician actually lose access — the account is disabled AND its live
 * sessions are killed (global sign-out), not merely marked inactive in the
 * database — and an offboarded tech's future work returns to the pool so it
 * can be reassigned rather than vanishing onto a dead route.
 */

process.env.AMPLIFY_AUTH_USERPOOL_ID = "pool-1";

type Send = { type: string; input: Record<string, unknown> };
const sends: Send[] = [];
let userGroups: string[] = [];

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
        sends.push({ type: c.__type, input: c.input });
        if (c.__type === "ListGroups") {
          return { Groups: userGroups.map((g) => ({ GroupName: g })) };
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
  };
});

type Customer = {
  id: string;
  displayName: string;
  email?: string | null;
  status: string;
  portalUserSub?: string | null;
  groupId?: string | null;
};
type Technician = {
  id: string;
  name: string;
  email?: string | null;
  active: boolean;
  userSub?: string | null;
};
type Job = {
  id: string;
  technicianId?: string | null;
  status: string;
  scheduledDate?: string | null;
  routeId?: string | null;
  routeOrder?: number | null;
  notes?: string | null;
};

const customers = new Map<string, Customer>();
const technicians = new Map<string, Technician>();
const jobs = new Map<string, Job>();

const fakeDataClient = {
  models: {
    Customer: {
      get: async ({ id }: { id: string }) => ({ data: customers.get(id) ?? null }),
      update: async (patch: Partial<Customer> & { id: string }) => {
        customers.set(patch.id, { ...customers.get(patch.id)!, ...patch });
        return { data: customers.get(patch.id) };
      },
    },
    Technician: {
      get: async ({ id }: { id: string }) => ({ data: technicians.get(id) ?? null }),
      update: async (patch: Partial<Technician> & { id: string }) => {
        technicians.set(patch.id, { ...technicians.get(patch.id)!, ...patch });
        return { data: technicians.get(patch.id) };
      },
    },
    Job: {
      list: async ({ filter }: { filter: { technicianId: { eq: string } } }) => ({
        data: [...jobs.values()].filter(
          (j) => j.technicianId === filter.technicianId.eq
        ),
        nextToken: null,
      }),
      update: async (patch: Partial<Job> & { id: string }) => {
        jobs.set(patch.id, { ...jobs.get(patch.id)!, ...patch });
        return { data: jobs.get(patch.id) };
      },
    },
  },
};
vi.mock("../shared/dataClient", () => ({ dataClient: async () => fakeDataClient }));

const notifyOffice = vi.fn(async () => true);
const sendEmail = vi.fn(async () => true);
vi.mock("../shared/email", () => ({
  notifyOffice: (...a: unknown[]) =>
    (notifyOffice as unknown as (...x: unknown[]) => Promise<boolean>)(...a),
  sendEmail: (...a: unknown[]) =>
    (sendEmail as unknown as (...x: unknown[]) => Promise<boolean>)(...a),
  emailShell: (heading: string, body: string) => `${heading}\n${body}`,
}));

const { handler } = await import("./handler");

const call = (field: string, args: Record<string, unknown>) =>
  (handler as unknown as (e: unknown) => Promise<unknown>)({
    info: { fieldName: field },
    arguments: args,
    identity: { sub: "owner-1", groups: ["OWNER"] },
  });

const sentTypes = () => sends.map((s) => s.type);

beforeEach(() => {
  sends.length = 0;
  userGroups = [];
  customers.clear();
  technicians.clear();
  jobs.clear();
  notifyOffice.mockClear();
  sendEmail.mockClear();
});

describe("revokePortalAccess", () => {
  it("disables the account, kills its sessions, and drops its groups", async () => {
    customers.set("c1", {
      id: "c1",
      displayName: "Dana",
      email: "Dana@Example.com",
      status: "INACTIVE",
      portalUserSub: "sub-1",
    });
    userGroups = ["CUSTOMER", "cus-c1", "grp-g1", "OWNER-should-not-touch"];

    const res = (await call("revokePortalAccess", { customerId: "c1" })) as {
      revoked: boolean;
      groupsRemoved: string[];
    };

    expect(res.revoked).toBe(true);
    // Disabling alone leaves a live token valid until it expires — the global
    // sign-out is what makes access end now.
    expect(sentTypes()).toContain("Disable");
    expect(sentTypes()).toContain("SignOut");
    // Removed the portal + dynamic groups, and only those.
    expect(res.groupsRemoved.sort()).toEqual(["CUSTOMER", "cus-c1", "grp-g1"]);
    const removed = sends
      .filter((s) => s.type === "RemoveFromGroup")
      .map((s) => s.input.GroupName);
    expect(removed).not.toContain("OWNER-should-not-touch");
    // Username is the (lower-cased) email.
    expect((sends.find((s) => s.type === "Disable")!.input.Username)).toBe(
      "dana@example.com"
    );
  });

  it("is a no-op when the customer has no portal login", async () => {
    customers.set("c1", {
      id: "c1",
      displayName: "Dana",
      email: "dana@example.com",
      status: "INACTIVE",
      portalUserSub: null,
    });

    const res = (await call("revokePortalAccess", { customerId: "c1" })) as {
      revoked: boolean;
    };

    expect(res.revoked).toBe(false);
    expect(sends).toHaveLength(0);
  });
});

describe("restorePortalAccess", () => {
  it("re-enables the account and restores its groups", async () => {
    customers.set("c1", {
      id: "c1",
      displayName: "Dana",
      email: "dana@example.com",
      status: "ACTIVE",
      portalUserSub: "sub-1",
      groupId: "g1",
    });

    const res = (await call("restorePortalAccess", { customerId: "c1" })) as {
      restored: boolean;
      groupsAdded: string[];
    };

    expect(res.restored).toBe(true);
    expect(sentTypes()).toContain("Enable");
    expect(res.groupsAdded).toEqual(expect.arrayContaining(["CUSTOMER", "cus-c1", "grp-g1"]));
  });
});

describe("deactivateTechnician", () => {
  beforeEach(() => {
    technicians.set("t1", {
      id: "t1",
      name: "Marcus",
      email: "marcus@buzzkill.com",
      active: true,
      userSub: "sub-tech-1",
    });
  });

  it("returns future assigned jobs to the pool and leaves history alone", async () => {
    jobs.set("future", {
      id: "future",
      technicianId: "t1",
      status: "SCHEDULED",
      scheduledDate: "2099-01-01",
      routeId: "r1",
      routeOrder: 2,
    });
    jobs.set("done", {
      id: "done",
      technicianId: "t1",
      status: "COMPLETED",
      scheduledDate: "2026-01-01",
      routeId: "r0",
    });

    const res = (await call("deactivateTechnician", { technicianId: "t1" })) as {
      jobsUnassigned: number;
      loginDisabled: boolean;
    };

    expect(res.jobsUnassigned).toBe(1);
    expect(jobs.get("future")).toMatchObject({
      status: "UNSCHEDULED",
      routeId: null,
      routeOrder: null,
      technicianId: null,
    });
    // History is untouched.
    expect(jobs.get("done")).toMatchObject({ status: "COMPLETED", routeId: "r0" });
  });

  it("disables the login, signs it out, drops TECH, and flips active:false", async () => {
    userGroups = ["TECH"];

    const res = (await call("deactivateTechnician", { technicianId: "t1" })) as {
      loginDisabled: boolean;
    };

    expect(res.loginDisabled).toBe(true);
    expect(sentTypes()).toContain("Disable");
    expect(sentTypes()).toContain("SignOut");
    const removed = sends
      .filter((s) => s.type === "RemoveFromGroup")
      .map((s) => s.input.GroupName);
    expect(removed).toContain("TECH");
    expect(technicians.get("t1")!.active).toBe(false);
  });

  it("pages the office so the surfaced work gets reassigned", async () => {
    jobs.set("future", {
      id: "future",
      technicianId: "t1",
      status: "SCHEDULED",
      scheduledDate: "2099-01-01",
      routeId: "r1",
    });

    await call("deactivateTechnician", { technicianId: "t1" });

    expect(notifyOffice).toHaveBeenCalledOnce();
    const [alert] = notifyOffice.mock.calls[0] as unknown as [{ subject: string }];
    expect(alert.subject).toMatch(/offboarded/i);
    expect(alert.subject).toMatch(/reassignment/i);
  });

  it("still flips active:false and pages when there is no login to disable", async () => {
    technicians.set("t1", { id: "t1", name: "Marcus", active: true, userSub: null });

    const res = (await call("deactivateTechnician", { technicianId: "t1" })) as {
      loginDisabled: boolean;
    };

    expect(res.loginDisabled).toBe(false);
    expect(technicians.get("t1")!.active).toBe(false);
    expect(notifyOffice).toHaveBeenCalledOnce();
  });
});
