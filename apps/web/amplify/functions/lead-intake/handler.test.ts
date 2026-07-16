import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Lead intake has exactly two outcomes: the lead is durably in the CRM, or the
 * caller is told it failed. There is no third.
 *
 * The landing pages used to show "we'll call you shortly" for leads that were
 * never recorded — LPCall's own comment said "Even on error, show success — we'll
 * get the lead from CloudWatch", and its payload could not pass validation, so it
 * destroyed 100% of them. These tests exist so that cannot come back.
 */

type Created = Record<string, unknown>;

const created: Created[] = [];
let createResult: { data: unknown; errors?: { message: string }[] } = {
  data: { id: "cust_1" },
};

const fakeDataClient = {
  models: {
    Customer: {
      create: async (input: Created) => {
        created.push(input);
        return createResult;
      },
    },
  },
};

vi.mock("../shared/dataClient", () => ({
  dataClient: async () => fakeDataClient,
}));

const officeEmails: { subject: string; bodyHtml: string }[] = [];
vi.mock("../shared/email", () => ({
  emailShell: (h: string, b: string) => `${h}${b}`,
  sendEmail: async () => true,
  notifyOffice: async (opts: { subject: string; bodyHtml: string }) => {
    officeEmails.push(opts);
    return true;
  },
}));

const { handler } = await import("./handler");

const post = async (payload: unknown) => {
  const res = (await (handler as unknown as (e: unknown, c: unknown, cb: unknown) => Promise<{ statusCode: number; body: string }>)(
    { httpMethod: "POST", body: JSON.stringify(payload), isBase64Encoded: false },
    {},
    () => {}
  ))!;
  return { status: res.statusCode, body: JSON.parse(res.body) };
};

/** Exactly what apps/web/src/pages/lp/LPCall.tsx sends: 3 fields, nothing else. */
const lpCallPayload = {
  propertyType: "Association",
  first: "Dana",
  last: "",
  email: "",
  phone: "(401) 555-0142",
  addr: "12 Beacon St",
  city: "",
  state: "",
  zip: "",
  sqft: "",
  units: "",
  freq: "Monthly",
  company: "",
  formId: "lp-call",
  consentToContact: true,
};

beforeEach(() => {
  created.length = 0;
  officeEmails.length = 0;
  createResult = { data: { id: "cust_1" } };
});

describe("lead-intake", () => {
  it("accepts the callback form's 3-field payload", async () => {
    // The old backend hard-required first+last+email+phone+addr+city+state+zip,
    // so every one of these 422'd.
    const res = await post(lpCallPayload);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, leadId: "cust_1" });
  });

  it("stores the lead as a CRM lead, not a customer", async () => {
    await post(lpCallPayload);

    expect(created[0]).toMatchObject({
      status: "LEAD",
      displayName: "Dana",
      phone: "+14015550142",
    });
  });

  it("refuses a submission with no way to reach anyone", async () => {
    const res = await post({ propertyType: "Residential", first: "", email: "", phone: "" });

    expect(res.status).toBe(422);
    expect(res.body.missing).toEqual(["name", "email or phone"]);
  });

  it("accepts a name with only an email", async () => {
    const res = await post({ first: "Sam", last: "Reed", email: "sam@example.com" });

    expect(res.status).toBe(200);
    expect(created[0]).toMatchObject({ email: "sam@example.com" });
  });

  it("keeps an unusable phone in the notes rather than losing the lead", async () => {
    // AppSync would reject the malformed value and take the whole record with
    // it; dropping the field and keeping the text is how the lead survives.
    const res = await post({
      first: "Sam",
      last: "Reed",
      email: "sam@example.com",
      phone: "call me after 5",
    });

    expect(res.status).toBe(200);
    expect(created[0].phone).toBeUndefined();
    expect(String(created[0].leadNotes)).toContain("call me after 5");
  });

  it("records consent when granted", async () => {
    await post({ ...lpCallPayload, consentToContact: true });

    expect(created[0].contactConsent).toBe(true);
    expect(created[0].contactConsentAt).toBeTruthy();
  });

  it("marks a lead email-only when consent was not given", async () => {
    await post({ first: "Sam", email: "sam@example.com", consentToContact: false });

    expect(created[0].contactConsent).toBe(false);
    expect(String(created[0].leadNotes)).toContain("do not call or text");
  });

  it("never reports success when the CRM write fails", async () => {
    createResult = { data: null, errors: [{ message: "conditional check failed" }] };

    const res = await post(lpCallPayload);

    expect(res.status).toBe(502);
    expect(res.body.ok).toBeUndefined();
    expect(res.body.error).toMatch(/call us/i);
  });

  it("pages the office with the lead when the CRM write fails", async () => {
    // The lead exists nowhere else at this point — an email is the only copy.
    createResult = { data: null, errors: [{ message: "boom" }] };

    await post(lpCallPayload);

    expect(officeEmails).toHaveLength(1);
    expect(officeEmails[0].subject).toContain("ACTION REQUIRED");
    expect(officeEmails[0].bodyHtml).toContain("Dana");
  });

  it("captures first-touch attribution against the lead", async () => {
    await post({
      ...lpCallPayload,
      attribution: { source: "google", gclid: "abc123", landingPage: "/lp/call" },
    });

    expect(created[0].leadSource).toContain("utm:google");
    expect(String(created[0].leadNotes)).toContain("abc123");
  });

  it("rejects a non-POST", async () => {
    const res = (await (handler as unknown as (e: unknown, c: unknown, cb: unknown) => Promise<{ statusCode: number }>)(
      { httpMethod: "GET" },
      {},
      () => {}
    ))!;

    expect(res.statusCode).toBe(405);
  });
});
