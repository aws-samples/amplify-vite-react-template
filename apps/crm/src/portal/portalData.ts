import { api, listAll, unwrap, type Customer } from "../lib/api";
import { myCustomerIds, myGroupIds, type Roles } from "../lib/auth";

/**
 * Every customer this portal user may act for.
 *
 *  - their OWN records (dynamic cus-<id> groups); plus
 *  - for a management-company GROUP login (grp-<id>), every member property of
 *    that group.
 *
 * A group login holds no cus- group at all, so without the group half it would
 * see empty pages. Returning the portfolio here is what makes every portal page
 * (billing, docs, requests, add-a-service) work across all of a management
 * company's properties at once — the pages already map over this list, so they
 * become portfolio views without page-by-page special-casing.
 *
 * The backend authorizes each action independently (assertCanActForCustomer
 * intersects the customer's accessGroups with the caller's token), so this list
 * decides what is OFFERED, never what is permitted.
 */
export async function loadMyCustomers(roles: Roles): Promise<Customer[]> {
  const ids = myCustomerIds(roles);
  const groupIds = myGroupIds(roles);
  const [own, memberLists] = await Promise.all([
    Promise.all(ids.map((id) => api().models.Customer.get({ id }))),
    Promise.all(
      groupIds.map((gid) =>
        listAll((t) =>
          api().models.Customer.list({
            filter: { groupId: { eq: gid } },
            limit: 500,
            nextToken: t,
          })
        )
      )
    ),
  ]);
  // get() returns a structurally-equivalent but differently-inferred type
  // than Schema["Customer"]["type"] — coerce once here.
  const mine = own
    .map((r) => unwrap(r) as unknown as Customer | null)
    .filter((c): c is Customer => Boolean(c));
  const members = memberLists.flat();
  // A login can be both an individual customer and a group contact — dedupe,
  // and order by name so a 29-property portfolio reads predictably.
  const byId = new Map<string, Customer>();
  for (const c of [...mine, ...members]) byId.set(c.id, c);
  return [...byId.values()].sort((a, b) =>
    (a.displayName ?? "").localeCompare(b.displayName ?? "")
  );
}
