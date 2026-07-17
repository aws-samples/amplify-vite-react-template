import { createHash, randomBytes } from "node:crypto";
import type { AppSyncResolverEvent } from "aws-lambda";
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminGetUserCommand,
  AdminListGroupsForUserCommand,
  AdminRemoveUserFromGroupCommand,
  AdminSetUserPasswordCommand,
  AdminUpdateUserAttributesCommand,
  AdminUserGlobalSignOutCommand,
  CognitoIdentityProviderClient,
  CreateGroupCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { dataClient } from "../shared/dataClient";
import { assertTechnicianCanBeSaved } from "../shared/compliance";
import { opFieldName } from "../shared/opEvent";
import { emailShell, notifyOffice, sendEmail } from "../shared/email";
import {
  customerAccessGroups,
  grpGroup,
} from "../shared/dynamicGroups";

const cognito = new CognitoIdentityProviderClient();

const USER_POOL_ID = process.env.AMPLIFY_AUTH_USERPOOL_ID!;
const STAFF_ROLES = ["OWNER", "OFFICE", "FINANCE", "TECH"] as const;
type StaffRole = (typeof STAFF_ROLES)[number];

type AdminCreateUserArgs = {
  email: string;
  name: string;
  roles: string[];
  customerId?: string | null;
  technicianId?: string | null;
  resend?: boolean | null;
};

type SetCustomerGroupArgs = {
  customerId: string;
  groupId?: string | null;
};

type CustomerIdArgs = { customerId: string };
type TechnicianIdArgs = { technicianId: string };
type SaveTechnicianArgs = {
  technicianId?: string | null;
  name: string;
  email?: string | null;
  phone?: string | null;
  active: boolean;
  licenseNumber?: string | null;
  licenseExpiresOn?: string | null;
};

type AdminArgs =
  | AdminCreateUserArgs
  | SetCustomerGroupArgs
  | CustomerIdArgs
  | TechnicianIdArgs
  | SaveTechnicianArgs;

export const handler = async (event: AppSyncResolverEvent<AdminArgs>) => {
  switch (opFieldName(event)) {
    case "adminCreateUser":
      return adminCreateUser(event.arguments as AdminCreateUserArgs);
    case "setCustomerGroup":
      return setCustomerGroup(event.arguments as SetCustomerGroupArgs);
    case "revokePortalAccess":
      return revokePortalAccess((event.arguments as CustomerIdArgs).customerId);
    case "restorePortalAccess":
      return restorePortalAccess((event.arguments as CustomerIdArgs).customerId);
    case "deactivateTechnician":
      return deactivateTechnician(
        (event.arguments as TechnicianIdArgs).technicianId
      );
    case "saveTechnician":
      return saveTechnician(event.arguments as SaveTechnicianArgs);
    default:
      throw new Error(`Unknown field ${opFieldName(event)}`);
  }
};

async function saveTechnician(args: SaveTechnicianArgs) {
  const name = args.name.trim();
  if (!name) throw new Error("Technician name is required");
  const fields = {
    name,
    email: args.email?.trim() || undefined,
    phone: args.phone?.trim() || undefined,
    active: args.active,
    licenseNumber: args.licenseNumber?.trim() || undefined,
    licenseExpiresOn: args.licenseExpiresOn?.trim() || undefined,
  };
  assertTechnicianCanBeSaved(fields);

  const client = await dataClient();
  const result = args.technicianId
    ? await client.models.Technician.update({
        id: args.technicianId,
        ...fields,
      })
    : await client.models.Technician.create(fields);
  if (!result.data) {
    throw new Error(
      `Could not save the technician: ${result.errors?.map((e) => e.message).join("; ") ?? "unknown error"}`
    );
  }
  return { technicianId: result.data.id };
}

async function ensureCognitoGroup(groupName: string) {
  try {
    await cognito.send(
      new CreateGroupCommand({
        UserPoolId: USER_POOL_ID,
        GroupName: groupName,
        Description: "CRM dynamic access group",
      })
    );
  } catch (err) {
    if ((err as { name?: string }).name !== "GroupExistsException") throw err;
  }
}

