import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PostAuthentication trigger: on every successful sign-in it stamps
 * custom:lastLoginAt (the GL-14 roster's source for "last login") and, for a
 * portal user, portalLastLoginAt on their Customer record. Neither stamp may
 * ever block the login.
 */

type Send = { type: string; input: Record<string, unknown> };
const sends: Send[] = [];
let updateAttrsShouldThrow = false;

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
        if (c.__type === "UpdateAttrs" && updateAttrsShouldThrow) {
          throw new Error("cognito is down");
        }
        return {};
      }
    },
    AdminUpdateUserAttributesCommand: cmd("UpdateAttrs"),
  };
});

const customerUpdate = vi.fn(async () => ({ data: {} }));
const listByPortalSub = vi.fn(async () => ({ data: [] as { id: string }[] }));
vi.mock("../shared/dataClient", () => ({
  dataClient: async () => ({
    models: {
      Customer: {
        listCustomerByPortalUserSub: (...a: unknown[]) =>
          (listByPortalSub as unknown as (...x: unknown[]) => unknown)(...a),
        update: (...a: unknown[]) =>
          (customerUpdate as unknown as (...x: unknown[]) => unknown)(...a),
      },
    },
  }),
}));

const openOwnedWork = vi.fn(async () => undefined);
vi.mock("../shared/ownedWork", () => ({
  openOwnedWork: (...a: unknown[]) =>
    (openOwnedWork as unknown as (...x: unknown[]) => unknown)(...a),
}));

const { handler } = await import("./handler");

const event = (overrides: Record<string, unknown> = {}) =>
  ({
    userPoolId: "pool-1",
    userName: "dana@example.com",
    request: { userAttributes: { sub: "sub-1" } },
    ...overrides,
  }) as unknown as Parameters<typeof handler>[0];

const run = (e: ReturnType<typeof event>) =>
  (handler as unknown as (x: unknown, y: unknown, z: unknown) => Promise<unknown>)(
    e,
    {},
    () => undefined
  );

beforeEach(() => {
  sends.length = 0;
  updateAttrsShouldThrow = false;
  customerUpdate.mockClear();
  listByPortalSub.mockClear();
  openOwnedWork.mockClear();
});

describe("post-auth last-login stamp", () => {
  it("stamps custom:lastLoginAt for the authenticated user", async () => {
    await run(event());
    const stamp = sends.find((s) => s.type === "UpdateAttrs");
    expect(stamp).toBeTruthy();
    expect(stamp!.input.Username).toBe("dana@example.com");
    const attr = (stamp!.input.UserAttributes as { Name: string; Value: string }[])[0];
    expect(attr.Name).toBe("custom:lastLoginAt");
    // A real ISO timestamp, not a placeholder.
    expect(Number.isNaN(Date.parse(attr.Value))).toBe(false);
  });

  it("never blocks the login when the stamp fails, and opens no ops work", async () => {
    updateAttrsShouldThrow = true;
    const e = event();
    const returned = await run(e);
    // The trigger must return the event so Cognito completes the sign-in.
    expect(returned).toBe(e);
    expect(openOwnedWork).not.toHaveBeenCalled();
  });
});
