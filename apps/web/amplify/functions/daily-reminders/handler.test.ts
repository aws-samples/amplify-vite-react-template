import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The daily backstops.
 *
 * The filters are the whole feature. A digest that lists plans or jobs which
 * are supposed to be unbilled — or an alert that cries about visits somebody
 * is staffed to make — trains the office to ignore it, at which point it is
 * worse than not existing.
 */

type Plan = {
  id: string;
  customerId: string;
  planName: string;
  priceCents: number;
  status: string;
  stripeSubscriptionId?: string | null;
};
type Job = {
  id: string;
  customerId?: string;
  servicePlanId?: string | null;
  serviceType?: string;
  type?: string;
  status: string;
  scheduledDate?: string | null;
  routeId?: string | null;
  priceCents?: number | null;
  paidAt?: string | null;
  completedAt?: string | null;
  timeWindow?: string | null;
};
type Invoice = { id: string; jobId?: string | null; status: string };
type Route = { id: string; date: string; technicianId: string };
type Tech = { id: string; name: string; active: boolean };

let plans: Plan[] = [];
let jobs: Job[] = [];
let invoiceRows: Invoice[] = [];
let routes: Route[] = [];
let techs: Tech[] = [];

/** Same shop-timezone date arithmetic the handler uses. */
const easternPlusDays = (n: number) =>
  new Date(Date.now() + n * 24 * 60 * 60 * 1000).toLocaleDateString("en-CA", {
    timeZone: "America/New_York",
  });

const fakeDataClient = {
  models: {
    ServicePlan: {
      list: async () => ({
        data: plans.filter((p) => p.status === "ACTIVE"),
        nextToken: null,
      }),
    },
    Job: {
      listJobByScheduledDate: async ({
        scheduledDate,
      }: {
        scheduledDate: string;
      }) => ({
        data: jobs.filter((j) => j.scheduledDate === scheduledDate),
        nextToken: null,
      }),
      listJobByServicePlanId: async ({ servicePlanId }: { servicePlanId: string }) => ({
        data: jobs.filter((j) => j.servicePlanId === servicePlanId),
        nextToken: null,
      }),
      listJobByStatusAndScheduledDate: async (
        { status }: { status: string },
        opts?: { filter?: { type?: { eq?: string } } }
      ) => ({
        data: jobs.filter(
          (j) =>
            j.status === status &&
            (!opts?.filter?.type?.eq || j.type === opts.filter.type.eq)
        ),
        nextToken: null,
      }),
    },
    Invoice: {
      list: async () => ({ data: invoiceRows, nextToken: null }),
      // Recovery lifecycle: the aging/dunning passes read the status index.
      // These existing tests don't exercise recovery, so return nothing owed.
      listInvoiceByStatusAndIssuedAt: async () => ({
        data: [],
        nextToken: null,
      }),
    },
    Dispute: {
      listDisputeByStatus: async () => ({ data: [], nextToken: null }),
    },
    Route: {
      get: async ({ id }: { id: string }) => ({
        data: routes.find((r) => r.id === id) ?? null,
      }),
    },
    Technician: {
      get: async ({ id }: { id: string }) => ({
        data: techs.find((t) => t.id === id) ?? null,
      }),
    },
    Customer: {
      get: async ({ id }: { id: string }) => ({
        data: { id, displayName: `Customer ${id}`, email: `${id}@example.com` },
      }),
    },
  },
};

vi.mock("../shared/dataClient", () => ({ dataClient: async () => fakeDataClient }));

const officeEmails: { subject: string; bodyHtml: string }[] = [];
const customerEmails: { to: string; subject: string; html: string }[] = [];
vi.mock("../shared/email", () => ({
  emailShell: (h: string, b: string) => `${h}${b}`,
  sendEmail: async (opts: { to: string; subject: string; html: string }) => {
    customerEmails.push(opts);
    return true;
  },
  notifyOffice: async (opts: { subject: string; bodyHtml: string }) => {
    officeEmails.push(opts);
    return true;
  },
}));