async function addToGroup(username: string, groupName: string) {
  await cognito.send(
    new AdminAddUserToGroupCommand({
      UserPoolId: USER_POOL_ID,
      Username: username,
      GroupName: groupName,
    })
  );
}

async function removeFromGroup(username: string, groupName: string) {
  await cognito.send(
    new AdminRemoveUserFromGroupCommand({
      UserPoolId: USER_POOL_ID,
      Username: username,
      GroupName: groupName,
    })
  );
}

/**
 * End a login now: remove it from the named groups, disable the account, and
 * globally sign it out. Disable stops any new sign-in; the global sign-out
 * revokes the tokens already issued, so an open session dies in minutes rather
 * than lingering until its access token expires. Idempotent — Cognito treats
 * disabling an already-disabled user and signing out an already-signed-out one
 * as no-ops, and we only remove the groups we found the user in.
 *
 * The IAM for AdminDisableUser and AdminUserGlobalSignOut rides on the
 * `manageUsers` grant crm-admin already holds (auth/resource.ts) — there is no
 * granular grant for global sign-out; it exists only inside that bundle.
 */
async function killLogin(username: string, removePrefixes: string[]) {
  const { Groups } = await cognito.send(
    new AdminListGroupsForUserCommand({
      UserPoolId: USER_POOL_ID,
      Username: username,
    })
  );
  const toRemove = (Groups ?? [])
    .map((g) => g.GroupName!)
    .filter((g) => removePrefixes.some((p) => g === p || g.startsWith(p)));
  for (const g of toRemove) {
    await removeFromGroup(username, g);
  }
  await cognito.send(
    new AdminDisableUserCommand({
      UserPoolId: USER_POOL_ID,
      Username: username,
    })
  );
  await cognito.send(
    new AdminUserGlobalSignOutCommand({
      UserPoolId: USER_POOL_ID,
      Username: username,
    })
  );
  return toRemove;
}

