import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown> & { id: string };
let customers: Row[];

vi.mock("./dataClient", () => ({
  dataClient: async () => ({
    models: {
      Customer: {
        list: async () => ({ data: customers, nextToken: null }),
      },
    },
  }),
}));

const {
  normalizeEmail,
  normalizePhone,
  normalizeName,
  normalizeZip,
  findLeadDuplicates,
} = await import("./leadIdentity");

beforeEach(() => {
  customers = [];
});

describe("normalizers (GL-02)", () => {
  it("email: trims, lowercases, validates", () => {
    expect(normalizeEmail("  Dana@Example.COM ")).toBe("dana@example.com");
    expect(normalizeEmail("not-an-email")).toBeUndefined();
    expect(normalizeEmail("")).toBeUndefined();
  });
  it("phone: digits → E.164, tolerates existing E.164", () => {
    expect(normalizePhone("(413) 555-0123")).toBe("+14135550123");
    expect(normalizePhone("1-413-555-0123")).toBe("+14135550123");
    expect(normalizePhone("+14135550123")).toBe("+14135550123");
    expect(normalizePhone("555")).toBeUndefined();
  });
  it("name + zip normalize for comparison", () => {
    expect(normalizeName("  Dana   O'Brien-Smith ")).toBe("dana o brien smith");
    expect(normalizeZip("01082-1234")).toBe("01082");
    expect(normalizeZip("abc")).toBeUndefined();
  });
});

describe("findLeadDuplicates", () => {
  it("matches on exact normalized email", async () => {
    customers = [
      { id: "c1", displayName: "Dana W", email: "dana@example.com", phone: null, status: "LEAD" },
      { id: "c2", displayName: "Someone", email: "x@y.com", phone: null, status: "ACTIVE" },
    ];
    const hits = await findLeadDuplicates({ email: "DANA@example.com" });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ id: "c1", matchedOn: "email" });
  });

  it("matches on exact normalized phone", async () => {
    customers = [{ id: "c1", displayName: "Dana", email: null, phone: "+14135550123", status: "LEAD" }];
    const hits = await findLeadDuplicates({ phone: "(413) 555-0123" });
    expect(hits[0]).toMatchObject({ id: "c1", matchedOn: "phone" });
  });

  it("matches on name + zip together, never address alone", async () => {
    customers = [
      { id: "c1", displayName: "Dana Whitlock", serviceZip: "01082", email: null, phone: null, status: "LEAD" },
    ];
    // Same name + zip → match.
    expect(
      await findLeadDuplicates({ name: "Dana Whitlock", zip: "01082" })
    ).toHaveLength(1);
    // Same zip, different name → no match (two people share a household).
    expect(
      await findLeadDuplicates({ name: "Chris Jones", zip: "01082" })
    ).toHaveLength(0);
  });

  it("returns nothing when there is no usable identifier or no match", async () => {
    customers = [{ id: "c1", displayName: "Dana", email: "dana@example.com", phone: null, status: "LEAD" }];
    expect(await findLeadDuplicates({})).toHaveLength(0);
    expect(await findLeadDuplicates({ email: "other@example.com" })).toHaveLength(0);
  });

  it("excludes a given id (a record never duplicates itself)", async () => {
    customers = [{ id: "c1", displayName: "Dana", email: "dana@example.com", phone: null, status: "LEAD" }];
    expect(
      await findLeadDuplicates({ email: "dana@example.com", excludeId: "c1" })
    ).toHaveLength(0);
  });
});
