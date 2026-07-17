import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Portal login provisioning — the shared core behind crm-admin's invite
 * buttons and bookingFinalize's provision-at-conversion (R41).
 *
 * The bar these hold: one call turns "this customer converted" into a login
 * that actually works — the Cognito account exists and is out of
 * FORCE_CHANGE_PASSWORD, the CUSTOMER + dynamic groups are granted, the
 * customer record carries the portal linkage, and the invite email holds a
 * working magic link. And the pieces are idempotent, because the caller may
 * be a retried Stripe webhook.
 */

process.env.AMPLIFY_AUTH_USERPOOL_ID = "pool-1";
process.env.CRM_APP_URL = "https://crm.example";

type Send = { type: string; input: Record<string, unknown> };
const sends: Send[] = [];
let existingCognitoUser: { status: string; sub: string } | null = null;

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
        if (c.__type === "CreateUser") {
          if (existingCognitoUser) {
            const err = new Error("exists");
            (err as { name?: string }).name = "UsernameExistsException";
            throw err;
          }
          return {
            User: {
              Username: String(c.input.Username),
              Attributes: [{ Name: "sub", Value: "sub-new" }],
            },
          };
        }
        if (c.__type === "GetUser") {
          return {
            Username: String(c.input.Username),
            UserStatus: existingCognitoUser?.status ?? "CONFIRMED",
            UserAttributes: [
              { Name: "sub", Value: existingCognitoUser?.sub ?? "sub-old" },
            ],
          };
        }
        return {};
      }
    },
    AdminAddUserToGroupCommand: cmd("AddToGroup"),
    AdminCreateUserCommand: cmd("CreateUser"),
    AdminGetUserCommand: cmd("GetUser"),
    AdminSetUserPasswordCommand: cmd("SetPassword"),
    AdminUpdateUserAttributesCommand: cmd("UpdateAttrs"),
    CreateGroupCommand: cmd("CreateGroup"),
  };
});

let customer: Record<string, unknown> | null = null;
const customerUpdates: Record<string, unknown>[] = [];
vi.mock("./dataClient", () => ({
  dataClient: async () => ({
    models: {
      Customer: {
        get: async () => ({ data: customer }),
        update: async (patch: Record<string, unknown>) => {
          customerUpdates.push(patch);
          return { data: patch };
        },
      },
    },
  }),
}));

const emails: { to: string; subject: string; html: string }[] = [];
vi.mock("./email", () => ({
  emailShell: (h: string, b: string) => `${h}${b}`,
  sendEmail: async (o: { to: string; subject: string; html: string }) => {
    emails.push(o);
    return true;
  },
}));

const { provisionPortalLogin } = await import("./portalProvision");

const ofType = (type: string) => sends.filter((s) => s.type === type);

beforeEach(() => {
  sends.length = 0;
  customerUpdates.length = 0;
  emails.length = 0;
  existingCognitoUser = null;
  customer = { id: "cust-1", groupId: null };
  process.env.AMPLIFY_AUTH_USERPOOL_ID = "pool-1";
});

