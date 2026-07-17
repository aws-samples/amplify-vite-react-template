import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Customer reactivation and the safe office edit — the access + status side of
 * GL-09.
 *
 * The guarantees under test:
 *  - Reactivation is ONE server action: the portal login is restored FIRST and
 *    only then is status published ACTIVE, so a paying customer is never left
 *    ACTIVE with a dead login (the exact split that used to be two client calls).
 *  - Every reactivation is written to the lifecycle ledger; an already-ACTIVE
 *    customer heals access and reports the current fact without a second, false
 *    transition.
 *  - updateCustomerContact writes only contact/address/note fields — never a
 *    protected lifecycle field — and validates the email.
 */

process.env.AMPLIFY_AUTH_USERPOOL_ID = "pool-1";

/** Ordered log of the cross-system side effects, so we can prove access is
 *  restored before status is flipped. */
let events: string[] = [];

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
        events.push(`cognito:${c.__type}`);
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

type Customer = {
  id: string;
  displayName: string;
  email?: string | null;
  status: string;
  portalUserSub?: string | null;
  groupId?: string | null;
};
const customers = new Map<string, Customer>();

/** Records every field written to a Customer, so a test can assert exactly
 *  which columns updateCustomerContact touched. */
let lastCustomerPatch: Record<string, unknown> | null = null;

const fakeDataClient = {
  models: {
    Customer: {
      get: async ({ id }: { id: string }) => ({ data: customers.get(id) ?? null }),
      update: async (patch: Partial<Customer> & { id: string }) => {
        lastCustomerPatch = patch;
        customers.set(patch.id, { ...customers.get(patch.id)!, ...patch });
        if (patch.status) events.push(`status:${patch.status}`);
        return { data: customers.get(patch.id) };
      },
    },
  },
};
vi.mock("../shared/dataClient", () => ({ dataClient: async () => fakeDataClient }));

const recordCustomerLifecycleEvent = vi.fn(async () => {
  events.push("audit");
});
vi.mock("../shared/lifecycleLog", () => ({
  recordCustomerLifecycleEvent: (...a: unknown[]) =>
    (recordCustomerLifecycleEvent as unknown as (...x: unknown[]) => Promise<void>)(
      ...a
    ),
}));

const notifyOffice = vi.fn(async () => true);
vi.mock("../shared/email", () => ({
  notifyOffice: (...a: unknown[]) =>
    (notifyOffice as unknown as (...x: unknown[]) => Promise<boolean>)(...a),
}));

const openOwnedWork = vi.fn(async () => {});
const openMissingContactWork = vi.fn(async () => {});
vi.mock("../shared/ownedWork", () => ({
  openOwnedWork: (...a: unknown[]) =>
    (openOwnedWork as unknown as (...x: unknown[]) => Promise<void>)(...a),
  openMissingContactWork: (...a: unknown[]) =>
    (openMissingContactWork as unknown as (...x: unknown[]) => Promise<void>)(...a),
}));

const { handler } = await import("./handler");

const call = (field: string, args: Record<string, unknown>) =>
  (handler as unknown as (e: unknown) => Promise<unknown>)({
    info: { fieldName: field },
    arguments: args,
    identity: {
      sub: "fin-1",
      groups: ["FINANCE"],
      claims: { email: "finance@buzzkill.com" },
    },
  });

beforeEach(() => {
  events = [];
  customers.clear();
  lastCustomerPatch = null;
  recordCustomerLifecycleEvent.mockClear();
  notifyOffice.mockClear();
  openOwnedWork.mockClear();
  openMissingContactWork.mockClear();
});

