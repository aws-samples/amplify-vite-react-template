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
type RateRow = {
  id: string;
  areaKey: string;
  active: boolean;
  pinned?: boolean;
  expiresAt?: string;
  ratesJson?: string;
};

let agreements: Agreement[] = [];
let marketRates: RateRow[] = [];
const quotesCreated: Record<string, unknown>[] = [];
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
        data: {
          id,
          displayName: "Dana",
          groupId: null,
          serviceCity: "Ware",
          serviceState: "MA",
        },
      }),
    },
    MarketRate: {
      list: async ({
        filter,
      }: {
        filter?: { areaKey?: { eq?: string } };
      }) => ({
        data: marketRates.filter(
          (r) => !filter?.areaKey?.eq || r.areaKey === filter.areaKey.eq
        ),
      }),
    },
    Quote: {
      create: async (input: Record<string, unknown>) => {
        quotesCreated.push(input);
        return { data: { id: "q_1", priceCents: input.priceCents }, errors: undefined };
      },
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

const GP_SHEET = JSON.stringify({
  oneTimeCents: 31900,
  plans: {
    MONTHLY: { monthlyCents: 9900, initialFeeCents: 10900 },
    BIMONTHLY: { monthlyCents: 5900, initialFeeCents: 10900 },
    QUARTERLY: { monthlyCents: 7500, initialFeeCents: 9900 },
  },
});

beforeEach(() => {
  agreements = [];
  created.length = 0;
  quotesCreated.length = 0;
  marketRates = [
    {
      id: "mr1",
      areaKey: "ware-ma",
      active: true,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      ratesJson: GP_SHEET,
    },
  ];
  createResult = { data: { id: "ag_1", status: "DRAFT" } };
});

describe("createAgreement", () => {
  it("creates a draft", async () => {
    const res = (await call("authorAgreement", {
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
    await call("authorAgreement", {
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
    await call("authorAgreement", {
      customerId: "c1",
      title: "T",
      bodyText: "B",
      accessGroups: ["grp-somebody-elses-portal"],
    });

    expect(created[0].accessGroups).toEqual(["cus-c1"]);
  });

  it("refuses an empty title or body", async () => {
    await expect(
      call("authorAgreement", { customerId: "c1", title: "  ", bodyText: "B" })
    ).rejects.toThrow(/needs a title/i);
    await expect(
      call("authorAgreement", { customerId: "c1", title: "T", bodyText: "  " })
    ).rejects.toThrow(/needs a body/i);
  });

  it("refuses an unknown customer", async () => {
    const realGet = fakeDataClient.models.Customer.get;
    fakeDataClient.models.Customer.get = async () => ({ data: null }) as never;
    await expect(
      call("authorAgreement", { customerId: "nope", title: "T", bodyText: "B" })
    ).rejects.toThrow(/not found/i);
    fakeDataClient.models.Customer.get = realGet;
  });

  it("refuses a technician", async () => {
    await expect(
      call("authorAgreement", { customerId: "c1", title: "T", bodyText: "B" }, ["TECH"])
    ).rejects.toThrow(/office role required/i);
  });

  it("surfaces a failed write rather than reporting an agreement it did not create", async () => {
    createResult = { data: null, errors: [{ message: "throttled" }] };

    await expect(
      call("authorAgreement", { customerId: "c1", title: "T", bodyText: "B" })
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

describe("createQuote — priced against the live AI sheet", () => {
  const quote = (args: Record<string, unknown>) =>
    call("createQuote", {
      customerId: "c1",
      planName: "General Pest Control — monthly",
      serviceFrequency: "MONTHLY",
      priceCents: 9900,
      listPriceCents: 9900,
      ...args,
    });

  it("quotes at the sheet's live rate without ceremony — no template anywhere", async () => {
    await quote({});

    expect(quotesCreated[0]).toMatchObject({
      planName: "General Pest Control — monthly",
      serviceFrequency: "MONTHLY",
      priceCents: 9900,
      listPriceCents: 9900,
      status: "DRAFT",
    });
    expect(quotesCreated[0].planTemplateId).toBeUndefined();
  });

  it("an HOA sheet vouches for per-unit × units when the unit count rides along", async () => {
    marketRates.push({
      id: "mr-hoa",
      areaKey: "ware-ma",
      active: true,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      ratesJson: JSON.stringify({
        hoaPerUnitMonthly: {
          UNITS_51_100: { MONTHLY: 675, BIMONTHLY: 550, QUARTERLY: 450 },
        },
      }),
    });

    // 60 units × $6.75/unit = $405/mo.
    await quote({
      planName: "HOA common-area plan",
      priceCents: 40500,
      listPriceCents: 40500,
      units: 60,
    });

    expect(quotesCreated[0]).toMatchObject({
      planName: "HOA common-area plan",
      priceCents: 40500,
      listPriceCents: 40500,
    });
  });

  it("an HOA total no live sheet's per-unit math produces is refused", async () => {
    marketRates.push({
      id: "mr-hoa",
      areaKey: "ware-ma",
      active: true,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      ratesJson: JSON.stringify({
        hoaPerUnitMonthly: {
          UNITS_51_100: { MONTHLY: 675, BIMONTHLY: 550, QUARTERLY: 450 },
        },
      }),
    });

    await expect(
      quote({
        planName: "HOA common-area plan",
        priceCents: 41500,
        listPriceCents: 41500, // not 60 × any live per-unit rate
        units: 60,
      })
    ).rejects.toThrow(/rate has moved/i);
    expect(quotesCreated).toHaveLength(0);
  });

  it("refuses a stale listPriceCents the live sheet no longer carries", async () => {
    // The screen showed $99/mo; the sheet re-researched to $89 since.
    marketRates[0].ratesJson = GP_SHEET.replace('"monthlyCents":9900', '"monthlyCents":8900');

    await expect(quote({})).rejects.toThrow(/rate has moved.*reload/is);
    expect(quotesCreated).toHaveLength(0);
  });

  it("refuses to quote an area with no live sheet at all", async () => {
    marketRates = [];

    await expect(quote({})).rejects.toThrow(/no live ai rate sheet/i);
  });

  it("an expired unpinned sheet cannot vouch for a price", async () => {
    marketRates[0].expiresAt = new Date(Date.now() - 1000).toISOString();

    await expect(quote({})).rejects.toThrow(/no live ai rate sheet/i);
  });

  it("tolerates the office-override row: a pinned sheet never expires", async () => {
    // The office edited the monthly rate to $95 and pinned the row.
    marketRates[0] = {
      ...marketRates[0],
      pinned: true,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      ratesJson: GP_SHEET.replace('"monthlyCents":9900', '"monthlyCents":9500'),
    };

    await quote({ priceCents: 9500, listPriceCents: 9500 });

    expect(quotesCreated[0]).toMatchObject({
      priceCents: 9500,
      listPriceCents: 9500,
    });
  });

  it("checks the cadence the quote is for, not just any number on the sheet", async () => {
    // $75 is the QUARTERLY rate — it can't vouch for a MONTHLY quote.
    await expect(quote({ listPriceCents: 7500, priceCents: 7500 })).rejects.toThrow(
      /rate has moved/i
    );
  });

  it("refuses a price that differs from the list price with no reason", async () => {
    // The typo that started this: 4 for 45. A $4/mo plan that bills forever.
    await expect(quote({ priceCents: 400 })).rejects.toThrow(/say why/i);
    expect(quotesCreated).toHaveLength(0);
  });

  it("names both numbers so the CSR can see the slip", async () => {
    await expect(quote({ priceCents: 400 })).rejects.toThrow(
      /lists at \$99\.00\/mo and this quote is \$4\.00\/mo/i
    );
  });

  it("allows a deviation with a reason, and records it with the actor", async () => {
    await quote({ priceCents: 8900, priceOverrideReason: "Matched a competitor" });

    expect(quotesCreated[0]).toMatchObject({
      priceCents: 8900,
      listPriceCents: 9900,
      priceOverrideReason: "Matched a competitor",
      quotedBy: "sub-office",
      quotedByEmail: "csr@x.com",
    });
  });

  it("treats whitespace as no reason at all", async () => {
    await expect(
      quote({ priceCents: 400, priceOverrideReason: "   " })
    ).rejects.toThrow(/say why/i);
  });

  it("refuses a nonsense price or a missing sheet rate", async () => {
    await expect(quote({ priceCents: 0 })).rejects.toThrow(/valid monthly price/i);
    await expect(quote({ priceCents: -5000 })).rejects.toThrow(/valid monthly price/i);
    await expect(quote({ listPriceCents: 0 })).rejects.toThrow(/missing its ai sheet rate/i);
  });

  it("refuses an unknown frequency", async () => {
    await expect(quote({ serviceFrequency: "WEEKLY" })).rejects.toThrow(
      /unknown service frequency/i
    );
  });

  it("refuses a customer with no service area on file", async () => {
    const realGet = fakeDataClient.models.Customer.get;
    fakeDataClient.models.Customer.get = (async ({ id }: { id: string }) => ({
      data: { id, displayName: "Dana", groupId: null, serviceCity: null, serviceState: null },
    })) as never;

    await expect(quote({})).rejects.toThrow(/service city/i);

    fakeDataClient.models.Customer.get = realGet;
  });

  it("refuses a technician", async () => {
    await expect(
      call(
        "createQuote",
        {
          customerId: "c1",
          planName: "P",
          serviceFrequency: "MONTHLY",
          priceCents: 9900,
          listPriceCents: 9900,
        },
        ["TECH"]
      )
    ).rejects.toThrow(/office role required/i);
  });
});