const { handler } = await import("./handler");

/** Office alerts about one topic — every digest asserts on its own subject. */
const alertsAbout = (needle: string) =>
  officeEmails.filter((e) => e.subject.includes(needle));

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

let jobSeq = 0;
const seedJob = (over: Partial<Job> = {}): Job => {
  const j: Job = {
    id: `j${++jobSeq}`,
    customerId: "c-one",
    serviceType: "Wasp nest removal",
    type: "ONE_TIME",
    status: "COMPLETED",
    priceCents: 29900,
    paidAt: null,
    completedAt: "2026-07-10T15:00:00.000Z",
    scheduledDate: null,
    routeId: null,
    ...over,
  };
  jobs.push(j);
  return j;
};

beforeEach(() => {
  plans = [];
  jobs = [];
  invoiceRows = [];
  routes = [];
  techs = [];
  jobSeq = 0;
  officeEmails.length = 0;
  customerEmails.length = 0;
});

describe("serviced-but-not-billing digest", () => {
  it("reports a plan that has been serviced but never started billing", async () => {
    const p = seed();
    seedJob({ servicePlanId: p.id, status: "COMPLETED", type: "RECURRING", priceCents: null });

    await handler();

    const alerts = alertsAbout("serviced without billing");
    expect(alerts).toHaveLength(1);
    expect(alerts[0].bodyHtml).toContain("Customer c1");
  });

  it("stays silent about a plan whose first visit has not happened yet", async () => {
    // Billing starts on first completion, so this plan is correctly unbilled.
    const p = seed();
    seedJob({ servicePlanId: p.id, status: "SCHEDULED", type: "RECURRING", priceCents: null });

    await handler();

    expect(alertsAbout("serviced without billing")).toHaveLength(0);
  });

  it("stays silent about a plan that is billing normally", async () => {
    const p = seed({ stripeSubscriptionId: "sub_live" });
    seedJob({ servicePlanId: p.id, status: "COMPLETED", type: "RECURRING", priceCents: null });

    await handler();

    expect(alertsAbout("serviced without billing")).toHaveLength(0);
  });

  it("ignores canceled and paused plans", async () => {
    const canceled = seed({ status: "CANCELED" });
    const paused = seed({ status: "PAUSED" });
    seedJob({ servicePlanId: canceled.id, status: "COMPLETED", type: "RECURRING", priceCents: null });
    seedJob({ servicePlanId: paused.id, status: "COMPLETED", type: "RECURRING", priceCents: null });

    await handler();

    expect(officeEmails).toHaveLength(0);
  });

  it("totals the annual value so the email says what it is worth", async () => {
    const a = seed({ priceCents: 9900 });
    const b = seed({ priceCents: 4500 });
    seedJob({ servicePlanId: a.id, status: "COMPLETED", type: "RECURRING", priceCents: null });
    seedJob({ servicePlanId: b.id, status: "COMPLETED", type: "RECURRING", priceCents: null });

    await handler();

    // (99.00 + 45.00) * 12
    expect(alertsAbout("serviced without billing")[0].bodyHtml).toContain(
      "$1728.00/yr"
    );
  });
});

