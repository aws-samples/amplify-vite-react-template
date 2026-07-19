import type { AppSyncResolverEvent } from "aws-lambda";
import {
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminGetUserCommand,
  AdminListGroupsForUserCommand,
  AdminRemoveUserFromGroupCommand,
  AdminUserGlobalSignOutCommand,
  CognitoIdentityProviderClient,
  ListUsersInGroupCommand,
  type UserType,
} from "@aws-sdk/client-cognito-identity-provider";
import { dataClient } from "../shared/dataClient";
import {
  assertTechnicianCanBeSaved,
  assertTechnicianCompliance,
} from "../shared/compliance";
import { opFieldName } from "../shared/opEvent";
import { notifyOffice } from "../shared/email";
import {
  addToGroup,
  ensureCognitoGroup,
  ensureLogin,
  grantCustomerPortal,
  sendMagicLinkInvite,
} from "../shared/portalProvision";
import {
  customerAccessGroups,
  grpGroup,
} from "../shared/dynamicGroups";
import {
  openMissingContactWork,
  openOwnedWork,
  releaseOwnedWorkForSub,
} from "../shared/ownedWork";
import { disposeStaleDrafts } from "../shared/jobAssignment";
import { callerEmail, callerSub } from "../shared/authz";
import {
  assignLeadOwner,
  createLead,
  logLeadTouch,
  reassignLeadsForSub,
  setLeadDisposition,
} from "../shared/leadLifecycle";
import { recordCustomerLifecycleEvent } from "../shared/lifecycleLog";
import { deactivateCustomer as sharedDeactivateCustomer } from "../shared/deactivation";
import {
  assertLifecycleReason,
  lifecycleReasonSummary,
} from "../shared/lifecycleReasons";
import {
  acquireLifecycleClaim,
  releaseLifecycleClaim,
} from "../shared/lifecycleClaim";
import { stripeClient } from "../shared/stripeClient";
import {
  recordStaffAccessEvent,
  type StaffAccessActor,
  type StaffAccessEventInput,
} from "../shared/staffAccessLog";
import {
  acquireOwnerSerial,
  claimStaffAccessCommand,
  finishCommand,
  recordCommandStage,
  releaseOwnerSerial,
  type ClaimResult,
} from "../shared/staffAccessCommand";
import {
  assertOwnerRemains,
  assertReasonCode,
  assertValidRoleSet,
  isStaffRole,
  normalizeRoles,
  STAFF_ROLES,
  staffRolesIn,
  type StaffRole,
} from "../shared/staffRoles";

const cognito = new CognitoIdentityProviderClient();

const USER_POOL_ID = process.env.AMPLIFY_AUTH_USERPOOL_ID!;

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
/** deactivate/reactivate carry a controlled reason (+ optional note for OTHER). */
type LifecycleArgs = {
  customerId: string;
  reasonCode: string;
  note?: string | null;
};
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

type ChangeStaffRolesArgs = {
  email: string;
  roles: string[];
  reasonCode?: string | null;
  reason?: string | null;
  idempotencyKey?: string | null;
};
type OffboardStaffArgs = {
  email: string;
  reasonCode?: string | null;
  reason?: string | null;
  idempotencyKey?: string | null;
};

/** The office's safe customer edits (GL-09): contact, address, notes only —
 *  never a protected lifecycle field. */
type UpdateCustomerContactArgs = {
  customerId: string;
  displayName: string;
  contactName?: string | null;
  email?: string | null;
  phone?: string | null;
  serviceStreet?: string | null;
  serviceCity?: string | null;
  serviceState?: string | null;
  serviceZip?: string | null;
  billingStreet?: string | null;
  billingCity?: string | null;
  billingState?: string | null;
  billingZip?: string | null;
  leadSource?: string | null;
  notes?: string | null;
};

type AdminArgs =
  | AdminCreateUserArgs
  | SetCustomerGroupArgs
  | CustomerIdArgs
  | LifecycleArgs
  | TechnicianIdArgs
  | SaveTechnicianArgs
  | ChangeStaffRolesArgs
  | OffboardStaffArgs
  | UpdateCustomerContactArgs
  | Record<string, never>;

export const handler = async (event: AppSyncResolverEvent<AdminArgs>) => {
  switch (opFieldName(event)) {
    case "adminCreateUser": {
      const args = event.arguments as AdminCreateUserArgs;
      try {
        return await adminCreateUser(args);
      } catch (err) {
        if (args.roles.includes("CUSTOMER") && args.customerId) {
          await recordPortalFailure(
            args.customerId,
            `Portal invite failed for ${args.name}`,
            err
          );
        }
        throw err;
      }
    }
    case "setCustomerGroup":
      return setCustomerGroup(event.arguments as SetCustomerGroupArgs);
    case "revokePortalAccess": {
      const customerId = (event.arguments as CustomerIdArgs).customerId;
      try {
        return await revokePortalAccess(customerId);
      } catch (err) {
        await recordPortalFailure(customerId, "Portal access revocation failed", err);
        throw err;
      }
    }
    case "restorePortalAccess": {
      const customerId = (event.arguments as CustomerIdArgs).customerId;
      try {
        return await restorePortalAccess(customerId);
      } catch (err) {
        await recordPortalFailure(customerId, "Portal access restoration failed", err);
        throw err;
      }
    }
    case "deactivateCustomer": {
      // The whole offboarding in one action (GL-09): money + schedule + portal +
      // status, ordered so INACTIVE never implies a live login. Stripe access is
      // wired into crm-admin (resource.ts) so the plan-cancel half runs here too;
      // the portal revoke is injected because only this function holds the pool.
      const args = event.arguments as LifecycleArgs;
      const code = assertLifecycleReason("DEACTIVATE", args.reasonCode, args.note);
      return await sharedDeactivateCustomer(
        stripeClient(),
        args.customerId,
        { sub: callerSub(event.identity), email: callerEmail(event.identity) },
        {
          reason: lifecycleReasonSummary(code, args.note),
          revokePortalAccess: async () => {
            const r = await revokePortalAccess(args.customerId);
            return { revoked: r.revoked, detail: r.groupsRemoved.join(", ") };
          },
        }
      );
    }
    case "reactivateCustomer": {
      const args = event.arguments as LifecycleArgs;
      const code = assertLifecycleReason("REACTIVATE", args.reasonCode, args.note);
      try {
        return await reactivateCustomer(
          args.customerId,
          { sub: callerSub(event.identity), email: callerEmail(event.identity) },
          { reason: lifecycleReasonSummary(code, args.note) }
        );
      } catch (err) {
        await recordPortalFailure(
          args.customerId,
          "Customer reactivation failed",
          err
        );
        throw err;
      }
    }
    case "updateCustomerContact":
      return updateCustomerContact(event.arguments as UpdateCustomerContactArgs);
    // GL-02 lead lifecycle. The actor is read from the token, never the request,
    // so ownership and who-decided are trustworthy.
    case "createLead":
      return createLead(event.arguments as never, {
        sub: callerSub(event.identity),
        email: callerEmail(event.identity),
      });
    case "logLeadTouch":
      return logLeadTouch(event.arguments as never, {
        sub: callerSub(event.identity),
        email: callerEmail(event.identity),
      });
    case "setLeadDisposition":
      return setLeadDisposition(event.arguments as never, {
        sub: callerSub(event.identity),
        email: callerEmail(event.identity),
      });
    case "assignLeadOwner":
      return assignLeadOwner(event.arguments as never, {
        sub: callerSub(event.identity),
        email: callerEmail(event.identity),
      });
    case "deactivateTechnician": {
      const args = event.arguments as TechnicianIdArgs & {
        reasonCode?: string | null;
        note?: string | null;
        idempotencyKey?: string | null;
      };
      return deactivateTechnician(
        args.technicianId,
        { sub: callerSub(event.identity), email: callerEmail(event.identity) },
        args.reasonCode ?? null,
        args.note ?? null,
        args.idempotencyKey ?? null
      );
    }
    case "saveTechnician":
      return saveTechnician(event.arguments as SaveTechnicianArgs);
    case "changeStaffRoles":
      return changeStaffRoles(event.arguments as ChangeStaffRolesArgs, {
        sub: callerSub(event.identity),
        email: callerEmail(event.identity),
      });
    case "offboardStaff":
      return offboardStaff(event.arguments as OffboardStaffArgs, {
        sub: callerSub(event.identity),
        email: callerEmail(event.identity),
      });
    case "staffRoster":
      return staffRoster();
    default:
      throw new Error(`Unknown field ${opFieldName(event)}`);
  }
};

async function recordPortalFailure(
  customerId: string,
  title: string,
  err: unknown
) {
  const detail = err instanceof Error ? err.message : String(err);
  await openOwnedWork({
    kind: "PORTAL_FAILURE",
    dedupeKey: `${customerId}:${title}`,
    title,
    detail,
    customerId,
    relatedId: customerId,
    sourceUrl: `/customers/${customerId}`,
    resolutionAction:
      "Repair the portal account or group membership, verify the customer can sign in, and record the result.",
    ownerTeam: "OPS",
  });
}

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
 * Open the durable security case for an access-removal that failed partway
 * (GL-14). One idempotent resume action — re-run the same operation — so a
 * timeout or provider error never leaves an enabled or ambiguously privileged
 * person with only a log line behind it.
 */
