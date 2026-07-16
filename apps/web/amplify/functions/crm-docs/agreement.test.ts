import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Agreement authoring.
 *
 * These mutations exist because OFFICE used to hold create/update on the model
 * itself, which meant an office user could write signedAt / signerName /
 * signerIp from a browser and produce a contract indistinguishable from one the
 * customer actually signed. The fix is structural rather than validated: the
 * model is read-only to every human role, and the arguments here have nowhere
 * to put a signature.
 */

type Agreement = Record<string, unknown> & { id: string; status: string };

let agreements: Agreement[] = [];
const created: Record<string, unknown>[] = [];
let createResult: { data: unknown; errors?: { message: string }[] } = {
  data: { id: "ag_1", status: "DRAFT" },
};

const fakeDataClient = {
  models: {
    Agreement: {
      get: async ({ id }: { id: string }) => ({
        data: agreements.find((a) => a.id === id) ?? null,
      }),
      create: async (input: Record<string, unknown>) => {
        created.push(input);
        return createResult;
      },
      update: async (patch: Agreement) => {
        const i = agreements.findIndex((a) => a.id === patch.id);
        if (i < 0) return { data: null, errors: [{ message: "not found" }] };
        agreements[i] = { ...agreements[i], ...patch };
        return { data: agreements[i], errors: undefined };
      },
    },
    Customer: {
      get: async ({ id }: { id: string }) => ({
        data: { id, displayName: "Dana", groupId: null },
      }),
    },
  },
};
vi.mock("../shared/dataClient", () => ({ dataClient: async () => fakeDataClient }));
vi.mock("../shared/email", () => ({
  emailShell: (h: string, b: string) => `${h}${b}`,
  sendEmail: async () => true,
  notifyOffice: async () => true,
}));
vi.mock("../shared/stripeClient", () => ({ stripeClient: () => ({}) }));

const { handler } = await import("./handler");

const call = (
  field: string,
  args: Record<string, unknown>,
  groups: string[] = ["OFFICE"]
) =>
  (handler as unknown as (e: never) => Promise<unknown>)({
    info: { fieldName: field },
    arguments: args,
    identity: { sub: "sub-office", groups, claims: { email: "csr@x.com" } },
  } as never);

beforeEach(() => {
  agreements = [];
  created.length = 0;
  createResult = { data: { id: "ag_1", status: "DRAFT" } };
});

describe("createAgreement", () => {
  it("creates a draft", async () => {
    const res = (await call("createAgreement", {
      customerId: "c1",
      title: "Residential plan",
      bodyText: "Terms…",
    })) as { agreementId: string };

    expect(res.agreementId).toBe("ag_1");
    expect(created[0]).toMatchObject({ status: "DRAFT", customerId: "c1" });
  });

  it("cannot be handed a signature, however hard a caller tries", async () => {
    // The forgery this replaces: an office user writing the signature fields
    // directly against the model. The mutation has no such arguments, so they
    // are dropped rather than validated away.
    await call("createAgreement", {
      customerId: "c1",
      title: "Residential plan",
      bodyText: "Terms…",
      status: "SIGNED",
      signedAt: "2026-07-15T00:00:00Z",
      signerName: "Dana Whitlock",
      signerIp: "1.2.3.4",
    });

    expect(created[0]).toMatchObject({ status: "DRAFT" });
    expect(created[0].signedAt).toBeUndefined();
    expect(created[0].signerName).toBeUndefined();
    expect(created[0].signerIp).toBeUndefined();
  });

  it("stamps access groups server-side rather than taking the caller's word", async () => {
    await call("createAgreement", {
      customerId: "c1",
      title: "T",
      bodyText: "B",
      accessGroups: ["grp-somebody-elses-portal"],
    });

    expect(created[0].accessGroups).toEqual(["cus-c1"]);
  });

  it("refuses an empty title or body", async () => {
    await expect(
      call("createAgreement", { customerId: "c1", title: "  ", bodyText: "B" })
    ).rejects.toThrow(/needs a title/i);
    await expect(
      call("createAgreement", { customerId: "c1", title: "T", bodyText: "  " })
    ).rejects.toThrow(/needs a body/i);
  });

  it("refuses an unknown customer", async () => {
    fakeDataClient.models.Customer.get = async () => ({ data: null }) as never;
    await expect(
      call("createAgreement", { customerId: "nope", title: "T", bodyText: "B" })
    ).rejects.toThrow(/not found/i);
    fakeDataClient.models.Customer.get = async ({ id }: { id: string }) => ({
      data: { id, displayName: "Dana", groupId: null },
    });
  });

  it("refuses a technician", async () => {
    await expect(
      call("createAgreement", { customerId: "c1", title: "T", bodyText: "B" }, ["TECH"])
    ).rejects.toThrow(/office role required/i);
  });

  it("surfaces a failed write rather than reporting an agreement it did not create", async () => {
    createResult = { data: null, errors: [{ message: "throttled" }] };

    await expect(
      call("createAgreement", { customerId: "c1", title: "T", bodyText: "B" })
    ).rejects.toThrow(/could not create the agreement/i);
  });
});

describe("voidAgreement", () => {
  it("voids a draft", async () => {
    agreements.push({ id: "ag_1", status: "DRAFT" });

    await call("voidAgreement", { agreementId: "ag_1" });

    expect(agreements[0].status).toBe("VOID");
  });

  it("refuses to void a signed agreement — it is the evidence", async () => {
    agreements.push({ id: "ag_1", status: "SIGNED", signedAt: "2026-07-01" });

    await expect(call("voidAgreement", { agreementId: "ag_1" })).rejects.toThrow(
      /has been signed/i
    );
    expect(agreements[0].status).toBe("SIGNED");
  });

  it("is idempotent on an already-void agreement", async () => {
    agreements.push({ id: "ag_1", status: "VOID" });

    const res = (await call("voidAgreement", { agreementId: "ag_1" })) as {
      alreadyVoid: boolean;
    };

    expect(res.alreadyVoid).toBe(true);
  });

  it("refuses a technician", async () => {
    agreements.push({ id: "ag_1", status: "DRAFT" });
    await expect(
      call("voidAgreement", { agreementId: "ag_1" }, ["TECH"])
    ).rejects.toThrow(/office role required/i);
  });
});