describe("completed-but-never-charged digest", () => {
  it("reports a completed one-time job with no invoice, with the amount", async () => {
    seedJob({ customerId: "c9" });

    await handler();

    const alerts = alertsAbout("never been charged");
    expect(alerts).toHaveLength(1);
    expect(alerts[0].bodyHtml).toContain("Customer c9");
    expect(alerts[0].bodyHtml).toContain("$299.00");
  });

  it("stays silent about a job paid up front at online booking", async () => {
    seedJob({ paidAt: "2026-07-01T00:00:00.000Z" });

    await handler();

    expect(alertsAbout("never been charged")).toHaveLength(0);
  });

  it("stays silent about a job covered by a PAID or OPEN invoice", async () => {
    const paid = seedJob();
    const open = seedJob();
    invoiceRows = [
      { id: "i1", jobId: paid.id, status: "PAID" },
      { id: "i2", jobId: open.id, status: "OPEN" },
    ];

    await handler();

    expect(alertsAbout("never been charged")).toHaveLength(0);
  });

  it("stays silent about a job whose charge was deliberately refunded", async () => {
    const j = seedJob();
    invoiceRows = [{ id: "i1", jobId: j.id, status: "REFUNDED" }];

    await handler();

    expect(alertsAbout("never been charged")).toHaveLength(0);
  });

  it("keeps reporting after a FAILED charge or a voided invoice", async () => {
    const failed = seedJob({ customerId: "c-failed" });
    const voided = seedJob({ customerId: "c-voided" });
    invoiceRows = [
      { id: "i1", jobId: failed.id, status: "FAILED" },
      { id: "i2", jobId: voided.id, status: "VOID" },
    ];

    await handler();

    const alerts = alertsAbout("never been charged");
    expect(alerts).toHaveLength(1);
    expect(alerts[0].bodyHtml).toContain("Customer c-failed");
    expect(alerts[0].bodyHtml).toContain("Customer c-voided");
  });

  it("ignores recurring plan visits — the subscription bills those", async () => {
    // The plan side has its own digest; a plan visit here would double-count.
    const p = seed({ stripeSubscriptionId: "sub_live" });
    seedJob({ servicePlanId: p.id, type: "RECURRING", priceCents: 9900 });
    seedJob({ servicePlanId: p.id, type: "RECURRING", status: "UNSCHEDULED", priceCents: null });

    await handler();

    expect(alertsAbout("never been charged")).toHaveLength(0);
  });

  it("ignores zero-priced jobs — there is nothing for Charge to take", async () => {
    seedJob({ priceCents: 0 });
    seedJob({ priceCents: null });

    await handler();

    expect(alertsAbout("never been charged")).toHaveLength(0);
  });
});

describe("active-plan-with-no-next-visit digest", () => {
  it("reports a billing plan whose only visit is completed and nothing is queued", async () => {
    const p = seed({ stripeSubscriptionId: "sub_live" });
    seedJob({ servicePlanId: p.id, status: "COMPLETED", type: "RECURRING", priceCents: null });

    await handler();

    const alerts = alertsAbout("no next visit");
    expect(alerts).toHaveLength(1);
    expect(alerts[0].bodyHtml).toContain("Customer c1");
    expect(alerts[0].bodyHtml).toContain("billing is running");
  });

  it("reports a plan whose visit ended NO_ACCESS — the honest exit queues nothing", async () => {
    const p = seed({ stripeSubscriptionId: "sub_live" });
    seedJob({ servicePlanId: p.id, status: "NO_ACCESS", type: "RECURRING", priceCents: null });

    await handler();

    expect(alertsAbout("no next visit")).toHaveLength(1);
  });

  it("reports a plan whose only scheduled visit is in the past — nobody is coming", async () => {
    const p = seed({ stripeSubscriptionId: "sub_live" });
    seedJob({
      servicePlanId: p.id,
      status: "SCHEDULED",
      type: "RECURRING",
      priceCents: null,
      scheduledDate: "2020-01-01",
    });

    await handler();

    expect(alertsAbout("no next visit")).toHaveLength(1);
  });

  it("stays silent when a next visit is queued or on the calendar", async () => {
    const queued = seed({ stripeSubscriptionId: "sub_1" });
    const scheduled = seed({ stripeSubscriptionId: "sub_2" });
    seedJob({ servicePlanId: queued.id, status: "UNSCHEDULED", type: "RECURRING", priceCents: null });
    seedJob({
      servicePlanId: scheduled.id,
      status: "SCHEDULED",
      type: "RECURRING",
      priceCents: null,
      scheduledDate: easternPlusDays(30),
    });

    await handler();

    expect(alertsAbout("no next visit")).toHaveLength(0);
  });

  it("ignores paused and canceled plans — they are supposed to have no visit", async () => {
    seed({ status: "PAUSED", stripeSubscriptionId: "sub_1" });
    seed({ status: "CANCELED" });

    await handler();

    expect(alertsAbout("no next visit")).toHaveLength(0);
  });
});

