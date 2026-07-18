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
/** An ordered log of the Cognito commands and the technician-deactivation write,
 *  so a test can prove access was revoked BEFORE any downstream data change. */
const timeline: string[] = [];

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
        timeline.push(c.__type);
        const username = c.input.Username as string;
        if (c.__type === "ListGroups") {
          return { Groups: groupsFor(username).map((g) => ({ GroupName: g })) };
        }
        if (c.__type === "AddToGroup" || c.__type === "RemoveFromGroup") {
          // Apply the membership change to the fake pool so a later ListGroups —
          // e.g. the effective-roles read-back after changeStaffRoles — sees the
          // real end state, exactly as Cognito would.
          const group = c.input.GroupName as string;
          const u = pool.get(username);
          if (c.__type === "AddToGroup") {
            if (u) {
              if (!u.groups.includes(group)) u.groups.push(group);
            } else if (!userGroups.includes(group)) userGroups = [...userGroups, group];
          } else {
            if (u) u.groups = u.groups.filter((g) => g !== group);
            else userGroups = userGroups.filter((g) => g !== group);
          }
          return {};
        }
        if (c.__type === "Disable" || c.__type === "Enable") {
          // Reflect the enabled state in the pool so a later read-back
          // (readLoginEnabled) sees the real state, exactly as Cognito would.
          const u = pool.get(username);
          if (u) u.enabled = c.__type === "Enable";
          return {};
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
/** Rows written to the append-only staff-access ledger (StaffAccessEvent). */
const staffAccessEvents: Record<string, unknown>[] = [];
/** Owned-work rows opened via openOwnedWork — keyed by the deterministic id. */
const workItems = new Map<string, Record<string, unknown>>();
/** Force the technician-deactivation write to fail, so a test can drive the
 *  fail-safe "access removed, downstream owned by a case" (PARTIAL) path. */
let technicianUpdateThrows = false;
/** Force the audit-ledger write to fail, so a test can drive the durable-ledger
 *  "security case + PARTIAL" path. */
let staffEventCreateThrows = false;

const fakeDataClient = {
  models: {
    Customer: {
      get: async ({ id }: { id: string }) => ({ data: customers.get(id) ?? null }),
      update: async (patch: Partial<Customer> & { id: string }) => {
        customers.set(patch.id, { ...customers.get(patch.id)!, ...patch });
        return { data: customers.get(patch.id) };
      },
      // GL-14 R6: the offboard reassigns the departing person's leads.
      listCustomerByStatusAndDisplayName: async ({
        status,
      }: {
        status: string;
      }) => ({
        data: [...customers.values()].filter(
          (c) => (c as { status?: string }).status === status
        ),
        nextToken: null,
      }),
    },
    Technician: {
      get: async ({ id }: { id: string }) => ({ data: technicians.get(id) ?? null }),
      update: async (patch: Partial<Technician> & { id: string }) => {
        if (technicianUpdateThrows) throw new Error("Technician.update failed (injected)");
        timeline.push("TechUpdate");
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
    StaffAccessEvent: {
      create: async (row: Record<string, unknown>) => {
        if (staffEventCreateThrows) throw new Error("ledger write failed (injected)");
        staffAccessEvents.push(row);
        return { data: row };
      },
      listStaffAccessEventByIdempotencyKey: async ({
        idempotencyKey,
      }: {
        idempotencyKey: string;
      }) => ({
        data: staffAccessEvents.filter((r) => r.idempotencyKey === idempotencyKey),
      }),
    },
    WorkItem: {
      get: async ({ id }: { id: string }) => ({ data: workItems.get(id) ?? null }),
      create: async (row: Record<string, unknown>) => {
        workItems.set(row.id as string, row);
        return { data: row };
      },
      update: async (patch: Record<string, unknown> & { id: string }) => {
        workItems.set(patch.id, { ...workItems.get(patch.id), ...patch });
        return { data: workItems.get(patch.id) };
      },
      // GL-14 R5: the offboard releases claimed exceptions owned by the departing
      // person; the release lists OPEN items filtered by ownerSub.
      list: async ({
        filter,
      }: {
        filter?: { status?: { eq?: string }; ownerSub?: { eq?: string } };
      } = {}) => ({
        data: [...workItems.values()].filter(
          (w) =>
            (filter?.status?.eq === undefined || w.status === filter.status.eq) &&
            (filter?.ownerSub?.eq === undefined ||
              w.ownerSub === filter.ownerSub.eq)
        ),
        nextToken: null,
      }),
    },
    WorkEvent: {
      create: async (row: Record<string, unknown>) => ({ data: row }),
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

const call = (field: string, args: Record<string, unknown>) => {
  // GL-14 requires a controlled reason on staff-access changes. Default one in
  // for the many tests that aren't about the reason itself, so they still reach
  // the behavior they assert; tests that check the reason pass their own.
  const needsReason =
    (field === "changeStaffRoles" || field === "offboardStaff") &&
    args.reasonCode === undefined;
  const arguments_ = needsReason
    ? { ...args, reasonCode: field === "offboardStaff" ? "ROLE_ENDED" : "REASSIGNMENT" }
    : args;
  return (handler as unknown as (e: unknown) => Promise<unknown>)({
    info: { fieldName: field },
    arguments: arguments_,
    identity: {
      sub: "owner-1",
      groups: ["OWNER"],
      username: "owner@x.com",
      claims: { email: "owner@x.com" },
    },
  });
};

const sentTypes = () => sends.map((s) => s.type);

/** A licence date comfortably in the future, so an "active" tech is compliant. */
const FUTURE_LICENSE = "2099-12-31";

beforeEach(() => {
  sends.length = 0;
  timeline.length = 0;
  userGroups = [];
  pool.clear();
  customers.clear();
  technicians.clear();
  jobs.clear();
  staffAccessEvents.length = 0;
  workItems.clear();
  technicianUpdateThrows = false;
  staffEventCreateThrows = false;
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

  it("records the reasoned change in the ledger with actor, prior/effective roles, and reports convergence", async () => {
    pool.set("dana@x.com", {
      username: "dana@x.com",
      sub: "sub-dana",
      email: "dana@x.com",
      groups: ["OFFICE"],
    });

    const res = (await call("changeStaffRoles", {
      email: "dana@x.com",
      roles: ["OFFICE", "FINANCE"],
      reason: "took over refunds",
    })) as { effectiveRoles: string[]; converged: boolean };

    // The end state is read back from Cognito, not assumed from the request.
    expect(res.converged).toBe(true);
    expect(res.effectiveRoles.sort()).toEqual(["FINANCE", "OFFICE"]);

    expect(staffAccessEvents).toHaveLength(1);
    expect(staffAccessEvents[0]).toMatchObject({
      subjectEmail: "dana@x.com",
      action: "CHANGE_ROLES",
      actorEmail: "owner@x.com",
      reason: "took over refunds",
      priorRoles: "OFFICE",
      outcome: "COMPLETE",
    });
    expect(staffAccessEvents[0].newRoles).toMatch(/FINANCE/);
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

  it("revokes access (disable + sign out) before any downstream technician change", async () => {
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

    await call("offboardStaff", { email: "marcus@buzzkill.com" });

    // Access removal (Disable + SignOut) must land before the technician is
    // flipped inactive — removing access is the security-critical step and can
    // never wait on a downstream write.
    const disableAt = timeline.indexOf("Disable");
    const signOutAt = timeline.indexOf("SignOut");
    const techUpdateAt = timeline.indexOf("TechUpdate");
    expect(disableAt).toBeGreaterThanOrEqual(0);
    expect(techUpdateAt).toBeGreaterThan(disableAt);
    expect(techUpdateAt).toBeGreaterThan(signOutAt);
  });

  it("records the offboarding in the ledger with actor, reason, and effects", async () => {
    pool.set("finance@x.com", {
      username: "finance@x.com",
      sub: "sub-fin",
      email: "finance@x.com",
      groups: ["FINANCE", "OFFICE"],
    });

    await call("offboardStaff", { email: "finance@x.com", reason: "left the company" });

    expect(staffAccessEvents).toHaveLength(1);
    expect(staffAccessEvents[0]).toMatchObject({
      subjectEmail: "finance@x.com",
      action: "OFFBOARD",
      actorEmail: "owner@x.com",
      reason: "left the company",
      newRoles: undefined,
      outcome: "COMPLETE",
    });
    expect(staffAccessEvents[0].effects).toMatch(/disabled and globally signed out/i);
  });

  it("on a partial downstream failure keeps access removed, opens an owned case, and reports PARTIAL without throwing", async () => {
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
    technicianUpdateThrows = true;

    const res = (await call("offboardStaff", { email: "marcus@buzzkill.com" })) as {
      loginDisabled: boolean;
      outcome: string;
      technicianDeactivated: boolean;
    };

    // Access was still removed — the fail-safe guarantee.
    expect(res.loginDisabled).toBe(true);
    expect(sentTypes()).toContain("Disable");
    expect(sentTypes()).toContain("SignOut");
    // But the downstream effect didn't finish, so it's PARTIAL, not a clean win.
    expect(res.outcome).toBe("PARTIAL");
    expect(res.technicianDeactivated).toBe(false);
    // An owned OPS case with a safe resume was opened.
    const staffCase = [...workItems.values()].find((w) => w.kind === "STAFF_OFFBOARD");
    expect(staffCase).toBeDefined();
    expect(String(staffCase!.resolutionAction)).toMatch(/re-run offboard/i);
    // And the ledger records the partial outcome.
    expect(staffAccessEvents[0]).toMatchObject({ action: "OFFBOARD", outcome: "PARTIAL" });
  });
});

describe("GL-14 hardening — reason, sessions, ordering, idempotency, read-back", () => {
  it("refuses a role change with no controlled reason, and OTHER without a note", async () => {
    pool.set("dana@x.com", {
      username: "dana@x.com",
      sub: "sub-dana",
      email: "dana@x.com",
      groups: ["OFFICE"],
    });
    await expect(
      call("changeStaffRoles", {
        email: "dana@x.com",
        roles: ["OFFICE", "FINANCE"],
        reasonCode: "",
      })
    ).rejects.toThrow(/reason is required/i);
    await expect(
      call("changeStaffRoles", {
        email: "dana@x.com",
        roles: ["OFFICE", "FINANCE"],
        reasonCode: "OTHER",
      })
    ).rejects.toThrow(/needs a short written note/i);
    // Nothing was changed on either refusal.
    expect(sentTypes()).not.toContain("AddToGroup");
  });

  it("refuses an unknown reason code", async () => {
    pool.set("dana@x.com", {
      username: "dana@x.com",
      sub: "sub-dana",
      email: "dana@x.com",
      groups: ["OFFICE"],
    });
    await expect(
      call("changeStaffRoles", {
        email: "dana@x.com",
        roles: ["FINANCE"],
        reasonCode: "BECAUSE",
      })
    ).rejects.toThrow(/isn't a valid reason/i);
  });

  it("ends the person's sessions on a demotion (removing a role signs them out)", async () => {
    pool.set("dana@x.com", {
      username: "dana@x.com",
      sub: "sub-dana",
      email: "dana@x.com",
      groups: ["OFFICE", "FINANCE"],
    });
    const res = (await call("changeStaffRoles", {
      email: "dana@x.com",
      roles: ["OFFICE"],
      reasonCode: "REDUCE_ACCESS",
    })) as { sessionsInvalidated: boolean; removed: string[] };
    expect(res.removed).toEqual(["FINANCE"]);
    expect(res.sessionsInvalidated).toBe(true);
    expect(sentTypes()).toContain("SignOut");
    expect(staffAccessEvents[0]).toMatchObject({
      action: "CHANGE_ROLES",
      reasonCode: "REDUCE_ACCESS",
    });
  });

  it("does NOT sign out when a change only adds a role", async () => {
    pool.set("dana@x.com", {
      username: "dana@x.com",
      sub: "sub-dana",
      email: "dana@x.com",
      groups: ["OFFICE"],
    });
    const res = (await call("changeStaffRoles", {
      email: "dana@x.com",
      roles: ["OFFICE", "FINANCE"],
      reasonCode: "PROMOTION",
    })) as { sessionsInvalidated: boolean };
    expect(res.sessionsInvalidated).toBe(false);
    expect(sentTypes()).not.toContain("SignOut");
  });

  it("offboarding disables and signs out BEFORE removing any group", async () => {
    pool.set("finance@x.com", {
      username: "finance@x.com",
      sub: "sub-fin",
      email: "finance@x.com",
      groups: ["FINANCE", "OFFICE"],
    });
    await call("offboardStaff", { email: "finance@x.com", reasonCode: "DEPARTURE_VOLUNTARY" });
    const disableAt = timeline.indexOf("Disable");
    const signOutAt = timeline.indexOf("SignOut");
    const firstRemove = timeline.indexOf("RemoveFromGroup");
    expect(disableAt).toBeGreaterThanOrEqual(0);
    expect(signOutAt).toBeGreaterThan(disableAt);
    // Access is cut before the role set is even touched.
    expect(firstRemove).toBeGreaterThan(signOutAt);
  });

  it("confirms the login disabled and the technician inactive before reporting COMPLETE", async () => {
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
    const res = (await call("offboardStaff", {
      email: "marcus@buzzkill.com",
      reasonCode: "SECURITY",
    })) as { outcome: string; loginDisabled: boolean; technicianConfirmedInactive: boolean };
    expect(res.loginDisabled).toBe(true);
    expect(res.technicianConfirmedInactive).toBe(true);
    expect(res.outcome).toBe("COMPLETE");
  });

  it("puts each in-progress visit in an owned Operations review", async () => {
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
    jobs.set("live", {
      id: "live",
      technicianId: "t1",
      status: "IN_PROGRESS",
      scheduledDate: "2026-07-18",
    });
    const res = (await call("offboardStaff", {
      email: "marcus@buzzkill.com",
      reasonCode: "ROLE_ENDED",
    })) as { inProgressCount: number };
    expect(res.inProgressCount).toBe(1);
    const review = [...workItems.values()].find((w) =>
      String(w.title).match(/in-progress visit left/i)
    );
    expect(review).toBeDefined();
  });

  it("is idempotent by key — a replay returns the recorded outcome without a second disable", async () => {
    pool.set("finance@x.com", {
      username: "finance@x.com",
      sub: "sub-fin",
      email: "finance@x.com",
      groups: ["FINANCE"],
    });
    await call("offboardStaff", {
      email: "finance@x.com",
      reasonCode: "DEPARTURE_VOLUNTARY",
      idempotencyKey: "req-1",
    });
    sends.length = 0;
    const res = (await call("offboardStaff", {
      email: "finance@x.com",
      reasonCode: "DEPARTURE_VOLUNTARY",
      idempotencyKey: "req-1",
    })) as { deduped: boolean };
    expect(res.deduped).toBe(true);
    // No Cognito action on the replay.
    expect(sentTypes()).not.toContain("Disable");
    // Only one ledger row exists for the key.
    expect(staffAccessEvents.filter((e) => e.idempotencyKey === "req-1")).toHaveLength(1);
  });

  it("opens a security case and reports PARTIAL when the audit row cannot be written", async () => {
    pool.set("finance@x.com", {
      username: "finance@x.com",
      sub: "sub-fin",
      email: "finance@x.com",
      groups: ["FINANCE"],
    });
    staffEventCreateThrows = true;
    const res = (await call("offboardStaff", {
      email: "finance@x.com",
      reasonCode: "DEPARTURE_VOLUNTARY",
    })) as { ledgerRecorded: boolean; outcome: string };
    expect(res.ledgerRecorded).toBe(false);
    expect(res.outcome).toBe("PARTIAL");
    const securityCase = [...workItems.values()].find(
      (w) => w.kind === "STAFF_SECURITY"
    );
    expect(securityCase).toBeDefined();
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
      attributes: { "custom:lastLoginAt": "2026-07-18T10:00:00.000Z" },
    });
    pool.set("tech@x.com", {
      username: "tech@x.com",
      sub: "sub-tech",
      email: "tech@x.com",
      name: "Terry Tech",
      groups: ["TECH"],
      // A pending, unredeemed invite that has never been used to sign in.
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
        lastLoginAt: string | null;
      }[];
    };

    // Owner sorts first.
    expect(res.staff[0].email).toBe("owner@x.com");
    // Last login is surfaced for a user who has signed in, and null for one who
    // has only ever been invited.
    expect(res.staff[0].lastLoginAt).toBe("2026-07-18T10:00:00.000Z");
    const tech = res.staff.find((s) => s.email === "tech@x.com")!;
    expect(tech.roles).toEqual(["TECH"]);
    expect(tech.unlinkedTech).toBe(true);
    expect(tech.pendingInvite).toBe(true);
    expect(tech.lastLoginAt).toBeNull();
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
    // GL-14 R2: a tech with a login is now offboarded through the ONE hardened
    // workflow, so the login must resolve in the Cognito pool.
    pool.set("marcus@buzzkill.com", {
      username: "marcus@buzzkill.com",
      sub: "sub-tech-1",
      email: "marcus@buzzkill.com",
      groups: ["TECH"],
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
