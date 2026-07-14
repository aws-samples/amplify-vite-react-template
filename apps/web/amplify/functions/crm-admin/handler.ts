import type { AppSyncResolverEvent } from "aws-lambda";
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminListGroupsForUserCommand,
  AdminRemoveUserFromGroupCommand,
  CognitoIdentityProviderClient,
  CreateGroupCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { dataClient } from "../shared/dataClient";
import { opFieldName } from "../shared/opEvent";
import {
  cusGroup,
  customerAccessGroups,
  grpGroup,
} from "../shared/dynamicGroups";

const cognito = new CognitoIdentityProviderClient();

const USER_POOL_ID = process.env.AMPLIFY_AUTH_USERPOOL_ID!;
const STAFF_ROLES = ["OFFICE", "TECH"] as const;

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

export const handler = async (
  event: AppSyncResolverEvent<AdminCreateUserArgs | SetCustomerGroupArgs>
) => {
  switch (opFieldName(event)) {
    case "adminCreateUser":
      return adminCreateUser(event.arguments as AdminCreateUserArgs);
    case "setCustomerGroup":
      return setCustomerGroup(event.arguments as SetCustomerGroupArgs);
    default:
      throw new Error(`Unknown field ${opFieldName(event)}`);
  }
};

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

async function adminCreateUser(args: AdminCreateUserArgs) {
  const email = args.email.trim().toLowerCase();
  const roles = [...new Set(args.roles)];

  const invalid = roles.filter(
    (r) => r !== "CUSTOMER" && !STAFF_ROLES.includes(r as "OFFICE" | "TECH")
  );
  if (invalid.length) throw new Error(`Invalid roles: ${invalid.join(", ")}`);
  if (roles.includes("CUSTOMER") && !args.customerId)
    throw new Error("customerId is required when creating a CUSTOMER login");

  // Create (or find) the Cognito user. Cognito emails the temporary
  // password using the invite template configured in backend.ts.
  let username = email;
  let sub: string | undefined;
  let created = false;
  try {
    const res = await cognito.send(
      new AdminCreateUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: email,
        DesiredDeliveryMediums: ["EMAIL"],
        ...(args.resend ? { MessageAction: "RESEND" } : {}),
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
  } catch (err) {
    if ((err as { name?: string }).name !== "UsernameExistsException") {
      throw err;
    }
    const existing = await cognito.send(
      new AdminGetUserCommand({ UserPoolId: USER_POOL_ID, Username: email })
    );
    username = existing.Username ?? email;
    sub = existing.UserAttributes?.find((a) => a.Name === "sub")?.Value;
  }
  if (!sub) throw new Error("Could not resolve Cognito sub for user");

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

  return { sub, username, created, groupsAdded };
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
