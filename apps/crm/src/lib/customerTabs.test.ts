import { describe, expect, it } from "vitest";
import { rowsForTab, type CustomersLoaded } from "./customerTabs";

/**
 * The Groups tab blanking the whole Customers screen.
 *
 * Reported as "Group screen fails load". The console showed
 * `TypeError: Cannot read properties of undefined (reading 'localeCompare')`
 * inside Array.sort, with NO network request and a database whose four groups
 * all had names — because the rows being sorted were not groups at all. They
 * were the Customer rows still held from the Active tab, cast to
 * CustomerGroup[] and sorted by `name`, which only a group has.
 */

/** A Customer as the Active tab loads it: `displayName`, and NO `name`. */
const CUSTOMERS = [
  { id: "c1", displayName: "Ajay Daptardar" },
  { id: "c2", displayName: "Admiral Dewey" },
] as unknown as Extract<
  CustomersLoaded,
  { tab: "ACTIVE" | "INACTIVE" }
>["customers"];

const GROUPS = [
  { id: "g1", name: "Lifeward" },
  { id: "g2", name: "Greasley Family" },
] as unknown as Extract<CustomersLoaded, { tab: "GROUPS" }>["groups"];

const LOADED_ACTIVE: CustomersLoaded = { tab: "ACTIVE", customers: CUSTOMERS };
const LOADED_GROUPS: CustomersLoaded = { tab: "GROUPS", groups: GROUPS };

describe("rowsForTab", () => {
  it("hands the Groups tab nothing while the Active tab's rows are still held", () => {
    // THE BUG: this returned the Customer rows as `groups`, and the very next
    // thing the screen did was sort them by a field they do not have.
    const { customers, groups } = rowsForTab(LOADED_ACTIVE, "GROUPS");
    expect(groups).toBeNull();
    expect(customers).toBeNull(); // both null ⇒ the screen shows its spinner
  });

  it("hands the Active tab nothing while the Groups tab's rows are still held", () => {
    // The mirror image, which was equally broken: the customer filter runs
    // `c.displayName.toLowerCase()`, and a group has no displayName.
    expect(rowsForTab(LOADED_GROUPS, "ACTIVE")).toEqual({
      customers: null,
      groups: null,
    });
  });

  it("does not leak one customer tab's rows into the other", () => {
    // Active and Inactive are the same SHAPE, so nothing would throw — but
    // showing inactive customers under Active is still wrong.
    expect(rowsForTab(LOADED_ACTIVE, "INACTIVE").customers).toBeNull();
  });

  it("returns the rows once the load for that tab has landed", () => {
    expect(rowsForTab(LOADED_GROUPS, "GROUPS").groups).toEqual(GROUPS);
    expect(rowsForTab(LOADED_ACTIVE, "ACTIVE").customers).toEqual(CUSTOMERS);
  });

  it("treats nothing-loaded-yet as loading, not as empty", () => {
    // Distinct from a real empty result: null renders the spinner, [] renders
    // "No customer groups" with a Create button.
    expect(rowsForTab(null, "GROUPS")).toEqual({ customers: null, groups: null });
    expect(rowsForTab({ tab: "GROUPS", groups: [] }, "GROUPS").groups).toEqual([]);
  });

  it("decides on the tag, not the shape of row 0", () => {
    // An empty list carries no shape to sniff, so shape-sniffing would call
    // this a match and re-open the hole the tag closes.
    expect(rowsForTab({ tab: "ACTIVE", customers: [] }, "GROUPS").groups).toBeNull();
  });
});
