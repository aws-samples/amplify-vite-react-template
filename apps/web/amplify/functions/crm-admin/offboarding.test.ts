import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Staff identity, linking, and offboarding — the Cognito + data side of GL-14.
 *
 * The bar these hold:
 *  - A technician login is created atomically linked to one active, licensed
 *    Technician, or refused with a fixable error — "invite now, link later"
 *    is gone, and one technician record maps to exactly one login.
 *  - A deactivated portal customer and an offboarded staff member actually lose
 *    access — the account is disabled AND its live sessions are killed (global
 *    sign-out), not merely flagged inactive — and an offboarded technician's
 *    future work returns to the pool for reassignment.
 *  - The system is never left without a usable owner: the last owner cannot be
 *    offboarded or stripped of the OWNER role.
 */

process.env.AMPLIFY_AUTH_USERPOOL_ID = "pool-1";

type Send = { type: string; input: Record<string, unknown> };
const sends: Send[] = [];

/** A Cognito user in the fake pool. */
type PoolUser = {
  username: string;
  sub: string;
  email?: string;
  name?: string;
  enabled?: boolean;
  status?: string;
  groups: string[];
  attributes?: Record<string, string>;
};
const pool = new Map<string, PoolUser>();
/** Legacy single-user group list, still used by the customer/technician tests
 *  that operate on one known login. Falls back to this when a username is not
 *  in the pool map. */
let userGroups: string[] = [];

function attrsOf(u: PoolUser) {
  return [
    { Name: "sub", Value: u.sub },
    ...(u.email ? [{ Name: "email", Value: u.email }] : []),
    ...(u.name ? [{ Name: "name", Value: u.name }] : []),
    ...Object.entries(u.attributes ?? {}).map(([Name, Value]) => ({
      Name,
      Value,
    })),
  ];
}

