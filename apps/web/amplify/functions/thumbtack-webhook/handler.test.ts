import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Thumbtack receiver's guarantees:
 *
 *  - the shared secret gates every route, compared in constant time;
 *  - Thumbtack's own ids make every write idempotent, because Thumbtack
 *    redelivers on any non-2xx;
 *  - a lead with no email and no phone is NOT "missing contact" — the thread
 *    is the contact method — so it must not open a MISSING_CONTACT work item;
 *  - no consent channel is ever claimed for a marketplace lead;
 *  - a delivery we cannot process is ACCEPTED and paged to a human, never
 *    rejected into a Thumbtack retry storm.
 */

const created: Record<string, unknown>[] = [];
const activities: Record<string, unknown>[] = [];
const paged: { subject: string; template: string }[] = [];
let createResult: { decision: string; id?: string } = {
  decision: "CREATED",
  id: "lead-1",
};
let customersByRef: Record<string, { id: string }[]> = {};

vi.mock("../shared/leadLifecycle", () => ({
  createLead: async (args: Record<string, unknown>) => {
    created.push(args);
    return createResult;
  },
  appendLeadActivity: async (input: Record<string, unknown>) => {
    activities.push(input);
    return input;
  },
}));

vi.mock("../shared/email", () => ({
  notifyLeads: async (o: { subject: string; template: string }) => {
    paged.push(o);
    return true;
  },
}));

vi.mock("../shared/dataClient", () => ({
  dataClient: async () => ({
    models: {
      Customer: {
        listCustomerByExternalRef: async ({ externalRef }: { externalRef: string }) => ({
          data: customersByRef[externalRef] ?? [],
        }),
      },
    },
  }),
}));

const { handler } = await import("./handler");

const SECRET = "tt-shared-secret";

// `null` means "send no Authorization header at all". It cannot be `undefined`
// — passing undefined explicitly re-triggers the default parameter.
const call = (path: string, body: unknown, auth: string | null = SECRET) =>
  handler(
    {
      rawPath: path,
      requestContext: { http: { method: "POST", path } },
      headers: auth === null ? {} : { authorization: auth },
      body: JSON.stringify(body),
      isBase64Encoded: false,
    } as never,
    {} as never,
    (() => undefined) as never
  ) as Promise<{ statusCode: number; body: string }>;

const LEAD = {
  leadID: "585695115596185614",
  customer: { customerID: "c1", name: "Ajay Daptardar" },
  leadPrice: "17.42",
  chargeState: "Charged",
  request: {
    category: "Pest Control Services",
    description: "Ants near the home foundation.",
    location: { city: "Belmont", state: "MA", zipCode: "02478" },
    details: [
      { question: "Property type", answer: "Residential" },
      { question: "Total square footage of building", answer: "3,000 - 4,000 sq ft" },
    ],
  },
};

beforeEach(() => {
  created.length = 0;
  activities.length = 0;
  paged.length = 0;
  createResult = { decision: "CREATED", id: "lead-1" };
  customersByRef = {};
  process.env.THUMBTACK_WEBHOOK_SECRET = SECRET;
});

describe("authentication", () => {
  it("rejects a request with no credential", async () => {
    const res = await call("/v1/lead", LEAD, null);
    expect(res.statusCode).toBe(401);
    expect(created).toHaveLength(0);
  });

  it("rejects a wrong secret", async () => {
    const res = await call("/v1/lead", LEAD, "not-the-secret");
    expect(res.statusCode).toBe(401);
    expect(created).toHaveLength(0);
  });

  it("accepts the bare secret (self-serve webhook) and Bearer form (partner)", async () => {
    expect((await call("/v1/lead", LEAD)).statusCode).toBe(200);
    expect((await call("/v1/lead", LEAD, `Bearer ${SECRET}`)).statusCode).toBe(200);
  });

  it("refuses everything when the secret is unset — never accepts blind writes", async () => {
    delete process.env.THUMBTACK_WEBHOOK_SECRET;
    const res = await call("/v1/lead", LEAD, "anything");
    expect(res.statusCode).toBe(503);
    expect(created).toHaveLength(0);
  });

  it("treats the Amplify placeholder as unset", async () => {
    process.env.THUMBTACK_WEBHOOK_SECRET = "placeholder-set-me";
    expect((await call("/v1/lead", LEAD, "placeholder-set-me")).statusCode).toBe(503);
  });
});

