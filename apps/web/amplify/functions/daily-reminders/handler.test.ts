import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The serviced-but-not-billing digest.
 *
 * The filter is the whole feature. A digest that lists plans which are supposed
 * to be unbilled trains the office to ignore it, at which point it is worse than
 * not existing.
 */

type Plan = {
  id: string;
  customerId: string;
  planName: string;
  priceCents: number;
  status: string;
  stripeSubscriptionId?: string | null;
};
type Job = { id: string; servicePlanId: string; status: string };

let plans: Plan[] = [];
let jobs: Job[] = [];

const fakeDataClient = {
  models: {
    ServicePlan: {
      list: async () => ({
        data: plans.filter((p) => p.status === "ACTIVE"),
        nextToken: null,
      }),
    },
    Job: {
      listJobByScheduledDate: async () => ({ data: [], nextToken: null }),
      listJobByServicePlanId: async ({ servicePlanId }: { servicePlanId: string }) => ({
        data: jobs.filter((j) => j.servicePlanId === servicePlanId),
        nextToken: null,
      }),
    },
    Customer: {
      get: async ({ id }: { id: string }) => ({
        data: { id, displayName: `Customer ${id}` },
      }),
    },
  },
};

vi.mock("../shared/dataClient", () => ({ dataClient: async () => fakeDataClient }));

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

const seed = (over: Partial<Plan> = {}): Plan => {
  const p: Plan = {
    id: `p${plans.length + 1}`,
    customerId: `c${plans.length + 1}`,
    planName: "Residential monthly",
    priceCents: 9900,
    status: "ACTIVE",
    stripeSubscriptionId: null,
    ...over,
  };
  plans.push(p);
  return p;
};

beforeEach(() => {
  plans = [];
  jobs = [];
  officeEmails.length = 0;
});

describe("serviced-but-not-billing digest", () => {
  it("reports a plan that has been serviced but never started billing", async () => {
    const p = seed();
    jobs.push({ id: "j1", servicePlanId: p.id, status: "COMPLETED" });

    await handler();

    expect(officeEmails).toHaveLength(1);
    expect(officeEmails[0].subject).toContain("serviced without billing");
    expect(officeEmails[0].bodyHtml).toContain("Customer c1");
  });

  it("stays silent about a plan whose first visit has not happened yet", async () => {
    // Billing starts on first completion, so this plan is correctly unbilled.
    const p = seed();
    jobs.push({ id: "j1", servicePlanId: p.id, status: "SCHEDULED" });

    await handler();

    expect(officeEmails).toHaveLength(0);
  });

  it("stays silent about a plan that is billing normally", async () => {
    const p = seed({ stripeSubscriptionId: "sub_live" });
    jobs.push({ id: "j1", servicePlanId: p.id, status: "COMPLETED" });

    await handler();

    expect(officeEmails).toHaveLength(0);
  });

  it("ignores canceled and paused plans", async () => {
    const canceled = seed({ status: "CANCELED" });
    const paused = seed({ status: "PAUSED" });
    jobs.push(
      { id: "j1", servicePlanId: canceled.id, status: "COMPLETED" },
      { id: "j2", servicePlanId: paused.id, status: "COMPLETED" }
    );

    await handler();

    expect(officeEmails).toHaveLength(0);
  });

  it("totals the annual value so the email says what it is worth", async () => {
    const a = seed({ priceCents: 9900 });
    const b = seed({ priceCents: 4500 });
    jobs.push(
      { id: "j1", servicePlanId: a.id, status: "COMPLETED" },
      { id: "j2", servicePlanId: b.id, status: "COMPLETED" }
    );

    await handler();

    // (99.00 + 45.00) * 12
    expect(officeEmails[0].bodyHtml).toContain("$1728.00/yr");
  });
});