async function openAccessSecurityCase(opts: {
  subjectLabel: string;
  relatedId: string;
  detail: string;
  resolutionAction: string;
}): Promise<boolean> {
  const id = await openOwnedWork({
    kind: "STAFF_SECURITY",
    dedupeKey: `staff-security:${opts.relatedId}`,
    title: `Access removal did not finish: ${opts.subjectLabel}`,
    detail: opts.detail,
    relatedId: opts.relatedId,
    sourceUrl: "/staff",
    resolutionAction: opts.resolutionAction,
    ownerTeam: "OPS",
  });
  // openOwnedWork never throws; null means the case does NOT exist. Callers
  // must pass that truth on — the UI may never claim a case exists when its
  // write failed (GL-14).
  return id !== null;
}

/**
 * End a login now: disable the account, globally sign it out, THEN remove it
 * from the named groups. The order is the security guarantee (GL-14): disabling
 * stops any new sign-in and the global sign-out revokes tokens already issued,
 * so the moment those two land the person cannot act — even if a later group
 * removal fails. Doing it the other way round (groups first) meant a failure in
 * the middle could leave the person still enabled with a changed role set. If
 * ANY step throws, a durable STAFF_SECURITY case is opened with an idempotent
 * resume (re-run) and the error is rethrown, so the caller never reports success
 * over a half-revoked login. Idempotent — Cognito treats disabling an
 * already-disabled user and signing out an already-signed-out one as no-ops, and
 * we only remove the groups we find the user in.
 *
 * The IAM for AdminDisableUser and AdminUserGlobalSignOut rides on the
 * `manageUsers` grant crm-admin already holds (auth/resource.ts) — there is no
 * granular grant for global sign-out; it exists only inside that bundle.
 */
async function killLogin(
  username: string,
  removePrefixes: string[],
  caseContext?: { subjectLabel: string; relatedId: string }
): Promise<string[]> {
  try {
    // 1. Disable first — stop any new sign-in.
    await cognito.send(
      new AdminDisableUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: username,
      })
    );
    // 2. Then kill live sessions — revoke tokens already issued.
    await cognito.send(
      new AdminUserGlobalSignOutCommand({
        UserPoolId: USER_POOL_ID,
        Username: username,
      })
    );
    // 3. Only now strip the groups. Access is already gone; this tidies the
    //    role set. A failure here still leaves a disabled, signed-out login.
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
    return toRemove;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    let securityCaseOpened = false;
    if (caseContext) {
      securityCaseOpened = await openAccessSecurityCase({
        subjectLabel: caseContext.subjectLabel,
        relatedId: caseContext.relatedId,
        detail: `Disabling/signing-out/removing groups for ${caseContext.subjectLabel} failed partway: ${detail}. The login may still be enabled or partially privileged.`,
        resolutionAction:
          "Re-run the same access removal — every step is idempotent, so a re-run safely finishes it — then confirm the login is disabled and its groups are gone.",
      }).catch(() => false);
    }
    // Carry whether the case durably exists: the caller reports it truthfully
    // instead of promising a case that was never written.
    throw Object.assign(
      err instanceof Error ? err : new Error(detail),
      { securityCaseOpened }
    );
  }
}

async function adminCreateUser(args: AdminCreateUserArgs) {
  const email = args.email.trim().toLowerCase();
  const roles = normalizeRoles(args.roles);

  assertValidRoleSet(roles);
  if (roles.includes("CUSTOMER") && !args.customerId)
    throw new Error("customerId is required when creating a CUSTOMER login");

  // GL-14: a technician login is not a login that merely happens to be in the
  // TECH group — it is a login bound to exactly one Technician profile that
  // carries a current applicator licence. "Invite now, link later" is gone:
  // without the profile the field-action guards (jobAssignment) can never tie
  // the login to a licence, so an unlinked TECH login is one that can be
  // dispatched to regulated work with no credential on record. Every check runs
  // BEFORE any Cognito user is created, so a refusal leaves nothing half-built.
  const client = await dataClient();
  if (roles.includes("TECH")) {
    if (!args.technicianId) {
      throw new Error(
        "A technician login must be linked to a technician record. Pick the technician (or add them first with a current applicator licence) — a technician can't be invited without one."
      );
    }
    const { data: tech } = await client.models.Technician.get({
      id: args.technicianId,
    });
    if (!tech) {
      throw new Error(
        `Technician ${args.technicianId} not found — pick an existing technician record to link this login to.`
      );
    }
    // Active + present, current licence. Reuses the same rule saveTechnician and
    // dispatch enforce, so the message names exactly what's missing.
    assertTechnicianCompliance(tech, { requireActive: true });
    // Exactly one login per technician. If this record already belongs to a
    // different person's login, linking it here would make two logins one
    // identity — the shared-identity case GL-14 forbids.
    if (tech.userSub && tech.email && tech.email.toLowerCase() !== email) {
      throw new Error(
        `${tech.name} is already linked to the login ${tech.email}. Offboard that login first, or pick a technician that isn't linked yet — one technician record, one login.`
      );
    }
  } else if (args.technicianId) {
    // A technicianId without the TECH role is a mistake, not a silent no-op —
    // the caller thinks they are creating a technician login and isn't.
    throw new Error(
      "technicianId was provided but the role set has no TECH role — add the technician role, or remove the technician link."
    );
  }

  // The login/grant/invite core lives in shared/portalProvision — the same
  // implementation the booking webhook uses to provision portal access at
  // conversion (R41), so an invite from this button and an invite from a paid
  // booking cannot drift apart.
  const { username, sub, created } = await ensureLogin(email, args.name);

  // Guard the same-identity race once more now the sub is known: the technician
  // must be free, or already this very login.
  if (args.technicianId && roles.includes("TECH")) {
    const { data: tech } = await client.models.Technician.get({
      id: args.technicianId,
    });
    if (tech?.userSub && tech.userSub !== sub) {
      throw new Error(
        `${tech.name} is already linked to another login. One technician record, one login.`
      );
    }
  }

  const groupsAdded: string[] = [];
  for (const role of staffRolesIn(roles)) {
    await addToGroup(username, role);
    groupsAdded.push(role);
  }

  if (roles.includes("CUSTOMER")) {
    groupsAdded.push(
      ...(await grantCustomerPortal({
        username,
        sub,
        customerId: args.customerId!,
      }))
    );
  }

  if (args.technicianId) {
    await client.models.Technician.update({
      id: args.technicianId,
      userSub: sub,
      email,
    });
  }

  const linkSent = await sendMagicLinkInvite({
    username,
    email,
    name: args.name,
    sub,
    created,
    portal: roles.includes("CUSTOMER"),
    customerId: args.customerId ?? undefined,
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
    await openMissingContactWork({
      customerId,
      displayName: customer.displayName,
      context: "Portal access could not be revoked because the login has no email identifier.",
    });
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
    await openMissingContactWork({
      customerId,
      displayName: customer.displayName,
      context: "Portal access could not be restored because the login has no email identifier.",
    });
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
 * Reactivate a deactivated customer as ONE server-owned action (GL-09).
 *
 * The office used to do this in two separate client calls — flip
 * Customer.status to ACTIVE, then restorePortalAccess — and if the second
 * failed the customer was left ACTIVE with a dead portal login: a paying
 * customer who cannot see their own account. This folds both into one Lambda
 * and, crucially, restores ACCESS FIRST: the approved access state is put back
 * before the status is published, so there is no window in which the record
 * reads ACTIVE while the login is still disabled. If the portal restore throws,
 * the status stays INACTIVE and the failure is truthful rather than hidden.
 *
 * The canceled plans stay canceled — a reactivated customer re-subscribes
 * through a new booking — so this restores access and status, not billing.
 *
 * Concurrency-safe: if a second employee finds the customer already ACTIVE
 * (someone else reactivated in between), it re-asserts the portal access to
 * heal any drift and reports the current fact (alreadyActive) instead of
 * writing a second, misleading transition.
 */
async function reactivateCustomer(
  customerId: string,
  actor: { sub: string | null; email: string | null },
  opts: { reason: string }
) {
  const client = await dataClient();
  const { data: customer } = await client.models.Customer.get({
    id: customerId,
  });
  if (!customer) throw new Error(`Customer ${customerId} not found`);

  // R5: single-winner claim, shared with deactivation, so an interleaving
  // deactivate cannot race this into mixed state. The loser reports the current
  // fact instead of driving a second transition.
  const won = await acquireLifecycleClaim(customerId, "REACTIVATE");
  if (!won) {
    const { data: current } = await client.models.Customer.get({
      id: customerId,
    });
    const status = current?.status ?? customer.status;
    return {
      customerId,
      reactivated: false,
      alreadyActive: status === "ACTIVE",
      portalRestored: false,
      status,
      inProgress: true,
      audited: true,
    };
  }

  try {
    if (customer.status === "ACTIVE") {
      const restore = await restorePortalAccess(customerId);
      return {
        customerId,
        reactivated: false,
        alreadyActive: true,
        portalRestored: restore.restored,
        status: "ACTIVE",
        audited: true,
      };
    }

    // Access before status — see the header. restorePortalAccess is idempotent
    // and a no-op when there is no portal user.
    const restore = await restorePortalAccess(customerId);
    const priorStatus = customer.status;
    await client.models.Customer.update({ id: customerId, status: "ACTIVE" });

    // R4: read the status back. A silently-failed flip must not report success —
    // open blocking recovery and tell the truth.
    const { data: readBack } = await client.models.Customer.get({
      id: customerId,
    });
    if (readBack?.status !== "ACTIVE") {
      await openOwnedWork({
        kind: "LIFECYCLE_RECOVERY",
        dedupeKey: `reactivate-status:${customerId}`,
        title: `Finish a reactivation — status did not persist: ${customer.displayName}`,
        detail: `${customer.displayName}'s portal login was ${restore.restored ? "re-enabled" : "handled"}, but the ACTIVE status write did not persist (still reads ${readBack?.status ?? "unknown"}).`,
        customerId,
        relatedId: customerId,
        sourceUrl: `/customers/${customerId}`,
        resolutionAction:
          "Re-run the reactivation to re-assert ACTIVE — it is idempotent — and confirm the record reads active.",
        ownerTeam: "OPS",
      });
      return {
        customerId,
        reactivated: false,
        alreadyActive: false,
        portalRestored: restore.restored,
        status: readBack?.status ?? customer.status,
        partial: true,
        audited: true,
      };
    }

    const { recorded } = await recordCustomerLifecycleEvent({
      customerId,
      action: "REACTIVATE",
      actor,
      reason: opts.reason,
      priorStatus,
      newStatus: "ACTIVE",
      effects: restore.restored
        ? `Portal login re-enabled (${restore.groupsAdded.join(
            ", "
          )}). Canceled plans left canceled; customer re-subscribes through a new booking.`
        : "No portal login to re-enable. Canceled plans left canceled.",
    });

    return {
      customerId,
      reactivated: true,
      alreadyActive: false,
      portalRestored: restore.restored,
      status: "ACTIVE",
      audited: recorded,
    };
  } finally {
    await releaseLifecycleClaim(customerId);
  }
}

/**
 * The office's safe customer edit (GL-09). With raw Customer.update closed to
 * the browser, this is how the office fixes a contact name, email, phone,
 * address or note — and ONLY those. It cannot touch status, Stripe ids, the
 * payment-method label, portalUserSub, accessGroups, groupId or paid state:
 * those protected lifecycle fields are named-action-only (deactivate/reactivate,
 * setCustomerGroup, the billing and booking Lambdas), which is the whole point
 * of removing the broad update grant. A field the caller does not send is set to
 * null, exactly like the previous raw update the Edit sheet used, so clearing a
 * field still works.
 */
async function updateCustomerContact(args: UpdateCustomerContactArgs) {
  const displayName = args.displayName?.trim();
  if (!displayName) throw new Error("A customer name is required");
  const email = args.email?.trim().toLowerCase() || null;
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new Error("Enter a valid email address, or leave it blank");
  }
  const trim = (v?: string | null) => (v?.trim() ? v.trim() : null);

  const client = await dataClient();
  const { data: customer } = await client.models.Customer.get({
    id: args.customerId,
  });
  if (!customer) throw new Error(`Customer ${args.customerId} not found`);

  const { data: updated, errors } = await client.models.Customer.update({
    id: args.customerId,
    displayName,
    contactName: trim(args.contactName),
    email,
    phone: trim(args.phone),
    serviceStreet: trim(args.serviceStreet),
    serviceCity: trim(args.serviceCity),
    serviceState: trim(args.serviceState),
    serviceZip: trim(args.serviceZip),
    billingStreet: trim(args.billingStreet),
    billingCity: trim(args.billingCity),
    billingState: trim(args.billingState),
    billingZip: trim(args.billingZip),
    leadSource: trim(args.leadSource),
    notes: trim(args.notes),
  });
  if (!updated) {
    throw new Error(
      `Could not save the customer's contact details: ${
        errors?.map((e) => e.message).join("; ") ?? "unknown error"
      }`
    );
  }
  return { customerId: args.customerId };
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
/**
 * Return a technician's future assigned work to the scheduling pool. Each
 * SCHEDULED job dated today or later is unassigned (route/order/tech cleared,
 * back to UNSCHEDULED) so the office can re-place it; a visit the tech is
 * mid-way through (IN_PROGRESS) is left alone and surfaced rather than yanked
 * out from under them; history (COMPLETED/past) is untouched. Shared by
 * deactivateTechnician and offboardStaff so a tech offboarded from either door
 * never leaves work stranded on a dead route.
 *
 * Creates its own data client rather than accepting one: naming the V6 client's
 * type across a function boundary trips tsc's depth ceiling (TS2321).
 */
async function reassignFutureJobs(
  technicianId: string,
  techName: string
): Promise<{
  jobsUnassigned: number;
  /** Jobs whose unassign write failed — each one keeps the offboard out of
   *  COMPLETE and is safely retried by re-running the same command (GL-14). */
  jobsFailed: number;
  inProgress: { id: string; scheduledDate: string | null }[];
}> {
  const client = await dataClient();
  const today = new Date().toISOString().slice(0, 10);
  const note = `Unassigned ${today}: ${techName} was offboarded. Returned to the scheduling pool for reassignment.`;
  let jobsUnassigned = 0;
  let jobsFailed = 0;
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
        try {
          // Re-read right before writing: if the office already moved this job
          // to ANOTHER technician mid-offboard, that newer assignment stands —
          // this handoff must never overwrite it back to UNSCHEDULED.
          const { data: fresh } = await client.models.Job.get({ id: job.id });
          if (
            !fresh ||
            fresh.technicianId !== technicianId ||
            fresh.status !== "SCHEDULED"
          ) {
            continue;
          }
          const { data: updated } = await client.models.Job.update({
            id: job.id,
            status: "UNSCHEDULED",
            routeId: null,
            routeOrder: null,
            technicianId: null,
            notes: fresh.notes ? `${fresh.notes}\n${note}` : note,
          });
          if (updated) {
            jobsUnassigned++;
            // GL-13: an unsent draft on a swept job gets a recorded office
            // disposition; a failed case write keeps the offboard PARTIAL.
            const { caseConfirmed } = await disposeStaleDrafts(
              job.id,
              technicianId,
              null
            );
            if (!caseConfirmed) jobsFailed++;
          } else jobsFailed++;
        } catch {
          jobsFailed++;
        }
      }
    }
    token = page.nextToken;
  } while (token);
  return { jobsUnassigned, jobsFailed, inProgress };
}