describe("POST /v1/lead", () => {
  it("creates the lead keyed on Thumbtack's id, with the questionnaire retained", async () => {
    const res = await call("/v1/lead", LEAD);

    expect(res.statusCode).toBe(200);
    expect(created).toHaveLength(1);
    const args = created[0];
    expect(args.externalRef).toBe("thumbtack#585695115596185614");
    expect(args.idempotencyKey).toBe("thumbtack:585695115596185614");
    expect(args.displayName).toBe("Ajay Daptardar");
    expect(args.serviceCity).toBe("Belmont");
    expect(args.serviceZip).toBe("02478");
    // The sqft band is what the pricing engine keys on — it must survive.
    expect(String(args.notes)).toContain("3,000 - 4,000 sq ft");
    expect(String(args.notes)).toContain("Residential");
    expect(String(args.notes)).toContain("17.42");
  });

  it("claims NO consent channel — a marketplace lead is not permission to email or call", async () => {
    await call("/v1/lead", LEAD);
    expect(created[0].contactConsentChannels).toBeUndefined();
  });

  it("says plainly that a street-less lead was priced from the town centroid", async () => {
    await call("/v1/lead", LEAD);
    expect(String(created[0].notes)).toMatch(/no street address/i);
  });

  it("keeps the street address when Thumbtack does supply one (Instant Book)", async () => {
    await call("/v1/lead", {
      ...LEAD,
      request: {
        ...LEAD.request,
        location: { address1: "36 Glen Ave", city: "Burlington", state: "MA", zipCode: "01803" },
      },
    });
    expect(created[0].serviceStreet).toBe("36 Glen Ave");
    expect(String(created[0].notes)).not.toMatch(/no street address/i);
  });

  it("never invents a name it was not given", async () => {
    await call("/v1/lead", { ...LEAD, customer: { customerID: "c1" } });
    expect(String(created[0].displayName)).toContain("Thumbtack lead");
  });

  it("a redelivery is a no-op, not a second lead", async () => {
    await call("/v1/lead", LEAD);
    createResult = { decision: "DUPLICATE" };
    const res = await call("/v1/lead", LEAD);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).duplicate).toBe(true);
    // Both calls carried the SAME idempotency key, which is what makes the
    // retry resolve to one lead rather than two.
    expect(created[0].idempotencyKey).toBe(created[1].idempotencyKey);
  });

  it("ignores a payload with no leadID rather than creating a nameless lead", async () => {
    const res = await call("/v1/lead", { customer: { name: "X" } });
    expect(res.statusCode).toBe(200);
    expect(created).toHaveLength(0);
  });
});

describe("POST /v1/message", () => {
  it("threads an inbound message onto the lead found by externalRef", async () => {
    customersByRef["thumbtack#585695115596185614"] = [{ id: "lead-1" }];

    const res = await call("/v1/message", {
      leadID: "585695115596185614",
      message: { messageID: "m1", text: "Can you come tomorrow?" },
    });

    expect(res.statusCode).toBe(200);
    const activity = activities.at(-1)!;
    expect(activity.customerId).toBe("lead-1");
    expect(activity.channel).toBe("THUMBTACK");
    expect(activity.direction).toBe("INBOUND");
    expect(String(activity.note)).toContain("Can you come tomorrow?");
    // Thumbtack's message id makes a redelivery idempotent.
    expect(activity.mutationId).toBe("tt-msg:m1");
  });

  it("pages a human for a message on a thread we have no lead for — never drops it", async () => {
    const res = await call("/v1/message", {
      leadID: "unknown-thread",
      message: { messageID: "m9", text: "hello?" },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).orphan).toBe(true);
    expect(paged).toHaveLength(1);
    expect(paged[0].template).toBe("ops-thumbtack-orphan-message");
  });
});

describe("PUT /v1/lead/update", () => {
  it("records the finalized lead fee on the thread as reported cost", async () => {
    customersByRef["thumbtack#585695115596185614"] = [{ id: "lead-1" }];

    await call("/v1/lead/update", {
      leadID: "585695115596185614",
      leadPrice: "43.55",
      chargeState: "Charged",
    });

    const activity = activities.at(-1)!;
    expect(String(activity.note)).toContain("43.55");
    expect(activity.outcome).toBe("NOTE");
  });

  it("routes to the update handler, not the lead handler", async () => {
    customersByRef["thumbtack#1"] = [{ id: "lead-1" }];
    await call("/v1/lead/update", { leadID: "1", leadPrice: "5.00" });
    // A misrouted /v1/lead/update would have created a lead.
    expect(created).toHaveLength(0);
  });
});

describe("failure handling", () => {
  it("ACCEPTS a delivery it cannot process and pages a human, so Thumbtack stops retrying", async () => {
    customersByRef["thumbtack#585695115596185614"] = [{ id: "lead-1" }];
    activities.push = () => {
      throw new Error("dynamo down");
    };

    const res = await call("/v1/message", {
      leadID: "585695115596185614",
      message: { messageID: "m1", text: "hi" },
    });

    expect(res.statusCode).toBe(200);
    expect(paged.at(-1)!.template).toBe("ops-thumbtack-failed");
    activities.push = Array.prototype.push;
  });

  it("404s an unknown route", async () => {
    expect((await call("/v1/nonsense", {})).statusCode).toBe(404);
  });

  it("400s a body that is not JSON", async () => {
    const res = (await handler(
      {
        rawPath: "/v1/lead",
        requestContext: { http: { method: "POST", path: "/v1/lead" } },
        headers: { authorization: SECRET },
        body: "not json",
        isBase64Encoded: false,
      } as never,
      {} as never,
      (() => undefined) as never
    )) as { statusCode: number };
    expect(res.statusCode).toBe(400);
  });
});
