import type { AppSyncResolverEvent } from "aws-lambda";
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminAddUserToGroupCommand,
  AdminListGroupsForUserCommand,
  ListUsersCommand,
  UsernameExistsException,
} from "@aws-sdk/client-cognito-identity-provider";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
// Role names are the schema's `UserRole` and the Cognito group names both —
// see the note on `isUserRole`. enums.ts pulls in no runtime dependency, the
// way pagination.ts does not.
import { DEFAULT_USER_ROLE, isUserRole } from "../../../src/lib/enums";

/**
 * Team administration behind ADMIN-group-only mutations.
 *
 * inviteUser: creates the Cognito user passwordless (CONFIRMED, verified
 * email — ready for magic-link sign-in immediately), adds them to a role
 * group, and sends an invitation email pointing at the portal.
 */

const cognito = new CognitoIdentityProviderClient();
const ses = new SESv2Client();

const POOL_ID = process.env.USER_POOL_ID!;
const PORTAL_URL = process.env.PORTAL_URL ?? "";
const INVITE_FROM = process.env.INVITE_FROM ?? "";

type InviteArgs = { email?: string | null; role?: string | null };

async function inviteUser(args: InviteArgs, invitedBy: string) {
  const email = args.email?.trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, error: "A valid email is required." };
  }
  const role = isUserRole(args.role) ? args.role : DEFAULT_USER_ROLE;

  try {
    await cognito.send(
      new AdminCreateUserCommand({
        UserPoolId: POOL_ID,
        Username: email,
        // No password ever exists; SUPPRESS Cognito's own invite —
        // we send a portal-branded one below.
        MessageAction: "SUPPRESS",
        UserAttributes: [
          { Name: "email", Value: email },
          { Name: "email_verified", Value: "true" },
        ],
      })
    );
  } catch (err) {
    if (err instanceof UsernameExistsException) {
      return { ok: false, error: "That email is already on the team." };
    }
    throw err;
  }

  await cognito.send(
    new AdminAddUserToGroupCommand({
      UserPoolId: POOL_ID,
      Username: email,
      GroupName: role,
    })
  );

  await ses.send(
    new SendEmailCommand({
      FromEmailAddress: INVITE_FROM,
      Destination: { ToAddresses: [email] },
      Content: {
        Simple: {
          Subject: { Data: "You're invited to the HOA Insurance CRM" },
          Body: {
            Text: {
              Data: `You've been invited to the HOA Insurance Agency CRM.\n\nSign in at ${PORTAL_URL} using this email address — we'll email you a sign-in link each time. No password needed.`,
            },
            Html: {
              Data: `
<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:24px">
  <h2 style="color:#142a4c">HOA Insurance Agency CRM</h2>
  <p>You've been invited to the agency CRM (role: <strong>${role}</strong>).</p>
  <p style="margin:28px 0">
    <a href="${PORTAL_URL}" style="background:#2e7dd1;color:#fff;padding:12px 22px;border-radius:6px;text-decoration:none;font-weight:600">Open the CRM</a>
  </p>
  <p style="color:#64748b;font-size:13px">Sign in with this email address — a sign-in link is emailed to you each time. No password needed.</p>
</div>`,
            },
          },
        },
      },
    })
  );

  console.log(`Invited ${email} as ${role} (by ${invitedBy})`);
  return { ok: true, email, role };
}

async function listTeamUsers() {
  const { Users = [] } = await cognito.send(
    new ListUsersCommand({ UserPoolId: POOL_ID, Limit: 60 })
  );

  const users = await Promise.all(
    Users.map(async (u) => {
      const attrs = Object.fromEntries(
        (u.Attributes ?? []).map((a) => [a.Name, a.Value])
      );
      const { Groups = [] } = await cognito.send(
        new AdminListGroupsForUserCommand({
          UserPoolId: POOL_ID,
          Username: u.Username!,
        })
      );
      return {
        userId: attrs.sub ?? u.Username,
        email: attrs.email ?? u.Username,
        status: u.UserStatus,
        enabled: u.Enabled ?? true,
        createdAt: u.UserCreateDate?.toISOString() ?? null,
        groups: Groups.map((g) => g.GroupName),
      };
    })
  );

  return { ok: true, users };
}

export const handler = async (
  event: AppSyncResolverEvent<InviteArgs | Record<string, never>>
) => {
  const invokedBy =
    (event.identity && "username" in event.identity && event.identity.username) ||
    "unknown";

  // The invocation payload doesn't always carry `info` — fall back to the
  // argument shape to tell the two operations apart.
  const field =
    event.info?.fieldName ??
    ("email" in (event.arguments ?? {}) ? "inviteUser" : "listTeamUsers");

  switch (field) {
    case "inviteUser":
      return inviteUser(event.arguments as InviteArgs, String(invokedBy));
    case "listTeamUsers":
      return listTeamUsers();
    default:
      return { ok: false, error: `Unknown field ${field}` };
  }
};