/**
 * The COMPLETE read-back for the job handoff (GL-14): count SCHEDULED future
 * jobs still assigned to the technician AFTER the sweep. Zero is the only
 * number that lets an offboard report COMPLETE — a job assigned mid-offboard or
 * left by a failed write shows up here rather than hiding behind per-item
 * counters. Returns -1 when the read itself fails (unknown ≠ confirmed).
 */
async function countAssignedFutureJobs(technicianId: string): Promise<number> {
  try {
    const client = await dataClient();
    const today = new Date().toISOString().slice(0, 10);
    let count = 0;
    let token: string | null | undefined;
    do {
      const page = await client.models.Job.list({
        filter: { technicianId: { eq: technicianId } },
        nextToken: token,
        limit: 200,
      });
      for (const job of page.data) {
        if (job.status === "SCHEDULED" && (job.scheduledDate ?? "") >= today) {
          count++;
        }
      }
      token = page.nextToken;
    } while (token);
    return count;
  } catch (err) {
    console.error("countAssignedFutureJobs failed", technicianId, err);
    return -1;
  }
}

/** Page the office to reassign the work an offboarded staff member left behind. */
async function notifyOffboard(opts: {
  name: string;
  relatedId: string;
  loginDisabled: boolean;
  rolesEnded: string[];
  jobsUnassigned: number;
  inProgress: { id: string; scheduledDate: string | null }[];
}) {
  const inProgressLine =
    opts.inProgress.length > 0
      ? `<p><strong>${opts.inProgress.length} visit${
          opts.inProgress.length === 1 ? " is" : "s are"
        } in progress right now</strong> and ${
          opts.inProgress.length === 1 ? "was" : "were"
        } left in place — check whether ${
          opts.inProgress.length === 1 ? "it" : "they"
        } finished before deciding what to do with ${
          opts.inProgress.length === 1 ? "it" : "them"
        }.</p>`
      : "";
  const jobsLine =
    opts.jobsUnassigned > 0
      ? `<p><strong>${opts.jobsUnassigned} future job${
          opts.jobsUnassigned === 1 ? " is" : "s are"
        } back in the scheduling pool</strong> and need${
          opts.jobsUnassigned === 1 ? "s" : ""
        } to be reassigned on the Schedule board.</p>`
      : "";
  const rolesLine = opts.rolesEnded.length
    ? ` (${opts.rolesEnded.join(", ").toLowerCase()})`
    : "";
  await notifyOffice({
    subject: `Staff offboarded — ${opts.name}${
      opts.jobsUnassigned > 0
        ? `, ${opts.jobsUnassigned} job${
            opts.jobsUnassigned === 1 ? "" : "s"
          } need reassignment`
        : ""
    }`,
    heading: "A staff member was offboarded",
    template: "ops-technician-offboarded",
    relatedId: opts.relatedId,
    bodyHtml: `<p><strong>${opts.name}</strong>${rolesLine} has been offboarded and their login ${
      opts.loginDisabled ? "disabled and signed out" : "was already gone"
    }.</p>
       ${jobsLine}
       ${inProgressLine}`,
  });
}

/**
 * Offboard a technician — the server-enforced version of "Deactivate
 * technician". Returns their future assigned jobs to the pool, disables and
 * signs out their login, flips active:false, and pages the office. A thin
 * wrapper over the shared offboarding pieces so the Schedule board's button
 * and the staff roster's Offboard action do exactly the same thing.
 *
 * OWNER-only (enforced at the schema). Idempotent — a re-run finds no assigned
 * future jobs and re-asserts the disabled login and active:false.
 */
