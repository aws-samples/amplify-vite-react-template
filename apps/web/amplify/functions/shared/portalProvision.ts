/**
 * Login provisioning — the one implementation of "create (or find) a Cognito
 * login, grant it access, and send the magic sign-in link".
 *
 * Two callers share it: crm-admin's adminCreateUser (the office invite
 * buttons) and bookingFinalize (R41 — the portal login is provisioned the
 * moment a booking converts the customer, because every email the system
 * sends afterward — receipts, service reports, payment recovery — points at
 * the portal). One implementation, so the invite email, the token TTL, and
 * the group bookkeeping cannot drift between the button and the webhook.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
  AdminUpdateUserAttributesCommand,
  CognitoIdentityProviderClient,
  CreateGroupCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { dataClient } from "./dataClient";
import { customerAccessGroups, grpGroup } from "./dynamicGroups";
import { emailShell, sendEmail } from "./email";

const cognito = new CognitoIdentityProviderClient();

/** Read lazily, not at import: the webhook Lambda doesn't need the pool id
 *  until it actually provisions, and a missing auth grant should surface as
 *  this plain sentence in the ops alert, not as an import-time crash. */
function userPoolId(): string {
  const id = process.env.AMPLIFY_AUTH_USERPOOL_ID;
  if (!id) throw new Error("AMPLIFY_AUTH_USERPOOL_ID is not configured");
  return id;
}

export async function ensureCognitoGroup(groupName: string) {
  try {
    await cognito.send(
      new CreateGroupCommand({
        UserPoolId: userPoolId(),
        GroupName: groupName,
        Description: "CRM dynamic access group",
      })
    );
  } catch (err) {
    if ((err as { name?: string }).name !== "GroupExistsException") throw err;
  }
}

export async function addToGroup(username: string, groupName: string) {
  await cognito.send(
    new AdminAddUserToGroupCommand({
      UserPoolId: userPoolId(),
      Username: username,
      GroupName: groupName,
    })
  );
}

/**
 * Create the Cognito user, or find the existing one for this email. No
 * temporary-password email — sign-in is the magic link (below). A random
 * permanent password moves a new account out of FORCE_CHANGE_PASSWORD,
 * which would otherwise block the magic-link custom auth flow.
 */
export async function ensureLogin(
  email: string,
  name: string
): Promise<{ username: string; sub: string; created: boolean }> {
  let username = email;
  let sub: string | undefined;
  let created = false;
  let needsPassword = false;
  try {
    const res = await cognito.send(
      new AdminCreateUserCommand({
        UserPoolId: userPoolId(),
        Username: email,
        MessageAction: "SUPPRESS",
        UserAttributes: [
          { Name: "email", Value: email },
          { Name: "email_verified", Value: "true" },
          { Name: "name", Value: name },
        ],
      })
    );
    username = res.User?.Username ?? email;
    sub = res.User?.Attributes?.find((a) => a.Name === "sub")?.Value;
    created = true;
    needsPassword = true;
  } catch (err) {
    if ((err as { name?: string }).name !== "UsernameExistsException") {
      throw err;
    }
    const existing = await cognito.send(
      new AdminGetUserCommand({ UserPoolId: userPoolId(), Username: email })
    );
    username = existing.Username ?? email;
    sub = existing.UserAttributes?.find((a) => a.Name === "sub")?.Value;
    needsPassword = existing.UserStatus === "FORCE_CHANGE_PASSWORD";
  }
  if (!sub) throw new Error("Could not resolve Cognito sub for user");

  if (needsPassword) {
    await cognito.send(
      new AdminSetUserPasswordCommand({
        UserPoolId: userPoolId(),
        Username: username,
        Password: `Bk1!${randomBytes(24).toString("base64url")}`,
        Permanent: true,
      })
    );
  }
  return { username, sub, created };
}

/**
 * Grant a login the CUSTOMER role plus the customer's dynamic (cus-/grp-)
 * groups, and stamp the customer record with the portal linkage. Returns the
 * groups granted.
 */
export async function grantCustomerPortal(opts: {
  username: string;
  sub: string;
  customerId: string;
}): Promise<string[]> {
  const client = await dataClient();
  const { data: customer } = await client.models.Customer.get({
    id: opts.customerId,
  });
  if (!customer) throw new Error(`Customer ${opts.customerId} not found`);

  const dynamicGroups = customerAccessGroups(opts.customerId, customer.groupId);
  const groupsAdded: string[] = [];
  for (const g of ["CUSTOMER", ...dynamicGroups]) {
    if (g !== "CUSTOMER") await ensureCognitoGroup(g);
    await addToGroup(opts.username, g);
    groupsAdded.push(g);
  }

  await client.models.Customer.update({
    id: opts.customerId,
    portalUserSub: opts.sub,
    portalInvitedAt: new Date().toISOString(),
    accessGroups: dynamicGroups,
  });
  return groupsAdded;
}