describe("reactivateCustomer (GL-09)", () => {
  it("restores portal access BEFORE flipping status, then records the transition", async () => {
    customers.set("c1", {
      id: "c1",
      displayName: "Dana Whitlock",
      email: "dana@example.com",
      status: "INACTIVE",
      portalUserSub: "sub-portal-1",
    });

    const res = (await call("reactivateCustomer", { customerId: "c1" })) as {
      reactivated: boolean;
      alreadyActive: boolean;
      portalRestored: boolean;
      status: string;
    };

    expect(res).toMatchObject({
      reactivated: true,
      alreadyActive: false,
      portalRestored: true,
      status: "ACTIVE",
    });
    expect(customers.get("c1")!.status).toBe("ACTIVE");
    // Access first: the Cognito enable happens before the ACTIVE status write,
    // so there is no window where the record reads ACTIVE with a dead login.
    expect(events.indexOf("cognito:Enable")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("cognito:Enable")).toBeLessThan(
      events.indexOf("status:ACTIVE")
    );
    // The transition is recorded for leadership.
    const [entry] = recordCustomerLifecycleEvent.mock.calls[0] as unknown as [
      { action: string; priorStatus: string; newStatus: string },
    ];
    expect(entry.action).toBe("REACTIVATE");
    expect(entry.priorStatus).toBe("INACTIVE");
    expect(entry.newStatus).toBe("ACTIVE");
  });

  it("is concurrency-safe: an already-ACTIVE customer reports the fact and records no second transition", async () => {
    customers.set("c1", {
      id: "c1",
      displayName: "Dana Whitlock",
      email: "dana@example.com",
      status: "ACTIVE",
      portalUserSub: "sub-portal-1",
    });

    const res = (await call("reactivateCustomer", { customerId: "c1" })) as {
      reactivated: boolean;
      alreadyActive: boolean;
      status: string;
    };

    expect(res).toMatchObject({ reactivated: false, alreadyActive: true, status: "ACTIVE" });
    // No status write and no second ledger row.
    expect(events).not.toContain("status:ACTIVE");
    expect(recordCustomerLifecycleEvent).not.toHaveBeenCalled();
  });

  it("no-ops portal restore for a customer that never had a login, still flips ACTIVE", async () => {
    customers.set("c1", {
      id: "c1",
      displayName: "No Portal",
      email: "np@example.com",
      status: "INACTIVE",
      portalUserSub: null,
    });

    const res = (await call("reactivateCustomer", { customerId: "c1" })) as {
      portalRestored: boolean;
      status: string;
    };

    expect(res.portalRestored).toBe(false);
    expect(customers.get("c1")!.status).toBe("ACTIVE");
    expect(recordCustomerLifecycleEvent).toHaveBeenCalledOnce();
  });

  it("throws on a missing customer rather than reporting a reactivation it did not do", async () => {
    await expect(
      call("reactivateCustomer", { customerId: "nope" })
    ).rejects.toThrow(/not found/i);
  });
});

describe("updateCustomerContact (GL-09)", () => {
  beforeEach(() => {
    customers.set("c1", {
      id: "c1",
      displayName: "Old Name",
      email: "old@example.com",
      status: "ACTIVE",
      portalUserSub: "sub-portal-1",
    });
  });

  it("writes only contact/address/note fields and never a protected lifecycle field", async () => {
    await call("updateCustomerContact", {
      customerId: "c1",
      displayName: "New Name",
      email: "New@Example.com",
      phone: "555-1000",
      serviceStreet: "1 Main St",
      notes: "gate code 4242",
    });

    // The write happened, email normalized, and the row still reads ACTIVE.
    expect(customers.get("c1")!.displayName).toBe("New Name");
    expect(customers.get("c1")!.email).toBe("new@example.com");
    expect(customers.get("c1")!.status).toBe("ACTIVE");
    // Not one protected lifecycle field is in the patch this mutation issued.
    const patched = Object.keys(lastCustomerPatch ?? {});
    for (const forbidden of [
      "status",
      "stripeCustomerId",
      "paymentMethodLabel",
      "paymentMethodKind",
      "portalUserSub",
      "accessGroups",
      "groupId",
      "convertedAt",
    ]) {
      expect(patched).not.toContain(forbidden);
    }
  });

  it("rejects an invalid email instead of saving it", async () => {
    await expect(
      call("updateCustomerContact", {
        customerId: "c1",
        displayName: "New Name",
        email: "not-an-email",
      })
    ).rejects.toThrow(/valid email/i);
    // Nothing was written.
    expect(customers.get("c1")!.displayName).toBe("Old Name");
  });

  it("requires a customer name", async () => {
    await expect(
      call("updateCustomerContact", { customerId: "c1", displayName: "   " })
    ).rejects.toThrow(/name is required/i);
  });
});
