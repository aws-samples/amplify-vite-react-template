import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSyncIdentity } from "aws-lambda";

/**
 * GL-13 row-scoping — the technician read surface.
 *
 * Direct-handler proof that the model API's removal of the TECH read is backed
 * by real scoping: a technician's day and job come only from these queries, and
 * neither reveals another worker's work. Technician A cannot read Technician B's
 * job by id (same opaque refusal as a missing one); a reassignment removes the
 * former assignee's read on the next call; office may view anyone; and the
 * customer payload is reduced to visit fields with the job's money fields gone.
 */

type Tech = {
  id: string;
  name?: string | null;
  userSub?: string | null;
  active?: boolean | null;
  licenseNumber?: string | null;
  licenseExpiresOn?: string | null;
};
type Job = Record<string, unknown> & {
  id: string;
  customerId: string;
  technicianId?: string | null;
  routeId?: string | null;
};

const techs = new Map<string, Tech>();
const jobs = new Map<string, Job>();
const routes = new Map<string, Record<string, unknown>>();
const customers = new Map<string, Record<string, unknown>>();
const reports = new Map<string, Record<string, unknown>>();
const products: Record<string, unknown>[] = [];

const fakeDataClient = {
  models: {
    Technician: {
      list: async () => ({ data: [...techs.values()], nextToken: null }),
    },
    Route: {
      listRouteByTechnicianIdAndDate: async (input: {
        technicianId: string;
        date: { eq: string };
      }) => ({
        data: [...routes.values()].filter(
          (r) =>
            r.technicianId === input.technicianId && r.date === input.date.eq
        ),
        nextToken: null,
      }),
    },
    Job: {
      get: async ({ id }: { id: string }) => ({ data: jobs.get(id) ?? null }),
      list: async ({
        filter,
      }: {
        filter?: {
          routeId?: { eq: string };
          customerId?: { eq: string };
        };
      }) => ({
        data: [...jobs.values()].filter(
          (j) =>
            (!filter?.routeId || j.routeId === filter.routeId.eq) &&
            (!filter?.customerId || j.customerId === filter.customerId.eq)
        ),
        nextToken: null,
      }),
    },
    Customer: {
      get: async ({ id }: { id: string }) => ({
        data: customers.get(id) ?? null,
      }),
    },
    ServiceReport: {
      listServiceReportByJobId: async ({ jobId }: { jobId: string }) => ({
        data: [...reports.values()].filter((r) => r.jobId === jobId),
        nextToken: null,
      }),
    },
    Product: {
      list: async () => ({ data: products, nextToken: null }),
    },
  },
};

vi.mock("./dataClient", () => ({ dataClient: async () => fakeDataClient }));

const { buildTechnicianDay, buildTechnicianJob } = await import(
  "./technicianReads"
);

const identity = (sub: string | null, groups: string[]): AppSyncIdentity =>
  ({ sub, groups, claims: {} }) as unknown as AppSyncIdentity;

const TECH_A = identity("sub-a", ["TECH"]);
const TECH_B = identity("sub-b", ["TECH"]);
const OFFICE = identity("sub-office", ["OFFICE"]);
const UNLINKED = identity("sub-nobody", ["TECH"]);

beforeEach(() => {
  techs.clear();
  jobs.clear();
  routes.clear();
  customers.clear();
  reports.clear();
  products.length = 0;

  techs.set("t_a", { id: "t_a", name: "Ana", userSub: "sub-a", active: true });
  techs.set("t_b", { id: "t_b", name: "Ben", userSub: "sub-b", active: true });

  customers.set("c_a", {
    id: "c_a",
    displayName: "Acme",
    contactName: "Al",
    email: "al@acme.test",
    phone: "555-1111",
    serviceStreet: "1 Main",
    serviceCity: "Town",
    serviceState: "CT",
    serviceZip: "06010",
    // Fields a technician must NOT receive:
    billingStreet: "9 Bank",
    stripeCustomerId: "cus_secret",
    notes: "internal org note",
  });

  routes.set("r_a", { id: "r_a", technicianId: "t_a", date: "2026-07-20", status: "PLANNED", notes: null });

  jobs.set("job_a", {
    id: "job_a",
    customerId: "c_a",
    technicianId: "t_a",
    routeId: "r_a",
    routeOrder: 1,
    serviceType: "General Pest",
    status: "SCHEDULED",
    priceCents: 12000,
    paidPaymentIntentId: "pi_secret",
  });
});

