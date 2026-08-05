/**
 * Which rows the Customers screen may render for the tab you are looking at.
 *
 * The three tabs share one `useAsync` slot, and that hook deliberately keeps
 * the previous result on screen while the next load runs — a refetch should not
 * flash a spinner. Two of the tabs load Customers and the third loads
 * CustomerGroups, so during that overlap the held rows are the OTHER shape.
 *
 * The screen used to bridge the gap with `rows as CustomerGroup[]`. That cast
 * is a lie TypeScript cannot check, and it had teeth: switching to Groups sorted
 * the still-showing CUSTOMER rows by `name` — a field only a group has — so
 * `undefined.localeCompare(...)` threw inside Array.sort and blanked the whole
 * screen. It happened before the groups request was even sent, which is why the
 * database was clean and the network tab showed nothing.
 *
 * Tagging each payload with the tab it was fetched FOR makes the mismatch
 * representable, and therefore checkable. Rows from another tab count as "not
 * loaded yet", which the screen already renders as a spinner.
 */
import type { Customer, CustomerGroup } from "./api";

export type CustomersTab = "ACTIVE" | "INACTIVE" | "GROUPS";

/** One load's result, tagged with the tab it was loaded for. */
export type CustomersLoaded =
  | { tab: "GROUPS"; groups: CustomerGroup[] }
  | { tab: "ACTIVE" | "INACTIVE"; customers: Customer[] };

/**
 * Split a held payload into the two lists the screen renders, keeping only
 * what belongs to `tab`. Both null means "still loading this tab".
 */
export function rowsForTab(
  loaded: CustomersLoaded | null,
  tab: CustomersTab
): { customers: Customer[] | null; groups: CustomerGroup[] | null } {
  // The tag, not the array's contents, decides. Sniffing shape ("does row 0
  // have a name?") would pass on an empty list and re-open the same hole.
  if (!loaded || loaded.tab !== tab) return { customers: null, groups: null };
  return loaded.tab === "GROUPS"
    ? { customers: null, groups: loaded.groups }
    : { customers: loaded.customers, groups: null };
}