async function deactivateTechnician(
  technicianId: string,
  actor: StaffAccessActor,
  reasonCode: string | null,
  note: string | null,
  idempotencyKey: string | null
) {
  // GL-14: the Schedule entrance validates the same controlled reason the Staff
  // entrance does — never a defaulted or free-typed one — before anything moves.
  const code = assertReasonCode("OFFBOARD", reasonCode, note);
  const key = idempotencyKey?.trim();
  if (!key) {
    throw new Error(
      "This action needs a fresh request key from the screen — reload the Schedule board and retry."
    );
  }
  const client = await dataClient();
  const { data: tech } = await client.models.Technician.get({
    id: technicianId,
  });
  if (!tech) throw new Error(`Technician ${technicianId} not found`);

  // GL-14 R2: a technician who has a login is ended through the ONE hardened
  // staff-access workflow — controlled reason, immutable ledger, a STAFF_SECURITY
  // case on a failed kill, read-back, and the work/lead release — never the old
  // lite bypass that reassigned jobs and killed the login with no audit.
  if (tech.userSub && tech.email) {
    return offboardStaff(
      {
        email: tech.email,
        reasonCode: code,
        reason: note?.trim() || "Deactivated from the Schedule board.",
        idempotencyKey: key,
      },
      actor
    );
  }

  // A technician who was never invited to a login (no Cognito account) — there
  // is no session to end or work/leads to release, but the deactivation is
  // still one durable, reasoned, resumable command, not a silent flag flip.
  const claim = await claimStaffAccessCommand({
    idempotencyKey: key,
    action: "OFFBOARD",
    subjectEmail: tech.email ?? tech.name,
    actor,
    reasonCode: code,
    reason: note ?? "Deactivated from the Schedule board (technician has no login).",
    requestedRoles: [],
  });
  const dup = dedupedCommandResult(claim, tech.email ?? tech.name);
  if (dup) return dup;

  const { jobsUnassigned, jobsFailed, inProgress } = await reassignFutureJobs(
    technicianId,
    tech.name
  );
  let techUpdateError: string | null = null;
  try {
    await client.models.Technician.update({ id: technicianId, active: false });
  } catch (err) {
    techUpdateError = err instanceof Error ? err.message : String(err);
  }
  // Complete means VERIFIED: read the record back rather than trusting the
  // write, so a silent failure cannot report a deactivated technician.
  const { data: verify } = await client.models.Technician.get({
    id: technicianId,
  });
  const technicianConfirmedInactive = verify?.active === false;
  // And no SCHEDULED future job may remain assigned — the read-back fact, not
  // the sweep's own accounting.
  const remainingFutureJobs = await countAssignedFutureJobs(technicianId);

  // Every in-progress visit is a real-world action mid-flight — owned
  // Operations review, exactly as the login path does. Confirmed writes only.
  let caseWriteFailed = false;
  for (const v of inProgress) {
    const opened = await openOwnedWork({
      kind: "STAFF_OFFBOARD",
      dedupeKey: `offboard-inprogress:${v.id}`,
      title: `In-progress visit left by a deactivated technician: ${tech.name}`,
      detail: `${tech.name} was deactivated while visit ${v.id}${v.scheduledDate ? ` (${v.scheduledDate})` : ""} was in progress. It was left in place.`,
      relatedId: v.id,
      sourceUrl: "/schedule",
      resolutionAction:
        "Check whether the visit was actually finished. If it was, complete/close it; if not, reassign or reschedule it and tell the customer.",
      ownerTeam: "OPS",
    });
    if (!opened) caseWriteFailed = true;
  }

  const partial =
    !technicianConfirmedInactive ||
    jobsFailed > 0 ||
    remainingFutureJobs !== 0 ||
    caseWriteFailed;
  let recoveryCaseOpened = false;
  if (partial) {
    recoveryCaseOpened = Boolean(
      await openOwnedWork({
        kind: "STAFF_OFFBOARD",
        dedupeKey: `${technicianId}:deactivate`,
        title: `Finish deactivating ${tech.name}`,
        detail: `Deactivating ${tech.name} did not fully finish: ${[
          technicianConfirmedInactive
            ? null
            : `the inactive flag did not persist${techUpdateError ? ` (${techUpdateError})` : ""}`,
          jobsFailed > 0
            ? `${jobsFailed} future job${jobsFailed === 1 ? "" : "s"} could not be returned to the pool`
            : null,
          remainingFutureJobs > 0
            ? `${remainingFutureJobs} future job${remainingFutureJobs === 1 ? " still reads" : "s still read"} as assigned`
            : remainingFutureJobs === -1
              ? "the remaining-jobs read-back failed"
              : null,
          caseWriteFailed
            ? "an in-progress-visit review case could not be written"
            : null,
        ]
          .filter(Boolean)
          .join("; ")}.`,
        relatedId: technicianId,
        sourceUrl: "/schedule",
        resolutionAction:
          "Re-run Deactivate for this technician (idempotent) — it re-asserts the inactive flag and returns any remaining future jobs to the pool.",
        ownerTeam: "OPS",
      })
    );
  }

  await notifyOffboard({
    name: tech.name,
    relatedId: technicianId,
    loginDisabled: false,
    rolesEnded: ["TECH"],
    jobsUnassigned,
    inProgress,
  });
  const effects = `Technician ${tech.name} ${
    technicianConfirmedInactive ? "verified inactive" : "NOT confirmed inactive"
  }; ${jobsUnassigned} future job${
    jobsUnassigned === 1 ? "" : "s"
  } returned to the scheduling pool${
    jobsFailed > 0 ? `, ${jobsFailed} could not be returned` : ""
  }.${
    inProgress.length
      ? ` ${inProgress.length} in-progress visit${
          inProgress.length === 1 ? "" : "s"
        } put in owned Operations review.`
      : ""
  }`;
  const ledgerRecorded = await recordStaffAccessEventDurable({
    subjectEmail: tech.email ?? tech.name,
    subjectSub: technicianId,
    action: "OFFBOARD",
    actor,
    reasonCode: code,
    reason: note ?? "Deactivated from the Schedule board (technician has no login).",
    priorRoles: ["TECH"],
    requestedRoles: [],
    newRoles: [],
    idempotencyKey: key,
    effects,
    outcome: partial ? "PARTIAL" : "COMPLETE",
  });

  const outcome = partial || !ledgerRecorded ? "PARTIAL" : "COMPLETE";
  const result = {
    technicianId,
    jobsUnassigned,
    jobsFailed,
    inProgressCount: inProgress.length,
    loginDisabled: false,
    technicianConfirmedInactive,
    recoveryCaseOpened,
    ledgerRecorded,
    outcome,
    effects,
    nextStep:
      outcome === "COMPLETE"
        ? null
        : "Re-run Deactivate for this technician — it is idempotent and finishes what remains.",
  };
  const commandRecorded = await finishCommand(key, {
    stage: outcome === "COMPLETE" ? "COMPLETE" : "PARTIAL",
    outcome,
    effects,
    result,
  });
  return { ...result, outcome: commandRecorded ? outcome : "PARTIAL" };
}

/**
 * Translate a lost command claim into the truthful response (GL-14): a
 * duplicate of a finished command returns the SAME persisted outcome; a
 * duplicate of a live one reports in-progress rather than acting. Returns null
 * when the caller won the claim and should proceed.
 */
function dedupedCommandResult(
  claim: ClaimResult,
  subjectLabel: string
): Record<string, unknown> | null {
  if (claim.claimed) return null;
  if (claim.state === "DONE") {
    let result: Record<string, unknown> | null = null;
    if (typeof claim.command.resultJson === "string") {
      try {
        result = JSON.parse(claim.command.resultJson) as Record<string, unknown>;
      } catch {
        result = null;
      }
    }
    return {
      ...(result ?? {}),
      subject: subjectLabel,
      deduped: true,
      outcome: claim.command.outcome ?? claim.command.stage,
      effects: claim.command.effects ?? null,
      stage: claim.command.stage,
    };
  }
  return {
    subject: subjectLabel,
    inProgress: true,
    outcome: "IN_PROGRESS",
    stage: claim.command.stage,
    effects:
      "This change is already being applied by another request. Nothing was re-applied; check back in a moment for its recorded outcome.",
  };
}

// ---------------------------------------------------------------------------
// GL-14: the owner-only workflow to review, change, and disable every staff
// role — not just technicians. The staff roster (below) is the review surface;
// changeStaffRoles and offboardStaff are the change and disable actions. All
// three are OWNER-only at the schema, mirroring adminCreateUser: the login that
// provisions staff is the one that manages and ends them.
// ---------------------------------------------------------------------------

type StaffLogin = {
  username: string;
  sub: string;
  email: string;
  enabled: boolean;
  roles: StaffRole[];
};

/** Resolve a staff login by email: its sub, whether it is enabled, and the
 *  staff roles it currently holds. Throws a fixable error if no such login. */
async function loadStaffLogin(email: string): Promise<StaffLogin> {
  const lower = email.trim().toLowerCase();
  if (!lower) throw new Error("An email is required");
  let user;
  try {
    user = await cognito.send(
      new AdminGetUserCommand({ UserPoolId: USER_POOL_ID, Username: lower })
    );
  } catch (err) {
    if ((err as { name?: string }).name === "UserNotFoundException") {
      throw new Error(`No login found for ${lower}`);
    }
    throw err;
  }
  const sub = user.UserAttributes?.find((a) => a.Name === "sub")?.Value;
  if (!sub) throw new Error(`Could not resolve the login id for ${lower}`);
  const username = user.Username ?? lower;
  const { Groups } = await cognito.send(
    new AdminListGroupsForUserCommand({
      UserPoolId: USER_POOL_ID,
      Username: username,
    })
  );
  const roles = staffRolesIn((Groups ?? []).map((g) => g.GroupName ?? ""));
  return { username, sub, email: lower, enabled: user.Enabled ?? true, roles };
}