function groupsFor(username: string): string[] {
  return pool.get(username)?.groups ?? userGroups;
}

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
        const username = c.input.Username as string;
        if (c.__type === "ListGroups") {
          return { Groups: groupsFor(username).map((g) => ({ GroupName: g })) };
        }
        if (c.__type === "GetUser") {
          const u = pool.get(username);
          if (!u) {
            const err = new Error("user not found") as Error & { name: string };
            err.name = "UserNotFoundException";
            throw err;
          }
          return {
            Username: u.username,
            Enabled: u.enabled ?? true,
            UserStatus: u.status ?? "CONFIRMED",
            UserAttributes: attrsOf(u),
          };
        }
        if (c.__type === "ListUsersInGroup") {
          const group = c.input.GroupName as string;
          const members = [...pool.values()].filter((u) =>
            u.groups.includes(group)
          );
          return {
            Users: members.map((u) => ({
              Username: u.username,
              Enabled: u.enabled ?? true,
              UserStatus: u.status ?? "CONFIRMED",
              Attributes: attrsOf(u),
            })),
          };
        }
        if (c.__type === "CreateUser") {
          const email = username;
          return {
            User: {
              Username: email,
              Attributes: [{ Name: "sub", Value: `sub-${email}` }],
            },
          };
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
  licenseNumber?: string | null;
  licenseExpiresOn?: string | null;
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
      listTechnicianByUserSub: async ({ userSub }: { userSub: string }) => ({
        data: [...technicians.values()].filter((t) => t.userSub === userSub),
      }),
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

/** A licence date comfortably in the future, so an "active" tech is compliant. */
const FUTURE_LICENSE = "2099-12-31";

beforeEach(() => {
  sends.length = 0;
  userGroups = [];
  pool.clear();
  customers.clear();
  technicians.clear();
  jobs.clear();
  notifyOffice.mockClear();
  sendEmail.mockClear();
});

describe("adminCreateUser — atomic technician linking (GL-14)", () => {
  it("refuses a technician login with no linked technician (no invite-now-link-later)", async () => {
    await expect(
      call("adminCreateUser", {
        email: "newtech@buzzkill.com",
        name: "New Tech",
        roles: ["TECH"],
      })
    ).rejects.toThrow(/must be linked to a technician record/i);
    // Nothing was provisioned — the refusal left no half-built Cognito user.
    expect(sentTypes()).not.toContain("CreateUser");
  });

  it("refuses linking a technician whose licence is missing/expired", async () => {
    technicians.set("t-nolic", {
      id: "t-nolic",
      name: "Unlicensed",
      active: true,
      licenseNumber: null,
      licenseExpiresOn: null,
    });
    await expect(
      call("adminCreateUser", {
        email: "unlic@buzzkill.com",
        name: "Unlicensed",
        roles: ["TECH"],
        technicianId: "t-nolic",
      })
    ).rejects.toThrow(/licen[sc]e/i);
    expect(sentTypes()).not.toContain("CreateUser");
  });

  it("refuses linking a technician already bound to another login (shared identity)", async () => {
    technicians.set("t-linked", {
      id: "t-linked",
      name: "Marcus",
      active: true,
      licenseNumber: "APP-1",
      licenseExpiresOn: FUTURE_LICENSE,
      userSub: "sub-someone-else",
      email: "marcus@buzzkill.com",
    });
    await expect(
      call("adminCreateUser", {
        email: "different@buzzkill.com",
        name: "Impostor",
        roles: ["TECH"],
        technicianId: "t-linked",
      })
    ).rejects.toThrow(/already linked/i);
    expect(sentTypes()).not.toContain("CreateUser");
  });

  it("refuses a technicianId when the role set has no TECH role", async () => {
    technicians.set("t1", {
      id: "t1",
      name: "Marcus",
      active: true,
      licenseNumber: "APP-1",
      licenseExpiresOn: FUTURE_LICENSE,
    });
    await expect(
      call("adminCreateUser", {
        email: "office@buzzkill.com",
        name: "Office",
        roles: ["OFFICE"],
        technicianId: "t1",
      })
    ).rejects.toThrow(/no TECH role/i);
  });

  it("creates and links a technician login atomically when the record is compliant", async () => {
    technicians.set("t1", {
      id: "t1",
      name: "Marcus",
      active: true,
      licenseNumber: "APP-1",
      licenseExpiresOn: FUTURE_LICENSE,
    });
    const res = (await call("adminCreateUser", {
      email: "Marcus@BuzzKill.com",
      name: "Marcus",
      roles: ["TECH"],
      technicianId: "t1",
    })) as { groupsAdded: string[]; linkSent: boolean };

    expect(res.groupsAdded).toContain("TECH");
    // The technician record now carries the created login's sub + email.
    expect(technicians.get("t1")).toMatchObject({
      userSub: "sub-marcus@buzzkill.com",
      email: "marcus@buzzkill.com",
    });
  });
});

describe("changeStaffRoles (GL-14)", () => {
  it("adds and removes the right groups", async () => {
    pool.set("dana@x.com", {
      username: "dana@x.com",
      sub: "sub-dana",
      email: "dana@x.com",
      groups: ["OFFICE"],
    });
    const res = (await call("changeStaffRoles", {
      email: "dana@x.com",
      roles: ["OFFICE", "FINANCE"],
    })) as { added: string[]; removed: string[] };

    expect(res.added).toEqual(["FINANCE"]);
    expect(res.removed).toEqual([]);
    const added = sends
      .filter((s) => s.type === "AddToGroup")
      .map((s) => s.input.GroupName);
    expect(added).toContain("FINANCE");
  });

  it("refuses granting TECH to a login with no linked technician", async () => {
    pool.set("dana@x.com", {
      username: "dana@x.com",
      sub: "sub-dana",
      email: "dana@x.com",
      groups: ["OFFICE"],
    });
    await expect(
      call("changeStaffRoles", { email: "dana@x.com", roles: ["OFFICE", "TECH"] })
    ).rejects.toThrow(/isn't linked to a technician record/i);
  });

  it("refuses an empty role set (offboard instead)", async () => {
    pool.set("dana@x.com", {
      username: "dana@x.com",
      sub: "sub-dana",
      email: "dana@x.com",
      groups: ["OFFICE"],
    });
    await expect(
      call("changeStaffRoles", { email: "dana@x.com", roles: [] })
    ).rejects.toThrow(/at least one role/i);
  });

  it("will not strip OWNER from the last usable owner", async () => {
    pool.set("solo@x.com", {
      username: "solo@x.com",
      sub: "sub-solo",
      email: "solo@x.com",
      groups: ["OWNER"],
    });
    await expect(
      call("changeStaffRoles", { email: "solo@x.com", roles: ["OFFICE"] })
    ).rejects.toThrow(/last active owner/i);
  });

  it("allows demoting an owner when a second owner exists", async () => {
    pool.set("solo@x.com", {
      username: "solo@x.com",
      sub: "sub-solo",
      email: "solo@x.com",
      groups: ["OWNER"],
    });
    pool.set("second@x.com", {
      username: "second@x.com",
      sub: "sub-second",
      email: "second@x.com",
      groups: ["OWNER"],
    });
    const res = (await call("changeStaffRoles", {
      email: "solo@x.com",
      roles: ["OFFICE"],
    })) as { removed: string[] };
    expect(res.removed).toContain("OWNER");
  });
});

describe("offboardStaff (GL-14)", () => {
  it("disables, signs out, and removes every staff + dynamic group", async () => {
    pool.set("finance@x.com", {
      username: "finance@x.com",
      sub: "sub-fin",
      email: "finance@x.com",
      groups: ["FINANCE", "OFFICE", "cus-c1"],
    });
    const res = (await call("offboardStaff", { email: "finance@x.com" })) as {
      loginDisabled: boolean;
      rolesRemoved: string[];
    };

    expect(res.loginDisabled).toBe(true);
    expect(sentTypes()).toContain("Disable");
    expect(sentTypes()).toContain("SignOut");
    const removed = sends
      .filter((s) => s.type === "RemoveFromGroup")
      .map((s) => s.input.GroupName);
    expect(removed).toEqual(expect.arrayContaining(["FINANCE", "OFFICE", "cus-c1"]));
    expect(res.rolesRemoved.sort()).toEqual(["FINANCE", "OFFICE"]);
  });

  it("returns a linked technician's future work to the pool and flips them inactive", async () => {
    pool.set("marcus@buzzkill.com", {
      username: "marcus@buzzkill.com",
      sub: "sub-marcus",
      email: "marcus@buzzkill.com",
      groups: ["TECH"],
    });
    technicians.set("t1", {
      id: "t1",
      name: "Marcus",
      active: true,
      userSub: "sub-marcus",
      email: "marcus@buzzkill.com",
      licenseNumber: "APP-1",
      licenseExpiresOn: FUTURE_LICENSE,
    });
    jobs.set("future", {
      id: "future",
      technicianId: "t1",
      status: "SCHEDULED",
      scheduledDate: "2099-01-01",
      routeId: "r1",
      routeOrder: 3,
    });

    const res = (await call("offboardStaff", { email: "marcus@buzzkill.com" })) as {
      jobsUnassigned: number;
      technicianDeactivated: boolean;
    };

    expect(res.jobsUnassigned).toBe(1);
    expect(res.technicianDeactivated).toBe(true);
    expect(jobs.get("future")).toMatchObject({
      status: "UNSCHEDULED",
      technicianId: null,
      routeId: null,
    });
    expect(technicians.get("t1")!.active).toBe(false);
    expect(notifyOffice).toHaveBeenCalledOnce();
  });

  it("will not offboard the last usable owner", async () => {
    pool.set("solo@x.com", {
      username: "solo@x.com",
      sub: "sub-solo",
      email: "solo@x.com",
      groups: ["OWNER"],
    });
    await expect(
      call("offboardStaff", { email: "solo@x.com" })
    ).rejects.toThrow(/last active owner/i);
    // The refusal did not disable anyone.
    expect(sentTypes()).not.toContain("Disable");
  });

  it("offboards an owner when another owner remains", async () => {
    pool.set("solo@x.com", {
      username: "solo@x.com",
      sub: "sub-solo",
      email: "solo@x.com",
      groups: ["OWNER"],
    });
    pool.set("second@x.com", {
      username: "second@x.com",
      sub: "sub-second",
      email: "second@x.com",
      groups: ["OWNER"],
    });
    const res = (await call("offboardStaff", { email: "solo@x.com" })) as {
      loginDisabled: boolean;
    };
    expect(res.loginDisabled).toBe(true);
    expect(sentTypes()).toContain("Disable");
  });
});

describe("staffRoster (GL-14)", () => {
  it("lists staff with roles, status, and flags unlinked technicians", async () => {
    pool.set("owner@x.com", {
      username: "owner@x.com",
      sub: "sub-owner",
      email: "owner@x.com",
      name: "Olivia Owner",
      groups: ["OWNER"],
    });
    pool.set("tech@x.com", {
      username: "tech@x.com",
      sub: "sub-tech",
      email: "tech@x.com",
      name: "Terry Tech",
      groups: ["TECH"],
      // A pending, unredeemed invite.
      attributes: {
        "custom:loginTokenHash": "abc",
        "custom:loginTokenExp": String(Date.now() + 60_000),
      },
    });
    // tech@x.com has no Technician record → unlinkedTech should flag it.

    const res = (await call("staffRoster", {})) as {
      staff: {
        email: string;
        roles: string[];
        unlinkedTech: boolean;
        pendingInvite: boolean;
      }[];
    };

    // Owner sorts first.
    expect(res.staff[0].email).toBe("owner@x.com");
    const tech = res.staff.find((s) => s.email === "tech@x.com")!;
    expect(tech.roles).toEqual(["TECH"]);
    expect(tech.unlinkedTech).toBe(true);
    expect(tech.pendingInvite).toBe(true);
  });

  it("joins the linked technician and reports licence validity", async () => {
    pool.set("tech@x.com", {
      username: "tech@x.com",
      sub: "sub-tech",
      email: "tech@x.com",
      name: "Terry Tech",
      groups: ["TECH"],
    });
    technicians.set("t1", {
      id: "t1",
      name: "Terry Tech",
      active: true,
      userSub: "sub-tech",
      email: "tech@x.com",
      licenseNumber: "APP-9",
      licenseExpiresOn: FUTURE_LICENSE,
    });

    const res = (await call("staffRoster", {})) as {
      staff: {
        email: string;
        linkedTechnicianId: string | null;
        licenseValid: boolean | null;
        unlinkedTech: boolean;
      }[];
    };
    const tech = res.staff.find((s) => s.email === "tech@x.com")!;
    expect(tech.linkedTechnicianId).toBe("t1");
    expect(tech.licenseValid).toBe(true);
    expect(tech.unlinkedTech).toBe(false);
  });
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
