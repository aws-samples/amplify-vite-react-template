import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The magic-link verify trigger, both legs.
 *
 * The defect these exist to hold shut: the request/redeem split used to key
 * off clientMetadata.mode in CreateAuthChallenge, but Cognito never delivers
 * InitiateAuth metadata to that trigger — so the request branch was
 * unreachable, no token was ever minted, and "a sign-in link is on its way"
 * was a lie every single time. The split now keys off the challenge answer,
 * which VerifyAuthChallengeResponse reliably receives.
 */

const { cognitoSend, sesSend } = vi.hoisted(() => ({
  cognitoSend: vi.fn(async () => ({})),
  sesSend: vi.fn(async () => ({})),
}));

type CommandInput = Record<string, never> | { [k: string]: unknown };

vi.mock("@aws-sdk/client-cognito-identity-provider", () => ({
  CognitoIdentityProviderClient: class {
    send = cognitoSend;
  },
  AdminUpdateUserAttributesCommand: class {
    constructor(public input: CommandInput) {}
  },
}));
vi.mock("@aws-sdk/client-ses", () => ({
  SESClient: class {
    send = sesSend;
  },
  SendEmailCommand: class {
    constructor(public input: CommandInput) {}
  },
}));

// GL-03: the link now travels through the ONE email contract (outbox record,
// suppression, recovery) — the tests assert on that boundary.
const sentEmails: { to: string; subject: string; html: string; template: string }[] = [];
vi.mock("../shared/email", () => ({
  sendEmail: async (o: { to: string; subject: string; html: string; template: string }) => {
    sentEmails.push(o);
    return true;
  },
  emailShell: (_heading: string, body: string) => body,
}));

const { handler, REQUEST_LINK_ANSWER } = await import("./verify");

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const event = (
  answer: string,
  attrs: Record<string, string> = {}
): Parameters<typeof handler>[0] =>
  ({
    userPoolId: "pool-1",
    userName: "sub-abc",
    request: {
      challengeAnswer: answer,
      userAttributes: { email: "dana@example.com", ...attrs },
    },
    response: {},
  }) as never;

/** The attribute map a cognito send received, keyed by attribute name. */
const sentAttributes = (call: number) => {
  const input = (cognitoSend.mock.calls[call] as unknown[])[0] as {
    input: {
      UserAttributes: { Name: string; Value: string }[];
      UserPoolId: string;
      Username: string;
    };
  };
  return {
    ...input.input,
    attrs: Object.fromEntries(
      input.input.UserAttributes.map((a) => [a.Name, a.Value])
    ),
  };
};

beforeEach(() => {
  cognitoSend.mockClear();
  sesSend.mockClear();
  sentEmails.length = 0;
  process.env.SES_FROM_EMAIL = "info@pestbuzzkill.com";
  process.env.CRM_APP_URL = "https://crm.example.com";
});

describe("the request leg (REQUEST_LINK sentinel)", () => {
  it("mints a token, stores its hash, emails the link — and fails the throwaway session", async () => {
    const res = await handler(event(REQUEST_LINK_ANSWER), {} as never, () => {});

    // The answer is never correct: the emailed link signs in, not the request.
    expect(res.response.answerCorrect).toBe(false);

    // A fresh token hash landed on the user with a future expiry.
    const stored = sentAttributes(0);
    expect(stored.UserPoolId).toBe("pool-1");
    expect(stored.Username).toBe("sub-abc");
    expect(stored.attrs["custom:loginTokenHash"]).toMatch(/^[0-9a-f]{64}$/);
    expect(Number(stored.attrs["custom:loginTokenExp"])).toBeGreaterThan(
      Date.now()
    );

    // The email carries a /welcome link whose token hashes to the stored hash.
    expect(sentEmails[0]).toMatchObject({
      to: "dana@example.com",
      template: "auth-magic-link",
    });
    const html = sentEmails[0].html;
    expect(html).toContain(
      "https://crm.example.com/welcome#email=dana%40example.com&token="
    );
    const token = /token=([A-Za-z0-9_-]+)/.exec(html)?.[1] ?? "";
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(sha256(token)).toBe(stored.attrs["custom:loginTokenHash"]);
  });

  it("can never redeem — even a stored hash of the sentinel itself is not consulted", async () => {
    const res = await handler(
      event(REQUEST_LINK_ANSWER, {
        "custom:loginTokenHash": sha256(REQUEST_LINK_ANSWER),
        "custom:loginTokenExp": String(Date.now() + 60_000),
      }),
      {} as never,
      () => {}
    );

    expect(res.response.answerCorrect).toBe(false);
    // It ran the request leg (minted + emailed), not the redeem leg.
    expect(sentEmails).toHaveLength(1);
  });
});

describe("the redeem leg (a real token)", () => {
  const token = "tok-abcdefghijklmnopqrstuvwxyz-0123456789_A";

  it("signs in on the stored token and burns it", async () => {
    const res = await handler(
      event(token, {
        "custom:loginTokenHash": sha256(token),
        "custom:loginTokenExp": String(Date.now() + 60_000),
      }),
      {} as never,
      () => {}
    );

    expect(res.response.answerCorrect).toBe(true);
    expect(sentEmails).toHaveLength(0);
    const burned = sentAttributes(0);
    expect(burned.attrs["custom:loginTokenHash"]).toBe("");
    expect(burned.attrs["custom:loginTokenExp"]).toBe("0");
  });

  it("refuses an expired token and burns nothing", async () => {
    const res = await handler(
      event(token, {
        "custom:loginTokenHash": sha256(token),
        "custom:loginTokenExp": String(Date.now() - 1),
      }),
      {} as never,
      () => {}
    );

    expect(res.response.answerCorrect).toBe(false);
    expect(cognitoSend).not.toHaveBeenCalled();
  });

  it("refuses a wrong token and leaves the real one standing", async () => {
    const res = await handler(
      event("not-the-token", {
        "custom:loginTokenHash": sha256(token),
        "custom:loginTokenExp": String(Date.now() + 60_000),
      }),
      {} as never,
      () => {}
    );

    expect(res.response.answerCorrect).toBe(false);
    expect(cognitoSend).not.toHaveBeenCalled();
  });

  it("refuses when no token was ever requested", async () => {
    const res = await handler(event(token), {} as never, () => {});

    expect(res.response.answerCorrect).toBe(false);
    expect(cognitoSend).not.toHaveBeenCalled();
    expect(sentEmails).toHaveLength(0);
  });
});