/**
 * Grant a login the CUSTOMER role plus a management group's dynamic (grp-)
 * group — the "group-only" login. It sees every property in the group's
 * portfolio (the portal Group view lists all customers with this groupId) but
 * is bound to no single Customer, so a management company gets one login that
 * is not entangled with any one property's cus- access. Stamps the group record
 * with the portal linkage. Returns the groups granted.
 */
export async function grantGroupPortal(opts: {
  username: string;
  sub: string;
  groupId: string;
}): Promise<string[]> {
  const client = await dataClient();
  const { data: group } = await client.models.CustomerGroup.get({
    id: opts.groupId,
  });
  if (!group) throw new Error(`CustomerGroup ${opts.groupId} not found`);

  const grp = grpGroup(opts.groupId);
  const groupsAdded: string[] = [];
  for (const g of ["CUSTOMER", grp]) {
    if (g !== "CUSTOMER") await ensureCognitoGroup(g);
    await addToGroup(opts.username, g);
    groupsAdded.push(g);
  }

  // The group's own record must carry grp-<id> so this login can read it (the
  // portal loads the CustomerGroup before its members).
  await client.models.CustomerGroup.update({
    id: opts.groupId,
    portalUserSub: opts.sub,
    portalInvitedAt: new Date().toISOString(),
    accessGroups: [grp],
  });
  return groupsAdded;
}

/** Magic sign-in link: single-use token, 7-day expiry for invites. */
export async function sendMagicLinkInvite(opts: {
  username: string;
  email: string;
  name: string;
  sub: string;
  created: boolean;
  portal: boolean;
  customerId?: string;
}): Promise<boolean> {
  const token = randomBytes(32).toString("base64url");
  await cognito.send(
    new AdminUpdateUserAttributesCommand({
      UserPoolId: userPoolId(),
      Username: opts.username,
      UserAttributes: [
        {
          Name: "custom:loginTokenHash",
          Value: createHash("sha256").update(token).digest("hex"),
        },
        {
          Name: "custom:loginTokenExp",
          Value: String(Date.now() + 7 * 24 * 60 * 60_000),
        },
      ],
    })
  );
  const crmUrl = process.env.CRM_APP_URL ?? "";
  const link = `${crmUrl}/welcome#email=${encodeURIComponent(opts.email)}&token=${token}`;
  return sendEmail({
    to: opts.email,
    subject: opts.created
      ? "Welcome to BuzzKill — tap to sign in"
      : "Your BuzzKill sign-in link",
    template: "magic-link-invite",
    customerId: opts.customerId,
    relatedId: opts.sub,
    html: emailShell(
      opts.created ? `Welcome, ${opts.name}!` : "Your sign-in link",
      `<p>Your BuzzKill ${opts.portal ? "customer portal" : "CRM"} account is ready. Tap below to sign in — no password needed.</p>
       <p style="margin:24px 0"><a href="${link}" style="background:#176b2c;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600">Sign in to BuzzKill</a></p>
       <p style="color:#666;font-size:13px;">The link works once and expires in 7 days. Need a new one? Use “Email me a sign-in link” on the login page. You can also set a password any time from the More tab.</p>`
    ),
  });
}

/**
 * The whole portal grant in one call — what "this customer converted" means
 * for access (R41). Idempotent per piece: an existing login is reused, group
 * adds are no-ops when already granted, and a re-run re-sends the invite
 * rather than failing.
 */
export async function provisionPortalLogin(opts: {
  customerId: string;
  email: string;
  name: string;
}): Promise<{
  sub: string;
  username: string;
  created: boolean;
  groupsAdded: string[];
  linkSent: boolean;
}> {
  const email = opts.email.trim().toLowerCase();
  if (!email) {
    throw new Error("Customer has no email — a portal login needs one");
  }
  const { username, sub, created } = await ensureLogin(email, opts.name);
  const groupsAdded = await grantCustomerPortal({
    username,
    sub,
    customerId: opts.customerId,
  });
  const linkSent = await sendMagicLinkInvite({
    username,
    email,
    name: opts.name,
    sub,
    created,
    portal: true,
    customerId: opts.customerId,
  });
  return { sub, username, created, groupsAdded, linkSent };
}
