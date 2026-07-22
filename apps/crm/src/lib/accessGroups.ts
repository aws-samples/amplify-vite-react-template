/**
 * Dynamic Cognito group naming for row-level customer visibility.
 * Mirror of apps/web/amplify/functions/shared/dynamicGroups.ts — keep in sync.
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