describe("buildTechnicianJob", () => {
  it("gives the assignee the job, with the customer reduced to visit fields", async () => {
    const d = await buildTechnicianJob(TECH_A, "job_a");
    expect(d.job.id).toBe("job_a");
    // Money fields are dropped even for the assignee's own job.
    expect(d.job.priceCents).toBeUndefined();
    expect(d.job.paidPaymentIntentId).toBeUndefined();
    // Customer carries only visit fields.
    expect(d.customer?.displayName).toBe("Acme");
    expect(d.customer?.serviceStreet).toBe("1 Main");
    expect(d.customer?.billingStreet).toBeUndefined();
    expect(d.customer?.stripeCustomerId).toBeUndefined();
    expect(d.customer?.notes).toBeUndefined();
    // The caller's OWN technician record, licence-free.
    expect(d.technician?.id).toBe("t_a");
    expect(d.technician).not.toHaveProperty("licenseNumber");
  });

  it("refuses a job that is not the caller's — opaque, like a missing one", async () => {
    await expect(buildTechnicianJob(TECH_B, "job_a")).rejects.toThrow(
      "Not authorized for this job"
    );
    await expect(buildTechnicianJob(TECH_B, "no_such_job")).rejects.toThrow(
      "Not authorized for this job"
    );
  });

  it("lets office read any job", async () => {
    const d = await buildTechnicianJob(OFFICE, "job_a");
    expect(d.job.id).toBe("job_a");
    // An office viewer is not a technician; report identity stays unset.
    expect(d.technician).toBeNull();
  });

  it("removes the former assignee's read the moment the job is reassigned", async () => {
    jobs.set("job_a", { ...jobs.get("job_a")!, technicianId: "t_b" });
    await expect(buildTechnicianJob(TECH_A, "job_a")).rejects.toThrow(
      "Not authorized for this job"
    );
    const d = await buildTechnicianJob(TECH_B, "job_a");
    expect(d.job.id).toBe("job_a");
  });
});

describe("buildTechnicianDay", () => {
  it("gives a technician their own route and stops, customers reduced to visit fields", async () => {
    const d = await buildTechnicianDay(TECH_A, { date: "2026-07-20" });
    expect(d.technicianId).toBe("t_a");
    expect(d.canPickTechnician).toBe(false);
    expect(d.technicians).toEqual([]);
    expect(d.route?.id).toBe("r_a");
    expect(d.jobs.map((j) => j.id)).toEqual(["job_a"]);
    expect(d.jobs[0].priceCents).toBeUndefined();
    expect(d.customers.c_a.serviceStreet).toBe("1 Main");
    expect(d.customers.c_a.billingStreet).toBeUndefined();
  });

  it("ignores a technicianId argument from a TECH — they only ever see themselves", async () => {
    const d = await buildTechnicianDay(TECH_A, {
      date: "2026-07-20",
      technicianId: "t_b",
    });
    expect(d.technicianId).toBe("t_a");
    expect(d.route?.id).toBe("r_a");
  });

  it("tells an unlinked technician login to get linked, without leaking any work", async () => {
    const d = await buildTechnicianDay(UNLINKED, { date: "2026-07-20" });
    expect(d.unlinked).toBe(true);
    expect(d.route).toBeNull();
    expect(d.jobs).toEqual([]);
  });

  it("lets office pick any technician's day and returns the picker roster", async () => {
    // Ben's route for the day.
    routes.set("r_b", { id: "r_b", technicianId: "t_b", date: "2026-07-20", status: "PLANNED", notes: null });
    jobs.set("job_b", {
      id: "job_b",
      customerId: "c_a",
      technicianId: "t_b",
      routeId: "r_b",
      routeOrder: 1,
      serviceType: "Rodent",
      status: "SCHEDULED",
    });
    const d = await buildTechnicianDay(OFFICE, {
      date: "2026-07-20",
      technicianId: "t_b",
    });
    expect(d.canPickTechnician).toBe(true);
    expect(d.technicians.map((t) => t.id).sort()).toEqual(["t_a", "t_b"]);
    expect(d.technicianId).toBe("t_b");
    expect(d.jobs.map((j) => j.id)).toEqual(["job_b"]);
  });
});