describe("unstaffed-visit gate on tomorrow's reminders", () => {
  const tomorrow = () => easternPlusDays(1);

  const staffedSetup = () => {
    routes.push({ id: "r1", date: tomorrow(), technicianId: "t1" });
    techs.push({ id: "t1", name: "Sam", active: true });
  };

  it("reminds the customer when the visit is on an active technician's route", async () => {
    staffedSetup();
    seedJob({
      customerId: "c-early",
      status: "SCHEDULED",
      scheduledDate: tomorrow(),
      routeId: "r1",
      completedAt: null,
    });

    await handler();

    expect(customerEmails).toHaveLength(1);
    expect(customerEmails[0].to).toBe("c-early@example.com");
    expect(alertsAbout("nobody coming")).toHaveLength(0);
  });

  it("suppresses the reminder and alerts the office when the visit is on no route", async () => {
    seedJob({
      customerId: "c-lost",
      status: "SCHEDULED",
      scheduledDate: tomorrow(),
      routeId: null,
      completedAt: null,
    });

    await handler();

    expect(customerEmails).toHaveLength(0);
    const alerts = alertsAbout("nobody coming");
    expect(alerts).toHaveLength(1);
    expect(alerts[0].bodyHtml).toContain("Customer c-lost");
    expect(alerts[0].bodyHtml).toContain("on no technician's route");
    expect(alerts[0].bodyHtml).toContain("No reminder was sent");
  });

  it("suppresses the reminder when the route's technician is deactivated", async () => {
    routes.push({ id: "r1", date: tomorrow(), technicianId: "t1" });
    techs.push({ id: "t1", name: "Sam", active: false });
    seedJob({
      customerId: "c-fired",
      status: "SCHEDULED",
      scheduledDate: tomorrow(),
      routeId: "r1",
      completedAt: null,
    });

    await handler();

    expect(customerEmails).toHaveLength(0);
    const alerts = alertsAbout("nobody coming");
    expect(alerts).toHaveLength(1);
    expect(alerts[0].bodyHtml).toContain("Sam, who is deactivated");
  });

  it("suppresses the reminder when the job's route is dated a different day", async () => {
    routes.push({ id: "r1", date: "2020-01-01", technicianId: "t1" });
    techs.push({ id: "t1", name: "Sam", active: true });
    seedJob({
      customerId: "c-moved",
      status: "SCHEDULED",
      scheduledDate: tomorrow(),
      routeId: "r1",
      completedAt: null,
    });

    await handler();

    expect(customerEmails).toHaveLength(0);
    expect(alertsAbout("nobody coming")).toHaveLength(1);
  });

  it("includes a pool job whose target date is tomorrow, without reminding anyone", async () => {
    seedJob({
      customerId: "c-pool",
      status: "UNSCHEDULED",
      scheduledDate: tomorrow(),
      completedAt: null,
    });

    await handler();

    expect(customerEmails).toHaveLength(0);
    const alerts = alertsAbout("nobody coming");
    expect(alerts).toHaveLength(1);
    expect(alerts[0].bodyHtml).toContain("needs-scheduling pool");
  });

  it("leaves the one-week-out reminder alone — routes do not exist yet", async () => {
    seedJob({
      customerId: "c-week",
      status: "SCHEDULED",
      scheduledDate: easternPlusDays(7),
      routeId: null,
      completedAt: null,
    });

    await handler();

    expect(customerEmails).toHaveLength(1);
    expect(customerEmails[0].to).toBe("c-week@example.com");
    expect(alertsAbout("nobody coming")).toHaveLength(0);
  });
});
