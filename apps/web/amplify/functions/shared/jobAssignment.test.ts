import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSyncIdentity } from "aws-lambda";

/**
 * GL-13 — technician least-privilege and assignment enforcement.
 *
 * Direct-handler proof that knowing a record id is never enough: Technician A
 * cannot start, end, report on, finalize, photograph, or pull document links
 * for Technician B's job. The assignee can; the office can; an assignee whose
 * credential lapsed cannot; and a reassignment takes effect on the next action.
 */

type Tech = {
  id: string;
  name?: string | null;
  userSub?: string | null;
  active?: boolean | null;
  licenseNumber?: string | null;
  licenseExpiresOn?: string | null;
};
type Job = {
  id: string;
  customerId: string;
  technicianId?: string | null;
  scheduledDate?: string | null;
};

const techs = new Map<string, Tech>();
const jobs = new Map<string, Job>();

const fakeDataClient = {
  models: {
    Technician: {
      list: async () => ({ data: [...techs.values()] }),
    },
    Job: {
      get: async ({ id }: { id: string }) => ({ data: jobs.get(id) ?? null }),
      list: async ({
        filter,
      }: {
        filter?: {
          customerId?: { eq: string };
          technicianId?: { eq: string };
        };
      }) => ({
        data: [...jobs.values()].filter(
          (j) =>
            (!filter?.customerId || j.customerId === filter.customerId.eq) &&
            (!filter?.technicianId || j.technicianId === filter.technicianId.eq)
        ),
      }),
    },
    ServiceReport: {
      get: async ({ id }: { id: string }) => ({
        data:
          id === "rep_a"
            ? { id: "rep_a", jobId: "job_a" }
            : id === "rep_b"
              ? { id: "rep_b", jobId: "job_b" }
              : null,
      }),
    },
  },
};

vi.mock("./dataClient", () => ({ dataClient: async () => fakeDataClient }));

const {
  assertCanActOnJobId,
  assertCanActOnReportId,
  technicianForCaller,
  technicianServesCustomer,
} = await import("./jobAssignment");

const identity = (sub: string | null, groups: string[]): AppSyncIdentity =>
  ({ sub, groups, claims: {} }) as unknown as AppSyncIdentity;

const TECH_A = identity("sub-a", ["TECH"]);
const TECH_B = identity("sub-b", ["TECH"]);
const OFFICE = identity("sub-office", ["OFFICE"]);
const UNLINKED = identity("sub-nobody", ["TECH"]);

beforeEach(() => {
  techs.clear();
  jobs.clear();
  techs.set("t_a", {
    id: "t_a",
    name: "Ana",
    userSub: "sub-a",
    active: true,
    licenseNumber: "MA-1",
    licenseExpiresOn: "2027-01-01",
  });
  techs.set("t_b", {
    id: "t_b",
    name: "Ben",
    userSub: "sub-b",
    active: true,
    licenseNumber: "MA-2",
    licenseExpiresOn: "2027-01-01",
  });
  jobs.set("job_a", {
    id: "job_a",
    customerId: "cust_a",
    technicianId: "t_a",
    scheduledDate: "2026-07-16",
  });
  jobs.set("job_b", {
    id: "job_b",
    customerId: "cust_b",
    technicianId: "t_b",
    scheduledDate: "2026-07-16",
  });
});

describe("assertCanActOnJobId", () => {
  it("lets the assigned technician act on their own job", async () => {
    await expect(assertCanActOnJobId(TECH_A, "job_a")).resolves.toBeUndefined();
  });

  it("refuses Technician A on Technician B's job", async () => {
    await expect(assertCanActOnJobId(TECH_A, "job_b")).rejects.toThrow(
      /not authorized for this job/i
    );
  });

  it("gives the same opaque refusal for a job that does not exist", async () => {
    await expect(assertCanActOnJobId(TECH_A, "job_ghost")).rejects.toThrow(
      /not authorized for this job/i
    );
  });

  it("lets office act on any job (audited emergency/scheduling access)", async () => {
    await expect(assertCanActOnJobId(OFFICE, "job_a")).resolves.toBeUndefined();
    await expect(assertCanActOnJobId(OFFICE, "job_b")).resolves.toBeUndefined();
  });

  it("tells an unlinked login it is not linked, without leaking the job", async () => {
    await expect(assertCanActOnJobId(UNLINKED, "job_a")).rejects.toThrow(
      /isn't linked to a technician record/i
    );
  });

  it("refuses the assignee once their applicator license has expired", async () => {
    techs.get("t_a")!.licenseExpiresOn = "2026-07-15"; // day before the visit
    await expect(assertCanActOnJobId(TECH_A, "job_a")).rejects.toThrow(
      /expired.*not valid for work/i
    );
  });

  it("refuses the assignee once they are deactivated", async () => {
    techs.get("t_a")!.active = false;
    await expect(assertCanActOnJobId(TECH_A, "job_a")).rejects.toThrow(
      /inactive/i
    );
  });

  it("honors a reassignment immediately: B can act, A can no longer", async () => {
    jobs.get("job_a")!.technicianId = "t_b"; // office reassigned job_a to Ben
    await expect(assertCanActOnJobId(TECH_B, "job_a")).resolves.toBeUndefined();
    await expect(assertCanActOnJobId(TECH_A, "job_a")).rejects.toThrow(
      /not authorized for this job/i
    );
  });
});

describe("assertCanActOnReportId", () => {
  it("lets the assignee act on their own report", async () => {
    await expect(
      assertCanActOnReportId(TECH_A, "rep_a")
    ).resolves.toBeUndefined();
  });

  it("refuses Technician A on Technician B's report", async () => {
    await expect(assertCanActOnReportId(TECH_A, "rep_b")).rejects.toThrow(
      /not authorized for this job/i
    );
  });

  it("is opaque about a report that does not exist (non-office)", async () => {
    await expect(assertCanActOnReportId(TECH_A, "rep_ghost")).rejects.toThrow(
      /not authorized for this report/i
    );
  });

  it("surfaces the assignee's own credential failure, not a generic refusal", async () => {
    techs.get("t_a")!.licenseNumber = null;
    await expect(assertCanActOnReportId(TECH_A, "rep_a")).rejects.toThrow(
      /applicator license number/i
    );
  });
});

describe("technicianServesCustomer", () => {
  it("is true for a customer the technician has a job with", async () => {
    expect(await technicianServesCustomer(TECH_A, "cust_a")).toBe(true);
  });

  it("is false for a customer served only by another technician", async () => {
    expect(await technicianServesCustomer(TECH_A, "cust_b")).toBe(false);
  });

  it("is false for an unlinked login", async () => {
    expect(await technicianServesCustomer(UNLINKED, "cust_a")).toBe(false);
  });
});

describe("technicianForCaller", () => {
  it("resolves the Technician linked to the signed-in user", async () => {
    expect((await technicianForCaller(TECH_A))?.id).toBe("t_a");
  });

  it("is null for an unlinked login", async () => {
    expect(await technicianForCaller(UNLINKED)).toBeNull();
  });
});