/** Re-read a login's effective staff roles straight from Cognito — the truth
 *  after a change, not what was requested. Used to report and to audit the real
 *  end state, so a group op that silently no-op'd shows up as a mismatch. */
async function effectiveStaffRoles(username: string): Promise<StaffRole[]> {
  const { Groups } = await cognito.send(
    new AdminListGroupsForUserCommand({
      UserPoolId: USER_POOL_ID,
      Username: username,
    })
  );
  return staffRolesIn((Groups ?? []).map((g) => g.GroupName ?? ""));
}

/** Count OTHER logins that are enabled and in the OWNER group right now — the
 *  pool the last-owner guard protects. */
async function countOtherUsableOwners(exceptUsername: string): Promise<number> {
  let count = 0;
  let token: string | undefined;
  do {
    const res = await cognito.send(
      new ListUsersInGroupCommand({
        UserPoolId: USER_POOL_ID,
        GroupName: "OWNER",
        Limit: 60,
        NextToken: token,
      })
    );
    for (const u of res.Users ?? []) {
      if (u.Username !== exceptUsername && (u.Enabled ?? true)) count++;
    }
    token = res.NextToken;
  } while (token);
  return count;
}

/** Count ALL logins enabled and in the OWNER group right now — the post-change
 *  safety net that catches a concurrency race two point-in-time checks miss (two
 *  owners each offboarding the other, both passing the pre-check). */
async function countAllUsableOwners(): Promise<number> {
  let count = 0;
  let token: string | undefined;
  do {
    const res = await cognito.send(
      new ListUsersInGroupCommand({
        UserPoolId: USER_POOL_ID,
        GroupName: "OWNER",
        Limit: 60,
        NextToken: token,
      })
    );
    for (const u of res.Users ?? []) {
      if (u.Enabled ?? true) count++;
    }
    token = res.NextToken;
  } while (token);
  return count;
}

/** Globally sign a login out — revoke every token already issued so a demotion
 *  takes effect on the next request, not whenever the old access token expires. */
async function globalSignOut(username: string): Promise<void> {
  await cognito.send(
    new AdminUserGlobalSignOutCommand({
      UserPoolId: USER_POOL_ID,
      Username: username,
    })
  );
}

/** Re-read a login's enabled state straight from Cognito — used to confirm a
 *  disable actually persisted before an action reports itself complete. */
async function readLoginEnabled(username: string): Promise<boolean> {
  const user = await cognito.send(
    new AdminGetUserCommand({ UserPoolId: USER_POOL_ID, Username: username })
  );
  return user.Enabled ?? true;
}

/**
 * Record the staff-access event as a REQUIRED durable outcome (GL-14 / X1). If
 * the immutable row cannot be written, the change still happened — so rather than
 * lose the proof, open a STAFF_SECURITY case demanding the record be
 * reconstructed, and tell the caller so it reports PARTIAL, never a clean success
 * over a missing audit row. Returns whether the row was durably written.
 */
async function recordStaffAccessEventDurable(
  input: StaffAccessEventInput
): Promise<boolean> {
  const written = await recordStaffAccessEvent(input);
  if (!written) {
    await openAccessSecurityCase({
      subjectLabel: input.subjectEmail,
      relatedId: `audit:${input.subjectEmail}:${input.idempotencyKey ?? input.action}`,
      detail: `A ${input.action} on ${input.subjectEmail} was applied but its immutable staff-access audit row could not be written. The action stands; the proof of it does not.`,
      resolutionAction:
        "Reconstruct the staff-access ledger entry from this case's details (actor, reason, prior/new roles, effects) so the history is complete and provable.",
    }).catch(() => undefined);
  }
  return written;
}

/**
 * Change a staff login's role set to exactly `roles`. Adds the missing staff
 * groups and removes the ones no longer wanted, leaving CUSTOMER and dynamic
 * (cus-/grp-) memberships untouched — this is a staff-role change, not a portal
 * one. Two rules it will not break:
 *   - Granting TECH requires an already-linked, active, currently-licensed
 *     technician, for the same reason adminCreateUser does: a TECH login with
 *     no licensed profile can be dispatched to regulated work with nothing on
 *     record. Link the technician (re-invite) before granting the role.
 *   - It will not strip OWNER from the last usable owner.
 * To remove every role, offboard the person instead — an empty role set here is
 * refused so "no roles" never silently means "still has a working login".
 *
 * Convergent and idempotent: it reconciles the effective set each call, so a
 * retry after a mid-loop failure adds only the still-missing groups and removes
 * only the still-extra ones. Prior and post-change effective roles are read back
 * from Cognito — not assumed from the request — and recorded in the staff-access
 * ledger, so a group op that silently failed to take surfaces as a mismatch
 * rather than a success. An `actor` and (optional) approved `reason` make the
 * change a reasoned, attributable event.
 */