async function adminCreateUser(args: AdminCreateUserArgs) {
  const email = args.email.trim().toLowerCase();
  const roles = [...new Set(args.roles)];

  const invalid = roles.filter(
    (r) => r !== "CUSTOMER" && !STAFF_ROLES.includes(r as StaffRole)
  );
  if (invalid.length) throw new Error(`Invalid roles: ${invalid.join(", ")}`);
  if (roles.includes("CUSTOMER") && !args.customerId)
    throw new Error("customerId is required when creating a CUSTOMER login");

  // Create (or find) the Cognito user. No temporary-password email —
  // we send a single-use magic sign-in link instead (below).
  let username = email;
  let sub: string | undefined;
  let created = false;
  let needsPassword = false;
  try {
    const res = await cognito.send(
      new AdminCreateUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: email,
        MessageAction: "SUPPRESS",
        UserAttributes: [
          { Name: "email", Value: email },
          { Name: "email_verified", Value: "true" },
          { Name: "name", Value: args.name },
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
      new AdminGetUserCommand({ UserPoolId: USER_POOL_ID, Username: email })
    );
    username = existing.Username ?? email;
    sub = existing.UserAttributes?.find((a) => a.Name === "sub")?.Value;
    needsPassword = existing.UserStatus === "FORCE_CHANGE_PASSWORD";
  }
  if (!sub) throw new Error("Could not resolve Cognito sub for user");

  // Users sign in via magic link (or later set their own password with the
  // reset flow). A random permanent password moves the account out of
  // FORCE_CHANGE_PASSWORD, which would otherwise block the custom auth flow.
  if (needsPassword) {
    await cognito.send(
      new AdminSetUserPasswordCommand({
        UserPoolId: USER_POOL_ID,
        Username: username,
        Password: `Bk1!${randomBytes(24).toString("base64url")}`,
        Permanent: true,
      })
    );
  }

  const client = await dataClient();
  const groupsAdded: string[] = [];

  for (const role of roles.filter((r) => r !== "CUSTOMER")) {
    await addToGroup(username, role);
    groupsAdded.push(role);
  }

  if (roles.includes("CUSTOMER")) {
    const customerId = args.customerId!;
    const { data: customer } = await client.models.Customer.get({
      id: customerId,
    });
    if (!customer) throw new Error(`Customer ${customerId} not found`);

    const dynamicGroups = customerAccessGroups(customerId, customer.groupId);
    for (const g of ["CUSTOMER", ...dynamicGroups]) {
      if (g !== "CUSTOMER") await ensureCognitoGroup(g);
      await addToGroup(username, g);
      groupsAdded.push(g);
    }

    await client.models.Customer.update({
      id: customerId,
      portalUserSub: sub,
      portalInvitedAt: new Date().toISOString(),
      accessGroups: dynamicGroups,
    });
  }

  if (args.technicianId) {
    await client.models.Technician.update({
      id: args.technicianId,
      userSub: sub,
      email,
    });
  }

  // Magic sign-in link: single-use token, 7-day expiry for invites.
  const token = randomBytes(32).toString("base64url");
  await cognito.send(
    new AdminUpdateUserAttributesCommand({
      UserPoolId: USER_POOL_ID,
      Username: username,
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
  const link = `${crmUrl}/welcome#email=${encodeURIComponent(email)}&token=${token}`;
  const linkSent = await sendEmail({
    to: email,
    subject: created
      ? "Welcome to BuzzKill — tap to sign in"
      : "Your BuzzKill sign-in link",
    template: "magic-link-invite",
    customerId: args.customerId ?? undefined,
    relatedId: sub,
    html: emailShell(
      created ? `Welcome, ${args.name}!` : "Your sign-in link",
      `<p>Your BuzzKill ${roles.includes("CUSTOMER") ? "customer portal" : "CRM"} account is ready. Tap below to sign in — no password needed.</p>
       <p style="margin:24px 0"><a href="${link}" style="background:#176b2c;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600">Sign in to BuzzKill</a></p>
       <p style="color:#666;font-size:13px;">The link works once and expires in 7 days. Need a new one? Use “Email me a sign-in link” on the login page. You can also set a password any time from the More tab.</p>`
    ),
  });

  return { sub, username, created, groupsAdded, linkSent };
}

/**
 * Move a customer into (or out of) a CustomerGroup, keeping row-level
 * visibility consistent everywhere it is denormalized:
 *   1. Customer.groupId + accessGroups
 *   2. accessGroups on every child record
 *   3. the portal user's Cognito group membership (grp-*)
 */
async function setCustomerGroup(args: SetCustomerGroupArgs) {
  const client = await dataClient();
  const { data: customer } = await client.models.Customer.get({
    id: args.customerId,
  });
  if (!customer) throw new Error(`Customer ${args.customerId} not found`);

  const newGroupId = args.groupId || null;
  if (newGroupId) {
    const { data: group } = await client.models.CustomerGroup.get({
      id: newGroupId,
    });
    if (!group) throw new Error(`CustomerGroup ${newGroupId} not found`);
    // Make sure the group record itself is visible to its members.
    const wanted = grpGroup(newGroupId);
    if (!(group.accessGroups ?? []).includes(wanted)) {
      await client.models.CustomerGroup.update({
        id: newGroupId,
        accessGroups: [...(group.accessGroups ?? []).filter(Boolean), wanted],
      });
    }
  }

  const accessGroups = customerAccessGroups(args.customerId, newGroupId);
  await client.models.Customer.update({
    id: args.customerId,
    groupId: newGroupId,
    accessGroups,
  });

  // Rewrite accessGroups on all child records.
  const filter = { customerId: { eq: args.customerId } };
  let childrenUpdated = 0;
  const collections = [
    client.models.ServicePlan,
    client.models.Job,
    client.models.Agreement,
    client.models.ServiceReport,
    client.models.Invoice,
  ] as const;
  for (const model of collections) {
    let nextToken: string | null | undefined;
    do {
      const page = await (
        model.list as (args: object) => Promise<{
          data: { id: string }[];
          nextToken?: string | null;
        }>
      )({ filter, nextToken, limit: 200 });
      for (const record of page.data) {
        await (
          model.update as (args: object) => Promise<unknown>
        )({ id: record.id, accessGroups });
        childrenUpdated++;
      }
      nextToken = page.nextToken;
    } while (nextToken);
  }

  // Fix the portal user's Cognito membership.
  let cognitoUpdated = false;
  if (customer.portalUserSub) {
    const username = customer.email?.toLowerCase();
    if (username) {
      const { Groups } = await cognito.send(
        new AdminListGroupsForUserCommand({
          UserPoolId: USER_POOL_ID,
          Username: username,
        })
      );
      const current = (Groups ?? [])
        .map((g) => g.GroupName!)
        .filter((g) => g.startsWith("grp-"));
      const wanted = newGroupId ? grpGroup(newGroupId) : null;
      for (const g of current) {
        if (g !== wanted) {
          await cognito.send(
            new AdminRemoveUserFromGroupCommand({
              UserPoolId: USER_POOL_ID,
              Username: username,
              GroupName: g,
            })
          );
        }
      }
      if (wanted && !current.includes(wanted)) {
        await ensureCognitoGroup(wanted);
        await addToGroup(username, wanted);
      }
      cognitoUpdated = true;
    }
  }

  return {
    customerId: args.customerId,
    groupId: newGroupId,
    accessGroups,
    childrenUpdated,
    cognitoUpdated,
  };
}

/**
 * End a deactivated customer's portal login.
 *
 * The money/work side of deactivation is crm-billing's deactivateCustomer; this
 * is the access side. Without it, a former customer keeps a working portal
 * login into their own billing address, card metadata, and every invoice and
 * report PDF. Removes the portal + dynamic (cus-/grp-) group memberships,
 * disables the account, and globally signs it out.
 *
 * Idempotent and a no-op when there is no portal user — a customer who was
 * never invited has nothing to revoke. portalUserSub is deliberately left on
 * the record so a later reactivation (restorePortalAccess) can re-enable the
 * same login rather than mint a new one.
 */
async function revokePortalAccess(customerId: string) {
  const client = await dataClient();
  const { data: customer } = await client.models.Customer.get({
    id: customerId,
  });
  if (!customer) throw new Error(`Customer ${customerId} not found`);
  if (!customer.portalUserSub) {
    return { customerId, revoked: false, groupsRemoved: [] as string[] };
  }
  const username = customer.email?.toLowerCase();
  if (!username) {
    throw new Error(
      `Customer ${customerId} has a portal login but no email to identify it — remove the Cognito user by hand`
    );
  }
  const groupsRemoved = await killLogin(username, ["CUSTOMER", "cus-", "grp-"]);
  return { customerId, revoked: true, groupsRemoved };
}

/**
 * Re-enable a reactivated customer's portal login: enable the account and
 * restore its CUSTOMER + dynamic group memberships so their own records are
 * visible again. The plans stay canceled — a reactivated customer re-subscribes
 * through a new booking — so this only restores access, it does not resurrect
 * billing. No-op when there is no portal user.
 */
async function restorePortalAccess(customerId: string) {
  const client = await dataClient();
  const { data: customer } = await client.models.Customer.get({
    id: customerId,
  });
  if (!customer) throw new Error(`Customer ${customerId} not found`);
  if (!customer.portalUserSub) {
    return { customerId, restored: false, groupsAdded: [] as string[] };
  }
  const username = customer.email?.toLowerCase();
  if (!username) {
    throw new Error(
      `Customer ${customerId} has a portal login but no email to identify it`
    );
  }
  await cognito.send(
    new AdminEnableUserCommand({
      UserPoolId: USER_POOL_ID,
      Username: username,
    })
  );
  const dynamicGroups = customerAccessGroups(customerId, customer.groupId);
  const groupsAdded: string[] = [];
  for (const g of ["CUSTOMER", ...dynamicGroups]) {
    if (g !== "CUSTOMER") await ensureCognitoGroup(g);
    await addToGroup(username, g);
    groupsAdded.push(g);
  }
  return { customerId, restored: true, groupsAdded };
}

/**
 * Offboard a technician — the server-enforced version of "Deactivate
 * technician", which used to flip Technician.active and nothing else.
 *
 * Two live things it must resolve. First, the tech's assigned future jobs: they
 * stayed on the now-dead route on no reassignment surface, so this unassigns
 * them (route/order/tech cleared, back to UNSCHEDULED) into the Schedule pool
 * where the office can place them, and reports the count. A job the tech is
 * mid-visit on (IN_PROGRESS) is left alone and surfaced in the office alert
 * rather than yanked out from under them; history (COMPLETED/past) is
 * untouched. Second, the login: a fired employee's Cognito account still
 * resolved the whole customer book, so this disables it and signs it out now,
 * not eventually.
 *
 * OWNER-only (enforced at the schema), mirroring adminCreateUser: offboarding
 * is a management action. Idempotent — a re-run finds no assigned future jobs
 * and re-asserts the disabled login and active:false.
 */
async function deactivateTechnician(technicianId: string) {
  const client = await dataClient();
  const { data: tech } = await client.models.Technician.get({
    id: technicianId,
  });
  if (!tech) throw new Error(`Technician ${technicianId} not found`);

  // a. Return the tech's future assigned work to the pool for reassignment,
  //    and collect anything in progress to surface rather than yank.
  const today = new Date().toISOString().slice(0, 10);
  const note = `Unassigned ${today}: ${tech.name} was offboarded. Returned to the scheduling pool for reassignment.`;
  let jobsUnassigned = 0;
  const inProgress: { id: string; scheduledDate: string | null }[] = [];
  let token: string | null | undefined;
  do {
    const page = await client.models.Job.list({
      filter: { technicianId: { eq: technicianId } },
      nextToken: token,
      limit: 200,
    });
    for (const job of page.data) {
      if (job.status === "IN_PROGRESS") {
        inProgress.push({ id: job.id, scheduledDate: job.scheduledDate ?? null });
        continue;
      }
      if (job.status === "SCHEDULED" && (job.scheduledDate ?? "") >= today) {
        const { data: updated } = await client.models.Job.update({
          id: job.id,
          status: "UNSCHEDULED",
          routeId: null,
          routeOrder: null,
          technicianId: null,
          notes: job.notes ? `${job.notes}\n${note}` : note,
        });
        if (updated) jobsUnassigned++;
      }
    }
    token = page.nextToken;
  } while (token);

  // b. Kill the login now — disable, global sign-out, drop the TECH group (and
  //    any dynamic groups). A tech invited via adminCreateUser has userSub and
  //    email set; without them there is nothing to disable.
  let loginDisabled = false;
  if (tech.userSub) {
    const username = tech.email?.toLowerCase();
    if (username) {
      await killLogin(username, ["TECH", "cus-", "grp-"]);
      loginDisabled = true;
    }
  }

  // c. Flip the flag last.
  await client.models.Technician.update({ id: technicianId, active: false });

  // d. Give the surfaced work a home: tell the office how much needs
  //    reassignment, and name any visit the tech was mid-way through.
  const inProgressLine =
    inProgress.length > 0
      ? `<p><strong>${inProgress.length} visit${
          inProgress.length === 1 ? " is" : "s are"
        } in progress right now</strong> and ${
          inProgress.length === 1 ? "was" : "were"
        } left in place — check whether ${
          inProgress.length === 1 ? "it" : "they"
        } finished before deciding what to do with ${
          inProgress.length === 1 ? "it" : "them"
        }.</p>`
      : "";
  await notifyOffice({
    subject: `Technician offboarded — ${jobsUnassigned} job${
      jobsUnassigned === 1 ? "" : "s"
    } need reassignment: ${tech.name}`,
    heading: "A technician was offboarded",
    template: "ops-technician-offboarded",
    relatedId: technicianId,
    bodyHtml: `<p><strong>${tech.name}</strong> has been deactivated and their login ${
      loginDisabled ? "disabled and signed out" : "was already gone"
    }.</p>
       <p><strong>${jobsUnassigned} future job${
         jobsUnassigned === 1 ? " is" : "s are"
       } back in the scheduling pool</strong> and need${
         jobsUnassigned === 1 ? "s" : ""
       } to be reassigned on the Schedule board.</p>
       ${inProgressLine}`,
  });

  return { jobsUnassigned, loginDisabled };
}
