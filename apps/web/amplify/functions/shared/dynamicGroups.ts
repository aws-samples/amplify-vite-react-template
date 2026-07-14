/**
 * Dynamic Cognito group naming for row-level customer visibility.
 *
 * Every customer-visible record carries `accessGroups` containing these
 * names; portal users are made members of the matching Cognito groups.
 * Keep in sync with apps/crm/src/lib/accessGroups.ts (frontend copy).
 */
export const cusGroup = (customerId: string) => `cus-${customerId}`;
export const grpGroup = (groupId: string) => `grp-${groupId}`;

/** accessGroups value for a customer record and all of its child records. */
export function customerAccessGroups(
  customerId: string,
  groupId?: string | null
): string[] {
  return groupId
    ? [cusGroup(customerId), grpGroup(groupId)]
    : [cusGroup(customerId)];
}