describe("a fresh customer gets a working login end to end", () => {
  it("creates the account silently, sets a permanent password, grants the groups, stamps the record, and emails the link", async () => {
    const res = await provisionPortalLogin({
      customerId: "cust-1",
      email: "dana@example.com",
      name: "Dana Whitlock",
    });

    // Account: created with the invite email suppressed, moved out of
    // FORCE_CHANGE_PASSWORD so the magic-link custom flow isn't blocked.
    expect(ofType("CreateUser")[0].input).toMatchObject({
      Username: "dana@example.com",
      MessageAction: "SUPPRESS",
    });
    expect(ofType("SetPassword")[0].input).toMatchObject({ Permanent: true });

    // Access: the CUSTOMER role plus the customer's own dynamic group.
    expect(ofType("AddToGroup").map((s) => s.input.GroupName)).toEqual([
      "CUSTOMER",
      "cus-cust-1",
    ]);

    // Linkage: the record knows its portal user, so every "has a portal"
    // gate in the app flips true.
    expect(customerUpdates[0]).toMatchObject({
      id: "cust-1",
      portalUserSub: "sub-new",
      accessGroups: ["cus-cust-1"],
    });
    expect(customerUpdates[0].portalInvitedAt).toBeDefined();

    // Invite: a single-use link the customer can actually tap.
    expect(ofType("UpdateAttrs")).toHaveLength(1);
    expect(emails).toHaveLength(1);
    expect(emails[0].to).toBe("dana@example.com");
    expect(emails[0].subject).toMatch(/Welcome to BuzzKill/);
    expect(emails[0].html).toContain("customer portal");
    expect(emails[0].html).toContain(
      "https://crm.example/welcome#email=dana%40example.com&token="
    );

    expect(res).toMatchObject({ sub: "sub-new", created: true, linkSent: true });
  });

  it("normalizes the email before it becomes the Cognito username", async () => {
    await provisionPortalLogin({
      customerId: "cust-1",
      email: "  Dana@Example.COM ",
      name: "Dana Whitlock",
    });
    expect(ofType("CreateUser")[0].input.Username).toBe("dana@example.com");
  });

  it("a grouped customer also gets the grp- group, created if missing", async () => {
    customer = { id: "cust-1", groupId: "g1" };

    await provisionPortalLogin({
      customerId: "cust-1",
      email: "dana@example.com",
      name: "Dana",
    });

    expect(ofType("CreateGroup").map((s) => s.input.GroupName)).toEqual([
      "cus-cust-1",
      "grp-g1",
    ]);
    expect(ofType("AddToGroup").map((s) => s.input.GroupName)).toEqual([
      "CUSTOMER",
      "cus-cust-1",
      "grp-g1",
    ]);
    expect(customerUpdates[0].accessGroups).toEqual(["cus-cust-1", "grp-g1"]);
  });
});

describe("an existing login is reused, never duplicated", () => {
  it("a confirmed account keeps its password and gets a sign-in link, not a welcome", async () => {
    existingCognitoUser = { status: "CONFIRMED", sub: "sub-old" };

    const res = await provisionPortalLogin({
      customerId: "cust-1",
      email: "dana@example.com",
      name: "Dana",
    });

    expect(ofType("SetPassword")).toHaveLength(0);
    expect(customerUpdates[0].portalUserSub).toBe("sub-old");
    expect(emails[0].subject).toBe("Your BuzzKill sign-in link");
    expect(res.created).toBe(false);
  });

  it("an account stuck in FORCE_CHANGE_PASSWORD is unblocked for the magic-link flow", async () => {
    existingCognitoUser = { status: "FORCE_CHANGE_PASSWORD", sub: "sub-old" };

    await provisionPortalLogin({
      customerId: "cust-1",
      email: "dana@example.com",
      name: "Dana",
    });

    expect(ofType("SetPassword")).toHaveLength(1);
  });
});

describe("failure modes are loud, not silent", () => {
  it("refuses a customer id that doesn't resolve", async () => {
    customer = null;
    await expect(
      provisionPortalLogin({
        customerId: "ghost",
        email: "dana@example.com",
        name: "Dana",
      })
    ).rejects.toThrow(/not found/);
    expect(emails).toHaveLength(0);
  });

  it("refuses a blank email instead of minting an unaddressable login", async () => {
    await expect(
      provisionPortalLogin({ customerId: "cust-1", email: "   ", name: "Dana" })
    ).rejects.toThrow(/no email/);
    expect(sends).toHaveLength(0);
  });

  it("names the missing auth grant when the pool id is absent", async () => {
    delete process.env.AMPLIFY_AUTH_USERPOOL_ID;
    await expect(
      provisionPortalLogin({
        customerId: "cust-1",
        email: "dana@example.com",
        name: "Dana",
      })
    ).rejects.toThrow(/AMPLIFY_AUTH_USERPOOL_ID/);
  });
});
