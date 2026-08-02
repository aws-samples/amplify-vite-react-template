import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The single authorization choke point for portal ACTIONS (pay an invoice, add
 * a payment method, book an add-on service).
 *
 * Three ways in: staff OWNER, the customer's own cus-<id>, or a management
 * company's group login (grp-<id>) acting for a member property. The group case
 * is decided by the customer row's own accessGroups stamp — the same rule
 * AppSync uses for row-level reads — so group membership is never inferred from
 * a stale token.
 */

type Customer = { id: string; accessGroups?: (string | null)[] | null };

const customers = new Map<string, Customer>();
/** Every Customer.get the authorizer performs — proves the token-only fast
 *  paths never touch the database. */
const reads: string[] = [];

const fakeDataClient = {
  models: {
    Customer: {
      get: async ({ id }: { id: string }) => {
        reads.push(id);
        return { data: customers.get(id) ?? null };
      },
    },
  },
};

vi.mock("./dataClient", () => ({ dataClient: async () => fakeDataClient }));

const { assertCanActForCustomer, canActForCustomer } = await import("./authz");

/** An AppSync Cognito identity carrying exactly these groups. */
const as = (groups: string[]) =>
  ({ sub: "sub-1", groups, claims: {} }) as unknown as Parameters<
    typeof assertCanActForCustomer
  >[0];

beforeEach(() => {
  customers.clear();
  reads.length = 0;
  // c1 belongs to group g1: its stamp carries both its own cus- and the grp-.
  customers.set("c1", { id: "c1", accessGroups: ["cus-c1", "grp-g1"] });
  // c2 belongs to a DIFFERENT group.
  customers.set("c2", { id: "c2", accessGroups: ["cus-c2", "grp-g2"] });
  // c3 belongs to no group at all.
  customers.set("c3", { id: "c3", accessGroups: ["cus-c3"] });
});

describe("assertCanActForCustomer — token-only fast paths", () => {
  it("allows OWNER without reading the customer", async () => {
    await expect(assertCanActForCustomer(as(["OWNER"]), "c1")).resolves.toBeUndefined();
    expect(reads).toHaveLength(0);
  });

  it("allows the customer's own login without reading the customer", async () => {
    await expect(
      assertCanActForCustomer(as(["CUSTOMER", "cus-c1"]), "c1")
    ).resolves.toBeUndefined();
    expect(reads).toHaveLength(0);
  });

  it("refuses a token with no groups at all, without reading", async () => {
    await expect(assertCanActForCustomer(as([]), "c1")).rejects.toThrow(
      /not authorized/i
    );
    expect(reads).toHaveLength(0);
  });

  it("refuses one customer acting for another", async () => {
    await expect(
      assertCanActForCustomer(as(["CUSTOMER", "cus-c2"]), "c1")
    ).rejects.toThrow(/not authorized/i);
  });
});

describe("assertCanActForCustomer — management-company group login", () => {
  it("lets a group login act for a member property", async () => {
    await expect(
      assertCanActForCustomer(as(["CUSTOMER", "grp-g1"]), "c1")
    ).resolves.toBeUndefined();
    // It consulted the customer's live stamp rather than trusting the token.
    expect(reads).toEqual(["c1"]);
  });

  it("REFUSES a group login for a property in a different group", async () => {
    await expect(
      assertCanActForCustomer(as(["CUSTOMER", "grp-g1"]), "c2")
    ).rejects.toThrow(/not authorized/i);
  });

  it("REFUSES a group login for an ungrouped property", async () => {
    await expect(
      assertCanActForCustomer(as(["CUSTOMER", "grp-g1"]), "c3")
    ).rejects.toThrow(/not authorized/i);
  });

  it("revokes access the moment a property leaves the group — no re-login", async () => {
    // The office removes c1 from g1: setCustomerGroup rewrites accessGroups.
    // The SAME token (still carrying grp-g1) must stop working immediately,
    // because the decision reads the customer's stamp, not the token's history.
    customers.set("c1", { id: "c1", accessGroups: ["cus-c1"] });
    await expect(
      assertCanActForCustomer(as(["CUSTOMER", "grp-g1"]), "c1")
    ).rejects.toThrow(/not authorized/i);
  });

  it("refuses when the customer does not exist", async () => {
    await expect(
      assertCanActForCustomer(as(["CUSTOMER", "grp-g1"]), "nope")
    ).rejects.toThrow(/not authorized/i);
  });

  it("a group login for one of several groups still only reaches its own members", async () => {
    // A contact managing two portfolios carries both grp- groups.
    await expect(
      assertCanActForCustomer(as(["CUSTOMER", "grp-g1", "grp-g2"]), "c2")
    ).resolves.toBeUndefined();
    // …but still not a property in neither group.
    await expect(
      assertCanActForCustomer(as(["CUSTOMER", "grp-g1", "grp-g2"]), "c3")
    ).rejects.toThrow(/not authorized/i);
  });
});

/**
 * The boolean form exists for READ paths that fold this decision into a wider
 * entitlement — getDocumentUrl allows a technician who is proven against the
 * specific document, so it needs an answer rather than an exception.
 */
describe("canActForCustomer — the predicate behind the assert", () => {
  it("answers instead of throwing, with the same verdicts", async () => {
    await expect(canActForCustomer(as(["OWNER"]), "c1")).resolves.toBe(true);
    await expect(
      canActForCustomer(as(["CUSTOMER", "cus-c1"]), "c1")
    ).resolves.toBe(true);
    await expect(
      canActForCustomer(as(["CUSTOMER", "grp-g1"]), "c1")
    ).resolves.toBe(true);
    await expect(
      canActForCustomer(as(["CUSTOMER", "grp-g1"]), "c2")
    ).resolves.toBe(false);
    await expect(canActForCustomer(as([]), "c1")).resolves.toBe(false);
  });

  it("keeps the token-only fast paths free of a customer read", async () => {
    await canActForCustomer(as(["OWNER"]), "c1");
    await canActForCustomer(as(["CUSTOMER", "cus-c1"]), "c1");
    expect(reads).toHaveLength(0);
  });

  it("drops a group login the moment the property leaves the group", async () => {
    await expect(
      canActForCustomer(as(["CUSTOMER", "grp-g1"]), "c1")
    ).resolves.toBe(true);
    customers.set("c1", { id: "c1", accessGroups: ["cus-c1"] });
    await expect(
      canActForCustomer(as(["CUSTOMER", "grp-g1"]), "c1")
    ).resolves.toBe(false);
  });
});