async function changeStaffRoles(
  args: ChangeStaffRolesArgs,
  actor: StaffAccessActor
) {
  // Every change starts from an approved, controlled reason — never blank or
  // free-typed. Refused before anything is touched.
  const reasonCode = assertReasonCode("CHANGE_ROLES", args.reasonCode, args.reason);

  const roles = normalizeRoles(args.roles);
  assertValidRoleSet(roles);
  const want = staffRolesIn(roles);
  if (want.length === 0) {
    throw new Error(
      "A staff member needs at least one role. To remove all access, offboard them instead."
    );
  }

  // GL-14: the durable command is claimed BEFORE any provider read or change.
  // The conditional create is the single-winner claim: a concurrent duplicate
  // loses it and is handed the persisted progress/outcome instead of driving a
  // second change, and a process stop leaves the command (stage + error) for a
  // resume rather than an unrecorded partial change.
  const key = args.idempotencyKey?.trim();
  if (!key) {
    throw new Error(
      "This change needs a fresh request key from the screen — reload the Staff screen and retry."
    );
  }
  const email = args.email.trim().toLowerCase();
  const claim = await claimStaffAccessCommand({
    idempotencyKey: key,
    action: "CHANGE_ROLES",
    subjectEmail: email,
    actor,
    reasonCode,
    reason: args.reason,
    requestedRoles: want,
  });
  const dup = dedupedCommandResult(claim, email);
  if (dup) return dup;

  // From here the command owns the request: a validation refusal lands in a
  // terminal FAILED (nothing changed, safe to retry with a fresh key), and any
  // failure AFTER the first group write returns a truthful PARTIAL with a
  // durable security owner — never a raw throw that loses the outcome.
  let mutated = false;
  let ownerSerialHeld = false;
  try {
    const target = await loadStaffLogin(args.email);
    const have = target.roles;

    const removingOwner = have.includes("OWNER") && !want.includes("OWNER");
    const grantingOwner = !have.includes("OWNER") && want.includes("OWNER");
    if (removingOwner || grantingOwner) {
      // GL-14: owner-set changes are SERIALIZED. Holding the mutex across the
      // last-owner check and the change makes the check authoritative — two
      // concurrent demotions can no longer both pass a point-in-time count and
      // then depend on a fallible rollback to keep one owner alive.
      ownerSerialHeld = await acquireOwnerSerial(key);
      if (!ownerSerialHeld) {
        throw new Error(
          "Another owner change is being applied right now. Wait a moment, then retry."
        );
      }
    }
    if (removingOwner) {
      assertOwnerRemains({
        targetLabel: target.email,
        otherUsableOwners: await countOtherUsableOwners(target.username),
        targetKeepsOwner: false,
      });
    }

    if (want.includes("TECH") && !have.includes("TECH")) {
      const client = await dataClient();
      const { data: techs } =
        await client.models.Technician.listTechnicianByUserSub({
          userSub: target.sub,
        });
      const tech = techs?.[0];
      if (!tech) {
        throw new Error(
          `Can't grant the technician role to ${target.email}: this login isn't linked to a technician record. Link it first with an invite (which binds a login to a licensed technician atomically).`
        );
      }
      assertTechnicianCompliance(tech, { requireActive: true });
    }

    await recordCommandStage(key, "VALIDATED", {
      priorRoles: have,
      subjectSub: target.sub,
    });

    const toAdd = want.filter((r) => !have.includes(r));
    const toRemove = have.filter((r) => !want.includes(r));

    // Apply each group change individually. A failure no longer aborts the
    // whole action into an unowned mixed state: the rest still apply, the
    // failure is collected, and the result is a truthful PARTIAL with one safe
    // resume (re-run — it re-applies only what is still missing).
    mutated = true;
    const opFailures: string[] = [];
    for (const r of toAdd) {
      try {
        await addToGroup(target.username, r);
      } catch (err) {
        opFailures.push(
          `add ${r}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    for (const r of toRemove) {
      try {
        await removeFromGroup(target.username, r);
      } catch (err) {
        opFailures.push(
          `remove ${r}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    // A demotion must END the person's sessions, not just change group
    // membership — otherwise an old token keeps the removed role until it
    // expires. Attempted even after a failed group op: the sign-out is the
    // security-critical half.
    let sessionsInvalidated = false;
    if (toRemove.length > 0) {
      try {
        await globalSignOut(target.username);
        sessionsInvalidated = true;
      } catch (err) {
        opFailures.push(
          `sign-out: ${err instanceof Error ? err.message : String(err)} — old sessions may still carry the removed role${toRemove.length === 1 ? "" : "s"}`
        );
      }
    }

    // Defense-in-depth: under the owner serial this cannot fire, but if the
    // pool ever reads empty, restore OWNER rather than proceed.
    if (removingOwner && (await countAllUsableOwners()) === 0) {
      await addToGroup(target.username, "OWNER");
      throw new Error(
        `That change would leave BuzzKill with no usable owner. ${target.email} keeps the owner role — promote a second owner, then retry.`
      );
    }

    // Removing the TECH role is a field departure even when the person keeps
    // office roles: their linked technician record goes inactive and future
    // assigned visits return to the pool — a future job may not remain on
    // someone who no longer holds the role (GL-14). Failures are counted, not
    // swallowed, and keep the change out of COMPLETE.
    let techJobsUnassigned = 0;
    let techJobsFailed = 0;
    let techInProgressCount = 0;
    if (toRemove.includes("TECH")) {
      try {
        const client = await dataClient();
        const { data: techs } =
          await client.models.Technician.listTechnicianByUserSub({
            userSub: target.sub,
          });
        const tech = techs?.[0];
        if (tech) {
          const r = await reassignFutureJobs(tech.id, tech.name);
          techJobsUnassigned = r.jobsUnassigned;
          techJobsFailed = r.jobsFailed;
          techInProgressCount = r.inProgress.length;
          for (const v of r.inProgress) {
            const opened = await openOwnedWork({
              kind: "STAFF_OFFBOARD",
              dedupeKey: `offboard-inprogress:${v.id}`,
              title: `In-progress visit left by a technician losing the TECH role: ${tech.name}`,
              detail: `${tech.name} lost the TECH role while visit ${v.id}${v.scheduledDate ? ` (${v.scheduledDate})` : ""} was in progress. It was left in place.`,
              relatedId: v.id,
              sourceUrl: "/schedule",
              resolutionAction:
                "Check whether the visit was actually finished. If it was, complete/close it; if not, reassign or reschedule it and tell the customer.",
              ownerTeam: "OPS",
            });
            if (!opened) techJobsFailed++;
          }
          await client.models.Technician.update({ id: tech.id, active: false });
          const { data: verify } = await client.models.Technician.get({
            id: tech.id,
          });
          if (verify?.active !== false) techJobsFailed++;
        }
      } catch (err) {
        techJobsFailed++;
        opFailures.push(
          `technician handoff: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    // Read the end state back from Cognito rather than trusting the request:
    // this is what the screen shows before reporting success, and what the
    // ledger records.
    const effective = await effectiveStaffRoles(target.username);
    const converged =
      opFailures.length === 0 &&
      techJobsFailed === 0 &&
      effective.length === want.length &&
      want.every((r) => effective.includes(r));

    // Every partial state has a durably CONFIRMED security owner. The flag is
    // passed to the caller so the screen only claims a case that exists.
    let securityCaseOpened = false;
    if (!converged) {
      securityCaseOpened = await openAccessSecurityCase({
        subjectLabel: target.email,
        relatedId: target.sub,
        detail: `Role change on ${target.email} did not fully take. Requested ${want.join(", ")}; effective ${effective.join(", ") || "none"}.${opFailures.length ? ` Failures: ${opFailures.join("; ")}.` : ""}`,
        resolutionAction:
          "Resume the role change from the Staff screen — re-running the same change re-applies only what is still missing — then confirm the effective roles match the request.",
      });
    }

    const ledgerRecorded = await recordStaffAccessEventDurable({
      subjectEmail: target.email,
      subjectSub: target.sub,
      action: "CHANGE_ROLES",
      actor,
      reasonCode,
      reason: args.reason ?? null,
      priorRoles: have,
      requestedRoles: want,
      newRoles: effective,
      idempotencyKey: key,
      effects: `Added ${toAdd.join(", ") || "none"}; removed ${
        toRemove.join(", ") || "none"
      }.${sessionsInvalidated ? " Sessions signed out." : ""}${converged ? "" : ` Effective roles did not converge on the request (${want.join(", ")}) — a group change did not take.`}`,
      outcome: converged ? "COMPLETE" : "PARTIAL",
    });

    const outcome = converged && ledgerRecorded ? "COMPLETE" : "PARTIAL";
    const effects = `Added ${toAdd.join(", ") || "none"}; removed ${
      toRemove.join(", ") || "none"
    }; effective roles now ${effective.join(", ") || "none"}.${
      sessionsInvalidated ? " Sessions signed out." : ""
    }${
      toRemove.includes("TECH")
        ? ` Technician handoff: ${techJobsUnassigned} future job${
            techJobsUnassigned === 1 ? "" : "s"
          } returned to the pool${
            techJobsFailed > 0 ? `, ${techJobsFailed} item(s) failed` : ""
          }${
            techInProgressCount > 0
              ? `, ${techInProgressCount} in-progress visit(s) put in owned review`
              : ""
          }.`
        : ""
    }`;
    const result = {
      email: target.email,
      roles: want,
      effectiveRoles: effective,
      converged,
      sessionsInvalidated,
      ledgerRecorded,
      securityCaseOpened,
      opFailures,
      techJobsUnassigned,
      techJobsFailed,
      outcome,
      effects,
      nextStep:
        outcome === "COMPLETE"
          ? null
          : "Resume the role change — re-running the same change applies only what is still missing.",
      added: toAdd,
      removed: toRemove,
    };
    const commandRecorded = await finishCommand(key, {
      stage: outcome === "COMPLETE" ? "COMPLETE" : "PARTIAL",
      outcome,
      effects,
      lastError: opFailures.join("; ") || null,
      result,
    });
    return { ...result, outcome: commandRecorded ? outcome : "PARTIAL" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!mutated) {
      // Refused before anything changed — terminal, truthful, safe to retry
      // with a fresh key once the blocker is fixed.
      await finishCommand(key, {
        stage: "FAILED",
        outcome: "REFUSED",
        effects: "Nothing was changed.",
        lastError: message,
      });
      throw err;
    }
    // Failed after mutation began (e.g. the Cognito read-back itself threw).
    // Own it durably and return the truth instead of throwing it away.
    const securityCaseOpened = await openAccessSecurityCase({
      subjectLabel: email,
      relatedId: `role-change:${email}`,
      detail: `Role change on ${email} stopped partway: ${message}. The effective role set may not match the request.`,
      resolutionAction:
        "Resume the role change from the Staff screen — re-running the same change re-applies only what is still missing — then confirm the effective roles.",
    }).catch(() => false);
    const ledgerRecorded = await recordStaffAccessEventDurable({
      subjectEmail: email,
      action: "CHANGE_ROLES",
      actor,
      reasonCode,
      reason: args.reason ?? null,
      requestedRoles: want,
      idempotencyKey: key,
      effects: `Stopped partway: ${message}`,
      outcome: "PARTIAL",
    });
    await finishCommand(key, {
      stage: "PARTIAL",
      outcome: "PARTIAL",
      effects: `Stopped partway: ${message}`,
      lastError: message,
    });
    return {
      email,
      outcome: "PARTIAL",
      error: message,
      securityCaseOpened,
      ledgerRecorded,
      effects: `Stopped partway: ${message}`,
      nextStep:
        "Resume the role change — re-running the same change applies only what is still missing.",
    };
  } finally {
    if (ownerSerialHeld) await releaseOwnerSerial();
  }
}

/**
 * Offboard any staff member — the generic, all-roles version of
 * deactivateTechnician. One guided action, ordered so removing access is
 * fail-safe:
 *   1. Revoke access FIRST and confirm it: disable the Cognito login, globally
 *      sign it out (live sessions die in minutes, not whenever the access token
 *      happens to expire), and remove every staff and dynamic group. If this
 *      step throws, the whole action fails and nothing reports success — a retry
 *      re-asserts, so the system errs toward "access removed", never toward a
 *      departed person who still holds a working session.
 *   2. THEN the downstream effects, which no longer gate access: if the login is
 *      linked to a technician, return their future jobs to the pool and flip the
 *      technician inactive. Because access is already gone, a failure here
 *      strands work but never leaves the person able to act — so it does not
 *      throw. It opens an owned OPS case with one safe resume (re-run offboard)
 *      and the action reports a PARTIAL outcome truthfully.
 *   - Audit/legal records — the Technician row and every finalized ServiceReport
 *     that names it and its licence — stay put (they must outlive the
 *     employment); nothing is deleted, and the staff-access ledger keeps the
 *     departure visible after they leave the roster.
 *   - Pages the office with anything that now needs reassignment.
 * It will not offboard the last usable owner. Idempotent — a re-run re-asserts
 * the disabled login and finds no future work.
 */
async function offboardStaff(
  args: OffboardStaffArgs,
  actor: StaffAccessActor
) {
  const reasonCode = assertReasonCode("OFFBOARD", args.reasonCode, args.reason);

  // GL-14: claim the durable command BEFORE any provider read or change — the
  // single-winner conditional create. A duplicate returns the persisted
  // progress/outcome; a stale command (process stop) is reclaimed under an
  // exclusive lease and resumed idempotently.
  const rawKey = args.idempotencyKey?.trim();
  if (!rawKey) {
    throw new Error(
      "This action needs a fresh request key from the screen — reload the Staff screen and retry."
    );
  }
  const key: string = rawKey;
  const email = args.email.trim().toLowerCase();
  const claim = await claimStaffAccessCommand({
    idempotencyKey: key,
    action: "OFFBOARD",
    subjectEmail: email,
    actor,
    reasonCode,
    reason: args.reason,
    requestedRoles: [],
  });
  const dup = dedupedCommandResult(claim, email);
  if (dup) return dup;

  let mutated =
    claim.claimed &&
    claim.resumedFromStage !== null &&
    claim.resumedFromStage !== "REQUESTED";
  let ownerSerialHeld = false;
  try {
    return await runOffboard();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!mutated) {
      await finishCommand(key, {
        stage: "FAILED",
        outcome: "REFUSED",
        effects: "Nothing was changed.",
        lastError: message,
      });
      throw err;
    }
    // Stopped after access changes began. killLogin already opened (and
    // reported) the security case when it threw; pass its truth through and
    // return the persisted PARTIAL instead of losing it in a raw error.
    const securityCaseOpened =
      (err as { securityCaseOpened?: boolean }).securityCaseOpened === true;
    const ledgerRecorded = await recordStaffAccessEventDurable({
      subjectEmail: email,
      action: "OFFBOARD",
      actor,
      reasonCode,
      reason: args.reason ?? null,
      requestedRoles: [],
      idempotencyKey: key,
      effects: `Stopped partway: ${message}`,
      outcome: "PARTIAL",
    });
    await finishCommand(key, {
      stage: "PARTIAL",
      outcome: "PARTIAL",
      effects: `Stopped partway: ${message}`,
      lastError: message,
    });
    return {
      email,
      outcome: "PARTIAL",
      error: message,
      securityCaseOpened,
      ledgerRecorded,
      effects: `Stopped partway: ${message}`,
      nextStep:
        "Re-run Offboard with the same request — every step is idempotent and it continues from where it stopped.",
    };
  } finally {
    if (ownerSerialHeld) await releaseOwnerSerial();
  }

  async function runOffboard() {
  const target = await loadStaffLogin(args.email);
  const client = await dataClient();
  const { data: techs } =
    await client.models.Technician.listTechnicianByUserSub({
      userSub: target.sub,
    });
  const tech = techs?.[0] ?? null;

  if (target.roles.length === 0 && !tech) {
    throw new Error(
      `${target.email} is not a staff login — nothing to offboard.`
    );
  }

  const offboardingOwner = target.roles.includes("OWNER");
  if (offboardingOwner) {
    // GL-14: owner-set changes are serialized — the mutex is held across the
    // last-owner check AND the removal, so the check is authoritative and no
    // fallible rollback is needed to preserve an owner.
    ownerSerialHeld = await acquireOwnerSerial(key);
    if (!ownerSerialHeld) {
      throw new Error(
        "Another owner change is being applied right now. Wait a moment, then retry."
      );
    }
    assertOwnerRemains({
      targetLabel: target.email,
      otherUsableOwners: await countOtherUsableOwners(target.username),
      targetKeepsOwner: false,
    });
  }

  await recordCommandStage(key, "VALIDATED", {
    priorRoles: target.roles,
    subjectSub: target.sub,
  });

  // 1. Revoke access first: disable + global sign-out, THEN drop groups. A
  //    failure at any step opens a durable STAFF_SECURITY case and throws, so
  //    this never reports success over a half-revoked login.
  mutated = true;
  const groupsRemoved = await killLogin(
    target.username,
    ["OWNER", "OFFICE", "FINANCE", "TECH", "cus-", "grp-"],
    { subjectLabel: target.email, relatedId: target.sub }
  );
  const rolesRemoved = groupsRemoved.filter(isStaffRole);

  // Defense-in-depth: under the owner serial this cannot fire, but if the pool
  // ever reads empty, restore access rather than proceed.
  if (offboardingOwner && (await countAllUsableOwners()) === 0) {
    await cognito.send(
      new AdminEnableUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: target.username,
      })
    );
    await addToGroup(target.username, "OWNER");
    throw new Error(
      `Offboarding ${target.email} would leave BuzzKill with no usable owner. Their access has been restored — promote a second owner, then retry.`
    );
  }

  await recordCommandStage(key, "ACCESS_DONE", {
    effects: `Login disabled and signed out; groups removed: ${
      groupsRemoved.join(", ") || "none"
    }.`,
  });

  // 2. Downstream effects — fail-safe, because access is already gone.
  let jobsUnassigned = 0;
  let jobsFailed = 0;
  let inProgress: { id: string; scheduledDate: string | null }[] = [];
  let technicianDeactivated = false;
  let downstreamError: string | null = null;
  if (tech) {
    try {
      const r = await reassignFutureJobs(tech.id, tech.name);
      jobsUnassigned = r.jobsUnassigned;
      jobsFailed = r.jobsFailed;
      inProgress = r.inProgress;
      await client.models.Technician.update({ id: tech.id, active: false });
      technicianDeactivated = true;
    } catch (err) {
      downstreamError = err instanceof Error ? err.message : String(err);
    }
  }

  // Track whether every case this flow depends on was CONFIRMED written — the
  // result may never claim owned recovery that does not durably exist (GL-14).
  let caseWriteFailed = false;
  if (downstreamError || jobsFailed > 0) {
    const opened = await openOwnedWork({
      kind: "STAFF_OFFBOARD",
      dedupeKey: `${target.email}:offboard`,
      title: `Offboarding of ${tech?.name ?? target.email} didn't finish`,
      detail: `Access was revoked (login disabled, signed out, roles removed) but returning ${tech?.name ?? "the technician"}'s future work to the pool ${
        downstreamError
          ? `failed: ${downstreamError}`
          : `left ${jobsFailed} job${jobsFailed === 1 ? "" : "s"} unmoved`
      }.`,
      relatedId: tech?.id ?? target.sub,
      sourceUrl: "/staff",
      resolutionAction:
        "Re-run Offboard for this person — access is already removed, so the re-run only returns their future jobs to the scheduling pool and flips the technician inactive.",
      ownerTeam: "OPS",
    });
    if (!opened) caseWriteFailed = true;
  }

  // 3. Read the result back — "complete" means verified, not assumed (GL-14).
  //    Confirm the login is disabled and, for a technician, that the record
  //    actually persisted inactive.
  let loginConfirmedDisabled = false;
  try {
    loginConfirmedDisabled = !(await readLoginEnabled(target.username));
  } catch {
    loginConfirmedDisabled = false;
  }
  let technicianConfirmedInactive = !tech;
  let remainingFutureJobs = 0;
  if (tech) {
    const { data: verify } = await client.models.Technician.get({ id: tech.id });
    technicianConfirmedInactive = verify?.active === false;
    // COMPLETE requires the read-back fact, not the sweep's own accounting: no
    // SCHEDULED future job may remain on this now-inactive technician.
    remainingFutureJobs = await countAssignedFutureJobs(tech.id);
    if (remainingFutureJobs !== 0 && !downstreamError && jobsFailed === 0) {
      // The sweep believed it finished, but the read-back disagrees (a job
      // assigned mid-offboard, or a failed read). Own it — never report green
      // over an unverified handoff.
      const opened = await openOwnedWork({
        kind: "STAFF_OFFBOARD",
        dedupeKey: `${target.email}:offboard`,
        title: `Offboarding of ${tech.name} didn't finish`,
        detail:
          remainingFutureJobs > 0
            ? `After the handoff, ${remainingFutureJobs} SCHEDULED future job${remainingFutureJobs === 1 ? " still reads" : "s still read"} as assigned to ${tech.name}, who is now inactive.`
            : `The read-back that confirms no future job remains on ${tech.name} failed, so the handoff cannot be verified.`,
        relatedId: tech.id,
        sourceUrl: "/staff",
        resolutionAction:
          "Re-run Offboard for this person — it returns any remaining future jobs to the scheduling pool — then confirm none remain.",
        ownerTeam: "OPS",
      });
      if (!opened) caseWriteFailed = true;
    }
  }

  // Each in-progress visit is a real-world action mid-flight — put it in owned
  // Operations review rather than only naming it in an email, so nothing a
  // departing technician was doing is left unwatched. Confirmed writes only: a
  // visit whose case did not persist keeps the offboard out of COMPLETE.
  for (const v of inProgress) {
    const opened = await openOwnedWork({
      kind: "STAFF_OFFBOARD",
      dedupeKey: `offboard-inprogress:${v.id}`,
      title: `In-progress visit left by an offboarded technician: ${tech?.name ?? target.email}`,
      detail: `${tech?.name ?? target.email} was offboarded while visit ${v.id}${v.scheduledDate ? ` (${v.scheduledDate})` : ""} was in progress. It was left in place, not yanked out from under them.`,
      relatedId: v.id,
      sourceUrl: "/schedule",
      resolutionAction:
        "Check whether the visit was actually finished. If it was, complete/close it; if not, reassign or reschedule it and tell the customer.",
      ownerTeam: "OPS",
    });
    if (!opened) caseWriteFailed = true;
  }

  // GL-18/GL-14 R5: every open exception this person had claimed goes back to
  // its team inbox — no required action may stay owned by someone offboarded.
  const workReleased = await releaseOwnedWorkForSub({
    sub: target.sub,
    reason: `${target.email} was offboarded.`,
    actorEmail: actor.email,
  });
  // GL-14 R6: hand their open leads back to the Sales queue so no later sweep
  // routes revenue work to a departed person.
  const leadsReassigned = await reassignLeadsForSub({
    sub: target.sub,
    actorEmail: actor.email,
  });

  // GL-14 R5: a partial hand-over is not "complete" — own it and keep offboarding
  // out of COMPLETE until every claim and lead is actually re-homed, with a safe
  // idempotent resume (re-run Offboard).
  const releaseFailed = workReleased.failed > 0 || leadsReassigned.failed > 0;
  if (releaseFailed) {
    const opened = await openOwnedWork({
      kind: "STAFF_OFFBOARD",
      dedupeKey: `${target.email}:release`,
      title: `Finish returning ${tech?.name ?? target.email}'s owned work and leads`,
      detail: `Offboarding ${target.email} could not return ${workReleased.failed} owned exception(s) and ${leadsReassigned.failed} lead(s) to the team. Access is already revoked; the hand-over is incomplete.`,
      relatedId: target.sub,
      sourceUrl: "/staff",
      resolutionAction:
        "Re-run Offboard for this person (idempotent) to return their remaining claimed exceptions and open leads to the Sales/Ops team queues.",
      ownerTeam: "OPS",
    });
    if (!opened) caseWriteFailed = true;
  }

  await recordCommandStage(key, "HANDOFF_DONE");

  const outcome =
    downstreamError ||
    jobsFailed > 0 ||
    remainingFutureJobs !== 0 ||
    !loginConfirmedDisabled ||
    !technicianConfirmedInactive ||
    releaseFailed ||
    caseWriteFailed
      ? "PARTIAL"
      : "COMPLETE";

  // If the login could not be confirmed disabled, that is a security gap, not a
  // mere partial — own it explicitly, and only claim the case if it durably
  // exists.
  let securityCaseOpened = false;
  if (!loginConfirmedDisabled) {
    securityCaseOpened = await openAccessSecurityCase({
      subjectLabel: target.email,
      relatedId: target.sub,
      detail: `${target.email} was offboarded but a read-back could not confirm the login is disabled. It may still be enabled.`,
      resolutionAction:
        "Re-run Offboard (idempotent), then confirm in Cognito that the login is disabled and signed out.",
    });
    if (!securityCaseOpened) caseWriteFailed = true;
  }

  const effectsSummary = [
    loginConfirmedDisabled
      ? "Login disabled and globally signed out (confirmed)."
      : securityCaseOpened
        ? "Login disable NOT confirmed — security case opened."
        : "Login disable NOT confirmed, and the security case could not be written — re-run Offboard now.",
    `Roles removed: ${rolesRemoved.join(", ") || "none"}.`,
    tech
      ? technicianConfirmedInactive && jobsFailed === 0 && remainingFutureJobs === 0
        ? `Technician ${tech.name} verified inactive; ${jobsUnassigned} future job${
            jobsUnassigned === 1 ? "" : "s"
          } returned to the scheduling pool (read-back confirms none remain).`
        : `Technician ${tech.name} reassignment/deactivation incomplete${
            jobsFailed > 0
              ? ` (${jobsFailed} job${jobsFailed === 1 ? "" : "s"} could not be returned)`
              : ""
          }${
            remainingFutureJobs > 0
              ? ` (${remainingFutureJobs} future job${remainingFutureJobs === 1 ? "" : "s"} still read as assigned)`
              : remainingFutureJobs === -1
                ? " (the remaining-jobs read-back failed)"
                : ""
          } — owned OPS case ${downstreamError || jobsFailed > 0 ? "opened" : "required"}.`
      : "No linked technician.",
    inProgress.length
      ? `${inProgress.length} in-progress visit${
          inProgress.length === 1 ? "" : "s"
        } put in owned Operations review.`
      : "",
    workReleased.released
      ? `${workReleased.released} owned exception${
          workReleased.released === 1 ? "" : "s"
        } returned to the team inbox.`
      : "",
    leadsReassigned.reassigned
      ? `${leadsReassigned.reassigned} open lead${
          leadsReassigned.reassigned === 1 ? "" : "s"
        } returned to the Sales queue.`
      : "",
    releaseFailed
      ? `Hand-over incomplete (${workReleased.failed} exception(s), ${leadsReassigned.failed} lead(s)) — owned OPS case opened.`
      : "",
    caseWriteFailed
      ? "At least one recovery case could not be written — re-run Offboard to re-assert it."
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  const ledgerRecorded = await recordStaffAccessEventDurable({
    subjectEmail: target.email,
    subjectSub: target.sub,
    action: "OFFBOARD",
    actor,
    reasonCode,
    reason: args.reason ?? null,
    priorRoles: target.roles,
    requestedRoles: [],
    newRoles: [],
    idempotencyKey: key,
    effects: effectsSummary,
    outcome,
  });

  await notifyOffboard({
    name: tech?.name ?? target.email,
    relatedId: tech?.id ?? target.sub,
    loginDisabled: loginConfirmedDisabled,
    rolesEnded: rolesRemoved,
    jobsUnassigned,
    inProgress,
  });

  const finalOutcome = ledgerRecorded ? outcome : "PARTIAL";
  const result = {
    email: target.email,
    loginDisabled: loginConfirmedDisabled,
    rolesRemoved,
    technicianDeactivated,
    technicianConfirmedInactive,
    jobsUnassigned,
    jobsFailed,
    inProgressCount: inProgress.length,
    workReleased: workReleased.released,
    leadsReassigned: leadsReassigned.reassigned,
    releaseFailed,
    ledgerRecorded,
    securityCaseOpened,
    caseWriteFailed,
    outcome: finalOutcome,
    effects: effectsSummary,
    nextStep:
      finalOutcome === "COMPLETE"
        ? null
        : "Re-run Offboard for this person — every step is idempotent, and the re-run finishes only what remains.",
  };
  // The terminal command write is itself part of "complete": if it cannot be
  // recorded, the effects stand but the durable command still reads unfinished,
  // so the caller is told PARTIAL and the resume path stays live.
  const commandRecorded = await finishCommand(key, {
    stage: finalOutcome === "COMPLETE" ? "COMPLETE" : "PARTIAL",
    outcome: finalOutcome,
    effects: effectsSummary,
    result,
  });
  return { ...result, outcome: commandRecorded ? finalOutcome : "PARTIAL" };
  }
}

type StaffRosterRow = {
  username: string;
  sub: string | null;
  email: string;
  name: string | null;
  enabled: boolean;
  status: string | null;
  /** An invite that hasn't been redeemed yet: a single-use link token is still
   *  live on the account. Cleared the moment they sign in via the link. */
  pendingInvite: boolean;
  /** Last successful sign-in (ISO), stamped by the post-auth trigger. Null for a
   *  login that has never been used — i.e. an invite that was never accepted. */
  lastLoginAt: string | null;
  roles: StaffRole[];
  linkedTechnicianId: string | null;
  technicianActive: boolean | null;
  licenseValid: boolean | null;
  licenseExpiresOn: string | null;
  /** A TECH login with no linked technician record — the exact unlinked/unsafe
   *  state GL-14 makes visible (and now blocks at creation). */
  unlinkedTech: boolean;
};

/**
 * The owner-only staff roster: every staff login with person, email, role(s),
 * status, pending invite, and — for technicians — the linked profile and its
 * licence state. Built from Cognito (the source of truth for who can sign in)
 * and joined to Technician records, so an unlinked or shared identity shows up
 * as a flag rather than hiding. Read-only.
 */
async function staffRoster() {
  const byUsername = new Map<string, StaffRosterRow>();
  for (const role of STAFF_ROLES) {
    let token: string | undefined;
    do {
      const res = await cognito.send(
        new ListUsersInGroupCommand({
          UserPoolId: USER_POOL_ID,
          GroupName: role,
          Limit: 60,
          NextToken: token,
        })
      );
      for (const u of (res.Users ?? []) as UserType[]) {
        const username = u.Username;
        if (!username) continue;
        const attrs = Object.fromEntries(
          (u.Attributes ?? []).map((a) => [a.Name, a.Value])
        );
        const existing = byUsername.get(username);
        if (existing) {
          existing.roles.push(role);
          continue;
        }
        const tokenExp = Number(attrs["custom:loginTokenExp"] ?? 0);
        byUsername.set(username, {
          username,
          sub: attrs.sub ?? null,
          email: attrs.email ?? username,
          name: attrs.name ?? null,
          enabled: u.Enabled ?? true,
          status: u.UserStatus ?? null,
          pendingInvite:
            Boolean(attrs["custom:loginTokenHash"]) &&
            Number.isFinite(tokenExp) &&
            tokenExp > Date.now(),
          lastLoginAt: attrs["custom:lastLoginAt"] ?? null,
          roles: [role],
          linkedTechnicianId: null,
          technicianActive: null,
          licenseValid: null,
          licenseExpiresOn: null,
          unlinkedTech: false,
        });
      }
      token = res.NextToken;
    } while (token);
  }

  // Join technicians in for the TECH rows, and flag the unlinked ones.
  const client = await dataClient();
  for (const row of byUsername.values()) {
    if (!row.roles.includes("TECH")) continue;
    if (!row.sub) {
      row.unlinkedTech = true;
      continue;
    }
    const { data: techs } =
      await client.models.Technician.listTechnicianByUserSub({
        userSub: row.sub,
      });
    const tech = techs?.[0];
    if (!tech) {
      row.unlinkedTech = true;
      continue;
    }
    row.linkedTechnicianId = tech.id;
    row.technicianActive = tech.active;
    row.licenseExpiresOn = tech.licenseExpiresOn ?? null;
    try {
      assertTechnicianCompliance(tech, { requireActive: true });
      row.licenseValid = true;
    } catch {
      row.licenseValid = false;
    }
  }

  const staff = [...byUsername.values()].map((r) => ({
    ...r,
    roles: STAFF_ROLES.filter((s) => r.roles.includes(s)),
  }));
  // Owners first, then by name/email — the roster reads top-down by authority.
  staff.sort((a, b) => {
    const ao = a.roles.includes("OWNER") ? 0 : 1;
    const bo = b.roles.includes("OWNER") ? 0 : 1;
    return ao - bo || (a.name ?? a.email).localeCompare(b.name ?? b.email);
  });
  return { staff, generatedAt: new Date().toISOString() };
}
