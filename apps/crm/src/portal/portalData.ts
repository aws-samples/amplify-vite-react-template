import { api, unwrap, type Customer } from "../lib/api";
import { myCustomerIds, type Roles } from "../lib/auth";

/**
 * The portal user's own customer records (their dynamic cus-<id> groups).
 * Group-sibling records are visible too but surfaced on the Group tab, not
 * mixed into "my" data.
 */
export async function loadMyCustomers(roles: Roles): Promise<Customer[]> {
  const ids = myCustomerIds(roles);
  const results = await Promise.all(
    ids.map((id) => api().models.Customer.get({ id }))
  );
  // get() returns a structurally-equivalent but differently-inferred type
  // than Schema["Customer"]["type"] — coerce once here.
  return results
    .map((r) => unwrap(r) as unknown as Customer | null)
    .filter((c): c is Customer => Boolean(c));
}
